import fs from 'node:fs/promises';
import path from 'node:path';
import { getSettings } from '../db';
import { createGeneratedMediaAsset, type MediaAsset } from './mediaLibraryStore';
import { normalizeApiBaseUrl } from './urlUtils';
import {
    REDBOX_OFFICIAL_VIDEO_BASE_URL,
    getRedBoxOfficialVideoModel,
} from '../../shared/redboxVideo';

export interface GenerateVideosInput {
    prompt: string;
    projectId?: string;
    title?: string;
    model?: string;
    endpoint?: string;
    apiKey?: string;
    aspectRatio?: string;
    count?: number;
    durationSeconds?: number;
    resolution?: '720p' | '1080p';
    generateAudio?: boolean;
    generationMode?: 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation';
    referenceImages?: string[];
    drivingAudio?: string;
    firstClip?: string;
}

export interface GenerateVideosResult {
    model: string;
    endpoint: string;
    provider: string;
    aspectRatio: '16:9' | '9:16';
    resolution: '720p' | '1080p';
    durationSeconds: number;
    generateAudio: boolean;
    assets: MediaAsset[];
}

function maskKeySuffix(value: unknown): string {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.slice(-6);
}

type VideoGenerationMode = 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation';
const VIDEO_TASK_POLL_INTERVAL_MS = 3000;
const VIDEO_TASK_POLL_TIMEOUT_MS = 6 * 60 * 1000;

function isRedBoxCompatibleEndpoint(endpoint: string): boolean {
    const normalized = normalizeApiBaseUrl(endpoint).toLowerCase();
    return normalized.includes('api.ziz.hk') && normalized.includes('/v1');
}

function normalizeVideoAspectRatio(value: string): '16:9' | '9:16' {
    return String(value || '').trim() === '9:16' ? '9:16' : '16:9';
}

function normalizeVideoResolution(value: string): '720p' | '1080p' {
    return String(value || '').trim() === '1080p' ? '1080p' : '720p';
}

function normalizeVideoDuration(value: unknown): number {
    const parsed = Math.floor(Number(value) || 8);
    return Math.max(5, Math.min(12, parsed));
}

function mapOpenAiVideoSize(
    aspectRatio: '16:9' | '9:16',
    resolution: '720p' | '1080p'
): '720x1280' | '1280x720' | '1024x1792' | '1792x1024' {
    if (aspectRatio === '9:16') {
        return resolution === '1080p' ? '1024x1792' : '720x1280';
    }
    return resolution === '1080p' ? '1792x1024' : '1280x720';
}

function mapOpenAiVideoSeconds(durationSeconds: number): '4' | '8' | '12' {
    if (durationSeconds <= 6) return '4';
    if (durationSeconds <= 10) return '8';
    return '12';
}

function inferMimeTypeFromPath(filePath: string): string {
    const ext = path.extname(String(filePath || '').trim()).toLowerCase();
    switch (ext) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.webp':
            return 'image/webp';
        case '.gif':
            return 'image/gif';
        case '.mp3':
            return 'audio/mpeg';
        case '.wav':
            return 'audio/wav';
        case '.m4a':
            return 'audio/mp4';
        case '.aac':
            return 'audio/aac';
        case '.ogg':
            return 'audio/ogg';
        case '.mp4':
            return 'video/mp4';
        case '.mov':
            return 'video/quicktime';
        case '.webm':
            return 'video/webm';
        default:
            return 'application/octet-stream';
    }
}

async function normalizeMediaValueForRemote(value: string): Promise<string> {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('data:')) {
        return raw;
    }
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 128) {
        return raw;
    }
    try {
        const buffer = await fs.readFile(raw);
        const mimeType = inferMimeTypeFromPath(raw);
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
        return raw;
    }
}

