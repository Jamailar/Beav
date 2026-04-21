import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  assertBundledGuideResources,
  artifactsRoot,
  bundleRootForTarget,
  captureCommand,
  copyArtifactToDir,
  ensureCommandExists,
  envFlag,
  findNewestFile,
  installerArtifactsDir,
  logStep,
  parseArgs,
  readPackageJson,
  readTauriConfig,
  repoRoot,
  runCommand,
} from './release-utils.mjs';

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripQuotes(value) {
  return value.replace(/^"+|"+$/g, '');
}

async function detectSigningIdentities() {
  const { stdout } = await captureCommand('security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = stdout
    .split('\n')
    .map((line) => {
      const match = line.match(/"([^"]+)"/);
      return match ? match[1] : null;
    })
    .filter((value) => value && value.startsWith('Developer ID Application:'));
  return dedupe(identities);
}

function inferTeamId(identity) {
  const match = identity.match(/\(([A-Z0-9]{10})\)\s*$/);
  return match ? match[1] : null;
}

function resolveNotaryAuth({ args, inferredTeamId }) {
  const profile = stripQuotes(
    String(args['notary-profile'] || process.env.APPLE_NOTARY_PROFILE || '').trim(),
  );
  if (profile) {
    return {
      mode: 'profile',
      summary: `keychain profile "${profile}"`,
      cliArgs: ['--keychain-profile', profile],
    };
  }

  const issuer = String(process.env.APPLE_API_ISSUER || '').trim();
  const keyId = String(process.env.APPLE_API_KEY || '').trim();
  const keyPath = String(process.env.APPLE_API_KEY_PATH || '').trim();

  if (issuer && keyId && keyPath) {
    return {
      mode: 'api-key',
      summary: `App Store Connect API key ${keyId}`,
      cliArgs: ['--issuer', issuer, '--key-id', keyId, '--key', keyPath],
    };
  }

  const appleId = String(process.env.APPLE_ID || '').trim();
  const password = String(process.env.APPLE_PASSWORD || '').trim();
  const teamId = String(process.env.APPLE_TEAM_ID || inferredTeamId || '').trim();

  if (appleId && password && teamId) {
    return {
      mode: 'apple-id',
      summary: `Apple ID ${appleId}`,
      cliArgs: ['--apple-id', appleId, '--password', password, '--team-id', teamId],
    };
  }

  throw new Error(
    [
      'Missing notarization credentials.',
      'Provide one of the following before running the mac release script:',
      '1. APPLE_NOTARY_PROFILE=<keychain-profile> after running the setup helper.',
      '2. APPLE_API_ISSUER + APPLE_API_KEY + APPLE_API_KEY_PATH.',
      '3. APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID.',
    ].join('\n'),
  );
}

function buildSigningOnlyEnv(signingIdentity) {
  const env = {
    ...process.env,
    APPLE_SIGNING_IDENTITY: signingIdentity,
  };

  delete env.APPLE_API_ISSUER;
  delete env.APPLE_API_KEY;
  delete env.APPLE_API_KEY_PATH;
  delete env.APPLE_ID;
  delete env.APPLE_PASSWORD;
  delete env.APPLE_TEAM_ID;

  return env;
}

