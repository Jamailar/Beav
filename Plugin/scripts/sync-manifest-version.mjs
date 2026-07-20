import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const CHROME_VERSION_PATTERN = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,3}$/;
const MAX_CHROME_VERSION_PART = 65535;
const MAX_PRERELEASE_BUILD = MAX_CHROME_VERSION_PART - 1;

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function assertChromeManifestVersion(version) {
  const value = String(version || '').trim();
  if (!CHROME_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid Chrome manifest version: ${value || '<empty>'}`);
  }

  const parts = value.split('.').map(Number);
  if (parts.some((part) => part > MAX_CHROME_VERSION_PART)) {
    throw new Error(`Chrome manifest version parts must be between 0 and ${MAX_CHROME_VERSION_PART}: ${value}`);
  }

  return value;
}

export function toChromeManifestVersion(packageVersion) {
  const version = String(packageVersion || '').trim();
  const match = version.match(SEMVER_PATTERN);
  if (!match) {
    throw new Error(`Invalid package version: ${version || '<empty>'}`);
  }

  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => part > MAX_CHROME_VERSION_PART)) {
    throw new Error(`Package version parts must be between 0 and ${MAX_CHROME_VERSION_PART}: ${version}`);
  }

  const prerelease = match[4];
  let build = MAX_CHROME_VERSION_PART;
  if (prerelease) {
    const counter = prerelease
      .split('.')
      .reverse()
      .find((part) => /^\d+$/.test(part));
    if (counter === undefined) {
      throw new Error(`Prerelease package version must end with a numeric counter: ${version}`);
    }

    build = Number(counter);
    if (build < 1 || build > MAX_PRERELEASE_BUILD) {
      throw new Error(`Prerelease counter must be between 1 and ${MAX_PRERELEASE_BUILD}: ${version}`);
    }
  }

  return assertChromeManifestVersion(`${core.join('.')}.${build}`);
}

export async function syncManifestVersion({ cwd = pluginRoot } = {}) {
  const packageJsonPath = path.join(cwd, 'package.json');
  const manifestPath = path.join(cwd, 'src', 'manifest.json');
  const identityPath = path.join(cwd, 'browser-control.identity.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const packageVersion = String(packageJson.version || '').trim();
  const manifestVersion = toChromeManifestVersion(packageVersion);

  if (!Object.hasOwn(manifest, 'version')) {
    throw new Error('manifest.json is missing version');
  }

  let nextManifestRaw = manifestRaw.replace(
    /("version"\s*:\s*)"[^"]*"/,
    `$1"${manifestVersion}"`,
  );
  if (Object.hasOwn(manifest, 'version_name')) {
    nextManifestRaw = nextManifestRaw.replace(
      /("version_name"\s*:\s*)"[^"]*"/,
      `$1"${packageVersion}"`,
    );
  } else {
    nextManifestRaw = nextManifestRaw.replace(
      /("version"\s*:\s*"[^"]*",\r?\n)/,
      `$1  "version_name": "${packageVersion}",\n`,
    );
  }
  if (!String(identity.manifestPublicKey || '').trim()) {
    throw new Error('browser-control.identity.json is missing manifestPublicKey');
  }
  if (Object.hasOwn(manifest, 'key')) {
    nextManifestRaw = nextManifestRaw.replace(
      /("key"\s*:\s*)"[^"]*"/,
      `$1"${identity.manifestPublicKey}"`,
    );
  } else {
    nextManifestRaw = nextManifestRaw.replace(
      /("version_name"\s*:\s*"[^"]*",\r?\n)/,
      `$1  "key": "${identity.manifestPublicKey}",\n`,
    );
  }
  const changed = nextManifestRaw !== manifestRaw;
  if (changed) {
    await writeFile(manifestPath, nextManifestRaw, 'utf8');
    console.log(`[sync-manifest-version] Synced ${packageVersion} as Chrome version ${manifestVersion}`);
  }

  return { packageVersion, manifestVersion, changed };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  syncManifestVersion().catch((error) => {
    console.error(`[sync-manifest-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
