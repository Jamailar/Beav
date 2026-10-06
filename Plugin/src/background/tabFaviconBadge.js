import { sendContentMessage } from './dynamicContentInjection.js';
import { getStoredMap, setStoredMap } from './storage.js';
import { getOwningSessionId, mightHaveActiveTabLease, subscribeActiveTabLeaseChanges } from './tabLeaseManager.js';

export const CONTENT_TAB_FAVICON_BADGE_TYPE = 'TAB_FAVICON_BADGE';
export const FINALIZED_TAB_BADGES_KEY = 'xwowBrowserDataAiFinalizedTabBadges';

let lifecycleListenersRegistered = false;
let unsubscribeLeaseChanges = null;
const pendingStatusCompleteReconciles = new Map();

export async function setTabFaviconBadge(tabId, badge, options = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'favicon badge requires tabId' };
  const faviconDataUrl = options.faviconDataUrl || await resolveTabFaviconHref(id);
  if (!faviconDataUrl) return { success: false, tabId: id, error: 'favicon_unavailable' };
  const result = await sendContentMessage(id, CONTENT_TAB_FAVICON_BADGE_TYPE, { badge, faviconDataUrl }, 0);
  return { ...result, badge };
}

export async function clearTabFaviconBadge(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'favicon badge clear requires tabId' };
  return await sendContentMessage(id, CONTENT_TAB_FAVICON_BADGE_TYPE, { badge: null, faviconDataUrl: null }, 0);
}

export async function applyLeaseFaviconBadge(lease = {}) {
  if (!lease?.tabId) return { success: false, error: 'lease favicon badge requires tabId' };
  return await reconcileTabFaviconBadge(lease.tabId, 'lease_apply');
}

export async function clearLeaseFaviconBadges(leases = []) {
  const results = [];
  for (const lease of leases) {
    if (lease?.tabId) {
      results.push(await reconcileTabFaviconBadge(lease.tabId, 'lease_clear').catch((error) => ({ success: false, tabId: lease.tabId, error: describeError(error) })));
    }
  }
  return { success: true, results };
}

export async function markFinalizedBadges(finalized = []) {
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  const markedAt = new Date().toISOString();
  const records = [];
  for (const item of finalized) {
    const tabId = Number(item?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) continue;
    const status = item.status === 'deliverable' ? 'deliverable' : 'handoff';
    const unseen = !(await tabIsVisible(tabId));
    const record = {
      tabId,
      status,
      sessionId: item.lease?.sessionId || '',
      turnId: item.lease?.turnId || '',
      pageRole: item.lease?.pageRole || '',
      unseen,
      finalizedAt: item.lease?.finalizedAt || markedAt,
      seenAt: unseen ? '' : markedAt,
    };
    badges[String(tabId)] = record;
    records.push(record);
  }
  await setStoredMap(FINALIZED_TAB_BADGES_KEY, badges);
  for (const record of records) {
    await setTabFaviconBadge(record.tabId, finalizedVisualBadge(record)).catch(() => {});
  }
  return { success: true, records, hasUnseen: records.some((record) => record.unseen) };
}

export function initializeTabFaviconBadges() {
  registerTabFaviconBadgeLifecycleListeners();
  if (!unsubscribeLeaseChanges) {
    unsubscribeLeaseChanges = subscribeActiveTabLeaseChanges((event) => {
      void handleActiveTabLeaseChange(event).catch(() => {});
    });
  }
  return { success: true, initialized: lifecycleListenersRegistered, leaseChangeSubscribed: Boolean(unsubscribeLeaseChanges) };
}

export async function replaceFinalizedBadge(tabId, reason = 'activated') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'replaceFinalizedBadge requires tabId' };
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  const record = badges[String(id)];
  if (!record) return { success: true, replaced: false };
  const updated = {
    ...record,
    unseen: false,
    seenAt: record.seenAt || new Date().toISOString(),
    seenReason: reason,
  };
  badges[String(id)] = updated;
  await setStoredMap(FINALIZED_TAB_BADGES_KEY, badges);
  await reconcileTabFaviconBadge(id, reason).catch(() => {});
  return { success: true, replaced: true, record: updated };
}

