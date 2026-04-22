import { promises as fs } from 'node:fs';
import { extname, isAbsolute, normalize } from 'node:path';
import { resolveAssetSourceToPath } from './localAssetManager';
import { isLocalAssetSource } from '../../shared/localAsset';

export type ImageProviderTemplate =
    | 'openai-images'
    | 'gemini-openai-images'
    | 'gemini-imagen-native'
    | 'dashscope-wan-native'
    | 'ark-seedream-native'
    | 'midjourney-proxy'
    | 'jimeng-openai-wrapper'
    // Legacy template ids kept for backward compatibility.
    | 'gemini-generate-content'
    | 'jimeng-images';

export type ImageAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | 'auto';
export type ImageQuality = 'low' | 'medium' | 'high' | 'standard' | 'hd' | 'auto';
export type ImageGenerationMode = 'text-to-image' | 'image-to-image' | 'reference-guided';

export interface ImageGenerationRequest {
    prompt: string;
    model: string;
    endpoint: string;
    apiKey: string;
    provider: string;
    providerTemplate: ImageProviderTemplate;
    generationMode?: ImageGenerationMode;
    referenceImages?: string[];
    aspectRatio?: ImageAspectRatio;
    size?: string;
    quality?: ImageQuality | string;
    count?: number;
}

export interface GeneratedImageOutput {
    imageBuffer: Buffer;
    mimeType?: string;
}

export interface ImageProviderAdapter {
    template: ImageProviderTemplate;
    supportsMultiCount: boolean;
    generate(request: ImageGenerationRequest): Promise<GeneratedImageOutput[]>;
}

export interface ImageProviderCapabilities {
    supportedModes: ImageGenerationMode[];
    supportsReferenceImages: boolean;
    maxReferenceImages: number;
}

