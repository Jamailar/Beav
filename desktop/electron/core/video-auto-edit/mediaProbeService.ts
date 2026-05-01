import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { MediaProbeRecord, VideoEditorV2AssetKind } from '../../../shared/videoAutoEdit';

type MediaProbeCacheRecord = {
  hash: string;
  probedAt: string;
  probe: MediaProbeRecord;
  thumbnailPath?: string | null;
  proxyPath?: string | null;
};

type ProbeMediaAssetResult = {
  probe: MediaProbeRecord;
  thumbnailPath?: string | null;
  proxyPath?: string | null;
};

function resolveFfmpegCommand(): string {
  try {
    const ffmpegStaticPath = require('ffmpeg-static') as string | null;
    if (ffmpegStaticPath) {
      return ffmpegStaticPath.includes('app.asar')
        ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked')
        : ffmpegStaticPath;
    }
  } catch {
    // Fall through to environment fallback.
  }
  if (process.env.REDBOX_ALLOW_SYSTEM_FFMPEG === '1') return 'ffmpeg';
  throw new Error('Bundled ffmpeg not found. Please reinstall app/package to restore internal ffmpeg binary.');
}

async function pathExists(filePath?: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readCache(cachePath: string): Promise<Record<string, MediaProbeCacheRecord>> {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, MediaProbeCacheRecord> : {};
  } catch {
    return {};
  }
}

async function writeCache(cachePath: string, cache: Record<string, MediaProbeCacheRecord>): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(cache, null, 2), 'utf-8');
  await fs.rename(tempPath, cachePath);
}

