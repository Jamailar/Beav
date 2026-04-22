import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
    ArrowLeft,
    AudioLines,
    Clapperboard,
    ExternalLink,
    FileAudio,
    FileImage,
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
    Sparkles,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { resolveAssetUrl } from '../utils/pathManager';
import { formatTimestampDate, parseTimestampMs } from '../utils/time';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EditorLayoutToggleButton } from '../components/manuscripts/EditorLayoutToggleButton';
import {
    loadRichpostPreviewHtml,
    RICHPOST_RENDER_VIEWPORT_HEIGHT,
    RICHPOST_RENDER_VIEWPORT_WIDTH,
    renderRichpostHtmlToPng,
    renderRichpostPageUrlToPng,
} from '../components/manuscripts/richpostPreviewImage';
import { stabilizeRichpostPagination } from '../components/manuscripts/richpostPaginationGuard';
import { appAlert, appConfirm } from '../utils/appDialogs';
import type { ImmersiveMode, PendingChatMessage } from '../App';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { composeMarkdownWithFrontmatter, parseMarkdownFrontmatter } from '../utils/markdownFrontmatter';
import { uiDebug, uiMeasure } from '../utils/uiDebug';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../shared/redboxVideo';
import type { RemotionCompositionConfig } from '../components/manuscripts/remotion/types';
import type { EditorProjectFile } from '../components/manuscripts/editorProject';
import { WritingDraftWorkbench } from '../components/manuscripts/WritingDraftWorkbench';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel, LiquidGlassMenuSeparator } from '@/components/ui/liquid-glass-menu';
import { buildEditorSessionBinding, type EditorAiWorkspaceMode } from '../features/chat/editorSessionBinding';
import {
    ARTICLE_DRAFT_EXTENSION,
    AUDIO_DRAFT_EXTENSION,
    ensureManuscriptFileName,
    POST_DRAFT_EXTENSION,
    stripManuscriptExtension,
    VIDEO_DRAFT_EXTENSION,
} from '../../shared/manuscriptFiles';

const VideoDraftWorkbench = lazy(async () => ({
    default: (await import('../components/manuscripts/ExperimentalVideoWorkbench')).ExperimentalVideoWorkbench,
}));
const AudioDraftWorkbench = lazy(async () => ({
    default: (await import('../components/manuscripts/AudioDraftWorkbench')).AudioDraftWorkbench,
}));

type DraftFilter = 'all' | 'drafts' | 'media' | 'image' | 'video' | 'audio' | 'folders';
type DraftLayout = 'gallery' | 'list';
type CreateKind = 'folder' | 'longform' | 'richpost' | 'video' | 'audio';
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
    richpostPreviewFile?: string;
    richpostPreviewFileUrl?: string;
    richpostPreviewUpdatedAt?: number;
    richpostPreviewPageFile?: string;
    richpostPreviewPageFileUrl?: string;
    richpostPreviewPageUpdatedAt?: number;
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
    richpostPreviewFileUrl?: string;
    richpostPreviewUpdatedAt?: number;
    richpostPreviewPageFile?: string;
    richpostPreviewPageFileUrl?: string;
    richpostPreviewPageUpdatedAt?: number;
};

type RichpostPreviewOverride = {
    fileUrl: string;
    updatedAt: number;
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
    richpostPreviewFileUrl: string;
    richpostPreviewUpdatedAt: number;
    richpostPreviewPageFile: string;
    richpostPreviewPageFileUrl: string;
    richpostPreviewPageUpdatedAt: number;
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
    layoutTokensExists?: boolean;
    layoutTokensFile?: string | null;
    layoutTokensUpdatedAt?: number | null;
    richpostPagePlanExists?: boolean;
    richpostPagePlanFile?: string | null;
    richpostPagePlanUpdatedAt?: number | null;
    richpostMastersDir?: string | null;
    richpostMasterCount?: number;
    richpostMasters?: Array<{
        id?: string;
        file?: string | null;
        fileUrl?: string | null;
        updatedAt?: number | null;
    }>;
    richpostTheme?: {
        id?: string | null;
        label?: string | null;
        description?: string | null;
    } | null;
    richpostTypography?: {
        fontScale?: number | null;
        lineHeightScale?: number | null;
    } | null;
    richpostFontScale?: number | null;
    richpostLineHeightScale?: number | null;
    richpostThemeId?: string | null;
    richpostThemeLabel?: string | null;
    richpostThemeDescription?: string | null;
    richpostThemeCatalog?: Array<{
        id?: string;
        label?: string;
        description?: string | null;
        source?: string | null;
        shellBg?: string | null;
        pageBg?: string | null;
        surfaceColor?: string | null;
        surfaceBg?: string | null;
        surfaceBorder?: string | null;
        surfaceShadow?: string | null;
        surfaceRadius?: string | null;
        imageRadius?: string | null;
        previewCardBg?: string | null;
        previewCardBorder?: string | null;
        previewCardShadow?: string | null;
        headingColor?: string | null;
        bodyColor?: string | null;
        textColor?: string | null;
        mutedColor?: string | null;
        accentColor?: string | null;
        headingFont?: string | null;
        bodyFont?: string | null;
    }>;
    longformLayoutPreset?: {
        id?: string | null;
        label?: string | null;
        description?: string | null;
    } | null;
    longformLayoutPresetId?: string | null;
    longformLayoutPresetLabel?: string | null;
    longformLayoutPresetDescription?: string | null;
    longformLayoutPresetCatalog?: Array<{
        id?: string;
        label?: string;
        description?: string | null;
        surfaceColor?: string | null;
        textColor?: string | null;
        accentColor?: string | null;
    }>;
    richpostPagesDir?: string | null;
    richpostThemesDir?: string | null;
    richpostThemesFile?: string | null;
    richpostThemeTemplateFile?: string | null;
    richpostThemeRoot?: string | null;
    richpostThemeConfigFile?: string | null;
    richpostThemeTokensFile?: string | null;
    richpostThemePagePlanFile?: string | null;
    richpostThemeAssetsDir?: string | null;
    richpostThemeMastersDir?: string | null;
    richpostThemeMasters?: Array<{
        id?: string;
        file?: string | null;
        fileUrl?: string | null;
        updatedAt?: number | null;
    }> | null;
    richpostPageCount?: number;
    richpostPages?: Array<{
        id?: string;
        label?: string;
        template?: string;
        title?: string | null;
        summary?: string | null;
        blockIds?: string[];
        file?: string | null;
        fileUrl?: string | null;
        exists?: boolean;
        updatedAt?: number | null;
    }>;
    layoutTemplateExists?: boolean;
    wechatTemplateExists?: boolean;
    layoutTemplateFile?: string | null;
    wechatTemplateFile?: string | null;
    layoutTemplateUpdatedAt?: number | null;
    wechatTemplateUpdatedAt?: number | null;
    hasLayoutHtml?: boolean;
    hasWechatHtml?: boolean;
    layoutHtmlExists?: boolean;
    wechatHtmlExists?: boolean;
    layoutHtmlFile?: string | null;
    wechatHtmlFile?: string | null;
    layoutHtmlFileUrl?: string | null;
    wechatHtmlFileUrl?: string | null;
    layoutHtmlUpdatedAt?: number | null;
    wechatHtmlUpdatedAt?: number | null;
    layoutHtml?: string;
    wechatHtml?: string;
};

type ExportVideoResolution = 'source' | '1080p' | '720p';

const DEFAULT_UNTITLED_DRAFT_TITLE = '未命名';
const RICHPOST_CARD_PREVIEW_WIDTH = 1080;
const RICHPOST_CARD_PREVIEW_HEIGHT = 1440;
const RICHPOST_CARD_PREVIEW_VIEWPORT_WIDTH = RICHPOST_RENDER_VIEWPORT_WIDTH;
const RICHPOST_CARD_PREVIEW_VIEWPORT_HEIGHT = RICHPOST_RENDER_VIEWPORT_HEIGHT;
const RICHPOST_CARD_PREVIEW_DEBOUNCE_MS = 700;

function resolveDraftExtension(kind: CreateKind | 'unknown'): string {
    if (kind === 'longform') return ARTICLE_DRAFT_EXTENSION;
    if (kind === 'richpost') return POST_DRAFT_EXTENSION;
    if (kind === 'video') return VIDEO_DRAFT_EXTENSION;
    if (kind === 'audio') return AUDIO_DRAFT_EXTENSION;
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
    return ensureManuscriptFileName(
        baseName,
        extension as typeof ARTICLE_DRAFT_EXTENSION | typeof POST_DRAFT_EXTENSION | typeof VIDEO_DRAFT_EXTENSION | typeof AUDIO_DRAFT_EXTENSION | '.md',
    );
}

interface ManuscriptsProps {
    pendingFile?: string | null;
    onFileConsumed?: () => void;
    onNavigateToRedClaw?: (message: PendingChatMessage) => void;
    isActive?: boolean;
    onImmersiveModeChange?: (mode: ImmersiveMode) => void;
}

const CREATE_KIND_OPTIONS: Array<{ id: CreateKind; label: string; icon: typeof FileText; accentClass: string; available: boolean; unavailableHint?: string }> = [
    { id: 'longform', label: '长文', icon: FileText, accentClass: 'from-[#E8D9FF] via-[#F6EEFF] to-white text-[#7C57C8]', available: false, unavailableHint: '暂未开放' },
    { id: 'richpost', label: '图文', icon: FileImage, accentClass: 'from-[#FFD9C7] via-[#FFF1E9] to-white text-[#C56B3D]', available: true },
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
    const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return false;
    return parts.slice(0, -1).some((part) => (
        part.endsWith(ARTICLE_DRAFT_EXTENSION)
        || part.endsWith(POST_DRAFT_EXTENSION)
        || part.endsWith(VIDEO_DRAFT_EXTENSION)
        || part.endsWith(AUDIO_DRAFT_EXTENSION)
    ));
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
            : kind === 'richpost'
                ? '图文草稿'
                : '长文草稿';

    if (kind === 'video' || kind === 'audio') {
        return `# ${safeTitle}\n\n## ${sectionTitle}\n\n## 剪辑目标\n\n\n## 时间线规划\n\n\n## 素材备注\n\n`;
    }

    if (kind === 'richpost') {
        return '';
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
    return `${Date.now()}`;
}

function pathBasenameSafe(rawPath: string): string {
    const normalized = String(rawPath || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}

function isSameDraftRelativePath(left: string | null | undefined, right: string | null | undefined): boolean {
    return String(left || '').replace(/\\/g, '/').trim() === String(right || '').replace(/\\/g, '/').trim();
}

function inferAssetKind(asset: MediaAsset): 'image' | 'video' | 'audio' | 'unknown' {
    const mime = String(asset.mimeType || '').toLowerCase();
    const ref = `${asset.relativePath || ''} ${asset.previewUrl || ''} ${asset.absolutePath || ''}`.toLowerCase();
    if (mime.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(ref)) return 'image';
    if (mime.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(ref)) return 'video';
    if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(ref)) return 'audio';
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
    if (type === 'richpost') return '图文';
    if (type === 'video') return '视频';
    if (type === 'audio') return '音频';
    return '稿件';
}

function resolveDraftTypeTheme(type: CreateKind | 'unknown'): { chip: string; tile: string; iconWrap: string } {
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
    if (type === 'richpost') {
        return {
            chip: 'bg-amber-500/10 text-amber-700 border border-amber-200/90',
            tile: 'bg-[linear-gradient(135deg,#7c3f00_0%,#c46f00_52%,#ffd166_100%)] text-white',
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
                richpostPreviewFileUrl: item.richpostPreviewFileUrl || undefined,
                richpostPreviewUpdatedAt: Number(item.richpostPreviewUpdatedAt || 0) || undefined,
                richpostPreviewPageFile: item.richpostPreviewPageFile || undefined,
                richpostPreviewPageFileUrl: item.richpostPreviewPageFileUrl || undefined,
                richpostPreviewPageUpdatedAt: Number(item.richpostPreviewPageUpdatedAt || 0) || undefined,
            };
        }
    };
    visit(nodes);
    return next;
}

