#!/usr/bin/env node

import assert from 'node:assert/strict';

const storage = {};
let retryAlarmCreates = 0;
const fetchCalls = [];

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version_name: '2.7.0' }),
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries(
        (Array.isArray(keys) ? keys : Object.keys(keys || {})).map((key) => [key, storage[key]]),
      ),
      set: async (values) => Object.assign(storage, values),
    },
  },
  alarms: {
    get: async () => null,
    create: async () => {
      retryAlarmCreates += 1;
    },
    clear: async () => {},
  },
};

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return {
    ok: true,
    status: 201,
    json: async () => ({ success: true }),
  };
};

const {
  PLUGIN_DIAGNOSTICS_QUEUE_KEY,
  PLUGIN_FEEDBACK_ENDPOINT,
  buildPluginDiagnosticPayload,
  classifyPluginDiagnosticSubmission,
  classifyPluginFeedbackPriority,
  drainPluginDiagnostics,
  reportPluginError,
} = await import('../src/background/diagnostics.js');

const payload = buildPluginDiagnosticPayload(
  Object.assign(new Error('capture failed at https://example.com/private?token=secret'), {
    details: {
      body: 'page正文不应进入诊断',
      token: 'secret-token',
      path: '/Users/jam/private/page.html',
    },
  }),
  {
    category: 'plugin.capture',
    event: 'plugin.capture.failed',
    operation: 'capture.tab',
    sourceOrigin: 'https://example.com/private?token=secret',
    fields: {
      sourceUrl: 'https://example.com/private?token=secret',
      content: 'page正文不应进入诊断',
      count: 2,
      failureBuckets: {
        source_rate_limited: 2,
        source_auth_required: 1,
      },
    },
  },
);

const serializedPayload = JSON.stringify(payload);
assert.equal(payload.fields.sourceOrigin, 'https://example.com');
assert.equal(payload.fields.sourceUrl, 'https://example.com');
assert(!serializedPayload.includes('secret-token'));
assert(!serializedPayload.includes('page正文不应进入诊断'));
assert(!serializedPayload.includes('/Users/jam/private/page.html'));
assert(!serializedPayload.includes('/private?token=secret'));
assert.deepEqual(payload.fields.failureBuckets, {
  source_rate_limited: 2,
  source_auth_required: 1,
});

const passiveConnection = await reportPluginError(new Error('native host disconnected'), {
  category: 'plugin.connection',
  event: 'plugin.connection.failed',
  operation: 'native-transport',
  trigger: 'plugin_connection_error',
  code: 'NATIVE_HOST_EXITED',
  phase: 'native_messaging',
  retryable: true,
});
assert.equal(passiveConnection.skipped, true);
assert.equal(passiveConnection.reason, 'connection_telemetry');
assert.equal(fetchCalls.length, 0);
assert.equal(retryAlarmCreates, 0);

storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY] = [{
  id: 'legacy-connection-report',
  lastAttemptAt: 0,
  attempts: 0,
  payload: buildPluginDiagnosticPayload(new Error('legacy connection failure'), {
    category: 'plugin.connection',
    event: 'plugin.connection.failed',
    operation: 'native-transport',
    code: 'DESKTOP_BRIDGE_DISCONNECTED',
    phase: 'native_transport',
    retryable: true,
  }),
}];
const legacyDrain = await drainPluginDiagnostics();
assert.equal(legacyDrain.dropped, 1);
assert.equal(legacyDrain.sent, 0);
assert.equal(storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY].length, 0);
assert.equal(fetchCalls.length, 0);

const expectedCancellation = await reportPluginError(
  Object.assign(new Error('capture cancelled'), { expected: true }),
  {
    category: 'plugin.capture',
    event: 'plugin.capture.failed',
    operation: 'task:capture-page',
    trigger: 'plugin_capture_error',
    code: 'OPERATION_CANCELLED',
    phase: 'capture',
  },
);
assert.equal(expectedCancellation.skipped, true);
assert.equal(expectedCancellation.reason, 'expected_outcome');
assert.equal(fetchCalls.length, 0);

const initializingSpace = await reportPluginError(
  Object.assign(new Error('space is initializing'), { expected: true }),
  {
    category: 'plugin.capture',
    event: 'plugin.capture.failed',
    operation: 'message:save-page-link',
    trigger: 'plugin_capture_error',
    code: 'SPACE_INITIALIZING',
    phase: 'space_context',
    retryable: true,
  },
);
assert.equal(initializingSpace.skipped, true);
assert.equal(initializingSpace.reason, 'expected_outcome');
assert.equal(fetchCalls.length, 0);

