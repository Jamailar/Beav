import { normalizeNativeMethodParams } from './browserProtocolSchemas.js';
import { unsupportedBrowserCommandError } from './unsupportedCommandRuntime.js';

export function createCommandRouter(options = {}) {
  const handlers = new Map();
  const unsupportedKind = options.unsupportedKind || 'native method';
  const routeSource = options.source || options.routeSource || unsupportedKind;
  const onRoute = typeof options.onRoute === 'function' ? options.onRoute : null;
  return {
    register(method, handler) {
      const name = normalizeMethod(method);
      if (!name) throw new Error('commandRouter.register requires method');
      if (typeof handler !== 'function') throw new Error(`commandRouter.register requires handler for ${name}`);
      handlers.set(name, handler);
      return this;
    },
    async route(method, params = {}) {
      const name = normalizeMethod(method);
      const handler = handlers.get(name);
      const startedAt = Date.now();
      publishRouteEvent(onRoute, {
        kind: 'route.started',
        source: routeSource,
        method: name || String(method || ''),
        unsupportedKind,
        paramKeys: listParamKeys(params),
      });
      if (!handler) {
        const error = unsupportedCommandError(name || method, unsupportedKind);
        publishRouteEvent(onRoute, {
          kind: 'route.unsupported',
          source: routeSource,
          method: name || String(method || ''),
          unsupportedKind,
          code: error.code,
          error: error.message,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      try {
        const result = await handler(params || {});
        publishRouteEvent(onRoute, {
          kind: 'route.succeeded',
          source: routeSource,
          method: name,
          unsupportedKind,
          durationMs: Date.now() - startedAt,
          resultSuccess: result?.success !== false,
        });
        return result;
      } catch (error) {
        publishRouteEvent(onRoute, {
          kind: 'route.failed',
          source: routeSource,
          method: name,
          unsupportedKind,
          code: error?.code || -32000,
          error: describeError(error).slice(0, 500),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
    has(method) {
      return handlers.has(normalizeMethod(method));
    },
    methods() {
      return [...handlers.keys()].sort();
    },
  };
}

export function createNativeMethodRouter(deps = {}) {
  const router = createCommandRouter({ source: 'native', onRoute: deps.onRoute });
  const normalize = (method, params) => normalizeNativeMethodParams(method, params);
  router
    .register('ping', async () => deps.ping())
    .register('getInfo', async () => deps.getInfo())
    .register('tools/list', async (params) => deps.listTools ? deps.listTools(params) : runNativeBrowserAction(deps, 'browser.capabilities', 'tools/list', params))
    .register('tools.list', async (params) => deps.listTools ? deps.listTools(params) : runNativeBrowserAction(deps, 'browser.capabilities', 'tools.list', params))
    .register('mcp.listTools', async (params) => deps.listTools ? deps.listTools(params) : runNativeBrowserAction(deps, 'browser.capabilities', 'mcp.listTools', params))
    .register('tools/call', async (params) => callMcpTool(deps, params))
    .register('tools.call', async (params) => callMcpTool(deps, params))
    .register('mcp.callTool', async (params) => callMcpTool(deps, params))
    .register('getCapabilities', async (params) => runNativeBrowserAction(deps, 'browser.capabilities', 'getCapabilities', params))
    .register('browser.action', async (params) => {
      const normalized = normalize('browser.action', params);
      return deps.runBrowserAction(normalized.action || normalized, normalized.sessionId);
    })
    .register('executeCommand', async (params) => deps.executeCommand({
      id: params.commandId || `native-${Date.now()}`,
      action: params.action,
      payload: params.payload || params,
    }))
    .register('executeCdp', async (params) => {
      const normalized = normalize('executeCdp', params);
      return deps.runBrowserAction({ type: 'cdp.send', ...normalized }, normalized.sessionId);
    })
    .register('attach', async (params) => {
      const normalized = normalize('attach', params);
      return deps.runBrowserAction({ type: 'cdp.attach', ...normalized }, normalized.sessionId);
    })
    .register('attachTarget', async (params) => {
      const normalized = normalize('attachTarget', params);
      return deps.runBrowserAction({ type: 'cdp.attach', ...normalized }, normalized.sessionId);
    })
    .register('detach', async (params) => {
      const normalized = normalize('detach', params);
      return deps.runBrowserAction({ type: 'cdp.detach', ...normalized }, normalized.sessionId);
    })
    .register('detachTarget', async (params) => {
      const normalized = normalize('detachTarget', params);
      return deps.runBrowserAction({ type: 'cdp.detach', ...normalized }, normalized.sessionId);
    })
    .register('moveMouse', async (params) => {
      const normalized = normalize('moveMouse', params);
      return deps.runBrowserAction({ type: 'input.mouseMove', ...normalized }, normalized.sessionId);
    })
    .register('nameSession', async (params) => {
      const normalized = normalize('nameSession', params);
      return deps.runBrowserAction({ type: 'session.name', ...normalized }, normalized.sessionId);
    })
    .register('turnEnded', async (params) => {
      const normalized = normalize('turnEnded', params);
      return deps.runBrowserAction({ type: 'turn.ended', ...normalized }, normalized.sessionId);
    })
    .register('createTab', async (params) => {
      const normalized = normalize('createTab', params);
      return deps.runBrowserAction({ type: 'tab.create', ...normalized }, normalized.sessionId);
    })
    .register('createWindow', async (params) => {
      const normalized = normalize('createTab', params);
      return deps.runBrowserAction({ type: 'window.create', ...normalized }, normalized.sessionId);
    })
    .register('claimUserTab', async (params) => {
      const normalized = normalize('claimUserTab', params);
      return deps.runBrowserAction({ type: 'tab.claim', ...normalized }, normalized.sessionId);
    })
    .register('activateTab', async (params) => {
      const normalized = normalize('activateTab', params);
      return deps.runBrowserAction({ type: 'tab.activate', ...normalized }, normalized.sessionId);
    })
    .register('navigateTab', async (params) => {
      const normalized = normalize('navigateTab', params);
      return deps.runBrowserAction({ type: 'tab.navigate', ...normalized }, normalized.sessionId);
    })
    .register('reloadTab', async (params) => {
      const normalized = normalize('reloadTab', params);
      return deps.runBrowserAction({ type: 'tab.reload', ...normalized }, normalized.sessionId);
    })
    .register('waitForPage', async (params) => runNativeBrowserAction(deps, 'page.waitReady', 'waitForPage', params))
    .register('waitTabReady', async (params) => runNativeBrowserAction(deps, 'page.waitReady', 'waitTabReady', params))
    .register('closeTab', async (params) => {
      const normalized = normalize('closeTab', params);
      return deps.runBrowserAction({ type: 'tab.close', ...normalized }, normalized.sessionId);
    })
    .register('finalizeTabs', async (params) => {
      const normalized = normalize('finalizeTabs', params);
      return deps.runBrowserAction({ type: 'tabs.finalize', ...normalized }, normalized.sessionId);
    })
    .register('getTabs', async (params) => runNativeBrowserAction(deps, 'session.tabs', 'getTabs', params))
    .register('getSessionTabs', async (params) => runNativeBrowserAction(deps, 'session.tabs', 'getSessionTabs', params))
    .register('getTabLeases', async (params) => runNativeBrowserAction(deps, 'tabLeases.list', 'getTabLeases', params))
    .register('getUserTabs', async (params) => runNativeBrowserAction(deps, 'tabs.list', 'getUserTabs', params))
    .register('getUserHistory', async (params) => runNativeBrowserAction(deps, 'history.search', 'getUserHistory', params))
    .register('getUserBookmarks', async (params) => runNativeBrowserAction(deps, 'bookmarks.list', 'getUserBookmarks', params))
    .register('getUserTopSites', async (params) => runNativeBrowserAction(deps, 'topSites.list', 'getUserTopSites', params))
    .register('getUserReadingList', async (params) => runNativeBrowserAction(deps, 'readingList.list', 'getUserReadingList', params))
    .register('getUserSessions', async (params) => runNativeBrowserAction(deps, 'sessions.recentlyClosed', 'getUserSessions', params))
    .register('getUserBrowserContext', async (params) => runNativeBrowserAction(deps, 'browser.context', 'getUserBrowserContext', params))
    .register('getWindows', async (params) => runNativeBrowserAction(deps, 'windows.list', 'getWindows', params))
    .register('getSessionEvents', async (params) => runNativeBrowserAction(deps, 'browser.sessionEvents', 'getSessionEvents', params))
    .register('getBrowserEvents', async (params) => runNativeBrowserAction(deps, 'browser.events', 'getBrowserEvents', params))
    .register('getBrowserEventSummary', async (params) => runNativeBrowserAction(deps, 'browser.events.summary', 'getBrowserEventSummary', params))
    .register('getCdpEvents', async (params) => runNativeBrowserAction(deps, 'cdp.events', 'getCdpEvents', params))
    .register('getCdpEventSummary', async (params) => runNativeBrowserAction(deps, 'cdp.events.summary', 'getCdpEventSummary', params))
    .register('getManagedTabGroups', async (params) => runNativeBrowserAction(deps, 'managedTabGroups.list', 'getManagedTabGroups', params))
    .register('getActiveTabObserverSnapshot', async (params) => runNativeBrowserAction(deps, 'activeTabObserver.snapshot', 'getActiveTabObserverSnapshot', params))
    .register('getCdpAttachments', async (params) => runNativeBrowserAction(deps, 'cdp.attachments', 'getCdpAttachments', params))
    .register('getDownloadState', async (params) => runNativeBrowserAction(deps, 'download.state', 'getDownloadState', params))
    .register('getViewportState', async (params) => runNativeBrowserAction(deps, 'viewport.state', 'getViewportState', params))
    .register('browser_viewport_set', async (params) => runNativeBrowserAction(deps, 'viewport.set', 'browser_viewport_set', params))
    .register('browser_viewport_reset', async (params) => runNativeBrowserAction(deps, 'viewport.reset', 'browser_viewport_reset', params))
    .register('getBrowserVisibility', async (params) => runNativeBrowserAction(deps, 'browser.visibility.get', 'getBrowserVisibility', params))
    .register('setBrowserVisibility', async (params) => runNativeBrowserAction(deps, 'browser.visibility.set', 'setBrowserVisibility', params))
    .register('browser_visibility_get', async (params) => runNativeBrowserAction(deps, 'browser.visibility.get', 'browser_visibility_get', params))
    .register('browser_visibility_set', async (params) => runNativeBrowserAction(deps, 'browser.visibility.set', 'browser_visibility_set', params))
    .register('webmcp_list_tools', async (params) => runNativeBrowserAction(deps, 'webmcp.listTools', 'webmcp_list_tools', params))
    .register('tab.capabilities.webmcp.listTools', async (params) => runNativeBrowserAction(deps, 'webmcp.listTools', 'tab.capabilities.webmcp.listTools', params))
    .register('webmcp_invoke_tool', async (params) => runNativeBrowserAction(deps, 'webmcp.invokeTool', 'webmcp_invoke_tool', params))
    .register('tab.capabilities.webmcp.invokeTool', async (params) => runNativeBrowserAction(deps, 'webmcp.invokeTool', 'tab.capabilities.webmcp.invokeTool', params))
    .register('listWebMcpTools', async (params) => runNativeBrowserAction(deps, 'webmcp.listTools', 'listWebMcpTools', params))
    .register('invokeWebMcpTool', async (params) => runNativeBrowserAction(deps, 'webmcp.invokeTool', 'invokeWebMcpTool', params))
    .register('browser.events', async (params) => runNativeBrowserAction(deps, 'browser.events', 'browser.events', params))
    .register('browser.events.summary', async (params) => runNativeBrowserAction(deps, 'browser.events.summary', 'browser.events.summary', params))
    .register('browser.sessionEvents', async (params) => runNativeBrowserAction(deps, 'browser.sessionEvents', 'browser.sessionEvents', params))
    .register('browser.clientHeartbeat', async (params) => runNativeBrowserAction(deps, 'browser.clientHeartbeat', 'browser.clientHeartbeat', params))
    .register('clientHeartbeat', async (params) => runNativeBrowserAction(deps, 'browser.clientHeartbeat', 'clientHeartbeat', params))
    .register('getLifecycleStatus', async (params) => runNativeBrowserAction(deps, 'lifecycle.status', 'getLifecycleStatus', params))
    .register('getSidePanelStatus', async (params) => runNativeBrowserAction(deps, 'sidePanel.status', 'getSidePanelStatus', params))
    .register('openSidePanel', async (params) => runNativeBrowserAction(deps, 'sidePanel.open', 'openSidePanel', params))
    .register('closeSidePanel', async (params) => runNativeBrowserAction(deps, 'sidePanel.close', 'closeSidePanel', params))
    .register('toggleSidePanel', async (params) => runNativeBrowserAction(deps, 'sidePanel.toggle', 'toggleSidePanel', params))
    .register('pageAssets', async (params) => runNativeBrowserAction(deps, 'page.assets', 'pageAssets', params))
    .register('pageAssetBundle', async (params) => runNativeBrowserAction(deps, 'page.assets.bundle', 'pageAssetBundle', params))
    .register('tab_page_assets_list', async (params) => runNativeBrowserAction(deps, 'page.assets', 'tab_page_assets_list', params))
    .register('tab_page_assets_bundle', async (params) => runNativeBrowserAction(deps, 'page.assets.bundle', 'tab_page_assets_bundle', params))
    .register('tab.capabilities.pageAssets.list', async (params) => runNativeBrowserAction(deps, 'page.assets', 'tab.capabilities.pageAssets.list', params))
    .register('tab.capabilities.pageAssets.bundle', async (params) => runNativeBrowserAction(deps, 'page.assets.bundle', 'tab.capabilities.pageAssets.bundle', params))
    .register('tab.consoleLogs', async (params) => runNativeBrowserAction(deps, 'page.consoleLogs', 'tab.consoleLogs', params))
    .register('tab_console_logs', async (params) => runNativeBrowserAction(deps, 'page.consoleLogs', 'tab_console_logs', params))
    .register('executeUnhandledCommand', async (params) => {
      const normalized = normalize('executeUnhandledCommand', params);
      await deps.runBrowserAction({ type: 'command.unsupported', ...normalized }, normalized.sessionId);
      throw unsupportedBrowserCommandError(normalized);
    });
  return router;
}

function runNativeBrowserAction(deps, type, method, params = {}) {
  const normalized = normalizeNativeMethodParams(method, params);
  return deps.runBrowserAction({ type, ...normalized }, normalized.sessionId);
}

function callMcpTool(deps, params = {}) {
  const name = String(params.name || params.toolName || params.tool || '').trim();
  if (!name) throw new Error('tools/call requires name');
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : (params.args || {});
  const normalizedArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return deps.runBrowserAction({
    ...normalizedArgs,
    type: name,
  }, params.sessionId || normalizedArgs.sessionId || '');
}

export function createLocalCommandActionRouter(deps = {}) {
  const router = createCommandRouter({ unsupportedKind: 'browser data AI command action', source: 'localCommand', onRoute: deps.onRoute });
  const runBrowserAction = (type, payload, session) => deps.runBrowserAction({ type, ...payload }, session);
  router
    .register('open.url', async ({ payload }) => deps.openUrl(payload.url, {
      active: payload.active !== false,
      waitUntilComplete: payload.waitUntilComplete !== false,
    }))
    .register('ping', async ({ payload, session }) => runBrowserAction('browser.ping', payload, session))
    .register('getInfo', async ({ payload, session }) => runBrowserAction('browser.info', payload, session))
    .register('browser.capabilities', async ({ payload, session }) => runBrowserAction('browser.capabilities', payload, session))
    .register('research.run', async ({ payload, session }) => runBrowserAction('research.run', payload, session))
    .register('capabilities.get', async ({ payload, session }) => runBrowserAction('browser.capabilities', payload, session))
    .register('getCapabilities', async ({ payload, session }) => runBrowserAction('browser.capabilities', payload, session))
    .register('native.status', async () => deps.getNativeStatus())
    .register('GET_NATIVE_HOST_STATUS', async () => deps.getNativeStatus())
    .register('native.connect', async ({ payload }) => ({ success: true, status: await deps.connectNativeTransport({ force: true, hostName: payload.hostName }) }))
    .register('native.disconnect', async ({ payload }) => {
      await deps.disconnectNativeTransport(payload.reason || 'command_disconnect');
      const status = deps.getNativeStatus();
      return { success: true, status: status.status || status };
    })
    .register('native.request', async ({ payload }) => deps.requestNativeCommand(payload))
    .register('nameSession', async ({ payload, session }) => runBrowserAction('session.name', payload, session))
    .register('turnEnded', async ({ payload, session }) => runBrowserAction('turn.ended', payload, session))
    .register('createTab', async ({ payload, session }) => runBrowserAction('tab.create', payload, session))
    .register('window.create', async ({ payload, session }) => runBrowserAction('window.create', payload, session))
    .register('browser.windowCreate', async ({ payload, session }) => runBrowserAction('window.create', payload, session))
    .register('createWindow', async ({ payload, session }) => runBrowserAction('window.create', payload, session))
    .register('claimUserTab', async ({ payload, session }) => runBrowserAction('tab.claim', payload, session))
    .register('activateTab', async ({ payload, session }) => runBrowserAction('tab.activate', payload, session))
    .register('focusTab', async ({ payload, session }) => runBrowserAction('tab.activate', payload, session))
    .register('tab.activate', async ({ payload, session }) => runBrowserAction('tab.activate', payload, session))
    .register('navigateTab', async ({ payload, session }) => runBrowserAction('tab.navigate', payload, session))
    .register('tab.navigate', async ({ payload, session }) => runBrowserAction('tab.navigate', payload, session))
    .register('page.navigate', async ({ payload, session }) => runBrowserAction('page.navigate', payload, session))
    .register('page.goto', async ({ payload, session }) => runBrowserAction('page.navigate', payload, session))
    .register('reloadTab', async ({ payload, session }) => runBrowserAction('tab.reload', payload, session))
    .register('tab.reload', async ({ payload, session }) => runBrowserAction('tab.reload', payload, session))
    .register('page.waitForLoadState', async ({ payload, session }) => runBrowserAction('page.waitForLoadState', payload, session))
    .register('page.waitReady', async ({ payload, session }) => runBrowserAction('page.waitReady', payload, session))
    .register('waitForPage', async ({ payload, session }) => runBrowserAction('page.waitReady', payload, session))
    .register('waitTabReady', async ({ payload, session }) => runBrowserAction('page.waitReady', payload, session))
    .register('closeTab', async ({ payload, session }) => runBrowserAction('tab.close', payload, session))
    .register('tab.close', async ({ payload, session }) => runBrowserAction('tab.close', payload, session))
    .register('tab.remove', async ({ payload, session }) => runBrowserAction('tab.close', payload, session))
    .register('finalizeTabs', async ({ payload, session }) => runBrowserAction('tabs.finalize', payload, session))
    .register('read.activeTab', async ({ command, payload }) => deps.captureActiveTab({ commandId: command.id, store: payload.store === true, options: payload.options || {} }))
    .register('read.url', async ({ command, payload }) => deps.captureUrl(payload.url, {
      commandId: command.id,
      store: payload.store === true,
      active: payload.active !== false,
      options: payload.options || {},
    }))
    .register('capture.activeTab', async ({ command, payload }) => deps.captureActiveTab(buildCapturePayload(command, payload)))
    .register('extract.activeTab', async ({ command, payload }) => deps.captureActiveTab(buildCapturePayload(command, payload)))
    .register('capture.tab', async ({ command, payload }) => deps.captureTabById(payload.tabId, buildCapturePayload(command, payload)))
    .register('extract.tab', async ({ command, payload }) => deps.captureTabById(payload.tabId, buildCapturePayload(command, payload)))
    .register('capture.url', async ({ command, payload }) => deps.captureUrl(payload.url, { ...buildCapturePayload(command, payload), active: payload.active !== false }))
    .register('extract.url', async ({ command, payload }) => deps.captureUrl(payload.url, { ...buildCapturePayload(command, payload), active: payload.active !== false }))
    .register('openAndExtract.url', async ({ command, payload }) => deps.captureUrl(payload.url, { ...buildCapturePayload(command, payload), active: payload.active !== false }))
    .register('scroll.activeTab', async ({ payload }) => deps.scrollActiveTab(payload.options || payload))
    .register('scroll.tab', async ({ payload }) => deps.scrollTabById(payload.tabId, payload.options || payload))
    .register('scroll.url', async ({ payload }) => deps.scrollUrl(payload.url, payload.options || payload))
    .register('click.activeTab', async ({ payload }) => deps.clickActiveTab(payload.options || payload))
    .register('click.tab', async ({ payload }) => deps.clickTabById(payload.tabId, payload.options || payload))
    .register('click.url', async ({ payload }) => deps.clickUrl(payload.url, payload.options || payload))
    .register('type.activeTab', async ({ payload }) => deps.typeActiveTab(payload.options || payload))
    .register('type.tab', async ({ payload }) => deps.typeTabById(payload.tabId, payload.options || payload))
    .register('type.url', async ({ payload }) => deps.typeUrl(payload.url, payload.options || payload))
    .register('screenshot.activeTab', async ({ payload }) => deps.screenshotActiveTab(payload.options || payload))
    .register('screenshot.tab', async ({ payload }) => deps.screenshotTabById(payload.tabId, payload.options || payload))
    .register('screenshot.url', async ({ payload }) => deps.screenshotUrl(payload.url, payload.options || payload))
    .register('screenshot.cdp', async ({ payload, session }) => runBrowserAction('cdp.screenshot', payload, session))
    .register('wait.activeTab', async ({ payload }) => deps.waitActiveTab(payload.options || payload))
    .register('wait.tab', async ({ payload }) => deps.waitTabById(payload.tabId, payload.options || payload))
    .register('wait.url', async ({ payload }) => deps.waitUrl(payload.url, payload.options || payload))
    .register('page.assets', async ({ payload, session }) => runBrowserAction('page.assets', payload, session))
    .register('assets.page', async ({ payload, session }) => runBrowserAction('page.assets', payload, session))
    .register('pageAssets', async ({ payload, session }) => runBrowserAction('page.assets', payload, session))
    .register('tab_page_assets_list', async ({ payload, session }) => runBrowserAction('page.assets', payload, session))
    .register('tab.capabilities.pageAssets.list', async ({ payload, session }) => runBrowserAction('page.assets', payload, session))
    .register('page.assets.bundle', async ({ payload, session }) => runBrowserAction('page.assets.bundle', payload, session))
    .register('assets.bundle', async ({ payload, session }) => runBrowserAction('page.assets.bundle', payload, session))
    .register('pageAssetBundle', async ({ payload, session }) => runBrowserAction('page.assets.bundle', payload, session))
    .register('tab_page_assets_bundle', async ({ payload, session }) => runBrowserAction('page.assets.bundle', payload, session))
    .register('tab.capabilities.pageAssets.bundle', async ({ payload, session }) => runBrowserAction('page.assets.bundle', payload, session))
    .register('page.frames', async ({ payload, session }) => runBrowserAction('page.frames', payload, session))
    .register('frames.list', async ({ payload, session }) => runBrowserAction('page.frames', payload, session))
    .register('getPageFrames', async ({ payload, session }) => runBrowserAction('page.frames', payload, session))
    .register('page.hover', async ({ payload, session }) => runBrowserAction('page.hover', payload, session))
    .register('page.click', async ({ payload, session }) => runBrowserAction('page.click', payload, session))
    .register('page.doubleClick', async ({ payload, session }) => runBrowserAction('page.doubleClick', payload, session))
    .register('page.inspectPoint', async ({ payload, session }) => runBrowserAction('page.inspectPoint', payload, session))
    .register('page.hitTest', async ({ payload, session }) => runBrowserAction('page.hitTest', payload, session))
    .register('page.clickNode', async ({ payload, session }) => runBrowserAction('page.clickNode', payload, session))
    .register('node.click', async ({ payload, session }) => runBrowserAction('node.click', payload, session))
    .register('page.scrollNode', async ({ payload, session }) => runBrowserAction('page.scrollNode', payload, session))
    .register('node.scroll', async ({ payload, session }) => runBrowserAction('node.scroll', payload, session))
    .register('page.waitForNode', async ({ payload, session }) => runBrowserAction('page.waitForNode', payload, session))
    .register('node.wait', async ({ payload, session }) => runBrowserAction('node.wait', payload, session))
    .register('page.waitForSelector', async ({ payload, session }) => runBrowserAction('page.waitForSelector', payload, session))
    .register('page.waitSelector', async ({ payload, session }) => runBrowserAction('page.waitSelector', payload, session))
    .register('page.check', async ({ payload, session }) => runBrowserAction('page.check', payload, session))
    .register('page.setChecked', async ({ payload, session }) => runBrowserAction('page.setChecked', payload, session))
    .register('page.isChecked', async ({ payload, session }) => runBrowserAction('page.isChecked', payload, session))
    .register('page.isVisible', async ({ payload, session }) => runBrowserAction('page.isVisible', payload, session))
    .register('page.getValue', async ({ payload, session }) => runBrowserAction('page.getValue', payload, session))
    .register('page.getValues', async ({ payload, session }) => runBrowserAction('page.getValues', payload, session))
    .register('page.getAttribute', async ({ payload, session }) => runBrowserAction('page.getAttribute', payload, session))
    .register('page.queryElements', async ({ payload, session }) => runBrowserAction('page.queryElements', payload, session))
    .register('page.domSnapshot', async ({ payload, session }) => runBrowserAction('page.domSnapshot', payload, session))
    .register('page.evaluate', async ({ payload, session }) => runBrowserAction('page.evaluate', payload, session))
    .register('page.evaluateScript', async ({ payload, session }) => runBrowserAction('page.evaluate', payload, session))
    .register('page.consoleLogs', async ({ payload, session }) => runBrowserAction('page.consoleLogs', payload, session))
    .register('tab_console_logs', async ({ payload, session }) => runBrowserAction('page.consoleLogs', payload, session))
    .register('tab.consoleLogs', async ({ payload, session }) => runBrowserAction('page.consoleLogs', payload, session))
    .register('page.select', async ({ payload, session }) => runBrowserAction('page.select', payload, session))
    .register('page.readClipboard', async ({ payload, session }) => runBrowserAction('page.readClipboard', payload, session))
    .register('clipboard.read', async ({ payload, session }) => runBrowserAction('clipboard.read', payload, session))
    .register('page.writeClipboard', async ({ payload, session }) => runBrowserAction('page.writeClipboard', payload, session))
    .register('clipboard.write', async ({ payload, session }) => runBrowserAction('clipboard.write', payload, session))
    .register('page.waitForFileChooser', async ({ payload, session }) => runBrowserAction('page.waitForFileChooser', payload, session))
    .register('page.acceptFileChooser', async ({ payload, session }) => runBrowserAction('page.acceptFileChooser', payload, session))
    .register('fileChooser.accept', async ({ payload, session }) => runBrowserAction('fileChooser.accept', payload, session))
    .register('page.setInputFiles', async ({ payload, session }) => runBrowserAction('page.setInputFiles', payload, session))
    .register('fileChooser.snapshot', async ({ payload, session }) => runBrowserAction('fileChooser.snapshot', payload, session))
    .register('download.wait', async ({ payload }) => deps.waitForDownload(payload.options || payload))
    .register('browser.events', async ({ payload, session }) => runBrowserAction('browser.events', payload, session))
    .register('getBrowserEvents', async ({ payload, session }) => runBrowserAction('browser.events', payload, session))
    .register('browser.events.summary', async ({ payload, session }) => runBrowserAction('browser.events.summary', payload, session))
    .register('events.summary', async ({ payload, session }) => runBrowserAction('browser.events.summary', payload, session))
    .register('getBrowserEventSummary', async ({ payload, session }) => runBrowserAction('browser.events.summary', payload, session))
    .register('browser.sessionEvents', async ({ payload, session }) => runBrowserAction('browser.sessionEvents', payload, session))
    .register('browser.clientHeartbeat', async ({ payload, session }) => runBrowserAction('browser.clientHeartbeat', payload, session))
    .register('clientHeartbeat', async ({ payload, session }) => runBrowserAction('browser.clientHeartbeat', payload, session))
    .register('lifecycle.status', async ({ payload, session }) => runBrowserAction('lifecycle.status', payload, session))
    .register('browser.lifecycleStatus', async ({ payload, session }) => runBrowserAction('lifecycle.status', payload, session))
    .register('getLifecycleStatus', async ({ payload, session }) => runBrowserAction('lifecycle.status', payload, session))
    .register('sidePanel.status', async ({ payload, session }) => runBrowserAction('sidePanel.status', payload, session))
    .register('sidepanel.status', async ({ payload, session }) => runBrowserAction('sidePanel.status', payload, session))
    .register('getSidePanelStatus', async ({ payload, session }) => runBrowserAction('sidePanel.status', payload, session))
    .register('sidePanel.open', async ({ payload, session }) => runBrowserAction('sidePanel.open', payload, session))
    .register('sidepanel.open', async ({ payload, session }) => runBrowserAction('sidePanel.open', payload, session))
    .register('openSidePanel', async ({ payload, session }) => runBrowserAction('sidePanel.open', payload, session))
    .register('sidePanel.close', async ({ payload, session }) => runBrowserAction('sidePanel.close', payload, session))
    .register('sidepanel.close', async ({ payload, session }) => runBrowserAction('sidePanel.close', payload, session))
    .register('closeSidePanel', async ({ payload, session }) => runBrowserAction('sidePanel.close', payload, session))
    .register('sidePanel.toggle', async ({ payload, session }) => runBrowserAction('sidePanel.toggle', payload, session))
    .register('sidepanel.toggle', async ({ payload, session }) => runBrowserAction('sidePanel.toggle', payload, session))
    .register('toggleSidePanel', async ({ payload, session }) => runBrowserAction('sidePanel.toggle', payload, session))
    .register('session.tabs', async ({ payload, session }) => runBrowserAction('session.tabs', payload, session))
    .register('getSessionTabs', async ({ payload, session }) => runBrowserAction('session.tabs', payload, session))
    .register('tabLeases.list', async ({ payload, session }) => runBrowserAction('tabLeases.list', payload, session))
    .register('tabs.leases', async ({ payload, session }) => runBrowserAction('tabLeases.list', payload, session))
    .register('getTabLeases', async ({ payload, session }) => runBrowserAction('tabLeases.list', payload, session))
    .register('tab.lifecycleEvents', async ({ payload, session }) => runBrowserAction('tab.lifecycleEvents', payload, session))
    .register('tabs.lifecycleEvents', async ({ payload, session }) => runBrowserAction('tab.lifecycleEvents', payload, session))
    .register('tabLifecycle.events', async ({ payload, session }) => runBrowserAction('tab.lifecycleEvents', payload, session))
    .register('getTabLifecycleEvents', async ({ payload, session }) => runBrowserAction('tab.lifecycleEvents', payload, session))
    .register('tab.lifecycleSnapshot', async ({ payload, session }) => runBrowserAction('tab.lifecycleSnapshot', payload, session))
    .register('tabs.lifecycleSnapshot', async ({ payload, session }) => runBrowserAction('tab.lifecycleSnapshot', payload, session))
    .register('tabLifecycle.snapshot', async ({ payload, session }) => runBrowserAction('tab.lifecycleSnapshot', payload, session))
    .register('getTabLifecycleSnapshot', async ({ payload, session }) => runBrowserAction('tab.lifecycleSnapshot', payload, session))
    .register('viewport.set', async ({ payload }) => deps.setViewport(payload.options || payload))
    .register('browser_viewport_set', async ({ payload, session }) => runBrowserAction('viewport.set', payload, session))
    .register('viewport.reset', async ({ payload }) => deps.resetViewport(payload.options || payload))
    .register('browser_viewport_reset', async ({ payload, session }) => runBrowserAction('viewport.reset', payload, session))
    .register('viewport.cdpSet', async ({ payload, session }) => runBrowserAction('cdp.viewportSet', payload, session))
    .register('cdp.viewportSet', async ({ payload, session }) => runBrowserAction('cdp.viewportSet', payload, session))
    .register('viewport.cdpReset', async ({ payload, session }) => runBrowserAction('cdp.viewportReset', payload, session))
    .register('cdp.viewportReset', async ({ payload, session }) => runBrowserAction('cdp.viewportReset', payload, session))
    .register('viewport.state', async ({ payload, session }) => runBrowserAction('viewport.state', payload, session))
    .register('cdp.viewportState', async ({ payload, session }) => runBrowserAction('viewport.state', payload, session))
    .register('getViewportState', async ({ payload, session }) => runBrowserAction('viewport.state', payload, session))
    .register('browser.visibility.get', async ({ payload, session }) => runBrowserAction('browser.visibility.get', payload, session))
    .register('browser_visibility_get', async ({ payload, session }) => runBrowserAction('browser.visibility.get', payload, session))
    .register('getBrowserVisibility', async ({ payload, session }) => runBrowserAction('browser.visibility.get', payload, session))
    .register('browser.visibility.set', async ({ payload, session }) => runBrowserAction('browser.visibility.set', payload, session))
    .register('browser_visibility_set', async ({ payload, session }) => runBrowserAction('browser.visibility.set', payload, session))
    .register('setBrowserVisibility', async ({ payload, session }) => runBrowserAction('browser.visibility.set', payload, session))
    .register('webmcp.listTools', async ({ payload, session }) => runBrowserAction('webmcp.listTools', payload, session))
    .register('webmcp_list_tools', async ({ payload, session }) => runBrowserAction('webmcp.listTools', payload, session))
    .register('tab.capabilities.webmcp.listTools', async ({ payload, session }) => runBrowserAction('webmcp.listTools', payload, session))
    .register('listWebMcpTools', async ({ payload, session }) => runBrowserAction('webmcp.listTools', payload, session))
    .register('webmcp.invokeTool', async ({ payload, session }) => runBrowserAction('webmcp.invokeTool', payload, session))
    .register('webmcp_invoke_tool', async ({ payload, session }) => runBrowserAction('webmcp.invokeTool', payload, session))
    .register('tab.capabilities.webmcp.invokeTool', async ({ payload, session }) => runBrowserAction('webmcp.invokeTool', payload, session))
    .register('invokeWebMcpTool', async ({ payload, session }) => runBrowserAction('webmcp.invokeTool', payload, session))
    .register('browser.action', async ({ payload, session }) => deps.runBrowserAction(payload.action || payload, session))
    .register('cdp.attach', async ({ payload, session }) => runBrowserAction('cdp.attach', payload, session))
    .register('attach', async ({ payload, session }) => runBrowserAction('cdp.attach', payload, session))
    .register('attachTarget', async ({ payload, session }) => runBrowserAction('cdp.attach', { targetId: payload.targetId || payload.id, ...payload }, session))
    .register('cdp.detach', async ({ payload, session }) => runBrowserAction('cdp.detach', payload, session))
    .register('detach', async ({ payload, session }) => runBrowserAction('cdp.detach', payload, session))
    .register('detachTarget', async ({ payload, session }) => runBrowserAction('cdp.detach', { targetId: payload.targetId || payload.id, ...payload }, session))
    .register('cdp.send', async ({ payload, session }) => runBrowserAction('cdp.send', payload, session))
    .register('executeCdp', async ({ payload, session }) => runBrowserAction('cdp.send', payload, session))
    .register('cdp.targets', async ({ payload, session }) => runBrowserAction('cdp.targets', payload, session))
    .register('target.list', async ({ payload, session }) => runBrowserAction('cdp.targets', payload, session))
    .register('cdp.events', async ({ payload, session }) => runBrowserAction('cdp.events', payload, session))
    .register('cdp.events.summary', async ({ payload, session }) => runBrowserAction('cdp.events.summary', payload, session))
    .register('getCdpEventSummary', async ({ payload, session }) => runBrowserAction('cdp.events.summary', payload, session))
    .register('cdp.attachments', async ({ payload, session }) => runBrowserAction('cdp.attachments', payload, session))
    .register('cdp.attachedTargets', async ({ payload, session }) => runBrowserAction('cdp.attachments', payload, session))
    .register('getCdpAttachments', async ({ payload, session }) => runBrowserAction('cdp.attachments', payload, session))
    .register('mouse.move', async ({ payload, session }) => runBrowserAction('input.mouseMove', payload, session))
    .register('moveMouse', async ({ payload, session }) => runBrowserAction('input.mouseMove', payload, session))
    .register('mouse.click', async ({ payload, session }) => runBrowserAction('input.mouseClick', payload, session))
    .register('mouse.drag', async ({ payload, session }) => runBrowserAction('input.mouseDrag', payload, session))
    .register('input.mouseDrag', async ({ payload, session }) => runBrowserAction('input.mouseDrag', payload, session))
    .register('mouse.wheel', async ({ payload, session }) => runBrowserAction('input.mouseWheel', payload, session))
    .register('input.mouseWheel', async ({ payload, session }) => runBrowserAction('input.mouseWheel', payload, session))
    .register('keyboard.type', async ({ payload, session }) => runBrowserAction('input.keyboardType', payload, session))
    .register('keyboard.press', async ({ payload, session }) => runBrowserAction('input.keyboardPress', payload, session))
    .register('keyboard.combo', async ({ payload, session }) => runBrowserAction('input.keyboardCombo', payload, session))
    .register('input.keyboardCombo', async ({ payload, session }) => runBrowserAction('input.keyboardCombo', payload, session))
    .register('cursor.move', async ({ payload, session }) => runBrowserAction('cursor.move', payload, session))
    .register('cursor.hide', async ({ payload, session }) => runBrowserAction('cursor.hide', payload, session))
    .register('tabs.list', async ({ payload, session }) => runBrowserAction('tabs.list', payload, session))
    .register('getUserTabs', async ({ payload, session }) => runBrowserAction('tabs.list', payload, session))
    .register('getTabs', async ({ payload, session }) => runBrowserAction('session.tabs', payload, session))
    .register('windows.list', async ({ payload, session }) => runBrowserAction('windows.list', payload, session))
    .register('browser.windows', async ({ payload, session }) => runBrowserAction('windows.list', payload, session))
    .register('getWindows', async ({ payload, session }) => runBrowserAction('windows.list', payload, session))
    .register('tabs.finalizedBadges', async ({ payload, session }) => runBrowserAction('tabs.finalizedBadges', payload, session))
    .register('managedTabGroups.list', async ({ payload, session }) => runBrowserAction('managedTabGroups.list', payload, session))
    .register('tabGroups.managed', async ({ payload, session }) => runBrowserAction('tabGroups.managed', payload, session))
    .register('getManagedTabGroups', async ({ payload, session }) => runBrowserAction('managedTabGroups.list', payload, session))
    .register('activeTabObserver.snapshot', async ({ payload, session }) => runBrowserAction('activeTabObserver.snapshot', payload, session))
    .register('activeTabs.snapshot', async ({ payload, session }) => runBrowserAction('activeTabObserver.snapshot', payload, session))
    .register('getActiveTabObserverSnapshot', async ({ payload, session }) => runBrowserAction('activeTabObserver.snapshot', payload, session))
    .register('history.search', async ({ payload, session }) => runBrowserAction('history.search', payload, session))
    .register('getUserHistory', async ({ payload, session }) => runBrowserAction('history.search', payload, session))
    .register('bookmarks.list', async ({ payload, session }) => runBrowserAction('bookmarks.list', payload, session))
    .register('getUserBookmarks', async ({ payload, session }) => runBrowserAction('bookmarks.list', payload, session))
    .register('topSites.list', async ({ payload, session }) => runBrowserAction('topSites.list', payload, session))
    .register('getUserTopSites', async ({ payload, session }) => runBrowserAction('topSites.list', payload, session))
    .register('readingList.list', async ({ payload, session }) => runBrowserAction('readingList.list', payload, session))
    .register('getUserReadingList', async ({ payload, session }) => runBrowserAction('readingList.list', payload, session))
    .register('sessions.recentlyClosed', async ({ payload, session }) => runBrowserAction('sessions.recentlyClosed', payload, session))
    .register('getUserSessions', async ({ payload, session }) => runBrowserAction('sessions.recentlyClosed', payload, session))
    .register('sessions.devices', async ({ payload, session }) => runBrowserAction('sessions.devices', payload, session))
    .register('browser.context', async ({ payload, session }) => runBrowserAction('browser.context', payload, session))
    .register('userBrowser.context', async ({ payload, session }) => runBrowserAction('browser.context', payload, session))
    .register('getUserBrowserContext', async ({ payload, session }) => runBrowserAction('browser.context', payload, session))
    .register('download.events', async ({ payload, session }) => runBrowserAction('download.events', payload, session))
    .register('download.state', async ({ payload, session }) => runBrowserAction('download.state', payload, session))
    .register('downloads.state', async ({ payload, session }) => runBrowserAction('download.state', payload, session))
    .register('getDownloadState', async ({ payload, session }) => runBrowserAction('download.state', payload, session))
    .register('downloads.search', async ({ payload, session }) => runBrowserAction('downloads.search', payload, session));
  return router;
}

export function commandRouterErrorEnvelope(error) {
  return {
    code: error?.code || -32000,
    message: describeError(error),
  };
}

function buildCapturePayload(command, payload) {
  return {
    commandId: command.id,
    store: payload.store !== false,
    aiInstruction: payload.aiInstruction || payload.instruction || '',
    schema: payload.schema || null,
    options: payload.options || {},
  };
}

function unsupportedCommandError(method, kind = 'native method') {
  const error = new Error(`Unsupported ${kind}: ${method}`);
  error.code = -32601;
  error.method = method;
  return error;
}

function normalizeMethod(method) {
  return String(method || '').trim();
}

function publishRouteEvent(onRoute, event) {
  if (!onRoute) return;
  void Promise.resolve(onRoute(event)).catch(() => {});
}

function listParamKeys(params = {}) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params).slice(0, 20);
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
