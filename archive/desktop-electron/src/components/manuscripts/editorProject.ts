import type {
    RemotionCompositionConfig,
    RemotionOverlay,
    RemotionRenderMode,
    RemotionScene,
    RemotionSceneEntity,
    RemotionTransition,
} from './remotion/types';
import type { ItemKeyframes } from '@/types/keyframe';
import type { ProjectMarker } from '@/types/timeline';
import type { Transition } from '@/types/transition';

export type EditorTrackKind = 'video' | 'audio' | 'subtitle' | 'text' | 'motion';
export type EditorItemType = 'media' | 'subtitle' | 'text' | 'motion';

export type EditorTrackUi = {
    hidden: boolean;
    locked: boolean;
    muted: boolean;
    solo: boolean;
    collapsed: boolean;
    volume: number;
};

export type EditorAsset = {
    id: string;
    kind: 'video' | 'audio' | 'image' | 'text' | 'subtitle';
    title: string;
    src: string;
    mimeType?: string;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
};

export type EditorTrack = {
    id: string;
    kind: EditorTrackKind;
    name: string;
    order: number;
    ui: EditorTrackUi;
};

export type EditorMediaItem = {
    id: string;
    type: 'media';
    trackId: string;
    assetId: string;
    fromMs: number;
    durationMs: number;
    trimInMs: number;
    trimOutMs: number;
    enabled: boolean;
};

export type EditorSubtitleItem = {
    id: string;
    type: 'subtitle';
    trackId: string;
    text: string;
    fromMs: number;
    durationMs: number;
    style: Record<string, unknown>;
    enabled: boolean;
};

export type EditorTextItem = {
    id: string;
    type: 'text';
    trackId: string;
    text: string;
    fromMs: number;
    durationMs: number;
    style: Record<string, unknown>;
    enabled: boolean;
};

export type EditorMotionItem = {
    id: string;
    type: 'motion';
    trackId: string;
    bindItemId?: string;
    fromMs: number;
    durationMs: number;
    templateId: string;
    props: Record<string, unknown>;
    enabled: boolean;
};

export type EditorItem = EditorMediaItem | EditorSubtitleItem | EditorTextItem | EditorMotionItem;

export type EditorAnimationLayerBinding = {
    type: 'clip';
    targetId: string;
};

export type EditorAnimationLayer = {
    id: string;
    name: string;
    trackId: string;
    enabled: boolean;
    fromMs: number;
    durationMs: number;
    zIndex: number;
    renderMode: RemotionRenderMode;
    componentType: string;
    props: Record<string, unknown>;
    entities: RemotionSceneEntity[];
    bindings: EditorAnimationLayerBinding[];
};

export type EditorProjectFile = {
    version: 1;
    project: {
        id: string;
        title: string;
        width: number;
        height: number;
        fps: number;
        ratioPreset: '16:9' | '9:16' | '4:3' | '3:4';
        backgroundColor?: string;
    };
    script: {
        body: string;
    };
    assets: EditorAsset[];
    tracks: EditorTrack[];
    items: EditorItem[];
    animationLayers: EditorAnimationLayer[];
    markers?: ProjectMarker[];
    transitions?: Transition[];
    keyframes?: ItemKeyframes[];
    stage: {
        itemTransforms: Record<string, {
            x: number;
            y: number;
            width: number;
            height: number;
            lockAspectRatio: boolean;
            minWidth: number;
            minHeight: number;
        }>;
        itemVisibility: Record<string, boolean>;
        itemLocks: Record<string, boolean>;
        itemOrder: string[];
        itemGroups: Record<string, string>;
        focusedGroupId: string | null;
    };
    ai: {
        motionPrompt: string;
        lastEditBrief?: string | null;
        lastMotionBrief?: string | null;
        scriptApproval?: {
            status: 'pending' | 'confirmed';
            lastScriptUpdateAt?: number | null;
            lastScriptUpdateSource?: 'user' | 'ai' | 'system' | null;
            confirmedAt?: number | null;
        };
    };
};

