import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Timeline } from '@/features/timeline';
import { useItemsStore } from '@/features/timeline/stores/items-store';
import { useTransitionsStore } from '@/features/timeline/stores/transitions-store';
import { useMarkersStore } from '@/features/timeline/stores/markers-store';
import { useKeyframesStore } from '@/features/timeline/stores/keyframes-store';
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store';
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store';
import { useTimelineViewportStore } from '@/features/timeline/stores/timeline-viewport-store';
import { useZoomStore } from '@/features/timeline/stores/zoom-store';
import { useSelectionStore } from '@/shared/state/selection/store';
import { usePlaybackStore } from '@/shared/state/playback/store';
import { syncRedBoxMediaLibrary } from '@/features/timeline/deps/media-library-contract';
import { syncRedBoxTimelineProject } from '@/features/timeline/deps/projects-contract';
import { syncRedBoxTimelineSettings } from '@/features/timeline/deps/settings-contract';
import type { VideoEditorTrackUiState, VideoEditorViewportMetrics } from '../../features/video-editor/store/useVideoEditorStore';
import type { EditorProjectFile } from './editorProject';
import {
    buildOptimisticPackageState,
    frameToMs,
    freecutTimelineToProject,
    mediaItemsFromEditorProject,
    msToFrame,
    projectToFreecutTimeline,
    type RedBoxPackageStateLike,
} from './freecutTimelineBridge';
import './vendored-freecut-timeline.css';

const FLOAT_EPSILON = 0.0005;

function nearlyEqual(left: number | null | undefined, right: number | null | undefined, epsilon = FLOAT_EPSILON) {
    return Math.abs((left ?? 0) - (right ?? 0)) <= epsilon;
}

function viewportEqual(
    left: VideoEditorViewportMetrics | null | undefined,
    right: VideoEditorViewportMetrics | null | undefined,
) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return nearlyEqual(left.scrollLeft, right.scrollLeft, 0.5)
        && nearlyEqual(left.scrollTop, right.scrollTop, 0.5)
        && nearlyEqual(left.maxScrollLeft, right.maxScrollLeft, 0.5)
        && nearlyEqual(left.maxScrollTop, right.maxScrollTop, 0.5);
}

function trackUiEqual(
    left: Record<string, VideoEditorTrackUiState> | null | undefined,
    right: Record<string, VideoEditorTrackUiState> | null | undefined,
) {
    const leftKeys = Object.keys(left || {}).sort();
    const rightKeys = Object.keys(right || {}).sort();
    if (leftKeys.length !== rightKeys.length) return false;

    return leftKeys.every((key, index) => {
        if (rightKeys[index] !== key) return false;
        const leftValue = left?.[key];
        const rightValue = right?.[key];
        return !!leftValue
            && !!rightValue
            && leftValue.locked === rightValue.locked
            && leftValue.hidden === rightValue.hidden
            && leftValue.collapsed === rightValue.collapsed
            && leftValue.muted === rightValue.muted
            && leftValue.solo === rightValue.solo
            && nearlyEqual(leftValue.volume, rightValue.volume, 0.001);
    });
}

type VendoredFreecutTimelineProps = {
    filePath: string;
    packageState?: RedBoxPackageStateLike | null;
    fallbackTracks: string[];
    onPackageStateChange?: (state: RedBoxPackageStateLike) => void;
    onHistoryAvailabilityChange?: (history: { canUndo: boolean; canRedo: boolean }) => void;
    controlledCursorTime?: number | null;
    controlledSelectedClipId?: string | null;
    controlledActiveTrackId?: string | null;
    onCursorTimeChange?: (time: number) => void;
    onSelectedClipChange?: (clipId: string | null) => void;
    onActiveTrackChange?: (trackId: string | null) => void;
    onViewportMetricsChange?: (metrics: VideoEditorViewportMetrics) => void;
    controlledViewport?: VideoEditorViewportMetrics | null;
    controlledZoomPercent?: number | null;
    onZoomPercentChange?: (zoomPercent: number) => void;
    controlledTrackUi?: Record<string, VideoEditorTrackUiState>;
    onTrackUiChange?: (trackUi: Record<string, VideoEditorTrackUiState>) => void;
    fps?: number;
    currentFrame?: number;
    durationInFrames?: number;
    isPlaying?: boolean;
    onTogglePlayback?: () => void;
    onSeekFrame?: (frame: number) => void;
};

