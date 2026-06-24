import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  artifactsRoot,
  assertBundledGuideResources,
  assertDirectoryIncludesBrowserPlugin,
  browserPluginSourceDir,
  bundleRootForTarget,
  copyArtifactToDir,
  copyArtifactToDirAs,
  ensureCommandExists,
  ensureRustTargets,
  findNewestFile,
  getBrowserPluginInfo,
  installerArtifactsDir,
  logStep,
  parseArgs,
  parseTargetList,
  pathExists,
  readPackageJson,
  readTauriConfig,
  repoRoot,
  runCommand,
  writeTempJsonConfig,
} from './release-utils.mjs';

const DEFAULT_LINUX_TARGETS = ['x86_64-unknown-linux-gnu'];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function remoteCommand(parts) {
  return parts.filter(Boolean).join(' ');
}

function remoteSiblingDir(remoteWorkdir, dirname) {
  return path.posix.join(path.posix.dirname(remoteWorkdir.replace(/\/+$/, '')), dirname);
}

async function writeSummary(summary) {
  const summaryPath = path.join(artifactsRoot, 'release', 'linux-build-summary.json');
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function removeLegacyAppImages(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && (
        entry.name.endsWith('.AppImage')
        || entry.name.endsWith('.AppImage.tar.gz')
        || entry.name.endsWith('.AppImage.tar.gz.sig')
      ))
      .map((entry) => fs.rm(path.join(dirPath, entry.name), { force: true })),
  );
}

async function resolveLinuxArtifacts(bundleRoot) {
  const debDir = path.join(bundleRoot, 'deb');
  const appImageDir = path.join(bundleRoot, 'appimage');
  const debPath = await findNewestFile(debDir, (filePath) => filePath.endsWith('.deb'));
  const updaterArchivePath = await findNewestFile(
    appImageDir,
    (filePath) => filePath.toLowerCase().endsWith('.appimage.tar.gz'),
  );
  const updaterSignaturePath = updaterArchivePath && (await pathExists(`${updaterArchivePath}.sig`))
    ? `${updaterArchivePath}.sig`
    : null;
  return { debPath, updaterArchivePath, updaterSignaturePath };
}

function linuxUpdaterArchLabel(target) {
  if (target.startsWith('aarch64-')) return 'aarch64';
  if (target.startsWith('armv7-')) return 'armv7';
  if (target.startsWith('i686-')) return 'i686';
  return 'x86_64';
}

function linuxUpdaterArtifactFilename(productName, version, target, suffix) {
  return `${productName}_${version}_${linuxUpdaterArchLabel(target)}.AppImage.tar.gz${suffix}`;
}

function linuxUpdaterFilenameMatchesTarget(filePath, target) {
  const filename = path.basename(filePath).toLowerCase();
  const arch = linuxUpdaterArchLabel(target);
  if (arch === 'x86_64') {
    return filename.includes('x86_64') || filename.includes('amd64') || filename.includes('x64');
  }
  return filename.includes(arch);
}

function withDefaultTauriSigningEnv(env) {
  const nextEnv = { ...env };
  if (!nextEnv.TAURI_SIGNING_PRIVATE_KEY && !nextEnv.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    nextEnv.TAURI_SIGNING_PRIVATE_KEY_PATH = path.join(process.env.HOME || '', '.tauri', 'redbox-updater.key');
  }
  return nextEnv;
}

