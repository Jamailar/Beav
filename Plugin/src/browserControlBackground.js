import { assertBrowserActionAllowed, BROWSER_ACTION_LEVELS, browserPolicyError, buildBrowserPolicyMetadata, classifyBrowserAction, DANGEROUS_ACTION_TEXT, DANGEROUS_CDP_METHODS, resolveBrowserPolicyPageUrl } from './background/browserPolicy.js';
import { createActiveTabObserver } from './background/activeTabObserver.js';
import { buildBrowserCapabilityMetadata, buildPluginRegistrationPayload } from './background/browserCapabilities.js';
import { createBrowserControlRuntime } from './background/browserControlRuntime.js';
import { createBrowserEventBridge, listBrowserEvents } from './background/browserEventBridge.js';
import { configureBrowserVisibilityTelemetry, getBrowserVisibility, setBrowserVisibility } from './background/browserVisibilityRuntime.js';
import { beginBrowserSessionTurn, createBrowserSession as createStoredBrowserSession, endBrowserSession as endStoredBrowserSession, ensureBrowserSession as ensureStoredBrowserSession, finishBrowserSessionRequest, getBrowserSession, listBrowserSessionEvents, listBrowserSessions as listStoredBrowserSessions, markTurnEnded as markStoredTurnEnded, nameBrowserSession as nameStoredBrowserSession, reconcileInterruptedBrowserRequests, sessionHasActiveRequests, startBrowserSessionRequest, stopActiveBrowserSessions as stopStoredActiveBrowserSessions, subscribeBrowserSessionEvents } from './background/browserSessionRuntime.js';
import { attachCdpTab, attachCdpTarget, configureCdpTransportTelemetry, detachAttachedDebuggersBestEffort, detachAttachedDebuggersForTabs, detachCdpTarget, forgetAttachedCdpTab, getAttachedCdpSnapshot, getCdpProtocolVersion, getDefaultCdpTimeoutMs, handleDebuggerDetach, hasAttachedCdp, isCdpCommandTimeoutError, listCdpTargetsRaw, requireDebuggerApi, sendCdpCommandWithTimeout } from './background/cdpTransport.js';
import { listCdpEvents, recordCdpEvent, summarizeCdpEvents } from './background/cdpEventRuntime.js';
import { captureCdpScreenshot, captureVisibleTabScreenshot, getViewportState, resetBrowserViewport, resetCdpViewport, setBrowserViewport, setCdpViewport } from './background/cdpPageRuntime.js';
import { readPageClipboard, readPageClipboardText, writePageClipboard, writePageClipboardText } from './background/clipboardRuntime.js';
import { commandRouterErrorEnvelope, createLocalCommandActionRouter, createNativeMethodRouter } from './background/commandRouter.js';
import { normalizeNativeMethodParams } from './background/browserProtocolSchemas.js';
import { getConsoleLogSnapshot, handleConsoleCdpEvent, listPageConsoleLogs } from './background/consoleLogRuntime.js';
import { addDownloadChangeListener, getDownloadState, handleDownloadChanged, handleDownloadCreated, listDownloadEvents, searchDownloads, waitForDownload } from './background/downloadRuntime.js';
import { configureDynamicContentInjectionTelemetry, ensureContentScript, sendContentMessage } from './background/dynamicContentInjection.js';
import { acceptFileChooser, configureFileChooserTelemetry, getFileChooserSnapshot, handleFileChooserCdpEvent, handleFileChooserDomEvent, setInputFiles, waitForFileChooser } from './background/fileChooserRuntime.js';
import { listPageFrames } from './background/frameRuntime.js';
import { CLIENT_HEARTBEAT_ALARM, TARGET_CLIENT_HEARTBEAT_ALARM, configureLifecycleGuard, ensureLifecycleInstallState, getBrowserClientHeartbeatState, getLifecycleStatus, handleLifecycleAlarm, maybeReloadForPendingUpdate, recordBrowserClientHeartbeat, recordLifecycleCleanupResult, registerLifecycleUpdateListener, restorePendingUpdate, startClientHeartbeat } from './background/lifecycleGuard.js';
import { NATIVE_HOST_DEFAULT, NATIVE_RECONNECT_ALARM, configureNativeTransport, connectNativeTransport as connectNativeTransportRaw, disconnectNativeTransport, getNativeStatus, postNativeMessage, refreshNativeStatus, requestNativeHost as requestNativeHostRaw, restoreNativeStatus, sendNativeNotification } from './background/nativeTransport.js';
import { CONTENT_PAGE_ASSETS_TYPE, bundlePageAssets, readPageAssetInventory } from './background/pageAssetRuntime.js';
import { exportPage } from './background/pageExportRuntime.js';
import { evaluatePageScript } from './background/pageScriptRuntime.js';
import { CONTENT_CURSOR_ARRIVED_TYPE, TARGET_CURSOR_ARRIVED_TYPE, TARGET_GET_CURSOR_STATE_TYPE, clearCursorOverlayForLeases, clearCursorOverlayForTab, configurePixelInputTelemetry, dispatchKeyboardCombo, dispatchKeyboardPress, dispatchKeyboardType, dispatchMouseClick, dispatchMouseDrag, dispatchMouseMove, dispatchMouseWheel, hasPendingCursorArrivals, hideCursorOverlay, moveCursorOverlay, notifyCursorArrived, readCursorOverlayState, republishCursorOverlayStateForTab } from './background/pixelInput.js';
import { closeSidePanel, configureSidePanelTelemetry, getSidePanelStatus, openSidePanel, registerSidePanelStatus, requireSidePanelOpen, restoreSidePanelStatus, toggleSidePanel } from './background/sidePanelStatus.js';
import { listSiteCapabilities, runSiteResearch, SITE_RESEARCH_CONTRACT_VERSION } from './background/siteResearchRuntime.js';
import { TARGET_GET_CONTROL_BADGE_STATE_TYPE, initializeTabControlBadges, readTabControlBadgeState } from './background/tabControlBadge.js';
import { clearLeaseFaviconBadges, hasUnseenFinalizedBadges, initializeTabFaviconBadges, listFinalizedBadges, markFinalizedBadges } from './background/tabFaviconBadge.js';
import { configureManagedTabGroupTelemetry, ensureAgentTabGroup, getManagedGroupIdContainingTabs, initializeManagedTabGroups, listManagedTabGroups, reconcileManagedGroupForTabs, refreshManagedGroupsFromChrome, releaseTabsFromManagedGroups, setSessionGroupTitle } from './background/tabGroupManager.js';
import { createTabLifecycleRuntime } from './background/tabLifecycleRuntime.js';
import { claimTabForSession as claimTabLeaseForSession, finalizeTabs as finalizeTabLeases, getSessionActiveLeases, getSessionTabs as getStoredSessionTabs, groupFinalizedTabs as groupStoredFinalizedTabs, listTabLeaseSnapshot, listTabLeases as listStoredTabLeases, moveReplacedTabLease, releaseActiveTurnLeases, releaseSessionTabLeases, releaseTabsForSession, removeTabLease, resumeHandoffTabs, syncSessionActiveTabFromLease, updateActiveSessionTurn } from './background/tabLeaseManager.js';
import { getActiveTabInfo, getUserBrowserContext, listBrowserWindows, listReadingList, listRecentlyClosedSessions, listSessionDevices, listTopSites, listUserBookmarks, listUserTabs, searchUserHistory } from './background/userBrowserState.js';
import { fetchUrlContents } from './background/urlContentRuntime.js';
import { unsupportedBrowserCommandError } from './background/unsupportedCommandRuntime.js';
import { configureWebMcpTelemetry, invokeWebMcpTool, listWebMcpTools } from './background/webMcpRuntime.js';
import { closeSiteResearchItem, openSiteResearchItem } from './background/siteResearchNavigation.js';

const PLUGIN_ID = 'redbox-browser-control';
const API_CANDIDATES = [];
const SETTINGS_KEY = 'redboxBrowserControlSettings';
const SCRAPERS_KEY = 'redboxBrowserControlScrapers';
const POLL_ALARM = 'redbox-browser-control-poll';
const CONTENT_READ_TYPE = 'xwow-data-ai:read-frame';
const CONTENT_DOM_SNAPSHOT_TYPE = 'xwow-data-ai:dom-snapshot';
const CONTENT_SITE_RESEARCH_EXTRACT_TYPE = 'xwow-data-ai:site-research-extract';
const CONTENT_SITE_RESEARCH_APPLY_FILTERS_TYPE = 'xwow-data-ai:site-research-apply-filters';
const CONTENT_SITE_RESEARCH_SUBMIT_SEARCH_TYPE = 'xwow-data-ai:site-research-submit-search';
const CONTENT_SITE_RESEARCH_PREPARE_ITEM_CLICK_TYPE = 'xwow-data-ai:site-research-prepare-item-click';
const CONTENT_SITE_RESEARCH_PREPARE_ITEM_CLOSE_TYPE = 'xwow-data-ai:site-research-prepare-item-close';
const CONTENT_SCROLL_TYPE = 'xwow-data-ai:scroll-page';
const CONTENT_CLICK_NEXT_TYPE = 'xwow-data-ai:click-next';
const CONTENT_CLICK_ELEMENT_TYPE = 'xwow-data-ai:click-element';
const CONTENT_CLICK_NODE_TYPE = 'xwow-data-ai:click-node';
const CONTENT_HOVER_ELEMENT_TYPE = 'xwow-data-ai:hover-element';
const CONTENT_INSPECT_POINT_TYPE = 'xwow-data-ai:inspect-point';
const CONTENT_SCROLL_NODE_TYPE = 'xwow-data-ai:scroll-node';
const CONTENT_SELECT_ELEMENT_TYPE = 'xwow-data-ai:select-element';
const CONTENT_TYPE_ELEMENT_TYPE = 'xwow-data-ai:type-element';
const CONTENT_WAIT_STABLE_TYPE = 'xwow-data-ai:wait-stable';
const CONTENT_WAIT_SELECTOR_TYPE = 'xwow-data-ai:wait-selector';
const CONTENT_WAIT_NODE_TYPE = 'xwow-data-ai:wait-node';
const CONTENT_CHECK_ELEMENT_TYPE = 'xwow-data-ai:check-element';
const CONTENT_IS_CHECKED_TYPE = 'xwow-data-ai:is-checked';
const CONTENT_IS_VISIBLE_TYPE = 'xwow-data-ai:is-visible';
const CONTENT_GET_VALUE_TYPE = 'xwow-data-ai:get-value';
const CONTENT_GET_VALUES_TYPE = 'xwow-data-ai:get-values';
const CONTENT_GET_ATTRIBUTE_TYPE = 'xwow-data-ai:get-attribute';
const CONTENT_QUERY_ELEMENTS_TYPE = 'xwow-data-ai:query-elements';
const CONTROLLED_PAGE_MUTATION_ACTIONS = new Set(['page.navigate', 'page.goto', 'page.waitForLoadState', 'page.waitForURL', 'page.waitForTimeout', 'page.evaluate', 'page.evaluateScript', 'page.scroll', 'page.click', 'page.clickNode', 'node.click', 'page.hover', 'page.inspectPoint', 'page.hitTest', 'page.scrollNode', 'node.scroll', 'page.waitForNode', 'node.wait', 'page.waitForSelector', 'page.waitSelector', 'page.check', 'page.setChecked', 'page.isChecked', 'page.isVisible', 'page.getValue', 'page.getValues', 'page.getAttribute', 'page.queryElements', 'page.domSnapshot', 'page.export', 'tab.export', 'page.consoleLogs', 'tab_console_logs', 'tab.consoleLogs', 'page.select', 'page.type', 'page.frames', 'page.readClipboard', 'clipboard.read', 'page.readClipboardText', 'clipboard.readText', 'page.writeClipboard', 'clipboard.write', 'page.writeClipboardText', 'clipboard.writeText', 'page.waitForFileChooser', 'page.acceptFileChooser', 'page.setInputFiles', 'fileChooser.accept', 'webmcp.listTools', 'webmcp.invokeTool', 'webmcp_list_tools', 'webmcp_invoke_tool', 'input.mouseDrag', 'input.mouseWheel', 'input.keyboardType', 'input.keyboardPress', 'input.keyboardCombo']);
const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();

let cachedBaseUrl = null;
let activeRun = null;
let activeBrowserSession = null;
let initializePromise = null;
let nativeStatus = getNativeStatus();
let lastClientHeartbeatState = null;
const activeTabObserver = createActiveTabObserver({
  onChanged: handleObservedActiveTabsChanged,
});
const browserControlRuntime = createBrowserControlRuntime({
  observedTabs: activeTabObserver,
  readCursorOverlayState,
  republishCursorOverlayStateForTab,
  clearCursorOverlayForTab,
  onActivityChange: () => {
    if (!browserControlRuntime.isBrowserControlActive()) void maybeReloadForPendingUpdate().catch(() => {});
  },
});
const browserEventBridge = createBrowserEventBridge({
  pluginId: PLUGIN_ID,
  sendNativeNotification,
  getActiveSession: () => activeBrowserSession,
});
const tabLifecycleRuntime = createTabLifecycleRuntime({
  publishEvent: (event) => browserEventBridge.publishTabLifecycleEvent(event),
});
configureManagedTabGroupTelemetry((event) => browserEventBridge.publishManagedTabGroupEvent(event));
configureDynamicContentInjectionTelemetry((event) => browserEventBridge.publishContentInjectionEvent(event));
configureSidePanelTelemetry((event) => browserEventBridge.publishSidePanelEvent(event));
configureBrowserVisibilityTelemetry((event) => browserEventBridge.publishBrowserVisibilityEvent(event));
configureWebMcpTelemetry((event) => browserEventBridge.publishWebMcpEvent(event));
configureCdpTransportTelemetry((event) => browserEventBridge.publishCdpCommandEvent(event));
configurePixelInputTelemetry((event) => browserEventBridge.publishPixelInputEvent(event));
configureFileChooserTelemetry((event) => browserEventBridge.publishFileChooserEvent(event));
subscribeBrowserSessionEvents((event) => browserEventBridge.publishSessionEvent(event));
addDownloadChangeListener((event) => {
  void browserEventBridge.sendDownloadChange(event).catch(() => {});
});
const nativeMethodRouter = createNativeMethodRouter({
  ping: () => ({ ok: true, now: new Date().toISOString(), status: nativeStatus }),
  getInfo: async () => await getBrowserControlInfo(),
  listTools: () => listBrowserControlMcpTools(),
  executeCommand: (command) => executeCommand(command),
  runBrowserAction: async (action, sessionId = '') => runBrowserAction(action, {
    session: await resolveBrowserActionSession(sessionId || '', 'native_host'),
  }),
  onRoute: (event) => browserEventBridge.publishCommandRouterEvent(event),
});

