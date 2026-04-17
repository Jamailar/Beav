import type { ItemKeyframes } from '@/types/keyframe';
import type {
    ImageItem,
    ProjectMarker,
    TextItem,
    TimelineItem,
    TimelineTrack,
    VideoItem,
    AudioItem,
} from '@/types/timeline';
import type { Transition } from '@/types/transition';
import type { TransformProperties } from '@/types/transform';
import {
    type EditorAsset,
    type EditorItem,
    type EditorMediaItem,
    type EditorProjectFile,
    type EditorSubtitleItem,
    type EditorTextItem,
    type EditorTrack,
    deriveLegacyTimelineClips,
    deriveTrackNames,
    deriveTrackUiMap,
} from './editorProject';
import { resolveAssetUrl } from '../../utils/pathManager';

export type RedBoxPackageStateLike = Record<string, unknown> & {
    timelineSummary?: Record<string, unknown>;
};

export type RedBoxTimelineProjection = {
    tracks: TimelineTrack[];
    items: TimelineItem[];
    markers: ProjectMarker[];
    transitions: Transition[];
    keyframes: ItemKeyframes[];
    durationSeconds: number;
};

const VIDEO_TRACK_HEIGHT = 96;
const AUDIO_TRACK_HEIGHT = 72;

export function msToFrame(valueMs: number, fps: number): number {
    return Math.max(0, Math.round((Math.max(0, valueMs) / 1000) * Math.max(1, fps)));
}

export function frameToMs(valueFrames: number, fps: number): number {
    return Math.max(0, Math.round((Math.max(0, valueFrames) / Math.max(1, fps)) * 1000));
}

function pickNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trackHeight(track: EditorTrack): number {
    return track.kind === 'audio' ? AUDIO_TRACK_HEIGHT : VIDEO_TRACK_HEIGHT;
}

function trackToTimelineTrack(track: EditorTrack, uiOverride?: EditorTrack['ui']): TimelineTrack {
    const ui = uiOverride || track.ui;
    return {
        id: track.id,
        name: track.name,
        kind: track.kind === 'audio' ? 'audio' : 'video',
        height: trackHeight(track),
        locked: ui.locked,
        visible: !ui.hidden,
        muted: ui.muted,
        solo: ui.solo,
        volume: ui.volume,
        order: track.order,
        items: [],
        isCollapsed: ui.collapsed,
    };
}

function mediaItemToTimelineItem(item: EditorMediaItem, asset: EditorAsset | undefined, fps: number): VideoItem | AudioItem | ImageItem {
    const base = {
        id: item.id,
        trackId: item.trackId,
        from: msToFrame(item.fromMs, fps),
        durationInFrames: Math.max(1, msToFrame(item.durationMs, fps)),
        label: asset?.title || item.assetId,
        mediaId: item.assetId,
        trimStart: msToFrame(item.trimInMs, fps),
        trimEnd: msToFrame(item.trimOutMs, fps),
        sourceDuration: asset?.durationMs ? msToFrame(asset.durationMs, fps) : undefined,
        sourceFps: fps,
        transform: undefined as TransformProperties | undefined,
    };
    const sourceWidth = pickNumber(asset?.metadata?.width);
    const sourceHeight = pickNumber(asset?.metadata?.height);
    const src = asset?.src ? resolveAssetUrl(asset.src) : '';

    if (asset?.kind === 'audio') {
        return {
            ...base,
            type: 'audio',
            src,
        };
    }

    if (asset?.kind === 'image') {
        return {
            ...base,
            type: 'image',
            src,
            sourceWidth,
            sourceHeight,
        };
    }

    return {
        ...base,
        type: 'video',
        src,
        sourceWidth,
        sourceHeight,
    };
}