export type EditorCommand =
    | { type: 'add_track'; kind: EditorTrackKind; trackId?: string }
    | { type: 'delete_tracks'; trackIds: string[] }
    | { type: 'upsert_assets'; assets: EditorAsset[] }
    | { type: 'add_item'; item: EditorItem }
    | { type: 'update_item'; itemId: string; patch: Partial<EditorItem> }
    | { type: 'delete_item'; itemId: string }
    | { type: 'delete_items'; itemIds: string[] }
    | { type: 'split_item'; itemId: string; splitMs: number }
    | { type: 'move_items'; itemIds: string[]; deltaMs: number; targetTrackId?: string }
    | { type: 'retime_item'; itemId: string; fromMs?: number; durationMs?: number }
    | { type: 'set_track_ui'; trackId: string; patch: Partial<EditorTrackUi> }
    | { type: 'reorder_tracks'; trackId: string; direction: 'up' | 'down' }
    | { type: 'update_stage_item'; itemId: string; patch?: Record<string, unknown>; visible?: boolean; locked?: boolean; groupId?: string }
    | { type: 'animation_layer_create'; layer: EditorAnimationLayer }
    | { type: 'animation_layer_update'; layerId: string; patch: Partial<EditorAnimationLayer> }
    | { type: 'animation_layer_delete'; layerId: string }
    | { type: 'generate_motion_items'; selectedItemIds?: string[]; instructions: string };

export type LegacyTimelineClip = {
    clipId?: string;
    assetId?: string;
    name?: string;
    track?: string;
    durationMs?: number;
    trimInMs?: number;
    trimOutMs?: number;
    enabled?: boolean;
    assetKind?: string;
    startMs?: number;
    endMs?: number;
    startSeconds?: number;
    endSeconds?: number;
    mediaPath?: string;
    mimeType?: string;
    subtitleStyle?: Record<string, unknown>;
    textStyle?: Record<string, unknown>;
    transitionStyle?: Record<string, unknown>;
};

export type ScriptBriefSection = {
    id: string;
    title: string;
    text: string;
    linkedItemId: string | null;
};

const PRIMARY_TRACK_ID = 'V1';

export function defaultTrackUi(): EditorTrackUi {
    return {
        hidden: false,
        locked: false,
        muted: false,
        solo: false,
        collapsed: false,
        volume: 1,
    };
}

export function isMediaItem(item: EditorItem): item is EditorMediaItem {
    return item.type === 'media';
}

export function isMotionItem(item: EditorItem): item is EditorMotionItem {
    return item.type === 'motion';
}

function sanitizeRemotionOutName(title: string): string {
    const normalized = title
        .trim()
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return normalized || 'redbox-motion';
}

function defaultRemotionRenderConfig(title: string, renderMode: RemotionRenderMode) {
    return {
        defaultOutName: sanitizeRemotionOutName(title),
        codec: renderMode === 'motion-layer' ? 'prores' : 'h264',
        imageFormat: renderMode === 'motion-layer' ? 'png' as const : 'jpeg' as const,
        pixelFormat: renderMode === 'motion-layer' ? 'yuva444p10le' : undefined,
        proResProfile: renderMode === 'motion-layer' ? '4444' : undefined,
        renderMode,
    };
}

export function isAnimationLayerBoundToClip(layer: EditorAnimationLayer) {
    return layer.bindings.some((binding) => binding.type === 'clip' && binding.targetId.trim() !== '');
}

function animationLayerToProjectedMotionItem(layer: EditorAnimationLayer): EditorMotionItem {
    const firstBinding = layer.bindings.find((binding) => binding.type === 'clip');
    return {
        id: layer.id,
        type: 'motion',
        trackId: layer.trackId,
        bindItemId: firstBinding?.targetId,
        fromMs: layer.fromMs,
        durationMs: layer.durationMs,
        templateId: String(layer.props.templateId || layer.componentType || 'static'),
        props: {
            ...layer.props,
            entities: layer.entities,
            overlayTitle: layer.props.overlayTitle ?? layer.name,
        },
        enabled: layer.enabled,
    };
}

