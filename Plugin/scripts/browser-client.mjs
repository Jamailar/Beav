#!/usr/bin/env node

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(pluginRoot, 'docs');
const defaultEndpointStatePath = process.env.REDBOX_BROWSER_CONTROL_ENDPOINT_STATE
  || path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-agent-endpoint.json');
const defaultEndpointsDirectory = process.env.REDBOX_BROWSER_CONTROL_ENDPOINTS_DIRECTORY
  || path.join(path.dirname(defaultEndpointStatePath), 'browser-control-agent-endpoints');
const defaultSocketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\redbox-browser-control'
  : path.join(os.tmpdir(), `redbox-browser-control-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.sock`);
const defaultTimeoutMs = Number(process.env.REDBOX_BROWSER_CONTROL_CLIENT_TIMEOUT_MS || 30_000);

const documentationAliases = new Map([
  ['api', 'browser-runtime'],
  ['browser', 'browser-runtime'],
  ['browser-runtime', 'browser-runtime'],
  ['chrome-troubleshooting', 'browser-troubleshooting'],
  ['troubleshooting', 'browser-troubleshooting'],
  ['browser-troubleshooting', 'browser-troubleshooting'],
  ['playwright', 'browser-playwright'],
]);

export async function setupBrowserRuntime(options = {}) {
  const globals = options.globals || globalThis;
  const runtime = new BrowserRuntime({
    transport: options.transport || new BrowserControlTransport(options),
    documentationRoot: options.documentationRoot || docsRoot,
    sessionId: options.sessionId,
    turnId: options.turnId,
  });
  const agent = {
    ...(isObject(globals.agent) ? globals.agent : {}),
    browsers: runtime.browsers,
    documentation: runtime.documentation,
  };
  globals.agent = agent;
  globals.redboxBrowserRuntime = runtime;
  return agent;
}

export class BrowserControlTransport {
  constructor(options = {}) {
    this.socketPath = options.socketPath || '';
    this.endpointStatePath = options.endpointStatePath || defaultEndpointStatePath;
    this.endpointsDirectory = options.endpointsDirectory || defaultEndpointsDirectory;
    this.browserId = String(options.browserId || options.instanceId || options.extensionInstanceId || '').trim();
    this.timeoutMs = Number(options.timeoutMs || defaultTimeoutMs);
  }

