export const TAB_LIFECYCLE_EVENT_LIMIT = 300;

export function createTabLifecycleRuntime(options = {}) {
  const publishEvent = typeof options.publishEvent === 'function' ? options.publishEvent : null;
  const events = [];
  let initialized = false;

  function remember(event) {
    events.unshift(event);
    if (events.length > TAB_LIFECYCLE_EVENT_LIMIT) events.length = TAB_LIFECYCLE_EVENT_LIMIT;
    if (publishEvent) void publishEvent(event).catch(() => {});
  }

  function record(kind, payload = {}) {
    const event = normalizeLifecycleEvent(kind, payload);
    remember(event);
    return event;
  }

  function initialize() {
    if (initialized) return { success: true, initialized: true };
    initialized = true;
    chrome.tabs.onCreated?.addListener(handleTabCreated);
    chrome.tabs.onUpdated?.addListener(handleTabUpdated);
    chrome.tabs.onRemoved?.addListener(handleTabRemoved);
    chrome.tabs.onReplaced?.addListener(handleTabReplaced);
    chrome.tabs.onAttached?.addListener(handleTabAttached);
    chrome.tabs.onDetached?.addListener(handleTabDetached);
    chrome.windows?.onCreated?.addListener(handleWindowCreated);
    chrome.windows?.onRemoved?.addListener(handleWindowRemoved);
    chrome.windows?.onFocusChanged?.addListener(handleWindowFocusChanged);
    record('runtime.initialized', { initialized: true });
    return { success: true, initialized: true };
  }

  function dispose() {
    if (!initialized) return { success: true, initialized: false };
    initialized = false;
    chrome.tabs.onCreated?.removeListener(handleTabCreated);
    chrome.tabs.onUpdated?.removeListener(handleTabUpdated);
    chrome.tabs.onRemoved?.removeListener(handleTabRemoved);
    chrome.tabs.onReplaced?.removeListener(handleTabReplaced);
    chrome.tabs.onAttached?.removeListener(handleTabAttached);
    chrome.tabs.onDetached?.removeListener(handleTabDetached);
    chrome.windows?.onCreated?.removeListener(handleWindowCreated);
    chrome.windows?.onRemoved?.removeListener(handleWindowRemoved);
    chrome.windows?.onFocusChanged?.removeListener(handleWindowFocusChanged);
    record('runtime.disposed', { initialized: false });
    return { success: true, initialized: false };
  }

  function listEvents(options = {}) {
    const limit = clamp(Number(options.limit || 100), 1, TAB_LIFECYCLE_EVENT_LIMIT);
    const kind = String(options.kind || '');
    const eventType = String(options.eventType || '');
    const tabId = optionalNumber(options.tabId);
    const windowId = optionalNumber(options.windowId);
    const since = String(options.since || options.sinceEmittedAt || '');
    const afterEventId = String(options.afterEventId || '');
    const filtered = events
      .filter((event) => !kind || event.kind === kind)
      .filter((event) => !eventType || event.eventType === eventType)
      .filter((event) => tabId === null || event.tabId === tabId || event.oldTabId === tabId || event.newTabId === tabId)
      .filter((event) => windowId === null || event.windowId === windowId || event.fromWindowId === windowId || event.toWindowId === windowId)
      .filter((event) => !since || String(event.emittedAt || '') > since);
    const afterIndex = afterEventId ? filtered.findIndex((event) => event.eventId === afterEventId) : -1;
    const windowed = afterIndex >= 0 ? filtered.slice(afterIndex + 1) : filtered;
    const selected = windowed.slice(0, limit);
    return {
      success: true,
      eventType: 'tabLifecycle',
      events: selected,
      eventCount: selected.length,
      hasMore: windowed.length > selected.length,
      newestEventId: filtered[0]?.eventId || '',
      newestEmittedAt: filtered[0]?.emittedAt || '',
      initialized,
      limit,
    };
  }

  function getSnapshot() {
    const byKind = {};
    const tabIds = new Set();
    const windowIds = new Set();
    for (const event of events) {
      byKind[event.kind] = (byKind[event.kind] || 0) + 1;
      if (Number.isInteger(event.tabId)) tabIds.add(event.tabId);
      if (Number.isInteger(event.oldTabId)) tabIds.add(event.oldTabId);
      if (Number.isInteger(event.newTabId)) tabIds.add(event.newTabId);
      if (Number.isInteger(event.windowId)) windowIds.add(event.windowId);
      if (Number.isInteger(event.fromWindowId)) windowIds.add(event.fromWindowId);
      if (Number.isInteger(event.toWindowId)) windowIds.add(event.toWindowId);
    }
    return {
      success: true,
      eventType: 'tabLifecycle',
      initialized,
      snapshotAt: new Date().toISOString(),
      eventCount: events.length,
      newestEventId: events[0]?.eventId || '',
      newestEmittedAt: events[0]?.emittedAt || '',
      byKind,
      tabIds: [...tabIds],
      windowIds: [...windowIds],
      recentEvents: events.slice(0, 20),
    };
  }

  function handleTabCreated(tab) {
    record('tab.created', {
      tab: normalizeTab(tab),
      tabId: tab?.id,
      windowId: tab?.windowId,
      active: tab?.active === true,
      url: tab?.url || '',
      title: tab?.title || '',
      status: tab?.status || '',
    });
  }

  function handleTabUpdated(tabId, changeInfo = {}, tab = {}) {
    record('tab.updated', {
      tabId,
      windowId: tab?.windowId,
      changeKeys: Object.keys(changeInfo || {}),
      changeInfo: normalizeChangeInfo(changeInfo),
      tab: normalizeTab(tab),
      active: tab?.active === true,
      url: tab?.url || changeInfo?.url || '',
      title: tab?.title || changeInfo?.title || '',
      status: tab?.status || changeInfo?.status || '',
    });
  }

  function handleTabRemoved(tabId, removeInfo = {}) {
    record('tab.removed', {
      tabId,
      windowId: removeInfo?.windowId,
      isWindowClosing: removeInfo?.isWindowClosing === true,
      removeInfo: {
        windowId: optionalNumber(removeInfo?.windowId),
        isWindowClosing: removeInfo?.isWindowClosing === true,
      },
    });
  }

  function handleTabReplaced(addedTabId, removedTabId) {
    record('tab.replaced', {
      tabId: optionalNumber(addedTabId),
      newTabId: optionalNumber(addedTabId),
      oldTabId: optionalNumber(removedTabId),
    });
  }

  function handleTabAttached(tabId, attachInfo = {}) {
    record('tab.attached', {
      tabId,
      windowId: attachInfo?.newWindowId,
      toWindowId: attachInfo?.newWindowId,
      newPosition: attachInfo?.newPosition,
      attachInfo: normalizeAttachInfo(attachInfo),
    });
  }

  function handleTabDetached(tabId, detachInfo = {}) {
    record('tab.detached', {
      tabId,
      windowId: detachInfo?.oldWindowId,
      fromWindowId: detachInfo?.oldWindowId,
      oldPosition: detachInfo?.oldPosition,
      detachInfo: normalizeDetachInfo(detachInfo),
    });
  }

  function handleWindowCreated(window) {
    record('window.created', {
      windowId: window?.id,
      window: normalizeWindow(window),
    });
  }

  function handleWindowRemoved(windowId) {
    record('window.removed', { windowId });
  }

  function handleWindowFocusChanged(windowId) {
    record('window.focusChanged', { windowId });
  }

  return {
    initialize,
    dispose,
    listEvents,
    getSnapshot,
  };
}