export function deriveAnimationLayers(project: EditorProjectFile): EditorAnimationLayer[] {
    if (Array.isArray(project.animationLayers) && project.animationLayers.length > 0) {
        return project.animationLayers
            .map((layer, index) => ({
                ...layer,
                name: layer.name || `动画层 ${index + 1}`,
                trackId: layer.trackId || 'M1',
                enabled: layer.enabled !== false,
                fromMs: Math.max(0, layer.fromMs || 0),
                durationMs: Math.max(300, layer.durationMs || 2000),
                zIndex: Number.isFinite(layer.zIndex) ? layer.zIndex : index,
                renderMode: layer.renderMode || 'motion-layer',
                componentType: layer.componentType || String(layer.props?.templateId || 'scene-sequence'),
                props: layer.props || {},
                entities: Array.isArray(layer.entities) ? layer.entities : [],
                bindings: Array.isArray(layer.bindings) ? layer.bindings.filter((binding) => !!binding?.targetId) : [],
            }))
            .sort((left, right) => left.fromMs - right.fromMs || left.zIndex - right.zIndex);
    }
    return project.items
        .filter(isMotionItem)
        .map((item, index) => ({
            id: item.id,
            name: String(item.props.overlayTitle || item.templateId || `动画层 ${index + 1}`),
            trackId: item.trackId || 'M1',
            enabled: item.enabled,
            fromMs: item.fromMs,
            durationMs: item.durationMs,
            zIndex: index,
            renderMode: 'motion-layer' as RemotionRenderMode,
            componentType: String(item.props.componentType || item.templateId || 'scene-sequence'),
            props: { ...item.props, templateId: item.templateId },
            entities: Array.isArray(item.props.entities) ? item.props.entities as RemotionSceneEntity[] : [],
            bindings: item.bindItemId ? [{ type: 'clip' as const, targetId: item.bindItemId }] : [],
        }));
}

export function deriveProjectedEditorItems(project: EditorProjectFile): EditorItem[] {
    const nonMotionItems = project.items.filter((item) => item.type !== 'motion');
    const motionItems = deriveAnimationLayers(project).map(animationLayerToProjectedMotionItem);
    return [...nonMotionItems, ...motionItems];
}

function cloneEntity<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function isTextualItem(item: EditorItem): item is EditorTextItem | EditorSubtitleItem {
    return item.type === 'text' || item.type === 'subtitle';
}

export function trackOrder(project: EditorProjectFile): EditorTrack[] {
    return [...project.tracks].sort((left, right) => left.order - right.order);
}

export function timelineTracks(project: EditorProjectFile): EditorTrack[] {
    return trackOrder(project);
}

export function nonMotionTracks(project: EditorProjectFile): EditorTrack[] {
    return trackOrder(project).filter((track) => track.kind !== 'motion');
}

export function deriveTrackUiMap(project: EditorProjectFile): Record<string, EditorTrackUi> {
    return Object.fromEntries(project.tracks.map((track) => [track.id, track.ui]));
}

export function deriveTrackNames(project: EditorProjectFile, includeMotion = false): string[] {
    return timelineTracks(project)
        .filter((track) => includeMotion || track.kind !== 'motion')
        .map((track) => track.id);
}

export function buildAssetMap(project: EditorProjectFile): Record<string, EditorAsset> {
    return Object.fromEntries(project.assets.map((asset) => [asset.id, asset]));
}

