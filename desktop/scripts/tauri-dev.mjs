import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { runCommand } from './release-utils.mjs';

const cwd = process.cwd();
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const cargoTargetDir = path.join(cwd, 'src-tauri', 'target', 'tauri-dev');
const env = {
  ...process.env,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || cargoTargetDir,
};

await runCommand('node', ['./scripts/tauri-preflight.mjs'], { cwd, env });

const child = spawn(command, ['exec', 'tauri', 'dev', ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
  env,
  windowsHide: true,
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', forwardSignal);
process.on('SIGTERM', forwardSignal);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`[tauri-dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
