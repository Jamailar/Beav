export const BROWSER_PROTOCOL_SCHEMA_VERSION = 1;
export const NATIVE_METHOD_SCHEMA_CATALOG_VERSION = 1;

export const NATIVE_METHOD_SCHEMAS = {
  executeCdp: methodSchema('executeCdp', {
    required: ['method', 'target.tabId|targetId'],
    aliases: { timeoutMs: 'timeout_ms', tabId: 'target.tabId', targetId: 'target.targetId', params: 'commandParams' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'target?', 'tabId?', 'targetId?', 'method', 'params?', 'timeout_ms?'],
    outputFields: ['success', 'result|error'],
  }),
  attachTarget: methodSchema('attachTarget', {
    required: ['targetId', 'tabId'],
    aliases: { targetId: 'target.targetId', tabId: 'target.tabId' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'target?', 'targetId?', 'tabId?'],
    outputFields: ['success', 'attached'],
  }),
  detachTarget: methodSchema('detachTarget', {
    required: ['targetId', 'tabId'],
    aliases: { targetId: 'target.targetId', tabId: 'target.tabId' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'target?', 'targetId?', 'tabId?'],
    outputFields: ['success', 'detached'],
  }),
  moveMouse: methodSchema('moveMouse', {
    required: ['tabId', 'x', 'y'],
    aliases: { tabId: 'target.tabId' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'tabId?', 'target?', 'x', 'y', 'waitForArrival?'],
    outputFields: ['success', 'x', 'y', 'tabId'],
  }),
  claimUserTab: methodSchema('claimUserTab', {
    required: ['tabId'],
    aliases: { tabId: 'id|activeTabId' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'tabId'],
    outputFields: ['success', 'tabId', 'sessionId'],
  }),
  createTab: methodSchema('createTab', {
    required: [],
    aliases: { windowId: 'window_id' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'url?', 'windowId?', 'active?'],
    outputFields: ['success', 'tab'],
  }),
  finalizeTabs: methodSchema('finalizeTabs', {
    required: ['keep[]'],
    aliases: { tabs: 'keep|finalizedTabs' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'keep:[{tabId,status}]'],
    outputFields: ['success', 'keptTabs', 'releasedTabs'],
  }),
  nameSession: methodSchema('nameSession', {
    required: ['name'],
    aliases: { name: 'sessionName|session_name' },
    inputFields: ['session_id?', 'turn_id?', 'name'],
    outputFields: ['success', 'sessionId', 'name'],
  }),
  turnEnded: methodSchema('turnEnded', {
    required: ['turnId'],
    aliases: { turnId: 'turn_id' },
    inputFields: ['session_id?', 'turn_id'],
    outputFields: ['success', 'turnId'],
  }),
  browser_viewport_set: methodSchema('browser_viewport_set', {
    required: ['width', 'height'],
    aliases: { windowId: 'window_id', browserId: 'browser_id' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'window_id?', 'width', 'height'],
    outputFields: ['success', 'windowId', 'restore'],
  }),
  browser_viewport_reset: methodSchema('browser_viewport_reset', {
    required: [],
    aliases: { windowId: 'window_id', browserId: 'browser_id' },
    inputFields: ['browser_id?', 'session_id?', 'turn_id?', 'window_id?'],
    outputFields: ['success', 'windowId', 'restored'],
  }),
  tab_page_assets_list: methodSchema('tab_page_assets_list', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id' },
    inputFields: ['browser_id?', 'tab_id', 'session_id?', 'turn_id?'],
    outputFields: ['id', 'assets', 'inlineSvgs', 'pageUrl', 'summary'],
  }),
  tab_page_assets_bundle: methodSchema('tab_page_assets_bundle', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id', inventoryId: 'inventory_id', assetIds: 'asset_ids', types: 'kinds' },
    inputFields: ['browser_id?', 'tab_id', 'inventoryId?', 'assetIds?', 'kinds?', 'session_id?', 'turn_id?'],
    outputFields: ['assets', 'directoryPath', 'failures', 'manifestPath', 'summary'],
  }),
  'tab.capabilities.pageAssets.list': methodSchema('tab.capabilities.pageAssets.list', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id' },
    inputFields: ['browser_id?', 'tab_id', 'session_id?', 'turn_id?'],
    outputFields: ['id', 'assets', 'inlineSvgs', 'pageUrl', 'summary'],
  }),
  'tab.capabilities.pageAssets.bundle': methodSchema('tab.capabilities.pageAssets.bundle', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id', inventoryId: 'inventory_id', assetIds: 'asset_ids', types: 'kinds' },
    inputFields: ['browser_id?', 'tab_id', 'inventoryId?', 'assetIds?', 'kinds?', 'session_id?', 'turn_id?'],
    outputFields: ['assets', 'directoryPath', 'failures', 'manifestPath', 'summary'],
  }),
  'tab.consoleLogs': methodSchema('tab.consoleLogs', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id', timeoutMs: 'timeout_ms' },
    inputFields: ['browser_id?', 'tab_id', 'filter?', 'levels?', 'limit?', 'session_id?', 'turn_id?'],
    outputFields: ['logs[].level', 'logs[].message', 'logs[].timestamp', 'logs[].url'],
  }),
  tab_console_logs: methodSchema('tab_console_logs', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id', timeoutMs: 'timeout_ms' },
    inputFields: ['browser_id?', 'tab_id', 'filter?', 'levels?', 'limit?', 'session_id?', 'turn_id?'],
    outputFields: ['logs[].level', 'logs[].message', 'logs[].timestamp', 'logs[].url'],
  }),
  'tab.capabilities.webmcp.listTools': methodSchema('tab.capabilities.webmcp.listTools', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id' },
    inputFields: ['browser_id?', 'tab_id', 'session_id?', 'turn_id?'],
    outputFields: ['tools'],
  }),
  'tab.capabilities.webmcp.invokeTool': methodSchema('tab.capabilities.webmcp.invokeTool', {
    required: ['tab_id', 'tool_name'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id', toolName: 'tool_name', timeoutMs: 'timeout_ms' },
    inputFields: ['browser_id?', 'tab_id', 'tool_name', 'input?', 'timeout_ms?', 'session_id?', 'turn_id?'],
    outputFields: ['result'],
  }),
  webmcp_list_tools: methodSchema('webmcp_list_tools', {
    required: ['tab_id'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id' },
    inputFields: ['browser_id?', 'tab_id', 'session_id?', 'turn_id?'],
    outputFields: ['tools'],
  }),
  webmcp_invoke_tool: methodSchema('webmcp_invoke_tool', {
    required: ['tab_id', 'tool_name'],
    aliases: { tabId: 'tab_id', browserId: 'browser_id', toolName: 'tool_name', timeoutMs: 'timeout_ms' },
    inputFields: ['browser_id?', 'tab_id', 'tool_name', 'input?', 'timeout_ms?', 'session_id?', 'turn_id?'],
    outputFields: ['result'],
  }),
};

export function getNativeMethodSchemaCatalog() {
  return {
    schemaVersion: NATIVE_METHOD_SCHEMA_CATALOG_VERSION,
    protocolSchemaVersion: BROWSER_PROTOCOL_SCHEMA_VERSION,
    source: 'xwow_target_method_normalizers',
    targetEvidence: 'hehggada_schema_parse_safeParse_and_confirmed_native_methods',
    methods: NATIVE_METHOD_SCHEMAS,
  };
}

export function normalizeNativeMethodParams(method, params = {}) {
  const name = String(method || '');
  switch (name) {
    case 'executeCdp':
      return normalizeExecuteCdpParams(params);
    case 'executeUnhandledCommand':
      return normalizeExecuteUnhandledCommandParams(params);
    case 'attach':
    case 'detach':
      return normalizeAttachDetachParams(params, name);
    case 'attachTarget':
    case 'detachTarget':
      return normalizeAttachDetachTargetParams(params, name);
    case 'moveMouse':
      return normalizeMoveMouseParams(params);
    case 'nameSession':
      return normalizeNameSessionParams(params);
    case 'turnEnded':
      return normalizeTurnEndedParams(params);
    case 'createTab':
      return normalizeCreateTabParams(params);
    case 'claimUserTab':
      return normalizeClaimUserTabParams(params);
    case 'activateTab':
      return normalizeActivateTabParams(params);
    case 'navigateTab':
      return normalizeNavigateTabParams(params);
    case 'reloadTab':
      return normalizeReloadTabParams(params);
    case 'waitForPage':
    case 'waitTabReady':
      return normalizeWaitPageParams(params, name);
    case 'closeTab':
      return normalizeCloseTabParams(params);
    case 'finalizeTabs':
      return normalizeFinalizeTabsParams(params);
    case 'getUserTabs':
    case 'getUserBookmarks':
    case 'getUserTopSites':
    case 'getUserReadingList':
    case 'getUserSessions':
      return normalizeUserStateListParams(params, name);
    case 'getUserBrowserContext':
      return normalizeUserBrowserContextParams(params);
    case 'getWindows':
      return normalizeWindowListParams(params);
    case 'getUserHistory':
      return normalizeUserHistoryParams(params);
    case 'getLifecycleStatus':
    case 'getCapabilities':
    case 'getBrowserEventSummary':
    case 'getCdpAttachments':
    case 'getActiveTabObserverSnapshot':
      return normalizeSnapshotParams(params, name);
    case 'getTabLeases':
      return normalizeTabLeaseSnapshotParams(params);
    case 'getViewportState':
      return normalizeWindowListParams(params);
    case 'browser_viewport_set':
      return normalizeBrowserViewportSetParams(params);
    case 'browser_viewport_reset':
      return normalizeBrowserViewportResetParams(params);
    case 'tab.consoleLogs':
    case 'tab_console_logs':
      return normalizeTabConsoleLogsParams(params);
    case 'getBrowserVisibility':
    case 'browser_visibility_get':
      return normalizeBrowserVisibilityParams(params);
    case 'setBrowserVisibility':
    case 'browser_visibility_set':
      return normalizeBrowserVisibilityParams(params, { set: true });
    case 'webmcp_list_tools':
    case 'listWebMcpTools':
    case 'tab.capabilities.webmcp.listTools':
      return normalizeWebMcpListToolsParams(params);
    case 'webmcp_invoke_tool':
    case 'invokeWebMcpTool':
    case 'tab.capabilities.webmcp.invokeTool':
      return normalizeWebMcpInvokeToolParams(params);
    case 'tab_page_assets_list':
    case 'tab.capabilities.pageAssets.list':
      return normalizeTabPageAssetsListParams(params);
    case 'tab_page_assets_bundle':
    case 'tab.capabilities.pageAssets.bundle':
      return normalizeTabPageAssetsBundleParams(params);
    case 'getSidePanelStatus':
      return normalizeSidePanelStatusParams(params);
    case 'openSidePanel':
    case 'closeSidePanel':
    case 'toggleSidePanel':
      return normalizeSidePanelControlParams(params, name);
    default:
      return normalizeBaseParams(params);
  }
}

function methodSchema(method, options = {}) {
  return {
    method,
    schemaVersion: NATIVE_METHOD_SCHEMA_CATALOG_VERSION,
    actionClass: options.actionClass || 'browser_control',
    required: options.required || [],
    aliases: options.aliases || {},
    inputFields: options.inputFields || [],
    outputFields: options.outputFields || [],
    validation: 'normalized_by_browserProtocolSchemas',
  };
}

export function normalizeBaseParams(params = {}) {
  if (params != null && !isObject(params)) {
    throw new Error('browser protocol params must be an object');
  }
  const source = isObject(params) ? params : {};
  const normalized = { ...source };
  const sessionId = firstString(source.sessionId, source.session_id, source.browserSessionId, source.browser_session_id);
  const turnId = firstString(source.turnId, source.turn_id, source.browserTurnId, source.browser_turn_id);
  if (sessionId) normalized.sessionId = sessionId;
  if (turnId) normalized.turnId = turnId;
  if (source.timeout_ms != null && source.timeoutMs == null) normalized.timeoutMs = Number(source.timeout_ms);
  return normalized;
}

function normalizeSnapshotParams(params = {}, method = 'snapshot') {
  return normalizeBaseParams(params);
}

function normalizeTabLeaseSnapshotParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  if (normalized.include_tab_info != null && normalized.includeTabInfo == null) {
    normalized.includeTabInfo = normalized.include_tab_info !== false;
  }
  if (normalized.state != null) {
    const state = String(normalized.state || '').trim();
    if (state && !['active', 'handoff', 'deliverable', 'released'].includes(state)) {
      throw new Error('getTabLeases requires state to be active, handoff, deliverable, or released');
    }
    normalized.state = state;
  }
  return normalized;
}

function normalizeWindowListParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  if (normalized.populate != null) normalized.populate = normalized.populate !== false;
  if (normalized.window_id != null && normalized.windowId == null) normalized.windowId = Number(normalized.window_id);
  if (normalized.window_type != null && normalized.windowType == null) normalized.windowType = normalized.window_type;
  if (normalized.window_types != null && normalized.windowTypes == null) normalized.windowTypes = normalized.window_types;
  return normalized;
}

function normalizeBrowserViewportSetParams(params = {}) {
  const normalized = normalizeWindowListParams(params);
  const width = Number(normalized.width);
  const height = Number(normalized.height);
  if (!Number.isInteger(width) || width <= 0) throw new Error('browser_viewport_set requires width to be a positive integer');
  if (!Number.isInteger(height) || height <= 0) throw new Error('browser_viewport_set requires height to be a positive integer');
  normalized.width = width;
  normalized.height = height;
  return normalized;
}

function normalizeBrowserViewportResetParams(params = {}) {
  return normalizeWindowListParams(params);
}

function normalizeBrowserVisibilityParams(params = {}, options = {}) {
  const normalized = normalizeWindowListParams(params);
  if (normalized.include_windows != null && normalized.includeWindows == null) {
    normalized.includeWindows = normalized.include_windows === true;
  }
  if (normalized.window_state != null && normalized.windowState == null) normalized.windowState = normalized.window_state;
  if (options.set && normalized.visible == null && normalized.hidden == null && normalized.minimized == null && normalized.state == null && normalized.windowState == null) {
    normalized.visible = true;
  }
  return normalized;
}

function normalizeSidePanelStatusParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const windowIdProvided = normalized.windowId != null
    || normalized.window_id != null
    || normalized.params?.windowId != null
    || normalized.params?.window_id != null;
  const windowId = firstPositiveInteger(normalized.windowId, normalized.window_id, normalized.params?.windowId, normalized.params?.window_id);
  if (windowId) normalized.windowId = windowId;
  if (windowIdProvided && !windowId) {
    throw new Error('getSidePanelStatus requires windowId to be a positive integer when provided');
  }
  return normalized;
}

function normalizeSidePanelControlParams(params = {}, method = 'sidePanel') {
  return normalizeSidePanelStatusParams(params);
}

function normalizeWebMcpListToolsParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.tab_id, normalized.browserTabId, normalized.browser_tab_id);
  if (!tabId) throw new Error('webmcp_list_tools requires tabId to be a positive integer');
  normalized.tabId = tabId;
  if (normalized.frame_id != null && normalized.frameId == null) normalized.frameId = Number(normalized.frame_id);
  return normalized;
}

function normalizeWebMcpInvokeToolParams(params = {}) {
  const normalized = normalizeWebMcpListToolsParams(params);
  const toolName = firstString(normalized.toolName, normalized.tool_name, normalized.name);
  if (!toolName) throw new Error('webmcp_invoke_tool requires toolName to be a non-empty string');
  normalized.toolName = toolName;
  if (normalized.input == null) normalized.input = {};
  if (!isObject(normalized.input)) throw new Error('webmcp_invoke_tool requires input to be an object');
  return normalized;
}

function normalizeTabPageAssetsListParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.tab_id, normalized.browserTabId, normalized.browser_tab_id);
  if (!tabId) throw new Error('tab_page_assets_list requires tabId to be a positive integer');
  normalized.tabId = tabId;
  return normalized;
}

function normalizeTabPageAssetsBundleParams(params = {}) {
  const normalized = normalizeTabPageAssetsListParams(params);
  if (normalized.asset_ids != null && normalized.assetIds == null) normalized.assetIds = normalized.asset_ids;
  if (normalized.inventory_id != null && normalized.inventoryId == null) normalized.inventoryId = normalized.inventory_id;
  if (normalized.kinds != null && normalized.types == null) normalized.types = normalized.kinds;
  return normalized;
}

function normalizeTabConsoleLogsParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.tab_id, normalized.browserTabId, normalized.browser_tab_id);
  if (!tabId) throw new Error('tab.consoleLogs requires tabId to be a positive integer');
  normalized.tabId = tabId;
  if (normalized.limit != null) {
    const limit = Number(normalized.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('tab.consoleLogs requires limit to be a positive integer');
    normalized.limit = limit;
  }
  if (normalized.filter != null && typeof normalized.filter !== 'string') {
    throw new Error('tab.consoleLogs requires filter to be a string');
  }
  if (normalized.levels != null && !Array.isArray(normalized.levels)) {
    throw new Error('tab.consoleLogs requires levels to be an array');
  }
  return normalized;
}

function normalizeUserBrowserContextParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  if (normalized.include_all != null && normalized.includeAll == null) normalized.includeAll = normalized.include_all === true;
  if (normalized.tabs_limit != null && normalized.tabsLimit == null) normalized.tabsLimit = Number(normalized.tabs_limit);
  if (normalized.history_limit != null && normalized.historyLimit == null) normalized.historyLimit = Number(normalized.history_limit);
  if (normalized.bookmarks_limit != null && normalized.bookmarksLimit == null) normalized.bookmarksLimit = Number(normalized.bookmarks_limit);
  if (normalized.top_sites_limit != null && normalized.topSitesLimit == null) normalized.topSitesLimit = Number(normalized.top_sites_limit);
  if (normalized.reading_list_limit != null && normalized.readingListLimit == null) normalized.readingListLimit = Number(normalized.reading_list_limit);
  if (normalized.sessions_limit != null && normalized.sessionsLimit == null) normalized.sessionsLimit = Number(normalized.sessions_limit);
  if (normalized.session_devices_limit != null && normalized.sessionDevicesLimit == null) normalized.sessionDevicesLimit = Number(normalized.session_devices_limit);
  return normalized;
}

function normalizeExecuteCdpParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const method = firstString(normalized.method, normalized.command);
  if (!method) throw new Error('executeCdp requires method to be a non-empty string');
  normalized.method = method;
  const target = isObject(normalized.target) ? normalized.target : {};
  const targetId = firstString(normalized.targetId, normalized.id, target.targetId);
  const tabId = firstPositiveInteger(normalized.tabId, target.tabId);
  if (targetId) normalized.targetId = targetId;
  if (tabId) normalized.tabId = tabId;
  if (normalized.commandParams == null) normalized.commandParams = isObject(normalized.params) ? normalized.params : {};
  if (method !== 'Target.getTargets' && !targetId && !tabId) {
    throw new Error('executeCdp requires tabId or targetId');
  }
  return normalized;
}

function normalizeExecuteUnhandledCommandParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const unsupportedMethod = firstString(normalized.unsupportedMethod, normalized.method, normalized.command, normalized.action, normalized.type);
  if (!unsupportedMethod) throw new Error('executeUnhandledCommand requires method, command, action, or type');
  normalized.unsupportedMethod = unsupportedMethod;
  return normalized;
}

function normalizeAttachDetachParams(params = {}, method) {
  const normalized = normalizeBaseParams(params);
  const target = isObject(normalized.target) ? normalized.target : {};
  const targetId = firstString(normalized.targetId, normalized.id, target.targetId);
  const tabId = firstPositiveInteger(normalized.tabId, target.tabId);
  if (targetId) normalized.targetId = targetId;
  if (tabId) normalized.tabId = tabId;
  if (!targetId && !tabId) throw new Error(`${method} requires tabId or targetId`);
  if (targetId && !tabId) throw new Error(`${method} requires tabId when targetId is provided`);
  return normalized;
}

function normalizeAttachDetachTargetParams(params = {}, method) {
  const normalized = normalizeBaseParams(params);
  const target = isObject(normalized.target) ? normalized.target : {};
  const targetId = firstString(normalized.targetId, normalized.id, target.targetId);
  if (!targetId) throw new Error(`${method} requires targetId to be a non-empty string`);
  normalized.targetId = targetId;
  const tabId = firstPositiveInteger(normalized.tabId, target.tabId);
  if (!tabId) throw new Error(`${method} requires tabId to be a positive integer`);
  normalized.tabId = tabId;
  return normalized;
}

function normalizeMoveMouseParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, isObject(normalized.target) ? normalized.target.tabId : null);
  if (!tabId) throw new Error('moveMouse requires tabId to be a positive integer');
  if (!Number.isFinite(Number(normalized.x))) throw new Error('moveMouse requires x to be a finite number');
  if (!Number.isFinite(Number(normalized.y))) throw new Error('moveMouse requires y to be a finite number');
  normalized.tabId = tabId;
  normalized.x = Number(normalized.x);
  normalized.y = Number(normalized.y);
  return normalized;
}

function normalizeNameSessionParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const name = firstString(normalized.name, normalized.sessionName, normalized.session_name);
  if (!name) throw new Error('nameSession requires name to be a non-empty string');
  normalized.name = name;
  return normalized;
}

function normalizeTurnEndedParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const turnId = firstString(normalized.turnId, normalized.turn_id);
  if (!turnId) throw new Error('turnEnded requires turnId to be a non-empty string');
  normalized.turnId = turnId;
  return normalized;
}

function normalizeCreateTabParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  if (normalized.url != null && !firstString(normalized.url)) {
    throw new Error('createTab requires url to be a non-empty string when provided');
  }
  return normalized;
}

function normalizeClaimUserTabParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.id, normalized.activeTabId);
  if (!tabId) throw new Error('claimUserTab requires tabId to be a positive integer');
  normalized.tabId = tabId;
  return normalized;
}

function normalizeActivateTabParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.id, normalized.activeTabId);
  if (!tabId) throw new Error('activateTab requires tabId to be a positive integer');
  normalized.tabId = tabId;
  return normalized;
}

function normalizeNavigateTabParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.id, normalized.activeTabId);
  if (!tabId) throw new Error('navigateTab requires tabId to be a positive integer');
  const url = firstString(normalized.url, normalized.href);
  if (!url) throw new Error('navigateTab requires url to be a non-empty string');
  normalized.tabId = tabId;
  normalized.url = url;
  return normalized;
}

function normalizeReloadTabParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.id, normalized.activeTabId);
  if (!tabId) throw new Error('reloadTab requires tabId to be a positive integer');
  normalized.tabId = tabId;
  return normalized;
}

