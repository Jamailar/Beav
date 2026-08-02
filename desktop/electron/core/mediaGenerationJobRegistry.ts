import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { getSettings, getWorkspacePaths } from '../db';
import { createGeneratedMediaAsset, getAbsoluteMediaPath, type MediaAsset } from './mediaLibraryStore';
import { isPathWithinRoots, resolveAssetSourceToPath, toAppAssetUrl } from './localAssetManager';
import { generateImagesToMediaLibrary } from './imageGenerationService';
import { generateVideosToMediaLibrary } from './videoGenerationService';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';

type MediaJobStatus =
  | 'accepted'
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'polling'
  | 'downloading'
  | 'persisting'
  | 'binding'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'dead_lettered';

type MediaJobArtifact = {
  artifactId: string;
  kind: string;
  relativePath?: string | null;
  absolutePath?: string | null;
  mimeType?: string | null;
  previewUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

type MediaJobEvent = {
  eventType: string;
  message: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
};

type MediaJobAttempt = {
  attemptId: string;
  attemptNo: number;
  status: string;
  providerTaskId?: string | null;
  providerStatusUrl?: string | null;
  idempotencyKey?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  nextPollAt?: number | null;
  retryNotBeforeAt?: number | null;
  lastError?: string | null;
  response?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaJobProjection = {
  jobId: string;
  kind: string;
  source: string;
  queueMode: 'free_creation' | 'ai_generation';
  priority: string;
  status: MediaJobStatus | string;
  providerKey: string;
  providerModel?: string | null;
  request?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  projectId?: string | null;
  manuscriptPath?: string | null;
  videoProjectPath?: string | null;
  ownerSessionId?: string | null;
  cancelReason?: string | null;
  archivedAt?: string | null;
  archiveReason?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  attempt?: MediaJobAttempt | null;
  artifacts: MediaJobArtifact[];
  recentEvents: MediaJobEvent[];
};

type StoredMediaJob = MediaJobProjection;

type MediaJobState = {
  version: 1;
  jobs: StoredMediaJob[];
};

type SubmitResult = {
  success: boolean;
  jobId: string;
  status: string;
  kind: string;
  source: string;
  queueMode: string;
  priority: string;
  providerKey: string;
  providerModel?: string | null;
  acceptedAt: string;
};

const STATE_VERSION = 1;
const MAX_JOBS = 2_000;
const MAX_EVENTS_PER_JOB = 32;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dead_lettered']);
const SECRET_KEYS = new Set([
  'apiKey',
  'api_key',
  'voiceApiKey',
  'voice_api_key',
  'ttsApiKey',
  'tts_api_key',
  'accessToken',
  'access_token',
]);

const DEFAULT_VOICES = [
  { id: 'alloy', name: 'Alloy', label: 'Alloy' },
  { id: 'echo', name: 'Echo', label: 'Echo' },
  { id: 'fable', name: 'Fable', label: 'Fable' },
  { id: 'onyx', name: 'Onyx', label: 'Onyx' },
  { id: 'nova', name: 'Nova', label: 'Nova' },
  { id: 'shimmer', name: 'Shimmer', label: 'Shimmer' },
];

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}

function numberValue(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function redactRequest(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = raw;
  }
  return result;
}

function cleanExecutionRequest(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  for (const key of SECRET_KEYS) {
    if (result[key] === '[redacted]') delete result[key];
  }
  return result;
}

function queueMode(value: unknown): 'free_creation' | 'ai_generation' {
  return value === 'ai_generation' ? 'ai_generation' : 'free_creation';
}

function providerKeyFor(kind: string, request: Record<string, unknown>): string {
  const explicit = optionalText(request.providerKey) || optionalText(request.provider);
  if (explicit) return explicit;
  if (kind === 'video' || kind === 'video_sequence') return 'redbox-official';
  if (kind === 'audio' || kind === 'audio_sequence' || kind === 'voice_clone') return 'voice-gateway';
  return optionalText(request.providerTemplate) || 'openai-compatible';
}

function providerModelFor(request: Record<string, unknown>): string | null {
  return optionalText(request.model)
    || optionalText(request.targetTtsModel)
    || optionalText(request.target_tts_model)
    || null;
}

function extensionForFormat(format: string): { extension: string; mimeType: string } {
  const normalized = format.toLowerCase().replace(/^[.]/, '');
  if (normalized === 'wav') return { extension: 'wav', mimeType: 'audio/wav' };
  if (normalized === 'ogg' || normalized === 'opus') return { extension: 'ogg', mimeType: 'audio/ogg' };
  if (normalized === 'aac') return { extension: 'aac', mimeType: 'audio/aac' };
  if (normalized === 'flac') return { extension: 'flac', mimeType: 'audio/flac' };
  if (normalized === 'm4a' || normalized === 'mp4') return { extension: 'm4a', mimeType: 'audio/mp4' };
  return { extension: 'mp3', mimeType: 'audio/mpeg' };
}

function audioEndpoint(value: unknown): string {
  const normalized = normalizeApiBaseUrl(text(value));
  if (!normalized) return '';
  return safeUrlJoin(normalized, '/audio/speech');
}

function voicesEndpoint(value: unknown): string {
  const normalized = normalizeApiBaseUrl(text(value));
  if (!normalized) return '';
  return safeUrlJoin(normalized, '/audio/voices');
}

function readSettings(): Record<string, unknown> {
  return (getSettings() || {}) as Record<string, unknown>;
}

function endpointFromRequest(request: Record<string, unknown>, settings: Record<string, unknown>): string {
  return text(request.endpoint)
    || text(request.baseURL)
    || text(settings.voice_endpoint)
    || text(settings.tts_endpoint)
    || text(settings.api_endpoint);
}

function apiKeyFromRequest(request: Record<string, unknown>, settings: Record<string, unknown>): string {
  return text(request.apiKey)
    || text(request.voiceApiKey)
    || text(request.ttsApiKey)
    || text(settings.voice_api_key)
    || text(settings.tts_api_key)
    || text(settings.api_key);
}

function parseVoiceItems(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const candidates = [record.voices, record.items, record.data, record.results];
  const values = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!values) return [];
  return values
    .map((item): Record<string, unknown> | null => {
      if (typeof item === 'string') return { id: item, name: item, label: item };
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const voiceId = text(raw.id) || text(raw.voiceId) || text(raw.voice_id) || text(raw.value);
      if (!voiceId) return null;
      return {
        ...raw,
        id: voiceId,
        name: text(raw.name) || text(raw.label) || voiceId,
        label: text(raw.label) || text(raw.name) || voiceId,
      };
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

async function parseAudioResponse(response: Response, requestedFormat: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const contentType = text(response.headers.get('content-type')).split(';')[0].toLowerCase();
  const rawBytes = Buffer.from(await response.arrayBuffer());
  if (!contentType.includes('json')) {
    return { bytes: rawBytes, mimeType: contentType || extensionForFormat(requestedFormat).mimeType };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBytes.toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new Error('语音服务返回了无法解析的 JSON');
  }
  const candidate = [
    parsed.audio,
    parsed.audio_base64,
    parsed.audioBase64,
    parsed.base64,
    parsed.data,
    parsed.url,
    parsed.audio_url,
    parsed.audioUrl,
  ].find((item) => typeof item === 'string' && item.trim());
  if (typeof candidate !== 'string') throw new Error('语音服务没有返回音频数据');
  if (/^https?:\/\//i.test(candidate)) {
    const audioResponse = await fetch(candidate);
    if (!audioResponse.ok) throw new Error(`下载语音结果失败 (${audioResponse.status})`);
    return {
      bytes: Buffer.from(await audioResponse.arrayBuffer()),
      mimeType: text(audioResponse.headers.get('content-type')) || extensionForFormat(requestedFormat).mimeType,
    };
  }
  const dataUrl = candidate.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrl) return { bytes: Buffer.from(dataUrl[2], 'base64'), mimeType: dataUrl[1] };
  return { bytes: Buffer.from(candidate, 'base64'), mimeType: extensionForFormat(requestedFormat).mimeType };
}

async function synthesizeSpeechAsset(request: Record<string, unknown>): Promise<{
  asset: MediaAsset;
  voiceId: string;
  model: string;
}> {
  const settings = readSettings();
  const input = text(request.input) || text(request.text);
  if (!input) throw new Error('voice.speech requires input');
  const voiceId = text(request.voiceId) || text(request.voice_id) || text(request.voice) || 'alloy';
  const model = text(request.model)
    || text(request.targetTtsModel)
    || text(request.target_tts_model)
    || text(settings.voice_tts_model)
    || text(settings.tts_model)
    || 'gpt-4o-mini-tts';
  const responseFormat = text(request.responseFormat) || text(request.response_format) || text(request.format) || 'mp3';
  const endpoint = audioEndpoint(endpointFromRequest(request, settings));
  const apiKey = apiKeyFromRequest(request, settings);
  if (!endpoint) throw new Error('语音 Endpoint 未配置。请先配置语音服务。');
  if (!apiKey) throw new Error('语音 API Key 未配置。请先配置语音服务。');
  const body: Record<string, unknown> = {
    model,
    input,
    voice: voiceId,
    response_format: responseFormat,
  };
  const speed = Number(request.speed);
  if (Number.isFinite(speed)) body.speed = speed;
  if (text(request.languageBoost)) body.language_boost = text(request.languageBoost);
  if (text(request.emotion)) body.emotion = text(request.emotion);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 800);
    throw new Error(`语音生成失败 (${response.status}): ${errorBody}`);
  }
  const audio = await parseAudioResponse(response, responseFormat);
  const asset = await createGeneratedMediaAsset({
    prompt: input,
    dataBuffer: audio.bytes,
    mimeType: audio.mimeType,
    projectId: optionalText(request.projectId),
    provider: 'voice',
    providerTemplate: 'tts',
    model,
    title: optionalText(request.title) || input.slice(0, 24),
  });
  return { asset, voiceId, model };
}

