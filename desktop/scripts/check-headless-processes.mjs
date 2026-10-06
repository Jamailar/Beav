import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const tauriSrc = path.join(desktopRoot, 'src-tauri', 'src');
const scriptsDir = path.join(desktopRoot, 'scripts');

const rustCommandPattern = /\b(?:std::process::)?Command::new\s*\(/;
const childProcessImportPattern = /node:child_process/;
const windowsHidePattern = /\bwindowsHide\s*:/;

function listFiles(root, extensions, files = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'dist' || entry.name === 'node_modules') {
      continue;
    }
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listFiles(absolute, extensions, files);
      continue;
    }
    if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
  return files;
}

function relative(filePath) {
  return path.relative(desktopRoot, filePath).split(path.sep).join('/');
}

const failures = [];

for (const filePath of listFiles(tauriSrc, ['.rs'])) {
  const rel = relative(filePath);
  if (
    rel === 'src-tauri/src/process_utils.rs' ||
    rel === 'src-tauri/src/bin/image_api_probe.rs' ||
    rel === 'src-tauri/src/bin/redbox_runtime_probe.rs'
  ) {
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (rustCommandPattern.test(content)) {
    failures.push(`${rel}: use background_command(...) instead of Command::new(...)`);
  }
}

for (const filePath of listFiles(scriptsDir, ['.mjs', '.js'])) {
  const rel = relative(filePath);
  if (rel === 'scripts/check-headless-processes.mjs') {
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (childProcessImportPattern.test(content) && !windowsHidePattern.test(content)) {
    failures.push(`${rel}: child_process calls must set windowsHide: true`);
  }
}

if (failures.length > 0) {
  console.error('[check-headless-processes] found child process launch paths without headless Windows handling:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[check-headless-processes] ok');
