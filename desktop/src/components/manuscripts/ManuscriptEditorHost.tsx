import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
    AlertTriangle,
    Check,
    Download,
    Eye,
    ExternalLink,
    FileText,
    FileAudio,
    FileVideo,
    Folder,
    FolderOpen,
    FolderPlus,
    Grid2X2,
    Image as ImageIcon,
    ImagePlus,
    Loader2,
    Paperclip,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { ConfirmDialog } from '../ConfirmDialog';
import { DocumentPreviewWorkbench } from './DocumentPreviewWorkbench';
import { EditorLayoutToggleButton } from './EditorLayoutToggleButton';
import type { EditorBodyViewMode } from './WritingDraftWorkbench';
import { MediaAssetPreviewOverlay } from '../../pages/media-library/MediaAssetPreviewOverlay';
import { subscribeDataChanged } from '../../bridge/appEvents';
import { appAlert, appConfirm } from '../../utils/appDialogs';
import type { GenerationIntent, ImmersiveMode, PendingChatMessage } from '../../features/app-shell/types';
import { useMediaJobSubscription } from '../../features/media-jobs/useMediaJobSubscription';
import { shallowArrayEqual, useMediaJobsByIds, useMediaJobsStore } from '../../features/media-jobs/useMediaJobsStore';
import { isMediaJobSuccessful, isMediaJobTerminal } from '../../features/media-jobs/types';
import type { MediaJobProjection } from '../../features/media-jobs/types';
import { usePageRefresh } from '../../hooks/usePageRefresh';
import { composeMarkdownWithFrontmatter } from '../../utils/markdownFrontmatter';
import { resolveAssetUrl } from '../../utils/pathManager';
import { parseTimestampMs } from '../../utils/time';
import { uiDebug, uiMeasure } from '../../utils/uiDebug';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../../shared/redboxVideo';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel, LiquidGlassMenuSeparator } from '@/components/ui/liquid-glass-menu';
import { buildEditorSessionBinding, type EditorAiWorkspaceMode } from '../../features/chat/editorSessionBinding';
import { renameManuscriptKeepingExtension } from '../../../shared/manuscriptFiles';

import {
    DraftFilter,
    DraftLayout,
    CreateKind,
    ManuscriptDraftType,
    FileNode,
    MediaAssetSource,
    MediaAsset,
    GeneratedAsset,
    ReferenceImageItem,
    SettingsShape,
    ManuscriptReadResult,
    ManuscriptWriteProposal,
    FileCardMeta,
    DraftCard,
    EditorDescriptor,
    FolderContextMenuState,
    AssetContextMenuState,
    DraftContextMenuState,
    VideoScriptApprovalState,
    VideoProjectState,
    RemotionState,
    PackageState,
    ExportVideoResolution,
    DEFAULT_UNTITLED_DRAFT_TITLE,
    resolveDraftExtension,
    stripDraftExtension,
    exportResolutionDimensions,
    ensureDraftFileName,
    MANUSCRIPTS_INITIAL_ASSET_LIMIT,
    MANUSCRIPTS_ACTIVE_ASSET_LIMIT,
    MANUSCRIPTS_CARD_RENDER_LIMIT,
    IMAGE_ASPECT_RATIO_OPTIONS,
    VIDEO_ASPECT_RATIO_OPTIONS,
    VIDEO_GENERATION_MODE_OPTIONS,
    readFileAsDataUrl,
    getCurrentFolderChildren,
    collectNestedFiles,
    isInternalPackageFile,
    isPackageDraftPath,
    getFolderTrail,
    getParentFolderPath,
    getRelativeFolderPath,
    buildMediaFolderTree,
    buildDraftTemplate,
    shouldHideFrontmatterInEditor,
    splitWritingDraftContent,
    normalizeDraftFileName,
    buildDraftStorageName,
    pathBasenameSafe,
    normalizeAssetKindReference,
    manuscriptContentFormatFromPath,
    isSameDraftRelativePath,
    inferAssetKind,
    isVideoAsset,
    getVideoReferenceModeHint,
    generatedAssetsFromMediaJob,
    mediaJobErrorMessage,
    sortMediaJobsByRecency,
    inferImageAspectFromSize,
    formatDateLabel,
    resolveDraftTypeLabel,
    resolveDraftTypeStyle,
    isRemovedMediaDraftType,
    summaryFromContent,
    collectFileMetaMap,
} from '../../features/manuscripts/editorModel';
const WritingDraftWorkbench = lazy(async () => ({
    default: (await import('./WritingDraftWorkbench')).WritingDraftWorkbench,
}));

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

function mergeMediaAssets(current: MediaAsset[], incoming: MediaAsset[]): MediaAsset[] {
    if (incoming.length === 0) return current;
    const byId = new Map(current.map((asset) => [asset.id, asset]));
    for (const asset of incoming) {
        byId.set(asset.id, asset);
    }
    return Array.from(byId.values()).sort((left, right) => {
        const rightKey = String(right.updatedAt || right.createdAt || '');
        const leftKey = String(left.updatedAt || left.createdAt || '');
        return rightKey.localeCompare(leftKey);
    });
}

