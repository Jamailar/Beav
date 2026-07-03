import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import clsx from 'clsx';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { buildAudioDataUrl } from '../features/audio-input/audioInput';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { uiDebug, uiMeasure } from '../utils/uiDebug';
import {
    ArrowLeft,
    Box,
    Building2,
    CalendarClock,
    Clapperboard,
    FolderOpen,
    Grid2X2,
    Image as ImageIcon,
    ImagePlus,
    List as ListIcon,
    Mic,
    Music2,
    Package,
    Pencil,
    Plus,
    RefreshCw,
    Save,
    Search,
    Sparkles,
    Tag,
    Trash2,
    UserRound,
    X,
} from 'lucide-react';
import { resolveAssetUrl } from '../utils/pathManager';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel } from '@/components/ui/liquid-glass-menu';

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

type MediaAssetSource = 'generated' | 'planned' | 'imported';

interface MediaAsset {
    id: string;
    source?: MediaAssetSource | string;
    projectId?: string;
    title?: string;
    prompt?: string;
    provider?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
    mimeType?: string;
    relativePath?: string;
    boundManuscriptPath?: string;
    absolutePath?: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    thumbnail_url?: string;
    createdAt?: string;
    updatedAt?: string;
    exists?: boolean;
}

interface MediaListResponse {
    success?: boolean;
    error?: string;
    assets?: MediaAsset[];
    total?: number;
    nextCursor?: string | null;
    hasMore?: boolean;
}

interface MediaAssetContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    asset: MediaAsset | null;
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
type AssetLibraryTab = 'media' | 'assets';
type SubjectViewMode = 'grid' | 'list';

const UNCATEGORIZED_FILTER = '__uncategorized__';
const DEFAULT_SUBJECT_CATEGORY_NAMES = ['品牌', '角色', '物品', '商品', '场景'];
const VISIBLE_SUBJECT_CATEGORY_NAMES = DEFAULT_SUBJECT_CATEGORY_NAMES.filter((name) => name !== '商品');
const HIDDEN_SUBJECT_CATEGORY_NAMES = new Set(['商品', '人物']);
const SUBJECT_VOICE_SAMPLE_TEXT = '君不见黄河之水天上来，奔流到海不复回。';
const SUBJECT_VOICE_RECORDING_SECONDS = 6;

const MEDIA_SOURCE_LABELS: Record<MediaAssetSource, string> = {
    generated: '生成',
    planned: '计划',
    imported: '导入',
};

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

function normalizeMediaAssetSource(source: unknown): MediaAssetSource {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'generated' || normalized === 'planned' || normalized === 'imported') {
        return normalized;
    }
    return 'imported';
}

function normalizeMediaAsset(asset: MediaAsset): MediaAsset {
    const legacyAsset = asset as MediaAsset & {
        project_id?: string;
        mime_type?: string;
        relative_path?: string;
        bound_manuscript_path?: string;
        absolute_path?: string;
        preview_url?: string;
        thumbnail_url?: string;
        aspect_ratio?: string;
    };
    return {
        ...asset,
        source: normalizeMediaAssetSource(asset.source),
        projectId: asset.projectId || legacyAsset.project_id,
        mimeType: asset.mimeType || legacyAsset.mime_type,
        relativePath: asset.relativePath || legacyAsset.relative_path,
        boundManuscriptPath: asset.boundManuscriptPath || legacyAsset.bound_manuscript_path,
        absolutePath: asset.absolutePath || legacyAsset.absolute_path,
        previewUrl: asset.previewUrl || legacyAsset.preview_url,
        thumbnailUrl: asset.thumbnailUrl || legacyAsset.thumbnail_url,
        aspectRatio: asset.aspectRatio || legacyAsset.aspect_ratio,
        exists: asset.exists !== false,
    };
}

function mediaAssetSourceUrl(asset: MediaAsset): string {
    return asset.previewUrl || asset.absolutePath || asset.relativePath || '';
}

function mediaAssetPreviewUrl(asset: MediaAsset): string {
    return asset.previewUrl || asset.thumbnailUrl || asset.absolutePath || asset.relativePath || '';
}

function isVideoAsset(asset: MediaAsset): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(mediaAssetSourceUrl(asset));
}

function isAudioAsset(asset: MediaAsset): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return true;
    return /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)(?:[?#].*)?$/i.test(mediaAssetSourceUrl(asset));
}

function formatMediaAssetDate(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function categoryIconForName(name: string) {
    const normalized = String(name || '').trim();
    if (normalized === '角色' || normalized === '人物') return UserRound;
    if (normalized === '品牌') return Building2;
    if (normalized === '商品') return Package;
    if (normalized === '场景') return Box;
    return Tag;
}

function isRoleCategoryName(name: string): boolean {
    const normalized = String(name || '').trim();
    return normalized === '角色' || normalized === '人物';
}

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
        voice: undefined,
        video: undefined,
    };
}