async function resolveFetchedLinuxArtifactsForTarget(localDir, target) {
  const bundleRoot = bundleRootForTarget(target);
  const { debPath, updaterArchivePath, updaterSignaturePath } = await resolveLinuxArtifacts(bundleRoot);
  const localDebPath =
    debPath && (await pathExists(path.join(localDir, path.basename(debPath))))
      ? path.join(localDir, path.basename(debPath))
      : await findNewestFile(localDir, (filePath) => filePath.endsWith('.deb'));
  const localUpdaterArchivePath =
    updaterArchivePath && (await pathExists(path.join(localDir, path.basename(updaterArchivePath))))
      ? path.join(localDir, path.basename(updaterArchivePath))
      : await findNewestFile(localDir, (filePath) => (
        filePath.toLowerCase().endsWith('.appimage.tar.gz')
        && linuxUpdaterFilenameMatchesTarget(filePath, target)
      ));
  const localUpdaterSignaturePath =
    updaterSignaturePath && (await pathExists(path.join(localDir, path.basename(updaterSignaturePath))))
      ? path.join(localDir, path.basename(updaterSignaturePath))
      : localUpdaterArchivePath && (await pathExists(`${localUpdaterArchivePath}.sig`))
        ? `${localUpdaterArchivePath}.sig`
        : await findNewestFile(localDir, (filePath) => (
          filePath.toLowerCase().endsWith('.appimage.tar.gz.sig')
          && linuxUpdaterFilenameMatchesTarget(filePath, target)
        ));

  return {
    debPath: localDebPath,
    updaterArchivePath: localUpdaterArchivePath,
    updaterSignaturePath: localUpdaterSignaturePath,
  };
}

async function buildLocalTarget(target, pluginInfo) {
  const tauriConfig = await readTauriConfig();
  assertBundledGuideResources(tauriConfig);

  const overrideConfig = {
    bundle: {
      ...(tauriConfig.bundle || {}),
      targets: ['deb', 'appimage'],
    },
  };

  const tempConfig = await writeTempJsonConfig('redbox-linux-release', overrideConfig);

  try {
    logStep(`Building Linux desktop packages for ${target}`);
    await runCommand(
      'pnpm',
      ['tauri', 'build', '--ci', '--config', tempConfig.configPath, '--target', target],
      { cwd: repoRoot, env: withDefaultTauriSigningEnv(process.env) },
    );

    const releaseRoot = path.join(repoRoot, 'src-tauri', 'target', target, 'release');
    const bundledPlugin = await assertDirectoryIncludesBrowserPlugin(
      releaseRoot,
      pluginInfo,
      `Linux ${target} release output`,
    );
    logStep(
      `Verified Linux ${target} bundled browser plugin ${bundledPlugin.version} (${bundledPlugin.fileCount} files, ${bundledPlugin.digest.slice(0, 12)})`,
    );

    const bundleRoot = bundleRootForTarget(target);
    const { debPath, updaterArchivePath, updaterSignaturePath } = await resolveLinuxArtifacts(bundleRoot);
    if (!debPath) {
      throw new Error(`Unable to locate generated Linux .deb artifact in ${bundleRoot}`);
    }
    if (!updaterArchivePath || !updaterSignaturePath) {
      throw new Error(`Unable to locate generated Linux updater archive/signature in ${bundleRoot}`);
    }

    const debArtifactPath = debPath
      ? await copyArtifactToDir(debPath, installerArtifactsDir('linux'))
      : null;
    const packageJson = await readPackageJson();
    const updaterArtifactPath = await copyArtifactToDirAs(
      updaterArchivePath,
      installerArtifactsDir('linux'),
      linuxUpdaterArtifactFilename(packageJson.productName || 'RedBox', packageJson.version, target, ''),
    );
    const updaterSignatureArtifactPath = await copyArtifactToDirAs(
      updaterSignaturePath,
      installerArtifactsDir('linux'),
      linuxUpdaterArtifactFilename(packageJson.productName || 'RedBox', packageJson.version, target, '.sig'),
    );

    return {
      target,
      mode: 'native-linux',
      debPath,
      debArtifactPath,
      updaterArchivePath,
      updaterSignaturePath,
      updaterArtifactPath,
      updaterSignatureArtifactPath,
    };
  } finally {
    await tempConfig.cleanup();
  }
}

