import { BROWSER_SESSIONS_KEY, recordBrowserSessionEvent } from './browserSessionRuntime.js';
import { getStoredMap, mutateBrowserControlState } from './storage.js';

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
  const now = Date.now();
  const instanceId = await getExtensionInstanceId();
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const currentSession = sessions[session.sessionId];
    if (!currentSession || currentSession.status !== 'active') {
      throw new Error(`browser session is not active: ${session.sessionId}`);
    }
    const expectedTurnId = String(session.currentTurnId || session.turnId || '');
    const currentTurnId = String(currentSession.currentTurnId || currentSession.turnId || '');
    if (expectedTurnId && currentTurnId && expectedTurnId !== currentTurnId) {
      const error = new Error(`browser turn is stale: ${expectedTurnId}`);
      error.code = 'BROWSER_TURN_STALE';
      throw error;
    }
    const existing = leases[String(id)];
    if (existing?.sessionId && existing.sessionId !== session.sessionId) {
      throw new Error(`tab_claim_conflict: tab ${id} is already claimed by ${existing.sessionId}`);
    }
    const lease = {
      ...(existing?.sessionId === session.sessionId ? existing : {}),
      tabId: id,
      sessionId: session.sessionId,
      turnId: currentTurnId || expectedTurnId,
      origin: existing?.origin || origin,
      state: 'active',
      pageRole: existing?.pageRole || pageRole,
      claimedAt: existing?.claimedAt || now,
      claimedAtIso: existing?.claimedAtIso || new Date(now).toISOString(),
      instanceId,
    };
    leases[String(id)] = lease;
    const ownedTabIds = Array.isArray(currentSession.ownedTabIds) ? currentSession.ownedTabIds : [];
    const updatedSession = {
      ...currentSession,
      activeTabId: id,
      ownedTabIds: ownedTabIds.includes(id) ? ownedTabIds : [...ownedTabIds, id],
      lastOwnedTabUpdatedAt: new Date().toISOString(),
      lastOwnedTabUpdateReason: 'tab_claimed',
      updatedAt: new Date().toISOString(),
    };
    sessions[session.sessionId] = updatedSession;
    return { lease, session: updatedSession };
  });
  const lease = mutation.lease;
  const updatedSession = mutation.session;
  const sessionEvent = await recordBrowserSessionEvent('tab.claimed', updatedSession, { tabId: id, lease });
  notifyActiveTabLeaseChange('claimed', { tabId: id, sessionId: lease.sessionId, turnId: lease.turnId, lease });
  return { lease, session: updatedSession, sessionEvent, stateRevision: mutation.stateRevision };
}

/**
 * Transfers ownership to a tab opened by an actively controlled source tab.
 *
 * `webNavigation.onCreatedNavigationTarget` is asynchronous and may arrive
 * while a turn is ending or another session is claiming the target. Keep the
 * source validation and target claim in the same storage mutation so a popup
 * can never outlive or escape its parent session/turn.
 */