const OPENAI_SQUARE_SIZE = '1024x1024';
const DEFAULT_SIZE_BY_ASPECT: Record<Exclude<ImageAspectRatio, 'auto'>, string> = {
    '1:1': '1024x1024',
    '3:4': '1536x2048',
    '4:3': '2048x1536',
    '9:16': '1152x2048',
    '16:9': '2048x1152',
};
const SEEDREAM_MIN_PIXELS = 3_686_400;
const SIZE_STEP = 64;
const IMAGE_PROVIDER_CAPABILITIES: Record<ImageProviderTemplate, ImageProviderCapabilities> = {
    'openai-images': {
        supportedModes: ['text-to-image', 'image-to-image', 'reference-guided'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
    'gemini-openai-images': {
        supportedModes: ['text-to-image', 'reference-guided'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
    'gemini-imagen-native': {
        supportedModes: ['text-to-image'],
        supportsReferenceImages: false,
        maxReferenceImages: 0,
    },
    'dashscope-wan-native': {
        supportedModes: ['text-to-image', 'image-to-image', 'reference-guided'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
    'ark-seedream-native': {
        supportedModes: ['text-to-image', 'reference-guided'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
    'midjourney-proxy': {
        supportedModes: ['text-to-image'],
        supportsReferenceImages: false,
        maxReferenceImages: 0,
    },
    'jimeng-openai-wrapper': {
        supportedModes: ['text-to-image', 'reference-guided', 'image-to-image'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
    'gemini-generate-content': {
        supportedModes: ['text-to-image', 'reference-guided'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
    'jimeng-images': {
        supportedModes: ['text-to-image', 'reference-guided', 'image-to-image'],
        supportsReferenceImages: true,
        maxReferenceImages: 4,
    },
};

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function isImageGenDebugEnabled(): boolean {
    const value = String(process.env.REDCONVERT_IMAGE_DEBUG || process.env.REDCONVERT_DEBUG || '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function readPositiveEnvInt(name: string, fallback: number): number {
    const raw = Number.parseInt(String(process.env[name] || '').trim(), 10);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return raw;
}

function resolveImageRequestTimeoutMs(): number {
    // OpenAI SDK default is 10 minutes. Keep a longer default for slow image providers/gateways.
    return readPositiveEnvInt('REDCONVERT_IMAGE_TIMEOUT_MS', 20 * 60 * 1000);
}

function resolveImage524RetryCount(): number {
    // Disabled by product decision: timeout/429 should fail fast and surface error immediately.
    return 0;
}

function isLikelyUpstreamTimeoutError(status: number, message: string): boolean {
    const text = String(message || '').toLowerCase();
    return (
        status === 524 ||
        status === 504 ||
        /receive timeout from origin/.test(text) ||
        /gateway timeout/.test(text) ||
        /request timed out/.test(text) ||
        /timeout/.test(text)
    );
}

function logImageGenDebug(scope: string, message: string, detail?: Record<string, unknown>): void {
    if (!isImageGenDebugEnabled()) return;
    const ts = new Date().toISOString();
    const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
    console.info(`[image-gen-debug][${scope}][${ts}] ${message}${suffix}`);
}

function normalizeRequestedGenerationMode(value: unknown): ImageGenerationMode {
    const normalized = String(value || '').trim();
    if (normalized === 'image-to-image' || normalized === 'reference-guided' || normalized === 'text-to-image') {
        return normalized;
    }
    return 'text-to-image';
}

function resolveGenerationModeForTemplate(template: ImageProviderTemplate, requested: unknown): ImageGenerationMode {
    const capabilities = IMAGE_PROVIDER_CAPABILITIES[template] || IMAGE_PROVIDER_CAPABILITIES['openai-images'];
    const normalized = normalizeRequestedGenerationMode(requested);
    if (capabilities.supportedModes.includes(normalized)) {
        return normalized;
    }
    return 'text-to-image';
}

function normalizeEndpoint(endpoint: string, suffix?: string): string {
    const base = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!suffix) return base;
    return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function normalizeEndpointOrigin(endpoint: string): string {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) return '';
    try {
        const url = new URL(normalized);
        return `${url.protocol}//${url.host}`;
    } catch {
        return normalized;
    }
}

function resolveOpenAiImagesEndpoint(endpoint: string): string {
    const base = normalizeEndpoint(endpoint);
    if (base.includes('/images/generations')) return base;
    return normalizeEndpoint(base, '/images/generations');
}

function resolveOpenAiImageEditsEndpoint(endpoint: string): string {
    const base = normalizeEndpoint(endpoint);
    if (base.includes('/images/edits')) return base;
    return normalizeEndpoint(base, '/images/edits');
}

function isOfficialOpenAiEndpoint(endpoint: string): boolean {
    const base = normalizeEndpoint(endpoint);
    if (!base) return false;
    try {
        const url = new URL(base);
        const host = String(url.hostname || '').toLowerCase();
        return host === 'api.openai.com';
    } catch {
        return false;
    }
}

function resolvePreferredOpenAiResponseFormat(endpoint: string): 'b64_json' | 'url' {
    // For third-party OpenAI-compatible gateways, URL response is usually lighter and
    // significantly reduces timeout risk compared with large base64 payloads.
    return isOfficialOpenAiEndpoint(endpoint) ? 'b64_json' : 'url';
}

function defaultAuthHeaders(apiKey: string): Record<string, string> {
    const token = String(apiKey || '').trim();
    return {
        Authorization: `Bearer ${token}`,
        'mj-api-secret': token,
        'X-API-KEY': token,
    };
}

function createOpenAiSdkClient(endpoint: string, apiKey: string): any {
    // Keep runtime dependency dynamic to avoid ESM/CJS edge-cases in electron main bundling.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenAI = require('openai').default;
    return new OpenAI({
        apiKey: String(apiKey || '').trim(),
        baseURL: normalizeEndpoint(endpoint),
        timeout: resolveImageRequestTimeoutMs(),
        maxRetries: 0,
    });
}

async function createOpenAiUploadable(raw: string): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toFile } = require('openai');
    const reference = await readReferenceImageForMultipart(raw);
    const buffer = Buffer.from(await reference.blob.arrayBuffer());
    return toFile(buffer, reference.filename, { type: reference.blob.type || 'image/png' });
}

function detectGeminiApiVersionFromEndpoint(endpoint: string): 'v1' | 'v1beta' {
    const normalized = normalizeEndpoint(endpoint).toLowerCase();
    if (normalized.includes('/v1/') || normalized.endsWith('/v1')) {
        return 'v1';
    }
    return 'v1beta';
}

function resolveGeminiSdkBaseUrl(endpoint: string): string | undefined {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) return undefined;
    try {
        const url = new URL(normalized);
        return `${url.protocol}//${url.host}`;
    } catch {
        return undefined;
    }
}

function isOfficialGeminiEndpoint(endpoint: string): boolean {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) return false;
    try {
        const host = String(new URL(normalized).hostname || '').toLowerCase();
        return host === 'generativelanguage.googleapis.com' || host.endsWith('.googleapis.com');
    } catch {
        return false;
    }
}

function createGeminiSdkClient(endpoint: string, apiKey: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GoogleGenAI } = require('@google/genai');
    const baseUrl = resolveGeminiSdkBaseUrl(endpoint);
    const options: Record<string, unknown> = {
        apiKey: String(apiKey || '').trim(),
        apiVersion: detectGeminiApiVersionFromEndpoint(endpoint),
        httpOptions: {
            timeout: resolveImageRequestTimeoutMs(),
            retryOptions: {
                attempts: 1,
            },
            ...(baseUrl ? { baseUrl } : {}),
        },
    };
    return new GoogleGenAI(options);
}

function buildGeminiContentParts(prompt: string, refs: string[]): Array<Record<string, unknown>> {
    const parts: Array<Record<string, unknown>> = [];
    for (const ref of refs) {
        const decoded = decodeDataUrl(ref);
        if (decoded) {
            parts.push({
                inlineData: {
                    mimeType: decoded.mimeType,
                    data: decoded.base64,
                },
            });
            continue;
        }
        if (isHttpUrl(ref)) {
            parts.push({
                fileData: {
                    mimeType: 'image/png',
                    fileUri: ref,
                },
            });
        }
    }
    parts.push({ text: prompt });
    return parts;
}

function inferAspectRatioFromSize(size?: string): ImageAspectRatio | undefined {
    const parsed = parseWxH(normalizeImageSize(size));
    if (!parsed) return undefined;
    const ratio = parsed.width / parsed.height;
    const candidates: Array<{ aspect: ImageAspectRatio; value: number }> = [
        { aspect: '1:1', value: 1 },
        { aspect: '3:4', value: 3 / 4 },
        { aspect: '4:3', value: 4 / 3 },
        { aspect: '9:16', value: 9 / 16 },
        { aspect: '16:9', value: 16 / 9 },
    ];
    let best: ImageAspectRatio | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const delta = Math.abs(ratio - candidate.value);
        if (delta < bestDelta) {
            best = candidate.aspect;
            bestDelta = delta;
        }
    }
    return bestDelta <= 0.04 ? best : undefined;
}

function isSizeCompatibleWithAspectRatio(size: string | undefined, aspectRatio?: ImageAspectRatio): boolean {
    if (!size) return false;
    if (!aspectRatio || aspectRatio === 'auto') return true;
    return inferAspectRatioFromSize(size) === aspectRatio;
}

function resolveDefaultSizeForAspectRatio(aspectRatio?: ImageAspectRatio): string {
    if (!aspectRatio || aspectRatio === 'auto') {
        return OPENAI_SQUARE_SIZE;
    }
    return DEFAULT_SIZE_BY_ASPECT[aspectRatio] || OPENAI_SQUARE_SIZE;
}

function mapAspectRatioToOpenAiSize(aspectRatio?: ImageAspectRatio, preferredSize?: string): string {
    const normalizedSize = normalizeImageSize(preferredSize);
    if (normalizedSize && isSizeCompatibleWithAspectRatio(normalizedSize, aspectRatio)) {
        return normalizedSize;
    }
    return resolveDefaultSizeForAspectRatio(aspectRatio);
}

function isSeedreamModel(model?: string): boolean {
    const normalized = String(model || '').trim().toLowerCase();
    return normalized.includes('seedream');
}

function parseWxH(size: string): { width: number; height: number } | null {
    const matched = String(size || '').trim().match(/^(\d{2,5})x(\d{2,5})$/i);
    if (!matched) return null;
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return { width, height };
}

function roundUpToStep(value: number, step = SIZE_STEP): number {
    return Math.ceil(value / step) * step;
}

function clampSizeEdge(value: number): number {
    return Math.min(4096, Math.max(1024, Math.round(value)));
}

function enforceMinPixelsForModel(size: string, model?: string): string {
    if (!isSeedreamModel(model)) {
        return size;
    }
    const parsed = parseWxH(size);
    if (!parsed) {
        return '2048x2048';
    }
    const currentPixels = parsed.width * parsed.height;
    if (currentPixels >= SEEDREAM_MIN_PIXELS) {
        return size;
    }
    const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / currentPixels);
    const width = clampSizeEdge(roundUpToStep(parsed.width * scale));
    const height = clampSizeEdge(roundUpToStep(parsed.height * scale));
    return `${width}x${height}`;
}

function enforceMinPixels(size: string, minPixels: number): string {
    const normalizedMinPixels = Number.isFinite(minPixels) ? Math.max(1, Math.floor(minPixels)) : 0;
    if (!normalizedMinPixels) return size;
    const parsed = parseWxH(size);
    if (!parsed) {
        const edge = clampSizeEdge(roundUpToStep(Math.sqrt(normalizedMinPixels)));
        return `${edge}x${edge}`;
    }
    const currentPixels = parsed.width * parsed.height;
    if (currentPixels >= normalizedMinPixels) {
        return size;
    }
    const scale = Math.sqrt(normalizedMinPixels / currentPixels);
    let width = clampSizeEdge(roundUpToStep(parsed.width * scale));
    let height = clampSizeEdge(roundUpToStep(parsed.height * scale));
    if (width * height < normalizedMinPixels) {
        const retryScale = Math.sqrt(normalizedMinPixels / Math.max(1, width * height));
        width = clampSizeEdge(roundUpToStep(width * retryScale));
        height = clampSizeEdge(roundUpToStep(height * retryScale));
    }
    return `${width}x${height}`;
}

function extractMinimumPixelConstraint(errorText: string): number | null {
    const raw = String(errorText || '').trim();
    if (!raw) return null;
    const candidates: string[] = [raw];
    try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        const message = String(parsed?.error?.message || parsed?.message || '').trim();
        if (message) candidates.push(message);
    } catch {
        // ignore non-json payload
    }
    for (const candidate of candidates) {
        const normalized = candidate.replace(/[,_]/g, '');
        const match = normalized.match(/at least\s+(\d{5,})\s*pixels?/i);
        if (match?.[1]) {
            const parsedValue = Number.parseInt(match[1], 10);
            if (Number.isFinite(parsedValue) && parsedValue > 0) {
                return parsedValue;
            }
        }
    }
    return null;
}

function resolveOpenAiSizeForRequest(request: ImageGenerationRequest): string {
    const baseSize = mapAspectRatioToOpenAiSize(request.aspectRatio, request.size);
    const adjusted = enforceMinPixelsForModel(baseSize, request.model);
    if (adjusted !== baseSize) {
        logImageGenDebug('openai-size', 'adjust_for_model_constraint', {
            model: request.model,
            baseSize,
            adjustedSize: adjusted,
            minPixels: SEEDREAM_MIN_PIXELS,
        });
    }
    return adjusted;
}

function mapAspectRatioToGemini(aspectRatio?: ImageAspectRatio, preferredSize?: string): string {
    if (aspectRatio && aspectRatio !== 'auto') {
        return aspectRatio;
    }
    return inferAspectRatioFromSize(preferredSize) || '1:1';
}

function mapAspectRatioToJimengRatio(aspectRatio?: ImageAspectRatio, preferredSize?: string): string {
    return mapAspectRatioToGemini(aspectRatio, preferredSize);
}

function mapQualityToOpenAi(quality?: string): string | undefined {
    const normalized = String(quality || '').trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'standard') return 'standard';
    if (normalized === 'hd') return 'hd';
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'auto') {
        return normalized;
    }
    return normalized;
}

function mapQualityToJimengResolution(quality?: string): string {
    const normalized = String(quality || '').trim().toLowerCase();
    if (normalized === 'high' || normalized === 'hd') return '4k';
    if (normalized === 'medium') return '2k';
    if (normalized === 'low') return '1k';
    return '2k';
}

function mapSizeToNativeTier(size?: string, quality?: string): '1K' | '2K' | '4K' {
    const normalizedQuality = String(quality || '').trim().toLowerCase();
    if (normalizedQuality === 'high' || normalizedQuality === 'hd') return '4K';
    const normalizedSize = normalizeImageSize(size).toLowerCase();
    if (normalizedSize.includes('1536') || normalizedSize.includes('2048') || normalizedSize.includes('2k')) {
        return '2K';
    }
    return '1K';
}

function mapSizeToDashScope(size?: string, aspectRatio?: ImageAspectRatio): string {
    const normalizedSize = normalizeImageSize(size);
    if (normalizedSize && isSizeCompatibleWithAspectRatio(normalizedSize, aspectRatio)) {
        return normalizedSize.replace('x', '*');
    }
    const normalized = String(size || '').trim().toLowerCase();
    if (normalized === '1k') return '1024*1024';
    if (normalized === '2k') return '2048*2048';
    if (normalized === '4k') return '4096*4096';
    return resolveDefaultSizeForAspectRatio(aspectRatio).replace('x', '*');
}

function mapSizeToDashscopeWanInterleave(size?: string, aspectRatio?: ImageAspectRatio): string {
    const normalizedSize = normalizeImageSize(size);
    if (normalizedSize && isSizeCompatibleWithAspectRatio(normalizedSize, aspectRatio)) {
        return normalizedSize.replace('x', '*');
    }
    return resolveDefaultSizeForAspectRatio(aspectRatio).replace('x', '*');
}

function toDashscopeImageValue(raw: string, mode: 'data-url' | 'raw-base64'): string {
    if (mode === 'data-url') return raw;
    const decoded = decodeDataUrl(raw);
    return decoded?.base64 || raw;
}

function pickReferenceImages(request: ImageGenerationRequest, max = 4): string[] {
    const list = Array.isArray(request.referenceImages) ? request.referenceImages : [];
    return list
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, Math.max(0, max));
}

function isHttpUrl(raw: string): boolean {
    return /^https?:\/\//i.test(String(raw || '').trim());
}

function isLocalFileLikeReference(raw: string): boolean {
    const value = String(raw || '').trim();
    if (!value) return false;
    return isLocalAssetSource(value) || isAbsolute(value);
}

function guessMimeTypeFromPath(filePath: string): string {
    const ext = extname(String(filePath || '')).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.bmp') return 'image/bmp';
    return 'image/png';
}

function resolveLocalReferencePath(raw: string): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    try {
        return normalize(resolveAssetSourceToPath(value));
    } catch {
        return null;
    }
}

