#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENDPOINT_STATE_PATH = path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-agent-endpoint.json');
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

function resolveSocketPath(explicitPath = '') {
  if (explicitPath) return explicitPath;
  if (process.env.REDBOX_BROWSER_CONTROL_SOCKET) return process.env.REDBOX_BROWSER_CONTROL_SOCKET;
  try {
    const state = JSON.parse(fs.readFileSync(DEFAULT_ENDPOINT_STATE_PATH, 'utf8'));
    if (state.socketPath) return state.socketPath;
  } catch {}
  return DEFAULT_SOCKET_PATH;
}

function callAgentSocket(socketPath, request, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`agent socket request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
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
  const socketPath = resolveSocketPath(args.socketPath);
  const response = await callAgentSocket(socketPath, {
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