const BROWSER_CONTROL_MCP_TOOLS = [
  {
    name: 'browser.capabilities',
    description: 'Return browser-control capabilities, policy metadata, and supported action contracts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'browser.info',
    description: 'Return browser-control backend, session, policy, and capability metadata.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'research.run',
    description: 'Execute one typed read-only site-research action. Desktop owns multi-step navigation, scrolling, item open/restore, retry, and cleanup orchestration. Xiaohongshu/Douyin items use originating-page UI clicks with no direct-URL fallback; macro mode remains for backward compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: ['xiaohongshu', 'xhs', 'douyin', 'youtube', 'web'] },
        operation: { type: 'string', enum: ['search', 'author_scan', 'content_scan'] },
        query: { type: 'string' },
        url: { type: 'string' },
        tabId: { type: 'number' },
        filters: {
          type: 'object',
          properties: {
            sort: { type: 'string', enum: ['relevance', 'latest', 'most_liked'] },
            contentType: { type: 'string', enum: ['all', 'image_text', 'video'] },
            publishTime: { type: 'string', enum: ['all', 'day', 'week', 'half_year'] },
          },
          additionalProperties: false,
        },
        limit: { type: 'number', minimum: 1, maximum: 100 },
        commentLimit: { type: 'number', minimum: 0, maximum: 100 },
        depth: { type: 'string', enum: ['preview', 'standard', 'deep'] },
        executionMode: { type: 'string', enum: ['macro', 'submit_search', 'extract', 'apply_filters', 'open_item', 'close_item', 'download_media'] },
        item: { type: 'object', additionalProperties: true },
        openState: { type: 'object', additionalProperties: true },
        media: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: true } },
        maxScrolls: { type: 'number', minimum: 0, maximum: 8 },
        downloadMedia: { type: 'boolean' },
        ocr: { type: 'boolean' },
        transcribeAudio: { type: 'boolean' },
        snapshot: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      required: ['operation'],
      additionalProperties: true,
    },
  },
  {
    name: 'browser.context',
    description: 'Return readonly user browser context such as open tabs, windows, and history summaries.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: true },
  },
  {
    name: 'browser.events',
    description: 'Replay browser-control runtime events.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, afterEventId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'browser.events.summary',
    description: 'Summarize browser-control runtime events.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'browser.sessionEvents',
    description: 'Replay browser-control session lifecycle events.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: true },
  },
  {
    name: 'browser.visibility.get',
    description: 'Return browser window visibility state.',
    inputSchema: { type: 'object', properties: { windowId: { type: 'number' } }, additionalProperties: true },
  },
  {
    name: 'browser.visibility.set',
    description: 'Set browser window visibility state.',
    inputSchema: { type: 'object', properties: { windowId: { type: 'number' }, state: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'windows.list',
    description: 'List browser windows with bounded metadata.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: true },
  },
  {
    name: 'history.search',
    description: 'Search recent browser history metadata.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: true },
  },
  {
    name: 'tabs.list',
    description: 'List current user browser tabs with bounded tab metadata.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: true },
  },
  {
    name: 'tab.info',
    description: 'Read metadata for a tab or the current active tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, activeOnly: { type: 'boolean' }, sessionId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'tabs.finalize',
    description: 'Finalize browser-control tabs, closing or handing off tabs according to keep entries.',
    inputSchema: { type: 'object', properties: { keep: { type: 'array', items: { type: 'object' } }, sessionId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'session.name',
    description: 'Name the current browser-control session.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sessionId: { type: 'string' } }, required: ['name'], additionalProperties: true },
  },
  {
    name: 'turn.ended',
    description: 'Mark the current browser-control turn ended.',
    inputSchema: { type: 'object', properties: { turnId: { type: 'string' }, sessionId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'tab.claim',
    description: 'Claim an existing user tab for an AI browser-control session.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'tab.create',
    description: 'Create a controlled browser tab.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' }, sessionId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'tab.navigate',
    description: 'Navigate an existing tab to an http or https URL.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, url: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'url'], additionalProperties: true },
  },
  {
    name: 'tab.back',
    description: 'Navigate a controlled tab back in history.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, waitUntil: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'tab.forward',
    description: 'Navigate a controlled tab forward in history.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, waitUntil: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'tab.reload',
    description: 'Reload a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'tab.close',
    description: 'Close a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.frames',
    description: 'List frames in a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.waitForLoadState',
    description: 'Wait for a controlled tab to reach a load state.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, state: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.waitForURL',
    description: 'Wait for a controlled tab URL to match a target, wildcard, or regex.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, url: { type: 'string' }, urlRegex: { type: 'string' }, exact: { type: 'boolean' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.waitForTimeout',
    description: 'Wait for a fixed duration in a controlled tab context.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, timeoutMs: { type: 'number' }, ms: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.evaluate',
    description: 'Evaluate JavaScript in a controlled tab through CDP; browser policy treats this as state-changing unless approved.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, script: { type: 'string' }, expression: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.domSnapshot',
    description: 'Read a bounded DOM snapshot for a tab or frame.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, frameId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.waitForSelector',
    description: 'Wait for a selector to appear in a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.queryElements',
    description: 'Query visible page elements by selector and return structured element summaries.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.click',
    description: 'Click a page element by selector, text, or node reference inside a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.doubleClick',
    description: 'Double-click a page element by selector or text.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.hover',
    description: 'Hover a page element by selector or text.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'node.click',
    description: 'Click a page node by DOM snapshot node reference.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, nodeId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.scroll',
    description: 'Scroll a controlled tab or frame.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, direction: { type: 'string' }, pixels: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'node.scroll',
    description: 'Scroll a DOM snapshot node.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, nodeId: { type: 'string' }, deltaY: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.type',
    description: 'Type text into a page element.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector', 'text'], additionalProperties: true },
  },
  {
    name: 'page.check',
    description: 'Check a checkbox or switch-like page element.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.setChecked',
    description: 'Set a checkbox or switch-like page element state.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, checked: { type: 'boolean' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.isChecked',
    description: 'Return whether a checkbox or switch-like element is checked.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.isVisible',
    description: 'Return whether a page element is visible.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.getValue',
    description: 'Read the value of a page form element.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.getValues',
    description: 'Read values from matching page form elements.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.getAttribute',
    description: 'Read an attribute from a page element.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, attribute: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.select',
    description: 'Select one or more options in a native select element.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, selector: { type: 'string' }, value: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'selector'], additionalProperties: true },
  },
  {
    name: 'page.consoleLogs',
    description: 'Read console logs captured for a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.assets',
    description: 'List images, videos, documents, favicons, and linked assets found on a page.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'page.screenshot',
    description: 'Capture a visible-tab screenshot as a data URL.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, format: { type: 'string' }, quality: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'clipboard.read',
    description: 'Read browser clipboard items for a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'clipboard.readText',
    description: 'Read browser clipboard text for a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'clipboard.write',
    description: 'Write browser clipboard items for a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, items: { type: 'array' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'clipboard.writeText',
    description: 'Write browser clipboard text for a controlled tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, text: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'text'], additionalProperties: true },
  },
  {
    name: 'input.mouseMove',
    description: 'Move the browser mouse cursor overlay.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId', 'x', 'y'], additionalProperties: true },
  },
  {
    name: 'input.mouseClick',
    description: 'Click browser viewport coordinates.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'x', 'y'], additionalProperties: true },
  },
  {
    name: 'input.mouseDrag',
    description: 'Drag between browser viewport coordinates.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, from: { type: 'object' }, to: { type: 'object' }, path: { type: 'array' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'input.mouseWheel',
    description: 'Scroll by browser viewport wheel deltas.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, sessionId: { type: 'string' } }, required: ['tabId'], additionalProperties: true },
  },
  {
    name: 'input.keyboardType',
    description: 'Type text through browser keyboard input.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, text: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'text'], additionalProperties: true },
  },
  {
    name: 'input.keyboardPress',
    description: 'Press a browser keyboard key.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, key: { type: 'string' }, sessionId: { type: 'string' } }, required: ['tabId', 'key'], additionalProperties: true },
  },
  {
    name: 'input.keyboardCombo',
    description: 'Press a browser keyboard shortcut.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, keys: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' } }, required: ['tabId', 'keys'], additionalProperties: true },
  },
  {
    name: 'viewport.state',
    description: 'Read browser viewport state.',
    inputSchema: { type: 'object', properties: { windowId: { type: 'number' }, sessionId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'viewport.set',
    description: 'Set browser viewport dimensions.',
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, windowId: { type: 'number' }, sessionId: { type: 'string' } }, required: ['width', 'height'], additionalProperties: true },
  },
  {
    name: 'viewport.reset',
    description: 'Reset browser viewport state.',
    inputSchema: { type: 'object', properties: { windowId: { type: 'number' }, sessionId: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'cdp.send',
    description: 'Send a Chrome DevTools Protocol command to an attached tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, method: { type: 'string' }, params: { type: 'object' }, sessionId: { type: 'string' } }, required: ['tabId', 'method'], additionalProperties: true },
  },
];

function listBrowserControlMcpTools() {
  return {
    ok: true,
    success: true,
    protocol: 'mcp-jsonrpc-browser-control',
    tools: BROWSER_CONTROL_MCP_TOOLS,
  };
}
const localCommandActionRouter = createLocalCommandActionRouter({
  onRoute: (event) => browserEventBridge.publishCommandRouterEvent(event),
  getNativeStatus: () => {
    const status = refreshNativeStatus();
    return { success: status.state === 'connected', status };
  },
  connectNativeTransport,
  disconnectNativeTransport,
  requestNativeCommand: async (payload) => {
    if (payload.method === 'ensureCodexAppServer' || payload.method === 'ensure_xwow_app_server' || payload.method === 'ensure_codex_app_server') {
      return await ensureAppServerWithSidePanelGate({ method: payload.method, params: payload.params || {}, timeoutMs: payload.timeoutMs, windowId: payload.windowId });
    }
    return await requestNativeHost(payload.method || 'ping', payload.params || {}, payload.timeoutMs);
  },
  runBrowserAction: async (action, session) => runBrowserAction(action, { session }),
  openUrl,
  captureActiveTab,
  captureUrl,
  captureTabById,
  scrollActiveTab,
  scrollTabById,
  scrollUrl,
  clickActiveTab,
  clickTabById,
  clickUrl,
  typeActiveTab,
  typeTabById,
  typeUrl,
  screenshotActiveTab,
  screenshotTabById,
  screenshotUrl,
  waitActiveTab,
  waitTabById,
  waitUrl,
  waitForDownload,
  setViewport: (options) => setBrowserViewport({ ...(options || {}), activeTabId: activeBrowserSession?.activeTabId }),
  resetViewport: (options) => resetBrowserViewport({ ...(options || {}), activeTabId: activeBrowserSession?.activeTabId }),
});
let lastStatus = {
  connected: false,
  baseUrl: '',
  lastError: 'Not connected',
  lastCaptureId: '',
  lastCommandId: '',
  activeRun: null,
  browserControl: null,
};

chrome.runtime.onInstalled.addListener(() => {
  void ensureLifecycleInstallState().then(() => ensureInitialized()).catch(() => ensureInitialized());
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInitialized();
});

configureLifecycleGuard({
  isBrowserControlActive,
  heartbeatProbe: () => nativeStatus.state !== 'connected' || requestNativeHost('ping', {}, 3000).then(() => true, () => false),
  onHeartbeatFailure: stopBrowserControlAfterHeartbeatFailure,
});

configureNativeTransport({
  onMessage: handleNativeMessage,
  onStatusChange: (status) => {
    nativeStatus = status;
  },
  onTelemetry: (event) => browserEventBridge.publishNativeTransportEvent(event),
  getRegistration: async () => {
    const lifecycle = await ensureLifecycleInstallState();
    return {
      extensionId: chrome.runtime.id,
      extensionInstanceId: lifecycle.extensionInstanceId,
      version: chrome.runtime.getManifest().version,
      browser: detectBrowserFamily(),
    };
  },
});

function detectBrowserFamily() {
  const userAgent = String(globalThis.navigator?.userAgent || '');
  if (/Edg\//i.test(userAgent)) return 'edge';
  if (/Brave\//i.test(userAgent) || globalThis.navigator?.brave) return 'brave';
  if (/Chromium\//i.test(userAgent)) return 'chromium';
  if (/Chrome\//i.test(userAgent)) return 'chrome';
  return 'unknown';
}

registerLifecycleUpdateListener();
registerSidePanelStatus();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === NATIVE_RECONNECT_ALARM) {
    void connectNativeTransport({ silent: true }).catch(() => {});
  }
  if (alarm?.name === CLIENT_HEARTBEAT_ALARM || alarm?.name === TARGET_CLIENT_HEARTBEAT_ALARM) {
    void handleLifecycleAlarm(alarm).catch(() => {});
  }
});

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isBrowserControlRuntimeMessage(message)) return false;
  void (async () => {
    const result = await handleMessage(message || {}, sender);
    sendResponse(result);
  })().catch((error) => {
    sendResponse({ success: false, error: describeError(error) });
  });
  return true;
});

function isBrowserControlRuntimeMessage(message = {}) {
  const type = String(message?.type || '');
  if (type.startsWith('xwow-data-ai:') || type.startsWith('redbox-browser-control:')) return true;
  if (type === 'browser.action' || type === 'GET_NATIVE_HOST_STATUS') return true;
  if (type === TARGET_GET_CURSOR_STATE_TYPE || type === TARGET_CURSOR_ARRIVED_TYPE) return true;
  if (type === TARGET_GET_CONTROL_BADGE_STATE_TYPE) return true;
  const method = String(message?.method || '');
  return method === 'ensureCodexAppServer' || method === 'ensure_codex_app_server';
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    void handleCdpEvent(source, method, params).catch(() => {});
  });
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    handleDebuggerDetach(source);
    void browserEventBridge.publishCdpLifecycleEvent({
      kind: 'debugger.detached',
      source: normalizeDebuggerSource(source),
      reason: reason || '',
    }).catch(() => {});
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void cleanupTabState(tabId, 'removed').catch(() => {});
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  if (Number.isInteger(Number(addedTabId))) {
    void reconcileReplacedTab(Number(addedTabId), Number(removedTabId))
      .then(() => cleanupTabState(removedTabId, 'replaced'))
      .catch(() => {});
  }
});

chrome.tabs.onAttached?.addListener(() => {
  void refreshManagedGroupsFromChrome().catch(() => {});
});

chrome.tabs.onDetached?.addListener(() => {
  void refreshManagedGroupsFromChrome().catch(() => {});
});

if (chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener((download) => {
    void handleDownloadCreated(download, { browserControlActive: isBrowserControlActive() }).catch(() => {});
  });
  chrome.downloads.onChanged.addListener((delta) => {
    void handleDownloadChanged(delta, { browserControlActive: isBrowserControlActive() }).catch(() => {});
  });
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && changes?.[SETTINGS_KEY]) {
    cachedBaseUrl = null;
  }
});

async function handleMessage(message, sender = {}) {
  switch (message.type) {
    case CONTENT_CURSOR_ARRIVED_TYPE:
    case TARGET_CURSOR_ARRIVED_TYPE:
      notifyCursorArrived(message);
      return { success: true };
    case 'xwow-data-ai:file-chooser-opened':
      return { success: true, fileChooser: handleFileChooserDomEvent(message, sender) };
    case TARGET_GET_CURSOR_STATE_TYPE: {
      const tabId = Number(message.tabId || sender?.tab?.id || activeBrowserSession?.activeTabId || 0);
      return { ok: true, success: true, state: browserControlRuntime.readCursorState(tabId) };
    }
    case TARGET_GET_CONTROL_BADGE_STATE_TYPE: {
      const tabId = Number(message.tabId || sender?.tab?.id || activeBrowserSession?.activeTabId || 0);
      return { ok: true, success: true, state: await readTabControlBadgeState(tabId) };
    }
    case 'xwow-data-ai:get-status':
      return { success: true, status: { ...lastStatus, nativeHost: nativeStatus } };
    case 'xwow-data-ai:get-active-tab':
      return { success: true, tab: await getActiveTabInfo() };
    case 'xwow-data-ai:register':
      await registerPlugin(true);
      return { success: true, status: lastStatus };
    case 'xwow-data-ai:analyze-active-tab':
      return await analyzeActiveTab(message.options || {});
    case 'xwow-data-ai:suggest-columns':
      return await suggestColumns(message.capture || null, message.options || {});
    case 'xwow-data-ai:preview-active-tab':
      return await previewActiveTab(message.scraper || {}, message.options || {});
    case 'xwow-data-ai:run-scraper':
      return await runScraper(message.scraper || {});
    case 'xwow-data-ai:stop-run':
      if (activeRun) activeRun.cancelled = true;
      setStatus({ activeRun });
      return { success: true, activeRun };
    case 'xwow-data-ai:create-browser-session':
      return await createBrowserSession(message.owner || 'manual_repair', message.metadata || {});
      case 'xwow-data-ai:list-browser-sessions':
      return { success: true, sessions: await listBrowserSessions(), tabLeases: await listTabLeases() };
    case 'xwow-data-ai:end-browser-session':
      return await endBrowserSession(message.sessionId || '', { releaseTabs: message.releaseTabs !== false });
    case 'xwow-data-ai:run-browser-action':
      return await runBrowserAction(message.action || {}, {
        session: await resolveBrowserActionSession(message.sessionId || '', message.owner || 'manual_repair'),
      });
    case 'xwow-data-ai:native-status':
    case 'GET_NATIVE_HOST_STATUS':
      {
        const status = refreshNativeStatus();
        return { success: status.state === 'connected', status };
      }
    case 'xwow-data-ai:native-connect':
      return { success: true, status: await connectNativeTransport({ force: true, hostName: message.hostName }) };
    case 'xwow-data-ai:native-disconnect':
      await disconnectNativeTransport('manual_disconnect');
      return { success: true, status: nativeStatus };
    case 'xwow-data-ai:native-request':
      return await requestNativeHost(message.method || 'ping', message.params || {}, message.timeoutMs);
    case 'ensure_xwow_app_server':
    case 'ensure_codex_app_server':
    case 'ensureCodexAppServer':
      return await ensureAppServerWithSidePanelGate(message);
    case 'xwow-data-ai:side-panel-status':
      return getSidePanelStatus(message.windowId);
    case 'xwow-data-ai:side-panel-open':
      return await openSidePanel(message.windowId);
    case 'xwow-data-ai:side-panel-close':
      return await closeSidePanel(message.windowId);
    case 'xwow-data-ai:side-panel-toggle':
      return await toggleSidePanel(message.windowId);
    case 'xwow-data-ai:save-scraper':
      return await saveScraper(message.scraper || {});
    case 'xwow-data-ai:list-scrapers':
      return { success: true, scrapers: await listScrapers() };
    case 'xwow-data-ai:list-captures':
      return await listCaptures(message.options || {});
    case 'xwow-data-ai:list-commands':
      return await listCommands(message.options || {});
    case 'xwow-data-ai:poll-command':
      return await pollCommandOnce();
    case 'xwow-data-ai:capture-active-tab':
      return await captureActiveTab({ store: true, aiInstruction: message.aiInstruction || '', options: message.options || {} });
    case 'xwow-data-ai:ingest-manual-capture':
      return await ingestManualCapture(message.capture || {});
    default:
      return { success: false, error: 'Unknown message type' };
  }
}

async function initialize() {
  await startClientHeartbeat();
  await restoreSidePanelStatus();
  await restoreNativeStatus();
  await connectNativeTransport({ silent: true }).catch(() => {});
  lastClientHeartbeatState = await getBrowserClientHeartbeatState().catch(() => null);
  await restorePendingUpdate();
  await activeTabObserver.initialize().catch(() => {});
  tabLifecycleRuntime.initialize();
  await initializeManagedTabGroups().catch(() => {});
  initializeTabFaviconBadges();
  initializeTabControlBadges();
  await reconcileInterruptedBrowserRuntime().catch((error) => {
    console.warn('[XWOW BrowserDataAI] interrupted browser runtime reconciliation failed', error);
  });
  setStatus({
    connected: nativeStatus.state === 'connected',
    lastError: nativeStatus.error || '',
  });
}

async function reconcileInterruptedBrowserRuntime() {
  const reconciled = await reconcileInterruptedBrowserRequests('extension_runtime_resumed');
  const cleanupResults = [];
  for (const session of reconciled.reconciledSessions || []) {
    const cleanupResult = await endActiveTurn(session, session.interruptedTurnId || session.lastTurnId || session.turnId).catch((error) => ({
      success: false,
      browserError: {
        code: 'BROWSER_CLEANUP_INCOMPLETE',
        message: describeErrorMessage(error),
        retryable: true,
        userActionRequired: false,
      },
    }));
    cleanupResults.push({ sessionId: session.sessionId, turnId: session.interruptedTurnId || '', result: cleanupResult });
  }
  if (cleanupResults.length) {
    const cleanup = await recordLifecycleCleanupResult({
      reason: 'extension_runtime_resumed',
      interruptedRequests: reconciled.interruptedRequests || [],
      cleanupResults,
    });
    await browserEventBridge.publishLifecycleEvent('interrupted_runtime_reconciled', {
      interruptedRequests: reconciled.interruptedRequests || [],
      cleanupResults,
      cleanupResult: cleanup.cleanupResult || null,
    }).catch(() => {});
  }
  return { ...reconciled, cleanupResults };
}

function ensureInitialized() {
  if (!initializePromise) {
    initializePromise = initialize().catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

void ensureInitialized().catch((error) => {
  setStatus({
    connected: false,
    lastError: describeError(error),
  });
});

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    apiBaseUrl: '',
    autoPoll: false,
    ...(result?.[SETTINGS_KEY] || {}),
  };
}

async function resolveApiBase(force = false) {
  if (cachedBaseUrl && !force) return cachedBaseUrl;
  const settings = await getSettings();
  const candidates = [settings.apiBaseUrl, ...API_CANDIDATES].filter(Boolean);
  let lastError = '';
  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      if (!response.ok) {
        lastError = `${baseUrl} ${response.status}`;
        continue;
      }
      cachedBaseUrl = baseUrl.replace(/\/+$/, '');
      setStatus({ connected: true, baseUrl: cachedBaseUrl, lastError: '' });
      return cachedBaseUrl;
    } catch (error) {
      lastError = describeError(error);
    }
  }
  cachedBaseUrl = null;
  throw new Error(lastError || 'Beav browser-control HTTP bridge is not configured');
}

