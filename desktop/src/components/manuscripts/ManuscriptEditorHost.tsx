import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
    AudioLines,
    Clapperboard,
    ExternalLink,
    FileAudio,
    FileText,
    Folder,
    FolderOpen,
    FolderPlus,
    Grid2X2,
    Image as ImageIcon,
    ImagePlus,
    Loader2,
    Plus,
    Play,
    RefreshCw,
    Search,
    Scissors,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { resolveAssetUrl } from '../../utils/pathManager';
import { formatTimestampDate, parseTimestampMs } from '../../utils/time';
import { ConfirmDialog } from '../ConfirmDialog';
import { EditorLayoutToggleButton } from './EditorLayoutToggleButton';
import { appAlert, appConfirm } from '../../utils/appDialogs';
import type { GenerationIntent, ImmersiveMode, PendingChatMessage } from '../../App';
import { useMediaJobSubscription } from '../../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsStore } from '../../features/media-jobs/useMediaJobsStore';
import { isMediaJobSuccessful, isMediaJobTerminal, type MediaJobProjection } from '../../features/media-jobs/types';
import { usePageRefresh } from '../../hooks/usePageRefresh';
import { composeMarkdownWithFrontmatter, parseMarkdownFrontmatter } from '../../utils/markdownFrontmatter';
import { uiDebug, uiMeasure } from '../../utils/uiDebug';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../../shared/redboxVideo';
import type { RemotionCompositionConfig } from './remotion/types';
import type { EditorProjectFile } from './editorProject';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel, LiquidGlassMenuSeparator } from '@/components/ui/liquid-glass-menu';
import { buildEditorSessionBinding, type EditorAiWorkspaceMode } from '../../features/chat/editorSessionBinding';
import {
    ensureManuscriptFileName,
    renameManuscriptKeepingExtension,
    stripManuscriptExtension,
} from '../../../shared/manuscriptFiles';

const VideoDraftWorkbench = lazy(async () => ({
    default: (await import('./ExperimentalVideoWorkbench')).ExperimentalVideoWorkbench,
}));
const VideoEditorV2Workbench = lazy(async () => ({
    default: (await import('../video-editor-v2/VideoEditorV2Workbench')).VideoEditorV2Workbench,
}));
const AudioDraftWorkbench = lazy(async () => ({
    default: (await import('./AudioDraftWorkbench')).AudioDraftWorkbench,
}));
const WritingDraftWorkbench = lazy(async () => ({
    default: (await import('./WritingDraftWorkbench')).WritingDraftWorkbench,
}));

type DraftFilter = 'all' | 'drafts' | 'media' | 'image' | 'video' | 'audio' | 'folders';
type DraftLayout = 'gallery' | 'list';
type CreateKind = 'folder' | 'longform' | 'video' | 'audio';
type FileNode = {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    status?: 'writing' | 'completed' | 'abandoned';
    title?: string;
    draftType?: CreateKind | 'unknown';
    updatedAt?: number;
    summary?: string;
};

type MediaAssetSource = 'generated' | 'planned' | 'imported' | 'external';

type MediaAsset = {
    id: string;
    source: MediaAssetSource;
    projectId?: string;
    title?: string;
    prompt?: string;
    provider?: string;
    providerTemplate?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
    mimeType?: string;
    relativePath?: string;
    boundManuscriptPath?: string;
    createdAt: string;
    updatedAt: string;
    absolutePath?: string;
    previewUrl?: string;
    exists?: boolean;
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

type ReferenceImageItem = {
    name: string;
    dataUrl: string;
};

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

type ManuscriptReadResult = {
    content?: string;
    metadata?: Record<string, unknown>;
};

type ManuscriptWriteProposal = {
    id: string;
    filePath: string;
    sessionId?: string | null;
    toolCallId?: string | null;
    draftType?: string | null;
    title?: string | null;
    metadata?: Record<string, unknown> | null;
    baseContent: string;
    proposedContent: string;
    createdAt: string;
    updatedAt: string;
};

type FileCardMeta = {
    title: string;
    draftType: CreateKind | 'unknown';
    updatedAt?: number;
    summary: string;
};

type DraftCard = {
    id: string;
    kind: 'draft';
    updatedAt: number;
    createdAt: number;
    file: FileNode;
    meta?: FileCardMeta;
    title: string;
    summary: string;
    draftType: CreateKind | 'unknown';
};

type EditorDescriptor = {
    title: string;
    draftType: CreateKind | 'unknown';
};

type FolderContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    folderPath: string;
    folderName: string;
};

type AssetContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    assetId: string;
    assetTitle: string;
};

type DraftContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    filePath: string;
    title: string;
};

type VideoScriptApprovalState = {
    status?: 'pending' | 'confirmed';
    lastScriptUpdateAt?: number | null;
    lastScriptUpdateSource?: string | null;
    confirmedAt?: number | null;
};

type VideoProjectState = {
    scriptBody?: string;
    scriptApproval?: VideoScriptApprovalState;
    assets?: Array<Record<string, unknown>>;
    baseMedia?: {
        sourceAssetIds?: string[];
        outputPath?: string | null;
        durationMs?: number;
        width?: number | null;
        height?: number | null;
        status?: string;
        updatedAt?: number | null;
    };
    ffmpegRecipeSummary?: string | null;
    remotion?: RemotionCompositionConfig | null;
    renderOutput?: string | null;
    legacy?: Record<string, unknown>;
};

type PackageState = {
    manifest?: Record<string, unknown>;
    assets?: { items?: Array<Record<string, unknown>> };
    cover?: Record<string, unknown>;
    images?: { items?: Array<Record<string, unknown>> };
    remotion?: RemotionCompositionConfig & {
        render?: {
            outputPath?: string;
            renderedAt?: number;
            durationInFrames?: number;
        };
    };
    timelineSummary?: {
        trackCount?: number;
        clipCount?: number;
        sourceRefs?: Array<Record<string, unknown>>;
        clips?: Array<Record<string, unknown>>;
        trackNames?: string[];
        trackUi?: Record<string, unknown>;
    };
    editorProject?: EditorProjectFile | null;
    videoProject?: VideoProjectState | null;
    contentMapExists?: boolean;
    contentMapFile?: string | null;
    contentMapUpdatedAt?: number | null;
};

type ExportVideoResolution = 'source' | '1080p' | '720p';

const DEFAULT_UNTITLED_DRAFT_TITLE = '未命名';
function resolveDraftExtension(kind: CreateKind | 'unknown'): string {
    if (kind === 'longform' || kind === 'video' || kind === 'audio') return '';
    return '.md';
}

function stripDraftExtension(fileName: string): string {
    return stripManuscriptExtension(fileName);
}

function exportResolutionDimensions(
    width: number,
    height: number,
    preset: ExportVideoResolution,
): { width: number; height: number } {
    const safeWidth = Math.max(1, width || 1);
    const safeHeight = Math.max(1, height || 1);
    if (preset === 'source') {
        return { width: safeWidth, height: safeHeight };
    }
    const landscape = safeWidth > safeHeight;
    const portrait = safeHeight > safeWidth;
    const target = preset === '720p'
        ? landscape
            ? { width: 1280, height: 720 }
            : portrait
                ? { width: 720, height: 1280 }
                : { width: 720, height: 720 }
        : landscape
            ? { width: 1920, height: 1080 }
            : portrait
                ? { width: 1080, height: 1920 }
                : { width: 1080, height: 1080 };
    const scale = Math.min(target.width / safeWidth, target.height / safeHeight, 1);
    return {
        width: Math.max(1, Math.round(safeWidth * scale)),
        height: Math.max(1, Math.round(safeHeight * scale)),
    };
}

function ensureDraftFileName(baseName: string, kind: CreateKind | 'unknown'): string {
    const extension = resolveDraftExtension(kind);
    return extension ? ensureManuscriptFileName(baseName, extension as '.md') : baseName;
}

interface ManuscriptEditorHostProps {
    filePath: string;
    onNavigateToRedClaw?: (message: PendingChatMessage) => void;
    onNavigateToGenerationStudio?: (intent: GenerationIntent) => void;
    isActive?: boolean;
    onClose?: () => void;
    onImmersiveModeChange?: (mode: ImmersiveMode) => void;
}

const CREATE_KIND_OPTIONS: Array<{ id: CreateKind; label: string; icon: typeof FileText; accentClass: string; available: boolean; unavailableHint?: string }> = [
    { id: 'longform', label: '长文', icon: FileText, accentClass: 'from-[#E8D9FF] via-[#F6EEFF] to-white text-[#7C57C8]', available: true },
    { id: 'video', label: '视频', icon: Clapperboard, accentClass: 'from-[#D6E7FF] via-[#EEF5FF] to-white text-[#4C76D8]', available: false, unavailableHint: '正在开发中' },
    { id: 'audio', label: '音频', icon: AudioLines, accentClass: 'from-[#D8F6E8] via-[#EFFCF5] to-white text-[#2E8B65]', available: false, unavailableHint: '正在开发中' },
];

const CREATE_KIND_OPTION_MAP: Record<CreateKind, (typeof CREATE_KIND_OPTIONS)[number]> = CREATE_KIND_OPTIONS.reduce((acc, option) => {
    acc[option.id] = option;
    return acc;
}, {} as Record<CreateKind, (typeof CREATE_KIND_OPTIONS)[number]>);

const FILTER_OPTIONS: Array<{ id: DraftFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'drafts', label: '稿件' },
    { id: 'media', label: '素材' },
    { id: 'image', label: '图片' },
    { id: 'video', label: '视频' },
    { id: 'audio', label: '音频' },
    { id: 'folders', label: '文件夹' },
];

const MANUSCRIPTS_INITIAL_ASSET_LIMIT = 0;
const MANUSCRIPTS_ACTIVE_ASSET_LIMIT = 60;
const MANUSCRIPTS_CARD_RENDER_LIMIT = 80;

const IMAGE_ASPECT_RATIO_OPTIONS = [
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: 'auto', label: 'auto' },
] as const;

const VIDEO_ASPECT_RATIO_OPTIONS = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
] as const;

const VIDEO_GENERATION_MODE_OPTIONS = [
    { value: 'text-to-video', label: '文生视频' },
    { value: 'reference-guided', label: '参考图视频' },
    { value: 'first-last-frame', label: '首尾帧视频' },
] as const;

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

function getCurrentFolderChildren(tree: FileNode[], folderPath: string): FileNode[] {
    if (!folderPath) return tree;
    const walk = (items: FileNode[]): FileNode[] | null => {
        for (const item of items) {
            if (item.path === folderPath && item.isDirectory) {
                return item.children || [];
            }
            if (item.isDirectory) {
                const nested = walk(item.children || []);
                if (nested) return nested;
            }
        }
        return null;
    };
    return walk(tree) || [];
}

function collectNestedFiles(items: FileNode[]): FileNode[] {
    const result: FileNode[] = [];
    const walk = (nodes: FileNode[]) => {
        for (const node of nodes) {
            if (node.isDirectory) {
                walk(node.children || []);
            } else {
                result.push(node);
            }
        }
    };
    walk(items);
    return result;
}

function isInternalPackageFile(filePath: string): boolean {
    return String(filePath || '').replace(/\\/g, '/').split('/').some((part) => part === 'manifest.json');
}

function isPackageDraftPath(filePath: string): boolean {
    return !filePath.endsWith('.md');
}

function getFolderTrail(folderPath: string): Array<{ label: string; path: string }> {
    if (!folderPath) return [{ label: '全部草稿', path: '' }];
    const parts = folderPath.split('/').filter(Boolean);
    const trail = [{ label: '全部草稿', path: '' }];
    let cursor = '';
    for (const part of parts) {
        cursor = cursor ? `${cursor}/${part}` : part;
        trail.push({ label: part, path: cursor });
    }
    return trail;
}

function getParentFolderPath(folderPath: string): string {
    const parts = folderPath.split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/');
}

function getRelativeFolderPath(filePath: string): string {
    const normalized = String(filePath || '').replace(/\\/g, '/').trim();
    if (!normalized) return '';
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/');
}

function buildMediaFolderTree(assets: MediaAsset[]): FileNode[] {
    const root: FileNode[] = [];

    const ensureChildFolder = (items: FileNode[], name: string, fullPath: string): FileNode => {
        let existing = items.find((item) => item.isDirectory && item.path === fullPath);
        if (!existing) {
            existing = {
                name,
                path: fullPath,
                isDirectory: true,
                children: [],
            };
            items.push(existing);
        }
        return existing;
    };

    for (const asset of assets) {
        const folderPath = getRelativeFolderPath(asset.relativePath || '');
        if (!folderPath) continue;
        const parts = folderPath.split('/').filter(Boolean);
        let currentItems = root;
        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = ensureChildFolder(currentItems, part, currentPath);
            currentItems = folder.children || [];
            folder.children = currentItems;
        }
    }

    const sortNodes = (items: FileNode[]) => {
        items.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
        for (const item of items) {
            if (item.children?.length) {
                sortNodes(item.children);
            }
        }
    };

    sortNodes(root);
    return root;
}