function MediaAssetPreviewDialog({
    asset,
    onClose,
    onOpenFile,
    onShowInFolder,
    onDelete,
}: {
    asset: MediaAsset;
    onClose: () => void;
    onOpenFile: (asset: MediaAsset) => void;
    onShowInFolder: (asset: MediaAsset) => void;
    onDelete: (asset: MediaAsset) => void;
}) {
    const source = normalizeMediaAssetSource(asset.source);
    const sourceUrl = mediaAssetSourceUrl(asset);
    const previewUrl = mediaAssetPreviewUrl(asset);
    const resolvedSourceUrl = sourceUrl ? resolveAssetUrl(sourceUrl) : '';
    const resolvedPreviewUrl = previewUrl ? resolveAssetUrl(previewUrl) : '';
    const label = String(asset.title || asset.id || '未命名素材').trim();
    const isVideo = isVideoAsset(asset);
    const isAudio = isAudioAsset(asset);

    return (
        <div
            className="fixed inset-0 z-[160] flex items-center justify-center bg-black/75 p-6"
            onMouseDown={onClose}
        >
            <div
                className="grid max-h-[86vh] w-full max-w-[1080px] grid-cols-[minmax(0,1fr)_280px] overflow-hidden rounded-2xl bg-white shadow-2xl max-[860px]:grid-cols-1"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className="flex min-h-[360px] items-center justify-center bg-black/[0.04] p-4">
                    {asset.exists === false || (!resolvedSourceUrl && !resolvedPreviewUrl) ? (
                        <div className="flex flex-col items-center gap-3 text-text-tertiary">
                            {isAudio ? <Music2 className="h-10 w-10" /> : isVideo ? <Clapperboard className="h-10 w-10" /> : <ImageIcon className="h-10 w-10" />}
                            <div className="max-w-[360px] truncate text-sm font-semibold">{label}</div>
                            {asset.exists === false && <div className="text-xs">源文件缺失</div>}
                        </div>
                    ) : isAudio && resolvedSourceUrl ? (
                        <div className="w-full max-w-[560px] rounded-xl bg-white p-5 shadow-sm">
                            <div className="mb-4 flex items-center gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
                                    <Music2 className="h-6 w-6" />
                                </div>
                                <div className="min-w-0 truncate text-sm font-semibold text-text-primary">{label}</div>
                            </div>
                            <audio src={resolvedSourceUrl} className="w-full" controls autoPlay preload="metadata" />
                        </div>
                    ) : isVideo && resolvedSourceUrl ? (
                        <video
                            src={resolvedSourceUrl}
                            className="block max-h-[78vh] max-w-full rounded-xl bg-black object-contain shadow-xl"
                            controls
                            autoPlay
                            playsInline
                            preload="metadata"
                        />
                    ) : (
                        <img
                            src={resolvedPreviewUrl}
                            alt={label}
                            className="block max-h-[78vh] max-w-full rounded-xl bg-white object-contain shadow-xl"
                        />
                    )}
                </div>
                <div className="flex min-h-0 flex-col border-l border-border bg-surface-primary max-[860px]:border-l-0 max-[860px]:border-t">
                    <div className="flex items-start justify-between gap-3 border-b border-border p-4">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-text-primary">{label}</div>
                            <div className="mt-1 text-[11px] text-text-tertiary">{MEDIA_SOURCE_LABELS[source]}</div>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
                            aria-label="关闭预览"
                            title="关闭"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px] text-text-secondary">
                        {asset.prompt && (
                            <div>
                                <div className="mb-1 font-semibold text-text-primary">提示词</div>
                                <div className="whitespace-pre-wrap leading-relaxed">{asset.prompt}</div>
                            </div>
                        )}
                        <div className="space-y-2">
                            {(asset.model || asset.provider || asset.mimeType) && (
                                <div className="break-words">
                                    <span className="font-semibold text-text-primary">来源 </span>
                                    {asset.model || asset.provider || asset.mimeType}
                                </div>
                            )}
                            {asset.createdAt && (
                                <div>
                                    <span className="font-semibold text-text-primary">创建 </span>
                                    {formatMediaAssetDate(asset.createdAt)}
                                </div>
                            )}
                            {(asset.relativePath || asset.absolutePath) && (
                                <div className="break-all text-[11px] text-text-tertiary">
                                    {asset.relativePath || asset.absolutePath}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="grid gap-2 border-t border-border p-4">
                        <button
                            type="button"
                            onClick={() => onOpenFile(asset)}
                            className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-[rgb(var(--color-text-primary))] px-3 text-sm font-semibold text-white transition hover:opacity-90"
                        >
                            打开文件
                        </button>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => onShowInFolder(asset)}
                                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface-primary px-3 text-sm font-semibold text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary"
                            >
                                <FolderOpen className="h-4 w-4" />
                                文件夹
                            </button>
                            <button
                                type="button"
                                onClick={() => onDelete(asset)}
                                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-600 transition hover:bg-red-100"
                            >
                                <Trash2 className="h-4 w-4" />
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MediaMasonryThumb({ asset }: { asset: MediaAsset }) {
    const sourceUrl = mediaAssetSourceUrl(asset);
    const previewUrl = mediaAssetPreviewUrl(asset);
    const resolvedSourceUrl = sourceUrl ? resolveAssetUrl(sourceUrl) : '';
    const resolvedPreviewUrl = previewUrl ? resolveAssetUrl(previewUrl) : '';
    const resolvedThumbnailUrl = asset.thumbnailUrl ? resolveAssetUrl(asset.thumbnailUrl) : '';
    const fallback = (
        <div className="flex aspect-square w-full items-center justify-center bg-surface-secondary/70 text-text-tertiary">
            {isAudioAsset(asset) ? <Music2 className="h-7 w-7" /> : isVideoAsset(asset) ? <Clapperboard className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
        </div>
    );

    if (asset.exists === false) return fallback;

    if (isAudioAsset(asset)) {
        return (
            <div className="flex aspect-[4/3] w-full items-center justify-center bg-surface-secondary/70 text-accent-primary">
                <Music2 className="h-7 w-7" />
            </div>
        );
    }

    if (isVideoAsset(asset)) {
        if (resolvedThumbnailUrl) {
            return <img src={resolvedThumbnailUrl} alt="" className="block h-auto w-full bg-surface-secondary" loading="lazy" />;
        }
        if (resolvedSourceUrl) {
            return <video src={resolvedSourceUrl} className="block h-auto w-full bg-black" muted playsInline preload="metadata" />;
        }
        return fallback;
    }

    const imageUrl = resolvedPreviewUrl || resolvedSourceUrl;
    if (!imageUrl) return fallback;
    return <img src={imageUrl} alt="" className="block h-auto w-full bg-surface-secondary" loading="lazy" />;
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

function normalizeAttributes(attributes: SubjectAttribute[]): SubjectAttribute[] {
    return attributes
        .map((item) => ({ key: String(item.key || '').trim(), value: String(item.value || '').trim() }))
        .filter((item) => item.key || item.value);
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
    const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
    const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
    const [isLoadingMoreMedia, setIsLoadingMoreMedia] = useState(false);
    const [previewImage, setPreviewImage] = useState<SubjectImageDraft | null>(null);
    const [previewMediaAsset, setPreviewMediaAsset] = useState<MediaAsset | null>(null);
    const [mediaContextMenu, setMediaContextMenu] = useState<MediaAssetContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        asset: null,
    });
    const [activeLibraryTab, setActiveLibraryTab] = useState<AssetLibraryTab>('media');
    const [subjectViewMode, setSubjectViewMode] = useState<SubjectViewMode>('grid');
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [generatingCardSubjectId, setGeneratingCardSubjectId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
    const [categoryDialogMode, setCategoryDialogMode] = useState<CategoryDialogMode>('create');
    const [categoryDialogName, setCategoryDialogName] = useState('');
    const [categoryDialogTargetId, setCategoryDialogTargetId] = useState<string | null>(null);
    const [isCategoryDialogSubmitting, setIsCategoryDialogSubmitting] = useState(false);
    const [draft, setDraft] = useState<SubjectDraft>(createEmptyDraft);
    const [initialVoicePresent, setInitialVoicePresent] = useState(false);
    const [initialVideoPresent, setInitialVideoPresent] = useState(false);
    const [recordingError, setRecordingError] = useState('');
    const [recordingHint, setRecordingHint] = useState('');
    const [recordingCountdown, setRecordingCountdown] = useState(0);
    const recordingIntervalRef = useRef<number | null>(null);
    const recordingTimeoutRef = useRef<number | null>(null);
    const hasLoadedSnapshotRef = useRef(false);
    const loadDataRequestRef = useRef(0);
    const deletedMediaAssetIdsRef = useRef<Set<string>>(new Set());

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
            const [categoriesResult, subjectsResult, mediaResult] = await uiMeasure('subjects', 'load_data', async () => (
                Promise.all([
                    window.ipcRenderer.subjects.categories.list(),
                    window.ipcRenderer.subjects.list({ limit: 500 }),
                    window.ipcRenderer.media.list<MediaListResponse>({ limit: 80 }),
                ])
            ), { requestId });
            if (!categoriesResult?.success) {
                throw new Error(categoriesResult?.error || '加载分类失败');
            }
            if (!subjectsResult?.success) {
                throw new Error(subjectsResult?.error || '加载资产失败');
            }
            if (requestId !== loadDataRequestRef.current) return;
            setCategories(Array.isArray(categoriesResult.categories) ? categoriesResult.categories : []);
            setSubjects(Array.isArray(subjectsResult.subjects) ? subjectsResult.subjects : []);
            setMediaAssets(
                mediaResult?.success && Array.isArray(mediaResult.assets)
                    ? mediaResult.assets
                        .map(normalizeMediaAsset)
                        .filter((asset) => !deletedMediaAssetIdsRef.current.has(asset.id))
                    : []
            );
            setMediaNextCursor(mediaResult?.success && typeof mediaResult.nextCursor === 'string' ? mediaResult.nextCursor : null);
            hasLoadedSnapshotRef.current = true;
        } catch (e) {
            if (requestId !== loadDataRequestRef.current) return;
            console.error('Failed to load subjects:', e);
            setError(e instanceof Error ? e.message : '加载资产库失败');
            if (!hasLoadedSnapshotRef.current) {
                setCategories([]);
                setSubjects([]);
                setMediaAssets([]);
            }
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

    const loadMoreMediaAssets = useCallback(async () => {
        if (!mediaNextCursor || isLoadingMoreMedia) return;
        setIsLoadingMoreMedia(true);
        setError('');
        try {
            const mediaResult = await window.ipcRenderer.media.list<MediaListResponse>({
                limit: 80,
                cursor: mediaNextCursor,
            });
            if (!mediaResult?.success) {
                throw new Error(mediaResult?.error || '加载更多媒体失败');
            }
            const nextAssets = Array.isArray(mediaResult.assets)
                ? mediaResult.assets
                    .map(normalizeMediaAsset)
                    .filter((asset) => !deletedMediaAssetIdsRef.current.has(asset.id))
                : [];
            setMediaAssets((current) => {
                const byId = new Map(current.map((asset) => [asset.id, asset]));
                for (const asset of nextAssets) {
                    byId.set(asset.id, asset);
                }
                return Array.from(byId.values());
            });
            setMediaNextCursor(typeof mediaResult.nextCursor === 'string' ? mediaResult.nextCursor : null);
        } catch (loadError) {
            console.error('Failed to load more media assets:', loadError);
            setError(loadError instanceof Error ? loadError.message : '加载更多媒体失败');
        } finally {
            setIsLoadingMoreMedia(false);
        }
    }, [isLoadingMoreMedia, mediaNextCursor]);

    useEffect(() => {
        if (!previewMediaAsset) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setPreviewMediaAsset(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewMediaAsset]);

    const categoryNameMap = useMemo(() => new Map(categories.map((item) => [item.id, item.name])), [categories]);
    const draftCategoryName = categoryNameMap.get(draft.categoryId || '') || '';
    const draftEntityLabel = draftCategoryName.trim() || '资产';
    const isRoleDraft = isRoleCategoryName(draftCategoryName);
    const isRoleSubject = useCallback((subject: SubjectRecord) => (
        isRoleCategoryName(categoryNameMap.get(subject.categoryId || '') || '')
    ), [categoryNameMap]);
    const draftAttributeValue = (key: string) => draft.attributes.find((item) => item.key === key)?.value || '';
    const visibleDraftAttributes = draft.attributes
        .map((attribute, index) => ({ attribute, index }))
        .filter(({ attribute }) => !isRoleDraft || (attribute.key !== '性别' && attribute.key !== '年龄'));
    const draftCategoryOptions = useMemo(() => categories.filter((category) => {
        const name = category.name.trim();
        return !['品牌', '商品'].includes(name) || category.id === draft.categoryId;
    }), [categories, draft.categoryId]);

    const filteredSubjects = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return subjects.filter((subject) => {
            if (categoryFilter === UNCATEGORIZED_FILTER && subject.categoryId) return false;
            if (categoryFilter !== 'all' && categoryFilter !== UNCATEGORIZED_FILTER && subject.categoryId !== categoryFilter) return false;
            if (!keyword) return true;
            const haystack = [
                subject.name,
                subject.description || '',
                subject.tags.join(' '),
                subject.attributes.map((item) => `${item.key} ${item.value}`).join(' '),
                categoryNameMap.get(subject.categoryId || '') || '',
            ].join('\n').toLowerCase();
            return haystack.includes(keyword);
        });
    }, [categoryFilter, categoryNameMap, query, subjects]);

    const filteredMediaAssets = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return mediaAssets.filter((asset) => {
            if (!keyword) return true;
            const haystack = [
                asset.title || '',
                asset.prompt || '',
                asset.projectId || '',
                asset.boundManuscriptPath || '',
                asset.relativePath || '',
                asset.absolutePath || '',
                asset.previewUrl || '',
                asset.provider || '',
                asset.model || '',
                asset.aspectRatio || '',
                asset.size || '',
                asset.quality || '',
                asset.mimeType || '',
                MEDIA_SOURCE_LABELS[normalizeMediaAssetSource(asset.source)],
            ].join('\n').toLowerCase();
            return haystack.includes(keyword);
        });
    }, [mediaAssets, query]);

    const openMediaPreview = useCallback((asset: MediaAsset) => {
        setMediaContextMenu({ visible: false, x: 0, y: 0, asset: null });
        setPreviewMediaAsset(asset);
    }, []);

    const openMediaContextMenu = useCallback((event: ReactMouseEvent, asset: MediaAsset) => {
        event.preventDefault();
        event.stopPropagation();
        setMediaContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            asset,
        });
    }, []);

    const handleOpenMediaAsset = useCallback(async (asset: MediaAsset) => {
        try {
            const result = await window.ipcRenderer.media.open<{ success?: boolean; error?: string }>({ assetId: asset.id });
            if (!result?.success) {
                void appAlert(result?.error || '打开媒体文件失败');
            }
        } catch (e) {
            console.error('Failed to open media asset:', e);
            void appAlert('打开媒体文件失败');
        }
    }, []);

    const handleShowMediaAssetInFolder = useCallback(async (asset: MediaAsset) => {
        const source = mediaAssetSourceUrl(asset);
        if (!source) {
            void appAlert('媒体资产没有可打开的文件路径');
            return;
        }
        try {
            const result = await window.ipcRenderer.files.showInFolder({ source }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '打开文件夹失败');
            }
        } catch (e) {
            console.error('Failed to show media asset in folder:', e);
            void appAlert('打开文件夹失败');
        }
    }, []);

    const handleDeleteMediaAsset = useCallback(async (asset: MediaAsset) => {
        const label = asset.title || asset.id;
        if (!(await appConfirm(`删除媒体“${label}”？`, { title: '删除媒体', confirmLabel: '删除', tone: 'danger' }))) return;
        try {
            const result = await window.ipcRenderer.media.delete<{ success?: boolean; error?: string }>({ assetId: asset.id });
            if (!result?.success) {
                void appAlert(result?.error || '删除失败');
                return;
            }
            deletedMediaAssetIdsRef.current.add(asset.id);
            setMediaAssets((current) => current.filter((item) => item.id !== asset.id));
            setPreviewMediaAsset((current) => current?.id === asset.id ? null : current);
            setMediaContextMenu((current) => current.asset?.id === asset.id ? { visible: false, x: 0, y: 0, asset: null } : current);
        } catch (e) {
            console.error('Failed to delete media asset:', e);
            void appAlert('删除失败');
        }
    }, []);

    const handleImportMediaAssets = useCallback(async () => {
        try {
            const result = await window.ipcRenderer.media.importFiles<{ success?: boolean; canceled?: boolean; error?: string }>();
            if (!result?.success) {
                void appAlert(result?.error || '导入媒体失败');
                return;
            }
            if (!result.canceled) {
                await loadData();
            }
        } catch (e) {
            console.error('Failed to import media assets:', e);
            void appAlert('导入媒体失败');
        }
    }, [loadData]);

    const categoryStats = useMemo(() => {
        const stats = new Map<string, number>();
        stats.set('all', subjects.length);
        stats.set(UNCATEGORIZED_FILTER, subjects.filter((item) => !item.categoryId).length);
        for (const category of categories) {
            stats.set(category.id, subjects.filter((item) => item.categoryId === category.id).length);
        }
        return stats;
    }, [categories, subjects]);

    const subjectCategoryTabs = useMemo(() => {
        const existingNames = new Set(categories.map((category) => category.name.trim()));
        const customCategories = categories.filter((category) => {
            const name = category.name.trim();
            return !DEFAULT_SUBJECT_CATEGORY_NAMES.includes(name) && !HIDDEN_SUBJECT_CATEGORY_NAMES.has(name);
        });
        return [
            { id: 'all', label: '全部', icon: Package, createName: '' },
            ...VISIBLE_SUBJECT_CATEGORY_NAMES.map((name) => {
                const category = categories.find((item) => item.name.trim() === name);
                return {
                    id: category?.id || `preset:${name}`,
                    label: name,
                    icon: categoryIconForName(name),
                    createName: existingNames.has(name) ? '' : name,
                };
            }),
            ...customCategories.map((category) => ({
                id: category.id,
                label: category.name,
                icon: categoryIconForName(category.name),
                createName: '',
            })),
        ];
    }, [categories]);

    const activeSubjectCategoryTab = subjectCategoryTabs.find((item) => item.id === categoryFilter) || subjectCategoryTabs[0];
    const createAssetButtonLabel = activeSubjectCategoryTab?.id && activeSubjectCategoryTab.id !== 'all'
        ? `创建${activeSubjectCategoryTab.label}`
        : '创建资产';

    const ensureSubjectCategory = useCallback(async (name: string): Promise<string> => {
        const trimmedName = name.trim();
        if (!trimmedName) return '';
        const existing = categories.find((category) => category.name.trim() === trimmedName);
        if (existing?.id) return existing.id;
        const result = await window.ipcRenderer.subjects.categories.create({ name: trimmedName });
        if (!result?.success || !result.category?.id) {
            throw new Error(result?.error || '创建分类失败');
        }
        await loadData();
        return result.category.id;
    }, [categories, loadData]);

    const selectSubjectCategoryTab = useCallback(async (item: { id: string; createName?: string }) => {
        if (item.id === 'all') {
            setCategoryFilter('all');
            return;
        }
        if (item.createName) {
            try {
                const categoryId = await ensureSubjectCategory(item.createName);
                if (categoryId) setCategoryFilter(categoryId);
            } catch (error) {
                console.error('Failed to create subject category:', error);
                void appAlert(error instanceof Error ? error.message : '创建分类失败');
            }
            return;
        }
        setCategoryFilter(item.id);
    }, [ensureSubjectCategory]);

    const openCreateModal = useCallback(() => {
        const defaultCategoryId = categoryFilter !== 'all' && categoryFilter !== UNCATEGORIZED_FILTER
            ? categoryFilter
            : '';
        setDraft({ ...createEmptyDraft(), categoryId: defaultCategoryId });
        setInitialVoicePresent(false);
        setInitialVideoPresent(false);
        setPreviewImage(null);
        setError('');
        setIsModalOpen(true);
    }, [categoryFilter]);

    const openEditModal = useCallback((subject: SubjectRecord) => {
        setDraft(toDraft(subject));
        setInitialVoicePresent(Boolean(subject.voicePreviewUrl));
        setInitialVideoPresent(Boolean(subject.videoPreviewUrl));
        setPreviewImage(null);
        setError('');
        setIsModalOpen(true);
    }, []);

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
        if (recordingTimeoutRef.current) {
            window.clearTimeout(recordingTimeoutRef.current);
            recordingTimeoutRef.current = null;
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

    const handleNamedAttributeChange = useCallback((key: string, value: string) => {
        setDraft((current) => {
            const existingIndex = current.attributes.findIndex((item) => item.key === key);
            if (!value.trim()) {
                return {
                    ...current,
                    attributes: existingIndex >= 0
                        ? current.attributes.filter((_, itemIndex) => itemIndex !== existingIndex)
                        : current.attributes,
                };
            }
            if (existingIndex >= 0) {
                return {
                    ...current,
                    attributes: current.attributes.map((item, itemIndex) => (
                        itemIndex === existingIndex ? { ...item, value } : item
                    )),
                };
            }
            return {
                ...current,
                attributes: [...current.attributes, { key, value }],
            };
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

    const handleRemoveVoice = useCallback(() => {
        setDraft((current) => ({
            ...current,
            voice: undefined,
        }));
        setRecordingError('');
        setRecordingHint('');
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

    const saveVoiceDataUrl = useCallback(async (dataUrl: string, fileName: string) => {
        const duration = await getAudioDurationSeconds(dataUrl);
        if (duration < 5 || duration > 10) {
            throw new Error('声音参考时长必须在 5 到 10 秒之间');
        }
        setDraft((current) => ({
            ...current,
            voice: {
                name: fileName,
                previewUrl: dataUrl,
                dataUrl,
                scriptText: SUBJECT_VOICE_SAMPLE_TEXT,
            },
        }));
        setRecordingHint(`已录入声音参考，时长约 ${duration.toFixed(1)} 秒`);
        setRecordingError('');
    }, []);

    const audioRecording = useAudioRecording({
        onCaptured: async (clip) => {
            if ((clip.byteLength || 0) > 10 * 1024 * 1024) {
                throw new Error('声音参考文件不能超过 10MB');
            }
            await saveVoiceDataUrl(
                buildAudioDataUrl(clip),
                clip.fileName || `voice-reference-${Date.now()}.wav`,
            );
        },
    });

    useEffect(() => {
        if (!audioRecording.error) return;
        setRecordingError(audioRecording.error);
        setRecordingHint('');
    }, [audioRecording.error]);

    useEffect(() => {
        if (audioRecording.isRecording) return;
        clearRecordingTimers();
        setRecordingCountdown(0);
    }, [audioRecording.isRecording, clearRecordingTimers]);

    const stopRecordingSession = useCallback(() => {
        clearRecordingTimers();
        setRecordingCountdown(0);
        if (audioRecording.isRecording || audioRecording.isWorking) {
            void audioRecording.cancelRecording();
        }
    }, [audioRecording, clearRecordingTimers]);

    const closeModal = useCallback(() => {
        if (working) return;
        stopRecordingSession();
        setIsModalOpen(false);
        setPreviewImage(null);
        setDraft(createEmptyDraft());
        setInitialVoicePresent(false);
        setInitialVideoPresent(false);
        setError('');
        setRecordingError('');
        setRecordingHint('');
    }, [stopRecordingSession, working]);

    useEffect(() => () => {
        stopRecordingSession();
    }, [stopRecordingSession]);

    const handleVoiceFileInput = useCallback(async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
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
        setRecordingCountdown(SUBJECT_VOICE_RECORDING_SECONDS);
        setRecordingError('');
        setRecordingHint('点击录音后，请按正常语速清晰朗读示例句。系统会自动截取这次采样。');
        const started = await audioRecording.startRecording();
        if (!started) {
            setRecordingCountdown(0);
            setRecordingHint('');
            return;
        }
        try {
            recordingIntervalRef.current = window.setInterval(() => {
                setRecordingCountdown((current) => Math.max(0, current - 1));
            }, 1000);
            recordingTimeoutRef.current = window.setTimeout(() => {
                void audioRecording.stopRecording();
            }, SUBJECT_VOICE_RECORDING_SECONDS * 1000);
        } catch (e) {
            stopRecordingSession();
            setRecordingError(e instanceof Error ? e.message : '无法启动录音');
            setRecordingHint('');
        }
    }, [audioRecording, stopRecordingSession]);

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

    const persistDraft = useCallback(async (): Promise<SubjectRecord> => {
        if (!draft.name.trim()) {
            throw new Error(`${draftEntityLabel}名称是必填项`);
        }

        const payload = {
            id: draft.id,
            name: draft.name.trim(),
            categoryId: draft.categoryId || undefined,
            description: draft.description.trim() || undefined,
            tags: draft.tagsText.split(',').map((item) => item.trim()).filter(Boolean),
            attributes: normalizeAttributes(draft.attributes),
            images: draft.images.map((image) => image.relativePath
                ? { relativePath: image.relativePath, name: image.name }
                : { dataUrl: image.dataUrl, name: image.name }),
            voice: draft.voice
                ? (draft.voice.relativePath
                    ? {
                        relativePath: draft.voice.relativePath,
                        name: draft.voice.name,
                        scriptText: draft.voice.scriptText.trim() || undefined,
                    }
                    : {
                        dataUrl: draft.voice.dataUrl,
                        name: draft.voice.name,
                        scriptText: draft.voice.scriptText.trim() || undefined,
                    })
                : (initialVoicePresent ? {} : undefined),
            video: draft.video
                ? (draft.video.relativePath
                    ? {
                        relativePath: draft.video.relativePath,
                        name: draft.video.name,
                    }
                    : {
                        dataUrl: draft.video.dataUrl,
                        name: draft.video.name,
                    })
                : (initialVideoPresent ? {} : undefined),
        };
        const result = draft.id
            ? await window.ipcRenderer.subjects.update(payload)
            : await window.ipcRenderer.subjects.create(payload);
        if (!result?.success || !result.subject) {
            throw new Error(result?.error || `保存${draftEntityLabel}失败`);
        }
        return result.subject;
    }, [draft, draftEntityLabel, initialVideoPresent, initialVoicePresent]);

    const handleSave = useCallback(async () => {
        setWorking(true);
        setError('');
        try {
            await persistDraft();
            await loadData();
            closeModal();
        } catch (e) {
            console.error('Failed to save subject:', e);
            setError(e instanceof Error ? e.message : `保存${draftEntityLabel}失败`);
        } finally {
            setWorking(false);
        }
    }, [closeModal, draftEntityLabel, loadData, persistDraft]);

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
            setInitialVideoPresent(Boolean((result.subject as SubjectRecord).videoPreviewUrl));
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
        if (!(await appConfirm(`删除${draftEntityLabel}“${draft.name || draft.id}”？`, { title: `删除${draftEntityLabel}`, confirmLabel: '删除', tone: 'danger' }))) return;
        setWorking(true);
        try {
            const result = await window.ipcRenderer.subjects.delete({ id: draft.id });
            if (!result?.success) {
                throw new Error(result?.error || `删除${draftEntityLabel}失败`);
            }
            await loadData();
            closeModal();
        } catch (e) {
            console.error('Failed to delete subject:', e);
            setError(e instanceof Error ? e.message : `删除${draftEntityLabel}失败`);
        } finally {
            setWorking(false);
        }
    }, [closeModal, draft.id, draft.name, draftEntityLabel, loadData]);

    return (
        <div className="h-full flex flex-col bg-background">
            <div className="border-b border-border px-4 py-2 bg-surface-secondary/45">
                <div className="flex items-center gap-2 min-w-0">
                    {!isModalVariant && onReturnHome && (
                        <button
                            type="button"
                            onClick={onReturnHome}
                            className="h-7 w-7 rounded-md border border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary hover:text-text-primary inline-flex items-center justify-center shrink-0"
                            aria-label="返回主页"
                            title="返回主页"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <div className="w-7 h-7 rounded-md bg-accent-primary/15 border border-accent-primary/20 text-accent-primary flex items-center justify-center shrink-0">
                        <Package className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-base leading-none font-semibold text-text-primary">资产库</h1>
                        <div className="text-[11px] mt-0.5 text-text-tertiary truncate">媒体、资产和长期素材统一管理，便于创作时直接调用参考</div>
                    </div>

                    <div className="hidden xl:flex items-center gap-1.5 min-w-0 ml-2">
                        <span className="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface-primary/70 text-text-secondary whitespace-nowrap">
                            媒体 {mediaAssets.length}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface-primary/70 text-text-secondary whitespace-nowrap">
                            资产 {subjects.length}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface-primary/70 text-text-secondary whitespace-nowrap">
                            分类 {categories.length}
                        </span>
                    </div>

                    <div className="ml-auto flex items-center gap-1.5">
                        <button
                            onClick={() => void loadData()}
                            className="h-7 px-2.5 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                        >
                            <span className="inline-flex items-center gap-1">
                                <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
                                刷新
                            </span>
                        </button>
                        {activeLibraryTab === 'media' && (
                            <button
                                onClick={() => void handleImportMediaAssets()}
                                className="h-7 px-2.5 text-[11px] rounded-md border border-accent-primary/30 bg-accent-primary/10 hover:bg-accent-primary/15 text-accent-primary"
                            >
                                <span className="inline-flex items-center gap-1">
                                    <ImagePlus className="w-3.5 h-3.5" />
                                    导入
                                </span>
                            </button>
                        )}
                        {activeLibraryTab === 'assets' && (
                            <button
                                onClick={openCreateModal}
                                className="h-7 px-2.5 text-[11px] rounded-md border border-accent-primary/30 bg-accent-primary/10 hover:bg-accent-primary/15 text-accent-primary"
                            >
                                <span className="inline-flex items-center gap-1">
                                    <Plus className="w-3.5 h-3.5" />
                                    {createAssetButtonLabel}
                                </span>
                            </button>
                        )}
                        {isModalVariant && onClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="h-7 w-7 rounded-md border border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary hover:text-text-primary inline-flex items-center justify-center"
                                title="关闭资产库"
                                aria-label="关闭资产库"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="px-6 py-3 border-b border-border bg-surface-secondary/20 space-y-3">
                <div className="flex items-center gap-1">
                    {([
                        { id: 'media' as const, label: '媒体', icon: Clapperboard, count: mediaAssets.length },
                        { id: 'assets' as const, label: '资产', icon: Package, count: subjects.length },
                    ]).map((item) => {
                        const Icon = item.icon;
                        const active = activeLibraryTab === item.id;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => setActiveLibraryTab(item.id)}
                                className={clsx(
                                    'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-colors',
                                    active
                                        ? 'bg-[rgb(var(--color-text-primary))] text-white'
                                        : 'text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                                )}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {item.label}
                                <span className={clsx('text-[10px]', active ? 'text-white/70' : 'text-text-tertiary')}>{item.count}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="flex flex-col lg:flex-row lg:items-center gap-2">
                    <div className="relative flex-1 min-w-0">
                        <Search className="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={activeLibraryTab === 'media' ? '搜索媒体标题、项目、稿件、路径' : '搜索资产名称、标签、属性、描述'}
                            className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                    </div>
                    {activeLibraryTab === 'assets' && (
                        <div className="inline-flex h-9 shrink-0 rounded-lg border border-border bg-surface-primary p-1">
                            <button
                                type="button"
                                onClick={() => setSubjectViewMode('grid')}
                                className={clsx(
                                    'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                                    subjectViewMode === 'grid'
                                        ? 'bg-surface-secondary text-text-primary'
                                        : 'text-text-tertiary hover:text-text-primary'
                                )}
                                title="网格视图"
                                aria-label="网格视图"
                            >
                                <Grid2X2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setSubjectViewMode('list')}
                                className={clsx(
                                    'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                                    subjectViewMode === 'list'
                                        ? 'bg-surface-secondary text-text-primary'
                                        : 'text-text-tertiary hover:text-text-primary'
                                )}
                                title="列表视图"
                                aria-label="列表视图"
                            >
                                <ListIcon className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                </div>

                {activeLibraryTab === 'assets' && (
                    <div className="flex min-h-[46px] items-end gap-4">
                        <div className="flex min-w-0 flex-1 items-end gap-5 overflow-x-auto">
                            {subjectCategoryTabs.map((item) => {
                                const active = categoryFilter === item.id;
                                const Icon = item.icon;
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => void selectSubjectCategoryTab(item)}
                                        className={clsx(
                                            'inline-flex h-10 shrink-0 items-center gap-2 border-b-2 pb-3 text-sm font-semibold transition-colors',
                                            active
                                                ? 'border-[rgb(var(--color-text-primary))] text-text-primary'
                                                : 'border-transparent text-text-secondary hover:text-text-primary'
                                        )}
                                    >
                                        <Icon className="h-4 w-4" />
                                        {item.label}
                                        <span className="text-[10px] text-text-tertiary">{categoryStats.get(item.id) || 0}</span>
                                    </button>
                                );
                            })}
                            <button
                                onClick={openCreateCategoryDialog}
                                className="mb-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-secondary transition hover:bg-surface-primary hover:text-text-primary"
                                aria-label="新建分类"
                                title="新建分类"
                            >
                                <Plus className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="mb-3 hidden shrink-0 items-center gap-1.5 text-xs font-medium text-text-secondary md:inline-flex">
                            <CalendarClock className="h-4 w-4" />
                            按时间倒序展示
                        </div>
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-auto p-6">
                {error && !isModalOpen && (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {error}
                    </div>
                )}

                {activeLibraryTab === 'media' ? (
                    loading && mediaAssets.length === 0 ? (
                        <div className="text-sm text-text-tertiary">媒体加载中...</div>
                    ) : filteredMediaAssets.length === 0 ? (
                        <div className={clsx('flex flex-col items-center justify-center text-center text-text-secondary', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                            <Clapperboard className="mb-4 h-12 w-12 stroke-[1.8]" />
                            <div className="text-sm font-medium">暂无媒体</div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="columns-2 sm:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6" style={{ columnGap: '0.625rem' }}>
                                {filteredMediaAssets.map((asset) => {
                                    return (
                                        <div
                                            key={asset.id}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => openMediaPreview(asset)}
                                            onContextMenu={(event) => openMediaContextMenu(event, asset)}
                                            onKeyDown={(event) => {
                                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                                event.preventDefault();
                                                openMediaPreview(asset);
                                            }}
                                            aria-label={asset.title || asset.id}
                                            className="group mb-2.5 block w-full break-inside-avoid overflow-hidden rounded-lg border border-border bg-surface-primary text-left shadow-sm transition hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent-primary/30"
                                        >
                                            <MediaMasonryThumb asset={asset} />
                                        </div>
                                    );
                                })}
                            </div>
                            {mediaNextCursor && (
                                <div className="flex justify-center">
                                    <button
                                        type="button"
                                        onClick={() => void loadMoreMediaAssets()}
                                        disabled={isLoadingMoreMedia}
                                        className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-surface-primary px-3 text-xs text-text-secondary transition hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        <RefreshCw className={clsx('h-3.5 w-3.5', isLoadingMoreMedia && 'animate-spin')} />
                                        {isLoadingMoreMedia ? '加载中' : '加载更多'}
                                    </button>
                                </div>
                            )}
                        </div>
                    )
                ) : loading && subjects.length === 0 && categories.length === 0 ? (
                    <div className="text-sm text-text-tertiary">资产库加载中...</div>
                ) : filteredSubjects.length === 0 ? (
                    <div className={clsx('flex flex-col items-center justify-center text-center text-text-secondary', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                        <CalendarClock className="mb-4 h-12 w-12 stroke-[1.8]" />
                        <div className="text-sm font-medium">暂无数据，尝试刷新</div>
                        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 text-xs text-text-secondary">已加载全部</div>
                    </div>
                ) : subjectViewMode === 'list' ? (
                    <div className="space-y-2">
                        {filteredSubjects.map((subject) => (
                            <button
                                key={subject.id}
                                type="button"
                                onClick={() => openEditModal(subject)}
                                className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-primary p-3 text-left shadow-sm transition-colors hover:bg-surface-secondary/40"
                            >
                                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-secondary/60">
                                    {subject.primaryPreviewUrl ? (
                                        <img
                                            src={resolveAssetUrl(subject.primaryPreviewUrl)}
                                            alt={subject.name}
                                            className="h-full w-full object-cover"
                                        />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                                            <Package className="h-6 w-6" />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <div className="truncate text-sm font-semibold text-text-primary">{subject.name}</div>
                                        <span className="shrink-0 rounded-md border border-border bg-surface-secondary/50 px-1.5 py-0.5 text-[10px] text-text-tertiary">
                                            {categoryNameMap.get(subject.categoryId || '') || '未分类'}
                                        </span>
                                    </div>
                                    {subject.description && (
                                        <div className="mt-1 line-clamp-1 text-xs text-text-secondary">
                                            {subject.description}
                                        </div>
                                    )}
                                    {subject.tags.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {subject.tags.slice(0, 5).map((tag) => (
                                                <span
                                                    key={`${subject.id}-list-${tag}`}
                                                    className="rounded-md border border-border bg-surface-secondary/50 px-1.5 py-0.5 text-[10px] text-text-secondary"
                                                >
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="hidden shrink-0 items-center gap-3 text-[11px] text-text-tertiary md:flex">
                                    <span>属性 {subject.attributes.length}</span>
                                    <span>图片 {(subject.previewUrls || []).length}</span>
                                    <span>{subject.voicePreviewUrl ? '声音参考' : '无声音'}</span>
                                    {isRoleSubject(subject) && (
                                        <span>{subject.videoPreviewUrl ? '视频参考' : '无视频'}</span>
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                        {filteredSubjects.map((subject) => (
                            <div
                                key={subject.id}
                                className="rounded-xl border border-border bg-surface-primary overflow-hidden shadow-sm hover:shadow-md transition-shadow"
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
                                                <Package className="w-8 h-8" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="p-3 space-y-2">
                                        <div>
                                            <div className="text-sm font-semibold text-text-primary truncate">{subject.name}</div>
                                            <div className="text-xs text-text-tertiary mt-1">
                                                {categoryNameMap.get(subject.categoryId || '') || '未分类'}
                                            </div>
                                        </div>
                                        {subject.description && (
                                            <div className="text-xs text-text-secondary line-clamp-2">
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
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-tertiary">
                                            <span>属性 {subject.attributes.length}</span>
                                            <span>图片 {(subject.previewUrls || []).length}</span>
                                            <span>{subject.voicePreviewUrl ? '有声音参考' : '无声音参考'}</span>
                                            {isRoleSubject(subject) && (
                                                <span>{subject.videoPreviewUrl ? '有视频参考' : '无视频参考'}</span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {isModalOpen && (
                <div className="absolute inset-0 z-30 bg-black/45 backdrop-blur-[1px] flex items-center justify-center p-6">
                    <div className="w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-secondary/30">
                            <div>
                                <div className="text-base font-semibold text-text-primary">
                                    {draft.id ? `编辑${draftEntityLabel}` : `新建${draftEntityLabel}`}
                                </div>
                                <div className="text-xs text-text-tertiary mt-0.5">
                                    名称必填，图片最多 5 张。保存后可在创作时直接引用这些{draftEntityLabel}资料。
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={closeModal}
                                className="rounded-full p-2 text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="max-h-[calc(90vh-140px)] overflow-auto p-6">
                            {error && (
                                <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                    {error}
                                </div>
                            )}

                            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
                                <div className="space-y-5">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <label className="block">
                                            <div className="text-sm font-medium text-text-primary mb-2">{draftEntityLabel}名称 *</div>
                                            <input
                                                value={draft.name}
                                                onChange={(event) => updateDraft({ name: event.target.value })}
                                                placeholder={`${draftEntityLabel}名称`}
                                                className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                            />
                                        </label>

                                        <label className="block">
                                            <div className="text-sm font-medium text-text-primary mb-2">分类</div>
                                            <div className="flex gap-2">
                                                <select
                                                    value={draft.categoryId}
                                                    onChange={(event) => updateDraft({ categoryId: event.target.value })}
                                                    className="flex-1 px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none"
                                                >
                                                    <option value="">未分类</option>
                                                    {draftCategoryOptions.map((category) => (
                                                        <option key={category.id} value={category.id}>{category.name}</option>
                                                    ))}
                                                </select>
                                                <button
                                                    type="button"
                                                    onClick={openCreateCategoryDialog}
                                                    className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary hover:bg-surface-secondary text-text-secondary"
                                                >
                                                    新建
                                                </button>
                                            </div>
                                            {draft.categoryId && (
                                                <div className="mt-2 flex items-center gap-2 text-xs text-text-tertiary">
                                                    <button type="button" onClick={() => {
                                                        const category = categories.find((item) => item.id === draft.categoryId);
                                                        if (category) openRenameCategoryDialog(category);
                                                    }} className="hover:text-text-primary">
                                                        重命名当前分类
                                                    </button>
                                                    <span>·</span>
                                                    <button type="button" onClick={() => {
                                                        const category = categories.find((item) => item.id === draft.categoryId);
                                                        if (category) void handleDeleteCategory(category);
                                                    }} className="hover:text-red-600">
                                                        删除当前分类
                                                    </button>
                                                </div>
                                            )}
                                        </label>
                                    </div>

                                    <label className="block">
                                        <div className="text-sm font-medium text-text-primary mb-2">{draftEntityLabel}描述</div>
                                        <div className="relative">
                                            <textarea
                                                value={draft.description}
                                                onChange={(event) => updateDraft({ description: event.target.value.slice(0, 200) })}
                                                rows={5}
                                                maxLength={200}
                                                placeholder={`描述${draftEntityLabel}特征或用途`}
                                                className="w-full px-3 py-2 pr-12 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary resize-y"
                                            />
                                            <div className="absolute bottom-2.5 right-3 text-xs text-text-tertiary">{draft.description.length}/200</div>
                                        </div>
                                    </label>

                                    {isRoleDraft && (
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <label className="block">
                                                <div className="text-sm font-medium text-text-primary mb-2">性别</div>
                                                <select
                                                    value={draftAttributeValue('性别')}
                                                    onChange={(event) => handleNamedAttributeChange('性别', event.target.value)}
                                                    className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                                >
                                                    <option value="">选择性别</option>
                                                    <option value="女性">女性</option>
                                                    <option value="男性">男性</option>
                                                    <option value="中性">中性</option>
                                                    <option value="其他">其他</option>
                                                </select>
                                            </label>
                                            <label className="block">
                                                <div className="text-sm font-medium text-text-primary mb-2">年龄</div>
                                                <input
                                                    value={draftAttributeValue('年龄')}
                                                    onChange={(event) => handleNamedAttributeChange('年龄', event.target.value)}
                                                    placeholder="角色年龄"
                                                    className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                                />
                                            </label>
                                        </div>
                                    )}

                                    <label className="block">
                                        <div className="text-sm font-medium text-text-primary mb-2">标签</div>
                                        <div className="relative">
                                            <Tag className="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
                                            <input
                                                value={draft.tagsText}
                                                onChange={(event) => updateDraft({ tagsText: event.target.value })}
                                                placeholder="多个标签用逗号分隔，例如：运动鞋, 白色, 男款"
                                                className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                            />
                                        </div>
                                    </label>

                                    <div className="rounded-2xl border border-border bg-surface-primary p-4 space-y-4">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <div className="text-sm font-medium text-text-primary">扩展属性</div>
                                                <div className="text-xs text-text-tertiary mt-0.5">用 key-value 描述规格、外观、背景、价格等</div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handleAddAttribute}
                                                className="px-3 py-1.5 text-xs rounded-md border border-border bg-surface-primary hover:bg-surface-secondary text-text-secondary"
                                            >
                                                添加属性
                                            </button>
                                        </div>

                                        {visibleDraftAttributes.length === 0 ? (
                                            <div className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-text-tertiary">
                                                还没有属性。比如：颜色、材质、职业、人设、价格区间。
                                            </div>
                                        ) : (
                                            <div className="space-y-3">
                                                {visibleDraftAttributes.map(({ attribute, index }) => (
                                                    <div key={index} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_40px] gap-3">
                                                        <input
                                                            value={attribute.key}
                                                            onChange={(event) => handleAttributeChange(index, { key: event.target.value })}
                                                            placeholder="属性名"
                                                            className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                                        />
                                                        <input
                                                            value={attribute.value}
                                                            onChange={(event) => handleAttributeChange(index, { value: event.target.value })}
                                                            placeholder="属性值"
                                                            className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveAttribute(index)}
                                                            className="rounded-md border border-border text-text-tertiary hover:bg-surface-secondary hover:text-red-600"
                                                        >
                                                            <X className="w-4 h-4 mx-auto" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-border bg-surface-primary p-4 h-fit">
                                    <div className="flex items-center justify-between mb-4">
                                        <div>
                                            <div className="text-sm font-medium text-text-primary">{draftEntityLabel}图片</div>
                                            <div className="text-xs text-text-tertiary mt-0.5">最多 5 张，本地复制进资产库</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {isRoleDraft && (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleGenerateCharacterCard()}
                                                    disabled={working || generatingCardSubjectId === draft.id || draft.images.length === 0}
                                                    className="inline-flex items-center gap-1 rounded-md bg-[rgb(var(--color-text-primary))] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[rgb(var(--color-surface-elevated))] disabled:cursor-not-allowed disabled:opacity-50"
                                                    title="生成角色卡"
                                                >
                                                    <Sparkles className={clsx('h-4 w-4', generatingCardSubjectId === draft.id && 'animate-pulse')} />
                                                    {generatingCardSubjectId === draft.id ? '生成中' : '角色卡'}
                                                </button>
                                            )}
                                            <label className={clsx(
                                                'inline-flex items-center gap-1 px-3 py-2 text-sm rounded-md border border-border bg-surface-primary hover:bg-surface-secondary text-text-secondary cursor-pointer',
                                                draft.images.length >= 5 && 'pointer-events-none opacity-50'
                                            )}>
                                                <ImagePlus className="w-4 h-4" />
                                                上传图片
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
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        {draft.images.map((image, index) => (
                                            <div key={`${image.relativePath || image.name}-${index}`} className="group relative rounded-xl overflow-hidden border border-border bg-surface-secondary/40 aspect-[4/5]">
                                                <button
                                                    type="button"
                                                    onClick={() => setPreviewImage(image)}
                                                    className="h-full w-full"
                                                    aria-label="预览图片"
                                                >
                                                    <img
                                                        src={resolveAssetUrl(image.previewUrl)}
                                                        alt={image.name}
                                                        className="w-full h-full object-cover"
                                                    />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveImage(index)}
                                                    className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white opacity-0 transition group-hover:opacity-100"
                                                >
                                                    <X className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        ))}
                                        {draft.images.length === 0 && (
                                            <div className="col-span-2 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-text-tertiary">
                                                暂无图片。上传后 AI 可以读取这些资产图片路径作为参考。
                                            </div>
                                        )}
                                    </div>

                                    {draft.id && (
                                        <div className="mt-4 rounded-lg bg-surface-secondary/40 px-4 py-3 text-xs text-text-tertiary space-y-1">
                                            <div>ID：{draft.id}</div>
                                            {isRoleDraft && (
                                                <div className="flex flex-wrap gap-x-3 gap-y-1">
                                                    <span>{draft.voice?.previewUrl ? '有声音' : '未录音'}</span>
                                                    <span>{draft.video?.previewUrl ? '有视频' : '无视频'}</span>
                                                </div>
                                            )}
                                            <div>保存后可在创作时直接通过{draftEntityLabel}名称引用这些资料。</div>
                                        </div>
                                    )}

                                    {isRoleDraft && (
                                        <div className="mt-4 rounded-xl border border-border bg-surface-secondary/30 p-4 space-y-3">
                                            <div>
                                                <div className="text-sm font-medium text-text-primary">角色视频</div>
                                                <div className="text-xs text-text-tertiary mt-0.5">可保存一段角色动态参考，体积不超过 200MB。</div>
                                            </div>
                                            {draft.video?.previewUrl ? (
                                                <div className="overflow-hidden rounded-lg border border-border bg-black">
                                                    <video
                                                        src={resolveAssetUrl(draft.video.previewUrl)}
                                                        className="aspect-video w-full object-cover"
                                                        muted
                                                        playsInline
                                                        controls
                                                        preload="metadata"
                                                    />
                                                    <div className="flex items-center justify-between gap-3 bg-black/75 px-3 py-2 text-xs text-white">
                                                        <span className="truncate">{draft.video.name}</span>
                                                        <button
                                                            type="button"
                                                            onClick={handleRemoveVideo}
                                                            className="shrink-0 rounded-md bg-white/10 px-2 py-1 hover:bg-white/20"
                                                        >
                                                            删除视频
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <label className="flex h-10 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface-primary text-sm font-medium text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary">
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
                                    <div className="mt-4 rounded-xl border border-border bg-surface-secondary/30 p-4 space-y-3">
                                        <div>
                                            <div className="text-sm font-medium text-text-primary">声音参考</div>
                                            <div className="text-xs text-text-tertiary mt-0.5">录制 5 到 10 秒，体积不超过 10MB。以后参考图视频可直接带这条声音参考。</div>
                                        </div>

                                        <div className="rounded-2xl border border-border bg-surface-primary px-4 py-4 space-y-3">
                                            <div className="text-xs font-medium uppercase tracking-[0.18em] text-text-tertiary">
                                                朗读采样句
                                            </div>
                                            <div className="text-xl leading-9 font-medium text-text-primary">
                                                {SUBJECT_VOICE_SAMPLE_TEXT}
                                            </div>
                                            <div className="text-xs leading-5 text-text-tertiary">
                                                请保持自然语速、音量稳定、吐字清晰。点击录音后会自动开始 6 秒采样，建议在安静环境下完成。
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void handleRecordVoice()}
                                                disabled={audioRecording.isRecording || audioRecording.isWorking}
                                                className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary hover:bg-surface-secondary text-text-secondary disabled:opacity-60"
                                            >
                                                <span className="inline-flex items-center gap-1">
                                                    <Mic className="w-4 h-4" />
                                                    {audioRecording.isRecording ? `录音中 ${recordingCountdown}s` : '点击录音'}
                                                </span>
                                            </button>
                                            <label className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary hover:bg-surface-secondary text-text-secondary cursor-pointer">
                                                导入音频
                                                <input
                                                    type="file"
                                                    accept="audio/*"
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
                                                    className="px-3 py-2 text-sm rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                                                >
                                                    删除声音
                                                </button>
                                            )}
                                        </div>

                                        {audioRecording.isRecording && (
                                            <div className="rounded-lg border border-accent-primary/25 bg-accent-primary/8 px-3 py-2 text-xs text-accent-primary">
                                                采样倒计时：{recordingCountdown} 秒。请持续朗读示例句，录音会自动结束。
                                            </div>
                                        )}
                                        {recordingHint && (
                                            <div className="text-xs text-text-tertiary">{recordingHint}</div>
                                        )}
                                        {recordingError && (
                                            <div className="text-xs text-red-600">{recordingError}</div>
                                        )}
                                        {draft.voice?.previewUrl && (
                                            <div className="rounded-lg border border-border bg-surface-primary px-3 py-3 space-y-2">
                                                <div className="text-xs text-text-secondary">{draft.voice.name}</div>
                                                <audio controls src={resolveAssetUrl(draft.voice.previewUrl)} className="w-full" />
                                            </div>
                                        )}
                                    </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface-secondary/30">
                            <div className="text-xs text-text-tertiary">
                                {draft.id ? `编辑现有${draftEntityLabel}` : `创建新${draftEntityLabel}`}
                            </div>
                            <div className="flex items-center gap-2">
                                {draft.id && (
                                    <button
                                        type="button"
                                        onClick={() => void handleDeleteSubject()}
                                        disabled={working}
                                        className="px-3 py-2 text-sm rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-60"
                                    >
                                        <span className="inline-flex items-center gap-1">
                                            <Trash2 className="w-4 h-4" />
                                            删除
                                        </span>
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    disabled={working}
                                    className="px-3 py-2 text-sm rounded-md border border-border bg-surface-primary hover:bg-surface-secondary text-text-secondary disabled:opacity-60"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleSave()}
                                    disabled={working}
                                    className="px-3 py-2 text-sm rounded-md border border-accent-primary/30 bg-accent-primary/10 hover:bg-accent-primary/15 text-accent-primary disabled:opacity-60"
                                >
                                    <span className="inline-flex items-center gap-1">
                                        {draft.id ? <Pencil className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                                        {working ? '处理中...' : draft.id ? '保存修改' : `创建${draftEntityLabel}`}
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

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
                                void handleShowMediaAssetInFolder(asset);
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

            {previewMediaAsset && (
                <MediaAssetPreviewDialog
                    asset={previewMediaAsset}
                    onClose={() => setPreviewMediaAsset(null)}
                    onOpenFile={(asset) => {
                        void handleOpenMediaAsset(asset);
                    }}
                    onShowInFolder={(asset) => {
                        void handleShowMediaAssetInFolder(asset);
                    }}
                    onDelete={(asset) => {
                        void handleDeleteMediaAsset(asset);
                    }}
                />
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