async function normalizeReferenceImageInput(raw: string): Promise<string> {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (decodeDataUrl(value)) return value;
    if (isHttpUrl(value)) return value;
    if (!isLocalFileLikeReference(value)) return value;

    const localPath = resolveLocalReferencePath(value);
    if (!localPath) {
        throw new Error(`Invalid local reference image path: ${value}`);
    }
    const buffer = await fs.readFile(localPath);
    const mimeType = guessMimeTypeFromPath(localPath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function normalizeReferenceImagesForTransport(referenceImages: string[]): Promise<string[]> {
    const normalized: string[] = [];
    for (const item of referenceImages) {
        const next = await normalizeReferenceImageInput(item);
        if (next) normalized.push(next);
    }
    return normalized;
}

function decodeDataUrl(raw: string): { mimeType: string; base64: string } | null {
    const value = String(raw || '').trim();
    const match = value.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) return null;
    return {
        mimeType: match[1] || 'image/png',
        base64: match[2] || '',
    };
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function logImageGenApiFailure(response: Response, errorText: string): void {
    const payload = {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        response: String(errorText || ''),
    };
    console.error(`[image-gen][api-failure] ${safeJsonStringify(payload)}`);
}

function logImageGenSdkFailure(scope: string, error: unknown, extra?: Record<string, unknown>): void {
    const err = (error && typeof error === 'object') ? (error as Record<string, any>) : {};
    const payload: Record<string, unknown> = {
        scope,
        name: err.name || undefined,
        message: err.message || String(error),
        status: err.status || err.statusCode || undefined,
        code: err.code || undefined,
        type: err.type || err?.error?.type || undefined,
        rawError: err?.error || undefined,
        ...(extra || {}),
    };
    console.error(`[image-gen][sdk-failure] ${safeJsonStringify(payload)}`);
}

function ensureSuccess(response: Response, errorText: string): void {
    if (response.ok) return;
    logImageGenApiFailure(response, errorText);
    throw new Error(errorText);
}

const RETRYABLE_OPENAI_IMAGE_UNKNOWN_PARAMS = new Set([
    'response_format',
    'quality',
    'size',
    'n',
    'background',
    'output_format',
    'style',
]);
const RETRYABLE_OPENAI_IMAGE_INVALID_VALUE_PARAMS = new Set([
    'quality',
    'response_format',
    'size',
    'style',
]);

function extractUnknownParameterFromError(errorText: string): string | null {
    const raw = String(errorText || '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        const directParam = String(parsed?.error?.param || '').trim();
        if (directParam) return directParam.toLowerCase();
        const message = String(parsed?.error?.message || parsed?.message || '').trim();
        if (message) {
            const msgMatch = message.match(/unknown parameter:\s*['"]?([a-zA-Z0-9_.-]+)['"]?/i);
            if (msgMatch?.[1]) return msgMatch[1].toLowerCase();
        }
    } catch {
        // ignore json parse error
    }
    const match = raw.match(/unknown parameter:\s*['"]?([a-zA-Z0-9_.-]+)['"]?/i);
    if (match?.[1]) return match[1].toLowerCase();
    return null;
}

function resolveRetryableUnknownParam(errorText: string, removed: Set<string>): string | null {
    const param = extractUnknownParameterFromError(errorText);
    if (!param) return null;
    if (removed.has(param)) return null;
    if (!RETRYABLE_OPENAI_IMAGE_UNKNOWN_PARAMS.has(param)) return null;
    return param;
}

function extractInvalidValueParameterFromError(errorText: string): string | null {
    const raw = String(errorText || '').trim();
    if (!raw) return null;
    let message = raw;
    let directParam = '';
    try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        directParam = String(parsed?.error?.param || parsed?.param || '').trim().toLowerCase();
        message = String(parsed?.error?.message || parsed?.message || raw).trim();
    } catch {
        // non-json error string
    }

    if (directParam) {
        return directParam;
    }

    const lower = message.toLowerCase();
    if (
        lower.includes("invalid value: 'standard'") ||
        (lower.includes('supported values') && lower.includes("'low'") && lower.includes("'medium'") && lower.includes("'high'") && lower.includes("'auto'"))
    ) {
        return 'quality';
    }
    if (
        lower.includes('response_format') ||
        (lower.includes('supported values') && lower.includes("'url'") && lower.includes("'b64_json'"))
    ) {
        return 'response_format';
    }
    if (
        lower.includes('size') &&
        (
            lower.includes('1024x1024') ||
            lower.includes('1536x1024') ||
            lower.includes('1024x1536') ||
            lower.includes('parameter `size`') ||
            lower.includes('parameter "size"') ||
            lower.includes('parameter size')
        )
    ) {
        return 'size';
    }
    if (lower.includes('style') && (lower.includes('vivid') || lower.includes('natural'))) {
        return 'style';
    }
    return null;
}

function resolveRetryableInvalidValueParam(errorText: string, removed: Set<string>): string | null {
    const param = extractInvalidValueParameterFromError(errorText);
    if (!param) return null;
    if (removed.has(param)) return null;
    if (!RETRYABLE_OPENAI_IMAGE_INVALID_VALUE_PARAMS.has(param)) return null;
    return param;
}

function extractSdkErrorInfo(error: unknown): { status: number; message: string } {
    const err = (error && typeof error === 'object') ? (error as Record<string, any>) : {};
    const status = Number(err.status || err.statusCode || err.code || 0) || 0;
    const message = String(
        err?.error?.message ||
        err?.message ||
        err?.cause?.message ||
        error ||
        'Unknown error'
    ).trim();
    return { status, message };
}

function shouldFallbackEditToGeneration(status: number, message: string): boolean {
    if (status !== 400) return false;
    const text = String(message || '').toLowerCase();
    return (
        text.includes('no body') ||
        text.includes('unexpected field') ||
        text.includes('invalid url') ||
        text.includes('invalid_request_error')
    );
}

async function tryOpenAiGenerationFallbackWithReferences(args: {
    request: ImageGenerationRequest;
    refs: string[];
    size: string;
    quality?: string;
    preferredResponseFormat: 'b64_json' | 'url';
    removedParams: Set<string>;
}): Promise<GeneratedImageOutput[]> {
    const endpoint = resolveOpenAiImagesEndpoint(args.request.endpoint);
    const baseBody: Record<string, unknown> = {};
    if (!args.removedParams.has('model')) {
        baseBody.model = args.request.model;
    }
    if (!args.removedParams.has('prompt')) {
        baseBody.prompt = args.request.prompt;
    }
    if (!args.removedParams.has('n')) {
        baseBody.n = Math.max(1, args.request.count || 1);
    }
    if (!args.removedParams.has('size')) {
        baseBody.size = args.size;
    }
    if (args.quality && !args.removedParams.has('quality')) {
        baseBody.quality = args.quality;
    }
    if (!args.removedParams.has('response_format')) {
        baseBody.response_format = args.preferredResponseFormat;
    }

    const payloadVariants: Array<{ name: string; payload: Record<string, unknown> }> = [];
    if (args.refs.length > 0) {
        payloadVariants.push({
            name: 'images-array',
            payload: {
                ...baseBody,
                images: args.refs,
            },
        });
    }
    if (args.refs.length > 0) {
        payloadVariants.push({
            name: 'image-single',
            payload: {
                ...baseBody,
                image: args.refs[0],
            },
        });
    }
    payloadVariants.push({
        name: 'text-only',
        payload: {
            ...baseBody,
        },
    });

    let lastError = '';
    let lastStatus = 0;
    for (const variant of payloadVariants) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${args.request.apiKey}`,
            },
            body: JSON.stringify(variant.payload),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            lastStatus = response.status;
            lastError = errorText || response.statusText || `HTTP ${response.status}`;
            logImageGenDebug('openai-images', 'edit_fallback_variant_failed', {
                endpoint,
                variant: variant.name,
                status: response.status,
                statusText: response.statusText,
                errorText: String(errorText || ''),
            });
            continue;
        }
        const payload = await parseJsonSafe(response);
        const outputs = await normalizeGeneratedImages(payload);
        if (outputs.length > 0) {
            logImageGenDebug('openai-images', 'edit_fallback_variant_succeeded', {
                endpoint,
                variant: variant.name,
                outputCount: outputs.length,
            });
            return outputs;
        }
        lastError = `Fallback variant ${variant.name} returned no image payload`;
    }
    throw new Error(`Image generation fallback failed (${lastStatus || 'unknown'}): ${lastError || 'no successful response'}`);
}

async function parseJsonSafe(response: Response): Promise<any> {
    const raw = await response.text().catch(() => '');
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return { raw };
    }
}

async function fetchImageByUrl(url: string): Promise<GeneratedImageOutput> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch generated image URL: ${response.status} ${response.statusText}`);
    }
    const mimeType = response.headers.get('content-type') || 'image/png';
    const imageBuffer = Buffer.from(await response.arrayBuffer());
    return { imageBuffer, mimeType };
}

async function readReferenceImageForMultipart(raw: string): Promise<{ blob: Blob; filename: string }> {
    const decoded = decodeDataUrl(raw);
    if (decoded) {
        const ext = decoded.mimeType.includes('jpeg')
            ? 'jpg'
            : decoded.mimeType.includes('webp')
                ? 'webp'
                : decoded.mimeType.includes('gif')
                    ? 'gif'
                    : 'png';
        const buffer = Buffer.from(decoded.base64, 'base64');
        return {
            blob: new Blob([buffer], { type: decoded.mimeType || 'image/png' }),
            filename: `reference.${ext}`,
        };
    }
    const response = await fetch(raw);
    if (!response.ok) {
        throw new Error(`Failed to fetch reference image: ${response.status} ${response.statusText}`);
    }
    const mimeType = response.headers.get('content-type') || 'image/png';
    const ext = mimeType.includes('jpeg')
        ? 'jpg'
        : mimeType.includes('webp')
            ? 'webp'
            : mimeType.includes('gif')
                ? 'gif'
                : 'png';
    return {
        blob: new Blob([Buffer.from(await response.arrayBuffer())], { type: mimeType }),
        filename: `reference.${ext}`,
    };
}

function pushBase64(outputs: GeneratedImageOutput[], raw: unknown, mimeType?: unknown): void {
    const value = String(raw || '').trim();
    if (!value) return;
    outputs.push({
        imageBuffer: Buffer.from(value, 'base64'),
        mimeType: String(mimeType || 'image/png'),
    });
}

async function normalizeGeneratedImages(payload: any): Promise<GeneratedImageOutput[]> {
    const outputs: GeneratedImageOutput[] = [];

    const readDataArray = async (items: any[]) => {
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (typeof item.b64_json === 'string') {
                pushBase64(outputs, item.b64_json, item.mime_type || item.mimeType);
                continue;
            }
            if (typeof item.base64 === 'string') {
                pushBase64(outputs, item.base64, item.mime_type || item.mimeType);
                continue;
            }
            if (typeof item.image_base64 === 'string') {
                pushBase64(outputs, item.image_base64, item.mime_type || item.mimeType);
                continue;
            }
            if (typeof item.b64_image === 'string') {
                pushBase64(outputs, item.b64_image, item.mime_type || item.mimeType);
                continue;
            }
            const imageUrl = String(item.url || item.imageUrl || item.image_url || '').trim();
            if (imageUrl) {
                outputs.push(await fetchImageByUrl(imageUrl));
            }
        }
    };

    if (Array.isArray(payload?.data)) {
        await readDataArray(payload.data);
    }
    if (Array.isArray(payload?.output?.results)) {
        await readDataArray(payload.output.results);
    }
    if (Array.isArray(payload?.generatedImages)) {
        for (const item of payload.generatedImages) {
            const image = item?.image;
            if (!image || typeof image !== 'object') continue;
            pushBase64(outputs, image.imageBytes, image.mimeType || image.mime_type || 'image/png');
            const imageUrl = String(image.gcsUri || image.uri || image.url || '').trim();
            if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
                outputs.push(await fetchImageByUrl(imageUrl));
            }
        }
    }
    const outputChoices = Array.isArray(payload?.output?.choices) ? payload.output.choices : [];
    for (const choice of outputChoices) {
        const messageContent = Array.isArray(choice?.message?.content) ? choice.message.content : [];
        for (const item of messageContent) {
            if (!item || typeof item !== 'object') continue;
            const imageValue = String((item as any).image || '').trim();
            if (!imageValue) continue;
            if (/^https?:\/\//i.test(imageValue)) {
                outputs.push(await fetchImageByUrl(imageValue));
                continue;
            }
            pushBase64(outputs, imageValue, (item as any).mimeType || (item as any).mime_type || 'image/png');
        }
    }
    if (Array.isArray(payload?.output?.images)) {
        for (const image of payload.output.images) {
            if (typeof image === 'string' && image.trim()) {
                outputs.push(await fetchImageByUrl(image.trim()));
                continue;
            }
            if (image && typeof image === 'object') {
                const imageUrl = String(image.url || image.imageUrl || image.image_url || '').trim();
                if (imageUrl) {
                    outputs.push(await fetchImageByUrl(imageUrl));
                    continue;
                }
                pushBase64(outputs, image.b64_json, image.mime_type || image.mimeType);
            }
        }
    }

    if (typeof payload?.output?.image === 'string') {
        pushBase64(outputs, payload.output.image, payload.output?.mime_type || payload.output?.mimeType);
    }
    if (typeof payload?.result?.image === 'string') {
        pushBase64(outputs, payload.result.image, payload.result?.mimeType || payload.result?.mime_type);
    }
    if (typeof payload?.result?.imageBase64 === 'string') {
        pushBase64(outputs, payload.result.imageBase64, payload.result?.mimeType || payload.result?.mime_type);
    }

    const imageUrlCandidates = [
        payload?.imageUrl,
        payload?.image_url,
        payload?.url,
        payload?.result?.imageUrl,
        payload?.result?.image_url,
        payload?.result?.url,
        payload?.output?.url,
        payload?.output?.image_url,
    ];
    for (const candidate of imageUrlCandidates) {
        const imageUrl = String(candidate || '').trim();
        if (!imageUrl) continue;
        outputs.push(await fetchImageByUrl(imageUrl));
    }

    if (Array.isArray(payload?.predictions)) {
        for (const prediction of payload.predictions) {
            if (!prediction || typeof prediction !== 'object') continue;
            pushBase64(outputs, prediction.bytesBase64Encoded, prediction.mimeType || prediction.mime_type);
            pushBase64(outputs, prediction.b64_json, prediction.mimeType || prediction.mime_type);
            pushBase64(outputs, prediction.image, prediction.mimeType || prediction.mime_type);
            pushBase64(outputs, prediction.imageBase64, prediction.mimeType || prediction.mime_type);
            const imageUrl = String(prediction.url || prediction.imageUrl || prediction.image_url || '').trim();
            if (imageUrl) {
                outputs.push(await fetchImageByUrl(imageUrl));
            }
        }
    }

    const candidateParts = Array.isArray(payload?.candidates) ? payload.candidates : [];
    for (const candidate of candidateParts) {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        for (const part of parts) {
            const inlineData = part?.inlineData || part?.inline_data;
            if (inlineData && typeof inlineData.data === 'string') {
                pushBase64(outputs, inlineData.data, inlineData.mimeType || inlineData.mime_type);
            }
        }
    }

    return outputs;
}

function resolveGeminiOpenAiEndpoint(endpoint: string): string {
    const base = normalizeEndpoint(endpoint);
    if (base.includes('/images/generations')) {
        return base;
    }
    if (base.includes('/openai')) {
        return normalizeEndpoint(base, '/images/generations');
    }
    if (base.includes('generativelanguage.googleapis.com')) {
        return normalizeEndpoint(base, '/openai/images/generations');
    }
    return normalizeEndpoint(base, '/images/generations');
}

function normalizeDashScopeBaseEndpoint(endpoint: string): string {
    const base = normalizeEndpoint(endpoint);
    if (!base) return '';
    if (base.includes('/services/aigc/') || base.includes('/api/v1/tasks/')) {
        return normalizeEndpointOrigin(base);
    }
    try {
        const url = new URL(base);
        const path = (url.pathname || '').replace(/\/+$/, '');
        const markerIndexes = [
            path.indexOf('/compatible-mode/'),
            path.indexOf('/api/v1/services/'),
            path.indexOf('/api/v1/tasks/'),
            path.indexOf('/api/v1'),
            path.indexOf('/v1'),
        ].filter((index) => index >= 0);
        if (markerIndexes.length > 0) {
            const cut = Math.min(...markerIndexes);
            url.pathname = cut > 0 ? path.slice(0, cut) : '/';
        }
        url.search = '';
        url.hash = '';
        return normalizeEndpoint(url.toString());
    } catch {
        return base
            .replace(/\/compatible-mode\/v\d+(\.\d+)?(?:\/.*)?$/i, '')
            .replace(/\/api\/v1(?:\/.*)?$/i, '')
            .replace(/\/v1(?:\/.*)?$/i, '');
    }
}

function resolveDashscopeWanEndpoints(
    endpoint: string,
    model: string,
    mode: ImageGenerationMode,
    referenceCount: number
): string[] {
    const explicit = normalizeEndpoint(endpoint);
    const base = normalizeDashScopeBaseEndpoint(endpoint);
    const normalizedModel = String(model || '').trim().toLowerCase();
    const isWan26 = normalizedModel.includes('wan2.6');
    const candidates: string[] = [];
    if (explicit.includes('/services/aigc/')) {
        candidates.push(explicit);
    }
    const requireImageInput = referenceCount > 0 || mode === 'image-to-image' || mode === 'reference-guided';
    if (isWan26) {
        // Prefer the official async endpoint for wan2.6.
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/image-generation/generation'));
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/multimodal-generation/generation'));
        if (requireImageInput) {
            candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/image2image/image-synthesis'));
        }
    } else if (requireImageInput) {
        // Prefer newer unified image-generation endpoint first; many models/providers
        // reject legacy paths with InvalidParameter/url error.
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/image-generation/generation'));
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/image2image/image-synthesis'));
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/multimodal-generation/generation'));
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/text2image/image-synthesis'));
    } else {
        // Prefer newer image-generation endpoint first for better compatibility.
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/image-generation/generation'));
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/text2image/image-synthesis'));
        candidates.push(normalizeEndpoint(base, '/api/v1/services/aigc/multimodal-generation/generation'));
    }
    return Array.from(new Set(candidates.filter(Boolean)));
}

function resolveDashscopeTaskEndpoint(endpoint: string, taskId: string): string {
    const base = normalizeDashScopeBaseEndpoint(endpoint);
    return normalizeEndpoint(base, `/api/v1/tasks/${encodeURIComponent(taskId)}`);
}

function buildDashscopeWanPayloadVariants(
    request: ImageGenerationRequest,
    endpoint: string
): Array<Record<string, unknown>> {
    const normalizedEndpoint = endpoint.toLowerCase();
    const count = Math.max(1, request.count || 1);
    const refs = pickReferenceImages(request, 4);
    const refSets: string[][] = (() => {
        if (refs.length === 0) return [[]];
        const hasDataUrl = refs.some((item) => Boolean(decodeDataUrl(item)));
        if (!hasDataUrl) return [refs];
        // DashScope wan2.6 docs explicitly state `image` accepts URL or Base64 string.
        // Prefer raw base64 first; keep data-url as fallback for gateway compatibility.
        return [
            refs.map((item) => toDashscopeImageValue(item, 'raw-base64')),
            refs.map((item) => toDashscopeImageValue(item, 'data-url')),
        ];
    })();
    const mode = normalizeRequestedGenerationMode(request.generationMode);
    if (normalizedEndpoint.includes('/text2image/')) {
        return [{
            model: request.model,
            input: {
                prompt: request.prompt,
            },
            parameters: {
                n: count,
                size: mapSizeToDashScope(request.size, request.aspectRatio),
            },
        }];
    }

    if (normalizedEndpoint.includes('/image2image/')) {
        return refSets.map((currentRefs) => {
            const imageList = currentRefs.slice(0, 2);
            return {
                model: request.model,
                input: {
                    prompt: request.prompt,
                    images: imageList,
                },
                parameters: {
                    n: count,
                    size: mapSizeToDashScope(request.size, request.aspectRatio),
                },
            };
        });
    }

    if (normalizedEndpoint.includes('/image-generation/')) {
        return refSets.map((currentRefs) => {
            const content: Array<Record<string, unknown>> = [
                { text: request.prompt },
                ...currentRefs.slice(0, 4).map((image) => ({ image })),
            ];
            const interleave = currentRefs.length === 0 && mode !== 'image-to-image';
            const payload: Record<string, unknown> = {
                model: request.model,
                input: {
                    messages: [
                        {
                            role: 'user',
                            content,
                        },
                    ],
                },
                parameters: {
                    size: interleave
                        ? mapSizeToDashscopeWanInterleave(request.size, request.aspectRatio)
                        : mapSizeToDashScope(request.size, request.aspectRatio),
                    ...(interleave
                        ? { enable_interleave: true, max_images: count }
                        : { enable_interleave: false, n: count }),
                },
            };
            return payload;
        });
    }

    const variants: Array<Record<string, unknown>> = [];
    for (const currentRefs of refSets) {
        const basePayload: Record<string, unknown> = {
            model: request.model,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            ...currentRefs.map((image) => ({ image })),
                            { text: request.prompt },
                        ],
                    },
                ],
            },
            parameters: {
                n: count,
                size: mapSizeToDashScope(request.size, request.aspectRatio),
            },
        };
        const interleavePayload: Record<string, unknown> = {
            ...basePayload,
            parameters: {
                ...(basePayload.parameters as Record<string, unknown>),
                enable_interleave: true,
            },
        };
        const minimalPayload: Record<string, unknown> = {
            model: request.model,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            ...currentRefs.map((image) => ({ image })),
                            { text: request.prompt },
                        ],
                    },
                ],
            },
        };
        if (currentRefs.length > 0) {
            variants.push(basePayload, interleavePayload, minimalPayload);
        } else {
            variants.push(interleavePayload, basePayload, minimalPayload);
        }
    }
    return variants;
}

