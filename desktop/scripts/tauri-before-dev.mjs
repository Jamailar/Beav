import { execFile as execFileCallback, spawn } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import { syncVersion } from './sync-version.mjs';

const execFile = promisify(execFileCallback);

const PORT = Number(process.env.LEXBOX_DEV_PORT || 1420);
const DEV_URL = process.env.LEXBOX_DEV_URL || `http://localhost:${PORT}`;
const cwd = process.cwd();
const isProbe = process.argv.includes('--probe');

async function isHealthy(url) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function getListeningPids(port) {
  try {
    const { stdout } = await execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

async function getCommandForPid(pid) {
  try {
    const { stdout } = await execFile('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.trim();
  } catch {
    return '';
  }
}

function isRepoViteCommand(command) {
  return command.includes(`${cwd}/node_modules`) && command.includes('vite');
}

async function getPortState() {
  const pids = await getListeningPids(PORT);
  const processes = await Promise.all(
    pids.map(async (pid) => ({
      pid,
      command: await getCommandForPid(pid),
    })),
  );

  return {
    healthy: await isHealthy(DEV_URL),
    processes,
  };
}

async function terminateProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 120));
    } catch {
      return;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // noop
  }
}

async function holdForReusedServer() {
  console.log(`[tauri-before-dev] Reusing healthy Vite server on ${DEV_URL}`);

  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
}

async function startDevServer() {
  console.log(`[tauri-before-dev] Starting Vite on ${DEV_URL}`);

  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, ['dev'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve();
        return;
      }
      if ((code ?? 0) === 0) {
        resolve();
        return;
      }
      reject(new Error(`pnpm dev exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function main() {
  await syncVersion({ cwd });

  const state = await getPortState();

  if (isProbe) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (state.healthy) {
    const foreignProcess = state.processes.find((entry) => !isRepoViteCommand(entry.command));
    if (foreignProcess) {
      throw new Error(`Port ${PORT} is in use by another process: PID ${foreignProcess.pid} (${foreignProcess.command})`);
    }
    await holdForReusedServer();
    return;
  }

  const staleRepoVite = state.processes.find((entry) => isRepoViteCommand(entry.command));
  if (staleRepoVite) {
    console.log(`[tauri-before-dev] Cleaning stale Vite process ${staleRepoVite.pid}`);
    await terminateProcess(staleRepoVite.pid);
  } else if (state.processes.length > 0) {
    const foreign = state.processes[0];
    throw new Error(`Port ${PORT} is in use by another process: PID ${foreign.pid} (${foreign.command})`);
  }

  await startDevServer();
}

main().catch((error) => {
  console.error(`[tauri-before-dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
