export async function getActiveTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    capturable: isHttpUrl(tab.url),
  };
}

const TARGET_USER_TABS_LIMIT = 1000;

export async function listUserTabs(action = {}) {
  const tabs = await chrome.tabs.query({});
  const groupTitles = await getTabGroupTitles(tabs);
  const limit = normalizeLimit(action.limit ?? action.maxResults, TARGET_USER_TABS_LIMIT, 1, TARGET_USER_TABS_LIMIT, 'getUserTabs');
  const filters = normalizeUserTabFilters(action);
  const normalizedTabs = tabs
    .filter((tab) => Number.isInteger(tab.id))
    .sort(sortTabsByLastAccessed)
    .slice(0, TARGET_USER_TABS_LIMIT)
    .map((tab) => normalizeUserTab(tab, groupTitles));
  const filteredTabs = normalizedTabs
    .filter((tab) => userTabMatchesFilters(tab, filters))
    .slice(0, limit);
  return {
    success: true,
    limit,
    targetLimit: TARGET_USER_TABS_LIMIT,
    targetShape: 'array',
    filters,
    tabs: filteredTabs,
    targetTabs: filteredTabs.map(toTargetUserTab),
  };
}

export async function listBrowserWindows(action = {}) {
  const windowTypes = normalizeWindowTypes(action.windowTypes || action.windowType || action.type);
  const populate = action.populate !== false;
  const windows = await chrome.windows.getAll({
    populate,
    windowTypes,
  });
  return {
    success: true,
    filters: {
      populate,
      windowTypes,
    },
    windows: windows.map(normalizeBrowserWindow),
    snapshotAt: new Date().toISOString(),
  };
}

export async function searchUserHistory(action = {}) {
  const query = normalizeStringQuery(action.query, 'getUserHistory');
  const maxResults = normalizeTargetHistoryLimit(action.limit ?? action.maxResults);
  const search = { text: query, maxResults };
  search.startTime = action.from == null ? 0 : parseHistoryDate(action.from, 'from');
  if (action.to != null) search.endTime = parseHistoryDate(action.to, 'to');
  const items = await chrome.history.search(search);
  const entries = items.flatMap(normalizeHistoryEntry);
  return {
    success: true,
    limit: maxResults,
    targetShape: 'array',
    entries,
    history: entries.map(toTargetHistoryEntry),
    targetHistory: entries.map(toTargetHistoryEntry),
  };
}

export async function listUserBookmarks(action = {}) {
  const limit = normalizeLimit(action.limit ?? action.maxResults, 200, 1, 1000, 'getUserBookmarks');
  const query = String(action.query || '').trim();
  const nodes = query
    ? await chrome.bookmarks.search(query)
    : flattenBookmarkNodes(await chrome.bookmarks.getTree());
  return {
    success: true,
    bookmarks: nodes.slice(0, limit).map(normalizeBookmarkNode),
  };
}

export async function listTopSites(action = {}) {
  const limit = normalizeLimit(action.limit ?? action.maxResults, 50, 1, 100, 'getUserTopSites');
  const sites = await chrome.topSites.get();
  return {
    success: true,
    sites: sites.slice(0, limit).map((site) => ({
      url: site.url || '',
      title: site.title || '',
    })),
  };
}

export async function listReadingList(action = {}) {
  if (!chrome.readingList?.query) return { success: true, unavailable: true, entries: [] };
  const query = {};
  if (action.url) query.url = String(action.url);
  if (action.title) query.title = String(action.title);
  if (typeof action.hasBeenRead === 'boolean') query.hasBeenRead = action.hasBeenRead;
  const limit = normalizeLimit(action.limit ?? action.maxResults, 100, 1, 500, 'getUserReadingList');
  const entries = await chrome.readingList.query(query);
  return {
    success: true,
    entries: entries.slice(0, limit).map((entry) => ({
      url: entry.url || '',
      title: entry.title || '',
      hasBeenRead: entry.hasBeenRead === true,
      creationTime: entry.creationTime ? new Date(entry.creationTime).toISOString() : '',
      lastUpdateTime: entry.lastUpdateTime ? new Date(entry.lastUpdateTime).toISOString() : '',
    })),
  };
}

export async function listRecentlyClosedSessions(action = {}) {
  const maxResults = normalizeLimit(action.limit ?? action.maxResults, 25, 1, 100, 'getUserSessions');
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults });
  return {
    success: true,
    sessions: sessions.map(normalizeClosedSession),
  };
}

