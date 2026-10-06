import process from 'node:process';

import { ensureCommandExists, logStep, parseArgs, runCommand } from './release-utils.mjs';

function inferTeamIdFromAppleIdentity(identity) {
  if (!identity) {
    return null;
  }
  const match = String(identity).match(/\(([A-Z0-9]{10})\)\s*$/);
  return match ? match[1] : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('Usage: pnpm release:mac:setup-notary -- --profile redbox-notary --apple-id you@example.com --team-id N9KF8X5S99 [--password <app-specific-password>]');
    return;
  }
  const profile = String(args.profile || process.env.APPLE_NOTARY_PROFILE || 'redbox-notary').trim();
  const appleId = String(args['apple-id'] || process.env.APPLE_ID || '').trim();
  const teamId = String(
    args['team-id'] ||
      process.env.APPLE_TEAM_ID ||
      inferTeamIdFromAppleIdentity(process.env.APPLE_SIGNING_IDENTITY),
  ).trim();
  const password = String(args.password || process.env.APPLE_PASSWORD || '').trim();

  if (process.platform !== 'darwin') {
    throw new Error('The Apple notary profile helper must run on macOS.');
  }

  await ensureCommandExists('xcrun', 'Install Xcode command line tools first.');

  if (!appleId) {
    throw new Error('Missing Apple ID. Pass --apple-id or set APPLE_ID.');
  }

  if (!teamId) {
    throw new Error('Missing Apple team id. Pass --team-id or set APPLE_TEAM_ID.');
  }

  const commandArgs = [
    'notarytool',
    'store-credentials',
    profile,
    '--apple-id',
    appleId,
    '--team-id',
    teamId,
  ];

  if (password) {
    commandArgs.push('--password', password);
  }

  logStep(`Saving notarytool profile "${profile}" for team ${teamId}`);
  await runCommand('xcrun', commandArgs);

  console.log('');
  console.log('Apple notarization profile saved');
  console.log(`- profile: ${profile}`);
  console.log('Use APPLE_NOTARY_PROFILE=<profile> with pnpm release:mac');
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
