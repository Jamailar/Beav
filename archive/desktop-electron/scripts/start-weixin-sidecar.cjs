#!/usr/bin/env node

const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function parseMajor(versionText) {
  const match = String(versionText || '').trim().match(/^v?(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function probeNode(command) {
  try {
    const result = spawnSync(command, ['-v'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) return null;
    const major = parseMajor(result.stdout || result.stderr || '');
    if (major < 22) return null;
    return { command, major };
  } catch {
    return null;
  }
}

const scriptPath = path.resolve(__dirname, 'weixin-claw-relay.mjs');
if (!fs.existsSync(scriptPath)) {
  console.error('[weixin-sidecar-bootstrap] missing relay script:', scriptPath);
  process.exit(1);
}

const candidates = [
  process.execPath,
  process.env.WEIXIN_CLAW_NODE,
  'node22',
  'node',
].filter(Boolean);

let selected = null;
for (const candidate of candidates) {
  const resolved = probeNode(candidate);
  if (resolved) {
    selected = resolved;
    break;
  }
}

if (!selected) {
  console.error('[weixin-sidecar-bootstrap] Node >=22 is required. Set WEIXIN_CLAW_NODE to a Node 22+ binary, or make node22 available in PATH.');
  process.exit(1);
}

const child = spawn(selected.command, [scriptPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  },
  stdio: 'inherit',
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