export async function claimChildTabForSourceLease(sourceTabId, targetTabId, options = {}) {
  const sourceId = Number(sourceTabId);
  const targetId = Number(targetTabId);
  if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0 || sourceId === targetId) {
    return { success: false, claimed: false, reason: 'invalid_tab_ids', lease: null, session: null };
  }
  const instanceId = await getExtensionInstanceId();
  const now = new Date();
  const claimedAt = now.getTime();
  const claimedAtIso = now.toISOString();
  const pageRole = String(options.pageRole || 'popup').slice(0, 80) || 'popup';
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const sourceLease = leases[String(sourceId)];
    if (!sourceLease || sourceLease.state !== 'active' || !sourceLease.sessionId || !sourceLease.turnId) {
      return { claimed: false, reason: 'source_lease_not_active', lease: null, session: null };
    }
    const session = sessions[sourceLease.sessionId];
    const currentTurnId = String(session?.currentTurnId || session?.turnId || '');
    if (!session || session.status !== 'active' || !currentTurnId || currentTurnId !== String(sourceLease.turnId)) {
      return { claimed: false, reason: 'source_turn_not_active', lease: null, session: null };
    }
    const existing = leases[String(targetId)];
    if (existing?.sessionId && (
      existing.sessionId !== session.sessionId
      || existing.turnId !== currentTurnId
      || existing.state !== 'active'
    )) {
      return { claimed: false, reason: 'target_claim_conflict', lease: null, session: null };
    }
    const lease = {
      ...(existing || {}),
      tabId: targetId,
      sessionId: session.sessionId,
      turnId: currentTurnId,
      origin: 'agent',
      state: 'active',
      pageRole,
      parentTabId: sourceId,
      claimedAt: existing?.claimedAt || claimedAt,
      claimedAtIso: existing?.claimedAtIso || claimedAtIso,
      instanceId,
      childTargetCreatedAt: existing?.childTargetCreatedAt || claimedAtIso,
      childTargetSource: String(options.source || 'web_navigation'),
    };
    leases[String(targetId)] = lease;
    const ownedTabIds = Array.isArray(session.ownedTabIds) ? session.ownedTabIds : [];
    const updatedSession = {
      ...session,
      ownedTabIds: ownedTabIds.includes(targetId) ? ownedTabIds : [...ownedTabIds, targetId],
      lastOwnedTabUpdatedAt: claimedAtIso,
      lastOwnedTabUpdateReason: 'child_tab_claimed',
      updatedAt: claimedAtIso,
    };
    sessions[session.sessionId] = updatedSession;
    return { claimed: true, reason: existing ? 'already_claimed' : 'claimed', lease, session: updatedSession };
  });
  if (mutation.claimed !== true) {
    return {
      success: true,
      claimed: false,
      reason: mutation.reason || 'claim_rejected',
      lease: null,
      session: null,
      stateRevision: mutation.stateRevision,
    };
  }
  const lease = mutation.lease;
  const session = mutation.session;
  const sessionEvent = await recordBrowserSessionEvent('tab.child.claimed', session, {
    tabId: targetId,
    sourceTabId: sourceId,
    lease,
    reason: mutation.reason,
  });
  notifyActiveTabLeaseChange('child.claimed', {
    tabId: targetId,
    sourceTabId: sourceId,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    lease,
  });
  return {
    success: true,
    claimed: true,
    reason: mutation.reason,
    lease,
    session,
    sessionEvent,
    stateRevision: mutation.stateRevision,
  };
}

export async function setTabMarkForSession(session, tabId, mark) {
  const id = Number(tabId);
  const normalizedMark = String(mark || '').trim().toLowerCase();
  if (!session?.sessionId || !Number.isInteger(id) || id <= 0) throw new Error('tab.mark requires an active session and tabId');
  if (!['handoff', 'deliverable', 'clear'].includes(normalizedMark)) {
    throw new Error('tab.mark requires mark to be handoff, deliverable, or clear');
  }
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const storedSession = sessions[session.sessionId];
    const expectedTurnId = String(session.currentTurnId || session.turnId || '');
    const currentTurnId = String(storedSession?.currentTurnId || storedSession?.turnId || '');
    const lease = leases[String(id)];
    if (!storedSession || storedSession.status !== 'active' || !lease || lease.sessionId !== session.sessionId || lease.state !== 'active') {
      throw new Error(`tab.mark cannot mark unclaimed active tab ${id}`);
    }
    if (!currentTurnId || (expectedTurnId && currentTurnId !== expectedTurnId) || lease.turnId !== currentTurnId) {
      const error = new Error(`tab.mark cannot mark stale tab ${id}`);
      error.code = 'BROWSER_TURN_STALE';
      throw error;
    }
    const markedAt = new Date().toISOString();
    const nextLease = {
      ...lease,
      ...(normalizedMark === 'clear'
        ? { mark: null, markedAt: null }
        : { mark: normalizedMark, markedAt, markedByTurnId: currentTurnId }),
    };
    leases[String(id)] = nextLease;
    return { lease: nextLease, session: storedSession };
  });
  const lease = mutation.lease;
  const sessionEvent = await recordBrowserSessionEvent('tab.marked', mutation.session, {
    tabId: id,
    mark: normalizedMark === 'clear' ? null : normalizedMark,
    lease,
  });
  notifyActiveTabLeaseChange('marked', {
    tabId: id,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    mark: normalizedMark === 'clear' ? null : normalizedMark,
    lease,
  });
  return {
    success: true,
    tabId: id,
    mark: normalizedMark === 'clear' ? null : normalizedMark,
    lease,
    sessionEvent,
    stateRevision: mutation.stateRevision,
  };
}

