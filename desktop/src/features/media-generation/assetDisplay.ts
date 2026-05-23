import { normalizeAspectRatio, parseAspectRatio, type GeneratedAsset, type GenerationRequest } from './feedModel';

export function isVideoAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)$/i.test(String(asset.relativePath || '').trim());
}

export function isAudioAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return true;
    return /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(String(asset.relativePath || '').trim());
}

export function inferAssetExtension(asset: GeneratedAsset, source: string): string {
    const mimeType = String(asset.mimeType || '').trim().toLowerCase();
    if (mimeType.startsWith('image/')) {
        const subtype = mimeType.slice('image/'.length).split(/[+;]/)[0];
        if (subtype === 'jpeg') return 'jpg';
        if (subtype) return subtype;
    }
    if (mimeType.startsWith('video/')) {
        const subtype = mimeType.slice('video/'.length).split(/[+;]/)[0];
        if (subtype === 'quicktime') return 'mov';
        if (subtype) return subtype;
    }
    if (mimeType.startsWith('audio/')) {
        const subtype = mimeType.slice('audio/'.length).split(/[+;]/)[0];
        if (subtype === 'mpeg') return 'mp3';
        if (subtype) return subtype;
    }

    const match = String(source || '').match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
    const inferred = String(match?.[1] || '').trim().toLowerCase();
    if (inferred) return inferred;
    if (isVideoAsset(asset)) return 'mp4';
    if (isAudioAsset(asset)) return 'mp3';
    return 'png';
}

export function generatedAssetDefaultName(asset: GeneratedAsset, source: string): string {
    const extension = inferAssetExtension(asset, source);
    const rawName = String(source || '').split(/[\\/]/).pop()?.replace(/[?#].*$/, '').trim();
    if (rawName) {
        try {
            return decodeURIComponent(rawName);
        } catch {
            return rawName;
        }
    }
    return `${asset.title || 'generated-asset'}.${extension}`;
}

export function formatRelativeTime(timestampMs: number): string {
    const diff = Date.now() - timestampMs;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
    return `${Math.max(1, Math.round(diff / 86_400_000))} 天前`;
}

export function buildRequestSummary(request: GenerationRequest): string[] {
    if (request.type === 'cover') {
        return [
            request.model || '默认模型',
            '3:4',
            request.quality || '默认',
        ];
    }
    if (request.type === 'image') {
        return [
            request.model || '默认模型',
            request.aspectRatio || 'Auto',
            request.resolution || '自动',
            request.quality || 'medium',
        ];
    }
    if (request.type === 'audio') {
        return [
            request.model || '默认模型',
            request.voiceId ? shortVoiceId(request.voiceId) : '未选音色',
        ];
    }
    if (request.type === 'digital-human') {
        return [
            'videoretalk',
            request.resolution,
            request.durationSeconds ? `${request.durationSeconds} 秒` : '自动时长',
        ];
    }
    return [
        request.model || '默认模型',
        request.aspectRatio,
        request.resolution,
    ];
}

export function shortVoiceId(value: string): string {
    if (!value) return '';
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

export function placeholderCountForRequest(request: GenerationRequest): number {
    return request.type === 'image' || request.type === 'cover' ? Math.max(1, request.count) : 1;
}

export function placeholderAspectRatioForRequest(request: GenerationRequest): string {
    if (request.type === 'audio') return '16 / 5';
    if (request.type === 'digital-human') return '16 / 9';
    if (request.type === 'cover') return '3 / 4';
    return request.type === 'image'
        ? normalizeAspectRatio(request.aspectRatio, '4 / 3')
        : normalizeAspectRatio(request.aspectRatio, '16 / 9');
}

export function isPortraitRequest(request: GenerationRequest): boolean {
    if (request.type === 'audio' || request.type === 'digital-human') return false;
    if (request.type === 'cover') return true;
    const ratio = request.type === 'image'
        ? parseAspectRatio(request.aspectRatio, '4:3')
        : parseAspectRatio(request.aspectRatio, '16:9');
    return ratio.height > ratio.width;
}

export function feedMediaGridClass(request: GenerationRequest, itemCount: number): string {
    if (request.type === 'audio') return 'max-w-[620px]';
    const portrait = isPortraitRequest(request);
    if (itemCount === 1) {
        return portrait ? 'max-w-[380px]' : 'max-w-[500px]';
    }
    return portrait ? 'max-w-[560px] sm:grid-cols-2' : 'max-w-[700px] sm:grid-cols-2';
}

export function feedMediaHeightClass(request: GenerationRequest): string {
    if (request.type === 'audio') return 'min-h-[104px]';
    return isPortraitRequest(request) ? 'max-h-[440px]' : 'max-h-[520px]';
}
