import {
    isMediaJobSuccessful,
    isMediaJobTerminal,
    type MediaJobProjection,
} from '../media-jobs/types';
import { resolveAssetUrl } from '../../utils/pathManager';

export type StudioMode = 'image' | 'video' | 'audio' | 'cover' | 'digital-human';
export type ImageGenerationMode = 'text-to-image' | 'reference-guided' | 'image-to-image';
export type VideoGenerationMode = 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation';
export type GenerationFeedSource = string;

export type ReferenceItem = {
    name: string;
    dataUrl: string;
};

export type GeneratedAsset = {
    id: string;
    title?: string;
    prompt?: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    thumbnail_url?: string;
    mimeType?: string;
    mime_type?: string;
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

export type ImageGenerationRequest = {
    type: 'image';
    prompt: string;
    title: string;
    projectId: string;
    count: number;
    model: string;
    aspectRatio: string;
    size: string;
    quality: string;
    resolution: string;
    generationMode: ImageGenerationMode;
    referenceItems: ReferenceItem[];
};

export type VideoGenerationRequest = {
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

export type AudioGenerationRequest = {
    type: 'audio';
    prompt: string;
    title: string;
    projectId: string;
    model: string;
    voiceId: string;
    voiceTargetTtsModel?: string;
    languageBoost: string;
    speed: string;
    emotion: string;
    responseFormat: string;
};

export type CoverPromptSwitches = {
    learnTypography: boolean;
    learnColorMood: boolean;
    beautifyFace: boolean;
    replaceBackground: boolean;
};

export type CoverGenerationRequest = {
    type: 'cover';
    prompt: string;
    title: string;
    projectId: string;
    count: number;
    model: string;
    quality: string;
    templateImage: ReferenceItem | null;
    baseImage: ReferenceItem | null;
    promptSwitches: CoverPromptSwitches;
};

export type DigitalHumanGenerationRequest = {
    type: 'digital-human';
    prompt: string;
    title: string;
    projectId: string;
    roleId: string;
    roleName: string;
    voiceId: string;
    videoPath: string;
    resolution: '720p' | '1080p';
    durationSeconds: number;
};

export type GenerationRequest =
    | ImageGenerationRequest
    | VideoGenerationRequest
    | AudioGenerationRequest
    | CoverGenerationRequest
    | DigitalHumanGenerationRequest;

export type GenerationFeedEntry = {
    kind: 'generation';
    id: string;
    createdAt: number;
    source: GenerationFeedSource;
    sourceTitle?: string;
    referencePreview?: ReferenceItem | null;
    request: GenerationRequest;
    status: 'running' | 'success' | 'error';
    jobId?: string;
    jobStatus?: string;
    completedAt?: string;
    error?: string;
    jobRequest?: Record<string, unknown>;
    assets: GeneratedAsset[];
};

export type AgentSessionFeedEntry = {
    kind: 'agent-session';
    id: string;
    createdAt: number;
    source: GenerationFeedSource;
    sourceTitle?: string;
    sessionId: string;
    contextId: string;
    title: string;
};

export type FeedEntry = GenerationFeedEntry | AgentSessionFeedEntry;

export type GenerationAgentAssetSummary = {
    kind: StudioMode;
    title?: string;
    id: string;
    relativePath?: string;
    previewUrl?: string;
    prompt?: string;
    model?: string;
    projectId?: string;
    createdAt: number | string;
};

export type DeletedFeedState = {
    entryIds: string[];
    jobIds: string[];
    clientRequestIds: string[];
    agentSessionIds: string[];
    agentContextIds: string[];
};

export type GenerationFeedEntryInit = {
    id: string;
    createdAt?: number;
    source?: GenerationFeedSource;
    sourceTitle?: string;
};

export type ImageGenerationRequestInput = Omit<ImageGenerationRequest, 'type' | 'generationMode'> & {
    imageMode: ImageGenerationMode;
};

export type VideoGenerationRequestInput = Omit<VideoGenerationRequest, 'type' | 'generationMode' | 'referenceItems'> & {
    videoMode: VideoGenerationMode;
    referenceItems: Array<ReferenceItem | null | undefined>;
    firstFrame?: ReferenceItem | null;
    lastFrame?: ReferenceItem | null;
};

export type AudioGenerationRequestInput = Omit<AudioGenerationRequest, 'type'>;

export type CoverGenerationRequestInput = Omit<CoverGenerationRequest, 'type'>;

export type DigitalHumanGenerationRequestInput = Omit<DigitalHumanGenerationRequest, 'type'>;

export const FEED_STORAGE_KEY = 'redbox:generation-studio:feed:v1';
export const FEED_DELETED_STORAGE_KEY = 'redbox:generation-studio:feed:deleted:v1';
const FEED_STORAGE_MAX_CHARS = 750_000;
const FEED_STORAGE_MAX_ENTRIES = 150;

export function normalizeImageQuality(value: unknown): string {
    const quality = String(value || '').trim();
    return quality === 'low' || quality === 'medium' || quality === 'high' ? quality : 'medium';
}

export function buildImageGenerationRequest(input: ImageGenerationRequestInput): ImageGenerationRequest {
    const effectiveImageMode: ImageGenerationMode = input.referenceItems.length > 0
        ? (input.imageMode === 'text-to-image' ? 'reference-guided' : input.imageMode)
        : 'text-to-image';
    return {
        type: 'image',
        prompt: input.prompt,
        title: input.title,
        projectId: input.projectId,
        count: input.count,
        model: input.model,
        aspectRatio: input.aspectRatio,
        size: input.size,
        quality: input.quality,
        resolution: input.resolution,
        generationMode: effectiveImageMode,
        referenceItems: input.referenceItems,
    };
}

export function buildVideoGenerationRequest(input: VideoGenerationRequestInput): VideoGenerationRequest {
    const effectiveReferences = input.videoMode === 'reference-guided'
        ? input.referenceItems.filter(Boolean) as ReferenceItem[]
        : input.videoMode === 'first-last-frame'
            ? [input.firstFrame, input.lastFrame].filter(Boolean) as ReferenceItem[]
            : [];
    const effectiveVideoMode = effectiveReferences.length > 0 && input.videoMode === 'text-to-video'
        ? 'reference-guided'
        : input.videoMode;
    return {
        type: 'video',
        prompt: input.prompt,
        title: input.title,
        projectId: input.projectId,
        model: input.model,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        durationSeconds: input.durationSeconds,
        generateAudio: input.generateAudio,
        generationMode: effectiveVideoMode,
        referenceItems: effectiveReferences,
        firstClip: input.firstClip,
        drivingAudio: input.drivingAudio,
    };
}

export function buildAudioGenerationRequest(input: AudioGenerationRequestInput): AudioGenerationRequest {
    return {
        type: 'audio',
        prompt: input.prompt,
        title: input.title,
        projectId: input.projectId,
        model: input.model,
        voiceId: input.voiceId,
        voiceTargetTtsModel: input.voiceTargetTtsModel,
        languageBoost: input.languageBoost,
        speed: input.speed,
        emotion: input.emotion,
        responseFormat: input.responseFormat,
    };
}

export function buildCoverGenerationRequest(input: CoverGenerationRequestInput): CoverGenerationRequest {
    return {
        type: 'cover',
        prompt: input.prompt,
        title: input.title,
        projectId: input.projectId,
        count: input.count,
        model: input.model,
        quality: input.quality,
        templateImage: input.templateImage,
        baseImage: input.baseImage,
        promptSwitches: input.promptSwitches,
    };
}

export function buildDigitalHumanGenerationRequest(input: DigitalHumanGenerationRequestInput): DigitalHumanGenerationRequest {
    return {
        type: 'digital-human',
        prompt: input.prompt,
        title: input.title,
        projectId: input.projectId,
        roleId: input.roleId,
        roleName: input.roleName,
        voiceId: input.voiceId,
        videoPath: input.videoPath,
        resolution: input.resolution,
        durationSeconds: input.durationSeconds,
    };
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function numberField(record: Record<string, unknown>, keys: string[], fallback: number): number {
    for (const key of keys) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return fallback;
}

function referenceNameFromSource(source: string, index: number): string {
    const normalized = source.split('?')[0]?.split('#')[0] || '';
    const name = normalized.split('/').filter(Boolean).pop();
    return name || `reference-${index + 1}`;
}

function isVideoAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)$/i.test(String(asset.relativePath || '').trim());
}

function isAudioAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return true;
    return /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(String(asset.relativePath || '').trim());
}

