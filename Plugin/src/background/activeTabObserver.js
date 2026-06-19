export function createActiveTabObserver(options = {}) {
  let activeTabIds = new Set();
  let activeTabIdByWindowId = new Map();
  let listenersRegistered = false;
  let onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {};

  const observer = {
    async initialize() {
      registerEventListeners();
      await refreshActiveTabs();
      return { success: true, activeTabIds: [...activeTabIds] };
    },
    dispose() {
      if (!listenersRegistered) return;
      listenersRegistered = false;
      chrome.tabs.onActivated?.removeListener(handleTabActivated);
      chrome.tabs.onCreated?.removeListener(handleTabCreated);
      chrome.tabs.onRemoved?.removeListener(handleTabWindowChanged);
      chrome.tabs.onReplaced?.removeListener(handleTabWindowChanged);
      chrome.tabs.onAttached?.removeListener(handleTabWindowChanged);
      chrome.tabs.onDetached?.removeListener(handleTabWindowChanged);
      chrome.tabs.onUpdated?.removeListener(handleTabUpdated);
      chrome.windows?.onCreated?.removeListener(handleWindowChanged);
      chrome.windows?.onFocusChanged?.removeListener(handleWindowChanged);
      chrome.windows?.onRemoved?.removeListener(handleWindowChanged);
    },
    setChangeHandler(handler) {
      onChanged = typeof handler === 'function' ? handler : () => {};
    },
    isObserved(tabId) {
      return activeTabIds.has(Number(tabId));
    },
    getSnapshot() {
      return {
        activeTabIds: [...activeTabIds],
        activeTabIdByWindowId: Object.fromEntries(activeTabIdByWindowId.entries()),
      };
    },
    refreshActiveTabs,
  };

  function registerEventListeners() {
    if (listenersRegistered) return;
    listenersRegistered = true;
    chrome.tabs.onActivated?.addListener(handleTabActivated);
    chrome.tabs.onCreated?.addListener(handleTabCreated);
    chrome.tabs.onRemoved?.addListener(handleTabWindowChanged);
    chrome.tabs.onReplaced?.addListener(handleTabWindowChanged);
    chrome.tabs.onAttached?.addListener(handleTabWindowChanged);
    chrome.tabs.onDetached?.addListener(handleTabWindowChanged);
    chrome.tabs.onUpdated?.addListener(handleTabUpdated);
    chrome.windows?.onCreated?.addListener(handleWindowChanged);
    chrome.windows?.onFocusChanged?.addListener(handleWindowChanged);
    chrome.windows?.onRemoved?.addListener(handleWindowChanged);
  }

  function handleTabActivated(activeInfo) {
    const windowId = Number(activeInfo?.windowId);
    const tabId = Number(activeInfo?.tabId);
    if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) return;
    setWindowActiveTab(windowId, tabId, 'activated');
  }

  function handleTabCreated(tab) {
    if (tab?.active !== true) return;
    const activeTab = activeTabFromChromeTab(tab);
    if (activeTab) setWindowActiveTab(activeTab.windowId, activeTab.tabId, 'created');
  }

  function handleTabUpdated(tabId, changeInfo, tab) {
    if (tab?.active !== true) return;
    const activeTab = activeTabFromChromeTab(tab);
    if (!activeTab) return;
    const changedKeys = Object.keys(changeInfo || {});
    if (!changedKeys.length) return;
    activeTabIdByWindowId.set(activeTab.windowId, activeTab.tabId);
    activeTabIds.add(activeTab.tabId);
    publishChangedTabs(new Set([activeTab.tabId]), 'updated', { changedKeys });
  }

  function handleTabWindowChanged() {
    void refreshActiveTabs().catch(() => {});
  }

  function handleWindowChanged() {
    void refreshActiveTabs().catch(() => {});
  }

  async function refreshActiveTabs() {
    const tabs = await chrome.tabs.query({ active: true }).catch(() => []);
    setActiveTabs(tabs.flatMap((tab) => activeTabFromChromeTab(tab) || []));
  }

  function setActiveTabs(activeTabs) {
    const nextActiveTabIds = new Set();
    const nextByWindowId = new Map();
    for (const item of activeTabs) {
      nextActiveTabIds.add(item.tabId);
      nextByWindowId.set(item.windowId, item.tabId);
    }
    const changed = diffSets(activeTabIds, nextActiveTabIds);
    activeTabIds = nextActiveTabIds;
    activeTabIdByWindowId = nextByWindowId;
    publishChangedTabs(changed, 'refreshed');
  }

  function setWindowActiveTab(windowId, tabId, reason = 'activated', metadata = {}) {
    const changed = new Set();
    const previousTabId = activeTabIdByWindowId.get(windowId);
    if (previousTabId !== undefined && previousTabId !== tabId) {
      activeTabIds.delete(previousTabId);
      changed.add(previousTabId);
    }
    activeTabIdByWindowId.set(windowId, tabId);
    if (!activeTabIds.has(tabId)) {
      activeTabIds.add(tabId);
      changed.add(tabId);
    }
    publishChangedTabs(changed, reason, metadata);
  }

  function publishChangedTabs(changed, reason = 'changed', metadata = {}) {
    const tabIds = [...changed];
    if (!tabIds.length) return;
    Promise.resolve(onChanged(tabIds, observer.getSnapshot(), {
      reason,
      ...metadata,
    })).catch(() => {});
  }

  return observer;
}

function activeTabFromChromeTab(tab) {
  if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number') return null;
  return { tabId: tab.id, windowId: tab.windowId };
}

function diffSets(previous, next) {
  const changed = new Set();
  for (const value of previous) {
    if (!next.has(value)) changed.add(value);
  }
  for (const value of next) {
    if (!previous.has(value)) changed.add(value);
  }
  return changed;
}