export async function handoffTabForUser(session, tabId, options = {}) {
  const id = Number(tabId);
  if (!session?.sessionId || !Number.isInteger(id) || id <= 0) throw new Error('browser auth handoff requires an active session and tabId');
  const reason = normalizeUserHandoffReason(options.reason);
  const ttlMs = clampUserHandoffTtl(options.ttlMs ?? options.ttl_ms);
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + ttlMs).toISOString();
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const storedSession = sessions[session.sessionId];
    const expectedTurnId = String(session.currentTurnId || session.turnId || '');
    const currentTurnId = String(storedSession?.currentTurnId || storedSession?.turnId || '');
    const lease = leases[String(id)];
    if (!storedSession || storedSession.status !== 'active' || !lease || lease.sessionId !== session.sessionId || lease.state !== 'active') {
      throw new Error(`browser auth handoff cannot retain unclaimed active tab ${id}`);
    }
    if (!currentTurnId || (expectedTurnId && currentTurnId !== expectedTurnId) || lease.turnId !== currentTurnId) {
      const error = new Error(`browser auth handoff cannot retain stale tab ${id}`);
      error.code = 'BROWSER_TURN_STALE';
      throw error;
    }
    const handoff = {
      tabId: id,
      sessionId: storedSession.sessionId,
      turnId: currentTurnId,
      reason,
      startedAt: startedAt.toISOString(),
      expiresAt,
      ttlMs,
    };
    const nextLease = {
      ...lease,
      state: 'handoff',
      handoffReason: reason,
      handoffStartedAt: handoff.startedAt,
      handoffExpiresAt: expiresAt,
      requiresUserAction: true,
      isActiveHandoff: true,
    };
    leases[String(id)] = nextLease;
    const updatedSession = {
      ...storedSession,
      activeTabId: id,
      pendingUserHandoff: handoff,
      updatedAt: handoff.startedAt,
    };
    sessions[storedSession.sessionId] = updatedSession;
    return { lease: nextLease, session: updatedSession, handoff };
  });
  const sessionEvent = await recordBrowserSessionEvent('browser.user_handoff.requested', mutation.session, {
    tabId: id,
    handoff: mutation.handoff,
    lease: mutation.lease,
  });
  notifyActiveTabLeaseChange('handoff.requested', {
    tabId: id,
    sessionId: mutation.lease.sessionId,
    turnId: mutation.lease.turnId,
    handoff: mutation.handoff,
    lease: mutation.lease,
  });
  return {
    success: true,
    handoff: mutation.handoff,
    lease: mutation.lease,
    session: mutation.session,
    sessionEvent,
    stateRevision: mutation.stateRevision,
  };
}