export async function listSessionDevices(action = {}) {
  const maxResults = normalizeLimit(action.limit ?? action.maxResults, 25, 1, 100, 'getUserSessions');
  const devices = await chrome.sessions.getDevices({ maxResults });
  return {
    success: true,
    devices: devices.map((device) => ({
      deviceName: device.deviceName || '',
      sessions: Array.isArray(device.sessions) ? device.sessions.map(normalizeClosedSession) : [],
    })),
  };
}

export async function getUserBrowserContext(action = {}) {
  const include = normalizeContextIncludes(action);
  const context = {
    success: true,
    include,
    snapshotAt: new Date().toISOString(),
  };
  if (include.includes('activeTab')) {
    context.activeTab = await getActiveTabInfo();
  }
  if (include.includes('tabs')) {
    context.tabs = await listUserTabs({
      ...action,
      limit: action.tabsLimit ?? action.tabLimit ?? action.limit,
      maxResults: action.tabsMaxResults ?? action.maxResults,
    });
  }
  if (include.includes('windows')) {
    context.windows = await listBrowserWindows({
      ...action,
      populate: action.windowPopulate ?? action.populate,
      windowTypes: action.windowTypes,
      windowType: action.windowType,
    });
  }
  if (include.includes('history')) {
    context.history = await searchUserHistory({
      ...action,
      limit: action.historyLimit ?? action.limit,
      maxResults: action.historyMaxResults ?? action.maxResults,
    });
  }
  if (include.includes('bookmarks')) {
    context.bookmarks = await listUserBookmarks({
      ...action,
      limit: action.bookmarksLimit ?? action.bookmarkLimit ?? action.limit,
      maxResults: action.bookmarksMaxResults ?? action.maxResults,
    });
  }
  if (include.includes('topSites')) {
    context.topSites = await listTopSites({
      ...action,
      limit: action.topSitesLimit ?? action.limit,
      maxResults: action.topSitesMaxResults ?? action.maxResults,
    });
  }
  if (include.includes('readingList')) {
    context.readingList = await listReadingList({
      ...action,
      limit: action.readingListLimit ?? action.limit,
      maxResults: action.readingListMaxResults ?? action.maxResults,
    });
  }
  if (include.includes('recentlyClosed')) {
    context.recentlyClosed = await listRecentlyClosedSessions({
      ...action,
      limit: action.sessionsLimit ?? action.recentlyClosedLimit ?? action.limit,
      maxResults: action.sessionsMaxResults ?? action.maxResults,
    });
  }
  if (include.includes('sessionDevices')) {
    context.sessionDevices = await listSessionDevices({
      ...action,
      limit: action.sessionDevicesLimit ?? action.sessionsLimit ?? action.limit,
      maxResults: action.sessionDevicesMaxResults ?? action.sessionsMaxResults ?? action.maxResults,
    });
  }
  return context;
}

export async function getTabGroupTitles(tabs) {
  const groups = new Map();
  const ids = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => typeof id === 'number' && id >= 0))];
  for (const id of ids) {
    const group = await chrome.tabGroups?.get(id).catch(() => null);
    if (group?.title) groups.set(id, group.title);
  }
  return groups;
}

function normalizeWindowTypes(value) {
  const requested = Array.isArray(value) ? value : (value ? [value] : ['normal']);
  const allowed = new Set(['normal', 'popup', 'panel', 'app', 'devtools']);
  const types = requested.map((item) => String(item || '').trim()).filter((item) => allowed.has(item));
  return types.length ? types : ['normal'];
}

function normalizeBrowserWindow(window) {
  const tabs = Array.isArray(window.tabs) ? window.tabs.map((tab) => normalizeUserTab(tab, new Map())) : [];
  return {
    id: window.id || null,
    focused: window.focused === true,
    top: Number.isInteger(window.top) ? window.top : null,
    left: Number.isInteger(window.left) ? window.left : null,
    width: Number.isInteger(window.width) ? window.width : null,
    height: Number.isInteger(window.height) ? window.height : null,
    state: window.state || '',
    type: window.type || '',
    alwaysOnTop: window.alwaysOnTop === true,
    activeTabId: tabs.find((tab) => tab.active)?.id || null,
    tabIds: tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)),
    tabCount: tabs.length,
    tabs,
  };
}