export function feedTime(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const raw = String(value || '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) return numeric;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function referenceItemsFromJobRequest(request: Record<string, unknown>, keys: string[]): ReferenceItem[] {
    for (const key of keys) {
        const items = normalizeReferenceItems(request[key]);
        if (items.length > 0) return items;
    }
    return [];
}

function imageCountFromJob(job: MediaJobProjection, request: Record<string, unknown>): number {
    const plannedCount = Array.isArray(request.imagePlanItems) ? request.imagePlanItems.length : 0;
    if (plannedCount > 0) return plannedCount;
    const requestedCount = Number(request.count || request.n);
    if (Number.isFinite(requestedCount) && requestedCount > 0) return requestedCount;
    return Math.max(1, job.artifacts?.length || 1);
}

function imagePlanItemsFromJobRequest(request: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(request.imagePlanItems)
        ? request.imagePlanItems.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        : [];
}

function promptFromJobRequest(request: Record<string, unknown>): string {
    const prompt = stringField(request, ['prompt', 'compiledPrompt', 'userPrompt', 'input', 'text', 'summary']);
    if (prompt) return prompt;
    const imagePlanPrompts = imagePlanItemsFromJobRequest(request)
        .map((item) => stringField(item, ['compiledPrompt', 'prompt', 'title']))
        .filter(Boolean);
    if (imagePlanPrompts.length > 0) return imagePlanPrompts.join('\n\n');
    return stringField(request, ['sharedStyleGuide', 'sequenceGoal']);
}

function titleFromImagePlanItems(request: Record<string, unknown>): string {
    const titles = imagePlanItemsFromJobRequest(request)
        .map((item) => stringField(item, ['title']))
        .filter(Boolean);
    if (titles.length === 0) return '';
    if (titles.length === 1) return titles[0];
    return `${titles[0]} 等 ${titles.length} 张`;
}

function emptyDeletedFeedState(): DeletedFeedState {
    return { entryIds: [], jobIds: [], clientRequestIds: [], agentSessionIds: [], agentContextIds: [] };
}

function serializeFeedEntries(entries: FeedEntry[]): string {
    return JSON.stringify(
        entries.slice(-FEED_STORAGE_MAX_ENTRIES).map((entry) => {
            if (!isGenerationFeedEntry(entry)) {
                return entry;
            }
            return {
                ...entry,
                jobRequest: undefined,
                request: {
                    ...entry.request,
                    referenceItems: [],
                    templateImage: entry.request.type === 'cover' ? null : undefined,
                    baseImage: entry.request.type === 'cover' ? null : undefined,
                    firstClip: entry.request.type === 'video' ? null : undefined,
                    drivingAudio: entry.request.type === 'video' ? null : undefined,
                },
            };
        }),
    );
}

export function normalizeReferenceItems(value: unknown): ReferenceItem[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item, index) => {
            if (typeof item === 'string') {
                const source = item.trim();
                if (!source) return null;
                return {
                    name: referenceNameFromSource(source, index),
                    dataUrl: source.startsWith('data:') ? source : resolveAssetUrl(source),
                } satisfies ReferenceItem;
            }
            if (!item || typeof item !== 'object') return null;
            const record = item as Record<string, unknown>;
            const rawSource = String(
                record.dataUrl
                || record.previewUrl
                || record.localUrl
                || record.absolutePath
                || record.path
                || record.url
                || '',
            ).trim();
            if (!rawSource) return null;
            const dataUrl = rawSource.startsWith('data:') ? rawSource : resolveAssetUrl(rawSource);
            if (!dataUrl) return null;
            return {
                name: String(record.name || record.fileName || referenceNameFromSource(rawSource, index)).trim() || 'reference',
                dataUrl,
            } satisfies ReferenceItem;
        })
        .filter((item): item is ReferenceItem => Boolean(item));
}

