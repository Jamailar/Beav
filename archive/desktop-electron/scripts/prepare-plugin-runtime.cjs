const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const sourceDir = path.join(repoRoot, 'Plugin');
const runtimeRoot = path.join(desktopDir, '.plugin-runtime');
const targetDir = path.join(runtimeRoot, 'browser-extension');

function copyDirectory(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

if (!fs.existsSync(sourceDir)) {
  console.warn(`[prepare-plugin-runtime] Plugin source not found, skip: ${sourceDir}`);
  process.exit(0);
}

copyDirectory(sourceDir, targetDir);
console.log(`[prepare-plugin-runtime] synced browser extension -> ${targetDir}`);