function textItemToTimelineItem(item: EditorSubtitleItem | EditorTextItem, fps: number): TextItem {
    return {
        id: item.id,
        trackId: item.trackId,
        type: 'text',
        text: item.text,
        label: item.text || item.id,
        from: msToFrame(item.fromMs, fps),
        durationInFrames: Math.max(1, msToFrame(item.durationMs, fps)),
        color: String(item.style?.color || '#ffffff'),
        backgroundColor: typeof item.style?.backgroundColor === 'string' ? item.style.backgroundColor : undefined,
        fontSize: typeof item.style?.fontSize === 'number' ? item.style.fontSize : undefined,
        fontWeight: typeof item.style?.fontWeight === 'string' ? item.style.fontWeight as TextItem['fontWeight'] : undefined,
        textAlign: typeof item.style?.align === 'string' ? item.style.align as TextItem['textAlign'] : undefined,
    };
}

function inferTrackKind(trackId: string, fallback: TimelineTrack['kind']): EditorTrack['kind'] {
    if (fallback === 'audio' || trackId.startsWith('A')) return 'audio';
    if (trackId.startsWith('S')) return 'subtitle';
    if (trackId.startsWith('T')) return 'text';
    return 'video';
}

function inferTextItemType(baseTrack: EditorTrack | undefined, trackId: string): 'subtitle' | 'text' {
    if (baseTrack?.kind === 'subtitle' || trackId.startsWith('S')) return 'subtitle';
    return 'text';
}

function toEditorTrack(track: TimelineTrack, baseTrack: EditorTrack | undefined): EditorTrack {
    const kind = inferTrackKind(track.id, track.kind);
    return {
        id: track.id,
        kind,
        name: track.name || track.id,
        order: track.order,
        ui: {
            hidden: track.visible === false,
            locked: track.locked,
            muted: track.muted,
            solo: track.solo,
            collapsed: Boolean(track.isCollapsed),
            volume: typeof track.volume === 'number' ? track.volume : (baseTrack?.ui.volume ?? 1),
        },
    };
}

function toEditorItem(
    item: TimelineItem,
    baseTrack: EditorTrack | undefined,
    baseItem: EditorItem | undefined,
    assetId: string | undefined,
    fps: number,
): EditorItem | null {
    if (item.type === 'video' || item.type === 'audio' || item.type === 'image') {
        return {
            id: item.id,
            type: 'media',
            trackId: item.trackId,
            assetId: assetId || ((baseItem && baseItem.type === 'media') ? baseItem.assetId : ''),
            fromMs: frameToMs(item.from, fps),
            durationMs: frameToMs(item.durationInFrames, fps),
            trimInMs: frameToMs(item.trimStart || 0, fps),
            trimOutMs: frameToMs(item.trimEnd || 0, fps),
            enabled: (baseItem && 'enabled' in baseItem) ? Boolean(baseItem.enabled) : true,
        };
    }

    if (item.type === 'text') {
        const nextType = inferTextItemType(baseTrack, item.trackId);
        const shared = {
            id: item.id,
            trackId: item.trackId,
            text: item.text,
            fromMs: frameToMs(item.from, fps),
            durationMs: frameToMs(item.durationInFrames, fps),
            enabled: (baseItem && 'enabled' in baseItem) ? Boolean(baseItem.enabled) : true,
            style: {
                ...(baseItem && (baseItem.type === 'subtitle' || baseItem.type === 'text') ? baseItem.style : {}),
                color: item.color,
                backgroundColor: item.backgroundColor,
                fontSize: item.fontSize,
                fontWeight: item.fontWeight,
                align: item.textAlign,
            },
        };

        if (nextType === 'subtitle') {
            return {
                ...shared,
                type: 'subtitle',
            };
        }

        return {
            ...shared,
            type: 'text',
        };
    }

    return baseItem || null;
}

export function projectDurationMs(project: EditorProjectFile): number {
    return project.items.reduce((max, item) => Math.max(max, item.fromMs + item.durationMs), 0);
}