export function Manuscripts({ pendingFile, onFileConsumed, onNavigateToRedClaw, isActive = false, onImmersiveModeChange }: ManuscriptsProps) {
    const [mode, setMode] = useState<'gallery' | 'editor'>('gallery');
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
    const [richpostPreviewOverrides, setRichpostPreviewOverrides] = useState<Record<string, RichpostPreviewOverride>>({});
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
    const [quality, setQuality] = useState('standard');
    const [generationMode, setGenerationMode] = useState<'text-to-image' | 'reference-guided' | 'image-to-image'>('text-to-image');
    const [referenceImages, setReferenceImages] = useState<ReferenceImageItem[]>([]);
    const [isReadingRefImages, setIsReadingRefImages] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [genError, setGenError] = useState('');
    const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
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
    const [isUpgradingDraft, setIsUpgradingDraft] = useState(false);
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
    const [editorBodyDirty, setEditorBodyDirty] = useState(false);
    const [isSavingEditorBody, setIsSavingEditorBody] = useState(false);
    const [isApplyingWriteProposal, setIsApplyingWriteProposal] = useState(false);
    const [isRejectingWriteProposal, setIsRejectingWriteProposal] = useState(false);
    const [editorAiWorkspaceMode, setEditorAiWorkspaceMode] = useState<EditorAiWorkspaceMode>({
        id: 'manuscript-editing',
        label: '稿件编辑',
        activeSkills: [],
    });
    const [immersiveMaterialsCollapsed, setImmersiveMaterialsCollapsed] = useState(false);
    const [immersiveTimelineCollapsed, setImmersiveTimelineCollapsed] = useState(false);
    const treeRequestIdRef = useRef(0);
    const assetsRequestIdRef = useRef(0);
    const hasLoadedSnapshotRef = useRef(false);
    const deferredAssetsTimerRef = useRef<number | null>(null);
    const searchPopoverRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const folderContextMenuRef = useRef<HTMLDivElement | null>(null);
    const assetContextMenuRef = useRef<HTMLDivElement | null>(null);
    const draftContextMenuRef = useRef<HTMLDivElement | null>(null);
    const editorFileRef = useRef<string | null>(null);
    const editorBodyRef = useRef('');
    const editorFrontmatterBlockRef = useRef<string | null>(null);
    const editorMetadataRef = useRef<Record<string, unknown>>({});
    const editorBodyDirtyRef = useRef(false);
    const editorSavePromiseRef = useRef<Promise<boolean> | null>(null);
    const richpostTypographyRequestIdRef = useRef(0);
    const richpostAutoRenderRequestKeyRef = useRef<string | null>(null);
    const richpostPreviewGenerationRef = useRef<Set<string>>(new Set());
    const richpostCardPreviewTimerRef = useRef<number | null>(null);
    const richpostCardPreviewRenderedAtRef = useRef<Record<string, number>>({});
    const fileMetaMap = useMemo(() => collectFileMetaMap(tree), [tree]);
    const isMediaScope = filter === 'media' || filter === 'image' || filter === 'video' || filter === 'audio';
    const mediaFolderTree = useMemo(() => buildMediaFolderTree(assets), [assets]);
    const currentEditorContent = useMemo(
        () => composeMarkdownWithFrontmatter(editorBody, editorFrontmatterBlock),
        [editorBody, editorFrontmatterBlock]
    );

    useEffect(() => {
        editorFileRef.current = editorFile;
    }, [editorFile]);

    useEffect(() => {
        editorBodyRef.current = editorBody;
    }, [editorBody]);

    useEffect(() => {
        editorFrontmatterBlockRef.current = editorFrontmatterBlock;
    }, [editorFrontmatterBlock]);

    useEffect(() => {
        editorMetadataRef.current = editorMetadata;
    }, [editorMetadata]);

    useEffect(() => {
        editorBodyDirtyRef.current = editorBodyDirty;
    }, [editorBodyDirty]);

    useEffect(() => () => {
        if (richpostCardPreviewTimerRef.current != null) {
            window.clearTimeout(richpostCardPreviewTimerRef.current);
            richpostCardPreviewTimerRef.current = null;
        }
    }, []);

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
            setQuality(next.image_quality || 'standard');
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
        if (!pendingFile) return;
        void (async () => {
            setEditorFile(pendingFile);
            setMode('editor');
            try {
                const result = await window.ipcRenderer.invoke('manuscripts:read', pendingFile) as ManuscriptReadResult;
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
            } finally {
                onFileConsumed?.();
            }
        })();
    }, [onFileConsumed, pendingFile]);

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
            if (filter === 'media' && !['image', 'video', 'audio'].includes(assetKind)) return false;
            if (filter === 'image' && assetKind !== 'image') return false;
            if (filter === 'video' && assetKind !== 'video') return false;
            if (filter === 'audio' && assetKind !== 'audio') return false;
            if (filter === 'drafts' || filter === 'folders') return false;
            if (isMediaScope && getRelativeFolderPath(asset.relativePath || '') !== mediaFolder) return false;
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

    const handleDeleteDraft = useCallback(async (targetPath: string) => {
        setWorkingId(targetPath);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete', targetPath) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '删除失败');
            if (isSameOrNestedPath(targetPath, activeFolder)) {
                setActiveFolder('');
            }
            if (isSameOrNestedPath(targetPath, editorFile)) {
                setEditorFile(null);
                setEditorDescriptor(null);
                setEditorBody('');
                setEditorFrontmatterBlock(null);
                setEditorMetadata({});
                setEditorWriteProposal(null);
                setEditorBodyDirty(false);
                setPackageState(null);
                setEditorChatSessionId(null);
                setMode('gallery');
            }
            setPendingDeleteDraftPath(null);
            await loadData();
        } catch (deleteError) {
            void appAlert(deleteError instanceof Error ? deleteError.message : '删除失败');
        } finally {
            setWorkingId(null);
        }
    }, [activeFolder, editorFile, isSameOrNestedPath, loadData]);

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

    const generateRichpostCardPreview = useCallback(async (
        targetFilePath: string,
        pageFileUrl: string,
        pageFilePath: string,
        pageUpdatedAt: number,
    ) => {
        if (!targetFilePath || !pageUpdatedAt) return;
        const normalizedPageFileUrl = String(pageFileUrl || '').trim();
        const normalizedPageFilePath = String(pageFilePath || '').trim();
        if (!normalizedPageFileUrl && !normalizedPageFilePath) return;
        if (richpostPreviewGenerationRef.current.has(targetFilePath)) return;
        richpostPreviewGenerationRef.current.add(targetFilePath);
        try {
            const renderOptions = {
                width: RICHPOST_CARD_PREVIEW_WIDTH,
                height: RICHPOST_CARD_PREVIEW_HEIGHT,
                viewportWidth: RICHPOST_CARD_PREVIEW_VIEWPORT_WIDTH,
                viewportHeight: RICHPOST_CARD_PREVIEW_VIEWPORT_HEIGHT,
            };
            let dataUrl = '';
            if (normalizedPageFileUrl) {
                try {
                    dataUrl = await renderRichpostPageUrlToPng(normalizedPageFileUrl, targetFilePath, renderOptions);
                } catch (renderByUrlError) {
                    console.warn('Failed to render richpost preview by URL, falling back to HTML snapshot:', renderByUrlError);
                }
            }
            if (!dataUrl) {
                const html = await loadRichpostPreviewHtml(normalizedPageFilePath);
                try {
                    dataUrl = await renderRichpostHtmlToPng(html, targetFilePath, renderOptions);
                } catch (renderByHtmlError) {
                    console.warn('Failed to render richpost preview with scaled options, retrying legacy size:', renderByHtmlError);
                    dataUrl = await renderRichpostHtmlToPng(html, targetFilePath);
                }
            }
            const dataBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            const saved = await window.ipcRenderer.invoke('manuscripts:save-richpost-card-preview', {
                filePath: targetFilePath,
                dataBase64,
            }) as { success?: boolean; fileUrl?: string; updatedAt?: number; error?: string };
            if (!saved?.success || !saved.fileUrl) {
                throw new Error(saved?.error || '保存图文封面失败');
            }
            richpostCardPreviewRenderedAtRef.current[targetFilePath] = pageUpdatedAt;
            setRichpostPreviewOverrides((prev) => ({
                ...prev,
                [targetFilePath]: {
                    fileUrl: saved.fileUrl || '',
                    updatedAt: Number(saved.updatedAt || Date.now()) || Date.now(),
                },
            }));
            void loadTree();
        } catch (previewError) {
            console.error('Failed to build richpost card preview:', previewError);
        } finally {
            richpostPreviewGenerationRef.current.delete(targetFilePath);
        }
    }, [loadTree]);

    const scheduleRichpostCardPreviewFromState = useCallback((
        targetFilePath: string,
        state?: PackageState | null,
        delayMs: number = RICHPOST_CARD_PREVIEW_DEBOUNCE_MS,
    ) => {
        if (!targetFilePath) return;
        const firstPage = state?.richpostPages?.find((page) => page?.exists && (page.fileUrl || page.file));
        const pageFileUrl = String(firstPage?.fileUrl || '').trim();
        const pageFilePath = String(firstPage?.file || '').trim();
        const pageUpdatedAt = Number(firstPage?.updatedAt || 0) || 0;
        if ((!pageFileUrl && !pageFilePath) || !pageUpdatedAt) return;
        if ((richpostCardPreviewRenderedAtRef.current[targetFilePath] || 0) >= pageUpdatedAt) return;
        if (richpostCardPreviewTimerRef.current != null) {
            window.clearTimeout(richpostCardPreviewTimerRef.current);
        }
        richpostCardPreviewTimerRef.current = window.setTimeout(() => {
            richpostCardPreviewTimerRef.current = null;
            void generateRichpostCardPreview(targetFilePath, pageFileUrl, pageFilePath, pageUpdatedAt);
        }, delayMs);
    }, [generateRichpostCardPreview]);

    const applyPackageState = useCallback((
        targetPath: string,
        nextState?: PackageState | null,
        delayMs: number = 120,
    ) => {
        setPackageState(nextState || null);
        if (!targetPath || !nextState || (nextState.richpostPages?.length || 0) === 0) {
            return;
        }
        scheduleRichpostCardPreviewFromState(targetPath, nextState, delayMs);
    }, [scheduleRichpostCardPreviewFromState]);

    const refreshPackageState = useCallback(async (targetPath: string) => {
        const isPackage = targetPath.endsWith(ARTICLE_DRAFT_EXTENSION)
            || targetPath.endsWith(POST_DRAFT_EXTENSION)
            || targetPath.endsWith(VIDEO_DRAFT_EXTENSION)
            || targetPath.endsWith(AUDIO_DRAFT_EXTENSION);
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

    const handleGeneratePackageHtml = useCallback(async (target: 'layout' | 'wechat') => {
        if (!editorFile) return;
        const workingKey = `package-html:${target}`;
        setWorkingId(workingKey);
        try {
            const saved = await ensureLatestEditorContentSaved();
            if (!saved) return;
            const result = await window.ipcRenderer.invoke('manuscripts:generate-package-html', {
                filePath: editorFile,
                target,
            }) as { success?: boolean; error?: string; state?: PackageState };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '生成 HTML 失败');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '生成 HTML 失败');
        } finally {
            setWorkingId((current) => current === workingKey ? null : current);
        }
    }, [editorFile, ensureLatestEditorContentSaved]);

    const resolveRichpostState = useCallback(async (
        filePath: string,
        nextState: PackageState,
        plan?: unknown,
    ) => {
        let resolvedState = nextState;
        if ((nextState.richpostPages?.length || 0) > 0) {
            const corrected = await stabilizeRichpostPagination({
                filePath,
                state: nextState,
                plan,
            });
            resolvedState = corrected.state;
        }
        return resolvedState;
    }, []);

    const handleSelectRichpostTheme = useCallback(async (themeId: string) => {
        if (!editorFile || !themeId.trim()) return;
        if (packageState?.richpostThemeId === themeId) return;
        const workingKey = `richpost-theme:${themeId}`;
        setWorkingId(workingKey);
        try {
            const saved = await ensureLatestEditorContentSaved();
            if (!saved) return;
            const result = await window.ipcRenderer.invoke('manuscripts:set-richpost-theme', {
                filePath: editorFile,
                themeId,
            }) as { success?: boolean; error?: string; state?: PackageState };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '切换图文主题失败');
            }
            const resolvedState = await resolveRichpostState(editorFile, result.state);
            setPackageState(resolvedState);
            if ((resolvedState.richpostPages?.length || 0) > 0) {
                scheduleRichpostCardPreviewFromState(editorFile, resolvedState, 120);
            }
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '切换图文主题失败');
        } finally {
            setWorkingId((current) => current === workingKey ? null : current);
        }
    }, [editorFile, ensureLatestEditorContentSaved, packageState?.richpostThemeId, resolveRichpostState, scheduleRichpostCardPreviewFromState]);

    const handleUpdateRichpostTypography = useCallback(async (settings: {
        fontScale: number;
        lineHeightScale: number;
    }) => {
        if (!editorFile) return;
        const requestFile = editorFile;
        const requestId = ++richpostTypographyRequestIdRef.current;
        try {
            const saved = await ensureLatestEditorContentSaved();
            if (!saved) return;
            const result = await window.ipcRenderer.invoke('manuscripts:render-richpost-pages', {
                filePath: requestFile,
                fontScale: settings.fontScale,
                lineHeightScale: settings.lineHeightScale,
            }) as { success?: boolean; error?: string; state?: PackageState };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '更新图文排版失败');
            }
            if (richpostTypographyRequestIdRef.current !== requestId || editorFileRef.current !== requestFile) {
                return;
            }
            const resolvedState = await resolveRichpostState(requestFile, result.state);
            if (richpostTypographyRequestIdRef.current !== requestId || editorFileRef.current !== requestFile) {
                return;
            }
            setPackageState(resolvedState);
            if ((resolvedState.richpostPages?.length || 0) > 0) {
                scheduleRichpostCardPreviewFromState(requestFile, resolvedState, 120);
            }
        } catch (error) {
            if (richpostTypographyRequestIdRef.current !== requestId || editorFileRef.current !== requestFile) {
                return;
            }
            console.error('Failed to update richpost typography:', error);
            void appAlert(error instanceof Error ? error.message : '更新图文排版失败');
        }
    }, [editorFile, ensureLatestEditorContentSaved, resolveRichpostState, scheduleRichpostCardPreviewFromState]);

    useEffect(() => {
        if (!editorFile || !editorFile.endsWith(POST_DRAFT_EXTENSION)) {
            return;
        }
        if (editorBodyDirty || isSavingEditorBody) {
            return;
        }
        if ((packageState?.richpostPages?.length || 0) > 0) {
            return;
        }
        const requestKey = [
            editorFile,
            String(packageState?.contentMapUpdatedAt || 0),
            String(packageState?.layoutTokensUpdatedAt || 0),
            String(packageState?.richpostPagePlanUpdatedAt || 0),
        ].join('::');
        if (richpostAutoRenderRequestKeyRef.current === requestKey) {
            return;
        }
        richpostAutoRenderRequestKeyRef.current = requestKey;
        let cancelled = false;
        void (async () => {
            try {
                const result = await window.ipcRenderer.invoke('manuscripts:render-richpost-pages', {
                    filePath: editorFile,
                }) as { success?: boolean; error?: string; state?: PackageState };
                if (!result?.success || !result.state) {
                    throw new Error(result?.error || '自动刷新图文分页失败');
                }
                const resolvedState = await resolveRichpostState(editorFile, result.state);
                if (cancelled || editorFileRef.current !== editorFile) {
                    return;
                }
                setPackageState(resolvedState);
                if ((resolvedState.richpostPages?.length || 0) > 0) {
                    scheduleRichpostCardPreviewFromState(editorFile, resolvedState, 120);
                }
            } catch (error) {
                if (cancelled || editorFileRef.current !== editorFile) {
                    return;
                }
                console.error('Failed to auto render richpost pages:', error);
                richpostAutoRenderRequestKeyRef.current = null;
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [
        editorBodyDirty,
        editorFile,
        isSavingEditorBody,
        packageState?.contentMapUpdatedAt,
        packageState?.layoutTokensUpdatedAt,
        packageState?.richpostPagePlanUpdatedAt,
        packageState?.richpostPages?.length,
        resolveRichpostState,
        scheduleRichpostCardPreviewFromState,
    ]);

    const handleSelectLongformLayoutPreset = useCallback(async (presetId: string, target: 'layout' | 'wechat') => {
        if (!editorFile || !presetId.trim()) return;
        const workingKey = `longform-layout-preset:${presetId}:${target}`;
        setWorkingId(workingKey);
        try {
            const saved = await ensureLatestEditorContentSaved();
            if (!saved) return;
            const result = await window.ipcRenderer.invoke('manuscripts:set-longform-layout-preset', {
                filePath: editorFile,
                presetId,
                target,
            }) as { success?: boolean; error?: string; state?: PackageState };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '切换长文母版失败');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '切换长文母版失败');
        } finally {
            setWorkingId((current) => current === workingKey ? null : current);
        }
    }, [editorFile, ensureLatestEditorContentSaved]);

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

    const handleUpgradeDraftPackage = useCallback(async (targetKind: 'article' | 'post') => {
        if (!editorFile) return;
        setIsUpgradingDraft(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:upgrade-to-package', {
                sourcePath: editorFile,
                targetKind,
            }) as { success?: boolean; error?: string; newPath?: string };
            if (!result?.success || !result.newPath) {
                throw new Error(result?.error || '升级工程稿件失败');
            }
            await loadData();
            setEditorFile(result.newPath);
            await refreshPackageState(result.newPath);
        } catch (upgradeError) {
            void appAlert(upgradeError instanceof Error ? upgradeError.message : '升级工程稿件失败');
        } finally {
            setIsUpgradingDraft(false);
        }
    }, [editorFile, loadData, refreshPackageState]);

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
            return;
        }
        void loadEditorWriteProposal(editorFile);
    }, [editorFile, loadEditorWriteProposal, mode]);

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
            const result = await window.ipcRenderer.invoke('manuscripts:accept-write-proposal', {
                filePath: editorFile,
            }) as { success?: boolean; error?: string; content?: string; state?: PackageState };
            if (!result?.success || typeof result.content !== 'string') {
                throw new Error(result?.error || '接受 AI 修改失败');
            }
            const nextDraft = splitWritingDraftContent(result.content, editorDescriptor?.draftType);
            setEditorBody(nextDraft.body);
            setEditorFrontmatterBlock(nextDraft.frontmatterBlock);
            setEditorBodyDirty(false);
            setEditorWriteProposal(null);
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
            const result = await window.ipcRenderer.invoke('manuscripts:confirm-package-script', {
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
            const result = await window.ipcRenderer.invoke('image-gen:generate', {
                prompt,
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
            }) as { success?: boolean; error?: string; assets?: GeneratedAsset[] };

            if (!result?.success) {
                setGenError(result?.error || '生图失败');
                return;
            }
            setGeneratedAssets(Array.isArray(result.assets) ? result.assets : []);
            await loadData();
        } catch (generationError) {
            console.error('Failed to generate images:', generationError);
            setGenError('生图失败');
        } finally {
            setIsGenerating(false);
        }
    }, [aspectRatio, count, genProjectId, genTitle, generationMode, loadData, model, prompt, quality, referenceImages, settings.image_provider, settings.image_provider_template, size]);

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
        if (!videoPrompt.trim()) {
            setVideoGenError('请先输入视频提示词');
            return;
        }
        if (videoGenerationMode === 'reference-guided' && effectiveVideoReferenceImages.length < 1) {
            setVideoGenError('参考图视频模式至少需要 1 张参考图');
            return;
        }
        if (videoGenerationMode === 'first-last-frame' && effectiveVideoReferenceImages.length < 2) {
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
            const result = await window.ipcRenderer.invoke('video-gen:generate', {
                prompt: videoPrompt,
                projectId: videoProjectId.trim() || undefined,
                title: videoTitle.trim() || undefined,
                model: effectiveVideoModel,
                generationMode: effectiveVideoReferenceImages.length > 0 ? videoGenerationMode : 'text-to-video',
                referenceImages: effectiveVideoReferenceImages.map((item) => item.dataUrl),
                aspectRatio: videoAspectRatio,
                resolution: videoResolution,
                durationSeconds: videoDurationSeconds,
                count: 1,
                generateAudio: false,
            }) as { success?: boolean; error?: string; assets?: GeneratedAsset[] };

            if (!result?.success) {
                setVideoGenError(result?.error || '生视频失败');
                return;
            }
            setGeneratedVideoAssets(Array.isArray(result.assets) ? result.assets : []);
            await loadData();
        } catch (generationError) {
            console.error('Failed to generate videos:', generationError);
            setVideoGenError('生视频失败');
        } finally {
            setIsGeneratingVideo(false);
        }
    }, [
        effectiveVideoModel,
        hasVideoConfig,
        loadData,
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
                richpostPreviewFileUrl: meta?.richpostPreviewFileUrl || '',
                richpostPreviewUpdatedAt: Number(meta?.richpostPreviewUpdatedAt || 0) || 0,
                richpostPreviewPageFile: meta?.richpostPreviewPageFile || '',
                richpostPreviewPageFileUrl: meta?.richpostPreviewPageFileUrl || '',
                richpostPreviewPageUpdatedAt: Number(meta?.richpostPreviewPageUpdatedAt || 0) || 0,
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

    useEffect(() => {
        if (mode !== 'gallery' || filter !== 'drafts') return;
        const pendingCards = contentCards.filter((card): card is DraftCard => {
            if (card.kind !== 'draft' || card.draftType !== 'richpost') {
                return false;
            }
            const hasPreviewSource = Boolean(card.richpostPreviewPageFileUrl || card.richpostPreviewPageFile);
            if (!hasPreviewSource) return false;
            const override = richpostPreviewOverrides[card.file.path];
            const overrideIsFresh = Boolean(
                override?.fileUrl
                && Number(override.updatedAt || 0) >= Number(card.richpostPreviewPageUpdatedAt || 0)
            );
            const persistedPreviewIsFresh = Boolean(
                card.richpostPreviewFileUrl
                && Number(card.richpostPreviewUpdatedAt || 0) >= Number(card.richpostPreviewPageUpdatedAt || 0)
            );
            return !persistedPreviewIsFresh
                && !overrideIsFresh
                && !richpostPreviewGenerationRef.current.has(card.file.path);
        });
        if (pendingCards.length === 0) return;

        let cancelled = false;
        void (async () => {
            for (const card of pendingCards) {
                if (cancelled) return;
                try {
                    await generateRichpostCardPreview(
                        card.file.path,
                        card.richpostPreviewPageFileUrl || '',
                        card.richpostPreviewPageFile || '',
                        Number(card.richpostPreviewPageUpdatedAt || 0) || Date.now(),
                    );
                    if (cancelled) return;
                } catch (error) {
                    console.error('Failed to build richpost card preview:', error);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [contentCards, filter, generateRichpostCardPreview, mode, richpostPreviewOverrides]);

    useEffect(() => {
        if (!editorFile) return;
        if ((packageState?.richpostPages?.length || 0) === 0) return;
        scheduleRichpostCardPreviewFromState(editorFile, packageState);
        return () => {
            if (richpostCardPreviewTimerRef.current != null) {
                window.clearTimeout(richpostCardPreviewTimerRef.current);
                richpostCardPreviewTimerRef.current = null;
            }
        };
    }, [editorFile, packageState, scheduleRichpostCardPreviewFromState]);

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
        const draftTheme = resolveDraftTypeTheme(draftType);
        const isVideoDraft = draftType === 'video';
        const isAudioDraft = draftType === 'audio';
        const isImmersiveWorkbench = mode === 'editor';
        const isRichPostDraft = draftType === 'richpost';
        const isMarkdownDraft = editorFile.endsWith('.md');
        const canUpgradeToArticle = draftType === 'longform' && isMarkdownDraft;
        const canUpgradeToPost = draftType === 'richpost' && isMarkdownDraft;
        const isArticlePackage = editorFile.endsWith(ARTICLE_DRAFT_EXTENSION);
        const isPostPackage = editorFile.endsWith(POST_DRAFT_EXTENSION);
        const isVideoPackage = editorFile.endsWith(VIDEO_DRAFT_EXTENSION);
        const isAudioPackage = editorFile.endsWith(AUDIO_DRAFT_EXTENSION);
        const isScriptConfirmed = (
            packageState?.videoProject?.scriptApproval?.status
            || packageState?.editorProject?.ai?.scriptApproval?.status
        ) === 'confirmed';
        const editorWriteProposalView = editorWriteProposal ? {
            id: editorWriteProposal.id,
            createdAt: editorWriteProposal.createdAt,
            baseBody: splitWritingDraftContent(editorWriteProposal.baseContent, draftType).body,
            proposedBody: splitWritingDraftContent(editorWriteProposal.proposedContent, draftType).body,
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
        const articleLayoutPreview = {
            filePath: packageState?.layoutHtmlFile || null,
            fileUrl: packageState?.layoutHtmlFileUrl || null,
            exists: Boolean(packageState?.layoutHtmlExists || packageState?.layoutHtmlFile || packageState?.layoutHtmlFileUrl),
            hasContent: Boolean(packageState?.hasLayoutHtml),
            updatedAt: Number(packageState?.layoutHtmlUpdatedAt || 0) || null,
        };
        const articleWechatPreview = {
            filePath: packageState?.wechatHtmlFile || null,
            fileUrl: packageState?.wechatHtmlFileUrl || null,
            exists: Boolean(packageState?.wechatHtmlExists || packageState?.wechatHtmlFile || packageState?.wechatHtmlFileUrl),
            hasContent: Boolean(packageState?.hasWechatHtml),
            updatedAt: Number(packageState?.wechatHtmlUpdatedAt || 0) || null,
        };
        const richpostPagePreviews = Array.isArray(packageState?.richpostPages)
            ? packageState.richpostPages.map((page, index) => ({
                id: String(page?.id || `page-${index + 1}`),
                label: String(page?.label || `第 ${index + 1} 页`),
                template: String(page?.template || 'text-stack'),
                title: page?.title ? String(page.title) : null,
                summary: page?.summary ? String(page.summary) : null,
                filePath: page?.file ? String(page.file) : null,
                fileUrl: page?.fileUrl ? String(page.fileUrl) : null,
                exists: Boolean(page?.exists || page?.file || page?.fileUrl),
                updatedAt: Number(page?.updatedAt || 0) || null,
            }))
            : [];
        const isGeneratingLayoutHtml = workingId === 'package-html:layout';
        const isGeneratingWechatHtml = workingId === 'package-html:wechat';
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
            <div className={clsx('h-full min-h-0 flex flex-col', isImmersiveWorkbench ? 'editor-ui-shell bg-background text-text-primary' : 'bg-surface-primary')}>
                <div className={clsx(
                    'flex items-center justify-between gap-3 px-6 py-3.5 backdrop-blur-md z-30',
                    isImmersiveWorkbench
                        ? 'border-b border-border bg-background/86 backdrop-blur-[32px]'
                        : 'border-b border-black/[0.03] bg-white/80 backdrop-blur-[32px]'
                )}>
                    <div className="flex items-center gap-4 min-w-0">
                        <button
                            type="button"
                            onClick={() => setMode('gallery')}
                            className={clsx(
                                'group inline-flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-[13px] font-bold transition-all active:scale-95',
                                isImmersiveWorkbench
                                    ? 'bg-surface-secondary/50 border border-border text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary'
                                    : 'bg-black/[0.03] border border-black/[0.02] text-text-secondary hover:bg-black/[0.06] hover:text-text-primary'
                            )}
                        >
                            <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" />
                            返回草稿
                        </button>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2.5">
                                <div className={clsx('text-[15px] font-extrabold tracking-tight truncate', isImmersiveWorkbench ? 'text-text-primary' : 'text-text-primary')}>{currentDescriptor.title}</div>
                                <span className={clsx('rounded-lg px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest', draftTheme.chip)}>
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
                        
                        {canUpgradeToArticle && (
                            <button
                                type="button"
                                onClick={() => void handleUpgradeDraftPackage('article')}
                                disabled={isUpgradingDraft}
                                className={clsx(
                                    'inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-bold transition-all disabled:opacity-40 active:scale-95 shadow-sm',
                                    isImmersiveWorkbench
                                        ? 'bg-accent-primary text-white hover:bg-accent-hover'
                                        : 'bg-text-primary text-white hover:bg-text-primary/90 shadow-text-primary/10'
                                )}
                            >
                                <Sparkles className="h-3.5 w-3.5" />
                                {isUpgradingDraft ? 'UPGRADING...' : '升级为排版工程'}
                            </button>
                        )}
                        {canUpgradeToPost && (
                            <button
                                type="button"
                                onClick={() => void handleUpgradeDraftPackage('post')}
                                disabled={isUpgradingDraft}
                                className={clsx(
                                    'inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-bold transition-all disabled:opacity-40 active:scale-95 shadow-sm',
                                    isImmersiveWorkbench
                                        ? 'bg-accent-primary text-white hover:bg-accent-hover'
                                        : 'bg-text-primary text-white hover:bg-text-primary/90 shadow-text-primary/10'
                                )}
                            >
                                <Sparkles className="h-3.5 w-3.5" />
                                {isUpgradingDraft ? 'UPGRADING...' : '升级为图文工程'}
                            </button>
                        )}
                        
                        {isArticlePackage && (
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => void handleGeneratePackageHtml('layout')}
                                    disabled={isGeneratingLayoutHtml}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition-all disabled:opacity-40 active:scale-95',
                                        isImmersiveWorkbench
                                            ? 'border border-border bg-surface-secondary/50 text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary'
                                            : 'bg-black/[0.03] border border-black/[0.02] text-text-secondary hover:text-text-primary hover:bg-black/[0.06]'
                                    )}
                                >
                                    {isGeneratingLayoutHtml ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                    {articleLayoutPreview.hasContent ? '重做排版' : '生成排版'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleGeneratePackageHtml('wechat')}
                                    disabled={isGeneratingWechatHtml}
                                    className={clsx(
                                        'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition-all disabled:opacity-40 active:scale-95',
                                        isImmersiveWorkbench
                                            ? 'border border-border bg-surface-secondary/50 text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary'
                                            : 'bg-black/[0.03] border border-black/[0.02] text-text-secondary hover:text-text-primary hover:bg-black/[0.06]'
                                    )}
                                >
                                    {isGeneratingWechatHtml ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                    {articleWechatPreview.hasContent ? '重做公众号' : '生成公众号'}
                                </button>
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
                                    <FileImage className="h-3.5 w-3.5" />
                                    插入配图
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
                {isVideoDraft ? (
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
                    <WritingDraftWorkbench
                        isActive={isActive}
                        draftType={isRichPostDraft ? 'richpost' : draftType === 'longform' ? 'longform' : 'unknown'}
                        title={currentDescriptor.title}
                        filePath={editorFile}
                        editorBody={editorBody}
                        writeProposal={editorWriteProposalView}
                        editorBodyDirty={editorBodyDirty}
                        isSavingEditorBody={isSavingEditorBody}
                        isApplyingWriteProposal={isApplyingWriteProposal}
                        isRejectingWriteProposal={isRejectingWriteProposal}
                        editorChatSessionId={editorChatSessionId}
                        editorChatReady={editorChatSessionReady}
                        layoutPreview={articleLayoutPreview}
                        wechatPreview={articleWechatPreview}
                        hasGeneratedHtml={Boolean(packageState?.hasWechatHtml || packageState?.hasLayoutHtml)}
                        richpostThemeId={typeof packageState?.richpostThemeId === 'string' ? packageState.richpostThemeId : null}
                        richpostFontScale={Number(packageState?.richpostFontScale || 1) || 1}
                        richpostLineHeightScale={Number(packageState?.richpostLineHeightScale || 1) || 1}
                        richpostThemePresets={Array.isArray(packageState?.richpostThemeCatalog) ? packageState.richpostThemeCatalog : []}
                        richpostThemesDir={typeof packageState?.richpostThemesDir === 'string' ? packageState.richpostThemesDir : null}
                        richpostThemeTemplateFile={typeof packageState?.richpostThemeTemplateFile === 'string' ? packageState.richpostThemeTemplateFile : null}
                        isApplyingRichpostTheme={String(workingId || '').startsWith('richpost-theme:')}
                        longformLayoutPresetId={typeof packageState?.longformLayoutPresetId === 'string' ? packageState.longformLayoutPresetId : null}
                        longformLayoutPresets={Array.isArray(packageState?.longformLayoutPresetCatalog) ? packageState.longformLayoutPresetCatalog : []}
                        isApplyingLongformLayoutPreset={String(workingId || '').startsWith('longform-layout-preset:')}
                        richpostPages={richpostPagePreviews}
                        coverAsset={packageCoverAsset}
                        imageAssets={packageImageAssets}
                            onEditorBodyChange={(value) => {
                                setEditorBody(value);
                                setEditorBodyDirty(true);
                            }}
                        onAcceptWriteProposal={() => {
                            void handleAcceptEditorWriteProposal();
                        }}
                        onSelectRichpostTheme={(themeId) => {
                            void handleSelectRichpostTheme(themeId);
                        }}
                        onUpdateRichpostTypography={(settings) => {
                            void handleUpdateRichpostTypography(settings);
                        }}
                        onSelectLongformLayoutPreset={(presetId, target) => {
                            void handleSelectLongformLayoutPreset(presetId, target);
                        }}
                            onAiWorkspaceModeChange={setEditorAiWorkspaceMode}
                            onPackageStateChange={(state) => applyPackageState(editorFile, state as PackageState)}
                            onRejectWriteProposal={() => {
                                void handleRejectEditorWriteProposal();
                            }}
                    />
                )}
            </div>
        );
    }

    return (
        <>
        <div className="h-full min-h-0 overflow-auto bg-surface-primary text-text-primary">
            <div className="mx-auto flex w-full max-w-[1680px] flex-col px-6 py-2">
                {/* 顶部导航与操作栏 - 更加精致 */}
                <div className="border-b border-black/[0.03] py-5 px-1">
                        <div className="flex flex-wrap items-center justify-between gap-6">
                            <div className="flex min-w-0 items-center gap-8">
                                {[
                                    { id: 'all', label: '全部' },
                                    { id: 'drafts', label: '我的稿件' },
                                    { id: 'media', label: '素材库' },
                                ].map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setFilter(item.id as DraftFilter)}
                                        className={clsx(
                                            'relative py-1 text-[15px] font-bold transition-all',
                                            filter === item.id ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                                        )}
                                    >
                                        {item.label}
                                        {filter === item.id && (
                                            <div className="absolute -bottom-[21px] left-0 right-0 h-1 rounded-t-full bg-accent-primary shadow-[0_0_8px_rgba(var(--color-accent-primary),0.4)]" />
                                        )}
                                    </button>
                                ))}
                            </div>
                            
                            <div className="relative flex flex-wrap items-center gap-1.5">
                                <div className="flex items-center gap-0.5 bg-black/[0.03] p-1 rounded-xl border border-black/[0.02]">
                                    <button
                                        type="button"
                                        onClick={() => setFilter('folders')}
                                        className={clsx(
                                            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all",
                                            filter === 'folders' ? "bg-white text-text-primary shadow-sm ring-1 ring-black/[0.02]" : "text-text-tertiary hover:text-text-primary hover:bg-black/[0.02]"
                                        )}
                                    >
                                        <FolderOpen className="h-3.5 w-3.5" />
                                        目录
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsImageModalOpen(true);
                                            void loadSettings();
                                        }}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-text-tertiary transition-all hover:text-text-primary hover:bg-black/[0.02]"
                                    >
                                        <ImageIcon className="h-3.5 w-3.5" />
                                        生图
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsVideoModalOpen(true);
                                            void loadSettings();
                                        }}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-text-tertiary transition-all hover:text-text-primary hover:bg-black/[0.02]"
                                    >
                                        <Clapperboard className="h-3.5 w-3.5" />
                                        生视频
                                    </button>
                                </div>

                                <div className="w-[1px] h-4 bg-black/[0.06] mx-1" />

                                <button
                                    type="button"
                                    onClick={() => void loadData()}
                                    className="p-2 rounded-xl text-text-tertiary transition-all hover:bg-black/[0.04] hover:text-text-primary active:scale-90"
                                    title="刷新"
                                >
                                    <RefreshCw className={clsx('h-4 w-4', isRefreshing && 'animate-spin')} />
                                </button>
                                
                                <button
                                    type="button"
                                    onClick={() => setIsSearchOpen((prev) => !prev)}
                                    className={clsx(
                                        'p-2 rounded-xl transition-all active:scale-90',
                                        isSearchOpen
                                            ? 'bg-accent-primary/10 text-accent-primary shadow-inner'
                                            : 'text-text-tertiary hover:bg-black/[0.04] hover:text-text-primary'
                                    )}
                                    title="搜索"
                                >
                                    <Search className="h-4 w-4" />
                                </button>

                                <div className="ml-2 flex items-center gap-1 rounded-xl border border-border bg-surface-elevated p-1 shadow-lg shadow-black/5">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setCreateKind('longform');
                                            setCreateOpen(true);
                                        }}
                                        className="inline-flex items-center gap-1.5 rounded-[10px] bg-accent-primary px-3 py-1.5 text-[12px] font-bold text-white shadow-sm shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95"
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        新建
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleImportMediaFiles()}
                                        disabled={workingId === 'media-import'}
                                        className="inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12px] font-bold text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-all active:scale-95 disabled:opacity-30"
                                    >
                                        <Upload className="h-3.5 w-3.5" />
                                        {workingId === 'media-import' ? '导入中' : '上传'}
                                    </button>
                                </div>

                                {/* 搜索弹窗 - 采用毛玻璃精致风格 */}
                                <div
                                    ref={searchPopoverRef}
                                    className={clsx(
                                        'absolute right-0 top-[calc(100%+12px)] z-40 w-[min(480px,calc(100vw-4rem))] origin-top-right transition-all duration-300 ease-out',
                                        isSearchOpen
                                            ? 'pointer-events-auto translate-y-0 scale-100 opacity-100'
                                            : 'pointer-events-none -translate-y-2 scale-[0.98] opacity-0'
                                    )}
                                >
                                    <div className="rounded-[24px] border border-white/60 bg-white/85 p-4 shadow-[0_32px_80px_-16px_rgba(0,0,0,0.14)] backdrop-blur-[32px]">
                                        <div className="flex items-center gap-3 rounded-xl border border-black/[0.05] bg-black/[0.02] px-4 py-2.5 focus-within:bg-white focus-within:ring-2 focus-within:ring-accent-primary/10 transition-all">
                                            <Search className="h-4 w-4 text-text-tertiary" />
                                            <input
                                                ref={searchInputRef}
                                                value={query}
                                                onChange={(event) => setQuery(event.target.value)}
                                                placeholder="搜索标题、摘要或标签..."
                                                className="h-6 w-full bg-transparent text-[13px] font-medium text-text-primary placeholder:text-text-tertiary/60 focus:outline-none"
                                            />
                                            {query ? (
                                                <button
                                                    type="button"
                                                    onClick={() => setQuery('')}
                                                    className="flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary hover:bg-black/[0.06] hover:text-text-primary"
                                                >
                                                    <X className="h-3.5 w-3.5" />
                                                </button>
                                            ) : null}
                                        </div>
                                        <div className="mt-3 px-1 text-[10px] font-bold text-text-tertiary/60 uppercase tracking-widest">
                                            Quick Search Insight
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* 文件夹区域 - 紧凑型 */}
                    <div className="border-b border-black/[0.03] py-6 px-1">
                        <div className="flex items-center justify-between mb-4">
                            <div className="text-[12px] font-bold text-text-tertiary uppercase tracking-widest px-1">文件夹 ({visibleFolders.length})</div>
                        </div>
                        <div className="flex gap-2.5 overflow-x-auto pb-1 custom-scrollbar">
                            {currentFolderPath ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (isMediaScope) {
                                            setMediaFolder(getParentFolderPath(mediaFolder));
                                        } else {
                                            setActiveFolder(getParentFolderPath(activeFolder));
                                        }
                                    }}
                                    className="group flex min-w-[80px] flex-col items-center gap-2 p-2 rounded-xl transition-all hover:bg-black/[0.03]"
                                >
                                    <div className="flex h-12 w-12 items-center justify-center text-text-tertiary transition-all group-hover:-translate-x-0.5 group-hover:text-text-primary">
                                        <ArrowLeft className="h-6 w-6" />
                                    </div>
                                    <div className="text-[10px] font-bold text-text-tertiary">返回上级</div>
                                </button>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => {
                                    setFolderCreateTitle('');
                                    setFolderCreateOpen(true);
                                }}
                                className="group flex min-w-[80px] flex-col items-center gap-2 p-2 rounded-xl transition-all hover:bg-black/[0.03]"
                            >
                                <div className="flex h-12 w-12 items-center justify-center text-accent-primary/60 transition-all group-hover:scale-110 group-hover:text-accent-primary">
                                    <FolderPlus className="h-7 w-7" />
                                </div>
                                <div className="text-[10px] font-bold text-text-tertiary">新建文件夹</div>
                            </button>
                            {visibleFolders.map((folder) => (
                                <button
                                    key={folder.path}
                                    type="button"
                                    onClick={() => {
                                        if (isMediaScope) {
                                            setMediaFolder(folder.path);
                                        } else {
                                            setActiveFolder(folder.path);
                                        }
                                    }}
                                    onContextMenu={isMediaScope ? undefined : (event) => openFolderContextMenu(event, folder)}
                                    className="group flex min-w-[80px] max-w-[100px] flex-col items-center gap-2 p-2 rounded-xl transition-all hover:bg-black/[0.03]"
                                >
                                    <div className="flex h-12 w-12 items-center justify-center text-accent-primary/50 transition-all group-hover:-translate-y-0.5 group-hover:text-accent-primary">
                                        <Folder className="h-9 w-9" />
                                    </div>
                                    <div className="line-clamp-1 text-[11px] font-bold text-text-secondary group-hover:text-text-primary">
                                        {folder.name}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 过滤器与布局切换 - 精密风格 */}
                    <div className="border-b border-black/[0.03] py-4 px-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1 bg-black/[0.03] p-1 rounded-xl border border-black/[0.02]">
                                {FILTER_OPTIONS.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setFilter(item.id)}
                                        className={clsx(
                                            'px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all',
                                            filter === item.id ? 'bg-white text-text-primary shadow-sm ring-1 ring-black/[0.02]' : 'text-text-tertiary hover:text-text-secondary hover:bg-black/[0.02]'
                                        )}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                            
                            <div className="ml-auto flex items-center gap-0.5 bg-black/[0.03] p-1 rounded-xl border border-black/[0.02]">
                                <button
                                    type="button"
                                    onClick={() => setLayout('gallery')}
                                    className={clsx(
                                        'p-1.5 rounded-lg transition-all',
                                        layout === 'gallery' ? 'bg-white text-text-primary shadow-sm ring-1 ring-black/[0.02]' : 'text-text-tertiary hover:text-text-primary'
                                    )}
                                >
                                    <Grid2X2 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setLayout('list')}
                                    className={clsx(
                                        'p-1.5 rounded-lg transition-all',
                                        layout === 'list' ? 'bg-white text-text-primary shadow-sm ring-1 ring-black/[0.02]' : 'text-text-tertiary hover:text-text-primary'
                                    )}
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="px-2 py-5">
                        {loading ? (
                            <div className="flex h-[420px] items-center justify-center text-text-tertiary">加载草稿中...</div>
                        ) : error ? (
                            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
                        ) : filter === 'folders' ? (
                            visibleFolders.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-sm text-text-tertiary">当前目录下还没有文件夹。</div>
                            ) : (
                                <div className={clsx(layout === 'gallery' ? 'grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5' : 'space-y-2')}>
                                    {visibleFolders.map((folder) => (
                                        <button
                                            key={folder.path}
                                            type="button"
                                            onClick={() => {
                                                if (isMediaScope) {
                                                    setMediaFolder(folder.path);
                                                } else {
                                                    setActiveFolder(folder.path);
                                                }
                                            }}
                                            onContextMenu={isMediaScope ? undefined : (event) => openFolderContextMenu(event, folder)}
                                            className={clsx(
                                                'rounded-2xl border border-border bg-white/70 text-left hover:bg-white',
                                                layout === 'gallery' ? 'p-4' : 'w-full px-4 py-3'
                                            )}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="text-3xl leading-none">📁</div>
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm font-medium text-text-primary">{folder.name}</div>
                                                    <div className="mt-0.5 text-[11px] text-text-tertiary">文件夹</div>
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )
                        ) : (
                            <div className="space-y-4">
                                {activeFolder && filter === 'all' ? (
                                    <div className="rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-text-tertiary">
                                        当前目录优先展示稿件内容。素材库素材仍会在“全部”根目录和“素材库”筛选里显示。
                                    </div>
                                ) : null}
                                {contentCards.length === 0 ? (
                                    <div className="rounded-2xl border border-dashed border-border px-4 py-12 text-sm text-text-tertiary">当前没有符合筛选条件的内容。</div>
                                ) : (
                                    <div className={clsx(layout === 'gallery' ? 'grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-4 gap-y-6' : 'space-y-2')}>
                                        {contentCards.map((card) => {
                                            if (card.kind === 'draft') {
                                                const typeTheme = resolveDraftTypeTheme(card.draftType);
                                                const Icon = card.draftType === 'video'
                                                    ? Clapperboard
                                                    : card.draftType === 'audio'
                                                        ? FileAudio
                                                        : card.draftType === 'richpost'
                                                            ? FileImage
                                                            : FileText;
                                                const previewOverride = richpostPreviewOverrides[card.file.path];
                                                const previewOverrideIsFresh = Boolean(
                                                    previewOverride?.fileUrl
                                                    && Number(previewOverride.updatedAt || 0) >= Number(card.richpostPreviewPageUpdatedAt || 0)
                                                );
                                                const richpostPreviewSrc = card.draftType === 'richpost'
                                                    ? resolveAssetUrl(
                                                        previewOverrideIsFresh
                                                            ? `${previewOverride?.fileUrl || ''}${String(previewOverride?.fileUrl || '').includes('?') ? '&' : '?'}v=${previewOverride?.updatedAt || card.updatedAt || 0}`
                                                            : card.richpostPreviewFileUrl
                                                                ? `${card.richpostPreviewFileUrl}${card.richpostPreviewFileUrl.includes('?') ? '&' : '?'}v=${card.richpostPreviewUpdatedAt || card.updatedAt || 0}`
                                                                : ''
                                                    )
                                                    : '';
                                                const showRichpostPreview = card.draftType === 'richpost'
                                                    && Boolean(richpostPreviewSrc);
                                                const openDraftCard = () => {
                                                    void openDraftEditor(card.file.path);
                                                };
                                                const handleDraftCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault();
                                                        openDraftCard();
                                                    }
                                                };
                                                return (
                                                    <div key={card.id} className={clsx(layout === 'gallery' ? 'group' : 'rounded-xl border border-black/[0.04] bg-white/70 px-4 py-2.5 transition-all hover:bg-white hover:shadow-sm')}>
                                                        {layout === 'gallery' ? (
                                                            <div
                                                                role="button"
                                                                tabIndex={0}
                                                                onClick={openDraftCard}
                                                                onKeyDown={handleDraftCardKeyDown}
                                                                onContextMenu={(event) => openDraftContextMenu(event, card.file, card.title)}
                                                                className="block w-full text-left outline-none"
                                                            >
                                                                <div className={clsx(
                                                                    'relative aspect-[5/6] overflow-hidden rounded-[14px] border border-black/[0.04] bg-white transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-[0_12px_24px_-8px_rgba(0,0,0,0.12)] focus-visible:ring-2 focus-visible:ring-accent-primary/30',
                                                                    !showRichpostPreview && typeTheme.tile
                                                                )}>
                                                                    {showRichpostPreview ? (
                                                                        <img
                                                                            src={richpostPreviewSrc}
                                                                            alt={`${card.title} 首图缩略图`}
                                                                            loading="lazy"
                                                                            draggable={false}
                                                                            className="h-full w-full select-none object-cover pointer-events-none bg-white"
                                                                        />
                                                                    ) : (
                                                                        <div className="absolute inset-0 p-4 flex flex-col">
                                                                            <div className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-lg shadow-sm', typeTheme.iconWrap)}>
                                                                                <Icon className="h-4 w-4" />
                                                                            </div>
                                                                            <div className="mt-4 text-[9px] font-bold uppercase tracking-[0.24em] text-white/50">{resolveDraftTypeLabel(card.draftType)}</div>
                                                                            <div className="mt-1.5 line-clamp-3 text-[15px] font-extrabold leading-tight text-white tracking-tight">{card.title}</div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="mt-2.5 px-1">
                                                                    <div className="truncate text-[13px] font-bold text-text-primary transition-colors group-hover:text-accent-primary">{card.title}</div>
                                                                    <div className="mt-0.5 text-[10px] font-bold uppercase tracking-tighter text-text-tertiary/60">{formatDateLabel(card.updatedAt)}</div>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={openDraftCard}
                                                                onContextMenu={(event) => openDraftContextMenu(event, card.file, card.title)}
                                                                className="flex w-full items-center gap-4 text-left"
                                                            >
                                                                <div className="flex min-w-0 items-center gap-4">
                                                                    <div className={clsx('flex h-9 w-9 items-center justify-center rounded-lg shadow-sm', typeTheme.tile)}>
                                                                        <Icon className="h-4 w-4 text-white" />
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="truncate text-[13px] font-bold text-text-primary">{card.title}</div>
                                                                        <div className="mt-0.5 truncate text-[11px] font-medium text-text-tertiary/70">{card.summary || card.file.path}</div>
                                                                    </div>
                                                                </div>
                                                            </button>
                                                        )}
                                                    </div>
                                                );
                                            }

                                            const asset = card.asset;
                                            const previewSrc = resolveAssetUrl(asset.previewUrl || asset.relativePath || asset.absolutePath || '');
                                            const assetKind = card.assetKind;
                                            return (
                                                <div key={card.id} className={clsx(layout === 'gallery' ? 'group' : 'rounded-xl border border-black/[0.04] bg-white/70 px-4 py-2.5 transition-all hover:bg-white hover:shadow-sm')}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setPreviewAsset(asset)}
                                                        onContextMenu={(event) => openAssetContextMenu(event, asset)}
                                                        className={clsx(layout === 'gallery' ? 'w-full text-left' : 'flex w-full items-center gap-4 text-left')}
                                                    >
                                                        {layout === 'gallery' ? (
                                                            <>
                                                                <div className="relative aspect-[5/6] overflow-hidden rounded-[14px] border border-black/[0.04] bg-black/[0.02] transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-[0_12px_24px_-8px_rgba(0,0,0,0.12)]">
                                                                    {asset.source === 'generated' ? (
                                                                        <div className="absolute left-2.5 top-2.5 z-10 rounded-lg bg-black/60 px-2 py-1 text-[9px] font-bold text-white backdrop-blur-md uppercase tracking-widest border border-white/10">
                                                                            AI
                                                                        </div>
                                                                    ) : null}
                                                                    {assetKind === 'image' ? (
                                                                        <img src={previewSrc} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                                    ) : assetKind === 'video' ? (
                                                                        <>
                                                                            <video
                                                                                src={previewSrc}
                                                                                className="h-full w-full object-cover bg-black"
                                                                                muted
                                                                                playsInline
                                                                                preload="metadata"
                                                                                onLoadedData={(event) => {
                                                                                    try {
                                                                                        if (event.currentTarget.currentTime < 0.05) {
                                                                                            event.currentTarget.currentTime = 0.05;
                                                                                        }
                                                                                    } catch {
                                                                                        // ignore
                                                                                    }
                                                                                }}
                                                                            />
                                                                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                                                                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-md border border-white/20">
                                                                                    <Play className="ml-0.5 h-4 w-4 fill-current" />
                                                                                </div>
                                                                            </div>
                                                                        </>
                                                                    ) : (
                                                                        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#10253f,#315e8f)] text-white/80">
                                                                            <AudioLines className="h-9 w-9" />
                                                                        </div>
                                                                    )}
                                                                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent" />
                                                                </div>
                                                                <div className="px-1 mt-2.5">
                                                                    <div className="truncate text-[13px] font-bold text-text-primary group-hover:text-accent-primary transition-colors">{card.title}</div>
                                                                    <div className="mt-0.5 text-[10px] font-bold text-text-tertiary/60 uppercase tracking-tighter">{formatDateLabel(asset.updatedAt)}</div>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <div className="flex min-w-0 items-center gap-4">
                                                                <div className="h-10 w-12 overflow-hidden rounded-lg bg-black/[0.03] border border-black/[0.04]">
                                                                    {assetKind === 'image' ? (
                                                                        <img src={previewSrc} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                                    ) : assetKind === 'video' ? (
                                                                        <video src={previewSrc} className="h-full w-full object-cover bg-black" muted playsInline />
                                                                    ) : (
                                                                        <div className="flex h-full w-full items-center justify-center bg-black/[0.05] text-text-tertiary">
                                                                            <AudioLines className="h-4 w-4" />
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="min-w-0 flex-1">
                                                                    <div className="truncate text-[13px] font-bold text-text-primary">{card.title}</div>
                                                                    <div className="mt-0.5 truncate text-[11px] font-medium text-text-tertiary/70">{formatDateLabel(asset.updatedAt)}</div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
            </div>
        </div>

            {isImageModalOpen && (
                <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-primary/95 px-5 py-4 backdrop-blur">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                <ImagePlus className="w-4 h-4 text-accent-primary" />
                                在草稿内生图
                            </div>
                            <button
                                onClick={() => void loadSettings()}
                                className="ml-auto px-3 py-2 text-xs rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                            >
                                刷新配置
                            </button>
                            <button
                                onClick={() => setIsImageModalOpen(false)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-surface-secondary"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            <div className="text-xs text-text-secondary">
                                当前生图配置：provider=<span className="font-mono">{settings.image_provider || 'openai-compatible'}</span> · template=<span className="font-mono">{settings.image_provider_template || 'openai-images'}</span> · endpoint=<span className="font-mono">{resolvedEndpoint || '(未设置)'}</span>
                            </div>
                            {!hasImageConfig && (
                                <div className="text-xs text-status-error">
                                    未检测到生图配置。请先到“设置 → AI 模型”填写生图 Endpoint 和 API Key。
                                </div>
                            )}

                            <textarea
                                value={prompt}
                                onChange={(event) => setPrompt(event.target.value)}
                                placeholder="输入提示词，例如：一张温暖晨光中的北欧风民宿客厅，真实摄影风格，适合小红书封面"
                                rows={4}
                                className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                            />

                            <div className="space-y-2">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <select
                                        value={generationMode}
                                        onChange={(event) => setGenerationMode(event.target.value as 'text-to-image' | 'reference-guided' | 'image-to-image')}
                                        className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    >
                                        <option value="text-to-image">文生图</option>
                                        <option value="reference-guided">参考图引导</option>
                                        <option value="image-to-image">图生图</option>
                                    </select>
                                </div>

                                {generationMode !== 'text-to-image' && (
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                        {Array.from({ length: 4 }).map((_, index) => {
                                            const item = referenceImages[index];
                                            return (
                                                <label key={index} className="group relative flex aspect-square max-w-[144px] cursor-pointer overflow-hidden rounded-xl border border-dashed border-border bg-surface-secondary/20 hover:border-accent-primary/40 hover:bg-surface-secondary/40">
                                                    {item ? (
                                                        <img src={item.dataUrl} alt={item.name} className="h-full w-full object-cover" />
                                                    ) : (
                                                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-tertiary">
                                                            <ImagePlus className="h-5 w-5" />
                                                            <div className="text-xs">上传参考图</div>
                                                            <div className="text-[11px]">参考图 {index + 1}</div>
                                                        </div>
                                                    )}
                                                    <div className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white">
                                                        {index === 0 && generationMode === 'image-to-image' ? '主图' : `参考图 ${index + 1}`}
                                                    </div>
                                                    {item && (
                                                        <>
                                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 text-[11px] text-white">
                                                                <div className="truncate">{item.name}</div>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    setReferenceImages((prev) => prev.filter((_, i) => i !== index));
                                                                }}
                                                                className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                                                            >
                                                                <X className="h-4 w-4" />
                                                            </button>
                                                        </>
                                                    )}
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        className="hidden"
                                                        onChange={(event) => void handleReferenceFile(event, index)}
                                                    />
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="text-[11px] text-text-tertiary">
                                    {generationMode === 'text-to-image'
                                        ? '文生图不需要参考图。'
                                        : isReadingRefImages
                                            ? '正在读取参考图...'
                                            : (generationMode === 'image-to-image'
                                                ? '图生图至少需要 1 张参考图，其余槽位可作为附加参考图。'
                                                : '参考图引导支持最多 4 张参考图。')}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                <input value={genTitle} onChange={(event) => setGenTitle(event.target.value)} placeholder="资产标题（可选）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
                                <input value={genProjectId} onChange={(event) => setGenProjectId(event.target.value)} placeholder="项目ID（可选）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
                                <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="模型（如 gpt-image-1）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
                                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                                <select value={size} onChange={(event) => setSize(event.target.value)} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    <option value="">自动（按比例）</option>
                                    <option value="1024x1024">1024x1024</option>
                                    <option value="1024x1536">1024x1536</option>
                                    <option value="1536x1024">1536x1024</option>
                                    <option value="auto">auto</option>
                                </select>
                                <select value={quality} onChange={(event) => setQuality(event.target.value)} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    <option value="standard">standard</option>
                                    <option value="high">high</option>
                                    <option value="auto">auto</option>
                                </select>
                                <select value={count} onChange={(event) => setCount(Number(event.target.value))} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    <option value={1}>1 张</option>
                                    <option value={2}>2 张</option>
                                    <option value={3}>3 张</option>
                                    <option value={4}>4 张</option>
                                </select>
                            </div>

                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => void handleGenerate()}
                                    disabled={isGenerating || !hasImageConfig}
                                    className="px-4 py-2 text-sm rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50"
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                                        {isGenerating ? '生成中...' : '开始生图'}
                                    </span>
                                </button>
                            </div>

                            {genError && <div className="text-xs text-status-error">{genError}</div>}

                            {generatedAssets.length > 0 && (
                                <div className="space-y-3 border-t border-border pt-4">
                                    <div className="text-sm font-medium text-text-primary inline-flex items-center gap-2">
                                        <Sparkles className="w-4 h-4 text-accent-primary" />
                                        最新生成结果（{generatedAssets.length}）
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                        {generatedAssets.map((asset) => (
                                            <div key={asset.id} className="group border border-border rounded-xl bg-surface-primary overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                                                {asset.previewUrl && asset.exists ? (
                                                    isVideoAsset(asset) ? (
                                                        <video src={resolveAssetUrl(asset.previewUrl)} className="w-full aspect-[4/5] object-cover bg-black" controls preload="metadata" />
                                                    ) : (
                                                        <img src={resolveAssetUrl(asset.previewUrl)} alt={asset.title || asset.id} className="w-full aspect-[4/5] object-cover" />
                                                    )
                                                ) : (
                                                    <div className="w-full aspect-[4/5] bg-surface-secondary flex items-center justify-center text-text-tertiary text-xs">无法预览</div>
                                                )}
                                                <div className="p-3 space-y-1.5">
                                                    <div className="text-sm text-text-primary truncate">{asset.title || asset.id}</div>
                                                    <div className="text-[11px] text-text-tertiary truncate">{asset.projectId || '(无项目ID)'}</div>
                                                    <div className="text-[11px] text-text-tertiary truncate">{asset.model || ''} · {asset.aspectRatio || asset.size || ''} · {asset.quality || ''}</div>
                                                    <button
                                                        onClick={() => void window.ipcRenderer.invoke('media:open', { assetId: asset.id })}
                                                        className="mt-1 px-2.5 py-1.5 text-xs rounded border border-border hover:bg-surface-secondary text-text-secondary"
                                                    >
                                                        <span className="inline-flex items-center gap-1">
                                                            <ExternalLink className="w-3.5 h-3.5" />
                                                            打开文件
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {isBindAssetModalOpen && editorFile && (
                <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-4xl rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border px-5 py-4">
                            <div className="text-sm font-medium text-text-primary">
                                {bindAssetRole === 'cover' ? '选择封面素材' : bindAssetRole === 'image' ? '选择配图素材' : '选择关联素材'}
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsBindAssetModalOpen(false)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-surface-secondary"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="grid max-h-[72vh] grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4 overflow-auto p-5">
                            {bindableAssets.map((asset) => (
                                <button
                                    key={asset.id}
                                    type="button"
                                    onClick={() => void handleBindAssetToPackage(asset.id)}
                                    className="overflow-hidden rounded-2xl border border-border bg-white text-left hover:border-accent-primary/40"
                                >
                                    <div className="aspect-[4/5] overflow-hidden bg-surface-secondary">
                                        <img
                                            src={resolveAssetUrl(asset.previewUrl || asset.relativePath || '')}
                                            alt={asset.title || asset.id}
                                            className="h-full w-full object-cover"
                                        />
                                    </div>
                                    <div className="px-3 py-2">
                                        <div className="truncate text-sm font-medium text-text-primary">{asset.title || asset.relativePath || asset.id}</div>
                                        <div className="mt-1 truncate text-xs text-text-tertiary">{asset.id}</div>
                                    </div>
                                </button>
                            ))}
                            {bindableAssets.length === 0 && (
                                <div className="col-span-full rounded-2xl border border-dashed border-border px-4 py-10 text-sm text-text-tertiary">
                                    媒体库里还没有可绑定的素材。
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {isVideoModalOpen && (
                <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-primary/95 px-5 py-4 backdrop-blur">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                <Clapperboard className="w-4 h-4 text-accent-primary" />
                                在草稿内生视频
                            </div>
                            <button
                                onClick={() => void loadSettings()}
                                className="ml-auto px-3 py-2 text-xs rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                            >
                                刷新配置
                            </button>
                            <button
                                onClick={() => setIsVideoModalOpen(false)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-surface-secondary"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            <div className="text-xs text-text-secondary">
                                当前生视频配置：source=<span className="font-mono">RedBox 官方</span> · model=<span className="font-mono">{effectiveVideoModel}</span> · endpoint=<span className="font-mono">{resolvedVideoEndpoint || '(未设置)'}</span>
                            </div>
                            {!hasVideoConfig && (
                                <div className="text-xs text-status-error">
                                    未检测到可用的 RedBox 官方视频配置。请先登录或配置 RedBox 官方 AI 源。
                                </div>
                            )}

                            <textarea
                                value={videoPrompt}
                                onChange={(event) => setVideoPrompt(event.target.value)}
                                placeholder="输入视频提示词，例如：晨光下的海边公路航拍镜头，电影感，轻微推镜，适合社媒短视频"
                                rows={4}
                                className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                            />

                            <div className="space-y-2">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <select
                                        value={videoGenerationMode}
                                        onChange={(event) => setVideoGenerationMode(event.target.value as 'text-to-video' | 'reference-guided' | 'first-last-frame')}
                                        className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    >
                                        {VIDEO_GENERATION_MODE_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>

                                {videoGenerationMode === 'reference-guided' && (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                                        {Array.from({ length: 5 }).map((_, index) => {
                                            const item = videoReferenceImages[index] || null;
                                            return (
                                                <label key={index} className="group relative flex aspect-square max-w-[120px] cursor-pointer overflow-hidden rounded-xl border border-dashed border-border bg-surface-secondary/20 hover:border-accent-primary/40 hover:bg-surface-secondary/40">
                                                    {item ? (
                                                        <img src={item.dataUrl} alt={item.name} className="h-full w-full object-cover" />
                                                    ) : (
                                                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-tertiary">
                                                            <ImagePlus className="h-4 w-4" />
                                                            <div className="text-[11px]">参考图{index + 1}</div>
                                                        </div>
                                                    )}
                                                    <div className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white">图{index + 1}</div>
                                                    {item && (
                                                        <>
                                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6 text-[10px] text-white">
                                                                <div className="truncate">{item.name}</div>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    setVideoReferenceImages((prev) => {
                                                                        const next = [...prev];
                                                                        next[index] = null;
                                                                        return next;
                                                                    });
                                                                }}
                                                                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                                                            >
                                                                <X className="h-3.5 w-3.5" />
                                                            </button>
                                                        </>
                                                    )}
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        className="hidden"
                                                        onChange={(event) => void handleVideoReferenceFile(event, index)}
                                                    />
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}

                                {videoGenerationMode === 'first-last-frame' && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {[
                                            { key: 'primary' as const, label: '首帧', item: videoPrimaryReferenceImage, setter: setVideoPrimaryReferenceImage },
                                            { key: 'last' as const, label: '尾帧', item: videoLastFrameImage, setter: setVideoLastFrameImage },
                                        ].map((slot) => (
                                            <label key={slot.key} className="group relative flex aspect-square max-w-[160px] cursor-pointer overflow-hidden rounded-xl border border-dashed border-border bg-surface-secondary/20 hover:border-accent-primary/40 hover:bg-surface-secondary/40">
                                                {slot.item ? (
                                                    <img src={slot.item.dataUrl} alt={slot.item.name} className="h-full w-full object-cover" />
                                                ) : (
                                                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-tertiary">
                                                        <ImagePlus className="h-5 w-5" />
                                                        <div className="text-xs">上传{slot.label}</div>
                                                        <div className="text-[11px]">{slot.label}图片</div>
                                                    </div>
                                                )}
                                                <div className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white">{slot.label}</div>
                                                {slot.item && (
                                                    <>
                                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 text-[11px] text-white">
                                                            <div className="truncate">{slot.item.name}</div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                slot.setter(null);
                                                            }}
                                                            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                                                        >
                                                            <X className="h-4 w-4" />
                                                        </button>
                                                    </>
                                                )}
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    className="hidden"
                                                    onChange={(event) => void handleVideoReferenceFile(event, slot.key)}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                )}

                                <div className="text-[11px] text-text-tertiary">
                                    {isReadingVideoRefImages ? '正在读取参考图...' : getVideoReferenceModeHint(videoGenerationMode)}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                <input value={videoTitle} onChange={(event) => setVideoTitle(event.target.value)} placeholder="视频标题（可选）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
                                <input value={videoProjectId} onChange={(event) => setVideoProjectId(event.target.value)} placeholder="项目ID（可选）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
                                <div className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary/70 text-text-secondary">
                                    当前模式模型：<span className="font-mono text-text-primary">{effectiveVideoModel}</span>
                                </div>
                                <select value={videoAspectRatio} onChange={(event) => setVideoAspectRatio(event.target.value as '16:9' | '9:16')} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    {VIDEO_ASPECT_RATIO_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                                <select value={videoResolution} onChange={(event) => setVideoResolution(event.target.value as '720p' | '1080p')} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    <option value="720p">720p</option>
                                    <option value="1080p">1080p</option>
                                </select>
                                <select value={videoDurationSeconds} onChange={(event) => setVideoDurationSeconds(Number(event.target.value))} className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary">
                                    <option value={5}>5 秒</option>
                                    <option value={8}>8 秒</option>
                                    <option value={10}>10 秒</option>
                                    <option value={12}>12 秒</option>
                                </select>
                            </div>

                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => void handleGenerateVideo()}
                                    disabled={isGeneratingVideo || !hasVideoConfig}
                                    className="px-4 py-2 text-sm rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50"
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        {isGeneratingVideo ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                        {isGeneratingVideo ? '生成中...' : '开始生视频'}
                                    </span>
                                </button>
                            </div>

                            {videoGenError && <div className="text-xs text-status-error">{videoGenError}</div>}

                            {isGeneratingVideo && (
                                <div className="space-y-3 border-t border-border pt-4">
                                    <div className="text-sm font-medium text-text-primary">视频生成中，请等待</div>
                                    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface-secondary/20 aspect-[16/9]">
                                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(245,158,11,0.16),transparent_55%)] animate-pulse" />
                                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_35%_40%,rgba(251,191,36,0.18),transparent_30%),radial-gradient(circle_at_65%_60%,rgba(249,115,22,0.14),transparent_28%)] blur-2xl animate-pulse" />
                                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
                                            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-accent-primary/20 bg-accent-primary/10 text-accent-primary">
                                                <Clapperboard className="h-6 w-6" />
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-base font-medium text-text-primary">正在生成视频片段</div>
                                                <div className="text-xs leading-5 text-text-tertiary">
                                                    已提交到官方视频服务。当前页面会继续等待结果返回，生成完成后会自动出现在下方。
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {generatedVideoAssets.length > 0 && (
                                <div className="space-y-3 border-t border-border pt-4">
                                    <div className="text-sm font-medium text-text-primary inline-flex items-center gap-2">
                                        <Sparkles className="w-4 h-4 text-accent-primary" />
                                        最新生视频结果（{generatedVideoAssets.length}）
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                        {generatedVideoAssets.map((asset) => (
                                            <div key={asset.id} className="group border border-border rounded-xl bg-surface-primary overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                                                {asset.previewUrl && asset.exists ? (
                                                    <video src={resolveAssetUrl(asset.previewUrl)} className="w-full aspect-[4/5] object-cover bg-black" controls preload="metadata" />
                                                ) : (
                                                    <div className="w-full aspect-[4/5] bg-surface-secondary flex items-center justify-center text-text-tertiary text-xs">无法预览</div>
                                                )}
                                                <div className="p-3 space-y-1.5">
                                                    <div className="text-sm text-text-primary truncate">{asset.title || asset.id}</div>
                                                    <div className="text-[11px] text-text-tertiary truncate">{asset.projectId || '(无项目ID)'}</div>
                                                    <div className="text-[11px] text-text-tertiary truncate">{asset.model || ''} · {asset.aspectRatio || ''} · {asset.size || ''}</div>
                                                    <button
                                                        onClick={() => void window.ipcRenderer.invoke('media:open', { assetId: asset.id })}
                                                        className="mt-1 px-2.5 py-1.5 text-xs rounded border border-border hover:bg-surface-secondary text-text-secondary"
                                                    >
                                                        <span className="inline-flex items-center gap-1">
                                                            <ExternalLink className="w-3.5 h-3.5" />
                                                            打开文件
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {createOpen && (
                <div className="fixed inset-0 z-[1000] bg-black/40 backdrop-blur-[4px] flex items-center justify-center p-4 animate-in fade-in duration-300" onMouseDown={() => !isCreating && setCreateOpen(false)}>
                    <div className="w-full max-w-[680px] rounded-[24px] border border-white/30 bg-white shadow-[0_40px_100px_-24px_rgba(0,0,0,0.28)] flex flex-col overflow-hidden" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-5 border-b border-black/[0.04] bg-white">
                            <h2 className="text-[18px] font-extrabold tracking-tight text-text-primary">新建内容</h2>
                            <button type="button" onClick={() => !isCreating && setCreateOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/[0.04] text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-90 disabled:opacity-40" disabled={isCreating}>
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="px-5 py-5 bg-white/50">
                            <div className="grid grid-cols-2 gap-3">
                                {CREATE_KIND_OPTIONS.map((option) => {
                                    const Icon = option.icon;
                                    const isCreatingOption = isCreating && createKind === option.id;
                                    const isUnavailable = !option.available;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            onClick={() => {
                                                if (isCreating || isUnavailable) return;
                                                void handleCreateDraft(option.id);
                                            }}
                                            aria-disabled={isCreating || isUnavailable}
                                            className={clsx(
                                                'group relative rounded-[18px] border border-black/[0.05] bg-white p-4 text-left transition-all duration-200 min-h-[124px] flex flex-col justify-between',
                                                !isUnavailable && 'hover:border-black/[0.1] hover:shadow-md',
                                                isCreating && 'cursor-wait opacity-70',
                                                isUnavailable && 'cursor-not-allowed opacity-60',
                                                isCreatingOption && 'border-accent-primary shadow-lg ring-1 ring-accent-primary/10'
                                            )}
                                        >
                                            <div className={clsx('relative overflow-hidden rounded-[16px] border border-black/[0.05] bg-gradient-to-br p-3 transition-transform duration-200', option.accentClass, !isUnavailable && 'group-hover:scale-[1.02]')}>
                                                <div className="absolute inset-x-3 bottom-2 h-5 rounded-full bg-white/60 blur-md" />
                                                <div className="relative flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/75 shadow-sm">
                                                    {isCreatingOption ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
                                                </div>
                                            </div>
                                            <div className="mt-3 flex items-center justify-between gap-3">
                                                <div className="font-extrabold text-[14px] text-text-primary">{option.label}</div>
                                                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-tertiary">
                                                    {isCreatingOption ? '创建中' : isUnavailable ? '开发中' : '点击创建'}
                                                </div>
                                            </div>
                                            {isUnavailable && option.unavailableHint ? (
                                                <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 -translate-y-1 opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100">
                                                    <div className="rounded-full bg-text-primary px-3 py-1 text-[11px] font-bold text-white shadow-[0_10px_24px_-12px_rgba(0,0,0,0.45)]">
                                                        {option.unavailableHint}
                                                    </div>
                                                </div>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {folderCreateOpen && (
                <div className="fixed inset-0 z-[1000] bg-black/10 backdrop-blur-[6px] flex items-center justify-center p-4 animate-in fade-in duration-300" onMouseDown={() => !isCreating && setFolderCreateOpen(false)}>
                    <div className="w-full max-w-md rounded-[24px] border border-white/60 bg-white/90 shadow-[0_40px_100px_-20px_rgba(0,0,0,0.2)] backdrop-blur-[32px] overflow-hidden flex flex-col" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="px-7 pt-7 pb-5">
                            <h2 className="text-[17px] font-extrabold tracking-tight text-text-primary">新建文件夹</h2>
                            <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-text-tertiary">Assign Directory Name</p>
                        </div>
                        <div className="px-7 py-2 space-y-4">
                            <input
                                autoFocus
                                value={folderCreateTitle}
                                onChange={(event) => setFolderCreateTitle(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !isCreating) {
                                        event.preventDefault();
                                        void handleCreateFolder();
                                    }
                                }}
                                placeholder="输入文件夹名称..."
                                className="w-full rounded-xl border border-black/[0.05] bg-black/[0.02] px-4 py-3 text-sm font-bold placeholder:text-text-tertiary/50 focus:outline-none focus:bg-white focus:ring-2 focus:ring-accent-primary/10 transition-all"
                            />
                        </div>
                        <div className="flex items-center justify-end gap-2 px-7 py-6 mt-4">
                            <button type="button" onClick={() => setFolderCreateOpen(false)} disabled={isCreating} className="px-4 py-2 rounded-lg text-[12px] font-bold text-text-tertiary hover:bg-black/[0.04] transition-all">取消</button>
                            <button type="button" onClick={() => void handleCreateFolder()} disabled={isCreating || !folderCreateTitle.trim()} className="px-5 py-2 rounded-lg bg-text-primary text-[12px] font-bold text-white shadow-md hover:bg-text-primary/90 transition-all active:scale-95 disabled:opacity-30">
                                {isCreating ? 'SAVING...' : '完成创建'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {folderRenameOpen && (
                <div className="fixed inset-0 z-[1000] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4" onMouseDown={() => !isCreating && setFolderRenameOpen(false)}>
                    <div className="w-full max-w-md rounded-3xl border border-border bg-background shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-5 border-b border-border/70">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">重命名文件夹</h2>
                                <p className="mt-1 text-sm text-text-secondary">输入新的文件夹名称。</p>
                            </div>
                            <button type="button" onClick={() => !isCreating && setFolderRenameOpen(false)} className="rounded-xl p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="px-6 py-6 space-y-3">
                            <label className="text-sm font-medium text-text-primary">名称</label>
                            <input
                                autoFocus
                                value={folderRenameTitle}
                                onChange={(event) => setFolderRenameTitle(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !isCreating) {
                                        event.preventDefault();
                                        void handleRenameFolder();
                                    }
                                }}
                                placeholder="输入新的文件夹名称"
                                className="w-full rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div className="flex items-center justify-end gap-3 px-6 py-5 border-t border-border/70 bg-surface-secondary/10 rounded-b-3xl">
                            <button type="button" onClick={() => setFolderRenameOpen(false)} disabled={isCreating} className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-50">取消</button>
                            <button type="button" onClick={() => void handleRenameFolder()} disabled={isCreating || !folderRenameTitle.trim()} className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50">
                                {isCreating ? '处理中...' : '重命名'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {assetRenameOpen && (
                <div className="fixed inset-0 z-[1000] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4" onMouseDown={() => !isCreating && setAssetRenameOpen(false)}>
                    <div className="w-full max-w-md rounded-3xl border border-border bg-background shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-5 border-b border-border/70">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">重命名素材</h2>
                                <p className="mt-1 text-sm text-text-secondary">输入新的素材名称。</p>
                            </div>
                            <button type="button" onClick={() => !isCreating && setAssetRenameOpen(false)} className="rounded-xl p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="px-6 py-6 space-y-3">
                            <label className="text-sm font-medium text-text-primary">名称</label>
                            <input
                                autoFocus
                                value={assetRenameTitle}
                                onChange={(event) => setAssetRenameTitle(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !isCreating) {
                                        event.preventDefault();
                                        void handleRenameAsset();
                                    }
                                }}
                                placeholder="输入新的素材名称"
                                className="w-full rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div className="flex items-center justify-end gap-3 px-6 py-5 border-t border-border/70 bg-surface-secondary/10 rounded-b-3xl">
                            <button type="button" onClick={() => setAssetRenameOpen(false)} disabled={isCreating} className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-50">取消</button>
                            <button type="button" onClick={() => void handleRenameAsset()} disabled={isCreating || !assetRenameTitle.trim()} className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50">
                                {isCreating ? '处理中...' : '重命名'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {draftRenameOpen && (
                <div className="fixed inset-0 z-[1000] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4" onMouseDown={() => !isCreating && setDraftRenameOpen(false)}>
                    <div className="w-full max-w-md rounded-3xl border border-border bg-background shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-5 border-b border-border/70">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">重命名稿件</h2>
                                <p className="mt-1 text-sm text-text-secondary">输入新的稿件或工程名称。</p>
                            </div>
                            <button type="button" onClick={() => !isCreating && setDraftRenameOpen(false)} className="rounded-xl p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="px-6 py-6 space-y-3">
                            <label className="text-sm font-medium text-text-primary">名称</label>
                            <input
                                autoFocus
                                value={draftRenameTitle}
                                onChange={(event) => setDraftRenameTitle(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !isCreating) {
                                        event.preventDefault();
                                        void handleRenameDraft();
                                    }
                                }}
                                placeholder="输入新的名称"
                                className="w-full rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div className="flex items-center justify-end gap-3 px-6 py-5 border-t border-border/70 bg-surface-secondary/10 rounded-b-3xl">
                            <button type="button" onClick={() => setDraftRenameOpen(false)} disabled={isCreating} className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-50">取消</button>
                            <button type="button" onClick={() => void handleRenameDraft()} disabled={isCreating || !draftRenameTitle.trim()} className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50">
                                {isCreating ? '处理中...' : '重命名'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {folderContextMenu.visible && (
                <LiquidGlassMenuPanel
                    ref={folderContextMenuRef}
                    className="fixed z-[1100] min-w-[160px]"
                    style={{
                        left: Math.min(folderContextMenu.x, window.innerWidth - 176),
                        top: Math.min(folderContextMenu.y, window.innerHeight - 176),
                    }}
                >
                    <button
                        type="button"
                        onClick={() => {
                            setFolderContextMenu((prev) => ({ ...prev, visible: false }));
                            void handleShowInFolder(folderContextMenu.folderPath);
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        文件夹中打开
                    </button>
                    <LiquidGlassMenuSeparator />
                    <button
                        type="button"
                        onClick={() => {
                            setFolderContextMenu((prev) => ({ ...prev, visible: false }));
                            setFolderRenamePath(folderContextMenu.folderPath);
                            setFolderRenameTitle(folderContextMenu.folderName);
                            setFolderRenameOpen(true);
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        重命名
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleDeleteFolder(folderContextMenu.folderPath)}
                        className={getLiquidGlassMenuItemClassName({ destructive: true })}
                    >
                        删除
                    </button>
                </LiquidGlassMenuPanel>
            )}

            {assetContextMenu.visible && (
                <LiquidGlassMenuPanel
                    ref={assetContextMenuRef}
                    className="fixed z-[1100] min-w-[160px]"
                    style={{
                        left: Math.min(assetContextMenu.x, window.innerWidth - 176),
                        top: Math.min(assetContextMenu.y, window.innerHeight - 132),
                    }}
                >
                    <button
                        type="button"
                        onClick={() => {
                            setAssetContextMenu((prev) => ({ ...prev, visible: false }));
                            setAssetRenameId(assetContextMenu.assetId);
                            setAssetRenameTitle(assetContextMenu.assetTitle);
                            setAssetRenameOpen(true);
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        重命名
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleDeleteAsset(assetContextMenu.assetId)}
                        className={getLiquidGlassMenuItemClassName({ destructive: true })}
                    >
                        删除
                    </button>
                </LiquidGlassMenuPanel>
            )}

            {draftContextMenu.visible && (
                <LiquidGlassMenuPanel
                    ref={draftContextMenuRef}
                    className="fixed z-[1100] min-w-[160px]"
                    style={{
                        left: Math.min(draftContextMenu.x, window.innerWidth - 176),
                        top: Math.min(draftContextMenu.y, window.innerHeight - 176),
                    }}
                >
                    <button
                        type="button"
                        onClick={() => {
                            setDraftContextMenu((prev) => ({ ...prev, visible: false }));
                            void handleShowInFolder(draftContextMenu.filePath);
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        文件夹中打开
                    </button>
                    <LiquidGlassMenuSeparator />
                    <button
                        type="button"
                        onClick={() => {
                            setDraftContextMenu((prev) => ({ ...prev, visible: false }));
                            setDraftRenamePath(draftContextMenu.filePath);
                            setDraftRenameTitle(draftContextMenu.title);
                            setDraftRenameOpen(true);
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        重命名
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setDraftContextMenu((prev) => ({ ...prev, visible: false }));
                            setPendingDeleteDraftPath(draftContextMenu.filePath);
                        }}
                        className={getLiquidGlassMenuItemClassName({ destructive: true })}
                    >
                        删除
                    </button>
                </LiquidGlassMenuPanel>
            )}

            {isExportVideoModalOpen && (
                <div
                    className="fixed inset-0 z-[1000] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4"
                    onMouseDown={() => !isRenderingRemotion && setIsExportVideoModalOpen(false)}
                >
                    <div
                        className="w-full max-w-lg rounded-3xl border border-border bg-background shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-6 py-5 border-b border-border/70">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">导出视频</h2>
                                <p className="mt-1 text-sm text-text-secondary">选择清晰度和保存位置，然后开始导出。</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => !isRenderingRemotion && setIsExportVideoModalOpen(false)}
                                disabled={isRenderingRemotion}
                                className="rounded-xl p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="px-6 py-6 space-y-5">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-text-primary">清晰度</label>
                                <select
                                    value={exportVideoResolution}
                                    onChange={(event) => setExportVideoResolution(event.target.value as ExportVideoResolution)}
                                    disabled={isRenderingRemotion}
                                    className="w-full rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:outline-none focus:border-accent-primary disabled:opacity-60"
                                >
                                    <option value="source">原始尺寸</option>
                                    <option value="1080p">1080p</option>
                                    <option value="720p">720p</option>
                                </select>
                                <div className="text-xs text-text-tertiary">
                                    导出尺寸：{exportTargetSize.width} x {exportTargetSize.height}
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-text-primary">保存位置</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        value={exportVideoPath}
                                        onChange={(event) => setExportVideoPath(event.target.value)}
                                        placeholder="请选择导出位置"
                                        disabled={isRenderingRemotion}
                                        className="min-w-0 flex-1 rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:outline-none focus:border-accent-primary disabled:opacity-60"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void handlePickExportVideoPath()}
                                        disabled={isRenderingRemotion}
                                        className="rounded-2xl border border-border px-4 py-3 text-sm text-text-primary hover:bg-surface-secondary transition-colors disabled:opacity-60"
                                    >
                                        选择位置
                                    </button>
                                </div>
                            </div>
                            <div className="rounded-2xl border border-border bg-surface-secondary/20 px-4 py-4">
                                <div className="flex items-center justify-between text-sm text-text-primary">
                                    <span>导出进度</span>
                                    <span className="font-mono">{exportVideoProgress}%</span>
                                </div>
                                <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/8">
                                    <div
                                        className="h-full rounded-full bg-accent-primary transition-[width] duration-300"
                                        style={{ width: `${Math.max(0, Math.min(100, exportVideoProgress))}%` }}
                                    />
                                </div>
                                <div className="mt-2 text-xs text-text-tertiary">
                                    {exportVideoError || exportVideoStage || '尚未开始'}
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-3 px-6 py-5 border-t border-border/70 bg-surface-secondary/10 rounded-b-3xl">
                            <div className="truncate text-xs text-text-tertiary">
                                {exportVideoPath || '未选择导出位置'}
                            </div>
                            <div className="flex items-center gap-3">
                                {(packageState?.videoProject?.renderOutput || packageState?.remotion?.render?.outputPath) && !isRenderingRemotion && exportVideoProgress >= 100 ? (
                                    <button
                                        type="button"
                                        onClick={() => void handleOpenRenderedRemotionVideo()}
                                        className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors"
                                    >
                                        打开文件
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() => setIsExportVideoModalOpen(false)}
                                    disabled={isRenderingRemotion}
                                    className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleConfirmExportVideo()}
                                    disabled={isRenderingRemotion}
                                    className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                                >
                                    {isRenderingRemotion ? '导出中...' : '导出视频'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {previewAsset && (
                <div className="fixed inset-0 z-[1000] bg-black/55 flex items-center justify-center p-4" onMouseDown={() => setPreviewAsset(null)}>
                    <div className="w-full max-w-[min(90vw,1100px)] rounded-3xl border border-border bg-background shadow-2xl overflow-hidden" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-border/70">
                            <div className="min-w-0">
                                <div className="text-sm font-medium text-text-primary truncate">{previewAsset.title || previewAsset.relativePath || previewAsset.id}</div>
                                <div className="text-xs text-text-tertiary mt-1">{previewAsset.prompt || previewAsset.relativePath || ''}</div>
                            </div>
                            <button type="button" onClick={() => setPreviewAsset(null)} className="rounded-xl p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="h-[72vh] bg-black/90 flex items-center justify-center p-6">
                            {inferAssetKind(previewAsset) === 'image' ? (
                                <img src={resolveAssetUrl(previewAsset.previewUrl || previewAsset.relativePath || previewAsset.absolutePath || '')} alt={previewAsset.title || previewAsset.id} className="max-w-full max-h-full object-contain" />
                            ) : inferAssetKind(previewAsset) === 'video' ? (
                                <video src={resolveAssetUrl(previewAsset.previewUrl || previewAsset.relativePath || previewAsset.absolutePath || '')} controls className="w-full max-h-full rounded-2xl bg-black" />
                            ) : inferAssetKind(previewAsset) === 'audio' ? (
                                <div className="w-full max-w-xl rounded-[28px] border border-white/10 bg-white/5 p-8 text-white">
                                    <div className="flex items-center gap-4">
                                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                                            <AudioLines className="h-6 w-6" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="truncate text-base font-medium">{previewAsset.title || previewAsset.relativePath || previewAsset.id}</div>
                                            <div className="mt-1 text-xs text-white/60">音频素材预览</div>
                                        </div>
                                    </div>
                                    <audio
                                        src={resolveAssetUrl(previewAsset.previewUrl || previewAsset.relativePath || previewAsset.absolutePath || '')}
                                        controls
                                        className="mt-8 w-full"
                                    />
                                </div>
                            ) : (
                                <div className="text-white/80 flex flex-col items-center gap-3">
                                    <AudioLines className="w-10 h-10" />
                                    <div className="text-sm">当前素材暂不支持预览。</div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={Boolean(pendingDeleteDraftPath)}
                title="删除草稿"
                description="确认删除这个草稿或文件夹吗？"
                confirmLabel="删除"
                tone="danger"
                onCancel={() => setPendingDeleteDraftPath(null)}
                onConfirm={() => {
                    if (!pendingDeleteDraftPath) return;
                    void handleDeleteDraft(pendingDeleteDraftPath);
                }}
            />
        </>
    );
}
