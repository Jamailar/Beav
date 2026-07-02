import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archiveRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(archiveRoot, '..', '..');

const SOURCE_ROOTS = [
  'components',
  'config',
  'features',
  'hooks',
  'notifications',
  'pages',
  'runtime',
  'utils',
  'App.tsx',
  'i18n.tsx',
  'index.css',
  'main.tsx',
  'types.d.ts',
  'vite-env.d.ts',
];

const PUBLIC_ASSET_ROOTS = [
  'branding',
  'channel-logos',
  'ecommerce-platform-icons',
  'onboarding',
  'provider-logos',
  'Box.png',
];

const IGNORED_NAMES = new Set(['.DS_Store']);

function walkFiles(rootPath, relativeBase = rootPath, files = []) {
  if (!existsSync(rootPath)) {
    return files;
  }

  const stats = statSync(rootPath);
  if (stats.isFile()) {
    files.push(path.relative(relativeBase, rootPath));
    return files;
  }

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, relativeBase, files);
    } else if (entry.isFile()) {
      files.push(path.relative(relativeBase, entryPath));
    }
  }

  return files;
}

function collectRootFiles(basePath, roots) {
  const files = [];
  for (const root of roots) {
    const absoluteRoot = path.join(basePath, root);
    for (const relativeFile of walkFiles(absoluteRoot, absoluteRoot)) {
      files.push(path.join(root, relativeFile));
    }
  }
  return files.sort();
}

function assertSourceCoverage() {
  const formalSrc = path.join(repoRoot, 'desktop', 'src');
  const archiveSrc = path.join(archiveRoot, 'src');
  const formalFiles = collectRootFiles(formalSrc, SOURCE_ROOTS);
  const missing = formalFiles.filter((relativeFile) => !existsSync(path.join(archiveSrc, relativeFile)));

  if (missing.length > 0) {
    console.error('Missing Electron UI source parity files:');
    for (const relativeFile of missing) {
      console.error(`- src/${relativeFile}`);
    }
    return false;
  }

  return true;
}

function assertPublicAssetParity() {
  const formalPublic = path.join(repoRoot, 'desktop', 'public');
  const archivePublic = path.join(archiveRoot, 'public');
  const formalAssets = collectRootFiles(formalPublic, PUBLIC_ASSET_ROOTS);
  const missing = [];
  const changed = [];

  for (const relativeFile of formalAssets) {
    const formalPath = path.join(formalPublic, relativeFile);
    const archivePath = path.join(archivePublic, relativeFile);
    if (!existsSync(archivePath)) {
      missing.push(relativeFile);
      continue;
    }
    if (!readFileSync(formalPath).equals(readFileSync(archivePath))) {
      changed.push(relativeFile);
    }
  }

  if (missing.length > 0) {
    console.error('Missing Electron public asset parity files:');
    for (const relativeFile of missing) {
      console.error(`- public/${relativeFile}`);
    }
  }

  if (changed.length > 0) {
    console.error('Diverged Electron public asset parity files:');
    for (const relativeFile of changed) {
      console.error(`- public/${relativeFile}`);
    }
  }

  return missing.length === 0 && changed.length === 0;
}

const sourceOk = assertSourceCoverage();
const assetsOk = assertPublicAssetParity();

if (!sourceOk || !assetsOk) {
  process.exit(1);
}

console.log('UI source parity check passed: formal UI source files are covered and public visual assets match.');
