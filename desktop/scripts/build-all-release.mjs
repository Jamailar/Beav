import fs from 'node:fs/promises';
import path from 'node:path';

import {
  artifactsRoot,
  browserPluginSummaryPath,
  logStep,
  packageBrowserPluginArchive,
  parseArgs,
  repoRoot,
  runCommand,
} from './release-utils.mjs';

function formatStatus(ok) {
  return ok ? 'completed' : 'failed';
}

async function readSummary(summaryPath) {
  try {
    const raw = await fs.readFile(summaryPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function runStep({ name, command, args, summaryPath }) {
  logStep(`Starting ${name} release`);
  try {
    await fs.rm(summaryPath, { force: true });
    await runCommand(command, args, { cwd: repoRoot });
    return {
      name,
      ok: true,
      summary: await readSummary(summaryPath),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      summary: await readSummary(summaryPath),
    };
  }
}

function collectInstallerLines(summary) {
  const lines = [];
  const artifacts = Array.isArray(summary?.artifacts) ? summary.artifacts : [];
  if (artifacts.length > 0) {
    for (const artifact of artifacts) {
      const target = artifact?.target ? ` (${artifact.target})` : '';
      for (const key of ['installerPath', 'debArtifactPath', 'zipPath']) {
        const value = String(artifact?.[key] || '').trim();
        if (value) {
          lines.push(`${key}${target}: ${value}`);
        }
      }
    }
    return lines;
  }

  for (const key of ['installerPath', 'debArtifactPath', 'zipPath']) {
    const value = String(summary?.[key] || '').trim();
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log(
      'Usage: pnpm release:all [-- --skip-win] [-- --skip-mac] [-- --skip-linux] [-- --mac-notary-retries 3] [-- --mac-notary-retry-delay-ms 5000] [-- --mac-targets aarch64-apple-darwin,x86_64-apple-darwin] [-- --windows-targets x86_64-pc-windows-msvc,aarch64-pc-windows-msvc,i686-pc-windows-msvc] [-- --linux-targets x86_64-unknown-linux-gnu]',
    );
    return;
  }

  const skipWin = args['skip-win'] === true;
  const skipMac = args['skip-mac'] === true;
  const skipLinux = args['skip-linux'] === true;
  const macNotaryRetries = String(args['mac-notary-retries'] || '').trim();
  const macNotaryRetryDelayMs = String(args['mac-notary-retry-delay-ms'] || '').trim();
  const macTargets = String(args['mac-targets'] || '').trim();
  const windowsTargets = String(args['windows-targets'] || '').trim();
  const linuxTargets = String(args['linux-targets'] || '').trim();
  const windowsSummaryPath = path.join(artifactsRoot, 'release', 'windows-build-summary.json');
  const macSummaryPath = path.join(artifactsRoot, 'release', 'mac-build-summary.json');
  const linuxSummaryPath = path.join(artifactsRoot, 'release', 'linux-build-summary.json');
  const results = [];

  if (!skipWin) {
    results.push(
      await runStep({
        name: 'Windows',
        command: 'node',
        args: [
          './scripts/build-windows-release.mjs',
          '--mode',
          'remote',
          '--host',
          'jamdebian',
          ...(windowsTargets ? ['--targets', windowsTargets] : []),
        ],
        summaryPath: windowsSummaryPath,
      }),
    );
  }

  if (!skipMac) {
    const macArgs = ['./scripts/build-mac-release.mjs'];
    if (macNotaryRetries) {
      macArgs.push('--notary-retries', macNotaryRetries);
    }
    if (macNotaryRetryDelayMs) {
      macArgs.push('--notary-retry-delay-ms', macNotaryRetryDelayMs);
    }
    if (macTargets) {
      macArgs.push('--targets', macTargets);
    }

    results.push(
      await runStep({
        name: 'macOS',
        command: 'node',
        args: macArgs,
        summaryPath: macSummaryPath,
      }),
    );
  }

  if (!skipLinux) {
    const linuxArgs = [
      './scripts/build-linux-release.mjs',
      '--mode',
      'remote',
      '--host',
      'jamdebian',
    ];
    if (linuxTargets) {
      linuxArgs.push('--targets', linuxTargets);
    }

    results.push(
      await runStep({
        name: 'Linux',
        command: 'node',
        args: linuxArgs,
        summaryPath: linuxSummaryPath,
      }),
    );
  }

  logStep('Packaging browser plugin release asset');
  try {
    await fs.rm(browserPluginSummaryPath, { force: true });
    results.push({
      name: 'Browser plugin',
      ok: true,
      summary: await packageBrowserPluginArchive(),
    });
  } catch (error) {
    results.push({
      name: 'Browser plugin',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      summary: await readSummary(browserPluginSummaryPath),
    });
  }

  console.log('');
  console.log('Release summary');
  for (const result of results) {
    console.log(`- ${result.name}: ${formatStatus(result.ok)}`);
    for (const line of collectInstallerLines(result.summary)) {
      console.log(`  ${line}`);
    }
    if (!result.ok && result.error) {
      console.log(`  error: ${result.error}`);
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
