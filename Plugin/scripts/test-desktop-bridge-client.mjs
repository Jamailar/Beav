#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_PROTOCOL_VERSION,
  DESKTOP_BRIDGE_DESCRIPTOR_SCHEMA_VERSION,
  DESKTOP_BRIDGE_PROTOCOL_VERSION,
  DesktopBridgeBrowserTransport,
  DesktopBridgeControlClient,
} from './desktop-bridge-client.mjs';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'beav-desktop-bridge-client-'));
const descriptorPath = path.join(tempRoot, 'desktop-bridge-v1.json');
const endpointPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\beav-desktop-bridge-client-${process.pid}-${randomUUID()}`
  : path.join(tempRoot, 'desktop-bridge-v1.sock');
const controlAuthToken = 'c'.repeat(64);
const requests = [];
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      requests.push(message);
      const result = handleRequest(message);
      const payload = Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result,
      }), 'utf8');
      const frame = Buffer.allocUnsafe(payload.length + 4);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame.subarray(0, 3));
      socket.write(frame.subarray(3));
    }
  });
});

try {
  await listen(server, endpointPath);
  await fs.writeFile(descriptorPath, `${JSON.stringify({
    schemaVersion: DESKTOP_BRIDGE_DESCRIPTOR_SCHEMA_VERSION,
    bridgeProtocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
    appVersion: '2.6.11',
    appInstanceId: 'app-test',
    endpoint: process.platform === 'win32'
      ? { kind: 'windows_named_pipe', name: endpointPath }
      : { kind: 'unix', path: endpointPath },
    hostAuthToken: 'h'.repeat(64),
    controlAuthToken,
    ready: true,
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  }, null, 2)}\n`, 'utf8');

  const client = new DesktopBridgeControlClient({ descriptorPath, timeoutMs: 2000 });
  const hello = await client.connect();
  assert.equal(hello.appInstanceId, 'app-test');
  assert.deepEqual(await client.listInstances(), [{
    browserInstanceId: 'extension-test',
    extensionInstanceId: 'extension-test',
    browser: 'chrome',
    extensionVersion: '2.6.11',
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    lastHandshakeAtMs: 1,
    endpointAgeMs: 0,
  }]);
  assert.equal((await client.listTools(2000, 'extension-test'))[0].name, 'tabs.list');
  const invoked = await client.invokeTool('tabs.list', { limit: 5 }, {
    browserInstanceId: 'extension-test',
    callId: 'test-call',
  });
  assert.equal(invoked.browserInstanceId, 'extension-test');
  assert.equal(invoked.response.result.ok, true);
  await client.close();

  const transport = new DesktopBridgeBrowserTransport({ timeoutMs: 2000 });
  process.env.REDBOX_BROWSER_BRIDGE_DESCRIPTOR = descriptorPath;
  const endpoints = await transport.listEndpoints();
  assert.equal(endpoints.length, 1);
  assert.equal((await transport.withBrowser('extension-test').hostInfo()).extensionReady, true);
  delete process.env.REDBOX_BROWSER_BRIDGE_DESCRIPTOR;

  const helloRequest = requests.find((request) => request.method === 'bridge.hello');
  assert.equal(helloRequest.params.authToken, controlAuthToken);
  assert.equal(helloRequest.params.role, 'browser_control_client');
  assert(requests.some((request) => request.method === 'control.listInstances'));
  assert(requests.some((request) => request.method === 'control.browserInvoke'));
  console.log(JSON.stringify({
    ok: true,
    requests: requests.map((request) => request.method),
  }, null, 2));
} finally {
  delete process.env.REDBOX_BROWSER_BRIDGE_DESCRIPTOR;
  await close(server);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function handleRequest(message) {
  if (message.method === 'bridge.hello') {
    assert.equal(message.params.bridgeProtocolVersion, DESKTOP_BRIDGE_PROTOCOL_VERSION);
    assert.equal(message.params.browserProtocolVersion, BROWSER_PROTOCOL_VERSION);
    assert.equal(message.params.authToken, controlAuthToken);
    return {
      ok: true,
      bridgeProtocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
      browserProtocolVersion: BROWSER_PROTOCOL_VERSION,
      appVersion: '2.6.11',
      appInstanceId: 'app-test',
      connectionId: 'connection-test',
      acceptedCapabilities: ['browser.control'],
    };
  }
  if (message.method === 'control.listInstances') {
    return {
      instances: [{
        browserInstanceId: 'extension-test',
        extensionInstanceId: 'extension-test',
        browser: 'chrome',
        extensionVersion: '2.6.11',
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        lastHandshakeAtMs: 1,
        endpointAgeMs: 0,
      }],
    };
  }
  if (message.method === 'control.listTools') {
    assert.equal(message.params.browserInstanceId, 'extension-test');
    return { tools: [{ name: 'tabs.list', inputSchema: { type: 'object' } }] };
  }
  if (message.method === 'control.browserInvoke') {
    assert.equal(message.params.request.identity.browserInstanceId, 'extension-test');
    return {
      response: {
        jsonrpc: '2.0',
        id: message.params.request.identity.callId,
        result: { ok: true },
      },
      browserInstanceId: 'extension-test',
    };
  }
  if (message.method === 'bridge.disconnect') return { ok: true };
  throw new Error(`Unexpected Desktop Bridge method: ${message.method}`);
}

function listen(target, socketPath) {
  return new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(socketPath, resolve);
  });
}

function close(target) {
  return new Promise((resolve) => target.close(() => resolve()));
}
