import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  assertBundledGuideResources,
  artifactsRoot,
  bundleRootForTarget,
  copyArtifactToDir,
  ensureCommandExists,
  envFlag,
  findNewestFile,
  installerArtifactsDir,
  logStep,
  parseArgs,
  pathExists,
  readPackageJson,
  readTauriConfig,
  repoRoot,
  runCommand,
  writeTempJsonConfig,
} from './release-utils.mjs';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function remoteCommand(parts) {
  return parts.filter(Boolean).join(' ');
}

async function resolveWindowsArtifacts(bundleRoot) {
  const nsisDir = path.join(bundleRoot, 'nsis');
  const setupPath = await findNewestFile(nsisDir, (filePath) => filePath.endsWith('-setup.exe'));
  const portableExePath = await findNewestFile(
    nsisDir,
    (filePath) => filePath.endsWith('.exe') && !filePath.endsWith('-setup.exe'),
  );
  const portableZipPath = await findNewestFile(nsisDir, (filePath) => filePath.endsWith('.zip'));
  return { nsisDir, setupPath, portableExePath, portableZipPath };
}

async function resolveFetchedWindowsArtifacts(localDir) {
  const setupPath = await findNewestFile(localDir, (filePath) => filePath.endsWith('-setup.exe'));
  const portableExePath = await findNewestFile(
    localDir,
    (filePath) => filePath.endsWith('.exe') && !filePath.endsWith('-setup.exe'),
  );
  const portableZipPath = await findNewestFile(localDir, (filePath) => filePath.endsWith('.zip'));
  return { setupPath, portableExePath, portableZipPath };
}

