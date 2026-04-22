const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'electron', 'prompts', 'library');
const destDir = path.join(rootDir, 'dist-electron', 'library');

if (!fs.existsSync(srcDir)) {
  console.warn(`[sync-prompt-library] Source directory not found: ${srcDir}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(destDir), { recursive: true });
fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });

console.log(`[sync-prompt-library] Copied prompts from ${srcDir} to ${destDir}`);