export async function finalizeTabs(tabEntries, session, options = {}) {
  if (!Array.isArray(tabEntries)) throw new Error('finalizeTabs requires a keep array');
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const currentSession = sessions[session?.sessionId];
    if (!currentSession || currentSession.status !== 'active') throw new Error(`browser session is not active: ${session?.sessionId || ''}`);
    const expectedTurnId = String(session?.currentTurnId || session?.turnId || '');
    const currentTurnId = String(currentSession.currentTurnId || currentSession.turnId || '');
    if (expectedTurnId && currentTurnId && expectedTurnId !== currentTurnId) {
      const error = new Error(`browser turn is stale: ${expectedTurnId}`);
      error.code = 'BROWSER_TURN_STALE';
      throw error;
    }
    const seenTabIds = new Set();
    const finalized = [];
    for (const entry of tabEntries) {
      if (!entry || typeof entry !== 'object') throw new Error('finalizeTabs received invalid tab entry');
      const tabId = Number(entry?.tabId || entry?.id || 0);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('finalizeTabs requires an integer tabId');
      if (seenTabIds.has(tabId)) throw new Error(`finalizeTabs received duplicate tab ${tabId}`);
      seenTabIds.add(tabId);
      const status = String(entry.status || '');
      if (status !== 'handoff' && status !== 'deliverable') {
        throw new Error(`finalizeTabs received invalid status ${status || 'unknown'}`);
      }
      const lease = leases[String(tabId)];
      if (!lease || lease.sessionId !== currentSession.sessionId || lease.state !== 'active' || lease.turnId !== currentTurnId) {
        throw new Error(`finalizeTabs cannot keep unknown or stale tab ${tabId}`);
      }
      const finalizedLease = {
        ...lease,
        state: status,
        finalizedAt: new Date().toISOString(),
        ...(Number.isInteger(Number(entry?.groupId)) ? { groupId: Number(entry.groupId) } : {}),
        ...(entry?.isActiveHandoff === true ? { isActiveHandoff: true } : {}),
      };
      leases[String(tabId)] = finalizedLease;
      finalized.push({ tabId, status, lease: { ...finalizedLease } });
    }
    return { finalized, session: currentSession };
  });
  const finalized = mutation.finalized;
  if (finalized.length && chrome.tabGroups && options.groupFinalized !== false) {
    await groupFinalizedTabs(finalized).catch(() => {});
  }
  const sessionEvents = [];
  for (const item of finalized) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.finalized', mutation.session, {
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
  return { success: true, finalized, sessionEvents, stateRevision: mutation.stateRevision };
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
  const instanceId = await getExtensionInstanceId();
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const storedSession = sessions[sessionId];
    if (!storedSession || storedSession.status !== 'active') return { changed: false, updatedLeases: [], session: null };
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
    const updatedSession = changed
      ? { ...storedSession, turnId: String(turnId), currentTurnId: String(turnId), updatedAt }
      : { ...storedSession };
    if (changed) sessions[sessionId] = updatedSession;
    return { changed, updatedLeases, session: updatedSession };
  });
  const changed = mutation.changed;
  const updatedLeases = mutation.updatedLeases || [];
  const updatedSession = mutation.session;
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
  return { success: true, updated: changed, updatedLeases, session: updatedSession, sessionEvents, stateRevision: mutation.stateRevision };
}

export async function resumeHandoffTabs(sessionId, turnId, options = {}) {
  if (!sessionId || !turnId) return { success: false, resumed: false, resumedLeases: [], staleTabIds: [], releasedLeases: [], sessionEvents: [] };
  const leaseSnapshot = await getStoredMap(TAB_LEASES_KEY);
  const nowMs = Date.now();
  const handoffCandidates = Object.values(leaseSnapshot)
    .filter((lease) => lease?.sessionId === sessionId && lease.state === 'handoff');
  const liveChecks = await Promise.all(handoffCandidates.map(async (lease) => {
    try {
      if (handoffHasExpired(lease, nowMs)) return [lease.tabId, false, 'handoff_expired'];
      await chrome.tabs.get(lease.tabId);
      return [lease.tabId, true, 'live'];
    } catch {
      return [lease.tabId, false, 'stale_handoff_tab'];
    }
  }));
  const liveTabIds = new Set(liveChecks.filter(([, live]) => live).map(([tabId]) => Number(tabId)));
  const staleReasonByTabId = new Map(liveChecks.filter(([, live]) => !live).map(([tabId, , reason]) => [Number(tabId), reason]));
  const instanceId = await getExtensionInstanceId();
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const storedSession = sessions[sessionId];
    if (!storedSession || storedSession.status !== 'active') {
      return { resumedLeases: [], staleTabIds: [], releasedLeases: [], session: null };
    }
    const resumedLeases = [];
    const staleTabIds = [];
    const releasedLeases = [];
    const resumedAt = new Date().toISOString();
    for (const [tabId, lease] of Object.entries(leases)) {
      if (lease?.sessionId !== sessionId || lease.state !== 'handoff') continue;
      if (!liveTabIds.has(Number(lease.tabId))) {
        staleTabIds.push(lease.tabId);
        releasedLeases.push({ ...lease });
        delete leases[tabId];
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
    if (!resumedLeases.length && !staleTabIds.length) {
      return { resumedLeases, staleTabIds, releasedLeases, session: { ...storedSession } };
    }
    const activeHandoff = resumedLeases.find((lease) => lease.isActiveHandoff === true);
    const staleSet = new Set(staleTabIds);
    const activeTabId = resumedLeases.length
      ? Number(activeHandoff?.tabId || resumedLeases[0].tabId)
      : (staleSet.has(storedSession.activeTabId) ? null : storedSession.activeTabId || null);
    const ownedTabIds = Array.isArray(storedSession.ownedTabIds) ? storedSession.ownedTabIds : [];
    const owned = ownedTabIds.filter((tabId) => !staleSet.has(tabId));
    for (const lease of resumedLeases) {
      if (!owned.includes(lease.tabId)) owned.push(lease.tabId);
    }
    const updatedSession = {
      ...storedSession,
      turnId: String(turnId),
      currentTurnId: String(turnId),
      activeTabId,
      ownedTabIds: owned,
      lastOwnedTabUpdatedAt: resumedAt,
      lastOwnedTabUpdateReason: 'handoff_resumed',
      ...(staleSet.has(Number(storedSession.pendingUserHandoff?.tabId)) || resumedLeases.some((lease) => Number(lease.tabId) === Number(storedSession.pendingUserHandoff?.tabId))
        ? { pendingUserHandoff: null }
        : {}),
      updatedAt: resumedAt,
    };
    sessions[sessionId] = updatedSession;
    return { resumedLeases, staleTabIds, releasedLeases, session: updatedSession };
  });
  const resumedLeases = mutation.resumedLeases || [];
  const staleTabIds = mutation.staleTabIds || [];
  const releasedLeases = mutation.releasedLeases || [];
  const updatedSession = mutation.session;

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
        reason: staleReasonByTabId.get(tabId) || 'stale_handoff_tab',
      }));
      notifyActiveTabLeaseChange('released', {
        tabId,
        sessionId,
        turnId,
        reason: staleReasonByTabId.get(tabId) || 'stale_handoff_tab',
      });
    }
  }
  return { success: true, resumed: resumedLeases.length > 0, resumedLeases, staleTabIds, releasedLeases, session: updatedSession, sessionEvents, stateRevision: mutation.stateRevision };
}

