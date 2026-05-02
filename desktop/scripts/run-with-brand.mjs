import { spawn } from 'node:child_process';
import process from 'node:process';

const [, , variant, command, ...args] = process.argv;

if (!variant || !command) {
  console.error('[run-with-brand] Usage: node ./scripts/run-with-brand.mjs <variant> <command> [...args]');
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    REDBOX_BRAND: variant,
  },
});

child.on('error', (error) => {
  console.error(`[run-with-brand] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
