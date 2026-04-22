import { useSyncExternalStore } from 'react';
import type { RemotionCompositionConfig } from '../../../components/manuscripts/remotion/types';
import type { EditorItem, EditorProjectFile } from '../../../components/manuscripts/editorProject';

export type VideoEditorViewportMetrics = {
    scrollLeft: number;
    maxScrollLeft: number;
    scrollTop: number;
    maxScrollTop: number;
};

export type VideoEditorTrackUiState = {
    locked: boolean;
    hidden: boolean;
    collapsed: boolean;
    muted: boolean;
    solo: boolean;
    volume: number;
};

export type VideoEditorPreviewTab = 'preview' | 'motion' | 'script';
export type VideoEditorRatioPreset = '16:9' | '9:16' | '4:3' | '3:4';
export type VideoEditorLeftPanel =
    | 'uploads'
    | 'videos'
    | 'images'
    | 'audios'
    | 'selection'
    | 'texts'
    | 'captions'
    | 'transitions';

export type SceneItemTransform = {
    x: number;
    y: number;
    width: number;
    height: number;
    lockAspectRatio: boolean;
    minWidth: number;
    minHeight: number;
};

export type VideoEditorState = {
    project: {
        title: string;
        filePath: string;
        width: number;
        height: number;
        ratioPreset: VideoEditorRatioPreset;
        fps: number;
        durationInFrames: number;
        exportPath: string | null;
        isExporting: boolean;
    };
    assets: {
        currentPreviewAssetId: string | null;
        selectedAssetId: string | null;
        materialSearch: string;
    };
    timeline: {
        selectedClipId: string | null;
        activeTrackId: string | null;
        viewport: VideoEditorViewportMetrics;
        zoomPercent: number;
        playheadSeconds: number;
        trackUi: Record<string, VideoEditorTrackUiState>;
    };
    timelinePreview: {
        mode: 'timeline-composition';
        activeClipId: string | null;
        visibleClipIds: string[];
        orderedClipIds: string[];
        timelineDurationSeconds: number;
        playbackStatus: 'idle' | 'playing' | 'ended';
    };
    selection: {
        kind: 'clip' | 'scene' | 'scene-item' | 'asset' | null;
        sceneItemId: string | null;
        sceneItemIds: string[];
        sceneItemKind: 'asset' | 'overlay' | 'title' | 'text' | 'subtitle' | null;
    };
    player: {
        previewTab: VideoEditorPreviewTab;
        isPlaying: boolean;
        currentTime: number;
        currentFrame: number;
    };
    scene: {
        selectedSceneId: string | null;
        editableComposition: RemotionCompositionConfig | null;
        guidesVisible: boolean;
        safeAreaVisible: boolean;
        itemTransforms: Record<string, SceneItemTransform>;
        itemVisibility: Record<string, boolean>;
        itemOrder: string[];
        itemLocks: Record<string, boolean>;
        itemGroups: Record<string, string>;
        focusedGroupId: string | null;
    };
    panels: {
        leftPanel: VideoEditorLeftPanel;
        materialPaneWidth: number;
        timelineHeight: number;
        redclawDrawerOpen: boolean;
    };
    remotion: {
        motionPrompt: string;
    };
    script: {
        dirty: boolean;
    };
    editor: {
        projectFile: EditorProjectFile | null;
        selection: {
            itemIds: string[];
            primaryItemId: string | null;
            trackIds: string[];
        };
        history: {
            undoStack: EditorProjectFile[];
            redoStack: EditorProjectFile[];
            canUndo: boolean;
            canRedo: boolean;
        };
        derived: {
            durationMs: number;
            visibleItems: EditorItem[];
            audibleItems: EditorItem[];
            activeMotionItems: EditorItem[];
        };
    };
};

type PartialUpdater =
    | Partial<VideoEditorState>
    | ((state: VideoEditorState) => Partial<VideoEditorState>);

export type VideoEditorStore = {
    getState: () => VideoEditorState;
    setState: (updater: PartialUpdater) => void;
    subscribe: (listener: () => void) => () => void;
};

function hasStateChanges(current: VideoEditorState, partial: Partial<VideoEditorState>): boolean {
    const keys = Object.keys(partial) as Array<keyof VideoEditorState>;
    for (const key of keys) {
        const nextValue = partial[key];
        const currentValue = current[key];
        if (!Object.is(currentValue, nextValue)) {
            return true;
        }
    }
    return false;
}

export function createVideoEditorStore(initialState?: Partial<VideoEditorState>): VideoEditorStore {
    let state: VideoEditorState = {
        project: {
            title: '',
            filePath: '',
            width: 1080,
            height: 1920,
            ratioPreset: '9:16',
            fps: 30,
            durationInFrames: 1,
            exportPath: null,
            isExporting: false,
        },
        assets: {
            currentPreviewAssetId: null,
            selectedAssetId: null,
            materialSearch: '',
        },
        timeline: {
            selectedClipId: null,
            activeTrackId: null,
            viewport: {
                scrollLeft: 0,
                maxScrollLeft: 0,
                scrollTop: 0,
                maxScrollTop: 0,
            },
            zoomPercent: 100,
            playheadSeconds: 0,
            trackUi: {},
        },
        timelinePreview: {
            mode: 'timeline-composition',
            activeClipId: null,
            visibleClipIds: [],
            orderedClipIds: [],
            timelineDurationSeconds: 0,
            playbackStatus: 'idle',
        },
        selection: {
            kind: null,
            sceneItemId: null,
            sceneItemIds: [],
            sceneItemKind: null,
        },
        player: {
            previewTab: 'preview',
            isPlaying: false,
            currentTime: 0,
            currentFrame: 0,
        },
        scene: {
            selectedSceneId: null,
            editableComposition: null,
            guidesVisible: true,
            safeAreaVisible: true,
            itemTransforms: {},
            itemVisibility: {},
            itemOrder: [],
            itemLocks: {},
            itemGroups: {},
            focusedGroupId: null,
        },
        panels: {
            leftPanel: 'uploads',
            materialPaneWidth: 300,
            timelineHeight: 280,
            redclawDrawerOpen: true,
        },
        remotion: {
            motionPrompt: '',
        },
        script: {
            dirty: false,
        },
        editor: {
            projectFile: null,
            selection: {
                itemIds: [],
                primaryItemId: null,
                trackIds: [],
            },
            history: {
                undoStack: [],
                redoStack: [],
                canUndo: false,
                canRedo: false,
            },
            derived: {
                durationMs: 0,
                visibleItems: [],
                audibleItems: [],
                activeMotionItems: [],
            },
        },
        ...initialState,
    };

    const listeners = new Set<() => void>();

    return {
        getState: () => state,
        setState: (updater) => {
            const partial = typeof updater === 'function' ? updater(state) : updater;
            if (!partial || Object.keys(partial).length === 0) {
                return;
            }
            if (!hasStateChanges(state, partial)) {
                return;
            }
            state = {
                ...state,
                ...partial,
            };
            listeners.forEach((listener) => listener());
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export function useVideoEditorStore<Selected>(
    store: VideoEditorStore,
    selector: (state: VideoEditorState) => Selected
): Selected {
    return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