  async listEndpoints() {
    const explicit = this.socketPath || process.env.REDBOX_BROWSER_CONTROL_SOCKET;
    if (explicit) return [{ socketPath: explicit, id: 'explicit', source: 'explicit' }];
    const descriptors = [];
    try {
      const entries = await fs.readdir(this.endpointsDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const state = JSON.parse(await fs.readFile(path.join(this.endpointsDirectory, entry.name), 'utf8'));
          if (isEndpointDescriptor(state)) descriptors.push({ ...state, source: 'registry' });
        } catch {}
      }
    } catch {}
    try {
      const state = JSON.parse(await fs.readFile(this.endpointStatePath, 'utf8'));
      if (isEndpointDescriptor(state) && !descriptors.some((entry) => entry.socketPath === state.socketPath)) {
        descriptors.push({ ...state, source: 'legacy' });
      }
    } catch {}
    if (!descriptors.length) descriptors.push({ socketPath: defaultSocketPath, id: 'legacy-default', source: 'legacy-default' });
    return descriptors.sort(compareEndpointDescriptors);
  }

  async resolveEndpoint() {
    if (this.socketPath) return this.socketPath;
    if (process.env.REDBOX_BROWSER_CONTROL_SOCKET) return process.env.REDBOX_BROWSER_CONTROL_SOCKET;
    const endpoints = await this.listEndpoints();
    const requested = this.browserId;
    const selected = requested
      ? endpoints.find((endpoint) => endpoint.instanceId === requested
        || endpoint.extension?.extensionInstanceId === requested
        || endpoint.extensionInstanceId === requested)
      : endpoints[0];
    if (!selected?.socketPath) {
      throw new Error(`Browser instance is not available: ${requested}`);
    }
    return selected;
  }

  async resolveSocketPath() {
    const endpoint = await this.resolveEndpoint();
    return typeof endpoint === 'string' ? endpoint : endpoint.socketPath;
  }

  async request(method, params = {}, options = {}) {
    const response = await sendSocketJsonRpc(await this.resolveSocketPath(), {
      jsonrpc: '2.0',
      id: options.id || `browser-client:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    }, Number(options.timeoutMs || this.timeoutMs));
    if (response.error) {
      const error = new Error(response.error.message || JSON.stringify(response.error));
      error.code = response.error.code;
      error.data = response.error.data;
      throw error;
    }
    return response.result;
  }

  async hostInfo(options = {}) {
    return await this.request('host.getInfo', {}, options);
  }

  async listTools(options = {}) {
    const result = await this.request('tools/list', {}, options);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}, options = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('callTool requires a tool name');
    return await this.request('tools/call', {
      name,
      arguments: isObject(args) ? args : {},
    }, options);
  }

  withBrowser(browserId) {
    return new BrowserControlTransport({
      endpointStatePath: this.endpointStatePath,
      endpointsDirectory: this.endpointsDirectory,
      browserId,
      timeoutMs: this.timeoutMs,
    });
  }

  withSocketPath(socketPath) {
    return new BrowserControlTransport({
      socketPath,
      endpointStatePath: this.endpointStatePath,
      endpointsDirectory: this.endpointsDirectory,
      timeoutMs: this.timeoutMs,
    });
  }
}

class BrowserRuntime {
  constructor(options) {
    this.transport = options.transport;
    this.documentationRoot = options.documentationRoot;
    this.sessionId = options.sessionId || `redbox-browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.turnId = options.turnId || `turn-${Date.now().toString(36)}`;
    this.documentation = new BrowserDocumentation(this.documentationRoot);
    this.browsers = new BrowserCollection(this);
  }

  scopedArgs(args = {}) {
    return {
      ...(isObject(args) ? args : {}),
      sessionId: this.sessionId,
      turnId: this.turnId,
    };
  }

  async callTool(name, args = {}, options = {}) {
    return await this.transport.callTool(name, this.scopedArgs(args), options);
  }

  withBrowser(browserId) {
    return new BrowserRuntime({
      transport: typeof this.transport.withBrowser === 'function'
        ? this.transport.withBrowser(browserId)
        : this.transport,
      documentationRoot: this.documentationRoot,
      sessionId: this.sessionId,
      turnId: this.turnId,
    });
  }

  withSocketPath(socketPath) {
    return new BrowserRuntime({
      transport: typeof this.transport.withSocketPath === 'function'
        ? this.transport.withSocketPath(socketPath)
        : this.transport,
      documentationRoot: this.documentationRoot,
      sessionId: this.sessionId,
      turnId: this.turnId,
    });
  }
}

class BrowserDocumentation {
  constructor(root) {
    this.root = root;
  }

  async get(name) {
    const normalized = documentationAliases.get(String(name || '').trim()) || String(name || '').trim();
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(normalized)) {
      throw new Error('Documentation name must be a relative path without an extension');
    }
    return await fs.readFile(path.join(this.root, `${normalized}.md`), 'utf8');
  }
}