async function resolveArtifacts({ productName, version, target }) {
  const bundleRoot = bundleRootForTarget(target);
  const macosDir = path.join(bundleRoot, 'macos');
  const dmgDir = path.join(bundleRoot, 'dmg');

  const appPath = path.join(macosDir, `${productName}.app`);
  const dmgPath =
    (await findNewestFile(dmgDir, (filePath) => {
      const base = path.basename(filePath);
      return base.startsWith(`${productName}_${version}_`) && base.endsWith('.dmg');
    })) ??
    (await findNewestFile(bundleRoot, (filePath) => filePath.endsWith('.dmg')));

  if (!dmgPath) {
    throw new Error(`Unable to locate generated dmg in ${bundleRoot}`);
  }

  return { bundleRoot, appPath, dmgPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('Usage: pnpm release:mac [-- --target universal-apple-darwin] [-- --identity "Developer ID Application: ..."] [-- --notary-profile redbox-notary] [-- --skip-notarize]');
    return;
  }
  const packageJson = await readPackageJson();
  const tauriConfig = await readTauriConfig();
  assertBundledGuideResources(tauriConfig);
  const productName = String(packageJson.productName || 'RedBox');
  const version = String(packageJson.version);
  const target = String(args.target || process.env.REDBOX_MAC_TARGET || '').trim();
  const skipNotarize = args['skip-notarize'] === true || envFlag('REDBOX_SKIP_NOTARIZE', false);

  if (process.platform !== 'darwin') {
    throw new Error('The mac release script must run on macOS.');
  }

  await ensureCommandExists('pnpm');
  await ensureCommandExists('security');
  await ensureCommandExists('codesign');
  await ensureCommandExists('xcrun', 'Install Xcode command line tools first.');

  const identities = await detectSigningIdentities();
  const signingIdentity = stripQuotes(
    String(args.identity || process.env.APPLE_SIGNING_IDENTITY || identities[0] || '').trim(),
  );

  if (!signingIdentity) {
    throw new Error(
      'No Developer ID Application certificate found in the login keychain. Install the certificate first.',
    );
  }

  const inferredTeamId = inferTeamId(signingIdentity);

  logStep(`Using signing identity: ${signingIdentity}`);
  if (inferredTeamId) {
    logStep(`Resolved Apple team: ${inferredTeamId}`);
  }
  const notaryAuth = skipNotarize ? null : resolveNotaryAuth({ args, inferredTeamId });
  if (notaryAuth) {
    logStep(`Using notarization auth: ${notaryAuth.summary}`);
  }

  const buildEnv = buildSigningOnlyEnv(signingIdentity);

  const buildArgs = ['tauri', 'build', '--ci'];
  if (target) {
    buildArgs.push('--target', target);
  }

  logStep('Building signed macOS app and dmg');
  await runCommand('pnpm', buildArgs, { cwd: repoRoot, env: buildEnv });

  const { appPath, dmgPath } = await resolveArtifacts({ productName, version, target });
  const installerPath = await copyArtifactToDir(dmgPath, installerArtifactsDir('macos'));

  logStep(`Generated app: ${path.relative(repoRoot, appPath)}`);
  logStep(`Generated dmg: ${path.relative(repoRoot, dmgPath)}`);
  logStep(`Copied macOS installer: ${path.relative(repoRoot, installerPath)}`);

  logStep('Verifying code signature');
  await runCommand('codesign', ['--verify', '--deep', '--verbose=2', appPath], { cwd: repoRoot });
  const signatureDetails = await captureCommand('codesign', ['-dv', '--verbose=4', appPath], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (signatureDetails.stderr.includes('Signature=adhoc')) {
    throw new Error('macOS bundle is still ad-hoc signed. A Developer ID signature is required.');
  }

  if (!skipNotarize) {
    logStep('Submitting dmg for notarization');
    await runCommand(
      'xcrun',
      ['notarytool', 'submit', dmgPath, '--wait', '--output-format', 'json', ...notaryAuth.cliArgs],
      { cwd: repoRoot },
    );

    logStep('Stapling notarization ticket to dmg');
    await runCommand('xcrun', ['stapler', 'staple', dmgPath], { cwd: repoRoot });

    logStep('Validating stapled dmg');
    await runCommand('xcrun', ['stapler', 'validate', dmgPath], { cwd: repoRoot });

    logStep('Running Gatekeeper assessment for dmg');
    await runCommand('spctl', ['--assess', '-vv', dmgPath], {
      cwd: repoRoot,
      allowFailure: true,
    });
  }

  const summary = {
    productName,
    version,
    signingIdentity,
    teamId: inferredTeamId,
    notarized: !skipNotarize,
    appPath,
    dmgPath,
    installerPath,
  };

  const summaryPath = path.join(artifactsRoot, 'release', 'mac-build-summary.json');
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('');
  console.log('macOS release completed');
  console.log(`- app: ${appPath}`);
  console.log(`- dmg: ${dmgPath}`);
  console.log(`- installer copy: ${installerPath}`);
  console.log(`- summary: ${summaryPath}`);
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
