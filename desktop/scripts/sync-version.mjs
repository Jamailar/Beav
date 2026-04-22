import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function replaceCargoPackageVersion(contents, version) {
  const pattern = /(\[package\][\s\S]*?\nversion = )"[^"]+"/;
  if (!pattern.test(contents)) {
    throw new Error('Failed to locate src-tauri/Cargo.toml package.version');
  }

  return contents.replace(
    pattern,
    `$1"${version}"`,
  );
}

function replaceCargoLockRootVersion(contents, version) {
  const pattern = /(\[\[package\]\]\nname = "redbox"\nversion = )"[^"]+"/;
  if (!pattern.test(contents)) {
    throw new Error('Failed to locate src-tauri/Cargo.lock root package version');
  }

  return contents.replace(
    pattern,
    `$1"${version}"`,
  );
}

async function writeIfChanged(filePath, nextContents) {
  const previous = await fs.readFile(filePath, 'utf8');
  if (previous === nextContents) {
    return false;
  }
  await fs.writeFile(filePath, nextContents, 'utf8');
  return true;
}

export async function syncVersion({ cwd = process.cwd() } = {}) {
  const packageJsonPath = path.join(cwd, 'package.json');
  const cargoTomlPath = path.join(cwd, 'src-tauri', 'Cargo.toml');
  const cargoLockPath = path.join(cwd, 'src-tauri', 'Cargo.lock');

  const packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageJsonRaw);
  const version = String(packageJson.version ?? '').trim();

  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid package.json version: ${version || '<empty>'}`);
  }

  const cargoTomlRaw = await fs.readFile(cargoTomlPath, 'utf8');
  const cargoLockRaw = await fs.readFile(cargoLockPath, 'utf8');

  const nextCargoToml = replaceCargoPackageVersion(cargoTomlRaw, version);
  const nextCargoLock = replaceCargoLockRootVersion(cargoLockRaw, version);

  const [cargoTomlChanged, cargoLockChanged] = await Promise.all([
    writeIfChanged(cargoTomlPath, nextCargoToml),
    writeIfChanged(cargoLockPath, nextCargoLock),
  ]);

  if (cargoTomlChanged || cargoLockChanged) {
    console.log(`[sync-version] Synced app version ${version}`);
  }

  return { version, cargoTomlChanged, cargoLockChanged };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  syncVersion().catch((error) => {
    console.error(`[sync-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