class BrowserCollection {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async list() {
    const endpoints = await this.runtime.transport.listEndpoints();
    const browsers = await Promise.all(endpoints.map(async (endpoint) => {
      const transport = new BrowserControlTransport({
        socketPath: endpoint.socketPath,
        timeoutMs: this.runtime.transport.timeoutMs,
      });
      try {
        const [host, info, tools] = await Promise.all([
          transport.hostInfo(),
          transport.callTool('browser.info', this.runtime.scopedArgs({})),
          transport.listTools(),
        ]);
        const data = unwrapActionData(info);
        const extensionInstanceId = data?.extensionInstanceId || host?.extension?.extensionInstanceId || endpoint.extension?.extensionInstanceId || '';
        const id = extensionInstanceId || host?.instanceId || endpoint.instanceId || endpoint.socketPath;
        return {
          id,
          name: data?.name || 'RedBox Browser Control',
          type: 'extension',
          metadata: {
            backend: 'native-host',
            hostInstanceId: host?.instanceId || endpoint.instanceId || '',
            socketPath: endpoint.socketPath,
            extensionId: data?.extensionId || host?.extension?.extensionId || '',
            extensionInstanceId,
            sessionId: this.runtime.sessionId,
            nativeConnected: String(data?.nativeHost?.connected ?? data?.connected ?? host?.nativeConnected ?? ''),
          },
          capabilities: {
            browser: buildCapabilityList(data?.capabilities?.browser || data?.contracts || []),
            tab: buildCapabilityList(tools),
          },
        };
      } catch {
        return null;
      }
    }));
    return browsers.filter(Boolean);
  }

  async get(id) {
    const requested = String(id || '').trim();
    const browsers = await this.list();
    const browser = !requested || ['extension', 'chrome', 'browser', 'redbox'].includes(requested)
      ? browsers[0]
      : browsers.find((entry) => entry.id === requested || entry.metadata?.hostInstanceId === requested);
    if (!browser) throw new Error(`Browser is not available: ${requested || 'extension'}`);
    return new BrowserFacade(this.runtime.withSocketPath(browser.metadata.socketPath), browser);
  }
}

class BrowserFacade {
  constructor(runtime, info) {
    this.runtime = runtime;
    this.browserId = info.id;
    this.id = info.id;
    this.name = info.name;
    this.type = info.type;
    this.info = info;
    this.capabilities = new CapabilityCollection(() => this.runtime.transport.listTools());
    this.tabs = new TabsFacade(runtime);
    this.user = new BrowserUserFacade(runtime);
  }

  async documentation() {
    return await this.runtime.documentation.get('browser-runtime');
  }

  async nameSession(name) {
    await this.runtime.callTool('session.name', { name: String(name || '').trim() });
  }

  async executeUnhandledCommand(command) {
    return await this.runtime.transport.request('executeUnhandledCommand', this.runtime.scopedArgs(command));
  }

  async research(options = {}) {
    return await this.runtime.callTool('research.run', options);
  }
}

class BrowserUserFacade {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async openTabs(options = {}) {
    const result = await this.runtime.callTool('tabs.list', normalizeLimitOptions(options));
    return normalizeTabList(unwrapActionData(result));
  }

  async claimTab(tab) {
    const tabId = normalizeTabId(tab);
    const result = await this.runtime.callTool('tab.claim', { tabId });
    return new TabFacade(this.runtime, normalizeTabInfo(unwrapActionData(result), tabId));
  }

  async history(options = {}) {
    const result = await this.runtime.callTool('history.search', normalizeLimitOptions(options));
    const data = unwrapActionData(result);
    return data?.history || data?.items || data?.entries || [];
  }
}

class TabsFacade {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async list(options = {}) {
    const result = await this.runtime.callTool('tabs.list', normalizeLimitOptions(options));
    return normalizeTabList(unwrapActionData(result));
  }

  async new(options = {}) {
    const result = await this.runtime.callTool('tab.create', options);
    return new TabFacade(this.runtime, normalizeTabInfo(unwrapActionData(result)));
  }

  async get(id) {
    const tabId = normalizeTabId(id);
    const result = await this.runtime.callTool('tab.info', { tabId });
    return new TabFacade(this.runtime, normalizeTabInfo(unwrapActionData(result), tabId));
  }

  async selected() {
    const result = await this.runtime.callTool('tab.info', { activeOnly: true });
    const info = normalizeTabInfo(unwrapActionData(result));
    return info.id ? new TabFacade(this.runtime, info) : undefined;
  }