async function registerPlugin(force) {
  const baseUrl = await resolveApiBase(force);
  const manifest = chrome.runtime.getManifest();
  const settings = await getSettings();
  const result = await postJson(`${baseUrl}/plugins/register`, buildPluginRegistrationPayload({
    pluginId: PLUGIN_ID,
    manifest,
    nativeHostName: settings.nativeHostName || NATIVE_HOST_DEFAULT,
    nativeStatus,
  }));
  setStatus({ connected: true, baseUrl, lastError: '' });
  return result;
}

async function connectNativeTransport(options = {}) {
  const settings = await getSettings();
  return await connectNativeTransportRaw({
    ...options,
    hostName: options.hostName || settings.nativeHostName || NATIVE_HOST_DEFAULT,
  });
}

async function requestNativeHost(method, params = {}, timeoutMs = 12_000) {
  return await requestNativeHostRaw(method, params, timeoutMs);
}

async function ensureAppServerWithSidePanelGate(message = {}) {
  const method = message.method || message.type || 'ensureCodexAppServer';
  const isTargetCodexAlias = method === 'ensure_codex_app_server';
  try {
    const sidePanel = await requireSidePanelOpen(message.windowId || message.params?.windowId, {
      closedError: isTargetCodexAlias ? 'Codex side panel is not open.' : 'Beav side panel is not open.',
    });
    const result = await requestNativeHost('ensureCodexAppServer', message.params || {}, message.timeoutMs);
    const status = refreshNativeStatus();
    await browserEventBridge.publishSidePanelEvent({
      kind: 'app_server_bootstrap.allowed',
      method,
      sidePanelOpen: true,
      sidePanel,
      nativeHostStatus: status,
      resultOk: result?.ok === true || result?.success === true,
    }).catch(() => {});
    if (isTargetCodexAlias) {
      return { ok: true, nativeHostStatus: status, sidePanelOpen: true, ...(result || {}) };
    }
    return { ok: true, success: true, nativeHostStatus: status, sidePanelOpen: true, sidePanel, result };
  } catch (error) {
    const status = refreshNativeStatus();
    const sidePanel = error?.status || getSidePanelStatus(message.windowId || message.params?.windowId);
    await browserEventBridge.publishSidePanelEvent({
      kind: 'app_server_bootstrap.denied',
      method,
      code: error?.code || 'ensure_app_server_failed',
      error: describeError(error).slice(0, 500),
      sidePanelOpen: sidePanel.sidePanelOpen === true,
      sidePanel,
      nativeHostStatus: status,
    }).catch(() => {});
    if (isTargetCodexAlias) {
      return {
        ok: false,
        error: describeErrorMessage(error),
        nativeHostStatus: status,
        sidePanelOpen: sidePanel.sidePanelOpen === true,
      };
    }
    return {
      ok: false,
      success: false,
      error: describeError(error),
      code: error?.code || 'ensure_app_server_failed',
      status,
      nativeHostStatus: status,
      sidePanelOpen: sidePanel.sidePanelOpen === true,
      sidePanel,
    };
  }
}

async function handleNativeMessage(message) {
  if (message?.jsonrpc === '2.0' && message.method) {
    await handleNativeRequest(message);
    return;
  }
  if (message?.type === 'browser.action') {
    const result = await runBrowserAction(message.action || {}, { session: await resolveBrowserActionSession(message.sessionId || '', 'native_host') });
    await sendNativeNotification('browser.action.result', result);
  }
}

async function handleNativeRequest(message) {
  let result;
  try {
    result = await nativeMethodRouter.route(message.method, message.params || {});
    postNativeMessage({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    postNativeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: commandRouterErrorEnvelope(error),
    });
  }
}

async function pollCommandOnce() {
  const settings = await getSettings();
  if (!settings.autoPoll) return { success: true, skipped: true };
  const baseUrl = await resolveApiBase(true);
  const url = `${baseUrl}/commands/next?pluginId=${encodeURIComponent(PLUGIN_ID)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`;
  const result = await getJson(url).catch((error) => {
    if (String(describeError(error)).includes('404')) return { command: null };
    throw error;
  });
  if (!result?.command) return { success: true, command: null };
  const command = result.command;
  setStatus({ lastCommandId: command.id });
  try {
    const commandResult = await executeCommand(command);
    if (commandResult?.success === false) {
      throw new Error(commandResult.error || commandResult.result?.error || `${command.action} failed`);
    }
    await postJson(`${baseUrl}/commands/complete`, {
      commandId: command.id,
      success: true,
      result: commandResult,
    });
    return { success: true, command: command.id, result: commandResult };
  } catch (error) {
    await postJson(`${baseUrl}/commands/complete`, {
      commandId: command.id,
      success: false,
      error: describeError(error),
    }).catch(() => {});
    throw error;
  }
}

async function executeCommand(command) {
  const payload = normalizeCommandPayloadProtocolFields(command.payload || {});
  const previousSession = activeBrowserSession;
  const explicitSessionId = extractCommandSessionId(command, payload);
  const explicitTurnId = extractCommandTurnId(command, payload);
  const session = explicitSessionId
    ? await ensureBrowserSession(explicitSessionId, 'app_command', { commandId: command.id, action: command.action, source: 'native_or_http_command' }, { turnId: explicitTurnId, reason: 'app_command' })
    : await createBrowserSession('app_command', { commandId: command.id, action: command.action });
  activeBrowserSession = session.session;
  setStatus({ browserControl: activeBrowserSession });
  try {
    return await localCommandActionRouter.route(command.action, { command, payload, session: activeBrowserSession });
  } finally {
    if (!explicitSessionId) {
      await endBrowserSession(activeBrowserSession.sessionId, { releaseTabs: true }).catch(() => {});
    }
    activeBrowserSession = previousSession;
    setStatus({ browserControl: activeBrowserSession });
  }
}

function extractCommandSessionId(command = {}, payload = {}) {
  return firstString(
    payload.sessionId,
    payload.session_id,
    payload.browserSessionId,
    payload.browser_session_id,
    command.sessionId,
    command.session_id,
    command.browserSessionId,
    command.browser_session_id,
  );
}

function extractCommandTurnId(command = {}, payload = {}) {
  return firstString(
    payload.turnId,
    payload.turn_id,
    payload.browserTurnId,
    payload.browser_turn_id,
    command.turnId,
    command.turn_id,
    command.browserTurnId,
    command.browser_turn_id,
  );
}

function normalizeCommandPayloadProtocolFields(payload = {}) {
  const normalized = { ...(payload || {}) };
  const sessionId = extractCommandSessionId({}, normalized);
  const turnId = extractCommandTurnId({}, normalized);
  if (sessionId) normalized.sessionId = sessionId;
  if (turnId) normalized.turnId = turnId;
  return normalized;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function analyzeActiveTab(options = {}) {
  const result = await captureActiveTab({ store: false, options });
  if (!result.success) return result;
  const capture = result.capture;
  return {
    success: true,
    capture,
    pageState: summarizeCapture(capture),
    suggestedColumns: buildSuggestedColumns(capture),
  };
}

async function suggestColumns(capture, options = {}) {
  let sourceCapture = capture;
  if (!sourceCapture) {
    const analyzed = await analyzeActiveTab(options);
    if (!analyzed.success) return analyzed;
    sourceCapture = analyzed.capture;
  }
  const columns = buildSuggestedColumns(sourceCapture);
  return { success: true, columns, source: sourceCapture.extractedData?.adapter ? 'adapter+heuristic' : 'heuristic' };
}

async function previewActiveTab(scraper = {}, options = {}) {
  const captureResult = await captureActiveTab({
    store: false,
    options: buildCaptureOptions(scraper, options),
  });
  if (!captureResult.success) return captureResult;
  const rows = buildPreviewRows(captureResult.capture, scraper.columns || []);
  return {
    success: true,
    capture: captureResult.capture,
    rows,
    columns: normalizeColumns(scraper.columns || buildSuggestedColumns(captureResult.capture)),
  };
}

async function runScraper(scraper = {}) {
  if (activeRun && activeRun.status === 'running') {
    return { success: false, error: 'A scraper run is already active' };
  }
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRun = {
    id: runId,
    status: 'running',
    mode: scraper.mode || 'NO_PAGINATION',
    total: Number(scraper.maxPages || 1),
    finished: 0,
    captures: [],
    cancelled: false,
  };
  setStatus({ activeRun });
  try {
    const result = scraper.bulkUrls?.length
      ? await runBulkUrls(scraper)
      : await runCurrentTabScraper(scraper);
    activeRun.status = 'completed';
    activeRun.result = result;
    setStatus({ activeRun });
    return { success: true, run: activeRun, result };
  } catch (error) {
    activeRun.status = 'failed';
    activeRun.error = describeError(error);
    setStatus({ activeRun });
    return { success: false, error: activeRun.error, run: activeRun };
  }
}

async function runCurrentTabScraper(scraper) {
  const mode = scraper.mode || 'NO_PAGINATION';
  const maxPages = clamp(Number(scraper.maxPages || 1), 1, 50);
  const captures = [];
  for (let index = 0; index < maxPages; index += 1) {
    if (activeRun?.cancelled) break;
    const options = buildCaptureOptions(scraper, {});
    if (mode === 'INFINITE_SCROLL') {
      options.scroll = { maxSteps: Number(scraper.scrollSteps || 5), delayMs: 500 };
    }
    const result = await captureActiveTab({
      store: true,
      options,
      aiInstruction: scraper.aiInstruction || '',
      schema: columnsToSchema(scraper.columns || []),
    });
    captures.push(result.captureId || result.capture?.captureId);
    activeRun.finished = index + 1;
    activeRun.captures = captures.filter(Boolean);
    setStatus({ activeRun });
    if (mode !== 'PAGINATION') break;
    const tab = await getActiveTabInfo();
    if (!tab?.id) break;
    const click = await sendContentMessage(tab.id, CONTENT_CLICK_NEXT_TYPE, { selector: scraper.nextButtonSelector || '' }, 0);
    if (!click?.success) break;
    await waitForTabIdle(tab.id, 4000);
  }
  return { captures: captures.filter(Boolean), mode };
}

async function runBulkUrls(scraper) {
  const captures = [];
  const urls = scraper.bulkUrls.filter(isHttpUrl).slice(0, clamp(Number(scraper.maxPages || 20), 1, 200));
  activeRun.total = urls.length;
  for (const url of urls) {
    if (activeRun?.cancelled) break;
    const result = await captureUrl(url, {
      store: true,
      options: buildCaptureOptions(scraper, {}),
      aiInstruction: scraper.aiInstruction || '',
      schema: columnsToSchema(scraper.columns || []),
    });
    captures.push(result.captureId);
    activeRun.finished += 1;
    activeRun.captures = captures.filter(Boolean);
    setStatus({ activeRun });
  }
  return { captures: captures.filter(Boolean), mode: 'BULK_URLS' };
}

async function captureActiveTab(options = {}) {
  const tab = await getActiveTabInfo();
  if (!tab?.id) throw new Error('No active tab');
  await claimTabForActiveSession(tab.id, 'user', 'source');
  return await captureTabById(tab.id, options);
}

async function captureUrl(url, options = {}) {
  if (!isHttpUrl(url)) throw new Error('capture.url requires an http(s) URL');
  const opened = await openUrl(url, {
    active: options.active === true,
    waitUntilComplete: true,
  });
  try {
    return await captureTabById(opened.tab.id, options);
  } finally {
    if (options.keepOpen !== true) {
      await chrome.tabs.remove(opened.tab.id).catch(() => {});
    }
  }
}

async function openUrl(url, options = {}) {
  if (!isHttpUrl(url)) throw new Error('open.url requires an http(s) URL');
  assertBrowserActionAllowed({
    type: 'tab.navigate',
    url,
    actionClass: BROWSER_ACTION_LEVELS.NAVIGATE,
  });
  const existingTabId = Number(options.tabId || 0) || null;
  const tab = existingTabId
    ? await chrome.tabs.update(existingTabId, { url, active: options.active !== false })
    : (await createControlledTab({ url, active: options.active !== false })).tab;
  if (tab?.id) await claimTabForActiveSession(tab.id, existingTabId ? 'user' : 'agent', 'source');
  if (options.waitUntilComplete !== false) {
    await waitForTabComplete(tab.id, Number(options.timeoutMs || 30_000));
  }
  return {
    success: true,
    tab: {
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url || url,
      title: tab.title || '',
      active: tab.active,
    },
  };
}

async function scrollActiveTab(options = {}) {
  const tab = await getActiveTabInfo();
  if (!tab?.id) throw new Error('No active tab');
  return await scrollTabById(tab.id, options);
}

async function scrollTabById(tabId, options = {}) {
  return await runBrowserAction({
    type: 'page.scroll',
    tabId: Number(tabId),
    direction: options.direction || 'down',
    amount: options.pixels,
    options,
    actionClass: BROWSER_ACTION_LEVELS.NAVIGATE,
  });
}

async function scrollUrl(url, options = {}) {
  const opened = await openUrl(url, { active: options.active !== false, waitUntilComplete: true });
  return await scrollTabById(opened.tab.id, options);
}

async function clickActiveTab(options = {}) {
  const tab = await getActiveTabInfo();
  if (!tab?.id) throw new Error('No active tab');
  return await clickTabById(tab.id, options);
}

async function clickTabById(tabId, options = {}) {
  return await runBrowserAction({
    type: 'page.click',
    tabId: Number(tabId),
    selector: options.selector || '',
    text: options.text || options.label || '',
    textRegex: options.textRegex || '',
    options,
    actionClass: options.actionClass || BROWSER_ACTION_LEVELS.READ_ONLY_REVEAL,
  });
}

async function clickUrl(url, options = {}) {
  const opened = await openUrl(url, { active: options.active !== false, waitUntilComplete: true });
  return await clickTabById(opened.tab.id, options);
}

async function captureTabById(tabId, options = {}) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab?.id || !isHttpUrl(tab.url)) {
    throw new Error('Tab is not capturable');
  }
  await claimTabForActiveSession(tab.id, 'user', 'source');
  assertBrowserActionAllowed({
    type: 'page.read',
    tabId: tab.id,
    actionClass: BROWSER_ACTION_LEVELS.OBSERVE,
    currentUrl: tab.url || '',
  });
  if (options.options?.scroll) {
    await runBrowserAction({
      type: 'page.scroll',
      tabId: tab.id,
      options: options.options.scroll,
      actionClass: BROWSER_ACTION_LEVELS.NAVIGATE,
    });
  }
  const frames = await readAllFrames(tab.id, options.options || {});
  const mainFrame = frames.find((frame) => frame.frameId === 0) || frames[0] || {};
  const combinedText = frames.map((frame) => frame.websiteTextContent).filter(Boolean).join('\n\n');
  const combinedHtml = frames.map((frame) => frame.websiteMarkdownContent).filter(Boolean).join('\n\n');
  const capture = {
    captureKind: 'page',
    url: mainFrame.url || tab.url || '',
    title: mainFrame.title || tab.title || '',
    frameCount: frames.length,
    websiteTextContent: combinedText,
    websiteMarkdownContent: combinedHtml,
    extractedData: mergeExtractedData(frames),
    frames,
    metadata: {
      tabId: tab.id,
      windowId: tab.windowId,
      capturedAt: new Date().toISOString(),
      extensionId: chrome.runtime.id,
      captureOptions: options.options || {},
    },
  };
  if (options.store !== false) {
    const ingest = await sendCapture(capture, options.commandId || '');
    capture.captureId = ingest?.capture?.id || '';
    setStatus({ lastCaptureId: capture.captureId });
    if (options.aiInstruction && capture.captureId) {
      const baseUrl = await resolveApiBase(false);
      const ai = await postJson(`${baseUrl}/ai/extract`, {
        captureId: capture.captureId,
        instruction: options.aiInstruction,
        schema: options.schema || undefined,
      });
      return { success: true, captureId: capture.captureId, capture, ai };
    }
    return { success: true, captureId: capture.captureId, capture };
  }
  return { success: true, capture };
}

async function readAllFrames(tabId, options) {
  const navFrames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0 }]);
  await ensureContentScript(tabId, { allFrames: true });
  const frames = [];
  for (const frame of navFrames || [{ frameId: 0 }]) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: CONTENT_READ_TYPE, options }, { frameId: frame.frameId });
      if (response?.success && response.data) {
        frames.push({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          ...response.data,
        });
      }
    } catch (error) {
      frames.push({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url || '',
        title: '',
        websiteTextContent: '',
        websiteMarkdownContent: '',
        extractedData: {},
        error: describeError(error),
      });
    }
  }
  return frames;
}

async function typeActiveTab(options = {}) {
  const tab = await getActiveTabInfo();
  if (!tab?.id) throw new Error('No active tab');
  return await typeTabById(tab.id, options);
}

async function typeTabById(tabId, options = {}) {
  return await runBrowserAction({
    type: 'page.type',
    tabId: Number(tabId),
    selector: options.selector || '',
    text: options.text || '',
    options,
    actionClass: options.actionClass || BROWSER_ACTION_LEVELS.LOCAL_FILTER,
  });
}

async function typeUrl(url, options = {}) {
  const opened = await openUrl(url, { active: options.active !== false, waitUntilComplete: true });
  return await typeTabById(opened.tab.id, options);
}

async function screenshotActiveTab(options = {}) {
  const tab = await getActiveTabInfo();
  if (!tab?.id) throw new Error('No active tab');
  return await screenshotTabById(tab.id, options);
}

async function screenshotTabById(tabId, options = {}) {
  return await runBrowserAction({
    type: 'page.screenshot',
    tabId: Number(tabId),
    format: options.format || 'jpeg',
    quality: options.quality,
    actionClass: BROWSER_ACTION_LEVELS.OBSERVE,
  });
}

async function screenshotUrl(url, options = {}) {
  const opened = await openUrl(url, { active: options.active !== false, waitUntilComplete: true });
  try {
    return await screenshotTabById(opened.tab.id, options);
  } finally {
    if (options.keepOpen !== true) await chrome.tabs.remove(opened.tab.id).catch(() => {});
  }
}

async function waitActiveTab(options = {}) {
  const tab = await getActiveTabInfo();
  if (!tab?.id) throw new Error('No active tab');
  return await waitTabById(tab.id, options);
}

async function waitTabById(tabId, options = {}) {
  return await runBrowserAction({
    type: 'page.waitReady',
    tabId: Number(tabId),
    timeoutMs: Number(options.timeoutMs || 10_000),
    options,
    actionClass: BROWSER_ACTION_LEVELS.OBSERVE,
  });
}

