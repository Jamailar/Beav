import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { PlayerRef } from '@remotion/player';
import { AudioLines, Check, ChevronsUpDown, Clapperboard, Image as ImageIcon, Plus, SlidersHorizontal, Sparkles, Type, Upload, Video } from 'lucide-react';
import { VideoEditorSidebarShell } from './VideoEditorSidebarShell';
import { VideoEditorStageShell } from './VideoEditorStageShell';
import { VideoEditorTimelineShell } from './VideoEditorTimelineShell';
import { TimelinePreviewComposition } from './TimelinePreviewComposition';
import { RemotionTransportBar } from './remotion/RemotionTransportBar';
import { RemotionVideoPreview } from './remotion/RemotionVideoPreview';
import type { RemotionCompositionConfig, RemotionScene } from './remotion/types';
import { createVideoEditorStore, useVideoEditorStore, type VideoEditorRatioPreset } from '../../features/video-editor/store/useVideoEditorStore';
import { resolveAssetUrl } from '../../utils/pathManager';
import { subscribeRuntimeEventStream } from '../../runtime/runtimeEventStream';
import {
    applyEditorCommandLocal,
    deriveAnimationLayers,
    deriveProjectedEditorItems,
    buildRemotionCompositionFromEditorProject,
    buildAssetMap,
    type EditorCommand,
    deriveLegacyTimelineClips,
    deriveTrackNames,
    deriveTrackUiMap,
    isMotionItem,
    type EditorAsset,
    type EditorMotionItem,
    type EditorProjectFile,
} from './editorProject';
import { ExperimentalTimeline } from './ExperimentalTimeline';

const ChatWorkspace = lazy(async () => ({
    default: (await import('../../pages/Chat')).Chat,
}));

const RATIO_PRESET_OPTIONS: Array<{ preset: VideoEditorRatioPreset; label: string; width: number; height: number }> = [
    { preset: '9:16', label: '9:16', width: 1080, height: 1920 },
    { preset: '3:4', label: '3:4', width: 1080, height: 1440 },
    { preset: '16:9', label: '16:9', width: 1920, height: 1080 },
    { preset: '4:3', label: '4:3', width: 1440, height: 1080 },
];

type MediaAssetLike = {
    id: string;
    title?: string;
    relativePath?: string;
    absolutePath?: string;
    previewUrl?: string;
    mimeType?: string;
};

type PackageStateLike = Record<string, unknown> & {
    editorProject?: EditorProjectFile | null;
};

type ChatResizeState = {
    startX: number;
    chatPaneWidth: number;
};

type SidebarTabId = 'assets' | 'video' | 'audio' | 'text' | 'elements' | 'selection';

type SharedAnimationElement = {
    id: string;
    name: string;
    storageKey?: string;
    source?: 'builtin' | 'workspace';
    componentType?: string;
    durationMs?: number;
    renderMode?: 'motion-layer' | 'full';
    props?: Record<string, unknown>;
    entities?: RemotionScene['entities'];
};

type ExperimentalVideoWorkbenchProps = {
    title: string;
    editorFile: string;
    packageState?: PackageStateLike | null;
    packagePreviewAssets: MediaAssetLike[];
    primaryVideoAsset?: MediaAssetLike | null;
    packageAssets?: Array<Record<string, unknown>>;
    timelineClipCount?: number;
    timelineTrackNames?: string[];
    timelineClips?: Array<Record<string, unknown>>;
    editorBody: string;
    editorBodyDirty: boolean;
    isSavingEditorBody: boolean;
    materialsCollapsed?: boolean;
    timelineCollapsed?: boolean;
    isActive?: boolean;
    editorChatSessionId: string | null;
    remotionComposition?: RemotionCompositionConfig | null;
    remotionRenderPath?: string | null;
    isGeneratingRemotion?: boolean;
    isRenderingRemotion?: boolean;
    onEditorBodyChange: (value: string) => void;
    onOpenBindAssets: () => void;
    onPackageStateChange: (state: PackageStateLike) => void;
    onConfirmScript?: () => void;
    onGenerateRemotionScene?: (instructions?: string) => void;
    onSaveRemotionScene?: (scene: RemotionCompositionConfig) => void;
    onRenderRemotionVideo: () => void;
    onOpenRenderedVideo?: () => void;
};

function normalizeAssetFromPreviewAsset(asset: MediaAssetLike): EditorAsset {
    const src = String(asset.absolutePath || asset.previewUrl || asset.relativePath || '').trim();
    const mimeType = String(asset.mimeType || '').trim().toLowerCase();
    const kind = mimeType.startsWith('audio/')
        ? 'audio'
        : mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('text/')
                ? 'text'
                : 'video';
    return {
        id: asset.id,
        kind,
        title: String(asset.title || asset.id || '素材'),
        src,
        mimeType: asset.mimeType,
        durationMs: kind === 'image' ? 1500 : null,
        metadata: {
            relativePath: asset.relativePath || null,
            absolutePath: asset.absolutePath || null,
            previewUrl: asset.previewUrl || null,
        },
    };
}

function inferAssetKindFromEditorAsset(asset: EditorAsset): 'video' | 'audio' | 'image' | 'text' {
    if (asset.kind === 'audio') return 'audio';
    if (asset.kind === 'image') return 'image';
    if (asset.kind === 'text' || asset.kind === 'subtitle') return 'text';
    return 'video';
}

function projectDurationMs(project: EditorProjectFile): number {
    return deriveProjectedEditorItems(project).reduce((max, item) => Math.max(max, item.fromMs + item.durationMs), 0);
}

