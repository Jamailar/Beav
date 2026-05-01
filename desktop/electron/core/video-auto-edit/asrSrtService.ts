import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSettings } from '../../db';
import { normalizeApiBaseUrl, safeUrlJoin } from '../urlUtils';

function extensionFromPath(filePath: string): string {
  return path.extname(filePath || '').toLowerCase();
}

function guessAudioMimeTypeByExtension(filePath: string): string {
  const ext = extensionFromPath(filePath);
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.opus') return 'audio/opus';
  return 'audio/mpeg';
}

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

async function extractAudioForAsr(inputPath: string, outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const ffmpegCommand = resolveFfmpegCommand();
  const args = [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-codec:a', 'libmp3lame',
    '-b:a', '96k',
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegCommand, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr || '(no stderr)'}`));
    });
  });
}

function looksLikeSrt(value: string): boolean {
  return /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(value);
}

export async function transcribeMediaToSrt(input: {
  mediaPath: string;
  workDir: string;
  language?: string;
}): Promise<{ srt: string; rawText: string }> {
  const settings = getSettings() as {
    api_endpoint?: string;
    api_key?: string;
    transcription_model?: string;
    transcription_endpoint?: string;
    transcription_key?: string;
  } | undefined;
  const endpoint = normalizeApiBaseUrl(String(settings?.transcription_endpoint || settings?.api_endpoint || '').trim());
  const apiKey = String(settings?.transcription_key || settings?.api_key || '').trim();
  if (!endpoint || !apiKey) {
    throw new Error('未配置转录 API（transcription_endpoint/transcription_key）');
  }

  const model = String(settings?.transcription_model || 'whisper-1').trim() || 'whisper-1';
  const mediaPath = path.resolve(path.normalize(input.mediaPath));
  const ext = extensionFromPath(mediaPath);
  const audioExtensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
  const uploadPath = audioExtensions.has(ext)
    ? mediaPath
    : path.join(input.workDir, `asr_${Date.now()}.mp3`);

  if (uploadPath !== mediaPath) {
    await extractAudioForAsr(mediaPath, uploadPath);
  }

  try {
    const audioBuffer = await fs.readFile(uploadPath);
    const endpointUrl = safeUrlJoin(endpoint, '/audio/transcriptions');
    const form = new FormData();
    form.set('model', model);
    form.set('response_format', 'srt');
    if (input.language) {
      form.set('language', input.language);
    }
    form.set(
      'file',
      new Blob([new Uint8Array(audioBuffer)], { type: guessAudioMimeTypeByExtension(uploadPath) }),
      path.basename(uploadPath) || 'audio.mp3',
    );

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 180000);
    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: abortController.signal,
      });
      const rawText = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(`转录请求失败：HTTP ${response.status} ${response.statusText} | ${rawText || '(empty)'}`);
      }

      const parsedText = (() => {
        try {
          const parsed = JSON.parse(rawText) as Record<string, unknown>;
          return String(parsed.srt || parsed.text || (parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>).srt || (parsed.data as Record<string, unknown>).text : '') || '').trim();
        } catch {
          return rawText.trim();
        }
      })();

      if (!looksLikeSrt(parsedText)) {
        throw new Error('ASR 未返回 SRT 格式内容。请确认转录模型支持 response_format=srt，或先使用“导入 SRT”。');
      }
      return { srt: parsedText, rawText };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (uploadPath !== mediaPath) {
      await fs.rm(uploadPath, { force: true }).catch(() => undefined);
    }
  }
}
