import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const cwd = process.cwd();
const targetRoot = path.join(cwd, 'src-tauri', 'target');
const releaseRoot = path.join(cwd, 'artifacts', 'release');
const staleMarkers = [
  '/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/',
  `${path.sep}LexBox${path.sep}src-tauri`,
  '/LexBox/src-tauri',
  '\\LexBox\\src-tauri',
];
const textFileExtensions = new Set(['.d', '.json', '.toml', '.txt', '.log']);
const execFile = promisify(execFileCallback);

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileContainsMarker(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!textFileExtensions.has(extension)) {
    return false;
  }

  const stats = await fs.stat(filePath);
  if (stats.size > 1_000_000) {
    return false;
  }

  const content = await fs.readFile(filePath, 'utf8');
  return staleMarkers.some((marker) => content.includes(marker));
}

async function directoryContainsStaleWorkspaceRefs(rootDir) {
  if (!(await pathExists(rootDir))) {
    return false;
  }

  try {
    await execFile(
      'rg',
      [
        '-l',
        '-m',
        '1',
        '--fixed-strings',
        '-g',
        '*.d',
        '-g',
        '*.json',
        '-g',
        '*.toml',
        '-g',
        '*.txt',
        '-g',
        '*.log',
        staleMarkers[0],
        rootDir,
      ],
      { cwd },
    );
    return true;
  } catch (error) {
    if (error?.code !== 1) {
      console.warn('[tauri-preflight] rg probe failed, falling back to manual scan');
    }
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (await fileContainsMarker(absolute)) {
        return true;
      }
    }
  }

  return false;
}

async function removeIfStale(targetPath, label) {
  if (!(await pathExists(targetPath))) {
    return false;
  }

  const stats = await fs.stat(targetPath);
  if (!stats.isFile()) {
    return false;
  }

  const content = await fs.readFile(targetPath, 'utf8');
  if (!staleMarkers.some((marker) => content.includes(marker))) {
    return false;
  }

  await fs.rm(targetPath, { force: true });
  console.log(`[tauri-preflight] Removed stale ${label}: ${path.relative(cwd, targetPath)}`);
  return true;
}

async function main() {
  let changed = false;

  if (await directoryContainsStaleWorkspaceRefs(targetRoot)) {
    await fs.rm(targetRoot, { recursive: true, force: true });
    console.log('[tauri-preflight] Removed stale src-tauri/target cache after workspace rename');
    changed = true;
  }

  const staleSummaries = [
    ['macOS release summary', path.join(releaseRoot, 'mac-build-summary.json')],
    ['Windows release summary', path.join(releaseRoot, 'windows-build-summary.json')],
  ];

  for (const [label, summaryPath] of staleSummaries) {
    if (await removeIfStale(summaryPath, label)) {
      changed = true;
    }
  }

  if (!changed) {
    console.log('[tauri-preflight] No stale workspace artifacts detected');
  }
}

main().catch((error) => {
  console.error(`[tauri-preflight] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