function buildDraftTemplate(title: string, kind: Exclude<CreateKind, 'folder'>): string {
    const ts = Date.now();
    const safeTitle = title.trim() || DEFAULT_UNTITLED_DRAFT_TITLE;
    const sectionTitle = kind === 'video'
        ? '视频脚本'
        : kind === 'audio'
            ? '音频脚本'
            : '长文草稿';

    if (kind === 'video' || kind === 'audio') {
        return `# ${safeTitle}\n\n## ${sectionTitle}\n\n## 剪辑目标\n\n\n## 时间线规划\n\n\n## 素材备注\n\n`;
    }

    const quotedTitle = JSON.stringify(safeTitle);

    return `---\nid: draft_${ts}\ntitle: ${quotedTitle}\ndraftType: ${kind}\nstatus: writing\ncreatedAt: ${ts}\nupdatedAt: ${ts}\n---\n\n# ${safeTitle}\n\n## ${sectionTitle}\n\n`;
}

function shouldHideFrontmatterInEditor(draftType: CreateKind | 'unknown' | null | undefined): boolean {
    return draftType !== 'video' && draftType !== 'audio';
}

function splitWritingDraftContent(content: string, draftType: CreateKind | 'unknown' | null | undefined) {
    const source = String(content || '');
    if (!shouldHideFrontmatterInEditor(draftType)) {
        return {
            body: source,
            frontmatterBlock: null as string | null,
        };
    }
    const parsed = parseMarkdownFrontmatter(source);
    if (!parsed.hasFrontmatter) {
        return {
            body: source,
            frontmatterBlock: null as string | null,
        };
    }
    return {
        body: parsed.body,
        frontmatterBlock: parsed.block,
    };
}

function normalizeDraftFileName(input: string): string {
    const trimmed = input.trim();
    const sanitized = trimmed.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
    return sanitized || `untitled-${Date.now()}`;
}

function buildDraftStorageName(): string {
    return `manuscript-${Date.now()}`;
}

function pathBasenameSafe(rawPath: string): string {
    const normalized = String(rawPath || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}

function normalizeAssetKindReference(value: string | null | undefined): string {
    const trimmed = String(value || '').trim().toLowerCase();
    if (!trimmed) return '';
    return trimmed.split(/[?#]/, 1)[0] || '';
}

function isSameDraftRelativePath(left: string | null | undefined, right: string | null | undefined): boolean {
    return String(left || '').replace(/\\/g, '/').trim() === String(right || '').replace(/\\/g, '/').trim();
}

function inferAssetKind(asset: MediaAsset): 'image' | 'video' | 'audio' | 'unknown' {
    const mime = String(asset.mimeType || '').toLowerCase();
    const refs = [
        normalizeAssetKindReference(asset.relativePath),
        normalizeAssetKindReference(asset.previewUrl),
        normalizeAssetKindReference(asset.absolutePath),
        normalizeAssetKindReference(asset.title),
    ].filter(Boolean);
    const ref = refs.join(' ');
    if (mime.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg|heic|heif|avif|jfif)$/i.test(ref)) return 'image';
    if (mime.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv|mpg|mpeg|m2ts|mts|ts|3gp|wmv|flv)$/i.test(ref)) return 'video';
    if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff|aif|caf)$/i.test(ref)) return 'audio';
    return 'unknown';
}


function isVideoAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(String(asset.relativePath || '').trim());
}

function getVideoReferenceModeHint(mode: 'text-to-video' | 'reference-guided' | 'first-last-frame'): string {
    if (mode === 'reference-guided') {
        return '上传 1 到 5 张参考图，视频会尽量复用这些图中的主体元素、风格和构图线索。';
    }
    if (mode === 'first-last-frame') {
        return '请上传 2 张图片，第一张作为首帧，第二张作为尾帧。';
    }
    return '文生视频不需要参考图。';
}

function generatedAssetsFromMediaJob(job: MediaJobProjection | null | undefined): GeneratedAsset[] {
    if (!job) return [];
    return job.artifacts
        .map((artifact) => {
            const metadata = artifact.metadata;
            if (!metadata || typeof metadata !== 'object') return null;
            const record = metadata as Record<string, unknown>;
            if (typeof record.id !== 'string') return null;
            return {
                id: record.id,
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
                updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : job.updatedAt,
            } satisfies GeneratedAsset;
        })
        .filter(Boolean) as GeneratedAsset[];
}

function mediaJobErrorMessage(job: MediaJobProjection | null | undefined, fallback: string): string {
    if (!job) return fallback;
    const attemptError = job.attempt?.lastError;
    if (typeof attemptError === 'string' && attemptError.trim()) return attemptError;
    const resultError = job.result && typeof job.result === 'object'
        ? (job.result as Record<string, unknown>).error
        : null;
    if (typeof resultError === 'string' && resultError.trim()) return resultError;
    if (typeof job.cancelReason === 'string' && job.cancelReason.trim()) return job.cancelReason;
    return fallback;
}

function sortMediaJobsByRecency(jobs: MediaJobProjection[]): MediaJobProjection[] {
    return [...jobs].sort((left, right) => {
        const updatedDelta = parseTimestampMs(right.updatedAt) - parseTimestampMs(left.updatedAt);
        if (updatedDelta !== 0) return updatedDelta;
        return parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt);
    });
}

function inferImageAspectFromSize(size: string): string {
    const matched = String(size || '').trim().match(/^(\d{2,5})x(\d{2,5})$/i);
    if (!matched) return '';
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
    const ratio = width / height;
    const candidates: Array<{ label: string; value: number }> = [
        { label: '1:1', value: 1 },
        { label: '3:4', value: 3 / 4 },
        { label: '4:3', value: 4 / 3 },
        { label: '9:16', value: 9 / 16 },
        { label: '16:9', value: 16 / 9 },
    ];
    let best = '';
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const delta = Math.abs(ratio - candidate.value);
        if (delta < bestDelta) {
            best = candidate.label;
            bestDelta = delta;
        }
    }
    return bestDelta <= 0.04 ? best : '';
}

function formatDateLabel(input?: string | number): string {
    return formatTimestampDate(input);
}

function resolveDraftTypeLabel(type: CreateKind | 'unknown'): string {
    if (type === 'longform') return '长文';
    if (type === 'video') return '视频';
    if (type === 'audio') return '音频';
    return '稿件';
}

function resolveDraftTypeStyle(type: CreateKind | 'unknown'): { chip: string; tile: string; iconWrap: string } {
    if (type === 'video') {
        return {
            chip: 'bg-rose-500/10 text-rose-600 border border-rose-200/80',
            tile: 'bg-[linear-gradient(135deg,#231942_0%,#5e548e_52%,#9f86c0_100%)] text-white',
            iconWrap: 'bg-white/15 text-white',
        };
    }
    if (type === 'audio') {
        return {
            chip: 'bg-emerald-500/10 text-emerald-700 border border-emerald-200/90',
            tile: 'bg-[linear-gradient(135deg,#113c37_0%,#1f7a72_50%,#91e5d8_100%)] text-white',
            iconWrap: 'bg-white/15 text-white',
        };
    }
    return {
        chip: 'bg-sky-500/10 text-sky-700 border border-sky-200/90',
        tile: 'bg-[linear-gradient(135deg,#10253f_0%,#315e8f_54%,#d6ecff_100%)] text-white',
        iconWrap: 'bg-white/15 text-white',
    };
}

