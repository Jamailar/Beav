#!/usr/bin/env node

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(pluginRoot, 'docs');
const defaultEndpointStatePath = process.env.REDBOX_BROWSER_CONTROL_ENDPOINT_STATE
  || path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-agent-endpoint.json');
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
    this.timeoutMs = Number(options.timeoutMs || defaultTimeoutMs);
  }

  resolveSocketPath() {
    if (this.socketPath) return this.socketPath;
    if (process.env.REDBOX_BROWSER_CONTROL_SOCKET) return process.env.REDBOX_BROWSER_CONTROL_SOCKET;
    try {
      const state = JSON.parse(readFileSyncUtf8(this.endpointStatePath));
      if (typeof state.socketPath === 'string' && state.socketPath.trim()) return state.socketPath;
    } catch {}
    return defaultSocketPath;
  }

  async request(method, params = {}, options = {}) {
    const response = await sendSocketJsonRpc(this.resolveSocketPath(), {
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
}

class BrowserRuntime {
  constructor(options) {
    this.transport = options.transport;
    this.sessionId = options.sessionId || `redbox-browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.turnId = options.turnId || `turn-${Date.now().toString(36)}`;
    this.documentation = new BrowserDocumentation(options.documentationRoot);
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
    try {
      const [info, tools] = await Promise.all([
        this.runtime.callTool('browser.info', {}),
        this.runtime.transport.listTools(),
      ]);
      const data = unwrapActionData(info);
      return [{
        id: 'extension',
        name: 'RedBox Browser Control',
        type: 'extension',
        metadata: {
          backend: 'native-host',
          sessionId: this.runtime.sessionId,
          nativeConnected: String(data?.nativeHost?.connected ?? data?.connected ?? ''),
        },
        capabilities: {
          browser: buildCapabilityList(data?.capabilities?.browser || data?.contracts || []),
          tab: buildCapabilityList(tools),
        },
      }];
    } catch {
      return [];
    }
  }

  async get(id) {
    const requested = String(id || '').trim();
    if (!['extension', 'chrome', 'browser', 'redbox'].includes(requested)) {
      throw new Error(`Browser is not available: ${requested}`);
    }
    const browsers = await this.list();
    if (!browsers.length) {
      throw new Error('Browser is not available: extension');
    }
    return new BrowserFacade(this.runtime, browsers[0]);
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

function readFileSyncUtf8(filePath) {
  return readFileSync(filePath, 'utf8');
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
