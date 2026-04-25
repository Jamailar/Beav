import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowUp,
    ChevronDown,
    Clapperboard,
    Copy,
    Download,
    FileText,
    FolderOpen,
    Image as ImageIcon,
    ImagePlus,
    Loader2,
    Music2,
    Paperclip,
    PencilLine,
    Play,
    Plus,
    RotateCcw,
    Sparkles,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../shared/redboxVideo';
import type { GenerationIntent, PendingChatMessage } from '../App';
import type { UploadedFileAttachment } from '../components/ChatComposer';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsStore } from '../features/media-jobs/useMediaJobsStore';
import { isMediaJobSuccessful, isMediaJobTerminal, type MediaJobProjection } from '../features/media-jobs/types';
import { Chat } from './Chat';
import { resolveAssetUrl } from '../utils/pathManager';
import { appAlert } from '../utils/appDialogs';

type StudioMode = 'image' | 'video';
type ImageGenerationMode = 'text-to-image' | 'reference-guided' | 'image-to-image';
type VideoGenerationMode = 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation';
type ImageCreationSurface = 'manual' | 'agent';

type SettingsShape = {
    api_endpoint?: string;
    api_key?: string;
    image_provider?: string;
    image_endpoint?: string;
    image_api_key?: string;
    image_model?: string;
    image_provider_template?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    video_endpoint?: string;
    video_api_key?: string;
    video_model?: string;
};

type ReferenceItem = {
    name: string;
    dataUrl: string;
};

type GenerationAgentSessionMetadata = {
    contextType: typeof GENERATION_AGENT_CONTEXT_TYPE;
    intent: 'image_creation';
    preferredRole: 'image-director';
    generationTarget: 'image-suite';
    suiteMode: true;
    requiresHumanApproval: true;
    projectId?: string;
    source: 'generation-studio';
    sourceTitle?: string;
    suiteState: {
        status: 'draft';
        approvedPlanVersion: number;
        sharedStyleGuide: string;
        cards: Array<{
            id: string;
            status: 'draft';
        }>;
    };
};

type GeneratedAsset = {
    id: string;
    title?: string;
    prompt?: string;
    previewUrl?: string;
    mimeType?: string;
    exists?: boolean;
    projectId?: string;
    provider?: string;
    providerTemplate?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
    relativePath?: string;
    updatedAt: string;
};

type ImageGenerationRequest = {
    type: 'image';
    prompt: string;
    title: string;
    projectId: string;
    count: number;
    model: string;
    aspectRatio: string;
    size: string;
    quality: string;
    generationMode: ImageGenerationMode;
    referenceItems: ReferenceItem[];
};

type VideoGenerationRequest = {
    type: 'video';
    prompt: string;
    title: string;
    projectId: string;
    model: string;
    aspectRatio: '16:9' | '9:16';
    resolution: '720p' | '1080p';
    durationSeconds: number;
    generateAudio: boolean;
    generationMode: VideoGenerationMode;
    referenceItems: ReferenceItem[];
    firstClip?: ReferenceItem | null;
    drivingAudio?: ReferenceItem | null;
};

type GenerationRequest = ImageGenerationRequest | VideoGenerationRequest;

type GenerationFeedEntry = {
    kind: 'generation';
    id: string;
    createdAt: number;
    source: GenerationIntent['source'];
    sourceTitle?: string;
    referencePreview?: ReferenceItem | null;
    request: GenerationRequest;
    status: 'running' | 'success' | 'error';
    jobId?: string;
    jobStatus?: string;
    completedAt?: string;
    error?: string;
    assets: GeneratedAsset[];
};

type AgentSessionFeedEntry = {
    kind: 'agent-session';
    id: string;
    createdAt: number;
    source: GenerationIntent['source'];
    sourceTitle?: string;
    sessionId: string;
    contextId: string;
    title: string;
};

type FeedEntry = GenerationFeedEntry | AgentSessionFeedEntry;

interface GenerationStudioProps {
    isActive?: boolean;
    pendingIntent?: GenerationIntent | null;
    onIntentConsumed?: () => void;
    onExecutionStateChange?: (active: boolean) => void;
}

const FEED_STORAGE_KEY = 'redbox:generation-studio:feed:v1';
const GENERATION_AGENT_CONTEXT_TYPE = 'generation-agent';

const IMAGE_ASPECT_RATIO_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: '1:1', label: '1:1' },
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
] as const;

const IMAGE_SIZE_OPTIONS = [
    { value: '', label: '自动' },
    { value: '1024x1024', label: '1k' },
    { value: '1024x1536', label: '1k 竖图' },
    { value: '1536x1024', label: '1k 横图' },
    { value: 'auto', label: 'Auto' },
] as const;

const IMAGE_QUALITY_OPTIONS = [
    { value: 'standard', label: '标准' },
    { value: 'high', label: '高质量' },
    { value: 'auto', label: 'Auto' },
] as const;

const IMAGE_COUNT_OPTIONS = [
    { value: '1', label: '1 张' },
    { value: '2', label: '2 张' },
    { value: '3', label: '3 张' },
    { value: '4', label: '4 张' },
] as const;

const VIDEO_MODE_OPTIONS = [
    { value: 'text-to-video', label: '文生视频' },
    { value: 'reference-guided', label: '参考图视频' },
    { value: 'first-last-frame', label: '首尾帧视频' },
    { value: 'continuation', label: '视频续写' },
] as const;

const VIDEO_ASPECT_RATIO_OPTIONS = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
] as const;

const VIDEO_RESOLUTION_OPTIONS = [
    { value: '720p', label: '720p' },
    { value: '1080p', label: '1080p' },
] as const;

const VIDEO_DURATION_OPTIONS = [
    { value: '5', label: '5 秒' },
    { value: '6', label: '6 秒' },
    { value: '7', label: '7 秒' },
    { value: '8', label: '8 秒' },
    { value: '9', label: '9 秒' },
    { value: '10', label: '10 秒' },
    { value: '11', label: '11 秒' },
    { value: '12', label: '12 秒' },
] as const;

const VIDEO_AUDIO_OPTIONS = [
    { value: 'off', label: '音频关' },
    { value: 'on', label: '音频开' },
] as const;

const SOURCE_LABELS: Record<GenerationIntent['source'], string> = {
    standalone: '独立创作',
    'media-library': '媒体库',
    manuscripts: '稿件',
    'cover-studio': '封面',
};

type AssetContextMenuState = {
    asset: GeneratedAsset;
    entryId?: string;
    x: number;
    y: number;
};

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

const readBlobAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(blob);
});

function makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dataUrlMimeType(dataUrl: string): string {
    const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
    return String(match?.[1] || '').trim().toLowerCase();
}

function referenceItemIsImage(item: ReferenceItem | null | undefined): boolean {
    return dataUrlMimeType(String(item?.dataUrl || '')).startsWith('image/');
}

function attachmentVisualKind(
    attachment: UploadedFileAttachment | null | undefined,
): 'image' | 'video' | 'audio' | 'text' | 'file' {
    const kind = String(attachment?.kind || '').trim().toLowerCase();
    const mimeType = String(attachment?.mimeType || '').trim().toLowerCase();
    const name = String(attachment?.name || '').trim().toLowerCase();
    if (kind === 'image' || mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(name)) return 'image';
    if (kind === 'video' || mimeType.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(name)) return 'video';
    if (kind === 'audio' || mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(name)) return 'audio';
    if (kind === 'text' || mimeType.startsWith('text/') || /\.(txt|md|markdown|json|csv|tsv|doc|docx|pdf|rtf|xml|yaml|yml)$/i.test(name)) return 'text';
    return 'file';
}

function attachmentPreviewSrc(attachment: UploadedFileAttachment | null | undefined): string {
    const preferred = String(
        attachment?.thumbnailDataUrl
        || attachment?.localUrl
        || attachment?.absolutePath
        || attachment?.originalAbsolutePath
        || '',
    ).trim();
    if (!preferred) return '';
    return preferred.startsWith('data:') ? preferred : resolveAssetUrl(preferred);
}

function formatAttachmentSize(size?: number): string {
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return '';
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    if (size >= 1024) return `${Math.round(size / 1024)} KB`;
    return `${Math.round(size)} B`;
}

function attachmentKindLabel(kind: ReturnType<typeof attachmentVisualKind>): string {
    switch (kind) {
        case 'image':
            return '图片';
        case 'video':
            return '视频';
        case 'audio':
            return '音频';
        case 'text':
            return '文档';
        default:
            return '文件';
    }
}

async function loadImageElement(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new window.Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('参考图读取失败'));
        image.src = source;
    });
}

async function buildReferenceContactSheet(
    items: ReferenceItem[],
): Promise<{ fileName: string; dataUrl: string; note: string }> {
    const imageItems = items.filter(referenceItemIsImage).slice(0, 4);
    if (imageItems.length === 0) {
        throw new Error('没有可用于拼版的图片参考图');
    }
    if (imageItems.length === 1) {
        return {
            fileName: imageItems[0].name || 'reference-image.png',
            dataUrl: imageItems[0].dataUrl,
            note: `参考图共 1 张：${imageItems[0].name || 'reference-image'}`,
        };
    }

    const loaded = await Promise.all(imageItems.map(async (item) => ({
        item,
        image: await loadImageElement(item.dataUrl),
    })));
    const columns = imageItems.length <= 2 ? imageItems.length : 2;
    const rows = Math.ceil(imageItems.length / columns);
    const cellWidth = 640;
    const cellHeight = 640;
    const labelHeight = 76;
    const gap = 18;
    const padding = 24;
    const canvas = document.createElement('canvas');
    canvas.width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
    canvas.height = padding * 2 + rows * (cellHeight + labelHeight) + (rows - 1) * gap;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('参考图拼版失败');
    }

    context.fillStyle = '#0f1115';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textBaseline = 'middle';
    context.font = '500 28px sans-serif';

    loaded.forEach(({ item, image }, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = padding + column * (cellWidth + gap);
        const y = padding + row * (cellHeight + labelHeight + gap);
        const imageRatio = image.width / Math.max(image.height, 1);
        const targetRatio = cellWidth / cellHeight;
        let drawWidth = cellWidth;
        let drawHeight = cellHeight;
        let drawX = x;
        let drawY = y;
        if (imageRatio > targetRatio) {
            drawHeight = cellHeight;
            drawWidth = drawHeight * imageRatio;
            drawX = x - (drawWidth - cellWidth) / 2;
        } else {
            drawWidth = cellWidth;
            drawHeight = drawWidth / Math.max(imageRatio, 0.001);
            drawY = y - (drawHeight - cellHeight) / 2;
        }

        context.save();
        context.beginPath();
        context.roundRect(x, y, cellWidth, cellHeight, 22);
        context.clip();
        context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
        context.restore();

        context.fillStyle = 'rgba(255,255,255,0.12)';
        context.fillRect(x, y + cellHeight + 10, cellWidth, labelHeight - 10);
        context.fillStyle = '#f5f7fb';
        context.fillText(`${index + 1}. ${item.name || `参考图 ${index + 1}`}`, x + 20, y + cellHeight + labelHeight / 2 + 4);
    });

    return {
        fileName: `suite-references-${Date.now()}.png`,
        dataUrl: canvas.toDataURL('image/png'),
        note: `参考图共 ${imageItems.length} 张，附件为拼版图，按从左到右、从上到下查看：${imageItems.map((item, index) => `${index + 1}.${item.name || `参考图${index + 1}`}`).join('，')}`,
    };
}

async function attachmentToReferenceItem(
    attachment: UploadedFileAttachment,
): Promise<ReferenceItem | null> {
    if (attachmentVisualKind(attachment) !== 'image') return null;
    const source = attachmentPreviewSrc(attachment);
    if (!source) return null;
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`读取附件失败 (${response.status})`);
    }
    const blob = await response.blob();
    return {
        name: attachment.name || `reference-${Date.now()}.png`,
        dataUrl: await readBlobAsDataUrl(blob),
    };
}

function normalizeGenerationAgentScope(value: string): string {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || 'default';
}

