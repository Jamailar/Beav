#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'browser-control.identity.json'), 'utf8'));
const hostName = identity.hostName;
const hostScript = path.join(pluginRoot, 'native-host', 'host.mjs');
const hostTemplate = path.join(pluginRoot, 'native-host', `${hostName}.json`);
const nativeHostStateDir = process.env.REDBOX_BROWSER_CONTROL_STATE_DIR || (
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/RedBox/native-host')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'RedBox/native-host')
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'RedBox/native-host')
);
const launcherPath = path.join(nativeHostStateDir, `${hostName}.launcher.sh`);
const extensionSourceRoots = [
  path.join(pluginRoot, 'dist', 'extension'),
  pluginRoot,
  path.join(pluginRoot, 'src'),
].map((item) => path.resolve(item));
const endpointStatePath = process.env.REDBOX_BROWSER_CONTROL_ENDPOINT_STATE
  || path.join(nativeHostStateDir, 'browser-control-agent-endpoint.json');
const defaultSocketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\redbox-browser-control'
  : path.join(os.tmpdir(), `redbox-browser-control-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.sock`);

const browserTargets = process.platform === 'darwin' ? [
  {
    id: 'chrome',
    label: 'Google Chrome',
    profileRoot: path.join(os.homedir(), 'Library/Application Support/Google/Chrome'),
    manifestPath: path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${hostName}.json`),
  },
  {
    id: 'chrome-beta',
    label: 'Google Chrome Beta',
    profileRoot: path.join(os.homedir(), 'Library/Application Support/Google/Chrome Beta'),
    manifestPath: path.join(os.homedir(), 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts', `${hostName}.json`),
  },
  {
    id: 'chrome-canary',
    label: 'Google Chrome Canary',
    profileRoot: path.join(os.homedir(), 'Library/Application Support/Google/Chrome Canary'),
    manifestPath: path.join(os.homedir(), 'Library/Application Support/Google/Chrome Canary/NativeMessagingHosts', `${hostName}.json`),
  },
  {
    id: 'chromium',
    label: 'Chromium',
    profileRoot: path.join(os.homedir(), 'Library/Application Support/Chromium'),
    manifestPath: path.join(os.homedir(), 'Library/Application Support/Chromium/NativeMessagingHosts', `${hostName}.json`),
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    profileRoot: path.join(os.homedir(), 'Library/Application Support/Microsoft Edge'),
    manifestPath: path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', `${hostName}.json`),
  },
  {
    id: 'brave',
    label: 'Brave Browser',
    profileRoot: path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
    manifestPath: path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts', `${hostName}.json`),
  },
] : process.platform === 'win32' ? [
  windowsTarget('chrome', 'Google Chrome', 'Google/Chrome/User Data'),
  windowsTarget('edge', 'Microsoft Edge', 'Microsoft/Edge/User Data'),
  windowsTarget('brave', 'Brave Browser', 'BraveSoftware/Brave-Browser/User Data'),
] : [
  linuxTarget('chrome', 'Google Chrome', 'google-chrome'),
  linuxTarget('chrome-beta', 'Google Chrome Beta', 'google-chrome-beta'),
  linuxTarget('chromium', 'Chromium', 'chromium'),
  linuxTarget('edge', 'Microsoft Edge', 'microsoft-edge'),
  linuxTarget('brave', 'Brave Browser', 'BraveSoftware/Brave-Browser'),
];

function windowsTarget(id, label, relative) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return {
    id,
    label,
    profileRoot: path.join(local, relative),
    manifestPath: path.join(nativeHostStateDir, 'manifests', `${id}.${hostName}.json`),
  };
}

function linuxTarget(id, label, relative) {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const profileRoot = path.join(root, relative);
  return {
    id,
    label,
    profileRoot,
    manifestPath: path.join(profileRoot, 'NativeMessagingHosts', `${hostName}.json`),
  };
}

function parseArgs(argv) {
  const args = {
    browser: '',
    extensionId: process.env.REDBOX_BROWSER_CONTROL_EXTENSION_ID || '',
    json: false,
    noFail: false,
    requireConnected: false,
    timeoutMs: 3000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--browser') args.browser = argv[++index] || '';
    else if (item === '--extension-id') args.extensionId = argv[++index] || '';
    else if (item === '--json') args.json = true;
    else if (item === '--no-fail' || item === '--soft') args.noFail = true;
    else if (item === '--require-connected') args.requireConnected = true;
    else if (item === '--timeout-ms') args.timeoutMs = Number(argv[++index] || args.timeoutMs);
    else if (item === '--help' || item === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/diagnose-browser-control.mjs [options]

Options:
  --browser <id>          Limit manifest checks to chrome, chrome-beta, chrome-canary, chromium, edge, or brave.
  --extension-id <id>     Expected Chrome extension id. Also reads REDBOX_BROWSER_CONTROL_EXTENSION_ID.
  --timeout-ms <ms>       Socket probe timeout. Defaults to 3000.
  --require-connected     Fail unless native-host socket and extension forwarding work.
  --no-fail, --soft       Always exit 0 and print issues in the report.
  --json                  Print JSON instead of human-readable text.
`);
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readJsonIfExists(filePath) {
  if (!exists(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { __parseError: error instanceof Error ? error.message : String(error) };
  }
}

const DIAGNOSTIC_SECRET_KEYS = /^(auth(token)?|authorization|cookie|password|otp|token)$/i;

function redactDiagnosticSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticSecrets(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    DIAGNOSTIC_SECRET_KEYS.test(key) ? '[REDACTED]' : redactDiagnosticSecrets(item),
  ]));
}

