#!/usr/bin/env node

import assert from 'node:assert/strict';

const sessionStore = {};
const localStore = {};

globalThis.chrome = {
  tabs: {
    get: async (tabId) => ({ id: Number(tabId), active: false }),
  },
  storage: {
    session: createStorageArea(sessionStore),
    local: createStorageArea(localStore),
  },
};

const {
  BROWSER_SESSIONS_KEY,
  createBrowserSession,
  finishBrowserSessionRequest,
  getBrowserSession,
  startBrowserSessionRequest,
} = await import('../src/background/browserSessionRuntime.js');
const {
  TAB_LEASES_KEY,
  claimChildTabForSourceLease,
  claimTabForSession,
  handoffTabForUser,
  listTabLeases,
  releaseTabsForSession,
  resumeHandoffTabs,
  setTabMarkForSession,
} = await import('../src/background/tabLeaseManager.js');
const { getBrowserControlStateRevision } = await import('../src/background/storage.js');

const first = (await createBrowserSession('test')).session;
const second = (await createBrowserSession('test')).session;

const claims = await Promise.allSettled([
  claimTabForSession(first, 101, 'user'),
  claimTabForSession(second, 101, 'user'),
]);
assert.equal(claims.filter((entry) => entry.status === 'fulfilled').length, 1, 'exactly one session may claim a tab');
assert.equal(claims.filter((entry) => entry.status === 'rejected').length, 1, 'claim conflict must be terminal');
assert.equal((await listTabLeases()).filter((lease) => lease.tabId === 101).length, 1, 'only one active lease is persisted');

const request = { requestId: 'same-call', action: 'page.queryElements', tabId: 101, turnId: first.turnId };
const starts = await Promise.all([
  startBrowserSessionRequest(first.sessionId, request),
  startBrowserSessionRequest(first.sessionId, request),
]);
assert.equal(starts.filter((entry) => entry.duplicateActive === true).length, 1, 'duplicate active request is rejected');
assert.equal(starts.filter((entry) => entry.duplicateActive !== true).length, 1, 'one request starts');
await finishBrowserSessionRequest(first.sessionId, request.requestId, {
  success: true,
  response: { success: true, value: 'receipt' },
});
const replay = await startBrowserSessionRequest(first.sessionId, request);
assert.equal(replay.replayed, true, 'terminal request is replayed instead of re-executed');
assert.equal(replay.response?.value, 'receipt');

const released = await releaseTabsForSession(first.sessionId, [101], 'test_release');
assert.equal(released.released, true);
assert.equal((await listTabLeases()).some((lease) => lease.tabId === 101), false, 'lease release is durable');
const persistedSession = await getBrowserSession(first.sessionId);
assert.equal(persistedSession?.ownedTabIds.includes(101), false, 'release updates the owning session in the same mutation');

await claimTabForSession(first, 201, 'agent');
const child = await claimChildTabForSourceLease(201, 202, { pageRole: 'popup' });
assert.equal(child.claimed, true, 'an active source lease may atomically claim its child tab');
assert.equal(child.lease?.sessionId, first.sessionId);
assert.equal(child.lease?.turnId, first.currentTurnId);
assert.equal(child.lease?.parentTabId, 201);
assert.equal((await getBrowserSession(first.sessionId))?.ownedTabIds.includes(202), true, 'child ownership is persisted with the parent session');
const marked = await setTabMarkForSession(first, 202, 'handoff');
assert.equal(marked.mark, 'handoff', 'a session can mark only its active leased tab');
assert.equal((await listTabLeases()).find((lease) => lease.tabId === 202)?.mark, 'handoff');

const handoff = await handoffTabForUser(first, 202, {
  reason: 'bot_verification_required',
  ttlMs: 1,
});
assert.equal(handoff.handoff.reason, 'bot_verification_required');
assert.equal(handoff.lease.state, 'handoff', 'manual verification changes only the retained lease to handoff');
assert(handoff.handoff.ttlMs >= 5 * 60_000, 'handoff TTL has a five-minute lower bound');
assert.equal((await getBrowserSession(first.sessionId))?.pendingUserHandoff?.tabId, 202, 'session persists the one pending manual verification handoff');
const resumed = await resumeHandoffTabs(first.sessionId, 'turn-after-verification', { reason: 'user_completed_verification' });
assert.equal(resumed.resumed, true, 'a live retained tab resumes on the next turn');
assert.equal((await listTabLeases()).find((lease) => lease.tabId === 202)?.state, 'active');
assert.equal((await listTabLeases()).find((lease) => lease.tabId === 202)?.turnId, 'turn-after-verification');
assert.equal((await getBrowserSession(first.sessionId))?.pendingUserHandoff, null, 'resume clears the completed handoff without retaining user auth state');

const staleSource = await claimChildTabForSourceLease(101, 102, { pageRole: 'popup' });
assert.equal(staleSource.claimed, false, 'a released source lease cannot claim a late child tab');
assert.equal(typeof sessionStore[BROWSER_SESSIONS_KEY], 'object');
assert.equal(typeof sessionStore[TAB_LEASES_KEY], 'object');
assert((await getBrowserControlStateRevision()) > 0, 'state revision is advanced for persisted mutations');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'concurrent_cross_session_claim_is_serialized',
    'duplicate_request_is_idempotent',
    'release_updates_lease_and_session_together',
    'child_tab_inherits_active_source_session_and_turn',
    'tab_mark_is_scoped_to_active_session_turn',
    'manual_verification_handoff_is_ttl_bounded_and_resumable',
    'late_child_target_is_rejected_after_source_release',
  ],
}, null, 2));

function createStorageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return clone(store);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, clone(store[key])]));
    },
    async set(values) {
      Object.assign(store, clone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
