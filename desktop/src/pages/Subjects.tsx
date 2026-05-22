import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { buildAudioDataUrl } from '../features/audio-input/audioInput';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsByIds } from '../features/media-jobs/useMediaJobsStore';
import { isMediaJobTerminal, type MediaJobProjection } from '../features/media-jobs/types';
import { uiDebug, uiMeasure } from '../utils/uiDebug';
import {
    ArrowLeft,
    Box,
    Building2,
    CalendarClock,
    Check,
    ChevronDown,
    Clapperboard,
    FolderOpen,
    Grid2X2,
    ImagePlus,
    List,
    Mic,
    Music2,
    Package,
    Pencil,
    Plus,
    RefreshCw,
    Save,
    Search,
    SlidersHorizontal,
    Sparkles,
    Tag,
    Trash2,
    UserRound,
    X,
    type LucideIcon,
} from 'lucide-react';
import { resolveAssetUrl } from '../utils/pathManager';
import { SelectMenu } from '../components/ui/SelectMenu';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel } from '@/components/ui/liquid-glass-menu';
import {
    filterAiModelsByCapability,
    normalizeAiModelDescriptors,
    parseAiSources,
    type AiModelDescriptor,
} from './settings/shared';
import { type AiSourceConfig } from '../config/aiSources';
import {
    ECOMMERCE_PLATFORM_GROUPS,
    ecommercePlatformIconPath,
    normalizeEcommercePlatformsSettings,
    type EcommercePlatformRecord,
} from '../features/ecommerce-platforms/catalog';

interface SubjectCategory {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

interface SubjectAttribute {
    key: string;
    value: string;
}

interface SubjectSku {
    id: string;
    name: string;
    attributes: SubjectAttribute[];
}

interface SubjectRecord {
    id: string;
    name: string;
    categoryId?: string;
    description?: string;
    tags: string[];
    attributes: SubjectAttribute[];
    imagePaths: string[];
    voicePath?: string;
    videoPath?: string;
    voiceScript?: string;
    voice?: Record<string, unknown>;
    brandId?: string;
    skus?: SubjectSku[];
    createdAt: string;
    updatedAt: string;
    absoluteImagePaths?: string[];
    previewUrls?: string[];
    primaryPreviewUrl?: string;
    absoluteVoicePath?: string;
    voicePreviewUrl?: string;
    absoluteVideoPath?: string;
    videoPreviewUrl?: string;
}

interface BrandWorkspaceBrand {
    id: string;
    name: string;
    description?: string;
    updatedAt: string;
    createdAt: string;
}

interface BrandWorkspaceProduct {
    id: string;
    brandId: string;
    name: string;
    description?: string;
    updatedAt: string;
    createdAt: string;
}

interface BrandWorkspaceSku {
    id: string;
    productId: string;
    name: string;
    variantText?: string;
}

interface BrandWorkspaceAssetRef {
    id: string;
    ownerType: string;
    ownerId: string;
    path: string;
    role: string;
    createdAt: string;
}

interface BrandWorkspaceProductDetailPage {
    id: string;
    productId: string;
    platform: string;
    market: string;
    locale: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
}

interface BrandWorkspaceProductBundle {
    product: BrandWorkspaceProduct;
    skus: BrandWorkspaceSku[];
    assets: BrandWorkspaceAssetRef[];
    skuAssets?: Record<string, BrandWorkspaceAssetRef[]>;
    detailPages?: BrandWorkspaceProductDetailPage[];
    detailPageAssets?: Record<string, BrandWorkspaceAssetRef[]>;
}

interface BrandWorkspaceBrandBundle {
    brand: BrandWorkspaceBrand;
    assets: BrandWorkspaceAssetRef[];
    products: BrandWorkspaceProductBundle[];
}

interface BrandWorkspaceResult {
    success?: boolean;
    error?: string;
    brands?: BrandWorkspaceBrandBundle[];
    brand?: BrandWorkspaceBrandBundle;
    product?: BrandWorkspaceProductBundle;
}

interface BrandWorkspaceBridge {
    list: () => Promise<BrandWorkspaceResult>;
    get: (payload: { id: string }) => Promise<BrandWorkspaceResult>;
    upsertBrand: (payload: unknown) => Promise<BrandWorkspaceResult>;
    upsertProduct: (payload: unknown) => Promise<BrandWorkspaceResult>;
    upsertSku: (payload: unknown) => Promise<BrandWorkspaceResult>;
    upsertProductDetailPage?: (payload: unknown) => Promise<BrandWorkspaceResult>;
    rebuildAiIndex: () => Promise<BrandWorkspaceResult>;
}

interface BrandWorkspaceProductDraft {
    id?: string;
    brandId: string;
    name: string;
    description: string;
    images: BrandWorkspaceImageDraft[];
    skus: BrandWorkspaceSkuDraft[];
}

interface BrandWorkspaceBrandDraft {
    id?: string;
    name: string;
    description: string;
    images: BrandWorkspaceImageDraft[];
}

interface BrandWorkspaceSkuDraft {
    id: string;
    name: string;
    variantText: string;
    images: BrandWorkspaceImageDraft[];
}

interface BrandWorkspaceImageDraft {
    id?: string;
    name: string;
    previewUrl: string;
    path?: string;
    dataUrl?: string;
}

interface ProductDetailContext {
    brandId: string;
    productId: string;
}

interface ProductDetailVersionDraft {
    market: string;
    locale: string;
    title: string;
}

interface SubjectImageDraft {
    name: string;
    previewUrl: string;
    relativePath?: string;
    dataUrl?: string;
}

interface SubjectDraft {
    id?: string;
    name: string;
    categoryId: string;
    description: string;
    tagsText: string;
    attributes: SubjectAttribute[];
    images: SubjectImageDraft[];
    brandId: string;
    skus: SubjectSku[];
    voice?: {
        name: string;
        previewUrl: string;
        relativePath?: string;
        dataUrl?: string;
        scriptText: string;
    };
    video?: {
        name: string;
        previewUrl: string;
        relativePath?: string;
        dataUrl?: string;
    };
}

type CategoryDialogMode = 'create' | 'rename';
type SubjectViewMode = 'grid' | 'list';
type AssetLibraryTab = 'assets' | 'media';
type AssetModalPhase = 'opening' | 'open' | 'closing';
type MediaAssetSource = 'generated' | 'planned' | 'imported';

const ASSET_LIBRARY_MODAL_ANIMATION_MS = 220;
type SubjectCategoryTab = {
    id: string;
    label: string;
    icon: LucideIcon;
    disabled?: boolean;
};

interface MediaAsset {
    id: string;
    source?: MediaAssetSource | string;
    projectId?: string;
    title?: string;
    prompt?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
    mimeType?: string;
    relativePath?: string;
    boundManuscriptPath?: string;
    createdAt?: string;
    updatedAt?: string;
    absolutePath?: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    thumbnail_url?: string;
    exists?: boolean;
}

interface MediaAssetContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    asset: MediaAsset | null;
}

const UNCATEGORIZED_FILTER = '__uncategorized__';
const DEFAULT_SUBJECT_CATEGORY_NAMES = ['品牌', '角色', '物品', '商品', '场景'];
const VISIBLE_SUBJECT_CATEGORY_NAMES = DEFAULT_SUBJECT_CATEGORY_NAMES.filter((name) => name !== '商品');
const HIDDEN_SUBJECT_CATEGORY_NAMES = new Set(['商品', '人物']);
const SUBJECT_VOICE_SAMPLE_TEXT = '君不见黄河之水天上来，奔流到海不复回。请用自然稳定的语速朗读这段文字，保持音量一致、停顿清晰，让系统更好地学习你的声音特点和语气节奏。';
const SUBJECT_VOICE_MIN_RECORDING_SECONDS = 30;
const SUBJECT_AUTOSAVE_DELAY_MS = 600;
const DEFAULT_VOICE_TTS_MODEL = 'cosyvoice-v3.5-plus';
const DEFAULT_VOICE_CLONE_MODEL = 'cosyvoice-v3.5-plus-voice-clone';
const MINIMAX_VOICE_CLONE_MODEL = 'minimax-voice-clone';
const COSYVOICE_CLONE_MODEL = 'cosyvoice-v3.5-plus-voice-clone';
const MEDIA_SOURCE_LABEL: Record<MediaAssetSource, string> = {
    generated: '已生成',
    planned: '计划项',
    imported: '导入',
};

type SubjectVoiceInfo = {
    label: string;
    detail?: string;
    tone: 'muted' | 'active' | 'ready' | 'failed';
    voiceId?: string;
    targetTtsModel?: string;
    cloneModel?: string;
    jobId?: string;
    error?: string;
    canRetry: boolean;
};

type SubjectVoiceSlotInfo = {
    voiceId: string;
    targetTtsModel: string;
    cloneModel?: string;
    provider?: string;
    status?: string;
};

type VoiceCloneModelOption = {
    value: string;
    label: string;
    description?: string;
};

type VoiceRouteOverride = {
    sourceId?: string;
    baseURL?: string;
    apiKey?: string;
    presetId?: string;
    protocol?: string;
};

const categoryIconForName = (name: string) => {
    const normalized = name.trim();
    if (normalized === '角色' || normalized === '人物') return UserRound;
    if (normalized === '物品' || normalized === '资产') return Package;
    if (normalized === '品牌') return Building2;
    if (normalized === '商品') return Package;
    if (normalized === '场景') return Box;
    return Tag;
};

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

const getAudioDurationSeconds = (src: string): Promise<number> => new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(Number(audio.duration) || 0);
    audio.onerror = () => reject(new Error('无法读取音频时长'));
    audio.src = src;
});

function createEmptyDraft(): SubjectDraft {
    return {
        name: '',
        categoryId: '',
        description: '',
        tagsText: '',
        attributes: [],
        images: [],
        brandId: '',
        skus: [],
        voice: undefined,
    };
}

function toDraft(subject?: SubjectRecord | null): SubjectDraft {
    if (!subject) return createEmptyDraft();
    return {
        id: subject.id,
        name: subject.name || '',
        categoryId: subject.categoryId || '',
        description: subject.description || '',
        tagsText: Array.isArray(subject.tags) ? subject.tags.join(', ') : '',
        attributes: Array.isArray(subject.attributes)
            ? subject.attributes.map((item) => ({ key: item.key || '', value: item.value || '' }))
            : [],
        images: (subject.previewUrls || []).map((previewUrl, index) => ({
            name: subject.imagePaths[index]?.split('/').pop() || `image-${index + 1}`,
            previewUrl,
            relativePath: subject.imagePaths[index],
        })),
        brandId: subject.brandId || '',
        skus: Array.isArray(subject.skus)
            ? subject.skus.map((sku) => ({
                id: sku.id || createDraftSkuId(),
                name: sku.name || '',
                attributes: Array.isArray(sku.attributes)
                    ? sku.attributes.map((item) => ({ key: item.key || '', value: item.value || '' }))
                    : [],
            }))
            : [],
        voice: subject.voicePreviewUrl ? {
            name: subject.voicePath?.split('/').pop() || 'voice-reference',
            previewUrl: subject.voicePreviewUrl,
            relativePath: subject.voicePath,
            scriptText: subject.voiceScript || '',
        } : undefined,
        video: subject.videoPreviewUrl ? {
            name: subject.videoPath?.split('/').pop() || 'role-video',
            previewUrl: subject.videoPreviewUrl,
            relativePath: subject.videoPath,
        } : undefined,
    };
}

function subjectDraftVoicePayload(draft: SubjectDraft, categories: SubjectCategory[], initialVoicePresent: boolean): Record<string, unknown> | undefined {
    const shouldSaveVoice = categories.find((item) => item.id === draft.categoryId)?.name.trim() === '角色';
    if (shouldSaveVoice && draft.voice) {
        return draft.voice.relativePath
            ? {
                relativePath: draft.voice.relativePath,
                name: draft.voice.name,
                scriptText: draft.voice.scriptText.trim() || undefined,
            }
            : {
                dataUrl: draft.voice.dataUrl,
                name: draft.voice.name,
                scriptText: draft.voice.scriptText.trim() || undefined,
            };
    }
    return initialVoicePresent ? {} : undefined;
}

function subjectDraftVideoPayload(draft: SubjectDraft, categories: SubjectCategory[], initialVideoPresent: boolean): Record<string, unknown> | undefined {
    const shouldSaveVideo = categories.find((item) => item.id === draft.categoryId)?.name.trim() === '角色';
    if (shouldSaveVideo && draft.video) {
        return draft.video.relativePath
            ? {
                relativePath: draft.video.relativePath,
                name: draft.video.name,
            }
            : {
                dataUrl: draft.video.dataUrl,
                name: draft.video.name,
            };
    }
    return initialVideoPresent ? {} : undefined;
}

function subjectDraftPayload(
    draft: SubjectDraft,
    categories: SubjectCategory[],
    voicePayload?: Record<string, unknown>,
    videoPayload?: Record<string, unknown>,
) {
    const categoryName = categories.find((item) => item.id === draft.categoryId)?.name.trim() || '';
    const isProduct = categoryName === '商品';
    return {
        id: draft.id,
        name: draft.name.trim(),
        categoryId: draft.categoryId || undefined,
        description: draft.description.trim() || undefined,
        tags: draft.tagsText.split(',').map((item) => item.trim()).filter(Boolean),
        attributes: normalizeAttributes(draft.attributes),
        images: draft.images.map((image) => image.relativePath
            ? { relativePath: image.relativePath, name: image.name }
            : { dataUrl: image.dataUrl, name: image.name }),
        voice: voicePayload,
        video: videoPayload,
        brandId: isProduct && draft.brandId ? draft.brandId : undefined,
        skus: isProduct ? normalizeSkus(draft.skus) : [],
    };
}

function subjectDraftPayloadSnapshot(
    draft: SubjectDraft,
    categories: SubjectCategory[],
    initialVoicePresent: boolean,
    initialVideoPresent: boolean,
): string {
    return JSON.stringify(subjectDraftPayload(
        draft,
        categories,
        subjectDraftVoicePayload(draft, categories, initialVoicePresent),
        subjectDraftVideoPayload(draft, categories, initialVideoPresent),
    ));
}

function normalizeAttributes(attributes: SubjectAttribute[]): SubjectAttribute[] {
    return attributes
        .map((item) => ({ key: String(item.key || '').trim(), value: String(item.value || '').trim() }))
        .filter((item) => item.key || item.value);
}

