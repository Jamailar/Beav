#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserControlTransport, setupBrowserRuntime } from './browser-client.mjs';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'redbox-browser-binding-'));
const endpointsDirectory = path.join(tempRoot, 'endpoints');
const endpointStatePath = path.join(tempRoot, 'legacy-endpoint.json');
const servers = new Set();
const requestAudit = [];

try {
  await fs.mkdir(endpointsDirectory, { recursive: true });
  await testSelectionAndStableBinding();
  await testRequestReplayAndResumeReconciliation();
  console.log(JSON.stringify({
    ok: true,
    isolatedStateRoot: tempRoot,
    scenarios: [
      'multi_instance_selection_required',
      'explicit_instance_selection',
      'host_rotation_preserves_extension_binding',
      'missing_bound_instance_does_not_fallback',
      'completed_call_id_replay',
      'extension_resume_reconciliation',
    ],
    auditedRequests: requestAudit.length,
  }, null, 2));
} finally {
  await Promise.all([...servers].map(closeEndpoint));
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function testSelectionAndStableBinding() {
  const chrome = await startEndpoint({ hostInstanceId: 'chrome-host-1', extensionInstanceId: 'chrome-profile-default', browser: 'chrome' });
  const edge = await startEndpoint({ hostInstanceId: 'edge-host-1', extensionInstanceId: 'edge-profile-work', browser: 'edge' });
  await writeDescriptor(chrome);
  await writeDescriptor(edge);

  const transport = new BrowserControlTransport({ endpointStatePath, endpointsDirectory, timeoutMs: 500 });
  await assert.rejects(
    transport.hostInfo(),
    (error) => error?.code === 'BROWSER_INSTANCE_SELECTION_REQUIRED'
      && error?.data?.instances?.length === 2
      && !JSON.stringify(error.data).includes('token-'),
  );

  const chromeTransport = transport.withBrowser('chrome-profile-default');
  assert.equal((await chromeTransport.hostInfo()).instanceId, 'chrome-host-1');
  assert.equal((await transport.withBrowser('edge-profile-work').hostInfo()).instanceId, 'edge-host-1');

  const sandbox = {};
  await setupBrowserRuntime({ globals: sandbox, transport, sessionId: 'binding-session', turnId: 'binding-turn' });
  await assert.rejects(
    sandbox.agent.browsers.get('extension'),
    (error) => error?.code === 'BROWSER_INSTANCE_SELECTION_REQUIRED' && error?.data?.instances?.length === 2,
  );
  const browser = await sandbox.agent.browsers.get('chrome-profile-default');
  await browser.nameSession('before-host-rotation');
  assert(requestAudit.some((entry) => entry.hostInstanceId === 'chrome-host-1' && entry.toolName === 'session.name'));

  await closeEndpoint(chrome);
  await fs.rm(descriptorPath(chrome.hostInstanceId), { force: true });
  const rotatedChrome = await startEndpoint({ hostInstanceId: 'chrome-host-2', extensionInstanceId: 'chrome-profile-default', browser: 'chrome' });
  await writeDescriptor(rotatedChrome);
  await browser.nameSession('after-host-rotation');
  assert(requestAudit.some((entry) => entry.hostInstanceId === 'chrome-host-2' && entry.toolName === 'session.name'));

  await closeEndpoint(rotatedChrome);
  await fs.rm(descriptorPath(rotatedChrome.hostInstanceId), { force: true });
  await assert.rejects(
    chromeTransport.hostInfo(),
    (error) => error?.code === 'BROWSER_INSTANCE_DISCONNECTED'
      && error?.data?.requestedBrowserInstanceId === 'chrome-profile-default'
      && error?.data?.instances?.some((instance) => instance.extensionInstanceId === 'edge-profile-work'),
  );
  assert.equal((await transport.withBrowser('edge-profile-work').hostInfo()).instanceId, 'edge-host-1');
}

async function testRequestReplayAndResumeReconciliation() {
  installChromeStorageMock();
  const runtime = await import('../src/background/browserSessionRuntime.js');
  await runtime.ensureBrowserSession('resume-session', 'agent', {}, { turnId: 'turn-one' });
  const firstStart = await runtime.startBrowserSessionRequest('resume-session', {
    requestId: 'call-completed',
    turnId: 'turn-one',
    action: 'page.title',
    tabId: 42,
  });
  assert.equal(firstStart.replayed, undefined);
  await runtime.finishBrowserSessionRequest('resume-session', 'call-completed', {
    success: true,
    response: { success: true, title: 'Fixture title' },
  });
  const replay = await runtime.startBrowserSessionRequest('resume-session', {
    requestId: 'call-completed',
    turnId: 'turn-one',
    action: 'page.title',
    tabId: 42,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.response?.title, 'Fixture title');

  await runtime.startBrowserSessionRequest('resume-session', {
    requestId: 'call-interrupted',
    turnId: 'turn-one',
    action: 'page.waitForTimeout',
    tabId: 42,
  });
  const reconciled = await runtime.reconcileInterruptedBrowserRequests('test_extension_runtime_resumed');
  assert.deepEqual(reconciled.interruptedRequests.map((request) => request.requestId), ['call-interrupted']);
  const session = await runtime.getBrowserSession('resume-session');
  assert.equal(session.activeRequestCount, 0);
  assert.equal(session.currentTurnId, null);
  assert.equal(session.recentRequests['call-completed'].terminalState, 'completed');
  assert.equal(session.recentRequests['call-interrupted'].terminalState, 'cancelled');
  assert.equal(session.recentRequests['call-interrupted'].browserError.code, 'BROWSER_ACTION_CANCELLED');
  const events = await runtime.listBrowserSessionEvents({ sessionId: 'resume-session', limit: 50 });
  assert(events.events.some((event) => event.eventType === 'request.replayed' && event.payload.requestId === 'call-completed'));
  assert(events.events.some((event) => event.eventType === 'request.interrupted' && event.payload.requestId === 'call-interrupted'));
}

async function startEndpoint({ hostInstanceId, extensionInstanceId, browser }) {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      const toolName = String(request?.params?.name || '');
      requestAudit.push({ hostInstanceId, extensionInstanceId, method: request.method, toolName });
      const result = endpointResult({ browser, extensionInstanceId, hostInstanceId, request, toolName });
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const endpoint = { server, hostInstanceId, extensionInstanceId, browser, port: address.port };
  servers.add(endpoint);
  return endpoint;
}

function endpointResult({ browser, extensionInstanceId, hostInstanceId, request, toolName }) {
  if (request.method === 'host.getInfo') {
    return {
      ok: true,
      hostName: 'com.redbox.browser_control',
      instanceId: hostInstanceId,
      extensionReady: true,
      extension: { extensionInstanceId, browser },
    };
  }
  if (request.method === 'tools/list') {
    return { tools: [
      { name: 'browser.info', description: 'Read browser identity.' },
      { name: 'session.name', description: 'Name browser session.' },
    ] };
  }
  if (request.method === 'tools/call' && toolName === 'browser.info') {
    return { success: true, extensionInstanceId, browser, name: `${browser} fixture` };
  }
  if (request.method === 'tools/call') return { success: true, toolName };
  return { success: true };
}

async function writeDescriptor(endpoint) {
  await fs.writeFile(descriptorPath(endpoint.hostInstanceId), `${JSON.stringify({
    instanceId: endpoint.hostInstanceId,
    browserInstanceId: endpoint.extensionInstanceId,
    extension: {
      extensionInstanceId: endpoint.extensionInstanceId,
      browser: endpoint.browser,
      profileId: endpoint.extensionInstanceId,
    },
    endpoint: { address: `127.0.0.1:${endpoint.port}`, authToken: `token-${endpoint.hostInstanceId}` },
    updatedAt: new Date().toISOString(),
    lastSeenAtMs: Date.now(),
  }, null, 2)}\n`, 'utf8');
}

function descriptorPath(hostInstanceId) {
  return path.join(endpointsDirectory, `${hostInstanceId}.json`);
}

async function closeEndpoint(endpoint) {
  if (!endpoint || !servers.has(endpoint)) return;
  servers.delete(endpoint);
  if (!endpoint.server.listening) return;
  await new Promise((resolve) => endpoint.server.close(resolve));
}

function installChromeStorageMock() {
  const values = new Map();
  const storage = {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => values.has(key)).map((key) => [key, structuredClone(values.get(key))]));
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries || {})) values.set(key, structuredClone(value));
    },
  };
  globalThis.chrome = { storage: { local: storage, session: storage } };
}
