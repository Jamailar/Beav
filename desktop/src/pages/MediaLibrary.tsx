import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Link2, RefreshCw, Save, FolderOpen, ImagePlus, Sparkles, Search, SlidersHorizontal, Image, X, Clapperboard, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { GenerationIntent } from '../App';
import { resolveAssetUrl } from '../utils/pathManager';
import { formatTimestampDate, parseTimestampMs } from '../utils/time';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel } from '@/components/ui/liquid-glass-menu';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../shared/redboxVideo';
import { MediaAssetPreviewOverlay } from './media-library/MediaAssetPreviewOverlay';

type MediaAssetSource = 'generated' | 'planned' | 'imported';

interface MediaAsset {
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
}

interface MediaListResponse {
    success?: boolean;
    error?: string;
    assets?: MediaAsset[];
}

interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
}

interface AssetDraft {
    title: string;
    projectId: string;
    prompt: string;
}

interface GeneratedAsset {
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
}

interface ReferenceImageItem {
    name: string;
    dataUrl: string;
}

interface MediaAssetContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    asset: MediaAsset | null;
}

interface MediaAssetPreviewState {
    asset: MediaAsset;
    src: string;
}

interface SettingsShape {
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
}

const SOURCE_META: Record<MediaAssetSource, { label: string; badgeClass: string; chipClass: string }> = {
    generated: {
        label: '已生成',
        badgeClass: 'text-emerald-600 border-emerald-500/40 bg-emerald-500/10',
        chipClass: 'border-emerald-500/30 text-emerald-700 bg-emerald-500/10',
    },
    planned: {
        label: '计划项',
        badgeClass: 'text-amber-600 border-amber-500/40 bg-amber-500/10',
        chipClass: 'border-amber-500/30 text-amber-700 bg-amber-500/10',
    },
    imported: {
        label: '导入',
        badgeClass: 'text-blue-600 border-blue-500/40 bg-blue-500/10',
        chipClass: 'border-blue-500/30 text-blue-700 bg-blue-500/10',
    },
};

const ASPECT_RATIO_OPTIONS = [
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
    { value: 'continuation', label: '视频续写' },
] as const;

function normalizeMediaAssetSource(source: unknown): MediaAssetSource {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'generated' || normalized === 'planned' || normalized === 'imported') {
        return normalized;
    }
    return 'imported';
}

function normalizeMediaAsset(asset: MediaAsset): MediaAsset {
    return {
        ...asset,
        source: normalizeMediaAssetSource(asset.source),
    };
}

function isVideoAsset(asset: { mimeType?: string; relativePath?: string }): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)$/i.test(String(asset.relativePath || '').trim());
}

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

function flattenManuscripts(nodes: FileNode[]): string[] {
    const result: string[] = [];
    const walk = (items: FileNode[]) => {
        for (const item of items) {
            if (item.isDirectory) {
                walk(item.children || []);
                continue;
            }
            if (item.path.endsWith('.md')) {
                result.push(item.path);
            }
        }
    };
    walk(nodes);
    return result.sort((a, b) => a.localeCompare(b));
}