export function projectToFreecutTimeline(
    project: EditorProjectFile,
    trackUiOverride?: Record<string, EditorTrack['ui']>,
): RedBoxTimelineProjection {
    const fps = Math.max(1, project.project.fps || 30);
    const assetMap = Object.fromEntries(project.assets.map((asset) => [asset.id, asset]));
    const tracks = project.tracks
        .filter((track) => track.kind !== 'motion')
        .sort((left, right) => left.order - right.order)
        .map((track) => trackToTimelineTrack(track, trackUiOverride?.[track.id]));
    const items = project.items
        .filter((item) => item.type !== 'motion')
        .map((item) => {
            if (item.type === 'media') {
                return mediaItemToTimelineItem(item, assetMap[item.assetId], fps);
            }
            return textItemToTimelineItem(item, fps);
        });
    const markers = Array.isArray(project.markers) ? project.markers : [];
    const transitions = Array.isArray(project.transitions) ? project.transitions : [];
    const keyframes = Array.isArray(project.keyframes) ? project.keyframes : [];
    const durationFrames = Math.max(
        ...items.map((item) => item.from + item.durationInFrames),
        ...markers.map((marker) => marker.frame),
        msToFrame(projectDurationMs(project), fps),
        fps * 6,
    );

    return {
        tracks,
        items,
        markers,
        transitions,
        keyframes,
        durationSeconds: Math.max(6, durationFrames / fps),
    };
}

export function freecutTimelineToProject(
    baseProject: EditorProjectFile,
    snapshot: Pick<RedBoxTimelineProjection, 'tracks' | 'items' | 'markers' | 'transitions' | 'keyframes'>,
): EditorProjectFile {
    const fps = Math.max(1, baseProject.project.fps || 30);
    const trackById = new Map(baseProject.tracks.map((track) => [track.id, track]));
    const itemById = new Map(baseProject.items.map((item) => [item.id, item]));
    const mediaAssetBySrc = new Map(baseProject.assets.map((asset) => [asset.src, asset.id]));

    const timelineTracks = snapshot.tracks
        .map((track) => toEditorTrack(track, trackById.get(track.id)))
        .sort((left, right) => left.order - right.order);
    const motionTracks = baseProject.tracks.filter((track) => track.kind === 'motion');
    const nextTracks = [...timelineTracks, ...motionTracks].map((track, order) => ({
        ...track,
        order,
    }));

    const timelineItems = snapshot.items
        .map((item) => {
            const baseTrack = trackById.get(item.trackId);
            const baseItem = itemById.get(item.id);
            const assetId = item.mediaId || ((baseItem && baseItem.type === 'media') ? baseItem.assetId : mediaAssetBySrc.get((item as VideoItem | AudioItem | ImageItem).src));
            return toEditorItem(item, baseTrack, baseItem, assetId, fps);
        })
        .filter(Boolean) as EditorItem[];
    const motionItems = baseProject.items.filter((item) => item.type === 'motion');

    return {
        ...baseProject,
        tracks: nextTracks,
        items: [...timelineItems, ...motionItems],
        markers: snapshot.markers,
        transitions: snapshot.transitions,
        keyframes: snapshot.keyframes,
    };
}

export function buildOptimisticPackageState(
    packageState: RedBoxPackageStateLike | null | undefined,
    nextProject: EditorProjectFile,
): RedBoxPackageStateLike {
    const trackUi = deriveTrackUiMap(nextProject);
    return {
        ...(packageState || {}),
        editorProject: nextProject,
        timelineSummary: {
            ...((packageState?.timelineSummary as Record<string, unknown>) || {}),
            clips: deriveLegacyTimelineClips(nextProject),
            trackNames: deriveTrackNames(nextProject, false),
            trackUi,
        },
    };
}

export function mediaItemsFromEditorProject(project: EditorProjectFile) {
    return project.assets.map((asset) => ({
        id: asset.id,
        name: asset.title,
        src: resolveAssetUrl(asset.src),
        mimeType: asset.mimeType || 'application/octet-stream',
        duration: Math.max(0, Number(asset.durationMs || 0) / 1000),
        fps: Math.max(1, project.project.fps || 30),
        width: pickNumber(asset.metadata?.width),
        height: pickNumber(asset.metadata?.height),
        thumbnailUrl: typeof asset.metadata?.thumbnailUrl === 'string' ? asset.metadata.thumbnailUrl : undefined,
        blobUrl: resolveAssetUrl(asset.src),
        proxyUrl: typeof asset.metadata?.proxyUrl === 'string' ? resolveAssetUrl(asset.metadata.proxyUrl) : null,
        isBroken: false,
        transcriptStatus: null,
    }));
}