  async finalize(options = {}) {
    await this.runtime.callTool('tabs.finalize', { keep: Array.isArray(options.keep) ? options.keep : [] });
  }
}

class TabFacade {
  constructor(runtime, info) {
    this.runtime = runtime;
    this.id = String(info.id || info.tabId || '');
    this.info = info;
    this.capabilities = new CapabilityCollection(() => this.runtime.transport.listTools());
    this.playwright = new PlaywrightFacade(runtime, this.id);
    this.cua = new CuaFacade(runtime, this.id);
    this.dom_cua = new DomCuaFacade(runtime, this.id);
    this.clipboard = new ClipboardFacade(runtime, this.id);
    this.dev = new DevFacade(runtime, this.id);
  }

  async goto(url, options = {}) {
    await this.runtime.callTool('tab.navigate', { tabId: asNumber(this.id), url, ...options });
  }

  async back(options = {}) {
    await this.runtime.callTool('tab.back', { tabId: asNumber(this.id), ...options });
  }

  async forward(options = {}) {
    await this.runtime.callTool('tab.forward', { tabId: asNumber(this.id), ...options });
  }

  async reload(options = {}) {
    await this.runtime.callTool('tab.reload', { tabId: asNumber(this.id), ...options });
  }

  async close() {
    await this.runtime.callTool('tab.close', { tabId: asNumber(this.id) });
  }

  async url() {
    const data = unwrapActionData(await this.runtime.callTool('tab.info', { tabId: asNumber(this.id) }));
    return normalizeTabInfo(data, this.id).url;
  }

  async title() {
    const data = unwrapActionData(await this.runtime.callTool('tab.info', { tabId: asNumber(this.id) }));
    return normalizeTabInfo(data, this.id).title;
  }

  async screenshot(options = {}) {
    const data = unwrapActionData(await this.runtime.callTool('page.screenshot', { tabId: asNumber(this.id), ...options }));
    const value = data?.dataUrl || data?.data || data?.base64 || '';
    return decodeScreenshot(value);
  }
}

class PlaywrightFacade {
  constructor(runtime, tabId, scope = {}) {
    this.runtime = runtime;
    this.tabId = tabId;
    this.scope = scope;
  }

  locator(selector) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.scope, selector });
  }

  getByRole(role, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.scope, role, name: options.name, exact: options.exact });
  }

  getByText(text, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.scope, text, exact: options.exact });
  }

  getByLabel(label, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.scope, label, exact: options.exact });
  }

  getByPlaceholder(placeholder, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.scope, placeholder, exact: options.exact });
  }

  getByTestId(testId) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.scope, testId });
  }

  frameLocator(frameSelector) {
    return new PlaywrightFacade(this.runtime, this.tabId, { ...this.scope, frameSelector });
  }

  async domSnapshot(options = {}) {
    const data = unwrapActionData(await this.runtime.callTool('page.domSnapshot', { tabId: asNumber(this.tabId), ...this.scope, ...options }));
    return typeof data?.snapshot === 'string' ? data.snapshot : JSON.stringify(data, null, 2);
  }

  async evaluate(pageFunction, arg, options = {}) {
    const script = typeof pageFunction === 'function'
      ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
      : String(pageFunction || '');
    const data = unwrapActionData(await this.runtime.callTool('page.evaluate', {
      tabId: asNumber(this.tabId),
      script,
      timeoutMs: options.timeoutMs,
    }));
    return data?.value ?? data?.result ?? data;
  }

  async waitForLoadState(options = {}) {
    await this.runtime.callTool('page.waitForLoadState', { tabId: asNumber(this.tabId), ...options });
  }

  async waitForURL(url, options = {}) {
    await this.runtime.callTool('page.waitForURL', { tabId: asNumber(this.tabId), url, ...options });
  }

  async waitForTimeout(timeoutMs) {
    await this.runtime.callTool('page.waitForTimeout', { tabId: asNumber(this.tabId), timeoutMs });
  }

  async expectNavigation(action, options = {}) {
    const value = await action();
    if (options.url) await this.waitForURL(options.url, options);
    else await this.waitForLoadState(options);
    return value;
  }
}

