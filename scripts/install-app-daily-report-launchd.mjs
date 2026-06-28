#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const LABEL = 'com.redconvert.app-daily-report';

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseArgs(argv) {
  const options = {
    hour: 21,
    minute: 0,
    envFile: path.join(repoRoot, '.env'),
    outputDir: path.join(repoRoot, 'artifacts', 'app-daily-reports'),
    load: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--no-load') {
      options.load = false;
      continue;
    }
    if (['--hour', '--minute', '--env-file', '--output-dir'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === '--hour') options.hour = Number(value);
      if (arg === '--minute') options.minute = Number(value);
      if (arg === '--env-file') options.envFile = path.resolve(value);
      if (arg === '--output-dir') options.outputDir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) {
    throw new Error('--hour must be an integer from 0 to 23');
  }
  if (!Number.isInteger(options.minute) || options.minute < 0 || options.minute > 59) {
    throw new Error('--minute must be an integer from 0 to 59');
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/install-app-daily-report-launchd.mjs [options]

Options:
  --hour <0-23>          Local launch hour, default: 21
  --minute <0-59>        Local launch minute, default: 0
  --env-file <path>      Env file read by the report script, default: ./.env
  --output-dir <path>    Report output directory, default: ./artifacts/app-daily-reports
  --no-load              Write the plist but do not load it immediately
  --help                 Show this help
`);
}

function buildPlist(options, logDir) {
  const nodePath = process.execPath;
  const scriptPath = path.join(repoRoot, 'scripts', 'app-daily-report.mjs');
  const stdoutPath = path.join(logDir, 'app-daily-report.out.log');
  const stderrPath = path.join(logDir, 'app-daily-report.err.log');
  const pathEnv = [
    path.dirname(nodePath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>--env-file</string>
    <string>${xmlEscape(options.envFile)}</string>
    <string>--output-dir</string>
    <string>${xmlEscape(options.outputDir)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${options.hour}</integer>
    <key>Minute</key>
    <integer>${options.minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
    <key>APP_DAILY_REPORT_TIMEZONE</key>
    <string>Asia/Shanghai</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const launchAgentsDir = path.join(homedir(), 'Library', 'LaunchAgents');
  const logDir = path.join(homedir(), 'Library', 'Logs', 'RedConvert');
  const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`);

  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(plistPath, buildPlist(options, logDir), 'utf8');

  console.log(`Wrote ${plistPath}`);
  console.log(`Daily schedule: ${String(options.hour).padStart(2, '0')}:${String(options.minute).padStart(2, '0')} local time`);
  console.log(`Report output: ${options.outputDir}`);
  console.log(`Logs: ${logDir}`);

  if (!options.load) {
    return;
  }

  const uid = process.getuid?.();
  const target = Number.isInteger(uid) ? `gui/${uid}` : null;
  if (!target) {
    console.log('Skipped launchctl load: cannot resolve current user id.');
    return;
  }

  runLaunchctl(['bootout', target, plistPath]);
  const result = runLaunchctl(['bootstrap', target, plistPath]);
  if (!result.ok) {
    throw new Error(`launchctl bootstrap failed: ${result.stderr || result.stdout || `status ${result.status}`}`);
  }

  const enabled = runLaunchctl(['enable', `${target}/${LABEL}`]);
  if (!enabled.ok) {
    console.log(`launchctl enable warning: ${enabled.stderr || enabled.stdout}`);
  }

  console.log(`Loaded LaunchAgent ${LABEL}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
