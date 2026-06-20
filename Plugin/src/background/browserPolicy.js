export const DANGEROUS_ACTION_TEXT = /(save|submit|publish|delete|remove|refund|cancel order|ship order|change price|change inventory|change budget|enable ad|disable ad|保存|提交|发布|删除|移除|退款|取消订单|发货|改价|库存|预算|开启广告|关闭广告)/i;

export const DANGEROUS_CDP_METHODS = /^(Browser\.close|Browser\.crash|Browser\.crashGpuProcess|Page\.crash|Page\.produceCompilationCache|Storage\.clearDataForOrigin|Network\.deleteCookies|Runtime\.terminateExecution|Target\.closeTarget)$/;
export const STATE_CHANGING_CDP_METHODS = /^(Page\.navigate|Page\.reload|DOM\.set[A-Z].*|DOMStorage\.setDOMStorageItem|DOMStorage\.removeDOMStorageItem|Emulation\.set[A-Z].*|Network\.setCookie|Network\.clearBrowserCache|Network\.clearBrowserCookies|Storage\.clearDataForOrigin|Target\.closeTarget)$/;
export const BROWSER_POLICY_CONTRACT_VERSION = 2;

export const BROWSER_ACTION_LEVELS = {
  OBSERVE: 'observe',
  NAVIGATE: 'navigate',
  READ_ONLY_REVEAL: 'read_only_reveal',
  READ_ONLY_EXPORT: 'read_only_export',
  LOCAL_FILTER: 'local_filter',
  STATE_CHANGING: 'state_changing',
};

export const BROWSER_ACTION_CLASS_METADATA = {
  [BROWSER_ACTION_LEVELS.OBSERVE]: {
    mutatesPage: false,
    mutatesRemoteState: false,
    requiresApprovalToken: false,
  },
  [BROWSER_ACTION_LEVELS.NAVIGATE]: {
    mutatesPage: false,
    mutatesRemoteState: false,
    requiresApprovalToken: false,
  },
  [BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL]: {
    mutatesPage: false,
    mutatesRemoteState: false,
    requiresApprovalToken: false,
  },
  [BROWSER_ACTION_LEVELS.READ_ONLY_EXPORT]: {
    mutatesPage: false,
    mutatesRemoteState: false,
    requiresApprovalToken: false,
  },
  [BROWSER_ACTION_LEVELS.LOCAL_FILTER]: {
    mutatesPage: true,
    mutatesRemoteState: false,
    requiresApprovalToken: false,
  },
  [BROWSER_ACTION_LEVELS.STATE_CHANGING]: {
    mutatesPage: true,
    mutatesRemoteState: true,
    requiresApprovalToken: true,
  },
};

export const BROWSER_POLICY_APPROVAL_SCOPES = {
  STATE_CHANGING: 'state_changing',
  ANY: '*',
};

