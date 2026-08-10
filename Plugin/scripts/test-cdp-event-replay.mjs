#!/usr/bin/env node

import assert from 'node:assert/strict';

const sessionStore = {};
globalThis.chrome = {
  storage: {
    session: createStorageArea(sessionStore),
    local: createStorageArea({}),
  },
};

const { CDP_EVENT_LOG_LIMIT, listCdpEvents, recordCdpEvent } = await import('../src/background/cdpEventRuntime.js');

const first = await recordCdpEvent({ tabId: 8 }, 'Runtime.consoleAPICalled', { type: 'log' });
const second = await recordCdpEvent({ tabId: 8 }, 'Network.requestWillBeSent', { requestId: 'request-1' });
const third = await recordCdpEvent({ tabId: 9 }, 'Runtime.consoleAPICalled', { type: 'warning' });
assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);

const replay = await listCdpEvents({ cursor: first.sequence, limit: 10 });
assert.deepEqual(replay.events.map((event) => event.sequence), [2, 3], 'cursor replay is chronological after the acknowledged sequence');
assert.equal(replay.nextCursor, 3);
assert.equal(replay.retainedLimit, CDP_EVENT_LOG_LIMIT);

const filtered = await listCdpEvents({ methods: ['Runtime.consoleAPICalled'], limit: 10 });
assert.deepEqual(filtered.events.map((event) => event.method), ['Runtime.consoleAPICalled', 'Runtime.consoleAPICalled']);
assert.deepEqual(filtered.events.map((event) => event.sequence), [3, 1], 'legacy replay remains newest-first without a cursor');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'cdp_events_have_monotonic_persisted_sequence',
    'cursor_replay_is_chronological',
    'method_list_filter_and_retention_metadata_are_exposed',
  ],
}, null, 2));

function createStorageArea(store) {
  return {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, clone(store[key])]));
    },
    async set(values) {
      Object.assign(store, clone(values));
    },
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