async function resolveDashscopeTaskPayload(
    endpoint: string,
    apiKey: string,
    taskId: string
): Promise<any> {
    const taskEndpoint = resolveDashscopeTaskEndpoint(endpoint, taskId);
    const maxRounds = 60;
    for (let i = 0; i < maxRounds; i += 1) {
        await delay(2000);
        const response = await fetch(taskEndpoint, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
        });
        const payload = await parseJsonSafe(response);
        if (!response.ok) {
            continue;
        }
        const status = String(
            payload?.output?.task_status ||
            payload?.output?.taskStatus ||
            payload?.output?.status ||
            payload?.status ||
            ''
        ).toLowerCase();
        const failed = status.includes('fail') || status.includes('cancel') || status.includes('error');
        if (failed) {
            const reason = String(
                payload?.output?.message ||
                payload?.output?.code ||
                payload?.message ||
                payload?.error ||
                ''
            ).trim();
            throw new Error(`DashScope task failed${reason ? `: ${reason}` : ''}`);
        }
        if (status.includes('succeed') || status.includes('success') || status.includes('done') || status.includes('finish')) {
            return payload;
        }
        const outputs = await normalizeGeneratedImages(payload);
        if (outputs.length > 0) {
            return payload;
        }
    }
    throw new Error('DashScope task timeout.');
}