class LocatorFacade {
  constructor(runtime, tabId, target) {
    this.runtime = runtime;
    this.tabId = tabId;
    this.target = target;
  }

  locator(selector) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, selector });
  }

  getByRole(role, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, role, name: options.name, exact: options.exact });
  }

  getByText(text, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, text, exact: options.exact });
  }

  getByLabel(label, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, label, exact: options.exact });
  }

  getByPlaceholder(placeholder, options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, placeholder, exact: options.exact });
  }

  getByTestId(testId) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, testId });
  }

  filter(options = {}) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, ...options });
  }

  first() {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, first: true });
  }

  last() {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, last: true });
  }

  nth(index) {
    return new LocatorFacade(this.runtime, this.tabId, { ...this.target, nth: index });
  }

  async all() {
    const data = await this.query({ all: true });
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    return elements.map((element, index) => new LocatorFacade(this.runtime, this.tabId, {
      ...this.target,
      nth: index,
      nodeId: element.nodeId || element.id,
    }));
  }

  async count(options = {}) {
    const data = await this.query({ ...options, all: true, mode: 'count' });
    return countQueryResults(data);
  }

  async allTextContents(options = {}) {
    const data = await this.query({ ...options, all: true, mode: 'all' });
    return textContentsFromQueryResults(data);
  }

  async innerText(options = {}) {
    const data = await this.query({ ...options, mode: 'innerText' });
    return String(data?.innerText ?? data?.first?.innerText ?? '');
  }

  async textContent(options = {}) {
    const data = await this.query({ ...options, mode: 'textContent' });
    return data?.textContent ?? data?.first?.textContent ?? null;
  }

  async isEnabled(options = {}) {
    const data = await this.query({ ...options, mode: 'isEnabled' });
    return Boolean(data?.isEnabled ?? data?.first?.enabled);
  }

  async isVisible(options = {}) {
    const data = unwrapActionData(await this.runtime.callTool('page.isVisible', this.args(options)));
    return Boolean(data?.visible ?? data?.isVisible ?? data?.result);
  }

  async getAttribute(attribute, options = {}) {
    const data = unwrapActionData(await this.runtime.callTool('page.getAttribute', this.args({ ...options, attribute })));
    return data?.value ?? data?.attributeValue ?? null;
  }

  async click(options = {}) {
    await this.runtime.callTool('page.click', this.args(options));
  }

  async dblclick(options = {}) {
    await this.runtime.callTool('page.doubleClick', this.args(options));
  }

  async fill(value, options = {}) {
    await this.runtime.callTool('page.type', this.args({ ...options, text: value }));
  }

  async type(value, options = {}) {
    await this.runtime.callTool('page.type', this.args({ ...options, text: value, append: true }));
  }

  async press(value, options = {}) {
    await this.runtime.callTool('input.keyboardPress', this.args({ ...options, key: value }));
  }

  async check(options = {}) {
    await this.runtime.callTool('page.check', this.args(options));
  }

  async uncheck(options = {}) {
    await this.runtime.callTool('page.setChecked', this.args({ ...options, checked: false }));
  }

  async setChecked(checked, options = {}) {
    await this.runtime.callTool('page.setChecked', this.args({ ...options, checked: Boolean(checked) }));
  }

  async selectOption(value, options = {}) {
    await this.runtime.callTool('page.select', this.args({ ...options, value }));
  }

  async waitFor(options = {}) {
    await this.runtime.callTool('page.waitForSelector', this.args(options));
  }

  args(extra = {}) {
    return {
      tabId: asNumber(this.tabId),
      ...this.target,
      ...dropUndefined(extra),
    };
  }

  async query(extra = {}) {
    return unwrapActionData(await this.runtime.callTool('page.queryElements', this.args(extra)));
  }
}