export function ManuscriptEditorHost({ filePath, onNavigateToRedClaw, onNavigateToGenerationStudio, isActive = false, onClose, onImmersiveModeChange }: ManuscriptEditorHostProps) {
    const [mode, setMode] = useState<'editor' | 'list'>('editor');
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
    const [previewAsset, setPreviewAsset] = useState<{ asset: MediaAsset; src: string } | null>(null);
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
    const [quality, setQuality] = useState('medium');
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
    const [editorBodyViewMode, setEditorBodyViewMode] = useState<EditorBodyViewMode>('edit');
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
    const boundAssetsRequestIdRef = useRef(0);
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
    const isSavingEditorBodyRef = useRef(false);
    const editorSavePromiseRef = useRef<Promise<boolean> | null>(null);
    const editorBodyReadRequestIdRef = useRef(0);
    const editorBodyRefreshTimerRef = useRef<number | null>(null);
    const skipEditorTitleBlurCommitRef = useRef(false);
    const handledImageTerminalJobIdRef = useRef<string | null>(null);
    const handledVideoTerminalJobIdRef = useRef<string | null>(null);
    const fileMetaMap = useMemo(() => collectFileMetaMap(tree), [tree]);
    const editorFileContentFormat = editorFile ? fileMetaMap[editorFile]?.contentFormat : undefined;
    const isMediaScope = filter === 'media' || filter === 'image' || filter === 'video' || filter === 'audio';
    const mediaFolderTree = useMemo(() => buildMediaFolderTree(assets), [assets]);
    const editorMetadataContentFormat = String(editorMetadata.contentFormat || '').trim();
    const editorIsDocument = editorMetadataContentFormat === 'document'
        || editorFileContentFormat === 'document'
        || editorDescriptor?.draftType === 'document';
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
        if (mode !== 'editor' || !editorFile) return;
        const metadataFormat = String(editorMetadata.contentFormat || editorFileContentFormat || '').trim();
        if (metadataFormat === 'document') return;
        const nextContentFormat = metadataFormat === 'html'
            ? 'html'
            : manuscriptContentFormatFromPath(editorFile);
        setEditorBodyViewMode(nextContentFormat === 'html' ? 'preview' : 'edit');
    }, [editorFile, editorFileContentFormat, editorMetadata.contentFormat, mode]);

    useEffect(() => {
        if (!isEditorTitleEditing) {
            setEditorTitleDraft(editorDescriptor?.title || '');
        }
    }, [editorDescriptor?.title, isEditorTitleEditing]);

    const manuscriptMediaJobs = useMediaJobsStore(useCallback(
        (state) => sortMediaJobsByRecency(
            Object.values(state.jobsById).filter((job) => (
                job.source === 'manuscripts' && isSameDraftRelativePath(job.manuscriptPath, editorFile)
            )),
        ),
        [editorFile],
    ), shallowArrayEqual);
    const activeMediaJobIds = useMemo(() => {
        const ids: string[] = [];
        if (activeImageJobId) ids.push(activeImageJobId);
        if (activeVideoJobId && activeVideoJobId !== activeImageJobId) ids.push(activeVideoJobId);
        return ids;
    }, [activeImageJobId, activeVideoJobId]);
    const activeMediaJobs = useMediaJobsByIds(activeMediaJobIds);
    const activeMediaJobsById = useMemo(() => (
        Object.fromEntries(activeMediaJobs.map((job) => [job.jobId, job])) as Record<string, MediaJobProjection>
    ), [activeMediaJobs]);
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
            const activeJob = activeMediaJobsById[activeImageJobId];
            if (activeJob && activeJob.kind === 'image' && isSameDraftRelativePath(activeJob.manuscriptPath, editorFile)) {
                return activeJob;
            }
        }
        return manuscriptMediaJobs.find((job) => job.kind === 'image') || null;
    }, [activeImageJobId, activeMediaJobsById, editorFile, manuscriptMediaJobs]);
    const currentVideoJob = useMemo(() => {
        if (activeVideoJobId) {
            const activeJob = activeMediaJobsById[activeVideoJobId];
            if (activeJob && activeJob.kind === 'video' && isSameDraftRelativePath(activeJob.manuscriptPath, editorFile)) {
                return activeJob;
            }
        }
        return manuscriptMediaJobs.find((job) => job.kind === 'video') || null;
    }, [activeMediaJobsById, activeVideoJobId, editorFile, manuscriptMediaJobs]);

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
        isSavingEditorBodyRef.current = isSavingEditorBody;
    }, [isSavingEditorBody]);

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
                window.ipcRenderer.manuscripts.list() as Promise<FileNode[]>
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
                window.ipcRenderer.media.list({ limit }) as Promise<{ success?: boolean; assets?: MediaAsset[]; error?: string }>
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

    const loadBoundAssetsForEditor = useCallback(async (targetPath: string | null | undefined = editorFileRef.current) => {
        const manuscriptPath = String(targetPath || '').trim();
        if (!manuscriptPath) return;
        const requestId = ++boundAssetsRequestIdRef.current;
        try {
            const mediaResult = await uiMeasure('manuscripts', 'load_bound_assets', async () => (
                window.ipcRenderer.media.list({ manuscriptPath }) as Promise<{ success?: boolean; assets?: MediaAsset[]; error?: string }>
            ), { requestId, mode, isActive, manuscriptPath });
            if (requestId !== boundAssetsRequestIdRef.current) return;
            if (!mediaResult?.success) {
                throw new Error(mediaResult?.error || '加载稿件配图失败');
            }
            const nextAssets = Array.isArray(mediaResult.assets) ? mediaResult.assets : [];
            const nextAssetIds = new Set(nextAssets.map((asset) => asset.id));
            setAssets((current) => {
                const currentWithoutStaleBindings = current.filter((asset) => (
                    !isSameDraftRelativePath(asset.boundManuscriptPath, manuscriptPath)
                    || nextAssetIds.has(asset.id)
                ));
                return mergeMediaAssets(currentWithoutStaleBindings, nextAssets);
            });
        } catch (loadError) {
            if (requestId !== boundAssetsRequestIdRef.current) return;
            console.error('Failed to load bound manuscript media assets:', loadError);
        }
    }, [isActive, mode]);

    useEffect(() => {
        if (!isBindAssetModalOpen) return;
        void loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT)
            .catch(() => undefined)
            .finally(() => {
                if (editorFileRef.current) {
                    void loadBoundAssetsForEditor(editorFileRef.current);
                }
            });
    }, [isBindAssetModalOpen, loadAssets, loadBoundAssetsForEditor]);

    const loadData = useCallback(async () => {
        uiDebug('manuscripts', 'load_data:start', { mode, isActive, hasSnapshot: hasLoadedSnapshotRef.current });
        if (hasLoadedSnapshotRef.current) {
            setIsRefreshing(true);
        } else {
            setLoading(true);
        }
        setError('');
        try {
            const activeEditorFile = editorFileRef.current;
            await Promise.all([loadTree(), loadAssets(MANUSCRIPTS_INITIAL_ASSET_LIMIT)]);
            if (activeEditorFile && mode === 'editor') {
                await loadBoundAssetsForEditor(activeEditorFile);
            }
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
    }, [assets.length, isActive, loadAssets, loadBoundAssetsForEditor, loadTree, mode, tree.length]);

    const handleImportMediaFiles = useCallback(async () => {
        setWorkingId('media-import');
        try {
            const result = await window.ipcRenderer.media.importFiles() as {
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
            setQuality(next.image_quality === 'low' || next.image_quality === 'medium' || next.image_quality === 'high' ? next.image_quality : 'medium');
        } catch (settingsError) {
            console.error('Failed to load image settings:', settingsError);
        }
    }, []);

    const reloadEditorBodyFromDisk = useCallback(async (
        targetPath: string | null,
        options?: { force?: boolean; reason?: string },
    ) => {
        const normalizedTarget = String(targetPath || '').trim();
        if (!normalizedTarget || mode !== 'editor') return false;
        if (!options?.force && (editorBodyDirtyRef.current || isSavingEditorBodyRef.current || editorSavePromiseRef.current)) {
            return false;
        }
        const requestId = ++editorBodyReadRequestIdRef.current;
        try {
            const result = await window.ipcRenderer.manuscripts.read(normalizedTarget) as ManuscriptReadResult;
            if (requestId !== editorBodyReadRequestIdRef.current) return false;
            if (!isSameDraftRelativePath(editorFileRef.current, normalizedTarget)) return false;
            if (!options?.force && (editorBodyDirtyRef.current || isSavingEditorBodyRef.current || editorSavePromiseRef.current)) {
                return false;
            }
            const nextContent = String(result?.content || '');
            const nextDraft = splitWritingDraftContent(nextContent, editorDescriptor?.draftType);
            const nextMetadata = (result?.metadata || {}) as Record<string, unknown>;
            const currentContent = composeMarkdownWithFrontmatter(
                editorBodyRef.current,
                editorFrontmatterBlockRef.current
            );
            const metadataKey = JSON.stringify(editorMetadataRef.current || {});
            const nextMetadataKey = JSON.stringify(nextMetadata || {});
            if (nextContent === currentContent && nextMetadataKey === metadataKey) {
                return false;
            }
            editorBodyRef.current = nextDraft.body;
            editorFrontmatterBlockRef.current = nextDraft.frontmatterBlock;
            editorMetadataRef.current = nextMetadata;
            editorBodyDirtyRef.current = false;
            setEditorBody(nextDraft.body);
            setEditorFrontmatterBlock(nextDraft.frontmatterBlock);
            setEditorMetadata(nextMetadata);
            setEditorBodyDirty(false);
            const nextTitle = String(nextMetadata.title || '').trim();
            const nextDraftType = String(nextMetadata.draftType || '').trim();
            if (nextTitle || nextDraftType) {
                setEditorDescriptor((current) => current ? {
                    ...current,
                    title: nextTitle || current.title,
                    draftType: (nextDraftType as ManuscriptDraftType | '') || current.draftType,
                } : current);
            }
            uiDebug('manuscripts', 'editor_body_refreshed', {
                reason: options?.reason || 'manual',
                filePath: normalizedTarget,
            });
            return true;
        } catch (readError) {
            console.error('Failed to refresh editor body:', readError);
            return false;
        }
    }, [editorDescriptor?.draftType, mode]);

    const refreshWorkspace = useCallback(async () => {
        // Keep editor interactions smooth: skip heavy media refresh while actively editing.
        if (mode === 'editor') {
            uiDebug('manuscripts', 'refresh_workspace:editor_fast_path');
            const activeEditorFile = editorFileRef.current;
            await Promise.all([
                loadTree(),
                reloadEditorBodyFromDisk(activeEditorFile, { reason: 'page-refresh' }),
                loadBoundAssetsForEditor(activeEditorFile),
            ]);
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
            void loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT)
                .catch(() => undefined)
                .finally(() => setIsRefreshing(false));
        }, 0);
    }, [loadAssets, loadBoundAssetsForEditor, loadTree, mode, reloadEditorBodyFromDisk]);

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
        const handleDataChanged = (_event: unknown, payload?: { scope?: string; filePath?: string; entityId?: string }) => {
            if (payload?.scope === 'manuscripts') {
                void loadTree();
                const changedPath = String(payload.filePath || payload.entityId || '').trim();
                const activeEditorFile = editorFileRef.current;
                if (mode === 'editor' && activeEditorFile && (!changedPath || isSameDraftRelativePath(changedPath, activeEditorFile))) {
                    if (editorBodyRefreshTimerRef.current != null) {
                        window.clearTimeout(editorBodyRefreshTimerRef.current);
                    }
                    editorBodyRefreshTimerRef.current = window.setTimeout(() => {
                        editorBodyRefreshTimerRef.current = null;
                        void reloadEditorBodyFromDisk(activeEditorFile, { reason: 'data-changed' });
                    }, 160);
                }
                return;
            }
            if (payload?.scope === 'media') {
                void loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT)
                    .catch(() => undefined)
                    .finally(() => {
                        const activeEditorFile = editorFileRef.current;
                        if (mode === 'editor' && activeEditorFile) {
                            void loadBoundAssetsForEditor(activeEditorFile);
                        }
                    });
            }
        };
        return subscribeDataChanged(handleDataChanged);
    }, [isActive, loadAssets, loadBoundAssetsForEditor, loadTree, mode, reloadEditorBodyFromDisk]);

    useEffect(() => {
        if (!isActive || mode !== 'editor' || !editorFile) return;
        const interval = window.setInterval(() => {
            void reloadEditorBodyFromDisk(editorFileRef.current, { reason: 'auto-poll' });
        }, 1500);
        return () => window.clearInterval(interval);
    }, [editorFile, isActive, mode, reloadEditorBodyFromDisk]);

    useEffect(() => {
        if (!isActive || mode !== 'editor' || !editorFile) return;
        void loadBoundAssetsForEditor(editorFile);
    }, [editorFile, isActive, loadBoundAssetsForEditor, mode]);

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
            if (editorBodyRefreshTimerRef.current != null) {
                window.clearTimeout(editorBodyRefreshTimerRef.current);
                editorBodyRefreshTimerRef.current = null;
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
                const result = await window.ipcRenderer.manuscripts.read(filePath) as ManuscriptReadResult;
                const metadata = (result?.metadata || {}) as Record<string, unknown>;
                if (isRemovedMediaDraftType(metadata.draftType)) {
                    setMode('list');
                    setEditorFile('');
                    setEditorDescriptor(null);
                    void appAlert('视频稿件和音频稿件编辑页面已移除。请在 AI 对话中直接上传素材并使用视频分析、字幕提取或音频整理能力。');
                    return;
                }
                setEditorDescriptor({
                    title: String(metadata.title || '').trim() || DEFAULT_UNTITLED_DRAFT_TITLE,
                    draftType: (String(metadata.draftType || '').trim() as ManuscriptDraftType | '') || 'unknown',
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
            if (isRemovedMediaDraftType(meta?.draftType)) return false;
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
            const result = await window.ipcRenderer.manuscripts.createFile({
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
            const result = await window.ipcRenderer.manuscripts.createFolder({
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
            const result = await window.ipcRenderer.manuscripts.delete(folderPath) as { success?: boolean; error?: string };
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
            const result = await window.ipcRenderer.manuscripts.rename({
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
            const result = await window.ipcRenderer.media.update({
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
            const result = await window.ipcRenderer.manuscripts.rename({
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
            const result = await window.ipcRenderer.manuscripts.rename({
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
            const result = await window.ipcRenderer.manuscripts.delete(targetPath) as { success?: boolean; error?: string };
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
            const result = await window.ipcRenderer.media.delete({ assetId }) as { success?: boolean; error?: string };
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
            if (isRemovedMediaDraftType(cached.draftType)) {
                setMode('list');
                setEditorFile('');
                setEditorDescriptor(null);
                void appAlert('视频稿件和音频稿件编辑页面已移除。请在 AI 对话中直接上传素材并使用视频分析、字幕提取或音频整理能力。');
                return;
            }
            setEditorDescriptor({
                title: cached.title,
                draftType: cached.draftType,
            });
            return;
        }
        try {
            const result = await window.ipcRenderer.manuscripts.read(targetPath) as ManuscriptReadResult;
            const metadata = (result?.metadata || {}) as Record<string, unknown>;
            if (isRemovedMediaDraftType(metadata.draftType)) {
                setMode('list');
                setEditorFile('');
                setEditorDescriptor(null);
                void appAlert('视频稿件和音频稿件编辑页面已移除。请在 AI 对话中直接上传素材并使用视频分析、字幕提取或音频整理能力。');
                return;
            }
            setEditorDescriptor({
                title: String(metadata.title || '').trim() || DEFAULT_UNTITLED_DRAFT_TITLE,
                draftType: (String(metadata.draftType || '').trim() as ManuscriptDraftType | '') || 'unknown',
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
        const result = await window.ipcRenderer.manuscripts.getPackageState(targetPath) as {
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
            const result = await window.ipcRenderer.manuscripts.save({
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
            const result = await window.ipcRenderer.manuscripts.attachExternalFiles({
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
            await loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT);
            await loadBoundAssetsForEditor(editorFile);
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
    }, [applyPackageState, editorFile, loadAssets, loadBoundAssetsForEditor, refreshPackageState]);

    const handleDownloadEditorFile = useCallback(async () => {
        if (!editorFileRef.current || workingId) return;
        const saved = await ensureLatestEditorContentSaved();
        if (!saved) return;
        const snapshotFile = editorFileRef.current;
        setWorkingId('download:editor');
        try {
            const result = await window.ipcRenderer.manuscripts.download({
                filePath: snapshotFile,
            }) as { success?: boolean; error?: string; path?: string; format?: string };
            if (!result?.success) {
                throw new Error(result?.error || '下载稿件失败');
            }
        } catch (downloadError) {
            void appAlert(downloadError instanceof Error ? downloadError.message : '下载稿件失败');
        } finally {
            setWorkingId(null);
        }
    }, [ensureLatestEditorContentSaved, workingId]);

    const handleOpenEditorDocument = useCallback(async () => {
        const snapshotFile = editorFileRef.current;
        if (!snapshotFile) return;
        try {
            const result = await window.ipcRenderer.openPath(`manuscripts://${snapshotFile}`);
            if (result && result.success === false) {
                throw new Error(result.error || '打开文件失败');
            }
        } catch (openError) {
            void appAlert(openError instanceof Error ? openError.message : '打开文件失败');
        }
    }, []);

    const handleRevealEditorDocument = useCallback(async () => {
        const snapshotFile = editorFileRef.current;
        if (!snapshotFile) return;
        try {
            const result = await window.ipcRenderer.files.showInFolder({
                source: `manuscripts://${snapshotFile}`,
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '显示文件失败');
            }
        } catch (revealError) {
            void appAlert(revealError instanceof Error ? revealError.message : '显示文件失败');
        }
    }, []);

    const handleSaveAsEditorDocument = useCallback(async () => {
        const snapshotFile = editorFileRef.current;
        if (!snapshotFile || workingId) return;
        setWorkingId('save-as:document');
        try {
            const result = await window.ipcRenderer.files.saveAs({
                source: `manuscripts://${snapshotFile}`,
                defaultName: pathBasenameSafe(snapshotFile),
            }) as { success?: boolean; error?: string; canceled?: boolean };
            if (result?.canceled) return;
            if (result && result.success === false) {
                throw new Error(result.error || '另存文件失败');
            }
        } catch (saveAsError) {
            void appAlert(saveAsError instanceof Error ? saveAsError.message : '另存文件失败');
        } finally {
            setWorkingId(null);
        }
    }, [workingId]);

    const handleGenerateRemotionScene = useCallback(async (instructionsOverride?: string) => {
        if (!editorFile || String(editorDescriptor?.draftType || '') !== 'video') return;
        setIsGeneratingRemotion(true);
        try {
            const result = await window.ipcRenderer.manuscripts.generateRemotionScene({
                filePath: editorFile,
                instructions: instructionsOverride || editorBody,
            }) as { success?: boolean; state?: PackageState; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '该生成功能已关闭');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '该生成功能已关闭');
        } finally {
            setIsGeneratingRemotion(false);
        }
    }, [editorBody, editorDescriptor?.draftType, editorFile]);

    const handleSaveRemotionScene = useCallback(async (scene: Record<string, unknown>) => {
        if (!editorFile || String(editorDescriptor?.draftType || '') !== 'video') return;
        try {
            const result = await window.ipcRenderer.manuscripts.saveRemotionScene({
                filePath: editorFile,
                scene,
            }) as { success?: boolean; state?: PackageState; error?: string };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '该生成功能已关闭');
            }
            setPackageState(result.state);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '该生成功能已关闭');
        }
    }, [editorDescriptor?.draftType, editorFile]);

    const handleRenderRemotionVideo = useCallback(() => {
        if (!editorFile || String(editorDescriptor?.draftType || '') !== 'video' || isRenderingRemotion) return;
        setExportVideoError('');
        setExportVideoStage('');
        setExportVideoProgress(0);
        setIsExportVideoModalOpen(true);
    }, [editorDescriptor?.draftType, editorFile, isRenderingRemotion]);

    const handlePickExportVideoPath = useCallback(async () => {
        if (!editorFile || String(editorDescriptor?.draftType || '') !== 'video' || isRenderingRemotion) return;
        try {
            const result = await window.ipcRenderer.manuscripts.pickExportPath({
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
        if (!editorFile || String(editorDescriptor?.draftType || '') !== 'video' || isRenderingRemotion) return;
        let outputPath = exportVideoPath.trim();
        if (!outputPath) {
            const picked = await window.ipcRenderer.manuscripts.pickExportPath({
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
            const result = await window.ipcRenderer.manuscripts.renderRemotionVideo({
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
            await window.ipcRenderer.openPath(outputPath);
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
        window.ipcRenderer.manuscripts.onRenderProgress(handleProgress);
        return () => {
            window.ipcRenderer.manuscripts.offRenderProgress(handleProgress);
        };
    }, [editorFile]);

    useEffect(() => {
        if (!editorFile || editorIsDocument) {
            setPackageState(null);
            setExportVideoPath('');
            setExportVideoProgress(0);
            setExportVideoStage('');
            setExportVideoError('');
            setIsExportVideoModalOpen(false);
            return;
        }
        void refreshPackageState(editorFile);
    }, [editorFile, editorIsDocument, refreshPackageState]);

    const loadEditorWriteProposal = useCallback(async (filePath: string | null) => {
        if (!filePath) {
            setEditorWriteProposal(null);
            return;
        }
        try {
            const result = await window.ipcRenderer.manuscripts.getWriteProposal({
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
                const result = await window.ipcRenderer.manuscripts.read(editorFile) as ManuscriptReadResult;
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
        if (!editorFile || mode !== 'editor' || editorIsDocument) {
            setEditorWriteProposal(null);
            setEditorReviewBody('');
            return;
        }
        void loadEditorWriteProposal(editorFile);
    }, [editorFile, editorIsDocument, loadEditorWriteProposal, mode]);

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
            if (!editorFile || editorIsDocument) return;
            if (!isSameDraftRelativePath(payload?.filePath, editorFile)) return;
            const nextProposal = payload?.proposal || null;
            setEditorWriteProposal(nextProposal);
            if (nextProposal) {
                const nextDraft = splitWritingDraftContent(nextProposal.proposedContent, editorDescriptor?.draftType);
                editorReviewProposalIdRef.current = nextProposal.id;
                setEditorReviewBody(nextDraft.body);
            } else {
                editorReviewProposalIdRef.current = null;
                setEditorReviewBody('');
            }
        };
        window.ipcRenderer.manuscripts.onWriteProposal(handleProposalChanged);
        return () => {
            window.ipcRenderer.manuscripts.offWriteProposal(handleProposalChanged);
        };
    }, [editorDescriptor?.draftType, editorFile, editorIsDocument]);

    useEffect(() => {
        if (!editorFile || editorIsDocument || mode !== 'editor' || editorBodyDirty) return;
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
        editorIsDocument,
        editorFile,
        editorFrontmatterBlock,
        mode,
        packageState?.editorProject?.script?.body,
        packageState?.videoProject?.scriptBody,
    ]);

    useEffect(() => {
        if (!editorFile || editorIsDocument || !editorBodyDirty || isSavingEditorBody) return;
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
        editorIsDocument,
        editorFile,
        editorFrontmatterBlock,
        editorMetadata,
        isSavingEditorBody,
        runEditorSave,
    ]);

    const editorChatBinding = useMemo(() => editorIsDocument ? null : buildEditorSessionBinding({
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
        editorIsDocument,
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
        void window.ipcRenderer.chat.bindEditorSession(editorChatBinding)
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
            const result = await window.ipcRenderer.manuscripts.acceptWriteProposal({
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
            const result = await window.ipcRenderer.manuscripts.rejectWriteProposal({
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
            ? 'theme'
            : false;
        onImmersiveModeChange?.(nextImmersiveMode);
        return () => {
            onImmersiveModeChange?.(false);
        };
    }, [editorDescriptor?.draftType, mode, onImmersiveModeChange]);

    const handleConfirmEditorScript = useCallback(async () => {
        if (!editorFile || !isRemovedMediaDraftType(editorDescriptor?.draftType)) return;
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
            const result = await window.ipcRenderer.media.bind({
                assetId,
                manuscriptPath: editorFile,
                role: bindAssetRole,
            }) as { success?: boolean; error?: string; state?: PackageState };
            if (!result?.success) {
                throw new Error(result?.error || '绑定素材失败');
            }
            await Promise.all([
                loadTree(),
                loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT),
            ]);
            await loadBoundAssetsForEditor(editorFile);
            if (result.state) {
                applyPackageState(editorFile, result.state);
            } else {
                await refreshPackageState(editorFile);
            }
            setIsBindAssetModalOpen(false);
        } catch (bindError) {
            void appAlert(bindError instanceof Error ? bindError.message : '绑定素材失败');
        }
    }, [applyPackageState, bindAssetRole, editorFile, loadAssets, loadBoundAssetsForEditor, loadTree, refreshPackageState]);

    const handlePreviewBoundAsset = useCallback((asset: MediaAsset) => {
        const src = asset.previewUrl || asset.absolutePath || asset.relativePath || '';
        if (!src || asset.exists === false) {
            void appAlert('媒体资产没有可预览的文件');
            return;
        }
        setPreviewAsset({ asset, src });
    }, []);

    const handleUnbindBoundAsset = useCallback(async (asset: MediaAsset) => {
        if (!editorFile) return;
        setWorkingId(`unbind:${asset.id}`);
        try {
            const result = await window.ipcRenderer.media.bind({
                assetId: asset.id,
                manuscriptPath: '',
            }) as { success?: boolean; error?: string; asset?: MediaAsset };
            if (!result?.success) {
                throw new Error(result?.error || '移除配图失败');
            }
            setPreviewAsset((current) => current?.asset.id === asset.id ? null : current);
            setAssets((current) => current.map((item) => (
                item.id === asset.id
                    ? {
                        ...(result.asset || item),
                        boundManuscriptPath: undefined,
                    }
                    : item
            )));
            await loadAssets(MANUSCRIPTS_ACTIVE_ASSET_LIMIT);
            await loadBoundAssetsForEditor(editorFile);
        } catch (unbindError) {
            void appAlert(unbindError instanceof Error ? unbindError.message : '移除配图失败');
        } finally {
            setWorkingId(null);
        }
    }, [editorFile, loadAssets, loadBoundAssetsForEditor]);

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
                quality: quality.trim() || 'medium',
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
                videoProjectPath: undefined,
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
        const metaContentFormat = String(editorMetadata.contentFormat || fileMetaMap[editorFile]?.contentFormat || '').trim();
        const isDocumentContent = metaContentFormat === 'document' || draftType === 'document';
        const contentFormat = !isDocumentContent && metaContentFormat === 'html'
            ? 'html'
            : manuscriptContentFormatFromPath(editorFile);
        const fileBaseUrl = String(editorMetadata.fileBaseUrl || '').trim();
        const draftStyle = resolveDraftTypeStyle(draftType);
        const isImmersiveWorkbench = mode === 'editor';
        const isArticlePackage = draftType === 'longform';
        const canBindMediaAssets = !isDocumentContent && (isArticlePackage || contentFormat === 'markdown');
        const isScriptConfirmed = (
            packageState?.videoProject?.scriptApproval?.status
            || packageState?.editorProject?.ai?.scriptApproval?.status
        ) === 'confirmed';
        const editorWriteProposalBaseDraft = editorWriteProposal
            ? splitWritingDraftContent(editorWriteProposal.baseContent, draftType)
            : null;
        const editorWriteProposalView = !isDocumentContent && editorWriteProposal && editorWriteProposalBaseDraft ? {
            id: editorWriteProposal.id,
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
            .filter((asset) => isSameDraftRelativePath(asset.boundManuscriptPath, editorFile))
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
        const fallbackTrackNames = ['V1', 'T1'];
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
                        {isDocumentContent ? (
                            <div className={clsx(
                                'flex shrink-0 items-center gap-0.5 rounded-lg p-0.5',
                                isImmersiveWorkbench
                                    ? 'border border-border bg-surface-secondary/50'
                                    : 'border border-black/[0.04] bg-black/[0.03]'
                            )}>
                                <button
                                    type="button"
                                    onClick={() => void handleOpenEditorDocument()}
                                    aria-label="打开"
                                    title="打开"
                                    disabled={!editorFile || Boolean(workingId)}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-all hover:bg-surface-secondary/80 hover:text-text-primary active:scale-95 disabled:opacity-35"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleRevealEditorDocument()}
                                    aria-label="在文件夹中显示"
                                    title="在文件夹中显示"
                                    disabled={!editorFile || Boolean(workingId)}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-all hover:bg-surface-secondary/80 hover:text-text-primary active:scale-95 disabled:opacity-35"
                                >
                                    <FolderOpen className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleSaveAsEditorDocument()}
                                    aria-label="下载"
                                    title="下载"
                                    disabled={!editorFile || Boolean(workingId)}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-all hover:bg-surface-secondary/80 hover:text-text-primary active:scale-95 disabled:opacity-35"
                                >
                                    {workingId === 'save-as:document' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                </button>
                            </div>
                        ) : (
                            <div className={clsx(
                                'flex shrink-0 items-center gap-0.5 rounded-lg p-0.5',
                                isImmersiveWorkbench
                                    ? 'border border-border bg-surface-secondary/50'
                                    : 'border border-black/[0.04] bg-black/[0.03]'
                            )}>
                                <button
                                    type="button"
                                    onClick={() => setEditorBodyViewMode('edit')}
                                    aria-label="编辑"
                                    title="编辑"
                                    aria-pressed={editorBodyViewMode === 'edit'}
                                    className={clsx(
                                        'inline-flex h-8 w-8 items-center justify-center rounded-md transition-all active:scale-95',
                                        editorBodyViewMode === 'edit'
                                            ? 'bg-accent-primary text-white shadow-sm'
                                            : 'text-text-tertiary hover:bg-surface-secondary/80 hover:text-text-primary'
                                    )}
                                >
                                    <Pencil className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setEditorBodyViewMode('preview')}
                                    aria-label="预览"
                                    title="预览"
                                    aria-pressed={editorBodyViewMode === 'preview'}
                                    className={clsx(
                                        'inline-flex h-8 w-8 items-center justify-center rounded-md transition-all active:scale-95',
                                        editorBodyViewMode === 'preview'
                                            ? 'bg-accent-primary text-white shadow-sm'
                                            : 'text-text-tertiary hover:bg-surface-secondary/80 hover:text-text-primary'
                                    )}
                                >
                                    <Eye className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void handleDownloadEditorFile();
                                    }}
                                    aria-label="下载"
                                    title="下载"
                                    disabled={!editorFile || Boolean(workingId) || isSavingEditorBody}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-all hover:bg-surface-secondary/80 hover:text-text-primary active:scale-95 disabled:opacity-35"
                                >
                                    {workingId === 'download:editor' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                </button>
                            </div>
                        )}
                        {!isDocumentContent && (editorBodyDirty || isSavingEditorBody) ? (
                            <div className={clsx(
                                'shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium',
                                isImmersiveWorkbench
                                    ? 'border border-border bg-surface-secondary/50 text-text-tertiary'
                                    : 'border border-black/[0.04] bg-black/[0.03] text-text-tertiary'
                            )}>
                                {isSavingEditorBody ? '保存中' : '未保存'}
                            </div>
                        ) : null}
                        {editorWriteProposalView ? (
                            <div className={clsx(
                                'flex shrink-0 items-center gap-1 rounded-lg p-0.5',
                                isImmersiveWorkbench
                                    ? 'border border-border bg-surface-secondary/50'
                                    : 'border border-black/[0.04] bg-black/[0.03]'
                            )}>
                                {editorWriteProposalView.isStale ? (
                                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-700" title="稿件在提案生成后发生过变化" aria-label="稿件在提案生成后发生过变化">
                                        <AlertTriangle className="h-4 w-4" />
                                    </span>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() => {
                                        void handleRejectEditorWriteProposal();
                                    }}
                                    disabled={isApplyingWriteProposal || isRejectingWriteProposal}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition hover:bg-surface-secondary/80 hover:text-text-primary disabled:opacity-35"
                                    aria-label="拒绝 AI 修改"
                                    title="拒绝 AI 修改"
                                >
                                    {isRejectingWriteProposal ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void handleAcceptEditorWriteProposal();
                                    }}
                                    disabled={isApplyingWriteProposal || isRejectingWriteProposal}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent-primary text-white transition hover:bg-accent-primary/92 disabled:opacity-35"
                                    aria-label="接受 AI 修改"
                                    title="接受 AI 修改"
                                >
                                    {isApplyingWriteProposal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                </button>
                            </div>
                        ) : null}
                        {canBindMediaAssets && (
                            <div className="flex items-center gap-1">
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

                    </div>
                </div>
                {isDocumentContent ? (
                    <DocumentPreviewWorkbench filePath={editorFile} title={currentDescriptor.title} />
                ) : (
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">写作工作台加载中...</div>}>
                        <WritingDraftWorkbench
                            isActive={isActive}
                            draftType={draftType === 'longform' || draftType === 'html' ? draftType : 'unknown'}
                            title={currentDescriptor.title}
                            filePath={editorFile}
                            editorBody={editorWriteProposalView ? editorReviewBody : editorBody}
                            bodyViewMode={editorBodyViewMode}
                            contentFormat={contentFormat}
                            fileBaseUrl={fileBaseUrl}
                            boundAssets={manuscriptBoundAssets}
                            writeProposal={editorWriteProposalView}
                            editorChatSessionId={editorChatSessionId}
                            editorChatReady={editorChatSessionReady}
                            editorSessionMetadata={editorChatBinding?.metadata ?? null}
                            onEditorBodyChange={(value) => {
                                if (editorWriteProposalView) {
                                    editorReviewBodyRef.current = value;
                                    setEditorReviewBody(value);
                                    return;
                                }
                                editorBodyRef.current = value;
                                editorBodyDirtyRef.current = true;
                                setEditorBody(value);
                                setEditorBodyDirty(true);
                            }}
                            onRequestBindImages={() => {
                                setBindAssetRole('image');
                                setIsBindAssetModalOpen(true);
                            }}
                            onPreviewAsset={handlePreviewBoundAsset}
                            onRemoveBoundImage={(asset) => {
                                void handleUnbindBoundAsset(asset);
                            }}
                            onAiWorkspaceModeChange={setEditorAiWorkspaceMode}
                        />
                    </Suspense>
                )}
                {isBindAssetModalOpen && (
                    <div
                        className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/38 p-6 backdrop-blur-sm"
                        onClick={() => setIsBindAssetModalOpen(false)}
                    >
                        <div
                            className="flex max-h-[78vh] w-[min(760px,92vw)] min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-primary shadow-2xl"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <div className="flex items-center justify-between border-b border-border px-4 py-3">
                                <div className="flex items-center gap-2 text-sm font-bold text-text-primary">
                                    <Paperclip className="h-4 w-4 text-text-tertiary" />
                                    {bindAssetRole === 'cover' ? '绑定封面' : bindAssetRole === 'image' ? '插入配图' : '绑定素材'}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => void handleImportAndBindAssetsToPackage()}
                                        disabled={workingId === 'media-import-bind'}
                                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-secondary/60 px-2.5 text-xs font-bold text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary disabled:opacity-45"
                                    >
                                        {workingId === 'media-import-bind' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                                        导入
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setIsBindAssetModalOpen(false)}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
                                        aria-label="关闭"
                                        title="关闭"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                                {bindableAssets.length === 0 ? (
                                    <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-text-tertiary">
                                        暂无可绑定素材
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
                                        {bindableAssets.map((asset) => {
                                            const kind = inferAssetKind(asset);
                                            const src = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
                                            const isWorking = workingId === asset.id;
                                            return (
                                                <button
                                                    key={asset.id}
                                                    type="button"
                                                    onClick={() => void handleBindAssetToPackage(asset.id)}
                                                    disabled={isWorking}
                                                    className="group min-w-0 overflow-hidden rounded-lg border border-border bg-surface-secondary/45 text-left transition hover:border-accent-primary/40 hover:bg-surface-secondary disabled:opacity-55"
                                                >
                                                    <div className="flex aspect-square items-center justify-center overflow-hidden bg-background text-text-tertiary">
                                                        {kind === 'image' && src ? (
                                                            <img src={src} alt={asset.title || asset.id} className="h-full w-full object-cover transition group-hover:scale-[1.02]" loading="lazy" />
                                                        ) : kind === 'video' ? (
                                                            <FileVideo className="h-7 w-7" />
                                                        ) : kind === 'audio' ? (
                                                            <FileAudio className="h-7 w-7" />
                                                        ) : (
                                                            <FileText className="h-7 w-7" />
                                                        )}
                                                    </div>
                                                    <div className="min-w-0 px-2.5 py-2">
                                                        <div className="truncate text-xs font-bold text-text-primary">
                                                            {asset.title || asset.relativePath || asset.id}
                                                        </div>
                                                        <div className="mt-1 truncate text-[10px] uppercase tracking-tight text-text-tertiary">
                                                            {isWorking ? '绑定中' : kind}
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
                <MediaAssetPreviewOverlay preview={previewAsset} onClose={() => setPreviewAsset(null)} />
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
