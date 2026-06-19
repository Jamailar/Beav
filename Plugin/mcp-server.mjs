#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENDPOINT_STATE_PATH = path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-agent-endpoint.json');
const DEFAULT_SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\redbox-browser-control'
  : path.join(os.tmpdir(), `redbox-browser-control-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.sock`);
const DEFAULT_TIMEOUT_MS = Number(process.env.REDBOX_BROWSER_CONTROL_MCP_TIMEOUT_MS || 30_000);

const FALLBACK_TOOLS = [
  browserTool('browser.capabilities', 'Return browser-control capabilities and action contracts.', {}),
  browserTool('tabs.list', 'List current user browser tabs.', { limit: { type: 'number' } }),
  browserTool('tab.claim', 'Claim an existing user tab for an AI browser-control session.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('tab.create', 'Create a controlled browser tab.', { url: { type: 'string' }, active: { type: 'boolean' }, sessionId: { type: 'string' } }),
  browserTool('tab.navigate', 'Navigate an existing tab to an http or https URL.', { tabId: { type: 'number' }, url: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'url']),
  browserTool('page.domSnapshot', 'Read a bounded DOM snapshot for a tab or frame.', { tabId: { type: 'number' }, frameId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.queryElements', 'Query visible page elements by selector.', { tabId: { type: 'number' }, selector: { type: 'string' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.click', 'Click a page element by selector, text, or node reference.', { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.type', 'Type text into a page element.', { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector', 'text']),
  browserTool('page.assets', 'List images, videos, documents, favicons, and linked assets found on a page.', { tabId: { type: 'number' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.screenshot', 'Capture a visible-tab screenshot as a data URL.', { tabId: { type: 'number' }, format: { type: 'string' }, quality: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('cdp.send', 'Send a Chrome DevTools Protocol command to an attached tab.', { tabId: { type: 'number' }, method: { type: 'string' }, params: { type: 'object' }, sessionId: { type: 'string' } }, ['tabId', 'method']),
];

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainMessages();
});
process.stdin.resume();

function browserTool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: true,
    },
  };
}

function drainMessages() {
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const headers = inputBuffer.slice(0, headerEnd).toString('utf8');
    const length = parseContentLength(headers);
    if (length < 0) {
      inputBuffer = Buffer.alloc(0);
      return;
    }
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + length;
    if (inputBuffer.length < messageEnd) return;
    const rawMessage = inputBuffer.slice(messageStart, messageEnd).toString('utf8');
    inputBuffer = inputBuffer.slice(messageEnd);
    void handleMessage(JSON.parse(rawMessage)).catch((error) => {
      sendError(null, -32000, error instanceof Error ? error.message : String(error));
    });
  }
}

function parseContentLength(headers) {
  const match = headers.match(/content-length:\s*(\d+)/i);
  return match ? Number(match[1]) : -1;
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (!message.method || message.id == null) return;
  try {
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'redbox-browser-control', version: '0.1.0' },
        },
      });
      return;
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: await listTools() } });
      return;
    }
    if (message.method === 'tools/call') {
      const name = String(message.params?.name || '').trim();
      if (!name) throw new Error('tools/call requires params.name');
      const result = await callAgentSocket({
        jsonrpc: '2.0',
        id: `mcp:${Date.now().toString(36)}`,
        method: 'tools/call',
        params: {
          name,
          arguments: message.params?.arguments || {},
        },
      });
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result.result ?? result, null, 2) }],
          isError: Boolean(result.error),
        },
      });
      return;
    }
    sendError(message.id, -32601, `Unsupported MCP method: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

async function listTools() {
  try {
    const response = await callAgentSocket({
      jsonrpc: '2.0',
      id: `mcp-tools:${Date.now().toString(36)}`,
      method: 'tools/list',
      params: {},
    });
    const tools = response?.result?.tools || response?.tools;
    if (Array.isArray(tools) && tools.length) return tools;
  } catch {}
  return FALLBACK_TOOLS;
}

function resolveSocketPath() {
  if (process.env.REDBOX_BROWSER_CONTROL_SOCKET) return process.env.REDBOX_BROWSER_CONTROL_SOCKET;
  try {
    const state = JSON.parse(fs.readFileSync(DEFAULT_ENDPOINT_STATE_PATH, 'utf8'));
    if (state.socketPath) return state.socketPath;
  } catch {}
  return DEFAULT_SOCKET_PATH;
}

function callAgentSocket(request, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const socketPath = resolveSocketPath();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`browser-control request timed out after ${timeoutMs}ms`));
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

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