export function deriveLegacyTimelineClips(project: EditorProjectFile): LegacyTimelineClip[] {
    const projectedItems = deriveProjectedEditorItems(project);
    const assetMap = buildAssetMap(project);
    const orderedTrackIds = deriveTrackNames(project, false);
    const trackIndex = new Map(orderedTrackIds.map((trackId, index) => [trackId, index]));
    const outgoingTransitions = new Map(
        (project.transitions || []).map((transition) => [transition.leftClipId, transition]),
    );
    return projectedItems
        .filter((item) => item.type !== 'motion')
        .slice()
        .sort((left, right) => {
            const leftTrack = trackIndex.get(left.trackId) ?? Number.MAX_SAFE_INTEGER;
            const rightTrack = trackIndex.get(right.trackId) ?? Number.MAX_SAFE_INTEGER;
            if (leftTrack !== rightTrack) return leftTrack - rightTrack;
            return left.fromMs - right.fromMs;
        })
        .map((item) => {
            if (item.type === 'media') {
                const asset = assetMap[item.assetId];
                return {
                    clipId: item.id,
                    assetId: item.assetId,
                    name: asset?.title || item.assetId,
                    track: item.trackId,
                    durationMs: item.durationMs,
                    trimInMs: item.trimInMs,
                    trimOutMs: item.trimOutMs,
                    enabled: item.enabled,
                    assetKind: asset?.kind || 'video',
                    startMs: item.fromMs,
                    endMs: item.fromMs + item.durationMs,
                    startSeconds: item.fromMs / 1000,
                    endSeconds: (item.fromMs + item.durationMs) / 1000,
                    mediaPath: asset?.src,
                    mimeType: asset?.mimeType,
                    subtitleStyle: {},
                    textStyle: {},
                    transitionStyle: outgoingTransitions.has(item.id)
                        ? {
                            presetId: outgoingTransitions.get(item.id)?.presentation,
                            kind: outgoingTransitions.get(item.id)?.presentation === 'fade'
                                ? 'fade'
                                : outgoingTransitions.get(item.id)?.presentation === 'slide'
                                    ? 'slide'
                                    : outgoingTransitions.get(item.id)?.presentation === 'wipe'
                                        ? 'wipe'
                                        : outgoingTransitions.get(item.id)?.presentation === 'flip'
                                            ? 'flip'
                                            : 'none',
                            direction: outgoingTransitions.get(item.id)?.direction as LegacyTimelineClip['transitionStyle']['direction'],
                            durationMs: Math.round(((outgoingTransitions.get(item.id)?.durationInFrames || 0) / Math.max(1, project.project.fps)) * 1000),
                        }
                        : {},
                };
            }
            return {
                clipId: item.id,
                assetId: undefined,
                name: item.text,
                track: item.trackId,
                durationMs: item.durationMs,
                trimInMs: 0,
                trimOutMs: 0,
                enabled: item.enabled,
                assetKind: item.type,
                startMs: item.fromMs,
                endMs: item.fromMs + item.durationMs,
                startSeconds: item.fromMs / 1000,
                endSeconds: (item.fromMs + item.durationMs) / 1000,
                mediaPath: '',
                mimeType: 'text/plain',
                subtitleStyle: item.type === 'subtitle' ? item.style : {},
                textStyle: item.type === 'text' ? item.style : {},
                transitionStyle: outgoingTransitions.has(item.id)
                    ? {
                        presetId: outgoingTransitions.get(item.id)?.presentation,
                        kind: outgoingTransitions.get(item.id)?.presentation === 'fade'
                            ? 'fade'
                            : outgoingTransitions.get(item.id)?.presentation === 'slide'
                                ? 'slide'
                                : outgoingTransitions.get(item.id)?.presentation === 'wipe'
                                    ? 'wipe'
                                    : outgoingTransitions.get(item.id)?.presentation === 'flip'
                                        ? 'flip'
                                        : 'none',
                        direction: outgoingTransitions.get(item.id)?.direction as LegacyTimelineClip['transitionStyle']['direction'],
                        durationMs: Math.round(((outgoingTransitions.get(item.id)?.durationInFrames || 0) / Math.max(1, project.project.fps)) * 1000),
                    }
                    : {},
            };
        });
}

