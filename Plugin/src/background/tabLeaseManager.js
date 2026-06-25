import { BROWSER_SESSIONS_KEY, recordBrowserSessionEvent } from './browserSessionRuntime.js';
import { getStoredMap, setStoredMap } from './storage.js';

export const TAB_LEASES_KEY = 'xwowBrowserDataAiTabLeases';
export const EXTENSION_INSTANCE_ID_KEY = 'extensionInstanceId';

let extensionInstanceIdPromise = null;
const activeTabLeaseChangeHandlers = new Set();

export function subscribeActiveTabLeaseChanges(handler) {
  if (typeof handler !== 'function') return () => {};
  activeTabLeaseChangeHandlers.add(handler);
  return () => activeTabLeaseChangeHandlers.delete(handler);
}

export async function listTabLeases() {
  return Object.values(await getStoredMap(TAB_LEASES_KEY));
}

export async function getOwningSessionId(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const lease = leases[String(id)];
  return lease?.state === 'active' && lease.sessionId ? lease.sessionId : null;
}

export async function mightHaveActiveTabLease(tabId) {
  return (await getOwningSessionId(tabId)) != null;
}

export async function listTabLeaseSnapshot(options = {}) {
  const sessionId = String(options.sessionId || options.session_id || '').trim();
  const state = String(options.state || '').trim();
  const includeTabInfo = options.includeTabInfo !== false;
  const leases = (await listTabLeases())
    .filter((lease) => lease?.tabId)
    .filter((lease) => !sessionId || lease.sessionId === sessionId)
    .filter((lease) => !state || lease.state === state)
    .sort(compareLeaseSnapshotEntries);
  const checked = includeTabInfo
    ? await Promise.all(leases.map(enrichLeaseSnapshotEntry))
    : leases.map((lease) => ({ lease: { ...lease }, tabId: lease.tabId, tab: null, live: null }));
  const staleTabIds = checked
    .filter((item) => item.live === false)
    .map((item) => item.tabId);
  const byState = {};
  for (const item of checked) {
    const key = item.lease?.state || 'unknown';
    byState[key] = (byState[key] || 0) + 1;
  }
  return {
    success: true,
    snapshotAt: new Date().toISOString(),
    storageKey: TAB_LEASES_KEY,
    filters: {
      sessionId,
      state,
      includeTabInfo,
    },
    leaseCount: checked.length,
    staleTabIds,
    byState,
    leases: checked,
  };
}

export async function claimTabForSession(session, tabId, origin = 'user', pageRole = 'source') {
  const id = Number(tabId);
  if (!session?.sessionId || !Number.isInteger(id)) return { lease: null, session: null };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const existing = leases[String(id)];
  if (existing?.sessionId && existing.sessionId !== session.sessionId) {
    throw new Error(`tab_claim_conflict: tab ${id} is already claimed by ${existing.sessionId}`);
  }
  const now = Date.now();
  const instanceId = await getExtensionInstanceId();
  const lease = {
    tabId: id,
    sessionId: session.sessionId,
    turnId: session.currentTurnId || session.turnId,
    origin,
    state: 'active',
    pageRole,
    claimedAt: now,
    claimedAtIso: new Date(now).toISOString(),
    instanceId,
  };
  leases[String(id)] = lease;
  await setStoredMap(TAB_LEASES_KEY, leases);

  let updatedSession = { ...session, activeTabId: id };
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  if (sessions[session.sessionId]) {
    const ownedTabIds = Array.isArray(sessions[session.sessionId].ownedTabIds)
      ? sessions[session.sessionId].ownedTabIds
      : [];
    sessions[session.sessionId] = {
      ...sessions[session.sessionId],
      activeTabId: id,
      ownedTabIds: ownedTabIds.includes(id) ? ownedTabIds : [...ownedTabIds, id],
      lastOwnedTabUpdatedAt: new Date().toISOString(),
      lastOwnedTabUpdateReason: 'tab_claimed',
    };
    updatedSession = sessions[session.sessionId];
    await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  }
  const sessionEvent = await recordBrowserSessionEvent('tab.claimed', updatedSession, { tabId: id, lease });
  notifyActiveTabLeaseChange('claimed', { tabId: id, sessionId: lease.sessionId, turnId: lease.turnId, lease });
  return { lease, session: updatedSession, sessionEvent };
}