export async function moveFinalizedBadge(addedTabId, removedTabId, reason = 'replaced') {
  const added = Number(addedTabId);
  const removed = Number(removedTabId);
  if (!Number.isInteger(added) || added <= 0 || !Number.isInteger(removed) || removed <= 0) {
    return { success: false, error: 'moveFinalizedBadge requires addedTabId and removedTabId' };
  }
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  const record = badges[String(removed)];
  if (!record) return { success: true, moved: false };
  delete badges[String(removed)];
  const moved = {
    ...record,
    tabId: added,
    replacedFromTabId: removed,
    replacedAt: new Date().toISOString(),
    replacedReason: reason,
  };
  badges[String(added)] = moved;
  await setStoredMap(FINALIZED_TAB_BADGES_KEY, badges);
  await reconcileTabFaviconBadge(removed, `${reason}_removed`).catch(() => {});
  await reconcileTabFaviconBadge(added, reason).catch(() => {});
  return { success: true, moved: true, record: moved };
}

export async function clearFinalizedBadge(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'clearFinalizedBadge requires tabId' };
  await clearFinalizedBadges([id]);
  await reconcileTabFaviconBadge(id, 'finalized_cleared').catch(() => {});
  return { success: true, cleared: true, tabId: id };
}

export async function republishFinalizedBadge(tabId, reason = 'updated') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'republishFinalizedBadge requires tabId' };
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  const record = badges[String(id)];
  if (!record) return { success: true, republished: false };
  const result = await reconcileTabFaviconBadge(id, reason).catch((error) => ({ success: false, error: describeError(error) }));
  return { success: result?.success !== false, republished: true, reason, record, result };
}

export async function clearFinalizedBadges(tabIds = []) {
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  let changed = false;
  for (const tabId of tabIds) {
    const id = Number(tabId);
    if (Number.isInteger(id) && badges[String(id)]) {
      delete badges[String(id)];
      changed = true;
    }
  }
  if (changed) await setStoredMap(FINALIZED_TAB_BADGES_KEY, badges);
  return { success: true, cleared: changed };
}

export async function hasUnseenFinalizedBadges() {
  const badges = await listFinalizedBadges();
  return {
    success: true,
    hasUnseen: badges.records.some((record) => record.unseen),
    unseenCount: badges.records.filter((record) => record.unseen).length,
  };
}

export async function listFinalizedBadges(options = {}) {
  const badges = Object.values(await getStoredMap(FINALIZED_TAB_BADGES_KEY));
  const limit = clamp(Number(options.limit || 100), 1, 500);
  return {
    success: true,
    records: badges
      .sort((a, b) => String(b.finalizedAt || '').localeCompare(String(a.finalizedAt || '')))
      .slice(0, limit),
  };
}

function normalizeLeaseBadge(state, lease = {}) {
  if (lease.unseen === true && state === 'handoff') return 'unseen-handoff';
  if (lease.unseen === true && state === 'deliverable') return 'unseen-deliverable';
  if (state === 'active') return 'active';
  if (state === 'handoff') return 'handoff';
  if (state === 'deliverable') return 'deliverable';
  return null;
}

function finalizedVisualBadge(record = {}) {
  if (record.unseen === true && record.status === 'deliverable') return 'unseen-deliverable';
  if (record.unseen === true) return 'unseen-handoff';
  return record.status === 'deliverable' ? 'deliverable' : 'handoff';
}

export async function reconcileTabFaviconBadge(tabId, reason = 'reconcile') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'reconcileTabFaviconBadge requires tabId' };
  const badge = await readEffectiveBadge(id);
  if (!badge) {
    const result = await clearTabFaviconBadge(id).catch((error) => ({ success: false, error: describeError(error) }));
    return { success: result?.success !== false, tabId: id, badge: null, reason, result };
  }
  const result = await setTabFaviconBadge(id, badge).catch((error) => ({ success: false, error: describeError(error) }));
  return { success: result?.success !== false, tabId: id, badge, reason, result };
}

