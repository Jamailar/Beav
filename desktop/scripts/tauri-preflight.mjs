import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBrand } from './sync-brand.mjs';

const cwd = process.cwd();
const defaultTargetRoot = path.join(cwd, 'src-tauri', 'target');
const targetRoot = path.resolve(cwd, process.env.CARGO_TARGET_DIR || defaultTargetRoot);
const cargoManifestPath = path.join(cwd, 'src-tauri', 'Cargo.toml');
const workspaceProbePath = path.join(targetRoot, '.redbox-preflight-workspace');
const incrementalRoot = path.join(targetRoot, 'debug', 'incremental');
const releaseRoot = path.join(cwd, 'artifacts', 'release');
const incrementalCachesPerFamily = Number(process.env.REDBOX_TAURI_INCREMENTAL_CACHE_RETENTION || 1);
const shouldPruneIncrementalCache = process.env.REDBOX_SKIP_TAURI_INCREMENTAL_PRUNE !== '1';
const shouldStopCargoCheck = process.env.REDBOX_SKIP_TAURI_CARGO_CHECK_STOP !== '1' && targetRoot === defaultTargetRoot;
const staleMarkers = [
  '/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/',
  `${path.sep}LexBox${path.sep}src-tauri`,
  '/LexBox/src-tauri',
  '\\LexBox\\src-tauri',
];
const textFileExtensions = new Set(['.d', '.json', '.toml', '.txt', '.log']);
const execFileRaw = promisify(execFileCallback);
const execFile = (file, args = [], options = {}) => execFileRaw(file, args, { windowsHide: true, ...options });

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 120));
    } catch {
      return true;
    }
  }
  return false;
}

async function stopConflictingCargoChecks() {
  if (!shouldStopCargoCheck) {
    return false;
  }

  let stdout = '';
  try {
    ({ stdout } = await execFile('ps', ['-axo', 'pid=,command=']));
  } catch {
    return false;
  }

  const conflictingChecks = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((entry) => {
      if (!entry || !Number.isFinite(entry.pid) || entry.pid === process.pid) {
        return false;
      }
      return (
        entry.command.includes('cargo check')
        && entry.command.includes('--message-format=json')
        && entry.command.includes(`--manifest-path ${cargoManifestPath}`)
      );
    });

  for (const entry of conflictingChecks) {
    console.log(`[tauri-preflight] Stopping background cargo check ${entry.pid}`);
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      continue;
    }

    if (!(await waitForProcessExit(entry.pid))) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // noop
      }
    }
  }

  return conflictingChecks.length > 0;
}

async function fileContainsMarker(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!textFileExtensions.has(extension)) {
    return false;
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.size > 1_000_000) {
      return false;
    }

    const content = await fs.readFile(filePath, 'utf8');
    return staleMarkers.some((marker) => content.includes(marker));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
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
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

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

async function targetNeedsStaleWorkspaceProbe() {
  if (!(await pathExists(targetRoot))) {
    return false;
  }

  try {
    const previousCwd = (await fs.readFile(workspaceProbePath, 'utf8')).trim();
    return previousCwd !== cwd;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function markStaleWorkspaceProbeComplete() {
  if (!(await pathExists(targetRoot))) {
    return;
  }

  await fs.writeFile(workspaceProbePath, `${cwd}\n`, 'utf8');
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

function getIncrementalCacheFamily(name) {
  const separatorIndex = name.lastIndexOf('-');
  if (separatorIndex <= 0) {
    return null;
  }
  return name.slice(0, separatorIndex);
}

async function pruneRustIncrementalCache() {
  if (!shouldPruneIncrementalCache) {
    console.log('[tauri-preflight] Skipped Rust incremental cache pruning');
    return false;
  }

  if (!Number.isInteger(incrementalCachesPerFamily) || incrementalCachesPerFamily < 1) {
    console.warn('[tauri-preflight] Ignored invalid REDBOX_TAURI_INCREMENTAL_CACHE_RETENTION value');
    return false;
  }

  if (!(await pathExists(incrementalRoot))) {
    return false;
  }

  let entries;
  try {
    entries = await fs.readdir(incrementalRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  const cacheFamilies = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const family = getIncrementalCacheFamily(entry.name);
    if (!family) {
      continue;
    }

    const absolute = path.join(incrementalRoot, entry.name);
    let stats;
    try {
      stats = await fs.stat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    const cacheEntry = {
      name: entry.name,
      absolute,
      modifiedAt: stats.mtimeMs,
    };

    const familyEntries = cacheFamilies.get(family);
    if (familyEntries) {
      familyEntries.push(cacheEntry);
    } else {
      cacheFamilies.set(family, [cacheEntry]);
    }
  }

  let removedCount = 0;
  for (const familyEntries of cacheFamilies.values()) {
    familyEntries.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const staleEntries = familyEntries.slice(incrementalCachesPerFamily);

    for (const entry of staleEntries) {
      await fs.rm(entry.absolute, { recursive: true, force: true });
      removedCount += 1;
    }
  }

  if (removedCount > 0) {
    console.log(`[tauri-preflight] Removed ${removedCount} stale Rust incremental cache directories`);
    return true;
  }

  console.log('[tauri-preflight] Rust incremental cache is already compact');
  return false;
}

async function main() {
  await syncBrand({ cwd });

  let changed = false;

  if (await stopConflictingCargoChecks()) {
    changed = true;
  }

  if (await targetNeedsStaleWorkspaceProbe()) {
    if (await directoryContainsStaleWorkspaceRefs(targetRoot)) {
      await fs.rm(targetRoot, { recursive: true, force: true });
      console.log('[tauri-preflight] Removed stale src-tauri/target cache after workspace rename');
      changed = true;
    } else {
      await markStaleWorkspaceProbeComplete();
    }
  }

  if (await pruneRustIncrementalCache()) {
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