export async function finalizeTabs(tabEntries, session, options = {}) {
  if (!Array.isArray(tabEntries)) throw new Error('finalizeTabs requires a keep array');
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const finalized = [];
  for (const entry of tabEntries) {
    if (!entry || typeof entry !== 'object') throw new Error('finalizeTabs received invalid tab entry');
    const tabId = Number(entry?.tabId || entry?.id || 0);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('finalizeTabs requires an integer tabId');
    const status = String(entry.status || '');
    if (status !== 'handoff' && status !== 'deliverable') {
      throw new Error(`finalizeTabs received invalid status ${status || 'unknown'}`);
    }
    const lease = leases[String(tabId)];
    if (!lease || lease.sessionId !== session.sessionId) {
      throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`);
    }
    lease.state = status;
    lease.finalizedAt = new Date().toISOString();
    if (Number.isInteger(Number(entry?.groupId))) lease.groupId = Number(entry.groupId);
    if (entry?.isActiveHandoff === true) lease.isActiveHandoff = true;
    leases[String(tabId)] = lease;
    finalized.push({ tabId, status, lease: { ...lease } });
  }
  await setStoredMap(TAB_LEASES_KEY, leases);
  if (finalized.length && chrome.tabGroups && options.groupFinalized !== false) {
    await groupFinalizedTabs(finalized).catch(() => {});
  }
  const sessionEvents = [];
  for (const item of finalized) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.finalized', session, {
      tabId: item.tabId,
      status: item.status,
      lease: item.lease,
    }));
    notifyActiveTabLeaseChange('finalized', {
      tabId: item.tabId,
      sessionId: item.lease.sessionId,
      turnId: item.lease.turnId,
      status: item.status,
      lease: item.lease,
    });
  }
  return { success: true, finalized, sessionEvents };
}

export async function getSessionHandoffLeases(sessionId) {
  return await getSessionLeases(sessionId, 'handoff');
}

export async function getSessionActiveLeases(sessionId) {
  return await getSessionLeases(sessionId, 'active');
}

export async function getSessionLeases(sessionId, state = '') {
  if (!sessionId) return { success: false, leases: [] };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  return {
    success: true,
    leases: Object.values(leases)
      .filter((lease) => lease?.sessionId === sessionId && (!state || lease.state === state))
      .sort((a, b) => String(a.finalizedAt || a.claimedAt || '').localeCompare(String(b.finalizedAt || b.claimedAt || ''))),
  };
}

export async function getSessionTabs(sessionId) {
  const active = await getSessionActiveLeases(sessionId);
  if (active.success === false) return { success: false, tabs: [], staleTabIds: [], sessionEvents: [] };
  const checked = await Promise.all(active.leases.map(async (lease) => {
    try {
      const tab = await chrome.tabs.get(lease.tabId);
      return { state: 'found', lease, tab };
    } catch {
      return { state: 'stale', lease, tabId: lease.tabId };
    }
  }));
  const tabs = [];
  const staleTabIds = [];
  for (const item of checked) {
    if (item.state === 'found') {
      tabs.push(tabInfo(item.tab, item.lease));
    } else {
      staleTabIds.push(item.tabId);
    }
  }
  const released = staleTabIds.length
    ? await releaseTabsForSession(sessionId, staleTabIds, 'stale_session_tab')
    : { releasedLeases: [], sessionEvents: [] };
  return {
    success: true,
    tabs,
    staleTabIds,
    releasedLeases: released.releasedLeases || [],
    sessionEvents: released.sessionEvents || [],
  };
}

export async function updateActiveSessionTurn(sessionId, turnId) {
  if (!sessionId || !turnId) return { success: false, updated: false, updatedLeases: [], sessionEvents: [] };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const instanceId = await getExtensionInstanceId();
  let changed = false;
  const updatedLeases = [];
  const updatedAt = new Date().toISOString();
  for (const [tabId, lease] of Object.entries(leases)) {
    if (lease?.sessionId !== sessionId || lease.state !== 'active') continue;
    if (lease.turnId === turnId && lease.instanceId === instanceId) continue;
    const updatedLease = { ...lease, turnId: String(turnId), instanceId, turnUpdatedAt: updatedAt };
    leases[tabId] = updatedLease;
    updatedLeases.push({ ...updatedLease });
    changed = true;
  }
  if (changed) await setStoredMap(TAB_LEASES_KEY, leases);
  let updatedSession = null;
  if (changed) {
    const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
    if (sessions[sessionId]) {
      updatedSession = {
        ...sessions[sessionId],
        turnId: String(turnId),
        currentTurnId: String(turnId),
        updatedAt,
      };
      sessions[sessionId] = updatedSession;
      await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
    }
  }
  const sessionEvents = [];
  for (const lease of updatedLeases) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.turn.updated', updatedSession || { sessionId, turnId, activeTabId: lease.tabId }, {
      tabId: lease.tabId,
      lease,
      turnId: String(turnId),
    }));
    notifyActiveTabLeaseChange('turn.updated', {
      tabId: lease.tabId,
      sessionId: lease.sessionId,
      turnId: String(turnId),
      lease,
    });
  }
  return { success: true, updated: changed, updatedLeases, session: updatedSession, sessionEvents };
}

export async function resumeHandoffTabs(sessionId, turnId, options = {}) {
  if (!sessionId || !turnId) return { success: false, resumed: false, resumedLeases: [], staleTabIds: [], releasedLeases: [], sessionEvents: [] };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const instanceId = await getExtensionInstanceId();
  const resumedLeases = [];
  const staleTabIds = [];
  const releasedLeases = [];
  const resumedAt = new Date().toISOString();
  for (const [tabId, lease] of Object.entries(leases)) {
    if (lease?.sessionId !== sessionId || lease.state !== 'handoff') continue;
    try {
      await chrome.tabs.get(lease.tabId);
    } catch {
      staleTabIds.push(lease.tabId);
      releasedLeases.push({ ...lease });
      continue;
    }
    const resumedLease = {
      ...lease,
      state: 'active',
      turnId: String(turnId),
      instanceId,
      resumedAt,
      resumeReason: String(options.reason || 'turn_started'),
    };
    leases[tabId] = resumedLease;
    resumedLeases.push({ ...resumedLease });
  }
  if (staleTabIds.length) {
    for (const tabId of staleTabIds) delete leases[String(tabId)];
  }
  if (!resumedLeases.length && !staleTabIds.length) {
    return { success: true, resumed: false, resumedLeases: [], staleTabIds: [], releasedLeases: [], sessionEvents: [] };
  }
  await setStoredMap(TAB_LEASES_KEY, leases);

  let updatedSession = null;
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  if (sessions[sessionId]) {
    const activeHandoff = resumedLeases.find((lease) => lease.isActiveHandoff === true);
    const staleSet = new Set(staleTabIds);
    const activeTabId = resumedLeases.length
      ? Number(activeHandoff?.tabId || resumedLeases[0].tabId)
      : (staleSet.has(sessions[sessionId].activeTabId) ? null : sessions[sessionId].activeTabId || null);
    const ownedTabIds = Array.isArray(sessions[sessionId].ownedTabIds) ? sessions[sessionId].ownedTabIds : [];
    const owned = ownedTabIds.filter((tabId) => !staleSet.has(tabId));
    for (const lease of resumedLeases) {
      if (!owned.includes(lease.tabId)) owned.push(lease.tabId);
    }
    updatedSession = {
      ...sessions[sessionId],
      turnId: String(turnId),
      currentTurnId: String(turnId),
      activeTabId,
      ownedTabIds: owned,
      lastOwnedTabUpdatedAt: resumedAt,
      lastOwnedTabUpdateReason: 'handoff_resumed',
      updatedAt: resumedAt,
    };
    sessions[sessionId] = updatedSession;
    await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  }

  const sessionEvents = [];
  for (const lease of resumedLeases) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.handoff.resumed', updatedSession || { sessionId, turnId, activeTabId: lease.tabId }, {
      tabId: lease.tabId,
      lease,
      reason: options.reason || 'turn_started',
    }));
    notifyActiveTabLeaseChange('handoff.resumed', {
      tabId: lease.tabId,
      sessionId: lease.sessionId,
      turnId: lease.turnId,
      reason: options.reason || 'turn_started',
      lease,
    });
  }
  if (staleTabIds.length) {
    for (const tabId of staleTabIds) {
      sessionEvents.push(await recordBrowserSessionEvent('tab.released', updatedSession || { sessionId, turnId }, {
        tabId,
        reason: 'stale_handoff_tab',
      }));
      notifyActiveTabLeaseChange('released', {
        tabId,
        sessionId,
        turnId,
        reason: 'stale_handoff_tab',
      });
    }
  }
  return { success: true, resumed: resumedLeases.length > 0, resumedLeases, staleTabIds, releasedLeases, session: updatedSession, sessionEvents };
}

export async function releaseTabsForSession(sessionId, tabIds, reason = 'release_tabs') {
  if (!sessionId || !Array.isArray(tabIds)) return { success: false, released: false, releasedLeases: [], sessionEvents: [] };
  const ids = new Set(tabIds.map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (!ids.size) return { success: true, released: false, releasedLeases: [], sessionEvents: [] };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const releasedLeases = [];
  let changed = false;
  for (const [tabId, lease] of Object.entries(leases)) {
    if (!ids.has(Number(tabId)) || lease?.sessionId !== sessionId) continue;
    releasedLeases.push({ ...lease });
    delete leases[tabId];
    changed = true;
  }
  if (changed) await setStoredMap(TAB_LEASES_KEY, leases);
  let updatedSession = null;
  if (changed) {
    const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
    if (sessions[sessionId]) {
      const ownedTabIds = (Array.isArray(sessions[sessionId].ownedTabIds) ? sessions[sessionId].ownedTabIds : [])
        .filter((id) => !ids.has(id));
      updatedSession = {
        ...sessions[sessionId],
        activeTabId: ids.has(sessions[sessionId].activeTabId) ? null : sessions[sessionId].activeTabId,
        ownedTabIds,
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: String(reason || 'release_tabs'),
      };
      sessions[sessionId] = updatedSession;
      await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
    }
  }
  const sessionEvents = [];
  for (const lease of releasedLeases) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.released', updatedSession || { sessionId, turnId: lease.turnId }, {
      tabId: lease.tabId,
      lease,
      reason,
    }));
    notifyActiveTabLeaseChange('released', {
      tabId: lease.tabId,
      sessionId: lease.sessionId,
      turnId: lease.turnId,
      reason,
      lease,
    });
  }
  return { success: true, released: changed, releasedLeases, session: updatedSession, sessionEvents };
}

export async function groupFinalizedTabs(finalized) {
  const handoff = finalized
    .filter((item) => item.status === 'handoff' && !Number.isInteger(item.lease?.groupId))
    .map((item) => item.tabId);
  const deliverable = finalized.filter((item) => item.status === 'deliverable').map((item) => item.tabId);
  if (handoff.length) {
    const groupId = await chrome.tabs.group({ tabIds: handoff });
    await chrome.tabGroups.update(groupId, { title: 'Beav Handoff', color: 'blue' }).catch(() => {});
  }
  if (deliverable.length) {
    const groupId = await chrome.tabs.group({ tabIds: deliverable });
    await chrome.tabGroups.update(groupId, { title: 'Beav Deliverable', color: 'green' }).catch(() => {});
  }
}

function tabInfo(tab, lease = {}) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active,
    leaseState: lease.state || '',
    origin: lease.origin || '',
    turnId: lease.turnId || '',
    sessionId: lease.sessionId || '',
    instanceId: lease.instanceId || null,
    claimedAt: lease.claimedAt || null,
  };
}

async function enrichLeaseSnapshotEntry(lease) {
  try {
    const tab = await chrome.tabs.get(lease.tabId);
    return {
      lease: { ...lease },
      tabId: lease.tabId,
      live: true,
      tab: tabInfo(tab, lease),
    };
  } catch {
    return {
      lease: { ...lease },
      tabId: lease.tabId,
      live: false,
      tab: null,
    };
  }
}

function compareLeaseSnapshotEntries(a, b) {
  const aSession = String(a.sessionId || '');
  const bSession = String(b.sessionId || '');
  if (aSession !== bSession) return aSession.localeCompare(bSession);
  const aState = String(a.state || '');
  const bState = String(b.state || '');
  if (aState !== bState) return aState.localeCompare(bState);
  return Number(a.tabId || 0) - Number(b.tabId || 0);
}

export async function releaseSessionTabLeases(sessionId) {
  const leases = await getStoredMap(TAB_LEASES_KEY);
  let changed = false;
  const releasedLeases = [];
  for (const [tabId, lease] of Object.entries(leases)) {
    if (lease?.sessionId === sessionId) {
      releasedLeases.push({ ...lease });
      delete leases[tabId];
      changed = true;
    }
  }
  if (changed) await setStoredMap(TAB_LEASES_KEY, leases);
  if (changed) {
    const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
    if (sessions[sessionId]) {
      sessions[sessionId] = {
        ...sessions[sessionId],
        activeTabId: null,
        ownedTabIds: [],
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: 'release_tabs',
      };
      await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
    }
  }
  const sessionEvents = [];
  if (changed) {
    for (const lease of releasedLeases) {
      sessionEvents.push(await recordBrowserSessionEvent('tab.released', { sessionId, turnId: lease.turnId }, { tabId: lease.tabId, lease }));
      notifyActiveTabLeaseChange('released', {
        tabId: lease.tabId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        reason: 'release_tabs',
        lease,
      });
    }
  }
  return { success: true, released: changed, releasedLeases, sessionEvents };
}

export async function releaseActiveTurnLeases(sessionId, turnId) {
  if (!sessionId || !turnId) return { success: false, released: false, releasedLeases: [], sessionEvents: [] };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  let changed = false;
  const releasedLeases = [];
  for (const [tabId, lease] of Object.entries(leases)) {
    if (lease?.sessionId === sessionId && lease.turnId === turnId && lease.state === 'active') {
      releasedLeases.push({ ...lease });
      delete leases[tabId];
      changed = true;
    }
  }
  if (changed) await setStoredMap(TAB_LEASES_KEY, leases);
  if (changed) {
    const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
    if (sessions[sessionId]) {
      const releasedIds = new Set(releasedLeases.map((lease) => lease.tabId));
      const ownedTabIds = (Array.isArray(sessions[sessionId].ownedTabIds) ? sessions[sessionId].ownedTabIds : [])
        .filter((id) => !releasedIds.has(id));
      sessions[sessionId] = {
        ...sessions[sessionId],
        activeTabId: releasedIds.has(sessions[sessionId].activeTabId) ? null : sessions[sessionId].activeTabId,
        ownedTabIds,
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: 'release_active_turn',
      };
      await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
    }
  }
  const sessionEvents = [];
  for (const lease of releasedLeases) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.turn.released', { sessionId, turnId }, { tabId: lease.tabId, lease }));
    notifyActiveTabLeaseChange('turn.released', {
      tabId: lease.tabId,
      sessionId: lease.sessionId,
      turnId: lease.turnId,
      lease,
    });
  }
  return { success: true, released: changed, releasedLeases, sessionEvents };
}

export async function syncSessionActiveTabFromLease(tabId, reason = 'activated') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, synced: false, error: 'sync active tab requires tabId' };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const lease = leases[String(id)];
  if (!lease?.sessionId) return { success: true, synced: false, tabId: id };
  if (lease.state !== 'active') return { success: true, synced: false, tabId: id, lease, reason: 'lease_not_active' };
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = sessions[lease.sessionId];
  if (!session || session.status !== 'active') return { success: true, synced: false, tabId: id, lease };
  const syncedAt = new Date().toISOString();
  const updatedSession = {
    ...session,
    activeTabId: id,
    ownedTabIds: Array.isArray(session.ownedTabIds) && session.ownedTabIds.includes(id)
      ? session.ownedTabIds
      : [...(Array.isArray(session.ownedTabIds) ? session.ownedTabIds : []), id],
    activeTabSyncedAt: syncedAt,
    activeTabSyncReason: reason,
  };
  sessions[lease.sessionId] = updatedSession;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('tab.active.synced', updatedSession, { tabId: id, reason, lease });
  notifyActiveTabLeaseChange('active.synced', {
    tabId: id,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    reason,
    lease,
  });
  return { success: true, synced: true, tabId: id, lease, session: updatedSession, sessionEvent };
}

export async function removeTabLease(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return { removed: false };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  if (!leases[String(id)]) return { removed: false };
  const lease = leases[String(id)];
  delete leases[String(id)];
  await setStoredMap(TAB_LEASES_KEY, leases);
  const sessionEvent = await recordBrowserSessionEvent('tab.removed', { sessionId: lease.sessionId, turnId: lease.turnId }, { tabId: id, lease });
  notifyActiveTabLeaseChange('removed', {
    tabId: id,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    lease,
  });
  return { removed: true, lease, sessionEvent };
}

export async function moveReplacedTabLease(addedTabId, removedTabId) {
  const added = Number(addedTabId);
  const removed = Number(removedTabId);
  if (!Number.isInteger(added) || !Number.isInteger(removed)) return { moved: false };
  const leases = await getStoredMap(TAB_LEASES_KEY);
  const lease = leases[String(removed)];
  if (!lease) return { moved: false };
  delete leases[String(removed)];
  const movedLease = { ...lease, tabId: added, replacedFromTabId: removed, replacedAt: new Date().toISOString() };
  leases[String(added)] = movedLease;
  await setStoredMap(TAB_LEASES_KEY, leases);
  const sessionEvent = await recordBrowserSessionEvent('tab.replaced', { sessionId: movedLease.sessionId, turnId: movedLease.turnId, activeTabId: added }, {
    addedTabId: added,
    removedTabId: removed,
    lease: movedLease,
  });
  notifyActiveTabLeaseChange('replaced', {
    tabId: added,
    addedTabId: added,
    removedTabId: removed,
    sessionId: movedLease.sessionId,
    turnId: movedLease.turnId,
    lease: movedLease,
  });
  return { moved: true, lease: movedLease, sessionEvent };
}

function notifyActiveTabLeaseChange(type, payload = {}) {
  if (!activeTabLeaseChangeHandlers.size) return;
  const event = {
    type,
    tabId: payload.tabId ?? null,
    sessionId: payload.sessionId || payload.lease?.sessionId || '',
    turnId: payload.turnId || payload.lease?.turnId || '',
    payload,
    emittedAt: new Date().toISOString(),
  };
  for (const handler of activeTabLeaseChangeHandlers) {
    try {
      handler(event);
    } catch (error) {
      console.warn('[XWOW BrowserDataAI] active tab lease change handler failed', error);
    }
  }
}

async function getExtensionInstanceId() {
  if (!extensionInstanceIdPromise) extensionInstanceIdPromise = loadExtensionInstanceId();
  return await extensionInstanceIdPromise;
}

async function loadExtensionInstanceId() {
  const stored = await chrome.storage.local.get(EXTENSION_INSTANCE_ID_KEY).catch(() => ({}));
  const existing = stored?.[EXTENSION_INSTANCE_ID_KEY];
  if (typeof existing === 'string' && existing.trim()) return existing;
  const generated = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `extension-instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ [EXTENSION_INSTANCE_ID_KEY]: generated }).catch(() => {});
  return generated;
}