async function writeSummary(summary) {
  const summaryPath = path.join(artifactsRoot, 'release', 'windows-build-summary.json');
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function buildLocally({ target, runner, signCommand, requireSigning }) {
  await ensureCommandExists('pnpm');
  const tauriConfig = await readTauriConfig();
  assertBundledGuideResources(tauriConfig);

  const hostIsWindows = process.platform === 'win32';
  if (hostIsWindows) {
    logStep('Using native Windows build path');
  } else {
    logStep('Using local cross-compile Windows build path');
    await ensureCommandExists('cargo-xwin', 'Install with `cargo install --locked cargo-xwin`.');
    await ensureCommandExists('makensis', 'Install NSIS first.');
    await ensureCommandExists('llvm-rc', 'Install LLVM first and ensure llvm-rc is in PATH.');
  }

  if (requireSigning && !signCommand) {
    throw new Error(
      'Missing Windows sign command. Set REDBOX_WINDOWS_SIGN_COMMAND or pass --sign-command.',
    );
  }

  const overrideConfig = {
    bundle: {
      ...(tauriConfig.bundle || {}),
      targets: ['nsis'],
    },
  };

  if (signCommand) {
    overrideConfig.bundle.windows = {
      signCommand,
    };
  }

  const tempConfig = await writeTempJsonConfig('redbox-windows-release', overrideConfig);

  try {
    const buildArgs = ['tauri', 'build', '--ci', '--config', tempConfig.configPath, '--target', target];
    if (!hostIsWindows) {
      buildArgs.push('--runner', runner || 'cargo-xwin');
    } else if (runner) {
      buildArgs.push('--runner', runner);
    }

    logStep(`Building Windows installer for ${target}`);
    await runCommand('pnpm', buildArgs, { cwd: repoRoot });

    const bundleRoot = bundleRootForTarget(target);
    const { setupPath, portableExePath, portableZipPath } = await resolveWindowsArtifacts(bundleRoot);
    if (!setupPath) {
      throw new Error(`Unable to locate generated NSIS installer in ${bundleRoot}`);
    }
    const localInstallerPath = await copyArtifactToDir(
      setupPath,
      installerArtifactsDir('windows'),
    );
    const localPortableExePath = portableExePath
      ? await copyArtifactToDir(portableExePath, installerArtifactsDir('windows'))
      : null;
    const localPortableZipPath = portableZipPath
      ? await copyArtifactToDir(portableZipPath, installerArtifactsDir('windows'))
      : null;

    const packageJson = await readPackageJson();
    const summary = {
      productName: packageJson.productName || 'RedBox',
      version: packageJson.version,
      target,
      mode: hostIsWindows ? 'native' : 'local-cross',
      runner: hostIsWindows ? runner || 'cargo' : runner || 'cargo-xwin',
      signed: Boolean(signCommand),
      setupPath,
      portableExePath,
      portableZipPath,
      installerPath: localInstallerPath,
      portableExeArtifactPath: localPortableExePath,
      portableZipArtifactPath: localPortableZipPath,
    };

    const summaryPath = await writeSummary(summary);

    console.log('');
    console.log('Windows release completed');
    console.log(`- installer: ${setupPath}`);
    console.log(`- installer copy: ${localInstallerPath}`);
    if (portableExePath) {
      console.log(`- portable exe: ${portableExePath}`);
      console.log(`- portable exe copy: ${localPortableExePath}`);
    }
    if (portableZipPath) {
      console.log(`- portable zip: ${portableZipPath}`);
      console.log(`- portable zip copy: ${localPortableZipPath}`);
    }
    console.log(`- summary: ${summaryPath}`);
  } finally {
    await tempConfig.cleanup();
  }
}

async function buildOnRemote({ target, runner, signCommand, requireSigning, remoteHost, remoteWorkdir }) {
  await ensureCommandExists('ssh', 'OpenSSH client is required.');
  await ensureCommandExists('rsync', 'rsync is required for remote Windows builds.');

  const remoteScriptPath = path.posix.join(remoteWorkdir, 'scripts', 'build-windows-release.mjs');
  const remoteRoot = `${remoteHost}:${remoteWorkdir}/`;
  const localWinDir = installerArtifactsDir('windows');

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
      remoteRoot,
    ],
    { cwd: repoRoot },
  );

  const remoteEnv = [
    'REDBOX_WINDOWS_MODE=local',
    `REDBOX_WINDOWS_TARGET=${shellQuote(target)}`,
    `REDBOX_WINDOWS_RUNNER=${shellQuote(runner || 'cargo-xwin')}`,
  ];

  if (signCommand) {
    remoteEnv.push(`REDBOX_WINDOWS_SIGN_COMMAND=${shellQuote(signCommand)}`);
  }
  if (requireSigning) {
    remoteEnv.push('REDBOX_REQUIRE_WINDOWS_SIGN=1');
  }

  const remoteBuild = remoteCommand([
    'bash -lc',
    shellQuote(
      [
        `cd ${shellQuote(remoteWorkdir)}`,
        'source "$HOME/.cargo/env" >/dev/null 2>&1 || true',
        'pnpm install --frozen-lockfile',
        `env ${remoteEnv.join(' ')} node ${shellQuote(remoteScriptPath)}`,
      ].join(' && '),
    ),
  ]);

  logStep(`Building Windows installer on remote host ${remoteHost}`);
  await runCommand('ssh', [remoteHost, remoteBuild], { cwd: repoRoot });

  await fs.mkdir(localWinDir, { recursive: true });
  logStep(`Fetching Windows artifacts to ${localWinDir}`);
  await runCommand(
    'rsync',
    [
      '-az',
      '--delete',
      '--include=*/',
      '--include=*.exe',
      '--include=*.zip',
      '--include=*.yml',
      '--include=*.blockmap',
      '--exclude=*',
      `${remoteHost}:${remoteWorkdir}/src-tauri/target/${target}/release/bundle/nsis/`,
      `${localWinDir}/`,
    ],
    { cwd: repoRoot },
  );

  if (!(await pathExists(localWinDir))) {
    throw new Error(`Local Windows artifact directory missing: ${localWinDir}`);
  }

  const { setupPath, portableExePath, portableZipPath } = await resolveFetchedWindowsArtifacts(localWinDir);
  if (!setupPath) {
    throw new Error(`Unable to locate fetched NSIS installer in ${localWinDir}`);
  }

  const packageJson = await readPackageJson();
  const summary = {
    productName: packageJson.productName || 'RedBox',
    version: packageJson.version,
    target,
    mode: 'remote',
    remoteHost,
    remoteWorkdir,
    runner: runner || 'cargo-xwin',
    signed: Boolean(signCommand),
    setupPath,
    portableExePath,
    portableZipPath,
    installerPath: setupPath,
    portableExeArtifactPath: portableExePath,
    portableZipArtifactPath: portableZipPath,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Windows release completed');
  console.log(`- installer: ${setupPath}`);
  if (portableExePath) {
    console.log(`- portable exe: ${portableExePath}`);
  }
  if (portableZipPath) {
    console.log(`- portable zip: ${portableZipPath}`);
  }
  console.log(`- summary: ${summaryPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('Usage: pnpm release:win [-- --mode remote|local] [-- --host jamdebian] [-- --workdir /home/jam/build/lexbox-win-release] [-- --target x86_64-pc-windows-msvc] [-- --runner cargo-xwin] [-- --sign-command "<command with %1>"] [-- --require-signing]');
    return;
  }

  const target = String(args.target || process.env.REDBOX_WINDOWS_TARGET || 'x86_64-pc-windows-msvc').trim();
  const runner = String(args.runner || process.env.REDBOX_WINDOWS_RUNNER || '').trim();
  const signCommand = String(args['sign-command'] || process.env.REDBOX_WINDOWS_SIGN_COMMAND || '').trim();
  const requireSigning = args['require-signing'] === true || envFlag('REDBOX_REQUIRE_WINDOWS_SIGN', false);
  const mode = String(
    args.mode ||
      process.env.REDBOX_WINDOWS_MODE ||
      (process.platform === 'win32' ? 'native' : 'remote'),
  ).trim();

  if (mode === 'local' || mode === 'native' || mode === 'local-cross') {
    await buildLocally({ target, runner, signCommand, requireSigning });
    return;
  }

  if (mode !== 'remote') {
    throw new Error(`Unsupported Windows release mode: ${mode}`);
  }

  const remoteHost = String(args.host || process.env.REDBOX_REMOTE_HOST || 'jamdebian').trim();
  const remoteWorkdir = String(
    args.workdir || process.env.REDBOX_REMOTE_WORKDIR || '/home/jam/build/lexbox-win-release',
  ).trim();

  await buildOnRemote({
    target,
    runner,
    signCommand,
    requireSigning,
    remoteHost,
    remoteWorkdir,
  });
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
