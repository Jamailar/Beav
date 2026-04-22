import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  artifactsRoot,
  assertBundledGuideResources,
  bundleRootForTarget,
  copyArtifactToDir,
  ensureCommandExists,
  ensureRustTargets,
  findNewestFile,
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

async function writeSummary(summary) {
  const summaryPath = path.join(artifactsRoot, 'release', 'linux-build-summary.json');
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function resolveLinuxArtifacts(bundleRoot) {
  const appImageDir = path.join(bundleRoot, 'appimage');
  const debDir = path.join(bundleRoot, 'deb');
  const appImagePath = await findNewestFile(appImageDir, (filePath) => filePath.endsWith('.AppImage'));
  const debPath = await findNewestFile(debDir, (filePath) => filePath.endsWith('.deb'));
  return { appImagePath, debPath };
}

async function resolveFetchedLinuxArtifactsForTarget(localDir, target) {
  const bundleRoot = bundleRootForTarget(target);
  const { appImagePath, debPath } = await resolveLinuxArtifacts(bundleRoot);

  const localAppImagePath =
    appImagePath && (await pathExists(path.join(localDir, path.basename(appImagePath))))
      ? path.join(localDir, path.basename(appImagePath))
      : await findNewestFile(localDir, (filePath) => filePath.endsWith('.AppImage'));
  const localDebPath =
    debPath && (await pathExists(path.join(localDir, path.basename(debPath))))
      ? path.join(localDir, path.basename(debPath))
      : await findNewestFile(localDir, (filePath) => filePath.endsWith('.deb'));

  return {
    appImagePath: localAppImagePath,
    debPath: localDebPath,
  };
}

async function buildLocalTarget(target) {
  const tauriConfig = await readTauriConfig();
  assertBundledGuideResources(tauriConfig);

  const overrideConfig = {
    bundle: {
      ...(tauriConfig.bundle || {}),
      targets: ['appimage', 'deb'],
    },
  };

  const tempConfig = await writeTempJsonConfig('redbox-linux-release', overrideConfig);

  try {
    logStep(`Building Linux desktop packages for ${target}`);
    await runCommand(
      'pnpm',
      ['tauri', 'build', '--ci', '--config', tempConfig.configPath, '--target', target],
      { cwd: repoRoot },
    );

    const bundleRoot = bundleRootForTarget(target);
    const { appImagePath, debPath } = await resolveLinuxArtifacts(bundleRoot);
    if (!appImagePath && !debPath) {
      throw new Error(`Unable to locate generated Linux artifacts in ${bundleRoot}`);
    }

    const appImageArtifactPath = appImagePath
      ? await copyArtifactToDir(appImagePath, installerArtifactsDir('linux'))
      : null;
    const debArtifactPath = debPath
      ? await copyArtifactToDir(debPath, installerArtifactsDir('linux'))
      : null;

    return {
      target,
      mode: 'native-linux',
      appImagePath,
      debPath,
      appImageArtifactPath,
      debArtifactPath,
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
  await runCommand('node', ['./scripts/tauri-preflight.mjs'], { cwd: repoRoot });
  await ensureRustTargets(targets, { cwd: repoRoot });

  const artifacts = [];
  for (const target of targets) {
    artifacts.push(await buildLocalTarget(target));
  }

  const packageJson = await readPackageJson();
  const summary = {
    productName: packageJson.productName || 'RedBox',
    version: packageJson.version,
    requestedTargets: targets,
    target: artifacts[0]?.target || null,
    mode: 'native-linux',
    appImagePath: artifacts[0]?.appImagePath || null,
    debPath: artifacts[0]?.debPath || null,
    appImageArtifactPath: artifacts[0]?.appImageArtifactPath || null,
    debArtifactPath: artifacts[0]?.debArtifactPath || null,
    installerPath: artifacts[0]?.appImageArtifactPath || artifacts[0]?.debArtifactPath || null,
    artifacts,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Linux release completed');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.target}`);
    if (artifact.appImagePath) {
      console.log(`  appimage: ${artifact.appImagePath}`);
      console.log(`  appimage copy: ${artifact.appImageArtifactPath}`);
    }
    if (artifact.debPath) {
      console.log(`  deb: ${artifact.debPath}`);
      console.log(`  deb copy: ${artifact.debArtifactPath}`);
    }
  }
  console.log(`- summary: ${summaryPath}`);
}

async function buildOnRemote({ targets, remoteHost, remoteWorkdir }) {
  await ensureCommandExists('ssh', 'OpenSSH client is required.');
  await ensureCommandExists('rsync', 'rsync is required for remote Linux builds.');

  const localLinuxDir = installerArtifactsDir('linux');
  const remoteScriptPath = path.posix.join(remoteWorkdir, 'scripts', 'build-linux-release.mjs');

  logStep(`Syncing source to ${remoteHost}:${remoteWorkdir}`);
  await runCommand('ssh', [remoteHost, `mkdir -p ${shellQuote(remoteWorkdir)}`], { cwd: repoRoot });
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

  const remoteEnv = [
    'REDBOX_LINUX_MODE=local',
    `REDBOX_LINUX_TARGETS=${shellQuote(targets.join(','))}`,
  ];

  const remoteBuildCommand = remoteCommand([
    'bash -lc',
    shellQuote([
      `cd ${shellQuote(remoteWorkdir)}`,
      'source "$HOME/.cargo/env" >/dev/null 2>&1 || true',
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
      '--include=*.AppImage',
      '--include=*.deb',
      '--exclude=*',
      `${remoteHost}:${remoteWorkdir}/artifacts/installers/linux/`,
      `${localLinuxDir}/`,
    ],
    { cwd: repoRoot },
  );

  const artifacts = [];
  for (const target of targets) {
    const { appImagePath, debPath } = await resolveFetchedLinuxArtifactsForTarget(localLinuxDir, target);
    if (!appImagePath && !debPath) {
      throw new Error(`Unable to locate fetched Linux artifacts for ${target} in ${localLinuxDir}`);
    }
    artifacts.push({
      target,
      mode: 'remote-linux',
      remoteHost,
      remoteWorkdir,
      appImagePath,
      debPath,
      appImageArtifactPath: appImagePath,
      debArtifactPath: debPath,
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
    appImagePath: artifacts[0]?.appImagePath || null,
    debPath: artifacts[0]?.debPath || null,
    appImageArtifactPath: artifacts[0]?.appImageArtifactPath || null,
    debArtifactPath: artifacts[0]?.debArtifactPath || null,
    installerPath: artifacts[0]?.appImageArtifactPath || artifacts[0]?.debArtifactPath || null,
    artifacts,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Linux release completed');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.target}`);
    if (artifact.appImageArtifactPath) {
      console.log(`  appimage: ${artifact.appImageArtifactPath}`);
    }
    if (artifact.debArtifactPath) {
      console.log(`  deb: ${artifact.debArtifactPath}`);
    }
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
