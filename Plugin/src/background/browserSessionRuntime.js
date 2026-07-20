import { getStoredMap, setStoredMap } from './storage.js';

export const BROWSER_SESSIONS_KEY = 'xwowBrowserDataAiSessions';
export const BROWSER_SESSION_EVENTS_KEY = 'xwowBrowserDataAiSessionEvents';
const MAX_BROWSER_SESSION_EVENTS = 500;
const MAX_RECENT_BROWSER_REQUESTS = 50;
const MAX_PERSISTED_BROWSER_RESPONSE_BYTES = 128 * 1024;
const browserSessionEventSubscribers = new Set();

export function subscribeBrowserSessionEvents(handler) {
  if (typeof handler !== 'function') return () => {};
  browserSessionEventSubscribers.add(handler);
  return () => browserSessionEventSubscribers.delete(handler);
}

export async function createBrowserSession(owner = 'manual_repair', metadata = {}) {
  const session = {
    sessionId: `browser-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    turnId: `turn-${Date.now().toString(36)}`,
    owner,
    metadata,
    createdAt: new Date().toISOString(),
    activeTabId: null,
    currentTurnId: null,
    ownedTabIds: [],
    activeRequests: {},
    activeRequestCount: 0,
    recentRequests: {},
    status: 'active',
  };
  session.currentTurnId = session.turnId;
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  sessions[session.sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('session.created', session, { metadata });
  return { success: true, session, sessionEvent };
}

export async function ensureBrowserSession(sessionId, owner = 'manual_repair', metadata = {}, options = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return await createBrowserSession(owner, metadata);
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const existing = normalizeSessionRuntimeState(sessions[id]);
  if (existing?.status === 'active') {
    const nextTurnId = String(options.turnId || existing.currentTurnId || existing.turnId || '');
    if (nextTurnId && existing.currentTurnId !== nextTurnId) {
      return await beginBrowserSessionTurn(id, nextTurnId, options.reason || 'session_ensured');
    }
    return { success: true, session: existing, sessionEvent: null, created: false };
  }
  const now = new Date().toISOString();
  const turnId = String(options.turnId || `turn-${Date.now().toString(36)}`);
  const session = {
    sessionId: id,
    turnId,
    owner,
    metadata,
    createdAt: now,
    updatedAt: now,
    activeTabId: null,
    currentTurnId: turnId,
    ownedTabIds: [],
    activeRequests: {},
    activeRequestCount: 0,
    recentRequests: normalizeRecentRequests(existing?.recentRequests),
    status: 'active',
    restoredFromEndedSession: Boolean(existing),
  };
  sessions[id] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent(existing ? 'session.restored' : 'session.created', session, { metadata, reason: options.reason || 'session_ensured' });
  return { success: true, session, sessionEvent, created: true };
}

export async function getBrowserSession(sessionId) {
  if (!sessionId) return null;
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  return normalizeSessionRuntimeState(sessions[sessionId]);
}

export async function listBrowserSessions() {
  return Object.values(await getStoredMap(BROWSER_SESSIONS_KEY))
    .map(normalizeSessionRuntimeState)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function nameBrowserSession(sessionId, name) {
  if (!sessionId) throw new Error('nameSession requires sessionId');
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  session.name = String(name || '').slice(0, 120);
  session.updatedAt = new Date().toISOString();
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('session.named', session, { name: session.name });
  return { success: true, session, sessionEvent };
}

export async function markTurnEnded(sessionId, turnId) {
  if (!sessionId) throw new Error('turnEnded requires sessionId');
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  session.lastTurnEndedAt = new Date().toISOString();
  session.lastTurnId = String(turnId || session.turnId || '');
  if (!session.lastTurnId || session.currentTurnId === session.lastTurnId || session.turnId === session.lastTurnId) {
    session.currentTurnId = null;
    session.activeRequests = {};
    session.activeRequestCount = 0;
  }
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('turn.ended', session, { turnId: session.lastTurnId });
  return { success: true, session, sessionEvent };
}

export async function beginBrowserSessionTurn(sessionId, turnId, reason = 'browser_action') {
  if (!sessionId) throw new Error('beginTurn requires sessionId');
  const nextTurnId = String(turnId || `turn-${Date.now().toString(36)}`);
  if (!nextTurnId) throw new Error('beginTurn requires turnId');
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== 'active') throw new Error(`session is not active: ${sessionId}`);
  const alreadyCurrentTurn = session.currentTurnId === nextTurnId;
  session.turnId = nextTurnId;
  session.currentTurnId = nextTurnId;
  session.lastTurnStartedAt = new Date().toISOString();
  session.lastTurnStartReason = String(reason || 'browser_action');
  session.updatedAt = session.lastTurnStartedAt;
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  if (alreadyCurrentTurn) return { success: true, session, sessionEvent: null, alreadyCurrentTurn: true };
  const sessionEvent = await recordBrowserSessionEvent('turn.started', session, { turnId: nextTurnId, reason });
  return { success: true, session, sessionEvent, alreadyCurrentTurn: false };
}

export async function startBrowserSessionRequest(sessionId, request = {}) {
  if (!sessionId) throw new Error('startRequest requires sessionId');
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== 'active') throw new Error(`session is not active: ${sessionId}`);
  if (!session.currentTurnId) {
    session.currentTurnId = String(request.turnId || `turn-${Date.now().toString(36)}`);
    session.turnId = session.currentTurnId;
  } else if (request.turnId && session.currentTurnId !== String(request.turnId)) {
    session.currentTurnId = String(request.turnId);
    session.turnId = session.currentTurnId;
  }
  const requestId = String(request.requestId || `browser-request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  if (session.activeRequests[requestId]) {
    return {
      success: false,
      duplicateActive: true,
      requestId,
      session,
      activeRequest: session.activeRequests[requestId],
    };
  }
  const replay = session.recentRequests?.[requestId];
  if (replay?.terminal === true) {
    const sessionEvent = await recordBrowserSessionEvent('request.replayed', session, {
      requestId,
      action: replay.action || String(request.action || ''),
      terminalState: replay.terminalState || '',
      responsePersisted: replay.responsePersisted === true,
    });
    return {
      success: true,
      replayed: true,
      requestId,
      session,
      response: replay.response || null,
      responsePersisted: replay.responsePersisted === true,
      terminalState: replay.terminalState || '',
      sessionEvent,
    };
  }
  const startedAt = new Date().toISOString();
  session.activeRequests[requestId] = {
    requestId,
    action: String(request.action || ''),
    tabId: normalizeTabId(request.tabId),
    startedAt,
  };
  session.activeRequestCount = Object.keys(session.activeRequests).length;
  session.lastRequestStartedAt = startedAt;
  session.updatedAt = startedAt;
  if (session.activeRequests[requestId].tabId) {
    session.activeTabId = session.activeRequests[requestId].tabId;
    session.ownedTabIds = addOwnedTabId(session.ownedTabIds, session.activeRequests[requestId].tabId);
  }
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('request.started', session, {
    requestId,
    action: session.activeRequests[requestId].action,
    tabId: session.activeRequests[requestId].tabId,
  });
  return { success: true, requestId, session, sessionEvent };
}

export async function finishBrowserSessionRequest(sessionId, requestId, result = {}) {
  if (!sessionId) return { success: false, error: 'Missing sessionId' };
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) return { success: true, finished: false };
  const id = String(requestId || '');
  const activeRequest = id ? session.activeRequests[id] : null;
  if (id && session.activeRequests[id]) {
    session.activeRequests[id] = {
      ...session.activeRequests[id],
      finishedAt: new Date().toISOString(),
      status: result.success === false ? 'failed' : 'completed',
      error: result.error || '',
    };
    delete session.activeRequests[id];
  } else if (!id) {
    const [oldestId] = Object.keys(session.activeRequests);
    if (oldestId) delete session.activeRequests[oldestId];
  }
  if (id && activeRequest && result.persistResult !== false) {
    const persistedResponse = persistableBrowserResponse(result.response);
    session.recentRequests[id] = {
      requestId: id,
      action: activeRequest.action || '',
      tabId: activeRequest.tabId || null,
      startedAt: activeRequest.startedAt || '',
      finishedAt: new Date().toISOString(),
      terminal: true,
      terminalState: result.cancelled === true ? 'cancelled' : result.success === false ? 'failed' : 'completed',
      error: result.error || '',
      browserError: result.browserError || null,
      response: persistedResponse.response,
      responsePersisted: persistedResponse.persisted,
    };
    session.recentRequests = retainRecentRequests(session.recentRequests);
  }
  session.activeRequestCount = Object.keys(session.activeRequests).length;
  session.lastRequestFinishedAt = new Date().toISOString();
  session.updatedAt = session.lastRequestFinishedAt;
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('request.finished', session, {
    requestId: id,
    status: result.success === false ? 'failed' : 'completed',
    error: result.error || '',
  });
  return { success: true, finished: true, session, sessionEvent };
}