async function buildLocally(targets) {
  if (process.platform !== 'linux') {
    throw new Error('Local Linux packaging requires a Linux host. Use the default remote mode on macOS.');
  }

  await ensureCommandExists('pnpm');
  await ensureCommandExists('rustup');
  const pluginInfo = await getBrowserPluginInfo();
  logStep(
    `Using browser plugin ${pluginInfo.version} (${pluginInfo.fileCount} files, ${pluginInfo.digest.slice(0, 12)})`,
  );
  await runCommand('node', ['./scripts/tauri-preflight.mjs'], { cwd: repoRoot });
  await ensureRustTargets(targets, { cwd: repoRoot });
  await removeLegacyAppImages(installerArtifactsDir('linux'));

  const artifacts = [];
  for (const target of targets) {
    artifacts.push(await buildLocalTarget(target, pluginInfo));
  }

  const packageJson = await readPackageJson();
  const summary = {
    productName: packageJson.productName || 'RedBox',
    version: packageJson.version,
    requestedTargets: targets,
    target: artifacts[0]?.target || null,
    mode: 'native-linux',
    debPath: artifacts[0]?.debPath || null,
    debArtifactPath: artifacts[0]?.debArtifactPath || null,
    updaterArchivePath: artifacts[0]?.updaterArchivePath || null,
    updaterSignaturePath: artifacts[0]?.updaterSignaturePath || null,
    updaterArtifactPath: artifacts[0]?.updaterArtifactPath || null,
    updaterSignatureArtifactPath: artifacts[0]?.updaterSignatureArtifactPath || null,
    installerPath: artifacts[0]?.debArtifactPath || null,
    artifacts,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Linux release completed');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.target}`);
    if (artifact.debPath) {
      console.log(`  deb: ${artifact.debPath}`);
      console.log(`  deb copy: ${artifact.debArtifactPath}`);
    }
    console.log(`  updater: ${artifact.updaterArtifactPath}`);
    console.log(`  updater signature: ${artifact.updaterSignatureArtifactPath}`);
  }
  console.log(`- summary: ${summaryPath}`);
}

