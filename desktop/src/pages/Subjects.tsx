import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { buildAudioDataUrl } from '../features/audio-input/audioInput';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsStore } from '../features/media-jobs/useMediaJobsStore';
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
    Grid2X2,
    ImagePlus,
    List,
    Mic,
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
    Upload,
    UserRound,
    X,
    type LucideIcon,
} from 'lucide-react';
import { resolveAssetUrl } from '../utils/pathManager';
import { SelectMenu } from '../components/ui/SelectMenu';

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
    voiceScript?: string;
    voice?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    absoluteImagePaths?: string[];
    previewUrls?: string[];
    primaryPreviewUrl?: string;
    absoluteVoicePath?: string;
    voicePreviewUrl?: string;
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
}

type CategoryDialogMode = 'create' | 'rename';
type SubjectViewMode = 'grid' | 'list';
type AssetLibraryTab = 'assets' | 'media';
type MediaAssetSource = 'generated' | 'planned' | 'imported';
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
    exists?: boolean;
}

const UNCATEGORIZED_FILTER = '__uncategorized__';
const DEFAULT_SUBJECT_CATEGORY_NAMES = ['角色', '物品', '品牌', '场景'];
const SUBJECT_VOICE_SAMPLE_TEXT = '君不见黄河之水天上来，奔流到海不复回。请用自然稳定的语速朗读这段文字，保持音量一致、停顿清晰，让系统更好地学习你的声音特点和语气节奏。';
const SUBJECT_VOICE_MIN_RECORDING_SECONDS = 30;
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
    jobId?: string;
    error?: string;
    canRetry: boolean;
};

const categoryIconForName = (name: string) => {
    const normalized = name.trim();
    if (normalized === '角色' || normalized === '人物') return UserRound;
    if (normalized === '物品' || normalized === '资产') return Package;
    if (normalized === '品牌') return Building2;
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
        voice: subject.voicePreviewUrl ? {
            name: subject.voicePath?.split('/').pop() || 'voice-reference',
            previewUrl: subject.voicePreviewUrl,
            relativePath: subject.voicePath,
            scriptText: subject.voiceScript || '',
        } : undefined,
    };
}

function normalizeAttributes(attributes: SubjectAttribute[]): SubjectAttribute[] {
    return attributes
        .map((item) => ({ key: String(item.key || '').trim(), value: String(item.value || '').trim() }))
        .filter((item) => item.key || item.value);
}

function normalizeMediaSource(source: unknown): MediaAssetSource {
    const normalized = String(source || '').trim().toLowerCase();
    if (normalized === 'generated' || normalized === 'planned' || normalized === 'imported') return normalized;
    return 'imported';
}

function normalizeMediaAsset(asset: MediaAsset): MediaAsset {
    return {
        ...asset,
        source: normalizeMediaSource(asset.source),
        exists: asset.exists !== false,
    };
}

function isVideoAsset(asset: Pick<MediaAsset, 'mimeType' | 'relativePath'>): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)$/i.test(String(asset.relativePath || '').trim());
}

