#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.redbox.browser_control';
const DEFAULT_API_BASE = '';
const LOG_PATH = path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-host.log');
const ENDPOINT_STATE_PATH = process.env.REDBOX_BROWSER_CONTROL_ENDPOINT_STATE
  || path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-agent-endpoint.json');
const ENDPOINTS_DIRECTORY = process.env.REDBOX_BROWSER_CONTROL_ENDPOINTS_DIRECTORY
  || path.join(path.dirname(ENDPOINT_STATE_PATH), 'browser-control-agent-endpoints');
const DEFAULT_AGENT_SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\redbox-browser-control'
  : path.join(os.tmpdir(), `redbox-browser-control-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${process.pid}.sock`);
const AGENT_REQUEST_TIMEOUT_MS = Number(process.env.REDBOX_BROWSER_CONTROL_AGENT_TIMEOUT_MS || 60_000);
const AGENT_PROTOCOL_VERSION = 2;

let nextRequestId = 0;
let nextAgentRequestId = 0;
let nativeConnected = false;
let agentServer = null;
let agentSocketPath = process.env.REDBOX_BROWSER_CONTROL_SOCKET || DEFAULT_AGENT_SOCKET_PATH;
const hostInstanceId = process.env.REDBOX_BROWSER_CONTROL_INSTANCE_ID
  || `native-host-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const endpointDescriptorPath = path.join(ENDPOINTS_DIRECTORY, `${hostInstanceId}.json`);
let extensionMetadata = {};
const pendingAgentRequests = new Map();

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length, 0);
  fs.writeSync(1, length);
  fs.writeSync(1, payload);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.success === false) {
    throw new Error(`${response.status} ${response.statusText} ${JSON.stringify(body)}`);
  }
  return body;
}

async function resolveApiBase() {
  const candidates = [
    process.env.REDBOX_BROWSER_CONTROL_API,
    DEFAULT_API_BASE,
  ].filter(Boolean);
  const errors = [];
  for (const baseUrl of candidates) {
    try {
      const health = await requestJson(`${baseUrl}/health`);
      if (health.service === 'browser-data-ai' || health.service === 'browser-control') return baseUrl;
      errors.push(`${baseUrl}: unexpected health ${JSON.stringify(health)}`);
    } catch (error) {
      errors.push(`${baseUrl}: ${error.message}`);
    }
  }
  throw new Error(`No browser-data-ai API found. ${errors.join(' | ')}`);
}

async function handleMethod(method, params = {}) {
  switch (method) {
    case 'ping':
      return { ok: true, hostName: HOST_NAME, now: new Date().toISOString() };
    case 'getInfo':
      return {
        ok: true,
        hostName: HOST_NAME,
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        apiDefault: DEFAULT_API_BASE,
      };
    case 'ensureXwowAppServer':
    case 'ensureCodexAppServer': {
      const apiBase = await resolveApiBase();
      return { ok: true, apiBase };
    }
    case 'publishCommand': {
      const apiBase = await resolveApiBase();
      return await requestJson(`${apiBase}/commands`, {
        method: 'POST',
        body: JSON.stringify(params),
      });
    }
    case 'onCDPEvent':
    case 'onDownloadChange':
    case 'onBrowserLifecycleEvent':
    case 'onBrowserSessionEvent':
      return await publishBrowserEvent(method, params);
    default:
      throw new Error(`Unsupported native host method: ${method}`);
  }
}

function isHostMethod(method = '') {
  return [
    'ping',
    'getInfo',
    'ensureXwowAppServer',
    'ensureCodexAppServer',
    'publishCommand',
    'onCDPEvent',
    'onDownloadChange',
    'onBrowserLifecycleEvent',
    'onBrowserSessionEvent',
  ].includes(String(method || ''));
}

async function publishBrowserEvent(method, params = {}) {
  const event = buildBrowserEventEnvelope(method, params);
  log(`event ${method} ${JSON.stringify(summarizeEvent(event))}`);
  try {
    const apiBase = await resolveApiBase();
    const result = await requestJson(`${apiBase}/events`, {
      method: 'POST',
      body: JSON.stringify(event),
    });
    return { ok: true, forwarded: true, result };
  } catch (error) {
    log(`event ${method} not forwarded: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: true, forwarded: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildBrowserEventEnvelope(method, params = {}) {
  const receivedAt = new Date().toISOString();
  return {
    type: method,
    nativeEventMethod: method,
    eventId: params.eventId || '',
    pluginId: params.pluginId || 'redbox-browser-control',
    extensionId: params.extensionId || '',
    sessionId: params.sessionId || '',
    turnId: params.turnId || '',
    activeTabId: Number.isInteger(Number(params.activeTabId)) ? Number(params.activeTabId) : null,
    owner: params.owner || '',
    eventType: params.eventType || '',
    kind: params.kind || params.sessionEventType || params.method || '',
    bridgeMethod: params.bridgeMethod || method,
    sourceKind: params.sourceKind || inferSourceKind(method, params),
    emittedAt: params.emittedAt || '',
    receivedAt,
    jobMetadata: params.jobMetadata || {},
    payload: params,
  };
}