async function buildOnRemote({ targets, remoteHost, remoteWorkdir }) {
  await ensureCommandExists('ssh', 'OpenSSH client is required.');
  await ensureCommandExists('rsync', 'rsync is required for remote Linux builds.');

  const localLinuxDir = installerArtifactsDir('linux');
  await removeLegacyAppImages(localLinuxDir);
  const remoteScriptPath = path.posix.join(remoteWorkdir, 'scripts', 'build-linux-release.mjs');
  const remotePluginDir = remoteSiblingDir(remoteWorkdir, 'Plugin');
  const pluginInfo = await getBrowserPluginInfo();

  logStep(`Syncing source to ${remoteHost}:${remoteWorkdir}`);
  logStep(
    `Syncing browser plugin ${pluginInfo.version} (${pluginInfo.fileCount} files, ${pluginInfo.digest.slice(0, 12)})`,
  );
  await runCommand('ssh', [remoteHost, `mkdir -p ${shellQuote(remoteWorkdir)} ${shellQuote(remotePluginDir)}`], {
    cwd: repoRoot,
  });
  await runCommand(
    'rsync',
    [
      '-az',
      '--delete',
      '--exclude=.git',
      '--exclude=node_modules',
      '--exclude=dist',
      '--exclude=artifacts',
      '--exclude=src-tauri/target',
      `${repoRoot}/`,
      `${remoteHost}:${remoteWorkdir}/`,
    ],
    { cwd: repoRoot },
  );
  await runCommand(
    'rsync',
    [
      '-az',
      '--delete',
      '--exclude=.DS_Store',
      `${browserPluginSourceDir}/`,
      `${remoteHost}:${remotePluginDir}/`,
    ],
    { cwd: repoRoot },
  );

  const remoteEnv = [
    'REDBOX_LINUX_MODE=local',
    `REDBOX_LINUX_TARGETS=${shellQuote(targets.join(','))}`,
  ];

  const remoteBuildCommand = remoteCommand([
    'bash -lc',
    shellQuote([
      `cd ${shellQuote(remoteWorkdir)}`,
      'source "$HOME/.cargo/env" >/dev/null 2>&1 || true',
      'export TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/redbox-updater.key}"',
      'node ./scripts/tauri-preflight.mjs',
      'pnpm install --frozen-lockfile',
      `env ${remoteEnv.join(' ')} node ${shellQuote(remoteScriptPath)}`,
    ].join(' && ')),
  ]);

  logStep(`Building Linux desktop packages on remote host ${remoteHost}`);
  await runCommand('ssh', [remoteHost, remoteBuildCommand], { cwd: repoRoot });

  await fs.mkdir(localLinuxDir, { recursive: true });
  logStep(`Fetching Linux artifacts to ${localLinuxDir}`);
  await runCommand(
    'rsync',
    [
      '-az',
      '--include=*/',
      '--include=*.deb',
      '--include=*.AppImage.tar.gz',
      '--include=*.AppImage.tar.gz.sig',
      '--exclude=*',
      `${remoteHost}:${remoteWorkdir}/artifacts/installers/linux/`,
      `${localLinuxDir}/`,
    ],
    { cwd: repoRoot },
  );

  const artifacts = [];
  for (const target of targets) {
    const { debPath, updaterArchivePath, updaterSignaturePath } = await resolveFetchedLinuxArtifactsForTarget(
      localLinuxDir,
      target,
    );
    if (!debPath) {
      throw new Error(`Unable to locate fetched Linux .deb artifact for ${target} in ${localLinuxDir}`);
    }
    if (!updaterArchivePath || !updaterSignaturePath) {
      throw new Error(`Unable to locate fetched Linux updater archive/signature for ${target} in ${localLinuxDir}`);
    }
    artifacts.push({
      target,
      mode: 'remote-linux',
      remoteHost,
      remoteWorkdir,
      debPath,
      debArtifactPath: debPath,
      updaterArchivePath,
      updaterSignaturePath,
      updaterArtifactPath: updaterArchivePath,
      updaterSignatureArtifactPath: updaterSignaturePath,
    });
  }

  const packageJson = await readPackageJson();
  const summary = {
    productName: packageJson.productName || 'RedBox',
    version: packageJson.version,
    requestedTargets: targets,
    target: artifacts[0]?.target || null,
    mode: 'remote-linux',
    remoteHost,
    remoteWorkdir,
    debPath: artifacts[0]?.debPath || null,
    debArtifactPath: artifacts[0]?.debArtifactPath || null,
    updaterArchivePath: artifacts[0]?.updaterArchivePath || null,
    updaterSignaturePath: artifacts[0]?.updaterSignaturePath || null,
    updaterArtifactPath: artifacts[0]?.updaterArtifactPath || null,
    updaterSignatureArtifactPath: artifacts[0]?.updaterSignatureArtifactPath || null,
    installerPath: artifacts[0]?.debArtifactPath || null,
    artifacts,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Linux release completed');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.target}`);
    if (artifact.debArtifactPath) {
      console.log(`  deb: ${artifact.debArtifactPath}`);
    }
    console.log(`  updater: ${artifact.updaterArtifactPath}`);
    console.log(`  updater signature: ${artifact.updaterSignatureArtifactPath}`);
  }
  console.log(`- summary: ${summaryPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('Usage: pnpm release:linux [-- --mode remote|local] [-- --host jamdebian] [-- --workdir /home/jam/build/redbox-tauri-linux-release] [-- --targets x86_64-unknown-linux-gnu]');
    return;
  }

  const targets = parseTargetList(
    args.targets || process.env.REDBOX_LINUX_TARGETS || args.target || process.env.REDBOX_LINUX_TARGET,
    DEFAULT_LINUX_TARGETS,
  );
  const mode = String(
    args.mode ||
      process.env.REDBOX_LINUX_MODE ||
      (process.platform === 'linux' ? 'local' : 'remote'),
  ).trim();

  if (mode === 'local' || mode === 'native' || mode === 'native-linux') {
    await buildLocally(targets);
    return;
  }

  if (mode !== 'remote') {
    throw new Error(`Unsupported Linux release mode: ${mode}`);
  }

  const remoteHost = String(args.host || process.env.REDBOX_REMOTE_HOST || 'jamdebian').trim();
  const remoteWorkdir = String(
    args.workdir || process.env.REDBOX_REMOTE_WORKDIR || '/home/jam/build/redbox-tauri-linux-release',
  ).trim();

  await buildOnRemote({ targets, remoteHost, remoteWorkdir });
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
