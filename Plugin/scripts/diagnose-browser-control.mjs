#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DesktopBridgeControlClient,
  desktopBridgeDescriptorPath,
  resolveDesktopBridgeEndpoint,
  validateDesktopBridgeDescriptor,
} from './desktop-bridge-client.mjs';

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
const bridgeDescriptorPath = desktopBridgeDescriptorPath();

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
  --timeout-ms <ms>       Desktop Bridge probe timeout. Defaults to 3000.
  --require-connected     Fail unless Desktop Bridge and extension forwarding work.
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

const DIAGNOSTIC_SECRET_KEYS = /(auth(token)?|authorization|cookie|password|otp|token)$/i;

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

function readBridgeDescriptor() {
  const descriptor = readJsonIfExists(bridgeDescriptorPath);
  const check = {
    path: bridgeDescriptorPath,
    exists: Boolean(descriptor),
    ok: false,
    endpoint: null,
    descriptor: null,
    issues: [],
  };
  if (!descriptor) {
    check.issues.push('bridge_descriptor_missing');
    return check;
  }
  if (descriptor.__parseError) {
    check.issues.push(`bridge_descriptor_parse_error:${descriptor.__parseError}`);
    return check;
  }
  try {
    validateDesktopBridgeDescriptor(descriptor);
    check.endpoint = resolveDesktopBridgeEndpoint(descriptor.endpoint);
    check.descriptor = descriptor;
    check.ok = true;
  } catch (error) {
    check.issues.push(`bridge_descriptor_invalid:${error instanceof Error ? error.message : String(error)}`);
  }
  return check;
}

async function probeDesktopBridge(bridge, timeoutMs) {
  const result = {
    endpoint: bridge.endpoint,
    exists: bridge.endpoint?.kind === 'windows_named_pipe'
      ? null
      : exists(bridge.endpoint?.path || ''),
    connected: false,
    handshake: null,
    tools: null,
    issues: [],
  };
  if (!bridge.ok) {
    result.issues.push('bridge_descriptor_unavailable');
    return result;
  }
  if (bridge.endpoint.kind !== 'windows_named_pipe' && !result.exists) {
    result.issues.push('bridge_socket_missing');
    return result;
  }
  const client = new DesktopBridgeControlClient({ timeoutMs });
  try {
    try {
      result.handshake = await client.connect();
      result.connected = true;
    } catch (error) {
      result.issues.push(`bridge_handshake_failed:${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
    try {
      result.tools = await client.listTools(timeoutMs);
    } catch (error) {
      result.issues.push(`extension_forwarding_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await client.close();
  }
  return result;
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
  if (!report.bridge.ok) issues.push(`bridge:${report.bridge.issues.join('|')}`);
  if (report.bridgeProbe.issues.length) issues.push(`bridge_probe:${report.bridgeProbe.issues.join('|')}`);
  if (args.requireConnected && !report.bridgeProbe.connected) issues.push('require_connected_failed');
  if (args.requireConnected && !report.bridgeProbe.tools) issues.push('require_extension_forwarding_failed');
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
  console.log(`Desktop Bridge descriptor: ${report.bridge.ok ? 'ok' : report.bridge.issues.join(', ')} (${report.bridge.path})`);
  const bridgeAddress = report.bridge.endpoint?.path || 'unavailable';
  console.log(`Desktop Bridge: ${report.bridgeProbe.connected ? 'connected' : report.bridgeProbe.issues.join(', ') || 'not connected'} (${bridgeAddress})`);
  if (report.bridgeProbe.tools) {
    const count = Array.isArray(report.bridgeProbe.tools) ? report.bridgeProbe.tools.length : 0;
    console.log(`Extension forwarding: ok (${count} tools)`);
  } else if (report.bridgeProbe.issues.some((issue) => issue.startsWith('extension_forwarding_failed:'))) {
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
  const bridge = readBridgeDescriptor();
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
    bridge,
    bridgeProbe: await probeDesktopBridge(bridge, Math.max(250, Number(args.timeoutMs || 3000))),
    summary: null,
  };
  report.summary = buildSummary(report, args);
  const safeReport = redactDiagnosticSecrets(report);
  for (const rawToken of [
    String(bridge.descriptor?.hostAuthToken || ''),
    String(bridge.descriptor?.controlAuthToken || ''),
  ]) {
    if (rawToken) assert(!JSON.stringify(safeReport).includes(rawToken), 'diagnostic report leaked bridge auth token');
  }
  if (args.json) console.log(JSON.stringify(safeReport, null, 2));
  else printHuman(safeReport);
  if (!args.noFail && !report.summary.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