export function normalizeReferenceItem(value: unknown): ReferenceItem | null {
    const items = normalizeReferenceItems(Array.isArray(value) ? value.slice(0, 1) : [value]);
    return items[0] || null;
}

export function normalizeGenerationRequest(value: unknown): GenerationRequest | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const rawType = String(record.type || '').trim().toLowerCase();
    const resolvedType = rawType === 'cover'
        ? 'cover'
        : rawType === 'audio'
        ? 'audio'
        : rawType === 'video'
        ? 'video'
        : rawType === 'image'
            ? 'image'
            : String(record.mode || '').trim().toLowerCase() === 'video'
                ? 'video'
                : String(record.mode || '').trim().toLowerCase() === 'audio'
                    ? 'audio'
                    : 'image';
    const prompt = String(record.prompt || record.userPrompt || record.input || record.text || '').trim();
    if (!prompt) return null;

    if (resolvedType === 'cover') {
        const rawSwitches = record.promptSwitches && typeof record.promptSwitches === 'object'
            ? record.promptSwitches as Partial<CoverPromptSwitches>
            : {};
        return {
            type: 'cover',
            prompt,
            title: String(record.title || '').trim(),
            projectId: String(record.projectId || '').trim(),
            count: Math.max(1, Math.min(4, Number(record.count || 1) || 1)),
            model: String(record.model || '').trim(),
            quality: normalizeImageQuality(record.quality),
            templateImage: normalizeReferenceItem(record.templateImage),
            baseImage: normalizeReferenceItem(record.baseImage),
            promptSwitches: {
                learnTypography: rawSwitches.learnTypography !== false,
                learnColorMood: rawSwitches.learnColorMood !== false,
                beautifyFace: rawSwitches.beautifyFace === true,
                replaceBackground: rawSwitches.replaceBackground === true,
            },
        } satisfies CoverGenerationRequest;
    }

    if (resolvedType === 'audio') {
        return {
            type: 'audio',
            prompt,
            title: String(record.title || '').trim(),
            projectId: String(record.projectId || '').trim(),
            model: String(record.model || '').trim(),
            voiceId: String(record.voiceId || record.voice_id || record.voice || '').trim(),
            languageBoost: String(record.languageBoost || record.language_boost || '').trim(),
            speed: String(record.speed || record.speed_rate || '1').trim() || '1',
            emotion: String(record.emotion || '').trim(),
            responseFormat: String(record.responseFormat || record.response_format || 'mp3').trim() || 'mp3',
        } satisfies AudioGenerationRequest;
    }

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
        quality: normalizeImageQuality(record.quality),
        resolution: String(record.resolution || 'auto').trim() || 'auto',
        generationMode: imageMode,
        referenceItems: normalizeReferenceItems(record.referenceItems),
    } satisfies ImageGenerationRequest;
}