async function fetchGeneratedVideoBuffer(videoUrl: string, apiKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const attempts: Array<Record<string, string>> = [
        {},
        { 'x-goog-api-key': apiKey },
        { Authorization: `Bearer ${apiKey}` },
    ];
    let lastError = 'Failed to download generated video.';

    for (const headers of attempts) {
        try {
            const response = await fetch(videoUrl, { headers });
            if (!response.ok) {
                lastError = `下载生成视频失败 (${response.status} ${response.statusText})`;
                continue;
            }
            const mimeType = String(response.headers.get('content-type') || 'video/mp4').trim().toLowerCase() || 'video/mp4';
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length === 0) {
                lastError = '下载到的生视频内容为空。';
                continue;
            }
            return { buffer, mimeType };
        } catch (error) {
            lastError = String(error || '下载生成视频失败。');
        }
    }

    throw new Error(lastError);
}

function buildCompatibleVideoRouteUrl(endpoint: string, suffix: string): string {
    const normalized = normalizeApiBaseUrl(endpoint);
    try {
        const parsed = new URL(normalized);
        const pathname = parsed.pathname.replace(/\/+$/, '');
        if (pathname.toLowerCase().endsWith(suffix.toLowerCase())) {
            return parsed.toString();
        }
        parsed.pathname = `${pathname}${suffix}`.replace(/\/{2,}/g, '/');
        return parsed.toString();
    } catch {
        return `${normalized.replace(/\/+$/, '')}${suffix}`;
    }
}

function buildCompatibleVideoRouteUrls(endpoint: string, suffix: string): string[] {
    const primary = buildCompatibleVideoRouteUrl(endpoint, suffix);
    const urls = [primary];
    if (isRedBoxCompatibleEndpoint(endpoint)) {
        try {
            const parsed = new URL(normalizeApiBaseUrl(endpoint));
            const apiRoute = `${parsed.origin}/api/v1${suffix}`;
            const v1Route = `${parsed.origin}/v1${suffix}`;
            return [primary, apiRoute, v1Route].filter((item, index, arr) => arr.indexOf(item) === index);
        } catch {
            return urls;
        }
    }
    return urls;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTaskId(payload: any): string {
    const direct = String(payload?.task_id || payload?.taskId || '').trim();
    if (direct) return direct;
    const data = payload?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return String((data as Record<string, unknown>).task_id || (data as Record<string, unknown>).taskId || '').trim();
    }
    return '';
}

function extractTaskStatus(payload: any): string {
    const direct = String(payload?.task_status || payload?.status || '').trim();
    if (direct) return direct.toUpperCase();
    const data = payload?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return String((data as Record<string, unknown>).task_status || (data as Record<string, unknown>).status || '').trim().toUpperCase();
    }
    return '';
}

function extractTaskFailureMessage(payload: any): string {
    const candidates = [
        payload?.message,
        payload?.error,
        payload?.error_message,
        payload?.detail,
    ];
    const data = payload?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        candidates.push(
            (data as Record<string, unknown>).message,
            (data as Record<string, unknown>).error,
            (data as Record<string, unknown>).error_message,
            (data as Record<string, unknown>).detail,
        );
    }
    for (const candidate of candidates) {
        const text = String(candidate || '').trim();
        if (text) return text;
    }
    return '';
}

