import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..', 'src-tauri', 'src');
const storeClosurePattern = /with_store(?:_mut)?\s*\([^|]*\|[^|]+\|\s*\{/g;
const slowOperationPattern = /(\bfs::|std::fs::|\.await\b|reqwest::|Command::new|spawn_blocking|tauri::async_runtime::spawn\s*\(|compute_embedding_with_settings\s*\()/;

function listRustFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listRustFiles(fullPath);
    }
    if (!entry.isFile() || !entry.name.endsWith('.rs')) {
      return [];
    }
    return [fullPath];
  });
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function closureBody(source, start) {
  let cursor = start;
  let depth = 0;
  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, cursor + 1);
      }
    }
  }
  return source.slice(start);
}

const violations = [];

for (const filePath of listRustFiles(srcRoot)) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(storeClosurePattern)) {
    const body = closureBody(source, match.index ?? 0);
    if (!slowOperationPattern.test(body)) continue;
    violations.push({
      filePath: path.relative(path.resolve(__dirname, '..'), filePath),
      line: lineNumber(source, match.index ?? 0),
    });
  }
}

if (violations.length > 0) {
  console.error('Store lock scope check failed. Move slow work outside with_store/with_store_mut closures:');
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.line}`);
  }
  process.exit(1);
}

console.log('Store lock scope check passed.');
