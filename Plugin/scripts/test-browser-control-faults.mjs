#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserControlTransport } from './browser-client.mjs';

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
  console.log(JSON.stringify({
    ok: true,
    isolatedStateRoot: tempRoot,
    scenarios: [
      'stale_descriptor_cleanup',
      'socket_disconnect_terminal',
      'late_response_preserves_timeout',
      'oversized_response_rejected',
    ],
  }, null, 2));
} finally {
  await Promise.all(servers.map((server) => closeServer(server)));
  await fs.rm(tempRoot, { recursive: true, force: true });
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