async function uploadRemoteTempFile(filePath: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const settings = readSettings();
  const endpoint = normalizeApiBaseUrl(endpointFromRequest(payload, settings));
  const apiKey = apiKeyFromRequest(payload, settings);
  if (!endpoint || !apiKey || !/api\.ziz\.hk|redbox/i.test(endpoint)) return null;
  const bytes = await fs.readFile(filePath);
  const contentType = text(payload.contentType) || 'application/octet-stream';
  const keyPrefix = text(payload.keyPrefix) || 'ai/digital-human';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), path.basename(filePath));
  form.append('key_prefix', keyPrefix);
  form.append('content_type', contentType);
  const response = await fetch(safeUrlJoin(endpoint, '/upload/file-buffer'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`媒体上传失败 (${response.status})`);
  const parsed = await response.json() as Record<string, unknown>;
  const fileUrl = text(parsed.file_url) || text(parsed.fileUrl) || text(parsed.url)
    || (parsed.data && typeof parsed.data === 'object' ? text((parsed.data as Record<string, unknown>).file_url) || text((parsed.data as Record<string, unknown>).url) : '');
  if (!fileUrl) throw new Error('媒体上传响应缺少 fileUrl');
  return { success: true, fileUrl, url: fileUrl, contentType, keyPrefix, upload: parsed };
}

