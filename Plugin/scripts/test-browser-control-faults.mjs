#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserControlTransport } from './browser-client.mjs';
import {
  assertNativeHostVersionCompatibility,
  calculateNativeReconnectDelayMs,
  classifyNativeTransportFailure,
  classifyDesktopBridgeHandshake,
  disconnectNativeTransport,
  handleNativeReconnectAlarm,
  NATIVE_RECONNECT_ALARM,
  normalizeProductVersion,
  shouldReportNativeConnectionFailure,
} from '../src/background/nativeTransport.js';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'redbox-browser-faults-'));
const endpointsDirectory = path.join(tempRoot, 'endpoints');
const endpointStatePath = path.join(tempRoot, 'legacy-endpoint.json');
const servers = [];

try {
  await fs.mkdir(endpointsDirectory, { recursive: true });
  await testStaleDescriptorCleanup();
  await testDisconnectedSocket();
  await testLateResponseTimeout();
  await testOversizedResponse();
  testNativeHostVersionCompatibility();
  testNativeReconnectBackoff();
  testNativeTransportFailureClassification();
  testDesktopBridgeHandshakeClassification();
  await testNativeReconnectSingleFlight();
  console.log(JSON.stringify({
    ok: true,
    isolatedStateRoot: tempRoot,
    scenarios: [
      'stale_descriptor_cleanup',
      'socket_disconnect_terminal',
      'late_response_preserves_timeout',
      'oversized_response_rejected',
      'native_host_patch_update_compatible',
      'native_host_minor_upgrade_is_compatible',
      'native_host_major_mismatch_rejected',
      'native_host_reconnect_uses_capped_exponential_backoff',
      'native_host_reconnect_is_single_flight',
      'native_host_exit_is_a_typed_recoverable_failure',
      'old_app_requires_upgrade',
      'bridge_error_is_reportable_but_app_not_running_is_suppressed',
    ],
  }, null, 2));
} finally {
  await Promise.all(servers.map((server) => closeServer(server)));
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function testNativeReconnectBackoff() {
  assert.equal(calculateNativeReconnectDelayMs(1, () => 0), 1_000);
  assert.equal(calculateNativeReconnectDelayMs(2, () => 0), 2_000);
  assert.equal(calculateNativeReconnectDelayMs(5, () => 0), 16_000);
  assert.equal(calculateNativeReconnectDelayMs(99, () => 1), 30_000);
}

async function testNativeReconnectSingleFlight() {
  let connectCalls = 0;
  globalThis.chrome = {
    runtime: {
      connectNative: () => {
        connectCalls += 1;
        throw new Error('Specified native messaging host not found.');
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    alarms: {
      get: async () => null,
      create: async () => {},
      clear: async () => {},
    },
  };
  await Promise.all([
    handleNativeReconnectAlarm({ name: NATIVE_RECONNECT_ALARM }),
    handleNativeReconnectAlarm({ name: NATIVE_RECONNECT_ALARM }),
    handleNativeReconnectAlarm({ name: NATIVE_RECONNECT_ALARM }),
  ]);
  assert.equal(connectCalls, 1);
  await disconnectNativeTransport('test_cleanup');
  delete globalThis.chrome;
}

function testNativeTransportFailureClassification() {
  assert.equal(classifyNativeTransportFailure(new Error('Native host has exited.')), 'NATIVE_HOST_EXITED');
  assert.equal(classifyNativeTransportFailure(new Error('Specified native messaging host not found.')), 'NATIVE_HOST_NOT_REGISTERED');
  assert.equal(classifyNativeTransportFailure(new Error('native_request_timeout: desktop.health')), 'NATIVE_REQUEST_TIMEOUT');
  assert.equal(classifyNativeTransportFailure(new Error('Native transport is disconnected; reconnect is pending')), 'NATIVE_TRANSPORT_DISCONNECTED');
}

function testNativeHostVersionCompatibility() {
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '2.6.11.65535', version_name: '2.6.11' }),
    },
  };
  assert.equal(normalizeProductVersion('2.6.11.65535'), '2.6.11');
  assert.equal(
    assertNativeHostVersionCompatibility({ appVersion: '2.6.11' }),
    true,
  );
  assert.equal(
    assertNativeHostVersionCompatibility({ appVersion: '2.6.10' }),
    true,
  );
  assert.equal(
    assertNativeHostVersionCompatibility({ appVersion: '2.5.99' }),
    true,
  );
  assert.throws(
    () => assertNativeHostVersionCompatibility({ appVersion: '3.0.0' }),
    /Native host major version mismatch/,
  );
  delete globalThis.chrome;
}