class CuaFacade {
  constructor(runtime, tabId) {
    this.runtime = runtime;
    this.tabId = tabId;
  }

  async move(options) {
    await this.runtime.callTool('input.mouseMove', { tabId: asNumber(this.tabId), ...options });
  }

  async click(options) {
    await this.runtime.callTool('input.mouseClick', { tabId: asNumber(this.tabId), ...options });
  }

  async double_click(options) {
    await this.click({ ...options, clickCount: 2 });
  }

  async drag(options) {
    await this.runtime.callTool('input.mouseDrag', { tabId: asNumber(this.tabId), ...options });
  }

  async scroll(options) {
    await this.runtime.callTool('input.mouseWheel', { tabId: asNumber(this.tabId), ...options });
  }

  async type(options) {
    await this.runtime.callTool('input.keyboardType', { tabId: asNumber(this.tabId), ...options });
  }

  async keypress(options) {
    await this.runtime.callTool('input.keyboardPress', { tabId: asNumber(this.tabId), ...options });
  }
}

class DomCuaFacade {
  constructor(runtime, tabId) {
    this.runtime = runtime;
    this.tabId = tabId;
  }

  async get_visible_dom(options = {}) {
    return unwrapActionData(await this.runtime.callTool('page.domSnapshot', { tabId: asNumber(this.tabId), ...options }));
  }

  async click(options) {
    await this.runtime.callTool('node.click', { tabId: asNumber(this.tabId), ...normalizeNodeOptions(options) });
  }

  async double_click(options) {
    await this.runtime.callTool('node.click', { tabId: asNumber(this.tabId), ...normalizeNodeOptions(options), clickCount: 2 });
  }

  async scroll(options) {
    await this.runtime.callTool(options?.node_id || options?.nodeId ? 'node.scroll' : 'page.scroll', { tabId: asNumber(this.tabId), ...normalizeNodeOptions(options) });
  }

  async type(options) {
    await this.runtime.callTool('input.keyboardType', { tabId: asNumber(this.tabId), ...options });
  }

  async keypress(options) {
    await this.runtime.callTool('input.keyboardPress', { tabId: asNumber(this.tabId), ...options });
  }
}

class ClipboardFacade {
  constructor(runtime, tabId) {
    this.runtime = runtime;
    this.tabId = tabId;
  }

  async read() {
    return unwrapActionData(await this.runtime.callTool('clipboard.read', { tabId: asNumber(this.tabId) }));
  }

  async readText() {
    const data = unwrapActionData(await this.runtime.callTool('clipboard.readText', { tabId: asNumber(this.tabId) }));
    return String(data?.text ?? data?.value ?? '');
  }

  async write(items) {
    await this.runtime.callTool('clipboard.write', { tabId: asNumber(this.tabId), items });
  }

  async writeText(text) {
    await this.runtime.callTool('clipboard.writeText', { tabId: asNumber(this.tabId), text });
  }
}

class DevFacade {
  constructor(runtime, tabId) {
    this.runtime = runtime;
    this.tabId = tabId;
  }

  async logs(options = {}) {
    const data = unwrapActionData(await this.runtime.callTool('page.consoleLogs', { tabId: asNumber(this.tabId), ...options }));
    return data?.logs || data?.items || [];
  }
}

class CapabilityCollection {
  constructor(loader) {
    this.loader = loader;
  }

  async list() {
    return buildCapabilityList(await this.loader());
  }

  async get(id) {
    const capabilities = await this.list();
    const capability = capabilities.find((item) => item.id === id);
    if (!capability) throw new Error(`Capability is not available: ${id}`);
    return {
      id: capability.id,
      description: capability.description,
      documentation: async () => `${capability.id}\n\n${capability.description || 'No documentation available.'}`,
    };
  }
}