function getVideoReferenceModeHint(mode: 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation'): string {
    if (mode === 'reference-guided') {
        return '上传 1 到 5 张参考图，视频会尽量复用这些图中的主体元素、风格和构图线索。';
    }
    if (mode === 'first-last-frame') {
        return '请上传 2 张图片，第一张作为首帧，第二张作为尾帧。';
    }
    if (mode === 'continuation') {
        return '请上传 1 段起始视频，模型会沿着这段镜头继续生成后续内容。';
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

function toSortableTime(value?: string): number {
    return parseTimestampMs(value) ?? 0;
}

function compareMediaAssetsByCreatedAtDesc(a: MediaAsset, b: MediaAsset): number {
    const createdDelta = toSortableTime(b.createdAt) - toSortableTime(a.createdAt);
    if (createdDelta !== 0) return createdDelta;
    const updatedDelta = toSortableTime(b.updatedAt) - toSortableTime(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return b.id.localeCompare(a.id);
}

function parseAspectRatio(value?: string): number | null {
    const matched = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (!matched) return null;
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return width / height;
}

function inferMediaAspectRatio(asset: MediaAsset): number {
    const sizeMatched = String(asset.size || '').trim().match(/^(\d{2,5})x(\d{2,5})$/i);
    if (sizeMatched) {
        const width = Number(sizeMatched[1]);
        const height = Number(sizeMatched[2]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return width / height;
        }
    }
    const explicitAspectRatio = parseAspectRatio(asset.aspectRatio);
    if (explicitAspectRatio && Number.isFinite(explicitAspectRatio) && explicitAspectRatio > 0) {
        return explicitAspectRatio;
    }
    return isVideoAsset(asset) ? 16 / 9 : 3 / 4;
}

function estimateMediaCardHeight(asset: MediaAsset, columnWidth: number): number {
    const mediaAspectRatio = inferMediaAspectRatio(asset);
    const mediaHeight = columnWidth / mediaAspectRatio;
    const textBlockHeight = 152;
    const headerHeight = 52;
    return Math.round(mediaHeight + textBlockHeight + headerHeight);
}

function getMasonryColumnCount(width: number): number {
    if (width >= 1536) return 5;
    if (width >= 1280) return 4;
    if (width >= 1024) return 3;
    if (width >= 640) return 2;
    return 1;
}

export function MediaLibrary({
    isActive = true,
    onNavigateToGenerationStudio,
}: {
    isActive?: boolean;
    onNavigateToGenerationStudio?: (intent: GenerationIntent) => void;
}) {
    const [assets, setAssets] = useState<MediaAsset[]>([]);
    const [manuscripts, setManuscripts] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<'all' | MediaAssetSource>('all');
    const [projectFilter, setProjectFilter] = useState('');
    const [drafts, setDrafts] = useState<Record<string, AssetDraft>>({});
    const [bindTarget, setBindTarget] = useState<Record<string, string>>({});
    const [workingId, setWorkingId] = useState<string | null>(null);
    const [settings, setSettings] = useState<SettingsShape>({});
    const [prompt, setPrompt] = useState('');
    const [genProjectId, setGenProjectId] = useState('');
    const [genTitle, setGenTitle] = useState('');
    const [count, setCount] = useState(1);
    const [model, setModel] = useState('');
    const [aspectRatio, setAspectRatio] = useState('3:4');
    const [size, setSize] = useState('');
    const [quality, setQuality] = useState('auto');
    const [generationMode, setGenerationMode] = useState<'text-to-image' | 'reference-guided' | 'image-to-image'>('text-to-image');
    const [referenceImages, setReferenceImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
    const [isReadingRefImages, setIsReadingRefImages] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [genError, setGenError] = useState('');
    const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
    const [videoPrompt, setVideoPrompt] = useState('');
    const [videoProjectId, setVideoProjectId] = useState('');
    const [videoTitle, setVideoTitle] = useState('');
    const [videoGenerationMode, setVideoGenerationMode] = useState<'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation'>('text-to-video');
    const [videoReferenceImages, setVideoReferenceImages] = useState<Array<ReferenceImageItem | null>>([]);
    const [videoPrimaryReferenceImage, setVideoPrimaryReferenceImage] = useState<ReferenceImageItem | null>(null);
    const [videoLastFrameImage, setVideoLastFrameImage] = useState<ReferenceImageItem | null>(null);
    const [videoFirstClip, setVideoFirstClip] = useState<ReferenceImageItem | null>(null);
    const [videoDrivingAudio, setVideoDrivingAudio] = useState<ReferenceImageItem | null>(null);
    const [isReadingVideoRefImages, setIsReadingVideoRefImages] = useState(false);
    const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16'>('16:9');
    const [videoResolution, setVideoResolution] = useState<'720p' | '1080p'>('720p');
    const [videoDurationSeconds, setVideoDurationSeconds] = useState(8);
    const [videoGenerateAudio, setVideoGenerateAudio] = useState(false);
    const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
    const [videoGenError, setVideoGenError] = useState('');
    const [generatedVideoAssets, setGeneratedVideoAssets] = useState<GeneratedAsset[]>([]);
    const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<MediaAssetContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        asset: null,
    });
    const [previewAsset, setPreviewAsset] = useState<MediaAssetPreviewState | null>(null);
    const [isImageModalOpen, setIsImageModalOpen] = useState(false);
    const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
    const [masonryColumnCount, setMasonryColumnCount] = useState(() => getMasonryColumnCount(typeof window === 'undefined' ? 1440 : window.innerWidth));
    const [measuredCardHeights, setMeasuredCardHeights] = useState<Record<string, number>>({});
    const hasLoadedSnapshotRef = useRef(false);
    const loadDataRequestRef = useRef(0);
    const loadSettingsRequestRef = useRef(0);
    const assetCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const loadData = useCallback(async () => {
        const requestId = loadDataRequestRef.current + 1;
        loadDataRequestRef.current = requestId;
        if (!hasLoadedSnapshotRef.current) {
            setLoading(true);
        }
        setError('');
        try {
            const [mediaResult, tree] = await Promise.all([
                window.ipcRenderer.invoke('media:list', { limit: 500 }) as Promise<MediaListResponse>,
                window.ipcRenderer.invoke('manuscripts:list') as Promise<FileNode[]>,
            ]);
            if (requestId !== loadDataRequestRef.current) return;

            if (!mediaResult?.success) {
                setError(mediaResult?.error || '加载媒体库失败');
            } else {
                const nextAssets = (Array.isArray(mediaResult.assets) ? mediaResult.assets : [])
                    .map(normalizeMediaAsset)
                    .sort(compareMediaAssetsByCreatedAtDesc);
                setAssets(nextAssets);
                setDrafts((prev) => Object.fromEntries(
                    Object.entries(prev).filter(([assetId]) => nextAssets.some((asset) => asset.id === assetId))
                ));
                setBindTarget((prev) => Object.fromEntries(
                    Object.entries(prev).filter(([assetId]) => nextAssets.some((asset) => asset.id === assetId))
                ));
                setExpandedAssetId((prev) => (
                    prev && nextAssets.some((asset) => asset.id === prev) ? prev : null
                ));
                hasLoadedSnapshotRef.current = true;
            }
            setManuscripts(flattenManuscripts(Array.isArray(tree) ? tree : []));
        } catch (e) {
            if (requestId !== loadDataRequestRef.current) return;
            console.error('Failed to load media library:', e);
            setError('加载媒体库失败');
        } finally {
            if (requestId === loadDataRequestRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void loadData();
    }, [isActive, loadData]);

    const loadSettings = useCallback(async () => {
        const requestId = loadSettingsRequestRef.current + 1;
        loadSettingsRequestRef.current = requestId;
        try {
            const s = await window.ipcRenderer.getSettings();
            if (requestId !== loadSettingsRequestRef.current) return;
            const next = (s || {}) as SettingsShape;
            setSettings(next);
            setModel(next.image_model || 'gpt-image-1');
            setAspectRatio(next.image_aspect_ratio || '3:4');
            setSize(next.image_size || '');
            setQuality(next.image_quality || 'auto');
        } catch (e) {
            if (requestId !== loadSettingsRequestRef.current) return;
            console.error('Failed to load image settings:', e);
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void loadSettings();
    }, [isActive, loadSettings]);

    useEffect(() => {
        const updateColumnCount = () => {
            setMasonryColumnCount(getMasonryColumnCount(window.innerWidth));
        };
        updateColumnCount();
        window.addEventListener('resize', updateColumnCount);
        return () => window.removeEventListener('resize', updateColumnCount);
    }, []);

    useEffect(() => {
        if (!contextMenu.visible) return;
        const close = () => setContextMenu((prev) => ({ ...prev, visible: false, asset: null }));
        window.addEventListener('click', close);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [contextMenu.visible]);

    useEffect(() => {
        if (!previewAsset) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setPreviewAsset(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewAsset]);

    useEffect(() => {
        if (!size) return;
        const sizeAspect = inferImageAspectFromSize(size);
        if (sizeAspect && aspectRatio && aspectRatio !== 'auto' && sizeAspect !== aspectRatio) {
            setSize('');
        }
    }, [aspectRatio, size]);

    const filteredAssets = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return assets.filter((asset) => {
            if (sourceFilter !== 'all' && asset.source !== sourceFilter) return false;
            if (projectFilter.trim() && (asset.projectId || '') !== projectFilter.trim()) return false;
            if (!keyword) return true;
            const text = [
                asset.title || '',
                asset.prompt || '',
                asset.projectId || '',
                asset.boundManuscriptPath || '',
                asset.id,
            ].join('\n').toLowerCase();
            return text.includes(keyword);
        }).sort(compareMediaAssetsByCreatedAtDesc);
    }, [assets, projectFilter, query, sourceFilter]);

    const measureAssetCard = useCallback((assetId: string) => {
        const node = assetCardRefs.current[assetId];
        if (!node) return;
        const nextHeight = Math.round(node.getBoundingClientRect().height);
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
        setMeasuredCardHeights((prev) => {
            if (prev[assetId] === nextHeight) return prev;
            return {
                ...prev,
                [assetId]: nextHeight,
            };
        });
    }, []);

    useEffect(() => {
        setMeasuredCardHeights((prev) => Object.fromEntries(
            Object.entries(prev).filter(([assetId]) => filteredAssets.some((asset) => asset.id === assetId))
        ));
    }, [filteredAssets]);

    useEffect(() => {
        if (filteredAssets.length === 0) return;
        const frame = window.requestAnimationFrame(() => {
            for (const asset of filteredAssets) {
                measureAssetCard(asset.id);
            }
        });
        return () => window.cancelAnimationFrame(frame);
    }, [filteredAssets, masonryColumnCount, measureAssetCard]);

    const masonryColumns = useMemo(() => {
        const columns = Array.from({ length: masonryColumnCount }, () => [] as MediaAsset[]);
        const columnHeights = Array.from({ length: masonryColumnCount }, () => 0);
        const horizontalGap = 16;
        const shellWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
        const contentWidth = Math.max(320, shellWidth - 48);
        const columnWidth = Math.max(220, (contentWidth - horizontalGap * (masonryColumnCount - 1)) / masonryColumnCount);

        for (const asset of filteredAssets) {
            let targetColumnIndex = 0;
            for (let index = 1; index < columnHeights.length; index += 1) {
                if (columnHeights[index] < columnHeights[targetColumnIndex]) {
                    targetColumnIndex = index;
                }
            }
            columns[targetColumnIndex].push(asset);
            columnHeights[targetColumnIndex] += (measuredCardHeights[asset.id] ?? estimateMediaCardHeight(asset, columnWidth)) + 16;
        }
        return columns;
    }, [filteredAssets, masonryColumnCount, measuredCardHeights]);

    const sourceStats = useMemo(() => {
        return assets.reduce<Record<'all' | MediaAssetSource, number>>((acc, asset) => {
            acc.all += 1;
            acc[asset.source] += 1;
            return acc;
        }, {
            all: 0,
            generated: 0,
            planned: 0,
            imported: 0,
        });
    }, [assets]);

    const getDraft = useCallback((asset: MediaAsset): AssetDraft => {
        const existing = drafts[asset.id];
        if (existing) return existing;
        return {
            title: asset.title || '',
            projectId: asset.projectId || '',
            prompt: asset.prompt || '',
        };
    }, [drafts]);

    const updateDraft = useCallback((assetId: string, patch: Partial<AssetDraft>) => {
        setDrafts((prev) => {
            const current = prev[assetId] || { title: '', projectId: '', prompt: '' };
            return {
                ...prev,
                [assetId]: { ...current, ...patch },
            };
        });
    }, []);

    const handleSaveMetadata = useCallback(async (asset: MediaAsset) => {
        const draft = getDraft(asset);
        setWorkingId(asset.id);
        try {
            const result = await window.ipcRenderer.invoke('media:update', {
                assetId: asset.id,
                title: draft.title,
                projectId: draft.projectId,
                prompt: draft.prompt,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '更新失败');
                return;
            }
            await loadData();
        } catch (e) {
            console.error('Failed to update media metadata:', e);
            void appAlert('更新失败');
        } finally {
            setWorkingId(null);
        }
    }, [getDraft, loadData]);

    const handleBind = useCallback(async (asset: MediaAsset) => {
        const manuscriptPath = bindTarget[asset.id] || asset.boundManuscriptPath || '';
        if (!manuscriptPath) {
            void appAlert('请选择要绑定的稿件');
            return;
        }
        setWorkingId(asset.id);
        try {
            const result = await window.ipcRenderer.invoke('media:bind', {
                assetId: asset.id,
                manuscriptPath,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '绑定失败');
                return;
            }
            await loadData();
        } catch (e) {
            console.error('Failed to bind media asset:', e);
            void appAlert('绑定失败');
        } finally {
            setWorkingId(null);
        }
    }, [bindTarget, loadData]);

    const handleDeleteAsset = useCallback(async (asset: MediaAsset) => {
        const label = asset.title || asset.id;
        const confirmed = await appConfirm(`确认删除媒体“${label}”？${asset.relativePath ? '\n对应文件也会一并删除。' : ''}`, {
            title: '删除媒体',
            confirmLabel: '删除',
            tone: 'danger',
        });
        if (!confirmed) return;
        setWorkingId(asset.id);
        try {
            const result = await window.ipcRenderer.invoke('media:delete', {
                assetId: asset.id,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '删除失败');
                return;
            }
            setDrafts((prev) => {
                const next = { ...prev };
                delete next[asset.id];
                return next;
            });
            setBindTarget((prev) => {
                const next = { ...prev };
                delete next[asset.id];
                return next;
            });
            setExpandedAssetId((prev) => prev === asset.id ? null : prev);
            await loadData();
        } catch (e) {
            console.error('Failed to delete media asset:', e);
            void appAlert('删除失败');
        } finally {
            setWorkingId(null);
        }
    }, [loadData]);

    const openAssetContextMenu = useCallback((event: React.MouseEvent, asset: MediaAsset) => {
        event.preventDefault();
        setContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            asset,
        });
    }, []);

    const openAssetPreview = useCallback((asset: MediaAsset) => {
        const src = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
        if (!src || !asset.exists) return;
        setPreviewAsset({ asset, src });
    }, []);

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
            const effectiveMode = referenceImages.length > 0
                ? generationMode
                : 'text-to-image';
            const result = await window.ipcRenderer.invoke('image-gen:generate', {
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
            }) as { success?: boolean; error?: string; assets?: GeneratedAsset[] };

            if (!result?.success) {
                setGenError(result?.error || '生图失败');
                return;
            }
            setGeneratedAssets(Array.isArray(result.assets) ? result.assets : []);
            await loadData();
        } catch (e) {
            console.error('Failed to generate images:', e);
            setGenError('生图失败');
        } finally {
            setIsGenerating(false);
        }
    }, [aspectRatio, count, genProjectId, genTitle, generationMode, loadData, model, prompt, quality, referenceImages, settings.image_provider, settings.image_provider_template, size]);

    const handleReferenceFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>, targetIndex: number) => {
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
        const effectiveGenerationMode = videoGenerationMode === 'continuation'
            ? 'continuation'
            : effectiveVideoReferenceImages.length > 0
                ? videoGenerationMode
                : 'text-to-video';
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
        if (videoGenerationMode === 'continuation' && !videoFirstClip?.dataUrl) {
            setVideoGenError('视频续写模式需要 1 段起始视频');
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
                generationMode: effectiveGenerationMode,
                referenceImages: effectiveVideoReferenceImages.map((item) => item.dataUrl),
                firstClip: videoFirstClip?.dataUrl || undefined,
                drivingAudio: videoDrivingAudio?.dataUrl || undefined,
                aspectRatio: videoAspectRatio,
                resolution: videoResolution,
                durationSeconds: videoDurationSeconds,
                count: 1,
                generateAudio: videoGenerateAudio,
            }) as { success?: boolean; error?: string; assets?: GeneratedAsset[] };

            if (!result?.success) {
                setVideoGenError(result?.error || '生视频失败');
                return;
            }
            setGeneratedVideoAssets(Array.isArray(result.assets) ? result.assets : []);
            await loadData();
        } catch (e) {
            console.error('Failed to generate videos:', e);
            setVideoGenError('生视频失败');
        } finally {
            setIsGeneratingVideo(false);
        }
    }, [
        hasVideoConfig,
        loadData,
        videoGenerationMode,
        videoAspectRatio,
        videoDurationSeconds,
        effectiveVideoModel,
        videoDrivingAudio,
        videoFirstClip,
        videoGenerateAudio,
        videoLastFrameImage,
        videoPrimaryReferenceImage,
        videoReferenceImages,
        videoProjectId,
        videoPrompt,
        videoResolution,
        videoTitle,
    ]);
    const handleVideoReferenceFile = useCallback(async (
        event: React.ChangeEvent<HTMLInputElement>,
        target: 'primary' | 'last' | number
    ) => {
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

    const handleVideoMediaFile = useCallback(async (
        event: React.ChangeEvent<HTMLInputElement>,
        target: 'firstClip' | 'drivingAudio'
    ) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingVideoRefImages(true);
        try {
            const item = {
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            };
            if (target === 'firstClip') {
                setVideoFirstClip(item);
            } else {
                setVideoDrivingAudio(item);
            }
        } catch (uploadError) {
            console.error('Failed to parse video media file:', uploadError);
            setVideoGenError(target === 'firstClip' ? '起始视频读取失败，请重试' : '驱动音频读取失败，请重试');
        } finally {
            setIsReadingVideoRefImages(false);
            event.target.value = '';
        }
    }, []);

    return (
        <div className="h-full flex flex-col bg-background">
            <div className="border-b border-border px-4 py-2 bg-surface-secondary/45">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-md bg-accent-primary/15 border border-accent-primary/20 text-accent-primary flex items-center justify-center shrink-0">
                        <Image className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-base leading-none font-semibold text-text-primary">媒体库画廊</h1>
                        <div className="text-[11px] mt-0.5 text-text-tertiary truncate">管理 AI 生成图、计划图并快速绑定稿件</div>
                    </div>

                    <div className="hidden xl:flex items-center gap-1.5 min-w-0 ml-2">
                        <span className="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface-primary/70 text-text-secondary whitespace-nowrap">
                            总资产 {sourceStats.all}
                        </span>
                        <span className={clsx('text-[10px] px-2 py-0.5 rounded-md border whitespace-nowrap', SOURCE_META.generated.chipClass)}>
                            已生成 {sourceStats.generated}
                        </span>
                        <span className={clsx('text-[10px] px-2 py-0.5 rounded-md border whitespace-nowrap', SOURCE_META.planned.chipClass)}>
                            计划项 {sourceStats.planned}
                        </span>
                        <span className={clsx('text-[10px] px-2 py-0.5 rounded-md border whitespace-nowrap', SOURCE_META.imported.chipClass)}>
                            导入 {sourceStats.imported}
                        </span>
                    </div>

                    <div className="ml-auto flex items-center gap-1.5">
                        <button
                            onClick={() => onNavigateToGenerationStudio?.({
                                mode: 'image',
                                source: 'media-library',
                                sourceTitle: '媒体库画廊',
                            })}
                            className="h-7 px-2.5 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                        >
                            <span className="inline-flex items-center gap-1">
                                <ImagePlus className="w-3.5 h-3.5" />
                                生图
                            </span>
                        </button>
                        <button
                            onClick={() => onNavigateToGenerationStudio?.({
                                mode: 'video',
                                source: 'media-library',
                                sourceTitle: '媒体库画廊',
                            })}
                            className="h-7 px-2.5 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                        >
                            <span className="inline-flex items-center gap-1">
                                <Clapperboard className="w-3.5 h-3.5" />
                                生视频
                            </span>
                        </button>
                        <button
                            onClick={() => void window.ipcRenderer.invoke('media:open-root')}
                            className="h-7 px-2.5 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                        >
                            <span className="inline-flex items-center gap-1">
                                <FolderOpen className="w-3.5 h-3.5" />
                                打开目录
                            </span>
                        </button>
                        <button
                            onClick={() => void loadData()}
                            className="h-7 px-2.5 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                        >
                            <span className="inline-flex items-center gap-1">
                                <RefreshCw className="w-3.5 h-3.5" />
                                刷新
                            </span>
                        </button>
                    </div>
                </div>
            </div>

            <div className="px-6 py-3 border-b border-border bg-surface-secondary/20 space-y-3">
                <div className="flex flex-col lg:flex-row lg:items-center gap-2">
                    <div className="relative flex-1 min-w-0">
                        <Search className="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="搜索标题、提示词、项目ID、稿件路径"
                            className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                    </div>
                    <input
                        value={projectFilter}
                        onChange={(event) => setProjectFilter(event.target.value)}
                        placeholder="按项目ID过滤"
                        className="w-full lg:w-52 px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                    />
                    <select
                        value={sourceFilter}
                        onChange={(event) => setSourceFilter(event.target.value as 'all' | MediaAssetSource)}
                        className="w-full lg:w-40 px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none"
                    >
                        <option value="all">全部来源</option>
                        <option value="generated">已生成</option>
                        <option value="planned">计划项</option>
                        <option value="imported">导入</option>
                    </select>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary px-2 py-1 rounded-md border border-border bg-surface-primary/70">
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        快速筛选
                    </span>
                    {(['all', 'generated', 'planned', 'imported'] as const).map((filterKey) => {
                        const active = sourceFilter === filterKey;
                        const countValue = sourceStats[filterKey];
                        const label = filterKey === 'all' ? '全部来源' : SOURCE_META[filterKey].label;
                        return (
                            <button
                                key={filterKey}
                                onClick={() => setSourceFilter(filterKey)}
                                className={clsx(
                                    'text-[11px] px-2.5 py-1 rounded-md border transition-colors',
                                    active
                                        ? (filterKey === 'all' ? 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary' : SOURCE_META[filterKey].chipClass)
                                        : 'border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary'
                                )}
                            >
                                {label} · {countValue}
                            </button>
                        );
                    })}
                    <div className="ml-auto text-[11px] text-text-tertiary">
                        当前结果 {filteredAssets.length}
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
                {loading && filteredAssets.length === 0 && assets.length === 0 ? (
                    <div className="text-sm text-text-tertiary">正在加载媒体库...</div>
                ) : error ? (
                    <div className="text-sm text-status-error">{error}</div>
                ) : filteredAssets.length === 0 ? (
                    <div className="text-sm text-text-tertiary">暂无媒体资产</div>
                ) : (
                    <div className="flex items-start gap-4">
                        {masonryColumns.map((columnAssets, columnIndex) => (
                            <div key={`media-masonry-column-${columnIndex}`} className="min-w-0 flex-1 space-y-4">
                                {columnAssets.map((asset) => {
                                    const draft = getDraft(asset);
                                    const sourceMeta = SOURCE_META[asset.source] ?? SOURCE_META.imported;
                                    return (
                                        <div
                                            key={asset.id}
                                            ref={(node) => {
                                                assetCardRefs.current[asset.id] = node;
                                                if (node) {
                                                    window.requestAnimationFrame(() => measureAssetCard(asset.id));
                                                }
                                            }}
                                            onClick={() => openAssetPreview(asset)}
                                            onContextMenu={(event) => openAssetContextMenu(event, asset)}
                                            className="group block w-full cursor-pointer overflow-hidden rounded-2xl border border-border bg-surface-primary text-left shadow-sm transition-shadow hover:shadow-md"
                                        >
                                            <div className="px-3 pt-3 pb-2 flex items-start justify-between gap-2">
                                                <span className={clsx('text-[10px] px-2 py-0.5 rounded-md border', sourceMeta.badgeClass)}>
                                                    {sourceMeta.label}
                                                </span>
                                                <span className="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface-secondary/70 text-text-secondary">
                                                    {formatTimestampDate(asset.createdAt)}
                                                </span>
                                            </div>

                                            <div className="bg-surface-secondary">
                                                {asset.previewUrl && asset.exists ? (
                                                    isVideoAsset(asset) ? (
                                                        <video
                                                            src={resolveAssetUrl(asset.previewUrl)}
                                                            className="block w-full h-auto bg-black"
                                                            controls
                                                            preload="metadata"
                                                            onClick={(event) => event.stopPropagation()}
                                                            onLoadedMetadata={() => measureAssetCard(asset.id)}
                                                        />
                                                    ) : (
                                                        <img
                                                            src={resolveAssetUrl(asset.previewUrl)}
                                                            alt={asset.title || asset.id}
                                                            className="block w-full h-auto"
                                                            onLoad={() => measureAssetCard(asset.id)}
                                                        />
                                                    )
                                                ) : (
                                                    <div className="min-h-[220px] w-full bg-surface-secondary flex items-center justify-center text-text-tertiary text-xs px-4 text-center">
                                                        {asset.source === 'planned' ? '计划素材（尚未生成）' : (isVideoAsset(asset) ? '视频文件不可用' : '图片文件不可用')}
                                                    </div>
                                                )}
                                            </div>

                                            <div className="p-3 space-y-2">
                                                <div>
                                                    <div className="text-sm font-medium text-text-primary break-words">{draft.title || asset.title || asset.id}</div>
                                                    <div className="text-[11px] text-text-tertiary truncate">
                                                        {draft.projectId || asset.projectId || '未设置项目ID'} · {asset.aspectRatio || asset.size || 'auto'}
                                                    </div>
                                                </div>
                                                <div className="text-[11px] text-text-tertiary truncate">
                                                    提示词：{(draft.prompt || asset.prompt || '暂无提示词').replace(/\s+/g, ' ')}
                                                </div>
                                                <div className="text-[11px] text-text-tertiary truncate">
                                                    稿件：{asset.boundManuscriptPath || '(未绑定)'}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {contextMenu.visible && contextMenu.asset && (
                <LiquidGlassMenuPanel
                    className="fixed z-50 min-w-[148px]"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            setExpandedAssetId(contextMenu.asset!.id);
                            setContextMenu({ visible: false, x: 0, y: 0, asset: null });
                        }}
                        className={getLiquidGlassMenuItemClassName()}
                    >
                        编辑
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const asset = contextMenu.asset;
                            setContextMenu({ visible: false, x: 0, y: 0, asset: null });
                            if (asset) {
                                void handleDeleteAsset(asset);
                            }
                        }}
                        className={getLiquidGlassMenuItemClassName({ destructive: true })}
                    >
                        删除
                    </button>
                </LiquidGlassMenuPanel>
            )}
            <MediaAssetPreviewOverlay preview={previewAsset} onClose={() => setPreviewAsset(null)} />
            {expandedAssetId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-2xl rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        {(() => {
                            const asset = assets.find((item) => item.id === expandedAssetId);
                            if (!asset) return null;
                            const draft = getDraft(asset);
                            const selectedManuscript = bindTarget[asset.id] || asset.boundManuscriptPath || '';
                            const busy = workingId === asset.id;
                            return (
                                <>
                                    <div className="flex items-center gap-2 border-b border-border px-5 py-4">
                                        <div className="text-sm font-medium text-text-primary truncate">编辑素材</div>
                                        <button
                                            type="button"
                                            onClick={() => setExpandedAssetId(null)}
                                            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-surface-secondary"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <div className="p-5 space-y-3">
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                            <input
                                                value={draft.title}
                                                onChange={(event) => updateDraft(asset.id, { title: event.target.value })}
                                                placeholder="标题"
                                                className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                            />
                                            <input
                                                value={draft.projectId}
                                                onChange={(event) => updateDraft(asset.id, { projectId: event.target.value })}
                                                placeholder="项目ID"
                                                className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                            />
                                        </div>
                                        <textarea
                                            value={draft.prompt}
                                            onChange={(event) => updateDraft(asset.id, { prompt: event.target.value })}
                                            placeholder="提示词"
                                            rows={4}
                                            className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        />
                                        <div className="text-[11px] text-text-tertiary break-all">
                                            {asset.relativePath || '(无文件路径)'}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={selectedManuscript}
                                                onChange={(event) => setBindTarget((prev) => ({ ...prev, [asset.id]: event.target.value }))}
                                                className="flex-1 min-w-0 px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                            >
                                                <option value="">选择稿件绑定</option>
                                                {manuscripts.map((filePath) => (
                                                    <option key={filePath} value={filePath}>
                                                        {filePath}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                onClick={() => void handleBind(asset)}
                                                disabled={busy}
                                                className="px-3 py-2 text-sm rounded-md border border-border hover:bg-surface-secondary text-text-secondary disabled:opacity-50"
                                            >
                                                <span className="inline-flex items-center gap-1">
                                                    <Link2 className="w-4 h-4" />
                                                    绑定
                                                </span>
                                            </button>
                                        </div>
                                        <button
                                            onClick={() => void handleSaveMetadata(asset)}
                                            disabled={busy}
                                            className="w-full px-3 py-2 text-sm rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50"
                                        >
                                            <span className="inline-flex items-center gap-1">
                                                <Save className="w-4 h-4" />
                                                {busy ? '保存中...' : '保存元数据'}
                                            </span>
                                        </button>
                                    </div>
                                </>
                            );
                        })()}
                    </div>
                </div>
            )}
            {isImageModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-primary/95 px-5 py-4 backdrop-blur">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                <ImagePlus className="w-4 h-4 text-accent-primary" />
                                在媒体库内生图
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
                                    {ASPECT_RATIO_OPTIONS.map((option) => (
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

            {isVideoModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-2xl border border-border bg-surface-primary shadow-2xl">
                        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-primary/95 px-5 py-4 backdrop-blur">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                <Clapperboard className="w-4 h-4 text-accent-primary" />
                                在媒体库内生视频
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
                                        onChange={(event) => setVideoGenerationMode(event.target.value as 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation')}
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

                                {videoGenerationMode === 'continuation' && (
                                    <label className="group relative flex aspect-video max-w-[320px] cursor-pointer overflow-hidden rounded-xl border border-dashed border-border bg-surface-secondary/20 hover:border-accent-primary/40 hover:bg-surface-secondary/40">
                                        {videoFirstClip ? (
                                            <div className="flex h-full w-full items-end bg-gradient-to-br from-surface-secondary to-surface-primary p-4 text-text-primary">
                                                <div className="space-y-1">
                                                    <div className="text-xs text-text-tertiary">起始视频</div>
                                                    <div className="text-sm font-medium truncate">{videoFirstClip.name}</div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-tertiary">
                                                <Clapperboard className="h-5 w-5" />
                                                <div className="text-xs">上传起始视频</div>
                                                <div className="text-[11px]">支持 mp4 / mov / webm</div>
                                            </div>
                                        )}
                                        <div className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white">起始视频</div>
                                        {videoFirstClip && (
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    setVideoFirstClip(null);
                                                }}
                                                className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                        <input
                                            type="file"
                                            accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                                            className="hidden"
                                            onChange={(event) => void handleVideoMediaFile(event, 'firstClip')}
                                        />
                                    </label>
                                )}

                                <label className="group relative flex aspect-[3/1] max-w-[320px] cursor-pointer overflow-hidden rounded-xl border border-dashed border-border bg-surface-secondary/20 hover:border-accent-primary/40 hover:bg-surface-secondary/40">
                                    {videoDrivingAudio ? (
                                        <div className="flex h-full w-full items-end bg-gradient-to-br from-surface-secondary to-surface-primary p-4 text-text-primary">
                                            <div className="space-y-1">
                                                <div className="text-xs text-text-tertiary">驱动音频（可选）</div>
                                                <div className="text-sm font-medium truncate">{videoDrivingAudio.name}</div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-tertiary">
                                            <FolderOpen className="h-5 w-5" />
                                            <div className="text-xs">上传驱动音频</div>
                                            <div className="text-[11px]">可选，用于人物口播/声音参考</div>
                                        </div>
                                    )}
                                    <div className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white">驱动音频</div>
                                    {videoDrivingAudio && (
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                setVideoDrivingAudio(null);
                                            }}
                                            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    )}
                                    <input
                                        type="file"
                                        accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
                                        className="hidden"
                                        onChange={(event) => void handleVideoMediaFile(event, 'drivingAudio')}
                                    />
                                </label>

                                <div className="text-[11px] text-text-tertiary">
                                    {isReadingVideoRefImages ? '正在读取参考图...' : getVideoReferenceModeHint(videoGenerationMode)}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                <input value={videoTitle} onChange={(event) => setVideoTitle(event.target.value)} placeholder="视频标题（可选）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
                                <input value={videoProjectId} onChange={(event) => setVideoProjectId(event.target.value)} placeholder="项目ID（可选）" className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary" />
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
                                <label className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 text-text-secondary inline-flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={videoGenerateAudio}
                                        onChange={(event) => setVideoGenerateAudio(event.target.checked)}
                                    />
                                    让模型尝试生成音频
                                </label>
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
                                    <div className="text-sm font-medium text-text-primary">
                                        视频生成中，请等待
                                    </div>
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

        </div>
    );
}
