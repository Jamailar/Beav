import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  assertBundledGuideResources,
  assertDirectoryIncludesBrowserPlugin,
  artifactsRoot,
  browserPluginSourceDir,
  bundleRootForTarget,
  copyArtifactToDir,
  ensureRustTargets,
  ensureCommandExists,
  envFlag,
  findNewestFile,
  getBrowserPluginInfo,
  installerArtifactsDir,
  logStep,
  parseTargetList,
  parseArgs,
  pathExists,
  readPackageJson,
  readTauriConfig,
  repoRoot,
  runCommand,
  writeTempJsonConfig,
} from './release-utils.mjs';

const DEFAULT_WINDOWS_TARGETS = [
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
  'i686-pc-windows-msvc',
];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function remoteCommand(parts) {
  return parts.filter(Boolean).join(' ');
}

function remoteSiblingDir(remoteWorkdir, dirname) {
  return path.posix.join(path.posix.dirname(remoteWorkdir.replace(/\/+$/, '')), dirname);
}

function remoteNsisDirForTarget(remoteWorkdir, target) {
  return path.posix.join(
    remoteWorkdir,
    'src-tauri',
    'target',
    target,
    'release',
    'bundle',
    'nsis',
  );
}

function windowsTargetArchLabel(target) {
  if (target.startsWith('aarch64-')) {
    return 'arm64';
  }
  if (target.startsWith('x86_64-')) {
    return 'x64';
  }
  if (target.startsWith('i686-')) {
    return 'x86';
  }
  return null;
}

function windowsTargetXwinArch(target) {
  if (target.startsWith('aarch64-')) {
    return 'aarch64';
  }
  if (target.startsWith('x86_64-')) {
    return 'x86_64';
  }
  if (target.startsWith('i686-') || target.startsWith('i586-')) {
    return 'x86';
  }
  return null;
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

async function resolveFetchedWindowsArtifactsForTarget(localDir, target) {
  const archLabel = windowsTargetArchLabel(target);
  const fileMatchesTarget = (filePath) => {
    if (!archLabel) {
      return true;
    }
    return path.basename(filePath).toLowerCase().includes(`_${archLabel.toLowerCase()}`);
  };

  const setupPath = await findNewestFile(
    localDir,
    (filePath) => filePath.endsWith('-setup.exe') && fileMatchesTarget(filePath),
  );
  const portableExePath = await findNewestFile(
    localDir,
    (filePath) =>
      filePath.endsWith('.exe') &&
      !filePath.endsWith('-setup.exe') &&
      fileMatchesTarget(filePath),
  );
  const portableZipPath = await findNewestFile(
    localDir,
    (filePath) => filePath.endsWith('.zip') && fileMatchesTarget(filePath),
  );
  return { setupPath, portableExePath, portableZipPath };
}

async function writeSummary(summary) {
  const summaryPath = path.join(artifactsRoot, 'release', 'windows-build-summary.json');
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function createWindowsClangWrappers({
  realClangPath,
  realClangxxPath,
  realClangClPath,
}) {
  const wrapperDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redbox-clang-cl-'));
  const wrapperScriptPath = path.join(wrapperDir, 'clang');
  const wrapperScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'compiler_name="$(basename "$0")"',
    'use_clang_cl=0',
    'case "$compiler_name" in',
    '  clang-cl|clang-cl.exe)',
    '    use_clang_cl=1',
    '    ;;',
    'esac',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    /imsvc|--target=*windows-msvc|--target=*pc-windows-msvc)',
    '      use_clang_cl=1',
    '      ;;',
    '  esac',
    'done',
    'if [ "$use_clang_cl" = "1" ]; then',
    `  exec ${JSON.stringify(realClangClPath)} "$@"`,
    'fi',
    'if [ "$compiler_name" = "clang++" ]; then',
    `  exec ${JSON.stringify(realClangxxPath)} "$@"`,
    'fi',
    `exec ${JSON.stringify(realClangPath)} "$@"`,
    '',
  ].join('\n');

  await fs.writeFile(wrapperScriptPath, wrapperScript, 'utf8');
  await fs.chmod(wrapperScriptPath, 0o755);
  await fs.symlink(wrapperScriptPath, path.join(wrapperDir, 'clang++'));
  await fs.symlink(wrapperScriptPath, path.join(wrapperDir, 'clang-cl'));
  return {
    wrapperDir,
    cleanup: async () => {
      await fs.rm(wrapperDir, { recursive: true, force: true });
    },
  };
}

