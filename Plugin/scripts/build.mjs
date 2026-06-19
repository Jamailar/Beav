import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(pluginRoot, 'src');
const outputDir = path.join(pluginRoot, 'dist', 'extension');

const scriptEntries = [
  'background.js',
  'browserControlContent.js',
  'captureRuntime.js',
  'pageObserver.js',
  'pageRouteBridge.js',
  'popup.js',
  'settings.js',
  'sidepanel.js',
  'xhsBridge.js',
];

const copiedFiles = [
  'manifest.json',
  'popup.css',
  'popup.html',
  'settings.css',
  'settings.html',
  'sidepanel.css',
  'sidepanel.html',
];

const copiedDirs = [
  'assets',
  'icons',
  'images',
  'vendor',
];

async function copySourceFile(relativePath) {
  await cp(path.join(sourceDir, relativePath), path.join(outputDir, relativePath));
}

async function copySourceDir(relativePath) {
  await cp(path.join(sourceDir, relativePath), path.join(outputDir, relativePath), {
    recursive: true,
  });
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const file of copiedFiles) {
  await copySourceFile(file);
}

for (const dir of copiedDirs) {
  await copySourceDir(dir);
}

await Promise.all(scriptEntries.map((entry) => build({
  entryPoints: [path.join(sourceDir, entry)],
  outfile: path.join(outputDir, entry),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
})));

const outputFiles = await readdir(outputDir);
console.log(`Built RedBox Capture extension into ${path.relative(pluginRoot, outputDir)}`);
console.log(`Output entries: ${outputFiles.sort().join(', ')}`);