function normalizeProject(
    packageState: RedBoxPackageStateLike | null | undefined,
    fallbackTracks: string[],
    fps = 30,
): EditorProjectFile | null {
    const candidate = packageState?.editorProject;
    if (candidate && typeof candidate === 'object') {
        return candidate as EditorProjectFile;
    }

    if (fallbackTracks.length === 0) {
        return null;
    }

    return {
        version: 1,
        project: {
            id: 'redbox-vendored-timeline',
            title: 'RedBox Timeline',
            width: 1080,
            height: 1920,
            fps,
            ratioPreset: '9:16',
        },
        script: {
            body: '',
        },
        assets: [],
        tracks: fallbackTracks.map((trackId, index) => ({
            id: trackId,
            kind: trackId.startsWith('A')
                ? 'audio'
                : trackId.startsWith('S')
                    ? 'subtitle'
                    : trackId.startsWith('T')
                        ? 'text'
                        : trackId.startsWith('M')
                            ? 'motion'
                            : 'video',
            name: trackId,
            order: index,
            ui: {
                hidden: false,
                locked: false,
                muted: false,
                solo: false,
                collapsed: false,
                volume: 1,
            },
        })),
        items: [],
        animationLayers: [],
        markers: [],
        transitions: [],
        keyframes: [],
        stage: {
            itemTransforms: {},
            itemVisibility: {},
            itemLocks: {},
            itemOrder: [],
            itemGroups: {},
            focusedGroupId: null,
        },
        ai: {
            motionPrompt: '',
        },
    };
}