function normalizeWaitPageParams(params = {}, method = 'waitForPage') {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.id, normalized.activeTabId);
  if (!tabId) throw new Error(`${method} requires tabId to be a positive integer`);
  normalized.tabId = tabId;
  return normalized;
}

function normalizeCloseTabParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const tabId = firstPositiveInteger(normalized.tabId, normalized.id, normalized.activeTabId);
  if (!tabId) throw new Error('closeTab requires tabId to be a positive integer');
  normalized.tabId = tabId;
  return normalized;
}

function normalizeFinalizeTabsParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  const entries = normalized.keep ?? normalized.tabs ?? normalized.finalizedTabs;
  if (!Array.isArray(entries)) {
    throw new Error('finalizeTabs requires a keep array');
  }
  normalized.tabs = entries.map((entry) => normalizeFinalizeTabEntry(entry));
  normalized.keep = normalized.tabs;
  return normalized;
}

function normalizeFinalizeTabEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('finalizeTabs received invalid tab entry');
  const tabId = firstPositiveInteger(entry.tabId, entry.id);
  if (!tabId) throw new Error('finalizeTabs requires an integer tabId');
  const status = String(entry.status || '').trim();
  if (status !== 'handoff' && status !== 'deliverable') {
    throw new Error(`finalizeTabs received invalid status ${status || 'unknown'}`);
  }
  return {
    ...entry,
    tabId,
    status,
  };
}

function normalizeUserHistoryParams(params = {}) {
  const normalized = normalizeBaseParams(params);
  if (normalized.query != null && typeof normalized.query !== 'string') {
    throw new Error('getUserHistory requires query to be a string');
  }
  if (normalized.limit == null && normalized.maxResults != null) normalized.limit = normalized.maxResults;
  const limit = normalized.limit == null ? null : Number(normalized.limit);
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('getUserHistory requires limit to be a positive integer');
  }
  if (limit != null) normalized.limit = limit;
  validateDateString(normalized.from, 'from');
  validateDateString(normalized.to, 'to');
  return normalized;
}

function normalizeUserStateListParams(params = {}, method) {
  const normalized = normalizeBaseParams(params);
  if (normalized.limit == null && normalized.maxResults != null) normalized.limit = normalized.maxResults;
  if (normalized.limit != null) {
    const limit = Number(normalized.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`${method} requires limit to be a positive integer`);
    }
    normalized.limit = limit;
  }
  if (normalized.query != null && typeof normalized.query !== 'string') {
    throw new Error(`${method} requires query to be a string`);
  }
  if (method === 'getUserTabs') normalizeUserTabFilterParams(normalized);
  return normalized;
}

function normalizeUserTabFilterParams(normalized) {
  for (const field of ['platformDomain', 'domain', 'host', 'hostname', 'storeName', 'siteName', 'tabGroup', 'groupTitle', 'search', 'urlIncludes']) {
    if (normalized[field] != null && typeof normalized[field] !== 'string') {
      throw new Error(`getUserTabs requires ${field} to be a string`);
    }
  }
  if (normalized.recentActiveMs != null) {
    const recentActiveMs = Number(normalized.recentActiveMs);
    if (!Number.isFinite(recentActiveMs) || recentActiveMs <= 0) {
      throw new Error('getUserTabs requires recentActiveMs to be a positive number');
    }
    normalized.recentActiveMs = recentActiveMs;
  }
  validateUserTabsDateString(normalized.lastOpenedAfter, 'lastOpenedAfter');
  validateUserTabsDateString(normalized.activeSince, 'activeSince');
}

function validateUserTabsDateString(value, label) {
  if (value == null) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`getUserTabs requires ${label} to be a valid date`);
  }
}

function validateDateString(value, label) {
  if (value == null) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`getUserHistory requires ${label} to be a valid date`);
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