export function normalizeGeneratedAssets(value: unknown): GeneratedAsset[] {
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
                thumbnailUrl: typeof record.thumbnailUrl === 'string' ? record.thumbnailUrl : typeof record.thumbnail_url === 'string' ? record.thumbnail_url : undefined,
                thumbnail_url: typeof record.thumbnail_url === 'string' ? record.thumbnail_url : undefined,
                mimeType: typeof record.mimeType === 'string' ? record.mimeType : typeof record.mime_type === 'string' ? record.mime_type : undefined,
                mime_type: typeof record.mime_type === 'string' ? record.mime_type : undefined,
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

export function normalizeFeedEntryRecord(value: unknown): FeedEntry | null {
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
            createdAt: feedTime(record.createdAt) || Date.now(),
            source: String(record.source || 'standalone').trim() || 'standalone',
            sourceTitle: typeof record.sourceTitle === 'string' ? record.sourceTitle : undefined,
            sessionId,
            contextId,
            title: typeof record.title === 'string' ? record.title : 'Agent 模式',
        } satisfies AgentSessionFeedEntry;
    }

    const request = normalizeGenerationRequest(record.request || record);
    if (!request) return null;

    return {
        kind: 'generation',
        id,
        createdAt: feedTime(record.createdAt) || Date.now(),
        source: String(record.source || 'standalone').trim() || 'standalone',
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
        jobRequest: record.jobRequest && typeof record.jobRequest === 'object' ? record.jobRequest as Record<string, unknown> : undefined,
        assets: normalizeGeneratedAssets(record.assets),
    } satisfies GenerationFeedEntry;
}

export function normalizeDeletedFeedState(value: unknown): DeletedFeedState {
    if (!value || typeof value !== 'object') return emptyDeletedFeedState();
    const record = value as Record<string, unknown>;
    const normalizeList = (items: unknown): string[] => (
        Array.isArray(items)
            ? Array.from(new Set(items.map((item) => String(item || '').trim()).filter(Boolean)))
            : []
    );
    return {
        entryIds: normalizeList(record.entryIds),
        jobIds: normalizeList(record.jobIds),
        clientRequestIds: normalizeList(record.clientRequestIds),
        agentSessionIds: normalizeList(record.agentSessionIds),
        agentContextIds: normalizeList(record.agentContextIds),
    };
}

export function readDeletedFeedState(): DeletedFeedState {
    if (typeof window === 'undefined') return emptyDeletedFeedState();
    try {
        return normalizeDeletedFeedState(JSON.parse(window.localStorage.getItem(FEED_DELETED_STORAGE_KEY) || '{}'));
    } catch {
        return emptyDeletedFeedState();
    }
}