function resolveJimengWrapperEndpoint(endpoint: string): string {
    const base = normalizeEndpoint(endpoint);
    if (base.includes('/images/generations')) return base;
    if (/\/v\d+(\.\d+)?$/i.test(base) || /\/v\d+(\.\d+)?\//i.test(base)) {
        return normalizeEndpoint(base, '/images/generations');
    }
    return normalizeEndpoint(base, '/v1/images/generations');
}

function resolveMidjourneySubmitEndpoints(endpoint: string): string[] {
    const base = normalizeEndpoint(endpoint);
    const candidates = [
        normalizeEndpoint(base, '/mj/submit/imagine'),
        normalizeEndpoint(base, '/midjourney/submit/imagine'),
        normalizeEndpoint(base, '/submit/imagine'),
    ];
    return Array.from(new Set(candidates));
}

function resolveMidjourneyFetchEndpoints(endpoint: string, taskId: string): string[] {
    const base = normalizeEndpoint(endpoint);
    const encoded = encodeURIComponent(taskId);
    const candidates = [
        normalizeEndpoint(base, `/mj/task/${encoded}/fetch`),
        normalizeEndpoint(base, `/midjourney/task/${encoded}/fetch`),
        normalizeEndpoint(base, `/task/${encoded}/fetch`),
    ];
    return Array.from(new Set(candidates));
}