async function clearCargoXwinClangSymlinkCache() {
  const cacheDir = path.join(os.homedir(), '.cache', 'cargo-xwin');
  await fs.rm(path.join(cacheDir, 'clang-cl'), { force: true });
  await fs.rm(path.join(cacheDir, 'clang-cl.exe'), { force: true });
}

function prependPathEnv(env, extraDir) {
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  const current = String(env[key] || env.PATH || '');
  return {
    ...env,
    [key]: current ? `${extraDir}${path.delimiter}${current}` : extraDir,
  };
}

async function buildLocalTarget({ target, runner, signCommand, hostIsWindows, buildEnv, pluginInfo }) {
  const tauriConfig = await readTauriConfig();
  assertBundledGuideResources(tauriConfig);

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
    await runCommand('pnpm', buildArgs, { cwd: repoRoot, env: buildEnv });

    const releaseRoot = path.join(repoRoot, 'src-tauri', 'target', target, 'release');
    const bundledPlugin = await assertDirectoryIncludesBrowserPlugin(
      releaseRoot,
      pluginInfo,
      `Windows ${target} release output`,
    );
    logStep(
      `Verified Windows ${target} bundled browser plugin ${bundledPlugin.version} (${bundledPlugin.fileCount} files, ${bundledPlugin.digest.slice(0, 12)})`,
    );

    const bundleRoot = bundleRootForTarget(target);
    const { setupPath, portableExePath, portableZipPath } = await resolveWindowsArtifacts(bundleRoot);
    if (!setupPath) {
      throw new Error(`Unable to locate generated NSIS installer in ${bundleRoot}`);
    }

    const installerPath = await copyArtifactToDir(
      setupPath,
      installerArtifactsDir('windows'),
    );
    const portableExeArtifactPath = portableExePath
      ? await copyArtifactToDir(portableExePath, installerArtifactsDir('windows'))
      : null;
    const portableZipArtifactPath = portableZipPath
      ? await copyArtifactToDir(portableZipPath, installerArtifactsDir('windows'))
      : null;

    return {
      target,
      mode: hostIsWindows ? 'native' : 'local-cross',
      runner: hostIsWindows ? runner || 'cargo' : runner || 'cargo-xwin',
      setupPath,
      portableExePath,
      portableZipPath,
      installerPath,
      portableExeArtifactPath,
      portableZipArtifactPath,
    };
  } finally {
    await tempConfig.cleanup();
  }
}

async function buildLocally({ targets, runner, signCommand, requireSigning }) {
  await ensureCommandExists('pnpm');
  await ensureCommandExists('rustup');
  const tauriConfig = await readTauriConfig();
  assertBundledGuideResources(tauriConfig);
  const pluginInfo = await getBrowserPluginInfo();
  logStep(
    `Using browser plugin ${pluginInfo.version} (${pluginInfo.fileCount} files, ${pluginInfo.digest.slice(0, 12)})`,
  );
  await runCommand('node', ['./scripts/tauri-preflight.mjs'], { cwd: repoRoot });

  const hostIsWindows = process.platform === 'win32';
  let clangWrappers = null;
  let buildEnv = process.env;
  if (hostIsWindows) {
    logStep('Using native Windows build path');
  } else {
    logStep('Using local cross-compile Windows build path');
    await ensureCommandExists('cargo-xwin', 'Install with `cargo install --locked cargo-xwin`.');
    await ensureCommandExists('makensis', 'Install NSIS first.');
    await ensureCommandExists('llvm-rc', 'Install LLVM first and ensure llvm-rc is in PATH.');
    const realClangPath = await ensureCommandExists('clang', 'Install LLVM/Clang first.');
    const realClangxxPath = await ensureCommandExists('clang++', 'Install LLVM/Clang first.');
    const realClangClPath = await ensureCommandExists('clang-cl').catch(() => null) || await ensureCommandExists(
      'clang-cl-19',
      'Install LLVM/Clang with clang-cl support first.',
    );
    clangWrappers = await createWindowsClangWrappers({
      realClangPath,
      realClangxxPath,
      realClangClPath,
    });
    buildEnv = prependPathEnv(process.env, clangWrappers.wrapperDir);
    if (!String(process.env.XWIN_ARCH || '').trim()) {
      const xwinArchList = [...new Set(
        targets
          .map((target) => windowsTargetXwinArch(target))
          .filter(Boolean),
      )];
      if (xwinArchList.length > 0) {
        buildEnv = {
          ...buildEnv,
          XWIN_ARCH: xwinArchList.join(','),
        };
        logStep(`Configured XWIN_ARCH=${buildEnv.XWIN_ARCH}`);
      }
    }
    logStep(`Injected Windows LLVM wrappers at ${clangWrappers.wrapperDir}`);
    await clearCargoXwinClangSymlinkCache();
    logStep('Cleared stale cargo-xwin clang-cl cache symlinks');
  }

  if (requireSigning && !signCommand) {
    throw new Error(
      'Missing Windows sign command. Set REDBOX_WINDOWS_SIGN_COMMAND or pass --sign-command.',
    );
  }

  await ensureRustTargets(targets, { cwd: repoRoot });

  const artifacts = [];
  try {
    for (const target of targets) {
      artifacts.push(await buildLocalTarget({
        target,
        runner,
        signCommand,
        hostIsWindows,
        buildEnv,
        pluginInfo,
      }));
    }
  } finally {
    if (clangWrappers) {
      await clangWrappers.cleanup();
    }
  }

  const packageJson = await readPackageJson();
  const summary = {
    productName: packageJson.productName || 'RedBox',
    version: packageJson.version,
    requestedTargets: targets,
    target: artifacts[0]?.target || null,
    mode: artifacts[0]?.mode || (hostIsWindows ? 'native' : 'local-cross'),
    runner: artifacts[0]?.runner || (hostIsWindows ? runner || 'cargo' : runner || 'cargo-xwin'),
    signed: Boolean(signCommand),
    setupPath: artifacts[0]?.setupPath || null,
    portableExePath: artifacts[0]?.portableExePath || null,
    portableZipPath: artifacts[0]?.portableZipPath || null,
    installerPath: artifacts[0]?.installerPath || null,
    portableExeArtifactPath: artifacts[0]?.portableExeArtifactPath || null,
    portableZipArtifactPath: artifacts[0]?.portableZipArtifactPath || null,
    artifacts,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Windows release completed');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.target}`);
    console.log(`  installer: ${artifact.setupPath}`);
    console.log(`  installer copy: ${artifact.installerPath}`);
    if (artifact.portableExePath) {
      console.log(`  portable exe: ${artifact.portableExePath}`);
      console.log(`  portable exe copy: ${artifact.portableExeArtifactPath}`);
    }
    if (artifact.portableZipPath) {
      console.log(`  portable zip: ${artifact.portableZipPath}`);
      console.log(`  portable zip copy: ${artifact.portableZipArtifactPath}`);
    }
  }
  console.log(`- summary: ${summaryPath}`);
}