function buildGenerationAgentContextId(projectId: string, source?: GenerationIntent['source'], sourceTitle?: string): string {
    const scope = normalizeGenerationAgentScope(projectId || sourceTitle || source || 'default');
    return `generation-studio:image-agent:${scope}`;
}

function buildGenerationAgentInitialContext(projectId: string, sourceTitle?: string): string {
    return [
        '你当前位于 RedBox 创作页的「套图制作」模式。',
        '这里是图片创作专用会话。用户只负责给目标、反馈和约束；具体图片生成相关工具调用由你负责。',
        sourceTitle ? `当前来源: ${sourceTitle}` : '',
        projectId ? `当前项目ID: ${projectId}` : '',
    ].filter(Boolean).join('\n');
}

function buildGenerationAgentSessionMetadata(
    projectId: string,
    sourceTitle?: string,
): GenerationAgentSessionMetadata {
    return {
        contextType: GENERATION_AGENT_CONTEXT_TYPE,
        intent: 'image_creation',
        preferredRole: 'image-director',
        generationTarget: 'image-suite',
        suiteMode: true,
        requiresHumanApproval: true,
        projectId: projectId || undefined,
        source: 'generation-studio',
        sourceTitle: sourceTitle || undefined,
        suiteState: {
            status: 'draft',
            approvedPlanVersion: 0,
            sharedStyleGuide: '',
            cards: [],
        },
    };
}

function isVideoAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)$/i.test(String(asset.relativePath || '').trim());
}

function inferAssetExtension(asset: GeneratedAsset, source: string): string {
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

    const match = String(source || '').match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
    const inferred = String(match?.[1] || '').trim().toLowerCase();
    if (inferred) return inferred;
    return isVideoAsset(asset) ? 'mp4' : 'png';
}

function formatRelativeTime(timestampMs: number): string {
    const diff = Date.now() - timestampMs;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
    return `${Math.max(1, Math.round(diff / 86_400_000))} 天前`;
}

function isVideoReference(item: ReferenceItem | null | undefined): boolean {
    return String(item?.dataUrl || '').startsWith('data:video/');
}

function applyIntentPreset(
    intent: GenerationIntent,
    setters: {
        setStudioMode: (mode: StudioMode) => void;
        setBindTarget: (value: string) => void;
        setImageAspectRatio: (value: string) => void;
        setVideoAspectRatio: (value: '16:9' | '9:16') => void;
        setVideoResolution: (value: '720p' | '1080p') => void;
        setVideoDurationSeconds: (value: number) => void;
        setImageProjectId: (value: string) => void;
        setVideoProjectId: (value: string) => void;
        setContextIntent: (value: GenerationIntent | null) => void;
    },
): void {
    setters.setStudioMode(intent.mode);
    setters.setContextIntent(intent);
    if (intent.bindTarget?.manuscriptPath) {
        setters.setBindTarget(intent.bindTarget.manuscriptPath);
    }
    if (intent.bindTarget?.projectId) {
        setters.setImageProjectId(intent.bindTarget.projectId);
        setters.setVideoProjectId(intent.bindTarget.projectId);
    }
    if (intent.preset?.aspectRatio) {
        if (intent.mode === 'image') {
            setters.setImageAspectRatio(intent.preset.aspectRatio);
        } else if (intent.preset.aspectRatio === '9:16' || intent.preset.aspectRatio === '16:9') {
            setters.setVideoAspectRatio(intent.preset.aspectRatio);
        }
    }
    if (intent.preset?.resolution === '720p' || intent.preset?.resolution === '1080p') {
        setters.setVideoResolution(intent.preset.resolution);
    }
    if (typeof intent.preset?.durationSeconds === 'number' && Number.isFinite(intent.preset.durationSeconds)) {
        setters.setVideoDurationSeconds(intent.preset.durationSeconds);
    }
}

function buildRequestSummary(request: GenerationRequest): string[] {
    if (request.type === 'image') {
        return [
            request.model || '默认模型',
            request.aspectRatio || 'Auto',
            request.size || '自动尺寸',
        ];
    }
    return [
        request.model || '默认模型',
        request.aspectRatio,
        request.resolution,
    ];
}

function serializeFeedEntries(entries: FeedEntry[]): string {
    return JSON.stringify(
        entries.map((entry) => {
            if (!isGenerationFeedEntry(entry)) {
                return entry;
            }
            return {
                ...entry,
                request: {
                    ...entry.request,
                    referenceItems: [],
                    firstClip: entry.request.type === 'video' ? null : undefined,
                    drivingAudio: entry.request.type === 'video' ? null : undefined,
                },
            };
        }),
    );
}

function normalizeReferenceItems(value: unknown): ReferenceItem[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const record = item as Record<string, unknown>;
            const dataUrl = String(record.dataUrl || '').trim();
            if (!dataUrl) return null;
            return {
                name: String(record.name || 'reference').trim() || 'reference',
                dataUrl,
            } satisfies ReferenceItem;
        })
        .filter((item): item is ReferenceItem => Boolean(item));
}

function normalizeReferenceItem(value: unknown): ReferenceItem | null {
    const items = normalizeReferenceItems(Array.isArray(value) ? value.slice(0, 1) : [value]);
    return items[0] || null;
}

function normalizeGenerationRequest(value: unknown): GenerationRequest | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const rawType = String(record.type || '').trim().toLowerCase();
    const resolvedType = rawType === 'video'
        ? 'video'
        : rawType === 'image'
            ? 'image'
            : String(record.mode || '').trim().toLowerCase() === 'video'
                ? 'video'
                : 'image';
    const prompt = String(record.prompt || record.userPrompt || '').trim();
    if (!prompt) return null;

    if (resolvedType === 'video') {
        const aspectRatio = String(record.aspectRatio || '16:9').trim();
        const resolution = String(record.resolution || '720p').trim() === '1080p' ? '1080p' : '720p';
        const generationMode = (() => {
            const rawMode = String(record.generationMode || record.videoMode || record.mode || '').trim();
            if (rawMode === 'reference-guided' || rawMode === 'first-last-frame' || rawMode === 'continuation' || rawMode === 'text-to-video') {
                return rawMode;
            }
            return 'text-to-video';
        })();
        return {
            type: 'video',
            prompt,
            title: String(record.title || '').trim(),
            projectId: String(record.projectId || '').trim(),
            model: String(record.model || '').trim(),
            aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9',
            resolution,
            durationSeconds: Math.max(1, Number(record.durationSeconds || 8) || 8),
            generateAudio: Boolean(record.generateAudio),
            generationMode,
            referenceItems: normalizeReferenceItems(record.referenceItems),
            firstClip: normalizeReferenceItem(record.firstClip),
            drivingAudio: normalizeReferenceItem(record.drivingAudio),
        } satisfies VideoGenerationRequest;
    }

    const imageMode = (() => {
        const rawMode = String(record.generationMode || record.imageMode || record.mode || '').trim();
        if (rawMode === 'reference-guided' || rawMode === 'image-to-image' || rawMode === 'text-to-image') {
            return rawMode;
        }
        return 'text-to-image';
    })();
    return {
        type: 'image',
        prompt,
        title: String(record.title || '').trim(),
        projectId: String(record.projectId || '').trim(),
        count: Math.max(1, Number(record.count || 1) || 1),
        model: String(record.model || '').trim(),
        aspectRatio: String(record.aspectRatio || '4:3').trim() || '4:3',
        size: String(record.size || '').trim(),
        quality: String(record.quality || 'auto').trim() || 'auto',
        generationMode: imageMode,
        referenceItems: normalizeReferenceItems(record.referenceItems),
    } satisfies ImageGenerationRequest;
}

function normalizeGeneratedAssets(value: unknown): GeneratedAsset[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item): GeneratedAsset | null => {
            if (!item || typeof item !== 'object') return null;
            const record = item as Record<string, unknown>;
            const id = String(record.id || '').trim();
            if (!id) return null;
            return {
                id,
                title: typeof record.title === 'string' ? record.title : undefined,
                prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
                previewUrl: typeof record.previewUrl === 'string' ? record.previewUrl : undefined,
                mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
                exists: typeof record.exists === 'boolean' ? record.exists : undefined,
                projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
                provider: typeof record.provider === 'string' ? record.provider : undefined,
                providerTemplate: typeof record.providerTemplate === 'string' ? record.providerTemplate : undefined,
                model: typeof record.model === 'string' ? record.model : undefined,
                aspectRatio: typeof record.aspectRatio === 'string' ? record.aspectRatio : undefined,
                size: typeof record.size === 'string' ? record.size : undefined,
                quality: typeof record.quality === 'string' ? record.quality : undefined,
                relativePath: typeof record.relativePath === 'string' ? record.relativePath : undefined,
                updatedAt: String(record.updatedAt || ''),
            } satisfies GeneratedAsset;
        })
        .filter((item): item is GeneratedAsset => Boolean(item));
}

function normalizeFeedEntryRecord(value: unknown): FeedEntry | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = String(record.id || '').trim();
    if (!id) return null;

    if (record.kind === 'agent-session') {
        const sessionId = String(record.sessionId || '').trim();
        const contextId = String(record.contextId || '').trim();
        if (!sessionId || !contextId) return null;
        return {
            kind: 'agent-session',
            id,
            createdAt: Number(record.createdAt || Date.now()),
            source: (String(record.source || 'standalone').trim() || 'standalone') as GenerationIntent['source'],
            sourceTitle: typeof record.sourceTitle === 'string' ? record.sourceTitle : undefined,
            sessionId,
            contextId,
            title: typeof record.title === 'string' ? record.title : '套图制作',
        } satisfies AgentSessionFeedEntry;
    }

    const request = normalizeGenerationRequest(record.request || record);
    if (!request) return null;

    return {
        kind: 'generation',
        id,
        createdAt: Number(record.createdAt || Date.now()),
        source: (String(record.source || 'standalone').trim() || 'standalone') as GenerationIntent['source'],
        sourceTitle: typeof record.sourceTitle === 'string' ? record.sourceTitle : undefined,
        referencePreview: normalizeReferenceItem(record.referencePreview),
        request,
        status: String(record.status || 'success').trim() === 'running'
            ? 'running'
            : String(record.status || '').trim() === 'error'
                ? 'error'
                : 'success',
        jobId: typeof record.jobId === 'string' ? record.jobId : undefined,
        jobStatus: typeof record.jobStatus === 'string' ? record.jobStatus : undefined,
        completedAt: typeof record.completedAt === 'string' ? record.completedAt : undefined,
        error: typeof record.error === 'string' ? record.error : undefined,
        assets: normalizeGeneratedAssets(record.assets),
    } satisfies GenerationFeedEntry;
}

function persistFeedEntries(entries: FeedEntry[]): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(FEED_STORAGE_KEY, serializeFeedEntries(entries));
    } catch {
        // ignore persistence errors
    }
}

function readPersistedFeedEntries(): FeedEntry[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(FEED_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeFeedEntryRecord)
            .filter((item): item is FeedEntry => Boolean(item))
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    } catch {
        return [];
    }
}

function requestModeLabel(request: GenerationRequest): string {
    return request.type === 'image' ? '图片创作' : '视频创作';
}

function requestLeadingReference(request: GenerationRequest): ReferenceItem | null {
    if (request.referenceItems.length > 0) return request.referenceItems[0];
    if (request.type === 'video' && request.firstClip) return request.firstClip;
    return null;
}

function requestSupportText(request: GenerationRequest): string {
    if (request.type === 'image') {
        if (request.generationMode === 'image-to-image') return '图生图';
        if (request.generationMode === 'reference-guided') return '参考图引导';
        return `${request.count} 张`;
    }
    if (request.generationMode === 'first-last-frame') return '首尾帧';
    if (request.generationMode === 'continuation') return '续写';
    if (request.generationMode === 'reference-guided') return '参考图';
    return `${request.durationSeconds} 秒`;
}

function isGenerationFeedEntry(entry: FeedEntry): entry is GenerationFeedEntry {
    return entry.kind === 'generation';
}

