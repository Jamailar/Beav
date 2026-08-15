import { getNativeStatus } from './nativeTransport.js';
import { EXTENSION_INSTANCE_ID_KEY } from './lifecycleGuard.js';

export const PLUGIN_DIAGNOSTICS_QUEUE_KEY = 'redboxPluginDiagnosticsQueue';
export const PLUGIN_DIAGNOSTICS_RECENT_KEY = 'redboxPluginDiagnosticsRecent';
export const PLUGIN_DIAGNOSTICS_RETRY_ALARM = 'redbox-plugin-diagnostics-retry';
export const PLUGIN_FEEDBACK_ENDPOINT = 'https://api.ziz.hk/beav/v1/public-feedback';

const QUEUE_LIMIT = 40;
const RECENT_LIMIT = 120;
const SAME_INCIDENT_COOLDOWN_MS = 24 * 60 * 60_000;
const RETRY_COOLDOWN_MS = 30_000;
const DRAIN_BATCH_LIMIT = 4;
const MAX_MESSAGE_CHARS = 600;
const MAX_FIELD_CHARS = 500;
const DIRECT_SUBMIT_TIMEOUT_MS = 8_000;
const MAX_DELIVERY_ATTEMPTS = 8;

let drainPromise = null;
let enqueuePromise = Promise.resolve();
let installationFingerprintPromise = null;

export async function reportPluginError(error, options = {}) {
  const next = enqueuePromise.then(() => enqueuePluginError(error, options));
  enqueuePromise = next.catch(() => {});
  return await next;
}