function inferSourceKind(method, params = {}) {
  if (params.sourceKind) return params.sourceKind;
  if (method === 'onCDPEvent') return 'cdp';
  if (method === 'onDownloadChange') return 'download';
  if (method === 'onBrowserLifecycleEvent') return 'lifecycle';
  if (method === 'onBrowserSessionEvent') return 'session';
  return 'native';
}

async function handleNotification(method, params = {}) {
  try {
    await handleMethod(method, params);
  } catch (error) {
    log(`notification ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleNativeResponse(message) {
  if (!message || typeof message !== 'object' || message.id == null) return false;
  const pending = pendingAgentRequests.get(String(message.id));
  if (!pending) return false;
  if (pending.method === 'getInfo' && message.result && typeof message.result === 'object') {
    const result = message.result;
    extensionMetadata = {
      extensionId: typeof result.extensionId === 'string' ? result.extensionId : '',
      extensionInstanceId: typeof result.extensionInstanceId === 'string' ? result.extensionInstanceId : '',
      extensionVersion: typeof result.version === 'string' ? result.version : '',
      updatedAt: new Date().toISOString(),
    };
    writeEndpointState();
  }
  pendingAgentRequests.delete(String(message.id));
  clearTimeout(pending.timer);
  const response = { jsonrpc: '2.0', id: pending.clientId };
  if (Object.prototype.hasOwnProperty.call(message, 'error')) response.error = message.error;
  else response.result = message.result;
  pending.write(response);
  return true;
}

function forwardAgentRequest(clientRequest, write) {
  if (!nativeConnected) {
    write({
      jsonrpc: '2.0',
      id: clientRequest.id ?? null,
      error: {
        code: -32002,
        message: 'Chrome extension is not connected to the native host',
        data: { socketPath: agentSocketPath },
      },
    });
    return;
  }
  const method = validateJsonRpcMethod(clientRequest.method);
  const params = validateJsonRpcParams(clientRequest.params || {});
  nextAgentRequestId += 1;
  const nativeId = `agent:${nextAgentRequestId}`;
  const clientId = clientRequest.id ?? null;
  const timer = setTimeout(() => {
    pendingAgentRequests.delete(nativeId);
    write({
      jsonrpc: '2.0',
      id: clientId,
      error: {
        code: -32001,
        message: `Extension request timed out: ${method}`,
        data: { timeoutMs: AGENT_REQUEST_TIMEOUT_MS },
      },
    });
  }, AGENT_REQUEST_TIMEOUT_MS);
  pendingAgentRequests.set(nativeId, { clientId, method, timer, write });
  writeMessage({ jsonrpc: '2.0', id: nativeId, method, params });
}

function validateJsonRpcMethod(method) {
  const name = String(method || '').trim();
  if (!name) throw new Error('JSON-RPC request requires method');
  if (name.length > 180) throw new Error('JSON-RPC method is too long');
  if (!/^[A-Za-z0-9_.:\/-]+$/.test(name)) throw new Error('JSON-RPC method contains unsupported characters');
  return name;
}

function validateJsonRpcParams(params) {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('JSON-RPC params must be an object');
  return params;
}

function handleAgentJsonRpc(message, write) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || !message.method) {
    write({
      jsonrpc: '2.0',
      id: message?.id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC request' },
    });
    return;
  }
  if (String(message.method).startsWith('host.')) {
    void handleAgentHostMethod(message, write);
    return;
  }
  try {
    forwardAgentRequest(message, write);
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleAgentHostMethod(message, write) {
  const method = String(message.method || '').slice('host.'.length);
  try {
    if (method === 'ping') {
      write({ jsonrpc: '2.0', id: message.id ?? null, result: buildHostInfo({ ok: true }) });
      return;
    }
    if (method === 'getInfo') {
      write({ jsonrpc: '2.0', id: message.id ?? null, result: buildHostInfo({ ok: true, capabilities: buildAgentCapabilities() }) });
      return;
    }
    if (method === 'shutdown') {
      write({ jsonrpc: '2.0', id: message.id ?? null, result: { ok: true } });
      setTimeout(() => process.exit(0), 20);
      return;
    }
    write({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `No host handler registered for method: ${message.method}` } });
  } catch (error) {
    write({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

function buildHostInfo(patch = {}) {
  return {
    hostName: HOST_NAME,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    socketPath: agentSocketPath,
    endpointStatePath: ENDPOINT_STATE_PATH,
    endpointDescriptorPath,
    endpointsDirectory: ENDPOINTS_DIRECTORY,
    instanceId: hostInstanceId,
    extension: extensionMetadata,
    nativeConnected,
    protocol: {
      transport: 'unix-socket-jsonrpc-lines',
      jsonrpc: '2.0',
      version: AGENT_PROTOCOL_VERSION,
      requestDirection: 'agent -> native-host -> chrome-extension-background',
    },
    ...patch,
  };
}

function buildAgentCapabilities() {
  return {
    forwarding: true,
    hostMethods: ['host.ping', 'host.getInfo', 'host.shutdown'],
    targetStyleMethods: [
      'ping',
      'getInfo',
      'executeCdp',
      'attach',
      'attachTarget',
      'detach',
      'detachTarget',
      'getTabs',
      'getUserTabs',
      'getUserHistory',
      'claimUserTab',
      'createTab',
      'finalizeTabs',
      'nameSession',
      'executeUnhandledCommand',
      'moveMouse',
      'turnEnded',
      'webmcp_list_tools',
      'webmcp_invoke_tool',
    ],
  };
}

function startAgentServer() {
  if (agentServer) return;
  if (process.platform !== 'win32') {
    try {
      fs.rmSync(agentSocketPath, { force: true });
    } catch {}
  }
  agentServer = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    const write = (message) => {
      socket.write(`${JSON.stringify(message)}\n`);
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          handleAgentJsonRpc(JSON.parse(line), write);
        } catch (error) {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
        }
      }
    });
  });
  agentServer.on('error', (error) => {
    log(`agent server error: ${error instanceof Error ? error.message : String(error)}`);
  });
  agentServer.listen(agentSocketPath, () => {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(agentSocketPath, 0o600);
      } catch {}
    }
    writeEndpointState();
    log(`agent endpoint listening ${agentSocketPath}`);
  });
}

function writeEndpointState() {
  try {
    fs.mkdirSync(path.dirname(ENDPOINT_STATE_PATH), { recursive: true });
    fs.mkdirSync(ENDPOINTS_DIRECTORY, { recursive: true });
    const descriptor = buildHostInfo({
      ok: true,
      capabilities: buildAgentCapabilities(),
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(endpointDescriptorPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
    // Keep the v1 singleton state file as a compatibility pointer for older clients.
    fs.writeFileSync(ENDPOINT_STATE_PATH, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
  } catch (error) {
    log(`failed to write endpoint state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cleanupEndpointState() {
  if (process.platform !== 'win32') {
    try {
      fs.rmSync(agentSocketPath, { force: true });
    } catch {}
  }
  try {
    fs.rmSync(endpointDescriptorPath, { force: true });
  } catch {}
}

function startNativeMessageReader(onMessage) {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length <= 0 || length > 64 * 1024 * 1024) throw new Error(`Invalid native message length: ${length}`);
      if (buffer.length < 4 + length) return;
      const payload = buffer.slice(4, 4 + length);
      buffer = buffer.slice(4 + length);
      void Promise.resolve(onMessage(JSON.parse(payload.toString('utf8')))).catch((error) => {
        log(`native message handler failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      });
    }
  });
  process.stdin.on('end', () => {
    nativeConnected = false;
    for (const [id, pending] of pendingAgentRequests) {
      clearTimeout(pending.timer);
      pending.write({
        jsonrpc: '2.0',
        id: pending.clientId,
        error: { code: -32003, message: 'Chrome native messaging stream ended' },
      });
      pendingAgentRequests.delete(id);
    }
    log('native messaging stdin ended');
  });
  process.stdin.resume();
}

function summarizeEvent(event) {
  const payload = event.payload || {};
  return {
    type: event.type,
    eventType: event.eventType,
    sessionId: event.sessionId,
    turnId: event.turnId,
    downloadId: payload.downloadId,
    cdpMethod: event.type === 'onCDPEvent' ? payload.method : undefined,
    kind: payload.kind,
  };
}

async function main() {
  log('native host started');
  nativeConnected = true;
  startAgentServer();
  startNativeMessageReader(async (message) => {
    if (!message || typeof message !== 'object') return;
    if (handleNativeResponse(message)) return;
    if (message.jsonrpc === '2.0' && message.method) {
      if (message.id == null) {
        await handleNotification(message.method, message.params || {});
        return;
      }
      try {
        const result = isHostMethod(message.method)
          ? await handleMethod(message.method, message.params || {})
          : (() => { throw new Error(`Unsupported native host method: ${message.method}`); })();
        writeMessage({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        writeMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }
    nextRequestId += 1;
    writeMessage({
      jsonrpc: '2.0',
      id: message.id || `host:${nextRequestId}`,
      result: { ok: true, echo: message },
    });
  });
}

process.once('exit', cleanupEndpointState);
process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(`fatal ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
}
