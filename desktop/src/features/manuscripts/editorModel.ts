import type { MediaJobProjection } from '../media-jobs/types';
import { resolveAssetUrl } from '../../utils/pathManager';
import { formatTimestampDate, parseTimestampMs } from '../../utils/time';
import { parseMarkdownFrontmatter } from '../../utils/markdownFrontmatter';
import {
    MANUSCRIPT_HTML_EXTENSION,
    MANUSCRIPT_MARKDOWN_EXTENSION,
    ensureManuscriptFileName,
    getManuscriptFileKind,
    stripManuscriptExtension,
    type ManuscriptExtension,
    type ManuscriptFileKind,
} from '../../../shared/manuscriptFiles';

export type DraftFilter = 'all' | 'drafts' | 'media' | 'image' | 'video' | 'audio' | 'folders';
export type DraftLayout = 'gallery' | 'list';
export type CreateKind = 'folder' | 'longform' | 'html';
export type ManuscriptDraftType = CreateKind | 'document' | 'unknown';
export type FileNode = {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    status?: 'writing' | 'completed' | 'abandoned';
    title?: string;
    draftType?: ManuscriptDraftType;
    contentFormat?: ManuscriptFileKind;
    updatedAt?: number;
    summary?: string;
};

export type MediaAssetSource = 'generated' | 'planned' | 'imported' | 'external';

export type MediaAsset = {
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

export type GeneratedAsset = {
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

export type ReferenceImageItem = {
    name: string;
    dataUrl: string;
};

export type SettingsShape = {
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

export type ManuscriptReadResult = {
    content?: string;
    metadata?: Record<string, unknown>;
};

export type ManuscriptWriteProposal = {
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

export type FileCardMeta = {
    title: string;
    draftType: ManuscriptDraftType;
    contentFormat?: ManuscriptFileKind;
    updatedAt?: number;
    summary: string;
};

export type DraftCard = {
    id: string;
    kind: 'draft';
    updatedAt: number;
    createdAt: number;
    file: FileNode;
    meta?: FileCardMeta;
    title: string;
    summary: string;
    draftType: ManuscriptDraftType;
};

export type EditorDescriptor = {
    title: string;
    draftType: ManuscriptDraftType;
};

export type FolderContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    folderPath: string;
    folderName: string;
};

export type AssetContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    assetId: string;
    assetTitle: string;
};

export type DraftContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    filePath: string;
    title: string;
};

export type VideoScriptApprovalState = {
    status?: 'pending' | 'confirmed';
    lastScriptUpdateAt?: number | null;
    lastScriptUpdateSource?: string | null;
    confirmedAt?: number | null;
};

export type VideoProjectState = {
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
    remotion?: RemotionState | null;
    renderOutput?: string | null;
    legacy?: Record<string, unknown>;
};

export type RemotionState = {
    width?: number | string | null;
    height?: number | string | null;
    render?: {
        outputPath?: string | null;
        renderedAt?: number;
        durationInFrames?: number;
    } | null;
} & Record<string, unknown>;

export type PackageState = {
    manifest?: Record<string, unknown>;
    assets?: { items?: Array<Record<string, unknown>> };
    cover?: Record<string, unknown>;
    images?: { items?: Array<Record<string, unknown>> };
    remotion?: RemotionState | null;
    timelineSummary?: {
        trackCount?: number;
        clipCount?: number;
        sourceRefs?: Array<Record<string, unknown>>;
        clips?: Array<Record<string, unknown>>;
        trackNames?: string[];
        trackUi?: Record<string, unknown>;
    };
    editorProject?: {
        script?: {
            body?: string | null;
        } | null;
        ai?: {
            scriptApproval?: {
                status?: string | null;
            } | null;
        } | null;
    } | null;
    videoProject?: VideoProjectState | null;
    contentMapExists?: boolean;
    contentMapFile?: string | null;
    contentMapUpdatedAt?: number | null;
};

export type ExportVideoResolution = 'source' | '1080p' | '720p';

export const DEFAULT_UNTITLED_DRAFT_TITLE = '未命名';
export function resolveDraftExtension(kind: ManuscriptDraftType): string {
    if (kind === 'longform') return '';
    if (kind === 'html') return MANUSCRIPT_HTML_EXTENSION;
    if (kind === 'document') return '';
    return MANUSCRIPT_MARKDOWN_EXTENSION;
}

export function stripDraftExtension(fileName: string): string {
    return stripManuscriptExtension(fileName);
}

export function exportResolutionDimensions(
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

export function ensureDraftFileName(baseName: string, kind: ManuscriptDraftType): string {
    const extension = resolveDraftExtension(kind);
    return extension ? ensureManuscriptFileName(baseName, extension as ManuscriptExtension) : baseName;
}

export const MANUSCRIPTS_INITIAL_ASSET_LIMIT = 0;
export const MANUSCRIPTS_ACTIVE_ASSET_LIMIT = 60;
export const MANUSCRIPTS_CARD_RENDER_LIMIT = 80;

export const IMAGE_ASPECT_RATIO_OPTIONS = [
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: 'auto', label: 'auto' },
] as const;

export const VIDEO_ASPECT_RATIO_OPTIONS = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
] as const;

export const VIDEO_GENERATION_MODE_OPTIONS = [
    { value: 'text-to-video', label: '文生视频' },
    { value: 'reference-guided', label: '参考图视频' },
    { value: 'first-last-frame', label: '首尾帧视频' },
] as const;

export const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