function extractCompatibleVideoUrls(payload: any): string[] {
    const urls: string[] = [];
    const pushUrl = (value: unknown) => {
        const text = String(value || '').trim();
        if (text && /^https?:\/\//i.test(text) && !urls.includes(text)) {
            urls.push(text);
        }
    };
    const output = payload && typeof payload === 'object' ? payload : {};
    pushUrl(output.video_url);
    pushUrl(output.video);
    pushUrl(output.url);
    const dataRows = Array.isArray(output.data) ? output.data : [];
    for (const item of dataRows) {
        if (typeof item === 'string') {
            pushUrl(item);
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        pushUrl((item as Record<string, unknown>).video_url);
        pushUrl((item as Record<string, unknown>).video);
        pushUrl((item as Record<string, unknown>).url);
    }
    return urls;
}

async function generateViaOpenAiCompatibleVideoRoute(input: {
    prompt: string;
    endpoint: string;
    apiKey: string;
    model: string;
    count: number;
    aspectRatio: '16:9' | '9:16';
    resolution: '720p' | '1080p';
    durationSeconds: number;
    title?: string;
    projectId?: string;
    referenceImages?: string[];
    generationMode?: VideoGenerationMode;
    drivingAudio?: string;
    firstClip?: string;
}): Promise<GenerateVideosResult> {
    const createUrls = buildCompatibleVideoRouteUrls(input.endpoint, '/videos/generations/async');
    const queryUrls = buildCompatibleVideoRouteUrls(input.endpoint, '/videos/generations/tasks/query');
    const size = mapOpenAiVideoSize(input.aspectRatio, input.resolution);
    const seconds = mapOpenAiVideoSeconds(input.durationSeconds);
    const refs = Array.isArray(input.referenceImages) ? input.referenceImages.filter(Boolean) : [];
    const normalizedDrivingAudio = input.drivingAudio ? await normalizeMediaValueForRemote(input.drivingAudio) : '';
    const body: Record<string, unknown> = {
        model: input.model,
        prompt: input.prompt,
        size,
        seconds,
        n: input.count,
    };
    if (isRedBoxCompatibleEndpoint(input.endpoint)) {
        body.resolution = input.resolution === '1080p' ? '1080P' : '720P';
        body.duration = input.durationSeconds;

        if (input.generationMode === 'text-to-video') {
            if (normalizedDrivingAudio) {
                body.audio_url = normalizedDrivingAudio;
                body.driving_audio_url = normalizedDrivingAudio;
            }
        } else if (input.generationMode === 'reference-guided') {
            const referenceImages = await Promise.all(refs.slice(0, 5).map((item) => normalizeMediaValueForRemote(item)));
            const normalizedRefs = referenceImages.filter(Boolean);
            if (normalizedRefs.length) {
                body.images = normalizedRefs;
                body.reference_images = normalizedRefs;
                body.reference_image_urls = normalizedRefs;
                body.image_urls = normalizedRefs;
                body.image = normalizedRefs[0];
                body.image_url = normalizedRefs[0];
                body.reference_image = normalizedRefs[0];
                body.img_url = normalizedRefs[0];
            }
            if (normalizedDrivingAudio) {
                body.reference_voice = normalizedDrivingAudio;
                body.reference_voice_url = normalizedDrivingAudio;
                body.audio_url = normalizedDrivingAudio;
            }
        } else if (input.generationMode === 'first-last-frame') {
            const firstFrame = refs[0] ? await normalizeMediaValueForRemote(refs[0]) : '';
            const lastFrame = refs[1] ? await normalizeMediaValueForRemote(refs[1]) : '';
            if (firstFrame || lastFrame) {
                body.video_mode = 'first_last_frame';
                body.media = [
                    ...(firstFrame ? [{ type: 'first_frame', url: firstFrame }] : []),
                    ...(lastFrame ? [{ type: 'last_frame', url: lastFrame }] : []),
                    ...(normalizedDrivingAudio ? [{ type: 'driving_audio', url: normalizedDrivingAudio }] : []),
                ];
                if (firstFrame) {
                    body.image = firstFrame;
                    body.image_url = firstFrame;
                    body.reference_image = firstFrame;
                    body.img_url = firstFrame;
                }
                body.images = [firstFrame, lastFrame].filter(Boolean);
                if (lastFrame) {
                    body.last_frame = lastFrame;
                    body.last_frame_url = lastFrame;
                    body.last_image_url = lastFrame;
                }
                if (normalizedDrivingAudio) {
                    body.audio_url = normalizedDrivingAudio;
                    body.driving_audio_url = normalizedDrivingAudio;
                }
            }
        } else if (input.generationMode === 'continuation') {
            const firstClip = input.firstClip ? await normalizeMediaValueForRemote(input.firstClip) : '';
            if (firstClip) {
                body.video_mode = 'continuation';
                body.media = [{ type: 'first_clip', url: firstClip }];
                body.first_clip_url = firstClip;
                body.video_url = firstClip;
                body.video = firstClip;
            }
        }
    } else {
        if (refs[0]) {
            body.image = refs[0];
            body.image_url = refs[0];
            body.reference_image = refs[0];
            body.img_url = refs[0];
        }
        if (refs.length > 0) {
            body.images = refs.slice(0, 2);
        }
        if (normalizedDrivingAudio) {
            body.audio_url = normalizedDrivingAudio;
            body.driving_audio_url = normalizedDrivingAudio;
        }
    }
    let response: Response | null = null;
    let payload: any = {};
    let lastError = '';
    let lastNetworkError = '';
    for (const requestUrl of createUrls) {
        try {
            response = await fetch(requestUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${input.apiKey}`,
                },
                body: JSON.stringify(body),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || 'fetch failed');
            lastNetworkError = `[${requestUrl}] ${message}`;
            lastError = `生视频网络请求失败：${lastNetworkError}`;
            console.warn('[VideoGeneration] async create failed, trying fallback route', {
                requestUrl,
                error: message,
            });
            continue;
        }
        if (response.ok) {
            payload = await response.json().catch(() => ({}));
            break;
        }
        const errorText = await response.text();
        lastError = `生视频异步创建失败 (${response.status}): ${errorText || response.statusText || 'request failed'}`;
        if (response.status !== 404) {
            throw new Error(lastError);
        }
    }
    if (!response?.ok) {
        if (lastNetworkError) {
            throw new Error(`生视频异步创建网络失败（请检查代理/网络/TLS）：${lastNetworkError}`);
        }
        throw new Error(lastError || '生视频异步创建失败');
    }

    const taskId = extractTaskId(payload);
    if (!taskId) {
        throw new Error('生视频异步创建成功，但接口未返回 task_id。');
    }
    console.log('[VideoGeneration] async task created', {
        model: input.model,
        taskId,
        requestId: String(payload?.request_id || '').trim(),
        endpoint: input.endpoint,
    });

    const deadline = Date.now() + VIDEO_TASK_POLL_TIMEOUT_MS;
    let finalPayload: any = payload;
    let finalStatus = extractTaskStatus(payload);
    let queryLastError = '';
    let queryLastNetworkError = '';

    while (Date.now() < deadline) {
        if (finalStatus === 'SUCCEEDED') {
            break;
        }
        if (finalStatus === 'FAILED' || finalStatus === 'CANCELLED') {
            const failure = extractTaskFailureMessage(finalPayload);
            throw new Error(`生视频异步任务失败：${failure || finalStatus}`);
        }

        await sleep(VIDEO_TASK_POLL_INTERVAL_MS);
        response = null;

        for (const queryUrl of queryUrls) {
            try {
                response = await fetch(queryUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${input.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: input.model,
                        task_id: taskId,
                    }),
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || 'fetch failed');
                queryLastNetworkError = `[${queryUrl}] ${message}`;
                console.warn('[VideoGeneration] async query failed, trying fallback route', {
                    queryUrl,
                    error: message,
                    taskId,
                });
                continue;
            }

            if (response.ok) {
                finalPayload = await response.json().catch(() => ({}));
                finalStatus = extractTaskStatus(finalPayload);
                console.log('[VideoGeneration] async task polled', {
                    taskId,
                    status: finalStatus || 'UNKNOWN',
                    requestId: String(finalPayload?.request_id || payload?.request_id || '').trim(),
                });
                break;
            }

            const errorText = await response.text();
            queryLastError = `生视频异步查询失败 (${response.status}): ${errorText || response.statusText || 'request failed'}`;
            if (response.status !== 404) {
                throw new Error(queryLastError);
            }
        }

        if (!response?.ok && queryLastNetworkError) {
            queryLastError = `生视频异步查询网络失败（请检查代理/网络/TLS）：${queryLastNetworkError}`;
        }
    }

    if (finalStatus !== 'SUCCEEDED') {
        if (queryLastError) {
            throw new Error(queryLastError);
        }
        throw new Error(`生视频异步任务超时，task_id=${taskId}`);
    }

    const videoUrls = extractCompatibleVideoUrls(finalPayload);
    if (!videoUrls.length) {
        throw new Error('生视频任务已完成，但接口未返回可下载的视频地址。');
    }

    const assets: MediaAsset[] = [];
    for (const videoUrl of videoUrls.slice(0, input.count)) {
        const downloaded = await fetchGeneratedVideoBuffer(videoUrl, input.apiKey);
        const asset = await createGeneratedMediaAsset({
            prompt: input.prompt,
            dataBuffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            projectId: input.projectId?.trim() || undefined,
            provider: input.endpoint.toLowerCase().includes('/redbox/') ? 'redbox' : 'openai-compatible',
            model: input.model,
            aspectRatio: input.aspectRatio,
            size: input.resolution,
            quality: `${input.durationSeconds}s`,
            title: input.title?.trim() || undefined,
        });
        assets.push(asset);
    }

    if (!assets.length) {
        throw new Error('生视频任务已完成，但没有可保存的视频文件。');
    }

    return {
        model: input.model,
        endpoint: input.endpoint,
        provider: input.endpoint.toLowerCase().includes('/redbox/') ? 'redbox' : 'openai-compatible',
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        durationSeconds: input.durationSeconds,
        generateAudio: false,
        assets,
    };
}

export async function generateVideosToMediaLibrary(input: GenerateVideosInput): Promise<GenerateVideosResult> {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) {
        throw new Error('Prompt is required');
    }

    const settings = (getSettings() || {}) as Record<string, unknown>;
    const generationMode = String(input.generationMode || '').trim() as VideoGenerationMode;
    const endpoint = normalizeApiBaseUrl(
        String(
            REDBOX_OFFICIAL_VIDEO_BASE_URL
        ).trim(),
        REDBOX_OFFICIAL_VIDEO_BASE_URL
    );
    const inputApiKey = String(input.apiKey || '').trim();
    const videoApiKey = String(settings.video_api_key || '').trim();
    const globalApiKey = String(settings.api_key || '').trim();
    const apiKey = inputApiKey || videoApiKey || globalApiKey;
    const selectedKeySource = inputApiKey
        ? 'input.apiKey'
        : videoApiKey
            ? 'settings.video_api_key'
            : globalApiKey
                ? 'settings.api_key'
                : 'none';
    const aspectRatio = normalizeVideoAspectRatio(String(input.aspectRatio || '').trim());
    const resolution = normalizeVideoResolution(String(input.resolution || '').trim());
    const durationSeconds = normalizeVideoDuration(input.durationSeconds);
    const count = Math.max(1, Math.min(2, Number(input.count) || 1));
    const generateAudio = Boolean(input.generateAudio);
    const referenceImages = Array.isArray(input.referenceImages)
        ? input.referenceImages.filter(Boolean).slice(0, generationMode === 'reference-guided' ? 5 : 2)
        : [];
    const drivingAudio = String(input.drivingAudio || '').trim();
    const firstClip = String(input.firstClip || '').trim();
    const model = getRedBoxOfficialVideoModel(generationMode || 'text-to-video');

    if (!endpoint) {
        throw new Error('生视频 Endpoint 未配置。请先登录或配置 RedBox 官方 AI 源。');
    }
    if (!apiKey) {
        throw new Error('生视频 API Key 未配置。请先登录或配置 RedBox 官方 AI 源。');
    }
    if (!isRedBoxCompatibleEndpoint(endpoint)) {
        throw new Error('生视频能力已锁定为 RedBox 官方视频源。请先使用 RedBox 官方 AI 源。');
    }
    console.log('[VideoGeneration] auth prepared', {
        endpoint,
        keySource: selectedKeySource,
        keySuffix: maskKeySuffix(apiKey),
        videoKeySuffix: maskKeySuffix(videoApiKey),
        globalKeySuffix: maskKeySuffix(globalApiKey),
        model,
        generationMode,
        hasDrivingAudio: Boolean(drivingAudio),
    });
    if (generationMode === 'reference-guided' && referenceImages.length < 1) {
        throw new Error('参考图视频模式至少需要 1 张参考图。');
    }
    if (generationMode === 'first-last-frame' && referenceImages.length < 2) {
        throw new Error('首尾帧视频模式需要 2 张参考图。');
    }
    if (generationMode === 'continuation' && !firstClip) {
        throw new Error('视频续写模式需要 1 段起始视频。');
    }

    return generateViaOpenAiCompatibleVideoRoute({
        prompt,
        endpoint,
        apiKey,
        model,
        count,
        aspectRatio,
        resolution,
        durationSeconds,
        title: input.title,
        projectId: input.projectId,
        referenceImages,
        generationMode,
        drivingAudio,
        firstClip,
    });
}