export function persistDeletedFeedState(state: DeletedFeedState): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(FEED_DELETED_STORAGE_KEY, JSON.stringify({
            entryIds: state.entryIds.slice(-500),
            jobIds: state.jobIds.slice(-500),
            clientRequestIds: state.clientRequestIds.slice(-500),
            agentSessionIds: state.agentSessionIds.slice(-500),
            agentContextIds: state.agentContextIds.slice(-500),
        }));
    } catch {
        // ignore persistence errors
    }
}

export function clientRequestIdFromJob(job: MediaJobProjection | null | undefined): string {
    const request = job?.request;
    if (!request || typeof request !== 'object') return '';
    return String(request.clientRequestId || request.clientFeedEntryId || '').trim();
}

export function isFeedEntryDeleted(entry: FeedEntry, deleted: DeletedFeedState): boolean {
    if (deleted.entryIds.includes(entry.id)) return true;
    if (isAgentSessionFeedEntry(entry)) {
        return deleted.agentSessionIds.includes(entry.sessionId)
            || deleted.agentContextIds.includes(entry.contextId);
    }
    if (isGenerationFeedEntry(entry)) {
        if (entry.jobId && deleted.jobIds.includes(entry.jobId)) return true;
        const requestClientId = String(
            (entry.request as unknown as Record<string, unknown>).clientRequestId
            || (entry.request as unknown as Record<string, unknown>).clientFeedEntryId
            || '',
        ).trim();
        if (requestClientId && deleted.clientRequestIds.includes(requestClientId)) return true;
    }
    return false;
}

export function isJobDeleted(job: MediaJobProjection, deleted: DeletedFeedState): boolean {
    return deleted.jobIds.includes(job.jobId)
        || deleted.entryIds.includes(`job:${job.jobId}`)
        || deleted.clientRequestIds.includes(clientRequestIdFromJob(job));
}

export function sortFeedEntries(entries: FeedEntry[]): FeedEntry[] {
    return [...entries].sort((left, right) => {
        const timeDelta = feedTime(left.createdAt) - feedTime(right.createdAt);
        if (timeDelta !== 0) return timeDelta;
        return left.id.localeCompare(right.id);
    });
}

export function persistFeedEntries(entries: FeedEntry[]): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(FEED_STORAGE_KEY, serializeFeedEntries(sortFeedEntries(entries)));
    } catch {
        // ignore persistence errors
    }
}