function normalizeUserTab(tab, groupTitles) {
  const lastOpenedMs = tab.lastAccessed && Number.isFinite(Number(tab.lastAccessed))
    ? Number(tab.lastAccessed)
    : 0;
  const lastOpened = tab.lastAccessed && Number.isFinite(Number(tab.lastAccessed))
    ? new Date(tab.lastAccessed).toISOString()
    : '';
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    lastOpened,
    tabGroup: groupTitles.get(tab.groupId) || '',
    windowId: tab.windowId,
    active: tab.active,
    favIconUrl: tab.favIconUrl || '',
    lastAccessed: lastOpened,
    lastOpenedMs,
  };
}

function toTargetUserTab(tab = {}) {
  return {
    id: tab.id,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.lastOpened ? { lastOpened: tab.lastOpened } : {}),
    ...(tab.tabGroup ? { tabGroup: tab.tabGroup } : {}),
  };
}

function normalizeUserTabFilters(action = {}) {
  const platformDomain = normalizeHostnameFilter(firstOptionalString(
    action.platformDomain,
    action.domain,
    action.host,
    action.hostname,
  ), 'platformDomain');
  const storeName = normalizeTextFilter(firstOptionalString(action.storeName, action.siteName), 'storeName');
  const tabGroup = normalizeTextFilter(firstOptionalString(action.tabGroup, action.groupTitle), 'tabGroup');
  const query = normalizeTextFilter(firstOptionalString(action.query, action.search), 'query');
  const urlIncludes = normalizeTextFilter(firstOptionalString(action.urlIncludes), 'urlIncludes');
  const recentActiveMs = normalizePositiveNumber(action.recentActiveMs, 'recentActiveMs');
  const lastOpenedAfter = normalizeOptionalDate(action.lastOpenedAfter ?? action.activeSince, 'lastOpenedAfter');
  const activeOnly = action.activeOnly === true;
  return {
    platformDomain,
    storeName,
    tabGroup,
    query,
    urlIncludes,
    recentActiveMs,
    lastOpenedAfter,
    activeOnly,
  };
}

function userTabMatchesFilters(tab, filters) {
  if (filters.activeOnly && tab.active !== true) return false;
  if (filters.platformDomain && !hostnameMatchesFilter(tab.url, filters.platformDomain)) return false;
  if (filters.urlIncludes && !String(tab.url || '').toLowerCase().includes(filters.urlIncludes)) return false;
  if (filters.tabGroup && !String(tab.tabGroup || '').toLowerCase().includes(filters.tabGroup)) return false;
  if (filters.storeName && !tabContainsText(tab, filters.storeName)) return false;
  if (filters.query && !tabContainsText(tab, filters.query)) return false;
  if (filters.recentActiveMs != null) {
    if (!tab.lastOpenedMs || Date.now() - tab.lastOpenedMs > filters.recentActiveMs) return false;
  }
  if (filters.lastOpenedAfter != null) {
    if (!tab.lastOpenedMs || tab.lastOpenedMs < filters.lastOpenedAfter) return false;
  }
  return true;
}

function tabContainsText(tab, needle) {
  const haystack = [
    tab.title,
    tab.url,
    tab.tabGroup,
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function hostnameMatchesFilter(url, hostnameFilter) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return false;
  return hostname === hostnameFilter || hostname.endsWith(`.${hostnameFilter}`);
}

function hostnameFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeHistoryEntry(item = {}) {
  if (typeof item.url !== 'string' || !Number.isFinite(Number(item.lastVisitTime))) return [];
  const dateVisited = new Date(item.lastVisitTime).toISOString();
  return [{
    url: item.url,
    title: item.title || '',
    dateVisited,
    id: item.id || '',
    visitCount: item.visitCount || 0,
    typedCount: item.typedCount || 0,
    lastVisitTime: dateVisited,
  }];
}

function toTargetHistoryEntry(entry = {}) {
  return {
    url: entry.url,
    ...(entry.title ? { title: entry.title } : {}),
    dateVisited: entry.dateVisited,
  };
}

function flattenBookmarkNodes(nodes = []) {
  const flattened = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    flattened.push(node);
    if (Array.isArray(node.children)) flattened.push(...flattenBookmarkNodes(node.children));
  }
  return flattened;
}

function normalizeBookmarkNode(node = {}) {
  return {
    id: node.id || '',
    parentId: node.parentId || '',
    title: node.title || '',
    url: node.url || '',
    dateAdded: node.dateAdded ? new Date(node.dateAdded).toISOString() : '',
    dateGroupModified: node.dateGroupModified ? new Date(node.dateGroupModified).toISOString() : '',
    childrenCount: Array.isArray(node.children) ? node.children.length : 0,
    type: node.url ? 'bookmark' : 'folder',
  };
}