export function buildRemotionCompositionFromEditorProject(project: EditorProjectFile): RemotionCompositionConfig {
    const assetMap = buildAssetMap(project);
    const projectedItems = deriveProjectedEditorItems(project);
    const animationLayers = deriveAnimationLayers(project).filter((layer) => layer.enabled);
    const renderMode: RemotionRenderMode =
        animationLayers.find((layer) => layer.renderMode === 'full' || layer.renderMode === 'motion-layer')?.renderMode
        || 'motion-layer';
    const standaloneScenes: RemotionScene[] = animationLayers
        .filter((layer) => !isAnimationLayerBoundToClip(layer))
        .map((layer) => {
            const overlays = Array.isArray(layer.props?.overlays)
                ? (layer.props.overlays as RemotionOverlay[])
                : [];
            return {
                id: layer.id,
                clipId: undefined,
                assetId: undefined,
                assetKind: 'unknown',
                src: '',
                startFrame: Math.round((layer.fromMs / 1000) * project.project.fps),
                durationInFrames: Math.max(12, Math.round((layer.durationMs / 1000) * project.project.fps)),
                trimInFrames: 0,
                motionPreset: (layer.props.templateId as RemotionScene['motionPreset']) || 'static',
                overlayTitle: typeof layer.props?.overlayTitle === 'string' ? String(layer.props.overlayTitle) : layer.name,
                overlayBody: typeof layer.props?.overlayBody === 'string' ? String(layer.props.overlayBody) : undefined,
                overlays,
                entities: layer.entities,
            };
        });
    const boundScenes: RemotionScene[] = projectedItems
        .filter(isMediaItem)
        .filter((item) => item.enabled)
        .filter((item) => {
            const track = project.tracks.find((candidate) => candidate.id === item.trackId);
            return track?.kind === 'video';
        })
        .flatMap((item) => {
            const asset = assetMap[item.assetId];
            const layer = animationLayers.find((candidate) => candidate.bindings.some((binding) => binding.targetId === item.id)) || null;
            if (!layer) return [];
            const overlays = Array.isArray(layer.props?.overlays)
                ? (layer.props.overlays as RemotionOverlay[])
                : [];
            return [{
                id: layer.id || `scene-${item.id}`,
                clipId: item.id,
                assetId: item.assetId,
                assetKind: (asset?.kind === 'image' || asset?.kind === 'video' || asset?.kind === 'audio') ? asset.kind : 'unknown',
                src: asset?.src || '',
                startFrame: Math.round((item.fromMs / 1000) * project.project.fps),
                durationInFrames: Math.max(12, Math.round(((layer.durationMs || item.durationMs) / 1000) * project.project.fps)),
                trimInFrames: Math.round((item.trimInMs / 1000) * project.project.fps),
                motionPreset: (layer.props.templateId as RemotionScene['motionPreset']) || 'static',
                overlayTitle: typeof layer.props?.overlayTitle === 'string' ? String(layer.props.overlayTitle) : layer.name,
                overlayBody: typeof layer.props?.overlayBody === 'string' ? String(layer.props.overlayBody) : undefined,
                overlays,
                entities: layer.entities,
            }];
        });
    const scenes: RemotionScene[] = [...standaloneScenes, ...boundScenes].sort((left, right) => left.startFrame - right.startFrame);
    const sceneByClipId = new Map(
        scenes
            .filter((scene) => typeof scene.clipId === 'string' && scene.clipId.trim() !== '')
            .map((scene) => [String(scene.clipId), scene]),
    );
    const transitions: RemotionTransition[] = (project.transitions || [])
        .filter((transition) => sceneByClipId.has(transition.leftClipId) && sceneByClipId.has(transition.rightClipId))
        .map((transition) => ({
            id: transition.id,
            type: transition.type || 'crossfade',
            presentation: transition.presentation,
            timing: transition.timing,
            leftClipId: transition.leftClipId,
            rightClipId: transition.rightClipId,
            trackId: transition.trackId,
            durationInFrames: Math.max(1, transition.durationInFrames || 1),
            direction: transition.direction,
            alignment: typeof transition.alignment === 'number' ? transition.alignment : undefined,
            bezierPoints: transition.bezierPoints,
            presetId: transition.presetId,
            properties: transition.properties,
        }));
    const durationInFrames = scenes.reduce((max, scene) => Math.max(max, scene.startFrame + scene.durationInFrames), 90);
    return {
        version: 1,
        title: project.project.title,
        entryCompositionId: 'RedBoxVideoMotion',
        width: project.project.width,
        height: project.project.height,
        fps: project.project.fps,
        durationInFrames,
        backgroundColor: project.project.backgroundColor,
        renderMode,
        scenes,
        transitions,
        sceneItemTransforms: project.stage.itemTransforms,
        render: defaultRemotionRenderConfig(project.project.title, renderMode),
    };
}

export function buildScriptBriefSections(project: EditorProjectFile): ScriptBriefSection[] {
    const rawSections = project.script.body
        .split(/\n{2,}|\r\n\r\n/)
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const timedItems = project.items
        .filter((item) => item.type !== 'motion')
        .slice()
        .sort((left, right) => left.fromMs - right.fromMs);
    return rawSections.map((text, index) => ({
        id: `brief-${index + 1}`,
        title: `段落 ${index + 1}`,
        text,
        linkedItemId: timedItems[index]?.id || timedItems[timedItems.length - 1]?.id || null,
    }));
}