export async function setBrowserSessionOwnedTab(sessionId, tabId, reason = 'tab_claimed') {
  const id = normalizeTabId(tabId);
  if (!sessionId || !id) return { success: false, updated: false };
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) return { success: false, updated: false };
  const updatedAt = new Date().toISOString();
  session.activeTabId = id;
  session.ownedTabIds = addOwnedTabId(session.ownedTabIds, id);
  session.lastOwnedTabUpdatedAt = updatedAt;
  session.lastOwnedTabUpdateReason = String(reason || 'tab_claimed');
  session.updatedAt = updatedAt;
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('tab.owned', session, { tabId: id, reason });
  return { success: true, updated: true, session, sessionEvent };
}

export async function clearBrowserSessionOwnedTabs(sessionId, reason = 'release_tabs') {
  if (!sessionId) return { success: false, updated: false };
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) return { success: true, updated: false };
  session.ownedTabIds = [];
  session.activeTabId = null;
  session.lastOwnedTabUpdatedAt = new Date().toISOString();
  session.lastOwnedTabUpdateReason = String(reason || 'release_tabs');
  session.updatedAt = session.lastOwnedTabUpdatedAt;
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('tabs.released', session, { reason });
  return { success: true, updated: true, session, sessionEvent };
}

export function sessionHasActiveRequests(session) {
  return normalizeActiveRequestCount(session) > 0;
}