function normalizeLifecycleEvent(kind, payload = {}) {
  return {
    eventId: payload.eventId || `tab-lifecycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    eventType: 'tabLifecycle',
    kind,
    emittedAt: new Date().toISOString(),
    ...payload,
    tabId: optionalNumber(payload.tabId),
    windowId: optionalNumber(payload.windowId),
    oldTabId: optionalNumber(payload.oldTabId),
    newTabId: optionalNumber(payload.newTabId),
    fromWindowId: optionalNumber(payload.fromWindowId),
    toWindowId: optionalNumber(payload.toWindowId),
  };
}

function normalizeTab(tab = {}) {
  if (!tab || typeof tab !== 'object') return null;
  return {
    id: optionalNumber(tab.id),
    windowId: optionalNumber(tab.windowId),
    index: optionalNumber(tab.index),
    active: tab.active === true,
    pinned: tab.pinned === true,
    highlighted: tab.highlighted === true,
    discarded: tab.discarded === true,
    status: tab.status || '',
    title: tab.title || '',
    url: tab.url || '',
    pendingUrl: tab.pendingUrl || '',
    groupId: optionalNumber(tab.groupId),
  };
}

function normalizeWindow(window = {}) {
  if (!window || typeof window !== 'object') return null;
  return {
    id: optionalNumber(window.id),
    focused: window.focused === true,
    type: window.type || '',
    state: window.state || '',
    top: optionalNumber(window.top),
    left: optionalNumber(window.left),
    width: optionalNumber(window.width),
    height: optionalNumber(window.height),
    tabIds: Array.isArray(window.tabs) ? window.tabs.map((tab) => optionalNumber(tab.id)).filter(Number.isInteger) : [],
  };
}

function normalizeChangeInfo(changeInfo = {}) {
  return {
    status: changeInfo.status || '',
    url: changeInfo.url || '',
    title: changeInfo.title || '',
    pinned: typeof changeInfo.pinned === 'boolean' ? changeInfo.pinned : null,
    audible: typeof changeInfo.audible === 'boolean' ? changeInfo.audible : null,
    discarded: typeof changeInfo.discarded === 'boolean' ? changeInfo.discarded : null,
    groupId: optionalNumber(changeInfo.groupId),
  };
}

function normalizeAttachInfo(attachInfo = {}) {
  return {
    newWindowId: optionalNumber(attachInfo.newWindowId),
    newPosition: optionalNumber(attachInfo.newPosition),
  };
}

function normalizeDetachInfo(detachInfo = {}) {
  return {
    oldWindowId: optionalNumber(detachInfo.oldWindowId),
    oldPosition: optionalNumber(detachInfo.oldPosition),
  };
}

function optionalNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
