import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChromeManifestVersion, toChromeManifestVersion } from './sync-manifest-version.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '..');
const sourceDir = path.join(pluginRoot, 'src');
const outputDir = path.join(pluginRoot, 'dist', 'extension');

async function exists(filePath) {
  await access(filePath);
}

async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

function collectManifestFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) {
      files.add(value);
    }
  };

  add(manifest.background?.service_worker);
  add(manifest.options_page);
  add(manifest.side_panel?.default_path);

  for (const value of Object.values(manifest.icons || {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) add(value);

  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }

  for (const resourceGroup of manifest.web_accessible_resources || []) {
    for (const file of resourceGroup.resources || []) add(file);
  }

  return files;
}

function collectHtmlRefs(html) {
  const refs = new Set();
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/g;
  for (const match of html.matchAll(attrPattern)) {
    const value = match[1];
    if (!value || /^(?:https?:|data:|#)/i.test(value)) continue;
    refs.add(value);
  }
  return refs;
}

function collectDynamicScriptFiles(backgroundSource) {
  const files = new Set();
  const filesArrayPattern = /files\s*:\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
  for (const match of backgroundSource.matchAll(filesArrayPattern)) {
    files.add(match[1]);
  }
  return files;
}

function extractQuotedStringList(source, regex, label) {
  const match = source.match(regex);
  assert(match, `Could not find ${label}`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

function extractBackgroundMcpTools(source) {
  const match = source.match(/const BROWSER_CONTROL_MCP_TOOLS = \[([\s\S]*?)\n\];/);
  assert(match, 'Could not find BROWSER_CONTROL_MCP_TOOLS');
  return [...match[1].matchAll(/name: '([^']+)'/g)].map((item) => item[1]);
}

function extractJsFallbackTools(source) {
  const match = source.match(/const FALLBACK_TOOLS = \[([\s\S]*?)\n\];/);
  assert(match, 'Could not find FALLBACK_TOOLS');
  return [...match[1].matchAll(/browserTool\('([^']+)'/g)].map((item) => item[1]);
}

function extractRustToolConst(source, constName) {
  return extractQuotedStringList(
    source,
    new RegExp(`const ${constName}: &\\[&str\\] = &\\[([\\s\\S]*?)\\n\\];`),
    constName,
  );
}

function diffList(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function assertSameSet(leftName, left, rightName, right) {
  const leftOnly = diffList(left, right);
  const rightOnly = diffList(right, left);
  assert.equal(leftOnly.length, 0, `${leftName} contains tools missing from ${rightName}: ${leftOnly.join(', ')}`);
  assert.equal(rightOnly.length, 0, `${rightName} contains tools missing from ${leftName}: ${rightOnly.join(', ')}`);
}

async function assertOutputFile(relativePath) {
  assert(!relativePath.includes('..'), `Invalid output reference: ${relativePath}`);
  await exists(path.join(outputDir, relativePath));
}

const sourceManifest = await readJson(path.join(sourceDir, 'manifest.json'));
const outputManifest = await readJson(path.join(outputDir, 'manifest.json'));
const packageJson = await readJson(path.join(pluginRoot, 'package.json'));
const browserIdentity = await readJson(path.join(pluginRoot, 'browser-control.identity.json'));
const siteResearchCapabilities = await readJson(path.join(sourceDir, 'background', 'siteResearchCapabilities.json'));
assert.deepEqual(outputManifest, sourceManifest, 'Built manifest must match source manifest exactly');
assert.equal(
  assertChromeManifestVersion(outputManifest.version),
  toChromeManifestVersion(packageJson.version),
  'Manifest version must be a Chrome-compatible projection of package.json version',
);
const extensionIdFromKey = crypto.createHash('sha256')
  .update(Buffer.from(outputManifest.key, 'base64'))
  .digest()
  .subarray(0, 16)
  .toString('hex')
  .replace(/[0-9a-f]/g, (value) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(value, 16)));
assert.equal(outputManifest.key, browserIdentity.manifestPublicKey, 'Built manifest must use the published extension public key');
assert.equal(extensionIdFromKey, browserIdentity.publishedExtensionId, 'Built manifest key must derive the published extension id');
assert.equal(
  outputManifest.version_name,
  packageJson.version,
  'Manifest version_name must preserve the release version shown to users',
);
assert.equal(siteResearchCapabilities.schemaVersion, 1, 'Site research capability schema must be versioned');
assert.equal(siteResearchCapabilities.contractVersion, 3, 'Site research capability contract must match Desktop');
assert(siteResearchCapabilities.capabilities.length > 0, 'Site research capability registry must not be empty');
const siteCapabilityIds = new Set();
const siteCapabilityHosts = new Set();
for (const capability of siteResearchCapabilities.capabilities) {
  assert(!siteCapabilityIds.has(capability.id), `Duplicate site research capability id: ${capability.id}`);
  siteCapabilityIds.add(capability.id);
  assert(Array.isArray(capability.supportedOperations) && capability.supportedOperations.length > 0, `${capability.id} must declare operations`);
  assert.match(capability.extractorSchemaHash, /^[a-f0-9]{64}$/, `${capability.id} must declare a sha256 extractor schema hash`);
  for (const host of capability.hostPatterns || []) {
    assert(!siteCapabilityHosts.has(host), `Duplicate site research host: ${host}`);
    siteCapabilityHosts.add(host);
  }
}

for (const file of collectManifestFiles(outputManifest)) {
  await assertOutputFile(file);
}

for (const htmlFile of ['popup.html', 'settings.html', 'sidepanel.html']) {
  const sourceHtml = await readText(path.join(sourceDir, htmlFile));
  const outputHtml = await readText(path.join(outputDir, htmlFile));
  assert.equal(outputHtml, sourceHtml, `${htmlFile} should be copied without rewriting`);
  for (const ref of collectHtmlRefs(outputHtml)) {
    await assertOutputFile(ref);
  }
}

for (const cssFile of ['popup.css', 'settings.css', 'sidepanel.css']) {
  const sourceCss = await readText(path.join(sourceDir, cssFile));
  const outputCss = await readText(path.join(outputDir, cssFile));
  assert.equal(outputCss, sourceCss, `${cssFile} should be copied without rewriting`);
}

const backgroundSource = await readText(path.join(sourceDir, 'background.js'));
for (const file of collectDynamicScriptFiles(backgroundSource)) {
  await assertOutputFile(file);
}
const dynamicContentInjectionSource = await readText(path.join(sourceDir, 'background', 'dynamicContentInjection.js'));
for (const file of collectDynamicScriptFiles(dynamicContentInjectionSource)) {
  await assertOutputFile(file);
}
await assertOutputFile('browserControlContent.js');
await assertOutputFile('images/cursor-chat.png');

for (const permission of ['debugger', 'nativeMessaging', 'webNavigation', 'tabGroups']) {
  assert(outputManifest.permissions.includes(permission), `Manifest must include ${permission} permission`);
}
assert(outputManifest.host_permissions.includes('<all_urls>'), 'Manifest must include <all_urls> for generic browser control');

const builtBackground = await readText(path.join(outputDir, 'background.js'));
assert(!/^\s*import\s/m.test(builtBackground), 'Background service worker must not rely on ESM imports');
assert(builtBackground.includes('redbox-browser-control'), 'Built background should include browser-control runtime');
assert(builtBackground.includes('extension.register'), 'Built background should register its stable extension instance with the native host');
assert(builtBackground.includes('registrationSucceeded'), 'Built background should report extension registration truth separately from host connectivity');
for (const capability of siteResearchCapabilities.capabilities) {
  assert(builtBackground.includes(capability.capabilityVersion), `Built background must include ${capability.id} capability version`);
  assert(builtBackground.includes(capability.extractorSchemaHash), `Built background must include ${capability.id} extractor hash`);
}

const builtObserver = await readText(path.join(outputDir, 'pageObserver.js'));
assert(builtObserver.includes('page-state:get'), 'Built pageObserver should retain page-state message handling');
assert(builtObserver.includes('pageRouteBridge.js'), 'Built pageObserver should retain page route bridge injection');
assert(!builtObserver.includes('redbox-page-overlay-host'), 'Built pageObserver must not inject a floating capture overlay');

const browserMcpConfig = await readJson(path.join(pluginRoot, '.mcp.json'));
const configuredBrowserTools = browserMcpConfig.mcpServers?.['browser-control']?.enabledTools || [];
assert(configuredBrowserTools.length > 0, 'Browser MCP config must expose enabledTools');

const browserControlBackgroundSource = await readText(path.join(sourceDir, 'browserControlBackground.js'));
const backgroundBrowserTools = extractBackgroundMcpTools(browserControlBackgroundSource);
const jsFallbackBrowserTools = extractJsFallbackTools(await readText(path.join(pluginRoot, 'mcp-server.mjs')));
const rustBrowserMcpSource = await readText(path.join(repositoryRoot, 'desktop/src-tauri/src/browser_control_mcp.rs'));
const rustEnabledBrowserTools = extractRustToolConst(rustBrowserMcpSource, 'ENABLED_TOOLS');
assertSameSet('.mcp enabledTools', configuredBrowserTools, 'browserControlBackground tools', backgroundBrowserTools);
assertSameSet('.mcp enabledTools', configuredBrowserTools, 'mcp-server fallback tools', jsFallbackBrowserTools);
assertSameSet('.mcp enabledTools', configuredBrowserTools, 'Rust browser MCP tools', rustEnabledBrowserTools);

const browserActionCases = new Set([...browserControlBackgroundSource.matchAll(/case '([^']+)'/g)].map((item) => item[1]));
const missingBrowserActionCases = configuredBrowserTools.filter((toolName) => !browserActionCases.has(toolName));
assert.equal(
  missingBrowserActionCases.length,
  0,
  `Browser MCP tools must have browserControlBackground switch cases: ${missingBrowserActionCases.join(', ')}`,
);

const configuredReadOnlyTools = Object.entries(browserMcpConfig.mcpServers?.['browser-control']?.perTool || {})
  .filter(([, policy]) => policy?.approvalMode === 'never')
  .map(([toolName]) => toolName);
const rustReadOnlyBrowserTools = extractRustToolConst(rustBrowserMcpSource, 'READ_ONLY_TOOLS');
assertSameSet('.mcp read-only browser tools', configuredReadOnlyTools, 'Rust read-only browser tools', rustReadOnlyBrowserTools);

for (const toolName of [
  'tab.back',
  'tab.forward',
  'page.waitForURL',
  'page.waitForTimeout',
  'page.evaluate',
  'page.queryElements',
  'tabs.finalize',
]) {
  assert(configuredBrowserTools.includes(toolName), `Browser MCP tools must include ${toolName}`);
}

const builtBrowserControlContent = await readText(path.join(outputDir, 'browserControlContent.js'));
for (const contractText of ['allTextContents', 'isEnabled', 'textContent', 'returnedCount', 'AGENT_CONTROL_BADGE', 'GET_AGENT_CONTROL_BADGE_STATE']) {
  assert(
    builtBrowserControlContent.includes(contractText),
    `Built browserControlContent should preserve browser-control content contract: ${contractText}`,
  );
}

const browserClientPath = path.join(pluginRoot, 'scripts/browser-client.mjs');
await exists(browserClientPath);
const browserClientModule = await import(`${browserClientPath}?verify=${Date.now()}`);
assert.equal(typeof browserClientModule.setupBrowserRuntime, 'function', 'browser-client must export setupBrowserRuntime');
for (const docName of ['browser-runtime.md', 'browser-playwright.md', 'browser-troubleshooting.md']) {
  const doc = await readText(path.join(pluginRoot, 'docs', docName));
  assert(doc.includes('browser'), `${docName} should describe browser runtime behavior`);
}

console.log('Verified built extension manifest, page assets, dynamic scripts, browser-control contracts, browser-client runtime, and key content-script contracts.');