function normalizeClosedSession(session = {}) {
  const tab = session.tab ? normalizeSessionTab(session.tab) : null;
  const window = session.window ? {
    sessionId: session.window.sessionId || '',
    tabs: Array.isArray(session.window.tabs) ? session.window.tabs.map(normalizeSessionTab) : [],
  } : null;
  return {
    lastModified: session.lastModified ? new Date(session.lastModified * 1000).toISOString() : '',
    tab,
    window,
  };
}

function normalizeSessionTab(tab = {}) {
  return {
    sessionId: tab.sessionId || '',
    id: tab.id || null,
    windowId: tab.windowId || null,
    index: Number.isInteger(tab.index) ? tab.index : null,
    url: tab.url || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
  };
}

function sortTabsByLastAccessed(a, b) {
  const lastAccessed = Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
  if (lastAccessed !== 0) return lastAccessed;
  const windowOrder = Number(a.windowId || 0) - Number(b.windowId || 0);
  if (windowOrder !== 0) return windowOrder;
  return Number(a.index || 0) - Number(b.index || 0);
}

function normalizeStringQuery(value, method) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${method} requires query to be a string`);
  return value;
}

function normalizeTextFilter(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`getUserTabs requires ${label} to be a string`);
  return value.trim().toLowerCase();
}

function normalizeHostnameFilter(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`getUserTabs requires ${label} to be a string`);
  const trimmed = value.trim();
  if (!trimmed) return '';
  const asUrl = hostnameFromUrl(trimmed);
  return (asUrl || trimmed).toLowerCase();
}

function normalizePositiveNumber(value, label) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`getUserTabs requires ${label} to be a positive number`);
  }
  return number;
}

function normalizeOptionalDate(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`getUserTabs requires ${label} to be a valid date`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`getUserTabs requires ${label} to be a valid date`);
  return parsed;
}

function firstOptionalString(...values) {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function parseHistoryDate(value, label) {
  if (typeof value !== 'string') throw new Error(`getUserHistory requires ${label} to be a valid date`);
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`getUserHistory requires ${label} to be a valid date`);
  return parsed;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function normalizeLimit(value, fallback, min, max, method) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${method} requires limit to be a positive integer`);
  }
  return Math.min(max, number);
}

function normalizeTargetHistoryLimit(value) {
  if (value == null) return 100;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('getUserHistory requires limit to be a positive integer');
  }
  return number;
}

function normalizeContextIncludes(action = {}) {
  const defaultIncludes = ['activeTab', 'tabs', 'windows'];
  const includeAll = action.includeAll === true || action.all === true;
  const raw = includeAll
    ? ['activeTab', 'tabs', 'windows', 'history', 'bookmarks', 'topSites', 'readingList', 'recentlyClosed', 'sessionDevices']
    : (action.include ?? action.includes ?? defaultIncludes);
  const requested = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',');
  const aliases = new Map([
    ['active', 'activeTab'],
    ['active_tab', 'activeTab'],
    ['active-tab', 'activeTab'],
    ['tab', 'tabs'],
    ['window', 'windows'],
    ['top_sites', 'topSites'],
    ['top-sites', 'topSites'],
    ['reading', 'readingList'],
    ['reading_list', 'readingList'],
    ['reading-list', 'readingList'],
    ['sessions', 'recentlyClosed'],
    ['recent', 'recentlyClosed'],
    ['recently_closed', 'recentlyClosed'],
    ['recently-closed', 'recentlyClosed'],
    ['devices', 'sessionDevices'],
    ['session_devices', 'sessionDevices'],
    ['session-devices', 'sessionDevices'],
  ]);
  const allowed = new Set(['activeTab', 'tabs', 'windows', 'history', 'bookmarks', 'topSites', 'readingList', 'recentlyClosed', 'sessionDevices']);
  const include = [];
  for (const item of requested) {
    const key = String(item || '').trim();
    if (!key) continue;
    const normalized = aliases.get(key) || key;
    if (!allowed.has(normalized)) {
      throw new Error(`getUserBrowserContext does not support include "${key}"`);
    }
    if (!include.includes(normalized)) include.push(normalized);
  }
  return include.length ? include : defaultIncludes;
}
