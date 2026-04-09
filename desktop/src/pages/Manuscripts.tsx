import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
    ArrowLeft,
    AudioLines,
    ChevronRight,
    Clapperboard,
    ExternalLink,
    FileAudio,
    FileImage,
    FileText,
    FolderOpen,
    FolderPlus,
    Grid2X2,
    Image as ImageIcon,
    ImagePlus,
    Plus,
    RefreshCw,
    Search,
    Sparkles,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { resolveAssetUrl } from '../utils/pathManager';
import type { PendingChatMessage } from '../App';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../shared/redboxVideo';
import type { RemotionCompositionConfig } from '../components/manuscripts/remotion/types';
import {
    ARTICLE_DRAFT_EXTENSION,
    AUDIO_DRAFT_EXTENSION,
    ensureManuscriptFileName,
    POST_DRAFT_EXTENSION,
    stripManuscriptExtension,
    VIDEO_DRAFT_EXTENSION,
} from '../../shared/manuscriptFiles';

const LegacyManuscriptsWorkspace = lazy(async () => ({
    default: (await import('./LegacyManuscriptsWorkspace')).Manuscripts,
}));
const VideoDraftWorkbench = lazy(async () => ({
    default: (await import('../components/manuscripts/VideoDraftWorkbench')).VideoDraftWorkbench,
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

type FileCardMeta = {
    title: string;
    draftType: CreateKind | 'unknown';
    updatedAt?: number;
    summary: string;
};

type EditorDescriptor = {
    title: string;
    draftType: CreateKind | 'unknown';
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
    };
    hasLayoutHtml?: boolean;
    hasWechatHtml?: boolean;
    layoutHtml?: string;
    wechatHtml?: string;
};

const DEFAULT_UNTITLED_DRAFT_TITLE = '未命名';

function resolveDraftExtension(kind: CreateKind | 'unknown'): string {
    if (kind === 'video') return VIDEO_DRAFT_EXTENSION;
    if (kind === 'audio') return AUDIO_DRAFT_EXTENSION;
    return '.md';
}

function stripDraftExtension(fileName: string): string {
    return stripManuscriptExtension(fileName);
}

function ensureDraftFileName(baseName: string, kind: CreateKind | 'unknown'): string {
    const extension = resolveDraftExtension(kind);
    return ensureManuscriptFileName(baseName, extension as typeof VIDEO_DRAFT_EXTENSION | typeof AUDIO_DRAFT_EXTENSION | '.md');
}

interface ManuscriptsProps {
    pendingFile?: string | null;
    onFileConsumed?: () => void;
    onNavigateToRedClaw?: (message: PendingChatMessage) => void;
    isActive?: boolean;
    onImmersiveModeChange?: (active: boolean) => void;
}

const CREATE_KIND_OPTIONS: Array<{ id: CreateKind; label: string; description: string; icon: typeof FileText }> = [
    { id: 'longform', label: '长文', description: '适合长篇文章、公众号正文、深度稿。', icon: FileText },
    { id: 'richpost', label: '图文', description: '适合小红书、图文笔记、卡片式内容。', icon: FileImage },
    { id: 'video', label: '视频', description: '用于脚本、分镜、镜头资产和成片整理。', icon: Clapperboard },
    { id: 'audio', label: '音频', description: '用于播客、口播、配音和音频剪辑。', icon: AudioLines },
    { id: 'folder', label: '文件夹', description: '整理稿件和资产，像在线 Office 一样管理内容。', icon: FolderPlus },
];

const FILTER_OPTIONS: Array<{ id: DraftFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'drafts', label: '稿件' },
    { id: 'media', label: '素材' },
    { id: 'image', label: '图片' },
    { id: 'video', label: '视频' },
    { id: 'audio', label: '音频' },
    { id: 'folders', label: '文件夹' },
];

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

    const quotedTitle = JSON.stringify(safeTitle);

    return `---\nid: draft_${ts}\ntitle: ${quotedTitle}\ndraftType: ${kind}\nstatus: writing\ncreatedAt: ${ts}\nupdatedAt: ${ts}\n---\n\n# ${safeTitle}\n\n## ${sectionTitle}\n\n`;
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
    if (!input) return '';
    const value = typeof input === 'number' ? input : Date.parse(String(input));
    if (!Number.isFinite(value)) return '';
    return new Date(value).toLocaleDateString();
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
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<DraftFilter>('all');
    const [layout, setLayout] = useState<DraftLayout>('gallery');
    const [createOpen, setCreateOpen] = useState(false);
    const [createKind, setCreateKind] = useState<CreateKind>('longform');
    const [createTitle, setCreateTitle] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
    const [workingId, setWorkingId] = useState<string | null>(null);
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
    const [bindAssetRole, setBindAssetRole] = useState<'cover' | 'image' | 'asset'>('image');
    const [isBindAssetModalOpen, setIsBindAssetModalOpen] = useState(false);
    const [editorChatSessionId, setEditorChatSessionId] = useState<string | null>(null);
    const [editorBody, setEditorBody] = useState('');
    const [editorMetadata, setEditorMetadata] = useState<Record<string, unknown>>({});
    const [editorBodyDirty, setEditorBodyDirty] = useState(false);
    const [isSavingEditorBody, setIsSavingEditorBody] = useState(false);
    const treeRequestIdRef = useRef(0);
    const assetsRequestIdRef = useRef(0);
    const hasLoadedSnapshotRef = useRef(false);
    const fileMetaMap = useMemo(() => collectFileMetaMap(tree), [tree]);

    const loadTree = useCallback(async () => {
        const requestId = ++treeRequestIdRef.current;
        try {
            const treeResult = await window.ipcRenderer.invoke('manuscripts:list') as Promise<FileNode[]>;
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

    const loadAssets = useCallback(async () => {
        const requestId = ++assetsRequestIdRef.current;
        try {
            const mediaResult = await window.ipcRenderer.invoke('media:list', { limit: 500 }) as { success?: boolean; assets?: MediaAsset[]; error?: string };
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
    }, []);

    const loadData = useCallback(async () => {
        if (hasLoadedSnapshotRef.current) {
            setIsRefreshing(true);
        } else {
            setLoading(true);
        }
        setError('');
        try {
            await Promise.all([loadTree(), loadAssets()]);
            hasLoadedSnapshotRef.current = true;
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : '加载草稿失败');
        } finally {
            setLoading(false);
            setIsRefreshing(false);
        }
    }, [loadAssets, loadTree]);

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
            alert(importError instanceof Error ? importError.message : '导入素材失败');
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
            setSettings({});
        }
    }, []);

    usePageRefresh({
        isActive,
        refresh: loadData,
    });

    useEffect(() => {
        if (!isActive) return;
        const handleDataChanged = (_event: unknown, payload?: { scope?: string }) => {
            if (payload?.scope === 'manuscripts') {
                void loadTree();
                return;
            }
            if (payload?.scope === 'media') {
                void loadAssets();
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

    const currentFolderChildren = useMemo(() => getCurrentFolderChildren(tree, activeFolder), [tree, activeFolder]);
    const currentFolders = useMemo(() => currentFolderChildren.filter((item) => item.isDirectory), [currentFolderChildren]);
    const currentFiles = useMemo(() => currentFolderChildren.filter((item) => !item.isDirectory), [currentFolderChildren]);

    const normalizedQuery = query.trim().toLowerCase();

    const visibleFolders = useMemo(() => {
        if (filter !== 'all' && filter !== 'folders') return [] as FileNode[];
        return currentFolders.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery));
    }, [currentFolders, filter, normalizedQuery]);

    const visibleDrafts = useMemo(() => {
        if (filter !== 'all' && filter !== 'drafts') return [] as FileNode[];
        return currentFiles.filter((item) => {
            const meta = fileMetaMap[item.path];
            const haystack = `${item.name} ${meta?.title || ''} ${meta?.summary || ''}`.toLowerCase();
            return !normalizedQuery || haystack.includes(normalizedQuery);
        });
    }, [currentFiles, fileMetaMap, filter, normalizedQuery]);

    const visibleAssets = useMemo(() => {
        if (activeFolder) return [] as MediaAsset[];
        return assets.filter((asset) => {
            const assetKind = inferAssetKind(asset);
            if (filter === 'media' && !['image', 'video', 'audio'].includes(assetKind)) return false;
            if (filter === 'image' && assetKind !== 'image') return false;
            if (filter === 'video' && assetKind !== 'video') return false;
            if (filter === 'audio' && assetKind !== 'audio') return false;
            if (filter === 'drafts' || filter === 'folders') return false;
            const haystack = `${asset.title || ''} ${asset.prompt || ''} ${asset.relativePath || ''}`.toLowerCase();
            return !normalizedQuery || haystack.includes(normalizedQuery);
        });
    }, [activeFolder, assets, filter, normalizedQuery]);

    const activeTrail = useMemo(() => getFolderTrail(activeFolder), [activeFolder]);

    const handleCreate = useCallback(async () => {
        const normalizedName = normalizeDraftFileName(createTitle);
        if (createKind === 'folder' && !normalizedName) return;
        setIsCreating(true);
        try {
            if (createKind === 'folder') {
                const result = await window.ipcRenderer.invoke('manuscripts:create-folder', {
                    parentPath: activeFolder,
                    name: normalizedName,
                }) as { success?: boolean; error?: string };
                if (!result?.success) throw new Error(result?.error || '创建文件夹失败');
                await loadData();
                setActiveFolder(activeFolder ? `${activeFolder}/${normalizedName}` : normalizedName);
            } else {
                const storageName = buildDraftStorageName();
                const draftTitle = DEFAULT_UNTITLED_DRAFT_TITLE;
                const result = await window.ipcRenderer.invoke('manuscripts:create-file', {
                    parentPath: activeFolder,
                    name: ensureDraftFileName(storageName, createKind),
                    title: draftTitle,
                    content: buildDraftTemplate(draftTitle, createKind),
                }) as { success?: boolean; error?: string; path?: string };
                if (!result?.success || !result.path) throw new Error(result?.error || '创建草稿失败');
                await loadData();
                setEditorFile(result.path);
                setEditorDescriptor({
                    title: draftTitle,
                    draftType: createKind,
                });
                setMode('editor');
            }
            setCreateOpen(false);
            setCreateTitle('');
        } catch (createError) {
            const message = createError instanceof Error ? createError.message : '创建失败';
            alert(message);
        } finally {
            setIsCreating(false);
        }
    }, [activeFolder, createKind, createTitle, loadData]);

    const handleDeleteDraft = useCallback(async (targetPath: string) => {
        if (!window.confirm('确认删除这个草稿或文件夹吗？')) return;
        setWorkingId(targetPath);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete', targetPath) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '删除失败');
            if (activeFolder === targetPath) {
                setActiveFolder('');
            }
            await loadData();
        } catch (deleteError) {
            alert(deleteError instanceof Error ? deleteError.message : '删除失败');
        } finally {
            setWorkingId(null);
        }
    }, [activeFolder, loadData]);

    const handleDeleteAsset = useCallback(async (assetId: string) => {
        if (!window.confirm('确认删除这个媒体资产吗？')) return;
        setWorkingId(assetId);
        try {
            const result = await window.ipcRenderer.invoke('media:delete', { assetId }) as { success?: boolean; error?: string };
            if (!result?.success) throw new Error(result?.error || '删除媒体失败');
            await loadData();
        } catch (deleteError) {
            alert(deleteError instanceof Error ? deleteError.message : '删除媒体失败');
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
            setPackageState(result.state);
        } else {
            setPackageState(null);
        }
    }, []);

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
                setPackageState(result.state);
            } else {
                await refreshPackageState(editorFile);
            }
        } catch (importError) {
            alert(importError instanceof Error ? importError.message : '导入素材失败');
        } finally {
            setWorkingId(null);
        }
    }, [editorFile, refreshPackageState]);

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
            alert(error instanceof Error ? error.message : '生成 Remotion 动画方案失败');
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
            alert(error instanceof Error ? error.message : '保存 Remotion 动画方案失败');
        }
    }, [editorDescriptor?.draftType, editorFile]);

    const handleRenderRemotionVideo = useCallback(async () => {
        if (!editorFile || editorDescriptor?.draftType !== 'video') return;
        setIsRenderingRemotion(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:render-remotion-video', {
                filePath: editorFile,
            }) as { success?: boolean; state?: PackageState; outputPath?: string; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '导出 Remotion 视频失败');
            }
            setPackageState(result.state);
        } catch (error) {
            alert(error instanceof Error ? error.message : '导出 Remotion 视频失败');
        } finally {
            setIsRenderingRemotion(false);
        }
    }, [editorDescriptor?.draftType, editorFile]);

    const handleOpenRenderedRemotionVideo = useCallback(async () => {
        const outputPath = packageState?.remotion?.render?.outputPath;
        if (!outputPath) return;
        try {
            await window.ipcRenderer.invoke('app:open-path', { path: outputPath });
        } catch (error) {
            alert(error instanceof Error ? error.message : '打开导出文件失败');
        }
    }, [packageState?.remotion?.render?.outputPath]);

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
            alert(upgradeError instanceof Error ? upgradeError.message : '升级工程稿件失败');
        } finally {
            setIsUpgradingDraft(false);
        }
    }, [editorFile, loadData, refreshPackageState]);

    useEffect(() => {
        if (!editorFile) {
            setPackageState(null);
            return;
        }
        void refreshPackageState(editorFile);
    }, [editorFile, refreshPackageState]);

    useEffect(() => {
        if (!editorFile || mode !== 'editor') {
            setEditorBody('');
            setEditorMetadata({});
            setEditorBodyDirty(false);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const result = await window.ipcRenderer.invoke('manuscripts:read', editorFile) as ManuscriptReadResult;
                if (cancelled) return;
                setEditorBody(String(result?.content || ''));
                setEditorMetadata((result?.metadata || {}) as Record<string, unknown>);
                setEditorBodyDirty(false);
            } catch (error) {
                console.error('Failed to load editor body:', error);
                if (!cancelled) {
                    setEditorBody('');
                    setEditorMetadata({});
                    setEditorBodyDirty(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [editorFile, mode]);

    useEffect(() => {
        if (!editorFile || !editorBodyDirty) return;
        const timer = window.setTimeout(async () => {
            try {
                setIsSavingEditorBody(true);
                const result = await window.ipcRenderer.invoke('manuscripts:save', {
                    path: editorFile,
                    content: editorBody,
                    metadata: editorMetadata,
                }) as { success?: boolean; error?: string };
                if (!result?.success) {
                    throw new Error(result?.error || '保存失败');
                }
                setEditorBodyDirty(false);
            } catch (error) {
                console.error('Failed to save editor body:', error);
            } finally {
                setIsSavingEditorBody(false);
            }
        }, 700);
        return () => window.clearTimeout(timer);
    }, [editorBody, editorBodyDirty, editorFile, editorMetadata]);

    useEffect(() => {
        if (!editorFile || (editorDescriptor?.draftType !== 'video' && editorDescriptor?.draftType !== 'audio')) {
            setEditorChatSessionId(null);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const session = await window.ipcRenderer.invoke('chat:getOrCreateFileSession', { filePath: editorFile }) as { id?: string } | null;
                if (cancelled || !session?.id) return;
                setEditorChatSessionId(session.id);
            } catch (error) {
                console.error('Failed to prepare editor chat session:', error);
                if (!cancelled) {
                    setEditorChatSessionId(null);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [editorDescriptor?.draftType, editorFile]);

    useEffect(() => {
        if (!editorChatSessionId || !editorFile) return;
        const draftType = editorDescriptor?.draftType;
        if (draftType !== 'video' && draftType !== 'audio') return;

        const packageAssets = Array.isArray(packageState?.assets?.items) ? packageState?.assets?.items : [];
        const timelineClips = Array.isArray(packageState?.timelineSummary?.clips) ? packageState?.timelineSummary?.clips : [];
        const timelineSummary = packageState?.timelineSummary as ({ trackNames?: string[] } & Record<string, unknown>) | undefined;
        const timelineTrackNames = Array.isArray(timelineSummary?.trackNames)
            ? timelineSummary.trackNames
            : Array.from(new Set(timelineClips.map((item) => String(item?.track || '').trim()).filter(Boolean)));

        void window.ipcRenderer.invoke('chat:update-session-metadata', {
            sessionId: editorChatSessionId,
            metadata: {
                associatedFilePath: editorFile,
                associatedPackageKind: draftType,
                agentProfile: draftType === 'video' ? 'video-editor' : draftType === 'audio' ? 'audio-editor' : 'default',
                associatedPackageTitle: editorDescriptor?.title || fileMetaMap[editorFile]?.title || '未命名',
                associatedPackageAssetCount: packageAssets.length,
                associatedPackageClipCount: Number(packageState?.timelineSummary?.clipCount || timelineClips.length || 0),
                associatedPackageTrackNames: timelineTrackNames,
                associatedPackageClips: timelineClips.slice(0, 12).map((item) => ({
                    assetId: item?.assetId,
                    name: item?.name,
                    track: item?.track,
                    order: item?.order,
                    durationMs: item?.durationMs,
                    trimInMs: item?.trimInMs,
                    trimOutMs: item?.trimOutMs,
                    enabled: item?.enabled,
                })),
            },
        }).catch((error) => {
            console.error('Failed to sync editor chat metadata:', error);
        });
    }, [editorChatSessionId, editorDescriptor?.draftType, editorDescriptor?.title, editorFile, fileMetaMap, packageState]);

    useEffect(() => {
        const immersive = mode === 'editor' && (editorDescriptor?.draftType === 'video' || editorDescriptor?.draftType === 'audio');
        onImmersiveModeChange?.(immersive);
        return () => {
            onImmersiveModeChange?.(false);
        };
    }, [editorDescriptor?.draftType, mode, onImmersiveModeChange]);

    const handleBindAssetToPackage = useCallback(async (assetId: string) => {
        if (!editorFile) return;
        try {
            const result = await window.ipcRenderer.invoke('media:bind', {
                assetId,
                manuscriptPath: editorFile,
                role: bindAssetRole,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '绑定素材失败');
            }
            await loadData();
            await refreshPackageState(editorFile);
            setIsBindAssetModalOpen(false);
        } catch (bindError) {
            alert(bindError instanceof Error ? bindError.message : '绑定素材失败');
        }
    }, [bindAssetRole, editorFile, loadData, refreshPackageState]);

    const openAssetExternally = useCallback(async (assetId: string) => {
        const result = await window.ipcRenderer.invoke('media:open', { assetId }) as { success?: boolean; error?: string };
        if (!result?.success) {
            alert(result?.error || '打开资产失败');
        }
    }, []);

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
        const draftCards = visibleDrafts.map((file) => {
            const meta = fileMetaMap[file.path];
            const draftType = meta?.draftType || 'unknown';
            return {
                id: `draft:${file.path}`,
                kind: 'draft' as const,
                updatedAt: Number(meta?.updatedAt || 0) || 0,
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
            updatedAt: Date.parse(asset.updatedAt || asset.createdAt || '') || 0,
            asset,
            title: asset.title || asset.relativePath || asset.id,
            summary: asset.prompt || asset.relativePath || '',
            assetKind: inferAssetKind(asset),
        }));

        return [...draftCards, ...assetCards].sort((a, b) => {
            const timeDelta = b.updatedAt - a.updatedAt;
            if (timeDelta !== 0) return timeDelta;
            return a.title.localeCompare(b.title, 'zh-Hans-CN');
        });
    }, [fileMetaMap, visibleAssets, visibleDrafts]);

    const bindableImageAssets = useMemo(
        () => assets.filter((asset) => inferAssetKind(asset) === 'image'),
        [assets]
    );
    const bindableAssets = useMemo(
        () => bindAssetRole === 'asset' ? assets : bindableImageAssets,
        [assets, bindAssetRole, bindableImageAssets]
    );

    if (mode === 'editor' && editorFile) {
        const currentDescriptor = editorDescriptor || {
            title: fileMetaMap[editorFile]?.title || editorFile,
            draftType: fileMetaMap[editorFile]?.draftType || 'unknown',
        };
        const draftType = currentDescriptor.draftType;
        const draftTheme = resolveDraftTypeTheme(draftType);
        const isVideoDraft = draftType === 'video';
        const isAudioDraft = draftType === 'audio';
        const isImmersiveWorkbench = isVideoDraft || isAudioDraft;
        const isRichPostDraft = draftType === 'richpost';
        const isMarkdownDraft = editorFile.endsWith('.md');
        const canUpgradeToArticle = draftType === 'longform' && isMarkdownDraft;
        const canUpgradeToPost = draftType === 'richpost' && isMarkdownDraft;
        const isArticlePackage = editorFile.endsWith(ARTICLE_DRAFT_EXTENSION);
        const isPostPackage = editorFile.endsWith(POST_DRAFT_EXTENSION);
        const isVideoPackage = editorFile.endsWith(VIDEO_DRAFT_EXTENSION);
        const isAudioPackage = editorFile.endsWith(AUDIO_DRAFT_EXTENSION);
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
        const packagePreviewAssets = [
            ...assets.filter((asset) => packageAssetIds.has(asset.id)),
            ...packageAssets
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
                })),
        ];
        const articlePreviewHtml = String(packageState?.wechatHtml || packageState?.layoutHtml || '').trim();
        const primaryVideoAsset = packagePreviewAssets.find((asset) => {
            const kind = inferAssetKind(asset);
            return kind === 'video' || kind === 'image';
        }) || null;
        const primaryAudioAsset = packagePreviewAssets.find((asset) => inferAssetKind(asset) === 'audio')
            || packagePreviewAssets.find((asset) => inferAssetKind(asset) === 'video')
            || null;
        const timelineTrackNames = Array.from(new Set((timelineClips.length > 0 ? timelineClips : [
            { track: isAudioDraft ? 'A1' : 'V1' },
            { track: isVideoDraft ? 'A1' : 'T1' },
        ]).map((item) => String(item.track || '').trim()).filter(Boolean)));

        return (
            <div className={clsx('h-full min-h-0 flex flex-col', isImmersiveWorkbench ? 'bg-[#0f0f0f] text-white' : 'bg-background')}>
                <div className={clsx(
                    'flex items-center justify-between gap-3 px-6 py-3 backdrop-blur-sm',
                    isImmersiveWorkbench
                        ? 'border-b border-white/10 bg-[#111111]'
                        : 'border-b border-border/70 bg-background/95'
                )}>
                    <div className="flex items-center gap-3 min-w-0">
                        <button
                            type="button"
                            onClick={() => setMode('gallery')}
                            className={clsx(
                                'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors',
                                isImmersiveWorkbench
                                    ? 'border border-white/10 text-white/70 hover:bg-white/5 hover:text-white'
                                    : 'border border-border text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                            )}
                        >
                            <ArrowLeft className="w-4 h-4" />
                            返回草稿
                        </button>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <div className={clsx('text-sm font-medium truncate', isImmersiveWorkbench ? 'text-white' : 'text-text-primary')}>{currentDescriptor.title}</div>
                                <span className={clsx('rounded-full px-2.5 py-1 text-[10px] font-medium', draftTheme.chip)}>
                                    {resolveDraftTypeLabel(draftType)}
                                </span>
                            </div>
                            <div className={clsx('text-xs truncate', isImmersiveWorkbench ? 'text-white/35' : 'text-text-tertiary')}>{editorFile}</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {canUpgradeToArticle && (
                            <button
                                type="button"
                                onClick={() => void handleUpgradeDraftPackage('article')}
                                disabled={isUpgradingDraft}
                                className={clsx(
                                    'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm disabled:opacity-60',
                                    isImmersiveWorkbench
                                        ? 'border border-white/10 text-white/70 hover:bg-white/5 hover:text-white'
                                        : 'border border-border text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                                )}
                            >
                                <Sparkles className="h-4 w-4" />
                                {isUpgradingDraft ? '升级中...' : '升级为排版工程'}
                            </button>
                        )}
                        {canUpgradeToPost && (
                            <button
                                type="button"
                                onClick={() => void handleUpgradeDraftPackage('post')}
                                disabled={isUpgradingDraft}
                                className={clsx(
                                    'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm disabled:opacity-60',
                                    isImmersiveWorkbench
                                        ? 'border border-white/10 text-white/70 hover:bg-white/5 hover:text-white'
                                        : 'border border-border text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                                )}
                            >
                                <Sparkles className="h-4 w-4" />
                                {isUpgradingDraft ? '升级中...' : '升级为图文工程'}
                            </button>
                        )}
                        {(isArticlePackage || isPostPackage) && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setBindAssetRole('cover');
                                        setIsBindAssetModalOpen(true);
                                    }}
                                    className={clsx(
                                        'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
                                        isImmersiveWorkbench
                                            ? 'border border-white/10 text-white/70 hover:bg-white/5 hover:text-white'
                                            : 'border border-border text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                                    )}
                                >
                                    <ImageIcon className="h-4 w-4" />
                                    {isPostPackage ? '设置封面' : '绑定封面'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setBindAssetRole('image');
                                        setIsBindAssetModalOpen(true);
                                    }}
                                    className={clsx(
                                        'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
                                        isImmersiveWorkbench
                                            ? 'border border-white/10 text-white/70 hover:bg-white/5 hover:text-white'
                                            : 'border border-border text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                                    )}
                                >
                                    <FileImage className="h-4 w-4" />
                                    {isPostPackage ? '添加配图' : '插入配图'}
                                </button>
                            </>
                        )}
                        {(isVideoPackage || isAudioPackage) && (
                            <button
                                type="button"
                                onClick={() => {
                                    void handleImportAndBindAssetsToPackage();
                                }}
                                className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/75 hover:bg-white/5 hover:text-white"
                            >
                                <Upload className="h-4 w-4" />
                                导入素材
                            </button>
                        )}
                    </div>
                </div>
                {isVideoDraft ? (
                    <Suspense fallback={<div className="h-full flex items-center justify-center text-white/45">视频工作台加载中...</div>}>
                        <VideoDraftWorkbench
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
                            onPackageStateChange={(state) => setPackageState(state as PackageState)}
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
                    <Suspense fallback={<div className="h-full flex items-center justify-center text-white/45">音频工作台加载中...</div>}>
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
                            editorChatSessionId={editorChatSessionId}
                            onEditorBodyChange={(value) => {
                                setEditorBody(value);
                                setEditorBodyDirty(true);
                            }}
                            onOpenBindAssets={() => {
                                void handleImportAndBindAssetsToPackage();
                            }}
                            onPackageStateChange={(state) => setPackageState(state as PackageState)}
                        />
                    </Suspense>
                ) : isRichPostDraft ? (
                    <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_420px]">
                        <div className="min-h-0">
                            <Suspense fallback={<div className="h-full flex items-center justify-center text-text-tertiary">编辑器加载中...</div>}>
                                <LegacyManuscriptsWorkspace pendingFile={editorFile} onNavigateToRedClaw={onNavigateToRedClaw} isActive={true} />
                            </Suspense>
                        </div>
                        <div className="border-l border-border/70 bg-[#fffaf3] px-6 py-5">
                            <div className="text-xs uppercase tracking-[0.24em] text-amber-600/70">Mobile Preview</div>
                            {(isPostPackage || isArticlePackage) && (
                                <div className="mt-3 rounded-2xl border border-amber-200/70 bg-white/85 px-4 py-3 text-xs text-text-secondary">
                                    <div>封面：{packageCoverId ? '已绑定' : '未绑定'}</div>
                                    <div className="mt-1">配图：{packageImages.length} 张</div>
                                    {isArticlePackage && (
                                        <div className="mt-1">排版：{packageState?.hasWechatHtml ? '已生成公众号 HTML' : '尚未生成'}</div>
                                    )}
                                </div>
                            )}
                            <div className="mt-4 rounded-[36px] border border-border bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
                                <div className="mx-auto w-[252px] rounded-[30px] border border-border bg-white p-4">
                                    {packageCoverId && packagePreviewAssets.find((asset) => asset.id === packageCoverId) ? (
                                        <img
                                            src={resolveAssetUrl(packagePreviewAssets.find((asset) => asset.id === packageCoverId)?.previewUrl || packagePreviewAssets.find((asset) => asset.id === packageCoverId)?.relativePath || '')}
                                            alt="封面"
                                            className="h-40 w-full rounded-3xl object-cover"
                                        />
                                    ) : (
                                        <div className="h-40 rounded-3xl bg-[linear-gradient(135deg,#fed7aa,#fdba74_38%,#fb7185)]" />
                                    )}
                                    <div className="mt-4 h-3 w-4/5 rounded-full bg-surface-secondary" />
                                    <div className="mt-2 h-3 w-3/5 rounded-full bg-surface-secondary" />
                                    <div className="mt-5 space-y-2">
                                        <div className="h-2.5 rounded-full bg-surface-secondary" />
                                        <div className="h-2.5 rounded-full bg-surface-secondary" />
                                        <div className="h-2.5 w-4/5 rounded-full bg-surface-secondary" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_340px]">
                        <div className="min-h-0">
                            <Suspense fallback={<div className="h-full flex items-center justify-center text-text-tertiary">编辑器加载中...</div>}>
                                <LegacyManuscriptsWorkspace pendingFile={editorFile} onNavigateToRedClaw={onNavigateToRedClaw} isActive={true} />
                            </Suspense>
                        </div>
                        <div className="border-l border-border/70 bg-[#fbf8ef] px-5 py-5">
                            <div className="text-xs uppercase tracking-[0.24em] text-[#8a6d3b]">Document Outline</div>
                            {isArticlePackage && (
                                <div className="mt-4 rounded-2xl border border-[#eadfbe] bg-white/85 px-4 py-3 text-xs text-text-secondary">
                                    <div>封面：{packageCoverId ? '已绑定' : '未绑定'}</div>
                                    <div className="mt-1">插图：{packageImages.length} 张</div>
                                    <div className="mt-1">公众号 HTML：{packageState?.hasWechatHtml ? '已生成' : '未生成'}</div>
                                </div>
                            )}
                            {isArticlePackage && articlePreviewHtml ? (
                                <div className="mt-4 overflow-hidden rounded-2xl border border-[#eadfbe] bg-white">
                                    <iframe
                                        title="文章排版预览"
                                        srcDoc={articlePreviewHtml}
                                        className="h-[520px] w-full bg-white"
                                    />
                                </div>
                            ) : (
                                <div className="mt-4 space-y-3">
                                    {['标题与摘要', '正文结构', '引用与资料', '复盘备注'].map((item) => (
                                        <div key={item} className="rounded-2xl border border-[#eadfbe] bg-white/85 px-4 py-3 text-sm text-text-secondary">
                                            {item}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {(isArticlePackage || isPostPackage) && packagePreviewAssets.length > 0 && (
                                <div className="mt-4 space-y-2">
                                    {packagePreviewAssets.slice(0, 4).map((asset) => (
                                        <div key={asset.id} className="flex items-center gap-3 rounded-2xl border border-[#eadfbe] bg-white/85 px-3 py-2">
                                            <div className="h-12 w-12 overflow-hidden rounded-xl bg-surface-secondary">
                                                <img src={resolveAssetUrl(asset.previewUrl || asset.relativePath || '')} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-sm font-medium text-text-primary">{asset.title || asset.relativePath || asset.id}</div>
                                                <div className="truncate text-xs text-text-tertiary">{asset.id === packageCoverId ? '封面' : '配图素材'}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <>
        <div className="h-full min-h-0 overflow-auto bg-background text-text-primary">
            <div className="mx-auto flex w-full max-w-[1680px] flex-col px-5 py-4">
                <div className="border-b border-border/60 px-2 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex min-w-0 flex-wrap items-center gap-5 text-sm">
                                {[
                                    { id: 'all', label: '我的空间' },
                                    { id: 'drafts', label: '我的稿件' },
                                    { id: 'media', label: '素材画廊' },
                                    { id: 'folders', label: '文件夹' },
                                ].map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setFilter(item.id as DraftFilter)}
                                        className={clsx(
                                            'relative pb-1 transition-colors',
                                            filter === item.id ? 'font-semibold text-text-primary' : 'text-text-secondary hover:text-text-primary'
                                        )}
                                    >
                                        {item.label}
                                        {filter === item.id && <span className="absolute inset-x-0 -bottom-[21px] h-0.5 rounded-full bg-accent-primary" />}
                                    </button>
                                ))}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <label className="relative w-[420px] max-w-[60vw] min-w-[260px]">
                                    <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                                    <input
                                        value={query}
                                        onChange={(event) => setQuery(event.target.value)}
                                        placeholder="搜索我的空间"
                                        className="h-11 w-full rounded-2xl border border-border/60 bg-white/70 pl-11 pr-4 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] focus:border-accent-primary focus:outline-none"
                                    />
                                </label>
                                <button
                                    type="button"
                                    onClick={() => setFilter('folders')}
                                    className="inline-flex items-center gap-2 rounded-2xl border border-border bg-white/70 px-4 py-2.5 text-sm text-text-secondary hover:text-text-primary"
                                >
                                    <FolderOpen className="h-4 w-4" />
                                    空间目录
                                </button>
                                <div className="flex items-center gap-2 rounded-2xl bg-accent-primary px-2 py-2 text-white shadow-[0_16px_36px_rgba(37,99,235,0.24)]">
                                    <button type="button" onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium">
                                        <Plus className="h-4 w-4" />
                                        新建
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleImportMediaFiles()}
                                        disabled={workingId === 'media-import'}
                                        className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-3 py-1.5 text-sm"
                                    >
                                        <Upload className="h-4 w-4" />
                                        {workingId === 'media-import' ? '导入中' : '上传'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="border-b border-border/60 px-2 py-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
                                {activeTrail.map((crumb, index) => (
                                    <div key={crumb.path || 'root'} className="flex min-w-0 items-center gap-2">
                                        {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-text-tertiary" />}
                                        <button
                                            type="button"
                                            onClick={() => setActiveFolder(crumb.path)}
                                            className={clsx('truncate transition-colors hover:text-text-primary', crumb.path === activeFolder && 'font-medium text-text-primary')}
                                        >
                                            {crumb.label}
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsImageModalOpen(true);
                                        void loadSettings();
                                    }}
                                    className="inline-flex items-center gap-2 rounded-xl border border-border bg-white/70 px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
                                >
                                    <ImageIcon className="h-4 w-4" />
                                    生图
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsVideoModalOpen(true);
                                        void loadSettings();
                                    }}
                                    className="inline-flex items-center gap-2 rounded-xl border border-border bg-white/70 px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
                                >
                                    <Clapperboard className="h-4 w-4" />
                                    生视频
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void loadData()}
                                    className="inline-flex items-center gap-2 rounded-xl border border-border bg-white/70 px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
                                >
                                    <RefreshCw className={clsx('h-4 w-4', isRefreshing && 'animate-spin')} />
                                    {isRefreshing ? '刷新中' : '刷新'}
                                </button>
                                {activeFolder === '' && (
                                    <button
                                        type="button"
                                        onClick={() => void window.ipcRenderer.invoke('media:open-root')}
                                        className="inline-flex items-center gap-2 rounded-xl border border-border bg-white/70 px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
                                    >
                                        <ExternalLink className="h-4 w-4" />
                                        打开媒体目录
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="mt-4">
                            <div className="mb-2 flex items-center justify-between">
                                <div className="text-sm font-semibold text-text-primary">文件夹 ({visibleFolders.length})</div>
                                <div className="text-xs text-text-tertiary">内容已经汇总进画廊，文件夹只负责整理。</div>
                            </div>
                            <div className="flex gap-3 overflow-x-auto pb-1">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setCreateKind('folder');
                                        setCreateTitle('');
                                        setCreateOpen(true);
                                    }}
                                    className="group min-w-[156px] rounded-2xl border border-dashed border-border bg-white/60 px-4 py-4 text-left hover:border-accent-primary/40 hover:bg-white"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface-secondary text-text-secondary">
                                            <FolderPlus className="h-4.5 w-4.5" />
                                        </div>
                                        <div>
                                            <div className="text-sm font-medium text-text-primary">新建文件夹</div>
                                            <div className="mt-0.5 text-[11px] text-text-tertiary">整理内容</div>
                                        </div>
                                    </div>
                                </button>
                                {visibleFolders.map((folder) => (
                                    <button
                                        key={folder.path}
                                        type="button"
                                        onClick={() => setActiveFolder(folder.path)}
                                        className="min-w-[172px] rounded-2xl border border-border bg-white/70 px-4 py-4 text-left hover:bg-white"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="text-3xl leading-none">📁</div>
                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-medium text-text-primary">{folder.name}</div>
                                                <div className="mt-0.5 text-[11px] text-text-tertiary">点击进入</div>
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="border-b border-border/60 px-2 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {FILTER_OPTIONS.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => setFilter(item.id)}
                                    className={clsx(
                                        'rounded-full px-3.5 py-1.5 text-sm transition-colors',
                                        filter === item.id ? 'bg-text-primary text-white' : 'text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                                    )}
                                >
                                    {item.label}
                                </button>
                            ))}
                            <div className="ml-auto inline-flex rounded-xl border border-border bg-white/70 p-1">
                                <button
                                    type="button"
                                    onClick={() => setLayout('gallery')}
                                    className={clsx('rounded-lg p-2 transition-colors', layout === 'gallery' ? 'bg-background text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-primary')}
                                >
                                    <Grid2X2 className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setLayout('list')}
                                    className={clsx('rounded-lg p-2 transition-colors', layout === 'list' ? 'bg-background text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-primary')}
                                >
                                    <FolderOpen className="h-4 w-4" />
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
                                            onClick={() => setActiveFolder(folder.path)}
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
                                {activeFolder && visibleAssets.length === 0 && (filter === 'all' || filter === 'media' || filter === 'image' || filter === 'video' || filter === 'audio') && (
                                    <div className="rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-text-tertiary">
                                        媒体素材当前仍统一展示在“全部草稿”根目录。文件夹内目前以稿件为主。
                                    </div>
                                )}
                                {contentCards.length === 0 ? (
                                    <div className="rounded-2xl border border-dashed border-border px-4 py-12 text-sm text-text-tertiary">当前没有符合筛选条件的内容。</div>
                                ) : (
                                    <div className={clsx(layout === 'gallery' ? 'grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-x-3.5 gap-y-5' : 'space-y-2')}>
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
                                                const isBusy = workingId === card.file.path;
                                                return (
                                                    <div key={card.id} className={clsx(layout === 'gallery' ? '' : 'rounded-2xl border border-border bg-white/75 px-4 py-3')}>
                                                        <button type="button" onClick={() => void openDraftEditor(card.file.path)} className={clsx(layout === 'gallery' ? 'w-full text-left' : 'flex w-full items-center gap-4 text-left')}>
                                                            <div className={clsx(layout === 'gallery' ? 'overflow-hidden rounded-[20px] border border-border bg-white/90' : 'flex-1 min-w-0')}>
                                                                {layout === 'gallery' ? (
                                                                    <>
                                                                        <div className={clsx('relative aspect-[5/6] px-4 py-4', typeTheme.tile)}>
                                                                            <div className={clsx('inline-flex h-9 w-9 items-center justify-center rounded-xl', typeTheme.iconWrap)}>
                                                                                <Icon className="h-4.5 w-4.5" />
                                                                            </div>
                                                                            <div className="mt-4 text-[10px] uppercase tracking-[0.22em] text-white/60">{resolveDraftTypeLabel(card.draftType)}</div>
                                                                            <div className="mt-2 line-clamp-2 text-lg font-semibold leading-tight">{card.title}</div>
                                                                            <div className="absolute inset-x-4 bottom-4 rounded-xl border border-white/15 bg-white/10 px-2.5 py-2 text-[11px] text-white/80 backdrop-blur-sm">
                                                                                {card.summary || '打开后继续编辑、排版或交给 AI 处理。'}
                                                                            </div>
                                                                        </div>
                                                                        <div className="space-y-1.5 px-2 pb-1 pt-2.5">
                                                                            <div className="truncate text-[13px] font-medium text-text-primary">{card.title}</div>
                                                                            <div className="flex items-center gap-2 text-[11px]">
                                                                                <span className={clsx('rounded-full px-2.5 py-1 font-medium', typeTheme.chip)}>{resolveDraftTypeLabel(card.draftType)}</span>
                                                                                <span className="text-text-tertiary">{formatDateLabel(card.updatedAt)}</span>
                                                                            </div>
                                                                        </div>
                                                                    </>
                                                                ) : (
                                                                    <div className="flex min-w-0 items-center gap-4">
                                                                        <div className={clsx('flex h-10 w-10 items-center justify-center rounded-xl', typeTheme.tile)}>
                                                                            <Icon className="h-4.5 w-4.5" />
                                                                        </div>
                                                                        <div className="min-w-0 flex-1">
                                                                            <div className="truncate text-sm font-medium text-text-primary">{card.title}</div>
                                                                            <div className="mt-1 truncate text-xs text-text-tertiary">{card.summary || card.file.path}</div>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </button>
                                                        <div className={clsx('mt-3 flex items-center justify-between gap-2', layout === 'gallery' ? 'px-1' : '')}>
                                                            <div className="text-xs text-text-tertiary">{card.file.path}</div>
                                                            <div className="flex items-center gap-2">
                                                                {onNavigateToRedClaw && (
                                                                    <button type="button" onClick={() => pushToRedClaw(card.file.path)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-secondary hover:text-text-primary">
                                                                        交给 RedClaw
                                                                    </button>
                                                                )}
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void handleDeleteDraft(card.file.path)}
                                                                    disabled={isBusy}
                                                                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-secondary hover:text-red-600 disabled:opacity-50"
                                                                >
                                                                    删除
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            }

                                            const asset = card.asset;
                                            const previewSrc = resolveAssetUrl(asset.previewUrl || asset.relativePath || asset.absolutePath || '');
                                            const assetKind = card.assetKind;
                                            const isBusy = workingId === asset.id;
                                            return (
                                                    <div key={card.id} className={clsx(layout === 'gallery' ? '' : 'rounded-2xl border border-border bg-white/75 px-4 py-3')}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setPreviewAsset(asset)}
                                                        className={clsx(layout === 'gallery' ? 'w-full text-left' : 'flex w-full items-center gap-4 text-left')}
                                                    >
                                                        <div className={clsx(layout === 'gallery' ? 'overflow-hidden rounded-[20px] border border-border bg-white/90' : 'flex-1 min-w-0')}>
                                                            {layout === 'gallery' ? (
                                                                <>
                                                                    <div className="aspect-[5/6] overflow-hidden bg-surface-secondary/60">
                                                                        {assetKind === 'image' ? (
                                                                            <img src={previewSrc} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                                        ) : assetKind === 'video' ? (
                                                                            <video src={previewSrc} className="h-full w-full object-cover" muted playsInline />
                                                                        ) : (
                                                                            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#10253f,#315e8f)] text-white">
                                                                                <AudioLines className="h-10 w-10" />
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="space-y-1.5 px-2 pb-1 pt-2.5">
                                                                        <div className="truncate text-[13px] font-medium text-text-primary">{card.title}</div>
                                                                        <div className="flex items-center gap-2 text-[11px]">
                                                                            <span className="rounded-full border border-border bg-white px-2.5 py-1 text-text-secondary">
                                                                                {assetKind === 'image' ? '图片' : assetKind === 'video' ? '视频' : assetKind === 'audio' ? '音频' : '资产'}
                                                                            </span>
                                                                            <span className="rounded-full border border-border bg-white px-2.5 py-1 text-text-tertiary">
                                                                                {asset.source === 'imported' ? '导入' : asset.source === 'generated' ? 'AI生成' : '计划项'}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                </>
                                                            ) : (
                                                                <div className="flex min-w-0 items-center gap-4">
                                                                    <div className="h-12 w-14 overflow-hidden rounded-xl bg-surface-secondary/60">
                                                                        {assetKind === 'image' ? (
                                                                            <img src={previewSrc} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                                        ) : assetKind === 'video' ? (
                                                                            <video src={previewSrc} className="h-full w-full object-cover" muted playsInline />
                                                                        ) : (
                                                                            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#10253f,#315e8f)] text-white">
                                                                                <AudioLines className="h-5 w-5" />
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="truncate text-sm font-medium text-text-primary">{card.title}</div>
                                                                        <div className="mt-1 truncate text-xs text-text-tertiary">{card.summary || asset.relativePath || ''}</div>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </button>
                                                    <div className={clsx('mt-3 flex items-center justify-between gap-2', layout === 'gallery' ? 'px-1' : '')}>
                                                        <div className="text-xs text-text-tertiary">{formatDateLabel(asset.updatedAt)}</div>
                                                        <div className="flex items-center gap-2">
                                                            <button type="button" onClick={() => void openAssetExternally(asset.id)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-secondary hover:text-text-primary">打开</button>
                                                            <button type="button" onClick={() => void handleDeleteAsset(asset.id)} disabled={isBusy} className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-secondary hover:text-red-600 disabled:opacity-50">删除</button>
                                                        </div>
                                                    </div>
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
                <div className="fixed inset-0 z-[1000] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4" onMouseDown={() => !isCreating && setCreateOpen(false)}>
                    <div className="w-full max-w-3xl rounded-3xl border border-border bg-background shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-5 border-b border-border/70">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">新建内容</h2>
                                <p className="mt-1 text-sm text-text-secondary">像在线 Office 一样，先选择要创建的内容类型。</p>
                            </div>
                            <button type="button" onClick={() => !isCreating && setCreateOpen(false)} className="rounded-xl p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="px-6 py-6 space-y-6">
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                                {CREATE_KIND_OPTIONS.map((option) => {
                                    const Icon = option.icon;
                                    const isActiveOption = createKind === option.id;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            onClick={() => setCreateKind(option.id)}
                                            className={clsx(
                                                'rounded-2xl border p-4 text-left transition-colors min-h-[150px]',
                                                isActiveOption
                                                    ? 'border-accent-primary bg-accent-primary/8'
                                                    : 'border-border bg-surface-secondary/20 hover:bg-surface-secondary/40'
                                            )}
                                        >
                                            <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center', isActiveOption ? 'bg-accent-primary/15 text-accent-primary' : 'bg-surface-primary text-text-secondary')}>
                                                <Icon className="w-5 h-5" />
                                            </div>
                                            <div className="mt-4 font-medium text-text-primary">{option.label}</div>
                                            <div className="mt-2 text-xs leading-5 text-text-secondary">{option.description}</div>
                                        </button>
                                    );
                                })}
                            </div>

                            {createKind === 'folder' ? (
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-text-primary">名称</label>
                                    <input
                                        autoFocus
                                        value={createTitle}
                                        onChange={(event) => setCreateTitle(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' && !isCreating) {
                                                event.preventDefault();
                                                void handleCreate();
                                            }
                                        }}
                                        placeholder="输入文件夹名称"
                                        className="w-full rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                    <p className="text-xs text-text-tertiary">当前创建位置：{activeFolder || '全部草稿 / 根目录'}</p>
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-border bg-surface-secondary/20 px-4 py-4">
                                    <div className="text-sm font-medium text-text-primary">草稿标题</div>
                                    <div className="mt-1 text-sm text-text-secondary">创建后默认标题为“未命名”，后续在稿件内部随时修改。</div>
                                    <div className="mt-2 text-xs text-text-tertiary">当前创建位置：{activeFolder || '全部草稿 / 根目录'}</div>
                                </div>
                            )}
                        </div>
                        <div className="flex items-center justify-end gap-3 px-6 py-5 border-t border-border/70 bg-surface-secondary/10 rounded-b-3xl">
                            <button type="button" onClick={() => setCreateOpen(false)} disabled={isCreating} className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-50">取消</button>
                            <button type="button" onClick={() => void handleCreate()} disabled={isCreating || (createKind === 'folder' && !createTitle.trim())} className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50">
                                {isCreating ? '创建中...' : createKind === 'folder' ? '创建文件夹' : '创建草稿'}
                            </button>
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
        </>
    );
}