function normalizeTimelineItems(next: EditorProjectFile): EditorProjectFile {
    const orderedTracks = trackOrder(next);
    const mainVideoTrackId = orderedTracks.find((track) => track.kind === 'video')?.id || null;
    const itemOriginalIndex = new Map(next.items.map((item, index) => [item.id, index]));
    const grouped = new Map<string, EditorItem[]>();

    next.items.forEach((item) => {
        const bucket = grouped.get(item.trackId) || [];
        bucket.push(item);
        grouped.set(item.trackId, bucket);
    });

    const normalizedItems: EditorItem[] = [];
    orderedTracks.forEach((track) => {
        const items = (grouped.get(track.id) || []).slice().sort((left, right) => {
            if (left.fromMs !== right.fromMs) return left.fromMs - right.fromMs;
            return (itemOriginalIndex.get(left.id) ?? 0) - (itemOriginalIndex.get(right.id) ?? 0);
        });
        let cursor = 0;
        items.forEach((item) => {
            const normalizedFromMs = track.id === mainVideoTrackId
                ? cursor
                : Math.max(item.fromMs, cursor);
            const nextItem = {
                ...item,
                fromMs: normalizedFromMs,
            } as EditorItem;
            normalizedItems.push(nextItem);
            cursor = normalizedFromMs + item.durationMs;
        });
    });

    const trackIdSet = new Set(orderedTracks.map((track) => track.id));
    next.items
        .filter((item) => !trackIdSet.has(item.trackId))
        .forEach((item) => normalizedItems.push(item));

    return {
        ...next,
        items: normalizedItems,
    };
}

function normalizeAnimationLayers(next: EditorProjectFile): EditorProjectFile {
    const motionTrackIds = trackOrder(next)
        .filter((track) => track.kind === 'motion')
        .map((track) => track.id);
    const knownTrackIds = new Set(motionTrackIds);
    const grouped = new Map<string, EditorAnimationLayer[]>();
    next.animationLayers.forEach((layer) => {
        const trackId = layer.trackId || 'M1';
        const bucket = grouped.get(trackId) || [];
        bucket.push(layer);
        grouped.set(trackId, bucket);
    });

    const normalized: EditorAnimationLayer[] = [];
    motionTrackIds.forEach((trackId) => {
        const layers = (grouped.get(trackId) || [])
            .slice()
            .sort((left, right) => left.fromMs - right.fromMs || left.zIndex - right.zIndex);
        let cursor = 0;
        layers.forEach((layer, index) => {
            const fromMs = Math.max(cursor, layer.fromMs || 0);
            const durationMs = Math.max(300, layer.durationMs || 0);
            normalized.push({
                ...layer,
                trackId,
                fromMs,
                durationMs,
                zIndex: index,
            });
            cursor = fromMs + durationMs;
        });
    });

    next.animationLayers
        .filter((layer) => !knownTrackIds.has(layer.trackId))
        .forEach((layer, index) => {
            normalized.push({
                ...layer,
                trackId: layer.trackId || `M${motionTrackIds.length + index + 1}`,
                fromMs: Math.max(0, layer.fromMs || 0),
                durationMs: Math.max(300, layer.durationMs || 0),
            });
        });

    return {
        ...next,
        animationLayers: normalized,
    };
}

function cloneProject(project: EditorProjectFile): EditorProjectFile {
    return {
        ...project,
        assets: project.assets.map((asset) => ({ ...asset, metadata: asset.metadata ? { ...asset.metadata } : undefined })),
        tracks: project.tracks.map((track) => ({ ...track, ui: { ...track.ui } })),
        items: project.items.map((item) => ({
            ...item,
            ...(item.type === 'motion'
                ? { props: { ...item.props } }
                : item.type === 'text' || item.type === 'subtitle'
                    ? { style: { ...item.style } }
                    : {}),
        })) as EditorItem[],
        stage: {
            itemTransforms: Object.fromEntries(Object.entries(project.stage.itemTransforms).map(([key, value]) => [key, { ...value }])),
            itemVisibility: { ...project.stage.itemVisibility },
            itemLocks: { ...project.stage.itemLocks },
            itemOrder: [...project.stage.itemOrder],
            itemGroups: { ...project.stage.itemGroups },
            focusedGroupId: project.stage.focusedGroupId,
        },
        animationLayers: deriveAnimationLayers(project).map((layer) => ({
            ...layer,
            props: { ...layer.props },
            entities: Array.isArray(layer.entities) ? layer.entities.map((entity) => cloneEntity(entity)) : [],
            bindings: Array.isArray(layer.bindings) ? layer.bindings.map((binding) => ({ ...binding })) : [],
        })),
        ai: { ...project.ai },
    };
}

function normalizeTrackUiPatch(track: EditorTrack, patch: Partial<EditorTrackUi>): EditorTrack {
    return {
        ...track,
        ui: {
            ...track.ui,
            ...patch,
        },
    };
}