export async function releaseTabsForSession(sessionId, tabIds, reason = 'release_tabs') {
  if (!sessionId || !Array.isArray(tabIds)) return { success: false, released: false, releasedLeases: [], sessionEvents: [] };
  const ids = new Set(tabIds.map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (!ids.size) return { success: true, released: false, releasedLeases: [], sessionEvents: [] };
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const releasedLeases = [];
    for (const [tabId, lease] of Object.entries(leases)) {
      if (!ids.has(Number(tabId)) || lease?.sessionId !== sessionId) continue;
      releasedLeases.push({ ...lease });
      delete leases[tabId];
    }
    const changed = releasedLeases.length > 0;
    let updatedSession = null;
    if (changed && sessions[sessionId]) {
      const storedSession = sessions[sessionId];
      const ownedTabIds = (Array.isArray(storedSession.ownedTabIds) ? storedSession.ownedTabIds : [])
        .filter((id) => !ids.has(id));
      updatedSession = {
        ...storedSession,
        activeTabId: ids.has(storedSession.activeTabId) ? null : storedSession.activeTabId,
        ownedTabIds,
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: String(reason || 'release_tabs'),
        updatedAt: new Date().toISOString(),
      };
      sessions[sessionId] = updatedSession;
    }
    return { changed, releasedLeases, session: updatedSession };
  });
  const releasedLeases = mutation.releasedLeases || [];
  const changed = mutation.changed === true;
  const updatedSession = mutation.session;
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
  return { success: true, released: changed, releasedLeases, session: updatedSession, sessionEvents, stateRevision: mutation.stateRevision };
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

function normalizeUserHandoffReason(value) {
  const reason = String(value || 'security_verification_required').trim().toLowerCase();
  if (!['login_required', 'security_verification_required', 'bot_verification_required'].includes(reason)) {
    throw new Error('browser auth handoff reason is unsupported');
  }
  return reason;
}

function clampUserHandoffTtl(value) {
  const ttlMs = Number(value ?? 20 * 60_000);
  return Number.isFinite(ttlMs) ? Math.max(5 * 60_000, Math.min(30 * 60_000, Math.floor(ttlMs))) : 20 * 60_000;
}