async function buildOnRemote({ targets, runner, signCommand, requireSigning, remoteHost, remoteWorkdir }) {
  await ensureCommandExists('ssh', 'OpenSSH client is required.');
  await ensureCommandExists('rsync', 'rsync is required for remote Windows builds.');

  const remoteScriptPath = path.posix.join(remoteWorkdir, 'scripts', 'build-windows-release.mjs');
  const remoteRoot = `${remoteHost}:${remoteWorkdir}/`;
  const remotePluginDir = remoteSiblingDir(remoteWorkdir, 'Plugin');
  const localWinDir = installerArtifactsDir('windows');
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
      remoteRoot,
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
    'REDBOX_WINDOWS_MODE=local',
    `REDBOX_WINDOWS_TARGETS=${shellQuote(targets.join(','))}`,
    `REDBOX_WINDOWS_RUNNER=${shellQuote(runner || 'cargo-xwin')}`,
  ];

  if (signCommand) {
    remoteEnv.push(`REDBOX_WINDOWS_SIGN_COMMAND=${shellQuote(signCommand)}`);
  }
  if (requireSigning) {
    remoteEnv.push('REDBOX_REQUIRE_WINDOWS_SIGN=1');
  }

  const remoteCleanupNsisDirs = targets
    .map((target) => remoteNsisDirForTarget(remoteWorkdir, target))
    .map((nsisDir) => `rm -rf ${shellQuote(nsisDir)}`)
    .join(' && ');

  const remoteBuild = remoteCommand([
    'bash -lc',
    shellQuote(
      [
        `cd ${shellQuote(remoteWorkdir)}`,
        'source "$HOME/.cargo/env" >/dev/null 2>&1 || true',
        'node ./scripts/tauri-preflight.mjs',
        'pnpm install --frozen-lockfile',
        'rustup target add aarch64-pc-windows-msvc x86_64-pc-windows-msvc i686-pc-windows-msvc',
        remoteCleanupNsisDirs,
        `env ${remoteEnv.join(' ')} node ${shellQuote(remoteScriptPath)}`,
      ].join(' && '),
    ),
  ]);

  logStep(`Building Windows installer on remote host ${remoteHost}`);
  await runCommand('ssh', [remoteHost, remoteBuild], { cwd: repoRoot });

  await fs.rm(localWinDir, { recursive: true, force: true });
  await fs.mkdir(localWinDir, { recursive: true });
  for (const target of targets) {
    const remoteNsisDir = `${remoteHost}:${remoteNsisDirForTarget(remoteWorkdir, target)}/`;
    logStep(`Fetching Windows artifacts for ${target} to ${localWinDir}`);
    await runCommand(
      'rsync',
      [
        '-az',
        '--include=*/',
        '--include=*.exe',
        '--include=*.zip',
        '--include=*.yml',
        '--include=*.blockmap',
        '--exclude=*',
        remoteNsisDir,
        `${localWinDir}/`,
      ],
      { cwd: repoRoot },
    );
  }

  if (!(await pathExists(localWinDir))) {
    throw new Error(`Local Windows artifact directory missing: ${localWinDir}`);
  }

  const packageJson = await readPackageJson();
  const artifacts = [];
  for (const target of targets) {
    const { setupPath, portableExePath, portableZipPath } =
      await resolveFetchedWindowsArtifactsForTarget(localWinDir, target);

    if (!setupPath) {
      throw new Error(`Unable to locate fetched NSIS installer for ${target} in ${localWinDir}`);
    }

    artifacts.push({
      target,
      mode: 'remote',
      remoteHost,
      remoteWorkdir,
      runner: runner || 'cargo-xwin',
      setupPath,
      portableExePath,
      portableZipPath,
      installerPath: setupPath,
      portableExeArtifactPath: portableExePath,
      portableZipArtifactPath: portableZipPath,
    });
  }

  const summary = {
    productName: packageJson.productName || 'RedBox',
    version: packageJson.version,
    requestedTargets: targets,
    target: artifacts[0]?.target || null,
    mode: 'remote',
    remoteHost,
    remoteWorkdir,
    runner: runner || 'cargo-xwin',
    signed: Boolean(signCommand),
    setupPath: artifacts[0]?.setupPath || null,
    portableExePath: artifacts[0]?.portableExePath || null,
    portableZipPath: artifacts[0]?.portableZipPath || null,
    installerPath: artifacts[0]?.installerPath || null,
    portableExeArtifactPath: artifacts[0]?.portableExeArtifactPath || null,
    portableZipArtifactPath: artifacts[0]?.portableZipArtifactPath || null,
    artifacts,
  };

  const summaryPath = await writeSummary(summary);

  console.log('');
  console.log('Windows release completed');
  for (const artifact of artifacts) {
    console.log(`- ${artifact.target}`);
    console.log(`  installer: ${artifact.installerPath}`);
    if (artifact.portableExeArtifactPath) {
      console.log(`  portable exe: ${artifact.portableExeArtifactPath}`);
    }
    if (artifact.portableZipArtifactPath) {
      console.log(`  portable zip: ${artifact.portableZipArtifactPath}`);
    }
  }
  console.log(`- summary: ${summaryPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('Usage: pnpm release:win [-- --mode remote|local] [-- --host jamdebian] [-- --workdir /home/jam/build/redbox-tauri-win-release] [-- --targets x86_64-pc-windows-msvc,aarch64-pc-windows-msvc,i686-pc-windows-msvc] [-- --target x86_64-pc-windows-msvc] [-- --runner cargo-xwin] [-- --sign-command "<command with %1>"] [-- --require-signing]');
    return;
  }

  const targets = parseTargetList(
    args.targets || process.env.REDBOX_WINDOWS_TARGETS || args.target || process.env.REDBOX_WINDOWS_TARGET,
    DEFAULT_WINDOWS_TARGETS,
  );
  const runner = String(args.runner || process.env.REDBOX_WINDOWS_RUNNER || '').trim();
  const signCommand = String(args['sign-command'] || process.env.REDBOX_WINDOWS_SIGN_COMMAND || '').trim();
  const requireSigning = args['require-signing'] === true || envFlag('REDBOX_REQUIRE_WINDOWS_SIGN', false);
  const mode = String(
    args.mode ||
      process.env.REDBOX_WINDOWS_MODE ||
      (process.platform === 'win32' ? 'native' : 'remote'),
  ).trim();

  if (mode === 'local' || mode === 'native' || mode === 'local-cross') {
    await buildLocally({ targets, runner, signCommand, requireSigning });
    return;
  }

  if (mode !== 'remote') {
    throw new Error(`Unsupported Windows release mode: ${mode}`);
  }

  const remoteHost = String(args.host || process.env.REDBOX_REMOTE_HOST || 'jamdebian').trim();
  const remoteWorkdir = String(
    args.workdir || process.env.REDBOX_REMOTE_WORKDIR || '/home/jam/build/redbox-tauri-win-release',
  ).trim();

  await buildOnRemote({
    targets,
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