function inferSceneFromMotion(project: EditorProjectFile, motionItem: EditorMotionItem | null) {
    if (!motionItem) return null;
    const composition = buildRemotionCompositionFromEditorProject(project);
    return composition.scenes.find((scene) => scene.id === motionItem.id || scene.clipId === motionItem.bindItemId) || null;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

export function ExperimentalVideoWorkbench({
    title,
    editorFile,
    packageState,
    packagePreviewAssets,
    primaryVideoAsset,
    packageAssets: _packageAssets,
    timelineClipCount: _timelineClipCount,
    timelineTrackNames: _timelineTrackNames,
    timelineClips: _timelineClips,
    editorBody,
    editorBodyDirty,
    isSavingEditorBody,
    materialsCollapsed = false,
    timelineCollapsed = false,
    isActive = true,
    editorChatSessionId,
    remotionComposition: _remotionComposition,
    remotionRenderPath: _remotionRenderPath,
    isGeneratingRemotion: _isGeneratingRemotion = false,
    isRenderingRemotion: _isRenderingRemotion = false,
    onEditorBodyChange,
    onOpenBindAssets,
    onPackageStateChange,
    onConfirmScript,
    onGenerateRemotionScene: _onGenerateRemotionScene,
    onSaveRemotionScene: _onSaveRemotionScene,
    onRenderRemotionVideo,
    onOpenRenderedVideo,
}: ExperimentalVideoWorkbenchProps) {
    const editorStoreRef = useRef(createVideoEditorStore());
    const editorStore = editorStoreRef.current;
    const remotionPlayerRef = useRef<PlayerRef | null>(null);
    const [localProject, setLocalProject] = useState<EditorProjectFile | null>(packageState?.editorProject || null);
    const [saveNonce, setSaveNonce] = useState(0);
    const [isGeneratingMotion, setIsGeneratingMotion] = useState(false);
    const [isTranscribingSubtitles, setIsTranscribingSubtitles] = useState(false);
    const [subtitleTranscriptionNotice, setSubtitleTranscriptionNotice] = useState<string | null>(null);
    const [chatPaneWidth, setChatPaneWidth] = useState(420);
    const [chatResizeState, setChatResizeState] = useState<ChatResizeState | null>(null);
    const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTabId>('assets');
    const [ratioMenuOpen, setRatioMenuOpen] = useState(false);
    const [sharedAnimationElements, setSharedAnimationElements] = useState<SharedAnimationElement[]>([]);
    const [elementsContextMenu, setElementsContextMenu] = useState<{ x: number; y: number; elementId: string } | null>(null);
    const [stageSelection, setStageSelection] = useState<{
        ids: string[];
        primaryId: string | null;
        kind: 'asset' | 'overlay' | 'title' | 'text' | 'subtitle' | null;
    }>({ ids: [], primaryId: null, kind: null });

    const previewTab = useVideoEditorStore(editorStore, (state) => state.player.previewTab);
    const isPlaying = useVideoEditorStore(editorStore, (state) => state.player.isPlaying);
    const currentTime = useVideoEditorStore(editorStore, (state) => state.player.currentTime);
    const zoomPercent = useVideoEditorStore(editorStore, (state) => state.timeline.zoomPercent);
    const selection = useVideoEditorStore(editorStore, (state) => state.editor.selection);
    const selectedAssetId = useVideoEditorStore(editorStore, (state) => state.assets.selectedAssetId);
    const drawerOpen = useVideoEditorStore(editorStore, (state) => state.panels.redclawDrawerOpen);

    useEffect(() => {
        if (!packageState?.editorProject) return;
        setLocalProject(packageState.editorProject);
        editorStore.setState((state) => ({
            editor: {
                ...state.editor,
                projectFile: packageState.editorProject || null,
            },
        }));
    }, [editorStore, packageState?.editorProject]);

    useEffect(() => {
        let cancelled = false;
        void window.ipcRenderer.invoke('animation-elements:list')
            .then((result) => {
                if (cancelled) return;
                const items = Array.isArray((result as { items?: SharedAnimationElement[] } | null)?.items)
                    ? ((result as { items?: SharedAnimationElement[] }).items || [])
                    : [];
                setSharedAnimationElements(items);
            })
            .catch((error) => {
                console.error('Failed to load animation elements:', error);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!isActive || !editorChatSessionId) return;
        const parseJsonOutput = (raw: unknown): Record<string, unknown> | null => {
            const text = String(raw || '').trim();
            if (!text) return null;
            try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
                return null;
            }
        };
        return subscribeRuntimeEventStream({
            getActiveSessionId: () => editorChatSessionId,
            onToolResult: ({ name, output }) => {
                if (name !== 'redbox_editor' || !output?.success) return;
                const parsed = parseJsonOutput(output.content);
                const nextState = parsed?.state;
                if (nextState && typeof nextState === 'object') {
                    onPackageStateChange(nextState as PackageStateLike);
                }
            },
            onTaskCheckpointSaved: ({ checkpointType }) => {
                if (checkpointType === 'editor.script_changed') {
                    setPreviewTab('script');
                }
            },
        });
    }, [editorChatSessionId, isActive, onPackageStateChange]);

    useEffect(() => {
        if (!localProject) return;
        const projectedItems = deriveProjectedEditorItems(localProject);
        editorStore.setState((state) => ({
            editor: {
                ...state.editor,
                projectFile: localProject,
                derived: {
                    ...state.editor.derived,
                    durationMs: projectDurationMs(localProject),
                    visibleItems: projectedItems.filter((item) => {
                        const track = localProject.tracks.find((candidate) => candidate.id === item.trackId);
                        return !track?.ui.hidden && item.enabled;
                    }),
                    audibleItems: projectedItems.filter((item) => {
                        const track = localProject.tracks.find((candidate) => candidate.id === item.trackId);
                        return (track?.kind === 'audio' || (item.type === 'media' && track?.kind === 'video')) && !track?.ui.muted && item.enabled;
                    }),
                    activeMotionItems: projectedItems.filter(isMotionItem),
                },
            },
        }));
    }, [editorStore, localProject]);

    useEffect(() => {
        if (!localProject) return;
        const timer = window.setTimeout(() => {
            void window.ipcRenderer.invoke('manuscripts:save-editor-project', {
                filePath: editorFile,
                project: {
                    ...localProject,
                    script: {
                        ...localProject.script,
                        body: editorBody,
                    },
                },
            }).then((result) => {
                if (result?.success && result.state) {
                    onPackageStateChange(result.state as PackageStateLike);
                }
            }).catch((error) => {
                console.error('Failed to save experimental editor project:', error);
            });
        }, 220);
        return () => window.clearTimeout(timer);
    }, [editorBody, editorFile, localProject, onPackageStateChange, saveNonce]);

    useEffect(() => {
        if (!isPlaying || !localProject) return;
        const durationSeconds = projectDurationMs(localProject) / 1000;
        const frameStep = 1 / Math.max(1, localProject.project.fps);
        const timer = window.setInterval(() => {
            editorStore.setState((state) => {
                const nextTime = Math.min(durationSeconds, state.player.currentTime + frameStep);
                const reachedEnd = nextTime >= durationSeconds;
                return {
                    player: {
                        ...state.player,
                        currentTime: nextTime,
                        currentFrame: Math.round(nextTime * localProject.project.fps),
                        isPlaying: reachedEnd ? false : state.player.isPlaying,
                    },
                };
            });
        }, 1000 / Math.max(1, localProject.project.fps));
        return () => window.clearInterval(timer);
    }, [editorStore, isPlaying, localProject]);

    useEffect(() => {
        if (!chatResizeState) return;

        const handlePointerMove = (event: PointerEvent) => {
            const deltaX = chatResizeState.startX - event.clientX;
            setChatPaneWidth(clamp(chatResizeState.chatPaneWidth + deltaX, 320, 720));
        };

        const handlePointerUp = () => {
            setChatResizeState(null);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [chatResizeState]);

    useEffect(() => {
        if (!elementsContextMenu) return;
        const closeMenu = () => setElementsContextMenu(null);
        window.addEventListener('pointerdown', closeMenu);
        window.addEventListener('scroll', closeMenu, true);
        return () => {
            window.removeEventListener('pointerdown', closeMenu);
            window.removeEventListener('scroll', closeMenu, true);
        };
    }, [elementsContextMenu]);

    const updateProject = (nextProject: EditorProjectFile) => {
        setLocalProject(nextProject);
        setSaveNonce((value) => value + 1);
    };

    const handleChangeRatioPreset = (preset: VideoEditorRatioPreset) => {
        if (!localProject) return;
        const nextOption = RATIO_PRESET_OPTIONS.find((option) => option.preset === preset);
        if (!nextOption) return;
        updateProject({
            ...localProject,
            project: {
                ...localProject.project,
                ratioPreset: nextOption.preset,
                width: nextOption.width,
                height: nextOption.height,
            },
        });
        setRatioMenuOpen(false);
    };

    const dispatchEditorCommands = async (commands: EditorCommand[]) => {
        if (!localProject || commands.length === 0) return;
        let optimisticProject = localProject;
        commands.forEach((command) => {
            optimisticProject = applyEditorCommandLocal(optimisticProject, command);
        });
        updateProject(optimisticProject);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:apply-editor-commands', {
                filePath: editorFile,
                commands,
            }) as { success?: boolean; state?: PackageStateLike };
            if (result?.success && result.state) {
                onPackageStateChange(result.state);
            }
        } catch (error) {
            console.error('Failed to apply editor commands:', error);
        }
    };

    const timelineClips = useMemo(() => localProject ? deriveLegacyTimelineClips(localProject) : [], [localProject]);
    const trackUi = useMemo(() => localProject ? deriveTrackUiMap(localProject) : {}, [localProject]);
    const trackOrder = useMemo(() => localProject ? deriveTrackNames(localProject, false) : [], [localProject]);
    const assetsById = useMemo(() => localProject ? buildAssetMap(localProject) : {}, [localProject]);
    const remotionComposition = useMemo(
        () => _remotionComposition || (localProject ? buildRemotionCompositionFromEditorProject(localProject) : null),
        [_remotionComposition, localProject]
    );
    const projectedItems = useMemo(() => localProject ? deriveProjectedEditorItems(localProject) : [], [localProject]);
    const animationLayers = useMemo(() => localProject ? deriveAnimationLayers(localProject) : [], [localProject]);
    const motionItems = useMemo(() => projectedItems.filter(isMotionItem), [projectedItems]);
    const selectedMotionItem = useMemo(() => {
        if (!localProject) return null;
        return projectedItems.find((item) => item.id === selection.primaryItemId && item.type === 'motion') as EditorMotionItem | null
            || (motionItems[0] as EditorMotionItem | undefined)
            || null;
    }, [localProject, motionItems, projectedItems, selection.primaryItemId]);
    const selectedScene = useMemo(() => localProject ? inferSceneFromMotion(localProject, selectedMotionItem) : null, [localProject, selectedMotionItem]);
    const scriptConfirmed = localProject?.ai?.scriptApproval?.status === 'confirmed';
    const scriptStatusLabel = isSavingEditorBody
        ? '脚本保存中...'
        : editorBodyDirty
            ? '脚本待保存'
            : scriptConfirmed
                ? '脚本已确认'
                : '脚本待确认';
    const selectedEditorItem = useMemo(
        () => projectedItems.find((item) => item.id === selection.primaryItemId) || null,
        [projectedItems, selection.primaryItemId]
    );
    const selectedEditorTrack = useMemo(
        () => selectedEditorItem ? localProject?.tracks.find((track) => track.id === selectedEditorItem.trackId) || null : null,
        [localProject, selectedEditorItem]
    );
    const selectedAsset = useMemo(() => {
        if (!localProject) return null;
        if (selectedAssetId) {
            return localProject.assets.find((asset) => asset.id === selectedAssetId) || null;
        }
        if (selectedEditorItem?.type === 'media') {
            return localProject.assets.find((asset) => asset.id === selectedEditorItem.assetId) || null;
        }
        return null;
    }, [localProject, selectedAssetId, selectedEditorItem]);
    const subtitleRecognitionItem = useMemo(() => {
        if (!localProject) return null;
        const isTranscribableMediaItem = (item: typeof projectedItems[number]) => {
            if (item.type !== 'media') return false;
            const asset = localProject.assets.find((candidate) => candidate.id === item.assetId) || null;
            return asset?.kind === 'audio' || asset?.kind === 'video';
        };
        const primarySelected = projectedItems.find((item) => item.id === selection.primaryItemId) || null;
        if (primarySelected && isTranscribableMediaItem(primarySelected)) {
            return primarySelected;
        }
        return projectedItems.find((item) => (
            isTranscribableMediaItem(item)
            && currentTime * 1000 >= item.fromMs
            && currentTime * 1000 <= item.fromMs + item.durationMs
        )) || null;
    }, [currentTime, localProject, projectedItems, selection.primaryItemId]);
    const selectedStageTransform = useMemo(
        () => stageSelection.primaryId ? localProject?.stage.itemTransforms[stageSelection.primaryId] || null : null,
        [localProject, stageSelection.primaryId]
    );
    const filteredAssets = useMemo(() => {
        const assets = packagePreviewAssets;
        if (activeSidebarTab === 'video') {
            return assets.filter((asset) => {
                const normalized = normalizeAssetFromPreviewAsset(asset);
                return normalized.kind === 'video' || normalized.kind === 'image';
            });
        }
        if (activeSidebarTab === 'audio') {
            return assets.filter((asset) => normalizeAssetFromPreviewAsset(asset).kind === 'audio');
        }
        if (activeSidebarTab === 'text') {
            return assets.filter((asset) => {
                const normalized = normalizeAssetFromPreviewAsset(asset);
                return normalized.kind === 'text' || normalized.kind === 'subtitle';
            });
        }
        return assets;
    }, [activeSidebarTab, packagePreviewAssets]);

    const setPreviewTab = (tab: 'preview' | 'motion' | 'script') => {
        editorStore.setState((state) => ({
            player: {
                ...state.player,
                previewTab: tab,
            },
        }));
    };

    const setSelection = (nextSelection: { itemIds: string[]; primaryItemId: string | null; trackIds: string[] }) => {
        editorStore.setState((state) => ({
            editor: {
                ...state.editor,
                selection: nextSelection,
            },
        }));
    };

    const setSelectedAsset = (assetId: string | null) => {
        editorStore.setState((state) => ({
            assets: {
                ...state.assets,
                selectedAssetId: assetId,
            },
        }));
    };

    const appendAssetToTimeline = async (assetLike: MediaAssetLike) => {
        if (!localProject) return;
        const asset = normalizeAssetFromPreviewAsset(assetLike);
        const desiredKind = asset.kind === 'audio' ? 'audio' : asset.kind === 'text' ? 'text' : asset.kind === 'subtitle' ? 'subtitle' : 'video';
        const selectedTrackId = selection.trackIds[0] || null;
        const selectedTrack = selectedTrackId ? localProject.tracks.find((track) => track.id === selectedTrackId) || null : null;
        const targetTrack = selectedTrack?.kind === desiredKind
            ? selectedTrack
            : localProject.tracks
                .filter((track) => track.kind === desiredKind)
                .sort((left, right) => left.order - right.order)
                .at(-1)
            || null;
        const targetTrackId = targetTrack?.id || `${desiredKind === 'audio' ? 'A' : desiredKind === 'subtitle' ? 'S' : desiredKind === 'text' ? 'T' : 'V'}1`;
        const appendAtMs = localProject.items
            .filter((item) => item.trackId === targetTrackId)
            .reduce((max, item) => Math.max(max, item.fromMs + item.durationMs), 0);
        const nextItemId = `item-${Math.random().toString(36).slice(2, 10)}`;
        const commands: EditorCommand[] = [];
        if (!localProject.assets.some((existing) => existing.id === asset.id)) {
            commands.push({ type: 'upsert_assets', assets: [asset] });
        }
        if (!localProject.tracks.some((track) => track.id === targetTrackId)) {
            commands.push({ type: 'add_track', kind: desiredKind, trackId: targetTrackId });
        }
        commands.push({
            type: 'add_item',
            item: {
                id: nextItemId,
                type: 'media',
                trackId: targetTrackId,
                assetId: asset.id,
                fromMs: appendAtMs,
                durationMs: Math.max(500, Number(asset.durationMs || (asset.kind === 'image' ? 1500 : 4000))),
                trimInMs: 0,
                trimOutMs: 0,
                enabled: true,
            },
        });
        await dispatchEditorCommands(commands);
        setSelection({ itemIds: [nextItemId], primaryItemId: nextItemId, trackIds: [] });
        seekTimeMs(appendAtMs);
    };

    const insertSharedAnimationElement = async (element: SharedAnimationElement) => {
        if (!localProject) return;
        const selectedMotionTrackId = selection.trackIds.find((trackId) => {
            const track = localProject.tracks.find((candidate) => candidate.id === trackId);
            return track?.kind === 'motion';
        }) || null;
        const motionTrackId = selectedMotionTrackId
            || localProject.tracks.filter((track) => track.kind === 'motion').sort((left, right) => left.order - right.order)[0]?.id
            || 'M1';
        const appendAtMs = animationLayers
            .filter((layer) => layer.trackId === motionTrackId)
            .reduce((max, layer) => Math.max(max, layer.fromMs + layer.durationMs), 0);
        const commands: EditorCommand[] = [];
        if (!localProject.tracks.some((track) => track.id === motionTrackId)) {
            commands.push({ type: 'add_track', kind: 'motion', trackId: motionTrackId });
        }
        commands.push({
            type: 'animation_layer_create',
            layer: {
                id: `anim-${Math.random().toString(36).slice(2, 10)}`,
                name: element.name || '动画元素',
                trackId: motionTrackId,
                enabled: true,
                fromMs: appendAtMs,
                durationMs: Math.max(300, Number(element.durationMs || 2000)),
                zIndex: animationLayers.length,
                renderMode: element.renderMode || 'motion-layer',
                componentType: element.componentType || 'scene-sequence',
                props: {
                    ...(element.props || {}),
                    templateId: String(element.props?.templateId || 'static'),
                },
                entities: Array.isArray(element.entities) ? element.entities : [],
                bindings: [],
            },
        });
        await dispatchEditorCommands(commands);
    };

    const deleteSharedAnimationElement = async (element: SharedAnimationElement) => {
        if (element.source === 'builtin') return;
        try {
            const result = await window.ipcRenderer.invoke('animation-elements:delete', {
                storageKey: element.storageKey || element.id,
            }) as { success?: boolean };
            if (result?.success) {
                setSharedAnimationElements((current) => current.filter((item) => item.id !== element.id));
            }
        } catch (error) {
            console.error('Failed to delete animation element:', error);
        }
    };

    const saveSelectedAnimationElement = async () => {
        const selectedLayer = animationLayers.find((layer) => layer.id === selectedMotionItem?.id);
        if (!selectedLayer) return;
        try {
            const result = await window.ipcRenderer.invoke('animation-elements:save', {
                name: selectedLayer.name,
                layer: selectedLayer,
            }) as { success?: boolean; item?: SharedAnimationElement };
            if (result?.success && result.item) {
                setSharedAnimationElements((current) => {
                    const next = current.filter((item) => item.id !== result.item?.id);
                    next.push(result.item);
                    return next;
                });
            }
        } catch (error) {
            console.error('Failed to save animation element:', error);
        }
    };

    const handleAutoTranscribeSubtitles = async () => {
        const clipId = String(subtitleRecognitionItem?.id || '').trim();
        if (!editorFile || !clipId || isTranscribingSubtitles) return;
        setIsTranscribingSubtitles(true);
        setSubtitleTranscriptionNotice(null);
        try {
            const selectedSubtitleTrackId = selection.trackIds.find((trackId) => {
                const track = localProject?.tracks.find((candidate) => candidate.id === trackId) || null;
                return track?.kind === 'subtitle';
            });
            const result = await window.ipcRenderer.invoke('manuscripts:transcribe-package-subtitles', {
                filePath: editorFile,
                clipId,
                track: selectedSubtitleTrackId || undefined,
            }) as {
                success?: boolean;
                error?: string;
                subtitleCount?: number;
                subtitleFile?: string;
                insertedClipId?: string;
                state?: PackageStateLike;
            };
            if (!result?.success || !result.state) {
                throw new Error(result?.error || '字幕识别失败');
            }
            onPackageStateChange(result.state);
            const insertedClipId = String(result.insertedClipId || '').trim();
            if (insertedClipId) {
                setSelection({ itemIds: [insertedClipId], primaryItemId: insertedClipId, trackIds: [] });
            }
            setSubtitleTranscriptionNotice(`已生成 ${Math.max(0, Number(result.subtitleCount || 0))} 段字幕`);
        } catch (error) {
            setSubtitleTranscriptionNotice(error instanceof Error ? error.message : String(error));
        } finally {
            setIsTranscribingSubtitles(false);
        }
    };

    const elementPreviewComposition = (element: SharedAnimationElement): RemotionCompositionConfig => ({
        version: 1,
        title: element.name,
        width: 360,
        height: 640,
        fps: 30,
        durationInFrames: Math.max(12, Math.round((Math.max(300, Number(element.durationMs || 2000)) / 1000) * 30)),
        backgroundColor: 'transparent',
        renderMode: element.renderMode || 'motion-layer',
        scenes: [{
            id: `${element.id}-preview`,
            startFrame: 0,
            durationInFrames: Math.max(12, Math.round((Math.max(300, Number(element.durationMs || 2000)) / 1000) * 30)),
            clipId: undefined,
            assetId: undefined,
            assetKind: 'unknown',
            src: '',
            trimInFrames: 0,
            motionPreset: String(element.props?.templateId || 'static') as RemotionScene['motionPreset'],
            overlayTitle: undefined,
            overlayBody: undefined,
            overlays: [],
            entities: Array.isArray(element.entities) ? element.entities : [],
        }],
    });

    const seekTimeMs = (timeMs: number) => {
        const safeTime = Math.max(0, timeMs);
        editorStore.setState((state) => ({
            player: {
                ...state.player,
                currentTime: safeTime / 1000,
                currentFrame: Math.round((safeTime / 1000) * (localProject?.project.fps || 30)),
            },
        }));
    };

    const generateMotionItems = async (instructions: string, selectedItemIds?: string[]) => {
        if (!localProject) return;
        setIsGeneratingMotion(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:generate-motion-items', {
                filePath: editorFile,
                instructions,
                selectedItemIds: selectedItemIds || [],
            }) as { success?: boolean; state?: PackageStateLike; brief?: string };
            if (result?.success && result.state) {
                onPackageStateChange(result.state);
            }
        } catch (error) {
            console.error('Failed to generate motion items:', error);
        } finally {
            setIsGeneratingMotion(false);
        }
    };

    const stageTitle = previewTab === 'motion' ? 'Motion Inspector' : previewTab === 'script' ? 'Script Workspace' : 'Stage Preview';
    const stageSubtitle = previewTab === 'motion'
        ? `${scriptStatusLabel} · 动画层预览直接读取 remotion.scene.json，可先预览和调整，最后再统一导出合成。`
        : previewTab === 'script'
            ? (scriptConfirmed ? '脚本已确认，可以继续剪辑与生成 motion。' : '先让 AI 改脚本文字并确认，再继续剪辑与生成 motion。')
            : 'Preview 继续负责低延迟校对与舞台布局，读取统一工程状态。';

    const sidebarTabs = [
        { id: 'assets', label: '全部', icon: Clapperboard },
        { id: 'video', label: '视频', icon: Video },
        { id: 'audio', label: '音频', icon: AudioLines },
        { id: 'text', label: '文本', icon: Type },
        { id: 'elements', label: '元素', icon: Sparkles },
        { id: 'selection', label: '属性', icon: SlidersHorizontal },
    ];
    const sidebarTitle = activeSidebarTab === 'selection'
        ? '属性'
        : activeSidebarTab === 'video'
            ? '视频素材'
            : activeSidebarTab === 'audio'
                ? '音频素材'
                : activeSidebarTab === 'elements'
                    ? '动画元素库'
                : activeSidebarTab === 'text'
                    ? '文本素材'
                    : '全部素材';
    const sidebarSubtitle = activeSidebarTab === 'selection'
        ? (
            selectedEditorItem
                ? `当前选中 ${selectedEditorItem.type === 'media' ? '时间轴素材' : selectedEditorItem.type}`
                : selectedAsset
                    ? `当前选中素材：${selectedAsset.title}`
                    : stageSelection.primaryId
                        ? `当前选中舞台对象：${stageSelection.kind || 'asset'}`
                        : '点击素材或时间轴对象后可查看属性'
        )
        : activeSidebarTab === 'elements'
            ? '工作区级共享动画元素库，所有视频工程可复用'
        : primaryVideoAsset
            ? `主预览：${primaryVideoAsset.title || primaryVideoAsset.id}`
            : '拖动素材到时间轴以创建 item';
    const sidebarTrackLabel = activeSidebarTab === 'selection'
        ? 'Inspector'
        : `${filteredAssets.length} Assets`;
    const stageGridClassName = materialsCollapsed ? 'col-start-1 row-start-1' : 'col-start-3 row-start-1';
    const timelineBarClassName = materialsCollapsed ? 'col-start-1 col-end-2 row-start-2' : 'col-start-1 col-end-4 row-start-2';
    const timelineSectionClassName = materialsCollapsed ? 'col-start-1 col-end-2 row-start-3' : 'col-start-1 col-end-4 row-start-3';
    const aiDividerClassName = materialsCollapsed ? 'col-start-2 row-start-1 row-span-3' : 'col-start-4 row-start-1 row-span-3';
    const aiPanelClassName = materialsCollapsed ? 'col-start-3 row-start-1 row-end-4' : 'col-start-5 row-start-1 row-end-4';

    const currentDurationFrames = remotionComposition?.durationInFrames || Math.max(90, Math.round((projectDurationMs(localProject || packageState?.editorProject || {
        version: 1,
        project: { id: '', title: '', width: 1080, height: 1920, fps: 30, ratioPreset: '9:16' },
        script: { body: '' },
        assets: [],
        tracks: [],
        items: [],
        animationLayers: [],
        stage: { itemTransforms: {}, itemVisibility: {}, itemLocks: {}, itemOrder: [], itemGroups: {}, focusedGroupId: null },
        ai: { motionPrompt: '' },
    } as EditorProjectFile) / 1000) * (localProject?.project.fps || 30)));
    const handleTogglePlayback = () => {
        const durationSeconds = Math.max(0, projectDurationMs(localProject) / 1000);
        const fps = Math.max(1, localProject.project.fps || 30);
        const endEpsilon = 1 / fps;

        editorStore.setState((state) => {
            if (state.player.isPlaying) {
                return {
                    player: {
                        ...state.player,
                        isPlaying: false,
                    },
                };
            }

            const shouldRestartFromBeginning = durationSeconds > 0 && state.player.currentTime >= durationSeconds - endEpsilon;
            const nextTime = shouldRestartFromBeginning ? 0 : state.player.currentTime;
            return {
                player: {
                    ...state.player,
                    currentTime: nextTime,
                    currentFrame: Math.round(nextTime * fps),
                    isPlaying: true,
                },
            };
        });
    };

    if (!localProject) {
        return (
            <div className="flex h-full items-center justify-center text-white/45">
                实验编辑器工程加载中...
            </div>
        );
    }

    const contextMenuElement = elementsContextMenu
        ? sharedAnimationElements.find((item) => item.id === elementsContextMenu.elementId) || null
        : null;

    return (
        <div
            className="grid h-full min-h-0"
            style={{
                gridTemplateColumns: `${materialsCollapsed ? 'minmax(0,1fr)' : '300px 8px minmax(0,1fr)'} ${drawerOpen ? '8px' : '0px'} ${drawerOpen ? `${chatPaneWidth}px` : '0px'}`,
                gridTemplateRows: `minmax(0,1fr) ${timelineCollapsed ? '0px' : '8px'} ${timelineCollapsed ? '0px' : '360px'}`,
            }}
        >
            {!materialsCollapsed ? (
            <VideoEditorSidebarShell
                title={sidebarTitle}
                subtitle={sidebarSubtitle}
                tabs={sidebarTabs}
                activeTabId={activeSidebarTab}
                trackLabel={sidebarTrackLabel}
                onSelectTab={(id) => setActiveSidebarTab(id as SidebarTabId)}
            >
                {activeSidebarTab === 'selection' ? (
                    <div className="space-y-4">
                        {selectedEditorItem || selectedAsset || stageSelection.primaryId ? (
                            <>
                                {selectedAsset ? (
                                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                                        <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">素材</div>
                                        <div className="mt-2 text-sm font-medium text-white">{selectedAsset.title || selectedAsset.id}</div>
                                        <div className="mt-2 space-y-1.5 text-xs text-white/62">
                                            <div>ID: {selectedAsset.id}</div>
                                            <div>类型: {selectedAsset.kind}</div>
                                            <div className="break-all">路径: {selectedAsset.src || '无'}</div>
                                        </div>
                                    </div>
                                ) : null}
                                {selectedEditorItem ? (
                                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                                        <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">时间轴对象</div>
                                        <div className="mt-2 text-sm font-medium text-white">{selectedEditorItem.id}</div>
                                        <div className="mt-2 space-y-1.5 text-xs text-white/62">
                                            <div>类型: {selectedEditorItem.type}</div>
                                            <div>轨道: {selectedEditorTrack?.name || selectedEditorItem.trackId}</div>
                                            <div>开始: {selectedEditorItem.fromMs}ms</div>
                                            <div>时长: {selectedEditorItem.durationMs}ms</div>
                                            <div>状态: {selectedEditorItem.enabled ? '启用' : '禁用'}</div>
                                        </div>
                                    </div>
                                ) : null}
                                {stageSelection.primaryId && selectedStageTransform ? (
                                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                                        <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">舞台属性</div>
                                        <div className="mt-2 text-sm font-medium text-white">{stageSelection.kind || 'asset'} · {stageSelection.primaryId}</div>
                                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/62">
                                            <div>X: {Math.round(selectedStageTransform.x)}</div>
                                            <div>Y: {Math.round(selectedStageTransform.y)}</div>
                                            <div>W: {Math.round(selectedStageTransform.width)}</div>
                                            <div>H: {Math.round(selectedStageTransform.height)}</div>
                                        </div>
                                    </div>
                                ) : null}
                            </>
                        ) : (
                            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-white/45">
                                点击素材卡片、时间轴对象或预览画布中的对象后，这里会显示属性。
                            </div>
                        )}
                    </div>
                ) : activeSidebarTab === 'elements' ? (
                    <div className="space-y-3">
                        <button
                            type="button"
                            onClick={() => {
                                void window.ipcRenderer.invoke('animation-elements:open-root');
                            }}
                            className="inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white/80 transition hover:border-cyan-300/45 hover:text-white"
                        >
                            <Upload className="h-4 w-4" />
                            打开元素库文件夹
                        </button>
                        <div className="grid grid-cols-2 gap-2.5">
                            {sharedAnimationElements.map((element) => (
                                <div
                                    key={element.id}
                                    className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition hover:border-violet-300/40 hover:bg-white/[0.05]"
                                    title={element.name}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        setElementsContextMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                            elementId: element.id,
                                        });
                                    }}
                                >
                                    <div className="relative aspect-[9/16] overflow-hidden bg-[#0c0d10]">
                                        <RemotionVideoPreview composition={elementPreviewComposition(element)} />
                                    </div>
                                    <div className="flex items-center justify-end gap-1 border-t border-white/10 px-2 py-2">
                                        <div className="flex items-center gap-1">
                                            <div className="rounded-full border border-violet-300/25 bg-violet-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-violet-100">
                                                {element.source === 'builtin' ? '内置' : '共享'}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void insertSharedAnimationElement(element);
                                                }}
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-cyan-300/35 bg-cyan-400/12 text-cyan-100 transition hover:border-cyan-300/60"
                                                title="追加到动画轨道末尾"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {sharedAnimationElements.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-white/45">
                                还没有共享动画元素。后续可以把当前动画层保存到工作区级元素库。
                            </div>
                        ) : null}
                        {elementsContextMenu && contextMenuElement ? (
                            <div
                                className="fixed z-[120] min-w-[160px] rounded-xl border border-white/10 bg-[#111111] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
                                style={{ left: elementsContextMenu.x, top: elementsContextMenu.y }}
                            >
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        void insertSharedAnimationElement(contextMenuElement);
                                        setElementsContextMenu(null);
                                    }}
                                >
                                    追加到动画轨末尾
                                </button>
                                {contextMenuElement.source !== 'builtin' ? (
                                    <button
                                        type="button"
                                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-200 hover:bg-red-400/10"
                                        onClick={() => {
                                            void deleteSharedAnimationElement(contextMenuElement);
                                            setElementsContextMenu(null);
                                        }}
                                    >
                                        删除共享元素
                                    </button>
                                ) : (
                                    <div className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/35">
                                        内置元素不可删除
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <div className="space-y-3">
                        <button
                            type="button"
                            onClick={onOpenBindAssets}
                            className="inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white/80 transition hover:border-cyan-300/45 hover:text-white"
                        >
                            <Upload className="h-4 w-4" />
                            导入素材
                        </button>
                        <div className="grid grid-cols-2 gap-2.5">
                            {filteredAssets.map((asset) => {
                                const normalized = normalizeAssetFromPreviewAsset(asset);
                                const previewSrc = resolveAssetUrl(normalized.metadata?.previewUrl as string || normalized.metadata?.relativePath as string || normalized.src || '');
                                const assetKind = inferAssetKindFromEditorAsset(normalized);
                                const active = selectedAssetId === asset.id;
                                return (
                                    <div
                                        key={asset.id}
                                        draggable={true}
                                        onDragStart={(event) => {
                                            event.dataTransfer.effectAllowed = 'copy';
                                            event.dataTransfer.setData('application/x-redbox-editor-asset', JSON.stringify(normalized));
                                        }}
                                        onClick={() => setSelectedAsset(asset.id)}
                                        className={clsx(
                                            'group cursor-grab overflow-hidden rounded-xl border bg-white/[0.03] text-left transition hover:border-white/20 hover:bg-white/[0.05] active:cursor-grabbing',
                                            active ? 'border-cyan-300/45 ring-1 ring-cyan-300/30' : 'border-white/10'
                                        )}
                                    >
                                        <div className="relative aspect-[3/4] overflow-hidden bg-[#0c0d10]">
                                            {assetKind === 'image' && previewSrc ? (
                                                <img
                                                    src={previewSrc}
                                                    alt={asset.title || asset.id}
                                                    className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                                                />
                                            ) : assetKind === 'video' && previewSrc ? (
                                                <video
                                                    src={previewSrc}
                                                    className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                                                    muted
                                                    preload="metadata"
                                                    playsInline
                                                />
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#171b22] to-[#0c0f14]">
                                                    {assetKind === 'audio' ? (
                                                        <AudioLines className="h-8 w-8 text-white/45" />
                                                    ) : assetKind === 'text' ? (
                                                        <Type className="h-8 w-8 text-white/45" />
                                                    ) : (
                                                        <ImageIcon className="h-8 w-8 text-white/45" />
                                                    )}
                                                </div>
                                            )}
                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent px-2.5 pb-2.5 pt-8">
                                                <div className="truncate text-[12px] font-medium text-white">{asset.title || asset.id}</div>
                                                <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-white/55">{normalized.kind}</div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    void appendAssetToTimeline(asset);
                                                }}
                                                className="absolute bottom-2.5 right-2.5 inline-flex h-8 w-8 items-center justify-center rounded-full border border-cyan-300/40 bg-cyan-400/18 text-cyan-50 shadow-[0_8px_24px_rgba(6,182,212,0.28)] transition hover:scale-105 hover:bg-cyan-400/24"
                                                title="加入当前轨道末尾"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                        <div className="px-2.5 py-2">
                                            <div className="truncate text-[10px] text-white/40">{normalized.src || '无可用路径'}</div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {filteredAssets.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-white/45">
                                当前分类下还没有素材。
                            </div>
                        ) : null}
                    </div>
                )}
            </VideoEditorSidebarShell>
            ) : null}

            {!materialsCollapsed ? <div className="col-start-2 row-start-1 border-r border-white/10 bg-white/[0.03]" /> : null}

            <VideoEditorStageShell
                title={stageTitle}
                subtitle={stageSubtitle}
                compact={true}
                gridClassName={stageGridClassName}
                contentChrome="none"
                toolbar={(
                    <div className="flex w-full items-center justify-between gap-3">
                        <div className="flex items-center rounded-full border border-white/10 bg-white/[0.03] p-1">
                            {(['preview', 'script', 'motion'] as const).map((tabId) => (
                                <button
                                    key={tabId}
                                    type="button"
                                    onClick={() => setPreviewTab(tabId)}
                                    className={clsx(
                                        'rounded-full px-3 py-1.5 text-xs transition',
                                        previewTab === tabId ? 'bg-cyan-400/16 text-cyan-100' : 'text-white/55 hover:text-white'
                                    )}
                                >
                                    {tabId.toUpperCase()}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-3">
                            {previewTab === 'preview' ? (
                                <div className="relative">
                                    <button
                                        type="button"
                                        onClick={() => setRatioMenuOpen((open) => !open)}
                                        className="inline-flex items-center gap-1.5 text-xs text-white/55 transition hover:text-white"
                                    >
                                        <span>{localProject.project.ratioPreset}</span>
                                        <ChevronsUpDown className="h-3.5 w-3.5" />
                                    </button>
                                    {ratioMenuOpen ? (
                                        <div className="absolute right-0 top-7 z-50 min-w-[120px] overflow-hidden rounded-xl border border-white/10 bg-[#1c1d20] shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
                                            {RATIO_PRESET_OPTIONS.map((option) => (
                                                <button
                                                    key={option.preset}
                                                    type="button"
                                                    onClick={() => handleChangeRatioPreset(option.preset)}
                                                    className="flex w-full items-center justify-between px-3 py-2 text-sm text-white/86 transition hover:bg-white/8"
                                                >
                                                    <span>{option.label}</span>
                                                    {localProject.project.ratioPreset === option.preset ? <Check className="h-4 w-4 text-cyan-300" /> : null}
                                                </button>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        {previewTab === 'motion' ? (
                            <button
                                type="button"
                                onClick={() => generateMotionItems(localProject.ai.motionPrompt || editorBody, selection.itemIds)}
                                disabled={isGeneratingMotion || !scriptConfirmed}
                                className="inline-flex items-center gap-2 rounded-full border border-fuchsia-300/35 bg-fuchsia-400/12 px-3 py-1.5 text-xs text-fuchsia-100 disabled:opacity-40"
                                title={scriptConfirmed ? '基于已确认脚本生成 motion item' : '先确认脚本，再生成 motion item'}
                            >
                                <Sparkles className="h-3.5 w-3.5" />
                                {isGeneratingMotion ? '生成中...' : '生成 Motion Items'}
                            </button>
                        ) : null}
                            <div
                                className={clsx(
                                    'inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium',
                                    scriptConfirmed
                                        ? 'border-emerald-400/25 bg-emerald-400/12 text-emerald-100'
                                        : 'border-amber-300/25 bg-amber-400/12 text-amber-100'
                                )}
                            >
                                {scriptStatusLabel}
                            </div>
                        </div>
                    </div>
                )}
            >
                {previewTab === 'preview' ? (
                    <TimelinePreviewComposition
                        currentFrame={Math.round(currentTime * localProject.project.fps)}
                        durationInFrames={currentDurationFrames}
                        fps={localProject.project.fps}
                        currentTime={currentTime}
                        isPlaying={isPlaying}
                        stageWidth={localProject.project.width}
                        stageHeight={localProject.project.height}
                        ratioPreset={localProject.project.ratioPreset}
                        timelineClips={timelineClips}
                        trackOrder={trackOrder}
                        trackUi={trackUi}
                        assetsById={Object.fromEntries(Object.entries(assetsById).map(([key, value]) => [key, {
                            id: value.id,
                            title: value.title,
                            previewUrl: value.src,
                            absolutePath: value.src,
                            relativePath: String(value.metadata?.relativePath || ''),
                            mimeType: value.mimeType,
                        }]))}
                        motionComposition={remotionComposition}
                        selectedScene={selectedScene}
                        selectedSceneItemId={stageSelection.primaryId}
                        selectedSceneItemIds={stageSelection.ids}
                        selectedSceneItemKind={stageSelection.kind}
                        guidesVisible={true}
                        safeAreaVisible={true}
                        itemTransforms={localProject.stage.itemTransforms}
                        itemVisibility={localProject.stage.itemVisibility}
                        itemOrder={localProject.stage.itemOrder}
                        itemLocks={localProject.stage.itemLocks}
                        itemGroups={localProject.stage.itemGroups}
                        focusedGroupId={localProject.stage.focusedGroupId}
                        onTogglePlayback={handleTogglePlayback}
                        onSeekFrame={(frame) => seekTimeMs((frame / localProject.project.fps) * 1000)}
                        onStepFrame={(deltaFrames) => seekTimeMs(((Math.round(currentTime * localProject.project.fps) + deltaFrames) / localProject.project.fps) * 1000)}
                        onChangeRatioPreset={handleChangeRatioPreset}
                        onSelectSceneItem={(kind, id, options) => {
                            setStageSelection((current) => {
                                const nextIds = options?.additive
                                    ? Array.from(new Set(current.ids.includes(id) ? current.ids.filter((itemId) => itemId !== id) : [...current.ids, id]))
                                    : [id];
                                return {
                                    ids: nextIds,
                                    primaryId: id,
                                    kind,
                                };
                            });
                        }}
                        onUpdateItemTransform={(id, patch) => {
                            void dispatchEditorCommands([{ type: 'update_stage_item', itemId: id, patch }]);
                        }}
                        onDeleteSceneItem={() => {}}
                        onDeleteSceneItems={() => {}}
                        onAlignSceneItems={() => {}}
                        onDistributeSceneItems={() => {}}
                        onSetSceneSelection={(ids, primaryId) => {
                            const kind = primaryId?.endsWith(':text') ? 'text' : primaryId?.endsWith(':subtitle') ? 'subtitle' : 'asset';
                            setStageSelection({ ids, primaryId, kind });
                        }}
                        onDuplicateSceneItems={() => {}}
                    />
                ) : previewTab === 'motion' ? (
                    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px]">
                        <div className="flex min-h-0 flex-col border-r border-white/10">
                            <div className="border-b border-white/10 px-4 py-3">
                                <RemotionTransportBar
                                    fps={localProject.project.fps}
                                    durationInFrames={currentDurationFrames}
                                    currentFrame={Math.round(currentTime * localProject.project.fps)}
                                    playing={isPlaying}
                                    onTogglePlayback={handleTogglePlayback}
                                    onSeekFrame={(frame) => seekTimeMs((frame / localProject.project.fps) * 1000)}
                                    onStepFrame={(deltaFrames) => seekTimeMs(((Math.round(currentTime * localProject.project.fps) + deltaFrames) / localProject.project.fps) * 1000)}
                                />
                            </div>
                            <div className="min-h-0 flex-1">
                                {remotionComposition ? (
                                    <RemotionVideoPreview composition={remotionComposition} playerRef={remotionPlayerRef} />
                                ) : (
                                    <div className="flex h-full items-center justify-center text-white/45">暂无可预览的 motion composition</div>
                                )}
                            </div>
                        </div>
                        <div className="min-h-0 overflow-y-auto bg-[#121318] px-4 py-4">
                            <textarea
                                value={localProject.ai.motionPrompt || ''}
                                onChange={(event) => updateProject({
                                    ...localProject,
                                    ai: {
                                        ...localProject.ai,
                                        motionPrompt: event.target.value,
                                    },
                                })}
                                placeholder="告诉 AI 你要的动画节奏、标题、字幕强调方式。"
                                className="h-24 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                            />
                            <div className="mt-4 space-y-3">
                                {motionItems.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setSelection({ itemIds: [item.id], primaryItemId: item.id, trackIds: [] })}
                                        className={clsx(
                                            'block w-full rounded-2xl border px-3 py-3 text-left transition',
                                            selection.primaryItemId === item.id ? 'border-fuchsia-400/45 bg-fuchsia-400/10' : 'border-white/10 bg-white/[0.03]'
                                        )}
                                    >
                                        <div className="truncate text-sm font-medium text-white">{String(item.props.overlayTitle || item.templateId || item.id)}</div>
                                        <div className="mt-1 text-[11px] text-white/45">{item.templateId} · {item.durationMs}ms</div>
                                    </button>
                                ))}
                            </div>
                            {selectedMotionItem ? (
                                <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-medium text-white">Motion Inspector</div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                void saveSelectedAnimationElement();
                                            }}
                                            className="inline-flex items-center rounded-full border border-violet-300/35 bg-violet-400/12 px-3 py-1 text-[11px] text-violet-100"
                                        >
                                            保存到元素库
                                        </button>
                                    </div>
                                    <div className="mt-3 space-y-3 text-sm text-white/80">
                                        <label className="block">
                                            <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-white/35">Template</div>
                                            <input
                                                value={selectedMotionItem.templateId}
                                                onChange={(event) => {
                                                    void dispatchEditorCommands([{ type: 'update_item', itemId: selectedMotionItem.id, patch: { templateId: event.target.value } as Partial<EditorMotionItem> }]);
                                                }}
                                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2"
                                            />
                                        </label>
                                        <label className="block">
                                            <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-white/35">Start (ms)</div>
                                            <input
                                                type="number"
                                                value={selectedMotionItem.fromMs}
                                                onChange={(event) => {
                                                    void dispatchEditorCommands([{ type: 'retime_item', itemId: selectedMotionItem.id, fromMs: Number(event.target.value) }]);
                                                }}
                                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2"
                                            />
                                        </label>
                                        <label className="block">
                                            <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-white/35">Duration (ms)</div>
                                            <input
                                                type="number"
                                                value={selectedMotionItem.durationMs}
                                                onChange={(event) => {
                                                    void dispatchEditorCommands([{ type: 'retime_item', itemId: selectedMotionItem.id, durationMs: Number(event.target.value) }]);
                                                }}
                                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2"
                                            />
                                        </label>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : (
                    <div className="flex h-full min-h-0 flex-col">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#121318] px-5 py-3">
                            <div>
                                <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">Markdown Script</div>
                                <div className="mt-1 text-sm text-white/72">AI 如果要改视频内容，必须先改这里的脚本文字。用户确认后才进入动画制作。</div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <div
                                    className={clsx(
                                        'inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium',
                                        scriptConfirmed
                                            ? 'border-emerald-400/25 bg-emerald-400/12 text-emerald-100'
                                            : 'border-amber-300/25 bg-amber-400/12 text-amber-100'
                                    )}
                                >
                                    {scriptStatusLabel}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onConfirmScript?.()}
                                    disabled={!onConfirmScript || scriptConfirmed || editorBodyDirty || isSavingEditorBody}
                                    className="rounded-full border border-emerald-400/35 bg-emerald-400/12 px-3 py-1 text-[11px] text-emerald-100 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-white/35"
                                >
                                    {scriptConfirmed ? '脚本已确认' : editorBodyDirty || isSavingEditorBody ? '保存后确认脚本' : '确认脚本'}
                                </button>
                            </div>
                        </div>
                        <textarea
                            value={editorBody}
                            onChange={(event) => onEditorBodyChange(event.target.value)}
                            placeholder="在这里写视频脚本、镜头安排、剪辑目标和导出要求。"
                            className="h-full w-full min-h-0 resize-none bg-transparent px-5 py-5 text-sm leading-7 text-white outline-none placeholder:text-white/30"
                        />
                    </div>
                )}
            </VideoEditorStageShell>

            <div
                className={`${aiDividerClassName} cursor-col-resize border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/14`}
                hidden={!drawerOpen}
                onPointerDown={(event) => {
                    event.preventDefault();
                    setChatResizeState({
                        startX: event.clientX,
                        chatPaneWidth,
                    });
                }}
            />

            <div
                className={`${aiPanelClassName} flex min-h-0 flex-col border-l border-white/10 bg-[#131417] shadow-[-24px_0_60px_rgba(0,0,0,0.4)]`}
                hidden={!drawerOpen}
            >
                <div className="min-h-0 flex-1 overflow-hidden">
                    {editorChatSessionId ? (
                        <Suspense fallback={<div className="flex h-full items-center justify-center text-white/45">AI 会话加载中...</div>}>
                            <ChatWorkspace
                                fixedSessionId={editorChatSessionId}
                                defaultCollapsed={true}
                                showClearButton={false}
                                fixedSessionBannerText=""
                                shortcuts={[
                                    { label: '改写脚本', text: '请先读取当前脚本，输出一版完整脚本草案，并使用 redbox_editor 的 script_update 写回脚本区。先不要修改时间轴或动画。' },
                                    { label: '确认后生成 Motion', text: '仅在脚本已确认后，为当前选中片段规划动画节奏，并给出 motion item 方案。' },
                                    { label: '检查节奏', text: '请检查当前脚本和时间轴节奏，指出最值得调整的 3 个点。' },
                                ]}
                                welcomeShortcuts={[
                                    { label: '改写脚本', text: '请先读取当前脚本，输出一版完整脚本草案，并使用 redbox_editor 的 script_update 写回脚本区。先不要修改时间轴或动画。' },
                                    { label: '确认后生成 Motion', text: '仅在脚本已确认后，为当前选中片段规划动画节奏，并给出 motion item 方案。' },
                                ]}
                                showWelcomeShortcuts={true}
                                showComposerShortcuts={false}
                                fixedSessionContextIndicatorMode="none"
                                showWelcomeHeader={true}
                                emptyStateComposerPlacement="bottom"
                                embeddedTheme="dark"
                                welcomeTitle="视频剪辑助手"
                                welcomeSubtitle="先改脚本并确认，再生成独立动画层；最终由编辑器把多个图层合成为视频。"
                                contentLayout="default"
                                contentWidthPreset="narrow"
                                allowFileUpload={true}
                                messageWorkflowPlacement="bottom"
                                messageWorkflowVariant="compact"
                                messageWorkflowEmphasis="default"
                            />
                        </Suspense>
                    ) : (
                        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/45">正在初始化视频剪辑会话...</div>
                    )}
                </div>
            </div>

            {!timelineCollapsed ? (
            <VideoEditorTimelineShell
                onResizeStart={() => {}}
                barClassName={timelineBarClassName}
                sectionClassName={timelineSectionClassName}
            >
                <ExperimentalTimeline
                    project={localProject}
                    currentTimeMs={currentTime * 1000}
                    isPlaying={isPlaying}
                    canAutoTranscribeSubtitles={Boolean(subtitleRecognitionItem)}
                    isTranscribingSubtitles={isTranscribingSubtitles}
                    selectedItemIds={selection.itemIds}
                    primaryItemId={selection.primaryItemId}
                    selectedTrackIds={selection.trackIds}
                    subtitleTranscriptionNotice={subtitleTranscriptionNotice}
                    zoomPercent={zoomPercent}
                    onApplyCommands={(commands) => {
                        void dispatchEditorCommands(commands);
                    }}
                    onAutoTranscribeSubtitles={() => {
                        void handleAutoTranscribeSubtitles();
                    }}
                    onSeekTimeMs={seekTimeMs}
                    onTogglePlayback={handleTogglePlayback}
                    onSelectionChange={setSelection}
                    onZoomPercentChange={(nextZoom) => editorStore.setState((state) => ({ timeline: { ...state.timeline, zoomPercent: nextZoom } }))}
                />
            </VideoEditorTimelineShell>
            ) : null}
        </div>
    );
}