function isAgentSessionFeedEntry(entry: FeedEntry): entry is AgentSessionFeedEntry {
    return entry.kind === 'agent-session';
}

function normalizeAspectRatio(value: string | undefined, fallback: string): string {
    const raw = String(value || '').trim();
    if (!raw || raw.toLowerCase() === 'auto') return fallback;
    if (!/^\d+:\d+$/.test(raw)) return fallback;
    return raw.replace(':', ' / ');
}

function parseAspectRatio(value: string | undefined, fallback: string): { width: number; height: number } {
    const raw = String(value || '').trim();
    const normalized = !raw || raw.toLowerCase() === 'auto' ? fallback : raw;
    const match = normalized.match(/^(\d+):(\d+)$/);
    const fallbackMatch = fallback.match(/^(\d+):(\d+)$/);
    const width = Number(match?.[1] || fallbackMatch?.[1] || 1);
    const height = Number(match?.[2] || fallbackMatch?.[2] || 1);
    return { width, height };
}

function estimateGenerationProgress(request: GenerationRequest, elapsedMs: number): number {
    const expectedDurationMs = request.type === 'image'
        ? 28_000
        : request.generationMode === 'reference-guided'
            ? 180_000
            : 150_000;
    const ratio = Math.min(1, elapsedMs / expectedDurationMs);
    return Math.min(94, Math.max(6, Math.round(ratio * 100)));
}

function assetsFromJobProjection(job: MediaJobProjection): GeneratedAsset[] {
    return (job.artifacts || [])
        .map((artifact) => artifact.metadata)
        .filter((item): item is GeneratedAsset => Boolean(item && typeof item === 'object' && typeof (item as GeneratedAsset).id === 'string'));
}

function errorMessageFromJobProjection(job: MediaJobProjection): string {
    const attemptError = typeof job.attempt?.lastError === 'string' ? job.attempt.lastError : '';
    const resultError = typeof job.result?.error === 'string' ? job.result.error : '';
    const cancelReason = typeof job.cancelReason === 'string' ? job.cancelReason : '';
    return attemptError || resultError || cancelReason || '生成失败';
}

function applyJobProjectionToFeedEntry(entry: FeedEntry, job: MediaJobProjection | null | undefined): FeedEntry {
    if (!isGenerationFeedEntry(entry)) return entry;
    if (!job || entry.jobId !== job.jobId) return entry;
    if (isMediaJobSuccessful(job.status)) {
        return {
            ...entry,
            jobStatus: job.status,
            completedAt: job.completedAt || entry.completedAt,
            status: 'success',
            error: undefined,
            assets: assetsFromJobProjection(job),
        };
    }
    if (isMediaJobTerminal(job.status)) {
        return {
            ...entry,
            jobStatus: job.status,
            completedAt: job.completedAt || entry.completedAt,
            status: 'error',
            error: errorMessageFromJobProjection(job),
        };
    }
    return {
        ...entry,
        jobStatus: job.status,
        status: 'running',
    };
}

function placeholderCountForRequest(request: GenerationRequest): number {
    return request.type === 'image' ? Math.max(1, request.count) : 1;
}

function placeholderAspectRatioForRequest(request: GenerationRequest): string {
    return request.type === 'image'
        ? normalizeAspectRatio(request.aspectRatio, '4 / 3')
        : normalizeAspectRatio(request.aspectRatio, '16 / 9');
}

function isPortraitRequest(request: GenerationRequest): boolean {
    const ratio = request.type === 'image'
        ? parseAspectRatio(request.aspectRatio, '4:3')
        : parseAspectRatio(request.aspectRatio, '16:9');
    return ratio.height > ratio.width;
}

function feedMediaGridClass(request: GenerationRequest, itemCount: number): string {
    const portrait = isPortraitRequest(request);
    if (itemCount === 1) {
        return portrait ? 'max-w-[380px]' : 'max-w-[500px]';
    }
    return portrait ? 'max-w-[560px] sm:grid-cols-2' : 'max-w-[700px] sm:grid-cols-2';
}

function feedMediaHeightClass(request: GenerationRequest): string {
    return isPortraitRequest(request) ? 'max-h-[440px]' : 'max-h-[520px]';
}

type PickerOption = {
    value: string;
    label: string;
};

function useDismissiblePopover(open: boolean, onClose: () => void) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (!(event.target instanceof Node)) return;
            if (rootRef.current?.contains(event.target)) return;
            onClose();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose, open]);

    return rootRef;
}