async function waitUrl(url, options = {}) {
  const opened = await openUrl(url, { active: options.active !== false, waitUntilComplete: true });
  return await waitTabById(opened.tab.id, options);
}

async function runBrowserAction(action, context = {}) {
  let session = context.session || activeBrowserSession || (await resolveBrowserActionSession('', 'manual_repair'));
  const normalized = normalizeBrowserAction(action);
  const startedAt = new Date().toISOString();
  let activeRequest = null;
  let decision = null;
  let actionSuccess = false;
  let actionError = '';
  let terminalResponse = null;
  let terminalBrowserError = null;
  let actionCleanup = null;
  try {
    const preparedTurn = await prepareBrowserActionTurn(session, normalized);
    session = preparedTurn.session || session;
    await browserControlRuntime.startSession(session.sessionId, session.currentTurnId || session.turnId || normalized.turnId || null, {
      publishTabs: false,
      reason: 'browser_action',
    }).catch(() => {});
    if (activeBrowserSession?.sessionId === session.sessionId) {
      activeBrowserSession = session;
      setStatus({ browserControl: activeBrowserSession });
    }
    if (normalized.tabId && !CONTROLLED_PAGE_MUTATION_ACTIONS.has(normalized.type)) {
      await claimTabForSession(session, normalized.tabId, normalized.origin || 'user', normalized.pageRole || 'source');
      if (activeBrowserSession?.sessionId === session.sessionId) session = activeBrowserSession;
    }
    const requestTabId = Number(normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId || 0);
    activeRequest = await startBrowserSessionRequest(session.sessionId, {
      requestId: normalized.callId || normalized.requestId || '',
      action: normalized.type,
      tabId: Number.isInteger(requestTabId) && requestTabId > 0 ? requestTabId : null,
      turnId: session.currentTurnId || session.turnId,
    });
    if (activeRequest.duplicateActive === true) {
      const duplicateError = new Error(`Browser action ${activeRequest.requestId} is already running`);
      duplicateError.code = 'BROWSER_ACTION_FAILED';
      duplicateError.retryable = true;
      throw duplicateError;
    }
    if (activeRequest.replayed === true) {
      if (activeRequest.responsePersisted !== true) {
        const replayError = new Error(`Browser action ${activeRequest.requestId} already reached a terminal state, but its response was too large to persist; refusing to execute the same callId again`);
        replayError.code = 'BROWSER_RESPONSE_TOO_LARGE';
        replayError.retryable = false;
        throw replayError;
      }
      terminalResponse = activeRequest.response;
      actionSuccess = terminalResponse?.success !== false;
      return terminalResponse;
    }
    await browserControlRuntime.startRequest(session.sessionId, requestTabId, {
      turnId: session.currentTurnId || session.turnId,
      publishTabs: false,
      reason: 'browser_action_request_started',
    }).catch(() => {});
    session = activeRequest.session || session;
    if (activeBrowserSession?.sessionId === session.sessionId) {
      activeBrowserSession = session;
      setStatus({ browserControl: activeBrowserSession });
    }
    const tab = normalized.tabId ? await chrome.tabs.get(Number(normalized.tabId)).catch(() => null) : null;
    decision = assertBrowserActionAllowed({
      ...normalized,
      requestId: activeRequest?.requestId || normalized.requestId || '',
      currentUrl: resolveBrowserPolicyPageUrl(normalized, tab, { isHttpUrl }),
    }, { isHttpUrl, requestId: activeRequest?.requestId || '' });
    await publishPolicyDecisionAudit({
      kind: 'policy.allowed',
      action: normalized,
      decision,
      session,
      requestId: activeRequest?.requestId || '',
      tabId: requestTabId,
    }).catch(() => {});
    let result;
    switch (normalized.type) {
      case 'tab.create':
        if (normalized.newWindow === true || normalized.window === true) {
          const { tab, window } = await createControlledTab({
            active: normalized.active !== false,
            url: normalized.url || 'about:blank',
            newWindow: true,
          });
          await claimTabForSession(session, tab.id, 'agent', normalized.pageRole || 'source');
          if (normalized.url && normalized.waitUntilComplete !== false && isHttpUrl(normalized.url)) {
            await waitForTabComplete(tab.id, Number(normalized.timeoutMs || 30_000));
          }
          result = { success: true, tab: tabInfo(tab), window: normalizeCreatedWindow(window), createdWindow: true };
        } else if (normalized.url) {
          result = await openUrl(normalized.url, {
            active: normalized.active !== false,
            waitUntilComplete: normalized.waitUntilComplete !== false,
          });
        } else {
          const { tab } = await createControlledTab({
            active: normalized.active !== false,
            url: 'about:blank',
          });
          await claimTabForSession(session, tab.id, 'agent', normalized.pageRole || 'source');
          result = { success: true, tab: tabInfo(tab) };
        }
        break;
      case 'window.create': {
        const { tab, window } = await createControlledTab({
          active: normalized.active !== false,
          url: normalized.url || 'about:blank',
          newWindow: true,
        });
        await claimTabForSession(session, tab.id, 'agent', normalized.pageRole || 'source');
        if (normalized.url && normalized.waitUntilComplete !== false && isHttpUrl(normalized.url)) {
          await waitForTabComplete(tab.id, Number(normalized.timeoutMs || 30_000));
        }
        result = { success: true, tab: tabInfo(tab), window: normalizeCreatedWindow(window), createdWindow: true };
        break;
      }
      case 'tab.claim':
        await claimTabForSession(session, normalized.tabId, 'user', normalized.pageRole || 'source');
        result = { success: true, tabId: normalized.tabId };
        break;
      case 'tab.activate':
        result = await activateControlledTab(session, normalized);
        break;
      case 'tab.close':
        result = await closeControlledTab(session, normalized);
        break;
      case 'browser.ping':
        result = { success: true, pong: true, now: new Date().toISOString() };
        break;
      case 'command.unsupported':
        throw unsupportedBrowserCommandError(normalized);
      case 'browser.info':
        result = await getBrowserControlInfo();
        break;
      case 'browser.capabilities':
        result = await getBrowserControlInfo();
        break;
      case 'research.run':
        result = await runSiteResearch(normalized, {
          getTab: async (tabId) => await chrome.tabs.get(tabId).catch(() => null),
          createControlledTab,
          claimTab: async (tabId, pageRole) => await claimTabForSession(session, tabId, 'agent', pageRole),
          waitForTabComplete,
          readSnapshot: async (tabId) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await sendContentMessage(tabId, CONTENT_DOM_SNAPSHOT_TYPE, {});
          },
          readSiteEvidence: async (tabId, options) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await sendContentMessage(tabId, CONTENT_SITE_RESEARCH_EXTRACT_TYPE, options || {});
          },
          applyFilters: async (tabId, options) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await sendContentMessage(tabId, CONTENT_SITE_RESEARCH_APPLY_FILTERS_TYPE, options || {});
          },
          submitSearch: async (tabId, options) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await sendContentMessage(tabId, CONTENT_SITE_RESEARCH_SUBMIT_SEARCH_TYPE, options || {});
          },
          openItem: async (tabId, options) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await openSiteResearchItem({ ...(options || {}), tabId }, buildSiteResearchNavigationDeps(session));
          },
          closeItem: async (tabId, options) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await closeSiteResearchItem({ ...(options || {}), tabId }, buildSiteResearchNavigationDeps(session));
          },
          scrollPage: async (tabId) => {
            await requireActiveControlledTabLease(session, tabId, 'research.run');
            return await sendContentMessage(tabId, CONTENT_SCROLL_TYPE, { deltaY: 800 });
          },
          closeTab: async (tabId) => await closeControlledTab(session, {
            tabId,
            reason: 'research_detail_complete',
          }).catch(() => {}),
          downloadAsset: async (asset, options) => {
            const sourceUrl = String(asset?.sourceUrl || '').trim();
            if (!isHttpUrl(sourceUrl)) throw new Error('research media URL must use http or https');
            const downloadId = await chrome.downloads.download({
              url: sourceUrl,
              saveAs: false,
              conflictAction: 'uniquify',
            });
            return await waitForDownload({
              downloadId,
              timeoutMs: Math.max(Number(options?.timeoutMs || 30_000), 30_000),
              sessionId: session.sessionId,
              turnId: session.currentTurnId || session.turnId || '',
              artifactBinding: {
                kind: 'browser_research_media',
                sourceUrl,
              },
            });
          },
        });
        break;
      case 'session.name':
        result = await nameBrowserSession(session.sessionId, normalized.name || normalized.sessionName || '');
        break;
      case 'turn.ended':
        result = await endActiveTurn(session, normalized.turnId || session.currentTurnId || session.turnId);
        break;
      case 'tab.info': {
        const tabId = Number(normalized.tabId || normalized.id || session.activeTabId || activeBrowserSession?.activeTabId || 0);
        const tab = tabId
          ? await chrome.tabs.get(tabId).catch(() => null)
          : await getActiveTabInfo();
        result = {
          success: true,
          tab: tab ? tabInfo(tab) : null,
          url: tab?.url || '',
          title: tab?.title || '',
        };
        break;
      }
      case 'tab.navigate':
        await requireActiveControlledTabLease(session, normalized.tabId, 'tab.navigate');
        result = await openUrl(normalized.url, {
          tabId: normalized.tabId,
          active: normalized.active !== false,
          waitUntilComplete: normalized.waitUntilComplete !== false,
        });
        break;
      case 'tab.back':
        await requireActiveControlledTabLease(session, normalized.tabId, 'tab.back');
        if (typeof chrome.tabs.goBack !== 'function') throw new Error('chrome.tabs.goBack is unavailable');
        await chrome.tabs.goBack(normalized.tabId);
        result = await waitForTargetLoadState(normalized.tabId, normalized.waitUntil || normalized.state || 'load', Number(normalized.timeoutMs || normalized.timeout_ms || 30_000));
        break;
      case 'tab.forward':
        await requireActiveControlledTabLease(session, normalized.tabId, 'tab.forward');
        if (typeof chrome.tabs.goForward !== 'function') throw new Error('chrome.tabs.goForward is unavailable');
        await chrome.tabs.goForward(normalized.tabId);
        result = await waitForTargetLoadState(normalized.tabId, normalized.waitUntil || normalized.state || 'load', Number(normalized.timeoutMs || normalized.timeout_ms || 30_000));
        break;
      case 'page.navigate':
      case 'page.goto': {
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        const waitUntil = normalizeTargetLoadState(normalized.waitUntil || normalized.wait_until || normalized.state || 'load', { allowCommit: true });
        result = await openUrl(normalized.url, {
          tabId: normalized.tabId,
          active: normalized.active !== false,
          timeoutMs: normalized.timeoutMs || normalized.timeout_ms,
          waitUntilComplete: false,
        });
        const loadState = await waitForTargetLoadState(normalized.tabId, waitUntil, Number(normalized.timeoutMs || normalized.timeout_ms || 30_000));
        result = { ...result, waitUntil, loadState, url: loadState.url || result.tab?.url || normalized.url };
        break;
      }
      case 'tab.reload':
        await requireActiveControlledTabLease(session, normalized.tabId, 'tab.reload');
        await chrome.tabs.reload(normalized.tabId);
        await waitForTabComplete(normalized.tabId, Number(normalized.timeoutMs || 30_000));
        result = { success: true, tabId: normalized.tabId };
        break;
      case 'page.waitReady':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.waitReady');
        await waitForTabComplete(normalized.tabId, Number(normalized.timeoutMs || 10_000));
        result = await sendContentMessage(normalized.tabId, CONTENT_WAIT_STABLE_TYPE, normalized.options || {}, normalized.options?.frameId);
        break;
      case 'page.waitForLoadState': {
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.waitForLoadState');
        const state = normalizeTargetLoadState(normalized.state || normalized.waitUntil || normalized.wait_until || 'load');
        result = await waitForTargetLoadState(normalized.tabId, state, Number(normalized.timeoutMs || normalized.timeout_ms || 10_000));
        break;
      }
      case 'page.waitForURL':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.waitForURL');
        result = await waitForTabUrlMatch(normalized.tabId, normalized, Number(normalized.timeoutMs || normalized.timeout_ms || 10_000));
        break;
      case 'page.waitForTimeout':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.waitForTimeout');
        {
          const waitedMs = Math.min(120_000, Math.max(0, Number(normalized.timeoutMs || normalized.timeout_ms || normalized.ms || normalized.milliseconds || 0)));
          await sleep(waitedMs);
          result = { success: true, tabId: normalized.tabId, waitedMs, checkedAt: new Date().toISOString() };
        }
        break;
      case 'page.assets':
      case 'tab_page_assets_list':
        result = await readPageAssetInventory(normalized.tabId, normalized.options || normalized);
        break;
      case 'page.assets.bundle':
      case 'tab_page_assets_bundle':
        result = await bundlePageAssets(normalized.tabId, normalized.options || normalized);
        break;
      case 'page.frames':
        if (normalized.prepareContentScript === true || normalized.prepare === true || normalized.injectIfMissing === true) {
          await requireActiveControlledTabLease(session, normalized.tabId, 'page.frames');
        }
        result = await listPageFrames(normalized.options ? { ...normalized.options, tabId: normalized.tabId } : normalized);
        break;
      case 'page.domSnapshot':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.domSnapshot');
        result = await sendContentMessage(normalized.tabId, CONTENT_DOM_SNAPSHOT_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.evaluate':
      case 'page.evaluateScript':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await evaluatePageScript({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.scroll':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.scroll');
        result = await sendContentMessage(normalized.tabId, CONTENT_SCROLL_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.click':
      case 'page.doubleClick':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.click');
        result = await sendContentMessage(normalized.tabId, CONTENT_CLICK_ELEMENT_TYPE, {
          ...(normalized.options || normalized),
          doubleClick: normalized.type === 'page.doubleClick' || normalized.doubleClick === true || normalized.options?.doubleClick === true,
        }, normalized.options?.frameId);
        if (normalized.options?.waitAfterClickMs) await sleep(Number(normalized.options.waitAfterClickMs));
        break;
      case 'page.clickNode':
      case 'node.click':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await sendContentMessage(normalized.tabId, CONTENT_CLICK_NODE_TYPE, normalized.options || normalized, normalized.options?.frameId);
        if (normalized.options?.waitAfterClickMs) await sleep(Number(normalized.options.waitAfterClickMs));
        break;
      case 'page.hover':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.hover');
        result = await sendContentMessage(normalized.tabId, CONTENT_HOVER_ELEMENT_TYPE, normalized.options || normalized, normalized.options?.frameId);
        if (normalized.options?.waitAfterHoverMs) await sleep(Number(normalized.options.waitAfterHoverMs));
        break;
      case 'page.inspectPoint':
      case 'page.hitTest':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await sendContentMessage(normalized.tabId, CONTENT_INSPECT_POINT_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.scrollNode':
      case 'node.scroll':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await sendContentMessage(normalized.tabId, CONTENT_SCROLL_NODE_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.waitForNode':
      case 'node.wait':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await sendContentMessage(normalized.tabId, CONTENT_WAIT_NODE_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.waitForSelector':
      case 'page.waitSelector':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await sendContentMessage(normalized.tabId, CONTENT_WAIT_SELECTOR_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.check':
      case 'page.setChecked':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await sendContentMessage(normalized.tabId, CONTENT_CHECK_ELEMENT_TYPE, normalized.options || normalized, normalized.options?.frameId);
        if (normalized.options?.waitAfterCheckMs) await sleep(Number(normalized.options.waitAfterCheckMs));
        break;
      case 'page.isChecked':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.isChecked');
        result = await sendContentMessage(normalized.tabId, CONTENT_IS_CHECKED_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.isVisible':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.isVisible');
        result = await sendContentMessage(normalized.tabId, CONTENT_IS_VISIBLE_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.getValue':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.getValue');
        result = await sendContentMessage(normalized.tabId, CONTENT_GET_VALUE_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.getValues':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.getValues');
        result = await sendContentMessage(normalized.tabId, CONTENT_GET_VALUES_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.getAttribute':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.getAttribute');
        result = await sendContentMessage(normalized.tabId, CONTENT_GET_ATTRIBUTE_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.queryElements':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.queryElements');
        result = await sendContentMessage(normalized.tabId, CONTENT_QUERY_ELEMENTS_TYPE, normalized.options || normalized, normalized.options?.frameId);
        break;
      case 'page.select':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.select');
        result = await sendContentMessage(normalized.tabId, CONTENT_SELECT_ELEMENT_TYPE, normalized.options || normalized, normalized.options?.frameId);
        if (normalized.options?.waitAfterSelectMs) await sleep(Number(normalized.options.waitAfterSelectMs));
        break;
      case 'page.type':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.type');
        result = await sendContentMessage(normalized.tabId, CONTENT_TYPE_ELEMENT_TYPE, normalized.options || normalized, normalized.options?.frameId);
        if (normalized.options?.waitAfterTypeMs) await sleep(Number(normalized.options.waitAfterTypeMs));
        break;
      case 'page.readClipboard':
      case 'clipboard.read':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await readPageClipboard({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.readClipboardText':
      case 'clipboard.readText':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await readPageClipboardText({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.writeClipboard':
      case 'clipboard.write':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await writePageClipboard({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.writeClipboardText':
      case 'clipboard.writeText':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await writePageClipboardText({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.consoleLogs':
      case 'tab_console_logs':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await listPageConsoleLogs({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.waitForFileChooser':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.waitForFileChooser');
        result = await waitForFileChooser({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.acceptFileChooser':
      case 'fileChooser.accept':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await acceptFileChooser({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'page.setInputFiles':
        await requireActiveControlledTabLease(session, normalized.tabId, 'page.setInputFiles');
        result = await setInputFiles({ ...(normalized.options || normalized), tabId: normalized.tabId });
        break;
      case 'webmcp.listTools':
      case 'webmcp_list_tools':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await listWebMcpTools(normalized);
        break;
      case 'webmcp.invokeTool':
      case 'webmcp_invoke_tool':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await invokeWebMcpTool(normalized);
        break;
      case 'page.screenshot':
        result = await captureVisibleTabScreenshot(normalized.tabId, normalized);
        break;
      case 'browser.fetchUrls':
      case 'page.fetchUrls':
      case 'urls.fetchContent':
        result = await fetchUrlContents(normalized);
        break;
      case 'page.export':
      case 'tab.export':
        await requireActiveControlledTabLease(session, normalized.tabId, normalized.type);
        result = await exportPage(normalized.tabId, {
          ...(normalized.options || normalized),
          tabId: normalized.tabId,
          sessionId: normalized.sessionId || session.sessionId,
          turnId: normalized.turnId || session.currentTurnId || session.turnId || '',
          jobMetadata: session.metadata || {},
        });
        break;
      case 'download.wait':
        result = await waitForDownload({
          ...(normalized.options || normalized),
          sessionId: normalized.sessionId || session.sessionId,
          turnId: normalized.turnId || session.currentTurnId || session.turnId || '',
          jobMetadata: session.metadata || {},
        });
        break;
      case 'download.events':
        result = await listDownloadEvents(normalized);
        break;
      case 'download.state':
      case 'downloads.state':
        result = {
          success: true,
          state: await getDownloadState(),
        };
        break;
      case 'downloads.search':
        result = await searchDownloads(normalized);
        break;
      case 'viewport.set':
      case 'browser_viewport_set':
        result = await setBrowserViewport({ ...(normalized.options || normalized), activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'viewport.reset':
      case 'browser_viewport_reset':
        result = await resetBrowserViewport({ ...(normalized.options || normalized), activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'cdp.attach':
        result = await attachCdp(normalized);
        break;
      case 'cdp.detach':
        result = await detachCdp(normalized);
        break;
      case 'cdp.send':
        result = await executeCdp(normalized);
        break;
      case 'cdp.targets':
        result = await listCdpTargets();
        break;
      case 'cdp.events':
        result = await listCdpEvents(normalized);
        break;
      case 'cdp.events.summary':
        result = await summarizeCdpEvents(normalized);
        break;
      case 'fileChooser.snapshot':
        result = { success: true, ...getFileChooserSnapshot() };
        break;
      case 'cdp.attachments':
      case 'cdp.attachedTargets':
        result = {
          success: true,
          ...getAttachedCdpSnapshot(),
        };
        break;
      case 'browser.sessionEvents':
        result = await listBrowserSessionEvents(normalized);
        break;
      case 'browser.events':
        result = await listAggregatedBrowserEvents(normalized);
        break;
      case 'browser.events.summary':
        result = await summarizeAggregatedBrowserEvents(normalized);
        break;
      case 'browser.clientHeartbeat':
        result = await receiveBrowserClientHeartbeat(normalized, session);
        break;
      case 'lifecycle.status':
      case 'browser.lifecycleStatus':
        result = await getLifecycleStatus();
        break;
      case 'sidePanel.status':
      case 'sidepanel.status':
        await restoreSidePanelStatus();
        result = getSidePanelStatus(normalized.windowId || normalized.params?.windowId || null);
        break;
      case 'sidePanel.open':
      case 'sidepanel.open':
        result = await openSidePanel(normalized.windowId || normalized.params?.windowId || null);
        break;
      case 'sidePanel.close':
      case 'sidepanel.close':
        result = await closeSidePanel(normalized.windowId || normalized.params?.windowId || null);
        break;
      case 'sidePanel.toggle':
      case 'sidepanel.toggle':
        result = await toggleSidePanel(normalized.windowId || normalized.params?.windowId || null);
        break;
      case 'browser.visibility.get':
      case 'browser_visibility_get':
      case 'getBrowserVisibility':
        result = await getBrowserVisibility(normalized);
        break;
      case 'browser.visibility.set':
      case 'browser_visibility_set':
      case 'setBrowserVisibility':
        result = await setBrowserVisibility(normalized);
        break;
      case 'session.tabs':
        result = await getSessionTabs(session);
        break;
      case 'tabLeases.list':
      case 'tabs.leases':
        result = await listTabLeaseSnapshot(normalized);
        break;
      case 'tab.lifecycleEvents':
      case 'tabs.lifecycleEvents':
      case 'tabLifecycle.events':
        result = tabLifecycleRuntime.listEvents(normalized);
        break;
      case 'tab.lifecycleSnapshot':
      case 'tabs.lifecycleSnapshot':
      case 'tabLifecycle.snapshot':
        result = tabLifecycleRuntime.getSnapshot();
        break;
      case 'cdp.screenshot':
        result = await captureCdpScreenshot({ ...normalized, activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'cdp.viewportSet':
        result = await setCdpViewport({ ...normalized, activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'cdp.viewportReset':
        result = await resetCdpViewport({ ...normalized, activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'viewport.state':
      case 'cdp.viewportState':
        result = await getViewportState({ ...normalized, activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'input.mouseMove':
        result = await dispatchMouseMove(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId, session });
        break;
      case 'input.mouseClick':
        result = await dispatchMouseClick(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId, session });
        break;
      case 'input.mouseDrag':
        await requireActiveControlledTabLease(session, normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId, 'input.mouseDrag');
        result = await dispatchMouseDrag(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId, session });
        break;
      case 'input.mouseWheel':
        await requireActiveControlledTabLease(session, normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId, 'input.mouseWheel');
        result = await dispatchMouseWheel(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId, session });
        break;
      case 'input.keyboardType':
        await requireActiveControlledTabLease(session, normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId, 'input.keyboardType');
        result = await dispatchKeyboardType(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'input.keyboardPress':
        await requireActiveControlledTabLease(session, normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId, 'input.keyboardPress');
        result = await dispatchKeyboardPress(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'input.keyboardCombo':
        await requireActiveControlledTabLease(session, normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId, 'input.keyboardCombo');
        result = await dispatchKeyboardCombo(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId });
        break;
      case 'cursor.move':
        result = await moveCursorOverlay(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId, session });
        break;
      case 'cursor.hide':
        result = await hideCursorOverlay(normalized, { activeTabId: session.activeTabId || activeBrowserSession?.activeTabId, session });
        break;
      case 'tabs.list':
        result = await listUserTabs(normalized);
        break;
      case 'windows.list':
      case 'browser.windows':
        result = await listBrowserWindows(normalized);
        break;
      case 'bookmarks.list':
        result = await listUserBookmarks(normalized);
        break;
      case 'topSites.list':
        result = await listTopSites(normalized);
        break;
      case 'readingList.list':
        result = await listReadingList(normalized);
        break;
      case 'sessions.recentlyClosed':
        result = await listRecentlyClosedSessions(normalized);
        break;
      case 'sessions.devices':
        result = await listSessionDevices(normalized);
        break;
      case 'browser.context':
      case 'userBrowser.context':
        result = await getUserBrowserContext(normalized);
        break;
      case 'tabs.finalize':
        result = await finalizeTabs(readFinalizeTabEntries(normalized), session);
        break;
      case 'tabs.finalizedBadges':
        result = normalized.hasUnseen === true ? await hasUnseenFinalizedBadges() : await listFinalizedBadges(normalized);
        break;
      case 'managedTabGroups.list':
      case 'tabGroups.managed':
        result = await listManagedTabGroups();
        break;
      case 'activeTabObserver.snapshot':
      case 'activeTabs.snapshot':
        result = {
          success: true,
          snapshotAt: new Date().toISOString(),
          ...activeTabObserver.getSnapshot(),
        };
        break;
      case 'history.search':
        result = await searchUserHistory(normalized);
        break;
      default:
        throw new Error(`Unsupported browser action: ${normalized.type}`);
    }
    actionSuccess = result?.success !== false;
    terminalResponse = {
      success: actionSuccess,
      sessionId: session.sessionId,
      turnId: session.currentTurnId || session.turnId || '',
      action: normalized.type,
      policy: decision,
      requestId: activeRequest?.requestId || '',
      result,
      cleanup: result?.cleanup || null,
      browserError: result?.browserError || null,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    return terminalResponse;
  } catch (error) {
    actionSuccess = false;
    actionError = describeErrorMessage(error);
    terminalBrowserError = buildBrowserActionError(error, normalized, session, activeRequest);
    actionCleanup = createCleanupReport('browser_action_failed', session.sessionId, session.currentTurnId || session.turnId || normalized.turnId || '');
    await runCleanupStep(actionCleanup, 'detach_action_debuggers', async () => await detachAttachedDebuggersForTabs([normalized.tabId]));
    finishCleanupReport(actionCleanup);
    terminalBrowserError.details = {
      ...(terminalBrowserError.details || {}),
      cleanup: actionCleanup,
    };
    decision = decision || error?.details?.decision || null;
    if (decision) {
      await publishPolicyDecisionAudit({
        kind: 'policy.denied',
        action: normalized,
        decision,
        session,
        requestId: activeRequest?.requestId || '',
        tabId: Number(normalized.tabId || session.activeTabId || activeBrowserSession?.activeTabId || 0),
        error: actionError,
      }).catch(() => {});
    }
    terminalResponse = {
      success: false,
      sessionId: session.sessionId,
      turnId: session.currentTurnId || session.turnId || '',
      action: normalized.type,
      policy: decision || null,
      requestId: activeRequest?.requestId || '',
      browserError: terminalBrowserError,
      cleanup: actionCleanup,
      error: actionError,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    return terminalResponse;
  } finally {
    if (activeRequest?.requestId && activeRequest.replayed !== true && activeRequest.duplicateActive !== true) {
      await browserControlRuntime.finishRequest(session.sessionId, {
        publishTabs: false,
        reason: 'browser_action_request_finished',
      }).catch(() => {});
      const finished = await finishBrowserSessionRequest(session.sessionId, activeRequest.requestId, {
        success: actionSuccess,
        error: actionError,
        browserError: terminalBrowserError,
        response: terminalResponse,
        persistResult: true,
      }).catch(() => null);
      if (finished?.session && activeBrowserSession?.sessionId === session.sessionId) {
        activeBrowserSession = finished.session;
        setStatus({ browserControl: activeBrowserSession });
      }
      await maybeReloadForPendingUpdate().catch(() => {});
    }
  }
}

function buildBrowserActionError(error, action = {}, session = {}, activeRequest = null) {
  const message = describeErrorMessage(error) || 'Browser action failed';
  const normalizedMessage = message.toLowerCase();
  const declaredCode = String(error?.code || '').toUpperCase();
  let code = declaredCode.startsWith('BROWSER_') ? declaredCode : 'BROWSER_ACTION_FAILED';
  let retryable = error?.retryable === true;
  let userActionRequired = error?.userActionRequired === true;
  if (isCdpCommandTimeoutError(error) || normalizedMessage.includes('timed out') || normalizedMessage.includes('timeout')) {
    code = 'BROWSER_ACTION_TIMEOUT';
    retryable = true;
  } else if (normalizedMessage.includes('unclaimed tab') || normalizedMessage.includes('active lease')) {
    code = 'BROWSER_TAB_NOT_OWNED';
    retryable = false;
    userActionRequired = true;
  } else if (declaredCode === 'BROWSER_ACTION_CANCELLED' || error?.name === 'AbortError') {
    code = 'BROWSER_ACTION_CANCELLED';
    retryable = false;
  }
  return {
    code,
    message,
    retryable,
    userActionRequired,
    browserInstanceId: String(action.browserInstanceId || ''),
    callId: String(action.callId || activeRequest?.requestId || ''),
    details: {
      sessionId: String(session.sessionId || ''),
      turnId: String(session.currentTurnId || session.turnId || action.turnId || ''),
      action: String(action.type || ''),
      tabId: Number.isInteger(Number(action.tabId)) ? Number(action.tabId) : null,
      targetId: typeof action.targetId === 'string' ? action.targetId : '',
      attempt: Number.isInteger(Number(action.attempt)) ? Number(action.attempt) : 1,
    },
  };
}

async function publishPolicyDecisionAudit({ kind, action = {}, decision = {}, session = {}, requestId = '', tabId = null, error = '' } = {}) {
  await browserEventBridge.publishPolicyDecisionEvent({
    kind,
    actionType: String(action.type || ''),
    actionClass: decision.actionClass || action.actionClass || '',
    reason: decision.reason || '',
    allowed: decision.allowed === true,
    policyContractVersion: decision.policyContractVersion || null,
    requiresUserConfirmation: decision.requiresUserConfirmation === true,
    approval: sanitizeApprovalDecision(decision.approval),
    requestId,
    sessionId: session.sessionId || '',
    turnId: session.currentTurnId || session.turnId || '',
    tabId: Number.isInteger(Number(tabId)) && Number(tabId) > 0 ? Number(tabId) : null,
    error: error ? String(error).slice(0, 500) : '',
  });
}

function sanitizeApprovalDecision(approval = null) {
  if (!approval) return { accepted: false, reason: 'not_evaluated' };
  return {
    accepted: approval.accepted === true,
    reason: approval.reason || '',
    scope: approval.scope || '',
    scopes: Array.isArray(approval.scopes) ? approval.scopes.map(String) : [],
    expiresAt: Number.isFinite(Number(approval.expiresAt)) ? Number(approval.expiresAt) : null,
    tokenId: approval.tokenId || '',
    bindings: approval.bindings || {},
  };
}

async function listAggregatedBrowserEvents(action = {}) {
  const limit = clamp(Number(action.limit || 100), 1, 500);
  const eventType = String(action.eventType || action.typeFilter || '');
  const sessionId = String(action.sessionId || '');
  const turnId = String(action.turnId || '');
  const bridgeMethod = String(action.bridgeMethod || action.method || '');
  const since = String(action.since || action.sinceEmittedAt || '');
  const afterEventId = String(action.afterEventId || '');
  const replayQuery = { ...action, type: '', eventType, limit: 500 };
  const bridge = await listBrowserEvents(replayQuery).catch(() => ({ events: [] }));
  const sessions = await listBrowserSessionEvents({ ...action, limit: 500 }).catch(() => ({ events: [] }));
  const downloads = await listDownloadEvents({ ...action, limit: 500 }).catch(() => ({ events: [] }));
  const cdp = await listCdpEvents({ ...action, limit: 500 }).catch(() => ({ events: [] }));
  const events = dedupeBrowserEvents([
    ...(bridge.events || []),
    ...(sessions.events || []).map(normalizeSessionReplayEvent),
    ...(downloads.events || []).map(normalizeDownloadReplayEvent),
    ...(cdp.events || []).map(normalizeCdpReplayEvent),
  ])
    .filter((event) => !eventType || event.eventType === eventType)
    .filter((event) => !sessionId || event.sessionId === sessionId)
    .filter((event) => !turnId || event.turnId === turnId)
    .filter((event) => !bridgeMethod || event.bridgeMethod === bridgeMethod)
    .filter((event) => !since || String(event.emittedAt || event.recordedAt || '') > since)
    .sort((a, b) => String(b.emittedAt || b.recordedAt || '').localeCompare(String(a.emittedAt || a.recordedAt || '')));
  const afterIndex = afterEventId ? events.findIndex((event) => event.eventId === afterEventId) : -1;
  const windowed = afterIndex >= 0 ? events.slice(afterIndex + 1) : events;
  const selected = windowed.slice(0, limit);
  return {
    success: true,
    events: selected,
    hasMore: windowed.length > selected.length,
    newestEventId: events[0]?.eventId || '',
    newestEmittedAt: events[0]?.emittedAt || '',
  };
}

async function summarizeAggregatedBrowserEvents(action = {}) {
  const replay = await listAggregatedBrowserEvents({ ...action, limit: 500 });
  const events = replay.events || [];
  const byEventType = {};
  const bySourceKind = {};
  const nativeDelivery = { posted: 0, success: 0, pending: 0, failed: 0 };
  for (const event of events) {
    addEventSummaryBucket(byEventType, event.eventType || 'unknown', event);
    addEventSummaryBucket(bySourceKind, event.sourceKind || event.bridgeMethod || 'bridge', event);
    if (event.nativeDelivery?.posted === true) nativeDelivery.posted += 1;
    if (event.nativeDelivery?.success === true) nativeDelivery.success += 1;
    if (event.nativeDelivery?.pending === true) nativeDelivery.pending += 1;
    if (event.nativeDelivery?.error) nativeDelivery.failed += 1;
  }
  const newestEventId = replay.newestEventId || events[0]?.eventId || '';
  const newestEmittedAt = replay.newestEmittedAt || events[0]?.emittedAt || events[0]?.recordedAt || '';
  const oldestEventId = events[events.length - 1]?.eventId || '';
  const oldestEmittedAt = events[events.length - 1]?.emittedAt || events[events.length - 1]?.recordedAt || '';
  return {
    success: true,
    filters: {
      eventType: String(action.eventType || action.typeFilter || ''),
      sessionId: String(action.sessionId || ''),
      turnId: String(action.turnId || ''),
      bridgeMethod: String(action.bridgeMethod || action.method || ''),
      since: String(action.since || action.sinceEmittedAt || ''),
      afterEventId: String(action.afterEventId || ''),
    },
    total: events.length,
    hasMore: replay.hasMore === true,
    newestEventId,
    newestEmittedAt,
    oldestEventId,
    oldestEmittedAt,
    byEventType,
    bySourceKind,
    nativeDelivery,
    checkpoint: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      total: events.length,
      hasMore: replay.hasMore === true,
      newestEventId,
      newestEmittedAt,
      oldestEventId,
      oldestEmittedAt,
      latestByEventType: buildEventCheckpointIndex(byEventType),
      latestBySourceKind: buildEventCheckpointIndex(bySourceKind),
      nativeDelivery,
      nextQuery: {
        afterEventId: newestEventId,
        since: newestEmittedAt,
      },
    },
  };
}

function buildEventCheckpointIndex(summary = {}) {
  return Object.fromEntries(Object.entries(summary).map(([key, bucket]) => [key, {
    count: Number(bucket?.count || 0),
    latestEventId: bucket?.latestEventId || '',
    latestEmittedAt: bucket?.latestEmittedAt || '',
    latestRecordedAt: bucket?.latestRecordedAt || '',
    latestKind: bucket?.latestKind || '',
  }]));
}

function addEventSummaryBucket(target, key, event) {
  const bucketKey = String(key || 'unknown');
  const bucket = target[bucketKey] || {
    count: 0,
    latestEventId: '',
    latestEmittedAt: '',
    latestRecordedAt: '',
    latestKind: '',
    nativeDelivery: { posted: 0, success: 0, pending: 0, failed: 0 },
  };
  bucket.count += 1;
  if (!bucket.latestEventId) {
    bucket.latestEventId = event.eventId || '';
    bucket.latestEmittedAt = event.emittedAt || '';
    bucket.latestRecordedAt = event.recordedAt || '';
    bucket.latestKind = event.kind || event.sessionEventType || '';
  }
  if (event.nativeDelivery?.posted === true) bucket.nativeDelivery.posted += 1;
  if (event.nativeDelivery?.success === true) bucket.nativeDelivery.success += 1;
  if (event.nativeDelivery?.pending === true) bucket.nativeDelivery.pending += 1;
  if (event.nativeDelivery?.error) bucket.nativeDelivery.failed += 1;
  target[bucketKey] = bucket;
}

function normalizeSessionReplayEvent(event = {}) {
  return {
    ...event,
    eventId: event.eventId || `session:${event.id}`,
    sessionEventType: event.sessionEventType || event.eventType || '',
    sourceKind: 'session',
    nativeDelivery: event.nativeDelivery || replayedNativeDelivery(),
  };
}

function normalizeDownloadReplayEvent(event = {}) {
  return {
    ...event,
    eventId: event.eventId || `download:${event.id}`,
    eventType: 'download',
    sourceKind: 'download',
    emittedAt: event.emittedAt || event.receivedAt || '',
    nativeDelivery: event.nativeDelivery || replayedNativeDelivery(),
  };
}

function normalizeCdpReplayEvent(event = {}) {
  return {
    ...event,
    eventId: event.eventId || `cdp:${event.id}`,
    eventType: 'cdp',
    sourceKind: 'cdp',
    emittedAt: event.emittedAt || event.receivedAt || '',
    nativeDelivery: event.nativeDelivery || replayedNativeDelivery(),
  };
}

function dedupeBrowserEvents(events = []) {
  const byId = new Map();
  for (const event of events) {
    if (!event?.eventId) continue;
    byId.set(event.eventId, event);
  }
  return [...byId.values()];
}

function replayedNativeDelivery() {
  return { posted: false, success: false, pending: false, error: 'replayed_from_source_store' };
}

async function prepareBrowserActionTurn(session, action) {
  if (!session?.sessionId || action?.type === 'turn.ended') return { success: true, session, sessionEvents: [] };
  const requestedTurnId = String(action?.turnId || '');
  const shouldBeginTurn = !session.currentTurnId || (requestedTurnId && requestedTurnId !== session.currentTurnId);
  if (!shouldBeginTurn) return { success: true, session, sessionEvents: [] };
  const turnId = requestedTurnId || createBrowserTurnId();
  const begun = await beginBrowserSessionTurn(session.sessionId, turnId, 'browser_action');
  const resumed = await resumeHandoffTabs(session.sessionId, turnId, {
    activeTabId: action?.tabId,
    reason: 'turn_started',
  }).catch((error) => ({ success: false, error: describeError(error), resumedLeases: [], sessionEvents: [] }));
  const updated = await updateActiveSessionTurn(session.sessionId, turnId)
    .catch((error) => ({ success: false, error: describeError(error), updatedLeases: [], sessionEvents: [] }));
  const resumedGroupId = (resumed.resumedLeases || []).find((lease) => Number.isInteger(lease.groupId))?.groupId;
  if (Number.isInteger(resumedGroupId)) {
    await reconcileManagedGroupForTabs(session.sessionId, resumedGroupId, (resumed.resumedLeases || []).map((lease) => lease.tabId)).catch(() => {});
  }
  const nextSession = updated.session || resumed.session || begun.session || session;
  await browserControlRuntime.startSession(nextSession.sessionId, turnId, {
    publishTabs: false,
    reason: 'turn_started',
  }).catch(() => {});
  await browserControlRuntime.trackTabs(nextSession.sessionId, [
    ...(resumed.resumedLeases || []).map((lease) => lease.tabId),
    ...(updated.updatedLeases || []).map((lease) => lease.tabId),
  ], {
    publish: false,
    reason: 'turn_started',
  }).catch(() => {});
  return {
    success: begun.success !== false && resumed.success !== false && updated.success !== false,
    session: nextSession,
    turnId,
    resumedLeases: resumed.resumedLeases || [],
    updatedLeases: updated.updatedLeases || [],
    sessionEvents: [
      ...(begun.sessionEvent ? [begun.sessionEvent] : []),
      ...(resumed.sessionEvents || []),
      ...(updated.sessionEvents || []),
    ],
  };
}

function normalizeBrowserAction(action) {
  const targetWebMcpType = String(action?.type || '');
  if (targetWebMcpType === 'tab.capabilities.pageAssets.list' || targetWebMcpType === 'tab.capabilities.pageAssets.bundle') {
    const normalizedTargetParams = normalizeNativeMethodParams(targetWebMcpType, action || {});
    const type = targetWebMcpType === 'tab.capabilities.pageAssets.list' ? 'page.assets' : 'page.assets.bundle';
    return {
      ...normalizedTargetParams,
      requestedType: targetWebMcpType,
      type,
      actionClass: action?.actionClass || classifyBrowserAction(type),
    };
  }
  if (targetWebMcpType === 'tab.consoleLogs' || targetWebMcpType === 'tab_console_logs') {
    const normalizedTargetParams = normalizeNativeMethodParams(targetWebMcpType, action || {});
    return {
      ...normalizedTargetParams,
      requestedType: targetWebMcpType,
      type: 'page.consoleLogs',
      actionClass: action?.actionClass || classifyBrowserAction('page.consoleLogs'),
    };
  }
  if (targetWebMcpType === 'tab.capabilities.webmcp.listTools' || targetWebMcpType === 'tab.capabilities.webmcp.invokeTool') {
    const normalizedTargetParams = normalizeNativeMethodParams(targetWebMcpType, action || {});
    const type = targetWebMcpType === 'tab.capabilities.webmcp.listTools' ? 'webmcp.listTools' : 'webmcp.invokeTool';
    return {
      ...normalizedTargetParams,
      requestedType: targetWebMcpType,
      type,
      actionClass: action?.actionClass || classifyBrowserAction(type),
    };
  }
  const normalized = {
    ...(action || {}),
    type: String(action?.type || ''),
    actionClass: action?.actionClass || classifyBrowserAction(action?.type),
  };
  if (!normalized.type) throw new Error('Browser action missing type');
  return normalized;
}

function createBrowserTurnId() {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function attachCdp(action = {}) {
  requireDebuggerApi();
  const target = cdpTargetFromAction(action);
  if (target.tabId) {
    const attachResult = await attachCdpTab(target.tabId);
    await publishCdpAttachLifecycle(target, attachResult, 'command').catch(() => {});
    return { success: true, target, attached: true };
  }
  const ownerTabId = requireTargetOwnerTabId(action, 'cdp.attach');
  const session = activeBrowserSession || await resolveBrowserActionSession(action.sessionId || '', 'cdp_attach');
  await requireActiveControlledTabLease(session, ownerTabId, 'cdp.attachTarget');
  const attachResult = await attachCdpTarget(target.targetId, ownerTabId);
  const lifecycleTarget = { ...target, tabId: ownerTabId };
  await publishCdpAttachLifecycle(lifecycleTarget, attachResult, 'command').catch(() => {});
  return { success: true, target: lifecycleTarget, attached: true };
}

async function detachCdp(action = {}) {
  requireDebuggerApi();
  const target = cdpTargetFromAction(action);
  const lifecycleTarget = target.targetId ? { ...target, tabId: requireTargetOwnerTabId(action, 'cdp.detach') } : target;
  if (target.targetId) {
    const session = activeBrowserSession || await resolveBrowserActionSession(action.sessionId || '', 'cdp_detach');
    await requireActiveControlledTabLease(session, lifecycleTarget.tabId, 'cdp.detachTarget');
  }
  await detachCdpTarget(target);
  await browserEventBridge.publishCdpLifecycleEvent({
    kind: 'debugger.detached.command',
    source: normalizeDebuggerSource(lifecycleTarget),
    target: lifecycleTarget,
  }).catch(() => {});
  return { success: true, target: lifecycleTarget, detached: true };
}

async function executeCdp(action = {}) {
  requireDebuggerApi();
  const method = String(action.method || action.command || '');
  if (!method) throw new Error('cdp.send requires a method');
  if (method === 'Target.getTargets') return await listCdpTargets();
  if (DANGEROUS_CDP_METHODS.test(method)) throw browserPolicyError('denied_dangerous_cdp_method', action);
  const target = cdpTargetFromAction(action);
  if (target.tabId) await publishCdpAttachLifecycle(target, await attachCdpTab(target.tabId), 'executeCdp').catch(() => {});
  if (target.targetId) {
    const ownerTabId = requireTargetOwnerTabId(action, 'executeCdp');
    const session = activeBrowserSession || await resolveBrowserActionSession(action.sessionId || '', 'cdp_execute');
    await requireActiveControlledTabLease(session, ownerTabId, 'executeCdp.target');
    await publishCdpAttachLifecycle({ ...target, tabId: ownerTabId }, await attachCdpTarget(target.targetId, ownerTabId), 'executeCdp').catch(() => {});
  }
  const params = action.commandParams || action.params || {};
  let result;
  try {
    result = await sendCdpCommandWithTimeout(target, method, params, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  } catch (error) {
    if (isCdpCommandTimeoutError(error) && typeof target.tabId === 'number') {
      await detachAttachedDebuggersForTabs([target.tabId]).catch(() => {});
    }
    throw error;
  }
  return { success: true, target, method, result };
}

async function listCdpTargets() {
  requireDebuggerApi();
  const targetInfos = await listCdpTargetsRaw();
  return {
    success: true,
    targetInfos: targetInfos.map(normalizeCdpTargetInfo),
    rawTargetInfos: targetInfos,
  };
}

function normalizeCdpTargetInfo(target = {}) {
  const targetId = target.targetId || target.id || '';
  return {
    ...target,
    id: target.id || targetId,
    targetId,
    tabId: target.tabId,
    type: target.type,
    title: target.title || '',
    url: target.url || '',
    attached: Boolean(target.attached),
  };
}

async function getBrowserControlInfo() {
  const manifest = chrome.runtime.getManifest();
  const lifecycle = await getLifecycleStatus().catch(() => null);
  return {
    success: true,
    ...buildBrowserCapabilityMetadata({
      pluginId: PLUGIN_ID,
      manifest,
      nativeStatus,
      cdpProtocolVersion: getCdpProtocolVersion(),
      activeSession: activeBrowserSession,
      browserControlRuntime: browserControlRuntime.getSnapshot(),
      browserPolicy: buildBrowserPolicyMetadata(),
      consoleLogSnapshot: getConsoleLogSnapshot(),
      clientHeartbeat: getLastClientHeartbeatSnapshot(),
      lifecycleStatus: lifecycle,
      extensionInstanceId: lifecycle?.extensionInstanceId || '',
      siteResearch: { capabilities: listSiteCapabilities(), contractVersion: SITE_RESEARCH_CONTRACT_VERSION },
    }),
  };
}

async function receiveBrowserClientHeartbeat(action = {}, session = null) {
  const result = await recordBrowserClientHeartbeat({
    source: action.source || 'app',
    clientId: action.clientId || action.id || '',
    sessionId: action.sessionId || session?.sessionId || activeBrowserSession?.sessionId || '',
    turnId: action.turnId || session?.currentTurnId || session?.turnId || '',
    staleAfterMs: action.staleAfterMs,
  });
  lastClientHeartbeatState = result;
  await browserEventBridge.publishLifecycleEvent('client_heartbeat.received', {
    heartbeat: result.heartbeat,
  }).catch(() => {});
  return result;
}

function getLastClientHeartbeatSnapshot() {
  if (!lastClientHeartbeatState?.heartbeat) return null;
  const heartbeat = lastClientHeartbeatState.heartbeat;
  const ageMs = heartbeat.receivedAt ? Math.max(0, Date.now() - Date.parse(heartbeat.receivedAt)) : null;
  return {
    ...lastClientHeartbeatState,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    fresh: Number.isFinite(ageMs) ? ageMs <= Number(heartbeat.staleAfterMs || 0) : lastClientHeartbeatState.fresh === true,
  };
}

async function nameBrowserSession(sessionId, name) {
  const result = await nameStoredBrowserSession(sessionId, name);
  const session = result.session;
  await setSessionGroupTitle(sessionId, session.name, await activeAgentTabIds(sessionId)).catch(() => {});
  if (activeBrowserSession?.sessionId === sessionId) {
    activeBrowserSession = { ...activeBrowserSession, name: session.name, updatedAt: session.updatedAt };
    setStatus({ browserControl: activeBrowserSession });
  }
  return result;
}

async function markTurnEnded(sessionId, turnId) {
  return await markStoredTurnEnded(sessionId, turnId);
}

async function endActiveTurn(session, turnId) {
  const activeTurnId = String(turnId || session?.currentTurnId || session?.turnId || '');
  const cleanup = createCleanupReport('turn_ended', session.sessionId, activeTurnId);
  const active = await runCleanupStep(cleanup, 'read_active_leases', async () => await getSessionActiveLeases(session.sessionId));
  const activeTurnLeases = (active?.leases || []).filter((lease) => !activeTurnId || lease.turnId === activeTurnId);
  const touchedIds = activeTurnLeases.map((lease) => lease.tabId).filter((tabId) => Number.isInteger(tabId));
  const closeAgentIds = activeTurnLeases
    .filter((lease) => lease.origin === 'agent')
    .map((lease) => lease.tabId)
    .filter((tabId) => Number.isInteger(tabId));
  await runCleanupStep(cleanup, 'detach_debuggers', async () => await detachAttachedDebuggersForTabs(touchedIds));
  await runCleanupStep(cleanup, 'untrack_runtime_tabs', async () => await browserControlRuntime.untrackTabs(session.sessionId, touchedIds, {
    reason: 'turn_ended',
    publish: false,
    clearCursor: true,
  }));
  await runCleanupStep(cleanup, 'release_managed_groups', async () => await releaseTabsFromManagedGroups(touchedIds));
  await runCleanupStep(cleanup, 'clear_cursor_overlays', async () => await clearCursorOverlayForLeases(activeTurnLeases, 'turn_ended'));
  await runCleanupStep(cleanup, 'clear_favicon_badges', async () => await clearLeaseFaviconBadges(activeTurnLeases));
  await runCleanupStep(cleanup, 'close_agent_tabs', async () => await closeTabsIdempotently(closeAgentIds));
  await runCleanupStep(cleanup, 'refresh_managed_groups', async () => await refreshManagedGroupsFromChrome());
  const released = cleanup.failures.length === 0
    ? await runCleanupStep(cleanup, 'release_turn_leases', async () => await releaseActiveTurnLeases(session.sessionId, activeTurnId)) || { releasedLeases: [], sessionEvents: [], session: null }
    : { releasedLeases: [], sessionEvents: [], session: null };
  if (cleanup.failures.length > 0 && !cleanup.steps.some((step) => step.name === 'release_turn_leases')) {
    cleanup.steps.push({
      name: 'release_turn_leases',
      success: false,
      skipped: true,
      reason: 'prior_cleanup_failure',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  }
  const marked = await runCleanupStep(cleanup, 'mark_turn_terminal', async () => await markTurnEnded(session.sessionId, activeTurnId)) || {
    success: false,
    session: released.session || session,
    sessionEvent: null,
  };
  finishCleanupReport(cleanup);
  if (activeBrowserSession?.sessionId === session.sessionId) {
    activeBrowserSession = {
      ...(marked.session || released.session || activeBrowserSession),
      activeTabId: released.releasedLeases?.some((lease) => lease.tabId === activeBrowserSession?.activeTabId)
        ? null
        : marked.session?.activeTabId || activeBrowserSession?.activeTabId || null,
    };
    setStatus({ browserControl: activeBrowserSession });
  }
  return {
    success: cleanup.success,
    partial: cleanup.success !== true,
    session: marked.session,
    turnId: activeTurnId,
    releasedLeases: released.releasedLeases || [],
    closedTabIds: closeAgentIds,
    cleanup,
    ...(cleanup.success ? {} : { browserError: browserCleanupIncompleteError(cleanup) }),
    sessionEvents: [
      ...(marked.sessionEvent ? [marked.sessionEvent] : []),
      ...(released.sessionEvents || []),
    ],
  };
}

async function finalizeTabs(tabEntries, session) {
  const cleanup = createCleanupReport('tabs_finalized', session.sessionId, session.currentTurnId || session.turnId || '');
  const storedLeases = await runCleanupStep(cleanup, 'read_session_leases', async () => ({
    success: true,
    leases: (await listStoredTabLeases()).filter((lease) => lease?.sessionId === session.sessionId),
  })) || { leases: [] };
  const sessionLeases = storedLeases.leases || [];
  const activeLeases = sessionLeases.filter((lease) => lease.state === 'active');
  const eligibleIds = new Set(sessionLeases.map((lease) => lease.tabId).filter((tabId) => Number.isInteger(tabId)));
  const keepEntries = normalizeFinalizeKeepEntries(tabEntries, eligibleIds);
  const keepByTabId = new Map(keepEntries.map((entry) => [entry.tabId, entry.status]));
  const activeAgentIds = activeLeases
    .filter((lease) => lease.origin === 'agent')
    .map((lease) => lease.tabId)
    .filter((tabId) => Number.isInteger(tabId));
  const managedGroup = await runCleanupStep(cleanup, 'read_managed_group', async () => ({
    success: true,
    groupId: await getManagedGroupIdContainingTabs(activeAgentIds),
  }));
  const groupId = managedGroup?.groupId ?? null;
  const tabEntriesWithGroup = keepEntries.map((entry) => ({
    ...entry,
    ...(entry.status === 'handoff' && groupId == null ? {} : entry.status === 'handoff' ? { groupId } : {}),
    ...(session.activeTabId === entry.tabId ? { isActiveHandoff: true } : {}),
  }));
  const result = await finalizeTabLeases(tabEntriesWithGroup, session, { groupFinalized: false });
  await runCleanupStep(cleanup, 'mark_finalized_badges', async () => await markFinalizedBadges(result.finalized || []));

  const keepDeliverableIds = new Set(keepEntries.filter((entry) => entry.status === 'deliverable').map((entry) => entry.tabId));
  const keepHandoffIds = new Set(keepEntries.filter((entry) => entry.status === 'handoff').map((entry) => entry.tabId));
  const releaseUserIds = [];
  const closeAgentIds = [];
  for (const lease of activeLeases) {
    if (keepByTabId.has(lease.tabId)) continue;
    if (lease.origin === 'agent') closeAgentIds.push(lease.tabId);
    else releaseUserIds.push(lease.tabId);
  }
  const releaseIds = [...keepDeliverableIds, ...releaseUserIds, ...closeAgentIds];
  const touchedIds = [...new Set([...keepHandoffIds, ...releaseIds])];
  await runCleanupStep(cleanup, 'detach_debuggers', async () => await detachAttachedDebuggersForTabs(touchedIds));
  await runCleanupStep(cleanup, 'untrack_runtime_tabs', async () => await browserControlRuntime.untrackTabs(session.sessionId, touchedIds, {
    reason: 'tabs_finalized',
    publish: false,
    clearCursor: true,
  }));
  await runCleanupStep(cleanup, 'release_managed_groups', async () => await releaseTabsFromManagedGroups([...keepDeliverableIds, ...releaseUserIds, ...closeAgentIds]));
  const releasingUserLeases = activeLeases.filter((lease) => releaseUserIds.includes(lease.tabId));
  await runCleanupStep(cleanup, 'clear_favicon_badges', async () => await clearLeaseFaviconBadges(releasingUserLeases));
  if (closeAgentIds.length) {
    await runCleanupStep(cleanup, 'close_agent_tabs', async () => await closeTabsIdempotently(closeAgentIds));
    await runCleanupStep(cleanup, 'refresh_managed_groups', async () => await refreshManagedGroupsFromChrome());
  }
  const released = releaseIds.length && cleanup.failures.length === 0
    ? await runCleanupStep(cleanup, 'release_tab_leases', async () => await releaseTabsForSession(session.sessionId, releaseIds, 'tabs_finalized')) || { releasedLeases: [], sessionEvents: [], session: null }
    : { releasedLeases: [], sessionEvents: [], session: null };
  if (releaseIds.length && cleanup.failures.length > 0 && !cleanup.steps.some((step) => step.name === 'release_tab_leases')) {
    cleanup.steps.push({
      name: 'release_tab_leases',
      success: false,
      skipped: true,
      reason: 'prior_cleanup_failure',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  }
  finishCleanupReport(cleanup);
  if (activeBrowserSession?.sessionId === session.sessionId) {
    const releasedSet = new Set(releaseIds);
    activeBrowserSession = {
      ...(released.session || activeBrowserSession),
      activeTabId: releasedSet.has(activeBrowserSession?.activeTabId)
        ? null
        : activeBrowserSession?.activeTabId || null,
    };
    setStatus({ browserControl: activeBrowserSession });
  }
  return {
    ...result,
    success: result.success !== false && cleanup.success,
    partial: cleanup.success !== true,
    releasedLeases: released.releasedLeases || [],
    closedTabIds: closeAgentIds,
    releasedTabIds: releaseIds,
    handoffTabIds: [...keepHandoffIds],
    deliverableTabIds: [...keepDeliverableIds],
    cleanup,
    ...(cleanup.success ? {} : { browserError: browserCleanupIncompleteError(cleanup) }),
    sessionEvents: [
      ...(result.sessionEvents || []),
      ...(released.sessionEvents || []),
    ],
  };
}

function createCleanupReport(reason, sessionId, turnId) {
  return {
    reason: String(reason || 'browser_cleanup'),
    sessionId: String(sessionId || ''),
    turnId: String(turnId || ''),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: true,
    steps: [],
    failures: [],
  };
}

async function runCleanupStep(cleanup, name, action) {
  const startedAt = new Date().toISOString();
  try {
    const result = await action();
    const success = result?.success !== false;
    const step = { name, success, startedAt, finishedAt: new Date().toISOString(), result: summarizeCleanupStepResult(result) };
    cleanup.steps.push(step);
    if (!success) {
      cleanup.success = false;
      cleanup.failures.push({ name, error: describeErrorMessage(result?.error || `${name} returned success=false`) });
    }
    return result;
  } catch (error) {
    const message = describeErrorMessage(error);
    cleanup.success = false;
    cleanup.steps.push({ name, success: false, startedAt, finishedAt: new Date().toISOString(), error: message });
    cleanup.failures.push({ name, error: message });
    return null;
  }
}

function summarizeCleanupStepResult(result) {
  if (result == null || typeof result !== 'object') return result ?? null;
  if (Array.isArray(result)) return result.slice(0, 100).map(summarizeCleanupArrayItem);
  const summary = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'session' || key === 'sessionEvents' || key === 'cleanupResult') continue;
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      summary[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    } else if (Array.isArray(value)) {
      summary[key] = value.slice(0, 100).map(summarizeCleanupArrayItem);
    }
  }
  return summary;
}

function summarizeCleanupArrayItem(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object') return String(value).slice(0, 500);
  return Object.fromEntries(['name', 'operation', 'tabId', 'targetId', 'status', 'success', 'alreadyDetached', 'error']
    .filter((key) => value[key] != null)
    .map((key) => [key, typeof value[key] === 'string' ? value[key].slice(0, 500) : value[key]]));
}

function finishCleanupReport(cleanup) {
  cleanup.finishedAt = new Date().toISOString();
  cleanup.success = cleanup.failures.length === 0;
  return cleanup;
}

function browserCleanupIncompleteError(cleanup) {
  return {
    code: 'BROWSER_CLEANUP_INCOMPLETE',
    message: `Browser cleanup completed with ${cleanup.failures.length} failure(s)`,
    retryable: true,
    userActionRequired: false,
    browserInstanceId: '',
    callId: '',
    details: {
      reason: cleanup.reason,
      sessionId: cleanup.sessionId,
      turnId: cleanup.turnId,
      failures: cleanup.failures,
    },
  };
}

async function closeTabsIdempotently(tabIds) {
  const closedTabIds = [];
  const alreadyClosedTabIds = [];
  const failures = [];
  for (const tabId of [...new Set((tabIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))]) {
    try {
      await chrome.tabs.remove(tabId);
      closedTabIds.push(tabId);
    } catch (error) {
      const message = describeErrorMessage(error);
      if (/no tab with id|invalid tab id/i.test(message)) alreadyClosedTabIds.push(tabId);
      else failures.push({ tabId, error: message });
    }
  }
  return { success: failures.length === 0, closedTabIds, alreadyClosedTabIds, failures };
}

async function groupFinalizedTabs(finalized) {
  return await groupStoredFinalizedTabs(finalized);
}

function normalizeFinalizeKeepEntries(tabEntries, activeIds) {
  if (!Array.isArray(tabEntries)) throw new Error('finalizeTabs requires a keep array');
  const seen = new Set();
  const entries = [];
  for (const entry of tabEntries) {
    if (!entry || typeof entry !== 'object') throw new Error('finalizeTabs received invalid tab entry');
    const tabId = Number(entry.tabId || entry.id || 0);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('finalizeTabs requires an integer tabId');
    if (!activeIds.has(tabId)) throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`);
    const status = String(entry.status || '');
    if (status !== 'handoff' && status !== 'deliverable') throw new Error(`finalizeTabs received invalid status ${status || 'unknown'}`);
    if (seen.has(tabId)) throw new Error(`finalizeTabs received duplicate tab ${tabId}`);
    seen.add(tabId);
    entries.push({ ...entry, tabId, status });
  }
  return entries;
}

function readFinalizeTabEntries(action = {}) {
  const entries = action.keep ?? action.tabs ?? action.finalizedTabs;
  if (!Array.isArray(entries)) throw new Error('finalizeTabs requires a keep array');
  return entries;
}

function cdpTargetFromAction(action = {}) {
  if (action.targetId) return { targetId: String(action.targetId) };
  return { tabId: requireTabId(action, action.type || 'cdp') };
}

function requireTargetOwnerTabId(action = {}, label = 'target CDP action') {
  const tabId = Number(action.tabId || action.target?.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${label} requires tabId when targetId is provided`);
  return tabId;
}

function requireTabId(action = {}, label = 'browser action') {
  const tabId = Number(action.tabId || activeBrowserSession?.activeTabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${label} requires an integer tabId`);
  return tabId;
}

async function handleCdpEvent(source, method, params) {
  handleFileChooserCdpEvent(source, method, params);
  handleConsoleCdpEvent(source, method, params);
  await recordCdpEvent(source, method, params);
  await browserEventBridge.sendCdpEvent({ source, method, params }).catch(() => {});
}

async function publishCdpAttachLifecycle(target, attachResult = {}, reason = '') {
  if (!attachResult?.attached) return null;
  return await browserEventBridge.publishCdpLifecycleEvent({
    kind: attachResult.alreadyAttached ? 'debugger.attach.reused' : 'debugger.attached',
    source: normalizeDebuggerSource(target),
    target,
    reason,
  });
}

function normalizeDebuggerSource(source = {}) {
  return {
    tabId: typeof source.tabId === 'number' ? source.tabId : null,
    targetId: typeof source.targetId === 'string' ? source.targetId : '',
    extensionId: typeof source.extensionId === 'string' ? source.extensionId : '',
  };
}

async function createBrowserSession(owner = 'manual_repair', metadata = {}) {
  const created = await createStoredBrowserSession(owner, metadata);
  if (created?.session) {
    await browserControlRuntime.startSession(created.session.sessionId, created.session.currentTurnId || created.session.turnId, {
      publishTabs: false,
      reason: 'session_created',
    }).catch(() => {});
  }
  return created;
}

async function ensureBrowserSession(sessionId, owner = 'manual_repair', metadata = {}, options = {}) {
  const ensured = await ensureStoredBrowserSession(sessionId, owner, metadata, options);
  if (ensured?.session) {
    await browserControlRuntime.startSession(ensured.session.sessionId, ensured.session.currentTurnId || ensured.session.turnId, {
      publishTabs: false,
      reason: options.reason || 'session_ensured',
    }).catch(() => {});
  }
  return ensured;
}

async function resolveBrowserActionSession(sessionId = '', owner = 'manual_repair') {
  if (sessionId) {
    const session = await getBrowserSession(sessionId);
    if (session?.status === 'active') {
      await browserControlRuntime.startSession(session.sessionId, session.currentTurnId || session.turnId, {
        publishTabs: false,
        reason: 'session_resolved',
      }).catch(() => {});
      return session;
    }
  }
  if (activeBrowserSession?.status === 'active') {
    await browserControlRuntime.startSession(activeBrowserSession.sessionId, activeBrowserSession.currentTurnId || activeBrowserSession.turnId, {
      publishTabs: false,
      reason: 'session_resolved',
    }).catch(() => {});
    return activeBrowserSession;
  }
  const created = await createBrowserSession(owner, {});
  activeBrowserSession = created.session;
  setStatus({ browserControl: activeBrowserSession });
  return activeBrowserSession;
}

async function listBrowserSessions() {
  return await listStoredBrowserSessions();
}

async function endBrowserSession(sessionId, options = {}) {
  const result = await endStoredBrowserSession(sessionId);
  if (options.releaseTabs !== false) {
    const released = await releaseSessionTabLeases(sessionId);
    await browserControlRuntime.finishSession(sessionId, {
      reason: 'end_browser_session',
      releaseTabs: true,
      publish: false,
      clearCursor: false,
    }).catch(() => {});
    await releaseTabsFromManagedGroups((released.releasedLeases || []).map((lease) => lease.tabId)).catch(() => {});
    await clearCursorOverlayForLeases(released.releasedLeases || [], 'end_browser_session').catch(() => {});
    await clearLeaseFaviconBadges(released.releasedLeases || []).catch(() => {});
  } else {
    await browserControlRuntime.finishSession(sessionId, {
      reason: 'end_browser_session',
      releaseTabs: true,
      publish: false,
      clearCursor: false,
    }).catch(() => {});
  }
  if (activeBrowserSession?.sessionId === sessionId) activeBrowserSession = null;
  await maybeReloadForPendingUpdate().catch(() => {});
  return result;
}

async function stopActiveBrowserSessions(reason = 'stop_active_sessions') {
  const cleanupResults = [];
  const activeSessions = (await listStoredBrowserSessions()).filter((session) => session?.status === 'active');
  for (const session of activeSessions) {
    const cleanup = await endActiveTurn(session, session.currentTurnId || session.turnId).catch((error) => ({
      success: false,
      browserError: browserCleanupIncompleteError({
        reason,
        sessionId: session.sessionId,
        turnId: session.currentTurnId || session.turnId || '',
        failures: [{ name: 'stop_active_session', error: describeErrorMessage(error) }],
      }),
    }));
    cleanupResults.push({ sessionId: session.sessionId, cleanup });
  }
  const result = await stopStoredActiveBrowserSessions(reason);
  const stoppedSessions = Array.isArray(result.stoppedSessions) ? result.stoppedSessions : [];
  for (const session of stoppedSessions) {
    if (session?.sessionId) {
      const released = await releaseSessionTabLeases(session.sessionId).catch(() => null);
      await browserControlRuntime.finishSession(session.sessionId, {
        reason,
        releaseTabs: true,
        publish: false,
        clearCursor: false,
      }).catch(() => {});
      await releaseTabsFromManagedGroups((released?.releasedLeases || []).map((lease) => lease.tabId)).catch(() => {});
      await clearCursorOverlayForLeases(released?.releasedLeases || [], reason).catch(() => {});
      await clearLeaseFaviconBadges(released?.releasedLeases || []).catch(() => {});
    }
  }
  await browserControlRuntime.stopActiveSessions(reason).catch(() => {});
  activeBrowserSession = null;
  await maybeReloadForPendingUpdate().catch(() => {});
  return {
    success: cleanupResults.every((entry) => entry.cleanup?.success !== false),
    stoppedSessions,
    cleanupResults,
  };
}

async function listTabLeases() {
  return await listStoredTabLeases();
}

async function getSessionTabs(session) {
  const result = await getStoredSessionTabs(session.sessionId);
  if (activeBrowserSession?.sessionId === session.sessionId && Array.isArray(result.tabs)) {
    const activeTabId = result.tabs.some((tab) => tab.id === activeBrowserSession.activeTabId)
      ? activeBrowserSession.activeTabId
      : result.tabs.find((tab) => tab.active)?.id || result.tabs[0]?.id || null;
    activeBrowserSession = {
      ...activeBrowserSession,
      activeTabId,
      ownedTabIds: result.tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)),
    };
    setStatus({ browserControl: activeBrowserSession });
  }
  return result;
}

async function claimTabForActiveSession(tabId, origin = 'user', pageRole = 'source') {
  if (!tabId) return null;
  const session = activeBrowserSession || await resolveBrowserActionSession('', 'manual_repair');
  return await claimTabForSession(session, Number(tabId), origin, pageRole);
}

async function claimTabForSession(session, tabId, origin = 'user', pageRole = 'source') {
  const previousAgentTabIds = origin === 'agent' ? await activeAgentTabIds(session.sessionId) : [];
  const result = await claimTabLeaseForSession(session, tabId, origin, pageRole);
  if (!result.lease) return null;
  activeBrowserSession = result.session || { ...session, activeTabId: Number(tabId) };
  await browserControlRuntime.startSession(activeBrowserSession.sessionId, activeBrowserSession.currentTurnId || activeBrowserSession.turnId, {
    publishTabs: false,
    reason: 'tab_claimed',
  }).catch(() => {});
  await browserControlRuntime.trackTab(activeBrowserSession.sessionId, Number(tabId), {
    publish: false,
    reason: 'tab_claimed',
  }).catch(() => {});
  if (origin === 'agent') {
    await ensureAgentTabGroup(session.sessionId, Number(tabId), previousAgentTabIds).catch(() => {});
  }
  setStatus({ browserControl: activeBrowserSession });
  return result.lease;
}

async function activeAgentTabIds(sessionId) {
  const active = await getSessionActiveLeases(sessionId).catch(() => ({ leases: [] }));
  return (active.leases || [])
    .filter((lease) => lease.origin === 'agent')
    .map((lease) => lease.tabId)
    .filter((tabId) => Number.isInteger(tabId));
}

function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active,
  };
}

function normalizeCreatedWindow(window = {}) {
  return {
    id: window?.id || null,
    focused: window?.focused === true,
    state: window?.state || '',
    type: window?.type || '',
    tabIds: Array.isArray(window?.tabs) ? window.tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)) : [],
  };
}

async function sendToMainFrame(tabId, message) {
  await ensureContentScript(tabId, { allFrames: false, frameId: 0 });
  return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

async function cleanupTabState(tabId, reason = 'removed') {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;
  forgetAttachedCdpTab(id);
  const removed = await removeTabLease(id);
  await browserControlRuntime.forgetTab(id, {
    reason,
    publish: false,
    clearCursor: false,
  }).catch(() => {});
  await clearCursorOverlayForTab(id, reason).catch(() => {});
  await releaseTabsFromManagedGroups([id]).catch(() => {});
  if (removed?.lease) await clearLeaseFaviconBadges([removed.lease]).catch(() => {});
  if (activeBrowserSession?.activeTabId === id) {
    activeBrowserSession = { ...activeBrowserSession, activeTabId: null, lastTabCleanupReason: reason };
    setStatus({ browserControl: activeBrowserSession });
  }
}

async function handleObservedActiveTabsChanged(tabIds = [], snapshotArg = null, metadata = {}) {
  const reason = metadata?.reason || 'active_tab_changed';
  const snapshot = activeTabObserver.getSnapshot();
  await browserEventBridge.publishActiveTabObserverEvent({
    changedTabIds: tabIds,
    activeTabIds: snapshot.activeTabIds,
    activeTabIdByWindowId: snapshot.activeTabIdByWindowId,
    reason,
    changedKeys: Array.isArray(metadata?.changedKeys) ? metadata.changedKeys : [],
  }).catch(() => {});
  await browserControlRuntime.republishTabStates(tabIds, { reason }).catch(() => {});
  for (const tabId of tabIds) {
    if (!snapshot.activeTabIds.includes(tabId)) continue;
    await handleTabActivated(tabId, 'active_observer');
  }
}

async function handleTabActivated(tabId, reason = 'activated') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return;
  const synced = await syncSessionActiveTabFromLease(id, reason).catch(() => null);
  if (synced?.session) {
    activeBrowserSession = synced.session;
    setStatus({ browserControl: activeBrowserSession });
  }
}

async function reconcileReplacedTab(addedTabId, removedTabId) {
  const added = Number(addedTabId);
  const removed = Number(removedTabId);
  if (!Number.isInteger(added) || !Number.isInteger(removed)) return;
  const moved = await moveReplacedTabLease(added, removed);
  if (!moved.moved) return;
  await browserControlRuntime.replaceTab(removed, added, moved.lease?.sessionId || activeBrowserSession?.sessionId || '', {
    reason: 'tab_replaced',
    publish: false,
  }).catch(() => {});
  await refreshManagedGroupsFromChrome().catch(() => {});
  if (activeBrowserSession?.activeTabId === removed) {
    activeBrowserSession = { ...activeBrowserSession, activeTabId: added };
    setStatus({ browserControl: activeBrowserSession });
  }
}

function isBrowserControlActive() {
  return Boolean(activeBrowserSession?.status === 'active' || browserControlRuntime.isBrowserControlActive() || sessionHasActiveRequests(activeBrowserSession) || hasPendingCursorArrivals() || hasAttachedCdp());
}

async function stopBrowserControlAfterHeartbeatFailure(details = {}) {
  const stopped = await stopActiveBrowserSessions('heartbeat_failure').catch((error) => ({ success: false, error: describeError(error), stoppedSessions: [] }));
  const detached = await detachAttachedDebuggersBestEffort().catch((error) => ({ success: false, error: describeError(error) }));
  const cleanup = await recordLifecycleCleanupResult({
    reason: 'heartbeat_failure',
    stoppedSessionCount: stopped.stoppedSessions?.length || 0,
    stoppedSessions: stopped.stoppedSessions || [],
    detached,
    clientHeartbeat: details.clientHeartbeat || null,
  }).catch((error) => ({ success: false, error: describeError(error), cleanupResult: null }));
  await browserEventBridge.publishCdpLifecycleEvent({
    kind: 'debugger.detached.best_effort',
    reason: 'heartbeat_failure',
    detachResult: detached,
    cleanupResult: cleanup.cleanupResult || null,
  }).catch(() => {});
  await browserEventBridge.publishLifecycleEvent('heartbeat_failure', {
    stoppedSessions: stopped.stoppedSessions || [],
    detachResult: detached,
    clientHeartbeat: details.clientHeartbeat || null,
    cleanupResult: cleanup.cleanupResult || null,
  }).catch(() => {});
  setStatus({
    browserControl: null,
    lastError: detached?.success === false ? detached.error : lastStatus.lastError,
  });
}

async function sendCapture(capture, commandId) {
  const baseUrl = await resolveApiBase(false);
  return await postJson(`${baseUrl}/captures`, {
    pluginId: PLUGIN_ID,
    commandId: commandId || undefined,
    captureKind: capture.captureKind,
    data: capture,
    metadata: capture.metadata,
  });
}

async function ingestManualCapture(capture) {
  const normalized = {
    captureKind: capture.captureKind || 'manual',
    url: capture.url || '',
    title: capture.title || '',
    frameCount: Number(capture.frameCount || 1),
    websiteTextContent: capture.websiteTextContent || '',
    websiteMarkdownContent: capture.websiteMarkdownContent || capture.websiteTextContent || '',
    extractedData: capture.extractedData || {},
    metadata: {
      ...(capture.metadata || {}),
      extensionId: chrome.runtime.id,
      capturedAt: new Date().toISOString(),
    },
  };
  const result = await sendCapture(normalized, '');
  const captureId = result?.capture?.id || '';
  setStatus({ lastCaptureId: captureId });
  return { success: true, captureId, capture: result?.capture || normalized };
}

async function listCaptures(options = {}) {
  const baseUrl = await resolveApiBase(false);
  const limit = encodeURIComponent(String(options.limit || 20));
  return await getJson(`${baseUrl}/captures?pluginId=${encodeURIComponent(PLUGIN_ID)}&limit=${limit}`);
}

async function listCommands(options = {}) {
  const baseUrl = await resolveApiBase(false);
  const params = new URLSearchParams({ pluginId: PLUGIN_ID, limit: String(options.limit || 20) });
  if (options.status) params.set('status', options.status);
  return await getJson(`${baseUrl}/commands?${params.toString()}`);
}

async function saveScraper(scraper) {
  const scrapers = await listScrapers();
  const now = new Date().toISOString();
  const next = {
    id: scraper.id || `scraper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: scraper.name || 'Untitled scraper',
    urlPattern: scraper.urlPattern || '',
    mode: scraper.mode || 'NO_PAGINATION',
    columns: normalizeColumns(scraper.columns || []),
    aiInstruction: scraper.aiInstruction || '',
    bulkUrls: scraper.bulkUrls || [],
    maxPages: Number(scraper.maxPages || 1),
    nextButtonSelector: scraper.nextButtonSelector || '',
    createdAt: scraper.createdAt || now,
    updatedAt: now,
  };
  const filtered = scrapers.filter((item) => item.id !== next.id);
  filtered.unshift(next);
  await chrome.storage.local.set({ [SCRAPERS_KEY]: filtered.slice(0, 100) });
  return { success: true, scraper: next, scrapers: filtered.slice(0, 100) };
}

async function listScrapers() {
  const result = await chrome.storage.local.get(SCRAPERS_KEY);
  return Array.isArray(result?.[SCRAPERS_KEY]) ? result[SCRAPERS_KEY] : [];
}

function summarizeCapture(capture) {
  const adapter = capture.extractedData?.adapter || null;
  return {
    url: capture.url,
    title: capture.title,
    frameCount: capture.frameCount,
    adapter: adapter ? { id: adapter.id, label: adapter.label } : null,
    emails: capture.extractedData?.emails?.length || 0,
    phones: capture.extractedData?.phones?.length || 0,
    images: capture.extractedData?.images?.length || 0,
    links: capture.extractedData?.links?.length || 0,
    primaryListCandidate: capture.extractedData?.primaryListCandidates?.[0] || null,
  };
}

function buildSuggestedColumns(capture) {
  const adapterFields = capture?.extractedData?.adapter?.suggestedFields || [];
  const fields = [...adapterFields];
  if (capture?.extractedData?.emails?.length) fields.push({ name: 'email', type: 'email', source: 'heuristic' });
  if (capture?.extractedData?.phones?.length) fields.push({ name: 'phone', type: 'phone', source: 'heuristic' });
  if (capture?.extractedData?.images?.length) fields.push({ name: 'image', type: 'image', source: 'heuristic' });
  if (capture?.extractedData?.links?.length) fields.push({ name: 'sourceUrl', type: 'url', source: 'heuristic' });
  fields.push({ name: 'title', type: 'text', source: 'default' });
  fields.push({ name: 'url', type: 'url', source: 'default' });
  return normalizeColumns(fields).slice(0, 12);
}

function normalizeColumns(columns) {
  const seen = new Set();
  return columns
    .map((column) => ({
      id: column.id || slug(column.name || column.label || 'field'),
      name: column.name || column.label || 'field',
      type: column.type || 'text',
      source: column.source || 'user',
      prompt: column.prompt || '',
    }))
    .filter((column) => {
      const key = column.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildPreviewRows(capture, columns) {
  const normalized = normalizeColumns(columns.length ? columns : buildSuggestedColumns(capture));
  const adapterData = capture.extractedData?.adapter?.data || {};
  const links = capture.extractedData?.links || [];
  const images = capture.extractedData?.images || [];
  const emails = capture.extractedData?.emails || [];
  const phones = capture.extractedData?.phones || [];
  const rowCount = Math.max(1, Math.min(10, links.length || images.length || emails.length || 1));
  return Array.from({ length: rowCount }).map((_, index) => {
    const row = {};
    for (const column of normalized) {
      const name = column.name;
      row[name] = adapterData[name]
        || valueForColumn(name, { capture, links, images, emails, phones, index })
        || '';
    }
    return row;
  });
}

function valueForColumn(name, context) {
  const key = name.toLowerCase();
  if (key.includes('title') || key === 'name') return context.capture.title;
  if (key.includes('url') || key.includes('link')) return context.links[context.index]?.href || context.capture.url;
  if (key.includes('image')) return context.images[context.index]?.src || '';
  if (key.includes('email')) return context.emails[context.index] || context.emails[0] || '';
  if (key.includes('phone')) return context.phones[context.index] || context.phones[0] || '';
  if (key.includes('description') || key.includes('content')) return context.capture.websiteTextContent.slice(0, 240);
  return '';
}

function mergeExtractedData(frames) {
  const emails = new Set();
  const phones = new Set();
  const images = [];
  const links = [];
  const primaryListCandidates = [];
  let adapter = null;
  for (const frame of frames) {
    for (const email of frame.extractedData?.emails || []) emails.add(email);
    for (const phone of frame.extractedData?.phones || []) phones.add(phone);
    images.push(...(frame.extractedData?.images || []));
    links.push(...(frame.extractedData?.links || []));
    if (!adapter && frame.extractedData?.adapter) adapter = frame.extractedData.adapter;
    if (frame.extractedData?.primaryListCandidate) {
      primaryListCandidates.push({
        frameId: frame.frameId,
        ...frame.extractedData.primaryListCandidate,
      });
    }
  }
  return {
    emails: [...emails],
    phones: [...phones],
    images,
    links,
    primaryListCandidates,
    adapter,
  };
}

function buildCaptureOptions(scraper, options) {
  return {
    minImageWidth: Number(scraper.minImageWidth || 40),
    minImageHeight: Number(scraper.minImageHeight || 40),
    maxLinks: Number(scraper.maxLinks || 500),
    ...(options || {}),
  };
}

function columnsToSchema(columns) {
  const properties = {};
  for (const column of normalizeColumns(columns)) {
    properties[column.name] = {
      type: 'string',
      description: column.prompt || `${column.name} extracted from the webpage`,
    };
  }
  return {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties,
        },
      },
    },
  };
}

async function waitForTabComplete(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') return;
    await sleep(250);
  }
}

async function waitForTargetLoadState(tabId, state = 'load', timeoutMs = 10_000) {
  const started = Date.now();
  const loadState = normalizeTargetLoadState(state, { allowCommit: true });
  if (loadState === 'commit') {
    const tab = await waitForTabUrl(tabId, timeoutMs);
    return { success: true, tabId, state: loadState, url: tab.url || '', title: tab.title || '', checkedAt: new Date().toISOString() };
  }
  await waitForTabComplete(tabId, timeoutMs);
  if (loadState === 'networkidle') {
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, Math.min(500, timeoutMs - elapsed)));
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return {
    success: true,
    tabId,
    state: loadState,
    url: tab?.url || '',
    title: tab?.title || '',
    checkedAt: new Date().toISOString(),
  };
}

async function waitForTabUrlMatch(tabId, action = {}, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url && tabUrlMatchesTarget(tab.url, action)) {
      return {
        success: true,
        tabId,
        url: tab.url || '',
        title: tab.title || '',
        checkedAt: new Date().toISOString(),
      };
    }
    await sleep(100);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return {
    success: false,
    error: 'waitForURL timed out',
    tabId,
    url: tab?.url || '',
    title: tab?.title || '',
    checkedAt: new Date().toISOString(),
  };
}

function tabUrlMatchesTarget(url, action = {}) {
  const current = String(url || '');
  const exact = action.exact === true;
  const target = String(action.url || action.targetUrl || action.pattern || '').trim();
  const regex = String(action.urlRegex || action.regex || '').trim();
  if (regex) {
    try {
      return new RegExp(regex).test(current);
    } catch {
      return false;
    }
  }
  if (!target) return !!current && current !== 'about:blank';
  if (exact) return current === target;
  if (target.includes('*')) {
    const pattern = target
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(current);
  }
  return current === target || current.includes(target);
}

async function waitForTabUrl(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url && tab.url !== 'about:blank') return tab;
    await sleep(100);
  }
  return await chrome.tabs.get(tabId);
}

function normalizeTargetLoadState(value, options = {}) {
  const state = String(value || 'load').trim().toLowerCase();
  if (state === 'domcontentloaded') return 'domcontentloaded';
  if (state === 'networkidle') return 'networkidle';
  if (state === 'commit' && options.allowCommit === true) return 'commit';
  return 'load';
}

async function waitForTabIdle(tabId, timeoutMs) {
  const startedUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
  await sleep(500);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete' && tab.url !== startedUrl) return;
    await sleep(300);
  }
}

async function getJson(url) {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`${url} failed with ${response.status}`);
  return await response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error || `${url} failed with ${response.status}`);
  }
  return body;
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  if (!isBrowserControlActive()) void maybeReloadForPendingUpdate().catch(() => {});
}

async function createControlledTab(options = {}) {
  const url = options.url || 'about:blank';
  const active = options.active !== false;
  const requestedWindowId = Number(options.windowId || 0) || null;
  const forceNewWindow = options.newWindow === true || options.window === true;
  const windowId = forceNewWindow ? null : requestedWindowId || await resolveNormalWindowId();
  if (windowId) {
    const tab = await chrome.tabs.create({ active, url, windowId });
    if (!tab?.id) throw new Error('Created Chrome tab has no id');
    return { success: true, tab, createdWindow: false, windowId: tab.windowId || windowId };
  }
  const created = await chrome.windows.create({
    focused: active,
    type: 'normal',
    url,
  });
  const tab = created?.tabs?.find((item) => Number.isInteger(item?.id));
  if (!tab?.id) throw new Error('Created Chrome window has no tab id');
  return { success: true, tab, window: created, createdWindow: true, windowId: created.id || tab.windowId || null };
}

function buildSiteResearchNavigationDeps(session) {
  return {
    getTab: async (tabId) => await chrome.tabs.get(Number(tabId)).catch(() => null),
    listTabs: async () => await chrome.tabs.query({}),
    prepareItemClick: async (tabId, options) => await sendContentMessage(
      Number(tabId),
      CONTENT_SITE_RESEARCH_PREPARE_ITEM_CLICK_TYPE,
      options || {},
    ),
    prepareItemClose: async (tabId, options) => await sendContentMessage(
      Number(tabId),
      CONTENT_SITE_RESEARCH_PREPARE_ITEM_CLOSE_TYPE,
      options || {},
    ),
    clickPoint: async (tabId, point) => await dispatchMouseClick({
      tabId: Number(tabId),
      x: point.x,
      y: point.y,
      coordinateSpace: 'viewport',
      waitForArrival: true,
    }, {
      activeTabId: Number(tabId),
      session,
    }),
    readSiteEvidence: async (tabId, options) => {
      await requireActiveControlledTabLease(session, Number(tabId), 'research.run');
      return await sendContentMessage(Number(tabId), CONTENT_SITE_RESEARCH_EXTRACT_TYPE, options || {});
    },
    claimTab: async (tabId, pageRole) => await claimTabForSession(session, Number(tabId), 'agent', pageRole),
    closeNewTab: async (tabId) => await chrome.tabs.remove(Number(tabId)),
    waitForTabComplete: async (tabId, timeoutMs) => await waitForTabComplete(Number(tabId), Number(timeoutMs || 20_000)),
    closeTab: async (tabId) => await closeControlledTab(session, {
      tabId: Number(tabId),
      reason: 'research_detail_complete',
    }),
    goBack: async (tabId) => {
      await chrome.tabs.goBack(Number(tabId));
      return await waitForTargetLoadState(Number(tabId), 'load', 20_000);
    },
    pressEscape: async (tabId) => await dispatchKeyboardPress({
      tabId: Number(tabId),
      key: 'Escape',
      code: 'Escape',
    }, {
      activeTabId: Number(tabId),
      session,
    }),
  };
}

async function closeControlledTab(session, action = {}) {
  const tabId = Number(action.tabId || action.id || action.activeTabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('tab.close requires tabId');
  if (!session?.sessionId) throw new Error('tab.close requires an active browser session');
  const leases = await listStoredTabLeases();
  const lease = leases.find((item) => Number(item.tabId) === tabId);
  if (!lease || lease.sessionId !== session.sessionId) {
    throw new Error(`tab.close cannot close unclaimed tab ${tabId}`);
  }
  const reason = action.reason || 'tab_close_action';
  await clearCursorOverlayForTab(tabId, reason).catch(() => {});
  await clearLeaseFaviconBadges([lease]).catch(() => {});
  await releaseTabsFromManagedGroups([tabId]).catch(() => {});
  await browserControlRuntime.untrackTab(session.sessionId, tabId, {
    reason,
    publish: false,
    clearCursor: false,
  }).catch(() => {});
  const removed = await removeTabLease(tabId).catch((error) => ({ removed: false, error: describeError(error) }));
  await chrome.tabs.remove(tabId).catch((error) => {
    const message = describeError(error);
    if (!/No tab with id|Tabs cannot be edited right now/i.test(message)) throw error;
  });
  if (activeBrowserSession?.sessionId === session.sessionId && activeBrowserSession.activeTabId === tabId) {
    activeBrowserSession = { ...activeBrowserSession, activeTabId: null };
    setStatus({ browserControl: activeBrowserSession });
  }
  await browserEventBridge.publishSessionEvent({
    eventType: 'tab.closed',
    sessionId: session.sessionId,
    turnId: action.turnId || session.currentTurnId || session.turnId || '',
    tabId,
    reason,
    lease,
    removedLease: removed.removed === true,
  }).catch(() => {});
  return {
    success: true,
    tabId,
    closed: true,
    removedLease: removed.removed === true,
    lease,
  };
}

async function activateControlledTab(session, action = {}) {
  const tabId = Number(action.tabId || action.id || action.activeTabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('tab.activate requires tabId');
  const lease = await requireActiveControlledTabLease(session, tabId, 'tab.activate');
  const tab = await chrome.tabs.get(tabId);
  if (!Number.isInteger(tab.windowId)) throw new Error(`tab.activate cannot resolve window for tab ${tabId}`);
  const windowInfo = await chrome.windows.get(tab.windowId);
  if (windowInfo?.type && windowInfo.type !== 'normal') throw new Error(`tab.activate requires a normal browser window for tab ${tabId}`);
  await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
  const activatedTab = await chrome.tabs.update(tabId, { active: true });
  const sync = await syncSessionActiveTabFromLease(tabId, 'tab_activate_action').catch((error) => ({ success: false, error: describeError(error) }));
  if (activeBrowserSession?.sessionId === session.sessionId) {
    activeBrowserSession = { ...activeBrowserSession, activeTabId: tabId };
    setStatus({ browserControl: activeBrowserSession });
  }
  await browserEventBridge.publishSessionEvent({
    eventType: 'tab.activated',
    sessionId: session.sessionId,
    turnId: action.turnId || session.currentTurnId || session.turnId || '',
    tabId,
    windowId: activatedTab.windowId || tab.windowId,
    reason: action.reason || 'tab_activate_action',
    lease,
  }).catch(() => {});
  return {
    success: true,
    tabId,
    windowId: activatedTab.windowId || tab.windowId,
    active: activatedTab.active === true,
    focusedWindow: true,
    synced: sync.success === true,
    lease,
  };
}

async function requireActiveControlledTabLease(session, tabId, actionType) {
  const id = Number(tabId || 0);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${actionType} requires tabId`);
  if (!session?.sessionId) throw new Error(`${actionType} requires an active browser session`);
  const leases = await listStoredTabLeases();
  const lease = leases.find((item) => Number(item.tabId) === id);
  if (!lease || lease.sessionId !== session.sessionId) {
    throw new Error(`${actionType} cannot operate on unclaimed tab ${id}`);
  }
  if (lease.state !== 'active') {
    throw new Error(`${actionType} requires active lease for tab ${id}`);
  }
  return lease;
}

async function resolveNormalWindowId() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const focused = windows.find((item) => item.focused && Number.isInteger(item.id));
  if (focused?.id) return focused.id;
  const first = windows.find((item) => Number.isInteger(item.id));
  return first?.id || null;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function slug(value) {
  return String(value || 'field').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'field';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function describeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
