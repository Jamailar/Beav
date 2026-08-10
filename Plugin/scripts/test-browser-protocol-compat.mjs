#!/usr/bin/env node

import assert from 'node:assert/strict';

const { createNativeMethodRouter } = await import('../src/background/commandRouter.js');
const { CHATGPT_BROWSER_AUTOMATION_REFERENCE, NATIVE_METHOD_SCHEMAS } = await import('../src/background/browserProtocolSchemas.js');

assert.equal(CHATGPT_BROWSER_AUTOMATION_REFERENCE.referenceId, 'chatgpt-chrome-extension-1.2.27236.6274');
for (const method of ['getBookmarks', 'getTopSites', 'getRecentlyClosedSessions', 'createNotification', 'markTab', 'focusTab', 'notifyCursorArrived']) {
  assert(NATIVE_METHOD_SCHEMAS[method], `compatibility inventory has a normalized schema for ${method}`);
}
assert.deepEqual(CHATGPT_BROWSER_AUTOMATION_REFERENCE.explicitlyNotAdopted, [
  'chat_specific_tab_mentions',
  'toolbar_usage_telemetry',
  'foreign_extension_iframe_blanking',
]);

const actions = [];
const cursorArrivals = [];
const router = createNativeMethodRouter({
  ping: () => ({ success: true }),
  getInfo: () => ({ success: true }),
  runBrowserAction: async (action, sessionId = '') => {
    actions.push({ action, sessionId });
    return { success: true, action };
  },
  notifyCursorArrived: (message) => cursorArrivals.push(message),
});

await router.route('getBookmarks', { maxResults: 3 });
await router.route('getTopSites', { limit: 4 });
await router.route('getRecentlyClosedSessions', { maxResults: 2 });
await router.route('focusTab', { id: 31, session_id: 'session-a' });
await router.route('markTab', { id: 31, status: 'handoff', session_id: 'session-a', turn_id: 'turn-a' });
await router.route('createNotification', { title: 'Browser ready', body: 'The handoff tab is ready.', priority: 1 });
await router.route('notifyCursorArrived', { session_id: 'session-a', turn_id: 'turn-a', move_sequence: 8 });
await router.route('tab_cdp_call', { tab_id: 31, method: 'Runtime.evaluate', params: { expression: 'document.title' } });
await router.route('tab_cdp_events', { tab_id: 31, cursor: 8, methods: ['Runtime.consoleAPICalled'] });

assert.deepEqual(actions.map(({ action }) => action.type), [
  'bookmarks.list',
  'topSites.list',
  'sessions.recentlyClosed',
  'tab.activate',
  'tab.mark',
  'notification.create',
  'cdp.send',
  'cdp.events',
]);
assert.equal(actions[0].action.limit, 3);
assert.equal(actions[3].action.tabId, 31);
assert.equal(actions[4].action.mark, 'handoff');
assert.equal(actions[5].action.message, 'The handoff tab is ready.');
assert.equal(actions[6].action.tabId, 31);
assert.equal(actions[7].action.cursor, 8);
assert.deepEqual(cursorArrivals, [{
  session_id: 'session-a',
  turn_id: 'turn-a',
  move_sequence: 8,
  sessionId: 'session-a',
  turnId: 'turn-a',
  moveSequence: 8,
}]);
await assert.rejects(
  () => router.route('markTab', { id: 31, mark: 'unknown' }),
  /handoff, deliverable, or clear/,
);
await assert.rejects(
  () => router.route('notifyCursorArrived', { session_id: 'session-a', move_sequence: 1 }),
  /requires turnId/,
);

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'comparison_aliases_route_to_canonical_actions',
    'comparison_inventory_is_a_local_schema_fixture',
    'cursor_arrival_requires_session_turn_and_sequence',
    'new_mutation_aliases_are_validated',
  ],
}, null, 2));