async function runFfmpeg(args: string[], options?: { allowNonZero?: boolean; timeoutMs?: number }): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const ffmpegCommand = resolveFfmpegCommand();
  const timeoutMs = Math.max(1000, Number(options?.timeoutMs || 30000) || 30000);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
      if (stdout.length > 12000) stdout = stdout.slice(-12000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 24000) stderr = stderr.slice(-24000);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 || options?.allowNonZero) {
        resolve({ code, stdout, stderr });
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr || '(no stderr)'}`));
    });
  });
}

function parseDurationMs(output: string): number | undefined {
  const match = output.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return undefined;
  const hours = Number(match[1]) || 0;
  const minutes = Number(match[2]) || 0;
  const seconds = Number(match[3]) || 0;
  const totalMs = Math.round(((hours * 3600) + (minutes * 60) + seconds) * 1000);
  return totalMs > 0 ? totalMs : undefined;
}

function parseFpsValue(value: string): number | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (normalized.includes('/')) {
    const [numerator, denominator] = normalized.split('/').map((part) => Number(part));
    if (numerator > 0 && denominator > 0) return Math.round((numerator / denominator) * 1000) / 1000;
    return undefined;
  }
  const number = Number(normalized);
  return number > 0 ? Math.round(number * 1000) / 1000 : undefined;
}

function parseProbeOutput(output: string): MediaProbeRecord {
  const videoLine = output.split(/\r?\n/).find((line) => /Stream #.+Video:/.test(line)) || '';
  const dimensionMatch = videoLine.match(/,\s*(\d{2,5})x(\d{2,5})(?:\s|,|\[)/);
  const fpsMatch = videoLine.match(/,\s*([\d.]+|\d+\/\d+)\s*fps(?:,|\s)/)
    || videoLine.match(/,\s*([\d.]+|\d+\/\d+)\s*tbr(?:,|\s)/);
  const rotateMatch = output.match(/rotate\s*:\s*(-?\d+(?:\.\d+)?)/)
    || output.match(/rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i);

  return {
    durationMs: parseDurationMs(output),
    width: dimensionMatch ? Number(dimensionMatch[1]) : undefined,
    height: dimensionMatch ? Number(dimensionMatch[2]) : undefined,
    fps: fpsMatch ? parseFpsValue(fpsMatch[1]) : undefined,
    hasAudio: /Stream #.+Audio:/.test(output),
    rotation: rotateMatch ? Math.round(Number(rotateMatch[1]) || 0) : undefined,
  };
}

async function probeMediaMetadata(mediaPath: string): Promise<MediaProbeRecord> {
  const result = await runFfmpeg(['-hide_banner', '-i', mediaPath], {
    allowNonZero: true,
    timeoutMs: 15000,
  });
  return parseProbeOutput(`${result.stdout}\n${result.stderr}`);
}

async function generateThumbnail(input: {
  mediaPath: string;
  assetKind: VideoEditorV2AssetKind;
  outputPath: string;
  durationMs?: number;
}): Promise<string | null> {
  if (input.assetKind === 'audio') return null;
  if (await pathExists(input.outputPath)) return input.outputPath;
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  const seekSeconds = input.assetKind === 'video' && input.durationMs && input.durationMs > 2000
    ? Math.min(5, Math.max(1, Math.round((input.durationMs / 1000) * 0.1)))
    : 0;
  const args = [
    '-y',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i', input.mediaPath,
    '-frames:v', '1',
    '-vf', 'scale=min(480\\,iw):-2',
    '-q:v', '4',
    input.outputPath,
  ];
  await runFfmpeg(args, { timeoutMs: 20000 });
  return await pathExists(input.outputPath) ? input.outputPath : null;
}

function shouldGenerateProxy(probe: MediaProbeRecord): boolean {
  const thresholdMs = Math.max(10000, Number(process.env.REDBOX_VIDEO_PROXY_THRESHOLD_MS || 120000) || 120000);
  const durationMs = Number(probe.durationMs || 0);
  const width = Number(probe.width || 0);
  const height = Number(probe.height || 0);
  return durationMs >= thresholdMs || width > 1280 || height > 720;
}

async function generateProxy(input: {
  mediaPath: string;
  outputPath: string;
  probe: MediaProbeRecord;
}): Promise<string | null> {
  if (!shouldGenerateProxy(input.probe)) return null;
  if (await pathExists(input.outputPath)) return input.outputPath;
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-i', input.mediaPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'scale=min(1280\\,iw):-2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    input.outputPath,
  ], {
    timeoutMs: 10 * 60 * 1000,
  });
  return await pathExists(input.outputPath) ? input.outputPath : null;
}

export async function generateSilentAudioSegment(input: {
  outputPath: string;
  durationMs: number;
}): Promise<string> {
  const durationSeconds = Math.max(0.1, Math.round(Math.max(1, input.durationMs) / 100) / 10);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(durationSeconds),
    '-c:a', 'aac',
    '-b:a', '96k',
    input.outputPath,
  ], {
    timeoutMs: 30000,
  });
  return input.outputPath;
}

export async function probeMediaAsset(input: {
  mediaPath: string;
  assetKind: VideoEditorV2AssetKind;
  assetHash: string;
  cachePath: string;
  thumbnailPath: string;
  proxyPath: string;
}): Promise<ProbeMediaAssetResult> {
  const mediaPath = path.resolve(path.normalize(input.mediaPath));
  const cache = await readCache(input.cachePath);
  const cached = cache[input.assetHash];
  const cachedThumbnailReady = cached ? (!cached.thumbnailPath || await pathExists(cached.thumbnailPath)) : false;
  const cachedProxyReady = cached ? (!cached.proxyPath || await pathExists(cached.proxyPath)) : false;
  if (cached && cachedThumbnailReady && cachedProxyReady) {
    return {
      probe: cached.probe || {},
      thumbnailPath: cached.thumbnailPath || null,
      proxyPath: cached.proxyPath || null,
    };
  }

  const probe = await probeMediaMetadata(mediaPath);
  const thumbnailPath = await generateThumbnail({
    mediaPath,
    assetKind: input.assetKind,
    outputPath: input.thumbnailPath,
    durationMs: probe.durationMs,
  }).catch(() => null);
  const proxyPath = input.assetKind === 'video'
    ? await generateProxy({
      mediaPath,
      outputPath: input.proxyPath,
      probe,
    }).catch(() => null)
    : null;

  cache[input.assetHash] = {
    hash: input.assetHash,
    probedAt: new Date().toISOString(),
    probe,
    thumbnailPath,
    proxyPath,
  };
  await writeCache(input.cachePath, cache);

  return {
    probe,
    thumbnailPath,
    proxyPath,
  };
}