export function applyEditorCommandLocal(project: EditorProjectFile, command: EditorCommand): EditorProjectFile {
    let next = cloneProject(project);
    switch (command.type) {
        case 'upsert_assets': {
            const assetMap = new Map(next.assets.map((asset) => [asset.id, asset]));
            command.assets.forEach((asset) => {
                assetMap.set(asset.id, asset);
            });
            next.assets = Array.from(assetMap.values());
            return next;
        }
        case 'add_track': {
            const trackId = command.trackId || nextTrackIdLocal(next, command.kind);
            next.tracks.push({
                id: trackId,
                kind: command.kind,
                name: trackId,
                order: next.tracks.length,
                ui: defaultTrackUi(),
            });
            return normalizeAnimationLayers(next);
        }
        case 'delete_tracks': {
            const trackIdSet = new Set(command.trackIds.filter((trackId) => trackId !== PRIMARY_TRACK_ID));
            if (trackIdSet.size === 0) return next;
            next.tracks = next.tracks.filter((track) => !trackIdSet.has(track.id)).map((track, order) => ({ ...track, order }));
            next.items = next.items.filter((item) => !trackIdSet.has(item.trackId));
            next.animationLayers = next.animationLayers.filter((layer) => !trackIdSet.has(layer.trackId));
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        }
        case 'add_item':
            if (command.item.type === 'motion') {
                next.animationLayers.push({
                    id: command.item.id,
                    name: String(command.item.props.overlayTitle || command.item.templateId || '动画层'),
                    trackId: command.item.trackId,
                    enabled: command.item.enabled,
                    fromMs: command.item.fromMs,
                    durationMs: command.item.durationMs,
                    zIndex: next.animationLayers.length,
                    renderMode: 'motion-layer',
                    componentType: String(command.item.props.componentType || command.item.templateId || 'scene-sequence'),
                    props: { ...command.item.props, templateId: command.item.templateId },
                    entities: Array.isArray(command.item.props.entities) ? command.item.props.entities as RemotionSceneEntity[] : [],
                    bindings: command.item.bindItemId ? [{ type: 'clip', targetId: command.item.bindItemId }] : [],
                });
                return normalizeAnimationLayers(next);
            }
            next.items.push(command.item);
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        case 'update_item':
            if (next.animationLayers.some((layer) => layer.id === command.itemId)) {
                next.animationLayers = next.animationLayers.map((layer) => layer.id === command.itemId ? ({
                    ...layer,
                    ...(command.patch as Partial<EditorAnimationLayer>),
                    props: {
                        ...layer.props,
                        ...(command.patch as Partial<EditorMotionItem>).props,
                        ...(command.patch as Partial<EditorMotionItem>).templateId ? { templateId: (command.patch as Partial<EditorMotionItem>).templateId } : {},
                    },
                    entities: Array.isArray((command.patch as Partial<EditorMotionItem>).props?.entities)
                        ? (command.patch as Partial<EditorMotionItem>).props?.entities as RemotionSceneEntity[]
                        : layer.entities,
                }) : layer);
                return normalizeAnimationLayers(next);
            }
            next.items = next.items.map((item) => item.id === command.itemId ? ({ ...item, ...command.patch } as EditorItem) : item);
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        case 'delete_item':
            if (next.animationLayers.some((layer) => layer.id === command.itemId)) {
                next.animationLayers = next.animationLayers.filter((layer) => layer.id !== command.itemId);
                return normalizeAnimationLayers(next);
            }
            next.items = next.items.filter((item) => item.id !== command.itemId);
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        case 'delete_items':
            next.animationLayers = next.animationLayers.filter((layer) => !command.itemIds.includes(layer.id));
            next.items = next.items.filter((item) => !command.itemIds.includes(item.id));
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        case 'split_item': {
            const target = next.items.find((item) => item.id === command.itemId);
            if (!target || target.type === 'motion') return next;
            const splitOffset = command.splitMs - target.fromMs;
            if (splitOffset <= 0 || splitOffset >= target.durationMs) return next;
            const duplicate: EditorItem = target.type === 'media'
                ? {
                    ...target,
                    id: `${target.id}-split-${Math.random().toString(36).slice(2, 8)}`,
                    fromMs: command.splitMs,
                    durationMs: target.durationMs - splitOffset,
                    trimInMs: target.trimInMs + splitOffset,
                }
                : {
                    ...target,
                    id: `${target.id}-split-${Math.random().toString(36).slice(2, 8)}`,
                    fromMs: command.splitMs,
                    durationMs: target.durationMs - splitOffset,
                };
            next.items = next.items.flatMap((item) => {
                if (item.id !== command.itemId) return [item];
                return [{ ...item, durationMs: splitOffset } as EditorItem, duplicate];
            });
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        }
        case 'move_items':
            next.animationLayers = next.animationLayers.map((layer) => {
                if (!command.itemIds.includes(layer.id)) return layer;
                return {
                    ...layer,
                    fromMs: Math.max(0, layer.fromMs + command.deltaMs),
                    trackId: command.targetTrackId || layer.trackId,
                };
            });
            next.items = next.items.map((item) => {
                if (!command.itemIds.includes(item.id) || item.type === 'motion') return item;
                return {
                    ...item,
                    fromMs: Math.max(0, item.fromMs + command.deltaMs),
                    trackId: command.targetTrackId || item.trackId,
                } as EditorItem;
            });
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        case 'retime_item':
            if (next.animationLayers.some((layer) => layer.id === command.itemId)) {
                next.animationLayers = next.animationLayers.map((layer) => layer.id === command.itemId ? ({
                    ...layer,
                    fromMs: command.fromMs ?? layer.fromMs,
                    durationMs: command.durationMs ?? layer.durationMs,
                }) : layer);
                return normalizeAnimationLayers(next);
            }
            next.items = next.items.map((item) => item.id === command.itemId ? ({
                ...item,
                fromMs: command.fromMs ?? item.fromMs,
                durationMs: command.durationMs ?? item.durationMs,
            } as EditorItem) : item);
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        case 'animation_layer_create':
            next.animationLayers.push(command.layer);
            return normalizeAnimationLayers(next);
        case 'animation_layer_update':
            next.animationLayers = next.animationLayers.map((layer) => layer.id === command.layerId ? ({
                ...layer,
                ...command.patch,
                props: {
                    ...layer.props,
                    ...(command.patch.props || {}),
                },
                entities: command.patch.entities ?? layer.entities,
                bindings: command.patch.bindings ?? layer.bindings,
            }) : layer);
            return normalizeAnimationLayers(next);
        case 'animation_layer_delete':
            next.animationLayers = next.animationLayers.filter((layer) => layer.id !== command.layerId);
            return normalizeAnimationLayers(next);
        case 'set_track_ui':
            next.tracks = next.tracks.map((track) => track.id === command.trackId ? normalizeTrackUiPatch(track, command.patch) : track);
            return normalizeAnimationLayers(next);
        case 'reorder_tracks': {
            const index = next.tracks.findIndex((track) => track.id === command.trackId);
            if (index < 0) return next;
            const targetIndex = command.direction === 'down'
                ? Math.min(next.tracks.length - 1, index + 1)
                : Math.max(0, index - 1);
            const [track] = next.tracks.splice(index, 1);
            next.tracks.splice(targetIndex, 0, track);
            next.tracks = next.tracks.map((item, order) => ({ ...item, order }));
            return normalizeAnimationLayers(normalizeTimelineItems(next));
        }
        case 'update_stage_item':
            if (command.patch) {
                const current = next.stage.itemTransforms[command.itemId];
                if (current) {
                    next.stage.itemTransforms[command.itemId] = { ...current, ...(command.patch as Partial<typeof current>) };
                }
            }
            if (typeof command.visible === 'boolean') {
                next.stage.itemVisibility[command.itemId] = command.visible;
            }
            if (typeof command.locked === 'boolean') {
                next.stage.itemLocks[command.itemId] = command.locked;
            }
            if (typeof command.groupId === 'string') {
                next.stage.itemGroups[command.itemId] = command.groupId;
            }
            return next;
        case 'generate_motion_items':
            return next;
        default:
            return next;
    }
}

function nextTrackIdLocal(project: EditorProjectFile, kind: EditorTrackKind): string {
    const prefix = kind === 'audio' ? 'A' : kind === 'subtitle' ? 'S' : kind === 'text' ? 'T' : kind === 'motion' ? 'M' : 'V';
    const values = project.tracks
        .filter((track) => track.kind === kind)
        .map((track) => Number(track.id.slice(1)))
        .filter(Number.isFinite);
    return `${prefix}${(Math.max(0, ...values) + 1) || 1}`;
}