const openAiAdapter: ImageProviderAdapter = {
    template: 'openai-images',
    supportsMultiCount: true,
    async generate(request) {
        const mode = resolveGenerationModeForTemplate('openai-images', request.generationMode);
        const refs = await normalizeReferenceImagesForTransport(
            pickReferenceImages(request, IMAGE_PROVIDER_CAPABILITIES['openai-images'].maxReferenceImages)
        );
        const useEditApi = (mode === 'image-to-image' || mode === 'reference-guided') && refs.length > 0;
        const endpoint = useEditApi
            ? resolveOpenAiImageEditsEndpoint(request.endpoint)
            : resolveOpenAiImagesEndpoint(request.endpoint);
        const preferredResponseFormat = resolvePreferredOpenAiResponseFormat(endpoint);
        const removedParams = new Set<string>();
        const maxRetryRounds = 4;
        let forcedSize = '';
        let attemptedEditFallback = false;
        let response: Response | null = null;
        let lastErrorText = '';
        const quality = mapQualityToOpenAi(request.quality);
        const client = createOpenAiSdkClient(request.endpoint, request.apiKey);
        const maxUpstreamTimeoutRetries = resolveImage524RetryCount();
        for (let i = 0; i < maxRetryRounds; i += 1) {
            const body: Record<string, unknown> = {};
            if (!removedParams.has('model')) {
                body.model = request.model;
            }
            if (!removedParams.has('prompt')) {
                body.prompt = request.prompt;
            }
            if (!removedParams.has('n')) {
                body.n = Math.max(1, request.count || 1);
            }
            if (!removedParams.has('size')) {
                body.size = forcedSize || resolveOpenAiSizeForRequest(request);
            }
            if (quality && !removedParams.has('quality')) {
                body.quality = quality;
            }
            if (!useEditApi && !removedParams.has('response_format')) {
                body.response_format = preferredResponseFormat;
            }
            if (useEditApi) {
                body.image = await Promise.all(refs.map((item) => createOpenAiUploadable(item)));
            }
            try {
                for (let attempt = 0; attempt <= maxUpstreamTimeoutRetries; attempt += 1) {
                    try {
                        const sdkResult = useEditApi
                            ? await client.images.edit(body)
                            : await client.images.generate(body);
                        return normalizeGeneratedImages(sdkResult);
                    } catch (error) {
                        logImageGenSdkFailure(useEditApi ? 'openai-images.edit' : 'openai-images.generate', error, {
                            endpoint,
                            model: request.model,
                            body: {
                                ...body,
                                ...(useEditApi ? { image: `[${refs.length} uploadable file(s)]` } : {}),
                            },
                            attempt: attempt + 1,
                        });
                        const { status, message } = extractSdkErrorInfo(error);
                        if (attempt < maxUpstreamTimeoutRetries && isLikelyUpstreamTimeoutError(status, message)) {
                            const waitMs = 1200 * (attempt + 1);
                            logImageGenDebug('openai-images', 'retry_after_upstream_timeout', {
                                endpoint,
                                model: request.model,
                                status,
                                attempt: attempt + 1,
                                maxRetries: maxUpstreamTimeoutRetries,
                                waitMs,
                                mode: useEditApi ? 'edit' : 'generate',
                            });
                            await delay(waitMs);
                            continue;
                        }
                        throw error;
                    }
                }
            } catch (error) {
                let { status, message } = extractSdkErrorInfo(error);
                lastErrorText = message;

                if (useEditApi && !attemptedEditFallback && shouldFallbackEditToGeneration(status, message)) {
                    attemptedEditFallback = true;
                    const currentSize = String(body.size || resolveOpenAiSizeForRequest(request));
                    try {
                        logImageGenDebug('openai-images', 'edit_fallback_to_generation', {
                            model: request.model,
                            endpoint: resolveOpenAiImagesEndpoint(request.endpoint),
                            refs: refs.length,
                            size: currentSize,
                        });
                        const outputs = await tryOpenAiGenerationFallbackWithReferences({
                            request,
                            refs,
                            size: currentSize,
                            quality,
                            preferredResponseFormat,
                            removedParams,
                        });
                        return outputs;
                    } catch (fallbackError) {
                        const fallbackInfo = extractSdkErrorInfo(fallbackError);
                        status = fallbackInfo.status || status;
                        message = fallbackInfo.message || message;
                        lastErrorText = message;
                    }
                }

                if (!removedParams.has('size')) {
                    const minPixels = extractMinimumPixelConstraint(message);
                    if (minPixels) {
                        const currentSize = String(body.size || '');
                        const adjustedSize = enforceMinPixels(currentSize, minPixels);
                        if (adjustedSize && adjustedSize !== currentSize) {
                            forcedSize = adjustedSize;
                            logImageGenDebug('openai-images', 'retry_with_resized_size', {
                                endpoint,
                                model: request.model,
                                baseSize: currentSize,
                                adjustedSize,
                                minPixels,
                                round: i + 1,
                                mode: useEditApi ? 'edit' : 'generate',
                            });
                            continue;
                        }
                    }
                }
                const retryParam = resolveRetryableUnknownParam(message, removedParams);
                if (retryParam) {
                    removedParams.add(retryParam);
                    logImageGenDebug('openai-images', 'retry_without_unknown_param', {
                        endpoint,
                        removedParam: retryParam,
                        round: i + 1,
                        via: 'openai-sdk',
                        mode: useEditApi ? 'edit' : 'generate',
                    });
                    continue;
                }
                const invalidValueParam = resolveRetryableInvalidValueParam(message, removedParams);
                if (invalidValueParam) {
                    removedParams.add(invalidValueParam);
                    logImageGenDebug('openai-images', 'retry_without_invalid_value_param', {
                        endpoint,
                        removedParam: invalidValueParam,
                        round: i + 1,
                        via: 'openai-sdk',
                        mode: useEditApi ? 'edit' : 'generate',
                    });
                    continue;
                }
                if (status === 524 || /receive timeout from origin/i.test(message)) {
                    throw new Error(
                        `Image generation failed (524): Receive timeout from origin. ` +
                        `上游网关超时，任务可能已在供应商侧执行成功。Raw: ${message}`
                    );
                }
                throw new Error(`Image generation failed (${status || 'unknown'}): ${message}`);
            }
        }

        throw new Error(`Image generation failed (${useEditApi ? 'edit' : 'generate'}): ${lastErrorText || 'no successful SDK response'}`);
    },
};

