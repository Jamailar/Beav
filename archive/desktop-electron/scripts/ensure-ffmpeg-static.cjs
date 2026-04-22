#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function resolveFfmpegStaticPackageDir() {
  const packageJsonPath = require.resolve('ffmpeg-static/package.json', { paths: [process.cwd()] });
  return path.dirname(packageJsonPath);
}

function resolveBinaryPath() {
  try {
    // eslint-disable-next-line global-require
    const binaryPath = require('ffmpeg-static');
    return typeof binaryPath === 'string' ? binaryPath : '';
  } catch {
    return '';
  }
}

function ensureFfmpegBinary() {
  const existingBinary = resolveBinaryPath();
  if (existingBinary && fs.existsSync(existingBinary)) {
    console.log(`[ffmpeg-static] binary ready: ${existingBinary}`);
    return;
  }

  const pkgDir = resolveFfmpegStaticPackageDir();
  const installer = path.join(pkgDir, 'install.js');
  if (!fs.existsSync(installer)) {
    throw new Error(`[ffmpeg-static] installer not found: ${installer}`);
  }

  console.log('[ffmpeg-static] binary missing, running install.js ...');
  const result = spawnSync(process.execPath, [installer], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`[ffmpeg-static] install.js failed with code ${result.status}`);
  }

  const recheckedBinary = resolveBinaryPath();
  if (!recheckedBinary || !fs.existsSync(recheckedBinary)) {
    throw new Error('[ffmpeg-static] binary still missing after install.js');
  }
  console.log(`[ffmpeg-static] binary installed: ${recheckedBinary}`);
}

try {
  ensureFfmpegBinary();
} catch (error) {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
}
