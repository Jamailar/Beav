import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { buildAudioDataUrl } from '../features/audio-input/audioInput';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { uiDebug, uiMeasure } from '../utils/uiDebug';
import {
    FolderPlus,
    ImagePlus,
    Mic,
    Package,
    Pencil,
    Plus,
    RefreshCw,
    Save,
    Search,
    Tag,
    Trash2,
    X,
} from 'lucide-react';
import { resolveAssetUrl } from '../utils/pathManager';

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

const UNCATEGORIZED_FILTER = '__uncategorized__';
const SUBJECT_VOICE_SAMPLE_TEXT = '君不见黄河之水天上来，奔流到海不复回。';
const SUBJECT_VOICE_RECORDING_SECONDS = 6;

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

export function Subjects({ isActive = true }: { isActive?: boolean }) {
    const [categories, setCategories] = useState<SubjectCategory[]>([]);
    const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
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
    const [recordingError, setRecordingError] = useState('');
    const [recordingHint, setRecordingHint] = useState('');
    const [recordingCountdown, setRecordingCountdown] = useState(0);
    const recordingIntervalRef = useRef<number | null>(null);
    const recordingTimeoutRef = useRef<number | null>(null);
    const hasLoadedSnapshotRef = useRef(false);
    const loadDataRequestRef = useRef(0);

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
            const [categoriesResult, subjectsResult] = await uiMeasure('subjects', 'load_data', async () => (
                Promise.all([
                    window.ipcRenderer.subjects.categories.list(),
                    window.ipcRenderer.subjects.list({ limit: 500 }),
                ])
            ), { requestId });
            if (!categoriesResult?.success) {
                throw new Error(categoriesResult?.error || '加载分类失败');
            }
            if (!subjectsResult?.success) {
                throw new Error(subjectsResult?.error || '加载主体失败');
            }
            if (requestId !== loadDataRequestRef.current) return;
            setCategories(Array.isArray(categoriesResult.categories) ? categoriesResult.categories : []);
            setSubjects(Array.isArray(subjectsResult.subjects) ? subjectsResult.subjects : []);
            hasLoadedSnapshotRef.current = true;
        } catch (e) {
            if (requestId !== loadDataRequestRef.current) return;
            console.error('Failed to load subjects:', e);
            setError(e instanceof Error ? e.message : '加载主体库失败');
            if (!hasLoadedSnapshotRef.current) {
                setCategories([]);
                setSubjects([]);
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

    const categoryNameMap = useMemo(() => new Map(categories.map((item) => [item.id, item.name])), [categories]);

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
        setDraft(createEmptyDraft());
        setInitialVoicePresent(false);
        setError('');
        setIsModalOpen(true);
    }, []);

    const openEditModal = useCallback((subject: SubjectRecord) => {
        setDraft(toDraft(subject));
        setInitialVoicePresent(Boolean(subject.voicePreviewUrl));
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

    const handleImageInput = useCallback(async (files: FileList | null) => {
        const nextFiles = Array.from(files || []);
        if (!nextFiles.length) return;
        if (draft.images.length + nextFiles.length > 5) {
            void appAlert('主体最多只能保存 5 张图片');
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
        if (!(await appConfirm(`删除分类“${category.name}”？如果仍有主体使用该分类，将会被拒绝。`, { title: '删除分类', confirmLabel: '删除', tone: 'danger' }))) return;
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

    const handleSave = useCallback(async () => {
        if (!draft.name.trim()) {
            setError('主体名称是必填项');
            return;
        }
        setWorking(true);
        setError('');
        try {
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
            };
            const result = draft.id
                ? await window.ipcRenderer.subjects.update(payload)
                : await window.ipcRenderer.subjects.create(payload);
            if (!result?.success) {
                throw new Error(result?.error || '保存主体失败');
            }
            await loadData();
            closeModal();
        } catch (e) {
            console.error('Failed to save subject:', e);
            setError(e instanceof Error ? e.message : '保存主体失败');
        } finally {
            setWorking(false);
        }
    }, [closeModal, draft, initialVoicePresent, loadData]);

    const handleDeleteSubject = useCallback(async () => {
        if (!draft.id) return;
        if (!(await appConfirm(`删除主体“${draft.name || draft.id}”？`, { title: '删除主体', confirmLabel: '删除', tone: 'danger' }))) return;
        setWorking(true);
        try {
            const result = await window.ipcRenderer.subjects.delete({ id: draft.id });
            if (!result?.success) {
                throw new Error(result?.error || '删除主体失败');
            }
            await loadData();
            closeModal();
        } catch (e) {
            console.error('Failed to delete subject:', e);
            setError(e instanceof Error ? e.message : '删除主体失败');
        } finally {
            setWorking(false);
        }
    }, [closeModal, draft.id, draft.name, loadData]);

    return (
        <div className="h-full flex flex-col bg-background">
            <div className="border-b border-border px-4 py-2 bg-surface-secondary/45">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-md bg-accent-primary/15 border border-accent-primary/20 text-accent-primary flex items-center justify-center shrink-0">
                        <Package className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-base leading-none font-semibold text-text-primary">主体库画廊</h1>
                        <div className="text-[11px] mt-0.5 text-text-tertiary truncate">人物、商品、场景统一管理，便于在创作时直接调用参考</div>
                    </div>

                    <div className="hidden xl:flex items-center gap-1.5 min-w-0 ml-2">
                        <span className="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface-primary/70 text-text-secondary whitespace-nowrap">
                            总主体 {subjects.length}
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
                        <button
                            onClick={openCreateModal}
                            className="h-7 px-2.5 text-[11px] rounded-md border border-accent-primary/30 bg-accent-primary/10 hover:bg-accent-primary/15 text-accent-primary"
                        >
                            <span className="inline-flex items-center gap-1">
                                <Plus className="w-3.5 h-3.5" />
                                新建主体
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
                            placeholder="搜索主体名称、标签、属性、描述"
                            className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary px-2 py-1 rounded-md border border-border bg-surface-primary/70">
                        <Tag className="w-3.5 h-3.5" />
                        分类筛选
                    </span>
                    {[
                        { id: 'all', label: '全部主体' },
                        { id: UNCATEGORIZED_FILTER, label: '未分类' },
                        ...categories.map((category) => ({ id: category.id, label: category.name })),
                    ].map((item) => {
                        const active = categoryFilter === item.id;
                        return (
                            <button
                                key={item.id}
                                onClick={() => setCategoryFilter(item.id)}
                                className={clsx(
                                    'text-[11px] px-2.5 py-1 rounded-md border transition-colors',
                                    active
                                        ? 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary'
                                        : 'border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary'
                                )}
                            >
                                {item.label} · {categoryStats.get(item.id) || 0}
                            </button>
                        );
                    })}
                    <button
                        onClick={openCreateCategoryDialog}
                        className="ml-auto text-[11px] px-2.5 py-1 rounded-md border border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary"
                    >
                        <span className="inline-flex items-center gap-1">
                            <FolderPlus className="w-3.5 h-3.5" />
                            新建分类
                        </span>
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
                {error && !isModalOpen && (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {error}
                    </div>
                )}

                {loading && subjects.length === 0 && categories.length === 0 ? (
                    <div className="text-sm text-text-tertiary">主体库加载中...</div>
                ) : filteredSubjects.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border bg-surface-primary/70 px-6 py-10 text-center text-sm text-text-tertiary">
                        当前筛选条件下没有主体。
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
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
                                    <div className="aspect-[4/5] bg-surface-secondary/50 overflow-hidden">
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
                                        <div className="flex items-center justify-between text-[10px] text-text-tertiary">
                                            <span>属性 {subject.attributes.length}</span>
                                            <span>图片 {(subject.previewUrls || []).length}</span>
                                            <span>{subject.voicePreviewUrl ? '有声音参考' : '无声音参考'}</span>
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
                                    {draft.id ? '编辑主体' : '新建主体'}
                                </div>
                                <div className="text-xs text-text-tertiary mt-0.5">
                                    名称必填，图片最多 5 张。保存后可在创作时直接引用这些主体资料。
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
                                            <div className="text-sm font-medium text-text-primary mb-2">主体名称 *</div>
                                            <input
                                                value={draft.name}
                                                onChange={(event) => updateDraft({ name: event.target.value })}
                                                placeholder="例如：张三 / Z001 跑鞋 / 城市咖啡馆"
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
                                                    {categories.map((category) => (
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
                                        <div className="text-sm font-medium text-text-primary mb-2">主体描述</div>
                                        <textarea
                                            value={draft.description}
                                            onChange={(event) => updateDraft({ description: event.target.value })}
                                            rows={5}
                                            placeholder="补充人物设定、商品卖点、场景氛围等，方便 AI 精准引用。"
                                            className="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-primary focus:outline-none focus:ring-1 focus:ring-accent-primary resize-y"
                                        />
                                    </label>

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

                                        {draft.attributes.length === 0 ? (
                                            <div className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-text-tertiary">
                                                还没有属性。比如：颜色、材质、职业、人设、价格区间。
                                            </div>
                                        ) : (
                                            <div className="space-y-3">
                                                {draft.attributes.map((attribute, index) => (
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
                                            <div className="text-sm font-medium text-text-primary">主体图片</div>
                                            <div className="text-xs text-text-tertiary mt-0.5">最多 5 张，本地复制进主体库</div>
                                        </div>
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

                                    <div className="grid grid-cols-2 gap-3">
                                        {draft.images.map((image, index) => (
                                            <div key={`${image.relativePath || image.name}-${index}`} className="group relative rounded-xl overflow-hidden border border-border bg-surface-secondary/40 aspect-[4/5]">
                                                <img
                                                    src={resolveAssetUrl(image.previewUrl)}
                                                    alt={image.name}
                                                    className="w-full h-full object-cover"
                                                />
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
                                                暂无图片。上传后 AI 可以读取这些主体的图片路径作为参考。
                                            </div>
                                        )}
                                    </div>

                                    {draft.id && (
                                        <div className="mt-4 rounded-lg bg-surface-secondary/40 px-4 py-3 text-xs text-text-tertiary space-y-1">
                                            <div>ID：{draft.id}</div>
                                            <div>保存后可在创作时直接通过主体名称引用这些资料。</div>
                                        </div>
                                    )}

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
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface-secondary/30">
                            <div className="text-xs text-text-tertiary">
                                {draft.id ? '编辑现有主体' : '创建新主体'}
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
                                        {working ? '处理中...' : draft.id ? '保存修改' : '创建主体'}
                                    </span>
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
                                    ? '输入分类名称后即可在主体库中直接使用。'
                                    : '更新分类名称后，已关联的主体会自动沿用该分类。'}
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