const geminiOpenAiAdapter: ImageProviderAdapter = {
    template: 'gemini-openai-images',
    supportsMultiCount: true,
    async generate(request) {
        if (isOfficialGeminiEndpoint(request.endpoint)) {
            const normalizedModel = String(request.model || '').trim().toLowerCase();
            if (normalizedModel.includes('imagen')) {
                return geminiImagenNativeAdapter.generate({
                    ...request,
                    providerTemplate: 'gemini-imagen-native',
                });
            }
            return geminiGenerateContentAdapter.generate({
                ...request,
                providerTemplate: 'gemini-generate-content',
            });
        }

        let forcedSize = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch(resolveGeminiOpenAiEndpoint(request.endpoint), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${request.apiKey}`,
                },
                body: JSON.stringify({
                    model: request.model,
                    prompt: request.prompt,
                    n: Math.max(1, request.count || 1),
                    size: forcedSize || resolveOpenAiSizeForRequest(request),
                    response_format: 'b64_json',
                }),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                const minPixels = extractMinimumPixelConstraint(errorText);
                if (minPixels) {
                    const currentSize = forcedSize || resolveOpenAiSizeForRequest(request);
                    const adjustedSize = enforceMinPixels(currentSize, minPixels);
                    if (adjustedSize !== currentSize) {
                        forcedSize = adjustedSize;
                        logImageGenDebug('gemini-openai-images', 'retry_with_resized_size', {
                            endpoint: request.endpoint,
                            model: request.model,
                            baseSize: currentSize,
                            adjustedSize,
                            minPixels,
                            attempt: attempt + 1,
                        });
                        continue;
                    }
                }
                ensureSuccess(response, `Gemini OpenAI image generation failed (${response.status}): ${errorText || response.statusText}`);
            }

            return normalizeGeneratedImages(await response.json());
        }
        throw new Error('Gemini OpenAI image generation failed: cannot satisfy size constraint.');
    },
};

const geminiGenerateContentAdapter: ImageProviderAdapter = {
    template: 'gemini-generate-content',
    supportsMultiCount: false,
    async generate(request) {
        const mode = resolveGenerationModeForTemplate('gemini-generate-content', request.generationMode);
        const refs = await normalizeReferenceImagesForTransport(
            pickReferenceImages(request, IMAGE_PROVIDER_CAPABILITIES['gemini-generate-content'].maxReferenceImages)
        );
        if (isOfficialGeminiEndpoint(request.endpoint)) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Modality } = require('@google/genai');
            const client = createGeminiSdkClient(request.endpoint, request.apiKey);
            try {
                const sdkResponse = await client.models.generateContent({
                    model: request.model,
                    contents: [
                        {
                            role: 'user',
                            parts: buildGeminiContentParts(request.prompt, mode === 'text-to-image' ? [] : refs),
                        },
                    ],
                    config: {
                        responseModalities: [Modality.TEXT, Modality.IMAGE],
                        imageConfig: {
                            aspectRatio: mapAspectRatioToGemini(request.aspectRatio, request.size),
                        },
                    },
                });
                return normalizeGeneratedImages(sdkResponse);
            } catch (error) {
                logImageGenSdkFailure('gemini-generate-content.generateContent', error, {
                    endpoint: request.endpoint,
                    model: request.model,
                });
                throw error;
            }
        }

        const parts = buildGeminiContentParts(request.prompt, mode === 'text-to-image' ? [] : refs);
        const endpoint = normalizeEndpoint(
            request.endpoint,
            `/models/${encodeURIComponent(request.model)}:generateContent`
        );
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': request.apiKey,
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts,
                    },
                ],
                generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    imageConfig: {
                        aspectRatio: mapAspectRatioToGemini(request.aspectRatio, request.size),
                    },
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            ensureSuccess(response, `Gemini generateContent image failed (${response.status}): ${errorText || response.statusText}`);
        }

        return normalizeGeneratedImages(await response.json());
    },
};

const geminiImagenNativeAdapter: ImageProviderAdapter = {
    template: 'gemini-imagen-native',
    supportsMultiCount: true,
    async generate(request) {
        const normalizedModel = String(request.model || '').trim().toLowerCase();
        const officialGeminiEndpoint = isOfficialGeminiEndpoint(request.endpoint);

        // If user selected a Gemini image/chat-image model under Imagen template,
        // auto-route to Gemini generateContent image flow to avoid protocol mismatch.
        if (normalizedModel.includes('gemini') && !normalizedModel.includes('imagen')) {
            return geminiGenerateContentAdapter.generate({
                ...request,
                providerTemplate: 'gemini-generate-content',
            });
        }

        // Non-official Gemini endpoints are commonly OpenAI-compatible gateways.
        // Route to Gemini OpenAI-compatible adapter instead of Imagen native predict.
        if (!officialGeminiEndpoint) {
            return geminiOpenAiAdapter.generate({
                ...request,
                providerTemplate: 'gemini-openai-images',
            });
        }

        if (isOfficialGeminiEndpoint(request.endpoint)) {
            const client = createGeminiSdkClient(request.endpoint, request.apiKey);
            try {
                const sdkResponse = await client.models.generateImages({
                    model: request.model,
                    prompt: request.prompt,
                    config: {
                        numberOfImages: Math.max(1, request.count || 1),
                        imageSize: mapSizeToNativeTier(request.size, request.quality),
                        aspectRatio: mapAspectRatioToGemini(request.aspectRatio, request.size),
                        includeRaiReason: true,
                    },
                });
                const sdkOutputs = await normalizeGeneratedImages(sdkResponse);
                if (sdkOutputs.length > 0) {
                    return sdkOutputs;
                }
            } catch (error) {
                logImageGenSdkFailure('gemini-imagen-native.generateImages', error, {
                    endpoint: request.endpoint,
                    model: request.model,
                });
                throw error;
            }
        }

        // Fallback to raw REST when SDK response shape does not contain image bytes.
        const base = normalizeEndpoint(request.endpoint);
        const endpoint = base.includes(':predict')
            ? base
            : normalizeEndpoint(base, `/models/${encodeURIComponent(request.model)}:predict`);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': request.apiKey,
            },
            body: JSON.stringify({
                instances: [{ prompt: request.prompt }],
                parameters: {
                    sampleCount: Math.max(1, request.count || 1),
                    imageSize: mapSizeToNativeTier(request.size, request.quality),
                    aspectRatio: mapAspectRatioToGemini(request.aspectRatio, request.size),
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            ensureSuccess(response, `Gemini Imagen native generation failed (${response.status}): ${errorText || response.statusText}`);
        }

        return normalizeGeneratedImages(await response.json());
    },
};

const dashscopeWanAdapter: ImageProviderAdapter = {
    template: 'dashscope-wan-native',
    supportsMultiCount: true,
    async generate(request) {
        const mode = resolveGenerationModeForTemplate('dashscope-wan-native', request.generationMode);
        const refs = await normalizeReferenceImagesForTransport(
            pickReferenceImages(request, IMAGE_PROVIDER_CAPABILITIES['dashscope-wan-native'].maxReferenceImages)
        );
        const endpoints = resolveDashscopeWanEndpoints(request.endpoint, request.model, mode, refs.length);
        const attemptedEndpoints: string[] = [];
        let finalError = '';
        for (const endpoint of endpoints) {
            attemptedEndpoints.push(endpoint);
            const payloadVariants = buildDashscopeWanPayloadVariants({
                ...request,
                generationMode: mode,
                referenceImages: refs,
            }, endpoint);
            for (let i = 0; i < payloadVariants.length; i += 1) {
                try {
                    const isAsyncEndpoint = endpoint.includes('/text2image/') || endpoint.includes('/image-generation/') || endpoint.includes('/image2image/');
                    const isMultimodalEndpoint = endpoint.includes('/multimodal-generation/');
                    logImageGenDebug('dashscope', 'request:start', {
                        endpoint,
                        variantIndex: i,
                        isAsyncEndpoint,
                        isMultimodalEndpoint,
                        mode,
                        referenceCount: refs.length,
                        referenceScheme: refs.map((ref) => decodeDataUrl(ref) ? 'data-url' : (isHttpUrl(ref) ? 'http-url' : 'unknown')).join(','),
                    });
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${request.apiKey}`,
                            ...(isAsyncEndpoint ? { 'X-DashScope-Async': 'enable' } : {}),
                            ...(isMultimodalEndpoint ? { 'X-DashScope-SSE': 'enable' } : {}),
                        },
                        body: JSON.stringify(payloadVariants[i]),
                    });
                    logImageGenDebug('dashscope', 'request:response', {
                        endpoint,
                        variantIndex: i,
                        status: response.status,
                        ok: response.ok,
                    });

                    if (!response.ok) {
                        const errorText = await response.text().catch(() => '');
                        logImageGenDebug('dashscope', 'request:error-response', {
                            endpoint,
                            variantIndex: i,
                            status: response.status,
                            body: (errorText || response.statusText).slice(0, 600),
                        });
                        finalError = `DashScope Wan generation failed (${response.status}): ${errorText || response.statusText}`;
                        if (response.status === 404 || response.status === 405) {
                            continue;
                        }
                        if (response.status >= 400 && response.status < 500) {
                            continue;
                        }
                        ensureSuccess(response, finalError);
                    }

                    let payload = await parseJsonSafe(response);
                    const taskId = String(
                        payload?.output?.task_id ||
                        payload?.output?.taskId ||
                        payload?.task_id ||
                        payload?.taskId ||
                        ''
                    ).trim();
                    if (taskId) {
                        logImageGenDebug('dashscope', 'task:poll:start', { endpoint, taskId });
                        payload = await resolveDashscopeTaskPayload(endpoint, request.apiKey, taskId);
                    }
                    const outputs = await normalizeGeneratedImages(payload);
                    if (outputs.length > 0) {
                        logImageGenDebug('dashscope', 'request:success', {
                            endpoint,
                            variantIndex: i,
                            outputCount: outputs.length,
                        });
                        return outputs;
                    }
                    finalError = finalError || 'DashScope returned no image payload.';
                } catch (error) {
                    logImageGenDebug('dashscope', 'request:exception', {
                        endpoint,
                        variantIndex: i,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    finalError = error instanceof Error ? error.message : String(error || finalError || 'unknown error');
                    continue;
                }
            }
        }
        const suffix = attemptedEndpoints.length
            ? ` attempted endpoints: ${attemptedEndpoints.join(', ')}`
            : '';
        const refSummary = refs.length > 0
            ? ` references: ${refs.map((ref) => decodeDataUrl(ref) ? 'data-url' : (isHttpUrl(ref) ? 'http-url' : 'unknown')).join(',')}`
            : '';
        throw new Error((finalError || 'DashScope Wan generation failed: no available endpoint.') + suffix + refSummary);
    },
};

