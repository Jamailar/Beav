import type { RemotionCompositionConfig, RemotionOverlay, RemotionScene } from './remotion/types';

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

export type EditorProjectFile = {
    version: 1;
    project: {
        id: string;
        title: string;
        width: number;
        height: number;
        fps: number;
        ratioPreset: '16:9' | '9:16';
        backgroundColor?: string;
    };
    script: {
        body: string;
    };
    assets: EditorAsset[];
    tracks: EditorTrack[];
    items: EditorItem[];
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
    const assetMap = buildAssetMap(project);
    const orderedTrackIds = deriveTrackNames(project, false);
    const trackIndex = new Map(orderedTrackIds.map((trackId, index) => [trackId, index]));
    return project.items
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
                    transitionStyle: {},
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
                transitionStyle: {},
            };
        });
}

export function buildRemotionCompositionFromEditorProject(project: EditorProjectFile): RemotionCompositionConfig {
    const assetMap = buildAssetMap(project);
    const motionItems = project.items.filter(isMotionItem).filter((item) => item.enabled);
    const scenes: RemotionScene[] = project.items
        .filter(isMediaItem)
        .filter((item) => item.enabled)
        .filter((item) => {
            const track = project.tracks.find((candidate) => candidate.id === item.trackId);
            return track?.kind === 'video';
        })
        .map((item) => {
            const asset = assetMap[item.assetId];
            const motion = motionItems.find((candidate) => candidate.bindItemId === item.id) || null;
            const overlays = Array.isArray(motion?.props?.overlays)
                ? (motion?.props?.overlays as RemotionOverlay[])
                : [];
            return {
                id: motion?.id || `scene-${item.id}`,
                clipId: item.id,
                assetId: item.assetId,
                assetKind: (asset?.kind === 'image' || asset?.kind === 'video' || asset?.kind === 'audio') ? asset.kind : 'unknown',
                src: asset?.src || '',
                startFrame: Math.round((item.fromMs / 1000) * project.project.fps),
                durationInFrames: Math.max(12, Math.round(((motion?.durationMs || item.durationMs) / 1000) * project.project.fps)),
                trimInFrames: Math.round((item.trimInMs / 1000) * project.project.fps),
                motionPreset: (motion?.templateId as RemotionScene['motionPreset']) || 'static',
                overlayTitle: typeof motion?.props?.overlayTitle === 'string' ? String(motion.props.overlayTitle) : undefined,
                overlayBody: typeof motion?.props?.overlayBody === 'string' ? String(motion.props.overlayBody) : undefined,
                overlays,
            };
        });
    const durationInFrames = scenes.reduce((max, scene) => Math.max(max, scene.startFrame + scene.durationInFrames), 90);
    return {
        version: 1,
        title: project.project.title,
        width: project.project.width,
        height: project.project.height,
        fps: project.project.fps,
        durationInFrames,
        backgroundColor: project.project.backgroundColor,
        scenes,
        sceneItemTransforms: project.stage.itemTransforms,
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
    const next = cloneProject(project);
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
            return next;
        }
        case 'delete_tracks': {
            const trackIdSet = new Set(command.trackIds);
            next.tracks = next.tracks.filter((track) => !trackIdSet.has(track.id)).map((track, order) => ({ ...track, order }));
            next.items = next.items.filter((item) => !trackIdSet.has(item.trackId));
            return next;
        }
        case 'add_item':
            next.items.push(command.item);
            return next;
        case 'update_item':
            next.items = next.items.map((item) => item.id === command.itemId ? ({ ...item, ...command.patch } as EditorItem) : item);
            return next;
        case 'delete_item':
            next.items = next.items.filter((item) => item.id !== command.itemId);
            return next;
        case 'delete_items':
            next.items = next.items.filter((item) => !command.itemIds.includes(item.id));
            return next;
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
            return next;
        }
        case 'move_items':
            next.items = next.items.map((item) => {
                if (!command.itemIds.includes(item.id)) return item;
                return {
                    ...item,
                    fromMs: Math.max(0, item.fromMs + command.deltaMs),
                    trackId: command.targetTrackId || item.trackId,
                } as EditorItem;
            });
            return next;
        case 'retime_item':
            next.items = next.items.map((item) => item.id === command.itemId ? ({
                ...item,
                fromMs: command.fromMs ?? item.fromMs,
                durationMs: command.durationMs ?? item.durationMs,
            } as EditorItem) : item);
            return next;
        case 'set_track_ui':
            next.tracks = next.tracks.map((track) => track.id === command.trackId ? normalizeTrackUiPatch(track, command.patch) : track);
            return next;
        case 'reorder_tracks': {
            const index = next.tracks.findIndex((track) => track.id === command.trackId);
            if (index < 0) return next;
            const targetIndex = command.direction === 'down'
                ? Math.min(next.tracks.length - 1, index + 1)
                : Math.max(0, index - 1);
            const [track] = next.tracks.splice(index, 1);
            next.tracks.splice(targetIndex, 0, track);
            next.tracks = next.tracks.map((item, order) => ({ ...item, order }));
            return next;
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
