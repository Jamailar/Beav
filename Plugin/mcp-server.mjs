#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENDPOINT_STATE_PATH = process.env.REDBOX_BROWSER_CONTROL_ENDPOINT_STATE
  || path.join(os.homedir(), 'Library/Application Support/RedBox/native-host/browser-control-agent-endpoint.json');
const DEFAULT_SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\redbox-browser-control'
  : path.join(os.tmpdir(), `redbox-browser-control-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.sock`);
const DEFAULT_TIMEOUT_MS = Number(process.env.REDBOX_BROWSER_CONTROL_MCP_TIMEOUT_MS || 30_000);

const FALLBACK_TOOLS = [
  browserTool('browser.capabilities', 'Return browser-control capabilities and action contracts.', {}),
  browserTool('browser.info', 'Return browser-control backend, session, policy, and capability metadata.', {}),
  browserTool('browser.context', 'Return readonly user browser context such as open tabs, windows, and history summaries.', { limit: { type: 'number' } }),
  browserTool('browser.events', 'Replay browser-control runtime events.', { limit: { type: 'number' }, afterEventId: { type: 'string' } }),
  browserTool('browser.events.summary', 'Summarize browser-control runtime events.', {}),
  browserTool('browser.sessionEvents', 'Replay browser-control session lifecycle events.', { sessionId: { type: 'string' }, limit: { type: 'number' } }),
  browserTool('browser.visibility.get', 'Return browser window visibility state.', { windowId: { type: 'number' } }),
  browserTool('browser.visibility.set', 'Set browser window visibility state.', { windowId: { type: 'number' }, state: { type: 'string' } }),
  browserTool('windows.list', 'List browser windows with bounded metadata.', { limit: { type: 'number' } }),
  browserTool('history.search', 'Search recent browser history metadata.', { query: { type: 'string' }, limit: { type: 'number' } }),
  browserTool('tabs.list', 'List current user browser tabs.', { limit: { type: 'number' } }),
  browserTool('tab.info', 'Read metadata for a tab or the current active tab.', { tabId: { type: 'number' }, activeOnly: { type: 'boolean' }, sessionId: { type: 'string' } }),
  browserTool('tabs.finalize', 'Finalize browser-control tabs, closing or handing off tabs according to keep entries.', { keep: { type: 'array', items: { type: 'object' } }, sessionId: { type: 'string' } }),
  browserTool('session.name', 'Name the current browser-control session.', { name: { type: 'string' }, sessionId: { type: 'string' } }, ['name']),
  browserTool('turn.ended', 'Mark the current browser-control turn ended.', { turnId: { type: 'string' }, sessionId: { type: 'string' } }),
  browserTool('tab.claim', 'Claim an existing user tab for an AI browser-control session.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('tab.create', 'Create a controlled browser tab.', { url: { type: 'string' }, active: { type: 'boolean' }, sessionId: { type: 'string' } }),
  browserTool('tab.navigate', 'Navigate an existing tab to an http or https URL.', { tabId: { type: 'number' }, url: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'url']),
  browserTool('tab.back', 'Navigate a controlled tab back in history.', { tabId: { type: 'number' }, waitUntil: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('tab.forward', 'Navigate a controlled tab forward in history.', { tabId: { type: 'number' }, waitUntil: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('tab.reload', 'Reload a controlled tab.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('tab.close', 'Close a controlled tab.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.frames', 'List frames in a controlled tab.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.waitForLoadState', 'Wait for a controlled tab to reach a load state.', { tabId: { type: 'number' }, state: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.waitForURL', 'Wait for a controlled tab URL to match a target, wildcard, or regex.', { tabId: { type: 'number' }, url: { type: 'string' }, urlRegex: { type: 'string' }, exact: { type: 'boolean' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.waitForTimeout', 'Wait for a fixed duration in a controlled tab context.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' }, ms: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.evaluate', 'Evaluate JavaScript in a controlled tab through CDP; browser policy treats this as state-changing unless approved.', { tabId: { type: 'number' }, script: { type: 'string' }, expression: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.domSnapshot', 'Read a bounded DOM snapshot for a tab or frame.', { tabId: { type: 'number' }, frameId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.waitForSelector', 'Wait for a selector to appear in a controlled tab.', { tabId: { type: 'number' }, selector: { type: 'string' }, timeoutMs: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.queryElements', 'Query visible page elements by selector.', { tabId: { type: 'number' }, selector: { type: 'string' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.click', 'Click a page element by selector, text, or node reference.', { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.doubleClick', 'Double-click a page element by selector or text.', { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.hover', 'Hover a page element by selector or text.', { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('node.click', 'Click a page node by DOM snapshot node reference.', { tabId: { type: 'number' }, nodeId: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.scroll', 'Scroll a controlled tab or frame.', { tabId: { type: 'number' }, direction: { type: 'string' }, pixels: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('node.scroll', 'Scroll a DOM snapshot node.', { tabId: { type: 'number' }, nodeId: { type: 'string' }, deltaY: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.type', 'Type text into a page element.', { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector', 'text']),
  browserTool('page.check', 'Check a checkbox or switch-like page element.', { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.setChecked', 'Set a checkbox or switch-like page element state.', { tabId: { type: 'number' }, selector: { type: 'string' }, checked: { type: 'boolean' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.isChecked', 'Return whether a checkbox or switch-like element is checked.', { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.isVisible', 'Return whether a page element is visible.', { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.getValue', 'Read the value of a page form element.', { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.getValues', 'Read values from matching page form elements.', { tabId: { type: 'number' }, selector: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.getAttribute', 'Read an attribute from a page element.', { tabId: { type: 'number' }, selector: { type: 'string' }, attribute: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.select', 'Select one or more options in a native select element.', { tabId: { type: 'number' }, selector: { type: 'string' }, value: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'selector']),
  browserTool('page.consoleLogs', 'Read console logs captured for a controlled tab.', { tabId: { type: 'number' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.assets', 'List images, videos, documents, favicons, and linked assets found on a page.', { tabId: { type: 'number' }, limit: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('page.screenshot', 'Capture a visible-tab screenshot as a data URL.', { tabId: { type: 'number' }, format: { type: 'string' }, quality: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('clipboard.read', 'Read browser clipboard items for a controlled tab.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('clipboard.readText', 'Read browser clipboard text for a controlled tab.', { tabId: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('clipboard.write', 'Write browser clipboard items for a controlled tab.', { tabId: { type: 'number' }, items: { type: 'array' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('clipboard.writeText', 'Write browser clipboard text for a controlled tab.', { tabId: { type: 'number' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'text']),
  browserTool('input.mouseMove', 'Move the browser mouse cursor overlay.', { tabId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId', 'x', 'y']),
  browserTool('input.mouseClick', 'Click browser viewport coordinates.', { tabId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'x', 'y']),
  browserTool('input.mouseDrag', 'Drag between browser viewport coordinates.', { tabId: { type: 'number' }, from: { type: 'object' }, to: { type: 'object' }, path: { type: 'array' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('input.mouseWheel', 'Scroll by browser viewport wheel deltas.', { tabId: { type: 'number' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, sessionId: { type: 'string' } }, ['tabId']),
  browserTool('input.keyboardType', 'Type text through browser keyboard input.', { tabId: { type: 'number' }, text: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'text']),
  browserTool('input.keyboardPress', 'Press a browser keyboard key.', { tabId: { type: 'number' }, key: { type: 'string' }, sessionId: { type: 'string' } }, ['tabId', 'key']),
  browserTool('input.keyboardCombo', 'Press a browser keyboard shortcut.', { tabId: { type: 'number' }, keys: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' } }, ['tabId', 'keys']),
  browserTool('viewport.state', 'Read browser viewport state.', { windowId: { type: 'number' }, sessionId: { type: 'string' } }),
  browserTool('viewport.set', 'Set browser viewport dimensions.', { width: { type: 'number' }, height: { type: 'number' }, windowId: { type: 'number' }, sessionId: { type: 'string' } }, ['width', 'height']),
  browserTool('viewport.reset', 'Reset browser viewport state.', { windowId: { type: 'number' }, sessionId: { type: 'string' } }),
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
