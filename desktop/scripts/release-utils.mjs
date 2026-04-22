import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..');
export const artifactsRoot = path.join(repoRoot, 'artifacts');
export const requiredBundledGuideResources = [
  'resources/knowledge-api-guide.html',
  'resources/richpost-theme-guide.html',
];

export function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    if (!trimmed) {
      continue;
    }

    const [rawKey, inlineValue] = trimmed.split('=', 2);
    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
      continue;
    }

    args[key] = true;
  }

  return args;
}

export function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export async function readPackageJson(cwd = repoRoot) {
  const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

export async function readTauriConfig(cwd = repoRoot) {
  const raw = await fs.readFile(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8');
  return JSON.parse(raw);
}

export function assertBundledGuideResources(tauriConfig) {
  const resources = tauriConfig?.bundle?.resources;
  if (!Array.isArray(resources)) {
    throw new Error('src-tauri/tauri.conf.json is missing bundle.resources.');
  }

  const missing = requiredBundledGuideResources.filter((resource) => !resources.includes(resource));
  if (missing.length > 0) {
    throw new Error(
      `src-tauri/tauri.conf.json is missing required bundled guide resources: ${missing.join(', ')}`,
    );
  }
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function listFilesRecursive(rootDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  if (await pathExists(rootDir)) {
    await walk(rootDir);
  }

  return files;
}

export async function findNewestFile(rootDir, matcher) {
  const files = await listFilesRecursive(rootDir);
  const matches = [];

  for (const filePath of files) {
    if (!matcher(filePath)) {
      continue;
    }
    const stats = await fs.stat(filePath);
    matches.push({ filePath, mtimeMs: stats.mtimeMs });
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.filePath ?? null;
}

export function bundleRootForTarget(target) {
  if (!target) {
    return path.join(repoRoot, 'src-tauri', 'target', 'release', 'bundle');
  }

  return path.join(repoRoot, 'src-tauri', 'target', target, 'release', 'bundle');
}

export function installerArtifactsDir(platform) {
  return path.join(artifactsRoot, 'installers', platform);
}

export async function copyArtifactToDir(sourcePath, targetDir) {
  await ensureDir(targetDir);
  const destinationPath = path.join(targetDir, path.basename(sourcePath));
  await fs.copyFile(sourcePath, destinationPath);
  return destinationPath;
}

export async function writeTempJsonConfig(prefix, value) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const configPath = path.join(tempDir, 'tauri.override.json');
  await fs.writeFile(configPath, JSON.stringify(value, null, 2), 'utf8');
  return {
    configPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function runCommand(command, args = [], options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    stdio = 'inherit',
    allowFailure = false,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    if (stdio === 'pipe') {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code: code ?? 0, stdout, stderr });
        return;
      }

      const suffix = stderr.trim() || stdout.trim();
      const details = suffix ? `\n${suffix}` : '';
      reject(new Error(`Command failed: ${command} ${args.join(' ')}${details}`));
    });
  });
}

export async function captureCommand(command, args = [], options = {}) {
  return runCommand(command, args, { ...options, stdio: 'pipe' });
}

export async function ensureCommandExists(command, hint) {
  const result = await captureCommand('bash', ['-lc', `command -v ${command}`], { allowFailure: true });
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const message = hint
    ? `${command} is required. ${hint}`
    : `${command} is required but was not found in PATH.`;
  throw new Error(message);
}

export function logStep(message) {
  console.log(`[release] ${message}`);
}

export function makeBuildEnv(overrides = {}) {
  return {
    ...process.env,
    ...overrides,
  };
}
