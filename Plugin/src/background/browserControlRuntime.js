export function createBrowserControlRuntime(options = {}) {
  const sessions = new Map();
  const tabSessions = new Map();
  const observedTabs = options.observedTabs || null;
  const republishCursorOverlayStateForTab = options.republishCursorOverlayStateForTab || (async () => ({ success: true }));
  const readCursorOverlayState = options.readCursorOverlayState || (() => null);
  const clearCursorOverlayForTab = options.clearCursorOverlayForTab || (async () => ({ success: true }));
  const onActivityChange = typeof options.onActivityChange === 'function' ? options.onActivityChange : null;
  let lastBrowserControlActive = false;

  function ensureSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) throw new Error('browser control runtime requires sessionId');
    const existing = sessions.get(id);
    if (existing) return existing;
    const session = {
      sessionId: id,
      currentTurnId: null,
      isRunning: false,
      activeRequests: 0,
      tabIds: new Set(),
      cursorByTabId: new Map(),
      abortController: null,
      startedAt: null,
      updatedAt: null,
    };
    sessions.set(id, session);
    return session;
  }

  function getSession(sessionId) {
    return sessions.get(String(sessionId || '')) || null;
  }

  async function startSession(sessionId, turnId = null, opts = {}) {
    const session = ensureSession(sessionId);
    const nextTurnId = turnId == null ? session.currentTurnId : String(turnId);
    if (nextTurnId && session.currentTurnId && session.currentTurnId !== nextTurnId) {
      session.cursorByTabId.clear();
    }
    session.currentTurnId = nextTurnId || session.currentTurnId || null;
    session.isRunning = true;
    session.startedAt = session.startedAt || new Date().toISOString();
    session.updatedAt = new Date().toISOString();
    if (opts.publishTabs !== false) await republishSessionTabs(session.sessionId, { reason: opts.reason || 'session_started' });
    notifyActivityChange();
    return snapshotSession(session);
  }

  async function finishSession(sessionId, opts = {}) {
    const session = getSession(sessionId);
    if (!session) return { success: true, finished: false };
    session.isRunning = false;
    session.activeRequests = 0;
    session.abortController = null;
    session.updatedAt = new Date().toISOString();
    if (opts.releaseTabs !== false) {
      for (const tabId of [...session.tabIds]) {
        await untrackTab(session.sessionId, tabId, { reason: opts.reason || 'session_finished', publish: opts.publish !== false, clearCursor: opts.clearCursor !== false });
      }
    } else if (opts.publish !== false) {
      await republishSessionTabs(session.sessionId, { reason: opts.reason || 'session_finished' });
    }
    session.cursorByTabId.clear();
    notifyActivityChange();
    return { success: true, finished: true, session: snapshotSession(session) };
  }

  async function stopSession(sessionId, reason = 'stop_session') {
    return await finishSession(sessionId, { reason, releaseTabs: true, publish: true, clearCursor: true });
  }

  async function stopActiveSessions(reason = 'stop_active_sessions') {
    const stoppedSessions = [];
    for (const session of [...sessions.values()]) {
      if (!session.isRunning && session.activeRequests <= 0) continue;
      const stopped = await stopSession(session.sessionId, reason);
      if (stopped?.session) stoppedSessions.push(stopped.session);
    }
    notifyActivityChange();
    return { success: true, stoppedSessions };
  }

  async function trackTab(sessionId, tabId, opts = {}) {
    const id = normalizeTabId(tabId);
    if (!id) return { success: false, tracked: false, error: 'trackTab requires tabId' };
    const session = ensureSession(sessionId);
    session.tabIds.add(id);
    tabSessions.set(id, session.sessionId);
    session.updatedAt = new Date().toISOString();
    if (opts.publish !== false) await republishTabState(id, { reason: opts.reason || 'tab_tracked' });
    notifyActivityChange();
    return { success: true, tracked: true, session: snapshotSession(session), tabId: id };
  }

  async function trackTabs(sessionId, tabIds = [], opts = {}) {
    const results = [];
    for (const tabId of Array.isArray(tabIds) ? tabIds : []) {
      results.push(await trackTab(sessionId, tabId, opts));
    }
    return { success: true, results };
  }

  async function untrackTab(sessionId, tabId, opts = {}) {
    const id = normalizeTabId(tabId);
    if (!id) return { success: false, untracked: false, error: 'untrackTab requires tabId' };
    const session = getSession(sessionId);
    if (session) {
      session.tabIds.delete(id);
      session.cursorByTabId.delete(id);
      session.updatedAt = new Date().toISOString();
    }
    if (!sessionId || tabSessions.get(id) === String(sessionId)) tabSessions.delete(id);
    if (opts.clearCursor !== false) await clearCursorOverlayForTab(id, opts.reason || 'tab_untracked').catch(() => null);
    if (opts.publish !== false) await republishTabState(id, { reason: opts.reason || 'tab_untracked' });
    notifyActivityChange();
    return { success: true, untracked: true, tabId: id, session: session ? snapshotSession(session) : null };
  }

  async function untrackTabs(sessionId, tabIds = [], opts = {}) {
    const results = [];
    for (const tabId of Array.isArray(tabIds) ? tabIds : []) {
      results.push(await untrackTab(sessionId, tabId, opts));
    }
    return { success: true, results };
  }

  async function forgetTab(tabId, opts = {}) {
    const id = normalizeTabId(tabId);
    if (!id) return { success: false, forgotten: false };
    const sessionId = tabSessions.get(id);
    if (sessionId) return await untrackTab(sessionId, id, opts);
    if (opts.clearCursor !== false) await clearCursorOverlayForTab(id, opts.reason || 'tab_forgotten').catch(() => null);
    if (opts.publish !== false) await republishTabState(id, { reason: opts.reason || 'tab_forgotten' });
    return { success: true, forgotten: true, tabId: id };
  }

  async function replaceTab(removedTabId, addedTabId, sessionId = '', opts = {}) {
    const removed = normalizeTabId(removedTabId);
    const added = normalizeTabId(addedTabId);
    if (!removed || !added) return { success: false, replaced: false };
    const ownerSessionId = String(sessionId || tabSessions.get(removed) || '');
    if (!ownerSessionId) return { success: true, replaced: false };
    await untrackTab(ownerSessionId, removed, { reason: opts.reason || 'tab_replaced', publish: false, clearCursor: true });
    await trackTab(ownerSessionId, added, { reason: opts.reason || 'tab_replaced', publish: opts.publish !== false });
    return { success: true, replaced: true, sessionId: ownerSessionId, removedTabId: removed, addedTabId: added };
  }

  async function startRequest(sessionId, tabId = null, opts = {}) {
    const session = ensureSession(sessionId);
    if (!session.isRunning) {
      if (opts.autoStart === false) throw new Error(`Browser control session is not running: ${sessionId}`);
      await startSession(session.sessionId, opts.turnId || session.currentTurnId, { publishTabs: false, reason: 'request_started' });
    }
    const id = normalizeTabId(tabId);
    if (id) await trackTab(session.sessionId, id, { publish: false, reason: 'request_started' });
    session.activeRequests += 1;
    session.abortController = session.abortController || new AbortController();
    session.updatedAt = new Date().toISOString();
    if (opts.publishTabs !== false) await republishSessionTabs(session.sessionId, { reason: opts.reason || 'request_started' });
    notifyActivityChange();
    return session.abortController.signal;
  }

  async function finishRequest(sessionId, opts = {}) {
    const session = getSession(sessionId);
    if (!session) return { success: true, finished: false };
    session.activeRequests = Math.max(0, session.activeRequests - 1);
    if (session.activeRequests === 0) session.abortController = null;
    session.updatedAt = new Date().toISOString();
    if (opts.publishTabs !== false) await republishSessionTabs(session.sessionId, { reason: opts.reason || 'request_finished' });
    notifyActivityChange();
    return { success: true, finished: true, session: snapshotSession(session) };
  }

  async function setCursorState(sessionId, tabId, turnId, state, opts = {}) {
    const session = ensureSession(sessionId);
    const id = normalizeTabId(tabId);
    if (!id) throw new Error('setCursorState requires tabId');
    if (!session.isRunning) throw new Error(`Browser control session is not running: ${sessionId}`);
    if (turnId != null) session.currentTurnId = String(turnId);
    session.cursorByTabId.set(id, state || null);
    await trackTab(session.sessionId, id, { publish: false, reason: 'cursor_state_set' });
    if (opts.publish !== false) await republishTabState(id, { reason: opts.reason || 'cursor_state_set' });
    return { success: true, tabId: id, session: snapshotSession(session) };
  }

  function isObserved(tabId) {
    const id = normalizeTabId(tabId);
    if (!id) return false;
    if (typeof observedTabs?.isObserved === 'function') return observedTabs.isObserved(id);
    const snapshot = typeof observedTabs?.getSnapshot === 'function' ? observedTabs.getSnapshot() : null;
    return Array.isArray(snapshot?.activeTabIds) ? snapshot.activeTabIds.includes(id) : true;
  }

  function readCursorState(tabId) {
    const id = normalizeTabId(tabId);
    if (!id) return defaultCursorState();
    const sessionId = tabSessions.get(id);
    const session = sessionId ? getSession(sessionId) : null;
    if (!session?.isRunning) return defaultCursorState();
    const stored = session.cursorByTabId.get(id) || readCursorOverlayState(id);
    if (!stored) {
      return {
        cursor: null,
        isVisible: false,
        sessionId: session.sessionId,
        turnId: session.currentTurnId,
      };
    }
    if (isObserved(id)) return stored;
    const cursor = stored.cursor && typeof stored.cursor === 'object'
      ? { ...stored.cursor, visible: false }
      : null;
    return {
      ...stored,
      cursor,
      isVisible: false,
    };
  }

  async function republishTabState(tabId, opts = {}) {
    const id = normalizeTabId(tabId);
    if (!id) return { success: false, republished: false };
    const isControlledTab = tabSessions.has(id);
    return await republishCursorOverlayStateForTab(id, {
      isObserved: isObserved(id),
      injectIfMissing: isControlledTab,
      reason: opts.reason || 'browser_control_tab_state',
    });
  }

  async function republishTabStates(tabIds = [], opts = {}) {
    const ids = normalizeTabIds(tabIds);
    const results = [];
    for (const id of ids) {
      results.push(await republishTabState(id, opts).catch((error) => ({
        success: false,
        tabId: id,
        error: error instanceof Error ? error.message : String(error),
      })));
    }
    return { success: true, results };
  }

  async function republishSessionTabs(sessionId, opts = {}) {
    const session = getSession(sessionId);
    if (!session) return { success: true, results: [] };
    return await republishTabStates([...session.tabIds], opts);
  }

  function isBrowserControlActive() {
    for (const session of sessions.values()) {
      if (session.isRunning || session.activeRequests > 0) return true;
    }
    return false;
  }

  function getSnapshot() {
    const sessionSnapshots = [...sessions.values()].map(snapshotSession);
    return {
      active: isBrowserControlActive(),
      sessionCount: sessionSnapshots.length,
      runningSessionIds: sessionSnapshots.filter((session) => session.isRunning).map((session) => session.sessionId),
      activeRequestCount: sessionSnapshots.reduce((total, session) => total + session.activeRequests, 0),
      tabSessionCount: tabSessions.size,
      controlledTabIds: [...tabSessions.keys()].sort((a, b) => a - b),
      sessions: sessionSnapshots,
    };
  }

  function notifyActivityChange() {
    const nextActive = isBrowserControlActive();
    if (nextActive === lastBrowserControlActive) return;
    lastBrowserControlActive = nextActive;
    onActivityChange?.(nextActive, getSnapshot());
  }

  return {
    sessions,
    tabSessions,
    startSession,
    finishSession,
    stopSession,
    stopActiveSessions,
    trackTab,
    trackTabs,
    untrackTab,
    untrackTabs,
    forgetTab,
    replaceTab,
    startRequest,
    finishRequest,
    setCursorState,
    readCursorState,
    republishTabState,
    republishTabStates,
    republishSessionTabs,
    isObserved,
    isBrowserControlActive,
    getSnapshot,
  };
}

function snapshotSession(session) {
  return {
    sessionId: session.sessionId,
    currentTurnId: session.currentTurnId || null,
    isRunning: session.isRunning === true,
    activeRequests: Number(session.activeRequests || 0),
    tabIds: [...session.tabIds].sort((a, b) => a - b),
    cursorTabIds: [...session.cursorByTabId.keys()].sort((a, b) => a - b),
    startedAt: session.startedAt || null,
    updatedAt: session.updatedAt || null,
  };
}

function defaultCursorState() {
  return {
    cursor: null,
    isVisible: false,
    sessionId: null,
    turnId: null,
  };
}

function normalizeTabId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeTabIds(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = normalizeTabId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
