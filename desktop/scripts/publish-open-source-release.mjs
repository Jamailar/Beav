import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  artifactsRoot,
  captureCommand,
  ensureCommandExists,
  logStep,
  parseArgs,
  readPackageJson,
  repoRoot,
  runCommand,
} from './release-utils.mjs';

const DEFAULT_REMOTE = 'export-sanitized';
const MAC_SUMMARY_PATH = path.join(artifactsRoot, 'release', 'mac-build-summary.json');
const WINDOWS_SUMMARY_PATH = path.join(artifactsRoot, 'release', 'windows-build-summary.json');

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeTag(versionOrTag) {
  const value = String(versionOrTag || '').trim();
  if (!value) {
    throw new Error('Release tag is required.');
  }
  return value.startsWith('v') ? value : `v${value}`;
}

function parseGitHubRepo(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value) {
    return null;
  }

  const sshMatch = value.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'github.com') {
      return null;
    }
    const pathname = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    if (!pathname || pathname.split('/').length !== 2) {
      return null;
    }
    return pathname;
  } catch {
    return null;
  }
}

async function resolveGitHubRepo(remoteName, explicitRepo) {
  const provided = String(explicitRepo || '').trim();
  if (provided) {
    return provided;
  }

  const remoteResult = await captureCommand('git', ['remote', 'get-url', remoteName], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (remoteResult.code !== 0) {
    return null;
  }

  const directRepo = parseGitHubRepo(remoteResult.stdout.trim());
  if (directRepo) {
    return directRepo;
  }

  const nestedPath = path.resolve(repoRoot, remoteResult.stdout.trim());
  if (!(await pathExists(nestedPath))) {
    return null;
  }

  const nestedOrigin = await captureCommand('git', ['-C', nestedPath, 'remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (nestedOrigin.code !== 0) {
    return null;
  }

  return parseGitHubRepo(nestedOrigin.stdout.trim());
}

async function assertTagDoesNotExistLocally(tag) {
  const result = await captureCommand('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.code === 0) {
    throw new Error(`Local tag already exists: ${tag}`);
  }
}

async function assertTagDoesNotExistOnRemote(remoteName, tag) {
  const result = await captureCommand('git', ['ls-remote', '--tags', remoteName, tag], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.code === 0 && result.stdout.trim()) {
    throw new Error(`Remote tag already exists on ${remoteName}: ${tag}`);
  }
}

async function latestReleaseTagExcluding(tag) {
  const result = await captureCommand(
    'git',
    ['tag', '--list', 'v*', '--sort=-version:refname'],
    { cwd: repoRoot },
  );
  return result.stdout
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && item !== tag) || null;
}

async function collectReleaseAssets() {
  const assets = [];
  const summaries = [];

  for (const summaryPath of [MAC_SUMMARY_PATH, WINDOWS_SUMMARY_PATH]) {
    if (!(await pathExists(summaryPath))) {
      continue;
    }
    const summary = await readJsonFile(summaryPath);
    summaries.push(summary);
    for (const key of [
      'installerPath',
      'portableExeArtifactPath',
      'portableZipArtifactPath',
    ]) {
      const filePath = String(summary?.[key] || '').trim();
      if (!filePath) {
        continue;
      }
      if (!(await pathExists(filePath))) {
        throw new Error(`Release asset declared in summary is missing: ${filePath}`);
      }
      if (!assets.includes(filePath)) {
        assets.push(filePath);
      }
    }
  }

  if (assets.length === 0) {
    throw new Error('No packaged installers were found. Run the build step first.');
  }

  return { assets, summaries };
}

async function buildReleaseNotes({ productName, tag, previousTag, assets }) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const logResult = await captureCommand(
    'git',
    ['log', '--no-merges', '--pretty=format:- %s (%h)', range],
    { cwd: repoRoot, allowFailure: true },
  );
  const commitLines = logResult.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const lines = [
    `# ${productName} ${tag}`,
    '',
    '## 更新日志',
  ];

  if (previousTag) {
    lines.push(`对比版本：\`${previousTag}\` -> \`${tag}\``);
    lines.push('');
  }

  if (commitLines.length > 0) {
    lines.push(...commitLines);
  } else {
    lines.push('- 本次发布没有检测到可归档的非 merge 提交。');
  }

  lines.push('');
  lines.push('## 安装包');
  for (const assetPath of assets) {
    lines.push(`- ${path.basename(assetPath)}`);
  }
  lines.push('');

  const notesPath = path.join(artifactsRoot, 'release', `${tag}-release-notes.md`);
  await fs.mkdir(path.dirname(notesPath), { recursive: true });
  await fs.writeFile(notesPath, `${lines.join('\n')}\n`, 'utf8');
  return notesPath;
}