function handoffHasExpired(lease, nowMs = Date.now()) {
  const expiresAt = Date.parse(String(lease?.handoffExpiresAt || ''));
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

export async function releaseSessionTabLeases(sessionId) {
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const releasedLeases = [];
    for (const [tabId, lease] of Object.entries(leases)) {
      if (lease?.sessionId !== sessionId) continue;
      releasedLeases.push({ ...lease });
      delete leases[tabId];
    }
    const changed = releasedLeases.length > 0;
    let session = null;
    if (changed && sessions[sessionId]) {
      session = {
        ...sessions[sessionId],
        activeTabId: null,
        ownedTabIds: [],
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: 'release_tabs',
        updatedAt: new Date().toISOString(),
      };
      sessions[sessionId] = session;
    }
    return { changed, releasedLeases, session };
  });
  const changed = mutation.changed === true;
  const releasedLeases = mutation.releasedLeases || [];
  const session = mutation.session;
  const sessionEvents = [];
  if (changed) {
    for (const lease of releasedLeases) {
      sessionEvents.push(await recordBrowserSessionEvent('tab.released', session || { sessionId, turnId: lease.turnId }, { tabId: lease.tabId, lease }));
      notifyActiveTabLeaseChange('released', {
        tabId: lease.tabId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        reason: 'release_tabs',
        lease,
      });
    }
  }
  return { success: true, released: changed, releasedLeases, sessionEvents, stateRevision: mutation.stateRevision };
}

export async function releaseActiveTurnLeases(sessionId, turnId) {
  if (!sessionId || !turnId) return { success: false, released: false, releasedLeases: [], sessionEvents: [] };
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const releasedLeases = [];
    for (const [tabId, lease] of Object.entries(leases)) {
      if (lease?.sessionId !== sessionId || lease.turnId !== turnId || lease.state !== 'active') continue;
      releasedLeases.push({ ...lease });
      delete leases[tabId];
    }
    const changed = releasedLeases.length > 0;
    let session = null;
    if (changed && sessions[sessionId]) {
      const releasedIds = new Set(releasedLeases.map((lease) => lease.tabId));
      const storedSession = sessions[sessionId];
      session = {
        ...storedSession,
        activeTabId: releasedIds.has(storedSession.activeTabId) ? null : storedSession.activeTabId,
        ownedTabIds: (Array.isArray(storedSession.ownedTabIds) ? storedSession.ownedTabIds : [])
          .filter((id) => !releasedIds.has(id)),
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: 'release_active_turn',
        updatedAt: new Date().toISOString(),
      };
      sessions[sessionId] = session;
    }
    return { changed, releasedLeases, session };
  });
  const changed = mutation.changed === true;
  const releasedLeases = mutation.releasedLeases || [];
  const session = mutation.session;
  const sessionEvents = [];
  for (const lease of releasedLeases) {
    sessionEvents.push(await recordBrowserSessionEvent('tab.turn.released', session || { sessionId, turnId }, { tabId: lease.tabId, lease }));
    notifyActiveTabLeaseChange('turn.released', {
      tabId: lease.tabId,
      sessionId: lease.sessionId,
      turnId: lease.turnId,
      lease,
    });
  }
  return { success: true, released: changed, releasedLeases, sessionEvents, stateRevision: mutation.stateRevision };
}

export async function syncSessionActiveTabFromLease(tabId, reason = 'activated') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, synced: false, error: 'sync active tab requires tabId' };
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const lease = leases[String(id)];
    if (!lease?.sessionId) return { synced: false, lease: null, session: null, reason: 'lease_missing' };
    if (lease.state !== 'active') return { synced: false, lease, session: null, reason: 'lease_not_active' };
    const session = sessions[lease.sessionId];
    if (!session || session.status !== 'active') return { synced: false, lease, session: null, reason: 'session_not_active' };
    const syncedAt = new Date().toISOString();
    const updatedSession = {
      ...session,
      activeTabId: id,
      ownedTabIds: Array.isArray(session.ownedTabIds) && session.ownedTabIds.includes(id)
        ? session.ownedTabIds
        : [...(Array.isArray(session.ownedTabIds) ? session.ownedTabIds : []), id],
      activeTabSyncedAt: syncedAt,
      activeTabSyncReason: reason,
      updatedAt: syncedAt,
    };
    sessions[lease.sessionId] = updatedSession;
    return { synced: true, lease, session: updatedSession, reason };
  });
  if (mutation.synced !== true) {
    return { success: true, synced: false, tabId: id, lease: mutation.lease, reason: mutation.reason, stateRevision: mutation.stateRevision };
  }
  const lease = mutation.lease;
  const updatedSession = mutation.session;
  const sessionEvent = await recordBrowserSessionEvent('tab.active.synced', updatedSession, { tabId: id, reason, lease });
  notifyActiveTabLeaseChange('active.synced', {
    tabId: id,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    reason,
    lease,
  });
  return { success: true, synced: true, tabId: id, lease, session: updatedSession, sessionEvent, stateRevision: mutation.stateRevision };
}

