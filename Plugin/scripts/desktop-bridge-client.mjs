import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DESKTOP_BRIDGE_PROTOCOL_VERSION = 1;
export const DESKTOP_BRIDGE_DESCRIPTOR_SCHEMA_VERSION = 2;
export const BROWSER_PROTOCOL_VERSION = 3;
export const MAX_DESKTOP_BRIDGE_FRAME_BYTES = 16 * 1_024 * 1_024 + 256 * 1_024;

export function desktopBridgeStateRoot() {
  if (process.env.REDBOX_BROWSER_CONTROL_STATE_DIR) {
    return process.env.REDBOX_BROWSER_CONTROL_STATE_DIR;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/RedBox/native-host');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'),
      'RedBox/native-host',
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
    'RedBox/native-host',
  );
}

export function desktopBridgeDescriptorPath() {
  return process.env.REDBOX_BROWSER_BRIDGE_DESCRIPTOR
    || path.join(desktopBridgeStateRoot(), 'desktop-bridge-v1.json');
}

export function readDesktopBridgeDescriptor(explicitPath = '') {
  const descriptorPath = explicitPath || desktopBridgeDescriptorPath();
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  validateDesktopBridgeDescriptor(descriptor);
  return { descriptorPath, descriptor };
}

export function validateDesktopBridgeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('desktop bridge descriptor must be an object');
  }
  if (Number(descriptor.schemaVersion) !== DESKTOP_BRIDGE_DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error(
      `desktop bridge descriptor schema mismatch: expected ${DESKTOP_BRIDGE_DESCRIPTOR_SCHEMA_VERSION}`,
    );
  }
  if (Number(descriptor.bridgeProtocolVersion) !== DESKTOP_BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `desktop bridge protocol mismatch: expected ${DESKTOP_BRIDGE_PROTOCOL_VERSION}`,
    );
  }
  if (
    descriptor.ready !== true
    || !String(descriptor.appInstanceId || '').trim()
    || String(descriptor.controlAuthToken || '').length < 32
  ) {
    throw new Error('desktop bridge descriptor is not ready');
  }
  resolveDesktopBridgeEndpoint(descriptor.endpoint);
  return descriptor;
}

export function resolveDesktopBridgeEndpoint(endpoint) {
  if (endpoint?.kind === 'unix' && String(endpoint.path || '').trim()) {
    return { kind: 'unix', path: String(endpoint.path) };
  }
  if (
    endpoint?.kind === 'windows_named_pipe'
    && String(endpoint.name || '').startsWith('\\\\.\\pipe\\')
  ) {
    return { kind: 'windows_named_pipe', path: String(endpoint.name) };
  }
  throw new Error('desktop bridge descriptor contains an unsupported endpoint');
}