export async function stageGenerationTempFile(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rawPath = text(payload.path) || text(payload.filePath) || text(payload.sourcePath);
  if (!rawPath) return { success: false, error: 'generation:upload-temp-file requires path' };
  let sourcePath: string;
  try {
    sourcePath = resolveAssetSourceToPath(rawPath);
  } catch {
    sourcePath = path.resolve(rawPath.replace(/^file:\/\//i, ''));
  }
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) return { success: false, error: `file does not exist: ${sourcePath}` };
  if (stat.size === 0) return { success: false, error: 'upload file is empty' };
  if (stat.size > MAX_UPLOAD_BYTES) return { success: false, error: 'upload file is too large' };
  const remote = await uploadRemoteTempFile(sourcePath, payload).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (remote?.success) return remote;
  const targetDir = path.join(getWorkspacePaths().base, '.redbox', 'media-runtime', 'uploads');
  await fs.mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${Date.now()}-${path.basename(sourcePath).replace(/[^a-zA-Z0-9._-]+/g, '_')}`);
  await fs.copyFile(sourcePath, targetPath);
  const fileUrl = toAppAssetUrl(targetPath);
  return {
    success: true,
    fileUrl,
    url: fileUrl,
    path: targetPath,
    local: true,
    remoteError: remote?.error,
  };
}

export async function prepareVideoRetalkSource(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rawPath = text(payload.path) || text(payload.filePath) || text(payload.sourcePath);
  if (!rawPath) return { success: false, error: 'generation:prepare-video-retalk-source requires path' };
  if (/^https?:\/\//i.test(rawPath)) return { success: true, path: rawPath, normalized: false, remote: true };
  let sourcePath = rawPath;
  try {
    sourcePath = resolveAssetSourceToPath(rawPath);
  } catch {
    sourcePath = path.resolve(rawPath.replace(/^file:\/\//i, ''));
  }
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) return { success: false, error: `VideoRetalk reference video does not exist: ${sourcePath}` };
  return { success: true, path: sourcePath, normalized: false };
}

function jobProjection(job: StoredMediaJob): MediaJobProjection {
  return cloneRecord(job);
}

function defaultResultForAsset(asset: MediaAsset, kind: string): Record<string, unknown> {
  const absolutePath = asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : '';
  const enriched = {
    ...asset,
    absolutePath: absolutePath || undefined,
    previewUrl: absolutePath ? toAppAssetUrl(absolutePath) : undefined,
    exists: Boolean(absolutePath),
  };
  return { kind, assets: [enriched] };
}

function artifactForAsset(jobId: string, kind: string, asset: MediaAsset): MediaJobArtifact {
  const absolutePath = asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : undefined;
  return {
    artifactId: `${jobId}:asset:${asset.id}`,
    kind,
    relativePath: asset.relativePath || null,
    absolutePath: absolutePath || null,
    mimeType: asset.mimeType || null,
    previewUrl: absolutePath ? toAppAssetUrl(absolutePath) : null,
    metadata: { assetId: asset.id, title: asset.title || null },
    createdAt: asset.createdAt || nowIso(),
  };
}

export class MediaGenerationJobRegistry extends EventEmitter {
  private readonly jobs = new Map<string, StoredMediaJob>();
  private readonly executionRequests = new Map<string, Record<string, unknown>>();
  private readonly activeRuns = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private loadedPath = '';
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private statePath(): string {
    return path.join(getWorkspacePaths().base, '.redbox', 'media-runtime', 'media-jobs.json');
  }

  private async ensureLoaded(): Promise<void> {
    const targetPath = this.statePath();
    if (this.loadedPath === targetPath) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      this.jobs.clear();
      this.executionRequests.clear();
      try {
        const raw = JSON.parse(await fs.readFile(targetPath, 'utf-8')) as Partial<MediaJobState>;
        if (raw.version === STATE_VERSION && Array.isArray(raw.jobs)) {
          for (const item of raw.jobs.slice(-MAX_JOBS)) {
            if (!item || typeof item !== 'object' || !text(item.jobId)) continue;
            this.jobs.set(item.jobId, item as StoredMediaJob);
          }
        }
      } catch {
        // Missing or malformed local state starts with an empty projection.
      }
      this.loadedPath = targetPath;
      this.loadPromise = null;
    })();
    return this.loadPromise;
  }

  private async persist(): Promise<void> {
    const targetPath = this.statePath();
    const snapshot: MediaJobState = {
      version: STATE_VERSION,
      jobs: Array.from(this.jobs.values()).slice(-MAX_JOBS),
    };
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      await fs.rename(tempPath, targetPath);
    });
    await this.writeQueue;
  }

  private emitUpdated(job: StoredMediaJob): void {
    this.emit('job-updated', jobProjection(job));
  }

  private async recordEvent(
    job: StoredMediaJob,
    eventType: string,
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const event: MediaJobEvent = {
      eventType,
      message,
      payload: payload || null,
      createdAt: nowIso(),
    };
    job.recentEvents = [...(job.recentEvents || []), event].slice(-MAX_EVENTS_PER_JOB);
    job.updatedAt = event.createdAt;
    await this.persist();
    this.emit('job-log', {
      jobId: job.jobId,
      message,
      payload: payload || null,
      createdAt: event.createdAt,
    });
    this.emitUpdated(job);
  }

  private getJobOrNull(jobId: string): StoredMediaJob | null {
    return this.jobs.get(text(jobId)) || null;
  }

  private async setStatus(
    job: StoredMediaJob,
    status: MediaJobStatus,
    eventType: string,
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    job.status = status;
    if (job.attempt) {
      job.attempt.status = status;
      job.attempt.updatedAt = nowIso();
    }
    if (TERMINAL_STATUSES.has(status)) job.completedAt = nowIso();
    await this.recordEvent(job, eventType, message, payload);
  }

  private async run(jobId: string): Promise<void> {
    if (this.activeRuns.has(jobId)) return;
    const job = this.jobs.get(jobId);
    if (!job || job.archivedAt || this.activeRuns.has(jobId)) return;
    this.activeRuns.add(jobId);
    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);
    try {
      if (job.status === 'cancel_requested' || job.status === 'cancelled') {
        await this.setStatus(job, 'cancelled', 'cancelled', '媒体任务已取消');
        return;
      }
      await this.setStatus(job, 'submitting', 'submitting', '提交媒体生成任务');
      const request = cleanExecutionRequest(this.executionRequests.get(jobId) || job.request || {});
      let result: Record<string, unknown>;
      if (job.kind === 'image') {
        const imageResult = await generateImagesToMediaLibrary({
          ...request,
          prompt: text(request.prompt),
          projectId: optionalText(request.projectId),
          title: optionalText(request.title),
          generationMode: optionalText(request.generationMode),
          referenceImages: Array.isArray(request.referenceImages) ? request.referenceImages as string[] : [],
          count: numberValue(request.count, 1),
          size: optionalText(request.size),
          quality: optionalText(request.quality),
          model: optionalText(request.model),
          provider: optionalText(request.provider),
          providerTemplate: optionalText(request.providerTemplate),
          endpoint: optionalText(request.endpoint),
          apiKey: optionalText(request.apiKey),
          aspectRatio: optionalText(request.aspectRatio),
        });
        result = {
          ...imageResult,
          assets: imageResult.assets.map((asset) => ({
            ...asset,
            absolutePath: asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : undefined,
            previewUrl: asset.relativePath ? toAppAssetUrl(getAbsoluteMediaPath(asset.relativePath)) : undefined,
          })),
        };
      } else if (job.kind === 'video' || job.kind === 'video_sequence') {
        await this.setStatus(job, 'polling', 'polling', '等待视频服务返回结果');
        const videoResult = await generateVideosToMediaLibrary({
          prompt: text(request.prompt),
          projectId: optionalText(request.projectId),
          title: optionalText(request.title),
          model: optionalText(request.model),
          endpoint: optionalText(request.endpoint),
          apiKey: optionalText(request.apiKey),
          aspectRatio: optionalText(request.aspectRatio),
          count: numberValue(request.count, 1),
          durationSeconds: numberValue(request.durationSeconds, 8),
          resolution: optionalText(request.resolution) === '1080p' ? '1080p' : '720p',
          generateAudio: Boolean(request.generateAudio),
          generationMode: ['text-to-video', 'reference-guided', 'first-last-frame', 'continuation'].includes(text(request.generationMode))
            ? text(request.generationMode) as 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation'
            : undefined,
          referenceImages: Array.isArray(request.referenceImages) ? request.referenceImages as string[] : [],
          drivingAudio: optionalText(request.drivingAudio),
          firstClip: optionalText(request.firstClip),
        });
        result = {
          ...videoResult,
          assets: videoResult.assets.map((asset) => ({
            ...asset,
            absolutePath: asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : undefined,
            previewUrl: asset.relativePath ? toAppAssetUrl(getAbsoluteMediaPath(asset.relativePath)) : undefined,
          })),
        };
      } else if (job.kind === 'audio' || job.kind === 'audio_sequence') {
        const speech = await synthesizeSpeechAsset(request);
        result = {
          success: true,
          model: speech.model,
          voiceId: speech.voiceId,
          ...defaultResultForAsset(speech.asset, 'audio'),
        };
      } else if (job.kind === 'voice_clone') {
        const cloned = await cloneVoice(request);
        result = { ...cloned };
      } else {
        throw new Error(`不支持的媒体任务类型: ${job.kind}`);
      }

      if (job.status === 'cancel_requested' || controller.signal.aborted) {
        await this.setStatus(job, 'cancelled', 'cancelled', '媒体任务已取消');
        return;
      }
      await this.setStatus(job, 'persisting', 'persisting', '保存生成产物');
      const assets = Array.isArray(result.assets)
        ? result.assets.filter((item): item is MediaAsset => Boolean(item && typeof item === 'object'))
        : [];
      const artifactKind = job.kind.startsWith('image') ? 'image' : job.kind.startsWith('video') ? 'video' : 'audio';
      for (const asset of assets) {
        job.artifacts.push(artifactForAsset(job.jobId, artifactKind, asset));
      }
      job.result = result;
      if (job.attempt) {
        job.attempt.response = { success: true, assetCount: assets.length };
        job.attempt.lastError = null;
      }
      await this.setStatus(job, 'completed', 'completed', '媒体生成完成', { artifactCount: assets.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.status === 'cancel_requested' || controller.signal.aborted) {
        job.cancelReason = job.cancelReason || 'user-requested';
        await this.setStatus(job, 'cancelled', 'cancelled', '媒体任务已取消');
      } else {
        if (job.attempt) job.attempt.lastError = message;
        job.result = { success: false, error: message };
        await this.setStatus(job, 'failed', 'failed', message, { error: message });
      }
    } finally {
      this.abortControllers.delete(jobId);
      this.activeRuns.delete(jobId);
    }
  }

  async submit(kind: string, rawRequest: Record<string, unknown>): Promise<SubmitResult> {
    await this.ensureLoaded();
    const request = { ...rawRequest };
    const jobId = id('media-job');
    const timestamp = nowIso();
    const source = optionalText(request.source) || 'generation_studio';
    const mode = queueMode(request.queueMode || request.queue_mode);
    const priority = optionalText(request.priority) || 'interactive';
    const providerKey = providerKeyFor(kind, request);
    const providerModel = providerModelFor(request);
    const attempt: MediaJobAttempt = {
      attemptId: id('media-attempt'),
      attemptNo: 1,
      status: 'accepted',
      idempotencyKey: optionalText(request.clientRequestId) || jobId,
      lastError: null,
      response: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const job: StoredMediaJob = {
      jobId,
      kind,
      source,
      queueMode: mode,
      priority,
      status: 'accepted',
      providerKey,
      providerModel,
      request: redactRequest(request),
      result: null,
      projectId: optionalText(request.projectId) || null,
      manuscriptPath: optionalText(request.manuscriptPath) || null,
      videoProjectPath: optionalText(request.videoProjectPath) || null,
      ownerSessionId: optionalText(request.sessionId) || optionalText(request.ownerSessionId) || null,
      cancelReason: null,
      archivedAt: null,
      archiveReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      attempt,
      artifacts: [],
      recentEvents: [],
    };
    this.jobs.set(jobId, job);
    this.executionRequests.set(jobId, request);
    await this.recordEvent(job, 'accepted', '媒体任务已接收');
    await this.setStatus(job, 'queued', 'queued', '等待媒体任务执行');
    void this.run(jobId);
    return {
      success: true,
      jobId,
      status: 'queued',
      kind,
      source,
      queueMode: mode,
      priority,
      providerKey,
      providerModel,
      acceptedAt: timestamp,
    };
  }

  async getJob(jobId: string): Promise<MediaJobProjection | null> {
    await this.ensureLoaded();
    const job = this.getJobOrNull(jobId);
    return job ? jobProjection(job) : null;
  }

  async listJobs(filter: Record<string, unknown> = {}): Promise<{ success: true; items: MediaJobProjection[] }> {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.min(300, Math.floor(numberValue(filter.limit, 100))));
    const items = Array.from(this.jobs.values())
      .filter((job) => filter.includeArchived === true || !job.archivedAt)
      .filter((job) => !text(filter.kind) || job.kind === text(filter.kind))
      .filter((job) => !text(filter.status) || job.status === text(filter.status))
      .filter((job) => !text(filter.source) || job.source === text(filter.source))
      .filter((job) => !text(filter.queueMode) || job.queueMode === queueMode(filter.queueMode))
      .filter((job) => !text(filter.manuscriptPath) || job.manuscriptPath === text(filter.manuscriptPath))
      .filter((job) => !text(filter.videoProjectPath) || job.videoProjectPath === text(filter.videoProjectPath))
      .filter((job) => !text(filter.ownerSessionId) || job.ownerSessionId === text(filter.ownerSessionId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(jobProjection);
    return { success: true, items };
  }

  async listJobSummaries(filter: Record<string, unknown> = {}): Promise<{ success: true; items: Array<Record<string, unknown>> }> {
    const result = await this.listJobs({ ...filter, limit: Math.min(numberValue(filter.limit, 50), 200) });
    return {
      success: true,
      items: result.items.map((job) => ({
        jobId: job.jobId,
        id: job.jobId,
        kind: job.kind,
        source: job.source,
        queueMode: job.queueMode,
        priority: job.priority,
        status: job.status,
        providerKey: job.providerKey,
        providerModel: job.providerModel,
        title: text(job.request?.title) || (job.kind === 'image' ? '图片生成' : job.kind === 'video' ? '视频生成' : '音频生成'),
        summary: text(job.request?.prompt) || text(job.request?.input) || '媒体生成任务',
        latestText: job.attempt?.lastError || job.recentEvents.at(-1)?.message || '',
        ownerSessionId: job.ownerSessionId,
        projectId: job.projectId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
        attemptNo: job.attempt?.attemptNo || 1,
        attemptStatus: job.attempt?.status || job.status,
        error: job.attempt?.lastError || null,
        artifactCount: job.artifacts.length,
        archivedAt: job.archivedAt,
        archiveReason: job.archiveReason,
      })),
    };
  }

  async getJobArtifacts(jobId: string): Promise<{ success: boolean; jobId: string; items: MediaJobArtifact[] }> {
    await this.ensureLoaded();
    const job = this.getJobOrNull(jobId);
    return { success: Boolean(job), jobId, items: job ? cloneRecord(job.artifacts) : [] };
  }

  async awaitJob(jobId: string, timeoutMs = 600_000): Promise<MediaJobProjection | null> {
    const timeout = Math.max(0, Math.min(600_000, Math.floor(numberValue(timeoutMs, 600_000))));
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeout) {
      const job = await this.getJob(jobId);
      if (!job || TERMINAL_STATUSES.has(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.getJob(jobId);
  }

  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const job = this.getJobOrNull(jobId);
    if (!job) return { success: false, error: '媒体任务不存在' };
    if (TERMINAL_STATUSES.has(job.status)) return { success: true, jobId, status: job.status };
    job.cancelReason = 'user-requested';
    this.abortControllers.get(jobId)?.abort();
    await this.setStatus(job, 'cancel_requested', 'cancel_requested', '正在取消媒体任务');
    if (!this.activeRuns.has(jobId)) await this.setStatus(job, 'cancelled', 'cancelled', '媒体任务已取消');
    return { success: true, jobId, status: job.status };
  }

  async deleteJob(jobId: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const job = this.getJobOrNull(jobId);
    if (!job) return { success: false, error: '媒体任务不存在' };
    if (!TERMINAL_STATUSES.has(job.status)) return { success: false, error: '任务仍在运行，请完成或取消后再归档' };
    job.archivedAt = nowIso();
    job.archiveReason = 'user-deleted';
    await this.recordEvent(job, 'archived', '媒体任务已归档');
    return { success: true, jobId, status: job.status, archivedAt: job.archivedAt };
  }

  async retryJob(jobId: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const job = this.getJobOrNull(jobId);
    if (!job) return { success: false, error: '媒体任务不存在' };
    if (!TERMINAL_STATUSES.has(job.status)) return { success: false, error: '任务仍在运行，不能重试' };
    const timestamp = nowIso();
    const nextAttemptNo = (job.attempt?.attemptNo || 0) + 1;
    job.archivedAt = null;
    job.archiveReason = null;
    job.cancelReason = null;
    job.completedAt = null;
    job.result = null;
    job.artifacts = [];
    job.attempt = {
      attemptId: id('media-attempt'),
      attemptNo: nextAttemptNo,
      status: 'queued',
      idempotencyKey: `${job.jobId}:attempt:${nextAttemptNo}`,
      lastError: null,
      response: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    job.status = 'queued';
    await this.recordEvent(job, 'retry', `媒体任务开始第 ${nextAttemptNo} 次尝试`, { attemptNo: nextAttemptNo });
    void this.run(jobId);
    return { success: true, jobId, status: 'queued', attemptNo: nextAttemptNo };
  }

  async getRuntimeStatus(): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const activeJobs = Array.from(this.jobs.values()).filter((job) => !job.archivedAt && !TERMINAL_STATUSES.has(job.status));
    const pressure = Array.from(this.jobs.values()).reduce<Record<string, number>>((result, job) => {
      if (job.archivedAt) return result;
      const key = `${job.kind}:${job.status}`;
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});
    return {
      success: true,
      runtimeReady: true,
      runtimeRunning: activeJobs.length > 0,
      pressure: { activeJobs: activeJobs.length, byKindStatus: pressure },
    };
  }
}

async function cloneVoice(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const settings = readSettings();
  const endpoint = normalizeApiBaseUrl(endpointFromRequest(request, settings));
  const apiKey = apiKeyFromRequest(request, settings);
  const source = text(request.sampleFileKey) || text(request.sample_file_key);
  const rawPath = text(request.path) || text(request.filePath) || text(request.sourcePath);
  if (!endpoint || !apiKey) throw new Error('语音服务未配置');
  const url = safeUrlJoin(endpoint, '/audio/voices/clone');
  let body: BodyInit;
  let headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (source) {
    body = JSON.stringify({ sample_file_key: source, name: optionalText(request.name), model: optionalText(request.model) });
    headers['Content-Type'] = 'application/json';
  } else {
    if (!rawPath) throw new Error('voice.clone requires sample path or sampleFileKey');
    const samplePath = resolveAssetSourceToPath(rawPath);
    const stat = await fs.stat(samplePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`voice sample does not exist: ${samplePath}`);
    const form = new FormData();
    form.append('file', new Blob([await fs.readFile(samplePath)]), path.basename(samplePath));
    if (optionalText(request.name)) form.append('name', optionalText(request.name)!);
    if (optionalText(request.model)) form.append('model', optionalText(request.model)!);
    body = form;
  }
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(`voice clone failed (${response.status}): ${(await response.text()).slice(0, 800)}`);
  const parsed = await response.json() as Record<string, unknown>;
  return { success: true, voice: parsed.voice || parsed.data || parsed, raw: parsed };
}

export async function listVoices(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const settings = readSettings();
  const endpoint = voicesEndpoint(endpointFromRequest(payload, settings));
  const model = text(payload.model) || text(payload.ttsModel) || text(settings.voice_tts_model) || text(settings.tts_model);
  const local: Array<Record<string, unknown>> = Array.isArray(settings.voice_list_json)
    ? settings.voice_list_json.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : DEFAULT_VOICES;
  if (!endpoint) return { success: true, voices: local, items: local, configError: 'voice endpoint is not configured' };
  const apiKey = apiKeyFromRequest(payload, settings);
  try {
    const url = new URL(endpoint);
    if (model) url.searchParams.set('model', model);
    const response = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined });
    if (!response.ok) throw new Error(`voice list failed (${response.status})`);
    const remote = parseVoiceItems(await response.json());
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of [...remote, ...local]) {
      const voiceId = text(item.id) || text(item.voiceId);
      if (voiceId && !byId.has(voiceId)) byId.set(voiceId, item);
    }
    const voices = Array.from(byId.values());
    return { success: true, voices, items: voices };
  } catch (error) {
    return { success: true, voices: local, items: local, remoteError: error instanceof Error ? error.message : String(error) };
  }
}

export async function getVoice(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const voiceId = text(payload.voiceId) || text(payload.voice_id) || text(payload.id);
  if (!voiceId) return { success: false, error: 'voice.get requires voiceId', voice: null };
  const settings = readSettings();
  const endpoint = normalizeApiBaseUrl(endpointFromRequest(payload, settings));
  const apiKey = apiKeyFromRequest(payload, settings);
  if (!endpoint) {
    const local = (await listVoices(payload)).voices as Array<Record<string, unknown>>;
    return { success: true, voice: local.find((item) => text(item.id) === voiceId) || null };
  }
  try {
    const response = await fetch(`${endpoint}/audio/voices/${encodeURIComponent(voiceId)}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!response.ok) throw new Error(`voice get failed (${response.status})`);
    return { success: true, voice: await response.json() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), voice: null };
  }
}