const arkSeedreamAdapter: ImageProviderAdapter = {
    template: 'ark-seedream-native',
    supportsMultiCount: true,
    async generate(request) {
        const mode = resolveGenerationModeForTemplate('ark-seedream-native', request.generationMode);
        const refs = await normalizeReferenceImagesForTransport(
            pickReferenceImages(request, IMAGE_PROVIDER_CAPABILITIES['ark-seedream-native'].maxReferenceImages)
        );
        let forcedSize = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch(resolveOpenAiImagesEndpoint(request.endpoint), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${request.apiKey}`,
                },
                body: JSON.stringify({
                    model: request.model,
                    prompt: request.prompt,
                    n: Math.max(1, request.count || 1),
                    size: forcedSize || resolveOpenAiSizeForRequest(request),
                    quality: mapQualityToOpenAi(request.quality),
                    response_format: 'b64_json',
                    ...(mode !== 'text-to-image' && refs.length > 0 ? { images: refs } : {}),
                }),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                const minPixels = extractMinimumPixelConstraint(errorText);
                if (minPixels) {
                    const currentSize = forcedSize || resolveOpenAiSizeForRequest(request);
                    const adjustedSize = enforceMinPixels(currentSize, minPixels);
                    if (adjustedSize !== currentSize) {
                        forcedSize = adjustedSize;
                        logImageGenDebug('ark-seedream-native', 'retry_with_resized_size', {
                            endpoint: request.endpoint,
                            model: request.model,
                            baseSize: currentSize,
                            adjustedSize,
                            minPixels,
                            attempt: attempt + 1,
                        });
                        continue;
                    }
                }
                ensureSuccess(response, `Ark/Seedream generation failed (${response.status}): ${errorText || response.statusText}`);
            }

            return normalizeGeneratedImages(await response.json());
        }
        throw new Error('Ark/Seedream generation failed: cannot satisfy size constraint.');
    },
};

const jimengWrapperAdapter: ImageProviderAdapter = {
    template: 'jimeng-openai-wrapper',
    supportsMultiCount: true,
    async generate(request) {
        const mode = resolveGenerationModeForTemplate('jimeng-openai-wrapper', request.generationMode);
        const refs = await normalizeReferenceImagesForTransport(
            pickReferenceImages(request, IMAGE_PROVIDER_CAPABILITIES['jimeng-openai-wrapper'].maxReferenceImages)
        );
        const response = await fetch(resolveJimengWrapperEndpoint(request.endpoint), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${request.apiKey}`,
            },
            body: JSON.stringify({
                model: request.model,
                prompt: request.prompt,
                n: Math.max(1, request.count || 1),
                ...(mode !== 'text-to-image' && refs.length > 0 ? { images: refs } : {}),
                ratio: mapAspectRatioToJimengRatio(request.aspectRatio, request.size),
                resolution: mapQualityToJimengResolution(request.quality),
                response_format: 'b64_json',
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            ensureSuccess(response, `Jimeng wrapper generation failed (${response.status}): ${errorText || response.statusText}`);
        }

        return normalizeGeneratedImages(await response.json());
    },
};

const midjourneyProxyAdapter: ImageProviderAdapter = {
    template: 'midjourney-proxy',
    supportsMultiCount: false,
    async generate(request) {
        const submitEndpoints = resolveMidjourneySubmitEndpoints(request.endpoint);
        let submitPayload: any = null;
        let submitError = '';
        for (const endpoint of submitEndpoints) {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...defaultAuthHeaders(request.apiKey),
                },
                body: JSON.stringify({
                    prompt: request.prompt,
                }),
            });
            const payload = await parseJsonSafe(response);
            if (response.ok) {
                submitPayload = payload;
                submitError = '';
                break;
            }
            submitError = typeof payload === 'object'
                ? JSON.stringify(payload)
                : String(payload || `${response.status} ${response.statusText}`);
        }

        if (!submitPayload) {
            throw new Error(`Midjourney proxy submit failed: ${submitError || 'no available endpoint'}`);
        }

        const taskId = String(
            submitPayload?.result ||
            submitPayload?.id ||
            submitPayload?.taskId ||
            submitPayload?.task_id ||
            ''
        ).trim();
        if (!taskId) {
            throw new Error(`Midjourney proxy response missing task id: ${JSON.stringify(submitPayload)}`);
        }

        const fetchEndpoints = resolveMidjourneyFetchEndpoints(request.endpoint, taskId);
        const maxRounds = 90;
        for (let i = 0; i < maxRounds; i += 1) {
            await delay(2000);
            let payload: any = null;
            for (const endpoint of fetchEndpoints) {
                const response = await fetch(endpoint, {
                    method: 'GET',
                    headers: defaultAuthHeaders(request.apiKey),
                });
                const candidate = await parseJsonSafe(response);
                if (!response.ok) continue;
                payload = candidate;
                break;
            }

            if (!payload) continue;
            const status = String(payload?.status || payload?.state || '').toLowerCase();
            const failReason = String(payload?.failReason || payload?.fail_reason || payload?.error || '').trim();
            if (status.includes('fail') || status.includes('error')) {
                throw new Error(`Midjourney proxy task failed${failReason ? `: ${failReason}` : ''}`);
            }

            const outputs = await normalizeGeneratedImages(payload);
            if (outputs.length > 0) {
                return outputs;
            }

            if (status.includes('success') || status.includes('finish') || status.includes('done')) {
                throw new Error('Midjourney proxy task completed but no image payload found.');
            }
        }

        throw new Error('Midjourney proxy task timeout.');
    },
};

const ADAPTERS: Record<ImageProviderTemplate, ImageProviderAdapter> = {
    'openai-images': openAiAdapter,
    'gemini-openai-images': geminiOpenAiAdapter,
    'gemini-imagen-native': geminiImagenNativeAdapter,
    'dashscope-wan-native': dashscopeWanAdapter,
    'ark-seedream-native': arkSeedreamAdapter,
    'midjourney-proxy': midjourneyProxyAdapter,
    'jimeng-openai-wrapper': jimengWrapperAdapter,
    'gemini-generate-content': geminiGenerateContentAdapter,
    'jimeng-images': jimengWrapperAdapter,
};

export function normalizeImageProviderTemplate(providerTemplate?: string, provider?: string): ImageProviderTemplate {
    const normalizedTemplate = String(providerTemplate || '').trim().toLowerCase();
    const supportedTemplates = new Set<ImageProviderTemplate>([
        'openai-images',
        'gemini-openai-images',
        'gemini-imagen-native',
        'dashscope-wan-native',
        'ark-seedream-native',
        'midjourney-proxy',
        'jimeng-openai-wrapper',
        'gemini-generate-content',
        'jimeng-images',
    ]);
    if (supportedTemplates.has(normalizedTemplate as ImageProviderTemplate)) {
        return normalizedTemplate as ImageProviderTemplate;
    }

    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (normalizedProvider.includes('midjourney') || normalizedProvider.includes('mj')) {
        return 'midjourney-proxy';
    }
    if (normalizedProvider.includes('ark') || normalizedProvider.includes('volc') || normalizedProvider.includes('seedream')) {
        return 'ark-seedream-native';
    }
    if (normalizedProvider.includes('dashscope') || normalizedProvider.includes('wan') || normalizedProvider.includes('通义万相')) {
        return 'dashscope-wan-native';
    }
    if (normalizedProvider.includes('gemini-imagen') || normalizedProvider.includes('imagen')) {
        return 'gemini-imagen-native';
    }
    if (normalizedProvider.includes('gemini') || normalizedProvider.includes('nanobanana') || normalizedProvider.includes('nano-banana')) {
        return 'gemini-openai-images';
    }
    if (normalizedProvider.includes('jimeng') || normalizedProvider.includes('即梦')) {
        return 'ark-seedream-native';
    }
    return 'openai-images';
}

export function normalizeImageAspectRatio(aspectRatio?: string): ImageAspectRatio | undefined {
    const normalized = String(aspectRatio || '').trim();
    if (
        normalized === '1:1' ||
        normalized === '3:4' ||
        normalized === '4:3' ||
        normalized === '9:16' ||
        normalized === '16:9' ||
        normalized === 'auto'
    ) {
        return normalized;
    }
    return undefined;
}

export function normalizeImageSize(size?: string): string {
    const raw = String(size || '').trim().toLowerCase();
    if (!raw || raw === 'auto') {
        return '';
    }
    if (raw === '1k') {
        return '1024x1024';
    }
    if (raw === '2k') {
        return '2048x2048';
    }
    if (raw === '4k') {
        return '4096x4096';
    }

    const matched = raw.match(/^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i);
    if (!matched) {
        return '';
    }

    const clamp = (value: number) => Math.min(4096, Math.max(1024, Math.round(value)));
    const width = clamp(Number(matched[1]));
    const height = clamp(Number(matched[2]));
    return `${width}x${height}`;
}

export function getImageProviderCapabilities(providerTemplate?: string, provider?: string): ImageProviderCapabilities {
    const template = normalizeImageProviderTemplate(providerTemplate, provider);
    return IMAGE_PROVIDER_CAPABILITIES[template] || IMAGE_PROVIDER_CAPABILITIES['openai-images'];
}

export function getImageProviderAdapter(providerTemplate?: string, provider?: string): ImageProviderAdapter {
    return ADAPTERS[normalizeImageProviderTemplate(providerTemplate, provider)];
}