export class DesktopBridgeControlClient {
  constructor(options = {}) {
    this.timeoutMs = Math.max(250, Number(options.timeoutMs || 30_000));
    this.descriptorPathOverride = String(options.descriptorPath || '');
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.sequence = 0;
    this.descriptor = null;
    this.descriptorPath = '';
    this.hello = null;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return this.hello;
    const loaded = readDesktopBridgeDescriptor(this.descriptorPathOverride);
    this.descriptor = loaded.descriptor;
    this.descriptorPath = loaded.descriptorPath;
    const endpoint = resolveDesktopBridgeEndpoint(this.descriptor.endpoint);
    this.socket = await connectSocket(endpoint.path, this.timeoutMs);
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => this.rejectAll(error));
    this.socket.on('close', () => this.rejectAll(new Error('desktop bridge disconnected')));
    this.hello = await this.request('bridge.hello', {
      role: 'browser_control_client',
      bridgeProtocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
      browserProtocolVersion: BROWSER_PROTOCOL_VERSION,
      nativeHostVersion: String(this.descriptor.appVersion || ''),
      hostInstanceId: `control-client-node-${process.pid}-${randomUUID()}`,
      appInstanceId: String(this.descriptor.appInstanceId),
      authToken: String(this.descriptor.controlAuthToken),
      capabilities: ['browser.control'],
    });
    return this.hello;
  }

  async listInstances(timeoutMs = this.timeoutMs) {
    await this.connect();
    const result = await this.request('control.listInstances', {}, timeoutMs);
    return Array.isArray(result?.instances) ? result.instances : [];
  }

  async listTools(timeoutMs = this.timeoutMs, browserInstanceId = '') {
    await this.connect();
    const result = await this.request('control.listTools', {
      timeoutMs,
      browserInstanceId: browserInstanceId || undefined,
    }, timeoutMs);
    if (!Array.isArray(result?.tools) || result.tools.length === 0) {
      throw new Error('desktop bridge returned an empty browser tool inventory');
    }
    return result.tools;
  }

  async invokeTool(name, argumentsValue = {}, options = {}) {
    await this.connect();
    const timeoutMs = Math.max(250, Number(options.timeoutMs || this.timeoutMs));
    const callId = String(options.callId || `node-control:${Date.now().toString(36)}`);
    const result = await this.request('control.browserInvoke', {
      request: {
        action: String(name || ''),
        arguments: argumentsValue && typeof argumentsValue === 'object' ? argumentsValue : {},
        identity: {
          sessionId: options.sessionId || undefined,
          turnId: options.turnId || undefined,
          callId,
          browserInstanceId: options.browserInstanceId || undefined,
          attempt: 1,
        },
        timeoutMs,
      },
    }, timeoutMs);
    if (!result?.response || typeof result.response !== 'object') {
      throw new Error('desktop bridge returned an invalid browser response');
    }
    return result;
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('desktop bridge client is not connected');
    }
    this.sequence += 1;
    const id = `node-control:${process.pid}:${this.sequence}`;
    const message = { jsonrpc: '2.0', id, method, params };
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    if (payload.length > MAX_DESKTOP_BRIDGE_FRAME_BYTES) {
      throw new Error('desktop bridge request exceeds the frame limit');
    }
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`desktop bridge request timed out: ${method}`));
      }, Math.max(250, Number(timeoutMs || this.timeoutMs)));
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async close() {
    const socket = this.socket;
    if (!socket) return;
    if (!socket.destroyed && this.hello) {
      await this.request('bridge.disconnect', {}, 1_000).catch(() => {});
    }
    this.socket = null;
    socket.end();
    socket.destroy();
    this.rejectAll(new Error('desktop bridge client closed'));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_DESKTOP_BRIDGE_FRAME_BYTES) {
        this.socket?.destroy(new Error('desktop bridge returned an invalid frame length'));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        this.socket?.destroy(error);
        return;
      }
      const id = String(message?.id || '');
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'desktop bridge request failed');
        if (message.error.data) Object.assign(error, {
          code: message.error.data.code,
          retryable: message.error.data.retryable,
          phase: message.error.data.phase,
          details: message.error.data.details,
        });
        pending.reject(error);
      } else if (Object.prototype.hasOwnProperty.call(message, 'result')) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error('desktop bridge response requires result or error'));
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class DesktopBridgeBrowserTransport {
  constructor(options = {}) {
    this.browserId = String(options.browserId || options.browserInstanceId || '').trim();
    this.timeoutMs = Math.max(250, Number(options.timeoutMs || 30_000));
  }

  async listEndpoints() {
    return await this.withClient((client) => client.listInstances(this.timeoutMs));
  }

  async hostInfo() {
    const instances = await this.listEndpoints();
    const instance = selectBrowserInstance(instances, this.browserId);
    return {
      hostName: 'com.redbox.browser_control',
      instanceId: String(instance.hostInstanceId || instance.browserInstanceId || ''),
      extensionReady: true,
      nativeConnected: true,
      extension: {
        extensionInstanceId: String(instance.extensionInstanceId || ''),
        extensionVersion: String(instance.extensionVersion || ''),
        browser: String(instance.browser || ''),
      },
    };
  }

  async listTools(options = {}) {
    const timeoutMs = Math.max(250, Number(options.timeoutMs || this.timeoutMs));
    return await this.withClient(
      (client) => client.listTools(timeoutMs, this.browserId),
      timeoutMs,
    );
  }

  async callTool(name, args = {}, options = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('callTool requires a tool name');
    const timeoutMs = Math.max(250, Number(options.timeoutMs || this.timeoutMs));
    const result = await this.withClient(
      (client) => client.invokeTool(name, args, {
        ...options,
        browserInstanceId: this.browserId || options.browserInstanceId,
        timeoutMs,
      }),
      timeoutMs,
    );
    return result.response;
  }

  async request(method, params = {}, options = {}) {
    if (method === 'tools/list') return { tools: await this.listTools(options) };
    if (method === 'tools/call') {
      return await this.callTool(params.name, params.arguments || {}, options);
    }
    throw new Error(`Desktop Bridge browser transport does not expose raw method: ${method}`);
  }

  withBrowser(browserId) {
    return new DesktopBridgeBrowserTransport({
      browserId,
      timeoutMs: this.timeoutMs,
    });
  }

  withEndpoint(endpoint) {
    return this.withBrowser(
      endpoint?.extensionInstanceId
      || endpoint?.browserInstanceId
      || endpoint?.hostInstanceId
      || this.browserId,
    );
  }

  async withClient(callback, timeoutMs = this.timeoutMs) {
    const client = new DesktopBridgeControlClient({ timeoutMs });
    try {
      return await callback(client);
    } finally {
      await client.close();
    }
  }
}

function selectBrowserInstance(instances, requested) {
  const candidates = Array.isArray(instances) ? instances : [];
  if (requested) {
    const selected = candidates.find((instance) => [
      instance?.browserInstanceId,
      instance?.extensionInstanceId,
      instance?.hostInstanceId,
    ].some((value) => String(value || '') === requested));
    if (selected) return selected;
    throw new Error(`Browser instance is not available: ${requested}`);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new Error('No browser instance is connected to Desktop Bridge');
  const error = new Error('Multiple browser instances are connected; select one explicitly');
  error.code = 'BROWSER_INSTANCE_SELECTION_REQUIRED';
  error.instances = candidates;
  throw error;
}

function connectSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`desktop bridge connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