function sendSocketJsonRpc(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`browser-control request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
        return;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => clearTimeout(timer));
  });
}

function isEndpointDescriptor(value) {
  return isObject(value) && typeof value.socketPath === 'string' && value.socketPath.trim().length > 0;
}

function compareEndpointDescriptors(left, right) {
  const leftTime = Date.parse(String(left?.updatedAt || '')) || 0;
  const rightTime = Date.parse(String(right?.updatedAt || '')) || 0;
  return rightTime - leftTime || String(left?.instanceId || left?.socketPath || '').localeCompare(String(right?.instanceId || right?.socketPath || ''));
}

function unwrapActionData(value) {
  const action = value?.result ?? value;
  const data = unwrapNestedActionData(action);
  if (data && typeof data === 'object' && (data.success === false || data.ok === false)) {
    const error = new Error(actionDataErrorMessage(data));
    error.data = data;
    throw error;
  }
  return data;
}

function unwrapNestedActionData(action) {
  if (action && typeof action === 'object' && (action.success === false || action.ok === false)) return action;
  if (action?.response && typeof action.response === 'object') return action.response;
  if (action?.result && typeof action.result === 'object') return unwrapNestedActionData(action.result);
  if (action?.data && typeof action.data === 'object') return unwrapNestedActionData(action.data);
  return action?.result ?? action?.data ?? action;
}

function actionDataErrorMessage(data) {
  const message = data.error || data.message || data.reason || data.code || 'Browser action failed';
  return typeof message === 'string' ? message : JSON.stringify(message);
}

function countQueryResults(data) {
  const direct = data?.count ?? data?.totalCount ?? data?.matchedCount ?? data?.returnedCount;
  const number = Number(direct);
  if (Number.isFinite(number)) return number;
  if (Array.isArray(data?.elements)) return data.elements.length;
  if (Array.isArray(data?.values)) return data.values.length;
  return 0;
}

function textContentsFromQueryResults(data) {
  const direct = data?.allTextContents || data?.textContents || data?.allInnerTexts || data?.innerTexts;
  if (Array.isArray(direct)) return direct.map((item) => String(item ?? ''));
  const values = Array.isArray(data?.values) ? data.values : (Array.isArray(data?.elements) ? data.elements : []);
  return values
    .map((item) => item?.textContent ?? item?.text_content ?? item?.innerText ?? item?.inner_text ?? item?.text ?? '')
    .map((item) => String(item ?? ''));
}

function normalizeTabList(data) {
  const tabs = data?.tabs || data?.items || data?.result?.tabs || [];
  return Array.isArray(tabs) ? tabs.map((tab) => normalizeTabInfo(tab)).filter((tab) => tab.id) : [];
}

function normalizeTabInfo(data, fallbackId = '') {
  const tab = data?.tab || data?.activeTab || data?.selectedTab || data?.result?.tab || data || {};
  return {
    id: String(tab.id ?? tab.tabId ?? fallbackId ?? ''),
    title: tab.title,
    url: tab.url,
    lastOpened: tab.lastOpened || tab.lastAccessed || tab.updatedAt,
    tabGroup: tab.tabGroup || tab.groupTitle,
  };
}

function normalizeTabId(value) {
  if (isObject(value)) return asNumber(value.id ?? value.tabId);
  return asNumber(value);
}

function asNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Expected a positive tab id, received ${String(value)}`);
  return number;
}

function normalizeLimitOptions(options = {}) {
  const out = { ...options };
  if (out.limit == null) out.limit = 50;
  return out;
}

function normalizeNodeOptions(options = {}) {
  const out = { ...options };
  if (out.node_id != null && out.nodeId == null) out.nodeId = out.node_id;
  return out;
}

function buildCapabilityList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    id: String(item.id || item.name || ''),
    description: String(item.description || item.summary || ''),
  })).filter((item) => item.id);
}

function decodeScreenshot(value) {
  const text = String(value || '');
  const base64 = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text;
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
