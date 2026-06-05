import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..', 'src');
const rawIpcPattern = /window\s*\.\s*ipcRenderer\s*\.\s*(on|off|send|invoke|invokeGuarded|command|commandGuarded)\s*\(/g;
const scannedExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);

function listSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath);
    }
    if (!entry.isFile() || !scannedExtensions.has(path.extname(entry.name))) {
      return [];
    }
    return [fullPath];
  });
}

function getLineAndColumn(source, offset) {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

const violations = [];

for (const filePath of listSourceFiles(srcRoot)) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(rawIpcPattern)) {
    const { line, column } = getLineAndColumn(source, match.index ?? 0);
    violations.push({
      filePath: path.relative(path.resolve(__dirname, '..'), filePath),
      line,
      column,
      method: match[1],
    });
  }
}

if (violations.length > 0) {
  console.error('Renderer IPC boundary check failed. Use bridge domain facade methods instead of raw channel calls:');
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.line}:${violation.column} raw window.ipcRenderer.${violation.method}(...)`);
  }
  process.exit(1);
}

console.log('Renderer IPC boundary check passed.');