function createDraftSkuId(): string {
    return `sku-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSkus(skus: SubjectSku[]): SubjectSku[] {
    return skus
        .map((sku) => ({
            id: sku.id || createDraftSkuId(),
            name: String(sku.name || '').trim(),
            attributes: normalizeAttributes(sku.attributes || []),
        }))
        .filter((sku) => sku.name);
}

function normalizeMediaSource(source: unknown): MediaAssetSource {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'generated' || normalized === 'planned' || normalized === 'imported') return normalized;
    return 'imported';
}

function normalizeMediaAsset(asset: MediaAsset): MediaAsset {
    const legacyAsset = asset as MediaAsset & {
        mime_type?: string;
        relative_path?: string;
        absolute_path?: string;
        preview_url?: string;
    };
    return {
        ...asset,
        source: normalizeMediaSource(asset.source),
        mimeType: asset.mimeType || legacyAsset.mime_type,
        relativePath: asset.relativePath || legacyAsset.relative_path,
        absolutePath: asset.absolutePath || legacyAsset.absolute_path,
        previewUrl: asset.previewUrl || legacyAsset.preview_url,
        thumbnailUrl: asset.thumbnailUrl || asset.thumbnail_url,
        exists: asset.exists !== false,
    };
}

function mediaAssetSourceUrl(asset: Pick<MediaAsset, 'previewUrl' | 'absolutePath' | 'relativePath'>): string {
    return asset.previewUrl || asset.absolutePath || asset.relativePath || '';
}

function isVideoAsset(asset: Pick<MediaAsset, 'mimeType' | 'relativePath' | 'absolutePath' | 'previewUrl'>): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return false;
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(mediaAssetSourceUrl(asset).trim());
}

function isAudioAsset(asset: Pick<MediaAsset, 'mimeType' | 'relativePath' | 'absolutePath' | 'previewUrl'>): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return true;
    return /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)(?:[?#].*)?$/i.test(mediaAssetSourceUrl(asset).trim());
}

function mediaAssetKindLabel(asset: MediaAsset): string {
    if (isAudioAsset(asset)) return '音频';
    if (isVideoAsset(asset)) return '视频';
    return asset.aspectRatio || asset.size || '图片';
}

function parseJsonObject(value: unknown): Record<string, unknown> {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function sourceModelDescriptors(source: AiSourceConfig): AiModelDescriptor[] {
    return normalizeAiModelDescriptors([
        ...(Array.isArray(source.modelsMeta) ? source.modelsMeta : []),
        ...(Array.isArray(source.models) ? source.models : []),
        source.model,
    ]);
}

function sourceSupportsVoiceTtsModel(source: AiSourceConfig, modelId: string): boolean {
    const target = modelId.trim();
    if (!target) return false;
    const descriptors = sourceModelDescriptors(source);
    const ttsModels = filterAiModelsByCapability(descriptors, 'tts');
    const audioModels = ttsModels.length > 0 ? ttsModels : filterAiModelsByCapability(descriptors, 'audio');
    return audioModels.some((model) => model.id === target);
}

function sourceToVoiceRouteOverride(source: AiSourceConfig | undefined): VoiceRouteOverride {
    if (!source) return {};
    return {
        sourceId: source.id || undefined,
        baseURL: source.baseURL || undefined,
        apiKey: source.apiKey || undefined,
        presetId: source.presetId || undefined,
        protocol: source.protocol || undefined,
    };
}

function resolveVoiceTtsModelOverride(settings: Record<string, unknown>, modelId: string): VoiceRouteOverride {
    const selectedModel = modelId.trim();
    if (!selectedModel) return {};
    const aiSources = parseAiSources(typeof settings.ai_sources_json === 'string' ? settings.ai_sources_json : undefined);
    const candidates = aiSources.filter((source) => sourceSupportsVoiceTtsModel(source, selectedModel));
    if (!candidates.length) return {};

    const routes = parseJsonObject(settings.ai_model_routes_json);
    const voiceRoute = parseJsonObject(routes.voiceTts);
    const routeSourceId = String(voiceRoute.sourceId || voiceRoute.source_id || '').trim();
    const routeModel = String(voiceRoute.model || voiceRoute.modelName || voiceRoute.model_name || '').trim();
    const defaultSourceId = String(settings.default_ai_source_id || '').trim();
    const source = (
        routeSourceId && (!routeModel || routeModel === selectedModel)
            ? candidates.find((item) => item.id === routeSourceId)
            : undefined
    )
        || (defaultSourceId ? candidates.find((item) => item.id === defaultSourceId) : undefined)
        || candidates[0];

    return sourceToVoiceRouteOverride(source);
}

function buildVoiceCloneModelOptions(settings: Record<string, unknown>): { options: VoiceCloneModelOption[]; selectedModel: string } {
    const routes = parseJsonObject(settings.ai_model_routes_json);
    const voiceRoute = parseJsonObject(routes.voiceTts);
    const selectedModel = String(
        settings.voice_tts_model
        || settings.tts_model
        || voiceRoute.model
        || DEFAULT_VOICE_TTS_MODEL
    ).trim();
    const aiSources = parseAiSources(typeof settings.ai_sources_json === 'string' ? settings.ai_sources_json : undefined);
    const descriptors = aiSources.flatMap((source) => sourceModelDescriptors(source));
    const ttsModels = filterAiModelsByCapability(descriptors, 'tts');
    const audioModels = ttsModels.length > 0 ? ttsModels : filterAiModelsByCapability(descriptors, 'audio');
    const seen = new Set<string>();
    const options = audioModels
        .map((model) => model.id.trim())
        .filter((model) => model && !seen.has(model) && seen.add(model))
        .map((model) => ({
            value: model,
            label: model,
            description: `${cloneModelForTargetTtsModel(model)} · 克隆后音色绑定此模型`,
        }));
    if (selectedModel && !options.some((option) => option.value === selectedModel)) {
        options.unshift({
            value: selectedModel,
            label: selectedModel,
            description: `${cloneModelForTargetTtsModel(selectedModel, String(settings.voice_clone_model || DEFAULT_VOICE_CLONE_MODEL))} · 当前设置`,
        });
    }
    if (!options.length) {
        options.push({
            value: DEFAULT_VOICE_TTS_MODEL,
            label: DEFAULT_VOICE_TTS_MODEL,
            description: `${COSYVOICE_CLONE_MODEL} · 默认`,
        });
    }
    return { options, selectedModel: selectedModel || options[0]?.value || DEFAULT_VOICE_TTS_MODEL };
}

function AudioMediaThumb({ src, compact = false }: { src: string; compact?: boolean }) {
    return (
        <div className={clsx(
            'flex h-full w-full flex-col items-center justify-center bg-surface-secondary/60 text-accent-primary',
            compact ? 'gap-1.5 p-1.5' : 'gap-3 p-4',
        )}>
            <div className={clsx(
                'flex items-center justify-center rounded-xl border border-accent-primary/20 bg-accent-primary/10',
                compact ? 'h-9 w-9' : 'h-14 w-14',
            )}>
                <Music2 className={compact ? 'h-5 w-5' : 'h-7 w-7'} />
            </div>
            {!compact && src ? (
                <audio
                    src={resolveAssetUrl(src)}
                    className="w-full"
                    controls
                    preload="metadata"
                    onClick={(event) => event.stopPropagation()}
                />
            ) : null}
        </div>
    );
}

function VideoMediaThumb({
    sourceUrl,
    thumbnailUrl,
    label,
}: {
    sourceUrl: string;
    thumbnailUrl?: string;
    label: string;
}) {
    const resolvedThumbnailUrl = thumbnailUrl ? resolveAssetUrl(thumbnailUrl) : '';
    if (resolvedThumbnailUrl) {
        return <img src={resolvedThumbnailUrl} alt={label} className="h-full w-full object-cover" />;
    }
    const resolvedSourceUrl = sourceUrl ? resolveAssetUrl(sourceUrl) : '';
    if (resolvedSourceUrl) {
        return <video src={resolvedSourceUrl} className="h-full w-full bg-black object-cover" muted playsInline preload="metadata" />;
    }
    return (
        <div className="flex h-full w-full items-center justify-center text-text-tertiary">
            <Clapperboard className="h-6 w-6" />
        </div>
    );
}

function subjectVoiceString(subject: SubjectRecord, keys: string[]): string {
    const voice = subject.voice || {};
    for (const key of keys) {
        const value = voice[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function normalizedModelKey(value?: string): string {
    return String(value || '').trim().toLowerCase();
}

function voiceValueString(voice: Record<string, unknown> | undefined, keys: string[]): string {
    if (!voice) return '';
    for (const key of keys) {
        const value = voice[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function subjectVoiceMappingForModel(subject: SubjectRecord, targetTtsModel?: string): Record<string, unknown> | undefined {
    const modelKey = normalizedModelKey(targetTtsModel);
    if (!modelKey) return subject.voice;
    const voiceMappings = subject.voice?.voiceMappings;
    if (!voiceMappings || typeof voiceMappings !== 'object' || Array.isArray(voiceMappings)) {
        return undefined;
    }
    const mapping = (voiceMappings as Record<string, unknown>)[modelKey];
    return mapping && typeof mapping === 'object' && !Array.isArray(mapping)
        ? mapping as Record<string, unknown>
        : undefined;
}

function subjectVoiceMetadata(subject: SubjectRecord, targetTtsModel?: string): Record<string, unknown> | undefined {
    const modelKey = normalizedModelKey(targetTtsModel);
    if (!modelKey) return subject.voice;
    const mappedVoice = subjectVoiceMappingForModel(subject, targetTtsModel);
    if (mappedVoice) return mappedVoice;
    const topLevelTarget = normalizedModelKey(voiceValueString(subject.voice, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model']));
    return topLevelTarget === modelKey ? subject.voice : undefined;
}

function subjectVoiceSlots(subject: SubjectRecord): SubjectVoiceSlotInfo[] {
    const slots = new Map<string, SubjectVoiceSlotInfo>();
    const addSlot = (voice: Record<string, unknown> | undefined) => {
        const voiceId = voiceValueString(voice, ['voiceId', 'voice_id']);
        const targetTtsModel = voiceValueString(voice, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model', 'model']);
        if (!voiceId || !targetTtsModel) return;
        const key = normalizedModelKey(targetTtsModel);
        if (!key) return;
        slots.set(key, {
            voiceId,
            targetTtsModel,
            cloneModel: voiceValueString(voice, ['cloneModel', 'clone_model']),
            provider: voiceValueString(voice, ['provider']),
            status: voiceValueString(voice, ['status']),
        });
    };

    const voiceMappings = subject.voice?.voiceMappings;
    if (voiceMappings && typeof voiceMappings === 'object' && !Array.isArray(voiceMappings)) {
        Object.values(voiceMappings as Record<string, unknown>).forEach((mapping) => {
            if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
                addSlot(mapping as Record<string, unknown>);
            }
        });
    }
    addSlot(subject.voice);
    return Array.from(slots.values()).sort((left, right) => left.targetTtsModel.localeCompare(right.targetTtsModel));
}

function shortVoiceId(value?: string): string {
    if (!value) return '';
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

function displayModelName(value?: string): string {
    return String(value || '').trim();
}

function cloneModelForTargetTtsModel(targetTtsModel: string, fallbackCloneModel = DEFAULT_VOICE_CLONE_MODEL): string {
    const key = normalizedModelKey(targetTtsModel);
    if (key.includes('cosyvoice')) return COSYVOICE_CLONE_MODEL;
    if (key.startsWith('speech-') || key.startsWith('speech_') || key.includes('minimax')) return MINIMAX_VOICE_CLONE_MODEL;
    return fallbackCloneModel || DEFAULT_VOICE_CLONE_MODEL;
}

function subjectVoiceInfo(subject: SubjectRecord, job?: MediaJobProjection | null, targetTtsModel?: string): SubjectVoiceInfo {
    const voice = subjectVoiceMetadata(subject, targetTtsModel);
    const voiceId = voiceValueString(voice, ['voiceId', 'voice_id']);
    const voiceTargetTtsModel = voiceValueString(voice, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model']);
    const cloneModel = voiceValueString(voice, ['cloneModel', 'clone_model', 'model']);
    const jobId = subjectVoiceString(subject, ['jobId']);
    const status = voiceValueString(voice, ['status']).toLowerCase();
    const lastError = voiceValueString(voice, ['lastError', 'error']);
    const hasSample = Boolean(subject.voicePreviewUrl || subject.voicePath);
    const jobStatus = String(job?.status || '').toLowerCase();
    const topLevelTarget = subjectVoiceString(subject, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model']);
    const activeJobApplies = !targetTtsModel || normalizedModelKey(topLevelTarget) === normalizedModelKey(targetTtsModel);

    if (activeJobApplies && jobStatus && !isMediaJobTerminal(jobStatus)) {
        return {
            label: jobStatus === 'queued' ? '声音复刻排队中' : '声音复刻中',
            detail: jobId ? shortVoiceId(jobId) : undefined,
            tone: 'active',
            targetTtsModel: subjectVoiceString(subject, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model']) || targetTtsModel,
            cloneModel: subjectVoiceString(subject, ['model', 'cloneModel', 'clone_model']),
            jobId,
            canRetry: false,
        };
    }

    if (status === 'queued' || status === 'submitting') {
        return {
            label: '声音复刻排队中',
            detail: jobId ? shortVoiceId(jobId) : undefined,
            tone: 'active',
            targetTtsModel: subjectVoiceString(subject, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model']) || targetTtsModel,
            cloneModel: subjectVoiceString(subject, ['model', 'cloneModel', 'clone_model']),
            jobId,
            canRetry: false,
        };
    }

    if (voiceId) {
        return {
            label: '已绑定声音',
            detail: shortVoiceId(voiceId),
            tone: 'ready',
            voiceId,
            targetTtsModel: voiceTargetTtsModel || targetTtsModel,
            cloneModel,
            jobId,
            canRetry: hasSample,
        };
    }

    if (status === 'failed' || jobStatus === 'failed' || jobStatus === 'dead_lettered') {
        return {
            label: '声音复刻失败',
            detail: lastError || job?.attempt?.lastError || undefined,
            tone: 'failed',
            targetTtsModel: subjectVoiceString(subject, ['targetTtsModel', 'target_tts_model', 'ttsModel', 'tts_model']) || targetTtsModel,
            cloneModel: subjectVoiceString(subject, ['model', 'cloneModel', 'clone_model']),
            jobId,
            error: lastError || job?.attempt?.lastError || undefined,
            canRetry: hasSample,
        };
    }

    if (hasSample) {
        return {
            label: '待复刻',
            tone: 'muted',
            targetTtsModel,
            jobId,
            canRetry: true,
        };
    }

    return {
        label: '无声音参考',
        tone: 'muted',
        canRetry: false,
    };
}

function voiceInfoClassName(tone: SubjectVoiceInfo['tone']): string {
    if (tone === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    if (tone === 'active') return 'border-blue-200 bg-blue-50 text-blue-700';
    if (tone === 'failed') return 'border-red-200 bg-red-50 text-red-700';
    return 'border-border bg-surface-secondary/50 text-text-tertiary';
}

function VoiceSlotBadges({ slots, compact = false }: { slots: SubjectVoiceSlotInfo[]; compact?: boolean }) {
    if (slots.length === 0) return null;
    return (
        <div className={clsx('flex flex-wrap', compact ? 'gap-1' : 'gap-1.5')}>
            {slots.map((slot) => (
                <span
                    key={`${slot.targetTtsModel}-${slot.voiceId}`}
                    className={clsx(
                        'inline-flex max-w-full items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700',
                        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[11px]',
                    )}
                    title={`${slot.targetTtsModel}: ${slot.voiceId}`}
                >
                    <span className="truncate font-mono">{displayModelName(slot.targetTtsModel)}</span>
                    <span className="font-mono opacity-75">{shortVoiceId(slot.voiceId)}</span>
                </span>
            ))}
        </div>
    );
}

function formatAssetDate(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString();
}

function getBrandWorkspaceBridge(): BrandWorkspaceBridge | null {
    return ((window.ipcRenderer as typeof window.ipcRenderer & { brandWorkspace?: BrandWorkspaceBridge }).brandWorkspace || null);
}

function createEmptyProductDraft(brandId = ''): BrandWorkspaceProductDraft {
    return {
        brandId,
        name: '',
        description: '',
        images: [],
        skus: [],
    };
}

function assetRefsToImageDrafts(assets?: BrandWorkspaceAssetRef[]): BrandWorkspaceImageDraft[] {
    return (assets || [])
        .filter((asset) => asset.role === 'image')
        .map((asset) => ({
            id: asset.id,
            name: asset.path.split(/[\\/]/).pop() || 'image',
            path: asset.path,
            previewUrl: asset.path,
        }));
}

function imageDraftPayload(images: BrandWorkspaceImageDraft[]) {
    return images.map((image) => ({
        id: image.id,
        path: image.path,
        dataUrl: image.dataUrl,
        name: image.name,
        role: 'image',
    }));
}

const ALL_ECOMMERCE_PLATFORMS = ECOMMERCE_PLATFORM_GROUPS.flatMap((group) => group.platforms);

function enabledEcommercePlatformsFromSettings(settings: Record<string, unknown>): EcommercePlatformRecord[] {
    const normalized = normalizeEcommercePlatformsSettings(settings.ecommerce_platforms_json);
    return ALL_ECOMMERCE_PLATFORMS.filter((platform) => normalized.enabledById[platform.id] !== false);
}

function detailVersionKey(market = '', locale = ''): string {
    const cleanMarket = market.trim();
    const cleanLocale = locale.trim();
    return cleanMarket || cleanLocale ? `${cleanMarket}__${cleanLocale}` : '__default__';
}

function detailVersionLabel(page?: Pick<BrandWorkspaceProductDetailPage, 'market' | 'locale'>): string {
    if (!page) return '默认版本';
    const parts = [page.market, page.locale].map((value) => value.trim()).filter(Boolean);
    return parts.length ? parts.join(' / ') : '默认版本';
}

async function imageFilesToDrafts(files: FileList | null): Promise<BrandWorkspaceImageDraft[]> {
    const nextFiles = Array.from(files || []);
    const invalid = nextFiles.find((file) => !file.type.startsWith('image/'));
    if (invalid) {
        throw new Error('仅支持图片文件');
    }
    return Promise.all(nextFiles.map(async (file) => {
        const dataUrl = await readFileAsDataUrl(file);
        return {
            name: file.name,
            previewUrl: dataUrl,
            dataUrl,
        };
    }));
}

interface BrandWorkspaceImageGridProps {
    images: BrandWorkspaceImageDraft[];
    onAdd: (files: FileList | null) => void;
    onRemove: (index: number) => void;
    label: string;
}

function BrandWorkspaceImageGrid({ images, onAdd, onRemove, label }: BrandWorkspaceImageGridProps) {
    return (
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-6">
            {images.map((image, index) => (
                <div key={`${image.path || image.name}-${index}`} className="group relative aspect-square overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))]">
                    <img src={resolveAssetUrl(image.previewUrl)} alt={image.name} className="h-full w-full object-cover" />
                    <button
                        type="button"
                        onClick={() => onRemove(index)}
                        className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                        aria-label="删除图片"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ))}
            <label className="flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] text-[rgb(var(--color-text-tertiary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]" aria-label={label} title={label}>
                <Plus className="h-5 w-5" />
                <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        onAdd(event.target.files);
                        event.currentTarget.value = '';
                    }}
                />
            </label>
        </div>
    );
}

function productBundleToDraft(bundle: BrandWorkspaceProductBundle): BrandWorkspaceProductDraft {
    return {
        id: bundle.product.id,
        brandId: bundle.product.brandId,
        name: bundle.product.name,
        description: bundle.product.description || '',
        images: assetRefsToImageDrafts(bundle.assets),
        skus: bundle.skus.map((sku) => ({
            id: sku.id,
            name: sku.name,
            variantText: sku.variantText || '',
            images: assetRefsToImageDrafts(bundle.skuAssets?.[sku.id]),
        })),
    };
}

function createEmptyBrandDraft(brand?: BrandWorkspaceBrand, assets?: BrandWorkspaceAssetRef[]): BrandWorkspaceBrandDraft {
    return {
        id: brand?.id,
        name: brand?.name || '',
        description: brand?.description || '',
        images: assetRefsToImageDrafts(assets),
    };
}

interface SubjectsProps {
    isActive?: boolean;
    onReturnHome?: () => void;
    onClose?: () => void;
    variant?: 'page' | 'modal';
}

export function Subjects({ isActive = true, onReturnHome, onClose, variant = 'page' }: SubjectsProps) {
    const isModalVariant = variant === 'modal';
    const [categories, setCategories] = useState<SubjectCategory[]>([]);
    const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
    const [brandWorkspaceBrands, setBrandWorkspaceBrands] = useState<BrandWorkspaceBrandBundle[]>([]);
    const [brandWorkspaceError, setBrandWorkspaceError] = useState('');
    const [enabledEcommercePlatforms, setEnabledEcommercePlatforms] = useState<EcommercePlatformRecord[]>([]);
    const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
    const [libraryTab, setLibraryTab] = useState<AssetLibraryTab>('assets');
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');
    const [viewMode, setViewMode] = useState<SubjectViewMode>('grid');
    const [filterOpen, setFilterOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isAssetModalVisible, setIsAssetModalVisible] = useState(false);
    const [assetModalPhase, setAssetModalPhase] = useState<AssetModalPhase>('closing');
    const [isDraftCategoryMenuOpen, setIsDraftCategoryMenuOpen] = useState(false);
    const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
    const [categoryDialogMode, setCategoryDialogMode] = useState<CategoryDialogMode>('create');
    const [categoryDialogName, setCategoryDialogName] = useState('');
    const [categoryDialogTargetId, setCategoryDialogTargetId] = useState<string | null>(null);
    const [isCategoryDialogSubmitting, setIsCategoryDialogSubmitting] = useState(false);
    const [draft, setDraft] = useState<SubjectDraft>(createEmptyDraft);
    const [brandDraft, setBrandDraft] = useState<BrandWorkspaceBrandDraft>(() => createEmptyBrandDraft());
    const [isBrandModalOpen, setIsBrandModalOpen] = useState(false);
    const [isBrandModalSubmitting, setIsBrandModalSubmitting] = useState(false);
    const [productDraft, setProductDraft] = useState<BrandWorkspaceProductDraft>(() => createEmptyProductDraft());
    const [productDraftBrand, setProductDraftBrand] = useState<BrandWorkspaceBrand | null>(null);
    const [isProductModalOpen, setIsProductModalOpen] = useState(false);
    const [isProductModalSubmitting, setIsProductModalSubmitting] = useState(false);
    const [expandedBrandIds, setExpandedBrandIds] = useState<Set<string>>(() => new Set());
    const [productDetailContext, setProductDetailContext] = useState<ProductDetailContext | null>(null);
    const [selectedDetailPlatformId, setSelectedDetailPlatformId] = useState('');
    const [selectedDetailVersionKey, setSelectedDetailVersionKey] = useState('__default__');
    const [detailVersionDraft, setDetailVersionDraft] = useState<ProductDetailVersionDraft>({ market: '', locale: '', title: '' });
    const [detailImageDrafts, setDetailImageDrafts] = useState<BrandWorkspaceImageDraft[]>([]);
    const [isDetailPageSubmitting, setIsDetailPageSubmitting] = useState(false);
    const [initialVoicePresent, setInitialVoicePresent] = useState(false);
    const [initialVideoPresent, setInitialVideoPresent] = useState(false);
    const [recordingError, setRecordingError] = useState('');
    const [recordingHint, setRecordingHint] = useState('');
    const [voiceCloneModelOptions, setVoiceCloneModelOptions] = useState<VoiceCloneModelOption[]>([]);
    const [selectedVoiceCloneTtsModel, setSelectedVoiceCloneTtsModel] = useState(DEFAULT_VOICE_TTS_MODEL);
    const [voiceModelSettingsSnapshot, setVoiceModelSettingsSnapshot] = useState<Record<string, unknown>>({});
    const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
    const recordingIntervalRef = useRef<number | null>(null);
    const hasLoadedSnapshotRef = useRef(false);
    const hasEnsuredDefaultCategoriesRef = useRef(false);
    const hasAppliedInitialCategoryRef = useRef(false);
    const hasInitializedBrandExpansionRef = useRef(false);
    const loadDataRequestRef = useRef(0);
    const refreshedVoiceJobIdsRef = useRef(new Set<string>());
    const autosaveTimerRef = useRef<number | null>(null);
    const autosaveLastPayloadRef = useRef<string | null>(null);
    const autosaveSavingRef = useRef(false);
    const autosaveVersionRef = useRef(0);
    const assetModalAnimationTimerRef = useRef<number | null>(null);
    const assetModalAnimationFrameRef = useRef<number | null>(null);
    const [retryingVoiceSubjectId, setRetryingVoiceSubjectId] = useState<string | null>(null);
    const [generatingCardSubjectId, setGeneratingCardSubjectId] = useState<string | null>(null);
    const [previewImage, setPreviewImage] = useState<SubjectImageDraft | null>(null);
    const [mediaContextMenu, setMediaContextMenu] = useState<MediaAssetContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        asset: null,
    });
    const clearAssetModalAnimationHandles = useCallback(() => {
        if (assetModalAnimationTimerRef.current !== null) {
            window.clearTimeout(assetModalAnimationTimerRef.current);
            assetModalAnimationTimerRef.current = null;
        }
        if (assetModalAnimationFrameRef.current !== null) {
            window.cancelAnimationFrame(assetModalAnimationFrameRef.current);
            assetModalAnimationFrameRef.current = null;
        }
    }, []);

    const openAssetModalSurface = useCallback(() => {
        clearAssetModalAnimationHandles();
        setIsModalOpen(true);
        setIsAssetModalVisible(true);
        setAssetModalPhase('opening');
        assetModalAnimationFrameRef.current = window.requestAnimationFrame(() => {
            assetModalAnimationFrameRef.current = window.requestAnimationFrame(() => {
                setAssetModalPhase('open');
                assetModalAnimationFrameRef.current = null;
            });
        });
    }, [clearAssetModalAnimationHandles]);

    const resetAssetModalDraft = useCallback(() => {
        setPreviewImage(null);
        setDraft(createEmptyDraft());
        setInitialVoicePresent(false);
        setInitialVideoPresent(false);
        setError('');
        setRecordingError('');
        setRecordingHint('');
    }, []);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        uiDebug('subjects', isActive ? 'view_activate' : 'view_deactivate', {
            loading,
            subjectCount: subjects.length,
        });
    }, [isActive, loading, subjects.length]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        uiDebug('subjects', 'view_mount');
        return () => {
            uiDebug('subjects', 'view_unmount');
        };
    }, []);

    useEffect(() => {
        if (!mediaContextMenu.visible) return;
        const close = () => setMediaContextMenu((current) => ({ ...current, visible: false, asset: null }));
        window.addEventListener('click', close);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [mediaContextMenu.visible]);

    const loadData = useCallback(async () => {
        const requestId = loadDataRequestRef.current + 1;
        loadDataRequestRef.current = requestId;
        if (!hasLoadedSnapshotRef.current) {
            setLoading(true);
        }
        setError('');
        try {
            const brandWorkspaceBridge = getBrandWorkspaceBridge();
            const [categoriesResult, subjectsResult, brandWorkspaceResult, mediaResult, settingsResult] = await uiMeasure('subjects', 'load_data', async () => (
                Promise.all([
                    window.ipcRenderer.subjects.categories.list(),
                    window.ipcRenderer.subjects.list({ limit: 500 }),
                    brandWorkspaceBridge
                        ? brandWorkspaceBridge.list()
                        : Promise.resolve({ success: false, error: '品牌工作区不可用', brands: [] }),
                    isModalVariant
                        ? window.ipcRenderer.invoke('media:list', { limit: 500 }) as Promise<{ success?: boolean; error?: string; assets?: MediaAsset[] }>
                        : Promise.resolve({ success: true, assets: [] }),
                    window.ipcRenderer.getSettings().catch(() => ({})),
                ])
            ), { requestId });
            if (!categoriesResult?.success) {
                throw new Error(categoriesResult?.error || '加载分类失败');
            }
            if (!subjectsResult?.success) {
                throw new Error(subjectsResult?.error || '加载资产失败');
            }
            if (requestId !== loadDataRequestRef.current) return;
            const nextCategories = Array.isArray(categoriesResult.categories) ? categoriesResult.categories : [];
            const settingsSnapshot = settingsResult as Record<string, unknown>;
            const voiceModelSettings = buildVoiceCloneModelOptions(settingsSnapshot);
            setCategories(nextCategories);
            setSubjects(Array.isArray(subjectsResult.subjects) ? subjectsResult.subjects : []);
            setBrandWorkspaceBrands(Array.isArray(brandWorkspaceResult?.brands) ? brandWorkspaceResult.brands : []);
            setBrandWorkspaceError(brandWorkspaceResult?.success === false ? (brandWorkspaceResult.error || '品牌工作区加载失败') : '');
            setEnabledEcommercePlatforms(enabledEcommercePlatformsFromSettings(settingsSnapshot));
            setVoiceModelSettingsSnapshot(settingsSnapshot);
            setVoiceCloneModelOptions(voiceModelSettings.options);
            setSelectedVoiceCloneTtsModel((current) => (
                current && voiceModelSettings.options.some((option) => option.value === current)
                    ? current
                    : voiceModelSettings.selectedModel
            ));
            setMediaAssets(
                Array.isArray(mediaResult?.assets)
                    ? mediaResult.assets.map(normalizeMediaAsset).sort((a, b) => (
                        new Date(b.createdAt || b.updatedAt || 0).getTime() - new Date(a.createdAt || a.updatedAt || 0).getTime()
                    ))
                    : []
            );
            hasLoadedSnapshotRef.current = true;
            if (!hasEnsuredDefaultCategoriesRef.current) {
                const existingNames = new Set(nextCategories.map((item) => item.name.trim()));
                const missingNames = DEFAULT_SUBJECT_CATEGORY_NAMES.filter((name) => !existingNames.has(name));
                if (missingNames.length > 0) {
                    hasEnsuredDefaultCategoriesRef.current = true;
                    await Promise.all(missingNames.map((name) => window.ipcRenderer.subjects.categories.create({ name })));
                    if (requestId === loadDataRequestRef.current) {
                        void loadData();
                    }
                } else {
                    hasEnsuredDefaultCategoriesRef.current = true;
                }
            }
        } catch (e) {
            if (requestId !== loadDataRequestRef.current) return;
            console.error('Failed to load subjects:', e);
            setError(e instanceof Error ? e.message : '加载资产库失败');
            if (!hasLoadedSnapshotRef.current) {
                setCategories([]);
                setSubjects([]);
                setBrandWorkspaceBrands([]);
                setEnabledEcommercePlatforms([]);
                setMediaAssets([]);
            }
        } finally {
            if (requestId === loadDataRequestRef.current) {
                setLoading(false);
            }
        }
    }, [isModalVariant]);

    useEffect(() => {
        if (!isActive) return;
        void loadData();
    }, [isActive, loadData]);

    useEffect(() => {
        if (!productDetailContext) return;
        if (enabledEcommercePlatforms.length === 0) {
            setSelectedDetailPlatformId('');
            return;
        }
        if (!selectedDetailPlatformId || !enabledEcommercePlatforms.some((platform) => platform.id === selectedDetailPlatformId)) {
            setSelectedDetailPlatformId(enabledEcommercePlatforms[0].id);
        }
    }, [enabledEcommercePlatforms, productDetailContext, selectedDetailPlatformId]);

    const voiceJobIds = useMemo(
        () => Array.from(new Set(subjects
            .map((subject) => subjectVoiceString(subject, ['jobId']))
            .filter(Boolean))),
        [subjects],
    );
    const voiceJobs = useMediaJobsByIds(voiceJobIds);
    const voiceJobsById = useMemo(() => (
        Object.fromEntries(voiceJobs.map((job) => [job.jobId, job])) as Record<string, MediaJobProjection>
    ), [voiceJobs]);
    const voiceJobBootstrapFilter = useMemo(() => ({ kind: 'voice_clone' as const, limit: 100 }), []);

    useMediaJobSubscription(voiceJobIds, {
        enabled: isActive,
        bootstrapFilter: voiceJobBootstrapFilter,
    });

    useEffect(() => {
        if (!isActive) return;
        for (const job of voiceJobs) {
            const jobId = job.jobId;
            if (!job || !isMediaJobTerminal(job.status) || refreshedVoiceJobIdsRef.current.has(jobId)) {
                continue;
            }
            refreshedVoiceJobIdsRef.current.add(jobId);
            void loadData();
            break;
        }
    }, [isActive, loadData, voiceJobs]);

    const categoryNameMap = useMemo(() => new Map(categories.map((item) => [item.id, item.name])), [categories]);
    useEffect(() => {
        if (hasAppliedInitialCategoryRef.current) return;
        const brandCategory = categories.find((item) => item.name.trim() === '品牌');
        if (!brandCategory) return;
        hasAppliedInitialCategoryRef.current = true;
        setCategoryFilter(brandCategory.id);
    }, [categories]);
    const subjectCategoryName = useCallback((subject: SubjectRecord) => (
        categoryNameMap.get(subject.categoryId || '')?.trim() || ''
    ), [categoryNameMap]);
    const subjectNameMap = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects]);
    const productCountByBrandId = useMemo(() => {
        const counts = new Map<string, number>();
        for (const bundle of brandWorkspaceBrands) {
            counts.set(bundle.brand.id, bundle.products.length);
        }
        return counts;
    }, [brandWorkspaceBrands]);
    const activeDetailBrandBundle = useMemo(() => (
        productDetailContext
            ? brandWorkspaceBrands.find((bundle) => bundle.brand.id === productDetailContext.brandId) || null
            : null
    ), [brandWorkspaceBrands, productDetailContext]);
    const activeDetailProductBundle = useMemo(() => (
        productDetailContext && activeDetailBrandBundle
            ? activeDetailBrandBundle.products.find((bundle) => bundle.product.id === productDetailContext.productId) || null
            : null
    ), [activeDetailBrandBundle, productDetailContext]);
    const activeDetailPlatform = useMemo(() => (
        enabledEcommercePlatforms.find((platform) => platform.id === selectedDetailPlatformId) || enabledEcommercePlatforms[0] || null
    ), [enabledEcommercePlatforms, selectedDetailPlatformId]);
    const activeDetailPages = useMemo(() => (
        activeDetailProductBundle && activeDetailPlatform
            ? (activeDetailProductBundle.detailPages || []).filter((page) => page.platform === activeDetailPlatform.id)
            : []
    ), [activeDetailPlatform, activeDetailProductBundle]);
    const isDraftDetailVersion = selectedDetailVersionKey.startsWith('draft-');
    const activeDetailPage = useMemo(() => (
        isDraftDetailVersion
            ? null
            : activeDetailPages.find((page) => detailVersionKey(page.market, page.locale) === selectedDetailVersionKey)
                || activeDetailPages.find((page) => detailVersionKey(page.market, page.locale) === '__default__')
                || activeDetailPages[0]
                || null
    ), [activeDetailPages, isDraftDetailVersion, selectedDetailVersionKey]);
    const productDetailThumbnailsByProductId = useMemo(() => {
        const result = new Map<string, BrandWorkspaceAssetRef[]>();
        for (const brandBundle of brandWorkspaceBrands) {
            for (const productBundle of brandBundle.products) {
                const assets = (productBundle.detailPages || []).flatMap((page) => (
                    productBundle.detailPageAssets?.[page.id] || []
                ));
                if (assets.length) {
                    result.set(productBundle.product.id, assets.slice(0, 5));
                }
            }
        }
        return result;
    }, [brandWorkspaceBrands]);
    useEffect(() => {
        if (!productDetailContext) return;
        if (isDraftDetailVersion) return;
        if (activeDetailPage) {
            setSelectedDetailVersionKey(detailVersionKey(activeDetailPage.market, activeDetailPage.locale));
            setDetailVersionDraft({
                market: activeDetailPage.market,
                locale: activeDetailPage.locale,
                title: activeDetailPage.title || '',
            });
            setDetailImageDrafts(assetRefsToImageDrafts(activeDetailProductBundle?.detailPageAssets?.[activeDetailPage.id]));
            return;
        }
        setSelectedDetailVersionKey('__default__');
        setDetailVersionDraft({ market: '', locale: '', title: '' });
        setDetailImageDrafts([]);
    }, [activeDetailPage, activeDetailProductBundle, isDraftDetailVersion, productDetailContext]);
    const activeDraftSubject = useMemo(
        () => draft.id ? subjects.find((subject) => subject.id === draft.id) || null : null,
        [draft.id, subjects],
    );
    const activeDraftVoiceInfo = useMemo(
        () => {
            if (!activeDraftSubject) return null;
            if (retryingVoiceSubjectId === activeDraftSubject.id) {
                const targetTtsModel = selectedVoiceCloneTtsModel || DEFAULT_VOICE_TTS_MODEL;
                return {
                    label: '声音复刻提交中',
                    tone: 'active',
                    targetTtsModel,
                    cloneModel: cloneModelForTargetTtsModel(targetTtsModel),
                    canRetry: false,
                } satisfies SubjectVoiceInfo;
            }
            return subjectVoiceInfo(
                activeDraftSubject,
                voiceJobsById[subjectVoiceString(activeDraftSubject, ['jobId'])],
                selectedVoiceCloneTtsModel,
            );
        },
        [activeDraftSubject, retryingVoiceSubjectId, selectedVoiceCloneTtsModel, voiceJobsById],
    );
    const activeDraftVoiceSlots = useMemo(
        () => activeDraftSubject ? subjectVoiceSlots(activeDraftSubject) : [],
        [activeDraftSubject],
    );
    const filteredSubjects = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return subjects.filter((subject) => {
            if (['品牌', '商品'].includes(subjectCategoryName(subject))) return false;
            if (categoryFilter === UNCATEGORIZED_FILTER && subject.categoryId) return false;
            if (categoryFilter !== UNCATEGORIZED_FILTER && subject.categoryId !== categoryFilter) return false;
            if (!keyword) return true;
            const haystack = [
                subject.name,
                subject.description || '',
                subject.tags.join(' '),
                subject.attributes.map((item) => `${item.key} ${item.value}`).join(' '),
                subject.brandId ? subjectNameMap.get(subject.brandId) || '' : '',
                (subject.skus || []).map((sku) => [
                    sku.name,
                    ...(sku.attributes || []).map((item) => `${item.key} ${item.value}`),
                ].join(' ')).join(' '),
                categoryNameMap.get(subject.categoryId || '') || '',
            ].join('\n').toLowerCase();
            return haystack.includes(keyword);
        });
    }, [categoryFilter, categoryNameMap, query, subjectCategoryName, subjectNameMap, subjects]);

    const isBrandCategoryView = categoryNameMap.get(categoryFilter)?.trim() === '品牌';
    const filteredBrandSubjects = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return brandWorkspaceBrands.filter((bundle) => {
            if (!keyword) return true;
            const haystack = [
                bundle.brand.name,
                bundle.brand.description || '',
                bundle.products.map((productBundle) => [
                    productBundle.product.name,
                    productBundle.product.description || '',
                    productBundle.skus.map((sku) => [
                        sku.name,
                        sku.variantText || '',
                    ].join(' ')).join(' '),
                ].join(' ')).join(' '),
            ].join('\n').toLowerCase();
            return haystack.includes(keyword);
        });
    }, [brandWorkspaceBrands, query]);
    useEffect(() => {
        if (hasInitializedBrandExpansionRef.current) return;
        if (brandWorkspaceBrands.length !== 1 || brandWorkspaceBrands[0].products.length === 0) return;
        hasInitializedBrandExpansionRef.current = true;
        setExpandedBrandIds(new Set([brandWorkspaceBrands[0].brand.id]));
    }, [brandWorkspaceBrands]);

    const filteredMediaAssets = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return mediaAssets;
        return mediaAssets.filter((asset) => {
            const haystack = [
                asset.title || '',
                asset.prompt || '',
                asset.projectId || '',
                asset.boundManuscriptPath || '',
                asset.relativePath || '',
                asset.id,
            ].join('\n').toLowerCase();
            return haystack.includes(keyword);
        });
    }, [mediaAssets, query]);

    const categoryStats = useMemo(() => {
        const stats = new Map<string, number>();
        stats.set('all', subjects.length);
        stats.set(UNCATEGORIZED_FILTER, subjects.filter((item) => !item.categoryId).length);
        for (const category of categories) {
            stats.set(category.id, subjects.filter((item) => item.categoryId === category.id).length);
        }
        return stats;
    }, [categories, subjects]);

    const openCreateBrandModal = useCallback(() => {
        setBrandDraft(createEmptyBrandDraft());
        setError('');
        setIsBrandModalOpen(true);
    }, []);

    const openEditBrandModal = useCallback((brand: BrandWorkspaceBrand, assets: BrandWorkspaceAssetRef[] = []) => {
        setBrandDraft(createEmptyBrandDraft(brand, assets));
        setError('');
        setIsBrandModalOpen(true);
    }, []);

    const closeBrandModal = useCallback(() => {
        if (isBrandModalSubmitting) return;
        setIsBrandModalOpen(false);
        setBrandDraft(createEmptyBrandDraft());
    }, [isBrandModalSubmitting]);

    const updateBrandDraft = useCallback((patch: Partial<BrandWorkspaceBrandDraft>) => {
        setBrandDraft((current) => ({ ...current, ...patch }));
    }, []);

    const handleSaveBrand = useCallback(async () => {
        const name = brandDraft.name.trim();
        if (!name) {
            void appAlert('品牌名称不能为空');
            return;
        }
        const brandWorkspaceBridge = getBrandWorkspaceBridge();
        if (!brandWorkspaceBridge) {
            void appAlert('品牌工作区不可用');
            return;
        }
        setIsBrandModalSubmitting(true);
        setError('');
        try {
            const result = await brandWorkspaceBridge.upsertBrand({
                id: brandDraft.id,
                name,
                description: brandDraft.description.trim() || undefined,
                images: imageDraftPayload(brandDraft.images),
            });
            if (!result?.success) {
                throw new Error(result?.error || '保存品牌失败');
            }
            await loadData();
            closeBrandModal();
        } catch (e) {
            console.error('Failed to save brand:', e);
            setError(e instanceof Error ? e.message : '保存品牌失败');
        } finally {
            setIsBrandModalSubmitting(false);
        }
    }, [brandDraft, closeBrandModal, loadData]);

    const handleBrandImageInput = useCallback(async (files: FileList | null) => {
        try {
            const images = await imageFilesToDrafts(files);
            if (!images.length) return;
            setBrandDraft((current) => ({ ...current, images: [...current.images, ...images] }));
        } catch (e) {
            void appAlert(e instanceof Error ? e.message : '品牌图片仅支持图片文件');
        }
    }, []);

    const handleRemoveBrandImage = useCallback((index: number) => {
        setBrandDraft((current) => ({
            ...current,
            images: current.images.filter((_, itemIndex) => itemIndex !== index),
        }));
    }, []);

    const openCreateModal = useCallback(() => {
        if (categoryNameMap.get(categoryFilter)?.trim() === '品牌') {
            openCreateBrandModal();
            return;
        }
        const nextDraft = createEmptyDraft();
        if (categoryFilter !== UNCATEGORIZED_FILTER) {
            nextDraft.categoryId = categoryFilter;
        }
        autosaveLastPayloadRef.current = null;
        setDraft(nextDraft);
        setInitialVoicePresent(false);
        setInitialVideoPresent(false);
        setError('');
        setIsDraftCategoryMenuOpen(false);
        openAssetModalSurface();
    }, [categoryFilter, categoryNameMap, openAssetModalSurface, openCreateBrandModal]);

    const openEditModal = useCallback((subject: SubjectRecord) => {
        autosaveLastPayloadRef.current = null;
        setDraft(toDraft(subject));
        setInitialVoicePresent(Boolean(subject.voicePreviewUrl));
        setInitialVideoPresent(Boolean(subject.videoPreviewUrl));
        setError('');
        setIsDraftCategoryMenuOpen(false);
        openAssetModalSurface();
    }, [openAssetModalSurface]);

    const openCreateProductModal = useCallback((brand: BrandWorkspaceBrand) => {
        setProductDraft(createEmptyProductDraft(brand.id));
        setProductDraftBrand(brand);
        setError('');
        setExpandedBrandIds((current) => new Set(current).add(brand.id));
        setIsProductModalOpen(true);
    }, []);

    const openEditProductModal = useCallback((brand: BrandWorkspaceBrand, productBundle: BrandWorkspaceProductBundle) => {
        setProductDraft(productBundleToDraft(productBundle));
        setProductDraftBrand(brand);
        setError('');
        setExpandedBrandIds((current) => new Set(current).add(brand.id));
        setIsProductModalOpen(true);
    }, []);

    const openProductDetailPage = useCallback((brand: BrandWorkspaceBrand, productBundle: BrandWorkspaceProductBundle) => {
        setProductDetailContext({ brandId: brand.id, productId: productBundle.product.id });
        setSelectedDetailPlatformId((current) => current || enabledEcommercePlatforms[0]?.id || '');
        setSelectedDetailVersionKey('__default__');
        setDetailVersionDraft({ market: '', locale: '', title: '' });
        setDetailImageDrafts([]);
        setError('');
    }, [enabledEcommercePlatforms]);

    const closeProductDetailPage = useCallback(() => {
        if (isDetailPageSubmitting) return;
        setProductDetailContext(null);
        setSelectedDetailVersionKey('__default__');
        setDetailVersionDraft({ market: '', locale: '', title: '' });
        setDetailImageDrafts([]);
    }, [isDetailPageSubmitting]);

    const handleDetailImageInput = useCallback(async (files: FileList | null) => {
        try {
            const images = await imageFilesToDrafts(files);
            if (!images.length) return;
            setDetailImageDrafts((current) => [...current, ...images]);
        } catch (e) {
            void appAlert(e instanceof Error ? e.message : '商品详情图仅支持图片文件');
        }
    }, []);

    const handleRemoveDetailImage = useCallback((index: number) => {
        setDetailImageDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index));
    }, []);

    const handleSelectDetailVersion = useCallback((page: BrandWorkspaceProductDetailPage) => {
        setSelectedDetailVersionKey(detailVersionKey(page.market, page.locale));
        setDetailVersionDraft({
            market: page.market,
            locale: page.locale,
            title: page.title || '',
        });
        setDetailImageDrafts(assetRefsToImageDrafts(activeDetailProductBundle?.detailPageAssets?.[page.id]));
    }, [activeDetailProductBundle]);

    const handleCreateDetailVersion = useCallback(() => {
        setSelectedDetailVersionKey(`draft-${Date.now()}`);
        setDetailVersionDraft({ market: '', locale: '', title: '' });
        setDetailImageDrafts([]);
    }, []);

    const handleSaveDetailPage = useCallback(async () => {
        if (!activeDetailProductBundle || !activeDetailPlatform) {
            void appAlert('请选择商品和电商平台');
            return;
        }
        const brandWorkspaceBridge = getBrandWorkspaceBridge();
        if (!brandWorkspaceBridge?.upsertProductDetailPage) {
            void appAlert('商品详情图保存接口不可用');
            return;
        }
        setIsDetailPageSubmitting(true);
        setError('');
        try {
            const result = await brandWorkspaceBridge.upsertProductDetailPage({
                id: activeDetailPage?.id,
                productId: activeDetailProductBundle.product.id,
                platform: activeDetailPlatform.id,
                market: detailVersionDraft.market.trim(),
                locale: detailVersionDraft.locale.trim(),
                title: detailVersionDraft.title.trim() || undefined,
                images: imageDraftPayload(detailImageDrafts),
            });
            if (!result?.success) {
                throw new Error(result?.error || '保存商品详情图失败');
            }
            await loadData();
            setSelectedDetailVersionKey(detailVersionKey(detailVersionDraft.market, detailVersionDraft.locale));
        } catch (e) {
            console.error('Failed to save product detail page:', e);
            setError(e instanceof Error ? e.message : '保存商品详情图失败');
        } finally {
            setIsDetailPageSubmitting(false);
        }
    }, [activeDetailPage, activeDetailPlatform, activeDetailProductBundle, detailImageDrafts, detailVersionDraft, loadData]);

    const closeProductModal = useCallback(() => {
        if (isProductModalSubmitting) return;
        setIsProductModalOpen(false);
        setProductDraft(createEmptyProductDraft());
        setProductDraftBrand(null);
    }, [isProductModalSubmitting]);

    const updateProductDraft = useCallback((patch: Partial<BrandWorkspaceProductDraft>) => {
        setProductDraft((current) => ({ ...current, ...patch }));
    }, []);

    const handleAddProductSku = useCallback(() => {
        setProductDraft((current) => ({
            ...current,
            skus: [
                ...current.skus,
                { id: createDraftSkuId(), name: '', variantText: '', images: [] },
            ],
        }));
    }, []);

    const handleProductSkuChange = useCallback((index: number, patch: Partial<BrandWorkspaceSkuDraft>) => {
        setProductDraft((current) => ({
            ...current,
            skus: current.skus.map((sku, skuIndex) => skuIndex === index ? { ...sku, ...patch } : sku),
        }));
    }, []);

    const handleRemoveProductSku = useCallback((index: number) => {
        setProductDraft((current) => ({
            ...current,
            skus: current.skus.filter((_, skuIndex) => skuIndex !== index),
        }));
    }, []);

    const handleProductImageInput = useCallback(async (files: FileList | null) => {
        try {
            const images = await imageFilesToDrafts(files);
            if (!images.length) return;
            setProductDraft((current) => ({ ...current, images: [...current.images, ...images] }));
        } catch (e) {
            void appAlert(e instanceof Error ? e.message : '商品图片仅支持图片文件');
        }
    }, []);

    const handleRemoveProductImage = useCallback((index: number) => {
        setProductDraft((current) => ({
            ...current,
            images: current.images.filter((_, itemIndex) => itemIndex !== index),
        }));
    }, []);

    const handleProductSkuImageInput = useCallback(async (index: number, files: FileList | null) => {
        try {
            const images = await imageFilesToDrafts(files);
            if (!images.length) return;
            setProductDraft((current) => ({
                ...current,
                skus: current.skus.map((sku, skuIndex) => (
                    skuIndex === index ? { ...sku, images: [...sku.images, ...images] } : sku
                )),
            }));
        } catch (e) {
            void appAlert(e instanceof Error ? e.message : 'SKU 图片仅支持图片文件');
        }
    }, []);

    const handleRemoveProductSkuImage = useCallback((skuIndex: number, imageIndex: number) => {
        setProductDraft((current) => ({
            ...current,
            skus: current.skus.map((sku, currentSkuIndex) => (
                currentSkuIndex === skuIndex
                    ? { ...sku, images: sku.images.filter((_, currentImageIndex) => currentImageIndex !== imageIndex) }
                    : sku
            )),
        }));
    }, []);

    const handleSaveProduct = useCallback(async () => {
        const name = productDraft.name.trim();
        if (!name) {
            void appAlert('商品名称不能为空');
            return;
        }
        const brandWorkspaceBridge = getBrandWorkspaceBridge();
        if (!brandWorkspaceBridge) {
            void appAlert('品牌工作区不可用');
            return;
        }
        setIsProductModalSubmitting(true);
        setError('');
        try {
            const payload = {
                id: productDraft.id,
                brandId: productDraft.brandId,
                name,
                description: productDraft.description.trim() || undefined,
                images: imageDraftPayload(productDraft.images),
                skus: productDraft.skus
                    .filter((sku) => sku.name.trim())
                    .map((sku) => ({
                        id: sku.id.startsWith('draft-sku-') ? undefined : sku.id,
                        name: sku.name.trim(),
                        variantText: sku.variantText.trim(),
                        images: imageDraftPayload(sku.images),
                    })),
            };
            const result = await brandWorkspaceBridge.upsertProduct(payload);
            if (!result?.success) {
                throw new Error(result?.error || '保存商品失败');
            }
            await loadData();
            closeProductModal();
        } catch (e) {
            console.error('Failed to save product:', e);
            setError(e instanceof Error ? e.message : '保存商品失败');
        } finally {
            setIsProductModalSubmitting(false);
        }
    }, [closeProductModal, loadData, productDraft]);

    const openCreateCategoryDialog = useCallback(() => {
        setCategoryDialogMode('create');
        setCategoryDialogTargetId(null);
        setCategoryDialogName('');
        setIsCategoryDialogOpen(true);
    }, []);

    const openRenameCategoryDialog = useCallback((category: SubjectCategory) => {
        setCategoryDialogMode('rename');
        setCategoryDialogTargetId(category.id);
        setCategoryDialogName(category.name);
        setIsCategoryDialogOpen(true);
    }, []);

    const resetCategoryDialog = useCallback(() => {
        setIsCategoryDialogOpen(false);
        setCategoryDialogTargetId(null);
        setCategoryDialogName('');
    }, []);

    const closeCategoryDialog = useCallback(() => {
        if (isCategoryDialogSubmitting) return;
        resetCategoryDialog();
    }, [isCategoryDialogSubmitting, resetCategoryDialog]);

    const clearRecordingTimers = useCallback(() => {
        if (recordingIntervalRef.current) {
            window.clearInterval(recordingIntervalRef.current);
            recordingIntervalRef.current = null;
        }
    }, []);

    const updateDraft = useCallback((patch: Partial<SubjectDraft>) => {
        setDraft((current) => ({ ...current, ...patch }));
    }, []);

    const handleAddAttribute = useCallback(() => {
        setDraft((current) => ({
            ...current,
            attributes: [...current.attributes, { key: '', value: '' }],
        }));
    }, []);

    const handleAttributeChange = useCallback((index: number, patch: Partial<SubjectAttribute>) => {
        setDraft((current) => ({
            ...current,
            attributes: current.attributes.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
        }));
    }, []);

    const handleRemoveAttribute = useCallback((index: number) => {
        setDraft((current) => ({
            ...current,
            attributes: current.attributes.filter((_, itemIndex) => itemIndex !== index),
        }));
    }, []);

    const handleAddSku = useCallback(() => {
        setDraft((current) => ({
            ...current,
            skus: [
                ...current.skus,
                {
                    id: createDraftSkuId(),
                    name: '',
                    attributes: [{ key: '规格', value: '' }],
                },
            ],
        }));
    }, []);

    const handleSkuChange = useCallback((index: number, patch: Partial<SubjectSku>) => {
        setDraft((current) => ({
            ...current,
            skus: current.skus.map((sku, skuIndex) => skuIndex === index ? { ...sku, ...patch } : sku),
        }));
    }, []);

    const handleSkuAttributeChange = useCallback((skuIndex: number, attributeIndex: number, patch: Partial<SubjectAttribute>) => {
        setDraft((current) => ({
            ...current,
            skus: current.skus.map((sku, currentSkuIndex) => {
                if (currentSkuIndex !== skuIndex) return sku;
                return {
                    ...sku,
                    attributes: sku.attributes.map((attribute, currentAttributeIndex) => (
                        currentAttributeIndex === attributeIndex ? { ...attribute, ...patch } : attribute
                    )),
                };
            }),
        }));
    }, []);

    const handleAddSkuAttribute = useCallback((skuIndex: number) => {
        setDraft((current) => ({
            ...current,
            skus: current.skus.map((sku, currentSkuIndex) => (
                currentSkuIndex === skuIndex
                    ? { ...sku, attributes: [...sku.attributes, { key: '', value: '' }] }
                    : sku
            )),
        }));
    }, []);

    const handleRemoveSkuAttribute = useCallback((skuIndex: number, attributeIndex: number) => {
        setDraft((current) => ({
            ...current,
            skus: current.skus.map((sku, currentSkuIndex) => (
                currentSkuIndex === skuIndex
                    ? { ...sku, attributes: sku.attributes.filter((_, index) => index !== attributeIndex) }
                    : sku
            )),
        }));
    }, []);

    const handleRemoveSku = useCallback((index: number) => {
        setDraft((current) => ({
            ...current,
            skus: current.skus.filter((_, skuIndex) => skuIndex !== index),
        }));
    }, []);

    const toggleBrandExpanded = useCallback((brandId: string) => {
        setExpandedBrandIds((current) => {
            const next = new Set(current);
            if (next.has(brandId)) {
                next.delete(brandId);
            } else {
                next.add(brandId);
            }
            return next;
        });
    }, []);

    const handleNamedAttributeChange = useCallback((key: string, value: string) => {
        setDraft((current) => {
            const nextAttributes = [...current.attributes];
            const existingIndex = nextAttributes.findIndex((item) => item.key === key);
            const nextValue = value.trim();
            if (!nextValue) {
                if (existingIndex >= 0) nextAttributes.splice(existingIndex, 1);
                return { ...current, attributes: nextAttributes };
            }
            if (existingIndex >= 0) {
                nextAttributes[existingIndex] = { ...nextAttributes[existingIndex], value };
            } else {
                nextAttributes.push({ key, value });
            }
            return { ...current, attributes: nextAttributes };
        });
    }, []);

    const handleImageInput = useCallback(async (files: FileList | null) => {
        const nextFiles = Array.from(files || []);
        if (!nextFiles.length) return;
        if (draft.images.length + nextFiles.length > 5) {
            void appAlert('资产最多只能保存 5 张图片');
            return;
        }
        const nextImages = await Promise.all(nextFiles.map(async (file) => ({
            name: file.name,
            previewUrl: await readFileAsDataUrl(file),
            dataUrl: await readFileAsDataUrl(file),
        })));
        setDraft((current) => ({
            ...current,
            images: [...current.images, ...nextImages],
        }));
    }, [draft.images.length]);

    const handleRemoveImage = useCallback((index: number) => {
        setDraft((current) => ({
            ...current,
            images: current.images.filter((_, itemIndex) => itemIndex !== index),
        }));
    }, []);

    const handleVideoFileInput = useCallback(async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        if (!/\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name) && !file.type.startsWith('video/')) {
            setError('角色视频仅支持常见视频文件');
            return;
        }
        if (file.size > 200 * 1024 * 1024) {
            setError('角色视频不能超过 200MB');
            return;
        }
        const dataUrl = await readFileAsDataUrl(file);
        setDraft((current) => ({
            ...current,
            video: {
                name: file.name,
                previewUrl: dataUrl,
                dataUrl,
            },
        }));
        setError('');
    }, []);

    const handleRemoveVideo = useCallback(() => {
        setDraft((current) => ({
            ...current,
            video: undefined,
        }));
    }, []);

    const buildSubjectPayload = useCallback((voicePayload?: Record<string, unknown>, videoPayload?: Record<string, unknown>) => ({
        ...subjectDraftPayload(draft, categories, voicePayload, videoPayload ?? subjectDraftVideoPayload(draft, categories, initialVideoPresent)),
    }), [categories, draft, initialVideoPresent]);

    const persistVoiceChange = useCallback(async (voicePayload: Record<string, unknown>, successHint: string) => {
        if (!draft.id) return false;
        const draftCategoryName = categories.find((item) => item.id === draft.categoryId)?.name.trim() || '';
        if (draftCategoryName !== '角色') return false;
        const payload = buildSubjectPayload(voicePayload);
        const result = await window.ipcRenderer.subjects.update(payload);
        if (!result?.success) {
            throw new Error(result?.error || '保存声音参考失败');
        }
        setInitialVoicePresent(Boolean(Object.keys(voicePayload).length));
        setRecordingHint(successHint);
        await loadData();
        return true;
    }, [buildSubjectPayload, categories, draft.categoryId, draft.id, loadData]);

    const handleRemoveVoice = useCallback(async () => {
        setDraft((current) => ({
            ...current,
            voice: undefined,
        }));
        setRecordingError('');
        setRecordingHint('');
        try {
            await persistVoiceChange({}, '声音参考已删除');
        } catch (e) {
            const message = e instanceof Error ? e.message : '删除声音参考失败';
            setRecordingError(message);
            void appAlert(message);
        }
    }, [persistVoiceChange]);

    const handleRetryVoiceClone = useCallback(async (subject: SubjectRecord) => {
        if (!subject.voicePath) {
            void appAlert('请先保存声音参考，再重试复刻');
            return;
        }
        setRetryingVoiceSubjectId(subject.id);
        setRecordingError('');
        setRecordingHint('正在提交音色复刻...');
        try {
            const targetTtsModel = selectedVoiceCloneTtsModel || DEFAULT_VOICE_TTS_MODEL;
            const cloneModel = cloneModelForTargetTtsModel(targetTtsModel);
            const routeOverride = resolveVoiceTtsModelOverride(voiceModelSettingsSnapshot, targetTtsModel);
            const result = await window.ipcRenderer.voice.clone({
                ownerAssetId: subject.id,
                samplePath: subject.voicePath,
                name: subject.name,
                model: cloneModel,
                ...routeOverride,
                cloneModel,
                targetTtsModel,
                target_tts_model: targetTtsModel,
                ttsModel: targetTtsModel,
                waitForCompletion: false,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '提交声音复刻失败');
            }
            setRecordingHint('音色复刻已提交');
            await loadData();
        } catch (e) {
            console.error('Failed to retry voice clone:', e);
            const message = e instanceof Error ? e.message : '提交声音复刻失败';
            setRecordingError(message);
            setRecordingHint('');
            void appAlert(message);
        } finally {
            setRetryingVoiceSubjectId(null);
        }
    }, [loadData, selectedVoiceCloneTtsModel, voiceModelSettingsSnapshot]);

    const saveVoiceDataUrl = useCallback(async (dataUrl: string, fileName: string) => {
        const duration = await getAudioDurationSeconds(dataUrl);
        if (duration <= SUBJECT_VOICE_MIN_RECORDING_SECONDS) {
            throw new Error(`声音参考时长必须大于 ${SUBJECT_VOICE_MIN_RECORDING_SECONDS} 秒`);
        }
        const nextVoice = {
            name: fileName,
            previewUrl: dataUrl,
            dataUrl,
            scriptText: SUBJECT_VOICE_SAMPLE_TEXT,
        };
        setDraft((current) => ({
            ...current,
            voice: nextVoice,
        }));
        setRecordingHint(`已录入声音参考，时长约 ${duration.toFixed(1)} 秒`);
        setRecordingError('');
        await persistVoiceChange({
            dataUrl,
            name: fileName,
            scriptText: SUBJECT_VOICE_SAMPLE_TEXT,
        }, `声音参考已保存，时长约 ${duration.toFixed(1)} 秒`);
    }, [persistVoiceChange]);

    const audioRecording = useAudioRecording({
        onCaptured: async (clip) => {
            const capturedSeconds = (clip.capturedDurationMs || 0) / 1000;
            if (capturedSeconds > 0 && capturedSeconds < SUBJECT_VOICE_MIN_RECORDING_SECONDS) {
                throw new Error(`实际录入音频只有 ${capturedSeconds.toFixed(1)} 秒，请重新录制至少 ${SUBJECT_VOICE_MIN_RECORDING_SECONDS} 秒`);
            }
            if ((clip.byteLength || 0) > 10 * 1024 * 1024) {
                throw new Error('声音参考文件不能超过 10MB');
            }
            await saveVoiceDataUrl(
                buildAudioDataUrl(clip),
                clip.fileName || `voice-reference-${Date.now()}.wav`,
            );
        },
    });
    const audioRecordingRef = useRef(audioRecording);
    useEffect(() => {
        audioRecordingRef.current = audioRecording;
    }, [audioRecording]);
    const voiceRecordingElapsedSeconds = audioRecording.isRecording
        ? recordingElapsedSeconds
        : 0;
    const canFinishVoiceRecording = voiceRecordingElapsedSeconds >= SUBJECT_VOICE_MIN_RECORDING_SECONDS;

    useEffect(() => {
        if (!audioRecording.error) return;
        setRecordingError(audioRecording.error);
        setRecordingHint('');
    }, [audioRecording.error]);

    useEffect(() => {
        if (audioRecording.isRecording) return;
        clearRecordingTimers();
        setRecordingElapsedSeconds(0);
    }, [audioRecording.isRecording, clearRecordingTimers]);

    const stopRecordingSession = useCallback(() => {
        clearRecordingTimers();
        setRecordingElapsedSeconds(0);
        const currentRecording = audioRecordingRef.current;
        if (currentRecording.isRecording || currentRecording.isWorking) {
            void currentRecording.cancelRecording();
        }
    }, [clearRecordingTimers]);

    const handleDraftCategoryChange = useCallback((categoryId: string) => {
        const nextCategoryName = categories.find((item) => item.id === categoryId)?.name.trim() || '';
        if (nextCategoryName !== '角色') {
            stopRecordingSession();
            setRecordingError('');
            setRecordingHint('');
        }
        setDraft((current) => ({
            ...current,
            categoryId,
            voice: nextCategoryName === '角色' ? current.voice : undefined,
            video: nextCategoryName === '角色' ? current.video : undefined,
            brandId: nextCategoryName === '商品' ? current.brandId : '',
            skus: nextCategoryName === '商品' ? current.skus : [],
        }));
    }, [categories, stopRecordingSession]);

    const closeModal = useCallback(() => {
        if (working) return;
        clearAssetModalAnimationHandles();
        stopRecordingSession();
        setIsDraftCategoryMenuOpen(false);
        setAssetModalPhase('closing');
        assetModalAnimationTimerRef.current = window.setTimeout(() => {
            setIsModalOpen(false);
            setIsAssetModalVisible(false);
            resetAssetModalDraft();
            assetModalAnimationTimerRef.current = null;
        }, ASSET_LIBRARY_MODAL_ANIMATION_MS);
    }, [clearAssetModalAnimationHandles, resetAssetModalDraft, stopRecordingSession, working]);

    useEffect(() => () => {
        clearAssetModalAnimationHandles();
        stopRecordingSession();
        if (autosaveTimerRef.current) {
            window.clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
        }
    }, [clearAssetModalAnimationHandles, stopRecordingSession]);

    const handleVoiceFileInput = useCallback(async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        if (!/\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(file.name)) {
            setRecordingError('声音参考仅支持常见音频文件');
            setRecordingHint('');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            setRecordingError('声音参考文件不能超过 10MB');
            return;
        }
        try {
            const dataUrl = await readFileAsDataUrl(file);
            await saveVoiceDataUrl(dataUrl, file.name);
        } catch (e) {
            setRecordingError(e instanceof Error ? e.message : '导入声音参考失败');
            setRecordingHint('');
        }
    }, [saveVoiceDataUrl]);

    const handleRecordVoice = useCallback(async () => {
        if (audioRecording.isRecording || audioRecording.isWorking) return;
        setRecordingElapsedSeconds(0);
        setRecordingError('');
        setRecordingHint('正在准备录音，请按正常语速清晰朗读示例句。');
        const started = await audioRecording.startRecording();
        if (!started) {
            setRecordingElapsedSeconds(0);
            setRecordingHint('');
            return;
        }
        setRecordingHint(`正在采样，达到 ${SUBJECT_VOICE_MIN_RECORDING_SECONDS} 秒后可手动完成。`);
        try {
            recordingIntervalRef.current = window.setInterval(() => {
                setRecordingElapsedSeconds((current) => current + 1);
            }, 1000);
        } catch (e) {
            stopRecordingSession();
            setRecordingError(e instanceof Error ? e.message : '无法启动录音');
            setRecordingHint('');
        }
    }, [audioRecording, clearRecordingTimers, stopRecordingSession]);

    const handleFinishVoiceRecording = useCallback(async () => {
        if (!audioRecording.isRecording || audioRecording.isWorking) return;
        if (recordingElapsedSeconds < SUBJECT_VOICE_MIN_RECORDING_SECONDS) {
            setRecordingHint(`至少需要 ${SUBJECT_VOICE_MIN_RECORDING_SECONDS} 秒，再点击完成采样。`);
            return;
        }
        clearRecordingTimers();
        await audioRecording.stopRecording();
    }, [audioRecording, clearRecordingTimers, recordingElapsedSeconds]);

    const submitCategoryDialog = useCallback(async () => {
        const trimmedName = categoryDialogName.trim();
        if (!trimmedName) {
            void appAlert('分类名称不能为空');
            return;
        }

        setIsCategoryDialogSubmitting(true);
        try {
            if (categoryDialogMode === 'create') {
                const result = await window.ipcRenderer.subjects.categories.create({ name: trimmedName });
                if (!result?.success) {
                    void appAlert(result?.error || '创建分类失败');
                    return;
                }
                resetCategoryDialog();
                await loadData();
                if (result.category?.id) {
                    setCategoryFilter(result.category.id);
                    setDraft((current) => ({ ...current, categoryId: result.category?.id || '' }));
                }
                return;
            }

            if (!categoryDialogTargetId) {
                void appAlert('未找到要重命名的分类');
                return;
            }

            const currentCategory = categories.find((item) => item.id === categoryDialogTargetId);
            if (currentCategory && trimmedName === currentCategory.name) {
                resetCategoryDialog();
                return;
            }

            const result = await window.ipcRenderer.subjects.categories.update({ id: categoryDialogTargetId, name: trimmedName });
            if (!result?.success) {
                void appAlert(result?.error || '重命名分类失败');
                return;
            }
            resetCategoryDialog();
            await loadData();
        } catch (e) {
            console.error('Failed to submit category dialog:', e);
            void appAlert(categoryDialogMode === 'create' ? '创建分类失败，请重试' : '重命名分类失败，请重试');
        } finally {
            setIsCategoryDialogSubmitting(false);
        }
    }, [categories, categoryDialogMode, categoryDialogName, categoryDialogTargetId, loadData, resetCategoryDialog]);

    const handleDeleteCategory = useCallback(async (category: SubjectCategory) => {
        if (!(await appConfirm(`删除分类“${category.name}”？如果仍有资产使用该分类，将会被拒绝。`, { title: '删除分类', confirmLabel: '删除', tone: 'danger' }))) return;
        const result = await window.ipcRenderer.subjects.categories.delete({ id: category.id });
        if (!result?.success) {
            void appAlert(result?.error || '删除分类失败');
            return;
        }
        if (categoryFilter === category.id) {
            setCategoryFilter('all');
        }
        if (draft.categoryId === category.id) {
            setDraft((current) => ({ ...current, categoryId: '' }));
        }
        await loadData();
    }, [categoryFilter, draft.categoryId, loadData]);

    const mergeSavedSubject = useCallback((savedSubject: SubjectRecord, syncDraftMedia = false) => {
        setSubjects((current) => current.map((subject) => (
            subject.id === savedSubject.id ? savedSubject : subject
        )));
        if (!syncDraftMedia) return;
        setDraft((current) => {
            if (current.id !== savedSubject.id) return current;
            const nextDraft = toDraft(savedSubject);
            autosaveLastPayloadRef.current = subjectDraftPayloadSnapshot(
                nextDraft,
                categories,
                Boolean(savedSubject.voicePreviewUrl),
                Boolean(savedSubject.videoPreviewUrl),
            );
            return nextDraft;
        });
        setInitialVoicePresent(Boolean(savedSubject.voicePreviewUrl));
        setInitialVideoPresent(Boolean(savedSubject.videoPreviewUrl));
    }, [categories]);

    const persistDraft = useCallback(async (): Promise<SubjectRecord> => {
        if (!draft.name.trim()) {
            throw new Error('资产名称是必填项');
        }
        autosaveVersionRef.current += 1;
        if (autosaveTimerRef.current) {
            window.clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
        }
        const nextVoicePayload = subjectDraftVoicePayload(draft, categories, initialVoicePresent);
        const nextVideoPayload = subjectDraftVideoPayload(draft, categories, initialVideoPresent);
        const payload = buildSubjectPayload(nextVoicePayload, nextVideoPayload);
        const result = draft.id
            ? await window.ipcRenderer.subjects.update(payload)
            : await window.ipcRenderer.subjects.create(payload);
        if (!result?.success || !result.subject) {
            throw new Error(result?.error || '保存资产失败');
        }
        return result.subject as SubjectRecord;
    }, [buildSubjectPayload, categories, draft.categoryId, draft.id, draft.name, draft.video, draft.voice, initialVideoPresent, initialVoicePresent]);

    useEffect(() => {
        if (!isModalOpen || !draft.id) return;
        const snapshot = subjectDraftPayloadSnapshot(draft, categories, initialVoicePresent, initialVideoPresent);
        if (!autosaveLastPayloadRef.current) {
            autosaveLastPayloadRef.current = snapshot;
            return;
        }
        if (snapshot === autosaveLastPayloadRef.current) return;
        if (!draft.name.trim()) return;

        autosaveVersionRef.current += 1;
        const version = autosaveVersionRef.current;
        const payload = subjectDraftPayload(
            draft,
            categories,
            subjectDraftVoicePayload(draft, categories, initialVoicePresent),
            subjectDraftVideoPayload(draft, categories, initialVideoPresent),
        );
        const syncDraftMedia = draft.images.some((image) => image.dataUrl) || Boolean(draft.voice?.dataUrl) || Boolean(draft.video?.dataUrl);
        const runAutosave = async () => {
            if (version !== autosaveVersionRef.current) return;
            if (autosaveSavingRef.current) {
                autosaveTimerRef.current = window.setTimeout(runAutosave, SUBJECT_AUTOSAVE_DELAY_MS);
                return;
            }
            autosaveSavingRef.current = true;
            try {
                const result = await window.ipcRenderer.subjects.update(payload);
                if (version !== autosaveVersionRef.current) return;
                if (!result?.success || !result.subject) {
                    throw new Error(result?.error || '自动保存失败');
                }
                autosaveLastPayloadRef.current = snapshot;
                mergeSavedSubject(result.subject as SubjectRecord, syncDraftMedia);
                setError('');
            } catch (e) {
                if (version === autosaveVersionRef.current) {
                    console.error('Failed to autosave subject:', e);
                    setError(e instanceof Error ? e.message : '自动保存失败');
                }
            } finally {
                autosaveSavingRef.current = false;
            }
        };

        if (autosaveTimerRef.current) {
            window.clearTimeout(autosaveTimerRef.current);
        }
        autosaveTimerRef.current = window.setTimeout(runAutosave, SUBJECT_AUTOSAVE_DELAY_MS);
        return () => {
            if (autosaveTimerRef.current) {
                window.clearTimeout(autosaveTimerRef.current);
                autosaveTimerRef.current = null;
            }
        };
    }, [categories, draft, initialVideoPresent, initialVoicePresent, isModalOpen, mergeSavedSubject]);

    const handleSave = useCallback(async () => {
        setWorking(true);
        setError('');
        try {
            await persistDraft();
            await loadData();
            closeModal();
        } catch (e) {
            console.error('Failed to save subject:', e);
            setError(e instanceof Error ? e.message : '保存资产失败');
        } finally {
            setWorking(false);
        }
    }, [closeModal, loadData, persistDraft]);

    const handleGenerateCharacterCard = useCallback(async () => {
        setWorking(true);
        setError('');
        try {
            const savedSubject = await persistDraft();
            if (!(savedSubject.previewUrls || []).length && !(savedSubject.absoluteImagePaths || []).length) {
                throw new Error('请先添加角色图片');
            }
            setGeneratingCardSubjectId(savedSubject.id);
            const result = await window.ipcRenderer.subjects.generateCharacterCard({ id: savedSubject.id });
            if (!result?.success || !result.subject) {
                throw new Error(result?.error || '生成角色卡失败');
            }
            setDraft(toDraft(result.subject as SubjectRecord));
            setInitialVoicePresent(Boolean((result.subject as SubjectRecord).voicePreviewUrl));
            await loadData();
        } catch (e) {
            console.error('Failed to generate character card:', e);
            setError(e instanceof Error ? e.message : '生成角色卡失败');
        } finally {
            setGeneratingCardSubjectId(null);
            setWorking(false);
        }
    }, [loadData, persistDraft]);

    const handleDeleteSubject = useCallback(async () => {
        if (!draft.id) return;
        if (!(await appConfirm(`删除资产“${draft.name || draft.id}”？`, { title: '删除资产', confirmLabel: '删除', tone: 'danger' }))) return;
        setWorking(true);
        try {
            const result = await window.ipcRenderer.subjects.delete({ id: draft.id });
            if (!result?.success) {
                throw new Error(result?.error || '删除资产失败');
            }
            await loadData();
            closeModal();
        } catch (e) {
            console.error('Failed to delete subject:', e);
            setError(e instanceof Error ? e.message : '删除资产失败');
        } finally {
            setWorking(false);
        }
    }, [closeModal, draft.id, draft.name, loadData]);

    const openMediaContextMenu = useCallback((event: React.MouseEvent, asset: MediaAsset) => {
        event.preventDefault();
        event.stopPropagation();
        setMediaContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            asset,
        });
    }, []);

    const handleShowMediaInFolder = useCallback(async (asset: MediaAsset) => {
        const source = asset.absolutePath || asset.relativePath || asset.previewUrl || '';
        if (!source) {
            void appAlert('媒体没有可打开的文件路径');
            return;
        }
        try {
            const result = await window.ipcRenderer.files.showInFolder({ source }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '打开文件夹失败');
            }
        } catch (e) {
            console.error('Failed to show media in folder:', e);
            void appAlert('打开文件夹失败');
        }
    }, []);

    const handleDeleteMediaAsset = useCallback(async (asset: MediaAsset) => {
        const label = asset.title || asset.id;
        if (!(await appConfirm(`删除媒体“${label}”？`, { title: '删除媒体', confirmLabel: '删除', tone: 'danger' }))) return;
        try {
            const result = await window.ipcRenderer.invoke('media:delete', { assetId: asset.id }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '删除失败');
                return;
            }
            setMediaAssets((current) => current.filter((item) => item.id !== asset.id));
            await loadData();
        } catch (e) {
            console.error('Failed to delete media asset:', e);
            void appAlert('删除失败');
        }
    }, [loadData]);

    const categoryTabs = useMemo<SubjectCategoryTab[]>(() => {
        const customCategories = categories.filter((category) => {
            const name = category.name.trim();
            return !DEFAULT_SUBJECT_CATEGORY_NAMES.includes(name) && !HIDDEN_SUBJECT_CATEGORY_NAMES.has(name);
        });
        return [
            ...VISIBLE_SUBJECT_CATEGORY_NAMES.map((name) => {
                const category = categories.find((item) => item.name.trim() === name);
                return {
                    id: category?.id || `preset:${name}`,
                    label: name,
                    icon: categoryIconForName(name),
                    disabled: !category?.id,
                };
            }),
            ...customCategories.map((category) => ({
                id: category.id,
                label: category.name,
                icon: categoryIconForName(category.name),
            })),
        ];
    }, [categories]);
    const activeCategoryTab = categoryTabs.find((item) => item.id === categoryFilter) || categoryTabs[0];
    const createAssetButtonLabel = `创建${activeCategoryTab?.label || '资产'}`;

    const draftCategoryName = categoryNameMap.get(draft.categoryId || '') || '';
    const draftEntityLabel = draftCategoryName || '资产';
    const isRoleDraft = draftCategoryName.trim() === '角色';
    const isBrandDraft = draftCategoryName.trim() === '品牌';
    const isProductDraft = draftCategoryName.trim() === '商品';
    const selectedBrandName = subjectNameMap.get(draft.brandId) || '';
    const draftPreviewImage = draft.images[0]?.previewUrl || '';
    const draftAttributeValue = (key: string) => draft.attributes.find((item) => item.key === key)?.value || '';
    const visibleDraftAttributes = draft.attributes
        .map((attribute, index) => ({ attribute, index }))
        .filter(({ attribute }) => !isRoleDraft || (attribute.key !== '性别' && attribute.key !== '年龄'));
    const draftCategoryOptions = useMemo(() => [
        { id: '', name: '未分类', icon: Tag },
        ...categories
            .filter((category) => (
                !['品牌', '商品'].includes(category.name.trim()) || category.id === draft.categoryId
            ))
            .map((category) => ({
            id: category.id,
            name: category.name,
            icon: categoryIconForName(category.name),
        })),
    ], [categories, draft.categoryId]);
    const selectedDraftCategory = draftCategoryOptions.find((item) => item.id === draft.categoryId) || draftCategoryOptions[0];
    const SelectedDraftCategoryIcon = selectedDraftCategory.icon;
    const activeLibraryTab = isModalVariant ? libraryTab : 'assets';
    const showAssetControls = activeLibraryTab === 'assets';

    if (productDetailContext && activeDetailBrandBundle && activeDetailProductBundle) {
        const productCover = activeDetailProductBundle.assets.find((asset) => asset.role === 'image');
        const detailPages = activeDetailPages;
        const hasPlatforms = enabledEcommercePlatforms.length > 0;
        return (
            <div className="flex h-full min-h-0 flex-col bg-white">
                <div className={clsx('border-b border-[rgb(var(--color-border))]', isModalVariant ? 'px-5 py-4' : 'px-8 py-5')}>
                    <div className="flex min-w-0 items-center gap-3">
                        <button
                            type="button"
                            onClick={closeProductDetailPage}
                            disabled={isDetailPageSubmitting}
                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[rgb(var(--color-border))] bg-white text-[rgb(var(--color-text-primary))] shadow-sm transition hover:bg-[rgb(var(--color-surface-primary))] disabled:opacity-50"
                            aria-label="返回资产库"
                            title="返回"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-[rgb(var(--color-surface-secondary))]">
                            {productCover ? (
                                <img src={resolveAssetUrl(productCover.path)} alt={activeDetailProductBundle.product.name} className="h-full w-full object-cover" />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center text-[rgb(var(--color-text-tertiary))]">
                                    <Package className="h-5 w-5" />
                                </div>
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                                {activeDetailBrandBundle.brand.name}
                            </div>
                            <h2 className="mt-1 truncate text-xl font-semibold leading-none text-[rgb(var(--color-text-primary))]">
                                {activeDetailProductBundle.product.name}
                            </h2>
                        </div>
                        <button
                            type="button"
                            onClick={() => void handleSaveDetailPage()}
                            disabled={isDetailPageSubmitting || !hasPlatforms}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-black px-3 text-sm font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Save className="h-4 w-4" />
                            {isDetailPageSubmitting ? '保存中' : '保存'}
                        </button>
                    </div>
                </div>

                <div className="flex min-h-0 flex-1">
                    <aside className={clsx('hidden min-h-0 w-[250px] shrink-0 border-r border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] p-4 lg:block', isModalVariant && 'w-[220px]')}>
                        <div className="mb-3 text-xs font-semibold text-[rgb(var(--color-text-secondary))]">电商平台</div>
                        {hasPlatforms ? (
                            <div className="space-y-1">
                                {enabledEcommercePlatforms.map((platform) => {
                                    const active = activeDetailPlatform?.id === platform.id;
                                    const iconPath = ecommercePlatformIconPath(platform.id);
                                    return (
                                        <button
                                            key={platform.id}
                                            type="button"
                                            onClick={() => {
                                                setSelectedDetailPlatformId(platform.id);
                                                setSelectedDetailVersionKey('__default__');
                                            }}
                                            className={clsx(
                                                'flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-semibold transition',
                                                active
                                                    ? 'bg-white text-[rgb(var(--color-text-primary))] shadow-sm'
                                                    : 'text-[rgb(var(--color-text-secondary))] hover:bg-white hover:text-[rgb(var(--color-text-primary))]'
                                            )}
                                        >
                                            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white">
                                                {iconPath ? (
                                                    <img src={iconPath} alt="" className="h-4 w-4 object-contain" />
                                                ) : (
                                                    <Box className="h-3.5 w-3.5" />
                                                )}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate">{platform.name}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="rounded-lg border border-dashed border-[rgb(var(--color-border))] bg-white px-3 py-3 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                                先在设置里开启电商平台。
                            </div>
                        )}
                    </aside>

                    <main className="min-w-0 flex-1 overflow-auto">
                        <div className={clsx('mx-auto w-full max-w-[1180px] space-y-5 py-5', isModalVariant ? 'px-5' : 'px-8')}>
                            <div className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
                                {enabledEcommercePlatforms.map((platform) => {
                                    const active = activeDetailPlatform?.id === platform.id;
                                    const iconPath = ecommercePlatformIconPath(platform.id);
                                    return (
                                        <button
                                            key={platform.id}
                                            type="button"
                                            onClick={() => {
                                                setSelectedDetailPlatformId(platform.id);
                                                setSelectedDetailVersionKey('__default__');
                                            }}
                                            className={clsx(
                                                'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition',
                                                active ? 'bg-black text-white' : 'bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-primary))]'
                                            )}
                                        >
                                            {iconPath && <img src={iconPath} alt="" className="h-4 w-4 rounded-sm object-contain" />}
                                            {platform.name}
                                        </button>
                                    );
                                })}
                            </div>

                            {error && (
                                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                    {error}
                                </div>
                            )}

                            {hasPlatforms && activeDetailPlatform ? (
                                <>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {detailPages.length === 0 && (
                                            <button
                                                type="button"
                                                className="inline-flex h-8 items-center rounded-lg bg-black px-3 text-xs font-semibold text-white"
                                            >
                                                默认版本
                                            </button>
                                        )}
                                        {detailPages.map((page) => {
                                            const active = activeDetailPage?.id === page.id;
                                            return (
                                                <button
                                                    key={page.id}
                                                    type="button"
                                                    onClick={() => handleSelectDetailVersion(page)}
                                                    className={clsx(
                                                        'inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold transition',
                                                        active
                                                            ? 'bg-black text-white'
                                                            : 'bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-primary))] hover:bg-[rgb(var(--color-surface-tertiary))]'
                                                    )}
                                                >
                                                    {detailVersionLabel(page)}
                                                </button>
                                            );
                                        })}
                                        <button
                                            type="button"
                                            onClick={handleCreateDetailVersion}
                                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-[rgb(var(--color-border))] px-2.5 text-xs font-semibold text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            版本
                                        </button>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                                        <label className="block">
                                            <div className="mb-1.5 text-xs font-semibold text-[rgb(var(--color-text-secondary))]">标题</div>
                                            <input
                                                value={detailVersionDraft.title}
                                                onChange={(event) => setDetailVersionDraft((current) => ({ ...current, title: event.target.value }))}
                                                placeholder={`${activeDetailPlatform.name} 商品详情`}
                                                className="h-10 w-full rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                            />
                                        </label>
                                        <label className="block">
                                            <div className="mb-1.5 text-xs font-semibold text-[rgb(var(--color-text-secondary))]">国家 / 市场</div>
                                            <input
                                                value={detailVersionDraft.market}
                                                onChange={(event) => setDetailVersionDraft((current) => ({ ...current, market: event.target.value }))}
                                                placeholder="例如 US、JP、泰国；国内平台可留空"
                                                className="h-10 w-full rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                            />
                                        </label>
                                        <label className="block">
                                            <div className="mb-1.5 text-xs font-semibold text-[rgb(var(--color-text-secondary))]">语言</div>
                                            <input
                                                value={detailVersionDraft.locale}
                                                onChange={(event) => setDetailVersionDraft((current) => ({ ...current, locale: event.target.value }))}
                                                placeholder="例如 en-US、ja-JP、th-TH"
                                                className="h-10 w-full rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                            />
                                        </label>
                                    </div>

                                    <section className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">商品详情图</div>
                                            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-[rgb(var(--color-surface-secondary))] px-3 text-xs font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))]">
                                                <Plus className="h-3.5 w-3.5" />
                                                添加图片
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    multiple
                                                    className="hidden"
                                                    onChange={(event) => {
                                                        void handleDetailImageInput(event.target.files);
                                                        event.currentTarget.value = '';
                                                    }}
                                                />
                                            </label>
                                        </div>

                                        {detailImageDrafts.length === 0 ? (
                                            <label className="flex min-h-[360px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] text-center text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))]">
                                                <ImagePlus className="mb-3 h-10 w-10 stroke-[1.6]" />
                                                <div className="text-sm font-semibold">上传商品详情图</div>
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    multiple
                                                    className="hidden"
                                                    onChange={(event) => {
                                                        void handleDetailImageInput(event.target.files);
                                                        event.currentTarget.value = '';
                                                    }}
                                                />
                                            </label>
                                        ) : (
                                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                                {detailImageDrafts.map((image, index) => (
                                                    <div key={`${image.path || image.name}-${index}`} className="group relative overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))] shadow-sm">
                                                        <img
                                                            src={resolveAssetUrl(image.previewUrl)}
                                                            alt={image.name}
                                                            className="block h-auto w-full object-contain"
                                                        />
                                                        <div className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-semibold text-white">
                                                            {index + 1}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveDetailImage(index)}
                                                            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                            aria-label="删除详情图"
                                                        >
                                                            <X className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                ))}
                                                <label className="flex min-h-[220px] cursor-pointer items-center justify-center rounded-lg border border-dashed border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] text-[rgb(var(--color-text-tertiary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]">
                                                    <Plus className="h-6 w-6" />
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        multiple
                                                        className="hidden"
                                                        onChange={(event) => {
                                                            void handleDetailImageInput(event.target.files);
                                                            event.currentTarget.value = '';
                                                        }}
                                                    />
                                                </label>
                                            </div>
                                        )}
                                    </section>
                                </>
                            ) : (
                                <div className="flex min-h-[54vh] flex-col items-center justify-center text-center text-[rgb(var(--color-text-secondary))]">
                                    <Box className="mb-4 h-12 w-12 stroke-[1.8]" />
                                    <div className="text-sm font-semibold">没有启用的电商平台</div>
                                </div>
                            )}
                        </div>
                    </main>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-white">
            <div className={clsx(isModalVariant ? 'px-5 pt-4 pb-3' : 'px-8 pt-6 pb-4')}>
                <div className="flex items-center gap-3">
                    {!isModalVariant && onReturnHome && (
                        <button
                            type="button"
                            onClick={onReturnHome}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[rgb(var(--color-border))] bg-white text-[rgb(var(--color-text-primary))] shadow-sm transition hover:bg-[rgb(var(--color-surface-primary))] hover:text-[rgb(var(--color-text-primary))]"
                            aria-label="返回主页"
                            title="返回主页"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                    )}
                    <h1 className={clsx('leading-none font-semibold tracking-[0.01em] text-[rgb(var(--color-text-primary))]', isModalVariant ? 'text-[20px]' : 'text-[26px]')}>资产库</h1>
                    <div className="ml-auto flex items-center gap-3">
                        <button
                            onClick={() => void loadData()}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]"
                        >
                            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
                            刷新
                        </button>
                        {!isBrandCategoryView && (
                        <div className="inline-flex rounded-xl bg-[rgb(var(--color-surface-secondary))] p-1">
                            <button
                                type="button"
                                onClick={() => setViewMode('grid')}
                                className={clsx(
                                    'inline-flex h-8 w-8 items-center justify-center rounded-lg transition',
                                    viewMode === 'grid' ? 'bg-white text-[rgb(var(--color-text-primary))] shadow-sm' : 'text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text-primary))]'
                                )}
                                aria-label="网格视图"
                                title="网格视图"
                            >
                                <Grid2X2 className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setViewMode('list')}
                                className={clsx(
                                    'inline-flex h-8 w-8 items-center justify-center rounded-lg transition',
                                    viewMode === 'list' ? 'bg-white text-[rgb(var(--color-text-primary))] shadow-sm' : 'text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text-primary))]'
                                )}
                                aria-label="列表视图"
                                title="列表视图"
                            >
                                <List className="h-4 w-4" />
                            </button>
                        </div>
                        )}
                        {!showAssetControls && (
                            <button
                                type="button"
                                onClick={() => setFilterOpen((value) => !value)}
                                className={clsx(
                                    'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-[rgb(var(--color-text-primary))] transition',
                                    filterOpen || query ? 'bg-[rgb(var(--color-surface-tertiary))]' : 'bg-[rgb(var(--color-surface-secondary))] hover:bg-[rgb(var(--color-surface-tertiary))]'
                                )}
                            >
                                <SlidersHorizontal className="h-4 w-4" />
                                筛选
                            </button>
                        )}
                        {isModalVariant && onClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                                aria-label="关闭资产库"
                                title="关闭"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {isModalVariant && (
                <div className="mx-5 flex items-center gap-1 border-b border-[rgb(var(--color-border))] pb-2">
                    {([
                        { id: 'assets' as const, label: '资产', icon: Package, count: subjects.length },
                        { id: 'media' as const, label: '媒体', icon: Clapperboard, count: mediaAssets.length },
                    ]).map((item) => {
                        const Icon = item.icon;
                        const active = activeLibraryTab === item.id;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => setLibraryTab(item.id)}
                                className={clsx(
                                    'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition',
                                    active ? 'bg-[rgb(var(--color-text-primary))] text-white' : 'text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]'
                                )}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {item.label}
                                <span className={clsx('text-[10px]', active ? 'text-white/70' : 'text-[rgb(var(--color-text-tertiary))]')}>{item.count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {showAssetControls && (
            <div className={clsx('flex min-h-[48px] items-end border-b border-[rgb(var(--color-border))]', isModalVariant ? 'mx-5' : 'mx-8')}>
                <div className="flex min-w-0 flex-1 items-end gap-6 overflow-x-auto no-scrollbar">
                    {categoryTabs.map((item) => {
                        const active = categoryFilter === item.id;
                        const Icon = item.icon;
                        return (
                            <button
                                key={item.id}
                                onClick={() => {
                                    if (!item.disabled) setCategoryFilter(item.id);
                                }}
                                disabled={item.disabled}
                                className={clsx(
                                    'inline-flex h-10 items-center gap-2 border-b-2 px-0 pb-3 text-sm font-semibold transition-colors',
                                    active
                                        ? 'border-black text-[rgb(var(--color-text-primary))]'
                                        : 'border-transparent text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text-primary))]',
                                    item.disabled && 'cursor-wait opacity-50'
                                )}
                            >
                                <Icon className="h-4 w-4" />
                                {item.label}
                            </button>
                        );
                    })}
                    <button
                        onClick={openCreateCategoryDialog}
                        className="mb-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                        aria-label="新建分类"
                        title="新建分类"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
                <div className="mb-3 ml-auto flex shrink-0 items-center gap-4">
                    <div className="hidden items-center gap-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] md:inline-flex">
                        <CalendarClock className="h-4 w-4" />
                        按时间倒序展示
                    </div>
                    <div className="h-4 w-px bg-[rgb(var(--color-surface-tertiary))]" />
                    <button
                        type="button"
                        onClick={openCreateModal}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-black px-3 text-sm font-semibold text-white transition hover:bg-black/88"
                    >
                        <Plus className="h-4 w-4" />
                        {createAssetButtonLabel}
                    </button>
                </div>
            </div>
            )}

            {filterOpen && (
                <div className={clsx('border-b border-[rgb(var(--color-border))] py-3', isModalVariant ? 'mx-5' : 'mx-8')}>
                    <div className="relative max-w-[420px]">
                        <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))]" />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={activeLibraryTab === 'media' ? '搜索媒体标题、项目、稿件、路径' : '搜索名称、标签、属性、描述'}
                            className="h-9 w-full rounded-lg border border-[rgb(var(--color-border))] bg-white pl-10 pr-3 text-sm text-[rgb(var(--color-text-primary))] outline-none transition focus:border-[rgb(var(--color-border))]"
                        />
                    </div>
                </div>
            )}

            <div className={clsx('min-h-0 flex-1 overflow-auto py-5', isModalVariant ? 'px-5' : 'px-8')}>
                {error && !isModalOpen && (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {error}
                    </div>
                )}

                {activeLibraryTab === 'media' ? (
                    loading && mediaAssets.length === 0 ? (
                        <div className="text-sm text-[rgb(var(--color-text-secondary))]">媒体加载中...</div>
                    ) : filteredMediaAssets.length === 0 ? (
                        <div className={clsx('flex flex-col items-center justify-center text-center text-[rgb(var(--color-text-secondary))]', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                            <Clapperboard className="mb-4 h-12 w-12 stroke-[1.8]" />
                            <div className="text-sm font-medium">暂无媒体</div>
                        </div>
                    ) : viewMode === 'grid' ? (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {filteredMediaAssets.map((asset) => {
                                const sourceUrl = mediaAssetSourceUrl(asset);
                                const previewUrl = resolveAssetUrl(asset.thumbnailUrl || sourceUrl);
                                const source = normalizeMediaSource(asset.source);
                                return (
                                    <div
                                        key={asset.id}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => void window.ipcRenderer.invoke('media:open', { assetId: asset.id })}
                                        onContextMenu={(event) => openMediaContextMenu(event, asset)}
                                        onKeyDown={(event) => {
                                            if (event.key !== 'Enter' && event.key !== ' ') return;
                                            event.preventDefault();
                                            void window.ipcRenderer.invoke('media:open', { assetId: asset.id });
                                        }}
                                        className="overflow-hidden rounded-lg border border-border bg-surface-primary text-left shadow-sm transition hover:shadow-md"
                                    >
                                        <div className="aspect-video overflow-hidden bg-surface-secondary/50">
                                            {previewUrl && asset.exists ? (
                                                isAudioAsset(asset) ? (
                                                    <AudioMediaThumb src={sourceUrl} />
                                                ) : isVideoAsset(asset) ? (
                                                    <VideoMediaThumb
                                                        sourceUrl={sourceUrl}
                                                        thumbnailUrl={asset.thumbnailUrl}
                                                        label={asset.title || asset.id}
                                                    />
                                                ) : (
                                                    <img src={previewUrl} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                )
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                                                    <Clapperboard className="h-6 w-6" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-1.5 p-2.5">
                                            <div className="truncate text-xs font-semibold text-text-primary">{asset.title || asset.id}</div>
                                            <div className="truncate text-[11px] text-text-tertiary">
                                                {asset.projectId || '未设置项目ID'}
                                            </div>
                                            <div className="flex items-center justify-between gap-2 text-[10px] text-text-tertiary">
                                                <span>{MEDIA_SOURCE_LABEL[source]}</span>
                                                <span>{mediaAssetKindLabel(asset)}</span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="divide-y divide-[rgb(var(--color-border))] rounded-xl border border-[rgb(var(--color-border))] bg-white">
                            {filteredMediaAssets.map((asset) => {
                                const sourceUrl = mediaAssetSourceUrl(asset);
                                const previewUrl = resolveAssetUrl(asset.thumbnailUrl || sourceUrl);
                                const source = normalizeMediaSource(asset.source);
                                return (
                                    <button
                                        key={asset.id}
                                        type="button"
                                        onClick={() => void window.ipcRenderer.invoke('media:open', { assetId: asset.id })}
                                        onContextMenu={(event) => openMediaContextMenu(event, asset)}
                                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[rgb(var(--color-surface-primary))]"
                                    >
                                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))]">
                                            {previewUrl && asset.exists ? (
                                                isAudioAsset(asset) ? (
                                                    <AudioMediaThumb src={sourceUrl} compact />
                                                ) : isVideoAsset(asset) ? (
                                                    <VideoMediaThumb
                                                        sourceUrl={sourceUrl}
                                                        thumbnailUrl={asset.thumbnailUrl}
                                                        label={asset.title || asset.id}
                                                    />
                                                ) : (
                                                    <img src={previewUrl} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                )
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center text-[rgb(var(--color-text-tertiary))]">
                                                    <Clapperboard className="h-5 w-5" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-xs font-semibold text-[rgb(var(--color-text-primary))]">{asset.title || asset.id}</div>
                                            <div className="mt-0.5 truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                                                {MEDIA_SOURCE_LABEL[source]} · {asset.projectId || '未设置项目ID'}
                                                {asset.boundManuscriptPath ? ` · ${asset.boundManuscriptPath}` : ''}
                                            </div>
                                        </div>
                                        <div className="hidden text-xs text-[rgb(var(--color-text-tertiary))] md:block">
                                            {formatAssetDate(asset.updatedAt || asset.createdAt)}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )
                ) : loading && subjects.length === 0 && categories.length === 0 ? (
                    <div className="text-sm text-[rgb(var(--color-text-secondary))]">资产库加载中...</div>
                ) : isBrandCategoryView ? (
                    filteredBrandSubjects.length === 0 ? (
                        <div className={clsx('flex flex-col items-center justify-center text-center text-[rgb(var(--color-text-secondary))]', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                            {brandWorkspaceError ? (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                                    {brandWorkspaceError}
                                </div>
                            ) : (
                                <>
                                    <Building2 className="mb-4 h-12 w-12 stroke-[1.8]" />
                                    <div className="text-sm font-medium">暂无品牌</div>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {brandWorkspaceError && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                                    {brandWorkspaceError}
                                </div>
                            )}
                            <div className="divide-y divide-[rgb(var(--color-border))] rounded-xl border border-[rgb(var(--color-border))] bg-white">
                            {filteredBrandSubjects.map((bundle) => {
                                const { brand, assets, products } = bundle;
                                const expanded = expandedBrandIds.has(brand.id);
                                const brandImage = assets.find((asset) => asset.role === 'image');
                                return (
                                    <div key={brand.id} className="bg-white">
                                        <div className="flex items-center gap-3 px-3 py-2.5">
                                            <button
                                                type="button"
                                                onClick={() => toggleBrandExpanded(brand.id)}
                                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                                                aria-label={expanded ? '收起品牌商品' : '展开品牌商品'}
                                                title={expanded ? '收起' : '展开'}
                                            >
                                                <ChevronDown className={clsx('h-4 w-4 transition-transform', !expanded && '-rotate-90')} />
                                            </button>
                                            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))]">
                                                {brandImage ? (
                                                    <img src={resolveAssetUrl(brandImage.path)} alt={brand.name} className="h-full w-full object-cover" />
                                                ) : (
                                                    <div className="flex h-full w-full items-center justify-center text-[rgb(var(--color-text-tertiary))]">
                                                        <Building2 className="h-5 w-5" />
                                                    </div>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => toggleBrandExpanded(brand.id)}
                                                className="min-w-0 flex-1 text-left"
                                            >
                                                <div className="truncate text-sm font-semibold text-[rgb(var(--color-text-primary))]">{brand.name}</div>
                                                <div className="mt-0.5 truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                                                    {products.length} 个商品
                                                    {brand.description ? ` · ${brand.description}` : ''}
                                                </div>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => openEditBrandModal(brand, assets)}
                                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                                                aria-label="编辑品牌"
                                                title="编辑品牌"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => openCreateProductModal(brand)}
                                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-black px-3 text-xs font-semibold text-white transition hover:bg-black/85"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                商品
                                            </button>
                                        </div>
                                        {expanded && (
                                            <div className="border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] px-3 py-2">
                                                {products.length === 0 ? (
                                                    <div className="rounded-lg border border-dashed border-[rgb(var(--color-border))] bg-white px-3 py-3 text-xs text-[rgb(var(--color-text-secondary))]">
                                                        还没有商品
                                                    </div>
                                                ) : (
                                                    <div className="space-y-1.5">
                                                        {products.map((productBundle) => {
                                                            const { product, skus, assets } = productBundle;
                                                            const productImage = assets.find((asset) => asset.role === 'image');
                                                            const detailThumbnails = productDetailThumbnailsByProductId.get(product.id) || [];
                                                            return (
                                                            <div
                                                                key={product.id}
                                                                role="button"
                                                                tabIndex={0}
                                                                onClick={() => openProductDetailPage(brand, productBundle)}
                                                                onKeyDown={(event) => {
                                                                    if (event.key !== 'Enter' && event.key !== ' ') return;
                                                                    event.preventDefault();
                                                                    openProductDetailPage(brand, productBundle);
                                                                }}
                                                                className="flex w-full items-center gap-3 rounded-lg bg-white px-3 py-2 text-left transition hover:bg-[rgb(var(--color-surface-secondary))]"
                                                            >
                                                                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))]">
                                                                    {productImage ? (
                                                                        <img src={resolveAssetUrl(productImage.path)} alt={product.name} className="h-full w-full object-cover" />
                                                                    ) : (
                                                                        <div className="flex h-full w-full items-center justify-center text-[rgb(var(--color-text-tertiary))]">
                                                                            <Package className="h-4 w-4" />
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="min-w-0 flex-1">
                                                                    <div className="truncate text-xs font-semibold text-[rgb(var(--color-text-primary))]">{product.name}</div>
                                                                    <div className="mt-0.5 truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                                                                        {skus.length} 个SKU
                                                                        {product.description ? ` · ${product.description}` : ''}
                                                                    </div>
                                                                </div>
                                                                <div className="hidden min-w-0 shrink-0 items-center gap-1 sm:flex">
                                                                    {detailThumbnails.slice(0, 4).map((asset) => (
                                                                        <div key={asset.id} className="h-8 w-8 overflow-hidden rounded-md bg-[rgb(var(--color-surface-secondary))]">
                                                                            <img src={resolveAssetUrl(asset.path)} alt="" className="h-full w-full object-cover" />
                                                                        </div>
                                                                    ))}
                                                                    <button
                                                                        type="button"
                                                                        onClick={(event) => {
                                                                            event.stopPropagation();
                                                                            openProductDetailPage(brand, productBundle);
                                                                        }}
                                                                        className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-[rgb(var(--color-border))] px-2 text-[11px] font-semibold text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-primary))] hover:text-[rgb(var(--color-text-primary))]"
                                                                    >
                                                                        <ImagePlus className="h-3.5 w-3.5" />
                                                                        详情图
                                                                    </button>
                                                                </div>
                                                                <div className="hidden text-xs text-[rgb(var(--color-text-tertiary))] md:block">
                                                                    {new Date(product.updatedAt).toLocaleDateString()}
                                                                </div>
                                                                <button
                                                                    type="button"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        openEditProductModal(brand, productBundle);
                                                                    }}
                                                                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                                                                    aria-label="编辑商品"
                                                                    title="编辑商品"
                                                                >
                                                                    <Pencil className="h-4 w-4" />
                                                                </button>
                                                            </div>
                                                        );})}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            </div>
                        </div>
                    )
                ) : filteredSubjects.length === 0 ? (
                    <div className={clsx('flex flex-col items-center justify-center text-center text-[rgb(var(--color-text-secondary))]', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                        <CalendarClock className="mb-4 h-12 w-12 stroke-[1.8]" />
                        <div className="text-sm font-medium">暂无数据，尝试刷新</div>
                        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 text-xs text-[rgb(var(--color-text-secondary))]">已加载全部</div>
                    </div>
                ) : viewMode === 'grid' ? (
                    <div className={clsx('grid gap-3', isModalVariant ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5')}>
                        {filteredSubjects.map((subject) => {
                            const voiceInfo = subjectVoiceInfo(subject, voiceJobsById[subjectVoiceString(subject, ['jobId'])]);
                            const voiceSlots = subjectVoiceSlots(subject);
                            const categoryName = categoryNameMap.get(subject.categoryId || '') || '未分类';
                            const brandName = subject.brandId ? subjectNameMap.get(subject.brandId) || '' : '';
                            const productCount = productCountByBrandId.get(subject.id) || 0;
                            return (
                            <div
                                key={subject.id}
                                className="overflow-hidden rounded-lg border border-border bg-surface-primary shadow-sm transition-shadow hover:shadow-md"
                            >
                                <button
                                    type="button"
                                    onClick={() => openEditModal(subject)}
                                    className="w-full text-left"
                                >
                                    <div className="aspect-video bg-surface-secondary/50 overflow-hidden">
                                        {subject.primaryPreviewUrl ? (
                                            <img
                                                src={resolveAssetUrl(subject.primaryPreviewUrl)}
                                                alt={subject.name}
                                                className="w-full h-full object-cover"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-text-tertiary">
                                                <Package className="w-6 h-6" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="space-y-1.5 p-2.5">
                                        <div>
                                            <div className="truncate text-xs font-semibold text-text-primary">{subject.name}</div>
                                            <div className="mt-0.5 text-[11px] text-text-tertiary">
                                                {categoryName}
                                                {brandName ? ` · ${brandName}` : ''}
                                            </div>
                                        </div>
                                        {subject.description && (
                                            <div className="line-clamp-2 text-[11px] text-text-secondary">
                                                {subject.description}
                                            </div>
                                        )}
                                        {subject.tags.length > 0 && (
                                            <div className="flex flex-wrap gap-1">
                                                {subject.tags.slice(0, 4).map((tag) => (
                                                    <span
                                                        key={`${subject.id}-${tag}`}
                                                        className="text-[10px] px-1.5 py-0.5 rounded-md border border-border bg-surface-secondary/50 text-text-secondary"
                                                    >
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        <VoiceSlotBadges slots={voiceSlots} compact />
                                            <div className="flex items-center justify-between text-[9px] text-text-tertiary">
                                            <span>属性 {subject.attributes.length}</span>
                                            <span>图片 {(subject.previewUrls || []).length}</span>
                                            {categoryName === '品牌' && <span>商品 {productCount}</span>}
                                            {categoryName === '商品' && <span>SKU {(subject.skus || []).length}</span>}
                                            <span className={clsx('rounded-md border px-1.5 py-0.5', voiceInfoClassName(voiceInfo.tone))}>
                                                {voiceInfo.targetTtsModel ? `${voiceInfo.label} · ${shortVoiceId(voiceInfo.targetTtsModel)}` : voiceInfo.label}
                                            </span>
                                        </div>
                                    </div>
                                </button>
                            </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="divide-y divide-[rgb(var(--color-border))] rounded-xl border border-[rgb(var(--color-border))] bg-white">
                        {filteredSubjects.map((subject) => {
                            const voiceInfo = subjectVoiceInfo(subject, voiceJobsById[subjectVoiceString(subject, ['jobId'])]);
                            const voiceSlots = subjectVoiceSlots(subject);
                            const categoryName = categoryNameMap.get(subject.categoryId || '') || '未分类';
                            const brandName = subject.brandId ? subjectNameMap.get(subject.brandId) || '' : '';
                            const productCount = productCountByBrandId.get(subject.id) || 0;
                            return (
                            <button
                                key={subject.id}
                                type="button"
                                onClick={() => openEditModal(subject)}
                                className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[rgb(var(--color-surface-primary))]"
                            >
                                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))]">
                                    {subject.primaryPreviewUrl ? (
                                        <img src={resolveAssetUrl(subject.primaryPreviewUrl)} alt={subject.name} className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-[rgb(var(--color-text-tertiary))]">
                                            <Package className="h-5 w-5" />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-xs font-semibold text-[rgb(var(--color-text-primary))]">{subject.name}</div>
                                    <div className="mt-0.5 truncate text-[11px] text-[rgb(var(--color-text-secondary))]">
                                        {categoryName}
                                        {brandName ? ` · ${brandName}` : ''}
                                        {categoryName === '品牌' && productCount > 0 ? ` · ${productCount} 个商品` : ''}
                                        {categoryName === '商品' && (subject.skus || []).length > 0 ? ` · ${(subject.skus || []).length} 个SKU` : ''}
                                        {subject.description ? ` · ${subject.description}` : ''}
                                    </div>
                                </div>
                                <div className="hidden text-xs text-[rgb(var(--color-text-tertiary))] md:block">
                                    {new Date(subject.updatedAt).toLocaleDateString()}
                                </div>
                                <div className="hidden max-w-[280px] md:block">
                                    <VoiceSlotBadges slots={voiceSlots} compact />
                                </div>
                                <div className={clsx('hidden rounded-md border px-2 py-1 text-[11px] md:block', voiceInfoClassName(voiceInfo.tone))}>
                                    {voiceInfo.targetTtsModel ? `${voiceInfo.label} · ${shortVoiceId(voiceInfo.targetTtsModel)}` : voiceInfo.label}
                                </div>
                            </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {mediaContextMenu.visible && mediaContextMenu.asset && (
                <LiquidGlassMenuPanel
                    className="fixed z-[150] min-w-[148px]"
                    style={{ left: mediaContextMenu.x, top: mediaContextMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            const asset = mediaContextMenu.asset;
                            setMediaContextMenu({ visible: false, x: 0, y: 0, asset: null });
                            if (asset) {
                                void handleShowMediaInFolder(asset);
                            }
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        <FolderOpen className="h-4 w-4" />
                        文件夹中打开
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const asset = mediaContextMenu.asset;
                            setMediaContextMenu({ visible: false, x: 0, y: 0, asset: null });
                            if (asset) {
                                void handleDeleteMediaAsset(asset);
                            }
                        }}
                        className={getLiquidGlassMenuItemClassName({ destructive: true })}
                    >
                        <Trash2 className="h-4 w-4" />
                        删除
                    </button>
                </LiquidGlassMenuPanel>
            )}

            {isBrandModalOpen && (
                <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/35 p-4">
                    <div className="flex max-h-[86vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between px-6 py-5">
                            <h2 className="text-lg font-semibold leading-none text-[rgb(var(--color-text-primary))]">
                                {brandDraft.id ? '编辑品牌' : '新建品牌'}
                            </h2>
                            <button
                                type="button"
                                onClick={closeBrandModal}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]"
                                aria-label="关闭"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-5">
                            {error && (
                                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                    {error}
                                </div>
                            )}
                            <label className="block">
                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">品牌名称 <span className="text-red-500">*</span></div>
                                <input
                                    value={brandDraft.name}
                                    onChange={(event) => updateBrandDraft({ name: event.target.value })}
                                    placeholder="品牌名称"
                                    className="h-10 w-full rounded-lg border border-violet-500 bg-white px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none ring-2 ring-violet-500/15 placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-violet-500/20"
                                />
                            </label>
                            <label className="block">
                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">品牌描述</div>
                                <textarea
                                    value={brandDraft.description}
                                    onChange={(event) => updateBrandDraft({ description: event.target.value.slice(0, 300) })}
                                    rows={5}
                                    maxLength={300}
                                    placeholder="品牌定位、风格、目标用户、适用场景"
                                    className="min-h-[120px] w-full resize-y rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 py-2.5 text-sm leading-5 text-[rgb(var(--color-text-primary))] outline-none placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-2 focus:ring-violet-500"
                                />
                            </label>
                            <div className="space-y-2">
                                <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">品牌图片</div>
                                <BrandWorkspaceImageGrid
                                    images={brandDraft.images}
                                    onAdd={(files) => void handleBrandImageInput(files)}
                                    onRemove={handleRemoveBrandImage}
                                    label="上传品牌图片"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-[rgb(var(--color-border))] px-6 py-4">
                            <button
                                type="button"
                                onClick={closeBrandModal}
                                disabled={isBrandModalSubmitting}
                                className="inline-flex h-9 items-center rounded-lg bg-[rgb(var(--color-surface-secondary))] px-3 text-sm font-medium text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))] disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleSaveBrand()}
                                disabled={isBrandModalSubmitting}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-black px-3 text-sm font-semibold text-white transition hover:bg-black/85 disabled:opacity-50"
                            >
                                <Save className="h-4 w-4" />
                                {isBrandModalSubmitting ? '保存中' : '保存'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isProductModalOpen && (
                <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/35 p-4">
                    <div className="flex max-h-[86vh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between px-6 py-5">
                            <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                                    {productDraftBrand?.name || '品牌'}
                                </div>
                                <h2 className="mt-1 text-lg font-semibold leading-none text-[rgb(var(--color-text-primary))]">
                                    {productDraft.id ? '编辑商品' : '新建商品'}
                                </h2>
                            </div>
                            <button
                                type="button"
                                onClick={closeProductModal}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]"
                                aria-label="关闭"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-5">
                            {error && (
                                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                    {error}
                                </div>
                            )}
                            <label className="block">
                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">商品名称 <span className="text-red-500">*</span></div>
                                <input
                                    value={productDraft.name}
                                    onChange={(event) => updateProductDraft({ name: event.target.value })}
                                    placeholder="商品名称"
                                    className="h-10 w-full rounded-lg border border-violet-500 bg-white px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none ring-2 ring-violet-500/15 placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-violet-500/20"
                                />
                            </label>
                            <label className="block">
                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">商品描述</div>
                                <textarea
                                    value={productDraft.description}
                                    onChange={(event) => updateProductDraft({ description: event.target.value.slice(0, 200) })}
                                    rows={4}
                                    maxLength={200}
                                    placeholder="商品卖点、材质、适用场景"
                                    className="min-h-[88px] w-full resize-y rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 py-2.5 text-sm leading-5 text-[rgb(var(--color-text-primary))] outline-none placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-2 focus:ring-violet-500"
                                />
                            </label>
                            <div className="space-y-2">
                                <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">商品图片</div>
                                <BrandWorkspaceImageGrid
                                    images={productDraft.images}
                                    onAdd={(files) => void handleProductImageInput(files)}
                                    onRemove={handleRemoveProductImage}
                                    label="上传商品图片"
                                />
                            </div>
                            <div className="space-y-2 rounded-xl bg-[rgb(var(--color-surface-primary))] p-4">
                                <div className="flex items-center justify-between">
                                    <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">SKU</div>
                                    <button
                                        type="button"
                                        onClick={handleAddProductSku}
                                        className="inline-flex h-8 items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-medium text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]"
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        添加
                                    </button>
                                </div>
                                {productDraft.skus.length === 0 ? (
                                    <div className="rounded-lg border border-dashed border-[rgb(var(--color-border))] bg-white px-3 py-2.5 text-xs text-[rgb(var(--color-text-secondary))]">
                                        为商品添加颜色、规格、尺码等 SKU。
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {productDraft.skus.map((sku, skuIndex) => (
                                            <div key={sku.id || skuIndex} className="rounded-lg bg-white p-3">
                                                <div className="grid grid-cols-[minmax(0,1fr)_32px] gap-2">
                                                    <input
                                                        value={sku.name}
                                                        onChange={(event) => handleProductSkuChange(skuIndex, { name: event.target.value })}
                                                        placeholder="SKU 名称"
                                                        className="h-9 rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRemoveProductSku(skuIndex)}
                                                        className="inline-flex h-9 items-center justify-center rounded-lg bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))] transition hover:bg-red-50 hover:text-red-600"
                                                        aria-label="删除 SKU"
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </button>
                                                </div>
                                                <textarea
                                                    value={sku.variantText}
                                                    onChange={(event) => handleProductSkuChange(skuIndex, { variantText: event.target.value.slice(0, 160) })}
                                                    rows={2}
                                                    maxLength={160}
                                                    placeholder="规格描述，如：颜色：樱桃红；容量：3.5g"
                                                    className="mt-2 min-h-[58px] w-full resize-y rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 py-2 text-xs leading-5 text-[rgb(var(--color-text-primary))] outline-none placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-2 focus:ring-violet-500"
                                                />
                                                <div className="mt-2 space-y-2">
                                                    <div className="text-xs font-semibold text-[rgb(var(--color-text-primary))]">SKU 图片</div>
                                                    <BrandWorkspaceImageGrid
                                                        images={sku.images}
                                                        onAdd={(files) => void handleProductSkuImageInput(skuIndex, files)}
                                                        onRemove={(imageIndex) => handleRemoveProductSkuImage(skuIndex, imageIndex)}
                                                        label="上传 SKU 图片"
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-[rgb(var(--color-border))] px-6 py-4">
                            <button
                                type="button"
                                onClick={closeProductModal}
                                disabled={isProductModalSubmitting}
                                className="inline-flex h-9 items-center rounded-lg bg-[rgb(var(--color-surface-secondary))] px-3 text-sm font-medium text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))] disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleSaveProduct()}
                                disabled={isProductModalSubmitting}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-black px-3 text-sm font-semibold text-white transition hover:bg-black/85 disabled:opacity-50"
                            >
                                <Save className="h-4 w-4" />
                                {isProductModalSubmitting ? '保存中' : '保存'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isAssetModalVisible && (
                <div
                    className={clsx(
                        'asset-library-modal-backdrop fixed inset-0 z-[120] flex items-center justify-center p-4',
                        assetModalPhase === 'open' ? 'asset-library-modal-backdrop--open' : 'asset-library-modal-backdrop--closed'
                    )}
                >
                    <div
                        className={clsx(
                            'asset-library-modal-panel flex max-h-[88vh] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl',
                            assetModalPhase === 'open' ? 'asset-library-modal-panel--open' : 'asset-library-modal-panel--closed'
                        )}
                    >
                        <div className="flex items-center justify-between px-8 pb-4 pt-6">
                            <h2 className="text-xl font-semibold leading-none text-[rgb(var(--color-text-primary))]">
                                {draft.id ? `编辑${draftEntityLabel}` : `新建${draftEntityLabel}`}
                            </h2>
                            <button
                                type="button"
                                onClick={closeModal}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]"
                                aria-label="关闭"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto px-8 pb-5">
                            {error && (
                                <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                    {error}
                                </div>
                            )}

                            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
                                <div className="space-y-4">
                                    <div className="block">
                                        <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">类别</div>
                                        <div className="flex gap-2">
                                            <div className="relative flex-1">
                                                <button
                                                    type="button"
                                                    onClick={() => setIsDraftCategoryMenuOpen((value) => !value)}
                                                    className={clsx(
                                                        'flex h-10 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm transition',
                                                        isDraftCategoryMenuOpen
                                                            ? 'border-violet-400 bg-white ring-2 ring-violet-500/15'
                                                            : 'border-transparent bg-[rgb(var(--color-surface-secondary))] hover:bg-[rgb(var(--color-surface-tertiary))]/70'
                                                    )}
                                                >
                                                    <span className="flex min-w-0 items-center gap-2">
                                                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-[rgb(var(--color-text-secondary))] shadow-sm">
                                                            <SelectedDraftCategoryIcon className="h-3.5 w-3.5" />
                                                        </span>
                                                        <span className="truncate font-medium text-[rgb(var(--color-text-primary))]">{selectedDraftCategory.name}</span>
                                                    </span>
                                                    <ChevronDown className={clsx('h-4 w-4 shrink-0 text-[rgb(var(--color-text-tertiary))] transition-transform', isDraftCategoryMenuOpen && 'rotate-180')} />
                                                </button>

                                                {isDraftCategoryMenuOpen && (
                                                    <div className="absolute left-0 right-0 top-full z-[140] mt-1.5 overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-white shadow-[0_18px_50px_rgba(15,23,42,0.16)]">
                                                        <div className="max-h-60 overflow-y-auto p-1">
                                                            {draftCategoryOptions.map((category) => {
                                                                const Icon = category.icon;
                                                                const selected = category.id === draft.categoryId;
                                                                return (
                                                                    <button
                                                                        key={category.id || '__uncategorized__'}
                                                                        type="button"
                                                                        onClick={() => {
                                                                            handleDraftCategoryChange(category.id);
                                                                            setIsDraftCategoryMenuOpen(false);
                                                                        }}
                                                                        className={clsx(
                                                                            'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition',
                                                                            selected ? 'bg-violet-50 text-violet-700' : 'text-[rgb(var(--color-text-primary))] hover:bg-[rgb(var(--color-surface-primary))]'
                                                                        )}
                                                                    >
                                                                        <span className={clsx(
                                                                            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                                                                            selected ? 'bg-violet-100 text-violet-700' : 'bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))]'
                                                                        )}>
                                                                            <Icon className="h-3.5 w-3.5" />
                                                                        </span>
                                                                        <span className="min-w-0 flex-1 truncate font-medium">{category.name}</span>
                                                                        {selected && <Check className="h-4 w-4 shrink-0" />}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setIsDraftCategoryMenuOpen(false);
                                                    openCreateCategoryDialog();
                                                }}
                                                className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))]"
                                                aria-label="新建分类"
                                                title="新建分类"
                                            >
                                                <Plus className="h-4 w-4" />
                                            </button>
                                        </div>
                                        {draft.categoryId && (
                                            <div className="mt-2 flex items-center gap-2 text-xs text-[rgb(var(--color-text-secondary))]">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const category = categories.find((item) => item.id === draft.categoryId);
                                                        if (category) openRenameCategoryDialog(category);
                                                    }}
                                                    className="transition hover:text-[rgb(var(--color-text-primary))]"
                                                >
                                                    重命名当前分类
                                                </button>
                                                <span>·</span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const category = categories.find((item) => item.id === draft.categoryId);
                                                        if (category) void handleDeleteCategory(category);
                                                    }}
                                                    className="transition hover:text-red-600"
                                                >
                                                    删除当前分类
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    <label className="block">
                                        <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">
                                            {draftEntityLabel}名称 <span className="text-red-500">*</span>
                                        </div>
                                        <input
                                            value={draft.name}
                                            onChange={(event) => updateDraft({ name: event.target.value })}
                                            placeholder={`${draftEntityLabel}名称`}
                                            className="h-10 w-full rounded-lg border border-violet-500 bg-white px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none ring-2 ring-violet-500/15 placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-violet-500/20"
                                        />
                                    </label>

                                    <label className="block">
                                        <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">{draftEntityLabel}描述</div>
                                        <div className="relative">
                                            <textarea
                                                value={draft.description}
                                                onChange={(event) => updateDraft({ description: event.target.value.slice(0, 200) })}
                                                rows={5}
                                                maxLength={200}
                                                placeholder={`描述${draftEntityLabel}特征或用途`}
                                                className="min-h-[92px] w-full resize-y rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 py-2.5 pr-12 text-sm leading-5 text-[rgb(var(--color-text-primary))] outline-none placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-2 focus:ring-violet-500"
                                            />
                                            <div className="absolute bottom-2.5 right-3 text-xs text-[rgb(var(--color-text-secondary))]">{draft.description.length}/200</div>
                                        </div>
                                    </label>

                                    {isRoleDraft && (
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <label className="block">
                                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">性别</div>
                                                <SelectMenu
                                                    value={draftAttributeValue('性别')}
                                                    onChange={(value) => handleNamedAttributeChange('性别', value)}
                                                    options={[
                                                        { value: '', label: '选择性别' },
                                                        { value: '女性', label: '女性' },
                                                        { value: '男性', label: '男性' },
                                                        { value: '中性', label: '中性' },
                                                        { value: '其他', label: '其他' },
                                                    ]}
                                                />
                                            </label>
                                            <label className="block">
                                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">年龄</div>
                                                <input
                                                    value={draftAttributeValue('年龄')}
                                                    onChange={(event) => handleNamedAttributeChange('年龄', event.target.value)}
                                                    placeholder="角色年龄"
                                                    className="h-10 w-full rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-2 focus:ring-violet-500"
                                                />
                                            </label>
                                        </div>
                                    )}

                                    <label className="block">
                                        <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">标签</div>
                                        <div className="relative">
                                            <Tag className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))]" />
                                            <input
                                                value={draft.tagsText}
                                                onChange={(event) => updateDraft({ tagsText: event.target.value })}
                                                placeholder="多个标签用逗号分隔"
                                                className="h-10 w-full rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] pl-9 pr-3 text-sm text-[rgb(var(--color-text-primary))] outline-none placeholder:text-[rgb(var(--color-text-tertiary))] focus:ring-2 focus:ring-violet-500"
                                            />
                                        </div>
                                    </label>

                                    {isProductDraft && (
                                        <div className="space-y-3 rounded-xl bg-[rgb(var(--color-surface-primary))] p-4">
                                            <div className="block">
                                                <div className="mb-1.5 text-sm font-semibold text-[rgb(var(--color-text-primary))]">所属品牌</div>
                                                <div className="flex h-9 items-center rounded-lg bg-white px-3 text-sm font-medium text-[rgb(var(--color-text-primary))]">
                                                    {selectedBrandName || '未绑定品牌'}
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">SKU</div>
                                                    <button
                                                        type="button"
                                                        onClick={handleAddSku}
                                                        className="inline-flex h-8 items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-medium text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]"
                                                    >
                                                        <Plus className="h-3.5 w-3.5" />
                                                        添加
                                                    </button>
                                                </div>
                                                {draft.skus.length === 0 ? (
                                                    <div className="rounded-lg border border-dashed border-[rgb(var(--color-border))] px-3 py-2.5 text-xs text-[rgb(var(--color-text-secondary))]">
                                                        为商品添加颜色、尺码、规格等可选项。
                                                    </div>
                                                ) : (
                                                    <div className="space-y-2">
                                                        {draft.skus.map((sku, skuIndex) => (
                                                            <div key={sku.id || skuIndex} className="rounded-lg bg-white p-3">
                                                                <div className="grid grid-cols-[minmax(0,1fr)_32px] gap-2">
                                                                    <input
                                                                        value={sku.name}
                                                                        onChange={(event) => handleSkuChange(skuIndex, { name: event.target.value })}
                                                                        placeholder="SKU 名称"
                                                                        className="h-9 rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                                                    />
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleRemoveSku(skuIndex)}
                                                                        className="inline-flex h-9 items-center justify-center rounded-lg bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))] transition hover:bg-red-50 hover:text-red-600"
                                                                        aria-label="删除 SKU"
                                                                    >
                                                                        <X className="h-4 w-4" />
                                                                    </button>
                                                                </div>
                                                                <div className="mt-2 space-y-2">
                                                                    {sku.attributes.map((attribute, attributeIndex) => (
                                                                        <div key={`${sku.id}-${attributeIndex}`} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_32px] gap-2">
                                                                            <input
                                                                                value={attribute.key}
                                                                                onChange={(event) => handleSkuAttributeChange(skuIndex, attributeIndex, { key: event.target.value })}
                                                                                placeholder="属性"
                                                                                className="h-8 rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-2.5 text-xs text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                                                            />
                                                                            <input
                                                                                value={attribute.value}
                                                                                onChange={(event) => handleSkuAttributeChange(skuIndex, attributeIndex, { value: event.target.value })}
                                                                                placeholder="值"
                                                                                className="h-8 rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-2.5 text-xs text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                                                            />
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleRemoveSkuAttribute(skuIndex, attributeIndex)}
                                                                                className="inline-flex h-8 items-center justify-center rounded-lg text-[rgb(var(--color-text-secondary))] transition hover:bg-red-50 hover:text-red-600"
                                                                                aria-label="删除 SKU 属性"
                                                                            >
                                                                                <X className="h-3.5 w-3.5" />
                                                                            </button>
                                                                        </div>
                                                                    ))}
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleAddSkuAttribute(skuIndex)}
                                                                        className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-secondary))] hover:text-[rgb(var(--color-text-primary))]"
                                                                    >
                                                                        <Plus className="h-3.5 w-3.5" />
                                                                        属性
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">扩展属性</div>
                                            <button
                                                type="button"
                                                onClick={handleAddAttribute}
                                                className="inline-flex h-8 items-center gap-1 rounded-lg bg-[rgb(var(--color-surface-secondary))] px-2.5 text-xs font-medium text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))]"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                添加
                                            </button>
                                        </div>
                                        {visibleDraftAttributes.length === 0 ? (
                                            <div className="rounded-lg border border-dashed border-[rgb(var(--color-border))] px-3 py-2.5 text-xs text-[rgb(var(--color-text-secondary))]">
                                                可添加颜色、材质、职业、人设、价格区间等结构化信息。
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {visibleDraftAttributes.map(({ attribute, index }) => (
                                                    <div key={index} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)_36px] gap-2">
                                                        <input
                                                            value={attribute.key}
                                                            onChange={(event) => handleAttributeChange(index, { key: event.target.value })}
                                                            placeholder="属性名"
                                                            className="h-9 rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                                        />
                                                        <input
                                                            value={attribute.value}
                                                            onChange={(event) => handleAttributeChange(index, { value: event.target.value })}
                                                            placeholder="属性值"
                                                            className="h-9 rounded-lg border-0 bg-[rgb(var(--color-surface-secondary))] px-3 text-sm text-[rgb(var(--color-text-primary))] outline-none focus:ring-2 focus:ring-violet-500"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveAttribute(index)}
                                                            className="inline-flex h-9 items-center justify-center rounded-lg bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))] transition hover:bg-red-50 hover:text-red-600"
                                                            aria-label="删除属性"
                                                        >
                                                            <X className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">{draftEntityLabel}图片</div>
                                            {isRoleDraft && (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleGenerateCharacterCard()}
                                                    disabled={working || generatingCardSubjectId === draft.id || draft.images.length === 0}
                                                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-[rgb(var(--color-text-primary))] px-2.5 text-xs font-semibold text-white transition hover:bg-[rgb(var(--color-surface-elevated))] disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    <Sparkles className={clsx('h-3.5 w-3.5', generatingCardSubjectId === draft.id && 'animate-pulse')} />
                                                    {generatingCardSubjectId === draft.id ? '生成中' : '角色卡'}
                                                </button>
                                            )}
                                        </div>
                                        <label className={clsx(
                                            'flex h-10 cursor-pointer items-center justify-center rounded-lg bg-[rgb(var(--color-surface-secondary))] text-sm font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))]',
                                            draft.images.length >= 5 && 'pointer-events-none opacity-50'
                                        )}>
                                            选择图片
                                            <input
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                className="hidden"
                                                onChange={(event) => {
                                                    void handleImageInput(event.target.files);
                                                    event.currentTarget.value = '';
                                                }}
                                            />
                                        </label>
                                        {draft.images.length > 0 && (
                                            <div className="grid grid-cols-6 gap-2">
                                                {draft.images.map((image, index) => (
                                                    <div key={`${image.relativePath || image.name}-${index}`} className="group relative aspect-video overflow-hidden rounded-lg bg-[rgb(var(--color-surface-secondary))]">
                                                        <button
                                                            type="button"
                                                            onClick={() => setPreviewImage(image)}
                                                            className="h-full w-full"
                                                            aria-label="预览图片"
                                                        >
                                                            <img src={resolveAssetUrl(image.previewUrl)} alt={image.name} className="h-full w-full object-cover" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveImage(index)}
                                                            className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                            aria-label="删除图片"
                                                        >
                                                            <X className="h-3 w-3" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {isRoleDraft && (
                                        <div className="space-y-2">
                                            <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">角色视频</div>
                                            {draft.video?.previewUrl ? (
                                                <div className="group relative overflow-hidden rounded-lg bg-black">
                                                    <video
                                                        src={resolveAssetUrl(draft.video.previewUrl)}
                                                        className="aspect-video w-full object-cover"
                                                        muted
                                                        playsInline
                                                        controls
                                                        preload="metadata"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={handleRemoveVideo}
                                                        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                        aria-label="删除角色视频"
                                                    >
                                                        <X className="h-3.5 w-3.5" />
                                                    </button>
                                                    <div className="truncate bg-black/75 px-3 py-2 text-xs font-medium text-white">{draft.video.name}</div>
                                                </div>
                                            ) : (
                                                <label className="flex h-10 cursor-pointer items-center justify-center rounded-lg bg-[rgb(var(--color-surface-secondary))] text-sm font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))]">
                                                    上传视频
                                                    <input
                                                        type="file"
                                                        accept="video/*,.mp4,.webm,.mov,.m4v,.mkv"
                                                        className="hidden"
                                                        onChange={(event) => {
                                                            void handleVideoFileInput(event.target.files);
                                                            event.currentTarget.value = '';
                                                        }}
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    )}

                                    {isRoleDraft && (
                                        <div className="space-y-2 rounded-xl bg-[rgb(var(--color-surface-primary))] p-4">
                                            <div className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">声音参考</div>
                                            <div className="rounded-xl bg-white px-4 py-3">
                                                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]">朗读采样句</div>
                                                <div className="mt-1.5 text-sm font-medium leading-6 text-[rgb(var(--color-text-primary))]">{SUBJECT_VOICE_SAMPLE_TEXT}</div>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (audioRecording.isRecording) {
                                                            void handleFinishVoiceRecording();
                                                        } else {
                                                            void handleRecordVoice();
                                                        }
                                                    }}
                                                    disabled={audioRecording.isWorking}
                                                    className={clsx(
                                                        'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white transition disabled:opacity-60',
                                                        audioRecording.isRecording
                                                            ? canFinishVoiceRecording
                                                                ? 'bg-emerald-600 hover:bg-emerald-700'
                                                                : 'bg-violet-600 hover:bg-violet-700'
                                                            : 'bg-black hover:bg-black/85',
                                                    )}
                                                >
                                                    <Mic className="h-3.5 w-3.5" />
                                                    {audioRecording.isWorking
                                                        ? '处理中'
                                                        : audioRecording.isRecording
                                                            ? (canFinishVoiceRecording ? '完成采样' : `录音中 ${recordingElapsedSeconds}s`)
                                                            : '录制音频'}
                                                </button>
                                                <label className={clsx(
                                                    'inline-flex h-9 items-center rounded-lg bg-white px-3 text-xs font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))]',
                                                    audioRecording.isRecording || audioRecording.isWorking
                                                        ? 'pointer-events-none opacity-50'
                                                        : 'cursor-pointer',
                                                )}>
                                                    导入音频
                                                    <input
                                                        type="file"
                                                        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm"
                                                        className="hidden"
                                                        onChange={(event) => {
                                                            void handleVoiceFileInput(event.target.files);
                                                            event.currentTarget.value = '';
                                                        }}
                                                    />
                                                </label>
                                                {draft.voice?.previewUrl && (
                                                    <button
                                                        type="button"
                                                        onClick={handleRemoveVoice}
                                                        className="inline-flex h-9 items-center rounded-lg bg-red-50 px-3 text-xs font-semibold text-red-700 transition hover:bg-red-100"
                                                    >
                                                        删除声音
                                                    </button>
                                                )}
                                            </div>
                                            {audioRecording.isRecording && (
                                                <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-700">
                                                    已录 {voiceRecordingElapsedSeconds} 秒
                                                </div>
                                            )}
                                            {recordingHint && <div className="text-xs text-[rgb(var(--color-text-secondary))]">{recordingHint}</div>}
                                            {recordingError && <div className="text-xs text-red-600">{recordingError}</div>}
                                            {draft.voice?.previewUrl && (
                                                <div className="space-y-2 rounded-lg bg-white px-3 py-2.5">
                                                    <div className="text-xs text-[rgb(var(--color-text-secondary))]">{draft.voice.name}</div>
                                                    <audio controls src={resolveAssetUrl(draft.voice.previewUrl)} className="w-full" />
                                                </div>
                                            )}
                                            {activeDraftSubject && activeDraftVoiceInfo && (
                                                <div className="space-y-2">
                                                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                                                        <SelectMenu
                                                            value={selectedVoiceCloneTtsModel}
                                                            onChange={setSelectedVoiceCloneTtsModel}
                                                            options={voiceCloneModelOptions}
                                                            placeholder="选择 TTS 模型"
                                                            className="w-full"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleRetryVoiceClone(activeDraftSubject)}
                                                            disabled={!activeDraftVoiceInfo.canRetry || retryingVoiceSubjectId === activeDraftSubject.id || activeDraftVoiceInfo.tone === 'active'}
                                                            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-secondary))] disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            <RefreshCw className={clsx('h-3.5 w-3.5', (retryingVoiceSubjectId === activeDraftSubject.id || activeDraftVoiceInfo.tone === 'active') && 'animate-spin')} />
                                                            {retryingVoiceSubjectId === activeDraftSubject.id
                                                                ? '提交中'
                                                                : activeDraftVoiceInfo.tone === 'active'
                                                                    ? '音色复刻中'
                                                                    : '克隆音色'}
                                                        </button>
                                                    </div>
                                                    <div className={clsx('rounded-lg border px-3 py-2 text-xs', voiceInfoClassName(activeDraftVoiceInfo.tone))}>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="font-semibold">{activeDraftVoiceInfo.label}</span>
                                                            {activeDraftVoiceInfo.detail && (
                                                                <span className="font-mono text-[11px] opacity-80">{activeDraftVoiceInfo.detail}</span>
                                                            )}
                                                            {activeDraftVoiceInfo.targetTtsModel && (
                                                                <span className="rounded-md bg-white/65 px-1.5 py-0.5 font-mono text-[10px] opacity-85">
                                                                    {displayModelName(activeDraftVoiceInfo.targetTtsModel)}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {activeDraftVoiceInfo.error && (
                                                            <div className="mt-1 line-clamp-2 opacity-80">{activeDraftVoiceInfo.error}</div>
                                                        )}
                                                    </div>
                                                    <VoiceSlotBadges slots={activeDraftVoiceSlots} />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <aside className="h-fit rounded-2xl bg-[rgb(var(--color-surface-secondary))] p-4">
                                    <div className="mb-3 text-base font-semibold text-[rgb(var(--color-text-primary))]">{draft.id ? '编辑预览' : '新增预览'}</div>
                                    <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-white">
                                        {draftPreviewImage ? (
                                            <img src={resolveAssetUrl(draftPreviewImage)} alt={draft.name || draftEntityLabel} className="h-full w-full object-cover" />
                                        ) : (
                                            <div className="flex items-center gap-2 text-sm font-medium text-[rgb(var(--color-text-secondary))]">
                                                <ImagePlus className="h-5 w-5" />
                                                暂无封面
                                            </div>
                                        )}
                                    </div>
                                    <div className="mt-4 space-y-2">
                                        <div className="flex items-center gap-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                                            <span className="rounded-full bg-white px-2 py-0.5">{draftCategoryName || '未分类'}</span>
                                            <span>{draft.images.length}/5 张图片</span>
                                            {isBrandDraft && <span>{productCountByBrandId.get(draft.id || '') || 0} 个商品</span>}
                                            {isProductDraft && <span>{draft.skus.length} 个SKU</span>}
                                            {isRoleDraft && <span>{draft.voice?.previewUrl ? '有声音' : '未录音'}</span>}
                                            {isRoleDraft && <span>{draft.video?.previewUrl ? '有视频' : '无视频'}</span>}
                                        </div>
                                        <div className="text-base font-semibold text-[rgb(var(--color-text-primary))]">{draft.name || `${draftEntityLabel}名称`}</div>
                                        <div className="min-h-[36px] text-xs leading-5 text-[rgb(var(--color-text-secondary))]">
                                            {draft.description || `选择图片后实时查看${draftEntityLabel}素材预览`}
                                        </div>
                                        {isProductDraft && selectedBrandName && (
                                            <div className="text-xs font-medium text-[rgb(var(--color-text-secondary))]">
                                                品牌：{selectedBrandName}
                                            </div>
                                        )}
                                    </div>
                                    {draft.id && (
                                        <div className="mt-4 space-y-1 rounded-lg bg-white px-3 py-2 text-[11px] leading-5 text-[rgb(var(--color-text-secondary))]">
                                            <div>ID：{draft.id}</div>
                                            {isBrandDraft && (
                                                <div>绑定商品：{productCountByBrandId.get(draft.id) || 0}</div>
                                            )}
                                            {isProductDraft && selectedBrandName && (
                                                <div>所属品牌：{selectedBrandName}</div>
                                            )}
                                            {isProductDraft && (
                                                <div>SKU数量：{draft.skus.length}</div>
                                            )}
                                            {activeDraftVoiceInfo?.voiceId && (
                                                <div>音色ID：<span className="font-mono">{activeDraftVoiceInfo.voiceId}</span></div>
                                            )}
                                            {activeDraftVoiceInfo?.targetTtsModel && (
                                                <div>TTS模型：<span className="font-mono">{activeDraftVoiceInfo.targetTtsModel}</span></div>
                                            )}
                                            {activeDraftVoiceInfo?.cloneModel && (
                                                <div>克隆模型：<span className="font-mono">{activeDraftVoiceInfo.cloneModel}</span></div>
                                            )}
                                            {activeDraftVoiceSlots.length > 0 && (
                                                <div className="pt-1">
                                                    <VoiceSlotBadges slots={activeDraftVoiceSlots} />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </aside>
                            </div>
                        </div>

                        <div className="flex items-center justify-between px-8 py-5">
                            <div>
                                {draft.id && (
                                    <button
                                        type="button"
                                        onClick={() => void handleDeleteSubject()}
                                        disabled={working}
                                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-red-50 px-3 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        删除
                                    </button>
                                )}
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    disabled={working}
                                    className="h-9 rounded-lg bg-[rgb(var(--color-surface-secondary))] px-5 text-sm font-semibold text-[rgb(var(--color-text-primary))] transition hover:bg-[rgb(var(--color-surface-tertiary))] disabled:opacity-60"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleSave()}
                                    disabled={working}
                                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-black px-5 text-sm font-semibold text-white transition hover:bg-black/85 disabled:opacity-60"
                                >
                                    {draft.id ? <Pencil className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                                    {working ? '处理中...' : draft.id ? '保存' : '创建'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {previewImage && (
                <div
                    className="fixed inset-0 z-[160] flex items-center justify-center bg-black/75 p-6"
                    onMouseDown={() => setPreviewImage(null)}
                >
                    <div
                        className="relative flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] items-center justify-center"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            onClick={() => setPreviewImage(null)}
                            className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
                            aria-label="关闭预览"
                        >
                            <X className="h-4 w-4" />
                        </button>
                        <img
                            src={resolveAssetUrl(previewImage.previewUrl)}
                            alt={previewImage.name}
                            className="block h-auto max-h-full w-auto max-w-full rounded-xl bg-white object-contain shadow-2xl"
                        />
                    </div>
                </div>
            )}

            {isCategoryDialogOpen && (
                <div
                    className="fixed inset-0 z-[130] bg-black/35 flex items-center justify-center p-6"
                    onMouseDown={closeCategoryDialog}
                >
                    <div
                        className="w-full max-w-sm rounded-2xl border border-border bg-surface-primary shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="px-5 py-4 border-b border-border">
                            <div className="text-sm font-semibold text-text-primary">
                                {categoryDialogMode === 'create' ? '新建分类' : '重命名分类'}
                            </div>
                            <div className="mt-1 text-xs leading-5 text-text-tertiary">
                                {categoryDialogMode === 'create'
                                    ? '输入分类名称后即可在资产库中直接使用。'
                                    : '更新分类名称后，已关联的资产会自动沿用该分类。'}
                            </div>
                        </div>
                        <div className="px-5 py-4 space-y-3">
                            <input
                                autoFocus
                                value={categoryDialogName}
                                onChange={(event) => setCategoryDialogName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        void submitCategoryDialog();
                                    } else if (event.key === 'Escape') {
                                        closeCategoryDialog();
                                    }
                                }}
                                placeholder="请输入分类名称"
                                className="w-full h-10 rounded-md border border-border bg-surface-secondary px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                            />
                            <div className="flex items-center justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={closeCategoryDialog}
                                    disabled={isCategoryDialogSubmitting}
                                    className="h-9 px-3 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary disabled:opacity-50"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void submitCategoryDialog();
                                    }}
                                    disabled={isCategoryDialogSubmitting}
                                    className="h-9 px-3 text-sm rounded-md bg-accent-primary text-white hover:bg-accent-hover disabled:opacity-50"
                                >
                                    {isCategoryDialogSubmitting ? '处理中...' : '确定'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
