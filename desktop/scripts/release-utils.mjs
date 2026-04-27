import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..');
export const workspaceRoot = path.resolve(repoRoot, '..');
export const artifactsRoot = path.join(repoRoot, 'artifacts');
export const browserPluginSourceDir = path.join(workspaceRoot, 'Plugin');
export const bundledBrowserPluginResource = '../../Plugin';
export const browserPluginSummaryPath = path.join(artifactsRoot, 'release', 'browser-plugin-summary.json');
export const requiredBundledReleaseResources = [
  'resources/knowledge-api-guide.html',
  'resources/richpost-theme-guide.html',
  bundledBrowserPluginResource,
];
export const requiredBrowserPluginFiles = [
  'manifest.json',
  'background.js',
  'pageObserver.js',
  'sidepanel.html',
  'sidepanel.js',
  'sidepanel.css',
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

export function dedupeList(values) {
  return [...new Set(values.filter(Boolean))];
}

export function parseTargetList(value, fallback = []) {
  if (Array.isArray(value)) {
    return dedupeList(value.map((item) => String(item || '').trim()).filter(Boolean));
  }

  const raw = String(value || '').trim();
  if (!raw) {
    return dedupeList(fallback.map((item) => String(item || '').trim()).filter(Boolean));
  }

  return dedupeList(
    raw
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
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

export function assertBundledReleaseResources(tauriConfig) {
  const resources = tauriConfig?.bundle?.resources;
  if (!Array.isArray(resources)) {
    throw new Error('src-tauri/tauri.conf.json is missing bundle.resources.');
  }

  const missing = requiredBundledReleaseResources.filter((resource) => !resources.includes(resource));
  if (missing.length > 0) {
    throw new Error(
      `src-tauri/tauri.conf.json is missing required bundled release resources: ${missing.join(', ')}`,
    );
  }
}

export function assertBundledGuideResources(tauriConfig) {
  assertBundledReleaseResources(tauriConfig);
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

async function hashDirectory(rootDir) {
  const files = (await listFilesRecursive(rootDir))
    .filter((filePath) => path.basename(filePath) !== '.DS_Store')
    .sort((left, right) => left.localeCompare(right));
  const hash = crypto.createHash('sha256');

  for (const filePath of files) {
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join('/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await fs.readFile(filePath));
    hash.update('\0');
  }

  return {
    digest: hash.digest('hex'),
    fileCount: files.length,
  };
}

export async function readBrowserPluginManifest(sourceDir = browserPluginSourceDir) {
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(raw);
}

export async function getBrowserPluginInfo(sourceDir = browserPluginSourceDir) {
  if (!(await pathExists(sourceDir))) {
    throw new Error(`Browser plugin source directory is missing: ${sourceDir}`);
  }

  const missing = [];
  for (const relativePath of requiredBrowserPluginFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    if (!(await pathExists(absolutePath))) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Browser plugin source is missing required files: ${missing.join(', ')}`);
  }

  const manifest = await readBrowserPluginManifest(sourceDir);
  const { digest, fileCount } = await hashDirectory(sourceDir);

  return {
    sourceDir,
    manifestName: String(manifest.name || ''),
    version: String(manifest.version || ''),
    digest,
    fileCount,
  };
}

export async function findBundledBrowserPluginDir(appPath) {
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const candidates = [
    path.join(resourcesDir, '_up_', '_up_', 'Plugin'),
    path.join(resourcesDir, '_up_', 'Plugin'),
    path.join(resourcesDir, 'Plugin'),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }

  const files = await listFilesRecursive(resourcesDir);
  const manifestPath = files.find((filePath) => {
    const normalized = filePath.split(path.sep).join('/');
    return normalized.endsWith('/Plugin/manifest.json');
  });

  return manifestPath ? path.dirname(manifestPath) : null;
}

export async function findBrowserPluginDirUnder(rootDir) {
  const candidates = [
    path.join(rootDir, '_up_', '_up_', 'Plugin'),
    path.join(rootDir, '_up_', 'Plugin'),
    path.join(rootDir, 'Plugin'),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }

  const files = await listFilesRecursive(rootDir);
  const manifestPath = files.find((filePath) => {
    const normalized = filePath.split(path.sep).join('/');
    return normalized.endsWith('/Plugin/manifest.json');
  });

  return manifestPath ? path.dirname(manifestPath) : null;
}

export async function assertDirectoryIncludesBrowserPlugin(rootDir, expectedInfo, label = 'bundle output') {
  const pluginDir = await findBrowserPluginDirUnder(rootDir);
  if (!pluginDir) {
    throw new Error(`${label} is missing bundled browser plugin: ${rootDir}`);
  }

  const actualInfo = await getBrowserPluginInfo(pluginDir);
  if (expectedInfo?.version && actualInfo.version !== expectedInfo.version) {
    throw new Error(`${label} contains browser plugin ${actualInfo.version}, expected ${expectedInfo.version}`);
  }
  if (expectedInfo?.digest && actualInfo.digest !== expectedInfo.digest) {
    throw new Error(`${label} browser plugin does not match the current Plugin directory.`);
  }

  return {
    ...actualInfo,
    bundleDir: pluginDir,
  };
}

export async function assertMacAppIncludesBrowserPlugin(appPath, expectedInfo) {
  const pluginDir = await findBundledBrowserPluginDir(appPath);
  if (!pluginDir) {
    throw new Error(`macOS app bundle is missing bundled browser plugin: ${appPath}`);
  }

  const actualInfo = await getBrowserPluginInfo(pluginDir);
  if (expectedInfo?.version && actualInfo.version !== expectedInfo.version) {
    throw new Error(
      `macOS app bundle contains browser plugin ${actualInfo.version}, expected ${expectedInfo.version}`,
    );
  }
  if (expectedInfo?.digest && actualInfo.digest !== expectedInfo.digest) {
    throw new Error('macOS app bundle browser plugin does not match the current Plugin directory.');
  }

  return {
    ...actualInfo,
    bundleDir: pluginDir,
  };
}

export async function packageBrowserPluginArchive() {
  await ensureCommandExists('zip', 'zip is required to package the browser extension release asset.');

  const pluginInfo = await getBrowserPluginInfo();
  const pluginArtifactsDir = path.join(artifactsRoot, 'installers', 'browser-plugin');
  const archivePath = path.join(pluginArtifactsDir, `RedBox_Browser_Extension_${pluginInfo.version}.zip`);
  const files = (await listFilesRecursive(browserPluginSourceDir))
    .filter((filePath) => path.basename(filePath) !== '.DS_Store')
    .map((filePath) => path.relative(browserPluginSourceDir, filePath).split(path.sep).join('/'))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error(`Browser plugin source directory has no files: ${browserPluginSourceDir}`);
  }

  await fs.rm(pluginArtifactsDir, { recursive: true, force: true });
  await ensureDir(pluginArtifactsDir);
  await runCommand('zip', ['-qr', '-X', archivePath, ...files], { cwd: browserPluginSourceDir });

  const summary = {
    type: 'browser-plugin',
    sourceDir: pluginInfo.sourceDir,
    manifestName: pluginInfo.manifestName,
    version: pluginInfo.version,
    digest: pluginInfo.digest,
    fileCount: pluginInfo.fileCount,
    zipPath: archivePath,
    installerPath: archivePath,
    artifacts: [
      {
        type: 'browser-plugin',
        version: pluginInfo.version,
        digest: pluginInfo.digest,
        fileCount: pluginInfo.fileCount,
        zipPath: archivePath,
        installerPath: archivePath,
      },
    ],
  };

  await ensureDir(path.dirname(browserPluginSummaryPath));
  await fs.writeFile(browserPluginSummaryPath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
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

export async function ensureRustTargets(targets, options = {}) {
  const { cwd = repoRoot } = options;
  const requestedTargets = dedupeList(
    targets
      .map((target) => String(target || '').trim())
      .filter(Boolean),
  );

  if (requestedTargets.length === 0) {
    return;
  }

  const installedResult = await captureCommand('rustup', ['target', 'list', '--installed'], { cwd });
  const installedTargets = new Set(
    installedResult.stdout
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
  );

  const missingTargets = requestedTargets.filter((target) => !installedTargets.has(target));
  if (missingTargets.length === 0) {
    return;
  }

  logStep(`Installing missing Rust targets: ${missingTargets.join(', ')}`);
  await runCommand('rustup', ['target', 'add', ...missingTargets], { cwd });
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