export function getCurrentFolderChildren(tree: FileNode[], folderPath: string): FileNode[] {
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

export function collectNestedFiles(items: FileNode[]): FileNode[] {
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

export function isInternalPackageFile(filePath: string): boolean {
    return String(filePath || '').replace(/\\/g, '/').split('/').some((part) => part === 'manifest.json');
}

export function isPackageDraftPath(filePath: string): boolean {
    return getManuscriptFileKind(filePath) === null;
}

export function getFolderTrail(folderPath: string): Array<{ label: string; path: string }> {
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

export function getParentFolderPath(folderPath: string): string {
    const parts = folderPath.split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/');
}

export function getRelativeFolderPath(filePath: string): string {
    const normalized = String(filePath || '').replace(/\\/g, '/').trim();
    if (!normalized) return '';
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/');
}

export function buildMediaFolderTree(assets: MediaAsset[]): FileNode[] {
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

export function buildDraftTemplate(title: string, kind: Exclude<CreateKind, 'folder'>): string {
    const ts = Date.now();
    const safeTitle = title.trim() || DEFAULT_UNTITLED_DRAFT_TITLE;
    const sectionTitle = '长文草稿';

    const quotedTitle = JSON.stringify(safeTitle);

    return `---\nid: draft_${ts}\ntitle: ${quotedTitle}\ndraftType: ${kind}\nstatus: writing\ncreatedAt: ${ts}\nupdatedAt: ${ts}\n---\n\n# ${safeTitle}\n\n## ${sectionTitle}\n\n`;
}

export function shouldHideFrontmatterInEditor(draftType: ManuscriptDraftType | null | undefined): boolean {
    if (draftType === 'html') return false;
    return true;
}

export function splitWritingDraftContent(content: string, draftType: ManuscriptDraftType | null | undefined) {
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

export function normalizeDraftFileName(input: string): string {
    const trimmed = input.trim();
    const sanitized = trimmed.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
    return sanitized || `untitled-${Date.now()}`;
}

export function buildDraftStorageName(): string {
    return `manuscript-${Date.now()}`;
}

export function pathBasenameSafe(rawPath: string): string {
    const normalized = String(rawPath || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}

export function manuscriptContentFormatFromPath(filePath: string | null | undefined): 'markdown' | 'html' {
    return getManuscriptFileKind(String(filePath || '')) === 'html' ? 'html' : 'markdown';
}

export function normalizeAssetKindReference(value: string | null | undefined): string {
    const trimmed = String(value || '').trim().toLowerCase();
    if (!trimmed) return '';
    return trimmed.split(/[?#]/, 1)[0] || '';
}

export function isSameDraftRelativePath(left: string | null | undefined, right: string | null | undefined): boolean {
    const normalize = (value: string | null | undefined) => String(value || '')
        .replace(/\\/g, '/')
        .trim()
        .split('/')
        .filter((segment) => segment && segment !== '.')
        .join('/');
    return normalize(left) === normalize(right);
}

export function inferAssetKind(asset: MediaAsset): 'image' | 'video' | 'audio' | 'unknown' {
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


export function isVideoAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(String(asset.relativePath || '').trim());
}

export function getVideoReferenceModeHint(mode: 'text-to-video' | 'reference-guided' | 'first-last-frame'): string {
    if (mode === 'reference-guided') {
        return '上传 1 到 5 张参考图，视频会尽量复用这些图中的主体元素、风格和构图线索。';
    }
    if (mode === 'first-last-frame') {
        return '请上传 2 张图片，第一张作为首帧，第二张作为尾帧。';
    }
    return '文生视频不需要参考图。';
}

export function generatedAssetsFromMediaJob(job: MediaJobProjection | null | undefined): GeneratedAsset[] {
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

export function mediaJobErrorMessage(job: MediaJobProjection | null | undefined, fallback: string): string {
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

export function sortMediaJobsByRecency(jobs: MediaJobProjection[]): MediaJobProjection[] {
    return [...jobs].sort((left, right) => {
        const updatedDelta = parseTimestampMs(right.updatedAt) - parseTimestampMs(left.updatedAt);
        if (updatedDelta !== 0) return updatedDelta;
        return parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt);
    });
}

export function inferImageAspectFromSize(size: string): string {
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

export function formatDateLabel(input?: string | number): string {
    return formatTimestampDate(input);
}

export function resolveDraftTypeLabel(type: ManuscriptDraftType): string {
    if (type === 'longform') return '长文';
    if (type === 'html') return 'HTML';
    if (type === 'document') return '文档';
    return '稿件';
}

export function resolveDraftTypeStyle(type: ManuscriptDraftType): { chip: string; tile: string; iconWrap: string } {
    void type;
    return {
        chip: 'bg-sky-500/10 text-sky-700 border border-sky-200/90',
        tile: 'bg-[linear-gradient(135deg,#10253f_0%,#315e8f_54%,#d6ecff_100%)] text-white',
        iconWrap: 'bg-white/15 text-white',
    };
}

export function isRemovedMediaDraftType(type: unknown): boolean {
    const normalized = String(type || '').trim();
    return normalized === 'video' || normalized === 'audio';
}

export function summaryFromContent(content: string): string {
    const plain = String(content || '')
        .replace(/^#+\s+/gm, '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/[*_>`~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.slice(0, 72);
}

export function collectFileMetaMap(nodes: FileNode[]): Record<string, FileCardMeta> {
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
                contentFormat: item.contentFormat,
                updatedAt: Number(item.updatedAt || 0) || undefined,
                summary: item.summary || '',
            };
        }
    };
    visit(nodes);
    return next;
}