function statIfExists(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function executableMode(filePath) {
  const stat = statIfExists(filePath);
  if (!stat) return false;
  return (stat.mode & 0o111) !== 0;
}

function normalizeExtensionId(value) {
  const id = String(value || '').trim();
  return /^[a-p]{32}$/.test(id) ? id : '';
}

function expectedOrigin(extensionId) {
  return extensionId ? `chrome-extension://${extensionId}/` : '';
}

function discoverInstalledExtensions(targets) {
  const matches = [];
  for (const target of targets) {
    if (!exists(target.profileRoot)) continue;
    let profiles = [];
    try {
      profiles = fs.readdirSync(target.profileRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      for (const preferencesFile of ['Preferences', 'Secure Preferences']) {
        const preferencesPath = path.join(target.profileRoot, profile, preferencesFile);
        const preferences = readJsonIfExists(preferencesPath);
        if (!preferences || preferences.__parseError) continue;
        const settings = preferences.extensions?.settings;
        if (!settings || typeof settings !== 'object') continue;
        for (const [id, value] of Object.entries(settings)) {
          if (!value || typeof value !== 'object') continue;
          const manifest = value.manifest && typeof value.manifest === 'object' ? value.manifest : {};
          const sourcePath = typeof value.path === 'string' ? value.path : '';
          const name = typeof manifest.name === 'string' ? manifest.name : '';
          const description = typeof manifest.description === 'string' ? manifest.description : '';
          const sourceMatches = sourcePath && extensionSourceRoots.includes(path.resolve(sourcePath));
          const nameMatches = /Beav|RedBox|RedConvert/i.test(`${name}\n${description}`);
          if (!sourceMatches && !nameMatches) continue;
          matches.push({
            browser: target.id,
            profile,
            preferencesFile,
            id,
            name,
            version: typeof manifest.version === 'string' ? manifest.version : '',
            path: sourcePath,
            state: value.state ?? null,
          });
        }
      }
    }
  }
  return dedupeExtensions(matches);
}

function dedupeExtensions(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.browser}:${item.profile}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function chooseExtensionId(requestedId, extensions) {
  const requested = normalizeExtensionId(requestedId);
  if (requested) return { value: requested, source: 'argument' };
  return { value: normalizeExtensionId(identity.publishedExtensionId), source: 'published_identity' };
}

function checkManifest(target, extensionId) {
  const manifest = readJsonIfExists(target.manifestPath);
  const check = {
    browser: target.id,
    label: target.label,
    path: target.manifestPath,
    exists: Boolean(manifest),
    ok: false,
    issues: [],
    manifest: null,
  };
  if (!manifest) {
    check.issues.push('manifest_missing');
    return check;
  }
  if (manifest.__parseError) {
    check.issues.push(`manifest_parse_error:${manifest.__parseError}`);
    return check;
  }
  check.manifest = {
    name: manifest.name || '',
    hostPath: manifest.path || '',
    type: manifest.type || '',
    allowedOrigins: Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [],
  };
  if (manifest.name !== hostName) check.issues.push(`unexpected_name:${manifest.name || ''}`);
  if (manifest.type !== 'stdio') check.issues.push(`unexpected_type:${manifest.type || ''}`);
  if (!path.isAbsolute(String(manifest.path || ''))) check.issues.push('host_path_not_absolute');
  if (!exists(manifest.path || '')) check.issues.push('host_path_missing');
  if (manifest.path) {
    const resolvedPath = path.resolve(manifest.path);
    const legacyHostScript = path.resolve(hostScript);
    if (resolvedPath === legacyHostScript) check.issues.push('host_path_uses_env_node_script');
  }
  const origin = expectedOrigin(extensionId);
  if (origin && !check.manifest.allowedOrigins.includes(origin)) check.issues.push('extension_origin_missing');
  check.ok = check.issues.length === 0;
  return check;
}

function readEndpointState() {
  const state = readJsonIfExists(endpointStatePath);
  const stat = statIfExists(endpointStatePath);
  const check = {
    path: endpointStatePath,
    exists: Boolean(state),
    ok: false,
    stale: false,
    ageMs: null,
    socketPath: defaultSocketPath,
    endpoint: null,
    state: null,
    issues: [],
  };
  if (!state) {
    check.issues.push('endpoint_state_missing');
    return check;
  }
  if (state.__parseError) {
    check.issues.push(`endpoint_state_parse_error:${state.__parseError}`);
    return check;
  }
  check.state = state;
  check.endpoint = state;
  check.socketPath = state.socketPath || defaultSocketPath;
  const updatedAtMs = Number(state.lastSeenAtMs || state.updatedAtMs || stat?.mtimeMs || 0);
  if (updatedAtMs) {
    check.ageMs = Date.now() - updatedAtMs;
    check.stale = check.ageMs > 2 * 60 * 1000;
    if (check.stale) check.issues.push('endpoint_state_stale');
  }
  if (!state.socketPath && !state.endpoint?.address && !state.tcpAddress) check.issues.push('endpoint_address_missing');
  check.ok = check.issues.length === 0;
  return check;
}

async function probeSocket(endpoint, timeoutMs) {
  const socketPath = endpoint?.socketPath || defaultSocketPath;
  const tcpAddress = String(endpoint?.endpoint?.address || endpoint?.tcpAddress || '');
  const result = {
    socketPath,
    tcpAddress,
    exists: tcpAddress ? null : (process.platform === 'win32' ? null : exists(socketPath)),
    connected: false,
    hostInfo: null,
    toolsList: null,
    issues: [],
  };
  if (!tcpAddress && process.platform !== 'win32' && !exists(socketPath)) {
    result.issues.push('socket_missing');
    return result;
  }
  try {
    result.hostInfo = await sendSocketJsonRpc(endpoint, { jsonrpc: '2.0', id: 'diag:host', method: 'host.getInfo', params: {} }, timeoutMs);
    result.connected = true;
  } catch (error) {
    result.issues.push(`host_get_info_failed:${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  try {
    result.toolsList = await sendSocketJsonRpc(endpoint, { jsonrpc: '2.0', id: 'diag:tools', method: 'tools/list', params: {} }, timeoutMs);
  } catch (error) {
    result.issues.push(`extension_forwarding_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

function sendSocketJsonRpc(endpoint, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const address = String(endpoint?.endpoint?.address || endpoint?.tcpAddress || '');
    const match = address.match(/^127\.0\.0\.1:(\d+)$/);
    const socket = match
      ? net.createConnection({ host: '127.0.0.1', port: Number(match[1]) })
      : net.createConnection(endpoint?.socketPath || defaultSocketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const authToken = String(endpoint?.endpoint?.authToken || endpoint?.authToken || '');
      if (authToken) payload._browserControlAuth = authToken;
      socket.write(`${JSON.stringify(payload)}\n`);
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
        try {
          const message = JSON.parse(line);
          if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
          else resolve(message.result);
        } catch (error) {
          reject(error);
        }
        return;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      if (!buffer.trim()) reject(new Error('socket_closed_without_response'));
    });
  });
}

function buildSummary(report, args) {
  const issues = [];
  if (!report.source.template.exists) issues.push('manifest_template_missing');
  if (report.extensionId.requested && !report.extensionId.valid) issues.push('invalid_extension_id');
  const installedManifests = report.manifests.filter((manifest) => manifest.exists);
  if (args.browser) {
    for (const manifest of report.manifests) {
      if (!manifest.ok) issues.push(`${manifest.browser}:${manifest.issues.join('|')}`);
    }
  } else {
    if (!installedManifests.length) issues.push('no_native_host_manifest');
    for (const manifest of installedManifests) {
      if (!manifest.ok) issues.push(`${manifest.browser}:${manifest.issues.join('|')}`);
    }
  }
  if (!report.endpoint.ok) issues.push(`endpoint:${report.endpoint.issues.join('|')}`);
  if (report.socket.issues.length) issues.push(`socket:${report.socket.issues.join('|')}`);
  if (args.requireConnected && !report.socket.connected) issues.push('require_connected_failed');
  if (args.requireConnected && !report.socket.toolsList) issues.push('require_extension_forwarding_failed');
  return {
    ok: issues.length === 0,
    issues,
  };
}

function printHuman(report) {
  console.log(`RedBox browser-control diagnosis (${report.checkedAt})`);
  console.log(`Host script: ${report.source.hostScript.path} ${report.source.hostScript.exists ? 'exists' : 'missing'} ${report.source.hostScript.executable ? 'executable' : 'not-executable'}`);
  console.log(`Launcher: ${report.source.launcher.path} ${report.source.launcher.exists ? 'exists' : 'missing'} ${report.source.launcher.executable ? 'executable' : 'not-executable'}`);
  console.log(`Manifest template: ${report.source.template.path} ${report.source.template.exists ? 'exists' : 'missing'}`);
  if (report.extensions.length) {
    for (const extension of report.extensions) {
      console.log(`Extension ${extension.id}: ${extension.name || 'unnamed'} ${extension.version || ''} (${extension.browser}/${extension.profile})`);
    }
  } else {
    console.log('Extension: not found in known browser profiles');
  }
  if (report.extensionId.requested || report.extensionId.effective) {
    const effective = report.extensionId.effective || 'none';
    console.log(`Expected extension id: ${effective} (${report.extensionId.source}) ${report.extensionId.valid === false ? 'invalid' : ''}`);
  }
  for (const manifest of report.manifests) {
    console.log(`Manifest ${manifest.browser}: ${manifest.ok ? 'ok' : manifest.issues.join(', ')} (${manifest.path})`);
  }
  console.log(`Endpoint state: ${report.endpoint.ok ? 'ok' : report.endpoint.issues.join(', ')} (${report.endpoint.path})`);
  console.log(`Control endpoint: ${report.socket.connected ? 'connected' : report.socket.issues.join(', ') || 'not connected'} (${report.socket.tcpAddress || report.socket.socketPath})`);
  if (report.socket.hostInfo) {
    console.log(`Host nativeConnected: ${report.socket.hostInfo.nativeConnected === true ? 'true' : 'false'}`);
  }
  if (report.socket.toolsList) {
    const count = Array.isArray(report.socket.toolsList.tools) ? report.socket.toolsList.tools.length : 0;
    console.log(`Extension forwarding: ok (${count} tools)`);
  } else if (report.socket.issues.some((issue) => issue.startsWith('extension_forwarding_failed:'))) {
    console.log('Extension forwarding: failed');
  }
  console.log(`Overall: ${report.summary.ok ? 'ok' : report.summary.issues.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectedTargets = args.browser
    ? browserTargets.filter((target) => target.id === args.browser)
    : browserTargets;
  assert(selectedTargets.length > 0, `Unknown browser target: ${args.browser}`);
  const extensions = discoverInstalledExtensions(selectedTargets);
  const chosenExtensionId = chooseExtensionId(args.extensionId, extensions);
  const extensionId = chosenExtensionId.value;
  const endpoint = readEndpointState();
  const report = {
    checkedAt: new Date().toISOString(),
    source: {
      hostScript: {
        path: hostScript,
        exists: exists(hostScript),
        executable: executableMode(hostScript),
      },
      launcher: {
        path: launcherPath,
        exists: exists(launcherPath),
        executable: executableMode(launcherPath),
      },
      template: {
        path: hostTemplate,
        exists: exists(hostTemplate),
      },
    },
    extensions,
    extensionId: {
      requested: args.extensionId || '',
      effective: extensionId,
      source: chosenExtensionId.source,
      valid: args.extensionId ? Boolean(normalizeExtensionId(args.extensionId)) : null,
    },
    manifests: selectedTargets.map((target) => checkManifest(target, extensionId)),
    endpoint,
    socket: await probeSocket(endpoint.endpoint || { socketPath: endpoint.socketPath || defaultSocketPath }, Math.max(250, Number(args.timeoutMs || 3000))),
    summary: null,
  };
  report.summary = buildSummary(report, args);
  const safeReport = redactDiagnosticSecrets(report);
  const rawAuthToken = String(endpoint.endpoint?.endpoint?.authToken || endpoint.endpoint?.authToken || '');
  if (rawAuthToken) assert(!JSON.stringify(safeReport).includes(rawAuthToken), 'diagnostic report leaked endpoint auth token');
  if (args.json) console.log(JSON.stringify(safeReport, null, 2));
  else printHuman(safeReport);
  if (!args.noFail && !report.summary.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
