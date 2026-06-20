import { BROWSER_SESSIONS_KEY } from './browserSessionRuntime.js';
import { sendContentMessage } from './dynamicContentInjection.js';
import { getStoredMap } from './storage.js';
import { TAB_LEASES_KEY, subscribeActiveTabLeaseChanges } from './tabLeaseManager.js';

export const TARGET_CONTROL_BADGE_TYPE = 'AGENT_CONTROL_BADGE';
export const TARGET_GET_CONTROL_BADGE_STATE_TYPE = 'GET_AGENT_CONTROL_BADGE_STATE';
export const XWOW_CONTROL_BADGE_TYPE = 'xwow-data-ai:control-badge';

let initialized = false;
let unsubscribeLeaseChanges = null;

export function initializeTabControlBadges() {
  if (!unsubscribeLeaseChanges) {
    unsubscribeLeaseChanges = subscribeActiveTabLeaseChanges((event) => {
      void handleActiveTabLeaseChange(event).catch(() => {});
    });
  }
  registerLifecycleListeners();
  return { success: true, initialized, leaseChangeSubscribed: Boolean(unsubscribeLeaseChanges) };
}

export async function readTabControlBadgeState(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return inactiveBadgeState();
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const lease = leases[String(id)];
  if (!lease?.sessionId || lease.state !== 'active') return inactiveBadgeState();
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = sessions[lease.sessionId] || {};
  return {
    visible: true,
    state: 'active',
    label: 'RedBox 控制中',
    sessionName: String(session.name || '').trim(),
    sessionId: lease.sessionId || '',
    turnId: lease.turnId || '',
    origin: lease.origin || '',
    pageRole: lease.pageRole || '',
    claimedAt: lease.claimedAtIso || '',
  };
}

export async function reconcileTabControlBadge(tabId, reason = 'reconcile') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) {
    return { success: false, error: 'control badge requires tabId' };
  }
  const state = await readTabControlBadgeState(id);
  const result = await sendContentMessage(id, TARGET_CONTROL_BADGE_TYPE, state, 0).catch((error) => ({
    success: false,
    error: describeError(error),
  }));
  return { success: result?.success !== false, tabId: id, reason, state, result };
}

export async function republishActiveTabControlBadge(tabId, reason = 'republish') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'control badge requires tabId' };
  const state = await readTabControlBadgeState(id);
  if (!state.visible) return { success: true, tabId: id, reason, skipped: true, state };
  const result = await sendContentMessage(id, TARGET_CONTROL_BADGE_TYPE, state, 0).catch((error) => ({
    success: false,
    error: describeError(error),
  }));
  return { success: result?.success !== false, tabId: id, reason, state, result };
}

export async function clearTabControlBadge(tabId, reason = 'clear') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'control badge clear requires tabId' };
  const state = inactiveBadgeState();
  const result = await sendContentMessage(id, TARGET_CONTROL_BADGE_TYPE, state, 0).catch((error) => ({
    success: false,
    error: describeError(error),
  }));
  return { success: result?.success !== false, tabId: id, reason, state, result };
}

export async function clearLeaseControlBadges(leases = [], reason = 'clear_leases') {
  const results = [];
  for (const lease of leases) {
    if (lease?.tabId) {
      results.push(await clearTabControlBadge(lease.tabId, reason).catch((error) => ({
        success: false,
        tabId: lease.tabId,
        error: describeError(error),
      })));
    }
  }
  return { success: true, results };
}

async function handleActiveTabLeaseChange(event = {}) {
  const tabIds = changedTabIdsFromLeaseEvent(event);
  for (const tabId of tabIds) {
    await reconcileTabControlBadge(tabId, `lease_${event.type || 'changed'}`).catch(() => {});
  }
}

function registerLifecycleListeners() {
  if (initialized) return;
  initialized = true;
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo = {}) => {
    if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      void republishActiveTabControlBadge(tabId, `tab_${changeInfo.status}`).catch(() => {});
    }
  });
  chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
    void reconcileTabControlBadge(addedTabId, 'tab_replaced_added').catch(() => {});
    void clearTabControlBadge(removedTabId, 'tab_replaced_removed').catch(() => {});
  });
}

function changedTabIdsFromLeaseEvent(event = {}) {
  const ids = new Set();
  const add = (value) => {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  };
  add(event.tabId);
  add(event.payload?.tabId);
  add(event.payload?.addedTabId);
  add(event.payload?.removedTabId);
  return [...ids];
}

function inactiveBadgeState() {
  return { visible: false, state: 'inactive' };
}

function describeError(error) {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}