export function readPersistedFeedEntries(): FeedEntry[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(FEED_STORAGE_KEY);
        if (!raw) return [];
        if (raw.length > FEED_STORAGE_MAX_CHARS) {
            window.localStorage.removeItem(FEED_STORAGE_KEY);
            return [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const deleted = readDeletedFeedState();
        return parsed
            .slice(-FEED_STORAGE_MAX_ENTRIES)
            .map(normalizeFeedEntryRecord)
            .filter((item): item is FeedEntry => Boolean(item))
            .filter((item) => !isFeedEntryDeleted(item, deleted))
            .filter((item) => (
                !isGenerationFeedEntry(item)
                || (item.status === 'running' && !item.jobId)
            ))
            .sort((a, b) => {
                const timeDelta = feedTime(a.createdAt) - feedTime(b.createdAt);
                if (timeDelta !== 0) return timeDelta;
                return a.id.localeCompare(b.id);
            });
    } catch {
        return [];
    }
}

export function mergeFeedEntriesById(baseEntries: FeedEntry[], incomingEntries: FeedEntry[]): FeedEntry[] {
    if (incomingEntries.length === 0) return baseEntries;
    const entriesById = new Map<string, FeedEntry>();
    for (const entry of baseEntries) {
        entriesById.set(entry.id, entry);
    }
    let changed = false;
    for (const entry of incomingEntries) {
        if (entriesById.get(entry.id) === entry) continue;
        entriesById.set(entry.id, entry);
        changed = true;
    }
    return changed ? sortFeedEntries(Array.from(entriesById.values())) : baseEntries;
}

export function requestModeLabel(request: GenerationRequest): string {
    if (request.type === 'cover') return '封面创作';
    if (request.type === 'image') return '图片创作';
    if (request.type === 'audio') return '音频创作';
    if (request.type === 'digital-human') return '数字人';
    return '视频创作';
}

export function requestLeadingReference(request: GenerationRequest): ReferenceItem | null {
    if (request.type === 'audio' || request.type === 'digital-human') return null;
    if (request.type === 'cover') return request.baseImage || request.templateImage || null;
    if (request.referenceItems.length > 0) return request.referenceItems[0];
    if (request.type === 'video' && request.firstClip) return request.firstClip;
    return null;
}

export function createGenerationFeedEntry(
    request: GenerationRequest,
    init: GenerationFeedEntryInit,
): GenerationFeedEntry {
    return {
        kind: 'generation',
        id: init.id,
        createdAt: init.createdAt || Date.now(),
        source: init.source || 'standalone',
        sourceTitle: init.sourceTitle,
        referencePreview: requestLeadingReference(request),
        request,
        status: 'running',
        assets: [],
    };
}

export function requestSupportText(request: GenerationRequest): string {
    if (request.type === 'cover') {
        return `${request.count} 张`;
    }
    if (request.type === 'image') {
        if (request.generationMode === 'image-to-image') return '图生图';
        if (request.generationMode === 'reference-guided') return '参考图引导';
        return `${request.count} 张`;
    }
    if (request.type === 'audio') {
        return request.languageBoost || '自动语言';
    }
    if (request.type === 'digital-human') return request.roleName || '角色';
    if (request.generationMode === 'first-last-frame') return '首尾帧';
    if (request.generationMode === 'continuation') return '续写';
    if (request.generationMode === 'reference-guided') return '参考图';
    return `${request.durationSeconds} 秒`;
}

export function isGenerationFeedEntry(entry: FeedEntry): entry is GenerationFeedEntry {
    return entry.kind === 'generation';
}

export function isAgentSessionFeedEntry(entry: FeedEntry): entry is AgentSessionFeedEntry {
    return entry.kind === 'agent-session';
}

export function normalizeAspectRatio(value: string | undefined, fallback: string): string {
    const raw = String(value || '').trim();
    if (!raw || raw.toLowerCase() === 'auto') return fallback;
    if (!/^\d+:\d+$/.test(raw)) return fallback;
    return raw.replace(':', ' / ');
}

export function parseAspectRatio(value: string | undefined, fallback: string): { width: number; height: number } {
    const raw = String(value || '').trim();
    const normalized = !raw || raw.toLowerCase() === 'auto' ? fallback : raw;
    const match = normalized.match(/^(\d+):(\d+)$/);
    const fallbackMatch = fallback.match(/^(\d+):(\d+)$/);
    const width = Number(match?.[1] || fallbackMatch?.[1] || 1);
    const height = Number(match?.[2] || fallbackMatch?.[2] || 1);
    return { width, height };
}

export function estimateGenerationProgress(request: GenerationRequest, elapsedMs: number): number {
    const expectedDurationMs = request.type === 'cover'
        ? 32_000
        : request.type === 'image'
        ? 28_000
        : request.type === 'audio'
            ? 45_000
        : request.type === 'digital-human'
            ? 210_000
            : request.generationMode === 'reference-guided'
                ? 180_000
                : 150_000;
    const ratio = Math.min(1, elapsedMs / expectedDurationMs);
    return Math.min(94, Math.max(6, Math.round(ratio * 100)));
}

export function assetsFromJobProjection(job: MediaJobProjection): GeneratedAsset[] {
    return (job.artifacts || [])
        .map((artifact) => {
            const metadata = artifact.metadata;
            const rawAsset = metadata?.asset && typeof metadata.asset === 'object'
                ? metadata.asset as Record<string, unknown>
                : metadata;
            if (rawAsset && typeof rawAsset === 'object') {
                const asset = rawAsset as GeneratedAsset;
                return {
                    ...asset,
                    previewUrl: asset.previewUrl || artifact.previewUrl || undefined,
                    thumbnailUrl: asset.thumbnailUrl || asset.thumbnail_url,
                    mimeType: asset.mimeType || asset.mime_type || artifact.mimeType || undefined,
                };
            }
            return rawAsset;
        })
        .filter((item): item is GeneratedAsset => Boolean(item && typeof item === 'object' && typeof (item as GeneratedAsset).id === 'string'));
}

export function requestFromJobProjection(job: MediaJobProjection): GenerationRequest | null {
    const request = job.request || {};
    const prompt = promptFromJobRequest(request);
    if (!prompt) return null;
    const title = stringField(request, ['title', 'name']) || titleFromImagePlanItems(request);
    const projectId = job.projectId || stringField(request, ['projectId']);
    const model = job.providerModel || stringField(request, ['model']);
    const generationMode = stringField(request, ['generationMode', 'mode']);

    if (job.kind === 'audio') {
        return {
            type: 'audio',
            prompt,
            title,
            projectId: projectId || '',
            model: model || '',
            voiceId: stringField(request, ['voiceId', 'voice_id', 'voice']),
            languageBoost: stringField(request, ['languageBoost', 'language_boost']),
            speed: stringField(request, ['speed', 'speed_rate']) || '1',
            emotion: stringField(request, ['emotion']),
            responseFormat: stringField(request, ['responseFormat', 'response_format']) || 'mp3',
        } satisfies AudioGenerationRequest;
    }

    if (job.kind === 'video' || job.kind === 'video_sequence') {
        const referenceItems = referenceItemsFromJobRequest(request, ['referenceItems', 'referenceImages', 'reference_images']);
        const firstClip = normalizeReferenceItem(request.firstClip || request.first_clip);
        const drivingAudio = normalizeReferenceItem(request.drivingAudio || request.driving_audio);
        const aspectRatio = stringField(request, ['aspectRatio', 'aspect_ratio']);
        const resolution = stringField(request, ['resolution']);
        const normalizedMode = generationMode === 'reference-guided'
            || generationMode === 'first-last-frame'
            || generationMode === 'continuation'
            || generationMode === 'text-to-video'
            ? generationMode
            : referenceItems.length > 0
                ? 'reference-guided'
                : 'text-to-video';
        return {
            type: 'video',
            prompt,
            title,
            projectId: projectId || '',
            model: model || '',
            aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9',
            resolution: resolution === '1080p' ? '1080p' : '720p',
            durationSeconds: numberField(request, ['durationSeconds', 'duration_seconds', 'duration'], 8),
            generateAudio: Boolean(request.generateAudio),
            generationMode: normalizedMode,
            referenceItems,
            firstClip,
            drivingAudio,
        } satisfies VideoGenerationRequest;
    }

    const referenceItems = referenceItemsFromJobRequest(request, ['referenceItems', 'referenceImages', 'reference_images']);
    const normalizedMode = generationMode === 'reference-guided'
        || generationMode === 'image-to-image'
        || generationMode === 'text-to-image'
        ? generationMode
        : referenceItems.length > 0
            ? 'reference-guided'
            : 'text-to-image';
    return {
        type: 'image',
        prompt,
        title,
        projectId: projectId || '',
        count: imageCountFromJob(job, request),
        model: model || '',
        aspectRatio: stringField(request, ['aspectRatio', 'aspect_ratio']) || '4:3',
        size: stringField(request, ['size']),
        quality: normalizeImageQuality(stringField(request, ['quality'])),
        resolution: stringField(request, ['resolution']) || 'auto',
        generationMode: normalizedMode,
        referenceItems,
    } satisfies ImageGenerationRequest;
}

export function sourceFromJobProjection(job: MediaJobProjection): GenerationFeedSource {
    const requestSource = job.request && typeof job.request.source === 'string' ? job.request.source.trim() : '';
    return requestSource || job.source || 'generation_studio';
}

export function feedEntryFromJobProjection(job: MediaJobProjection): GenerationFeedEntry | null {
    const request = requestFromJobProjection(job);
    if (!request) return null;
    const createdAt = feedTime(job.createdAt);
    const base: GenerationFeedEntry = {
        kind: 'generation',
        id: `job:${job.jobId}`,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        source: sourceFromJobProjection(job),
        sourceTitle: undefined,
        referencePreview: requestLeadingReference(request),
        request,
        status: 'running',
        jobId: job.jobId,
        jobStatus: job.status,
        completedAt: job.completedAt || undefined,
        error: undefined,
        jobRequest: job.request || undefined,
        assets: assetsFromJobProjection(job),
    };
    return applyJobProjectionToFeedEntry(base, job) as GenerationFeedEntry;
}

export function isSamePendingGenerationRequest(entry: FeedEntry, jobEntry: GenerationFeedEntry): boolean {
    if (!isGenerationFeedEntry(entry) || entry.jobId || entry.status !== 'running') return false;
    if (entry.request.type !== jobEntry.request.type) return false;
    if (entry.request.prompt.trim() !== jobEntry.request.prompt.trim()) return false;
    return Math.abs(entry.createdAt - jobEntry.createdAt) < 120_000;
}

export function errorMessageFromJobProjection(job: MediaJobProjection): string {
    const attemptError = typeof job.attempt?.lastError === 'string' ? job.attempt.lastError : '';
    const resultError = typeof job.result?.error === 'string' ? job.result.error : '';
    const cancelReason = typeof job.cancelReason === 'string' ? job.cancelReason : '';
    return attemptError || resultError || cancelReason || '生成失败';
}

export function applyJobProjectionToFeedEntry(entry: FeedEntry, job: MediaJobProjection | null | undefined): FeedEntry {
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
        const assets = assetsFromJobProjection(job);
        return {
            ...entry,
            jobStatus: job.status,
            completedAt: job.completedAt || entry.completedAt,
            status: assets.length > 0 ? 'success' : 'error',
            error: errorMessageFromJobProjection(job),
            assets,
        };
    }
    return {
        ...entry,
        jobStatus: job.status,
        status: 'running',
        assets: assetsFromJobProjection(job),
    };
}