function forwardBuildArgs(args) {
  const forwarded = [];
  for (const name of ['skip-win', 'skip-mac', 'mac-notary-retries', 'mac-notary-retry-delay-ms']) {
    const value = args[name];
    if (value === undefined || value === false) {
      continue;
    }
    forwarded.push(`--${name}`);
    if (value !== true) {
      forwarded.push(String(value));
    }
  }
  return forwarded;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log(
      'Usage: pnpm release:oss [-- --repo owner/name] [-- --remote export-sanitized] [-- --tag v1.9.3] [-- --title "RedBox v1.9.3"] [-- --draft] [-- --prerelease] [-- --skip-build] [-- --skip-win] [-- --skip-mac]',
    );
    return;
  }

  await ensureCommandExists('git');
  await ensureCommandExists('gh', 'GitHub CLI is required. Install from https://cli.github.com/');
  await ensureCommandExists('pnpm');

  const packageJson = await readPackageJson();
  const rawProductName = String(packageJson.productName || packageJson.name || 'RedBox').trim();
  const productName = rawProductName.toLowerCase() === 'redbox' ? 'RedBox' : rawProductName || 'RedBox';
  const tag = normalizeTag(args.tag || packageJson.version);
  const title = String(args.title || `${productName} ${tag}`).trim();
  const remoteName = String(args.remote || process.env.REDBOX_OPEN_SOURCE_REMOTE || DEFAULT_REMOTE).trim();
  const githubRepo = await resolveGitHubRepo(
    remoteName,
    args.repo || process.env.REDBOX_OPEN_SOURCE_GITHUB_REPO,
  );
  if (!githubRepo) {
    throw new Error(
      'Unable to resolve the GitHub repo for the open-source release. Pass --repo owner/name or set REDBOX_OPEN_SOURCE_GITHUB_REPO.',
    );
  }

  if (args['skip-build'] !== true) {
    const buildArgs = ['./scripts/build-all-release.mjs', ...forwardBuildArgs(args)];
    logStep(`Building installers via ${buildArgs.join(' ')}`);
    await runCommand('node', buildArgs, { cwd: repoRoot });
  }

  const { assets } = await collectReleaseAssets();
  const previousTag = await latestReleaseTagExcluding(tag);
  const notesPath = await buildReleaseNotes({
    productName,
    tag,
    previousTag,
    assets,
  });

  await assertTagDoesNotExistLocally(tag);
  await assertTagDoesNotExistOnRemote(remoteName, tag);

  logStep(`Creating local release tag ${tag}`);
  await runCommand('git', ['tag', '-a', tag, '-m', `${title}`], { cwd: repoRoot });

  let pushedTag = false;
  try {
    logStep(`Pushing tag ${tag} to ${remoteName}`);
    await runCommand('git', ['push', remoteName, tag], { cwd: repoRoot });
    pushedTag = true;

    const releaseArgs = [
      'release',
      'create',
      tag,
      '--repo',
      githubRepo,
      '--title',
      title,
      '--notes-file',
      notesPath,
      ...assets,
    ];
    if (args.draft === true) {
      releaseArgs.push('--draft');
    }
    if (args.prerelease === true) {
      releaseArgs.push('--prerelease');
    }

    logStep(`Creating GitHub release ${tag} in ${githubRepo}`);
    await runCommand('gh', releaseArgs, { cwd: repoRoot });
  } catch (error) {
    if (!pushedTag) {
      await runCommand('git', ['tag', '-d', tag], {
        cwd: repoRoot,
        allowFailure: true,
      });
    }
    throw error;
  }

  console.log('');
  console.log('Open-source release completed');
  console.log(`- tag: ${tag}`);
  console.log(`- remote: ${remoteName}`);
  console.log(`- github repo: ${githubRepo}`);
  console.log(`- notes: ${notesPath}`);
  for (const assetPath of assets) {
    console.log(`- asset: ${assetPath}`);
  }
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