async function enqueuePluginError(error, options = {}) {
  const payload = buildPluginDiagnosticPayload(error, options);
  const submission = classifyPluginDiagnosticSubmission(payload);
  if (!submission.submit) {
    return {
      success: true,
      skipped: true,
      reason: submission.reason,
      queued: 0,
    };
  }
  const installationIdHash = await resolveInstallationFingerprint();
  if (installationIdHash) payload.fields.installationIdHash = installationIdHash;
  const dedupeKey = buildDedupeKey(payload);
  const now = Date.now();
  const store = await readDiagnosticStore();
  const recent = pruneRecentReports(store.recent, now);
  const previousEpisode = readEpisode(recent[dedupeKey]);

  if (previousEpisode && now - previousEpisode.lastSeenAt < SAME_INCIDENT_COOLDOWN_MS) {
    const episode = nextEpisode(previousEpisode, now);
    recent[dedupeKey] = episode;
    const queue = updateQueuedEpisode(store.queue, dedupeKey, episode);
    await writeDiagnosticStore({
      queue,
      recent: pruneRecentReports(recent, now),
    });
    return {
      ...(await drainPluginDiagnostics()),
      skipped: true,
      reason: 'active_episode',
      occurrences: episode.occurrences,
    };
  }

  const episode = {
    firstSeenAt: now,
    lastSeenAt: now,
    occurrences: 1,
  };
  recent[dedupeKey] = episode;
  payload.fields = withEpisodeFields(payload.fields, dedupeKey, episode);
  const queue = Array.isArray(store.queue) ? store.queue.slice() : [];
  const existing = queue.find((entry) => entry?.dedupeKey === dedupeKey);
  if (existing) {
    existing.lastSeenAt = now;
    existing.occurrences = Math.min(999, Number(existing.occurrences || 1) + 1);
    existing.payload = {
      ...existing.payload,
      fields: {
        ...(existing.payload?.fields || {}),
        occurrences: existing.occurrences,
        lastSeenAt: new Date(now).toISOString(),
      },
    };
  } else {
    queue.push({
      id: `plugin-diagnostic-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      dedupeKey,
      queuedAt: now,
      lastSeenAt: now,
      lastAttemptAt: 0,
      attempts: 0,
      occurrences: 1,
      payload,
    });
  }

  const nextQueue = queue
    .filter((entry) => entry && entry.payload)
    .slice(-QUEUE_LIMIT);
  await writeDiagnosticStore({
    queue: nextQueue,
    recent: pruneRecentReports(recent, now),
  });
  await schedulePluginDiagnosticsRetry();
  return await drainPluginDiagnostics();
}

export async function drainPluginDiagnostics() {
  if (drainPromise) return await drainPromise;
  drainPromise = (async () => {
    let sent = 0;
    let dropped = 0;
    for (let index = 0; index < DRAIN_BATCH_LIMIT; index += 1) {
      const store = await readDiagnosticStore();
      const now = Date.now();
      const entry = store.queue.find((candidate) => (
        candidate
          && candidate.payload
          && (now - Number(candidate.lastAttemptAt || 0) >= RETRY_COOLDOWN_MS)
      ));
      if (!entry) break;

      const submission = classifyPluginDiagnosticSubmission(entry.payload);
      if (!submission.submit) {
        await removeQueuedReport(entry.id);
        dropped += 1;
        continue;
      }
      await markAttempt(entry.id, now);
      try {
        await submitPluginDiagnostic(entry.payload, entry.id);
        await removeQueuedReport(entry.id);
        sent += 1;
      } catch (error) {
        if (error?.permanent === true || Number(entry.attempts || 0) + 1 >= MAX_DELIVERY_ATTEMPTS) {
          await removeQueuedReport(entry.id);
          dropped += 1;
        }
        break;
      }
    }

    const pending = (await readDiagnosticStore()).queue.length;
    if (pending > 0) {
      await schedulePluginDiagnosticsRetry();
    } else {
      await clearPluginDiagnosticsRetry();
    }
    return { success: true, sent, dropped, queued: pending };
  })().finally(() => {
    drainPromise = null;
  });
  return await drainPromise;
}

export async function submitPluginDiagnostic(payload, reportId = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DIRECT_SUBMIT_TIMEOUT_MS);
  try {
    const response = await fetch(PLUGIN_FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildPluginFeedbackRequest(payload, reportId)),
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = createDiagnosticSendError(
        responseBody?.message || `Plugin diagnostics failed with HTTP ${response.status}`,
      );
      error.status = response.status;
      error.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      throw error;
    }
    return {
      success: true,
      status: response.status,
      response: responseBody,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildPluginFeedbackRequest(payload = {}, reportId = '') {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const category = String(payload.category || '').includes('connection')
    ? 'plugin_connection'
    : 'plugin_capture';
  const event = safeToken(payload.event || 'plugin.error', 'plugin.error');
  const trigger = safeToken(payload.trigger || 'plugin_error', 'plugin_error');
  const code = safeToken(fields.code || 'PLUGIN_ERROR', 'PLUGIN_ERROR');
  const phase = safeToken(fields.phase || '', 'unknown');
  const extensionVersion = String(fields.extensionVersion || '').slice(0, 32);
  const browser = safeToken(fields.browser || 'unknown', 'unknown');
  const message = redactText(payload.message || 'Browser plugin error', 1_000);
  const context = sanitizeValue({
    schema: 'redbox.browserPluginDiagnostic.v1',
    automatic: true,
    reportId: safeToken(reportId, ''),
    event,
    trigger,
    fields,
  });
  return {
    title: category === 'plugin_connection'
      ? '浏览器插件连接失败（自动上报）'
      : '浏览器插件采集失败（自动上报）',
    content: `插件自动上报：${message}`.slice(0, 4_000),
    category,
    priority: classifyPluginFeedbackPriority(payload),
    source: 'browser_extension',
    request_kind: 'plugin_error',
    client: {
      product: 'beav',
      extensionVersion,
      browser,
    },
    log_text: redactText(`event=${event} trigger=${trigger} code=${code} phase=${phase}`, 600),
    attachments: [],
    context,
  };
}

export function classifyPluginFeedbackPriority(payload = {}) {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const code = String(fields.code || '').trim().toUpperCase();
  const message = String(payload.message || '');
  const nativeStatus = fields.nativeStatus && typeof fields.nativeStatus === 'object'
    ? fields.nativeStatus
    : {};
  const expectedDisconnect = fields.expected === true
    || fields.userActionRequired === true
    || nativeStatus.expectedDisconnect === true
    || nativeStatus.lifecycle?.expected === true;
  const expectedCaptureFailure = /^(OPERATION_CANCELLED|POLICY_DENIED|URL_NOT_BELONG_TO_XIAOHONGSHU|UNSUPPORTED_URL|UNSUPPORTED_PAGE|CAPTURE_NOT_APPLICABLE|SPACE_INITIALIZING)$/.test(code)
    || /^URL does not belong to (?:小红书|Xiaohongshu)$/i.test(message.trim());
  const expectedConnectionState = /^(APP_NOT_RUNNING|APP_STARTING|APP_SHUTTING_DOWN|APP_BRIDGE_UNAVAILABLE|NATIVE_HOST_RESTARTING)$/.test(code);
  const protocolOrAuthorizationFailure = /(?:PROTOCOL_MISMATCH|AUTHENTICATION_FAILED|VERSION_STALE|UNTRUSTED_ORIGIN)/.test(code);
  const outcomeUnknown = /(?:WRITE_OUTCOME_UNKNOWN|OPERATION_OUTCOME_UNKNOWN)/.test(code);

  if (expectedDisconnect || expectedCaptureFailure || expectedConnectionState) return 'low';
  if (protocolOrAuthorizationFailure || outcomeUnknown) return 'high';
  return 'normal';
}

export function classifyPluginDiagnosticSubmission(payload = {}) {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const category = String(payload.category || '').trim().toLowerCase();
  const event = String(payload.event || '').trim().toLowerCase();
  const code = String(fields.code || '').trim().toUpperCase();
  const priority = classifyPluginFeedbackPriority(payload);
  const nativeStatus = fields.nativeStatus && typeof fields.nativeStatus === 'object'
    ? fields.nativeStatus
    : {};
  const expected = fields.expected === true
    || fields.userActionRequired === true
    || nativeStatus.expectedDisconnect === true
    || nativeStatus.lifecycle?.expected === true;
  const expectedOutcome = /^(OPERATION_CANCELLED|POLICY_DENIED|URL_NOT_BELONG_TO_XIAOHONGSHU|UNSUPPORTED_URL|UNSUPPORTED_PAGE|CAPTURE_NOT_APPLICABLE|SPACE_INITIALIZING)$/.test(code);
  const unavailableConnection = /^(APP_NOT_RUNNING|APP_STARTING|APP_SHUTTING_DOWN|APP_BRIDGE_UNAVAILABLE|NATIVE_HOST_EXITED|NATIVE_HOST_NOT_REGISTERED|NATIVE_HOST_RESTARTING|NATIVE_TRANSPORT_DISCONNECTED)$/.test(code);

  if (event.endsWith('.recovered')) return { submit: false, reason: 'recovery_telemetry' };
  if (expected || expectedOutcome) return { submit: false, reason: 'expected_outcome' };
  if (category.includes('connection')) {
    return priority === 'high' && fields.retryable !== true
      ? { submit: true, reason: 'actionable_connection_failure' }
      : { submit: false, reason: 'connection_telemetry' };
  }
  if (unavailableConnection) return { submit: false, reason: 'connection_unavailable' };
  return { submit: true, reason: 'actionable_operation_failure' };
}

export async function schedulePluginDiagnosticsRetry() {
  if (!globalThis.chrome?.alarms?.create) return;
  const existing = await callChromePromise(
    globalThis.chrome.alarms.get?.(PLUGIN_DIAGNOSTICS_RETRY_ALARM),
    null,
  );
  if (!existing) {
    await callChromePromise(
      globalThis.chrome.alarms.create(PLUGIN_DIAGNOSTICS_RETRY_ALARM, {
        periodInMinutes: 1,
      }),
      undefined,
    );
  }
}

export async function clearPluginDiagnosticsRetry() {
  await callChromePromise(
    globalThis.chrome?.alarms?.clear?.(PLUGIN_DIAGNOSTICS_RETRY_ALARM),
    undefined,
  );
}

export function buildPluginDiagnosticPayload(error, options = {}) {
  const errorRecord = error && typeof error === 'object' ? error : {};
  const message = redactText(
    options.message || errorRecord.message || error || 'Browser plugin error',
    MAX_MESSAGE_CHARS,
  );
  const code = safeToken(options.code || errorRecord.code || 'PLUGIN_ERROR', 'PLUGIN_ERROR');
  const operation = safeToken(options.operation || 'unknown', 'unknown');
  const event = safeToken(options.event || 'plugin.error', 'plugin.error');
  const category = safeToken(options.category || 'plugin.browser', 'plugin.browser');
  const trigger = safeToken(options.trigger || 'plugin_error', 'plugin_error');
  const nativeStatus = compactNativeStatus(getNativeStatus());
  const manifest = globalThis.chrome?.runtime?.getManifest?.() || {};

  const fields = sanitizeValue({
    source: 'browser_extension',
    extensionVersion: String(manifest.version_name || manifest.version || '').slice(0, 32),
    browser: detectBrowserFamily(),
    operation,
    code,
    phase: safeToken(options.phase || errorRecord.phase || '', ''),
    retryable: errorRecord.retryable === true || options.retryable === true,
    expected: errorRecord.expected === true || options.expected === true,
    errorName: String(errorRecord.name || '').slice(0, 80),
    nativeStatus,
    ...(options.sourceOrigin ? { sourceOrigin: safeOrigin(options.sourceOrigin) } : {}),
    ...(options.fields && typeof options.fields === 'object' ? options.fields : {}),
    ...(errorRecord.details ? { details: errorRecord.details } : {}),
  });

  return {
    level: options.level || 'error',
    category,
    event,
    message: message || 'Browser plugin error',
    fields,
    trigger,
  };
}

function buildDedupeKey(payload) {
  const fields = payload.fields || {};
  return [
    payload.category,
    normalizeDiagnosticOperation(fields.operation),
    fields.code,
    fields.phase,
  ].map((value) => String(value || '').slice(0, 96)).join(':').slice(0, 320);
}

function normalizeDiagnosticOperation(value = '') {
  return String(value).replace(/^(?:message|task):/, 'workflow:');
}

async function readDiagnosticStore() {
  const result = await callChromePromise(
    globalThis.chrome?.storage?.local?.get?.([
      PLUGIN_DIAGNOSTICS_QUEUE_KEY,
      PLUGIN_DIAGNOSTICS_RECENT_KEY,
    ]),
    {},
  );
  return {
    queue: Array.isArray(result?.[PLUGIN_DIAGNOSTICS_QUEUE_KEY])
      ? result[PLUGIN_DIAGNOSTICS_QUEUE_KEY].filter((entry) => entry && typeof entry === 'object')
      : [],
    recent: result?.[PLUGIN_DIAGNOSTICS_RECENT_KEY]
      && typeof result[PLUGIN_DIAGNOSTICS_RECENT_KEY] === 'object'
      ? result[PLUGIN_DIAGNOSTICS_RECENT_KEY]
      : {},
  };
}

async function writeDiagnosticStore({ queue, recent }) {
  await globalThis.chrome?.storage?.local?.set?.({
    [PLUGIN_DIAGNOSTICS_QUEUE_KEY]: Array.isArray(queue) ? queue.slice(-QUEUE_LIMIT) : [],
    [PLUGIN_DIAGNOSTICS_RECENT_KEY]: recent || {},
  });
}

async function markAttempt(id, now) {
  const store = await readDiagnosticStore();
  const queue = store.queue.map((entry) => (
    entry.id === id
      ? { ...entry, attempts: Number(entry.attempts || 0) + 1, lastAttemptAt: now }
      : entry
  ));
  await writeDiagnosticStore({ queue, recent: store.recent });
}

async function removeQueuedReport(id) {
  const store = await readDiagnosticStore();
  await writeDiagnosticStore({
    queue: store.queue.filter((entry) => entry.id !== id),
    recent: store.recent,
  });
}

function pruneRecentReports(recent, now) {
  return Object.fromEntries(
    Object.entries(recent || {})
      .filter(([, episode]) => readEpisode(episode)?.lastSeenAt > now - 24 * 60 * 60 * 1000)
      .sort((left, right) => (
        Number(readEpisode(right[1])?.lastSeenAt || 0) - Number(readEpisode(left[1])?.lastSeenAt || 0)
      ))
      .slice(0, RECENT_LIMIT),
  );
}

function readEpisode(value) {
  if (Number.isFinite(Number(value))) {
    const timestamp = Number(value);
    return timestamp > 0
      ? { firstSeenAt: timestamp, lastSeenAt: timestamp, occurrences: 1 }
      : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const firstSeenAt = Number(value.firstSeenAt || value.lastSeenAt || 0);
  const lastSeenAt = Number(value.lastSeenAt || firstSeenAt || 0);
  if (firstSeenAt <= 0 || lastSeenAt <= 0) return null;
  return {
    firstSeenAt,
    lastSeenAt,
    occurrences: Math.max(1, Math.min(999, Number(value.occurrences || 1))),
  };
}

function nextEpisode(episode, now) {
  return {
    firstSeenAt: Number(episode.firstSeenAt || now),
    lastSeenAt: now,
    occurrences: Math.min(999, Math.max(1, Number(episode.occurrences || 1)) + 1),
  };
}

function withEpisodeFields(fields, incidentKey, episode) {
  return {
    ...(fields || {}),
    incidentKey,
    occurrences: episode.occurrences,
    firstSeenAt: new Date(episode.firstSeenAt).toISOString(),
    lastSeenAt: new Date(episode.lastSeenAt).toISOString(),
  };
}

function updateQueuedEpisode(entries, dedupeKey, episode) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (entry?.dedupeKey !== dedupeKey || !entry.payload) return entry;
    return {
      ...entry,
      lastSeenAt: episode.lastSeenAt,
      occurrences: episode.occurrences,
      payload: {
        ...entry.payload,
        fields: withEpisodeFields(entry.payload.fields, dedupeKey, episode),
      },
    };
  });
}

async function resolveInstallationFingerprint() {
  if (!installationFingerprintPromise) {
    installationFingerprintPromise = (async () => {
      const stored = await callChromePromise(
        globalThis.chrome?.storage?.local?.get?.(EXTENSION_INSTANCE_ID_KEY),
        {},
      );
      const installationId = String(stored?.[EXTENSION_INSTANCE_ID_KEY] || '').trim();
      if (!installationId || !globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return '';
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`beav-plugin-diagnostic:${installationId}`),
      );
      return [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
    })().catch(() => '');
  }
  return await installationFingerprintPromise;
}

function compactNativeStatus(status = {}) {
  const bridge = status.handshake?.desktopBridge && typeof status.handshake.desktopBridge === 'object'
    ? status.handshake.desktopBridge
    : {};
  return {
    state: safeToken(status.state || 'unknown', 'unknown'),
    reconnectAttempt: Number.isInteger(Number(status.reconnectAttempt))
      ? Number(status.reconnectAttempt)
      : 0,
    error: redactText(status.error || '', 240),
    desktopBridgeConnected: bridge.connected === true,
    bridgeErrorCode: safeToken(bridge.errorCode || '', ''),
    bridgePhase: safeToken(bridge.phase || '', ''),
    bridgeReconnectAttempt: Math.max(0, Number(bridge.bridgeReconnectAttempt || 0)),
    descriptorAgeMs: Math.max(0, Number(bridge.details?.descriptorAgeMs || 0)),
    nativeHostVersion: safeToken(status.handshake?.appVersion || '', ''),
    desktopAppVersion: safeToken(bridge.appVersion || '', ''),
    expectedDisconnect: status.expectedDisconnect === true,
    nextRetryMs: Math.max(0, Number(status.nextRetryMs || 0)),
    lifecycle: status.lifecycle && typeof status.lifecycle === 'object'
      ? {
        reason: safeToken(status.lifecycle.reason || 'unknown', 'unknown'),
        expected: status.lifecycle.expected === true,
      }
      : null,
  };
}

function sanitizeValue(value, key = '', depth = 0) {
  if (depth > 3) return '[TRUNCATED]';
  if (isSensitiveKey(key)) return '[REDACTED_SECRET]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/url|link|origin|href|source/i.test(key)) return safeOrigin(value);
    return redactText(value, MAX_FIELD_CHARS);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 24)
        .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_FIELD_CHARS);
}

function isSensitiveKey(key) {
  return /authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh|content|html|markdown|body|payload|attachment|base64|binary|blob|raw|file|image|media|path/i.test(String(key || ''));
}

function redactText(value, maxChars) {
  return String(value ?? '')
    .replace(/data:(?:image|audio|video)\/[\w.+-]+;base64,[^\s]+/gi, '[REDACTED_DATA_URI]')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|secret|code|signature)=)[^&\s]+/gi, '$1[REDACTED_SECRET]')
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/var\/folders\/)[^\s,;]+/g, '[REDACTED_PATH]')
    .slice(0, maxChars);
}

function safeOrigin(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return '[REDACTED_URL]';
    return url.origin;
  } catch {
    return redactText(raw, 160);
  }
}

function safeToken(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 96);
  return normalized || fallback;
}

async function callChromePromise(value, fallback) {
  try {
    return await value;
  } catch {
    return fallback;
  }
}

function detectBrowserFamily() {
  const userAgent = String(globalThis.navigator?.userAgent || '');
  if (/Edg\//i.test(userAgent)) return 'edge';
  if (/Brave\//i.test(userAgent) || globalThis.navigator?.brave) return 'brave';
  if (/Chromium\//i.test(userAgent)) return 'chromium';
  if (/Chrome\//i.test(userAgent)) return 'chrome';
  return 'unknown';
}

function createDiagnosticSendError(message) {
  const error = new Error(String(message || 'Plugin diagnostics submission failed'));
  error.retryable = true;
  return error;
}