function subjectVoiceString(subject: SubjectRecord, keys: string[]): string {
    const voice = subject.voice || {};
    for (const key of keys) {
        const value = voice[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function shortVoiceId(value?: string): string {
    if (!value) return '';
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

function subjectVoiceInfo(subject: SubjectRecord, job?: MediaJobProjection | null): SubjectVoiceInfo {
    const voiceId = subjectVoiceString(subject, ['voiceId', 'voice_id']);
    const jobId = subjectVoiceString(subject, ['jobId']);
    const status = subjectVoiceString(subject, ['status']).toLowerCase();
    const lastError = subjectVoiceString(subject, ['lastError', 'error']);
    const hasSample = Boolean(subject.voicePreviewUrl || subject.voicePath);
    const jobStatus = String(job?.status || '').toLowerCase();

    if (jobStatus && !isMediaJobTerminal(jobStatus)) {
        return {
            label: jobStatus === 'queued' ? '声音复刻排队中' : '声音复刻中',
            detail: jobId ? shortVoiceId(jobId) : undefined,
            tone: 'active',
            jobId,
            canRetry: false,
        };
    }

    if (status === 'queued' || status === 'submitting') {
        return {
            label: '声音复刻排队中',
            detail: jobId ? shortVoiceId(jobId) : undefined,
            tone: 'active',
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
            jobId,
            canRetry: hasSample,
        };
    }

    if (status === 'failed' || jobStatus === 'failed' || jobStatus === 'dead_lettered') {
        return {
            label: '声音复刻失败',
            detail: lastError || job?.attempt?.lastError || undefined,
            tone: 'failed',
            jobId,
            error: lastError || job?.attempt?.lastError || undefined,
            canRetry: hasSample,
        };
    }

    if (hasSample) {
        return {
            label: '待复刻',
            tone: 'muted',
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

function formatAssetDate(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString();
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
    const [libraryTab, setLibraryTab] = useState<AssetLibraryTab>('assets');
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');
    const [viewMode, setViewMode] = useState<SubjectViewMode>('grid');
    const [filterOpen, setFilterOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isDraftCategoryMenuOpen, setIsDraftCategoryMenuOpen] = useState(false);
    const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
    const [categoryDialogMode, setCategoryDialogMode] = useState<CategoryDialogMode>('create');
    const [categoryDialogName, setCategoryDialogName] = useState('');
    const [categoryDialogTargetId, setCategoryDialogTargetId] = useState<string | null>(null);
    const [isCategoryDialogSubmitting, setIsCategoryDialogSubmitting] = useState(false);
    const [draft, setDraft] = useState<SubjectDraft>(createEmptyDraft);
    const [initialVoicePresent, setInitialVoicePresent] = useState(false);
    const [recordingError, setRecordingError] = useState('');
    const [recordingHint, setRecordingHint] = useState('');
    const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
    const recordingIntervalRef = useRef<number | null>(null);
    const hasLoadedSnapshotRef = useRef(false);
    const hasEnsuredDefaultCategoriesRef = useRef(false);
    const loadDataRequestRef = useRef(0);
    const refreshedVoiceJobIdsRef = useRef(new Set<string>());
    const [retryingVoiceSubjectId, setRetryingVoiceSubjectId] = useState<string | null>(null);
    const [generatingCardSubjectId, setGeneratingCardSubjectId] = useState<string | null>(null);
    const voiceJobsById = useMediaJobsStore((state) => state.jobsById);

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
                    isModalVariant
                        ? window.ipcRenderer.invoke('media:list', { limit: 500 }) as Promise<{ success?: boolean; error?: string; assets?: MediaAsset[] }>
                        : Promise.resolve({ success: true, assets: [] }),
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
            setCategories(nextCategories);
            setSubjects(Array.isArray(subjectsResult.subjects) ? subjectsResult.subjects : []);
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

    const voiceJobIds = useMemo(
        () => Array.from(new Set(subjects
            .map((subject) => subjectVoiceString(subject, ['jobId']))
            .filter(Boolean))),
        [subjects],
    );
    const voiceJobBootstrapFilter = useMemo(() => ({ kind: 'voice_clone' as const, limit: 100 }), []);

    useMediaJobSubscription(voiceJobIds, {
        enabled: isActive,
        bootstrapFilter: voiceJobBootstrapFilter,
    });

    useEffect(() => {
        if (!isActive) return;
        for (const jobId of voiceJobIds) {
            const job = voiceJobsById[jobId];
            if (!job || !isMediaJobTerminal(job.status) || refreshedVoiceJobIdsRef.current.has(jobId)) {
                continue;
            }
            refreshedVoiceJobIdsRef.current.add(jobId);
            void loadData();
            break;
        }
    }, [isActive, loadData, voiceJobIds, voiceJobsById]);

    const categoryNameMap = useMemo(() => new Map(categories.map((item) => [item.id, item.name])), [categories]);
    const activeDraftSubject = useMemo(
        () => draft.id ? subjects.find((subject) => subject.id === draft.id) || null : null,
        [draft.id, subjects],
    );
    const activeDraftVoiceInfo = useMemo(
        () => {
            if (!activeDraftSubject) return null;
            if (retryingVoiceSubjectId === activeDraftSubject.id) {
                return {
                    label: '声音复刻提交中',
                    tone: 'active',
                    canRetry: false,
                } satisfies SubjectVoiceInfo;
            }
            return subjectVoiceInfo(activeDraftSubject, voiceJobsById[subjectVoiceString(activeDraftSubject, ['jobId'])]);
        },
        [activeDraftSubject, retryingVoiceSubjectId, voiceJobsById],
    );
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

    const openCreateModal = useCallback(() => {
        const nextDraft = createEmptyDraft();
        if (categoryFilter !== 'all' && categoryFilter !== UNCATEGORIZED_FILTER) {
            nextDraft.categoryId = categoryFilter;
        }
        setDraft(nextDraft);
        setInitialVoicePresent(false);
        setError('');
        setIsDraftCategoryMenuOpen(false);
        setIsModalOpen(true);
    }, [categoryFilter]);

    const openEditModal = useCallback((subject: SubjectRecord) => {
        setDraft(toDraft(subject));
        setInitialVoicePresent(Boolean(subject.voicePreviewUrl));
        setError('');
        setIsDraftCategoryMenuOpen(false);
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

    const buildSubjectPayload = useCallback((voicePayload?: Record<string, unknown>) => ({
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
    }), [draft]);

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
            const result = await window.ipcRenderer.voice.clone({
                ownerAssetId: subject.id,
                samplePath: subject.voicePath,
                name: subject.name,
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
    }, [loadData]);

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
        }));
    }, [categories, stopRecordingSession]);

    const closeModal = useCallback(() => {
        if (working) return;
        stopRecordingSession();
        setIsDraftCategoryMenuOpen(false);
        setIsModalOpen(false);
        setDraft(createEmptyDraft());
        setInitialVoicePresent(false);
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

    const persistDraft = useCallback(async (): Promise<SubjectRecord> => {
        if (!draft.name.trim()) {
            throw new Error('资产名称是必填项');
        }
        const shouldSaveVoice = categories.find((item) => item.id === draft.categoryId)?.name.trim() === '角色';
        const nextVoicePayload = shouldSaveVoice && draft.voice
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
            : (initialVoicePresent ? {} : undefined);
        const payload = buildSubjectPayload(nextVoicePayload);
        const result = draft.id
            ? await window.ipcRenderer.subjects.update(payload)
            : await window.ipcRenderer.subjects.create(payload);
        if (!result?.success || !result.subject) {
            throw new Error(result?.error || '保存资产失败');
        }
        return result.subject as SubjectRecord;
    }, [buildSubjectPayload, categories, draft.categoryId, draft.id, draft.name, draft.voice, initialVoicePresent]);

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

    const categoryTabs = useMemo<SubjectCategoryTab[]>(() => {
        const customCategories = categories.filter((category) => !DEFAULT_SUBJECT_CATEGORY_NAMES.includes(category.name.trim()));
        return [
            { id: 'all', label: '资产', icon: Package },
            ...DEFAULT_SUBJECT_CATEGORY_NAMES.map((name) => {
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

    const draftCategoryName = categoryNameMap.get(draft.categoryId || '') || '';
    const draftEntityLabel = draftCategoryName || '资产';
    const isRoleDraft = draftCategoryName.trim() === '角色';
    const draftPreviewImage = draft.images[0]?.previewUrl || '';
    const draftAttributeValue = (key: string) => draft.attributes.find((item) => item.key === key)?.value || '';
    const visibleDraftAttributes = draft.attributes
        .map((attribute, index) => ({ attribute, index }))
        .filter(({ attribute }) => !isRoleDraft || (attribute.key !== '性别' && attribute.key !== '年龄'));
    const draftCategoryOptions = useMemo(() => [
        { id: '', name: '未分类', icon: Tag },
        ...categories.map((category) => ({
            id: category.id,
            name: category.name,
            icon: categoryIconForName(category.name),
        })),
    ], [categories]);
    const selectedDraftCategory = draftCategoryOptions.find((item) => item.id === draft.categoryId) || draftCategoryOptions[0];
    const SelectedDraftCategoryIcon = selectedDraftCategory.icon;
    const activeLibraryTab = isModalVariant ? libraryTab : 'assets';
    const showAssetControls = activeLibraryTab === 'assets';

    return (
        <div className="flex h-full min-h-0 flex-col bg-white">
            <div className={clsx(isModalVariant ? 'px-5 pt-4 pb-3' : 'px-8 pt-6 pb-4')}>
                <div className="flex items-center gap-3">
                    {!isModalVariant && onReturnHome && (
                        <button
                            type="button"
                            onClick={onReturnHome}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-slate-950"
                            aria-label="返回主页"
                            title="返回主页"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                    )}
                    <h1 className={clsx('leading-none font-semibold tracking-[0.01em] text-slate-900', isModalVariant ? 'text-[20px]' : 'text-[26px]')}>资产库</h1>
                    {showAssetControls && (
                        <button
                            onClick={openCreateModal}
                            className={clsx(
                                'inline-flex items-center gap-2 rounded-xl bg-black text-sm font-semibold text-white shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition hover:bg-black/88',
                                isModalVariant ? 'h-9 px-3' : 'h-10 px-4'
                            )}
                        >
                            <Upload className="h-4 w-4" />
                            新增
                            <ChevronDown className="h-3.5 w-3.5 opacity-80" />
                        </button>
                    )}

                    <div className="ml-auto flex items-center gap-3">
                        <button
                            onClick={() => void loadData()}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-100"
                        >
                            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
                            刷新
                        </button>
                        <div className="inline-flex rounded-xl bg-slate-100 p-1">
                            <button
                                type="button"
                                onClick={() => setViewMode('grid')}
                                className={clsx(
                                    'inline-flex h-8 w-8 items-center justify-center rounded-lg transition',
                                    viewMode === 'grid' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
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
                                    viewMode === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                                )}
                                aria-label="列表视图"
                                title="列表视图"
                            >
                                <List className="h-4 w-4" />
                            </button>
                        </div>
                        {!showAssetControls && (
                            <button
                                type="button"
                                onClick={() => setFilterOpen((value) => !value)}
                                className={clsx(
                                    'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-slate-800 transition',
                                    filterOpen || query ? 'bg-slate-200' : 'bg-slate-100 hover:bg-slate-200'
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
                                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
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
                <div className="mx-5 flex items-center gap-1 border-b border-slate-200 pb-2">
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
                                    active ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                                )}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {item.label}
                                <span className={clsx('text-[10px]', active ? 'text-white/70' : 'text-slate-400')}>{item.count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {showAssetControls && (
            <div className={clsx('flex min-h-[48px] items-end border-b border-slate-200', isModalVariant ? 'mx-5' : 'mx-8')}>
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
                                        ? 'border-black text-slate-950'
                                        : 'border-transparent text-slate-500 hover:text-slate-800',
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
                        className="mb-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                        aria-label="新建分类"
                        title="新建分类"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
                <div className="mb-3 ml-auto flex shrink-0 items-center gap-4">
                    <div className="hidden items-center gap-1.5 text-xs font-medium text-slate-500 md:inline-flex">
                        <CalendarClock className="h-4 w-4" />
                        按时间倒序展示
                    </div>
                    <div className="h-4 w-px bg-slate-200" />
                    <button
                        type="button"
                        onClick={() => setFilterOpen((value) => !value)}
                        className={clsx(
                            'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-slate-800 transition',
                            filterOpen || query ? 'bg-slate-200' : 'bg-slate-100 hover:bg-slate-200'
                        )}
                    >
                        <SlidersHorizontal className="h-4 w-4" />
                        筛选
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            )}

            {filterOpen && (
                <div className={clsx('border-b border-slate-200 py-3', isModalVariant ? 'mx-5' : 'mx-8')}>
                    <div className="relative max-w-[420px]">
                        <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={activeLibraryTab === 'media' ? '搜索媒体标题、项目、稿件、路径' : '搜索名称、标签、属性、描述'}
                            className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
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
                        <div className="text-sm text-slate-500">媒体加载中...</div>
                    ) : filteredMediaAssets.length === 0 ? (
                        <div className={clsx('flex flex-col items-center justify-center text-center text-slate-500', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                            <Clapperboard className="mb-4 h-12 w-12 stroke-[1.8]" />
                            <div className="text-sm font-medium">暂无媒体</div>
                        </div>
                    ) : viewMode === 'grid' ? (
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                            {filteredMediaAssets.map((asset) => {
                                const previewUrl = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
                                const source = normalizeMediaSource(asset.source);
                                return (
                                    <button
                                        key={asset.id}
                                        type="button"
                                        onClick={() => void window.ipcRenderer.invoke('media:open', { assetId: asset.id })}
                                        className="overflow-hidden rounded-lg border border-border bg-surface-primary text-left shadow-sm transition hover:shadow-md"
                                    >
                                        <div className="aspect-[4/5] overflow-hidden bg-surface-secondary/50">
                                            {previewUrl && asset.exists ? (
                                                isVideoAsset(asset) ? (
                                                    <video src={previewUrl} className="h-full w-full bg-black object-cover" muted playsInline preload="metadata" />
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
                                                <span>{asset.aspectRatio || asset.size || (isVideoAsset(asset) ? '视频' : '图片')}</span>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
                            {filteredMediaAssets.map((asset) => {
                                const previewUrl = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
                                const source = normalizeMediaSource(asset.source);
                                return (
                                    <button
                                        key={asset.id}
                                        type="button"
                                        onClick={() => void window.ipcRenderer.invoke('media:open', { assetId: asset.id })}
                                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-slate-50"
                                    >
                                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                                            {previewUrl && asset.exists ? (
                                                isVideoAsset(asset) ? (
                                                    <video src={previewUrl} className="h-full w-full bg-black object-cover" muted playsInline preload="metadata" />
                                                ) : (
                                                    <img src={previewUrl} alt={asset.title || asset.id} className="h-full w-full object-cover" />
                                                )
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center text-slate-400">
                                                    <Clapperboard className="h-5 w-5" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-xs font-semibold text-slate-900">{asset.title || asset.id}</div>
                                            <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                                {MEDIA_SOURCE_LABEL[source]} · {asset.projectId || '未设置项目ID'}
                                                {asset.boundManuscriptPath ? ` · ${asset.boundManuscriptPath}` : ''}
                                            </div>
                                        </div>
                                        <div className="hidden text-xs text-slate-400 md:block">
                                            {formatAssetDate(asset.updatedAt || asset.createdAt)}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )
                ) : loading && subjects.length === 0 && categories.length === 0 ? (
                    <div className="text-sm text-slate-500">资产库加载中...</div>
                ) : filteredSubjects.length === 0 ? (
                    <div className={clsx('flex flex-col items-center justify-center text-center text-slate-500', isModalVariant ? 'min-h-[360px]' : 'min-h-[54vh]')}>
                        <CalendarClock className="mb-4 h-12 w-12 stroke-[1.8]" />
                        <div className="text-sm font-medium">暂无数据，尝试刷新</div>
                        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 text-xs text-slate-500">已加载全部</div>
                    </div>
                ) : viewMode === 'grid' ? (
                    <div className={clsx('grid gap-2.5', isModalVariant ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6' : 'grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8')}>
                        {filteredSubjects.map((subject) => {
                            const voiceInfo = subjectVoiceInfo(subject, voiceJobsById[subjectVoiceString(subject, ['jobId'])]);
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
                                    <div className="aspect-[4/5] bg-surface-secondary/50 overflow-hidden">
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
                                                {categoryNameMap.get(subject.categoryId || '') || '未分类'}
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
                                            <div className="flex items-center justify-between text-[9px] text-text-tertiary">
                                            <span>属性 {subject.attributes.length}</span>
                                            <span>图片 {(subject.previewUrls || []).length}</span>
                                            <span className={clsx('rounded-md border px-1.5 py-0.5', voiceInfoClassName(voiceInfo.tone))}>
                                                {voiceInfo.label}
                                            </span>
                                        </div>
                                    </div>
                                </button>
                            </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
                        {filteredSubjects.map((subject) => {
                            const voiceInfo = subjectVoiceInfo(subject, voiceJobsById[subjectVoiceString(subject, ['jobId'])]);
                            return (
                            <button
                                key={subject.id}
                                type="button"
                                onClick={() => openEditModal(subject)}
                                className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-slate-50"
                            >
                                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                                    {subject.primaryPreviewUrl ? (
                                        <img src={resolveAssetUrl(subject.primaryPreviewUrl)} alt={subject.name} className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-slate-400">
                                            <Package className="h-5 w-5" />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-xs font-semibold text-slate-900">{subject.name}</div>
                                    <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                        {categoryNameMap.get(subject.categoryId || '') || '未分类'}
                                        {subject.description ? ` · ${subject.description}` : ''}
                                    </div>
                                </div>
                                <div className="hidden text-xs text-slate-400 md:block">
                                    {new Date(subject.updatedAt).toLocaleDateString()}
                                </div>
                                <div className={clsx('hidden rounded-md border px-2 py-1 text-[11px] md:block', voiceInfoClassName(voiceInfo.tone))}>
                                    {voiceInfo.label}
                                </div>
                            </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {isModalOpen && (
                <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4">
                    <div className="flex max-h-[88vh] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between px-8 pb-4 pt-6">
                            <h2 className="text-xl font-semibold leading-none text-slate-950">
                                {draft.id ? `编辑${draftEntityLabel}` : `新建${draftEntityLabel}`}
                            </h2>
                            <button
                                type="button"
                                onClick={closeModal}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-950 transition hover:bg-slate-100"
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
                                        <div className="mb-1.5 text-sm font-semibold text-slate-800">类别</div>
                                        <div className="flex gap-2">
                                            <div className="relative flex-1">
                                                <button
                                                    type="button"
                                                    onClick={() => setIsDraftCategoryMenuOpen((value) => !value)}
                                                    className={clsx(
                                                        'flex h-10 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm transition',
                                                        isDraftCategoryMenuOpen
                                                            ? 'border-violet-400 bg-white ring-2 ring-violet-500/15'
                                                            : 'border-transparent bg-slate-100 hover:bg-slate-200/70'
                                                    )}
                                                >
                                                    <span className="flex min-w-0 items-center gap-2">
                                                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-slate-500 shadow-sm">
                                                            <SelectedDraftCategoryIcon className="h-3.5 w-3.5" />
                                                        </span>
                                                        <span className="truncate font-medium text-slate-900">{selectedDraftCategory.name}</span>
                                                    </span>
                                                    <ChevronDown className={clsx('h-4 w-4 shrink-0 text-slate-400 transition-transform', isDraftCategoryMenuOpen && 'rotate-180')} />
                                                </button>

                                                {isDraftCategoryMenuOpen && (
                                                    <div className="absolute left-0 right-0 top-full z-[140] mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.16)]">
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
                                                                            selected ? 'bg-violet-50 text-violet-700' : 'text-slate-700 hover:bg-slate-50'
                                                                        )}
                                                                    >
                                                                        <span className={clsx(
                                                                            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                                                                            selected ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-500'
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
                                                className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-700 transition hover:bg-slate-200"
                                                aria-label="新建分类"
                                                title="新建分类"
                                            >
                                                <Plus className="h-4 w-4" />
                                            </button>
                                        </div>
                                        {draft.categoryId && (
                                            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const category = categories.find((item) => item.id === draft.categoryId);
                                                        if (category) openRenameCategoryDialog(category);
                                                    }}
                                                    className="transition hover:text-slate-950"
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
                                        <div className="mb-1.5 text-sm font-semibold text-slate-800">
                                            {draftEntityLabel}名称 <span className="text-red-500">*</span>
                                        </div>
                                        <input
                                            value={draft.name}
                                            onChange={(event) => updateDraft({ name: event.target.value })}
                                            placeholder={`${draftEntityLabel}名称`}
                                            className="h-10 w-full rounded-lg border border-violet-500 bg-white px-3 text-sm text-slate-900 outline-none ring-2 ring-violet-500/15 placeholder:text-slate-400 focus:ring-violet-500/20"
                                        />
                                    </label>

                                    <label className="block">
                                        <div className="mb-1.5 text-sm font-semibold text-slate-800">{draftEntityLabel}描述</div>
                                        <div className="relative">
                                            <textarea
                                                value={draft.description}
                                                onChange={(event) => updateDraft({ description: event.target.value.slice(0, 200) })}
                                                rows={5}
                                                maxLength={200}
                                                placeholder={`描述${draftEntityLabel}特征或用途`}
                                                className="min-h-[92px] w-full resize-y rounded-lg border-0 bg-slate-100 px-3 py-2.5 pr-12 text-sm leading-5 text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-violet-500"
                                            />
                                            <div className="absolute bottom-2.5 right-3 text-xs text-slate-500">{draft.description.length}/200</div>
                                        </div>
                                    </label>

                                    {isRoleDraft && (
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <label className="block">
                                                <div className="mb-1.5 text-sm font-semibold text-slate-800">性别</div>
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
                                                <div className="mb-1.5 text-sm font-semibold text-slate-800">年龄</div>
                                                <input
                                                    value={draftAttributeValue('年龄')}
                                                    onChange={(event) => handleNamedAttributeChange('年龄', event.target.value)}
                                                    placeholder="角色年龄"
                                                    className="h-10 w-full rounded-lg border-0 bg-slate-100 px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-violet-500"
                                                />
                                            </label>
                                        </div>
                                    )}

                                    <label className="block">
                                        <div className="mb-1.5 text-sm font-semibold text-slate-800">标签</div>
                                        <div className="relative">
                                            <Tag className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                            <input
                                                value={draft.tagsText}
                                                onChange={(event) => updateDraft({ tagsText: event.target.value })}
                                                placeholder="多个标签用逗号分隔"
                                                className="h-10 w-full rounded-lg border-0 bg-slate-100 pl-9 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-violet-500"
                                            />
                                        </div>
                                    </label>

                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div className="text-sm font-semibold text-slate-800">扩展属性</div>
                                            <button
                                                type="button"
                                                onClick={handleAddAttribute}
                                                className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-100 px-2.5 text-xs font-medium text-slate-700 transition hover:bg-slate-200"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                添加
                                            </button>
                                        </div>
                                        {visibleDraftAttributes.length === 0 ? (
                                            <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2.5 text-xs text-slate-500">
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
                                                            className="h-9 rounded-lg border-0 bg-slate-100 px-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-violet-500"
                                                        />
                                                        <input
                                                            value={attribute.value}
                                                            onChange={(event) => handleAttributeChange(index, { value: event.target.value })}
                                                            placeholder="属性值"
                                                            className="h-9 rounded-lg border-0 bg-slate-100 px-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-violet-500"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveAttribute(index)}
                                                            className="inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition hover:bg-red-50 hover:text-red-600"
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
                                            <div className="text-sm font-semibold text-slate-800">{draftEntityLabel}图片</div>
                                            {isRoleDraft && (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleGenerateCharacterCard()}
                                                    disabled={working || generatingCardSubjectId === draft.id || draft.images.length === 0}
                                                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-950 px-2.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    <Sparkles className={clsx('h-3.5 w-3.5', generatingCardSubjectId === draft.id && 'animate-pulse')} />
                                                    {generatingCardSubjectId === draft.id ? '生成中' : '角色卡'}
                                                </button>
                                            )}
                                        </div>
                                        <label className={clsx(
                                            'flex h-10 cursor-pointer items-center justify-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-950 transition hover:bg-slate-200',
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
                                                    <div key={`${image.relativePath || image.name}-${index}`} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100">
                                                        <img src={resolveAssetUrl(image.previewUrl)} alt={image.name} className="h-full w-full object-cover" />
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
                                        <div className="space-y-2 rounded-xl bg-slate-50 p-4">
                                            <div className="text-sm font-semibold text-slate-800">声音参考</div>
                                            <div className="rounded-xl bg-white px-4 py-3">
                                                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">朗读采样句</div>
                                                <div className="mt-1.5 text-sm font-medium leading-6 text-slate-900">{SUBJECT_VOICE_SAMPLE_TEXT}</div>
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
                                                    'inline-flex h-9 items-center rounded-lg bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100',
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
                                            {recordingHint && <div className="text-xs text-slate-500">{recordingHint}</div>}
                                            {recordingError && <div className="text-xs text-red-600">{recordingError}</div>}
                                            {draft.voice?.previewUrl && (
                                                <div className="space-y-2 rounded-lg bg-white px-3 py-2.5">
                                                    <div className="text-xs text-slate-500">{draft.voice.name}</div>
                                                    <audio controls src={resolveAssetUrl(draft.voice.previewUrl)} className="w-full" />
                                                </div>
                                            )}
                                            {activeDraftSubject && activeDraftVoiceInfo && (
                                                <div className="space-y-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleRetryVoiceClone(activeDraftSubject)}
                                                        disabled={!activeDraftVoiceInfo.canRetry || retryingVoiceSubjectId === activeDraftSubject.id || activeDraftVoiceInfo.tone === 'active'}
                                                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        <RefreshCw className={clsx('h-3.5 w-3.5', (retryingVoiceSubjectId === activeDraftSubject.id || activeDraftVoiceInfo.tone === 'active') && 'animate-spin')} />
                                                        {retryingVoiceSubjectId === activeDraftSubject.id
                                                            ? '提交中'
                                                            : activeDraftVoiceInfo.tone === 'active'
                                                                ? '音色复刻中'
                                                                : '重新克隆音色'}
                                                    </button>
                                                    <div className={clsx('rounded-lg border px-3 py-2 text-xs', voiceInfoClassName(activeDraftVoiceInfo.tone))}>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="font-semibold">{activeDraftVoiceInfo.label}</span>
                                                            {activeDraftVoiceInfo.detail && (
                                                                <span className="font-mono text-[11px] opacity-80">{activeDraftVoiceInfo.detail}</span>
                                                            )}
                                                        </div>
                                                        {activeDraftVoiceInfo.error && (
                                                            <div className="mt-1 line-clamp-2 opacity-80">{activeDraftVoiceInfo.error}</div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <aside className="h-fit rounded-2xl bg-slate-100 p-4">
                                    <div className="mb-3 text-base font-semibold text-slate-800">{draft.id ? '编辑预览' : '新增预览'}</div>
                                    <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-white">
                                        {draftPreviewImage ? (
                                            <img src={resolveAssetUrl(draftPreviewImage)} alt={draft.name || draftEntityLabel} className="h-full w-full object-cover" />
                                        ) : (
                                            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
                                                <ImagePlus className="h-5 w-5" />
                                                暂无封面
                                            </div>
                                        )}
                                    </div>
                                    <div className="mt-4 space-y-2">
                                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                                            <span className="rounded-full bg-white px-2 py-0.5">{draftCategoryName || '未分类'}</span>
                                            <span>{draft.images.length}/5 张图片</span>
                                            {isRoleDraft && <span>{draft.voice?.previewUrl ? '有声音' : '未录音'}</span>}
                                        </div>
                                        <div className="text-base font-semibold text-slate-900">{draft.name || `${draftEntityLabel}名称`}</div>
                                        <div className="min-h-[36px] text-xs leading-5 text-slate-500">
                                            {draft.description || `选择图片后实时查看${draftEntityLabel}素材预览`}
                                        </div>
                                    </div>
                                    {draft.id && (
                                        <div className="mt-4 space-y-1 rounded-lg bg-white px-3 py-2 text-[11px] leading-5 text-slate-500">
                                            <div>ID：{draft.id}</div>
                                            {activeDraftVoiceInfo?.voiceId && (
                                                <div>音色ID：<span className="font-mono">{activeDraftVoiceInfo.voiceId}</span></div>
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
                                    className="h-9 rounded-lg bg-slate-100 px-5 text-sm font-semibold text-slate-950 transition hover:bg-slate-200 disabled:opacity-60"
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