export function isGenerationStudioMediaJob(job: MediaJobProjection): boolean {
    return job.queueMode === 'free_creation'
        && (job.kind === 'image' || job.kind === 'video' || job.kind === 'video_sequence' || job.kind === 'audio');
}

export function mergeMediaJobsIntoFeedEntries(
    entries: FeedEntry[],
    jobs: MediaJobProjection[],
    deleted: DeletedFeedState,
): FeedEntry[] {
    let changed = false;
    const next = [...entries];
    const sortedJobs = jobs
        .filter(isGenerationStudioMediaJob)
        .filter((job) => !isJobDeleted(job, deleted))
        .sort((left, right) => {
            const timeDelta = feedTime(left.createdAt) - feedTime(right.createdAt);
            if (timeDelta !== 0) return timeDelta;
            return left.jobId.localeCompare(right.jobId);
        });

    for (const job of sortedJobs) {
        const existingIndex = next.findIndex((entry) => isGenerationFeedEntry(entry) && entry.jobId === job.jobId);
        if (existingIndex >= 0) {
            const patched = applyJobProjectionToFeedEntry(next[existingIndex], job);
            if (patched !== next[existingIndex]) {
                next[existingIndex] = patched;
                changed = true;
            }
            continue;
        }

        const jobEntry = feedEntryFromJobProjection(job);
        if (!jobEntry) continue;
        const pendingIndex = next.findIndex((entry) => isSamePendingGenerationRequest(entry, jobEntry));
        if (pendingIndex >= 0) {
            next[pendingIndex] = applyJobProjectionToFeedEntry({
                ...(next[pendingIndex] as GenerationFeedEntry),
                jobId: job.jobId,
                jobStatus: job.status,
                jobRequest: job.request || undefined,
            }, job);
        } else {
            next.push(jobEntry);
        }
        changed = true;
    }

    return changed ? sortFeedEntries(next) : entries;
}