const first = await reportPluginError(new Error('source API failed'), {
  category: 'plugin.capture',
  event: 'plugin.capture.failed',
  operation: 'task:capture-page',
  trigger: 'plugin_capture_error',
  code: 'SOURCE_API_FAILED',
  phase: 'capture',
  retryable: true,
});
assert.equal(first.sent, 1);
assert.equal(first.queued, 0);
assert.equal(storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY].length, 0);
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, PLUGIN_FEEDBACK_ENDPOINT);
const firstRequest = JSON.parse(fetchCalls[0].options.body);
assert.equal(firstRequest.request_kind, 'plugin_error');
assert.equal(firstRequest.source, 'browser_extension');
assert.equal(firstRequest.category, 'plugin_capture');
assert.equal(firstRequest.context.schema, 'redbox.browserPluginDiagnostic.v1');
assert.equal(firstRequest.context.automatic, true);
assert.equal(firstRequest.priority, 'normal');
assert(!JSON.stringify(firstRequest).includes('capture failed at https://'));

const duplicate = await reportPluginError(new Error('source API failed'), {
  category: 'plugin.capture',
  event: 'plugin.capture.failed',
  operation: 'message:capture-page',
  trigger: 'plugin_capture_error',
  code: 'SOURCE_API_FAILED',
  phase: 'capture',
  retryable: true,
});
assert.equal(duplicate.skipped, true);
assert.equal(duplicate.reason, 'active_episode');
assert.equal(duplicate.occurrences, 2);
assert.equal(storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY].length, 0);
assert.equal(retryAlarmCreates, 1);
assert.equal(fetchCalls.length, 1);

globalThis.fetch = async () => {
  throw new Error('network offline');
};
const offline = await reportPluginError(new Error('capture unavailable'), {
  category: 'plugin.capture',
  event: 'plugin.capture.failed',
  operation: 'capture.tab',
  trigger: 'capture_error',
  code: 'CAPTURE_UNAVAILABLE',
  phase: 'content_script',
});
assert.equal(offline.sent, 0);
assert.equal(offline.queued, 1);
assert.equal(storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY].length, 1);

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return {
    ok: true,
    status: 201,
    json: async () => ({ success: true }),
  };
};
storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY][0].lastAttemptAt = 0;
const retry = await drainPluginDiagnostics();
assert.equal(retry.sent, 1);
assert.equal(retry.queued, 0);
assert.equal(storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY].length, 0);
assert.equal(fetchCalls.at(-1).url, PLUGIN_FEEDBACK_ENDPOINT);

assert.equal(classifyPluginFeedbackPriority({
  fields: { code: 'URL_NOT_BELONG_TO_XIAOHONGSHU' },
}), 'low');
assert.equal(classifyPluginFeedbackPriority({
  message: 'URL does not belong to 小红书',
  fields: { code: 'PLUGIN_ERROR' },
}), 'low');
assert.equal(classifyPluginFeedbackPriority({
  fields: { code: 'NATIVE_HOST_DISCONNECTED', nativeStatus: { expectedDisconnect: true } },
}), 'low');
assert.equal(classifyPluginFeedbackPriority({
  fields: { code: 'DESKTOP_BRIDGE_PROTOCOL_MISMATCH' },
}), 'high');
assert.equal(classifyPluginFeedbackPriority({
  fields: { code: 'NATIVE_HOST_EXITED' },
}), 'normal');
assert.equal(classifyPluginFeedbackPriority({
  fields: { code: 'CAPTURE_PARTIAL_FAILURE' },
}), 'normal');
assert.equal(classifyPluginFeedbackPriority({
  fields: { code: 'WRITE_OUTCOME_UNKNOWN' },
}), 'high');
assert.deepEqual(classifyPluginDiagnosticSubmission({
  category: 'plugin.connection',
  fields: { code: 'NATIVE_REQUEST_TIMEOUT', retryable: true },
}), { submit: false, reason: 'connection_telemetry' });
assert.deepEqual(classifyPluginDiagnosticSubmission({
  category: 'plugin.connection',
  fields: { code: 'DESKTOP_BRIDGE_PROTOCOL_MISMATCH', retryable: false },
}), { submit: true, reason: 'actionable_connection_failure' });
assert.deepEqual(classifyPluginDiagnosticSubmission({
  category: 'plugin.capture',
  fields: { code: 'APP_BRIDGE_UNAVAILABLE', retryable: true },
}), { submit: false, reason: 'connection_unavailable' });
assert.deepEqual(classifyPluginDiagnosticSubmission({
  category: 'plugin.capture',
  fields: { code: 'CAPTURE_FAILED', expected: true },
}), { submit: false, reason: 'expected_outcome' });
assert.deepEqual(classifyPluginDiagnosticSubmission({
  category: 'plugin.capture',
  fields: { code: 'SPACE_INITIALIZING', retryable: true },
}), { submit: false, reason: 'expected_outcome' });

console.log(JSON.stringify({
  ok: true,
  queuedReports: storage[PLUGIN_DIAGNOSTICS_QUEUE_KEY].length,
  directSubmissions: fetchCalls.length,
  retryAlarmCreates,
}, null, 2));
