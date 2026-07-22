#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserControlTransport, setupBrowserRuntime } from './browser-client.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '..');
const extensionPath = path.join(pluginRoot, 'dist', 'extension');
const hostName = 'com.redbox.browser_control';
const hostScript = path.join(pluginRoot, 'native-host', 'host.mjs');
const defaultRustHostPath = path.join(repositoryRoot, 'desktop', 'src-tauri', 'target', 'debug', 'beav');
const stableChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const args = {
    allowStableChrome: false,
    allowJsHost: false,
    chromePath: process.env.REDBOX_BROWSER_CONTROL_CHROME_PATH || '',
    hostPath: process.env.REDBOX_BROWSER_CONTROL_HOST_PATH || defaultRustHostPath,
    faultMatrix: false,
    keepProfile: false,
    timeoutMs: 20_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--allow-stable-chrome') args.allowStableChrome = true;
    else if (item === '--allow-js-host') args.allowJsHost = true;
    else if (item === '--chrome-path') args.chromePath = argv[++index] || '';
    else if (item === '--host-path') args.hostPath = argv[++index] || '';
    else if (item === '--fault-matrix') args.faultMatrix = true;
    else if (item === '--keep-profile') args.keepProfile = true;
    else if (item === '--timeout-ms') args.timeoutMs = Number(argv[++index] || args.timeoutMs);
    else if (item === '--help' || item === '-h') {
      console.log(`Usage: node scripts/smoke-browser-control-e2e.mjs [options]

Options:
  --chrome-path <path>       Browser binary to launch. Also reads REDBOX_BROWSER_CONTROL_CHROME_PATH.
  --host-path <path>         Native Host executable. Defaults to desktop/src-tauri/target/debug/beav.
  --allow-js-host            Explicitly use Plugin/native-host/host.mjs when the Rust Host is unavailable.
  --fault-matrix             Inject stale descriptor, late response, Host kill, and MV3 worker restart faults.
  --allow-stable-chrome      Allow /Applications/Google Chrome.app as a fallback.
  --keep-profile             Keep the temporary profile directory after the smoke run.
  --timeout-ms <ms>          Wait timeout for extension/socket readiness. Defaults to 20000.
`);
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectedBrowser = chooseBrowser(args);
  assert(fs.existsSync(extensionPath), `Built extension not found: ${extensionPath}. Run pnpm build first.`);
  if (args.allowJsHost) {
    assert(fs.existsSync(hostScript), `Native host script not found: ${hostScript}`);
  } else {
    assert(
      fs.existsSync(args.hostPath),
      `Built Rust Native Host not found: ${args.hostPath}. Build the desktop binary or pass --host-path; use --allow-js-host only for compatibility diagnostics.`,
    );
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'redbox-browser-e2e-'));
  const isolatedHome = path.join(tempRoot, 'home');
  const profileRoot = path.join(tempRoot, 'chrome-profile');
  const endpointPath = path.join(tempRoot, 'browser-control-endpoint.json');
  const endpointsDirectory = path.join(tempRoot, 'browser-control-agent-endpoints');
  const socketPath = path.join(tempRoot, 'browser-control.sock');
  const launcherPath = path.join(tempRoot, 'native-host-launcher.sh');
  const manifestPaths = nativeManifestPathsForBrowser(selectedBrowser.path, profileRoot, isolatedHome);
  const extensionId = extensionIdForUnpackedPath(extensionPath);
  for (const manifestPath of manifestPaths) {
    assertPathInside(tempRoot, manifestPath, 'Native Messaging manifest');
  }
  let chromeProcess = null;
  let transport = null;
  let nativeConnectResult = null;
  try {
    await fsp.mkdir(isolatedHome, { recursive: true });
    await fsp.mkdir(profileRoot, { recursive: true });
    const nativeHostPath = await installNativeHostManifest(extensionId, manifestPaths, launcherPath, args);
    chromeProcess = launchChrome(selectedBrowser.path, profileRoot, endpointPath, endpointsDirectory, socketPath, isolatedHome);
    const devtools = await waitForDevTools(profileRoot, args.timeoutMs, chromeProcess);
    nativeConnectResult = await triggerNativeConnect({
      extensionId,
      port: devtools.port,
      timeoutMs: args.timeoutMs,
    });
    await waitForEndpoint(endpointPath, socketPath, args.timeoutMs, {
      browserPath: selectedBrowser.path,
      child: chromeProcess,
      devtools,
      extensionId,
      manifestPaths,
      nativeConnectResult,
      profileRoot,
    });

    transport = new BrowserControlTransport({ endpointStatePath: endpointPath, endpointsDirectory, timeoutMs: 5000 });
    const hostInfo = await transport.hostInfo();
    assert.equal(hostInfo.hostName, hostName);
    assert.equal(
      args.allowJsHost,
      nativeHostPath === launcherPath,
      'smoke Host selection should only use the JS launcher when --allow-js-host is explicit',
    );
    const tools = await transport.listTools();
    assert(tools.some((tool) => tool.name === 'tab.create'), 'tools/list should include tab.create');
    const researchTool = tools.find((tool) => tool.name === 'research.run');
    const researchStepModes = researchTool?.inputSchema?.properties?.executionMode?.enum || [];
    assert.deepEqual(
      researchStepModes,
      ['macro', 'submit_search', 'extract', 'apply_filters', 'open_item', 'close_item', 'download_media'],
      'current extension should expose page-UI search, item interaction, and research extraction modes',
    );

    const sandbox = {};
    await setupBrowserRuntime({ globals: sandbox, transport, sessionId: 'smoke-session', turnId: 'smoke-turn' });
    const runtimeBrowser = await sandbox.agent.browsers.get('extension');
    await runtimeBrowser.nameSession('browser-control-smoke');
    const tab = await runtimeBrowser.tabs.new({ url: 'https://example.com/', active: true });
    await tab.playwright.waitForLoadState({ state: 'complete', timeoutMs: 10_000 }).catch(() => {});
    const title = await tab.title();
    const linkLocator = tab.playwright.locator('a');
    const linkQuery = await linkLocator.query({ all: true, mode: 'all' });
    const links = await linkLocator.count();
    const linkTexts = await linkLocator.allTextContents();
    const badgeLocator = tab.playwright.locator('#xwow-browser-data-ai-control-badge');
    await badgeLocator.waitFor({ timeoutMs: 5000 });
    const badgeTexts = await badgeLocator.allTextContents();
    assert.match(title || '', /Example Domain/i, 'tab title should come from the loaded page');
    assert(links >= 1, `DOM query should find at least one link on example.com: ${summarize(linkQuery)}`);
    assert(
      linkTexts.some((text) => /Learn more|More information/i.test(text)),
      `DOM query should read example.com link text, received: ${JSON.stringify(linkTexts)}`,
    );
    assert(
      badgeTexts.some((text) => /(?:Beav|RedBox) 控制中/i.test(text)),
      `controlled tab should show the Beav control badge, received: ${JSON.stringify(badgeTexts)}`,
    );
    const researchStepResponse = await transport.callTool('research.run', {
      sessionId: 'smoke-session',
      turnId: 'smoke-turn',
      callId: 'smoke-research-extract',
      site: 'web',
      operation: 'content_scan',
      executionMode: 'extract',
      tabId: Number(tab.id),
      snapshot: false,
    });
    const researchStep = unwrapToolActionData(researchStepResponse);
    assert.equal(
      researchStep.step,
      'extract',
      `atomic research result should unwrap to its step payload: ${summarize(researchStepResponse)}`,
    );
    assert.equal(researchStep.site?.id, 'web');
    assert.equal(researchStep.site?.capabilityVersion, '1.1.0');
    assert.match(researchStep.content?.body || '', /Example Domain/);
    assert.equal(researchStep.response, undefined, 'atomic research evidence should not retain the content-delivery envelope');
    const faults = args.faultMatrix
      ? await runFaultMatrix({
        devtools,
        endpointPath,
        endpointsDirectory,
        extensionId,
        initialHostInfo: hostInfo,
        profileRoot,
        selectedBrowser,
        tabId: tab.id,
        timeoutMs: args.timeoutMs,
        transport,
      })
      : [];
    if (args.faultMatrix) {
      const resumedSandbox = {};
      await setupBrowserRuntime({
        globals: resumedSandbox,
        transport,
        sessionId: 'smoke-session',
        turnId: 'smoke-resume-turn',
      });
      const resumedBrowser = await resumedSandbox.agent.browsers.get('extension');
      assert.equal(resumedBrowser.id, runtimeBrowser.id, 'Resume should rediscover the same extension instance');
      await resumedBrowser.tabs.finalize({ keep: [] });

      const stableExtensionInstanceId = String(hostInfo.extension?.extensionInstanceId || '');
      assert(stableExtensionInstanceId, 'browser restart requires a stable extensionInstanceId');
      await transport.request('host.shutdown', {}, { timeoutMs: 2000 }).catch(() => {});
      await stopChrome(chromeProcess);
      chromeProcess = null;
      await fsp.rm(path.join(profileRoot, 'DevToolsActivePort'), { force: true }).catch(() => {});

      chromeProcess = launchChrome(
        selectedBrowser.path,
        profileRoot,
        endpointPath,
        endpointsDirectory,
        socketPath,
        isolatedHome,
      );
      const restartedDevtools = await waitForDevTools(profileRoot, args.timeoutMs, chromeProcess);
      await triggerNativeConnect({
        extensionId,
        port: restartedDevtools.port,
        timeoutMs: args.timeoutMs,
      });
      await waitForEndpoint(endpointPath, socketPath, args.timeoutMs, {
        browserPath: selectedBrowser.path,
        child: chromeProcess,
        devtools: restartedDevtools,
        extensionId,
        manifestPaths,
        profileRoot,
      });
      transport = new BrowserControlTransport({ endpointStatePath: endpointPath, endpointsDirectory, timeoutMs: 5000 });
      const restartedHostInfo = await transport.hostInfo();
      assert.equal(
        restartedHostInfo.extension?.extensionInstanceId,
        stableExtensionInstanceId,
        'browser restart should preserve the bound extension instance',
      );
      assert.equal(restartedHostInfo.extensionReady, true, 'browser restart should restore extension forwarding');
      faults.push({
        scenario: 'browser_process_restart',
        terminal: 'reconnected',
        extensionInstanceId: stableExtensionInstanceId,
        hostPid: restartedHostInfo.pid,
      });
    } else {
      await runtimeBrowser.tabs.finalize({ keep: [] });
    }
    await transport.request('host.shutdown', {}, { timeoutMs: 2000 }).catch(() => {});

    console.log(JSON.stringify({
      ok: true,
      browser: selectedBrowser.label,
      browserPath: selectedBrowser.path,
      extensionId,
      host: hostInfo.hostName,
      nativeHostPath,
      nativeHostKind: args.allowJsHost ? 'js-compatibility' : 'rust-production',
      manifestPaths,
      tools: tools.length,
      researchStepModes,
      tabId: tab.id,
      title,
      links,
      linkTexts,
      badgeTexts,
      researchStep: {
        step: researchStep.step,
        site: researchStep.site?.id,
        capabilityVersion: researchStep.site?.capabilityVersion,
        contentChars: researchStep.content?.body?.length || 0,
      },
      faults,
      profileRoot: args.keepProfile ? profileRoot : null,
    }, null, 2));
  } finally {
    if (transport) await transport.request('host.shutdown', {}, { timeoutMs: 1000 }).catch(() => {});
    if (chromeProcess) await stopChrome(chromeProcess).catch(() => {});
    try { fs.rmSync(socketPath, { force: true }); } catch {}
    try { fs.rmSync(endpointPath, { force: true }); } catch {}
    if (!args.keepProfile) {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function chooseBrowser(args) {
  const candidates = [];
  if (args.chromePath) {
    candidates.push({ label: 'explicit browser', path: expandHome(args.chromePath) });
  }
  if (!args.chromePath) {
    candidates.push(...defaultBrowserCandidates(args.allowStableChrome));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate.path));
  if (found) return found;
  const attempted = candidates.map((candidate) => `- ${candidate.label}: ${candidate.path}`).join('\n');
  throw new Error(`No browser binary found for extension smoke test. Tried:\n${attempted}`);
}

function defaultBrowserCandidates(allowStableChrome) {
  const home = os.homedir();
  const candidates = [
    {
      label: 'Playwright Chromium 1161',
      path: path.join(home, 'Library/Caches/ms-playwright/chromium-1161/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    },
    {
      label: 'Playwright Chromium 1223',
      path: path.join(home, 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    },
    {
      label: 'Playwright Chromium 1217',
      path: path.join(home, 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    },
    {
      label: 'Chrome for Testing',
      path: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    },
    {
      label: 'Chromium',
      path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    },
    {
      label: 'Homebrew Chromium',
      path: '/opt/homebrew/bin/chromium',
    },
  ];
  if (allowStableChrome) {
    candidates.push({ label: 'Google Chrome stable', path: stableChromePath });
  }
  return candidates;
}

function nativeManifestPathsForBrowser(browserPath, profileRoot = '', isolatedHome = '') {
  assert(isolatedHome, 'isolated HOME is required for browser-control smoke manifests');
  const home = isolatedHome;
  const fileName = `${hostName}.json`;
  const manifestDirs = [];
  if (profileRoot) {
    manifestDirs.push(path.join(profileRoot, 'NativeMessagingHosts'));
  }
  const normalized = browserPath.toLowerCase();
  if (process.platform === 'linux') {
    const configRoot = path.join(home, '.config');
    if (normalized.includes('chromium')) {
      manifestDirs.push(path.join(configRoot, 'chromium', 'NativeMessagingHosts'));
    }
    if (normalized.includes('google-chrome') || normalized.includes('google chrome')) {
      manifestDirs.push(path.join(configRoot, 'google-chrome', 'NativeMessagingHosts'));
    }
    if (normalized.includes('microsoft-edge') || normalized.includes('microsoft edge')) {
      manifestDirs.push(path.join(configRoot, 'microsoft-edge', 'NativeMessagingHosts'));
    }
    if (normalized.includes('brave')) {
      manifestDirs.push(path.join(configRoot, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'));
    }
    if (manifestDirs.length === (profileRoot ? 1 : 0)) {
      manifestDirs.push(path.join(configRoot, 'chromium', 'NativeMessagingHosts'));
      manifestDirs.push(path.join(configRoot, 'google-chrome', 'NativeMessagingHosts'));
    }
    return [...new Set(manifestDirs)].map((dir) => path.join(dir, fileName));
  }
  if (normalized.includes('chromium.app') || normalized.endsWith('/chromium') || normalized.includes('/chromium-')) {
    manifestDirs.push(path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'));
  }
  if (normalized.includes('chrome for testing')) {
    manifestDirs.push(path.join(home, 'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts'));
    manifestDirs.push(path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'));
  }
  if (normalized.includes('google chrome') || normalized.endsWith('/google chrome')) {
    manifestDirs.push(path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'));
  }
  if (manifestDirs.length === 0) {
    manifestDirs.push(path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'));
    manifestDirs.push(path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'));
  }
  return [...new Set(manifestDirs)].map((dir) => path.join(dir, fileName));
}

function launchChrome(browserPath, profileRoot, endpointPath, endpointsDirectory, socketPath, isolatedHome) {
  const args = [
    `--user-data-dir=${profileRoot}`,
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--password-store=basic',
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching',
    'about:blank',
  ];
  const child = spawn(browserPath, args, {
    env: {
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
      XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
      REDBOX_BROWSER_CONTROL_ENDPOINT_STATE: endpointPath,
      REDBOX_BROWSER_CONTROL_ENDPOINTS_DIRECTORY: endpointsDirectory,
      REDBOX_BROWSER_CONTROL_STATE_DIR: path.dirname(endpointPath),
      REDBOX_BROWSER_CONTROL_SOCKET: socketPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  attachStderrRing(child);
  return child;
}

function attachStderrRing(child) {
  const maxChars = 20_000;
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > maxChars) stderr = stderr.slice(-maxChars);
  });
  child.redboxStderr = () => stderr.trim();
  child.redboxPid = child.pid ?? null;
  return child;
}

function extensionIdForUnpackedPath(sourcePath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourcePath, 'manifest.json'), 'utf8'));
  const identityBytes = manifest.key
    ? Buffer.from(manifest.key, 'base64')
    : Buffer.from(path.resolve(sourcePath));
  const hash = createHash('sha256').update(identityBytes).digest();
  let id = '';
  for (const byte of hash.subarray(0, 16)) {
    id += String.fromCharCode(97 + ((byte >> 4) & 0xf));
    id += String.fromCharCode(97 + (byte & 0xf));
  }
  return id;
}

async function waitForDevTools(profileRoot, timeoutMs, child) {
  const activePortPath = path.join(profileRoot, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readOptional(activePortPath).catch(() => null);
    if (text) {
      const [portLine, browserPathLine] = text.trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) {
        return { port, browserWebSocketPath: browserPathLine || '' };
      }
    }
    await delay(100);
  }
  const stderr = typeof child?.redboxStderr === 'function' ? child.redboxStderr() : '';
  throw new Error([
    `Timed out waiting for DevToolsActivePort: ${activePortPath}`,
    stderr ? `stderr:\n${stderr}` : 'stderr=<empty>',
  ].join('\n'));
}

async function triggerNativeConnect({ extensionId, port, timeoutMs }) {
  const extensionUrl = `chrome-extension://${extensionId}/popup.html`;
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const target = await openDevToolsTarget(port, extensionUrl, Math.min(5000, Math.max(1000, deadline - Date.now())));
    const client = await CdpWebSocketClient.connect(target.webSocketDebuggerUrl, Math.min(5000, Math.max(1000, deadline - Date.now())));
    try {
      await client.send('Runtime.enable');
      const readiness = await client.send('Runtime.evaluate', {
        returnByValue: true,
        expression: "typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.sendMessage)",
      });
      if (readiness?.result?.value !== true) {
        lastError = 'extension popup exists but chrome.runtime is not ready';
      } else {
        const evaluated = await client.send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'xwow-data-ai:native-connect' }, (response) => {
              resolve({ response, lastError: chrome.runtime.lastError && chrome.runtime.lastError.message || '' });
            });
          })`,
        });
        if (!evaluated?.exceptionDetails) return evaluated?.result?.value || evaluated?.result || null;
        lastError = `native-connect evaluation failed: ${JSON.stringify(evaluated.exceptionDetails)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      client.close();
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for extension native-connect readiness: ${lastError}`);
}

async function runFaultMatrix(options) {
  const faults = [];
  const staleDescriptorPath = path.join(options.endpointsDirectory, 'stale-smoke-endpoint.json');
  await fsp.mkdir(options.endpointsDirectory, { recursive: true });
  await fsp.writeFile(staleDescriptorPath, `${JSON.stringify({
    instanceId: 'stale-smoke-endpoint',
    tcpAddress: '127.0.0.1:9',
    lastSeenAtMs: Date.now() - 300_000,
  })}\n`, 'utf8');
  const endpointsAfterStale = await options.transport.listEndpoints();
  assert(!endpointsAfterStale.some((endpoint) => endpoint.instanceId === 'stale-smoke-endpoint'));
  assert(!fs.existsSync(staleDescriptorPath), 'stale endpoint descriptor should be removed');
  faults.push({ scenario: 'stale_descriptor', terminal: 'completed', cleaned: true });

  const authenticatedEndpoint = await options.transport.resolveEndpoint();
  assert(authenticatedEndpoint && typeof authenticatedEndpoint === 'object', 'fault matrix requires a descriptor endpoint');
  const invalidAuthEndpoint = structuredClone(authenticatedEndpoint);
  invalidAuthEndpoint.endpoint = {
    ...(invalidAuthEndpoint.endpoint || {}),
    authToken: 'invalid-smoke-auth-token',
  };
  const invalidAuthTransport = new BrowserControlTransport({
    endpoint: invalidAuthEndpoint,
    timeoutMs: 2000,
  });
  await assert.rejects(
    invalidAuthTransport.hostInfo(),
    (error) => /auth/i.test(String(error?.message || error)),
  );
  const hostAfterAuthFailure = await options.transport.hostInfo({ timeoutMs: 2000 });
  assert.equal(hostAfterAuthFailure.instanceId, options.initialHostInfo.instanceId);
  faults.push({
    scenario: 'invalid_auth_token',
    terminal: 'failed',
    hostStillReady: true,
    credentialsLeaked: false,
  });

  const lateCallId = 'smoke-late-response';
  await assert.rejects(
    options.transport.callTool('page.waitForTimeout', {
      sessionId: 'smoke-session',
      turnId: 'smoke-turn',
      tabId: options.tabId,
      timeoutMs: 350,
    }, { id: lateCallId, timeoutMs: 50 }),
    (error) => /timed out/i.test(String(error?.message || error)),
  );
  await delay(500);
  const hostAfterLateResponse = await options.transport.hostInfo({ timeoutMs: 2000 });
  assert.equal(hostAfterLateResponse.instanceId, options.initialHostInfo.instanceId);
  faults.push({ scenario: 'late_response', terminal: 'failed', callId: lateCallId, hostStillReady: true });

  const stableExtensionInstanceId = String(options.initialHostInfo.extension?.extensionInstanceId || '');
  assert(stableExtensionInstanceId, 'fault matrix requires a registered extensionInstanceId');
  const killedPid = Number(options.initialHostInfo.pid);
  assert(Number.isInteger(killedPid) && killedPid > 1 && killedPid !== process.pid, `invalid Native Host pid: ${killedPid}`);
  process.kill(killedPid, 'SIGKILL');
  await delay(250);
  await triggerNativeConnect({ extensionId: options.extensionId, port: options.devtools.port, timeoutMs: options.timeoutMs });
  const recoveredAfterKill = await waitForRecoveredHost({
    ...options,
    previousInstanceId: options.initialHostInfo.instanceId,
    extensionInstanceId: stableExtensionInstanceId,
  });
  await removeEndpointDescriptor(options.endpointsDirectory, options.initialHostInfo.instanceId);
  faults.push({
    scenario: 'host_kill_socket_disconnect',
    terminal: 'failed_then_recovered',
    previousPid: killedPid,
    recoveredPid: recoveredAfterKill.pid,
    endpointRotated: recoveredAfterKill.instanceId !== options.initialHostInfo.instanceId,
  });

  await stopExtensionServiceWorker({
    browserWebSocketPath: options.devtools.browserWebSocketPath,
    extensionId: options.extensionId,
    port: options.devtools.port,
    timeoutMs: options.timeoutMs,
  });
  await delay(500);
  await triggerNativeConnect({ extensionId: options.extensionId, port: options.devtools.port, timeoutMs: options.timeoutMs });
  const recoveredAfterReload = await waitForRecoveredHost({
    ...options,
    previousInstanceId: recoveredAfterKill.instanceId,
    extensionInstanceId: stableExtensionInstanceId,
  });
  await removeEndpointDescriptor(options.endpointsDirectory, recoveredAfterKill.instanceId);
  assert.equal(recoveredAfterReload.extension?.extensionInstanceId, stableExtensionInstanceId);
  faults.push({
    scenario: 'extension_service_worker_restart',
    terminal: 'reconciled',
    extensionInstanceId: stableExtensionInstanceId,
    endpointRotated: recoveredAfterReload.instanceId !== recoveredAfterKill.instanceId,
  });
  return faults;
}

async function stopExtensionServiceWorker({ browserWebSocketPath, extensionId, port, timeoutMs }) {
  assert(browserWebSocketPath, 'DevTools browser WebSocket path is required to restart the extension service worker');
  const browserWebSocketUrl = `ws://127.0.0.1:${port}${browserWebSocketPath}`;
  const client = await CdpWebSocketClient.connect(browserWebSocketUrl, timeoutMs);
  try {
    const targets = await client.send('Target.getTargets');
    const worker = (targets?.targetInfos || []).find((target) => (
      target.type === 'service_worker'
      && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)
    ));
    assert(worker?.targetId, `extension service worker target not found for ${extensionId}`);
    const closed = await client.send('Target.closeTarget', { targetId: worker.targetId });
    assert.equal(closed?.success, true, 'extension service worker target should stop cleanly');
    return { success: true, targetId: worker.targetId };
  } finally {
    client.close();
  }
}

async function waitForRecoveredHost(options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const discovery = new BrowserControlTransport({
      browserId: options.extensionInstanceId,
      endpointStatePath: options.endpointPath,
      endpointsDirectory: options.endpointsDirectory,
      timeoutMs: 2000,
    });
    try {
      const endpoints = await discovery.listEndpoints();
      const candidates = endpoints.filter((endpoint) => (
        endpoint.instanceId !== options.previousInstanceId
        && endpoint.extension?.extensionInstanceId === options.extensionInstanceId
      ));
      for (const endpoint of candidates) {
        try {
          const info = await discovery.withEndpoint(endpoint).hostInfo({ timeoutMs: 1000 });
          if (info.extensionReady === true && info.instanceId !== options.previousInstanceId) return info;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for recovered Native Host: ${lastError}`);
}

async function removeEndpointDescriptor(endpointsDirectory, instanceId) {
  if (!instanceId) return;
  await fsp.rm(path.join(endpointsDirectory, `${instanceId}.json`), { force: true }).catch(() => {});
}

async function openDevToolsTarget(port, targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const target = await requestDevToolsJson(port, `/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
      if (target?.webSocketDebuggerUrl) return target;
      lastError = `missing webSocketDebuggerUrl: ${JSON.stringify(target)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const existing = await findDevToolsTarget(port, targetUrl).catch(() => null);
      if (existing?.webSocketDebuggerUrl) return existing;
    }
    await delay(250);
  }
  throw new Error(`Timed out opening DevTools target ${targetUrl}: ${lastError}`);
}

async function findDevToolsTarget(port, targetUrl) {
  const targets = await requestDevToolsJson(port, '/json/list');
  return (Array.isArray(targets) ? targets : []).find((target) => target?.url === targetUrl) || null;
}

async function requestDevToolsJson(port, requestPath, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method: options.method || 'GET',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

class CdpWebSocketClient {
  constructor(socket, leftover = Buffer.alloc(0)) {
    this.nextId = 0;
    this.pending = new Map();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.rejectAll(new Error('CDP WebSocket closed')));
    socket.on('error', (error) => this.rejectAll(error));
    if (leftover.length) this.handleData(leftover);
  }

  static async connect(wsUrl, timeoutMs) {
    const url = new URL(wsUrl);
    const port = Number(url.port || 80);
    const host = url.hostname || '127.0.0.1';
    const requestPath = `${url.pathname}${url.search}`;
    const key = randomBytes(16).toString('base64');
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting CDP WebSocket: ${wsUrl}`));
      }, Math.min(Number(timeoutMs || 5000), 10_000));
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('connect', () => {
        socket.write([
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'));
      });
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        clearTimeout(timer);
        const header = buffer.slice(0, end).toString('utf8');
        const leftover = buffer.slice(end + 4);
        if (!/^HTTP\/1\.1 101\b/i.test(header)) {
          socket.destroy();
          reject(new Error(`CDP WebSocket handshake failed: ${header.split(/\r?\n/)[0] || header}`));
          return;
        }
        resolve(new CdpWebSocketClient(socket, leftover));
      };
      socket.on('data', onData);
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP WebSocket is closed'));
    this.nextId += 1;
    const id = this.nextId;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeWebSocketFrame(Buffer.from(payload, 'utf8'), 0x1));
    });
  }

  close() {
    this.closed = true;
    try {
      this.socket.end(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
      this.socket.destroy();
    } catch {}
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = decodeWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.slice(frame.frameLength);
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      let message = null;
      try {
        message = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        continue;
      }
      if (message.id == null) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function encodeWebSocketFrame(payload, opcode) {
  const length = payload.length;
  let header = null;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { frameLength: offset + length, opcode, payload };
}

async function stopChrome(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    onceExit(child),
    delay(3000).then(() => child.kill('SIGKILL')),
  ]);
}

function onceExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function findExtensionId(profileRoot) {
  const profileDirs = await fsp.readdir(profileRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of profileDirs) {
    if (!entry.isDirectory()) continue;
    const profile = path.join(profileRoot, entry.name);
    for (const preferencesFile of ['Secure Preferences', 'Preferences']) {
      const preferences = await readJsonOptional(path.join(profile, preferencesFile));
      const settings = preferences?.extensions?.settings;
      if (!settings || typeof settings !== 'object') continue;
      for (const [id, value] of Object.entries(settings)) {
        if (!value || typeof value !== 'object') continue;
        const sourcePath = typeof value.path === 'string' ? path.resolve(value.path) : '';
        if (sourcePath === path.resolve(extensionPath)) return id;
      }
    }
  }
  return '';
}

async function installNativeHostManifest(extensionId, manifestPaths, launcherPath, args) {
  const resolvedHostPath = args.allowJsHost
    ? launcherPath
    : path.resolve(expandHome(args.hostPath));
  if (args.allowJsHost) {
    await fsp.writeFile(launcherPath, [
      '#!/bin/sh',
      '# Generated by RedBox browser-control smoke test.',
      `exec ${shellQuote(process.execPath)} ${shellQuote(hostScript)} "$@"`,
      '',
    ].join('\n'), 'utf8');
    await fsp.chmod(launcherPath, 0o755);
  } else {
    assert(fs.existsSync(resolvedHostPath), `Native Host executable not found: ${resolvedHostPath}`);
  }
  const manifest = {
    name: hostName,
    description: 'RedBox browser control native messaging host',
    path: resolvedHostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  await fsp.chmod(hostScript, 0o755);
  for (const manifestPath of manifestPaths) {
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return resolvedHostPath;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function waitForEndpoint(endpointPath, socketPath, timeoutMs, diagnostics = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    const endpoint = await readJsonOptional(endpointPath).catch(() => null);
    if (endpoint?.endpoint?.address || endpoint?.tcpAddress) return;
    await delay(200);
  }
  const child = diagnostics.child;
  const stderr = typeof child?.redboxStderr === 'function' ? child.redboxStderr() : '';
  const childState = child
    ? `pid=${child.redboxPid || ''} exit=${child.exitCode ?? ''} signal=${child.signalCode ?? ''}`
    : 'pid=';
  const registeredExtensionId = diagnostics.profileRoot
    ? await findExtensionId(diagnostics.profileRoot).catch(() => '')
    : '';
  throw new Error([
    `Timed out waiting for browser-control endpoint: ${endpointPath}`,
    `browserPath=${diagnostics.browserPath || ''}`,
    `profileRoot=${diagnostics.profileRoot || ''}`,
    `extensionPath=${extensionPath}`,
    `expectedExtensionId=${diagnostics.extensionId || ''}`,
    `registeredExtensionId=${registeredExtensionId || ''}`,
    `manifestPaths=${(diagnostics.manifestPaths || []).join(',')}`,
    `nativeConnectResult=${JSON.stringify(diagnostics.nativeConnectResult || null)}`,
    `devtools=${JSON.stringify(diagnostics.devtools || null)}`,
    `chrome=${childState}`,
    stderr ? `stderr:\n${stderr}` : 'stderr=<empty>',
  ].join('\n'));
}

async function readOptional(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonOptional(filePath) {
  const text = await readOptional(filePath);
  return text == null ? null : JSON.parse(text);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expandHome(value) {
  if (!value.startsWith('~')) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function assertPathInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${label} must stay inside the isolated smoke directory: ${candidate}`,
  );
}

function summarize(value) {
  const text = JSON.stringify(value);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function unwrapToolActionData(value) {
  const action = value?.result ?? value;
  if (action?.kind === 'browser_research_step' || action?.step) return action;
  if (action?.response && typeof action.response === 'object') return action.response;
  if (action?.result && typeof action.result === 'object') return unwrapToolActionData(action.result);
  if (action?.data && typeof action.data === 'object') return unwrapToolActionData(action.data);
  const contentText = action?.content?.find?.((item) => item?.type === 'text' && typeof item.text === 'string')?.text;
  if (contentText) {
    try {
      return unwrapToolActionData(JSON.parse(contentText));
    } catch {}
  }
  return action?.result ?? action?.data ?? action;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