export async function removeTabLease(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return { removed: false };
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const lease = leases[String(id)];
    if (!lease) return { removed: false, lease: null, session: null };
    delete leases[String(id)];
    let session = null;
    if (sessions[lease.sessionId]) {
      const storedSession = sessions[lease.sessionId];
      session = {
        ...storedSession,
        activeTabId: Number(storedSession.activeTabId) === id ? null : storedSession.activeTabId,
        ownedTabIds: (Array.isArray(storedSession.ownedTabIds) ? storedSession.ownedTabIds : []).filter((candidate) => Number(candidate) !== id),
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: 'tab_removed',
        updatedAt: new Date().toISOString(),
      };
      sessions[lease.sessionId] = session;
    }
    return { removed: true, lease, session };
  });
  if (mutation.removed !== true) return { removed: false, stateRevision: mutation.stateRevision };
  const lease = mutation.lease;
  const sessionEvent = await recordBrowserSessionEvent('tab.removed', { sessionId: lease.sessionId, turnId: lease.turnId }, { tabId: id, lease });
  notifyActiveTabLeaseChange('removed', {
    tabId: id,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    lease,
  });
  return { removed: true, lease, sessionEvent, stateRevision: mutation.stateRevision };
}

export async function moveReplacedTabLease(addedTabId, removedTabId) {
  const added = Number(addedTabId);
  const removed = Number(removedTabId);
  if (!Number.isInteger(added) || !Number.isInteger(removed)) return { moved: false };
  const mutation = await mutateLeasesAndSessions((leases, sessions) => {
    const lease = leases[String(removed)];
    if (!lease || leases[String(added)]) return { moved: false, lease: null, session: null };
    delete leases[String(removed)];
    const movedLease = { ...lease, tabId: added, replacedFromTabId: removed, replacedAt: new Date().toISOString() };
    leases[String(added)] = movedLease;
    let session = null;
    if (sessions[movedLease.sessionId]) {
      const storedSession = sessions[movedLease.sessionId];
      const owned = (Array.isArray(storedSession.ownedTabIds) ? storedSession.ownedTabIds : [])
        .map((candidate) => Number(candidate) === removed ? added : candidate);
      if (!owned.includes(added)) owned.push(added);
      session = {
        ...storedSession,
        activeTabId: Number(storedSession.activeTabId) === removed ? added : storedSession.activeTabId,
        ownedTabIds: [...new Set(owned)],
        lastOwnedTabUpdatedAt: new Date().toISOString(),
        lastOwnedTabUpdateReason: 'tab_replaced',
        updatedAt: new Date().toISOString(),
      };
      sessions[movedLease.sessionId] = session;
    }
    return { moved: true, lease: movedLease, session };
  });
  if (mutation.moved !== true) return { moved: false, stateRevision: mutation.stateRevision };
  const movedLease = mutation.lease;
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
  return { moved: true, lease: movedLease, sessionEvent, stateRevision: mutation.stateRevision };
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

async function mutateLeasesAndSessions(reducer) {
  const mutation = await mutateBrowserControlState([TAB_LEASES_KEY, BROWSER_SESSIONS_KEY], (maps, context) => (
    reducer(maps[TAB_LEASES_KEY], maps[BROWSER_SESSIONS_KEY], context)
  ));
  return {
    ...(mutation.result && typeof mutation.result === 'object' ? mutation.result : {}),
    result: mutation.result,
    stateRevision: mutation.stateRevision,
  };
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