export function generatedAssetKind(asset: GeneratedAsset, request: GenerationRequest): StudioMode {
    if (isVideoAsset(asset)) return 'video';
    if (isAudioAsset(asset)) return 'audio';
    return request.type;
}

export function isStandaloneGenerationSource(source: GenerationFeedSource): boolean {
    return [
        'standalone',
        'generation_studio',
        'generation-studio',
        'tool',
        'chat',
        'redclaw',
    ].includes(String(source || '').trim());
}

export function buildRecentGenerationAssetSummaries(
    entries: FeedEntry[],
    projectId: string,
    source?: GenerationFeedSource,
): GenerationAgentAssetSummary[] {
    const normalizedProjectId = projectId.trim();
    const normalizedSource = String(source || '').trim();
    return entries
        .filter(isGenerationFeedEntry)
        .filter((entry) => {
            if (normalizedProjectId) {
                return entry.request.projectId === normalizedProjectId
                    || entry.assets.some((asset) => asset.projectId === normalizedProjectId);
            }
            if (normalizedSource === 'standalone') {
                return isStandaloneGenerationSource(entry.source);
            }
            return !normalizedSource || entry.source === normalizedSource;
        })
        .flatMap((entry) => entry.assets.map((asset) => ({
            kind: generatedAssetKind(asset, entry.request),
            title: asset.title,
            id: asset.id,
            relativePath: asset.relativePath,
            previewUrl: asset.previewUrl,
            prompt: asset.prompt || entry.request.prompt,
            model: asset.model || (entry.request.type === 'digital-human' ? 'videoretalk' : entry.request.model),
            projectId: asset.projectId || entry.request.projectId || undefined,
            createdAt: asset.updatedAt || entry.completedAt || entry.createdAt,
        } satisfies GenerationAgentAssetSummary)))
        .reverse()
        .slice(0, 6);
}

export function latestAssetOfKind(
    assets: GenerationAgentAssetSummary[],
    kind: StudioMode,
): GenerationAgentAssetSummary | undefined {
    return assets.find((asset) => asset.kind === kind);
}
