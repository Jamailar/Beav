#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = __dirname;
const identity = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'browser-control.identity.json'), 'utf8'));
const hostName = String(identity.hostName || 'com.redbox.browser_control');
const hostScript = path.join(__dirname, 'native-host', 'host.mjs');
const templatePath = path.join(__dirname, 'native-host', `${hostName}.json`);
const nativeHostStateDir = path.join(resolvePlatformDataRoot(), 'RedBox', 'native-host');
const launcherPath = path.join(nativeHostStateDir, `${hostName}.launcher.sh`);
const extensionSourceRoots = [
  path.join(pluginRoot, 'dist', 'extension'),
  pluginRoot,
  path.join(pluginRoot, 'src'),
].map((item) => path.resolve(item));
const browserTargets = buildBrowserTargets();

function resolvePlatformDataRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function buildBrowserTargets() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      windowsBrowserTarget('chrome', 'Google Chrome', path.join(local, 'Google/Chrome/User Data'), 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts'),
      windowsBrowserTarget('edge', 'Microsoft Edge', path.join(local, 'Microsoft/Edge/User Data'), 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts'),
      windowsBrowserTarget('brave', 'Brave Browser', path.join(local, 'BraveSoftware/Brave-Browser/User Data'), 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'darwin') {
    const root = path.join(os.homedir(), 'Library/Application Support');
    return [
      unixBrowserTarget('chrome', 'Google Chrome', root, 'Google/Chrome'),
      unixBrowserTarget('chrome-beta', 'Google Chrome Beta', root, 'Google/Chrome Beta'),
      unixBrowserTarget('chrome-canary', 'Google Chrome Canary', root, 'Google/Chrome Canary'),
      unixBrowserTarget('chromium', 'Chromium', root, 'Chromium'),
      unixBrowserTarget('edge', 'Microsoft Edge', root, 'Microsoft Edge'),
      unixBrowserTarget('brave', 'Brave Browser', root, 'BraveSoftware/Brave-Browser'),
    ];
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return [
    unixBrowserTarget('chrome', 'Google Chrome', config, 'google-chrome'),
    unixBrowserTarget('chrome-beta', 'Google Chrome Beta', config, 'google-chrome-beta'),
    unixBrowserTarget('chromium', 'Chromium', config, 'chromium'),
    unixBrowserTarget('edge', 'Microsoft Edge', config, 'microsoft-edge'),
    unixBrowserTarget('brave', 'Brave Browser', config, 'BraveSoftware/Brave-Browser'),
  ];
}

function unixBrowserTarget(id, label, root, relative) {
  const profileRoot = path.join(root, relative);
  return { id, label, profileRoot, manifestPath: path.join(profileRoot, 'NativeMessagingHosts', `${hostName}.json`) };
}

function windowsBrowserTarget(id, label, profileRoot, registryRoot) {
  return {
    id,
    label,
    profileRoot,
    manifestPath: path.join(nativeHostStateDir, 'manifests', `${id}.${hostName}.json`),
    registryKey: `${registryRoot}\\${hostName}`,
  };
}

function parseArgs(argv) {
  const out = {
    browser: '',
    dryRun: false,
    extensionId: process.env.REDBOX_BROWSER_CONTROL_EXTENSION_ID || '',
    json: false,
    node: process.env.REDBOX_BROWSER_CONTROL_NODE || process.env.REDBOX_NATIVE_NODE || '',
    hostPath: process.env.REDBOX_BROWSER_CONTROL_HOST_PATH || '',
    target: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--extension-id') out.extensionId = argv[++index] || '';
    else if (item === '--browser') out.browser = argv[++index] || '';
    else if (item === '--node') out.node = argv[++index] || '';
    else if (item === '--host-path') out.hostPath = argv[++index] || '';
    else if (item === '--all') out.browser = 'all';
    else if (item === '--target') out.target = argv[++index] || '';
    else if (item === '--dry-run') out.dryRun = true;
    else if (item === '--json') out.json = true;
    else if (item === '--help' || item === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node install-native-host.mjs [options]

Options:
  --extension-id <id>     Chrome extension id. Defaults to REDBOX_BROWSER_CONTROL_EXTENSION_ID.
  --browser <id|all>      Install for chrome, chrome-beta, chrome-canary, chromium, edge, brave, or all.
                          Defaults to browsers where a RedBox extension is discovered; with an explicit
                          extension id and no discovered browser, defaults to chrome for compatibility.
  --node <path>           Absolute Node.js executable for GUI-launched browsers. Defaults to
                          REDBOX_BROWSER_CONTROL_NODE, REDBOX_NATIVE_NODE, then the current node.
  --host-path <path>      Native host executable. Required on Windows; desktop builds install this automatically.
  --all                   Alias for --browser all.
  --target <path>         Write one manifest to an explicit path.
  --dry-run               Print the planned manifest writes without changing files.
  --json                  Print a structured JSON result.
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
  } catch {
    return null;
  }
}

function normalizeExtensionId(value) {
  const id = String(value || '').trim();
  return /^[a-p]{32}$/.test(id) ? id : '';
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
        const settings = preferences?.extensions?.settings;
        if (!settings || typeof settings !== 'object') continue;
        for (const [id, value] of Object.entries(settings)) {
          if (!value || typeof value !== 'object') continue;
          const manifest = value.manifest && typeof value.manifest === 'object' ? value.manifest : {};
          const sourcePath = typeof value.path === 'string' ? value.path : '';
          const sourceMatches = sourcePath && extensionSourceRoots.includes(path.resolve(sourcePath));
          const name = typeof manifest.name === 'string' ? manifest.name : '';
          const description = typeof manifest.description === 'string' ? manifest.description : '';
          const nameMatches = /Beav|RedBox|RedConvert/i.test(`${name}\n${description}`);
          const extensionId = normalizeExtensionId(id);
          if (!extensionId || (!sourceMatches && !nameMatches)) continue;
          matches.push({
            browser: target.id,
            profile,
            preferencesFile,
            id: extensionId,
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

function selectExtensionId(args, extensions) {
  const requested = normalizeExtensionId(args.extensionId);
  if (requested) return { value: requested, source: 'argument' };
  const published = normalizeExtensionId(identity.publishedExtensionId);
  if (!published) throw new Error('browser-control.identity.json has an invalid publishedExtensionId');
  return { value: published, source: 'published_identity' };
}

function selectTargets(args, extensions, extensionIdSource) {
  if (args.target) {
    return [{
      id: 'custom',
      label: 'Custom manifest target',
      manifestPath: path.resolve(args.target),
    }];
  }
  if (args.browser) {
    const requested = args.browser === 'all'
      ? browserTargets.map((target) => target.id)
      : args.browser.split(',').map((item) => item.trim()).filter(Boolean);
    const targets = requested.map((id) => {
      const target = browserTargets.find((item) => item.id === id);
      if (!target) throw new Error(`Unknown browser target: ${id}. Expected one of ${browserTargets.map((item) => item.id).join(', ')}, all.`);
      return target;
    });
    return dedupeTargets(targets);
  }
  if (extensionIdSource === 'discovered' || extensions.length > 0) {
    const discoveredBrowsers = [...new Set(extensions.map((extension) => extension.browser))];
    const targets = discoveredBrowsers
      .map((id) => browserTargets.find((target) => target.id === id))
      .filter(Boolean);
    if (targets.length) return dedupeTargets(targets);
  }
  return [browserTargets.find((target) => target.id === 'chrome')];
}

function dedupeTargets(targets) {
  const seen = new Set();
  const out = [];
  for (const target of targets) {
    if (!target || seen.has(target.manifestPath)) continue;
    seen.add(target.manifestPath);
    out.push(target);
  }
  return out;
}

function resolveNodeExecutable(args) {
  const candidates = [
    args.node,
    process.execPath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const filePath = path.resolve(candidate);
    if (path.isAbsolute(filePath) && exists(filePath)) return filePath;
  }
  throw new Error('No Node.js executable found for the native host launcher. Pass --node <absolute path>.');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildLauncher(nodePath) {
  return [
    '#!/bin/sh',
    '# Generated by RedBox browser-control native host installer.',
    `exec ${shellQuote(nodePath)} ${shellQuote(hostScript)} "$@"`,
    '',
  ].join('\n');
}

function installLauncher(nodePath, dryRun, explicitHostPath = '') {
  if (explicitHostPath) {
    const hostPath = path.resolve(explicitHostPath);
    if (!exists(hostPath)) throw new Error(`Native host executable not found: ${hostPath}`);
    return { path: hostPath, node: '', hostScript: '', installed: false, source: 'explicit_host' };
  }
  if (process.platform === 'win32') {
    throw new Error('Windows requires --host-path <desktop executable>; packaged Beav installs the native host automatically.');
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncher(nodePath));
    fs.chmodSync(launcherPath, 0o755);
  }
  return {
    path: launcherPath,
    node: nodePath,
    hostScript,
    installed: !dryRun,
    source: 'node_launcher',
  };
}

function buildManifest(extensionId, hostPath) {
  return fs.readFileSync(templatePath, 'utf8')
    .replace('__HOST_PATH__', hostPath)
    .replace('__EXTENSION_ID__', extensionId);
}

function installManifest(target, manifest, dryRun) {
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target.manifestPath), { recursive: true });
    fs.writeFileSync(target.manifestPath, manifest);
  }
  if (!dryRun && target.registryKey) {
    const result = spawnSync('reg.exe', ['ADD', target.registryKey, '/ve', '/t', 'REG_SZ', '/d', target.manifestPath, '/f'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Failed to register ${target.label} native host: ${result.stderr || result.stdout}`);
  }
  return {
    browser: target.id,
    label: target.label,
    path: target.manifestPath,
    installed: !dryRun,
    registryKey: target.registryKey || '',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!exists(hostScript)) throw new Error(`Native host script not found: ${hostScript}`);
  if (!exists(templatePath)) throw new Error(`Native host template not found: ${templatePath}`);
  const extensions = discoverInstalledExtensions(browserTargets);
  const extensionId = selectExtensionId(args, extensions);
  const targets = selectTargets(args, extensions, extensionId.source);
  const nodePath = args.hostPath ? '' : resolveNodeExecutable(args);
  const launcher = installLauncher(nodePath, args.dryRun, args.hostPath);
  if (!args.dryRun) fs.chmodSync(hostScript, 0o755);
  const manifest = buildManifest(extensionId.value, launcher.path);
  const installations = targets.map((target) => installManifest(target, manifest, args.dryRun));
  const result = {
    ok: true,
    dryRun: args.dryRun,
    hostName,
    hostScript,
    launcher,
    extensionId: extensionId.value,
    extensionIdSource: extensionId.source,
    discoveredExtensions: extensions,
    installations,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const item of installations) {
    const verb = args.dryRun ? 'would install' : 'installed';
    console.log(`[native-host] ${verb} ${item.label}: ${item.path}`);
  }
  console.log(`[native-host] host ${args.dryRun ? 'would use' : 'uses'} ${launcher.path}`);
  console.log(`[native-host] allowed origin chrome-extension://${extensionId.value}/ (${extensionId.source})`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