function summaryFromContent(content: string): string {
    const plain = String(content || '')
        .replace(/^#+\s+/gm, '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/[*_>`~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.slice(0, 72);
}

function collectFileMetaMap(nodes: FileNode[]): Record<string, FileCardMeta> {
    const next: Record<string, FileCardMeta> = {};
    const visit = (items: FileNode[]) => {
        for (const item of items) {
            if (item.isDirectory) {
                visit(item.children || []);
                continue;
            }
            next[item.path] = {
                title: item.title || DEFAULT_UNTITLED_DRAFT_TITLE,
                draftType: item.draftType || 'unknown',
                updatedAt: Number(item.updatedAt || 0) || undefined,
                summary: item.summary || '',
            };
        }
    };
    visit(nodes);
    return next;
}

export function ManuscriptEditorHost({ filePath, onNavigateToRedClaw, onNavigateToGenerationStudio, isActive = false, onClose, onImmersiveModeChange }: ManuscriptEditorHostProps) {
    const [mode, setMode] = useState<'editor'>('editor');
    const [editorFile, setEditorFile] = useState<string | null>(null);
    const [editorDescriptor, setEditorDescriptor] = useState<EditorDescriptor | null>(null);
    const [tree, setTree] = useState<FileNode[]>([]);
    const [assets, setAssets] = useState<MediaAsset[]>([]);
    const [loading, setLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [activeFolder, setActiveFolder] = useState('');
    const [mediaFolder, setMediaFolder] = useState('');
    const [query, setQuery] = useState('');
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [filter, setFilter] = useState<DraftFilter>('all');
    const [layout, setLayout] = useState<DraftLayout>('gallery');
    const [createOpen, setCreateOpen] = useState(false);
    const [folderCreateOpen, setFolderCreateOpen] = useState(false);
    const [createKind, setCreateKind] = useState<CreateKind>('longform');
    const [folderCreateTitle, setFolderCreateTitle] = useState('');
    const [folderRenameOpen, setFolderRenameOpen] = useState(false);
    const [folderRenamePath, setFolderRenamePath] = useState('');
    const [folderRenameTitle, setFolderRenameTitle] = useState('');
    const [assetRenameOpen, setAssetRenameOpen] = useState(false);
    const [assetRenameId, setAssetRenameId] = useState('');
    const [assetRenameTitle, setAssetRenameTitle] = useState('');
    const [draftRenameOpen, setDraftRenameOpen] = useState(false);
    const [draftRenamePath, setDraftRenamePath] = useState('');
    const [draftRenameTitle, setDraftRenameTitle] = useState('');
    const [isEditorTitleEditing, setIsEditorTitleEditing] = useState(false);
    const [editorTitleDraft, setEditorTitleDraft] = useState('');
    const [isEditorTitleSaving, setIsEditorTitleSaving] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        folderPath: '',
        folderName: '',
    });
    const [assetContextMenu, setAssetContextMenu] = useState<AssetContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        assetId: '',
        assetTitle: '',
    });
    const [draftContextMenu, setDraftContextMenu] = useState<DraftContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        filePath: '',
        title: '',
    });
    const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
    const [workingId, setWorkingId] = useState<string | null>(null);
    const [pendingDeleteDraftPath, setPendingDeleteDraftPath] = useState<string | null>(null);
    const [settings, setSettings] = useState<SettingsShape>({});
    const [isImageModalOpen, setIsImageModalOpen] = useState(false);
    const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [genProjectId, setGenProjectId] = useState('');
    const [genTitle, setGenTitle] = useState('');
    const [count, setCount] = useState(1);
    const [model, setModel] = useState('');
    const [aspectRatio, setAspectRatio] = useState('3:4');
    const [size, setSize] = useState('');
    const [quality, setQuality] = useState('auto');
    const [generationMode, setGenerationMode] = useState<'text-to-image' | 'reference-guided' | 'image-to-image'>('text-to-image');
    const [referenceImages, setReferenceImages] = useState<ReferenceImageItem[]>([]);
    const [isReadingRefImages, setIsReadingRefImages] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [genError, setGenError] = useState('');
    const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
    const [activeImageJobId, setActiveImageJobId] = useState<string | null>(null);
    const [videoPrompt, setVideoPrompt] = useState('');
    const [videoProjectId, setVideoProjectId] = useState('');
    const [videoTitle, setVideoTitle] = useState('');
    const [videoGenerationMode, setVideoGenerationMode] = useState<'text-to-video' | 'reference-guided' | 'first-last-frame'>('text-to-video');
    const [videoReferenceImages, setVideoReferenceImages] = useState<Array<ReferenceImageItem | null>>([]);
    const [videoPrimaryReferenceImage, setVideoPrimaryReferenceImage] = useState<ReferenceImageItem | null>(null);
    const [videoLastFrameImage, setVideoLastFrameImage] = useState<ReferenceImageItem | null>(null);
    const [isReadingVideoRefImages, setIsReadingVideoRefImages] = useState(false);
    const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16'>('16:9');
    const [videoResolution, setVideoResolution] = useState<'720p' | '1080p'>('720p');
    const [videoDurationSeconds, setVideoDurationSeconds] = useState(8);
    const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
    const [videoGenError, setVideoGenError] = useState('');
    const [generatedVideoAssets, setGeneratedVideoAssets] = useState<GeneratedAsset[]>([]);
    const [activeVideoJobId, setActiveVideoJobId] = useState<string | null>(null);
    const [videoWorkbenchVersion, setVideoWorkbenchVersion] = useState<'v2' | 'legacy'>('legacy');
    const [packageState, setPackageState] = useState<PackageState | null>(null);
    const [isGeneratingRemotion, setIsGeneratingRemotion] = useState(false);
    const [isRenderingRemotion, setIsRenderingRemotion] = useState(false);
    const [isExportVideoModalOpen, setIsExportVideoModalOpen] = useState(false);
    const [exportVideoResolution, setExportVideoResolution] = useState<ExportVideoResolution>('1080p');
    const [exportVideoPath, setExportVideoPath] = useState('');
    const [exportVideoProgress, setExportVideoProgress] = useState(0);
    const [exportVideoStage, setExportVideoStage] = useState('');
    const [exportVideoError, setExportVideoError] = useState('');
    const [bindAssetRole, setBindAssetRole] = useState<'cover' | 'image' | 'asset'>('image');
    const [isBindAssetModalOpen, setIsBindAssetModalOpen] = useState(false);
    const [editorChatSessionId, setEditorChatSessionId] = useState<string | null>(null);
    const [editorChatSessionReady, setEditorChatSessionReady] = useState(false);
    const [editorBody, setEditorBody] = useState('');
    const [editorFrontmatterBlock, setEditorFrontmatterBlock] = useState<string | null>(null);
    const [editorMetadata, setEditorMetadata] = useState<Record<string, unknown>>({});
    const [editorWriteProposal, setEditorWriteProposal] = useState<ManuscriptWriteProposal | null>(null);
    const [editorReviewBody, setEditorReviewBody] = useState('');
    const [editorBodyDirty, setEditorBodyDirty] = useState(false);
    const [isSavingEditorBody, setIsSavingEditorBody] = useState(false);
    const [isApplyingWriteProposal, setIsApplyingWriteProposal] = useState(false);
    const [isRejectingWriteProposal, setIsRejectingWriteProposal] = useState(false);
    const [editorAiWorkspaceMode, setEditorAiWorkspaceMode] = useState<EditorAiWorkspaceMode>({
        id: 'manuscript-editing',
        label: '稿件编辑',
    });
    const [immersiveMaterialsCollapsed, setImmersiveMaterialsCollapsed] = useState(false);
    const [immersiveTimelineCollapsed, setImmersiveTimelineCollapsed] = useState(false);
    const treeRequestIdRef = useRef(0);
    const assetsRequestIdRef = useRef(0);
    const hasLoadedSnapshotRef = useRef(false);
    const deferredAssetsTimerRef = useRef<number | null>(null);
    const searchPopoverRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const editorTitleInputRef = useRef<HTMLInputElement | null>(null);
    const folderContextMenuRef = useRef<HTMLDivElement | null>(null);
    const assetContextMenuRef = useRef<HTMLDivElement | null>(null);
    const draftContextMenuRef = useRef<HTMLDivElement | null>(null);
    const editorFileRef = useRef<string | null>(null);
    const editorBodyRef = useRef('');
    const editorReviewBodyRef = useRef('');
    const editorReviewProposalIdRef = useRef<string | null>(null);
    const editorFrontmatterBlockRef = useRef<string | null>(null);
    const editorMetadataRef = useRef<Record<string, unknown>>({});
    const editorBodyDirtyRef = useRef(false);
    const editorSavePromiseRef = useRef<Promise<boolean> | null>(null);
    const skipEditorTitleBlurCommitRef = useRef(false);
    const handledImageTerminalJobIdRef = useRef<string | null>(null);
    const handledVideoTerminalJobIdRef = useRef<string | null>(null);
    const trackedJobsById = useMediaJobsStore((state) => state.jobsById);
    const fileMetaMap = useMemo(() => collectFileMetaMap(tree), [tree]);
    const isMediaScope = filter === 'media' || filter === 'image' || filter === 'video' || filter === 'audio';
    const mediaFolderTree = useMemo(() => buildMediaFolderTree(assets), [assets]);
    const currentEditorContent = useMemo(
        () => composeMarkdownWithFrontmatter(editorBody, editorFrontmatterBlock),
        [editorBody, editorFrontmatterBlock]
    );
    const manuscriptJobBootstrapFilter = useMemo(
        () => (editorFile ? { source: 'manuscripts', manuscriptPath: editorFile, limit: 40 } : null),
        [editorFile],
    );

    useEffect(() => {
        if (isEditorTitleEditing) {
            window.requestAnimationFrame(() => {
                editorTitleInputRef.current?.focus();
                editorTitleInputRef.current?.select();
            });
        }
    }, [isEditorTitleEditing]);

    useEffect(() => {
        if (!isEditorTitleEditing) {
            setEditorTitleDraft(editorDescriptor?.title || '');
        }
    }, [editorDescriptor?.title, isEditorTitleEditing]);

    const manuscriptMediaJobs = useMemo(
        () => sortMediaJobsByRecency(
            Object.values(trackedJobsById).filter((job) => (
                job.source === 'manuscripts' && isSameDraftRelativePath(job.manuscriptPath, editorFile)
            )),
        ),
        [editorFile, trackedJobsById],
    );
    const trackedMediaJobIds = useMemo(() => {
        const ids = new Set<string>();
        if (activeImageJobId) ids.add(activeImageJobId);
        if (activeVideoJobId) ids.add(activeVideoJobId);
        for (const job of manuscriptMediaJobs) {
            ids.add(job.jobId);
        }
        return Array.from(ids);
    }, [activeImageJobId, activeVideoJobId, manuscriptMediaJobs]);
    const currentImageJob = useMemo(() => {
        if (activeImageJobId) {
            const activeJob = trackedJobsById[activeImageJobId];
            if (activeJob && activeJob.kind === 'image' && isSameDraftRelativePath(activeJob.manuscriptPath, editorFile)) {
                return activeJob;
            }
        }
        return manuscriptMediaJobs.find((job) => job.kind === 'image') || null;
    }, [activeImageJobId, editorFile, manuscriptMediaJobs, trackedJobsById]);
    const currentVideoJob = useMemo(() => {
        if (activeVideoJobId) {
            const activeJob = trackedJobsById[activeVideoJobId];
            if (activeJob && activeJob.kind === 'video' && isSameDraftRelativePath(activeJob.manuscriptPath, editorFile)) {
                return activeJob;
            }
        }
        return manuscriptMediaJobs.find((job) => job.kind === 'video') || null;
    }, [activeVideoJobId, editorFile, manuscriptMediaJobs, trackedJobsById]);

    useMediaJobSubscription(trackedMediaJobIds, {
        enabled: isActive && Boolean(editorFile),
        bootstrapFilter: manuscriptJobBootstrapFilter,
    });

    useEffect(() => {
        editorFileRef.current = editorFile;
    }, [editorFile]);

    useEffect(() => {
        editorBodyRef.current = editorBody;
    }, [editorBody]);

    useEffect(() => {
        editorReviewBodyRef.current = editorReviewBody;
    }, [editorReviewBody]);

    useEffect(() => {
        editorFrontmatterBlockRef.current = editorFrontmatterBlock;
    }, [editorFrontmatterBlock]);

    useEffect(() => {
        editorMetadataRef.current = editorMetadata;
    }, [editorMetadata]);

    useEffect(() => {
        editorBodyDirtyRef.current = editorBodyDirty;
    }, [editorBodyDirty]);

    useEffect(() => {
        setActiveImageJobId(null);
        setActiveVideoJobId(null);
        setIsGenerating(false);
        setIsGeneratingVideo(false);
        setGenError('');
        setVideoGenError('');
        setGeneratedAssets([]);
        setGeneratedVideoAssets([]);
        handledImageTerminalJobIdRef.current = null;
        handledVideoTerminalJobIdRef.current = null;
    }, [editorFile]);

    useEffect(() => () => {
    }, [videoGenerationMode]);

    const loadTree = useCallback(async () => {
        const requestId = ++treeRequestIdRef.current;
        try {
            const treeResult = await uiMeasure('manuscripts', 'load_tree', async () => (
                window.ipcRenderer.invoke('manuscripts:list') as Promise<FileNode[]>
            ), { requestId, mode, isActive });
            if (requestId !== treeRequestIdRef.current) return;
            setTree(Array.isArray(treeResult) ? treeResult : []);
        } catch (loadError) {
            if (requestId !== treeRequestIdRef.current) return;
            console.error('Failed to load drafts hub:', loadError);
            setError(loadError instanceof Error ? loadError.message : '加载草稿失败');
            if (!hasLoadedSnapshotRef.current) {
                setTree([]);
            }
            throw loadError;
        }
    }, []);

    const loadAssets = useCallback(async (limit = MANUSCRIPTS_ACTIVE_ASSET_LIMIT) => {
        const requestId = ++assetsRequestIdRef.current;
        try {
            const mediaResult = await uiMeasure('manuscripts', 'load_assets', async () => (
                window.ipcRenderer.invoke('media:list', { limit }) as Promise<{ success?: boolean; assets?: MediaAsset[]; error?: string }>
            ), { requestId, mode, isActive, limit });
            if (requestId !== assetsRequestIdRef.current) return;
            if (!mediaResult?.success) {
                throw new Error(mediaResult?.error || '加载媒体资产失败');
            }
            setAssets(Array.isArray(mediaResult.assets) ? mediaResult.assets : []);
        } catch (loadError) {
            if (requestId !== assetsRequestIdRef.current) return;
            console.error('Failed to load draft media assets:', loadError);
            if (!hasLoadedSnapshotRef.current) {
                setAssets([]);
            }
            throw loadError;
        }
    }, [isActive, mode]);

    const loadData = useCallback(async () => {
        uiDebug('manuscripts', 'load_data:start', { mode, isActive, hasSnapshot: hasLoadedSnapshotRef.current });
        if (hasLoadedSnapshotRef.current) {
            setIsRefreshing(true);
        } else {
            setLoading(true);
        }
        setError('');
        try {
            await Promise.all([loadTree(), loadAssets(MANUSCRIPTS_INITIAL_ASSET_LIMIT)]);
            hasLoadedSnapshotRef.current = true;
            uiDebug('manuscripts', 'load_data:done', {
                mode,
                isActive,
                treeCount: tree.length,
                assetCount: assets.length,
            });
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : '加载草稿失败');
        } finally {
            setLoading(false);
            setIsRefreshing(false);
        }
    }, [assets.length, isActive, loadAssets, loadTree, mode, tree.length]);

    const handleImportMediaFiles = useCallback(async () => {
        setWorkingId('media-import');
        try {
            const result = await window.ipcRenderer.invoke('media:import-files') as {
                success?: boolean;
                canceled?: boolean;
                error?: string;
                added?: number;
            };
            if (result?.canceled) {
                return;
            }
            if (!result?.success) {
                throw new Error(result?.error || '导入素材失败');
            }
            await loadData();
        } catch (importError) {
            void appAlert(importError instanceof Error ? importError.message : '导入素材失败');
        } finally {
            setWorkingId(null);
        }
    }, [loadData]);

    const loadSettings = useCallback(async () => {
        try {
            const loaded = await window.ipcRenderer.getSettings();
            const next = (loaded || {}) as SettingsShape;
            setSettings(next);
            setModel(next.image_model || 'gpt-image-1');
            setAspectRatio(next.image_aspect_ratio || '3:4');
            setSize(next.image_size || '');
            setQuality(next.image_quality || 'auto');
        } catch (settingsError) {
            console.error('Failed to load image settings:', settingsError);
        }
    }, []);

    const refreshWorkspace = useCallback(async () => {
        // Keep editor interactions smooth: skip heavy media refresh while actively editing.
        if (mode === 'editor') {
            uiDebug('manuscripts', 'refresh_workspace:editor_fast_path');
            await loadTree();
            return;
        }
        uiDebug('manuscripts', 'refresh_workspace:gallery_split_load');
        if (hasLoadedSnapshotRef.current) {
            setIsRefreshing(true);
        } else {
            setLoading(true);
        }
        setError('');
        try {
            await loadTree();
            hasLoadedSnapshotRef.current = true;
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : '加载草稿失败');
        } finally {
            setLoading(false);
        }
        if (deferredAssetsTimerRef.current != null) {
            window.clearTimeout(deferredAssetsTimerRef.current);
        }
        deferredAssetsTimerRef.current = window.setTimeout(() => {
            deferredAssetsTimerRef.current = null;
            void loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT).finally(() => setIsRefreshing(false));
        }, 0);
    }, [loadAssets, loadTree, mode]);

    usePageRefresh({
        isActive,
        refresh: refreshWorkspace,
    });

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        uiDebug('manuscripts', isActive ? 'view_activate' : 'view_deactivate', { mode, editorFile });
    }, [editorFile, isActive, mode]);

    useEffect(() => {
        if (!isActive) return;
        const handleDataChanged = (_event: unknown, payload?: { scope?: string }) => {
            if (payload?.scope === 'manuscripts') {
                void loadTree();
                return;
            }
            if (payload?.scope === 'media') {
                void loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT);
            }
        };
        window.ipcRenderer.on('data:changed', handleDataChanged);
        return () => {
            window.ipcRenderer.off('data:changed', handleDataChanged);
        };
    }, [isActive, loadAssets, loadTree]);

    useEffect(() => {
        if (!isActive) return;
        void loadSettings();
    }, [isActive, loadSettings]);

    useEffect(() => {
        if (!isActive) return;
        if (mode === 'editor') return;
        if (!['media', 'image', 'video', 'audio'].includes(filter)) return;
        if (assets.length > 0) return;
        uiDebug('manuscripts', 'load_assets:on_demand');
        void loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT);
    }, [assets.length, filter, isActive, loadAssets, mode]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        uiDebug('manuscripts', isActive ? 'view_activate' : 'view_deactivate', { mode, editorFile });
    }, [editorFile, isActive, mode]);

    useEffect(() => {
        return () => {
            if (deferredAssetsTimerRef.current != null) {
                window.clearTimeout(deferredAssetsTimerRef.current);
                deferredAssetsTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!isSearchOpen) return;
        const timer = window.setTimeout(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        }, 140);
        const handlePointerDown = (event: MouseEvent) => {
            if (!searchPopoverRef.current?.contains(event.target as Node)) {
                setIsSearchOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsSearchOpen(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isSearchOpen]);

    useEffect(() => {
        if (!folderContextMenu.visible) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (!folderContextMenuRef.current?.contains(event.target as Node)) {
                setFolderContextMenu((prev) => ({ ...prev, visible: false }));
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setFolderContextMenu((prev) => ({ ...prev, visible: false }));
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [folderContextMenu.visible]);

    useEffect(() => {
        if (!assetContextMenu.visible) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (!assetContextMenuRef.current?.contains(event.target as Node)) {
                setAssetContextMenu((prev) => ({ ...prev, visible: false }));
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setAssetContextMenu((prev) => ({ ...prev, visible: false }));
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [assetContextMenu.visible]);

    useEffect(() => {
        if (!draftContextMenu.visible) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (!draftContextMenuRef.current?.contains(event.target as Node)) {
                setDraftContextMenu((prev) => ({ ...prev, visible: false }));
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setDraftContextMenu((prev) => ({ ...prev, visible: false }));
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [draftContextMenu.visible]);

    useEffect(() => {
        return () => {
            if (deferredAssetsTimerRef.current != null) {
                window.clearTimeout(deferredAssetsTimerRef.current);
                deferredAssetsTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!size) return;
        const sizeAspect = inferImageAspectFromSize(size);
        if (sizeAspect && aspectRatio && aspectRatio !== 'auto' && sizeAspect !== aspectRatio) {
            setSize('');
        }
    }, [aspectRatio, size]);

    useEffect(() => {
        if (!filePath) return;
        void (async () => {
            setEditorFile(filePath);
            setMode('editor');
            try {
                const result = await window.ipcRenderer.invoke('manuscripts:read', filePath) as ManuscriptReadResult;
                const metadata = (result?.metadata || {}) as Record<string, unknown>;
                setEditorDescriptor({
                    title: String(metadata.title || '').trim() || DEFAULT_UNTITLED_DRAFT_TITLE,
                    draftType: (String(metadata.draftType || '').trim() as CreateKind | '') || 'unknown',
                });
            } catch {
                setEditorDescriptor({
                    title: DEFAULT_UNTITLED_DRAFT_TITLE,
                    draftType: 'unknown',
                });
            }
        })();
    }, [filePath]);

    const currentFolderChildren = useMemo(
        () => getCurrentFolderChildren(isMediaScope ? mediaFolderTree : tree, isMediaScope ? mediaFolder : activeFolder),
        [activeFolder, isMediaScope, mediaFolder, mediaFolderTree, tree],
    );
    const currentFolders = useMemo(() => currentFolderChildren.filter((item) => item.isDirectory), [currentFolderChildren]);
    const currentFiles = useMemo(
        () => (isMediaScope ? [] : currentFolderChildren.filter((item) => !item.isDirectory)),
        [currentFolderChildren, isMediaScope],
    );
    const currentNestedDraftFiles = useMemo(
        () => (isMediaScope ? [] : collectNestedFiles(currentFolderChildren)),
        [currentFolderChildren, isMediaScope],
    );

    const normalizedQuery = query.trim().toLowerCase();

    const visibleFolders = useMemo(() => {
        return currentFolders.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery));
    }, [currentFolders, normalizedQuery]);

    const visibleDrafts = useMemo(() => {
        if (filter !== 'all' && filter !== 'drafts') return [] as FileNode[];
        return currentNestedDraftFiles.filter((item) => {
            if (isInternalPackageFile(item.path)) return false;
            const meta = fileMetaMap[item.path];
            const haystack = `${item.name} ${meta?.title || ''} ${meta?.summary || ''}`.toLowerCase();
            return !normalizedQuery || haystack.includes(normalizedQuery);
        }).sort((left, right) => {
            const leftMeta = fileMetaMap[left.path];
            const rightMeta = fileMetaMap[right.path];
            const leftUpdatedAt = Number(leftMeta?.updatedAt || left.updatedAt || 0) || 0;
            const rightUpdatedAt = Number(rightMeta?.updatedAt || right.updatedAt || 0) || 0;
            if (rightUpdatedAt !== leftUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
            return right.path.localeCompare(left.path, 'zh-Hans-CN');
        });
    }, [currentNestedDraftFiles, fileMetaMap, filter, normalizedQuery]);

    const visibleAssets = useMemo(() => {
        if (filter === 'all' && activeFolder) return [] as MediaAsset[];
        return assets.filter((asset) => {
            const assetKind = inferAssetKind(asset);
            if (filter === 'media' && !['image', 'video', 'audio', 'unknown'].includes(assetKind)) return false;
            if (filter === 'image' && assetKind !== 'image') return false;
            if (filter === 'video' && assetKind !== 'video') return false;
            if (filter === 'audio' && assetKind !== 'audio') return false;
            if (filter === 'drafts' || filter === 'folders') return false;
            if (isMediaScope && mediaFolder && getRelativeFolderPath(asset.relativePath || '') !== mediaFolder) return false;
            const haystack = `${asset.title || ''} ${asset.prompt || ''} ${asset.relativePath || ''}`.toLowerCase();
            return !normalizedQuery || haystack.includes(normalizedQuery);
        });
    }, [activeFolder, assets, filter, isMediaScope, mediaFolder, normalizedQuery]);

    const activeTrail = useMemo(() => getFolderTrail(isMediaScope ? mediaFolder : activeFolder), [activeFolder, isMediaScope, mediaFolder]);
    const currentFolderPath = isMediaScope ? mediaFolder : activeFolder;

    const isSameOrNestedPath = useCallback((targetPath: string, currentPath: string | null | undefined) => {
        const target = String(targetPath || '').trim().replace(/\/+$/, '');
        const current = String(currentPath || '').trim().replace(/\/+$/, '');
        if (!target || !current) return false;
        return current === target || current.startsWith(`${target}/`);
    }, []);

    const handleCreateDraft = useCallback(async (kind: CreateKind = createKind) => {
        if (kind === 'folder') return;
        const createOption = CREATE_KIND_OPTION_MAP[kind];
        if (!createOption?.available) {
            void appAlert(createOption?.unavailableHint || `${createOption?.label || '该类型'}暂不可创建`);
            return;
        }
        setCreateKind(kind);
        setIsCreating(true);
        try {
            const storageName = buildDraftStorageName();
            const draftTitle = DEFAULT_UNTITLED_DRAFT_TITLE;
            const result = await window.ipcRenderer.invoke('manuscripts:create-file', {
                parentPath: activeFolder,
                name: ensureDraftFileName(storageName, kind),
                title: draftTitle,
                content: buildDraftTemplate(draftTitle, kind),
            }) as { success?: boolean; error?: string; path?: string };
            if (!result?.success || !result.path) throw new Error(result?.error || '创建草稿失败');
            await loadData();
            setEditorFile(result.path);
            setEditorDescriptor({
                title: draftTitle,
                draftType: kind,
            });
            setMode('editor');
            setCreateOpen(false);
        } catch (createError) {
            const message = createError instanceof Error ? createError.message : '创建失败';
            void appAlert(message);
        } finally {
            setIsCreating(false);
        }
    }, [activeFolder, createKind, loadData]);

    const handleCreateFolder = useCallback(async () => {
        const normalizedName = normalizeDraftFileName(folderCreateTitle);
        if (!normalizedName) return;
        setIsCreating(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:create-folder', {
                parentPath: activeFolder,
                name: normalizedName,
            }) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '创建文件夹失败');
            await loadData();
            setActiveFolder(activeFolder ? `${activeFolder}/${normalizedName}` : normalizedName);
            setFolderCreateOpen(false);
            setFolderCreateTitle('');
        } catch (createError) {
            const message = createError instanceof Error ? createError.message : '创建失败';
            void appAlert(message);
        } finally {
            setIsCreating(false);
        }
    }, [activeFolder, folderCreateTitle, loadData]);

    const openFolderContextMenu = useCallback((event: React.MouseEvent, folder: FileNode) => {
        event.preventDefault();
        event.stopPropagation();
        setFolderContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            folderPath: folder.path,
            folderName: folder.name,
        });
    }, []);

    const handleDeleteFolder = useCallback(async (folderPath: string) => {
        if (!(await appConfirm('确认删除这个文件夹吗？文件夹内内容也会一起删除。', {
            title: '删除文件夹',
            confirmLabel: '删除',
            tone: 'danger',
        }))) return;
        setFolderContextMenu((prev) => ({ ...prev, visible: false }));
        setWorkingId(folderPath);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete', folderPath) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '删除文件夹失败');
            if (isSameOrNestedPath(folderPath, activeFolder)) {
                setActiveFolder(getParentFolderPath(folderPath));
            }
            await loadData();
        } catch (deleteError) {
            void appAlert(deleteError instanceof Error ? deleteError.message : '删除文件夹失败');
        } finally {
            setWorkingId(null);
        }
    }, [activeFolder, isSameOrNestedPath, loadData]);

    const handleShowInFolder = useCallback(async (source: string, fallbackMessage = '打开文件夹失败') => {
        const normalized = String(source || '').trim();
        if (!normalized) return;
        const result = await window.ipcRenderer.files.showInFolder({ source: normalized }) as { success?: boolean; error?: string };
        if (!result?.success) {
            void appAlert(result?.error || fallbackMessage);
        }
    }, []);

    const handleRenameFolder = useCallback(async () => {
        const newName = normalizeDraftFileName(folderRenameTitle);
        if (!newName || !folderRenamePath) return;
        setIsCreating(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:rename', {
                oldPath: folderRenamePath,
                newName,
            }) as { success?: boolean; error?: string; newPath?: string };
            if (!result?.success) throw new Error(result?.error || '重命名文件夹失败');
            if (isSameOrNestedPath(folderRenamePath, activeFolder)) {
                setActiveFolder(String(result?.newPath || getParentFolderPath(folderRenamePath)));
            }
            setFolderRenameOpen(false);
            setFolderRenamePath('');
            setFolderRenameTitle('');
            await loadData();
        } catch (renameError) {
            void appAlert(renameError instanceof Error ? renameError.message : '重命名文件夹失败');
        } finally {
            setIsCreating(false);
        }
    }, [activeFolder, folderRenamePath, folderRenameTitle, isSameOrNestedPath, loadData]);

    const openAssetContextMenu = useCallback((event: React.MouseEvent, asset: MediaAsset) => {
        event.preventDefault();
        event.stopPropagation();
        setAssetContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            assetId: asset.id,
            assetTitle: asset.title || asset.relativePath || asset.id,
        });
    }, []);

    const handleRenameAsset = useCallback(async () => {
        const nextTitle = assetRenameTitle.trim();
        if (!assetRenameId || !nextTitle) return;
        setIsCreating(true);
        try {
            const result = await window.ipcRenderer.invoke('media:update', {
                assetId: assetRenameId,
                title: nextTitle,
            }) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '重命名素材失败');
            setAssetRenameOpen(false);
            setAssetRenameId('');
            setAssetRenameTitle('');
            await loadData();
        } catch (renameError) {
            void appAlert(renameError instanceof Error ? renameError.message : '重命名素材失败');
        } finally {
            setIsCreating(false);
        }
    }, [assetRenameId, assetRenameTitle, loadData]);

    const openDraftContextMenu = useCallback((event: React.MouseEvent, file: FileNode, title: string) => {
        event.preventDefault();
        event.stopPropagation();
        setDraftContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            filePath: file.path,
            title,
        });
    }, []);

    const handleRenameDraft = useCallback(async () => {
        const nextName = normalizeDraftFileName(draftRenameTitle);
        if (!draftRenamePath || !nextName) return;
        setIsCreating(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:rename', {
                oldPath: draftRenamePath,
                newName: nextName,
            }) as { success?: boolean; error?: string; newPath?: string };
            if (!result?.success) throw new Error(result?.error || '重命名稿件失败');
            if (editorFile === draftRenamePath) {
                setEditorFile(String(result?.newPath || ''));
            }
            setDraftRenameOpen(false);
            setDraftRenamePath('');
            setDraftRenameTitle('');
            await loadData();
        } catch (renameError) {
            void appAlert(renameError instanceof Error ? renameError.message : '重命名稿件失败');
        } finally {
            setIsCreating(false);
        }
    }, [draftRenamePath, draftRenameTitle, editorFile, loadData]);

    const handleStartEditorTitleEdit = useCallback(() => {
        if (!editorDescriptor || isEditorTitleSaving) return;
        skipEditorTitleBlurCommitRef.current = false;
        setEditorTitleDraft(editorDescriptor.title);
        setIsEditorTitleEditing(true);
    }, [editorDescriptor, isEditorTitleSaving]);

    const handleCancelEditorTitleEdit = useCallback(() => {
        skipEditorTitleBlurCommitRef.current = true;
        setEditorTitleDraft(editorDescriptor?.title || '');
        setIsEditorTitleEditing(false);
    }, [editorDescriptor?.title]);

    const handleCommitEditorTitle = useCallback(async () => {
        if (!editorFile || !editorDescriptor || isEditorTitleSaving) return;
        const nextTitle = editorTitleDraft.trim();
        if (!nextTitle) {
            handleCancelEditorTitleEdit();
            return;
        }
        if (nextTitle === editorDescriptor.title) {
            setIsEditorTitleEditing(false);
            return;
        }

        setIsEditorTitleSaving(true);
        try {
            const nextName = isPackageDraftPath(editorFile)
                ? nextTitle
                : renameManuscriptKeepingExtension(pathBasenameSafe(editorFile), normalizeDraftFileName(nextTitle));
            const result = await window.ipcRenderer.invoke('manuscripts:rename', {
                oldPath: editorFile,
                newName: nextName,
            }) as { success?: boolean; error?: string; newPath?: string };
            if (!result?.success) throw new Error(result?.error || '重命名稿件失败');

            const nextPath = String(result?.newPath || editorFile);
            if (nextPath) {
                editorFileRef.current = nextPath;
                setEditorFile(nextPath);
            }
            setEditorDescriptor((current) => current ? { ...current, title: nextTitle } : current);
            setEditorMetadata((current) => {
                const nextMetadata = { ...current, title: nextTitle };
                editorMetadataRef.current = nextMetadata;
                return nextMetadata;
            });
            setEditorTitleDraft(nextTitle);
            setIsEditorTitleEditing(false);
            await loadData();
        } catch (renameError) {
            void appAlert(renameError instanceof Error ? renameError.message : '重命名稿件失败');
        } finally {
            setIsEditorTitleSaving(false);
        }
    }, [
        editorDescriptor,
        editorFile,
        editorTitleDraft,
        handleCancelEditorTitleEdit,
        isEditorTitleSaving,
        loadData,
    ]);

    const handleDeleteDraft = useCallback(async (targetPath: string) => {
        setWorkingId(targetPath);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete', targetPath) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '删除失败');
            if (isSameOrNestedPath(targetPath, activeFolder)) {
                setActiveFolder('');
            }
            if (isSameOrNestedPath(targetPath, editorFile)) {
                onClose?.();
            }
            setPendingDeleteDraftPath(null);
            await loadData();
        } catch (deleteError) {
            void appAlert(deleteError instanceof Error ? deleteError.message : '删除失败');
        } finally {
            setWorkingId(null);
        }
    }, [activeFolder, editorFile, isSameOrNestedPath, loadData, onClose]);

    const handleDeleteAsset = useCallback(async (assetId: string) => {
        if (!(await appConfirm('确认删除这个媒体资产吗？', { title: '删除媒体资产', confirmLabel: '删除', tone: 'danger' }))) return;
        setWorkingId(assetId);
        try {
            const result = await window.ipcRenderer.invoke('media:delete', { assetId }) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '删除媒体失败');
            await loadData();
        } catch (deleteError) {
            void appAlert(deleteError instanceof Error ? deleteError.message : '删除媒体失败');
        } finally {
            setWorkingId(null);
        }
    }, [loadData]);

    const openDraftEditor = useCallback(async (targetPath: string) => {
        setEditorFile(targetPath);
        setMode('editor');
        const cached = fileMetaMap[targetPath];
        if (cached) {
            setEditorDescriptor({
                title: cached.title,
                draftType: cached.draftType,
            });
            return;
        }
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:read', targetPath) as ManuscriptReadResult;
            const metadata = (result?.metadata || {}) as Record<string, unknown>;
            setEditorDescriptor({
                title: String(metadata.title || '').trim() || DEFAULT_UNTITLED_DRAFT_TITLE,
                draftType: (String(metadata.draftType || '').trim() as CreateKind | '') || 'unknown',
            });
        } catch {
            setEditorDescriptor({
                title: DEFAULT_UNTITLED_DRAFT_TITLE,
                draftType: 'unknown',
            });
        }
    }, [fileMetaMap]);

    const applyPackageState = useCallback((
        targetPath: string,
        nextState?: PackageState | null,
        delayMs: number = 120,
    ) => {
        setPackageState(nextState || null);
        void targetPath;
        void delayMs;
    }, []);

    const refreshPackageState = useCallback(async (targetPath: string) => {
        const isPackage = isPackageDraftPath(targetPath);
        if (!isPackage) {
            setPackageState(null);
            return;
        }
        const result = await window.ipcRenderer.invoke('manuscripts:get-package-state', targetPath) as {
            success?: boolean;
            state?: PackageState;
        };
        if (result?.success && result.state) {
            applyPackageState(targetPath, result.state, 120);
        } else {
            setPackageState(null);
        }
    }, [applyPackageState]);

    useEffect(() => {
        if (!currentImageJob) {
            setIsGenerating(false);
            return;
        }
        const terminal = isMediaJobTerminal(currentImageJob.status);
        setIsGenerating(!terminal);
        if (terminal && activeImageJobId === currentImageJob.jobId) {
            setActiveImageJobId(null);
        }
        if (isMediaJobSuccessful(currentImageJob.status)) {
            setGenError('');
            setGeneratedAssets(generatedAssetsFromMediaJob(currentImageJob));
            if (handledImageTerminalJobIdRef.current !== currentImageJob.jobId) {
                handledImageTerminalJobIdRef.current = currentImageJob.jobId;
                void loadData();
            }
            return;
        }
        if (!terminal) return;
        setGenError(mediaJobErrorMessage(currentImageJob, '生图失败'));
        if (handledImageTerminalJobIdRef.current !== currentImageJob.jobId) {
            handledImageTerminalJobIdRef.current = currentImageJob.jobId;
        }
    }, [activeImageJobId, currentImageJob, loadData]);

    useEffect(() => {
        if (!currentVideoJob) {
            setIsGeneratingVideo(false);
            return;
        }
        const terminal = isMediaJobTerminal(currentVideoJob.status);
        setIsGeneratingVideo(!terminal);
        if (terminal && activeVideoJobId === currentVideoJob.jobId) {
            setActiveVideoJobId(null);
        }
        if (isMediaJobSuccessful(currentVideoJob.status)) {
            setVideoGenError('');
            setGeneratedVideoAssets(generatedAssetsFromMediaJob(currentVideoJob));
            if (handledVideoTerminalJobIdRef.current !== currentVideoJob.jobId) {
                handledVideoTerminalJobIdRef.current = currentVideoJob.jobId;
                void loadData();
                if (editorFile) {
                    void refreshPackageState(editorFile);
                }
            }
            return;
        }
        if (!terminal) return;
        setVideoGenError(mediaJobErrorMessage(currentVideoJob, '生视频失败'));
        if (handledVideoTerminalJobIdRef.current !== currentVideoJob.jobId) {
            handledVideoTerminalJobIdRef.current = currentVideoJob.jobId;
        }
    }, [activeVideoJobId, currentVideoJob, editorFile, loadData, refreshPackageState]);

    const runEditorSave = useCallback(async (options?: { alertOnError?: boolean }) => {
        const snapshotFile = editorFileRef.current;
        if (!snapshotFile) return true;
        const snapshotContent = composeMarkdownWithFrontmatter(
            editorBodyRef.current,
            editorFrontmatterBlockRef.current
        );
        const snapshotMetadata = { ...editorMetadataRef.current };
        const snapshotMetadataKey = JSON.stringify(snapshotMetadata);

        setIsSavingEditorBody(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:save', {
                path: snapshotFile,
                content: snapshotContent,
                metadata: snapshotMetadata,
            }) as { success?: boolean; error?: string; state?: PackageState; newPath?: string; title?: string | null };
            if (!result?.success) {
                throw new Error(result?.error || '保存失败');
            }
            if (result.state) {
                applyPackageState(snapshotFile, result.state, 120);
            }
            if (typeof result.title === 'string' && result.title.trim()) {
                const nextTitle = result.title.trim();
                setEditorDescriptor((current) => current ? { ...current, title: nextTitle } : current);
                setEditorMetadata((current) => {
                    const nextMetadata = { ...current, title: nextTitle };
                    editorMetadataRef.current = nextMetadata;
                    return nextMetadata;
                });
            }
            if (typeof result.newPath === 'string' && result.newPath.trim() && result.newPath !== snapshotFile) {
                editorFileRef.current = result.newPath;
                setEditorFile(result.newPath);
                await loadData();
            }
            const latestContent = composeMarkdownWithFrontmatter(
                editorBodyRef.current,
                editorFrontmatterBlockRef.current
            );
            const latestMetadataKey = JSON.stringify(editorMetadataRef.current || {});
            const latestFile = editorFileRef.current;
            const isStillCurrent = latestFile === snapshotFile
                && latestContent === snapshotContent
                && latestMetadataKey === snapshotMetadataKey;
            if (isStillCurrent) {
                editorBodyDirtyRef.current = false;
                setEditorBodyDirty(false);
            }
            return true;
        } catch (error) {
            if (options?.alertOnError !== false) {
                void appAlert(error instanceof Error ? error.message : '保存失败');
            }
            return false;
        } finally {
            setIsSavingEditorBody(false);
        }
    }, [applyPackageState, loadData]);

    const ensureLatestEditorContentSaved = useCallback(async () => {
        if (!editorFileRef.current) return true;
        let attempt = 0;
        while (attempt < 4) {
            if (editorSavePromiseRef.current) {
                const completed = await editorSavePromiseRef.current;
                if (!completed) {
                    return false;
                }
            }
            if (!editorBodyDirtyRef.current && !editorSavePromiseRef.current) {
                return true;
            }
            const savePromise = runEditorSave({ alertOnError: true }).finally(() => {
                if (editorSavePromiseRef.current === savePromise) {
                    editorSavePromiseRef.current = null;
                }
            });
            editorSavePromiseRef.current = savePromise;
            const succeeded = await savePromise;
            if (!succeeded) {
                return false;
            }
            if (!editorBodyDirtyRef.current) {
                return true;
            }
            attempt += 1;
        }
        return !editorBodyDirtyRef.current;
    }, [runEditorSave]);

    const handleImportAndBindAssetsToPackage = useCallback(async () => {
        if (!editorFile) return;
        setWorkingId('media-import-bind');
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:attach-external-files', {
                filePath: editorFile,
            }) as {
                success?: boolean;
                canceled?: boolean;
                error?: string;
                imported?: Array<Record<string, unknown>>;
                state?: PackageState;
            };
            if (result?.canceled) {
                return;
            }
            if (!result?.success) {
                throw new Error(result?.error || '导入素材失败');
            }
            if (result.state) {
                applyPackageState(editorFile, result.state);
            } else {
                await refreshPackageState(editorFile);
            }
        } catch (importError) {
            void appAlert(importError instanceof Error ? importError.message : '导入素材失败');
        } finally {
            setWorkingId(null);
        }
    }, [applyPackageState, editorFile, refreshPackageState]);

    const handleGenerateRemotionScene = useCallback(async (instructionsOverride?: string) => {
        if (!editorFile || editorDescriptor?.draftType !== 'video') return;
        setIsGeneratingRemotion(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:generate-remotion-scene', {
                filePath: editorFile,
                instructions: instructionsOverride || editorBody,
            }) as { success?: boolean; state?: PackageState; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '生成 Remotion 动画方案失败');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '生成 Remotion 动画方案失败');
        } finally {
            setIsGeneratingRemotion(false);
        }
    }, [editorBody, editorDescriptor?.draftType, editorFile]);

    const handleSaveRemotionScene = useCallback(async (scene: RemotionCompositionConfig) => {
        if (!editorFile || editorDescriptor?.draftType !== 'video') return;
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:save-remotion-scene', {
                filePath: editorFile,
                scene,
            }) as { success?: boolean; state?: PackageState; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '保存 Remotion 动画方案失败');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '保存 Remotion 动画方案失败');
        }
    }, [editorDescriptor?.draftType, editorFile]);

    const handleRenderRemotionVideo = useCallback(() => {
        if (!editorFile || editorDescriptor?.draftType !== 'video' || isRenderingRemotion) return;
        setExportVideoError('');
        setExportVideoStage('');
        setExportVideoProgress(0);
        setIsExportVideoModalOpen(true);
    }, [editorDescriptor?.draftType, editorFile, isRenderingRemotion]);

    const handlePickExportVideoPath = useCallback(async () => {
        if (!editorFile || editorDescriptor?.draftType !== 'video' || isRenderingRemotion) return;
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:pick-export-path', {
                filePath: editorFile,
                resolutionPreset: exportVideoResolution,
                renderMode: 'full',
            }) as { success?: boolean; canceled?: boolean; path?: string; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '选择导出位置失败');
            }
            if (!result.canceled && result.path) {
                setExportVideoPath(result.path);
            }
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '选择导出位置失败');
        }
    }, [editorDescriptor?.draftType, editorFile, exportVideoResolution, isRenderingRemotion]);

    const handleConfirmExportVideo = useCallback(async () => {
        if (!editorFile || editorDescriptor?.draftType !== 'video' || isRenderingRemotion) return;
        let outputPath = exportVideoPath.trim();
        if (!outputPath) {
            const picked = await window.ipcRenderer.invoke('manuscripts:pick-export-path', {
                filePath: editorFile,
                resolutionPreset: exportVideoResolution,
                renderMode: 'full',
            }) as { success?: boolean; canceled?: boolean; path?: string; error?: string };
            if (!picked?.success) {
                void appAlert(picked?.error || '选择导出位置失败');
                return;
            }
            if (picked.canceled || !picked.path) {
                return;
            }
            outputPath = picked.path;
            setExportVideoPath(outputPath);
        }
        setIsRenderingRemotion(true);
        setExportVideoError('');
        setExportVideoStage('准备导出');
        setExportVideoProgress(0);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:render-remotion-video', {
                filePath: editorFile,
                renderMode: 'full',
                outputPath,
                resolutionPreset: exportVideoResolution,
            }) as { success?: boolean; state?: PackageState; outputPath?: string; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '导出视频失败');
            }
            setPackageState(result.state);
            setExportVideoProgress(100);
            setExportVideoStage('导出完成');
            if (result.outputPath) {
                setExportVideoPath(result.outputPath);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : '导出视频失败';
            setExportVideoError(message);
            setExportVideoStage('导出失败');
            void appAlert(message);
        } finally {
            setIsRenderingRemotion(false);
        }
    }, [editorDescriptor?.draftType, editorFile, exportVideoPath, exportVideoResolution, isRenderingRemotion]);

    const handleOpenRenderedRemotionVideo = useCallback(async () => {
        const outputPath = packageState?.videoProject?.renderOutput || packageState?.remotion?.render?.outputPath;
        if (!outputPath) return;
        try {
            await window.ipcRenderer.invoke('app:open-path', { path: outputPath });
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '打开导出文件失败');
        }
    }, [packageState?.remotion?.render?.outputPath, packageState?.videoProject?.renderOutput]);

    useEffect(() => {
        const handleProgress = (_event: unknown, payload?: Record<string, unknown>) => {
            if (!editorFile || payload?.filePath !== editorFile) return;
            if (typeof payload.percent === 'number') {
                setExportVideoProgress(Math.max(0, Math.min(100, payload.percent)));
            }
            if (typeof payload.stage === 'string') {
                setExportVideoStage(payload.stage);
            }
            if (typeof payload.error === 'string' && payload.error.trim()) {
                setExportVideoError(payload.error);
            }
            if (payload?.status === 'running') {
                setIsExportVideoModalOpen(true);
            }
        };
        window.ipcRenderer.on('manuscripts:render-progress', handleProgress);
        return () => {
            window.ipcRenderer.off('manuscripts:render-progress', handleProgress);
        };
    }, [editorFile]);

    useEffect(() => {
        if (!editorFile) {
            setPackageState(null);
            setExportVideoPath('');
            setExportVideoProgress(0);
            setExportVideoStage('');
            setExportVideoError('');
            setIsExportVideoModalOpen(false);
            return;
        }
        void refreshPackageState(editorFile);
    }, [editorFile, refreshPackageState]);

    const loadEditorWriteProposal = useCallback(async (filePath: string | null) => {
        if (!filePath) {
            setEditorWriteProposal(null);
            return;
        }
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:get-write-proposal', {
                filePath,
            }) as { success?: boolean; proposal?: ManuscriptWriteProposal | null };
            setEditorWriteProposal(result?.proposal || null);
        } catch (error) {
            console.error('Failed to load manuscript write proposal:', error);
            setEditorWriteProposal(null);
        }
    }, []);

    useEffect(() => {
        if (!editorFile || mode !== 'editor') {
            setEditorBody('');
            setEditorFrontmatterBlock(null);
            setEditorMetadata({});
            setEditorWriteProposal(null);
            setEditorReviewBody('');
            setEditorBodyDirty(false);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const result = await window.ipcRenderer.invoke('manuscripts:read', editorFile) as ManuscriptReadResult;
                if (cancelled) return;
                const nextContent = String(result?.content || '');
                const { body, frontmatterBlock } = splitWritingDraftContent(nextContent, editorDescriptor?.draftType);
                setEditorBody(body);
                setEditorFrontmatterBlock(frontmatterBlock);
                setEditorMetadata((result?.metadata || {}) as Record<string, unknown>);
                setEditorBodyDirty(false);
            } catch (error) {
                console.error('Failed to load editor body:', error);
                if (!cancelled) {
                    setEditorBody('');
                    setEditorFrontmatterBlock(null);
                    setEditorMetadata({});
                    setEditorReviewBody('');
                    setEditorBodyDirty(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [editorDescriptor?.draftType, editorFile, mode]);

    useEffect(() => {
        if (!editorFile || mode !== 'editor') {
            setEditorWriteProposal(null);
            setEditorReviewBody('');
            return;
        }
        void loadEditorWriteProposal(editorFile);
    }, [editorFile, loadEditorWriteProposal, mode]);

    useEffect(() => {
        if (!editorWriteProposal) {
            editorReviewProposalIdRef.current = null;
            setEditorReviewBody('');
            return;
        }
        const nextDraft = splitWritingDraftContent(editorWriteProposal.proposedContent, editorDescriptor?.draftType);
        editorReviewProposalIdRef.current = editorWriteProposal.id;
        setEditorReviewBody(nextDraft.body);
    }, [editorDescriptor?.draftType, editorWriteProposal?.id, editorWriteProposal?.proposedContent]);

    useEffect(() => {
        const handleProposalChanged = (_event: unknown, payload?: { filePath?: string; proposal?: ManuscriptWriteProposal | null }) => {
            if (!editorFile) return;
            if (!isSameDraftRelativePath(payload?.filePath, editorFile)) return;
            setEditorWriteProposal(payload?.proposal || null);
        };
        window.ipcRenderer.on('manuscripts:write-proposal', handleProposalChanged);
        return () => {
            window.ipcRenderer.off('manuscripts:write-proposal', handleProposalChanged);
        };
    }, [editorFile]);

    useEffect(() => {
        if (!editorFile || mode !== 'editor' || editorBodyDirty) return;
        const nextScriptBody = packageState?.videoProject?.scriptBody
            ?? packageState?.editorProject?.script?.body;
        if (typeof nextScriptBody !== 'string') return;
        const nextDraft = splitWritingDraftContent(nextScriptBody, editorDescriptor?.draftType);
        if (nextDraft.body === editorBody && nextDraft.frontmatterBlock === editorFrontmatterBlock) return;
        setEditorBody(nextDraft.body);
        setEditorFrontmatterBlock(nextDraft.frontmatterBlock);
        setEditorBodyDirty(false);
    }, [
        editorBody,
        editorBodyDirty,
        editorDescriptor?.draftType,
        editorFile,
        editorFrontmatterBlock,
        mode,
        packageState?.editorProject?.script?.body,
        packageState?.videoProject?.scriptBody,
    ]);

    useEffect(() => {
        if (!editorFile || !editorBodyDirty || isSavingEditorBody) return;
        const timer = window.setTimeout(() => {
            const savePromise = runEditorSave({ alertOnError: false }).finally(() => {
                if (editorSavePromiseRef.current === savePromise) {
                    editorSavePromiseRef.current = null;
                }
            });
            editorSavePromiseRef.current = savePromise;
            void savePromise;
        }, 250);
        return () => window.clearTimeout(timer);
    }, [
        editorBody,
        editorBodyDirty,
        editorFile,
        editorFrontmatterBlock,
        editorMetadata,
        isSavingEditorBody,
        runEditorSave,
    ]);

    const editorChatBinding = useMemo(() => buildEditorSessionBinding({
        editorFile,
        draftType: editorDescriptor?.draftType,
        editorTitle: editorDescriptor?.title,
        fileFallbackTitle: editorFile ? fileMetaMap[editorFile]?.title || null : null,
        editorAiWorkspaceMode,
        packageState,
        editorBodyDirty,
    }), [
        editorAiWorkspaceMode,
        editorBodyDirty,
        editorDescriptor?.draftType,
        editorDescriptor?.title,
        editorFile,
        fileMetaMap,
        packageState,
    ]);
    const editorChatBindingFingerprint = useMemo(
        () => (editorChatBinding ? JSON.stringify(editorChatBinding) : ''),
        [editorChatBinding],
    );

    useEffect(() => {
        if (!editorChatBinding || !editorFile) {
            setEditorChatSessionId(null);
            setEditorChatSessionReady(false);
            return;
        }
        setEditorChatSessionReady(false);
        let cancelled = false;
        void window.ipcRenderer.invoke('chat:bind-editor-session', editorChatBinding)
            .then((session) => {
                const sessionRecord = session as { id?: string } | null;
                if (cancelled || !sessionRecord?.id) return;
                setEditorChatSessionId(sessionRecord.id);
                setEditorChatSessionReady(true);
            })
            .catch((error) => {
                console.error('Failed to bind editor chat session:', error);
                if (!cancelled) {
                    setEditorChatSessionId(null);
                    setEditorChatSessionReady(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [editorChatBinding, editorChatBindingFingerprint, editorFile]);

    const handleAcceptEditorWriteProposal = useCallback(async () => {
        if (!editorFile || !editorWriteProposal) return;
        const shouldWarnAboutOverwrite =
            isSavingEditorBody
            || editorBodyDirty
            || currentEditorContent !== editorWriteProposal.baseContent;
        if (shouldWarnAboutOverwrite) {
            const confirmed = await appConfirm(
                '当前稿件在 AI 提案生成后又有变化。接受提案会用 AI 的版本覆盖现在的正文，是否继续？',
                {
                    title: '接受 AI 修改',
                    confirmLabel: '继续接受',
                }
            );
            if (!confirmed) return;
        }
        setIsApplyingWriteProposal(true);
        try {
            const proposedDraft = splitWritingDraftContent(
                editorWriteProposal.proposedContent,
                editorDescriptor?.draftType
            );
            const reviewBody = editorReviewProposalIdRef.current === editorWriteProposal.id
                ? editorReviewBodyRef.current
                : proposedDraft.body;
            const proposedContentOverride = composeMarkdownWithFrontmatter(
                reviewBody,
                proposedDraft.frontmatterBlock
            );
            const result = await window.ipcRenderer.invoke('manuscripts:accept-write-proposal', {
                filePath: editorFile,
                proposedContentOverride,
            }) as { success?: boolean; error?: string; content?: string; state?: PackageState };
            if (!result?.success || typeof result.content !== 'string') {
                throw new Error(result?.error || '接受 AI 修改失败');
            }
            const nextDraft = splitWritingDraftContent(result.content, editorDescriptor?.draftType);
            setEditorBody(nextDraft.body);
            setEditorFrontmatterBlock(nextDraft.frontmatterBlock);
            setEditorBodyDirty(false);
            setEditorWriteProposal(null);
            setEditorReviewBody('');
            if (result.state) {
                applyPackageState(editorFile, result.state);
            }
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '接受 AI 修改失败');
        } finally {
            setIsApplyingWriteProposal(false);
        }
    }, [applyPackageState, currentEditorContent, editorBodyDirty, editorDescriptor?.draftType, editorFile, editorWriteProposal, isSavingEditorBody]);

    const handleRejectEditorWriteProposal = useCallback(async () => {
        if (!editorFile || !editorWriteProposal) return;
        setIsRejectingWriteProposal(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:reject-write-proposal', {
                filePath: editorFile,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '拒绝 AI 修改失败');
            }
            setEditorWriteProposal(null);
            setEditorReviewBody('');
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '拒绝 AI 修改失败');
        } finally {
            setIsRejectingWriteProposal(false);
        }
    }, [editorFile, editorWriteProposal]);

    useEffect(() => {
        const nextImmersiveMode: ImmersiveMode = mode === 'editor'
            ? (editorDescriptor?.draftType === 'video' || editorDescriptor?.draftType === 'audio' ? 'dark' : 'theme')
            : false;
        onImmersiveModeChange?.(nextImmersiveMode);
        return () => {
            onImmersiveModeChange?.(false);
        };
    }, [editorDescriptor?.draftType, mode, onImmersiveModeChange]);

    const handleConfirmEditorScript = useCallback(async () => {
        if (!editorFile || (editorDescriptor?.draftType !== 'video' && editorDescriptor?.draftType !== 'audio')) return;
        if (editorBodyDirty || isSavingEditorBody) {
            void appAlert('脚本正在保存或仍有未保存改动，请稍后再确认。');
            return;
        }
        try {
            const result = await window.ipcRenderer.manuscripts.confirmPackageScript({
                filePath: editorFile,
            }) as { success?: boolean; state?: PackageState; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '确认脚本失败');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '确认脚本失败');
        }
    }, [editorBodyDirty, editorDescriptor?.draftType, editorFile, isSavingEditorBody]);

    const handleBindAssetToPackage = useCallback(async (assetId: string) => {
        if (!editorFile) return;
        try {
            const result = await window.ipcRenderer.invoke('media:bind', {
                assetId,
                manuscriptPath: editorFile,
                role: bindAssetRole,
            }) as { success?: boolean; error?: string; state?: PackageState };
            if (!result?.success) {
                throw new Error(result?.error || '绑定素材失败');
            }
            await loadData();
            if (result.state) {
                applyPackageState(editorFile, result.state);
            } else {
                await refreshPackageState(editorFile);
            }
            setIsBindAssetModalOpen(false);
        } catch (bindError) {
            void appAlert(bindError instanceof Error ? bindError.message : '绑定素材失败');
        }
    }, [applyPackageState, bindAssetRole, editorFile, loadData, refreshPackageState]);

    const pushToRedClaw = useCallback((filePath: string) => {
        const meta = fileMetaMap[filePath];
        onNavigateToRedClaw?.({
            content: `请继续处理这个草稿：${filePath}`,
            displayContent: `继续处理 ${meta?.title || filePath}`,
        });
    }, [fileMetaMap, onNavigateToRedClaw]);

    const handleGenerate = useCallback(async () => {
        if (!prompt.trim()) {
            setGenError('请先输入提示词');
            return;
        }
        if (generationMode === 'image-to-image' && referenceImages.length === 0) {
            setGenError('图生图模式至少需要 1 张参考图');
            return;
        }

        setIsGenerating(true);
        setGenError('');
        try {
            const effectiveMode = referenceImages.length > 0 ? generationMode : 'text-to-image';
            const result = await window.ipcRenderer.generation.submitImage({
                prompt,
                bypassPromptOptimizer: true,
                projectId: genProjectId.trim() || undefined,
                title: genTitle.trim() || undefined,
                generationMode: effectiveMode,
                referenceImages: referenceImages.map((item) => item.dataUrl),
                count,
                model: model.trim() || undefined,
                provider: settings.image_provider || undefined,
                providerTemplate: settings.image_provider_template || undefined,
                aspectRatio: aspectRatio.trim() || undefined,
                size: size.trim() || undefined,
                quality: quality.trim() || undefined,
                source: 'manuscripts',
                manuscriptPath: editorFile || undefined,
            }) as { success?: boolean; error?: string; jobId?: string };

            if (!result?.success || !result?.jobId) {
                setGenError(result?.error || '生图失败');
                setIsGenerating(false);
                return;
            }
            setActiveImageJobId(result.jobId);
        } catch (generationError) {
            console.error('Failed to generate images:', generationError);
            setGenError('生图失败');
            setIsGenerating(false);
        } finally {
        }
    }, [aspectRatio, count, editorFile, genProjectId, genTitle, generationMode, model, prompt, quality, referenceImages, settings.image_provider, settings.image_provider_template, size]);

    const handleReferenceFile = useCallback(async (event: ChangeEvent<HTMLInputElement>, targetIndex: number) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingRefImages(true);
        try {
            const nextItem = {
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            };
            setReferenceImages((prev) => {
                const next = [...prev];
                next[targetIndex] = nextItem;
                return next.slice(0, 4);
            });
        } catch (uploadError) {
            console.error('Failed to parse reference images:', uploadError);
            setGenError('参考图读取失败，请重试');
        } finally {
            setIsReadingRefImages(false);
            event.target.value = '';
        }
    }, []);

    const resolvedEndpoint = (settings.image_endpoint || settings.api_endpoint || '').trim();
    const resolvedApiKey = (settings.image_api_key || settings.api_key || '').trim();
    const hasImageConfig = Boolean(resolvedEndpoint) && Boolean(resolvedApiKey);
    const resolvedVideoEndpoint = REDBOX_OFFICIAL_VIDEO_BASE_URL;
    const resolvedVideoApiKey = (settings.video_api_key || settings.api_key || '').trim();
    const effectiveVideoModel = getRedBoxOfficialVideoModel(videoGenerationMode);
    const hasVideoConfig = Boolean(resolvedVideoEndpoint) && Boolean(resolvedVideoApiKey);

    const handleGenerateVideo = useCallback(async () => {
        const effectiveVideoReferenceImages = videoGenerationMode === 'reference-guided'
            ? videoReferenceImages.filter(Boolean) as ReferenceImageItem[]
            : videoGenerationMode === 'first-last-frame'
                ? [videoPrimaryReferenceImage, videoLastFrameImage].filter(Boolean) as ReferenceImageItem[]
                : [];
        const effectiveVideoGenerationMode = effectiveVideoReferenceImages.length > 0 && videoGenerationMode === 'text-to-video'
            ? 'reference-guided'
            : videoGenerationMode;
        if (!videoPrompt.trim()) {
            setVideoGenError('请先输入视频提示词');
            return;
        }
        if (effectiveVideoGenerationMode === 'reference-guided' && effectiveVideoReferenceImages.length < 1) {
            setVideoGenError('参考图视频模式至少需要 1 张参考图');
            return;
        }
        if (effectiveVideoGenerationMode === 'first-last-frame' && effectiveVideoReferenceImages.length < 2) {
            setVideoGenError('首尾帧视频模式需要 2 张参考图');
            return;
        }
        if (!hasVideoConfig) {
            setVideoGenError('未检测到可用的生视频配置');
            return;
        }

        setIsGeneratingVideo(true);
        setVideoGenError('');
        try {
            const result = await window.ipcRenderer.generation.submitVideo({
                prompt: videoPrompt,
                projectId: videoProjectId.trim() || undefined,
                title: videoTitle.trim() || undefined,
                model: effectiveVideoModel,
                generationMode: effectiveVideoGenerationMode,
                referenceImages: effectiveVideoReferenceImages.map((item) => item.dataUrl),
                aspectRatio: videoAspectRatio,
                resolution: videoResolution,
                durationSeconds: videoDurationSeconds,
                count: 1,
                generateAudio: false,
                source: 'manuscripts',
                manuscriptPath: editorFile || undefined,
                videoProjectPath: editorDescriptor?.draftType === 'video' ? editorFile || undefined : undefined,
            }) as { success?: boolean; error?: string; jobId?: string };

            if (!result?.success || !result?.jobId) {
                setVideoGenError(result?.error || '生视频失败');
                setIsGeneratingVideo(false);
                return;
            }
            setActiveVideoJobId(result.jobId);
        } catch (generationError) {
            console.error('Failed to generate videos:', generationError);
            setVideoGenError('生视频失败');
            setIsGeneratingVideo(false);
        } finally {
        }
    }, [
        editorDescriptor?.draftType,
        editorFile,
        effectiveVideoModel,
        hasVideoConfig,
        videoAspectRatio,
        videoDurationSeconds,
        videoGenerationMode,
        videoLastFrameImage,
        videoPrimaryReferenceImage,
        videoProjectId,
        videoPrompt,
        videoReferenceImages,
        videoResolution,
        videoTitle,
    ]);

    const handleVideoReferenceFile = useCallback(async (event: ChangeEvent<HTMLInputElement>, target: 'primary' | 'last' | number) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingVideoRefImages(true);
        try {
            const item = {
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            };
            if (typeof target === 'number') {
                setVideoReferenceImages((prev) => {
                    const next = [...prev];
                    next[target] = item;
                    return next.slice(0, 5);
                });
                if (videoGenerationMode === 'text-to-video') {
                    setVideoGenerationMode('reference-guided');
                }
            } else if (target === 'primary') {
                setVideoPrimaryReferenceImage(item);
            } else {
                setVideoLastFrameImage(item);
            }
        } catch (uploadError) {
            console.error('Failed to parse video reference image:', uploadError);
            setVideoGenError('视频参考图读取失败，请重试');
        } finally {
            setIsReadingVideoRefImages(false);
            event.target.value = '';
        }
    }, []);


    const contentCards = useMemo(() => {
        const draftCards: DraftCard[] = visibleDrafts.map((file) => {
            const meta = fileMetaMap[file.path];
            const draftType = meta?.draftType || 'unknown';
            return {
                id: `draft:${file.path}`,
                kind: 'draft' as const,
                updatedAt: Number(meta?.updatedAt || 0) || 0,
                createdAt: 0,
                file,
                meta,
                title: meta?.title || stripDraftExtension(file.name),
                summary: meta?.summary || '',
                draftType,
            };
        });

        const assetCards = visibleAssets.map((asset) => ({
            id: `asset:${asset.id}`,
            kind: 'asset' as const,
            updatedAt: parseTimestampMs(asset.updatedAt) || 0,
            createdAt: parseTimestampMs(asset.createdAt) || 0,
            asset,
            title: asset.title || asset.relativePath || asset.id,
            summary: asset.prompt || asset.relativePath || '',
            assetKind: inferAssetKind(asset),
        }));

        const compareCards = (
            a: typeof draftCards[number] | typeof assetCards[number],
            b: typeof draftCards[number] | typeof assetCards[number],
        ) => {
            const updatedDelta = b.updatedAt - a.updatedAt;
            if (updatedDelta !== 0) return updatedDelta;
            const createdDelta = b.createdAt - a.createdAt;
            if (createdDelta !== 0) return createdDelta;
            return a.title.localeCompare(b.title, 'zh-Hans-CN');
        };

        return [...draftCards, ...assetCards]
            .sort(compareCards)
            .slice(0, MANUSCRIPTS_CARD_RENDER_LIMIT);
    }, [fileMetaMap, visibleAssets, visibleDrafts]);

    const bindableImageAssets = useMemo(
        () => assets.filter((asset) => inferAssetKind(asset) === 'image'),
        [assets]
    );
    const bindableAssets = useMemo(
        () => bindAssetRole === 'asset' ? assets : bindableImageAssets,
        [assets, bindAssetRole, bindableImageAssets]
    );
    const exportSourceWidth = Number(packageState?.videoProject?.remotion?.width || packageState?.remotion?.width || 1920);
    const exportSourceHeight = Number(packageState?.videoProject?.remotion?.height || packageState?.remotion?.height || 1080);
    const exportTargetSize = exportResolutionDimensions(exportSourceWidth, exportSourceHeight, exportVideoResolution);

    if (mode === 'editor' && editorFile) {
        const currentDescriptor = editorDescriptor || {
            title: fileMetaMap[editorFile]?.title || editorFile,
            draftType: fileMetaMap[editorFile]?.draftType || 'unknown',
        };
        const draftType = currentDescriptor.draftType;
        const draftStyle = resolveDraftTypeStyle(draftType);
        const isVideoDraft = draftType === 'video';
        const isAudioDraft = draftType === 'audio';
        const isImmersiveWorkbench = mode === 'editor';
        const isArticlePackage = draftType === 'longform';
        const isVideoPackage = draftType === 'video';
        const isAudioPackage = draftType === 'audio';
        const isScriptConfirmed = (
            packageState?.videoProject?.scriptApproval?.status
            || packageState?.editorProject?.ai?.scriptApproval?.status
        ) === 'confirmed';
        const editorWriteProposalBaseDraft = editorWriteProposal
            ? splitWritingDraftContent(editorWriteProposal.baseContent, draftType)
            : null;
        const editorWriteProposalView = editorWriteProposal && editorWriteProposalBaseDraft ? {
            baseBody: editorWriteProposalBaseDraft.body,
            isStale: currentEditorContent !== editorWriteProposal.baseContent,
        } : null;
        const packageCoverId = String(packageState?.cover?.assetId || '').trim();
        const packageImages = Array.isArray(packageState?.images?.items) ? packageState?.images?.items : [];
        const packageAssets = Array.isArray(packageState?.assets?.items) ? packageState?.assets?.items : [];
        const timelineClipCount = Number(packageState?.timelineSummary?.clipCount || 0);
        const timelineClips = Array.isArray(packageState?.timelineSummary?.clips) ? packageState?.timelineSummary?.clips : [];
        const packageAssetIds = new Set([
            packageCoverId,
            ...packageImages.map((item) => String(item.assetId || '').trim()),
            ...packageAssets.map((item) => String(item.assetId || '').trim()),
            ...timelineClips.map((item) => String(item?.assetId || '').trim()),
        ].filter(Boolean));
        const manuscriptBoundAssets = assets
            .filter((asset) => String(asset.boundManuscriptPath || '').trim() === editorFile)
            .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
        const timelineFallbackAssets = timelineClips
            .filter((item) => {
                const assetId = String(item?.assetId || '').trim();
                return assetId && !assets.some((asset) => asset.id === assetId);
            })
            .map((item) => ({
                id: String(item?.assetId || ''),
                source: 'external' as const,
                title: String(item?.name || pathBasenameSafe(String(item?.mediaPath || '')) || item?.assetId || ''),
                mimeType: String(item?.mimeType || ''),
                relativePath: '',
                absolutePath: String(item?.mediaPath || ''),
                previewUrl: '',
                createdAt: '',
                updatedAt: '',
                exists: true,
            }));
        const packageAssetFallbacks = packageAssets
            .filter((item) => {
                const assetId = String(item.assetId || '').trim();
                return assetId && !assets.some((asset) => asset.id === assetId);
            })
            .map((item) => ({
                id: String(item.assetId || ''),
                source: 'external' as const,
                title: String(item.title || pathBasenameSafe(String(item.mediaPath || '')) || item.assetId || ''),
                mimeType: String(item.mimeType || ''),
                relativePath: '',
                absolutePath: String(item.absolutePath || item.mediaPath || ''),
                previewUrl: String(item.previewUrl || ''),
                createdAt: '',
                updatedAt: '',
                exists: Boolean(item.exists),
            }));
        const packagePreviewAssets = Array.from(new Map(
            [
                ...timelineClips
                    .map((item) => String(item?.assetId || '').trim())
                    .filter(Boolean)
                    .map((assetId) => assets.find((asset) => asset.id === assetId))
                    .filter(Boolean),
                ...manuscriptBoundAssets,
                ...assets.filter((asset) => packageAssetIds.has(asset.id)),
                ...timelineFallbackAssets,
                ...packageAssetFallbacks,
            ].map((asset) => [asset.id, asset])
        ).values());
        const packageCoverAsset = packagePreviewAssets.find((asset) => asset.id === packageCoverId) || null;
        const packageImageAssets = packagePreviewAssets.filter((asset) => (
            inferAssetKind(asset) === 'image' && asset.id !== packageCoverId
        ));
        const primaryVideoAsset = packagePreviewAssets.find((asset) => {
            const kind = inferAssetKind(asset);
            return kind === 'video' || kind === 'image';
        }) || null;
        const primaryAudioAsset = packagePreviewAssets.find((asset) => inferAssetKind(asset) === 'audio')
            || packagePreviewAssets.find((asset) => inferAssetKind(asset) === 'video')
            || null;
        const timelineSummary = packageState?.timelineSummary as ({ trackNames?: unknown } & Record<string, unknown>) | undefined;
        const packageTrackNames = Array.isArray(timelineSummary?.trackNames)
            ? timelineSummary.trackNames.map((item) => String(item || '').trim()).filter(Boolean)
            : [];
        const fallbackTrackNames = isAudioDraft
            ? ['A1']
            : isVideoDraft
                ? ['V1', 'A1']
                : ['V1', 'T1'];
        const timelineTrackNames = Array.from(new Set([
            ...packageTrackNames,
            ...timelineClips.map((item) => String(item.track || '').trim()).filter(Boolean),
            ...(packageTrackNames.length === 0 && timelineClips.length === 0 ? fallbackTrackNames : []),
        ]));

        return (
            <div className={clsx('h-full min-h-0 flex flex-col', isImmersiveWorkbench && 'editor-ui-shell text-text-primary')}>
                <div className={clsx(
                    'flex items-center justify-between gap-3 px-6 py-3.5 backdrop-blur-md z-30',
                    isImmersiveWorkbench
                        ? 'border-b border-border bg-background/86 backdrop-blur-[32px]'
                        : 'border-b border-black/[0.03] bg-white/80 backdrop-blur-[32px]'
                )}>
                    <div className="flex items-center gap-4 min-w-0">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2.5">
                                {isEditorTitleEditing ? (
                                    <input
                                        ref={editorTitleInputRef}
                                        value={editorTitleDraft}
                                        onChange={(event) => setEditorTitleDraft(event.target.value)}
                                        onBlur={() => {
                                            if (skipEditorTitleBlurCommitRef.current) {
                                                skipEditorTitleBlurCommitRef.current = false;
                                                return;
                                            }
                                            void handleCommitEditorTitle();
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                event.currentTarget.blur();
                                            } else if (event.key === 'Escape') {
                                                event.preventDefault();
                                                handleCancelEditorTitleEdit();
                                            }
                                        }}
                                        disabled={isEditorTitleSaving}
                                        className={clsx(
                                            'h-7 min-w-[180px] max-w-[min(52vw,560px)] rounded-lg border px-2 text-[15px] font-extrabold tracking-tight outline-none transition-colors',
                                            isImmersiveWorkbench
                                                ? 'border-border bg-surface-secondary/70 text-text-primary focus:border-accent-primary'
                                                : 'border-black/10 bg-white text-text-primary focus:border-accent-primary'
                                        )}
                                        aria-label="稿件标题"
                                    />
                                ) : (
                                    <button
                                        type="button"
                                        onClick={handleStartEditorTitleEdit}
                                        title="点击修改名字"
                                        className={clsx(
                                            'min-w-0 max-w-[min(52vw,620px)] rounded-lg px-1.5 py-0.5 text-left text-[15px] font-extrabold tracking-tight transition-colors',
                                            isImmersiveWorkbench
                                                ? 'text-text-primary hover:bg-surface-secondary/70'
                                                : 'text-text-primary hover:bg-black/[0.04]'
                                        )}
                                    >
                                        <span className="block truncate">{currentDescriptor.title}</span>
                                    </button>
                                )}
                                <span className={clsx('rounded-lg px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest', draftStyle.chip)}>
                                    {resolveDraftTypeLabel(draftType)}
                                </span>
                            </div>
                            <div className={clsx('mt-0.5 text-[10px] font-bold uppercase tracking-tighter truncate opacity-60', isImmersiveWorkbench ? 'text-text-tertiary' : 'text-text-tertiary')}>{editorFile}</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        {isAudioDraft && (
                            <div className="mr-2 flex items-center gap-1 rounded-xl border border-border bg-surface-secondary/50 px-1 py-1">
                                <EditorLayoutToggleButton
                                    kind="timeline"
                                    collapsed={immersiveTimelineCollapsed}
                                    onClick={() => setImmersiveTimelineCollapsed((value) => !value)}
                                    title={immersiveTimelineCollapsed ? '展开时间轴' : '折叠时间轴'}
                                />
                                <EditorLayoutToggleButton
                                    kind="materials"
                                    collapsed={immersiveMaterialsCollapsed}
                                    onClick={() => setImmersiveMaterialsCollapsed((value) => !value)}
                                    title={immersiveMaterialsCollapsed ? '展开素材栏' : '折叠素材栏'}
                                />
                            </div>
                        )}
                        
                        {isArticlePackage && (
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setBindAssetRole('cover');
                                        setIsBindAssetModalOpen(true);
                                    }}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition-all active:scale-95',
                                        isImmersiveWorkbench
                                            ? 'border border-border bg-surface-secondary/50 text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary'
                                            : 'bg-black/[0.03] border border-black/[0.02] text-text-secondary hover:text-text-primary hover:bg-black/[0.06]'
                                    )}
                                >
                                    <ImageIcon className="h-3.5 w-3.5" />
                                    绑定封面
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setBindAssetRole('image');
                                        setIsBindAssetModalOpen(true);
                                    }}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition-all active:scale-95',
                                        isImmersiveWorkbench
                                            ? 'border border-border bg-surface-secondary/50 text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary'
                                            : 'bg-black/[0.03] border border-black/[0.02] text-text-secondary hover:text-text-primary hover:bg-black/[0.06]'
                                    )}
                                >
                                    <ImageIcon className="h-3.5 w-3.5" />
                                    插入配图
                                </button>
                            </div>
                        )}

                        {isVideoDraft && (
                            <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-secondary/50 p-1">
                                <button
                                    type="button"
                                    onClick={() => setVideoWorkbenchVersion('v2')}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-black transition-all active:scale-95',
                                        videoWorkbenchVersion === 'v2'
                                            ? 'bg-accent-primary text-white shadow-sm shadow-accent-primary/20'
                                            : 'text-text-tertiary hover:bg-surface-secondary/80 hover:text-text-primary'
                                    )}
                                >
                                    <Scissors className="h-3.5 w-3.5" />
                                    V2 自动剪辑
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setVideoWorkbenchVersion('legacy')}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-black transition-all active:scale-95',
                                        videoWorkbenchVersion === 'legacy'
                                            ? 'bg-surface-primary text-text-primary shadow-sm'
                                            : 'text-text-tertiary hover:bg-surface-secondary/80 hover:text-text-primary'
                                    )}
                                >
                                    旧工作台
                                </button>
                            </div>
                        )}
                        
                        {isVideoPackage && (
                            <button
                                type="button"
                                onClick={() => {
                                    void handleRenderRemotionVideo();
                                }}
                                disabled={isRenderingRemotion || !isScriptConfirmed}
                                title={isScriptConfirmed ? '导出当前视频' : '先确认脚本，再导出视频'}
                                className="inline-flex items-center gap-2 rounded-xl bg-accent-primary px-4 py-2 text-[12px] font-bold text-white shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95 disabled:opacity-40"
                            >
                                {isRenderingRemotion ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                                {isRenderingRemotion ? 'EXPORTING...' : '导出视频'}
                            </button>
                        )}
                        {isAudioPackage && (
                            <button
                                type="button"
                                onClick={() => {
                                    void handleImportAndBindAssetsToPackage();
                                }}
                                className="inline-flex items-center gap-2 rounded-xl bg-accent-primary px-4 py-2 text-[12px] font-bold text-white shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95"
                            >
                                <Upload className="h-3.5 w-3.5" />
                                导入素材
                            </button>
                        )}
                    </div>
                </div>
                {isVideoDraft && videoWorkbenchVersion === 'v2' ? (
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">V2 自动剪辑工作台加载中...</div>}>
                        <VideoEditorV2Workbench
                            isActive={isActive}
                            title={currentDescriptor.title}
                            editorFile={editorFile}
                        />
                    </Suspense>
                ) : isVideoDraft ? (
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">视频工作台加载中...</div>}>
                        <VideoDraftWorkbench
                            isActive={isActive}
                            title={currentDescriptor.title}
                            editorFile={editorFile}
                            packageAssets={packageAssets}
                            packageState={packageState}
                            packagePreviewAssets={packagePreviewAssets}
                            primaryVideoAsset={primaryVideoAsset}
                            timelineClipCount={timelineClipCount}
                            timelineTrackNames={timelineTrackNames}
                            timelineClips={timelineClips}
                            editorBody={editorBody}
                            editorBodyDirty={editorBodyDirty}
                            isSavingEditorBody={isSavingEditorBody}
                            materialsCollapsed={immersiveMaterialsCollapsed}
                            timelineCollapsed={immersiveTimelineCollapsed}
                            editorChatSessionId={editorChatSessionId}
                            remotionComposition={packageState?.remotion || null}
                            remotionRenderPath={packageState?.remotion?.render?.outputPath || null}
                            isGeneratingRemotion={isGeneratingRemotion}
                            isRenderingRemotion={isRenderingRemotion}
                            onEditorBodyChange={(value) => {
                                setEditorBody(value);
                                setEditorBodyDirty(true);
                            }}
                            onOpenBindAssets={() => {
                                void handleImportAndBindAssetsToPackage();
                            }}
                            onPackageStateChange={(state) => applyPackageState(editorFile, state as PackageState)}
                            onConfirmScript={() => {
                                void handleConfirmEditorScript();
                            }}
                            onGenerateRemotionScene={(instructions) => {
                                void handleGenerateRemotionScene(instructions);
                            }}
                            onSaveRemotionScene={(scene) => {
                                void handleSaveRemotionScene(scene);
                            }}
                            onRenderRemotionVideo={() => {
                                void handleRenderRemotionVideo();
                            }}
                            onOpenRenderedVideo={() => {
                                void handleOpenRenderedRemotionVideo();
                            }}
                        />
                    </Suspense>
                ) : isAudioDraft ? (
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">音频工作台加载中...</div>}>
                        <AudioDraftWorkbench
                            editorFile={editorFile}
                            packageAssets={packageAssets}
                            packagePreviewAssets={packagePreviewAssets}
                            primaryAudioAsset={primaryAudioAsset}
                            timelineClipCount={timelineClipCount}
                            timelineTrackNames={timelineTrackNames}
                            timelineClips={timelineClips}
                            editorBody={editorBody}
                            editorBodyDirty={editorBodyDirty}
                            isSavingEditorBody={isSavingEditorBody}
                            materialsCollapsed={immersiveMaterialsCollapsed}
                            timelineCollapsed={immersiveTimelineCollapsed}
                            editorChatSessionId={editorChatSessionId}
                            onEditorBodyChange={(value) => {
                                setEditorBody(value);
                                setEditorBodyDirty(true);
                            }}
                            onOpenBindAssets={() => {
                                void handleImportAndBindAssetsToPackage();
                            }}
                            onPackageStateChange={(state) => applyPackageState(editorFile, state as PackageState)}
                        />
                    </Suspense>
                ) : (
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">写作工作台加载中...</div>}>
                        <WritingDraftWorkbench
                            isActive={isActive}
                            draftType={draftType === 'longform' ? 'longform' : 'unknown'}
                            title={currentDescriptor.title}
                            filePath={editorFile}
                            editorBody={editorWriteProposalView ? editorReviewBody : editorBody}
                            writeProposal={editorWriteProposalView}
                            editorBodyDirty={editorBodyDirty}
                            isSavingEditorBody={isSavingEditorBody}
                            isApplyingWriteProposal={isApplyingWriteProposal}
                            isRejectingWriteProposal={isRejectingWriteProposal}
                            editorChatSessionId={editorChatSessionId}
                            editorChatReady={editorChatSessionReady}
                            onEditorBodyChange={(value) => {
                                if (editorWriteProposalView) {
                                    setEditorReviewBody(value);
                                    return;
                                }
                                setEditorBody(value);
                                setEditorBodyDirty(true);
                            }}
                            onAcceptWriteProposal={() => {
                                void handleAcceptEditorWriteProposal();
                            }}
                            onAiWorkspaceModeChange={setEditorAiWorkspaceMode}
                            onRejectWriteProposal={() => {
                                void handleRejectEditorWriteProposal();
                            }}
                        />
                    </Suspense>
                )}
            </div>
        );
    }


    return (
        <div className="flex h-full min-h-0 items-center justify-center bg-background text-sm text-text-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在打开稿件编辑器...
        </div>
    );
}