export async function endBrowserSession(sessionId) {
  if (!sessionId) return { success: false, error: 'Missing sessionId' };
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const session = normalizeSessionRuntimeState(sessions[sessionId]);
  if (!session) return { success: true, ended: false };
  session.status = 'ended';
  session.activeRequests = {};
  session.activeRequestCount = 0;
  session.endedAt = new Date().toISOString();
  sessions[sessionId] = session;
  await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvent = await recordBrowserSessionEvent('session.ended', session, { reason: session.endedReason || '' });
  return { success: true, ended: true, session, sessionEvent };
}

export async function stopActiveBrowserSessions(reason = 'stop_active_sessions') {
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const stoppedSessions = [];
  const endedAt = new Date().toISOString();
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session?.status !== 'active') continue;
    const stoppedSession = {
      ...normalizeSessionRuntimeState(session),
      status: 'ended',
      activeRequests: {},
      activeRequestCount: 0,
      endedAt,
      endedReason: String(reason || 'stop_active_sessions'),
    };
    sessions[sessionId] = stoppedSession;
    stoppedSessions.push(stoppedSession);
  }
  if (stoppedSessions.length) {
    await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  }
  const sessionEvents = [];
  for (const session of stoppedSessions) {
    sessionEvents.push(await recordBrowserSessionEvent('session.stopped', session, { reason: session.endedReason || reason }));
  }
  return { success: true, stoppedSessions, sessionEvents };
}

export async function reconcileInterruptedBrowserRequests(reason = 'extension_runtime_resumed') {
  const sessions = await getStoredMap(BROWSER_SESSIONS_KEY);
  const reconciledSessions = [];
  const interruptedRequests = [];
  const interruptedAt = new Date().toISOString();
  for (const [sessionId, storedSession] of Object.entries(sessions)) {
    const session = normalizeSessionRuntimeState(storedSession);
    const activeRequests = Object.values(session?.activeRequests || {});
    if (!session || session.status !== 'active' || !activeRequests.length) continue;
    const interruptedTurnId = String(session.currentTurnId || session.turnId || '');
    for (const request of activeRequests) {
      const requestId = String(request.requestId || '');
      if (!requestId) continue;
      const browserError = {
        code: 'BROWSER_ACTION_CANCELLED',
        message: 'Browser action was interrupted when the extension runtime restarted',
        retryable: false,
        userActionRequired: false,
        browserInstanceId: '',
        callId: requestId,
        details: { reason, sessionId, turnId: interruptedTurnId, action: request.action || '', tabId: request.tabId || null },
      };
      const response = {
        success: false,
        sessionId,
        turnId: interruptedTurnId,
        action: request.action || '',
        requestId,
        browserError,
        error: browserError.message,
        startedAt: request.startedAt || '',
        completedAt: interruptedAt,
      };
      session.recentRequests[requestId] = {
        requestId,
        action: request.action || '',
        tabId: request.tabId || null,
        startedAt: request.startedAt || '',
        finishedAt: interruptedAt,
        terminal: true,
        terminalState: 'cancelled',
        error: browserError.message,
        browserError,
        response,
        responsePersisted: true,
      };
      interruptedRequests.push({ sessionId, turnId: interruptedTurnId, requestId, action: request.action || '', tabId: request.tabId || null });
    }
    session.activeRequests = {};
    session.activeRequestCount = 0;
    session.recentRequests = retainRecentRequests(session.recentRequests);
    session.lastTurnId = interruptedTurnId;
    session.lastTurnInterruptedAt = interruptedAt;
    session.lastTurnInterruptReason = String(reason || 'extension_runtime_resumed');
    session.currentTurnId = null;
    session.updatedAt = interruptedAt;
    sessions[sessionId] = session;
    reconciledSessions.push({ ...session, interruptedTurnId });
  }
  if (reconciledSessions.length) await setStoredMap(BROWSER_SESSIONS_KEY, sessions);
  const sessionEvents = [];
  for (const request of interruptedRequests) {
    const session = sessions[request.sessionId] || {};
    sessionEvents.push(await recordBrowserSessionEvent('request.interrupted', session, { ...request, reason }));
  }
  return { success: true, reason, reconciledSessions, interruptedRequests, sessionEvents };
}