export function classifyBrowserAction(type) {
  if (typeof type === 'object' && type) return classifyBrowserActionPayload(type);
  if (/^cdp\.(targets|events|events\.summary|attachments|attachedTargets|screenshot|viewportState)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^command\.unsupported$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^cdp\.(attach|detach)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/^cdp\.viewport/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/^cdp\.send$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(page\.navigate|page\.goto)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/^page\.waitForLoadState$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(page\.evaluate|page\.evaluateScript)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.STATE_CHANGING;
  if (/^page\.(waitForURL|waitForTimeout)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^input\.mouseMove$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/^input\.mouseClick$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/^input\.mouseDrag$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/^input\.mouseWheel$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/^input\.keyboard/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/^cursor\./i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^page\.(click|doubleClick)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/^page\.hover$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/^page\.(inspectPoint|hitTest)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(page\.waitForNode|node\.wait)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(page\.scrollNode|node\.scroll)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/^(page\.clickNode|node\.click)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/^page\.(waitForSelector|waitSelector)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^page\.isChecked$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^page\.domSnapshot$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(page\.export|tab\.export)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_EXPORT;
  if (/^(page\.consoleLogs|tab_console_logs|tab\.consoleLogs)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^page\.(isVisible|getValue|getValues|getAttribute|queryElements)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(page\.readClipboard|clipboard\.read|page\.readClipboardText|clipboard\.readText)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_EXPORT;
  if (/^(browser\.fetchUrls|page\.fetchUrls|urls\.fetchContent)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_EXPORT;
  if (/^(page\.waitForFileChooser|fileChooser\.snapshot)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^page\.(check|setChecked)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/^page\.select$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/^(page\.writeClipboard|clipboard\.write|page\.writeClipboardText|clipboard\.writeText)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/^(page\.acceptFileChooser|fileChooser\.accept|page\.setInputFiles)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/^tab_page_assets_bundle$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_EXPORT;
  if (/^(webmcp\.listTools|webmcp_list_tools)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(webmcp\.invokeTool|webmcp_invoke_tool)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.STATE_CHANGING;
  if (/^(tab\.activate|activateTab|focusTab|tab\.back|tab\.forward)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/^(tab\.close|tab\.remove|closeTab)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.STATE_CHANGING;
  if (/^(browser\.ping|browser\.info|browser\.events|browser\.sessionEvents|browser\.clientHeartbeat|lifecycle\.status|browser\.lifecycleStatus|sidePanel\.status|sidepanel\.status|session\.tabs|session\.name|turn\.ended|tab\.info|tabLeases\.list|tabs\.leases|tab\.lifecycleEvents|tabs\.lifecycleEvents|tabLifecycle\.events|tab\.lifecycleSnapshot|tabs\.lifecycleSnapshot|tabLifecycle\.snapshot|tabs\.list|windows\.list|browser\.windows|tabs\.finalize|tabs\.finalizedBadges|managedTabGroups\.list|tabGroups\.managed|activeTabObserver\.snapshot|activeTabs\.snapshot|page\.frames|frames\.list|history\.search|bookmarks\.list|topSites\.list|readingList\.list|sessions\.recentlyClosed|sessions\.devices|browser\.context|userBrowser\.context|viewport\.state|cdp\.viewportState|browser\.visibility\.get|browser_visibility_get|tab_page_assets_list|download\.events|download\.state|downloads\.state|downloads\.search)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/^(browser\.visibility\.set|browser_visibility_set)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/^(sidePanel|sidepanel)\.(open|close|toggle)$/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  if (/screenshot|wait|read|assets/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.OBSERVE;
  if (/navigate|create|reload|scroll|viewport/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.NAVIGATE;
  if (/download/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_EXPORT;
  if (/type/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.LOCAL_FILTER;
  if (/click/i.test(String(type || ''))) return BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL;
  return BROWSER_ACTION_LEVELS.OBSERVE;
}

export function classifyBrowserActionPayload(action = {}) {
  if (String(action.type || '') === 'cdp.send') return classifyCdpMethod(action.method || action.command || '');
  return classifyBrowserAction(action.type);
}

export function classifyCdpMethod(method = '') {
  const name = String(method || '');
  if (!name || name === 'Target.getTargets') return BROWSER_ACTION_LEVELS.OBSERVE;
  if (DANGEROUS_CDP_METHODS.test(name) || STATE_CHANGING_CDP_METHODS.test(name)) return BROWSER_ACTION_LEVELS.STATE_CHANGING;
  if (/^(Page\.captureScreenshot|DOMSnapshot\.|Accessibility\.|Performance\.|Log\.|Target\.get|Runtime\.evaluate|Runtime\.callFunctionOn)$/i.test(name)) {
    return BROWSER_ACTION_LEVELS.OBSERVE;
  }
  if (/^(Emulation\.clear|Page\.bringToFront|Page\.get|Network\.get|DOM\.get|CSS\.get|Runtime\.get)/i.test(name)) {
    return BROWSER_ACTION_LEVELS.OBSERVE;
  }
  return BROWSER_ACTION_LEVELS.OBSERVE;
}

export function assertBrowserActionAllowed(action, options = {}) {
  const decision = buildBrowserPolicyDecision(action, options);
  if (!decision.allowed) throw browserPolicyError(decision.reason, action, { decision });
  return decision;
}

export function buildBrowserPolicyDecision(action, options = {}) {
  const isHttpUrl = options.isHttpUrl || ((url) => /^https?:\/\//i.test(String(url || '')));
  const actionClass = action.actionClass || classifyBrowserActionPayload(action);
  const actionClassMetadata = BROWSER_ACTION_CLASS_METADATA[actionClass] || null;
  const pageText = [action.selector, action.text, action.label, action.textRegex, action.url, action.currentUrl, action.method].filter(Boolean).join(' ');
  const actionType = String(action.type || '');
  const pageBoundAction = ![
    'download.wait',
    'command.unsupported',
    'viewport.set',
    'viewport.reset',
    'cdp.targets',
    'cdp.events',
    'cdp.events.summary',
    'cdp.attachments',
    'cdp.attachedTargets',
    'fileChooser.snapshot',
    'tab.activate',
    'tab.navigate',
    'tab.reload',
    'window.create',
    'browser.windowCreate',
    'page.waitReady',
    'tab.close',
    'tab.remove',
    'tab.info',
    'tab.back',
    'tab.forward',
    'page.waitForURL',
    'page.waitForTimeout',
    'tabs.list',
    'windows.list',
    'browser.windows',
    'browser.visibility.get',
    'browser_visibility_get',
    'browser.visibility.set',
    'browser_visibility_set',
    'tabs.finalize',
    'tabs.finalizedBadges',
    'managedTabGroups.list',
    'tabGroups.managed',
    'activeTabObserver.snapshot',
    'activeTabs.snapshot',
    'history.search',
    'bookmarks.list',
    'topSites.list',
    'readingList.list',
    'sessions.recentlyClosed',
    'sessions.devices',
    'browser.context',
    'userBrowser.context',
    'viewport.state',
    'cdp.viewportState',
    'download.events',
    'download.state',
    'downloads.state',
    'downloads.search',
    'browser_viewport_set',
    'browser_viewport_reset',
    'browser.ping',
    'browser.info',
    'browser.capabilities',
    'browser.events',
    'browser.events.summary',
    'browser.sessionEvents',
    'browser.clientHeartbeat',
    'browser.fetchUrls',
    'page.fetchUrls',
    'urls.fetchContent',
    'lifecycle.status',
    'browser.lifecycleStatus',
    'sidePanel.status',
    'sidepanel.status',
    'sidePanel.open',
    'sidepanel.open',
    'sidePanel.close',
    'sidepanel.close',
    'sidePanel.toggle',
    'sidepanel.toggle',
    'session.tabs',
    'tabLeases.list',
    'tabs.leases',
    'tab.lifecycleEvents',
    'tabs.lifecycleEvents',
    'tabLifecycle.events',
    'tab.lifecycleSnapshot',
    'tabs.lifecycleSnapshot',
    'tabLifecycle.snapshot',
    'session.name',
    'turn.ended',
    'webmcp.listTools',
    'webmcp_list_tools',
    'tab_page_assets_list',
    'tab_page_assets_bundle',
    'tab_console_logs',
  ].includes(actionType) && !(actionType.startsWith('cdp.') && action.targetId);
  if (!actionClassMetadata) return deniedPolicyDecision('action_policy_denied', action, actionClass, null);
  const approval = evaluateApprovalToken(action, actionClass, options);
  if (actionType === 'cdp.send' && DANGEROUS_CDP_METHODS.test(String(action.method || ''))) {
    return deniedPolicyDecision('denied_dangerous_cdp_method', action, actionClass, actionClassMetadata, { approval });
  }
  if (actionClassMetadata.requiresApprovalToken && !approval.accepted) {
    return deniedPolicyDecision('denied_state_changing_v1', action, actionClass, actionClassMetadata, { approval });
  }
  if (pageBoundAction && !isHttpUrl(action.currentUrl || action.url || '') && !actionType.startsWith('tab.create')) {
    return deniedPolicyDecision('denied_page_not_allowlisted', action, actionClass, actionClassMetadata, { approval });
  }
  if ((actionType === 'page.click' || actionType === 'page.doubleClick' || actionType === 'page.type' || actionType.startsWith('input.')) && DANGEROUS_ACTION_TEXT.test(pageText)) {
    return deniedPolicyDecision('denied_dangerous_action', action, actionClass, actionClassMetadata, { approval });
  }
  return {
    allowed: true,
    reason: 'allowed_by_page_plan',
    policyContractVersion: BROWSER_POLICY_CONTRACT_VERSION,
    actionClass,
    actionClassMetadata,
    requiresUserConfirmation: actionClassMetadata.requiresApprovalToken && !approval.accepted,
    approval,
  };
}

export function buildBrowserPolicyMetadata() {
  return {
    policyContractVersion: BROWSER_POLICY_CONTRACT_VERSION,
    actionLevels: { ...BROWSER_ACTION_LEVELS },
    actionClassMetadata: { ...BROWSER_ACTION_CLASS_METADATA },
    approvalScopes: { ...BROWSER_POLICY_APPROVAL_SCOPES },
    dangerousTextPattern: DANGEROUS_ACTION_TEXT.source,
    dangerousCdpPattern: DANGEROUS_CDP_METHODS.source,
    stateChangingCdpPattern: STATE_CHANGING_CDP_METHODS.source,
    approvalTokenBindings: ['actionType', 'actionTypes', 'method', 'methods', 'sessionId', 'tabId', 'requestId', 'tokenId'],
  };
}

export function evaluateApprovalToken(action = {}, actionClass = '', options = {}) {
  const token = action.approvalToken || action.approval || null;
  if (!token || typeof token !== 'object') return { accepted: false, reason: 'missing_approval_token' };
  if (token.approved !== true && token.granted !== true) return { accepted: false, reason: 'approval_not_granted' };
  const scope = String(token.scope || '');
  const scopes = Array.isArray(token.scopes) ? token.scopes.map(String) : [scope].filter(Boolean);
  const hasScope = scopes.includes(BROWSER_POLICY_APPROVAL_SCOPES.ANY)
    || scopes.includes(actionClass)
    || scopes.includes(BROWSER_POLICY_APPROVAL_SCOPES.STATE_CHANGING);
  if (!hasScope) return { accepted: false, reason: 'approval_scope_mismatch', scope, scopes };
  const actionTypeMatch = optionalStringMatch([action.type, action.requestedType], token.actionType, token.actionTypes);
  if (!actionTypeMatch.accepted) return { accepted: false, reason: 'approval_action_type_mismatch', ...actionTypeMatch, scope, scopes };
  const methodMatch = optionalStringMatch(action.method || action.command || '', token.method, token.methods);
  if (!methodMatch.accepted) return { accepted: false, reason: 'approval_method_mismatch', ...methodMatch, scope, scopes };
  const sessionMatch = optionalStringMatch(action.sessionId || options.sessionId || '', token.sessionId, token.sessionIds);
  if (!sessionMatch.accepted) return { accepted: false, reason: 'approval_session_mismatch', ...sessionMatch, scope, scopes };
  const tabMatch = optionalNumberMatch(action.tabId || options.tabId || null, token.tabId, token.tabIds);
  if (!tabMatch.accepted) return { accepted: false, reason: 'approval_tab_mismatch', ...tabMatch, scope, scopes };
  const requestMatch = optionalStringMatch(action.requestId || options.requestId || '', token.requestId, token.requestIds);
  if (!requestMatch.accepted) return { accepted: false, reason: 'approval_request_mismatch', ...requestMatch, scope, scopes };
  const now = Number(options.now || Date.now());
  const expiresAt = Number(token.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { accepted: false, reason: 'approval_expired', expiresAt };
  return {
    accepted: true,
    reason: 'approval_token_accepted',
    scope,
    scopes,
    expiresAt,
    approvedBy: String(token.approvedBy || ''),
    tokenId: String(token.tokenId || token.id || ''),
    bindings: {
      actionType: actionTypeMatch,
      method: methodMatch,
      sessionId: sessionMatch,
      tabId: tabMatch,
      requestId: requestMatch,
    },
  };
}

function deniedPolicyDecision(reason, action, actionClass, actionClassMetadata, details = {}) {
  return {
    allowed: false,
    reason,
    policyContractVersion: BROWSER_POLICY_CONTRACT_VERSION,
    actionType: String(action?.type || ''),
    actionClass,
    actionClassMetadata,
    requiresUserConfirmation: Boolean(actionClassMetadata?.requiresApprovalToken),
    ...details,
  };
}

function optionalStringMatch(actualValue, expectedValue, expectedValues) {
  const actualValues = (Array.isArray(actualValue) ? actualValue : [actualValue])
    .filter((value) => value != null && String(value).trim())
    .map(String);
  const actual = actualValues[0] || '';
  const expected = [
    expectedValue,
    ...(Array.isArray(expectedValues) ? expectedValues : []),
  ].filter((value) => value != null && String(value).trim()).map(String);
  if (!expected.length) return { accepted: true, constrained: false, actual, actualValues, expected: [] };
  return {
    accepted: actualValues.some((value) => expected.includes(value)),
    constrained: true,
    actual,
    actualValues,
    expected,
  };
}

function optionalNumberMatch(actualValue, expectedValue, expectedValues) {
  const actual = Number(actualValue || 0);
  const expected = [
    expectedValue,
    ...(Array.isArray(expectedValues) ? expectedValues : []),
  ].map(Number).filter((value) => Number.isInteger(value) && value > 0);
  if (!expected.length) return { accepted: true, constrained: false, actual: Number.isInteger(actual) ? actual : null, expected: [] };
  return {
    accepted: expected.includes(actual),
    constrained: true,
    actual,
    expected,
  };
}

export function browserPolicyError(reason, action, details = {}) {
  const error = new Error(`Browser action denied: ${reason}`);
  error.code = reason;
  error.action = action;
  error.details = details;
  return error;
}