function testDesktopBridgeHandshakeClassification() {
  assert.equal(classifyDesktopBridgeHandshake({ appVersion: '2.6.9' }), 'upgrade_required');
  assert.equal(
    classifyDesktopBridgeHandshake({ desktopBridge: { connected: false } }),
    'app_not_running',
  );
  assert.equal(
    classifyDesktopBridgeHandshake({
      desktopBridge: {
        connected: false,
        availability: 'app_not_running',
        errorCode: 'APP_STARTING',
        phase: 'bridge_reconnect',
      },
    }),
    'app_starting',
  );
  assert.equal(
    classifyDesktopBridgeHandshake({
      desktopBridge: {
        connected: false,
        availability: 'bridge_error',
        errorCode: 'DESKTOP_BRIDGE_PROTOCOL_MISMATCH',
      },
    }),
    'bridge_error',
  );
  assert.equal(
    classifyDesktopBridgeHandshake({ desktopBridge: { connected: true } }),
    'connected',
  );
  assert.equal(
    shouldReportNativeConnectionFailure(
      new Error('Beav desktop app is not connected'),
      { state: 'app_not_running' },
    ),
    false,
  );
  assert.equal(
    shouldReportNativeConnectionFailure(
      Object.assign(new Error('Beav desktop bridge is reconnecting'), { code: 'APP_STARTING' }),
      { state: 'app_starting' },
      { state: 'connected' },
    ),
    false,
  );
  assert.equal(
    shouldReportNativeConnectionFailure(
      new Error('Beav desktop app is not connected'),
      { state: 'app_not_running' },
      { state: 'connected' },
    ),
    false,
  );
  assert.equal(
    shouldReportNativeConnectionFailure(
      new Error('Native host is unavailable'),
      { state: 'disconnected' },
    ),
    false,
  );
  assert.equal(
    shouldReportNativeConnectionFailure(
      new Error('Native host disconnected'),
      { state: 'disconnected' },
      { state: 'connected' },
    ),
    true,
  );
  assert.equal(
    shouldReportNativeConnectionFailure(
      Object.assign(new Error('Bridge protocol mismatch'), { code: 'DESKTOP_BRIDGE_PROTOCOL_MISMATCH' }),
      { state: 'upgrade_required' },
    ),
    true,
  );
}

async function testStaleDescriptorCleanup() {
  const stalePath = path.join(endpointsDirectory, 'stale.json');
  await fs.writeFile(stalePath, `${JSON.stringify({
    instanceId: 'stale-instance',
    tcpAddress: '127.0.0.1:9',
    lastSeenAtMs: Date.now() - 300_000,
  })}\n`, 'utf8');
  const transport = new BrowserControlTransport({ endpointStatePath, endpointsDirectory });
  const endpoints = await transport.listEndpoints();
  assert(!endpoints.some((endpoint) => endpoint.instanceId === 'stale-instance'));
  await assert.rejects(fs.stat(stalePath), (error) => error?.code === 'ENOENT');
}

async function testDisconnectedSocket() {
  const endpoint = await startEndpoint('disconnect', (socket) => socket.destroy());
  const transport = new BrowserControlTransport({ endpoint, timeoutMs: 250 });
  await assert.rejects(
    transport.hostInfo(),
    (error) => error?.code === 'BROWSER_INSTANCE_DISCONNECTED',
  );
}

async function testLateResponseTimeout() {
  const endpoint = await startEndpoint('late', (socket, request) => {
    setTimeout(() => {
      if (!socket.destroyed) {
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true, late: true } })}\n`);
      }
    }, 150);
  });
  const transport = new BrowserControlTransport({ endpoint, timeoutMs: 30 });
  await assert.rejects(
    transport.hostInfo(),
    (error) => error?.code === 'BROWSER_ACTION_TIMEOUT',
  );
  await delay(200);
}

async function testOversizedResponse() {
  const endpoint = await startEndpoint('oversized', (socket, request) => {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { payload: 'x'.repeat((8 * 1024 * 1024) + 1024) },
    });
    socket.end(`${response}\n`);
  });
  const transport = new BrowserControlTransport({ endpoint, timeoutMs: 2000 });
  await assert.rejects(
    transport.hostInfo(),
    (error) => error?.code === 'BROWSER_RESPONSE_TOO_LARGE',
  );
}

async function startEndpoint(instanceId, respond) {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        socket.destroy();
        return;
      }
      respond(socket, request);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    instanceId,
    extension: { extensionInstanceId: `extension-${instanceId}` },
    endpoint: { address: `127.0.0.1:${address.port}`, authToken: `token-${instanceId}` },
    lastSeenAtMs: Date.now(),
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
