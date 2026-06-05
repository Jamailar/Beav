import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(desktopRoot, 'src-tauri', 'src');

const restrictedPatterns = [
  {
    domain: 'redclaw',
    pattern: /store\s*\.\s*redclaw_state\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'redclaw.rs'),
      path.join(srcRoot, 'persistence', 'mod.rs'),
    ]),
  },
  {
    domain: 'redclaw jobs',
    pattern: /store\s*\.\s*redclaw_job_(definitions|executions)\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'redclaw.rs'),
      path.join(srcRoot, 'persistence', 'mod.rs'),
    ]),
  },
  {
    domain: 'settings',
    pattern: /store\s*\.\s*settings\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'settings.rs'),
      path.join(srcRoot, 'memory', 'mod.rs'),
      path.join(srcRoot, 'runtime', 'session_runtime.rs'),
    ]),
  },
  {
    domain: 'spaces',
    pattern: /store\s*\.\s*(spaces|active_space_id)\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'spaces.rs'),
      path.join(srcRoot, 'legacy_import.rs'),
      path.join(srcRoot, 'memory', 'mod.rs'),
    ]),
  },
  {
    domain: 'media assets',
    pattern: /store\s*\.\s*media_assets\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'media.rs'),
    ]),
  },
  {
    domain: 'work items',
    pattern: /store\s*\.\s*work_items\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'work_items.rs'),
      path.join(srcRoot, 'store', 'redclaw.rs'),
      path.join(srcRoot, 'commands', 'runtime_task_resume.rs'),
    ]),
  },
  {
    domain: 'runtime tasks',
    pattern: /store\s*\.\s*runtime_tasks\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'runtime_tasks.rs'),
      path.join(srcRoot, 'runtime', 'task_runtime.rs'),
      path.join(srcRoot, 'subagents', 'aggregation.rs'),
      path.join(srcRoot, 'subagents', 'spawner.rs'),
      path.join(srcRoot, 'commands', 'runtime_task_resume.rs'),
    ]),
  },
  {
    domain: 'assistant daemon',
    pattern: /store\s*\.\s*assistant_state\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'assistant.rs'),
    ]),
  },
  {
    domain: 'mcp tools',
    pattern: /store\s*\.\s*(mcp_servers|runtime_hooks)\b/g,
    allowedFiles: new Set([
      path.join(srcRoot, 'store', 'mcp_tools.rs'),
    ]),
  },
];

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

const violations = [];

for (const filePath of listRustFiles(srcRoot)) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const rule of restrictedPatterns) {
    if (rule.allowedFiles.has(filePath)) {
      continue;
    }
    for (const match of source.matchAll(rule.pattern)) {
      violations.push({
        domain: rule.domain,
        filePath: path.relative(desktopRoot, filePath),
        line: lineNumber(source, match.index ?? 0),
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Domain store boundary check failed. Use domain store helpers instead of direct AppStore internals:');
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.line} direct ${violation.domain} store access`);
  }
  process.exit(1);
}

console.log('Domain store boundary check passed.');