export function VendoredFreecutTimeline({
    filePath,
    packageState,
    fallbackTracks,
    onPackageStateChange,
    onHistoryAvailabilityChange,
    controlledCursorTime,
    controlledSelectedClipId,
    controlledActiveTrackId,
    onCursorTimeChange,
    onSelectedClipChange,
    onActiveTrackChange,
    onViewportMetricsChange,
    controlledViewport,
    controlledZoomPercent,
    onZoomPercentChange,
    controlledTrackUi,
    onTrackUiChange,
    fps,
    isPlaying,
    onTogglePlayback,
    onSeekFrame,
}: VendoredFreecutTimelineProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const localProjectRef = useRef<EditorProjectFile | null>(null);
    const packageStateRef = useRef<RedBoxPackageStateLike | null | undefined>(packageState);
    const hydratedSignatureRef = useRef('');
    const isHydratingRef = useRef(false);
    const pendingProjectSyncRef = useRef<number | null>(null);
    const pendingSaveRef = useRef<number | null>(null);
    const reportedCursorTimeRef = useRef<number | null>(controlledCursorTime ?? null);
    const reportedSelectedClipIdRef = useRef<string | null>(controlledSelectedClipId ?? null);
    const reportedActiveTrackIdRef = useRef<string | null>(controlledActiveTrackId ?? null);
    const reportedZoomPercentRef = useRef<number | null>(controlledZoomPercent ?? null);
    const reportedViewportRef = useRef<VideoEditorViewportMetrics | null>(controlledViewport ?? null);
    const externalPlayingRef = useRef<boolean>(Boolean(isPlaying));
    const externalCursorTimeRef = useRef<number | null>(controlledCursorTime ?? null);
    const externalSelectedClipIdRef = useRef<string | null>(controlledSelectedClipId ?? null);
    const externalActiveTrackIdRef = useRef<string | null>(controlledActiveTrackId ?? null);
    const externalZoomPercentRef = useRef<number | null>(controlledZoomPercent ?? null);
    const externalViewportRef = useRef<VideoEditorViewportMetrics | null>(controlledViewport ?? null);
    const externalTrackUiRef = useRef<Record<string, VideoEditorTrackUiState> | null | undefined>(controlledTrackUi);
    const [localProject, setLocalProject] = useState<EditorProjectFile | null>(
        () => normalizeProject(packageState, fallbackTracks, fps),
    );

    const projection = useMemo(
        () => localProject ? projectToFreecutTimeline(localProject, controlledTrackUi) : null,
        [controlledTrackUi, localProject],
    );

    packageStateRef.current = packageState;
    localProjectRef.current = localProject;
    externalPlayingRef.current = Boolean(isPlaying);
    externalCursorTimeRef.current = controlledCursorTime ?? null;
    externalSelectedClipIdRef.current = controlledSelectedClipId ?? null;
    externalActiveTrackIdRef.current = controlledActiveTrackId ?? null;
    externalZoomPercentRef.current = controlledZoomPercent ?? null;
    externalViewportRef.current = controlledViewport ?? null;
    externalTrackUiRef.current = controlledTrackUi;

    const persistProject = useCallback((project: EditorProjectFile) => {
        if (pendingSaveRef.current !== null) {
            window.clearTimeout(pendingSaveRef.current);
        }
        pendingSaveRef.current = window.setTimeout(() => {
            void window.ipcRenderer.invoke('manuscripts:save-editor-project', {
                filePath,
                project,
            }).then((result) => {
                if (result?.success && result.state) {
                    onPackageStateChange?.(result.state as RedBoxPackageStateLike);
                }
                return window.ipcRenderer.invoke('manuscripts:get-editor-runtime-state', { filePath });
            }).then((runtimeResult) => {
                if (!runtimeResult?.success || !runtimeResult.state) {
                    return;
                }
                const runtimeState = runtimeResult.state as Record<string, unknown>;
                onHistoryAvailabilityChange?.({
                    canUndo: Boolean(runtimeState.canUndo),
                    canRedo: Boolean(runtimeState.canRedo),
                });
            }).catch((error) => {
                console.error('Failed to save vendored editor project:', error);
            });
        }, 220);
    }, [filePath, onHistoryAvailabilityChange, onPackageStateChange]);

    const hydrateFromProject = useCallback((project: EditorProjectFile | null) => {
        if (!project) {
            return;
        }
        const nextProjection = projectToFreecutTimeline(project, controlledTrackUi);
        isHydratingRef.current = true;
        hydratedSignatureRef.current = JSON.stringify(nextProjection);
        syncRedBoxMediaLibrary(mediaItemsFromEditorProject(project));
        syncRedBoxTimelineProject({
            id: project.project.id,
            metadata: {
                width: project.project.width,
                height: project.project.height,
                fps: project.project.fps,
            },
        });
        syncRedBoxTimelineSettings({
            editorDensity: 'compact',
            showWaveforms: true,
            showFilmstrips: true,
            defaultWhisperModel: 'base',
            maxUndoHistory: 80,
        });
        useItemsStore.getState().setTracks(nextProjection.tracks);
        useItemsStore.getState().setItems(nextProjection.items);
        useTransitionsStore.getState().setTransitions(nextProjection.transitions);
        useMarkersStore.getState().setMarkers(nextProjection.markers);
        useMarkersStore.getState().setInPoint(null);
        useMarkersStore.getState().setOutPoint(null);
        useKeyframesStore.getState().setKeyframes(nextProjection.keyframes);
        useTimelineSettingsStore.getState().setFps(project.project.fps);
        useTimelineSettingsStore.getState().setTimelineLoading(false);
        useTimelineCommandStore.getState().clearHistory();
        const initialFrame = msToFrame(controlledCursorTime || 0, project.project.fps);
        usePlaybackStore.getState().setCurrentFrame(initialFrame);
        if (isPlaying) {
            usePlaybackStore.getState().play();
        } else {
            usePlaybackStore.getState().pause();
        }
        const activeTrackId = controlledActiveTrackId || null;
        useSelectionStore.getState().setActiveTrack(activeTrackId);
        useSelectionStore.getState().selectItems(controlledSelectedClipId ? [controlledSelectedClipId] : []);
        useZoomStore.getState().setZoomLevelImmediate(Math.max(0.1, (controlledZoomPercent || 100) / 100));
        const viewportState = useTimelineViewportStore.getState();
        useTimelineViewportStore.getState().setViewport({
            scrollLeft: controlledViewport?.scrollLeft || 0,
            scrollTop: controlledViewport?.scrollTop || 0,
            viewportWidth: viewportState.viewportWidth,
            viewportHeight: viewportState.viewportHeight,
        });
        window.setTimeout(() => {
            isHydratingRef.current = false;
        }, 0);
    }, [controlledActiveTrackId, controlledCursorTime, controlledSelectedClipId, controlledTrackUi, controlledViewport, controlledZoomPercent, isPlaying]);

    useEffect(() => {
        const nextProject = normalizeProject(packageState, fallbackTracks, fps);
        const nextSignature = JSON.stringify({
            project: nextProject,
            trackUi: controlledTrackUi,
        });
        if (hydratedSignatureRef.current === nextSignature) {
            return;
        }
        setLocalProject(nextProject);
        hydrateFromProject(nextProject);
        hydratedSignatureRef.current = nextSignature;
    }, [controlledTrackUi, fallbackTracks, fps, hydrateFromProject, packageState]);

    useEffect(() => {
        if (!localProject) {
            return;
        }
        const syncProjectFromStores = () => {
            pendingProjectSyncRef.current = null;
            if (isHydratingRef.current || !localProjectRef.current) {
                return;
            }
            const nextProject = freecutTimelineToProject(localProjectRef.current, {
                tracks: useItemsStore.getState().tracks,
                items: useItemsStore.getState().items,
                markers: useMarkersStore.getState().markers,
                transitions: useTransitionsStore.getState().transitions,
                keyframes: useKeyframesStore.getState().keyframes,
            });
            const previousSignature = JSON.stringify(localProjectRef.current);
            const nextSignature = JSON.stringify(nextProject);
            if (previousSignature === nextSignature) {
                return;
            }
            localProjectRef.current = nextProject;
            setLocalProject(nextProject);
            const nextTrackUi = Object.fromEntries(
                nextProject.tracks.map((track) => [track.id, track.ui]),
            );
            if (!trackUiEqual(nextTrackUi, externalTrackUiRef.current)) {
                onTrackUiChange?.(nextTrackUi);
            }
            onPackageStateChange?.(buildOptimisticPackageState(packageStateRef.current, nextProject));
            persistProject(nextProject);
        };

        const scheduleProjectSync = () => {
            if (pendingProjectSyncRef.current !== null) {
                return;
            }
            pendingProjectSyncRef.current = window.setTimeout(syncProjectFromStores, 16);
        };

        const unsubscribeItems = useItemsStore.subscribe(scheduleProjectSync);
        const unsubscribeTransitions = useTransitionsStore.subscribe(scheduleProjectSync);
        const unsubscribeMarkers = useMarkersStore.subscribe(scheduleProjectSync);
        const unsubscribeKeyframes = useKeyframesStore.subscribe(scheduleProjectSync);
        const unsubscribeSelection = useSelectionStore.subscribe((state) => {
            if (isHydratingRef.current) return;
            const nextSelectedClipId = state.selectedItemIds[0] || null;
            const nextActiveTrackId = state.activeTrackId || null;
            if (nextSelectedClipId !== reportedSelectedClipIdRef.current && nextSelectedClipId !== externalSelectedClipIdRef.current) {
                reportedSelectedClipIdRef.current = nextSelectedClipId;
                onSelectedClipChange?.(nextSelectedClipId);
            }
            if (nextActiveTrackId !== reportedActiveTrackIdRef.current && nextActiveTrackId !== externalActiveTrackIdRef.current) {
                reportedActiveTrackIdRef.current = nextActiveTrackId;
                onActiveTrackChange?.(nextActiveTrackId);
            }
        });
        const unsubscribePlayback = usePlaybackStore.subscribe((state) => {
            if (!localProjectRef.current || isHydratingRef.current) return;
            const nextTime = frameToMs(state.currentFrame, localProjectRef.current.project.fps) / 1000;
            if (!nearlyEqual(nextTime, reportedCursorTimeRef.current) && !nearlyEqual(nextTime, externalCursorTimeRef.current)) {
                reportedCursorTimeRef.current = nextTime;
                onCursorTimeChange?.(nextTime);
            }
            if (state.currentFrame !== currentFrame) {
                onSeekFrame?.(state.currentFrame);
            }
            if (state.isPlaying !== externalPlayingRef.current) {
                onTogglePlayback?.();
            }
        });
        const unsubscribeZoom = useZoomStore.subscribe((state) => {
            if (isHydratingRef.current) return;
            const nextZoomPercent = Math.round(state.level * 100);
            if (nextZoomPercent !== reportedZoomPercentRef.current && nextZoomPercent !== externalZoomPercentRef.current) {
                reportedZoomPercentRef.current = nextZoomPercent;
                onZoomPercentChange?.(nextZoomPercent);
            }
        });
        const unsubscribeViewport = useTimelineViewportStore.subscribe((state) => {
            if (isHydratingRef.current) return;
            const container = rootRef.current?.querySelector('.timeline-container') as HTMLElement | null;
            const maxScrollLeft = container ? Math.max(0, container.scrollWidth - container.clientWidth) : state.scrollLeft;
            const maxScrollTop = container ? Math.max(0, container.scrollHeight - container.clientHeight) : state.scrollTop;
            const nextViewport = {
                scrollLeft: state.scrollLeft,
                maxScrollLeft,
                scrollTop: state.scrollTop,
                maxScrollTop,
            };
            if (!viewportEqual(nextViewport, reportedViewportRef.current) && !viewportEqual(nextViewport, externalViewportRef.current)) {
                reportedViewportRef.current = nextViewport;
                onViewportMetricsChange?.(nextViewport);
            }
        });

        return () => {
            unsubscribeItems();
            unsubscribeTransitions();
            unsubscribeMarkers();
            unsubscribeKeyframes();
            unsubscribeSelection();
            unsubscribePlayback();
            unsubscribeZoom();
            unsubscribeViewport();
        };
    }, [localProject, onActiveTrackChange, onCursorTimeChange, onPackageStateChange, onSeekFrame, onSelectedClipChange, onTogglePlayback, onTrackUiChange, onViewportMetricsChange, onZoomPercentChange, persistProject]);

    useEffect(() => {
        return () => {
            if (pendingProjectSyncRef.current !== null) {
                window.clearTimeout(pendingProjectSyncRef.current);
            }
            if (pendingSaveRef.current !== null) {
                window.clearTimeout(pendingSaveRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!localProject) return;
        const nextFrame = typeof currentFrame === 'number'
            ? currentFrame
            : msToFrame(controlledCursorTime || 0, localProject.project.fps);
        if (usePlaybackStore.getState().currentFrame !== nextFrame) {
            usePlaybackStore.getState().setCurrentFrame(nextFrame);
        }
    }, [controlledCursorTime, currentFrame, localProject]);

    useEffect(() => {
        const selectionState = useSelectionStore.getState();
        const nextActiveTrackId = controlledActiveTrackId || null;
        if (controlledActiveTrackId !== undefined && selectionState.activeTrackId !== nextActiveTrackId) {
            selectionState.setActiveTrack(nextActiveTrackId);
        }
        const nextSelectedIds = controlledSelectedClipId ? [controlledSelectedClipId] : [];
        const currentSelectedIds = selectionState.selectedItemIds;
        if (
            currentSelectedIds.length !== nextSelectedIds.length
            || currentSelectedIds.some((itemId, index) => itemId !== nextSelectedIds[index])
        ) {
            selectionState.selectItems(nextSelectedIds);
        }
    }, [controlledActiveTrackId, controlledSelectedClipId]);

    useEffect(() => {
        const nextZoomLevel = Math.max(0.1, (controlledZoomPercent || 100) / 100);
        if (!nearlyEqual(useZoomStore.getState().level, nextZoomLevel, 0.001)) {
            useZoomStore.getState().setZoomLevelImmediate(nextZoomLevel);
        }
    }, [controlledZoomPercent]);

    useEffect(() => {
        if (!controlledViewport) return;
        const current = useTimelineViewportStore.getState();
        if (!viewportEqual(controlledViewport, {
            scrollLeft: current.scrollLeft,
            maxScrollLeft: current.scrollLeft,
            scrollTop: current.scrollTop,
            maxScrollTop: current.scrollTop,
        })) {
            useTimelineViewportStore.getState().setViewport({
                scrollLeft: controlledViewport.scrollLeft,
                scrollTop: controlledViewport.scrollTop,
                viewportWidth: current.viewportWidth,
                viewportHeight: current.viewportHeight,
            });
        }
    }, [controlledViewport]);

    useEffect(() => {
        const playbackStore = usePlaybackStore.getState();
        if (Boolean(isPlaying) !== playbackStore.isPlaying) {
            if (isPlaying) {
                playbackStore.play();
            } else {
                playbackStore.pause();
            }
        }
    }, [isPlaying]);

    if (!projection) {
        return null;
    }

    return (
        <div ref={rootRef} className="freecut-timeline-theme h-full min-h-0 overflow-hidden">
            <Timeline duration={projection.durationSeconds} />
        </div>
    );
}