let registry: MediaGenerationJobRegistry | null = null;

export function getMediaGenerationJobRegistry(): MediaGenerationJobRegistry {
  if (!registry) registry = new MediaGenerationJobRegistry();
  return registry;
}

export async function synthesizeVoiceSpeech(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const result = await synthesizeSpeechAsset(payload);
    const absolutePath = result.asset.relativePath ? getAbsoluteMediaPath(result.asset.relativePath) : '';
    const asset = {
      ...result.asset,
      absolutePath: absolutePath || undefined,
      previewUrl: absolutePath ? toAppAssetUrl(absolutePath) : undefined,
    };
    return {
      success: true,
      voiceId: result.voiceId,
      data: { finalAudio: { path: absolutePath, mimeType: result.asset.mimeType, asset } },
      asset,
      path: absolutePath,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteVoice(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const voiceId = text(payload.voiceId) || text(payload.voice_id) || text(payload.id);
  if (!voiceId) return { success: false, error: 'voice.delete requires voiceId' };
  const settings = readSettings();
  const endpoint = normalizeApiBaseUrl(endpointFromRequest(payload, settings));
  const apiKey = apiKeyFromRequest(payload, settings);
  if (!endpoint) return { success: false, error: 'voice endpoint is not configured' };
  try {
    const response = await fetch(`${endpoint}/audio/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!response.ok) throw new Error(`voice delete failed (${response.status})`);
    return { success: true, voiceId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function bindVoiceAsset(_payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { success: false, status: 'unavailable', error: 'Voice asset binding is managed by the Subjects page in the Electron archive' };
}
