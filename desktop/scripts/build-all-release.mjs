import fs from 'node:fs/promises';
import path from 'node:path';

import {
  artifactsRoot,
  logStep,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log(
      'Usage: pnpm release:all [-- --skip-win] [-- --skip-mac] [-- --mac-notary-retries 3] [-- --mac-notary-retry-delay-ms 5000]',
    );
    return;
  }

  const skipWin = args['skip-win'] === true;
  const skipMac = args['skip-mac'] === true;
  const macNotaryRetries = String(args['mac-notary-retries'] || '').trim();
  const macNotaryRetryDelayMs = String(args['mac-notary-retry-delay-ms'] || '').trim();
  const windowsSummaryPath = path.join(artifactsRoot, 'release', 'windows-build-summary.json');
  const macSummaryPath = path.join(artifactsRoot, 'release', 'mac-build-summary.json');
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

    results.push(
      await runStep({
        name: 'macOS',
        command: 'node',
        args: macArgs,
        summaryPath: macSummaryPath,
      }),
    );
  }

  console.log('');
  console.log('Release summary');
  for (const result of results) {
    console.log(`- ${result.name}: ${formatStatus(result.ok)}`);
    if (result.summary?.installerPath) {
      console.log(`  installer: ${result.summary.installerPath}`);
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