function PopoverSelect({
    value,
    onChange,
    options,
    className,
    title,
    panelClassName,
    layout = 'wrap',
}: {
    value: string;
    onChange: (value: string) => void;
    options: readonly PickerOption[];
    className?: string;
    title?: string;
    panelClassName?: string;
    layout?: 'wrap' | 'column';
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useDismissiblePopover(open, () => setOpen(false));
    const active = options.find((option) => option.value === value) || options[0];

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className={clsx(
                    'inline-flex h-9 min-w-[104px] items-center gap-2 rounded-full border border-border bg-surface-primary px-3 shadow-[var(--ui-shadow-1)] transition-colors hover:border-border/70',
                    open && 'border-brand-red/50 ring-1 ring-brand-red/20',
                    className,
                )}
            >
                <span className="truncate text-[12px] font-medium text-text-primary">{active?.label || value}</span>
                <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-accent-muted text-text-tertiary">
                    <ChevronDown className="h-3 w-3" />
                </span>
            </button>

            {open && (
                <div
                    className={clsx(
                        'absolute bottom-[calc(100%+10px)] left-0 z-20 min-w-[220px] max-w-[340px] rounded-[20px] border border-border bg-surface-secondary p-3 shadow-[var(--ui-shadow-2)]',
                        panelClassName,
                    )}
                >
                    {title && <div className="mb-3 text-[13px] font-semibold text-text-secondary">{title}</div>}
                    <div className={clsx(
                        layout === 'column' ? 'flex flex-col gap-2' : 'flex flex-wrap gap-2',
                    )}>
                        {options.map((option) => {
                            const selected = option.value === active?.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                        onChange(option.value);
                                        setOpen(false);
                                    }}
                                    className={clsx(
                                        'rounded-[14px] border px-3 py-2.5 text-[12px] font-semibold transition-colors',
                                        layout === 'column' ? 'w-full text-left' : 'min-w-[92px] flex-1',
                                        selected
                                            ? 'border-brand-red/50 bg-brand-red text-white'
                                            : 'border-transparent bg-surface-tertiary text-text-secondary hover:bg-accent-muted',
                                    )}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function ImageAspectRatioPicker({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useDismissiblePopover(open, () => setOpen(false));
    const active =
        IMAGE_ASPECT_RATIO_OPTIONS.find((option) => option.value === value) || IMAGE_ASPECT_RATIO_OPTIONS[0];

    const frameClassName = (ratio: string) => {
        switch (ratio) {
            case '16:9':
                return 'h-3 w-6';
            case '9:16':
                return 'h-6 w-3';
            case '4:3':
                return 'h-4 w-5';
            case '3:4':
                return 'h-5 w-4';
            case '1:1':
            case 'auto':
            default:
                return 'h-4 w-4';
        }
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className={clsx(
                    'inline-flex h-9 min-w-[84px] items-center gap-2 rounded-full border border-border bg-surface-primary px-3 shadow-[var(--ui-shadow-1)] transition-colors hover:border-border/70',
                    open && 'border-brand-red/50 ring-1 ring-brand-red/20',
                )}
            >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-muted text-text-secondary">
                    <span className={clsx('rounded-[3px] border border-current', frameClassName(active.value))} />
                </span>
                <span className="text-[12px] font-medium text-text-primary">{active.label}</span>
                <ChevronDown className="ml-auto h-3 w-3 text-text-tertiary" />
            </button>

            {open && (
                <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-[372px] rounded-[20px] border border-border bg-surface-secondary p-4 shadow-[var(--ui-shadow-2)]">
                    <div className="mb-3 text-[13px] font-semibold text-text-secondary">图片比例</div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => {
                            const selected = option.value === active.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                        onChange(option.value);
                                        setOpen(false);
                                    }}
                                    className={clsx(
                                        'flex h-[84px] flex-col items-center justify-center rounded-[16px] border text-center transition-colors',
                                        selected
                                            ? 'border-brand-red/50 bg-brand-red text-white'
                                            : 'border-transparent bg-surface-tertiary text-text-secondary hover:bg-accent-muted',
                                    )}
                                >
                                    <span className={clsx(
                                        'mb-3 rounded-[4px] border',
                                        selected ? 'border-current' : 'border-text-tertiary',
                                        frameClassName(option.value),
                                    )} />
                                    <span className="text-[12px] font-semibold">{option.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function UploadPreviewCard({
    label,
    accept,
    multiple = false,
    items,
    onChange,
    onClear,
}: {
    label: string;
    accept: string;
    multiple?: boolean;
    items: ReferenceItem[];
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
    onClear?: () => void;
}) {
    const lead = items[0] || null;
    const hasItems = items.length > 0;
    const leadIsVideo = isVideoReference(lead);

    return (
        <div className="group relative">
            <label className={clsx(
                'relative flex h-[88px] w-[88px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[18px] border transition-colors',
                hasItems
                    ? 'border-border bg-surface-tertiary hover:border-border/70'
                    : 'border-border bg-surface-secondary text-text-secondary hover:bg-surface-tertiary',
            )}
            >
                <input
                    type="file"
                    accept={accept}
                    multiple={multiple}
                    className="hidden"
                    onChange={onChange}
                />

                {hasItems ? (
                    <>
                        {items.length === 1 ? (
                            leadIsVideo ? (
                                <div className="absolute inset-0 flex items-center justify-center bg-surface-elevated text-text-primary">
                                    <Clapperboard className="h-7 w-7" />
                                </div>
                            ) : (
                                <img src={lead?.dataUrl} alt={lead?.name || label} className="absolute inset-0 h-full w-full object-cover" />
                            )
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-surface-secondary">
                                {items.slice(0, 3).reverse().map((item, index) => (
                                    <div
                                        key={`${item.name}-${index}`}
                                        className="absolute h-[48px] w-[38px] overflow-hidden rounded-[10px] border border-white/40 bg-surface-tertiary shadow-[var(--ui-shadow-1)]"
                                        style={{
                                            transform: `translate(${index * 10 - 10}px, ${index * -4}px) rotate(${index === 1 ? -4 : index === 2 ? 5 : 0}deg)`,
                                        }}
                                    >
                                        {isVideoReference(item) ? (
                                            <div className="flex h-full w-full items-center justify-center bg-surface-elevated text-text-primary">
                                                <Clapperboard className="h-4 w-4" />
                                            </div>
                                        ) : (
                                            <img src={item.dataUrl} alt={item.name} className="h-full w-full object-cover" />
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent px-2 pb-2 pt-4 text-center">
                            <div className="truncate text-[11px] font-semibold text-white">{label}</div>
                            {items.length > 1 && (
                                <div className="mt-0.5 text-[10px] text-white/90">{items.length} 张</div>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        <Plus className="h-7 w-7" strokeWidth={1.8} />
                        <span className="mt-1.5 text-[11px] font-medium">{label}</span>
                    </>
                )}
            </label>

            {hasItems && onClear && (
                <button
                    type="button"
                    onClick={onClear}
                    className="absolute -right-1.5 -top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white shadow-[0_6px_16px_rgba(0,0,0,0.28)] group-hover:flex"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}

function AssetPreview({
    asset,
    className,
    style,
    interactive = false,
}: {
    asset: GeneratedAsset;
    className?: string;
    style?: React.CSSProperties;
    interactive?: boolean;
}) {
    if (!asset.previewUrl || !asset.exists) {
        return (
            <div
                className={clsx('flex items-center justify-center rounded-[16px] bg-surface-secondary text-xs text-text-tertiary', className)}
                style={style}
            >
                无法预览
            </div>
        );
    }
    const src = resolveAssetUrl(asset.previewUrl);
    if (isVideoAsset(asset)) {
        return (
            <video
                src={src}
                controls
                preload="metadata"
                className={clsx('w-full rounded-[16px] bg-black object-cover', interactive && 'pointer-events-none', className)}
                style={style}
            />
        );
    }
    return (
        <img
            src={src}
            alt={asset.title || asset.id}
            className={clsx('w-full rounded-[16px] object-cover', interactive && 'pointer-events-none', className)}
            style={style}
        />
    );
}

function AgentAttachmentCard({
    attachment,
    onClear,
}: {
    attachment: UploadedFileAttachment;
    onClear: () => void;
}) {
    const kind = attachmentVisualKind(attachment);
    const previewSrc = kind === 'image' ? attachmentPreviewSrc(attachment) : '';
    const meta = [attachmentKindLabel(kind), formatAttachmentSize(attachment.size)].filter(Boolean).join(' · ');

    return (
        <div className="flex items-center gap-3 rounded-[16px] border border-border bg-surface-secondary p-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-surface-tertiary">
                {previewSrc ? (
                    <img src={previewSrc} alt={attachment.name} className="h-full w-full object-cover" />
                ) : kind === 'video' ? (
                    <Clapperboard className="h-5 w-5 text-text-tertiary" />
                ) : kind === 'audio' ? (
                    <Music2 className="h-5 w-5 text-text-tertiary" />
                ) : (
                    <FileText className="h-5 w-5 text-text-tertiary" />
                )}
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-text-primary">{attachment.name}</div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">{meta || '附件'}</div>
            </div>
            <button
                type="button"
                onClick={onClear}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-primary text-text-tertiary transition-colors hover:text-text-primary"
                aria-label="移除附件"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}

function ReferenceStack({
    request,
    preview,
}: {
    request: GenerationRequest;
    preview?: ReferenceItem | null;
}) {
    const lead = preview || requestLeadingReference(request);
    if (!lead) {
        return (
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface-secondary text-text-tertiary">
                {request.type === 'image' ? <ImageIcon className="h-3.5 w-3.5" /> : <Clapperboard className="h-3.5 w-3.5" />}
            </div>
        );
    }
    return (
        <div className="h-10 w-10 overflow-hidden rounded-[12px] bg-surface-tertiary">
            <img src={lead.dataUrl} alt={lead.name} className="h-full w-full object-cover" />
        </div>
    );
}

function MetaRow({ request }: { request: GenerationRequest }) {
    const summary = buildRequestSummary(request);
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="inline-flex h-7 items-center rounded-[9px] bg-accent-muted px-2.5 text-[12px] font-semibold text-brand-red">
                {requestModeLabel(request)}
            </span>
            <div className="inline-flex min-w-0 flex-wrap items-center gap-2.5 rounded-[9px] bg-surface-secondary px-3 py-1.5 text-[12px] text-text-secondary">
                <span className="max-w-[240px] truncate font-medium text-text-primary">{summary[0]}</span>
                <span className="text-text-tertiary">|</span>
                <span>{summary[1]}</span>
                <span className="text-text-tertiary">|</span>
                <span>{summary[2]}</span>
                <span className="text-text-tertiary">|</span>
                <span>{requestSupportText(request)}</span>
            </div>
        </div>
    );
}

function FeedEntryMessage({
    entry,
    onRegenerate,
    onEdit,
    onPreviewAsset,
    onOpenAssetMenu,
}: {
    entry: GenerationFeedEntry;
    onRegenerate: (entry: GenerationFeedEntry) => void;
    onEdit: (entry: GenerationFeedEntry) => void;
    onPreviewAsset: (asset: GeneratedAsset) => void;
    onOpenAssetMenu: (event: React.MouseEvent<HTMLElement>, asset: GeneratedAsset, entryId?: string) => void;
}) {
    const [now, setNow] = useState(() => Date.now());
    const isRunning = entry.status === 'running';
    const progress = estimateGenerationProgress(entry.request, now - entry.createdAt);
    const placeholderCount = placeholderCountForRequest(entry.request);
    const placeholderAspectRatio = placeholderAspectRatioForRequest(entry.request);
    const mediaGridClass = feedMediaGridClass(entry.request, placeholderCount);
    const assetGridClass = feedMediaGridClass(entry.request, entry.assets.length);
    const mediaHeightClass = feedMediaHeightClass(entry.request);

    useEffect(() => {
        setNow(Date.now());
        if (!isRunning) return;
        const timer = window.setInterval(() => setNow(Date.now()), 800);
        return () => window.clearInterval(timer);
    }, [entry.createdAt, isRunning]);

    return (
        <article className="space-y-3">
            <div className="flex items-start gap-2.5">
                <ReferenceStack request={entry.request} preview={entry.referencePreview} />
                <div className="min-w-0 flex-1 space-y-2">
                    <MetaRow request={entry.request} />
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
                        <span>{formatRelativeTime(entry.createdAt)}</span>
                        <span>·</span>
                        <span>{SOURCE_LABELS[entry.source]}</span>
                        {entry.sourceTitle && (
                            <>
                                <span>·</span>
                                <span className="truncate">{entry.sourceTitle}</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="max-w-[680px] text-[13px] leading-6 text-text-primary">
                {entry.request.prompt}
            </div>

            {isRunning && (
                <div className="max-w-[760px] rounded-[16px] border border-border bg-surface-secondary px-4 py-3">
                    <div className="mb-2.5 flex items-center justify-between gap-4">
                        <div className="text-[12px] font-medium text-text-secondary">
                            任务创作中 {progress}%...
                        </div>
                        <div className="text-[11px] text-text-tertiary">
                            {entry.request.type === 'image' ? '正在生成图片' : '正在生成视频'}
                        </div>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-surface-tertiary">
                        <div
                            className="h-full rounded-full bg-[linear-gradient(90deg,rgb(var(--color-brand-red)/1)_0%,rgb(var(--color-accent-primary)/1)_100%)] transition-[width] duration-700 ease-out"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>
            )}

            {entry.status === 'error' && (
                <div className="max-w-[620px] rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                    {entry.error || '生成失败'}
                </div>
            )}

            {isRunning && entry.assets.length === 0 && (
                <div className={clsx('grid gap-4', mediaGridClass)}>
                    {Array.from({ length: placeholderCount }).map((_, index) => (
                        <div
                            key={`${entry.id}-placeholder-${index}`}
                            className={clsx(
                                'relative overflow-hidden rounded-[16px] border border-border bg-surface-secondary',
                                mediaHeightClass,
                            )}
                            style={{ aspectRatio: placeholderAspectRatio }}
                        >
                            <div
                                className="absolute inset-0"
                                style={{
                                    background: 'linear-gradient(180deg, rgb(var(--color-surface-primary) / 0.92) 0%, rgb(var(--color-surface-secondary) / 0.98) 100%)',
                                }}
                            />
                            <div
                                className="absolute -left-[12%] top-[-16%] h-[52%] w-[58%] rounded-full blur-[28px] animate-[pulse_2.1s_ease-in-out_infinite]"
                                style={{ background: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.3) 0%, rgb(var(--color-brand-red) / 0.14) 30%, rgb(var(--color-brand-red) / 0) 72%)' }}
                            />
                            <div
                                className="absolute right-[-10%] top-[8%] h-[42%] w-[46%] rounded-full blur-[24px] animate-[pulse_1.7s_ease-in-out_infinite]"
                                style={{ background: 'radial-gradient(circle, rgb(var(--color-accent-primary) / 0.24) 0%, rgb(var(--color-accent-primary) / 0.1) 36%, rgb(var(--color-accent-primary) / 0) 74%)' }}
                            />
                            <div
                                className="absolute bottom-[-12%] left-[18%] h-[44%] w-[50%] rounded-full blur-[26px] animate-[pulse_2.4s_ease-in-out_infinite]"
                                style={{ background: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.2) 0%, rgb(var(--color-brand-red) / 0.08) 34%, rgb(var(--color-brand-red) / 0) 76%)' }}
                            />
                            <div
                                className="absolute inset-0 opacity-90 animate-[pulse_1.35s_linear_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.32) 1.15px, transparent 1.55px)',
                                    backgroundSize: '20px 20px',
                                    backgroundPosition: '0 0',
                                    maskImage: 'linear-gradient(180deg, transparent 2%, rgba(0,0,0,0.86) 24%, rgba(0,0,0,0.94) 62%, transparent 98%)',
                                    WebkitMaskImage: 'linear-gradient(180deg, transparent 2%, rgba(0,0,0,0.86) 24%, rgba(0,0,0,0.94) 62%, transparent 98%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-85 animate-[pulse_1.1s_ease-in-out_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-accent-primary) / 0.42) 1.2px, transparent 1.7px)',
                                    backgroundSize: '18px 18px',
                                    backgroundPosition: '9px 6px',
                                    maskImage: 'radial-gradient(circle at 80% 22%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 15%, rgba(0,0,0,0.6) 29%, transparent 54%)',
                                    WebkitMaskImage: 'radial-gradient(circle at 80% 22%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 15%, rgba(0,0,0,0.6) 29%, transparent 54%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-85 animate-[pulse_0.95s_ease-in-out_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.36) 1.1px, transparent 1.6px)',
                                    backgroundSize: '17px 17px',
                                    backgroundPosition: '4px 10px',
                                    maskImage: 'radial-gradient(circle at 18% 80%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 16%, rgba(0,0,0,0.58) 31%, transparent 56%)',
                                    WebkitMaskImage: 'radial-gradient(circle at 18% 80%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 16%, rgba(0,0,0,0.58) 31%, transparent 56%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-65 animate-[pulse_1.45s_ease-in-out_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.22) 0.95px, transparent 1.45px)',
                                    backgroundSize: '14px 14px',
                                    backgroundPosition: '2px 3px',
                                    maskImage: 'linear-gradient(135deg, transparent 0%, rgba(0,0,0,0.94) 18%, rgba(0,0,0,0.94) 46%, transparent 68%)',
                                    WebkitMaskImage: 'linear-gradient(135deg, transparent 0%, rgba(0,0,0,0.94) 18%, rgba(0,0,0,0.94) 46%, transparent 68%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-55 animate-[pulse_0.8s_linear_infinite]"
                                style={{
                                    background: 'linear-gradient(110deg, transparent 12%, rgb(var(--color-surface-primary) / 0.24) 34%, rgb(var(--color-brand-red) / 0.18) 50%, rgb(var(--color-surface-primary) / 0.18) 63%, transparent 82%)',
                                    transform: 'translateX(-18%)',
                                    mixBlendMode: 'screen',
                                }}
                            />
                            <div className="absolute left-5 top-5 text-[12px] font-semibold text-text-secondary">
                                {entry.request.type === 'image' ? '正在创建图片' : '正在创建视频'}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {entry.assets.length > 0 && (
                <div className={clsx('grid gap-4', assetGridClass)}>
                    {entry.assets.map((asset) => (
                        <button
                            key={asset.id}
                            type="button"
                            onClick={() => onPreviewAsset(asset)}
                            onContextMenu={(event) => onOpenAssetMenu(event, asset, entry.id)}
                            disabled={!asset.previewUrl || !asset.exists}
                            className={clsx(
                                'group relative overflow-hidden rounded-[16px] text-left transition-transform',
                                asset.previewUrl && asset.exists
                                    ? 'cursor-pointer hover:-translate-y-0.5'
                                    : 'cursor-default',
                            )}
                            title={isVideoAsset(asset) ? '点击打开视频预览' : '点击放大图片'}
                        >
                            <AssetPreview
                                asset={asset}
                                className={clsx(mediaHeightClass, asset.previewUrl && asset.exists && 'transition-[filter] duration-200 group-hover:brightness-[0.94]')}
                                style={{ aspectRatio: normalizeAspectRatio(asset.aspectRatio, placeholderAspectRatio) }}
                                interactive
                            />
                            {asset.previewUrl && asset.exists && isVideoAsset(asset) && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white shadow-[0_10px_24px_rgba(0,0,0,0.28)]">
                                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                                    </div>
                                </div>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {!isRunning && (
                <div className="flex flex-wrap items-center gap-2.5">
                    <button
                        type="button"
                        onClick={() => onRegenerate(entry)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        再次生成
                    </button>
                    <button
                        type="button"
                        onClick={() => onEdit(entry)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
                    >
                        <PencilLine className="h-3.5 w-3.5" />
                        重新编辑
                    </button>
                </div>
            )}
        </article>
    );
}

export function GenerationStudio({
    isActive = false,
    pendingIntent = null,
    onIntentConsumed,
    onExecutionStateChange,
}: GenerationStudioProps) {
    const [settings, setSettings] = useState<SettingsShape>({});
    const [contextIntent, setContextIntent] = useState<GenerationIntent | null>(null);
    const [studioMode, setStudioMode] = useState<StudioMode>('image');
    const [imageCreationSurface, setImageCreationSurface] = useState<ImageCreationSurface>('manual');
    const [, setBindTarget] = useState('');
    const [feedEntries, setFeedEntries] = useState<FeedEntry[]>(() => readPersistedFeedEntries());
    const [previewAsset, setPreviewAsset] = useState<GeneratedAsset | null>(null);
    const [assetContextMenu, setAssetContextMenu] = useState<AssetContextMenuState | null>(null);
    const feedScrollRef = useRef<HTMLElement | null>(null);
    const feedBottomRef = useRef<HTMLDivElement | null>(null);
    const lastFeedCountRef = useRef(feedEntries.length);
    const agentSessionRequestIdRef = useRef(0);

    const [imagePrompt, setImagePrompt] = useState('');
    const [imageTitle, setImageTitle] = useState('');
    const [imageProjectId, setImageProjectId] = useState('');
    const [imageCount, setImageCount] = useState(1);
    const [imageModel, setImageModel] = useState('');
    const [imageAspectRatio, setImageAspectRatio] = useState('4:3');
    const [imageSize, setImageSize] = useState('');
    const [imageQuality, setImageQuality] = useState('auto');
    const [imageMode, setImageMode] = useState<ImageGenerationMode>('text-to-image');
    const [imageReferences, setImageReferences] = useState<ReferenceItem[]>([]);
    const [isReadingImageRefs, setIsReadingImageRefs] = useState(false);
    const [imageError, setImageError] = useState('');
    const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
    const [isAgentSessionLoading, setIsAgentSessionLoading] = useState(false);
    const [agentSessionError, setAgentSessionError] = useState('');
    const [agentExecutionActive, setAgentExecutionActive] = useState(false);
    const [agentPendingMessage, setAgentPendingMessage] = useState<PendingChatMessage | null>(null);
    const [agentAttachment, setAgentAttachment] = useState<UploadedFileAttachment | null>(null);

    const [videoPrompt, setVideoPrompt] = useState('');
    const [videoTitle, setVideoTitle] = useState('');
    const [videoProjectId, setVideoProjectId] = useState('');
    const [videoMode, setVideoMode] = useState<VideoGenerationMode>('text-to-video');
    const [videoReferences, setVideoReferences] = useState<Array<ReferenceItem | null>>([]);
    const [videoFirstFrame, setVideoFirstFrame] = useState<ReferenceItem | null>(null);
    const [videoLastFrame, setVideoLastFrame] = useState<ReferenceItem | null>(null);
    const [videoFirstClip, setVideoFirstClip] = useState<ReferenceItem | null>(null);
    const [videoDrivingAudio, setVideoDrivingAudio] = useState<ReferenceItem | null>(null);
    const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16'>('16:9');
    const [videoResolution, setVideoResolution] = useState<'720p' | '1080p'>('720p');
    const [videoDurationSeconds, setVideoDurationSeconds] = useState(8);
    const [videoGenerateAudio, setVideoGenerateAudio] = useState(false);
    const [isReadingVideoRefs, setIsReadingVideoRefs] = useState(false);
    const [videoError, setVideoError] = useState('');
    const trackedJobsById = useMediaJobsStore((state) => state.jobsById);
    const isAgentMode = studioMode === 'image' && imageCreationSurface === 'agent';
    const generationAgentTitle = useMemo(
        () => contextIntent?.sourceTitle ? `套图制作 · ${contextIntent.sourceTitle}` : '套图制作',
        [contextIntent?.sourceTitle],
    );
    const generationAgentContextId = useMemo(
        () => buildGenerationAgentContextId(imageProjectId, contextIntent?.source, contextIntent?.sourceTitle),
        [contextIntent?.source, contextIntent?.sourceTitle, imageProjectId],
    );
    const generationAgentInitialContext = useMemo(
        () => buildGenerationAgentInitialContext(imageProjectId, contextIntent?.sourceTitle),
        [contextIntent?.sourceTitle, imageProjectId],
    );
    const generationAgentSessionMetadata = useMemo(
        () => buildGenerationAgentSessionMetadata(imageProjectId, contextIntent?.sourceTitle),
        [contextIntent?.sourceTitle, imageProjectId],
    );
    const trackedJobIds = useMemo(
        () => feedEntries
            .filter(isGenerationFeedEntry)
            .map((entry) => entry.jobId)
            .filter((jobId): jobId is string => Boolean(jobId)),
        [feedEntries],
    );
    const updateFeedEntries = useCallback(
        (updater: FeedEntry[] | ((prev: FeedEntry[]) => FeedEntry[])) => {
            setFeedEntries((prev) => {
                const next = typeof updater === 'function'
                    ? (updater as (prev: FeedEntry[]) => FeedEntry[])(prev)
                    : updater;
                persistFeedEntries(next);
                return next;
            });
        },
        [],
    );
    const ensureAgentFeedEntry = useCallback((sessionId: string, createdAt = Date.now()) => {
        updateFeedEntries((prev) => {
            const existingIndex = prev.findIndex((entry) => (
                isAgentSessionFeedEntry(entry)
                && (entry.sessionId === sessionId || entry.contextId === generationAgentContextId)
            ));
            const nextEntry: AgentSessionFeedEntry = {
                kind: 'agent-session',
                id: existingIndex >= 0 ? prev[existingIndex].id : `agent-feed:${generationAgentContextId}`,
                createdAt: existingIndex >= 0 ? prev[existingIndex].createdAt : createdAt,
                source: contextIntent?.source || 'standalone',
                sourceTitle: contextIntent?.sourceTitle,
                sessionId,
                contextId: generationAgentContextId,
                title: generationAgentTitle,
            };
            if (existingIndex < 0) {
                return [...prev, nextEntry].sort((a, b) => a.createdAt - b.createdAt);
            }
            const existing = prev[existingIndex] as AgentSessionFeedEntry;
            if (
                existing.sessionId === nextEntry.sessionId
                && existing.contextId === nextEntry.contextId
                && existing.title === nextEntry.title
                && existing.source === nextEntry.source
                && existing.sourceTitle === nextEntry.sourceTitle
            ) {
                return prev;
            }
            const next = [...prev];
            next[existingIndex] = nextEntry;
            return next;
        });
    }, [contextIntent?.source, contextIntent?.sourceTitle, generationAgentContextId, generationAgentTitle, updateFeedEntries]);

    useMediaJobSubscription(trackedJobIds, {
        enabled: trackedJobIds.length > 0,
    });

    const loadContext = useCallback(async (overwriteDraftDefaults = false) => {
        try {
            const nextSettings = await window.ipcRenderer.getSettings() as SettingsShape;

            const normalizedSettings = (nextSettings || {}) as SettingsShape;
            setSettings(normalizedSettings);

            setImageModel((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_model || 'gpt-image-1') : prev));
            setImageAspectRatio((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_aspect_ratio || '4:3') : prev));
            setImageSize((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_size || '') : prev));
            setImageQuality((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_quality || 'auto') : prev));
        } catch (error) {
            console.error('Failed to load generation studio context:', error);
        }
    }, []);

    useEffect(() => {
        void loadContext(false);
    }, [isActive, loadContext]);

    useEffect(() => {
        if (!pendingIntent) return;
        applyIntentPreset(pendingIntent, {
            setStudioMode,
            setBindTarget,
            setImageAspectRatio,
            setVideoAspectRatio,
            setVideoResolution,
            setVideoDurationSeconds,
            setImageProjectId,
            setVideoProjectId,
            setContextIntent,
        });
        onIntentConsumed?.();
    }, [onIntentConsumed, pendingIntent]);

    useEffect(() => {
        onExecutionStateChange?.(agentExecutionActive || feedEntries.some((entry) => isGenerationFeedEntry(entry) && entry.status === 'running'));
    }, [agentExecutionActive, feedEntries, onExecutionStateChange]);

    useEffect(() => {
        if (!isAgentMode) {
            agentSessionRequestIdRef.current += 1;
            setAgentExecutionActive(false);
            setAgentSessionError('');
            setAgentPendingMessage(null);
            setAgentAttachment(null);
            setIsAgentSessionLoading(false);
            return;
        }

        const requestId = ++agentSessionRequestIdRef.current;
        setIsAgentSessionLoading(true);
        setAgentSessionError('');

        void (async () => {
            try {
                const session = await window.ipcRenderer.chat.getOrCreateContextSession({
                    contextId: generationAgentContextId,
                    contextType: GENERATION_AGENT_CONTEXT_TYPE,
                    title: generationAgentTitle,
                    initialContext: generationAgentInitialContext,
                    metadata: generationAgentSessionMetadata,
                });
                if (requestId !== agentSessionRequestIdRef.current) return;
                setAgentSessionId(session.id);
                const rawSessionTimestamp = session.createdAt || session.created_at || session.updatedAt || Date.now();
                const numericSessionTimestamp = typeof rawSessionTimestamp === 'number'
                    ? rawSessionTimestamp
                    : Number(rawSessionTimestamp);
                const sessionCreatedAt = Number.isFinite(numericSessionTimestamp)
                    ? numericSessionTimestamp
                    : Date.parse(String(rawSessionTimestamp));
                ensureAgentFeedEntry(session.id, Number.isFinite(sessionCreatedAt) ? sessionCreatedAt : Date.now());
                const existingMessages = await window.ipcRenderer.chat.getMessages(session.id);
                if (requestId !== agentSessionRequestIdRef.current) return;
                const hasExistingMessages = Array.isArray(existingMessages) && existingMessages.length > 0;
                if (hasExistingMessages) {
                    const rawFirstTimestamp = existingMessages[0]?.createdAt
                        || existingMessages[0]?.created_at
                        || existingMessages[0]?.timestamp
                        || Date.now();
                    const numericTimestamp = typeof rawFirstTimestamp === 'number'
                        ? rawFirstTimestamp
                        : Number(rawFirstTimestamp);
                    const firstTimestamp = Number.isFinite(numericTimestamp)
                        ? numericTimestamp
                        : Date.parse(String(rawFirstTimestamp));
                    ensureAgentFeedEntry(session.id, Number.isFinite(firstTimestamp) ? firstTimestamp : Date.now());
                }
            } catch (error) {
                if (requestId !== agentSessionRequestIdRef.current) return;
                console.error('Failed to initialize generation agent session:', error);
                setAgentSessionError(error instanceof Error ? error.message : '套图制作会话初始化失败');
            } finally {
                if (requestId === agentSessionRequestIdRef.current) {
                    setIsAgentSessionLoading(false);
                }
            }
        })();
    }, [ensureAgentFeedEntry, generationAgentContextId, generationAgentInitialContext, generationAgentSessionMetadata, generationAgentTitle, isAgentMode]);

    useEffect(() => {
        updateFeedEntries((prev) => {
            let changed = false;
            const next = prev.map((entry) => {
                const patched = applyJobProjectionToFeedEntry(
                    entry,
                    isGenerationFeedEntry(entry) && entry.jobId ? trackedJobsById[entry.jobId] : null,
                );
                if (patched !== entry) {
                    changed = true;
                }
                return patched;
            });
            return changed ? next : prev;
        });
    }, [trackedJobsById, updateFeedEntries]);

    useEffect(() => {
        if (!previewAsset) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setPreviewAsset(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewAsset]);

    useEffect(() => {
        if (!assetContextMenu) return;
        const handlePointerDown = () => setAssetContextMenu(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setAssetContextMenu(null);
        };
        window.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [assetContextMenu]);

    useEffect(() => {
        if (!isActive || feedEntries.length === 0) return;
        const frame = window.requestAnimationFrame(() => {
            feedBottomRef.current?.scrollIntoView({ block: 'end' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [isActive]);

    useEffect(() => {
        const previousCount = lastFeedCountRef.current;
        lastFeedCountRef.current = feedEntries.length;
        if (feedEntries.length === 0 || feedEntries.length <= previousCount) return;
        const frame = window.requestAnimationFrame(() => {
            const container = feedScrollRef.current;
            if (!container) return;
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [feedEntries.length]);

    const resolvedImageEndpoint = (settings.image_endpoint || settings.api_endpoint || '').trim();
    const resolvedImageApiKey = (settings.image_api_key || settings.api_key || '').trim();
    const hasImageConfig = Boolean(resolvedImageEndpoint) && Boolean(resolvedImageApiKey);
    const resolvedVideoEndpoint = (settings.video_endpoint || REDBOX_OFFICIAL_VIDEO_BASE_URL).trim();
    const resolvedVideoApiKey = (settings.video_api_key || settings.api_key || '').trim();
    const hasVideoConfig = Boolean(resolvedVideoEndpoint) && Boolean(resolvedVideoApiKey);
    const effectiveVideoModel = resolvedVideoEndpoint === REDBOX_OFFICIAL_VIDEO_BASE_URL
        ? getRedBoxOfficialVideoModel(videoMode)
        : (settings.video_model || getRedBoxOfficialVideoModel(videoMode)).trim();

    const imageModelLabel = imageModel.trim() || settings.image_model || 'GPT Image';
    const videoModelLabel = effectiveVideoModel;
    const currentConfigHint = studioMode === 'image'
        ? `${imageModelLabel} · ${imageAspectRatio || 'Auto'} · ${imageSize || '自动'}`
        : `${videoModelLabel} · ${videoAspectRatio} · ${videoResolution}`;
    const activeError = studioMode === 'image' ? imageError : videoError;
    const imageModelOptions = useMemo<PickerOption[]>(() => {
        const baseOptions: PickerOption[] = [
            { value: 'gpt-image-1', label: 'gpt-image-1' },
            { value: 'gpt-image-2', label: 'gpt-image-2' },
        ];

        if (!imageModel.trim()) return baseOptions;
        if (baseOptions.some((option) => option.value === imageModel)) return baseOptions;
        return [{ value: imageModel, label: imageModelLabel }, ...baseOptions];
    }, [imageModel, imageModelLabel]);

    const createFeedEntry = useCallback((request: GenerationRequest): GenerationFeedEntry => ({
        kind: 'generation',
        id: makeId('generation'),
        createdAt: Date.now(),
        source: contextIntent?.source || 'standalone',
        sourceTitle: contextIntent?.sourceTitle,
        referencePreview: requestLeadingReference(request),
        request,
        status: 'running',
        assets: [],
    }), [contextIntent?.source, contextIntent?.sourceTitle]);

    const runImageRequest = useCallback((request: ImageGenerationRequest): boolean => {
        if (!request.prompt.trim()) {
            setImageError('请先输入提示词');
            return false;
        }
        if (!hasImageConfig) {
            setImageError('未检测到生图配置，请先在设置中补齐');
            return false;
        }
        if (request.generationMode === 'image-to-image' && request.referenceItems.length === 0) {
            setImageError('图生图模式至少需要 1 张参考图');
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setImageError('');

        void (async () => {
            try {
                const result = await window.ipcRenderer.generation.submitImage({
                    prompt: request.prompt.trim(),
                    bypassPromptOptimizer: true,
                    projectId: request.projectId.trim() || undefined,
                    title: request.title.trim() || undefined,
                    generationMode: request.referenceItems.length > 0 ? request.generationMode : 'text-to-image',
                    referenceImages: request.referenceItems.map((item) => item.dataUrl),
                    count: request.count,
                    model: request.model.trim() || undefined,
                    provider: settings.image_provider || undefined,
                    providerTemplate: settings.image_provider_template || undefined,
                    aspectRatio: request.aspectRatio.trim() || undefined,
                    size: request.size.trim() || undefined,
                    quality: request.quality.trim() || undefined,
                    source: contextIntent?.source === 'manuscripts' ? 'manuscripts' : 'generation_studio',
                }) as { success?: boolean; error?: string; jobId?: string };

                if (!result?.success || !result?.jobId) {
                    throw new Error(result?.error || '生图失败');
                }

                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '生图失败';
                setImageError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [
        createFeedEntry,
        hasImageConfig,
        contextIntent?.source,
        settings.image_provider,
        settings.image_provider_template,
        updateFeedEntries,
    ]);

    const runVideoRequest = useCallback((request: VideoGenerationRequest): boolean => {
        if (!request.prompt.trim()) {
            setVideoError('请先输入提示词');
            return false;
        }
        const effectiveVideoMode = request.generationMode === 'text-to-video' && request.referenceItems.length > 0
            ? 'reference-guided'
            : request.generationMode;
        if (!hasVideoConfig) {
            setVideoError('未检测到生视频配置，请先在设置中补齐');
            return false;
        }
        if (effectiveVideoMode === 'reference-guided' && request.referenceItems.length === 0) {
            setVideoError('参考图视频模式至少需要 1 张参考图');
            return false;
        }
        if (effectiveVideoMode === 'first-last-frame' && request.referenceItems.length < 2) {
            setVideoError('首尾帧模式需要首帧和尾帧两张图片');
            return false;
        }
        if (effectiveVideoMode === 'continuation' && !request.firstClip?.dataUrl) {
            setVideoError('视频续写模式需要上传起始视频');
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setVideoError('');

        void (async () => {
            try {
                const result = await window.ipcRenderer.generation.submitVideo({
                    prompt: request.prompt.trim(),
                    projectId: request.projectId.trim() || undefined,
                    title: request.title.trim() || undefined,
                    generationMode: effectiveVideoMode,
                    referenceImages: request.referenceItems.map((item) => item.dataUrl),
                    firstClip: request.firstClip?.dataUrl || undefined,
                    drivingAudio: request.drivingAudio?.dataUrl || undefined,
                    aspectRatio: request.aspectRatio,
                    resolution: request.resolution,
                    durationSeconds: request.durationSeconds,
                    model: request.model,
                    generateAudio: request.generateAudio,
                    source: contextIntent?.source === 'manuscripts' ? 'manuscripts' : 'generation_studio',
                }) as { success?: boolean; error?: string; jobId?: string };

                if (!result?.success || !result?.jobId) {
                    throw new Error(result?.error || '生视频失败');
                }

                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '生视频失败';
                setVideoError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [contextIntent?.source, createFeedEntry, hasVideoConfig, updateFeedEntries]);

    const handleGenerateImage = useCallback(() => {
        const effectiveImageMode: ImageGenerationMode = imageReferences.length > 0
            ? (imageMode === 'text-to-image' ? 'reference-guided' : imageMode)
            : 'text-to-image';
        const accepted = runImageRequest({
            type: 'image',
            prompt: imagePrompt,
            title: imageTitle,
            projectId: imageProjectId,
            count: imageCount,
            model: imageModel,
            aspectRatio: imageAspectRatio,
            size: imageSize,
            quality: imageQuality,
            generationMode: effectiveImageMode,
            referenceItems: imageReferences,
        });
        if (!accepted) return;
        setImagePrompt('');
        setImageReferences([]);
    }, [
        imageAspectRatio,
        imageCount,
        imageMode,
        imageModel,
        imagePrompt,
        imageProjectId,
        imageQuality,
        imageReferences,
        imageSize,
        imageTitle,
        runImageRequest,
    ]);

    const handleGenerateVideo = useCallback(() => {
        const effectiveReferences = videoMode === 'reference-guided'
            ? videoReferences.filter(Boolean) as ReferenceItem[]
            : videoMode === 'first-last-frame'
                ? [videoFirstFrame, videoLastFrame].filter(Boolean) as ReferenceItem[]
                : [];
        const effectiveVideoMode = effectiveReferences.length > 0 && videoMode === 'text-to-video'
            ? 'reference-guided'
            : videoMode;

        const accepted = runVideoRequest({
            type: 'video',
            prompt: videoPrompt,
            title: videoTitle,
            projectId: videoProjectId,
            model: effectiveVideoModel,
            aspectRatio: videoAspectRatio,
            resolution: videoResolution,
            durationSeconds: videoDurationSeconds,
            generateAudio: videoGenerateAudio,
            generationMode: effectiveVideoMode,
            referenceItems: effectiveReferences,
            firstClip: videoFirstClip,
            drivingAudio: videoDrivingAudio,
        });
        if (!accepted) return;
        setVideoPrompt('');
        setVideoReferences([]);
        setVideoFirstFrame(null);
        setVideoLastFrame(null);
        setVideoFirstClip(null);
        setVideoDrivingAudio(null);
    }, [
        runVideoRequest,
        videoAspectRatio,
        videoDrivingAudio,
        videoDurationSeconds,
        videoFirstClip,
        videoFirstFrame,
        videoGenerateAudio,
        videoLastFrame,
        effectiveVideoModel,
        videoMode,
        videoProjectId,
        videoPrompt,
        videoReferences,
        videoResolution,
        videoTitle,
    ]);

    const handleRegenerate = useCallback((entry: GenerationFeedEntry) => {
        if (entry.request.type === 'image') {
            runImageRequest(entry.request);
            return;
        }
        runVideoRequest(entry.request);
    }, [runImageRequest, runVideoRequest]);

    const handleEditEntry = useCallback((entry: GenerationFeedEntry) => {
        setStudioMode(entry.request.type);
        if (entry.request.type === 'image') {
            setImagePrompt(entry.request.prompt);
            setImageTitle(entry.request.title);
            setImageProjectId(entry.request.projectId);
            setImageCount(entry.request.count);
            setImageModel(entry.request.model);
            setImageAspectRatio(entry.request.aspectRatio);
            setImageSize(entry.request.size);
            setImageQuality(entry.request.quality);
            setImageMode(entry.request.generationMode);
            setImageReferences(entry.request.referenceItems);
            return;
        }
        setVideoPrompt(entry.request.prompt);
        setVideoTitle(entry.request.title);
        setVideoProjectId(entry.request.projectId);
        setVideoMode(entry.request.generationMode);
        setVideoAspectRatio(entry.request.aspectRatio);
        setVideoResolution(entry.request.resolution);
        setVideoDurationSeconds(entry.request.durationSeconds);
        setVideoGenerateAudio(entry.request.generateAudio);
        setVideoReferences(entry.request.generationMode === 'reference-guided' ? entry.request.referenceItems : []);
        setVideoFirstFrame(entry.request.generationMode === 'first-last-frame' ? entry.request.referenceItems[0] || null : null);
        setVideoLastFrame(entry.request.generationMode === 'first-last-frame' ? entry.request.referenceItems[1] || null : null);
        setVideoFirstClip(entry.request.firstClip || null);
        setVideoDrivingAudio(entry.request.drivingAudio || null);
    }, []);

    const handleDeleteEntry = useCallback((entryId: string) => {
        updateFeedEntries((prev) => prev.filter((entry) => entry.id !== entryId));
        setAssetContextMenu((current) => (current?.entryId === entryId ? null : current));
    }, []);

    const resolveAssetSource = useCallback((asset: GeneratedAsset) => (
        asset.previewUrl || asset.relativePath || ''
    ), []);

    const handleCopyAsset = useCallback(async (asset: GeneratedAsset) => {
        const source = resolveAssetSource(asset);
        if (!source) return;
        try {
            const result = await window.ipcRenderer.files.copyImage({ source }) as {
                success?: boolean;
                error?: string;
            };
            if (!result?.success) {
                throw new Error(result?.error || '复制失败');
            }
        } catch (error) {
            console.error('Failed to copy generated asset:', error);
            void appAlert(error instanceof Error ? error.message : '复制失败');
        }
    }, [resolveAssetSource]);

    const handleSaveAsset = useCallback(async (asset: GeneratedAsset) => {
        const source = resolveAssetSource(asset);
        if (!source) return;
        try {
            const extension = inferAssetExtension(asset, source);
            const result = await window.ipcRenderer.files.saveAs({
                source,
                defaultName: `${Date.now()}.${extension}`,
            }) as {
                success?: boolean;
                error?: string;
                canceled?: boolean;
            };
            if (!result?.success && !result?.canceled) {
                throw new Error(result?.error || '保存失败');
            }
        } catch (error) {
            console.error('Failed to save generated asset:', error);
            void appAlert(error instanceof Error ? error.message : '保存失败');
        }
    }, [resolveAssetSource]);

    const handleShowAssetInFolder = useCallback(async (asset: GeneratedAsset) => {
        const source = resolveAssetSource(asset);
        if (!source) return;
        try {
            const result = await window.ipcRenderer.files.showInFolder({ source }) as {
                success?: boolean;
                error?: string;
            };
            if (!result?.success) {
                throw new Error(result?.error || '打开文件夹失败');
            }
        } catch (error) {
            console.error('Failed to reveal generated asset:', error);
            void appAlert(error instanceof Error ? error.message : '打开文件夹失败');
        }
    }, [resolveAssetSource]);

    const handleEditAsset = useCallback(async (asset: GeneratedAsset) => {
        if (isVideoAsset(asset)) {
            void appAlert('当前仅支持把图片加入参考图');
            return;
        }
        const source = resolveAssetSource(asset);
        if (!source) return;
        try {
            const assetUrl = resolveAssetUrl(source);
            if (!assetUrl) {
                throw new Error('素材地址无效');
            }
            const response = await fetch(assetUrl);
            if (!response.ok) {
                throw new Error(`读取素材失败 (${response.status})`);
            }
            const blob = await response.blob();
            const dataUrl = await readBlobAsDataUrl(blob);
            const extension = inferAssetExtension(asset, source);
            const name = `${asset.title || `reference-${Date.now()}`}.${extension}`;
            setStudioMode('image');
            setImageMode((prev) => (prev === 'text-to-image' ? 'reference-guided' : prev));
            setImageReferences((prev) => [
                { name, dataUrl },
                ...prev,
            ].slice(0, 4));
            setImageError('');
        } catch (error) {
            console.error('Failed to reuse generated asset as reference:', error);
            void appAlert(error instanceof Error ? error.message : '添加参考图失败');
        }
    }, [resolveAssetSource]);

    const handleOpenAssetMenu = useCallback((
        event: React.MouseEvent<HTMLButtonElement>,
        asset: GeneratedAsset,
        entryId: string,
    ) => {
        event.preventDefault();
        setAssetContextMenu({
            asset,
            entryId,
            x: event.clientX,
            y: event.clientY,
        });
    }, []);

    const handleImageReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        setIsReadingImageRefs(true);
        try {
            const nextItems = await Promise.all(files.slice(0, 4).map(async (file) => ({
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            })));
            setImageReferences((prev) => [...prev, ...nextItems].slice(0, 4));
        } catch (error) {
            console.error('Failed to read image references:', error);
            setImageError('参考图读取失败，请重试');
        } finally {
            setIsReadingImageRefs(false);
            event.target.value = '';
        }
    }, []);

    const handleVideoReferenceFile = useCallback(async (
        event: React.ChangeEvent<HTMLInputElement>,
        target: number | 'first' | 'last' | 'firstClip' | 'drivingAudio',
    ) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingVideoRefs(true);
        try {
            const item = {
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            };
            if (typeof target === 'number') {
                setVideoReferences((prev) => {
                    const next = [...prev];
                    next[target] = item;
                    return next.slice(0, 5);
                });
                if (videoMode === 'text-to-video') {
                    setVideoMode('reference-guided');
                }
            } else if (target === 'first') {
                setVideoFirstFrame(item);
            } else if (target === 'last') {
                setVideoLastFrame(item);
            } else if (target === 'firstClip') {
                setVideoFirstClip(item);
            } else {
                setVideoDrivingAudio(item);
            }
        } catch (error) {
            console.error('Failed to read video reference:', error);
            setVideoError('参考素材读取失败，请重试');
        } finally {
            setIsReadingVideoRefs(false);
            event.target.value = '';
        }
    }, [videoMode]);

    const handleVideoReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        setIsReadingVideoRefs(true);
        try {
            const nextItems = await Promise.all(files.slice(0, 5).map(async (file) => ({
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            })));
            setVideoReferences((prev) => [...prev.filter(Boolean), ...nextItems].slice(0, 5));
            if (videoMode === 'text-to-video' && nextItems.length > 0) {
                setVideoMode('reference-guided');
            }
        } catch (error) {
            console.error('Failed to read video references:', error);
            setVideoError('参考素材读取失败，请重试');
        } finally {
            setIsReadingVideoRefs(false);
            event.target.value = '';
        }
    }, [videoMode]);

    const uploadedVideoRefs = useMemo(() => {
        if (videoMode === 'reference-guided') {
            return videoReferences.filter(Boolean) as ReferenceItem[];
        }
        if (videoMode === 'first-last-frame') {
            return [videoFirstFrame, videoLastFrame].filter(Boolean) as ReferenceItem[];
        }
        return [];
    }, [videoFirstFrame, videoLastFrame, videoMode, videoReferences]);

    const composerGridClass = studioMode === 'video' && videoMode === 'first-last-frame'
        ? 'grid items-start gap-4 md:grid-cols-[196px_minmax(0,1fr)]'
        : 'grid items-start gap-4 md:grid-cols-[104px_minmax(0,1fr)]';
    const composerWidthClass = 'mx-auto w-full max-w-[900px]';
    const currentHeaderHint = isAgentMode ? '套图制作 · 对话驱动' : currentConfigHint;
    const canSendAgentMessage = isAgentMode
        && Boolean(agentSessionId)
        && !isAgentSessionLoading
        && !agentExecutionActive
        && (imagePrompt.trim().length > 0 || Boolean(agentAttachment));
    const handlePickAgentAttachment = useCallback(async () => {
        if (!agentSessionId || isAgentSessionLoading || agentExecutionActive) return;
        try {
            const result = await window.ipcRenderer.chat.pickAttachment({
                sessionId: agentSessionId,
            }) as { success?: boolean; canceled?: boolean; error?: string; attachment?: UploadedFileAttachment };
            if (!result?.success) {
                throw new Error(result?.error || '上传附件失败');
            }
            if (result.canceled || !result.attachment) return;
            setAgentAttachment(result.attachment);
            setImageError('');
        } catch (error) {
            console.error('Failed to pick generation agent attachment:', error);
            setImageError(error instanceof Error ? error.message : '上传附件失败');
        }
    }, [agentExecutionActive, agentSessionId, isAgentSessionLoading]);
    const handleSendAgentMessage = useCallback(async () => {
        const content = imagePrompt.trim();
        if ((!content && !agentAttachment) || !agentSessionId || isAgentSessionLoading || agentExecutionActive) return;
        let attachment: UploadedFileAttachment | undefined;
        let attachmentContextNote = '';

        if (agentAttachment && attachmentVisualKind(agentAttachment) === 'image') {
            try {
                const uploadedImage = await attachmentToReferenceItem(agentAttachment);
                const combinedReferences = uploadedImage
                    ? [uploadedImage, ...imageReferences]
                    : [...imageReferences];
                const contactSheet = await buildReferenceContactSheet(combinedReferences);
                const result = await window.ipcRenderer.chat.createInlineAttachment({
                    dataUrl: contactSheet.dataUrl,
                    fileName: contactSheet.fileName,
                    sessionId: agentSessionId,
                }) as { success?: boolean; error?: string; attachment?: UploadedFileAttachment };
                if (!result?.success || !result.attachment) {
                    throw new Error(result?.error || '参考图附件创建失败');
                }
                attachment = result.attachment;
                attachmentContextNote = contactSheet.note;
            } catch (error) {
                console.error('Failed to merge generation references:', error);
                setImageError(error instanceof Error ? error.message : '参考图附件创建失败');
                return;
            }
        } else if (agentAttachment) {
            attachment = agentAttachment;
            if (imageReferences.length > 0) {
                attachmentContextNote = `当前轮次还存在 ${imageReferences.length} 张创作参考图未随消息附带；如需让 AI 读取这些图，请移除当前文件附件，或把参考图直接通过左侧图片区发送。`;
            }
        } else if (imageReferences.length > 0) {
            try {
                const contactSheet = await buildReferenceContactSheet(imageReferences);
                const result = await window.ipcRenderer.chat.createInlineAttachment({
                    dataUrl: contactSheet.dataUrl,
                    fileName: contactSheet.fileName,
                    sessionId: agentSessionId,
                }) as { success?: boolean; error?: string; attachment?: UploadedFileAttachment };
                if (!result?.success || !result.attachment) {
                    throw new Error(result?.error || '参考图附件创建失败');
                }
                attachment = result.attachment;
                attachmentContextNote = contactSheet.note;
            } catch (error) {
                console.error('Failed to create inline agent attachment:', error);
                setImageError(error instanceof Error ? error.message : '参考图附件创建失败');
                return;
            }
        }
        ensureAgentFeedEntry(agentSessionId);
        const messageContent = [content, attachmentContextNote].filter(Boolean).join('\n\n').trim();
        setAgentPendingMessage({
            content: messageContent,
            displayContent: content || (attachment ? `请处理这个附件：${attachment.name}` : undefined),
            attachment,
        });
        setImagePrompt('');
        setImageError('');
        setAgentAttachment(null);
    }, [agentAttachment, agentExecutionActive, agentSessionId, ensureAgentFeedEntry, imagePrompt, imageReferences, isAgentSessionLoading]);
    const studioToolbar = (
        <div className="flex items-center gap-2.5">
            <button
                type="button"
                onClick={() => setStudioMode('image')}
                className={clsx(
                    'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'image'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <ImagePlus className="h-4 w-4" />
                图片创作
            </button>
            <button
                type="button"
                onClick={() => setStudioMode('video')}
                className={clsx(
                    'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'video'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <Clapperboard className="h-4 w-4" />
                视频创作
            </button>
            {studioMode === 'image' && (
                <button
                    type="button"
                    role="switch"
                    aria-checked={isAgentMode}
                    aria-label="套图制作"
                    onClick={() => setImageCreationSurface((prev) => prev === 'agent' ? 'manual' : 'agent')}
                    className="inline-flex items-center gap-3 rounded-full px-1 py-1 text-[14px] font-medium text-text-secondary transition-colors"
                >
                    <span className="inline-flex items-center gap-2">
                        <Sparkles className={clsx('h-4 w-4 transition-colors', isAgentMode ? 'text-brand-red' : 'text-text-tertiary')} />
                        <span>套图制作</span>
                    </span>
                    <span
                        className={clsx(
                            'relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors duration-200',
                            isAgentMode
                                ? 'border-brand-red/40 bg-brand-red'
                                : 'border-border bg-surface-tertiary',
                        )}
                    >
                        <span
                            className={clsx(
                                'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22)] transition-transform duration-200',
                                isAgentMode ? 'translate-x-[22px]' : 'translate-x-0.5',
                            )}
                        />
                    </span>
                </button>
            )}
            <div className="ml-auto hidden text-[12px] text-text-tertiary md:block">{currentHeaderHint}</div>
        </div>
    );

    return (
        <div className="h-full min-h-0 bg-background text-text-primary">
            <div className="mx-auto flex h-full min-h-0 max-w-[1180px] flex-col px-6">
                <main ref={feedScrollRef} className="flex-1 min-h-0 overflow-y-auto pt-6">
                    {feedEntries.length === 0 ? (
                        <div className="min-h-[280px]" />
                    ) : (
                        <div className="mx-auto max-w-[860px] space-y-7 pb-10">
                            {feedEntries.map((entry) => (
                                isGenerationFeedEntry(entry) ? (
                                    <FeedEntryMessage
                                        key={entry.id}
                                        entry={entry}
                                        onRegenerate={handleRegenerate}
                                        onEdit={handleEditEntry}
                                        onPreviewAsset={setPreviewAsset}
                                        onOpenAssetMenu={handleOpenAssetMenu}
                                    />
                                ) : (
                                    <Chat
                                        key={entry.id}
                                        isActive={isActive}
                                        fixedSessionId={entry.sessionId}
                                        pendingMessage={entry.sessionId === agentSessionId ? agentPendingMessage : null}
                                        onMessageConsumed={() => {
                                            if (entry.sessionId === agentSessionId) {
                                                setAgentPendingMessage(null);
                                            }
                                        }}
                                        defaultCollapsed={true}
                                        showClearButton={false}
                                        showWelcomeShortcuts={false}
                                        showComposerShortcuts={false}
                                        showComposer={false}
                                        showMessageAttachments={true}
                                        showWelcomeHeader={false}
                                        collapseEmptyFixedSession={true}
                                        fixedSessionContextIndicatorMode="none"
                                        welcomeTitle=""
                                        welcomeSubtitle=""
                                        contentLayout="wide"
                                        allowFileUpload={false}
                                        messageWorkflowPlacement="top"
                                        messageWorkflowVariant="compact"
                                        messageWorkflowEmphasis="thoughts-first"
                                        messageWorkflowDisplayMode="all"
                                        onExecutionStateChange={entry.sessionId === agentSessionId ? setAgentExecutionActive : undefined}
                                    />
                                )
                            ))}
                            <div ref={feedBottomRef} />
                        </div>
                    )}
                </main>

                <footer className="bg-background pb-5 pt-4">
                    <div className={composerWidthClass}>
                        <div className="rounded-[24px] border border-border bg-surface-secondary px-5 py-3 shadow-[var(--ui-shadow-1)]">
                            {studioToolbar}

                            <div className="mt-3 rounded-[20px] border border-border bg-surface-primary p-4">
                                <div className={composerGridClass}>
                                    <div className="space-y-3">
                                        {studioMode === 'image' ? (
                                            <UploadPreviewCard
                                                label={isReadingImageRefs ? '读取中' : '图片'}
                                                accept="image/*"
                                                multiple
                                                items={imageReferences}
                                                onChange={handleImageReferenceFiles}
                                                onClear={() => setImageReferences([])}
                                            />
                                        ) : videoMode === 'first-last-frame' ? (
                                            <div className="grid grid-cols-2 gap-3">
                                                <UploadPreviewCard
                                                    label={isReadingVideoRefs ? '读取中' : '首帧'}
                                                    accept="image/*"
                                                    items={videoFirstFrame ? [videoFirstFrame] : []}
                                                    onChange={(event) => void handleVideoReferenceFile(event, 'first')}
                                                    onClear={() => setVideoFirstFrame(null)}
                                                />
                                                <UploadPreviewCard
                                                    label={isReadingVideoRefs ? '读取中' : '尾帧'}
                                                    accept="image/*"
                                                    items={videoLastFrame ? [videoLastFrame] : []}
                                                    onChange={(event) => void handleVideoReferenceFile(event, 'last')}
                                                    onClear={() => setVideoLastFrame(null)}
                                                />
                                            </div>
                                        ) : videoMode === 'continuation' ? (
                                            <UploadPreviewCard
                                                label={isReadingVideoRefs ? '读取中' : '视频'}
                                                accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                                                items={videoFirstClip ? [videoFirstClip] : []}
                                                onChange={(event) => void handleVideoReferenceFile(event, 'firstClip')}
                                                onClear={() => setVideoFirstClip(null)}
                                            />
                                        ) : (
                                            <UploadPreviewCard
                                                label={isReadingVideoRefs ? '读取中' : '图片'}
                                                accept="image/*"
                                                multiple
                                                items={uploadedVideoRefs}
                                                onChange={handleVideoReferenceFiles}
                                                onClear={() => setVideoReferences([])}
                                            />
                                        )}
                                    </div>

                                    <div className="space-y-3">
                                        <textarea
                                            value={studioMode === 'image' ? imagePrompt : videoPrompt}
                                            onChange={(event) => (
                                                studioMode === 'image'
                                                    ? setImagePrompt(event.target.value)
                                                    : setVideoPrompt(event.target.value)
                                            )}
                                            rows={2}
                                            placeholder={studioMode === 'image' ? '描述您想生成的场景、风格、细节...' : '描述您想生成的视频场景、镜头、动作...'}
                                            className="min-h-[54px] w-full resize-none bg-transparent text-[14px] leading-6 text-text-primary outline-none placeholder:text-text-tertiary"
                                        />

                                        {studioMode === 'image' && isAgentMode && agentAttachment && (
                                            <AgentAttachmentCard
                                                attachment={agentAttachment}
                                                onClear={() => setAgentAttachment(null)}
                                            />
                                        )}

                                        <div className="flex flex-wrap items-center gap-2">
                                            {studioMode === 'image' ? (
                                                <>
                                                    {isAgentMode && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void handlePickAgentAttachment()}
                                                            disabled={!agentSessionId || isAgentSessionLoading || agentExecutionActive}
                                                            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary disabled:opacity-45"
                                                        >
                                                            <Paperclip className="h-3.5 w-3.5" />
                                                            附件
                                                        </button>
                                                    )}
                                                    <PopoverSelect
                                                        value={imageModel}
                                                        onChange={setImageModel}
                                                        options={imageModelOptions}
                                                        className="min-w-[156px]"
                                                        title="图片模型"
                                                        panelClassName="w-[240px]"
                                                        layout="column"
                                                    />
                                                    <ImageAspectRatioPicker
                                                        value={imageAspectRatio}
                                                        onChange={setImageAspectRatio}
                                                    />
                                                    <PopoverSelect
                                                        value={imageSize}
                                                        onChange={setImageSize}
                                                        options={IMAGE_SIZE_OPTIONS}
                                                        className="min-w-[82px]"
                                                        title="图片尺寸"
                                                        panelClassName="w-[248px]"
                                                    />
                                                    <PopoverSelect
                                                        value={String(imageCount)}
                                                        onChange={(value) => setImageCount(Number(value) || 1)}
                                                        options={IMAGE_COUNT_OPTIONS}
                                                        className="min-w-[78px]"
                                                        title="生成数量"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateImage}
                                                        disabled={isAgentMode ? !canSendAgentMessage : !hasImageConfig}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                    >
                                                        {isAgentMode ? (
                                                            agentExecutionActive ? (
                                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                            ) : (
                                                                <ArrowUp className="h-5 w-5" />
                                                            )
                                                        ) : (
                                                            <Sparkles className="h-5 w-5" />
                                                        )}
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    <PopoverSelect
                                                        value={videoMode}
                                                        onChange={(value) => setVideoMode(value as VideoGenerationMode)}
                                                        options={VIDEO_MODE_OPTIONS}
                                                        className="min-w-[150px]"
                                                        title="视频模式"
                                                        panelClassName="w-[280px]"
                                                    />
                                                    <PopoverSelect
                                                        value={videoAspectRatio}
                                                        onChange={(value) => setVideoAspectRatio(value as '16:9' | '9:16')}
                                                        options={VIDEO_ASPECT_RATIO_OPTIONS}
                                                        className="min-w-[96px]"
                                                        title="视频比例"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <PopoverSelect
                                                        value={videoResolution}
                                                        onChange={(value) => setVideoResolution(value as '720p' | '1080p')}
                                                        options={VIDEO_RESOLUTION_OPTIONS}
                                                        className="min-w-[96px]"
                                                        title="视频清晰度"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <PopoverSelect
                                                        value={String(videoDurationSeconds)}
                                                        onChange={(value) => setVideoDurationSeconds(Number(value) || 8)}
                                                        options={VIDEO_DURATION_OPTIONS}
                                                        className="min-w-[96px]"
                                                        title="视频时长"
                                                        panelClassName="w-[188px]"
                                                        layout="column"
                                                    />
                                                    <PopoverSelect
                                                        value={videoGenerateAudio ? 'on' : 'off'}
                                                        onChange={(value) => setVideoGenerateAudio(value === 'on')}
                                                        options={VIDEO_AUDIO_OPTIONS}
                                                        className="min-w-[92px]"
                                                        title="音频"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={handleGenerateVideo}
                                                        disabled={!hasVideoConfig}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                    >
                                                        <Sparkles className="h-5 w-5" />
                                                    </button>
                                                </>
                                            )}
                                        </div>

                                        {studioMode === 'image' && isReadingImageRefs && (
                                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-tertiary">
                                                <span>正在读取参考图...</span>
                                            </div>
                                        )}

                                        {studioMode === 'video' && (
                                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-tertiary">
                                                {videoDrivingAudio && <span>已附带驱动音频</span>}
                                                {isReadingVideoRefs && <span>正在读取素材...</span>}
                                            </div>
                                        )}

                                        {((isAgentMode && studioMode === 'image') ? (agentSessionError || imageError) : activeError) && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                {(isAgentMode && studioMode === 'image') ? (agentSessionError || imageError) : activeError}
                                            </div>
                                        )}

                                        {studioMode === 'image' && !isAgentMode && !hasImageConfig && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                未检测到生图配置。请先到“设置 → AI 模型”填写图片生成的 Endpoint、API Key 和模型。
                                            </div>
                                        )}

                                        {studioMode === 'video' && !hasVideoConfig && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                未检测到生视频配置。请先完成官方视频登录或填写视频生成所需的 API Key。
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </footer>
            </div>

            {previewAsset && (
                <div
                    className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/72 p-6 backdrop-blur-[1px]"
                    onMouseDown={() => setPreviewAsset(null)}
                >
                    <div
                        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            onClick={() => setPreviewAsset(null)}
                            className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/65"
                        >
                            <X className="h-4 w-4" />
                        </button>
                        {isVideoAsset(previewAsset) ? (
                            <video
                                src={resolveAssetUrl(previewAsset.previewUrl || '')}
                                controls
                                autoPlay
                                preload="metadata"
                                className="max-h-[90vh] max-w-[92vw] rounded-2xl bg-black shadow-2xl"
                            />
                        ) : (
                            <img
                                src={resolveAssetUrl(previewAsset.previewUrl || '')}
                                alt={previewAsset.title || previewAsset.id}
                                className="max-h-[90vh] max-w-[92vw] rounded-2xl border border-white/10 bg-black/10 object-contain shadow-2xl"
                            />
                        )}
                    </div>
                </div>
            )}

            {assetContextMenu && (
                <div
                    className="fixed z-[1250] min-w-[148px] overflow-hidden rounded-[16px] border border-border bg-surface-elevated p-1.5 text-text-primary shadow-[var(--ui-shadow-2)]"
                    style={{
                        left: Math.min(assetContextMenu.x, window.innerWidth - 172),
                        top: Math.min(assetContextMenu.y, window.innerHeight - 244),
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            void handleCopyAsset(assetContextMenu.asset);
                            setAssetContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                        <Copy className="h-3.5 w-3.5" />
                        复制
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void handleSaveAsset(assetContextMenu.asset);
                            setAssetContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                        <Download className="h-3.5 w-3.5" />
                        保存
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void handleShowAssetInFolder(assetContextMenu.asset);
                            setAssetContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                        <FolderOpen className="h-3.5 w-3.5" />
                        打开文件夹
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void handleEditAsset(assetContextMenu.asset);
                            setAssetContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                        <PencilLine className="h-3.5 w-3.5" />
                        编辑
                    </button>
                    <button
                        type="button"
                        onClick={() => assetContextMenu.entryId && handleDeleteEntry(assetContextMenu.entryId)}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-brand-red transition-colors hover:bg-brand-red/10"
                    >
                        <X className="h-3.5 w-3.5" />
                        删除
                    </button>
                </div>
            )}
        </div>
    );
}
