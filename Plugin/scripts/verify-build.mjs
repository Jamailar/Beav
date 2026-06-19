import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

async function assertOutputFile(relativePath) {
  assert(!relativePath.includes('..'), `Invalid output reference: ${relativePath}`);
  await exists(path.join(outputDir, relativePath));
}

const sourceManifest = await readJson(path.join(sourceDir, 'manifest.json'));
const outputManifest = await readJson(path.join(outputDir, 'manifest.json'));
assert.deepEqual(outputManifest, sourceManifest, 'Built manifest must match source manifest exactly');

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

const builtObserver = await readText(path.join(outputDir, 'pageObserver.js'));
assert(builtObserver.includes('page-state:get'), 'Built pageObserver should retain page-state message handling');
assert(builtObserver.includes('pageRouteBridge.js'), 'Built pageObserver should retain page route bridge injection');

console.log('Verified built extension manifest, page assets, dynamic scripts, and key content-script contracts.');