export async function readEffectiveBadge(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if ((await getOwningSessionId(id)) != null) return 'active';
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  const record = badges[String(id)];
  return record ? finalizedVisualBadge(record) : null;
}

async function handleActiveTabLeaseChange(event = {}) {
  if (event.type === 'active.synced') return;
  const tabIds = changedTabIdsFromLeaseEvent(event);
  for (const tabId of tabIds) {
    if (event.type === 'claimed' || event.type === 'handoff.resumed') {
      await clearFinalizedBadges([tabId]).catch(() => {});
    }
    await reconcileTabFaviconBadge(tabId, `lease_${event.type || 'changed'}`).catch(() => {});
  }
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

function registerTabFaviconBadgeLifecycleListeners() {
  if (lifecycleListenersRegistered) return;
  lifecycleListenersRegistered = true;
  chrome.tabs.onActivated?.addListener((activeInfo) => {
    if (Number.isInteger(activeInfo?.tabId)) {
      void replaceFinalizedBadge(activeInfo.tabId, 'tab_activated').catch(() => {});
    }
  });
  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void clearFocusedWindowFinalizedBadge(windowId).catch(() => {});
  });
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo = {}) => {
    void handleTabFaviconUpdated(tabId, changeInfo).catch(() => {});
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    void clearFinalizedBadge(tabId).catch(() => {});
  });
  chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
    void moveFinalizedBadge(addedTabId, removedTabId, 'tab_replaced').catch(() => {});
  });
}

async function handleTabFaviconUpdated(tabId, changeInfo = {}) {
  if (changeInfo.favIconUrl != null && isBadgeFaviconUrl(changeInfo.favIconUrl)) return;
  const faviconChanged = changeInfo.favIconUrl != null;
  if (changeInfo.url != null || faviconChanged) {
    if (pendingStatusCompleteReconciles.has(tabId)) {
      clearTimeout(pendingStatusCompleteReconciles.get(tabId));
      pendingStatusCompleteReconciles.delete(tabId);
    }
    if (await mightHaveBadge(tabId)) await reconcileTabFaviconBadge(tabId, 'tab_updated');
    return;
  }
  if (changeInfo.status === 'complete') scheduleStatusCompleteReconcile(tabId);
}

async function mightHaveBadge(tabId) {
  if (await mightHaveActiveTabLease(tabId).catch(() => false)) return true;
  const badges = await getStoredMap(FINALIZED_TAB_BADGES_KEY);
  return Boolean(badges[String(Number(tabId))]);
}

function scheduleStatusCompleteReconcile(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (pendingStatusCompleteReconciles.has(id)) clearTimeout(pendingStatusCompleteReconciles.get(id));
  const timer = setTimeout(() => {
    pendingStatusCompleteReconciles.delete(id);
    void reconcileStatusCompleteBadge(id).catch(() => {});
  }, 2500);
  pendingStatusCompleteReconciles.set(id, timer);
}

async function reconcileStatusCompleteBadge(tabId) {
  if (!(await mightHaveBadge(tabId))) return;
  await reconcileTabFaviconBadge(tabId, 'tab_status_complete');
}

async function clearFocusedWindowFinalizedBadge(windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  const tabId = tabs.find((tab) => Number.isInteger(tab?.id))?.id;
  if (Number.isInteger(tabId)) await replaceFinalizedBadge(tabId, 'window_focused');
}

async function tabIsVisible(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.active !== true || !Number.isInteger(tab.windowId)) return false;
  const window = await chrome.windows?.get(tab.windowId).catch(() => null);
  return window?.focused === true;
}

async function resolveTabFaviconHref(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.favIconUrl || defaultFaviconDataUrl();
}

function isBadgeFaviconUrl(value) {
  return typeof value === 'string' && value.includes('xwow-favicon-badge');
}

function defaultFaviconDataUrl() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#10131a"/><text x="16" y="21" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#4ee1c1">X</text></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