export async function listBrowserSessionEvents(options = {}) {
  const limit = clampLimit(options.limit || 200, 1, MAX_BROWSER_SESSION_EVENTS);
  const events = Object.values(await getStoredMap(BROWSER_SESSION_EVENTS_KEY))
    .filter((event) => matchesEventFilters(event, options))
    .sort((a, b) => String(b.emittedAt || '').localeCompare(String(a.emittedAt || '')))
    .slice(0, limit);
  return { success: true, events };
}

export async function recordBrowserSessionEvent(eventType, session = {}, payload = {}) {
  const event = {
    id: `browser-session-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    eventType,
    sessionId: session?.sessionId || payload.sessionId || '',
    turnId: session?.turnId || payload.turnId || '',
    currentTurnId: session?.currentTurnId || '',
    activeTabId: session?.activeTabId || payload.activeTabId || null,
    owner: session?.owner || '',
    activeRequestCount: Number(session?.activeRequestCount || 0),
    ownedTabIds: Array.isArray(session?.ownedTabIds) ? session.ownedTabIds : [],
    emittedAt: new Date().toISOString(),
    payload,
  };
  const events = await getStoredMap(BROWSER_SESSION_EVENTS_KEY);
  events[event.id] = event;
  const retained = Object.values(events)
    .sort((a, b) => String(b.emittedAt || '').localeCompare(String(a.emittedAt || '')))
    .slice(0, MAX_BROWSER_SESSION_EVENTS);
  await setStoredMap(BROWSER_SESSION_EVENTS_KEY, Object.fromEntries(retained.map((item) => [item.id, item])));
  notifyBrowserSessionEventSubscribers(event);
  return event;
}

function notifyBrowserSessionEventSubscribers(event) {
  if (!browserSessionEventSubscribers.size) return;
  for (const handler of browserSessionEventSubscribers) {
    try {
      handler(event);
    } catch (error) {
      console.warn('[XWOW BrowserDataAI] session event subscriber failed', error);
    }
  }
}

function normalizeSessionRuntimeState(session) {
  if (!session) return null;
  const activeRequests = normalizeActiveRequests(session.activeRequests);
  return {
    ...session,
    ownedTabIds: normalizeOwnedTabIds(session.ownedTabIds, session.activeTabId),
    activeRequests,
    activeRequestCount: Object.keys(activeRequests).length,
    recentRequests: normalizeRecentRequests(session.recentRequests),
  };
}

function normalizeActiveRequests(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([requestId, request]) => requestId && request && typeof request === 'object'));
}

function normalizeRecentRequests(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return retainRecentRequests(Object.fromEntries(Object.entries(value).filter(([requestId, request]) => (
    requestId && request && typeof request === 'object' && request.terminal === true
  ))));
}

function retainRecentRequests(value) {
  return Object.fromEntries(Object.entries(value || {})
    .sort(([, left], [, right]) => String(right?.finishedAt || '').localeCompare(String(left?.finishedAt || '')))
    .slice(0, MAX_RECENT_BROWSER_REQUESTS));
}

function persistableBrowserResponse(response) {
  if (response == null) return { persisted: true, response: null };
  try {
    const serialized = JSON.stringify(response);
    if (serialized.length <= MAX_PERSISTED_BROWSER_RESPONSE_BYTES) {
      return { persisted: true, response };
    }
  } catch {}
  return { persisted: false, response: null };
}

function normalizeActiveRequestCount(session) {
  if (!session) return 0;
  if (Number.isInteger(session.activeRequestCount) && session.activeRequestCount > 0) return session.activeRequestCount;
  return Object.keys(normalizeActiveRequests(session.activeRequests)).length;
}

function normalizeOwnedTabIds(value, activeTabId) {
  const ids = Array.isArray(value) ? value : [];
  const out = [];
  for (const candidate of [...ids, activeTabId]) {
    const id = normalizeTabId(candidate);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function addOwnedTabId(value, tabId) {
  const ids = normalizeOwnedTabIds(value, null);
  const id = normalizeTabId(tabId);
  if (id && !ids.includes(id)) ids.push(id);
  return ids;
}

function normalizeTabId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function matchesEventFilters(event, options = {}) {
  if (options.eventType && event.eventType !== options.eventType) return false;
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  if (options.turnId && event.turnId !== options.turnId) return false;
  if (options.tabId && Number(event.activeTabId || 0) !== Number(options.tabId)) return false;
  return true;
}

function clampLimit(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return min;
  return Math.max(min, Math.min(max, number));
}
