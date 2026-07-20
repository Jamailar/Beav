#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STATE_ROOT = process.env.REDBOX_BROWSER_CONTROL_STATE_DIR || (
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/RedBox/native-host')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'RedBox/native-host')
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'RedBox/native-host')
);
const DEFAULT_ENDPOINT_STATE_PATH = process.env.REDBOX_BROWSER_CONTROL_ENDPOINT_STATE
  || path.join(DEFAULT_STATE_ROOT, 'browser-control-agent-endpoint.json');
const DEFAULT_SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\redbox-browser-control'
  : path.join(os.tmpdir(), `redbox-browser-control-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.sock`);

function parseArgs(argv) {
  const out = { params: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--socket') out.socketPath = argv[index + 1];
    if (item === '--method') out.method = argv[index + 1];
    if (item === '--params') out.params = JSON.parse(argv[index + 1] || '{}');
    if (item === '--timeout-ms') out.timeoutMs = Number(argv[index + 1] || 0);
    if (item === '--help' || item === '-h') out.help = true;
  }
  if (!out.method && argv[0] && !argv[0].startsWith('--')) out.method = argv[0];
  if (!out.params && argv[1] && !argv[1].startsWith('--')) out.params = JSON.parse(argv[1] || '{}');
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node agent-client.mjs --method getInfo',
    '  node agent-client.mjs --method getUserTabs --params \'{"session_id":"s1","turn_id":"t1"}\'',
    '',
    'The client sends newline-delimited JSON-RPC 2.0 to the native-host agent socket.',
  ].join('\n');
}

function resolveEndpoint(explicitPath = '') {
  if (explicitPath) return { socketPath: explicitPath };
  if (process.env.REDBOX_BROWSER_CONTROL_SOCKET) return { socketPath: process.env.REDBOX_BROWSER_CONTROL_SOCKET };
  try {
    const state = JSON.parse(fs.readFileSync(DEFAULT_ENDPOINT_STATE_PATH, 'utf8'));
    if (state.socketPath || state.endpoint?.address || state.tcpAddress) return state;
  } catch {}
  return { socketPath: DEFAULT_SOCKET_PATH };
}

function callAgentEndpoint(endpoint, request, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const address = String(endpoint?.endpoint?.address || endpoint?.tcpAddress || '');
    const match = address.match(/^127\.0\.0\.1:(\d+)$/);
    const socket = match
      ? net.createConnection({ host: '127.0.0.1', port: Number(match[1]) })
      : net.createConnection(endpoint?.socketPath || DEFAULT_SOCKET_PATH);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`agent socket request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const authToken = String(endpoint?.endpoint?.authToken || endpoint?.authToken || '');
      if (authToken) request._browserControlAuth = authToken;
      socket.write(`${JSON.stringify(request)}\n`);
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
        resolve(JSON.parse(line));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.method) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }
  const endpoint = resolveEndpoint(args.socketPath);
  const response = await callAgentEndpoint(endpoint, {
    jsonrpc: '2.0',
    id: `agent-client:${Date.now().toString(36)}`,
    method: args.method,
    params: args.params || {},
  }, args.timeoutMs || 30_000);
  console.log(JSON.stringify(response, null, 2));
  if (response.error) process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
