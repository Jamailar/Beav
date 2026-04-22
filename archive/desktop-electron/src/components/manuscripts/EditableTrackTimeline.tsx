import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import clsx from 'clsx';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import { AudioLines, Clapperboard, Eye, EyeOff, ImageIcon, Lock, MoreHorizontal, Rows, Trash2, Type, Unlock, Volume2, VolumeX } from 'lucide-react';
import { TimelinePlayheadOverlay } from './timeline/TimelinePlayheadOverlay';
import { TimelineRuler } from './timeline/TimelineRuler';
import { TimelineScrollbar } from './timeline/TimelineScrollbar';
import { TimelineToolbar } from './timeline/TimelineToolbar';
import { resolveSubtitlePreset } from './subtitles/subtitlePresets';
import { resolveTextPreset } from './texts/textPresets';
import { resolveTransitionPreset } from './transitions/transitionPresets';
import { resolveAssetUrl } from '../../utils/pathManager';
import './editable-track-timeline.css';
import type { VideoEditorTrackUiState, VideoEditorViewportMetrics } from '../../features/video-editor/store/useVideoEditorStore';

type TimelineClipSummary = {
    clipId?: unknown;
    assetId?: unknown;
    name?: unknown;
    track?: unknown;
    order?: unknown;
    durationMs?: unknown;
    trimInMs?: unknown;
    trimOutMs?: unknown;
    enabled?: unknown;
    assetKind?: unknown;
    mediaPath?: unknown;
    mimeType?: unknown;
    subtitleStyle?: {
        presetId?: unknown;
        animation?: unknown;
        emphasisWords?: unknown;
        segmentationMode?: unknown;
        linesPerCaption?: unknown;
    } | unknown;
    textStyle?: {
        presetId?: unknown;
        animation?: unknown;
    } | unknown;
    transitionStyle?: {
        presetId?: unknown;
        kind?: unknown;
        direction?: unknown;
    } | unknown;
};

type TimelineActionShape = {
    id: string;
    start: number;
    end: number;
    effectId: string;
    trimInMs?: number;
    trimOutMs?: number;
    selected?: boolean;
    flexible?: boolean;
    movable?: boolean;
    disable?: boolean;
};

type TimelineRowShape = {
    id: string;
    actions: TimelineActionShape[];
    rowHeight?: number;
};

type EditableTrackTimelineProps = {
    filePath: string;
    clips: Array<Record<string, unknown>>;
    fallbackTracks: string[];
    accent?: 'cyan' | 'emerald';
    emptyLabel?: string;
    onPackageStateChange?: (state: Record<string, unknown>) => void;
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
    sceneItemVisibility?: Record<string, boolean>;
    sceneItemLocks?: Record<string, boolean>;
    sceneItemGroups?: Record<string, string>;
    onToggleSceneItemVisibility?: (sceneItemId: string) => void;
    onToggleSceneItemLock?: (sceneItemId: string) => void;
    onMoveSceneItemsToEdge?: (ids: string[], edge: "front" | "back") => void;
    fps?: number;
    currentFrame?: number;
    durationInFrames?: number;
    isPlaying?: boolean;
    onTogglePlayback?: () => void;
    onStepFrame?: (deltaFrames: number) => void;
    onSeekFrame?: (frame: number) => void;
};

export type EditableTrackTimelineHandle = {
    setCursorTime: (time: number) => void;
};

type DropIndicatorState = {
    x: number;
    time: number;
    rowId: string;
    rowLabel: string;
    splitTarget: boolean;
    snapLabel?: string | null;
};

type DragPreviewState = {
    x: number;
    y: number;
    width: number;
    height: number;
    kind: 'video' | 'audio' | 'image' | 'default';
    title: string;
    durationLabel: string;
};

type TimelineClipboardItem = {
    assetId: string;
    trackId: string;
    kind: TrackKind;
    durationMs: number;
    trimInMs: number;
    trimOutMs: number;
    enabled: boolean;
    sourceOrder: number;
};

type TimelineSelectionSnapshot = {
    rows: TimelineRowShape[];
    selectedClipIds: string[];
    primaryClipId: string | null;
};

type InteractionSnapGuide = {
    left: number;
    top: number;
    height: number;
    label: string;
};

type TrackReorderState = {
    pointerId: number;
    trackId: string;
    startClientY: number;
    initialRows: TimelineRowShape[];
};

type TrackVisualClip = {
    trackId: string;
    clipId: string;
    left: number;
    width: number;
    top: number;
    height: number;
    selected: boolean;
    action: TimelineActionShape;
    clip?: TimelineClipSummary;
};

type TrackVisualKind = 'video' | 'audio' | 'subtitle';
type TrackKind = TrackVisualKind;

type ClipInteractionState = {
    pointerId: number;
    rowId: string;
    clipId: string;
    mode: 'move' | 'resize-start' | 'resize-end';
    startClientX: number;
    startClientY: number;
    initialRows: TimelineRowShape[];
    initialActions: TimelineActionShape[];
    initialAction: TimelineActionShape;
};

const DEFAULT_CLIP_MS = 4000;
const DEFAULT_IMAGE_CLIP_MS = 500;
const MIN_CLIP_MS = 1000;
const MIN_IMAGE_CLIP_MS = 500;
const SCALE_WIDTH = 72;
const MIN_SCALE_WIDTH = 36;
const MAX_SCALE_WIDTH = 160;
const TRACK_RAIL_WIDTH = 156;
const START_LEFT = TRACK_RAIL_WIDTH;
const TIMELINE_ROW_HEIGHT = 40;
const CURSOR_TIME_EPSILON = 0.01;
const SCROLL_LEFT_EPSILON = 0.5;
const SCROLL_TOP_EPSILON = 0.5;
const TIMELINE_SNAP_SECONDS = 0.25;
const TIMELINE_WHEEL_SCROLL_STEP = 1;
const TIMELINE_WHEEL_ZOOM_STEP = 12;
const COLLAPSED_TRACK_ROW_HEIGHT = 42;
const TRACK_ROW_HEIGHTS: Record<TrackKind, number> = {
    video: 40,
    audio: 36,
    subtitle: 32,
};

const TIMELINE_EFFECTS = {
    video: { id: 'video', name: 'Video' },
    audio: { id: 'audio', name: 'Audio' },
    image: { id: 'image', name: 'Image' },
    default: { id: 'default', name: 'Clip' },
} as const;

const TRACK_DEFINITIONS: Record<TrackKind, {
    prefix: string;
    title: string;
    kindLabel: string;
    emptyLabel: string;
    accepts: Array<'video' | 'audio' | 'image' | 'default'>;
}> = {
    video: {
        prefix: 'V',
        title: '视频轨',
        kindLabel: '视频',
        emptyLabel: '拖拽视频或图片到这里',
        accepts: ['video', 'image', 'default'],
    },
    audio: {
        prefix: 'A',
        title: '音频轨',
        kindLabel: '音频',
        emptyLabel: '拖拽音频到这里',
        accepts: ['audio'],
    },
    subtitle: {
        prefix: 'S',
        title: '字幕轨',
        kindLabel: '字幕',
        emptyLabel: '等待字幕或文本片段',
        accepts: ['default'],
    },
};

function createDefaultTrackUiState(): VideoEditorTrackUiState {
    return {
        locked: false,
        hidden: false,
        collapsed: false,
        muted: false,
        solo: false,
        volume: 1,
    };
}

function normalizeNumber(input: unknown, fallback = 0): number {
    const value = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(value) ? value : fallback;
}

function getClipId(clip: TimelineClipSummary, trackName: string, index: number): string {
    const explicit = String(clip.clipId || '').trim();
    if (explicit) return explicit;
    const assetId = String(clip.assetId || '').trim();
    const name = String(clip.name || '').trim();
    return `${trackName}:${assetId || name || 'clip'}:${index}`;
}

function normalizeTrackNames(clips: TimelineClipSummary[], fallbackTracks: string[]): string[] {
    const ordered = new Set<string>();
    fallbackTracks.filter(Boolean).forEach((item) => ordered.add(item));
    clips.forEach((clip) => {
        const track = String(clip.track || '').trim();
        if (track) ordered.add(track);
    });
    return ordered.size > 0 ? Array.from(ordered) : ['V1', 'A1'];
}

function clipVisibleDurationMs(clip: TimelineClipSummary): number {
    const durationMs = normalizeNumber(clip.durationMs, 0);
    const kind = getEffectId(clip.assetKind);
    const minDurationMs = kind === 'image' ? MIN_IMAGE_CLIP_MS : MIN_CLIP_MS;
    const defaultDurationMs = kind === 'image' ? DEFAULT_IMAGE_CLIP_MS : DEFAULT_CLIP_MS;
    if (durationMs > 0) return Math.max(minDurationMs, durationMs);
    return defaultDurationMs;
}

function getEffectId(assetKind: unknown): string {
    const normalized = String(assetKind || '').trim().toLowerCase();
    if (normalized === 'video') return 'video';
    if (normalized === 'audio') return 'audio';
    if (normalized === 'image') return 'image';
    return 'default';
}

function trackIdToKind(trackId: string): TrackKind {
    const normalized = String(trackId || '').trim().toUpperCase();
    if (normalized.startsWith(TRACK_DEFINITIONS.audio.prefix)) return 'audio';
    if (normalized.startsWith(TRACK_DEFINITIONS.subtitle.prefix) || normalized.startsWith('T') || normalized.startsWith('C')) return 'subtitle';
    return 'video';
}

function assetKindToTrackKind(assetKind: unknown): TrackKind {
    const normalized = String(assetKind || '').trim().toLowerCase();
    if (normalized === 'audio') return 'audio';
    if (normalized === 'caption' || normalized === 'subtitle' || normalized === 'text') return 'subtitle';
    return 'video';
}

function trackIdToVisualKind(trackId: string): TrackVisualKind {
    return trackIdToKind(trackId);
}

function clipToVisualKind(clip?: TimelineClipSummary | null): TrackVisualKind {
    if (!clip) return 'video';
    const assetKind = String(clip.assetKind || '').trim().toLowerCase();
    const mimeType = String(clip.mimeType || '').trim().toLowerCase();
    if (assetKind === 'audio' || mimeType.startsWith('audio/')) return 'audio';
    if (assetKind === 'caption' || assetKind === 'subtitle' || assetKind === 'text' || mimeType.startsWith('text/')) {
        return 'subtitle';
    }
    return 'video';
}

function assetSourceUrl(clip: TimelineClipSummary): string {
    return resolveAssetUrl(String(clip.mediaPath || ''));
}

function assetMimeType(clip: TimelineClipSummary): string {
    return String(clip.mimeType || '').trim().toLowerCase();
}

function buildClipStripFrameCount(width: number): number {
    return Math.max(1, Math.ceil(width / 44));
}

async function waitForMediaEvent(target: HTMLMediaElement, eventName: 'loadeddata' | 'seeked'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const handleReady = () => {
            cleanup();
            resolve();
        };
        const handleError = () => {
            cleanup();
            reject(new Error(`Failed while waiting for ${eventName}`));
        };
        const cleanup = () => {
            target.removeEventListener(eventName, handleReady);
            target.removeEventListener('error', handleError);
        };
        target.addEventListener(eventName, handleReady, { once: true });
        target.addEventListener('error', handleError, { once: true });
    });
}

async function generateVideoStripFrames(options: {
    assetUrl: string;
    frameCount: number;
    clipDurationSeconds: number;
    trimInSeconds: number;
}): Promise<string[]> {
    const { assetUrl, frameCount, clipDurationSeconds, trimInSeconds } = options;
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = assetUrl;

    await waitForMediaEvent(video, 'loadeddata');

    const safeDuration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : clipDurationSeconds + trimInSeconds;
    const sampleSpan = Math.max(0.12, clipDurationSeconds);
    const canvas = document.createElement('canvas');
    canvas.width = 84;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) return [];

    const frames: string[] = [];
    for (let index = 0; index < frameCount; index += 1) {
        const progress = frameCount <= 1 ? 0 : index / Math.max(1, frameCount - 1);
        const seekTime = Math.min(
            Math.max(0, trimInSeconds + progress * sampleSpan),
            Math.max(0, safeDuration - 0.05)
        );
        if (Math.abs(video.currentTime - seekTime) > 0.02) {
            video.currentTime = seekTime;
            await waitForMediaEvent(video, 'seeked');
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.72));
    }

    return frames;
}

function emitTimelineDragState(active: boolean) {
    window.dispatchEvent(new CustomEvent('redbox-video-editor:timeline-drag-state', {
        detail: { active },
    }));
}

function roundToStep(value: number, step: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value / step) * step;
}

function snapTimeToCandidates(
    timeInSeconds: number,
    candidates: number[],
    thresholdSeconds: number
): { time: number; snapped: boolean; candidate?: number } {
    let bestCandidate: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate) => {
        if (!Number.isFinite(candidate)) return;
        const distance = Math.abs(candidate - timeInSeconds);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestCandidate = candidate;
        }
    });
    if (bestCandidate === null || bestDistance > thresholdSeconds) {
        return { time: timeInSeconds, snapped: false };
    }
    return { time: bestCandidate, snapped: true, candidate: bestCandidate };
}

function actionDurationSeconds(action: TimelineActionShape): number {
    return Math.max(0.1, Number(action.end || 0) - Number(action.start || 0));
}

function rebalanceActionsInOrder(actions: TimelineActionShape[]): TimelineActionShape[] {
    let cursor = 0;
    return actions.map((action) => {
        const duration = actionDurationSeconds(action);
        const start = cursor;
        const end = start + duration;
        cursor = end;
        return {
            ...action,
            start,
            end,
        };
    });
}

function rebalanceActionsByStart(actions: TimelineActionShape[]): TimelineActionShape[] {
    const sorted = [...actions].sort((left, right) => {
        const delta = Number(left.start || 0) - Number(right.start || 0);
        if (Math.abs(delta) > CURSOR_TIME_EPSILON) return delta;
        return actionDurationSeconds(left) - actionDurationSeconds(right);
    });
    return rebalanceActionsInOrder(sorted);
}

function formatSeconds(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const totalSeconds = Math.round(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainSeconds = totalSeconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, '0')}`;
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    if (max <= min) return min;
    return Math.min(Math.max(value, min), max);
}

function parseAssetIdFromDataTransfer(dataTransfer: DataTransfer): string {
    const directAssetId = dataTransfer.getData('application/x-redbox-asset-id');
    if (directAssetId) {
        return directAssetId.trim();
    }
    const fallbackText = dataTransfer.getData('text/plain').trim();
    if (fallbackText.startsWith('redbox-asset:')) {
        return fallbackText.slice('redbox-asset:'.length).trim();
    }
    return '';
}

function parseAssetPayloadFromDataTransfer(dataTransfer: DataTransfer): {
    kind: 'video' | 'audio' | 'image' | 'default';
    title: string;
    durationMs?: number;
} | null {
    const raw = dataTransfer.getData('application/x-redbox-asset');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { kind?: unknown; title?: unknown; durationMs?: unknown };
        const kind = getEffectId(parsed.kind) as 'video' | 'audio' | 'image' | 'default';
        const title = String(parsed.title || '').trim() || '素材';
        const durationMs = normalizeNumber(parsed.durationMs, 0);
        return {
            kind,
            title,
            durationMs: durationMs > 0 ? durationMs : undefined,
        };
    } catch {
        return null;
    }
}

function trackAcceptsAssetPayloadKind(trackId: string, payloadKind: 'video' | 'audio' | 'image' | 'default' | null): boolean {
    if (!payloadKind) return true;
    return TRACK_DEFINITIONS[trackIdToKind(trackId)].accepts.includes(payloadKind);
}

function trackDisplayLabel(trackId: string): string {
    const kind = trackIdToKind(trackId);
    return TRACK_DEFINITIONS[kind].kindLabel;
}

function trackKindRowHeight(kind: TrackKind, collapsed = false): number {
    if (collapsed) return COLLAPSED_TRACK_ROW_HEIGHT;
    return TRACK_ROW_HEIGHTS[kind] || TIMELINE_ROW_HEIGHT;
}

function trackRowHeight(trackId: string, collapsed = false): number {
    return trackKindRowHeight(trackIdToKind(trackId), collapsed);
}

function summarizeClipText(value: unknown, maxLength = 54): string {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clipCaptionTokens(value: unknown): string[] {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const matches = normalized.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*|[\u4e00-\u9fff]|[^\s]/g);
    return (matches || []).map((token) => token.trim()).filter(Boolean);
}

function sceneItemIdForClip(clip: TimelineClipSummary | undefined): string | null {
    if (!clip) return null;
    const clipId = String(clip.clipId || '').trim();
    if (!clipId) return null;
    const kind = String(clip.assetKind || '').trim().toLowerCase();
    const track = String(clip.track || '').trim().toUpperCase();
    if (kind === 'text') return `${clipId}:text`;
    if (kind === 'subtitle' || kind === 'caption' || track.startsWith('S') || track.startsWith('C')) return `${clipId}:subtitle`;
    return clipId;
}

function buildCaptionSegments(
    words: string[],
    mode: 'punctuationOrPause' | 'time' | 'singleWord',
    linesPerCaption: number,
    durationSeconds: number
): string[][] {
    if (words.length === 0) return [];
    if (mode === 'singleWord') return words.map((word) => [word]);
    if (mode === 'time') {
        const targetSegments = Math.max(1, Math.min(words.length, Math.round(Math.max(0.5, durationSeconds) / 0.8)));
        const wordsPerSegment = Math.max(1, Math.ceil(words.length / targetSegments));
        const segments: string[][] = [];
        for (let index = 0; index < words.length; index += wordsPerSegment) {
            segments.push(words.slice(index, index + wordsPerSegment));
        }
        return segments;
    }
    const segments: string[][] = [];
    let buffer: string[] = [];
    const softLimit = Math.max(3, linesPerCaption * 4);
    words.forEach((word) => {
        buffer.push(word);
        if (/[.,!?;:，。！？；：]/.test(word) || buffer.length >= softLimit) {
            segments.push(buffer);
            buffer = [];
        }
    });
    if (buffer.length > 0) segments.push(buffer);
    return segments;
}

function trackKindIcon(kind: TrackKind) {
    if (kind === 'audio') return AudioLines;
    if (kind === 'subtitle') return Type;
    return Clapperboard;
}

function reorderRowsByIndices(rows: TimelineRowShape[], fromIndex: number, toIndex: number): TimelineRowShape[] {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= rows.length || toIndex >= rows.length) {
        return cloneRows(rows);
    }
    const nextRows = cloneRows(rows);
    const [movedRow] = nextRows.splice(fromIndex, 1);
    nextRows.splice(toIndex, 0, movedRow);
    return nextRows;
}

function applyTrackUiToRows(
    rows: TimelineRowShape[],
    trackUi: Record<string, VideoEditorTrackUiState>
): TimelineRowShape[] {
    return rows.map((row) => {
        const ui = trackUi[row.id];
        const nextRowHeight = trackRowHeight(row.id, !!ui?.collapsed);
        if ((row.rowHeight || trackRowHeight(row.id, false)) === nextRowHeight) {
            return row;
        }
        return {
            ...row,
            rowHeight: nextRowHeight,
        };
    });
}

function cloneRows(rows: TimelineRowShape[]): TimelineRowShape[] {
    return rows.map((row) => ({
        ...row,
        actions: row.actions.map((action) => ({ ...action })),
    }));
}

function buildTimelineRows(clips: TimelineClipSummary[], fallbackTracks: string[]): TimelineRowShape[] {
    const trackNames = normalizeTrackNames(clips, fallbackTracks);
    return trackNames.map((trackName) => {
        const trackClips = clips
            .filter((item) => String(item.track || '').trim() === trackName)
            .sort((a, b) => normalizeNumber(a.order, 0) - normalizeNumber(b.order, 0));

        let cursorSeconds = 0;
        const actions = trackClips.map((clip, index) => {
            const durationSeconds = clipVisibleDurationMs(clip) / 1000;
            const id = getClipId(clip, trackName, index);
            const action: TimelineActionShape = {
                id,
                start: cursorSeconds,
                end: cursorSeconds + durationSeconds,
                effectId: getEffectId(clip.assetKind),
                trimInMs: normalizeNumber(clip.trimInMs, 0),
                trimOutMs: normalizeNumber(clip.trimOutMs, 0),
                movable: true,
                flexible: true,
                disable: clip.enabled === false,
            };
            cursorSeconds = action.end;
            return action;
        });

        return {
            id: trackName,
            rowHeight: trackRowHeight(trackName, false),
            actions,
        };
    });
}

function serializeRows(rows: TimelineRowShape[]): string {
    return JSON.stringify(rows.map((row) => ({
        id: row.id,
        actions: row.actions.map((action) => ({
            id: action.id,
            start: Number(action.start.toFixed(3)),
            end: Number(action.end.toFixed(3)),
            trimInMs: normalizeNumber(action.trimInMs, 0),
            trimOutMs: normalizeNumber(action.trimOutMs, 0),
            disable: !!action.disable,
            effectId: action.effectId,
        })),
    })));
}

export const EditableTrackTimeline = forwardRef<EditableTrackTimelineHandle, EditableTrackTimelineProps>(function EditableTrackTimeline({
    filePath,
    clips,
    fallbackTracks,
    accent = 'cyan',
    emptyLabel = '拖入素材到时间轴开始剪辑',
    onPackageStateChange,
    controlledCursorTime = null,
    controlledSelectedClipId = null,
    controlledActiveTrackId = null,
    onCursorTimeChange,
    onSelectedClipChange,
    onActiveTrackChange,
    onViewportMetricsChange,
    controlledViewport = null,
    controlledZoomPercent = null,
    onZoomPercentChange,
    controlledTrackUi,
    onTrackUiChange,
    sceneItemVisibility = {},
    sceneItemLocks = {},
    sceneItemGroups = {},
    onToggleSceneItemVisibility,
    onToggleSceneItemLock,
    onMoveSceneItemsToEdge,
    fps = 30,
    currentFrame,
    durationInFrames,
    isPlaying = false,
    onTogglePlayback,
    onStepFrame,
    onSeekFrame,
}, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const timelineRef = useRef<TimelineState | null>(null);
    const isSyncingTimelineCursorRef = useRef(false);
    const lastSyncedTimelineCursorTimeRef = useRef<number | null>(null);
    const isTimelineFocusedRef = useRef(false);
    const videoStripCacheRef = useRef<Map<string, string[]>>(new Map());
    const videoStripPendingRef = useRef<Set<string>>(new Set());
    const normalizedClips = useMemo(() => clips.map((item) => item as TimelineClipSummary), [clips]);
    const externalRows = useMemo(
        () => applyTrackUiToRows(buildTimelineRows(normalizedClips, fallbackTracks), controlledTrackUi || {}),
        [controlledTrackUi, fallbackTracks, normalizedClips]
    );
    const externalSignature = useMemo(() => serializeRows(externalRows), [externalRows]);
    const [editorRows, setEditorRows] = useState<TimelineRowShape[]>(externalRows);
    const [isPersisting, setIsPersisting] = useState(false);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
    const [focusedTrackId, setFocusedTrackId] = useState<string | null>(null);
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
    const [localTrackUiMap, setLocalTrackUiMap] = useState<Record<string, VideoEditorTrackUiState>>(controlledTrackUi || {});
    const [internalCursorTime, setInternalCursorTime] = useState(0);
    const [scaleWidth, setScaleWidth] = useState(() => {
        const initialZoom = Number(controlledZoomPercent ?? 100);
        const safeZoom = Number.isFinite(initialZoom) ? initialZoom : 100;
        return clampNumber((safeZoom / 100) * SCALE_WIDTH, MIN_SCALE_WIDTH, MAX_SCALE_WIDTH);
    });
    const [viewportWidth, setViewportWidth] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [maxScrollTop, setMaxScrollTop] = useState(0);
    const [isDraggingAsset, setIsDraggingAsset] = useState(false);
    const [draggingAssetKind, setDraggingAssetKind] = useState<'video' | 'audio' | 'image' | 'default' | null>(null);
    const [dropIndicator, setDropIndicator] = useState<DropIndicatorState | null>(null);
    const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
    const [clipInteraction, setClipInteraction] = useState<ClipInteractionState | null>(null);
    const [trackReorder, setTrackReorder] = useState<TrackReorderState | null>(null);
    const [interactionSnapGuide, setInteractionSnapGuide] = useState<InteractionSnapGuide | null>(null);
    const [videoStripFrames, setVideoStripFrames] = useState<Record<string, string[]>>({});
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        clipId: string;
    } | null>(null);
    const [trackContextMenu, setTrackContextMenu] = useState<{
        x: number;
        y: number;
        trackIds: string[];
    } | null>(null);
    const clipboardRef = useRef<TimelineClipboardItem[]>([]);
    const undoStackRef = useRef<TimelineSelectionSnapshot[]>([]);
    const redoStackRef = useRef<TimelineSelectionSnapshot[]>([]);
    const pendingHistorySnapshotRef = useRef<TimelineSelectionSnapshot | null>(null);
    const effectiveTrackUiMap = controlledTrackUi || localTrackUiMap;
    const lockedTrackIds = useMemo(
        () => Object.entries(effectiveTrackUiMap).filter(([, value]) => value.locked).map(([trackId]) => trackId),
        [effectiveTrackUiMap]
    );
    const hiddenTrackIds = useMemo(
        () => Object.entries(effectiveTrackUiMap).filter(([, value]) => value.hidden).map(([trackId]) => trackId),
        [effectiveTrackUiMap]
    );
    const soloTrackIds = useMemo(
        () => Object.entries(effectiveTrackUiMap).filter(([, value]) => value.solo).map(([trackId]) => trackId),
        [effectiveTrackUiMap]
    );

    const clipById = useMemo(() => {
        const map = new Map<string, TimelineClipSummary>();
        normalizedClips.forEach((clip, index) => {
            const trackName = String(clip.track || '').trim() || fallbackTracks[0] || 'V1';
            map.set(getClipId(clip, trackName, index), clip);
        });
        return map;
    }, [fallbackTracks, normalizedClips]);

    const effectiveSelectedClipIds = useMemo(() => {
        const baseIds = selectedClipIds.length > 0
            ? selectedClipIds
            : (selectedClipId ? [selectedClipId] : []);
        return Array.from(new Set(baseIds.filter((id) => clipById.has(id))));
    }, [clipById, selectedClipId, selectedClipIds]);

    const selectedClipIdSet = useMemo(() => new Set(effectiveSelectedClipIds), [effectiveSelectedClipIds]);
    const effectiveSelectedTrackIds = useMemo(() => {
        return Array.from(new Set(selectedTrackIds.filter((trackId) => editorRows.some((row) => row.id === trackId))));
    }, [editorRows, selectedTrackIds]);
    const selectedTrackIdSet = useMemo(() => new Set(effectiveSelectedTrackIds), [effectiveSelectedTrackIds]);
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
    const cursorTimeEpsilon = Math.max(CURSOR_TIME_EPSILON, 0.5 / safeFps);
    const hasControlledCursorTime = Number.isFinite(controlledCursorTime ?? NaN);
    const effectiveCursorTime = hasControlledCursorTime
        ? Math.max(0, Number(controlledCursorTime))
        : internalCursorTime;

    const snapshotSelectionState = useCallback((
        rows: TimelineRowShape[] = editorRows,
        ids: string[] = effectiveSelectedClipIds,
        primaryId: string | null = selectedClipId
    ): TimelineSelectionSnapshot => ({
        rows: applyTrackUiToRows(cloneRows(rows), effectiveTrackUiMap),
        selectedClipIds: [...ids],
        primaryClipId: primaryId,
    }), [editorRows, effectiveSelectedClipIds, effectiveTrackUiMap, selectedClipId]);

    const applySelectionState = useCallback((ids: string[], primaryId?: string | null) => {
        const filtered = Array.from(new Set(ids)).filter((id) => clipById.has(id));
        const nextPrimary = primaryId !== undefined
            ? (primaryId && filtered.includes(primaryId) ? primaryId : filtered[0] || null)
            : filtered[0] || null;
        setSelectedClipIds(filtered);
        setSelectedClipId(nextPrimary);
    }, [clipById]);

    const clearSelectionState = useCallback(() => {
        setSelectedClipIds([]);
        setSelectedClipId(null);
    }, []);

    const applyTrackSelectionState = useCallback((ids: string[], primaryId?: string | null) => {
        const filtered = Array.from(new Set(ids)).filter((trackId) => editorRows.some((row) => row.id === trackId));
        const nextPrimary = primaryId !== undefined
            ? (primaryId && filtered.includes(primaryId) ? primaryId : filtered[0] || null)
            : filtered[0] || null;
        setSelectedTrackIds(filtered);
        setFocusedTrackId(nextPrimary);
    }, [editorRows]);

    const updateTrackUiMap = useCallback((updater: (current: Record<string, VideoEditorTrackUiState>) => Record<string, VideoEditorTrackUiState>) => {
        const nextMap = updater(effectiveTrackUiMap);
        if (!controlledTrackUi) {
            setLocalTrackUiMap(nextMap);
        }
        onTrackUiChange?.(nextMap);
    }, [controlledTrackUi, effectiveTrackUiMap, onTrackUiChange]);

    const pushUndoSnapshot = useCallback((snapshot: TimelineSelectionSnapshot) => {
        undoStackRef.current.push(snapshot);
        if (undoStackRef.current.length > 80) {
            undoStackRef.current.shift();
        }
        redoStackRef.current = [];
    }, []);

    const captureUndoSnapshot = useCallback(() => {
        pushUndoSnapshot(snapshotSelectionState());
    }, [pushUndoSnapshot, snapshotSelectionState]);

    useEffect(() => {
        setEditorRows(externalRows);
    }, [externalRows, externalSignature]);

    useEffect(() => {
        if (!controlledTrackUi) return;
        setLocalTrackUiMap(controlledTrackUi);
    }, [controlledTrackUi]);

    useEffect(() => {
        const nextTrackId = String(controlledActiveTrackId || '').trim();
        if (!nextTrackId) return;
        if (!editorRows.some((row) => row.id === nextTrackId)) return;
        setFocusedTrackId((current) => current === nextTrackId ? current : nextTrackId);
    }, [controlledActiveTrackId, editorRows]);

    useEffect(() => {
        if (!focusedTrackId) return;
        if (editorRows.some((row) => row.id === focusedTrackId)) return;
        setFocusedTrackId(null);
    }, [editorRows, focusedTrackId]);

    useEffect(() => {
        setSelectedTrackIds((current) => current.filter((trackId) => editorRows.some((row) => row.id === trackId)));
    }, [editorRows]);

    useEffect(() => {
        return () => {
            emitTimelineDragState(false);
        };
    }, []);

    useEffect(() => {
        if (effectiveSelectedClipIds.length === 0) {
            if (selectedClipId !== null || selectedClipIds.length > 0) {
                clearSelectionState();
            }
            return;
        }
        if (!selectedClipId || !clipById.has(selectedClipId) || !selectedClipIdSet.has(selectedClipId)) {
            applySelectionState(effectiveSelectedClipIds, effectiveSelectedClipIds[0] || null);
        }
    }, [applySelectionState, clearSelectionState, clipById, effectiveSelectedClipIds, selectedClipId, selectedClipIdSet, selectedClipIds.length]);

    useEffect(() => {
        onSelectedClipChange?.(selectedClipId);
    }, [onSelectedClipChange, selectedClipId]);

    const selectedTrackId = useMemo(() => {
        return editorRows.find((row) => row.actions.some((action) => action.id === selectedClipId))?.id || null;
    }, [editorRows, selectedClipId]);

    useEffect(() => {
        if (!selectedTrackId || selectedTrackId === focusedTrackId) return;
        setFocusedTrackId(selectedTrackId);
    }, [focusedTrackId, selectedTrackId]);

    const activeTrackId = effectiveSelectedTrackIds[0] || selectedTrackId || focusedTrackId;
    const activeTrackLocked = activeTrackId ? lockedTrackIds.includes(activeTrackId) : false;
    const contextMenuClip = contextMenu ? clipById.get(contextMenu.clipId) : null;
    const contextMenuSceneItemId = sceneItemIdForClip(contextMenuClip);
    const contextMenuSceneHidden = contextMenuSceneItemId ? sceneItemVisibility[contextMenuSceneItemId] === false : false;
    const contextMenuSceneLocked = contextMenuSceneItemId ? !!sceneItemLocks[contextMenuSceneItemId] : false;

    useEffect(() => {
        onActiveTrackChange?.(activeTrackId);
    }, [activeTrackId, onActiveTrackChange]);

    const syncTimelineCursor = useCallback((nextTime: number) => {
        const safeTime = Math.max(0, nextTime);
        if (
            lastSyncedTimelineCursorTimeRef.current !== null
            && Math.abs(lastSyncedTimelineCursorTimeRef.current - safeTime) < cursorTimeEpsilon
        ) {
            return;
        }
        lastSyncedTimelineCursorTimeRef.current = safeTime;
        isSyncingTimelineCursorRef.current = true;
        timelineRef.current?.setTime(safeTime);
        queueMicrotask(() => {
            isSyncingTimelineCursorRef.current = false;
        });
    }, [cursorTimeEpsilon]);

    const commitCursorTime = useCallback((nextTime: number, options?: {
        emitChange?: boolean;
        syncTimeline?: boolean;
    }) => {
        if (!Number.isFinite(nextTime)) return;
        const safeTime = Math.max(0, nextTime);
        if (options?.syncTimeline !== false) {
            syncTimelineCursor(safeTime);
        }
        if (!hasControlledCursorTime) {
            setInternalCursorTime((current) => (
                Math.abs(current - safeTime) < cursorTimeEpsilon ? current : safeTime
            ));
        }
        if (
            options?.emitChange !== false
            && onCursorTimeChange
            && Math.abs(effectiveCursorTime - safeTime) >= cursorTimeEpsilon
        ) {
            onCursorTimeChange(safeTime);
        }
    }, [cursorTimeEpsilon, effectiveCursorTime, hasControlledCursorTime, onCursorTimeChange, syncTimelineCursor]);

    useEffect(() => {
        if (!hasControlledCursorTime) return;
        syncTimelineCursor(effectiveCursorTime);
    }, [effectiveCursorTime, hasControlledCursorTime, syncTimelineCursor]);

    useEffect(() => {
        const nextClipId = String(controlledSelectedClipId || '').trim();
        if (!nextClipId || nextClipId === selectedClipId || !clipById.has(nextClipId)) {
            return;
        }
        applySelectionState([nextClipId], nextClipId);
    }, [applySelectionState, clipById, controlledSelectedClipId]);

    useImperativeHandle(ref, () => ({
        setCursorTime: (time: number) => {
            commitCursorTime(time);
        },
    }), [commitCursorTime]);

    const focusTrack = useCallback((
        trackId: string | null,
        options?: { clearClipSelection?: boolean; selectTrack?: boolean; additive?: boolean }
    ) => {
        const nextTrackId = String(trackId || '').trim();
        if (!nextTrackId) return;
        if (!editorRows.some((row) => row.id === nextTrackId)) return;
        if (options?.selectTrack) {
            const nextTrackIds = options.additive
                ? (
                    selectedTrackIdSet.has(nextTrackId)
                        ? effectiveSelectedTrackIds.filter((id) => id !== nextTrackId)
                        : [...effectiveSelectedTrackIds, nextTrackId]
                )
                : [nextTrackId];
            applyTrackSelectionState(nextTrackIds, nextTrackId);
        } else {
            setFocusedTrackId(nextTrackId);
        }
        if (options?.clearClipSelection) {
            clearSelectionState();
        }
        setContextMenu(null);
        setTrackContextMenu(null);
    }, [applyTrackSelectionState, clearSelectionState, editorRows, effectiveSelectedTrackIds, selectedTrackIdSet]);

    const findCompatibleTrackId = useCallback((
        kind: TrackKind,
        options?: { preferredTrackId?: string | null; fallbackTrackId?: string | null }
    ) => {
        const compatibleTrackIds = editorRows
            .map((row) => row.id)
            .filter((trackId) => trackIdToKind(trackId) === kind)
            .filter((trackId) => !lockedTrackIds.includes(trackId));
        const preferredTrackId = String(options?.preferredTrackId || '').trim();
        if (preferredTrackId && compatibleTrackIds.includes(preferredTrackId)) {
            return preferredTrackId;
        }
        const fallbackTrackId = String(options?.fallbackTrackId || '').trim();
        if (fallbackTrackId && compatibleTrackIds.includes(fallbackTrackId)) {
            return fallbackTrackId;
        }
        if (activeTrackId && compatibleTrackIds.includes(activeTrackId)) {
            return activeTrackId;
        }
        return compatibleTrackIds[compatibleTrackIds.length - 1] || null;
    }, [activeTrackId, editorRows, lockedTrackIds]);

    const canDeleteTrack = useCallback((trackId: string | null) => {
        const normalizedTrackId = String(trackId || '').trim();
        if (!normalizedTrackId) return false;
        const row = editorRows.find((item) => item.id === normalizedTrackId);
        if (!row) return false;
        const trackKind = trackIdToKind(normalizedTrackId);
        return editorRows.filter((item) => trackIdToKind(item.id) === trackKind).length > 1;
    }, [editorRows]);

    const createTrackOfKind = useCallback(async (
        kind: TrackKind,
        options?: { adjacentToTrackId?: string | null; direction?: 'up' | 'down'; focus?: boolean }
    ) => {
        if (!filePath) return null;
        const adjacentToTrackId = String(options?.adjacentToTrackId || '').trim();
        const direction = options?.direction || 'down';
        const shouldFocus = options?.focus !== false;
        const addResult = await window.ipcRenderer.invoke('manuscripts:add-package-track', {
            filePath,
            kind,
        }) as { success?: boolean; state?: Record<string, unknown> };
        if (!addResult?.success || !addResult.state) {
            return null;
        }

        let latestState = addResult.state;
        const nextTrackNames = (
            (addResult.state as { timelineSummary?: { trackNames?: string[] } })?.timelineSummary?.trackNames || []
        )
            .map((item) => String(item || '').trim())
            .filter(Boolean);

        const createdTrackId = [...nextTrackNames]
            .reverse()
            .find((trackId) => trackIdToKind(trackId) === kind) || null;
        if (!createdTrackId) {
            onPackageStateChange?.(latestState);
            return null;
        }

        if (adjacentToTrackId) {
            const anchorIndex = nextTrackNames.indexOf(adjacentToTrackId);
            const createdIndex = nextTrackNames.indexOf(createdTrackId);
            if (anchorIndex >= 0 && createdIndex >= 0) {
                const desiredIndex = direction === 'up' ? anchorIndex : anchorIndex + 1;
                let remainingSteps = Math.max(0, createdIndex - desiredIndex);
                while (remainingSteps > 0) {
                    const moveResult = await window.ipcRenderer.invoke('manuscripts:move-package-track', {
                        filePath,
                        trackId: createdTrackId,
                        direction: 'up',
                    }) as { success?: boolean; state?: Record<string, unknown> };
                    if (moveResult?.success && moveResult.state) {
                        latestState = moveResult.state;
                    }
                    remainingSteps -= 1;
                }
            }
        }

        if (shouldFocus) {
            setFocusedTrackId(createdTrackId);
        }
        onPackageStateChange?.(latestState);
        return createdTrackId;
    }, [filePath, onPackageStateChange]);

    const ensureTrackIdForKind = useCallback(async (
        kind: TrackKind,
        options?: { preferredTrackId?: string | null; fallbackTrackId?: string | null }
    ) => {
        const existingTrackId = findCompatibleTrackId(kind, options);
        if (existingTrackId) return existingTrackId;
        return createTrackOfKind(kind);
    }, [createTrackOfKind, findCompatibleTrackId]);

    const persistRows = useCallback(async (rowsToPersist: TimelineRowShape[]) => {
        if (!filePath) return;
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            for (const row of rowsToPersist) {
                const orderedActions = [...row.actions].sort((a, b) => a.start - b.start);
                for (let index = 0; index < orderedActions.length; index += 1) {
                    const action = orderedActions[index];
                    const originalClip = clipById.get(action.id);
                    if (!originalClip) continue;
                    const nextDurationMs = Math.max(
                        getEffectId(originalClip.assetKind) === 'image' ? MIN_IMAGE_CLIP_MS : MIN_CLIP_MS,
                        Math.round(Math.max(0.1, action.end - action.start) * 1000)
                    );
                    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
                        filePath,
                        clipId: action.id,
                        assetId: String(originalClip.assetId || ''),
                        track: row.id,
                        order: index,
                        durationMs: nextDurationMs,
                        trimInMs: normalizeNumber(action.trimInMs, normalizeNumber(originalClip.trimInMs, 0)),
                        trimOutMs: normalizeNumber(action.trimOutMs, normalizeNumber(originalClip.trimOutMs, 0)),
                        enabled: action.disable !== true,
                    }) as { success?: boolean; state?: Record<string, unknown> };
                    if (result?.success && result.state) {
                        latestState = result.state;
                    }
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
            }
        } catch (error) {
            console.error('Failed to persist timeline rows:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [clipById, filePath, onPackageStateChange]);

    useEffect(() => {
        const currentSignature = serializeRows(editorRows);
        if (currentSignature === externalSignature) return;
        if (clipInteraction) return;
        if (trackReorder) return;
        const timer = window.setTimeout(() => {
            void persistRows(editorRows);
        }, 220);
        return () => window.clearTimeout(timer);
    }, [clipInteraction, editorRows, externalSignature, persistRows, trackReorder]);

    const handleAddTrack = useCallback(async (kind: TrackKind) => {
        if (!filePath) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            await createTrackOfKind(kind);
        } catch (error) {
            console.error('Failed to add package track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [captureUndoSnapshot, createTrackOfKind, filePath]);

    const handleMoveTrack = useCallback(async (trackId: string, direction: 'up' | 'down') => {
        if (!filePath || !trackId) return;
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:move-package-track', {
                filePath,
                trackId,
                direction,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                setFocusedTrackId(trackId);
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to move package track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [filePath, onPackageStateChange]);

    const handleClearTrack = useCallback(async (trackId: string) => {
        const normalizedTrackId = String(trackId || '').trim();
        if (!filePath || !normalizedTrackId) return;
        const targetRow = editorRows.find((row) => row.id === normalizedTrackId);
        if (!targetRow || targetRow.actions.length === 0) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            for (const action of targetRow.actions) {
                const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                    filePath,
                    clipId: action.id,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (result?.success && result.state) {
                    latestState = result.state;
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
                if (activeTrackId === normalizedTrackId) {
                    clearSelectionState();
                    setFocusedTrackId(normalizedTrackId);
                }
            }
        } catch (error) {
            console.error('Failed to clear track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [activeTrackId, captureUndoSnapshot, clearSelectionState, editorRows, filePath, onPackageStateChange]);

    const handleBatchTrackUi = useCallback((
        trackIds: string[],
        updater: (current: VideoEditorTrackUiState) => VideoEditorTrackUiState
    ) => {
        const validTrackIds = Array.from(new Set(trackIds)).filter((trackId) => editorRows.some((row) => row.id === trackId));
        if (validTrackIds.length === 0) return;
        updateTrackUiMap((current) => {
            const next = { ...current };
            validTrackIds.forEach((trackId) => {
                const previous = next[trackId] || createDefaultTrackUiState();
                next[trackId] = updater(previous);
            });
            return next;
        });
    }, [editorRows, updateTrackUiMap]);

    const removeTrackUiEntries = useCallback((trackIds: string[]) => {
        const normalizedTrackIds = Array.from(new Set(trackIds.map((trackId) => String(trackId || '').trim()).filter(Boolean)));
        if (normalizedTrackIds.length === 0) return;
        updateTrackUiMap((current) => {
            let changed = false;
            const next = { ...current };
            normalizedTrackIds.forEach((trackId) => {
                if (!Object.prototype.hasOwnProperty.call(next, trackId)) return;
                delete next[trackId];
                changed = true;
            });
            return changed ? next : current;
        });
    }, [updateTrackUiMap]);

    const handleClearTracks = useCallback(async (trackIds: string[]) => {
        const validTrackIds = Array.from(new Set(trackIds)).filter((trackId) => editorRows.some((row) => row.id === trackId));
        if (!filePath || validTrackIds.length === 0) return;
        const clipsToDelete = editorRows
            .filter((row) => validTrackIds.includes(row.id))
            .flatMap((row) => row.actions.map((action) => action.id));
        if (clipsToDelete.length === 0) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            for (const clipId of clipsToDelete) {
                const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                    filePath,
                    clipId,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (result?.success && result.state) {
                    latestState = result.state;
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
                clearSelectionState();
                applyTrackSelectionState(validTrackIds, validTrackIds[0] || null);
            }
        } catch (error) {
            console.error('Failed to clear tracks:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [applyTrackSelectionState, captureUndoSnapshot, clearSelectionState, editorRows, filePath, onPackageStateChange]);

    const canDeleteTrackSet = useCallback((trackIds: string[]) => {
        const validTrackIds = Array.from(new Set(trackIds)).filter((trackId) => editorRows.some((row) => row.id === trackId));
        if (validTrackIds.length === 0) return false;
        const totalByKind = editorRows.reduce<Record<TrackKind, number>>((accumulator, row) => {
            const kind = trackIdToKind(row.id);
            accumulator[kind] = (accumulator[kind] || 0) + 1;
            return accumulator;
        }, { video: 0, audio: 0, subtitle: 0 });
        const selectedByKind = validTrackIds.reduce<Record<TrackKind, number>>((accumulator, trackId) => {
            const kind = trackIdToKind(trackId);
            accumulator[kind] = (accumulator[kind] || 0) + 1;
            return accumulator;
        }, { video: 0, audio: 0, subtitle: 0 });
        return (Object.keys(selectedByKind) as TrackKind[]).every((kind) => {
            if (!selectedByKind[kind]) return true;
            return totalByKind[kind] - selectedByKind[kind] >= 1;
        });
    }, [editorRows]);

    const handleDeleteTracks = useCallback(async (trackIds: string[]) => {
        const validTrackIds = Array.from(new Set(trackIds)).filter((trackId) => editorRows.some((row) => row.id === trackId));
        if (!filePath || validTrackIds.length === 0 || !canDeleteTrackSet(validTrackIds)) return;
        const rowsById = new Map(editorRows.map((row) => [row.id, row]));
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            for (const trackId of validTrackIds) {
                const targetRow = rowsById.get(trackId);
                if (!targetRow) continue;
                for (const action of targetRow.actions) {
                    // eslint-disable-next-line no-await-in-loop
                    const clipDeleteResult = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                        filePath,
                        clipId: action.id,
                    }) as { success?: boolean; state?: Record<string, unknown> };
                    if (clipDeleteResult?.success && clipDeleteResult.state) {
                        latestState = clipDeleteResult.state;
                    }
                }
                // eslint-disable-next-line no-await-in-loop
                const result = await window.ipcRenderer.invoke('manuscripts:delete-package-track', {
                    filePath,
                    trackId,
                }) as { success?: boolean; state?: Record<string, unknown>; error?: string };
                if (result?.success && result.state) {
                    latestState = result.state;
                    continue;
                }
                if (result?.error) {
                    console.warn('Failed to delete selected track:', result.error);
                }
            }
            if (latestState) {
                removeTrackUiEntries(validTrackIds);
                onPackageStateChange?.(latestState);
                applyTrackSelectionState([], null);
                clearSelectionState();
                setFocusedTrackId(null);
            }
        } catch (error) {
            console.error('Failed to delete selected tracks:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [applyTrackSelectionState, canDeleteTrackSet, captureUndoSnapshot, clearSelectionState, editorRows, filePath, onPackageStateChange, removeTrackUiEntries]);

    const handleDeleteTrack = useCallback(async (trackId: string) => {
        if (!trackId || !canDeleteTrack(trackId)) return;
        await handleDeleteTracks([trackId]);
    }, [canDeleteTrack, handleDeleteTracks]);

    const updateTrackUi = useCallback((
        trackId: string | null,
        updater: (current: VideoEditorTrackUiState) => VideoEditorTrackUiState
    ) => {
        const normalizedTrackId = String(trackId || '').trim();
        if (!normalizedTrackId) return;
        updateTrackUiMap((current) => {
            const previous = current[normalizedTrackId] || createDefaultTrackUiState();
            return {
                ...current,
                [normalizedTrackId]: updater(previous),
            };
        });
    }, [updateTrackUiMap]);

    const toggleTrackLock = useCallback((trackId: string | null) => {
        updateTrackUi(trackId, (current) => ({ ...current, locked: !current.locked }));
    }, [updateTrackUi]);

    const toggleTrackHidden = useCallback((trackId: string | null) => {
        updateTrackUi(trackId, (current) => ({ ...current, hidden: !current.hidden }));
    }, [updateTrackUi]);

    const toggleTrackCollapsed = useCallback((trackId: string | null) => {
        updateTrackUi(trackId, (current) => ({ ...current, collapsed: !current.collapsed }));
    }, [updateTrackUi]);

    const toggleTrackMuted = useCallback((trackId: string | null) => {
        updateTrackUi(trackId, (current) => ({ ...current, muted: !current.muted }));
    }, [updateTrackUi]);

    const toggleTrackSolo = useCallback((trackId: string | null) => {
        updateTrackUi(trackId, (current) => ({ ...current, solo: !current.solo }));
    }, [updateTrackUi]);

    const setTrackVolume = useCallback((trackId: string | null, volume: number) => {
        updateTrackUi(trackId, (current) => ({
            ...current,
            volume: clampNumber(volume, 0, 1),
        }));
    }, [updateTrackUi]);

    const handleInsertTrackAdjacent = useCallback(async (baseTrackId: string, direction: 'up' | 'down' = 'down') => {
        const normalizedTrackId = String(baseTrackId || '').trim();
        if (!filePath || !normalizedTrackId) return null;
        setIsPersisting(true);
        try {
            return await createTrackOfKind(trackIdToKind(normalizedTrackId), {
                adjacentToTrackId: normalizedTrackId,
                direction,
            });
        } catch (error) {
            console.error('Failed to insert adjacent track:', error);
            return null;
        } finally {
            setIsPersisting(false);
        }
    }, [createTrackOfKind, filePath]);

    const handleDuplicateTrack = useCallback(async (trackId: string) => {
        const normalizedTrackId = String(trackId || '').trim();
        if (!filePath || !normalizedTrackId) return;
        const sourceRow = editorRows.find((row) => row.id === normalizedTrackId);
        if (!sourceRow) return;
        const targetTrackId = await handleInsertTrackAdjacent(normalizedTrackId, 'down');
        if (!targetTrackId) return;
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            const orderedActions = [...sourceRow.actions].sort((a, b) => a.start - b.start);
            for (let index = 0; index < orderedActions.length; index += 1) {
                const action = orderedActions[index];
                const originalClip = clipById.get(action.id);
                if (!originalClip) continue;
                const addResult = await window.ipcRenderer.invoke('manuscripts:add-package-clip', {
                    filePath,
                    assetId: String(originalClip.assetId || ''),
                    track: targetTrackId,
                    order: index,
                    durationMs: Math.max(100, Math.round(actionDurationSeconds(action) * 1000)),
                }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
                if (addResult?.success && addResult.state) {
                    latestState = addResult.state;
                }
                const insertedClipId = String(addResult?.insertedClipId || '').trim();
                if (!insertedClipId) continue;
                const updateResult = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
                    filePath,
                    clipId: insertedClipId,
                    track: targetTrackId,
                    order: index,
                    durationMs: Math.max(100, Math.round(actionDurationSeconds(action) * 1000)),
                    trimInMs: normalizeNumber(action.trimInMs, normalizeNumber(originalClip.trimInMs, 0)),
                    trimOutMs: normalizeNumber(action.trimOutMs, normalizeNumber(originalClip.trimOutMs, 0)),
                    enabled: action.disable !== true,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (updateResult?.success && updateResult.state) {
                    latestState = updateResult.state;
                }
            }
            if (latestState) {
                setFocusedTrackId(targetTrackId);
                onPackageStateChange?.(latestState);
            }
        } catch (error) {
            console.error('Failed to duplicate track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [clipById, editorRows, filePath, handleInsertTrackAdjacent, onPackageStateChange]);

    const handleMoveTracks = useCallback(async (trackIds: string[], direction: 'up' | 'down') => {
        const validTrackIds = Array.from(new Set(trackIds.filter((trackId) => editorRows.some((row) => row.id === trackId))));
        if (!filePath || validTrackIds.length === 0) return;
        const orderMap = new Map(editorRows.map((row, index) => [row.id, index]));
        const sortedTrackIds = [...validTrackIds].sort((left, right) => {
            const leftIndex = orderMap.get(left) ?? 0;
            const rightIndex = orderMap.get(right) ?? 0;
            return direction === 'up' ? leftIndex - rightIndex : rightIndex - leftIndex;
        });
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            for (const trackId of sortedTrackIds) {
                // eslint-disable-next-line no-await-in-loop
                const result = await window.ipcRenderer.invoke('manuscripts:move-package-track', {
                    filePath,
                    trackId,
                    direction,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (result?.success && result.state) {
                    latestState = result.state;
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
                applyTrackSelectionState(validTrackIds, validTrackIds[0] || null);
            }
        } catch (error) {
            console.error('Failed to move selected tracks:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [applyTrackSelectionState, editorRows, filePath, onPackageStateChange]);

    const persistTrackReorder = useCallback(async (trackId: string, fromIndex: number, toIndex: number) => {
        if (!filePath || fromIndex === toIndex) return;
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            const direction = toIndex > fromIndex ? 'down' : 'up';
            const stepCount = Math.abs(toIndex - fromIndex);
            for (let index = 0; index < stepCount; index += 1) {
                const result = await window.ipcRenderer.invoke('manuscripts:move-package-track', {
                    filePath,
                    trackId,
                    direction,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (result?.success && result.state) {
                    latestState = result.state;
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
            }
        } catch (error) {
            console.error('Failed to persist track reorder:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [filePath, onPackageStateChange]);

    const findAdjacentCompatibleTrackId = useCallback((trackId: string | null, direction: 'up' | 'down') => {
        const normalizedTrackId = String(trackId || '').trim();
        if (!normalizedTrackId) return null;
        const trackKind = trackIdToKind(normalizedTrackId);
        const compatibleTrackIds = editorRows
            .map((row) => row.id)
            .filter((rowId) => trackIdToKind(rowId) === trackKind);
        const currentIndex = compatibleTrackIds.indexOf(normalizedTrackId);
        if (currentIndex < 0) return null;
        const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (nextIndex < 0 || nextIndex >= compatibleTrackIds.length) return null;
        return compatibleTrackIds[nextIndex] || null;
    }, [editorRows]);

    const moveSelectedClipToAdjacentTrack = useCallback((direction: 'up' | 'down') => {
        if (!selectedClipId || effectiveSelectedClipIds.length !== 1) return;
        const sourceTrackId = editorRows.find((row) => row.actions.some((action) => action.id === selectedClipId))?.id || null;
        if (!sourceTrackId) return;
        const targetTrackId = findAdjacentCompatibleTrackId(sourceTrackId, direction);
        if (!targetTrackId || targetTrackId === sourceTrackId) return;
        if (lockedTrackIds.includes(sourceTrackId) || lockedTrackIds.includes(targetTrackId)) return;
        const sourceRow = editorRows.find((row) => row.id === sourceTrackId);
        const targetRow = editorRows.find((row) => row.id === targetTrackId);
        if (!sourceRow || !targetRow) return;
        const movingAction = sourceRow.actions.find((action) => action.id === selectedClipId);
        if (!movingAction) return;
        captureUndoSnapshot();
        const nextRows = editorRows.map((row) => {
            if (row.id === sourceTrackId) {
                return {
                    ...row,
                    actions: rebalanceActionsInOrder(row.actions.filter((action) => action.id !== selectedClipId)),
                };
            }
            if (row.id === targetTrackId) {
                return {
                    ...row,
                    actions: rebalanceActionsByStart([...row.actions.map((action) => ({ ...action })), { ...movingAction }]),
                };
            }
            return {
                ...row,
                actions: row.actions.map((action) => ({ ...action })),
            };
        });
        setEditorRows(nextRows);
        setFocusedTrackId(targetTrackId);
        applySelectionState([selectedClipId], selectedClipId);
    }, [applySelectionState, captureUndoSnapshot, editorRows, effectiveSelectedClipIds.length, findAdjacentCompatibleTrackId, lockedTrackIds, selectedClipId]);

    const beginTrackReorder = useCallback((event: React.PointerEvent<HTMLButtonElement>, trackId: string) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (isPersisting) return;
        const normalizedTrackId = String(trackId || '').trim();
        if (!normalizedTrackId) return;
        captureUndoSnapshot();
        setTrackReorder({
            pointerId: event.pointerId,
            trackId: normalizedTrackId,
            startClientY: event.clientY,
            initialRows: cloneRows(editorRows),
        });
    }, [captureUndoSnapshot, editorRows, isPersisting]);

    const handleDeleteSelectedClip = useCallback(async () => {
        if (!filePath || effectiveSelectedClipIds.length === 0) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            const idsToDelete = [...effectiveSelectedClipIds];
            for (const clipId of idsToDelete) {
                const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                    filePath,
                    clipId,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (result?.success && result.state) {
                    latestState = result.state;
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
                clearSelectionState();
            }
        } catch (error) {
            console.error('Failed to delete selected clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [captureUndoSnapshot, clearSelectionState, effectiveSelectedClipIds, filePath, onPackageStateChange]);

    const handleSplitSelectedClip = useCallback(async () => {
        if (!filePath || !selectedClipId) return;
        const selectedAction = editorRows.flatMap((row) => row.actions).find((action) => action.id === selectedClipId);
        if (!selectedAction) return;
        const actionStart = Number(selectedAction.start || 0);
        const actionEnd = Number(selectedAction.end || 0);
        const actionDuration = Math.max(0.1, actionEnd - actionStart);
        const relativeCursor = effectiveCursorTime > actionStart && effectiveCursorTime < actionEnd
            ? (effectiveCursorTime - actionStart) / actionDuration
            : 0.5;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:split-package-clip', {
                filePath,
                clipId: selectedClipId,
                splitRatio: relativeCursor,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to split selected clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [captureUndoSnapshot, effectiveCursorTime, editorRows, filePath, onPackageStateChange, selectedClipId]);

    const handleDeleteClipById = useCallback(async (clipId: string) => {
        if (!filePath || !clipId) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                filePath,
                clipId,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
                if (effectiveSelectedClipIds.includes(clipId)) {
                    const remaining = effectiveSelectedClipIds.filter((item) => item !== clipId);
                    applySelectionState(remaining, remaining[0] || null);
                }
            }
        } catch (error) {
            console.error('Failed to delete selected clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [applySelectionState, captureUndoSnapshot, effectiveSelectedClipIds, filePath, onPackageStateChange]);

    const handleSplitClipAtCursor = useCallback(async (clipId: string, splitAtTime?: number) => {
        if (!filePath || !clipId) return;
        const selectedAction = editorRows.flatMap((row) => row.actions).find((action) => action.id === clipId);
        if (!selectedAction) return;
        const actionStart = Number(selectedAction.start || 0);
        const actionEnd = Number(selectedAction.end || 0);
        const actionDuration = Math.max(0.1, actionEnd - actionStart);
        const activeTime = typeof splitAtTime === 'number' ? splitAtTime : effectiveCursorTime;
        const relativeCursor = activeTime > actionStart && activeTime < actionEnd
            ? (activeTime - actionStart) / actionDuration
            : 0.5;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:split-package-clip', {
                filePath,
                clipId,
                splitRatio: relativeCursor,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to split selected clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [captureUndoSnapshot, effectiveCursorTime, editorRows, filePath, onPackageStateChange]);

    const handleToggleSelectedClip = useCallback(async () => {
        if (!filePath || !selectedClipId || effectiveSelectedClipIds.length > 1) return;
        const clip = clipById.get(selectedClipId);
        const currentRow = editorRows.find((row) => row.actions.some((action) => action.id === selectedClipId));
        if (!clip || !currentRow) return;
        const order = [...currentRow.actions].findIndex((action) => action.id === selectedClipId);
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
                filePath,
                clipId: selectedClipId,
                assetId: String(clip.assetId || ''),
                track: currentRow.id,
                order,
                durationMs: clip.durationMs ?? null,
                trimInMs: normalizeNumber(clip.trimInMs, 0),
                trimOutMs: normalizeNumber(clip.trimOutMs, 0),
                enabled: clip.enabled === false,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to toggle clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [captureUndoSnapshot, clipById, editorRows, effectiveSelectedClipIds.length, filePath, onPackageStateChange, selectedClipId]);

    const buildClipboardItems = useCallback((): TimelineClipboardItem[] => {
        const selectedIds = effectiveSelectedClipIds;
        if (selectedIds.length === 0) return [];
        return editorRows.flatMap((row) =>
            row.actions
                .map((action, index) => ({ row, action, index }))
                .filter(({ action }) => selectedIds.includes(action.id))
                .map(({ row, action, index }) => {
                    const clip = clipById.get(action.id);
                    return {
                        assetId: String(clip?.assetId || ''),
                        trackId: row.id,
                        kind: assetKindToTrackKind(clip?.assetKind),
                        durationMs: Math.max(100, Math.round(actionDurationSeconds(action) * 1000)),
                        trimInMs: normalizeNumber(action.trimInMs, normalizeNumber(clip?.trimInMs, 0)),
                        trimOutMs: normalizeNumber(action.trimOutMs, normalizeNumber(clip?.trimOutMs, 0)),
                        enabled: action.disable !== true,
                        sourceOrder: index,
                    };
                })
        ).filter((item) => item.assetId);
    }, [clipById, editorRows, effectiveSelectedClipIds]);

    const copySelectedClips = useCallback(() => {
        const items = buildClipboardItems();
        if (items.length === 0) return [];
        clipboardRef.current = items;
        return items;
    }, [buildClipboardItems]);

    const readClipboardItems = useCallback((text?: string | null): TimelineClipboardItem[] => {
        if (clipboardRef.current.length > 0) {
            return clipboardRef.current;
        }
        try {
            if (!text) return [];
            const parsed = JSON.parse(text) as { type?: unknown; items?: TimelineClipboardItem[] };
            if (parsed.type === 'redbox-timeline-clips' && Array.isArray(parsed.items)) {
                const normalizedItems = parsed.items
                    .map((item) => ({
                        ...item,
                        kind: item.kind === 'audio' ? 'audio' : trackIdToKind(String(item.trackId || '')),
                    }))
                    .filter((item) => !!item.assetId);
                clipboardRef.current = normalizedItems;
                return normalizedItems;
            }
        } catch {
            // noop
        }
        return [];
    }, []);

    const pasteClipboardClips = useCallback(async (itemsOverride?: TimelineClipboardItem[]) => {
        if (!filePath) return;
        const items = itemsOverride && itemsOverride.length > 0 ? itemsOverride : readClipboardItems();
        if (items.length === 0) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            const grouped = new Map<string, TimelineClipboardItem[]>();
            for (const item of items) {
                const destinationTrackId = await ensureTrackIdForKind(item.kind, {
                    preferredTrackId: activeTrackId,
                    fallbackTrackId: item.trackId,
                });
                const targetTrackId = destinationTrackId || item.trackId;
                const bucket = grouped.get(targetTrackId) || [];
                bucket.push(item);
                grouped.set(targetTrackId, bucket);
            }
            let latestState: Record<string, unknown> | null = null;
            const insertedClipIds: string[] = [];
            for (const [trackId, trackItems] of grouped.entries()) {
                const currentRow = editorRows.find((row) => row.id === trackId);
                const sortedTrackItems = [...trackItems].sort((a, b) => a.sourceOrder - b.sourceOrder);
                const sortedActions = currentRow
                    ? [...currentRow.actions].sort((a, b) => a.start - b.start)
                    : [];
                let insertionOrder = sortedActions.length;
                let splitTarget: TimelineActionShape | null = null;
                let splitRatio = 0.5;

                for (let index = 0; index < sortedActions.length; index += 1) {
                    const action = sortedActions[index];
                    const midpoint = (Number(action.start || 0) + Number(action.end || 0)) / 2;
                    const actionStart = Number(action.start || 0);
                    const actionEnd = Number(action.end || 0);
                    if (effectiveCursorTime > actionStart && effectiveCursorTime < actionEnd) {
                        splitTarget = action;
                        const duration = Math.max(0.1, actionEnd - actionStart);
                        splitRatio = Math.min(Math.max((effectiveCursorTime - actionStart) / duration, 0.1), 0.9);
                        insertionOrder = index + 1;
                        break;
                    }
                    if (effectiveCursorTime <= midpoint) {
                        insertionOrder = index;
                        break;
                    }
                }

                if (splitTarget) {
                    const splitResult = await window.ipcRenderer.invoke('manuscripts:split-package-clip', {
                        filePath,
                        clipId: splitTarget.id,
                        splitRatio,
                    }) as { success?: boolean; state?: Record<string, unknown> };
                    if (splitResult?.success && splitResult.state) {
                        latestState = splitResult.state;
                    }
                }

                for (const item of sortedTrackItems) {
                    const addResult = await window.ipcRenderer.invoke('manuscripts:add-package-clip', {
                        filePath,
                        assetId: item.assetId,
                        track: trackId,
                        order: insertionOrder,
                        durationMs: item.durationMs,
                    }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
                    if (!addResult?.success || !addResult.insertedClipId) {
                        insertionOrder += 1;
                        continue;
                    }
                    insertedClipIds.push(addResult.insertedClipId);
                    const updateResult = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
                        filePath,
                        clipId: addResult.insertedClipId,
                        assetId: item.assetId,
                        track: trackId,
                        order: insertionOrder,
                        durationMs: item.durationMs,
                        trimInMs: item.trimInMs,
                        trimOutMs: item.trimOutMs,
                        enabled: item.enabled,
                    }) as { success?: boolean; state?: Record<string, unknown> };
                    latestState = (updateResult?.success && updateResult.state)
                        ? updateResult.state
                        : (addResult.state || latestState);
                    insertionOrder += 1;
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
            }
            if (insertedClipIds.length > 0) {
                applySelectionState(insertedClipIds, insertedClipIds[insertedClipIds.length - 1] || insertedClipIds[0] || null);
            }
        } catch (error) {
            console.error('Failed to paste timeline clips:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [activeTrackId, applySelectionState, captureUndoSnapshot, editorRows, effectiveCursorTime, ensureTrackIdForKind, filePath, onPackageStateChange, readClipboardItems]);

    const undoTimelineChange = useCallback(() => {
        const snapshot = undoStackRef.current.pop();
        if (!snapshot) return;
        redoStackRef.current.push(snapshotSelectionState());
        setEditorRows(cloneRows(snapshot.rows));
        applySelectionState(snapshot.selectedClipIds, snapshot.primaryClipId);
    }, [applySelectionState, snapshotSelectionState]);

    const redoTimelineChange = useCallback(() => {
        const snapshot = redoStackRef.current.pop();
        if (!snapshot) return;
        undoStackRef.current.push(snapshotSelectionState());
        setEditorRows(cloneRows(snapshot.rows));
        applySelectionState(snapshot.selectedClipIds, snapshot.primaryClipId);
    }, [applySelectionState, snapshotSelectionState]);

    const handleAssetDrop = async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDraggingAsset(false);
        setDraggingAssetKind(null);
        setDropIndicator(null);
        setDragPreview(null);
        emitTimelineDragState(false);
        const assetId = parseAssetIdFromDataTransfer(event.dataTransfer);
        const directPayload = event.dataTransfer.getData('application/x-redbox-asset');
        let durationMs: number | undefined;
        if (directPayload) {
            try {
                const parsed = JSON.parse(directPayload) as { durationMs?: unknown };
                const candidateDurationMs = Number(parsed.durationMs);
                if (Number.isFinite(candidateDurationMs) && candidateDurationMs > 0) {
                    durationMs = candidateDurationMs;
                }
            } catch {
                // noop
            }
        }
        if (!assetId || !bodyRef.current || !filePath) {
            console.warn('[timeline-drop] missing required drop context', {
                assetId,
                hasBody: !!bodyRef.current,
                filePath,
            });
            return;
        }

        const rect = bodyRef.current.getBoundingClientRect();
        const assetPayload = parseAssetPayloadFromDataTransfer(event.dataTransfer);
        const assetTrackKind = assetKindToTrackKind(assetPayload?.kind);
        const relativeY = event.clientY - rect.top + scrollTop;
        const hoveredTrack = findTrackSummaryAtRelativeY(relativeY, false);
        const hoveredRow = hoveredTrack ? editorRows.find((row) => row.id === hoveredTrack.id) || null : null;
        const virtualPlacement = resolveVirtualTrackPlacement(relativeY, assetTrackKind);
        const ensuredTrackId = virtualPlacement.shouldCreateTrack
            ? await createTrackOfKind(assetTrackKind, {
                adjacentToTrackId: virtualPlacement.anchorTrackId,
                direction: virtualPlacement.direction,
            })
            : await ensureTrackIdForKind(assetTrackKind, {
                preferredTrackId: hoveredRow && !lockedTrackIds.includes(hoveredRow.id) ? hoveredRow.id : null,
            });
        const targetTrackId = ensuredTrackId || hoveredRow?.id || null;
        if (!targetTrackId) {
            console.warn('[timeline-drop] could not resolve target track', {
                assetId,
                assetPayload,
                assetTrackKind,
            });
            return;
        }
        const targetRow = editorRows.find((row) => row.id === targetTrackId) || null;
        if (lockedTrackIds.includes(targetTrackId)) {
            console.warn('[timeline-drop] target track is locked', { targetTrackId, assetId });
            return;
        }

        const relativeX = Math.max(0, event.clientX - rect.left - START_LEFT);
        const sortedActions = targetRow
            ? [...targetRow.actions].sort((a, b) => a.start - b.start)
            : [];
        const snapCandidates = [
            0,
            effectiveCursorTime,
            ...sortedActions.flatMap((action) => [Number(action.start || 0), Number(action.end || 0)]),
        ];
        const snappedDrop = snapTimeToCandidates(
            Math.max(0, (relativeX + scrollLeft) / scaleWidth),
            snapCandidates,
            Math.max(TIMELINE_SNAP_SECONDS * 0.5, 10 / Math.max(1, scaleWidth))
        );
        const dropTime = snappedDrop.time;
        let desiredOrder = sortedActions.length;
        let splitTarget: TimelineActionShape | null = null;
        let splitRatio = 0.5;
        for (let index = 0; index < sortedActions.length; index += 1) {
            const midpoint = (sortedActions[index].start + sortedActions[index].end) / 2;
            if (dropTime > sortedActions[index].start && dropTime < sortedActions[index].end) {
                splitTarget = sortedActions[index];
                const duration = Math.max(0.1, sortedActions[index].end - sortedActions[index].start);
                splitRatio = Math.min(Math.max((dropTime - sortedActions[index].start) / duration, 0.1), 0.9);
                desiredOrder = index + 1;
                break;
            }
            if (dropTime <= midpoint) {
                desiredOrder = index;
                break;
            }
        }

        setIsPersisting(true);
        try {
            captureUndoSnapshot();
            console.info('[timeline-drop] dropping asset into timeline', {
                assetId,
                assetPayload,
                targetTrackId,
                desiredOrder,
                splitTarget: splitTarget?.id || null,
                splitRatio,
            });
            if (splitTarget) {
                const splitResult = await window.ipcRenderer.invoke('manuscripts:split-package-clip', {
                    filePath,
                    clipId: splitTarget.id,
                    splitRatio,
                }) as { success?: boolean; state?: Record<string, unknown> };
                if (splitResult?.success && splitResult.state) {
                    onPackageStateChange?.(splitResult.state);
                }
            }
            const result = await window.ipcRenderer.invoke('manuscripts:add-package-clip', {
                filePath,
                assetId,
                track: targetTrackId,
                order: desiredOrder,
                durationMs,
            }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                console.info('[timeline-drop] add clip result', result);
                onPackageStateChange?.(result.state);
                setFocusedTrackId(targetTrackId);
                const insertedClipId = String(result.insertedClipId || '').trim();
                if (insertedClipId) {
                    applySelectionState([insertedClipId], insertedClipId);
                    commitCursorTime(dropTime);
                }
            }
        } catch (error) {
            console.error('Failed to add clip from drag-and-drop:', error);
        } finally {
            setIsPersisting(false);
        }
    };

    const selectedClip = selectedClipId ? clipById.get(selectedClipId) : null;
    const selectedSceneItemId = sceneItemIdForClip(selectedClip);
    const selectedSceneItemHidden = selectedSceneItemId ? sceneItemVisibility[selectedSceneItemId] === false : false;
    const selectedSceneItemLocked = selectedSceneItemId ? !!sceneItemLocks[selectedSceneItemId] : false;
    const selectedSceneItemGrouped = selectedSceneItemId ? !!sceneItemGroups[selectedSceneItemId] : false;
    const totalDurationSeconds = useMemo(() => {
        return Math.max(
            0,
            ...editorRows.flatMap((row) => row.actions.map((action) => Number(action.end || 0)))
        );
    }, [editorRows]);
    const trackSummaries = useMemo(() => {
        let offsetTop = 0;
        return editorRows.map((row, index) => {
            const top = offsetTop;
            const height = row.rowHeight || TIMELINE_ROW_HEIGHT;
            offsetTop += height;
            const visualKind = trackIdToVisualKind(row.id);
            const definition = TRACK_DEFINITIONS[visualKind];
            const ui = effectiveTrackUiMap[row.id] || createDefaultTrackUiState();
            const totalDurationSeconds = row.actions.reduce((sum, action) => (
                sum + Math.max(0, Number(action.end || 0) - Number(action.start || 0))
            ), 0);
            return {
                id: row.id,
                title: row.id,
                kindLabel: definition.kindLabel,
                emptyLabel: definition.emptyLabel,
                kind: visualKind,
                clipCount: row.actions.length,
                totalDurationSeconds,
                locked: ui.locked,
                hidden: ui.hidden,
                collapsed: ui.collapsed,
                muted: ui.muted,
                solo: ui.solo,
                volume: ui.volume,
                top,
                height,
                canMoveUp: index > 0,
                canMoveDown: index < editorRows.length - 1,
            };
        });
    }, [editorRows, effectiveTrackUiMap]);
    const selectedTrackSummaries = useMemo(() => {
        const summaryMap = new Map(trackSummaries.map((track) => [track.id, track]));
        return effectiveSelectedTrackIds
            .map((trackId) => summaryMap.get(trackId))
            .filter((track): track is NonNullable<typeof track> => !!track);
    }, [effectiveSelectedTrackIds, trackSummaries]);
    const trackStackBottom = useMemo(
        () => trackSummaries[trackSummaries.length - 1]
            ? trackSummaries[trackSummaries.length - 1].top + trackSummaries[trackSummaries.length - 1].height
            : 0,
        [trackSummaries]
    );
    const allSelectedTracksAudio = selectedTrackSummaries.length > 0 && selectedTrackSummaries.every((track) => track.kind === 'audio');
    const selectedTrackBatchLabel = useMemo(() => {
        if (selectedTrackSummaries.length === 0) return null;
        const clipCount = selectedTrackSummaries.reduce((sum, track) => sum + track.clipCount, 0);
        return `${selectedTrackSummaries.length} 轨 · ${clipCount} 段`;
    }, [selectedTrackSummaries]);
    const visualClips = useMemo<TrackVisualClip[]>(() => {
        const trackMap = new Map(trackSummaries.map((track) => [track.id, track]));
        return editorRows.flatMap((row) => {
            const track = trackMap.get(row.id);
            if (!track || track.hidden) return [];
            return row.actions.map((action) => ({
                trackId: row.id,
                clipId: action.id,
                left: START_LEFT + Number(action.start || 0) * scaleWidth - scrollLeft,
                width: Math.max(24, (Number(action.end || 0) - Number(action.start || 0)) * scaleWidth),
                top: track.top - scrollTop + 4,
                height: Math.max(track.collapsed ? 30 : 44, track.height - 8),
                selected: selectedClipIdSet.has(action.id),
                action,
                clip: clipById.get(String(action.id || '').trim()),
            }));
        });
    }, [clipById, editorRows, scaleWidth, scrollLeft, scrollTop, selectedClipIdSet, trackSummaries]);
    useEffect(() => {
        const visibleVideoClips = visualClips.filter(({ clip, width }) => {
            const kind = String(clip?.assetKind || '').trim().toLowerCase();
            return kind === 'video' && !!clip && !!assetSourceUrl(clip) && width > 32;
        });

        visibleVideoClips.forEach(({ clipId, clip, width, action }) => {
            if (!clip) return;
            const frameCount = buildClipStripFrameCount(width);
            const cacheKey = `${clipId}:${frameCount}:${Math.round(normalizeNumber(clip.trimInMs, 0))}:${Math.round(actionDurationSeconds(action) * 1000)}`;
            if (videoStripCacheRef.current.has(cacheKey)) {
                const cached = videoStripCacheRef.current.get(cacheKey)!;
                setVideoStripFrames((current) => current[cacheKey] ? current : { ...current, [cacheKey]: cached });
                return;
            }
            if (videoStripPendingRef.current.has(cacheKey)) return;
            videoStripPendingRef.current.add(cacheKey);
            void generateVideoStripFrames({
                assetUrl: assetSourceUrl(clip),
                frameCount,
                clipDurationSeconds: actionDurationSeconds(action),
                trimInSeconds: normalizeNumber(clip.trimInMs, 0) / 1000,
            })
                .then((frames) => {
                    videoStripCacheRef.current.set(cacheKey, frames);
                    setVideoStripFrames((current) => ({ ...current, [cacheKey]: frames }));
                })
                .catch((error) => {
                    console.warn('Failed to generate timeline filmstrip:', error);
                })
                .finally(() => {
                    videoStripPendingRef.current.delete(cacheKey);
                });
        });
    }, [visualClips]);
    const updateRowActions = useCallback((rowId: string, nextActions: TimelineActionShape[]) => {
        setEditorRows((currentRows) => currentRows.map((row) => (
            row.id === rowId
                ? {
                    ...row,
                    actions: nextActions.map((action) => ({ ...action })),
                }
                : row
        )));
    }, []);
    const beginClipInteraction = useCallback((
        event: React.PointerEvent<HTMLElement>,
        mode: ClipInteractionState['mode'],
        rowId: string,
        action: TimelineActionShape
    ) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (lockedTrackIds.includes(rowId)) return;
        const row = editorRows.find((item) => item.id === rowId);
        if (!row) return;
        applySelectionState([action.id], action.id);
        setContextMenu(null);
        pendingHistorySnapshotRef.current = snapshotSelectionState();
        setClipInteraction({
            pointerId: event.pointerId,
            rowId,
            clipId: action.id,
            mode,
            startClientX: event.clientX,
            startClientY: event.clientY,
            initialRows: cloneRows(editorRows),
            initialActions: row.actions.map((item) => ({ ...item })),
            initialAction: { ...action },
        });
    }, [applySelectionState, editorRows, lockedTrackIds, snapshotSelectionState]);

    useEffect(() => {
        if (!clipInteraction) return;

        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerId !== clipInteraction.pointerId) return;
            const deltaSeconds = roundToStep(
                (event.clientX - clipInteraction.startClientX) / scaleWidth,
                TIMELINE_SNAP_SECONDS
            );
            const rowClips = clipInteraction.initialActions.map((action) => ({ ...action }));
            const actionIndex = rowClips.findIndex((action) => action.id === clipInteraction.clipId);
            if (actionIndex < 0) return;
            const sourceClip = rowClips[actionIndex];
            const clip = clipById.get(clipInteraction.clipId);
            const minDurationSeconds = (
                (clip && getEffectId(clip.assetKind) === 'image' ? MIN_IMAGE_CLIP_MS : MIN_CLIP_MS) / 1000
            );
            const snapCandidates = [
                0,
                effectiveCursorTime,
                ...clipInteraction.initialActions
                    .filter((action) => action.id !== clipInteraction.clipId)
                    .flatMap((action) => [Number(action.start || 0), Number(action.end || 0)]),
            ];
            const snapThresholdSeconds = Math.max(TIMELINE_SNAP_SECONDS * 0.5, 10 / Math.max(1, scaleWidth));
            const sourceTrackKind = trackIdToKind(clipInteraction.rowId);
            let targetRowId = clipInteraction.rowId;
            if (clipInteraction.mode === 'move' && bodyRef.current) {
                const rect = bodyRef.current.getBoundingClientRect();
                const relativeY = event.clientY - rect.top + scrollTop;
                const hoveredTrack = findTrackSummaryAtRelativeY(relativeY);
                const hoveredRow = hoveredTrack ? editorRows.find((row) => row.id === hoveredTrack.id) || null : null;
                if (hoveredRow && !lockedTrackIds.includes(hoveredRow.id) && trackIdToKind(hoveredRow.id) === sourceTrackKind) {
                    targetRowId = hoveredRow.id;
                }
            }
            const guideTop = (trackSummaries.find((track) => track.id === targetRowId)?.top ?? 0) - scrollTop;
            const guideHeight = trackSummaries.find((track) => track.id === targetRowId)?.height ?? TIMELINE_ROW_HEIGHT;

            if (clipInteraction.mode === 'move') {
                const intendedStart = Math.max(0, clipInteraction.initialAction.start + deltaSeconds);
                const snappedStart = snapTimeToCandidates(intendedStart, snapCandidates, snapThresholdSeconds);
                const movedAction = {
                    ...sourceClip,
                    start: snappedStart.time,
                    end: snappedStart.time + actionDurationSeconds(clipInteraction.initialAction),
                };
                setInteractionSnapGuide(
                    snappedStart.snapped && typeof snappedStart.candidate === 'number'
                        ? {
                            left: START_LEFT + snappedStart.candidate * scaleWidth - scrollLeft,
                            top: guideTop + 4,
                            height: Math.max(44, guideHeight - 8),
                            label: snappedStart.candidate === effectiveCursorTime ? '吸附到游标' : '吸附到边界',
                        }
                        : null
                );
                if (targetRowId === clipInteraction.rowId) {
                    rowClips[actionIndex] = movedAction;
                    updateRowActions(clipInteraction.rowId, rebalanceActionsByStart(rowClips));
                    return;
                }

                const nextRows = clipInteraction.initialRows.map((row) => {
                    if (row.id === clipInteraction.rowId) {
                        return {
                            ...row,
                            actions: rebalanceActionsInOrder(
                                row.actions
                                    .filter((action) => action.id !== clipInteraction.clipId)
                                    .map((action) => ({ ...action }))
                            ),
                        };
                    }
                    if (row.id === targetRowId) {
                        const targetActions = [
                            ...row.actions.map((action) => ({ ...action })),
                            movedAction,
                        ];
                        return {
                            ...row,
                            actions: rebalanceActionsByStart(targetActions),
                        };
                    }
                    return {
                        ...row,
                        actions: row.actions.map((action) => ({ ...action })),
                    };
                });
                setEditorRows(nextRows);
                return;
            }

            if (clipInteraction.mode === 'resize-start') {
                const initialTrimInMs = normalizeNumber(clipInteraction.initialAction.trimInMs, 0);
                const maxRevealSeconds = initialTrimInMs / 1000;
                const initialDuration = actionDurationSeconds(clipInteraction.initialAction);
                const clampedDelta = Math.min(
                    Math.max(deltaSeconds, -maxRevealSeconds),
                    Math.max(0, initialDuration - minDurationSeconds)
                );
                const nextDuration = Math.max(
                    minDurationSeconds,
                    initialDuration - clampedDelta
                );
                const nextTrimInMs = Math.max(0, initialTrimInMs + Math.round(clampedDelta * 1000));
                rowClips[actionIndex] = {
                    ...sourceClip,
                    end: Number(sourceClip.start || 0) + nextDuration,
                    trimInMs: nextTrimInMs,
                };
                setInteractionSnapGuide(null);
                updateRowActions(clipInteraction.rowId, rebalanceActionsInOrder(rowClips));
                return;
            }

            const intendedEnd = Number(sourceClip.start || 0) + Math.max(
                minDurationSeconds,
                actionDurationSeconds(clipInteraction.initialAction) + deltaSeconds
            );
            const snappedEnd = snapTimeToCandidates(intendedEnd, snapCandidates, snapThresholdSeconds);
            const nextDuration = Math.max(
                minDurationSeconds,
                snappedEnd.time - Number(sourceClip.start || 0)
            );
            rowClips[actionIndex] = {
                ...sourceClip,
                end: Number(sourceClip.start || 0) + nextDuration,
            };
            setInteractionSnapGuide(
                snappedEnd.snapped && typeof snappedEnd.candidate === 'number'
                    ? {
                        left: START_LEFT + snappedEnd.candidate * scaleWidth - scrollLeft,
                        top: guideTop + 4,
                        height: Math.max(44, guideHeight - 8),
                        label: snappedEnd.candidate === effectiveCursorTime ? '对齐游标' : '对齐边界',
                    }
                    : null
            );
            updateRowActions(clipInteraction.rowId, rebalanceActionsInOrder(rowClips));
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (event.pointerId !== clipInteraction.pointerId) return;
            const pendingSnapshot = pendingHistorySnapshotRef.current;
            if (pendingSnapshot && serializeRows(pendingSnapshot.rows) !== serializeRows(editorRows)) {
                pushUndoSnapshot(pendingSnapshot);
            }
            pendingHistorySnapshotRef.current = null;
            setInteractionSnapGuide(null);
            setClipInteraction(null);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [clipById, clipInteraction, effectiveCursorTime, editorRows, lockedTrackIds, pushUndoSnapshot, scaleWidth, scrollLeft, scrollTop, trackSummaries, updateRowActions]);

    useEffect(() => {
        if (!trackReorder) return;

        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerId !== trackReorder.pointerId) return;
            const sourceIndex = trackReorder.initialRows.findIndex((row) => row.id === trackReorder.trackId);
            if (sourceIndex < 0) return;
            const deltaY = event.clientY - trackReorder.startClientY;
            const movedSlots = Math.round(deltaY / TIMELINE_ROW_HEIGHT);
            const targetIndex = Math.max(0, Math.min(trackReorder.initialRows.length - 1, sourceIndex + movedSlots));
            setEditorRows(reorderRowsByIndices(trackReorder.initialRows, sourceIndex, targetIndex));
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (event.pointerId !== trackReorder.pointerId) return;
            const sourceIndex = trackReorder.initialRows.findIndex((row) => row.id === trackReorder.trackId);
            const targetIndex = editorRows.findIndex((row) => row.id === trackReorder.trackId);
            setTrackReorder(null);
            if (sourceIndex >= 0 && targetIndex >= 0 && sourceIndex !== targetIndex) {
                void persistTrackReorder(trackReorder.trackId, sourceIndex, targetIndex);
            }
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [editorRows, persistTrackReorder, trackReorder]);
    const effectiveDurationInFrames = Math.max(
        1,
        Number.isFinite(durationInFrames as number)
            ? Number(durationInFrames)
            : Math.round(totalDurationSeconds * safeFps)
    );
    const boundedFrame = Math.min(
        Math.max(0, Number.isFinite(currentFrame as number) ? Number(currentFrame) : Math.round(effectiveCursorTime * safeFps)),
        Math.max(0, effectiveDurationInFrames - 1)
    );
    const timelineContentWidth = useMemo(() => {
        const minimumScaleCount = 20;
        const visualSeconds = Math.max(totalDurationSeconds, minimumScaleCount);
        return START_LEFT + visualSeconds * scaleWidth;
    }, [scaleWidth, totalDurationSeconds]);
    const maxScrollLeft = Math.max(0, timelineContentWidth - viewportWidth);
    const selectedClipDurationSeconds = useMemo(() => {
        const action = editorRows.flatMap((row) => row.actions).find((item) => item.id === selectedClipId);
        if (!action) return 0;
        return Math.max(0.1, Number(action.end || 0) - Number(action.start || 0));
    }, [editorRows, selectedClipId]);
    const activeTrackSummary = useMemo(() => {
        if (!activeTrackId) return null;
        return trackSummaries.find((track) => track.id === activeTrackId) || null;
    }, [activeTrackId, trackSummaries]);

    function findTrackSummaryAtRelativeY(relativeY: number, clampToEdge = true) {
        const exactTrack = trackSummaries.find((track) => relativeY >= track.top && relativeY < track.top + track.height) || null;
        if (exactTrack || !clampToEdge) {
            return exactTrack;
        }
        if (relativeY < 0) {
            return trackSummaries[0] || null;
        }
        return trackSummaries[trackSummaries.length - 1] || null;
    }

    function resolveVirtualTrackPlacement(relativeY: number, kind: TrackKind) {
        if (trackSummaries.length === 0) {
            return {
                shouldCreateTrack: true,
                direction: 'down' as const,
                anchorTrackId: null,
                virtualTop: 0,
                virtualHeight: trackKindRowHeight(kind),
            };
        }

        if (relativeY < 0) {
            return {
                shouldCreateTrack: true,
                direction: 'up' as const,
                anchorTrackId: trackSummaries[0]?.id || null,
                virtualTop: 0,
                virtualHeight: trackKindRowHeight(kind),
            };
        }

        if (relativeY >= trackStackBottom) {
            return {
                shouldCreateTrack: true,
                direction: 'down' as const,
                anchorTrackId: trackSummaries[trackSummaries.length - 1]?.id || null,
                virtualTop: trackStackBottom,
                virtualHeight: trackKindRowHeight(kind),
            };
        }

        return {
            shouldCreateTrack: false,
            direction: 'down' as const,
            anchorTrackId: null,
            virtualTop: 0,
            virtualHeight: trackKindRowHeight(kind),
        };
    }

    useEffect(() => {
        if (!selectedTrackId) return;
        if (!hiddenTrackIds.includes(selectedTrackId)) return;
        clearSelectionState();
    }, [clearSelectionState, hiddenTrackIds, selectedTrackId]);
    const selectedClipAction = useMemo(() => {
        if (!selectedClipId) return null;
        return editorRows.flatMap((row) => row.actions).find((item) => item.id === selectedClipId) || null;
    }, [editorRows, selectedClipId]);
    const zoomPercent = Math.round((scaleWidth / SCALE_WIDTH) * 100);
    const canUseTransport = !!(onTogglePlayback || onStepFrame || onSeekFrame);
    const playheadLeft = Math.round(Math.min(
        Math.max(START_LEFT, START_LEFT + effectiveCursorTime * scaleWidth - scrollLeft),
        Math.max(START_LEFT, viewportWidth - 12)
    ));
    const interactionGuide = useMemo(() => {
        if (!clipInteraction) return null;
        const activeClip = visualClips.find((clip) => clip.clipId === clipInteraction.clipId);
        if (!activeClip) return null;
        return {
            left: activeClip.left,
            right: activeClip.left + activeClip.width,
            top: activeClip.top,
            height: activeClip.height,
            label:
                clipInteraction.mode === 'move'
                    ? '移动'
                    : clipInteraction.mode === 'resize-start'
                        ? '调整入点'
                        : '调整出点',
        };
    }, [clipInteraction, visualClips]);

    const syncTimelineScrollLeft = useCallback((nextLeft: number) => {
        const safeLeft = clampNumber(nextLeft, 0, maxScrollLeft);
        timelineRef.current?.setScrollLeft(safeLeft);
        setScrollLeft((current) => (
            Math.abs(current - safeLeft) < SCROLL_LEFT_EPSILON ? current : safeLeft
        ));
    }, [maxScrollLeft]);

    const syncTimelineScrollTop = useCallback((nextTop: number) => {
        const safeTop = clampNumber(nextTop, 0, maxScrollTop);
        timelineRef.current?.setScrollTop(safeTop);
        setScrollTop((current) => (
            Math.abs(current - safeTop) < SCROLL_TOP_EPSILON ? current : safeTop
        ));
    }, [maxScrollTop]);

    const applyTimelineScale = useCallback((
        nextScaleWidth: number,
        anchorClientX?: number,
        anchorBounds?: DOMRect | null
    ) => {
        const clampedScaleWidth = clampNumber(nextScaleWidth, MIN_SCALE_WIDTH, MAX_SCALE_WIDTH);
        if (Math.abs(clampedScaleWidth - scaleWidth) < 0.001) {
            return;
        }

        let nextScrollLeft = scrollLeft;
        if (
            typeof anchorClientX === 'number'
            && anchorBounds
            && anchorBounds.width > START_LEFT
        ) {
            const relativeX = clampNumber(anchorClientX - anchorBounds.left - START_LEFT, 0, anchorBounds.width - START_LEFT);
            const anchorTime = Math.max(0, (relativeX + scrollLeft) / Math.max(1, scaleWidth));
            const nextContentWidth = START_LEFT + Math.max(totalDurationSeconds, 20) * clampedScaleWidth;
            const nextMaxScrollLeft = Math.max(0, nextContentWidth - viewportWidth);
            nextScrollLeft = clampNumber(anchorTime * clampedScaleWidth - relativeX, 0, nextMaxScrollLeft);
        }

        setScaleWidth(clampedScaleWidth);
        if (Math.abs(nextScrollLeft - scrollLeft) >= SCROLL_LEFT_EPSILON) {
            timelineRef.current?.setScrollLeft(nextScrollLeft);
            setScrollLeft(nextScrollLeft);
        }
    }, [scaleWidth, scrollLeft, totalDurationSeconds, viewportWidth]);

    const focusOnTime = useCallback((timeInSeconds: number) => {
        const left = Math.max(0, timeInSeconds * scaleWidth - Math.max(180, viewportWidth * 0.35));
        syncTimelineScrollLeft(left);
    }, [scaleWidth, syncTimelineScrollLeft, viewportWidth]);

    const seekToTime = useCallback((timeInSeconds: number) => {
        const safeTime = Math.max(0, timeInSeconds);
        commitCursorTime(safeTime);
    }, [commitCursorTime]);

    const seekBodyCursorToClientX = useCallback((clientX: number) => {
        if (!bodyRef.current) return;
        const rect = bodyRef.current.getBoundingClientRect();
        const relativeX = Math.max(0, clientX - rect.left - START_LEFT);
        const nextTime = Math.max(0, (relativeX + scrollLeft) / scaleWidth);
        seekToTime(nextTime);
    }, [scaleWidth, scrollLeft, seekToTime]);

    const focusOnCursor = useCallback(() => {
        focusOnTime(effectiveCursorTime);
    }, [effectiveCursorTime, focusOnTime]);

    const focusOnSelectedClip = useCallback(() => {
        if (!selectedClipAction) return;
        const clipCenter = (Number(selectedClipAction.start || 0) + Number(selectedClipAction.end || 0)) / 2;
        focusOnTime(clipCenter);
    }, [focusOnTime, selectedClipAction]);

    useEffect(() => {
        const nextClipId = String(controlledSelectedClipId || '').trim();
        if (!nextClipId || nextClipId !== selectedClipId) return;
        focusOnSelectedClip();
    }, [controlledSelectedClipId, focusOnSelectedClip, selectedClipId]);

    const jumpToSelectedClipEdge = useCallback((edge: 'start' | 'end') => {
        if (!selectedClipAction) return;
        const nextTime = edge === 'start'
            ? Number(selectedClipAction.start || 0)
            : Number(selectedClipAction.end || 0);
        seekToTime(nextTime);
        focusOnTime(nextTime);
    }, [focusOnTime, seekToTime, selectedClipAction]);

    const zoomOutTimeline = useCallback((anchorClientX?: number, anchorBounds?: DOMRect | null) => {
        applyTimelineScale(scaleWidth - TIMELINE_WHEEL_ZOOM_STEP, anchorClientX, anchorBounds);
    }, [applyTimelineScale, scaleWidth]);

    const zoomResetTimeline = useCallback((anchorClientX?: number, anchorBounds?: DOMRect | null) => {
        applyTimelineScale(SCALE_WIDTH, anchorClientX, anchorBounds);
    }, [applyTimelineScale]);

    const fitZoomToTimeline = useCallback(() => {
        const availableWidth = Math.max(240, viewportWidth - START_LEFT - 32);
        const visualSeconds = Math.max(totalDurationSeconds, 6);
        const nextScaleWidth = Math.round(availableWidth / visualSeconds);
        applyTimelineScale(nextScaleWidth);
    }, [applyTimelineScale, totalDurationSeconds, viewportWidth]);

    const zoomInTimeline = useCallback((anchorClientX?: number, anchorBounds?: DOMRect | null) => {
        applyTimelineScale(scaleWidth + TIMELINE_WHEEL_ZOOM_STEP, anchorClientX, anchorBounds);
    }, [applyTimelineScale, scaleWidth]);

    const handleTimelineWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
        const deltaScale = event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
                ? Math.max(1, viewportWidth)
                : 1;
        const normalizedDeltaX = event.deltaX * deltaScale;
        const normalizedDeltaY = event.deltaY * deltaScale;

        if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            const shouldZoomIn = normalizedDeltaY < 0;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (shouldZoomIn) {
                zoomInTimeline(event.clientX, bounds);
            } else {
                zoomOutTimeline(event.clientX, bounds);
            }
            return;
        }

        const verticalDelta = Math.abs(normalizedDeltaY) >= TIMELINE_WHEEL_SCROLL_STEP
            ? normalizedDeltaY
            : normalizedDeltaX;
        const horizontalDelta = Math.abs(normalizedDeltaX) >= TIMELINE_WHEEL_SCROLL_STEP
            ? normalizedDeltaX
            : normalizedDeltaY;
        if (!event.shiftKey && Math.abs(verticalDelta) < TIMELINE_WHEEL_SCROLL_STEP) {
            return;
        }
        if (event.shiftKey && Math.abs(horizontalDelta) < TIMELINE_WHEEL_SCROLL_STEP) {
            return;
        }

        event.preventDefault();
        if (event.shiftKey) {
            syncTimelineScrollLeft(scrollLeft + horizontalDelta);
            return;
        }
        syncTimelineScrollTop(scrollTop + verticalDelta);
    }, [scrollLeft, scrollTop, syncTimelineScrollLeft, syncTimelineScrollTop, viewportWidth, zoomInTimeline, zoomOutTimeline]);

    const selectAllClips = useCallback(() => {
        const allIds = editorRows.flatMap((row) => row.actions.map((action) => action.id));
        applySelectionState(allIds, allIds[0] || null);
    }, [applySelectionState, editorRows]);

    useEffect(() => {
        const handleCopy = (event: ClipboardEvent) => {
            if (!isTimelineFocusedRef.current) return;
            const items = copySelectedClips();
            if (!items.length) return;
            event.preventDefault();
            const payload = JSON.stringify({
                type: 'redbox-timeline-clips',
                items,
            });
            event.clipboardData?.setData('text/plain', payload);
        };

        const handlePaste = (event: ClipboardEvent) => {
            if (!isTimelineFocusedRef.current) return;
            const text = event.clipboardData?.getData('text/plain') || '';
            const items = readClipboardItems(text);
            if (items.length === 0) return;
            event.preventDefault();
            void pasteClipboardClips(items);
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isTimelineFocusedRef.current) return;
            const target = event.target as HTMLElement | null;
            const tagName = target?.tagName?.toLowerCase();
            const isTyping =
                tagName === 'input' ||
                tagName === 'textarea' ||
                tagName === 'select' ||
                !!target?.isContentEditable;
            if (isTyping) return;

            const withCommand = event.metaKey || event.ctrlKey;
            const key = event.key.toLowerCase();

            if (event.code === 'Space') {
                if (!onTogglePlayback) return;
                event.preventDefault();
                onTogglePlayback();
                return;
            }

            if (withCommand && key === 'a') {
                event.preventDefault();
                selectAllClips();
                return;
            }

            if (withCommand && key === 'c') {
                event.preventDefault();
                copySelectedClips();
                return;
            }

            if (withCommand && key === 'x') {
                event.preventDefault();
                copySelectedClips();
                void handleDeleteSelectedClip();
                return;
            }

            if (withCommand && key === 'v') {
                event.preventDefault();
                void pasteClipboardClips();
                return;
            }

            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClipId) {
                event.preventDefault();
                void handleDeleteClipById(selectedClipId);
                return;
            }

            if (withCommand && key === 'b' && selectedClipId) {
                event.preventDefault();
                void handleSplitClipAtCursor(selectedClipId);
                return;
            }

            if (withCommand && (key === '=' || key === '+')) {
                event.preventDefault();
                zoomInTimeline();
                return;
            }

            if (withCommand && key === '-') {
                event.preventDefault();
                zoomOutTimeline();
                return;
            }

            if (withCommand && key === '0') {
                event.preventDefault();
                zoomResetTimeline();
                return;
            }

            if (withCommand && key === '9') {
                event.preventDefault();
                fitZoomToTimeline();
                return;
            }

            if (withCommand && key === 'z' && event.shiftKey) {
                event.preventDefault();
                redoTimelineChange();
                return;
            }

            if (withCommand && key === 'z') {
                event.preventDefault();
                undoTimelineChange();
                return;
            }

            if (!event.metaKey && event.ctrlKey && key === 'y') {
                event.preventDefault();
                redoTimelineChange();
                return;
            }

            if (event.altKey && event.shiftKey && event.key === 'ArrowUp' && activeTrackId) {
                event.preventDefault();
                void handleMoveTrack(activeTrackId, 'up');
                return;
            }

            if (event.altKey && event.shiftKey && event.key === 'ArrowDown' && activeTrackId) {
                event.preventDefault();
                void handleMoveTrack(activeTrackId, 'down');
                return;
            }

            if (event.altKey && !event.shiftKey && event.key === 'ArrowUp') {
                event.preventDefault();
                moveSelectedClipToAdjacentTrack('up');
                return;
            }

            if (event.altKey && !event.shiftKey && event.key === 'ArrowDown') {
                event.preventDefault();
                moveSelectedClipToAdjacentTrack('down');
                return;
            }

            if (withCommand && key === 'l' && effectiveSelectedTrackIds.length > 0) {
                event.preventDefault();
                handleBatchTrackUi(effectiveSelectedTrackIds, (current) => ({ ...current, locked: !current.locked }));
                return;
            }

            if (event.key === 'ArrowLeft') {
                if (!onStepFrame) return;
                event.preventDefault();
                onStepFrame(event.shiftKey ? -safeFps : -1);
                return;
            }

            if (event.key === 'ArrowRight') {
                if (!onStepFrame) return;
                event.preventDefault();
                onStepFrame(event.shiftKey ? safeFps : 1);
            }
        };

        document.addEventListener('copy', handleCopy, true);
        document.addEventListener('paste', handlePaste, true);
        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('copy', handleCopy, true);
            document.removeEventListener('paste', handlePaste, true);
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [
        fitZoomToTimeline,
        copySelectedClips,
        handleDeleteSelectedClip,
        handleDeleteClipById,
        handleSplitClipAtCursor,
        onStepFrame,
        onTogglePlayback,
        pasteClipboardClips,
        redoTimelineChange,
        safeFps,
        selectAllClips,
        selectedClipId,
        activeTrackId,
        applyTrackSelectionState,
        effectiveSelectedTrackIds,
        handleMoveTrack,
        handleBatchTrackUi,
        moveSelectedClipToAdjacentTrack,
        selectedTrackIdSet,
        undoTimelineChange,
        zoomInTimeline,
        zoomOutTimeline,
        zoomResetTimeline,
    ]);

    useEffect(() => {
        if (!bodyRef.current) return;
        const update = () => {
            const width = bodyRef.current?.clientWidth || 0;
            setViewportWidth(width);
            const grid = bodyRef.current?.querySelector('.ReactVirtualized__Grid') as HTMLElement | null;
            if (grid) {
                const nextMaxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight);
                const nextSafeScrollTop = clampNumber(grid.scrollTop, 0, nextMaxScrollTop);
                setMaxScrollTop((current) => (
                    Math.abs(current - nextMaxScrollTop) < SCROLL_TOP_EPSILON ? current : nextMaxScrollTop
                ));
                if (Math.abs(grid.scrollTop - nextSafeScrollTop) >= SCROLL_TOP_EPSILON) {
                    timelineRef.current?.setScrollTop(nextSafeScrollTop);
                }
                setScrollTop((current) => (
                    Math.abs(current - nextSafeScrollTop) < SCROLL_TOP_EPSILON ? current : nextSafeScrollTop
                ));
            }
        };
        update();
        const observer = new ResizeObserver(() => update());
        observer.observe(bodyRef.current);
        return () => observer.disconnect();
    }, [editorRows]);

    useEffect(() => {
        onViewportMetricsChange?.({
            scrollLeft,
            maxScrollLeft,
            scrollTop,
            maxScrollTop,
        });
    }, [maxScrollLeft, maxScrollTop, onViewportMetricsChange, scrollLeft, scrollTop]);

    useEffect(() => {
        const nextZoom = Number(controlledZoomPercent);
        if (!Number.isFinite(nextZoom)) return;
        const nextScaleWidth = clampNumber((nextZoom / 100) * SCALE_WIDTH, MIN_SCALE_WIDTH, MAX_SCALE_WIDTH);
        setScaleWidth((current) => (Math.abs(current - nextScaleWidth) < 0.001 ? current : nextScaleWidth));
    }, [controlledZoomPercent]);

    useEffect(() => {
        onZoomPercentChange?.(zoomPercent);
    }, [onZoomPercentChange, zoomPercent]);

    useEffect(() => {
        const nextScrollLeft = Number(controlledViewport?.scrollLeft);
        if (!Number.isFinite(nextScrollLeft)) return;
        const safeLeft = clampNumber(nextScrollLeft, 0, maxScrollLeft);
        timelineRef.current?.setScrollLeft(safeLeft);
        setScrollLeft((current) => (
            Math.abs(current - safeLeft) < SCROLL_LEFT_EPSILON ? current : safeLeft
        ));
    }, [controlledViewport?.scrollLeft, maxScrollLeft]);

    useEffect(() => {
        const nextScrollTop = Number(controlledViewport?.scrollTop);
        if (!Number.isFinite(nextScrollTop)) return;
        const safeTop = clampNumber(nextScrollTop, 0, maxScrollTop);
        timelineRef.current?.setScrollTop(safeTop);
        setScrollTop((current) => (
            Math.abs(current - safeTop) < SCROLL_TOP_EPSILON ? current : safeTop
        ));
    }, [controlledViewport?.scrollTop, maxScrollTop]);

    return (
        <div
            ref={rootRef}
            tabIndex={0}
            className={clsx('redbox-editable-timeline', accent === 'emerald' ? 'redbox-editable-timeline--emerald' : 'redbox-editable-timeline--cyan')}
            onFocus={() => {
                isTimelineFocusedRef.current = true;
            }}
            onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                isTimelineFocusedRef.current = false;
            }}
            onPointerDown={() => {
                isTimelineFocusedRef.current = true;
                rootRef.current?.focus({ preventScroll: true });
            }}
        >
            <TimelineToolbar
                clipCount={normalizedClips.length}
                trackCount={editorRows.length}
                isPersisting={isPersisting}
                selectedClipLabel={
                    effectiveSelectedClipIds.length > 1
                        ? `已选 ${effectiveSelectedClipIds.length} 段`
                        : selectedClip ? `选中 ${formatSeconds(selectedClipDurationSeconds)}` : null
                }
                layerLabel={
                    selectedSceneItemId
                        ? `${selectedSceneItemHidden ? '隐藏' : '显示'} · ${selectedSceneItemLocked ? '锁定' : '可编辑'}${selectedSceneItemGrouped ? ' · 组内' : ''}`
                        : null
                }
                activeTrackLabel={
                    activeTrackSummary
                        ? `${activeTrackSummary.title} · ${activeTrackSummary.kindLabel} · ${activeTrackSummary.clipCount} 段 · ${formatSeconds(activeTrackSummary.totalDurationSeconds)}`
                        : null
                }
                cursorLabel={formatSeconds(effectiveCursorTime)}
                totalLabel={formatSeconds(totalDurationSeconds)}
                zoomPercent={zoomPercent}
                canUseTransport={canUseTransport}
                playing={isPlaying}
                currentTimeLabel={formatSeconds(boundedFrame / safeFps)}
                totalTimeLabel={formatSeconds(effectiveDurationInFrames / safeFps)}
                boundedFrame={boundedFrame}
                maxFrame={Math.max(1, effectiveDurationInFrames - 1)}
                stepFramesPerSecond={safeFps}
                onSeekFrame={onSeekFrame}
                onStepFrame={onStepFrame}
                onTogglePlayback={onTogglePlayback}
                onZoomOut={zoomOutTimeline}
                onZoomReset={zoomResetTimeline}
                onZoomFit={fitZoomToTimeline}
                onZoomIn={zoomInTimeline}
                onFocusCursor={focusOnCursor}
                onFocusSelection={focusOnSelectedClip}
                onJumpSelectionStart={() => jumpToSelectedClipEdge('start')}
                onJumpSelectionEnd={() => jumpToSelectedClipEdge('end')}
                onAddVideoTrack={() => handleAddTrack('video')}
                onAddAudioTrack={() => handleAddTrack('audio')}
                onAddSubtitleTrack={() => handleAddTrack('subtitle')}
                onMoveSelectionToPrevTrack={() => moveSelectedClipToAdjacentTrack('up')}
                onMoveSelectionToNextTrack={() => moveSelectedClipToAdjacentTrack('down')}
                onMoveTrackUp={() => {
                    if (activeTrackId) {
                        void handleMoveTrack(activeTrackId, 'up');
                    }
                }}
                onMoveTrackDown={() => {
                    if (activeTrackId) {
                        void handleMoveTrack(activeTrackId, 'down');
                    }
                }}
                onDeleteTrack={() => {
                    if (activeTrackId) {
                        void handleDeleteTrack(activeTrackId);
                    }
                }}
                onToggleTrackVisibility={() => toggleTrackHidden(activeTrackId)}
                onToggleTrackLock={() => toggleTrackLock(activeTrackId)}
                onToggleTrackMute={() => toggleTrackMuted(activeTrackId)}
                onToggleLayerVisibility={() => {
                    if (selectedSceneItemId) {
                        onToggleSceneItemVisibility?.(selectedSceneItemId);
                    }
                }}
                onToggleLayerLock={() => {
                    if (selectedSceneItemId) {
                        onToggleSceneItemLock?.(selectedSceneItemId);
                    }
                }}
                onBringLayerFront={() => {
                    if (selectedSceneItemId) {
                        onMoveSceneItemsToEdge?.([selectedSceneItemId], 'front');
                    }
                }}
                onSendLayerBack={() => {
                    if (selectedSceneItemId) {
                        onMoveSceneItemsToEdge?.([selectedSceneItemId], 'back');
                    }
                }}
                onSplit={handleSplitSelectedClip}
                onDelete={handleDeleteSelectedClip}
                onToggleClipEnabled={handleToggleSelectedClip}
                splitDisabled={!selectedClipId || effectiveSelectedClipIds.length > 1 || activeTrackLocked}
                deleteDisabled={effectiveSelectedClipIds.length === 0 || activeTrackLocked}
                toggleDisabled={!selectedClipId || effectiveSelectedClipIds.length > 1 || activeTrackLocked}
                toggleLabel={selectedClip?.enabled === false ? '启用片段' : '禁用片段'}
                layerVisibilityDisabled={!selectedSceneItemId}
                layerVisibilityLabel={selectedSceneItemHidden ? '显示当前图层' : '隐藏当前图层'}
                layerLockDisabled={!selectedSceneItemId}
                layerLockLabel={selectedSceneItemLocked ? '解锁当前图层' : '锁定当前图层'}
                layerOrderDisabled={!selectedSceneItemId}
                selectionNavDisabled={!selectedClipAction}
                moveSelectionTrackDisabled={!selectedClipAction || effectiveSelectedClipIds.length > 1 || !selectedTrackId}
                moveTrackDisabled={!activeTrackSummary || isPersisting}
                deleteTrackDisabled={!activeTrackSummary || !canDeleteTrack(activeTrackSummary.id) || isPersisting}
                trackVisibilityDisabled={!activeTrackSummary}
                trackVisibilityLabel={activeTrackSummary?.hidden ? '显示轨道' : '隐藏轨道'}
                trackLockDisabled={!activeTrackSummary}
                trackLockLabel={activeTrackLocked ? '解锁轨道' : '锁定轨道'}
                trackMuteDisabled={!activeTrackSummary || activeTrackSummary.kind !== 'audio'}
                trackMuteLabel={activeTrackSummary?.muted ? '取消静音轨道' : '静音轨道'}
            />
            <TimelineRuler
                viewportWidth={viewportWidth}
                contentWidth={timelineContentWidth}
                scrollLeft={scrollLeft}
                scaleWidth={scaleWidth}
                startLeft={START_LEFT}
                cursorTime={effectiveCursorTime}
                onSeekTime={seekToTime}
                onScrollLeftChange={(nextLeft) => {
                    syncTimelineScrollLeft(nextLeft);
                }}
                onWheel={handleTimelineWheel}
            />
            <div
                ref={bodyRef}
                className={clsx('redbox-editable-timeline__body', isDraggingAsset && 'redbox-editable-timeline__body--dragging')}
                onWheel={handleTimelineWheel}
                onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingAsset(true);
                    emitTimelineDragState(true);
                    if (!bodyRef.current || editorRows.length === 0) {
                        setDropIndicator(null);
                        setDragPreview(null);
                        return;
                    }
                    const rect = bodyRef.current.getBoundingClientRect();
                    const assetPayload = parseAssetPayloadFromDataTransfer(event.dataTransfer);
                    setDraggingAssetKind(assetPayload?.kind || null);
                    const relativeY = event.clientY - rect.top + scrollTop;
                    const hoveredTrack = findTrackSummaryAtRelativeY(relativeY, false);
                    const hoveredRow = hoveredTrack ? editorRows.find((row) => row.id === hoveredTrack.id) || null : null;
                    const assetTrackKind = assetKindToTrackKind(assetPayload?.kind);
                    const virtualPlacement = resolveVirtualTrackPlacement(relativeY, assetTrackKind);
                    const targetTrackId = virtualPlacement.shouldCreateTrack
                        ? null
                        : assetPayload
                            ? findCompatibleTrackId(assetTrackKind, {
                                preferredTrackId: hoveredRow && !lockedTrackIds.includes(hoveredRow.id) ? hoveredRow.id : null,
                            })
                            : hoveredRow?.id || null;
                    const targetRow = targetTrackId
                        ? editorRows.find((row) => row.id === targetTrackId) || hoveredRow
                        : null;
                    if (targetRow && lockedTrackIds.includes(targetRow.id)) {
                        setDropIndicator(null);
                        setDragPreview(null);
                        return;
                    }
                    if (!targetRow && !virtualPlacement.shouldCreateTrack) {
                        setDropIndicator(null);
                        setDragPreview(null);
                        return;
                    }
                    const relativeX = Math.max(0, event.clientX - rect.left - START_LEFT);
                    const baseNextTime = Math.max(0, (relativeX + scrollLeft) / scaleWidth);
                    const sortedActions = targetRow ? [...targetRow.actions].sort((a, b) => a.start - b.start) : [];
                    const snapCandidates = [
                        0,
                        effectiveCursorTime,
                        ...sortedActions.flatMap((action) => [Number(action.start || 0), Number(action.end || 0)]),
                    ];
                    const snappedDrop = snapTimeToCandidates(
                        baseNextTime,
                        snapCandidates,
                        Math.max(TIMELINE_SNAP_SECONDS * 0.5, 10 / Math.max(1, scaleWidth))
                    );
                    const nextTime = snappedDrop.time;
                    let splitTarget = false;
                    for (let index = 0; index < sortedActions.length; index += 1) {
                        if (nextTime > sortedActions[index].start && nextTime < sortedActions[index].end) {
                            splitTarget = true;
                            break;
                        }
                    }
                    const indicatorX = Math.min(
                        Math.max(START_LEFT, START_LEFT + nextTime * scaleWidth - scrollLeft),
                        Math.max(START_LEFT, viewportWidth - 14)
                    );
                    const indicatorTrackLabel = virtualPlacement.shouldCreateTrack
                        ? `新建 ${TRACK_DEFINITIONS[assetTrackKind].title}`
                        : targetRow
                            ? `${targetRow.id} · ${TRACK_DEFINITIONS[trackIdToKind(targetRow.id)].kindLabel}`
                            : null;
                    setDropIndicator({
                        x: indicatorX,
                        time: nextTime,
                        rowId: targetRow?.id || `__create__:${assetTrackKind}`,
                        rowLabel: indicatorTrackLabel || '新建轨道',
                        splitTarget,
                        snapLabel: snappedDrop.snapped
                            ? (snappedDrop.candidate === effectiveCursorTime ? '吸附游标' : '吸附边界')
                            : null,
                    });
                    if (assetPayload) {
                        const previewDurationMs = assetPayload.durationMs
                            ?? (assetPayload.kind === 'image' ? DEFAULT_IMAGE_CLIP_MS : DEFAULT_CLIP_MS);
                        const previewWidth = Math.max(28, (previewDurationMs / 1000) * scaleWidth);
                        const targetTrackSummary = targetRow
                            ? trackSummaries.find((track) => track.id === targetRow.id) || null
                            : null;
                        const previewTop = virtualPlacement.shouldCreateTrack
                            ? virtualPlacement.virtualTop - scrollTop + 4
                            : (targetTrackSummary?.top ?? hoveredTrack?.top ?? 0) - scrollTop + 4;
                        setDragPreview({
                            x: indicatorX + 2,
                            y: previewTop,
                            width: previewWidth,
                            height: virtualPlacement.shouldCreateTrack
                                ? Math.max(32, virtualPlacement.virtualHeight - 8)
                                : Math.max(32, ((targetRow?.rowHeight) || TIMELINE_ROW_HEIGHT) - 8),
                            kind: assetPayload.kind,
                            title: assetPayload.title,
                            durationLabel: formatSeconds(previewDurationMs / 1000),
                        });
                    } else {
                        setDragPreview(null);
                    }
                }}
                onDragEnter={(event) => {
                    event.preventDefault();
                    setIsDraggingAsset(true);
                    const assetPayload = parseAssetPayloadFromDataTransfer(event.dataTransfer);
                    setDraggingAssetKind(assetPayload?.kind || null);
                    emitTimelineDragState(true);
                }}
                onDragLeave={(event) => {
                    if (!bodyRef.current?.contains(event.relatedTarget as Node | null)) {
                        setIsDraggingAsset(false);
                        setDraggingAssetKind(null);
                        setDropIndicator(null);
                        setDragPreview(null);
                        emitTimelineDragState(false);
                    }
                }}
                onDrop={handleAssetDrop}
            >
                {selectedTrackSummaries.length > 0 ? (
                    <div className="redbox-editable-timeline__track-selection-bar">
                        <div className="redbox-editable-timeline__track-selection-meta">
                            <span>轨道管理</span>
                            <span>{selectedTrackBatchLabel}</span>
                        </div>
                        <div className="redbox-editable-timeline__track-selection-actions">
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button"
                                onClick={() => handleBatchTrackUi(effectiveSelectedTrackIds, (current) => ({ ...current, collapsed: !current.collapsed }))}
                            >
                                折叠/展开
                            </button>
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button"
                                onClick={() => handleBatchTrackUi(effectiveSelectedTrackIds, (current) => ({ ...current, hidden: !current.hidden }))}
                            >
                                隐藏/显示
                            </button>
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button"
                                onClick={() => handleBatchTrackUi(effectiveSelectedTrackIds, (current) => ({ ...current, locked: !current.locked }))}
                            >
                                锁定/解锁
                            </button>
                            {allSelectedTracksAudio ? (
                                <>
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__track-selection-button"
                                        onClick={() => handleBatchTrackUi(effectiveSelectedTrackIds, (current) => ({ ...current, muted: !current.muted }))}
                                    >
                                        静音/取消
                                    </button>
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__track-selection-button"
                                        onClick={() => handleBatchTrackUi(effectiveSelectedTrackIds, (current) => ({ ...current, solo: !current.solo }))}
                                    >
                                        独奏/取消
                                    </button>
                                </>
                            ) : null}
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button"
                                onClick={() => {
                                    void handleMoveTracks(effectiveSelectedTrackIds, 'up');
                                }}
                            >
                                整体上移
                            </button>
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button"
                                onClick={() => {
                                    void handleMoveTracks(effectiveSelectedTrackIds, 'down');
                                }}
                            >
                                整体下移
                            </button>
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button"
                                onClick={() => {
                                    void handleClearTracks(effectiveSelectedTrackIds);
                                }}
                            >
                                清空内容
                            </button>
                            {selectedTrackSummaries.length === 1 ? (
                                <>
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__track-selection-button"
                                        onClick={() => {
                                            void handleInsertTrackAdjacent(selectedTrackSummaries[0].id, 'up');
                                        }}
                                    >
                                        上方插入
                                    </button>
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__track-selection-button"
                                        onClick={() => {
                                            void handleInsertTrackAdjacent(selectedTrackSummaries[0].id, 'down');
                                        }}
                                    >
                                        下方插入
                                    </button>
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__track-selection-button"
                                        onClick={() => {
                                            void handleDuplicateTrack(selectedTrackSummaries[0].id);
                                        }}
                                    >
                                        复制轨道
                                    </button>
                                </>
                            ) : null}
                            <button
                                type="button"
                                className="redbox-editable-timeline__track-selection-button redbox-editable-timeline__track-selection-button--danger"
                                onClick={() => {
                                    void handleDeleteTracks(effectiveSelectedTrackIds);
                                }}
                                disabled={!canDeleteTrackSet(effectiveSelectedTrackIds)}
                            >
                                删除轨道
                            </button>
                        </div>
                    </div>
                ) : null}
                <div className="redbox-editable-timeline__track-rail">
                    {trackSummaries.map((track) => {
                        const isSelectedTrack = activeTrackId === track.id;
                        const isDropTrack = dropIndicator?.rowId === track.id;
                        const TrackIcon = trackKindIcon(track.kind);
                        const isTrackDragging = trackReorder?.trackId === track.id;
                        return (
                            <div
                                key={track.id}
                                className={clsx(
                                    'redbox-editable-timeline__track-pill',
                                    `redbox-editable-timeline__track-pill--${track.kind}`,
                                    (isSelectedTrack || selectedTrackIdSet.has(track.id)) && 'redbox-editable-timeline__track-pill--selected',
                                    isTrackDragging && 'redbox-editable-timeline__track-pill--reordering',
                                    track.locked && 'redbox-editable-timeline__track-pill--locked',
                                    track.hidden && 'redbox-editable-timeline__track-pill--hidden',
                                    track.collapsed && 'redbox-editable-timeline__track-pill--collapsed',
                                    track.muted && 'redbox-editable-timeline__track-pill--muted',
                                    track.solo && 'redbox-editable-timeline__track-pill--solo',
                                    isDropTrack && 'redbox-editable-timeline__track-pill--drop',
                                    isDraggingAsset && draggingAssetKind && trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-pill--accepting',
                                    isDraggingAsset && draggingAssetKind && !trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-pill--blocked'
                                )}
                                style={{
                                    top: track.top - scrollTop + 3,
                                    height: Math.max(26, track.height - 6),
                                }}
                                onClick={(event) => {
                                    focusTrack(track.id, {
                                        clearClipSelection: true,
                                        selectTrack: true,
                                        additive: event.metaKey || event.ctrlKey || event.shiftKey,
                                    });
                                }}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    setContextMenu(null);
                                    const targetTrackIds = selectedTrackIdSet.has(track.id)
                                        ? effectiveSelectedTrackIds
                                        : [track.id];
                                    applyTrackSelectionState(targetTrackIds, track.id);
                                    setTrackContextMenu({
                                        x: event.clientX,
                                        y: event.clientY,
                                        trackIds: targetTrackIds,
                                    });
                                    focusTrack(track.id, { clearClipSelection: true, selectTrack: true });
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        focusTrack(track.id, { clearClipSelection: true, selectTrack: true });
                                    }
                                }}
                                role="button"
                                tabIndex={0}
                            >
                                <div className="redbox-editable-timeline__track-title-row">
                                    <div className="redbox-editable-timeline__track-title">
                                        <TrackIcon size={10} />
                                        <span>{track.title}</span>
                                    </div>
                                    <div className="redbox-editable-timeline__track-actions">
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleTrackHidden(track.id);
                                            }}
                                            disabled={isPersisting}
                                            title={track.hidden ? '显示轨道内容' : '隐藏轨道内容'}
                                        >
                                            {track.hidden ? <EyeOff size={10} /> : <Eye size={10} />}
                                        </button>
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleTrackCollapsed(track.id);
                                            }}
                                            disabled={isPersisting}
                                            title={track.collapsed ? '展开轨道' : '折叠轨道'}
                                        >
                                            <Rows size={10} />
                                        </button>
                                        {track.kind === 'audio' ? (
                                            <button
                                                type="button"
                                                className="redbox-editable-timeline__track-action"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    toggleTrackMuted(track.id);
                                                }}
                                                disabled={isPersisting}
                                                title={track.muted ? '取消静音轨道' : '静音轨道'}
                                            >
                                                {track.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                                            </button>
                                        ) : null}
                                        {track.kind === 'audio' ? (
                                            <button
                                                type="button"
                                                className="redbox-editable-timeline__track-action"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    toggleTrackSolo(track.id);
                                                }}
                                                disabled={isPersisting}
                                                title={track.solo ? '取消独奏轨道' : '独奏轨道'}
                                            >
                                                <span className="redbox-editable-timeline__track-action-glyph">S</span>
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleTrackLock(track.id);
                                            }}
                                            disabled={isPersisting}
                                            title={track.locked ? '解锁轨道' : '锁定轨道'}
                                        >
                                            {track.locked ? <Unlock size={10} /> : <Lock size={10} />}
                                        </button>
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setTrackContextMenu({
                                                    x: event.clientX,
                                                    y: event.clientY,
                                                    trackIds: selectedTrackIdSet.has(track.id) ? effectiveSelectedTrackIds : [track.id],
                                                });
                                            }}
                                            disabled={isPersisting}
                                            title="更多轨道操作"
                                        >
                                            <MoreHorizontal size={10} />
                                        </button>
                                    </div>
                                </div>
                                <div className="redbox-editable-timeline__track-meta">
                                    <span className="redbox-editable-timeline__track-meta-brief">{track.clipCount} 段</span>
                                    <span className="redbox-editable-timeline__track-meta-brief">{formatSeconds(track.totalDurationSeconds)}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="redbox-editable-timeline__canvas-overlay">
                    {trackSummaries.map((track) => (
                        <button
                            key={`track-hit-${track.id}`}
                            type="button"
                                className={clsx(
                                'redbox-editable-timeline__track-hit',
                                `redbox-editable-timeline__track-hit--${track.kind}`,
                                activeTrackId === track.id && 'redbox-editable-timeline__track-hit--selected',
                                track.locked && 'redbox-editable-timeline__track-hit--locked',
                                track.hidden && 'redbox-editable-timeline__track-hit--hidden',
                                isDraggingAsset && draggingAssetKind && trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-hit--accepting',
                                isDraggingAsset && draggingAssetKind && !trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-hit--blocked'
                            )}
                            style={{
                                left: START_LEFT,
                                top: track.top - scrollTop,
                                height: track.height,
                            }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    focusTrack(track.id, {
                                        clearClipSelection: true,
                                        selectTrack: true,
                                        additive: event.metaKey || event.ctrlKey || event.shiftKey,
                                    });
                                }}
                            />
                    ))}
                    {trackSummaries
                        .filter((track) => track.clipCount === 0 && !track.hidden)
                        .map((track) => (
                            <div
                                key={`empty-track-${track.id}`}
                                className="redbox-editable-timeline__empty-track"
                                style={{
                                    left: START_LEFT + 14,
                                    right: 16,
                                    top: track.top - scrollTop + 6,
                                    height: Math.max(24, track.height - 12),
                                }}
                                onClick={() => {
                                    focusTrack(track.id, { clearClipSelection: true, selectTrack: true });
                                }}
                            >
                                <div className={clsx(
                                    'redbox-editable-timeline__empty-track-chip',
                                    `redbox-editable-timeline__empty-track-chip--${track.kind}`,
                                    track.locked && 'redbox-editable-timeline__empty-track-chip--locked',
                                    isDraggingAsset && draggingAssetKind && trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__empty-track-chip--accepting',
                                    isDraggingAsset && draggingAssetKind && !trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__empty-track-chip--blocked'
                                )}>
                                    {track.kind === 'audio' ? <AudioLines size={12} /> : track.kind === 'subtitle' ? <Type size={12} /> : <Clapperboard size={12} />}
                                    <span>{track.emptyLabel}</span>
                                </div>
                            </div>
                        ))}
                    {dragPreview ? (
                        <div
                            className="redbox-editable-timeline__canvas-clip redbox-editable-timeline__canvas-clip--preview"
                            style={{
                                left: dragPreview.x,
                                width: dragPreview.width,
                                top: dragPreview.y,
                                height: dragPreview.height,
                            }}
                        >
                            <div
                                className={clsx(
                                    'redbox-editable-timeline__clip',
                                    'redbox-editable-timeline__clip--preview',
                                    'redbox-editable-timeline__clip--compact',
                                    dragPreview.kind === 'audio' && 'redbox-editable-timeline__clip--audio',
                                    dragPreview.kind === 'video' && 'redbox-editable-timeline__clip--video',
                                    dragPreview.kind === 'image' && 'redbox-editable-timeline__clip--image',
                                )}
                            >
                                <div className="redbox-editable-timeline__clip-video-tag">
                                    {dragPreview.kind === 'audio' ? '音频' : dragPreview.kind === 'image' ? '图片' : '视频'}
                                </div>
                                <div className="redbox-editable-timeline__clip-overlay" />
                                <div className="redbox-editable-timeline__clip-title">{dragPreview.title}</div>
                                <div className="redbox-editable-timeline__clip-meta">
                                    <span>即将插入</span>
                                    <span>{dragPreview.durationLabel}</span>
                                </div>
                            </div>
                        </div>
                    ) : null}
                    {visualClips.map(({ trackId, clipId, left, width, top, height, selected, action, clip }) => {
                        const visibleDurationSeconds = Math.max(0.1, Number(action.end || 0) - Number(action.start || 0));
                        const kind = String(clip?.assetKind || '').trim().toLowerCase();
                        const visualKind = clipToVisualKind(clip);
                        const assetUrl = clip ? assetSourceUrl(clip) : '';
                        const mimeType = clip ? assetMimeType(clip) : '';
                        const typeLabel = visualKind === 'audio'
                            ? '音频'
                            : kind === 'text'
                                ? '文本'
                                : visualKind === 'subtitle'
                                    ? '字幕'
                                    : kind === 'image'
                                        ? '图片'
                                        : '视频';
                        const isCompactClip = width < 132;
                        const isTinyClip = width < 88;
                        const showTitle = width >= 96;
                        const showMeta = width >= 136;
                        const transitionStyle = (clip?.transitionStyle && typeof clip.transitionStyle === 'object' ? clip.transitionStyle as Record<string, unknown> : {}) || {};
                        const subtitleStyle = (clip?.subtitleStyle && typeof clip.subtitleStyle === 'object' ? clip.subtitleStyle as Record<string, unknown> : {}) || {};
                        const textStyle = (clip?.textStyle && typeof clip.textStyle === 'object' ? clip.textStyle as Record<string, unknown> : {}) || {};
                        const transitionPreset = resolveTransitionPreset(String(transitionStyle.presetId || '').trim() || undefined);
                        const transitionKind = String(transitionStyle.kind || transitionPreset.kind || '').trim();
                        const transitionDirection = String(transitionStyle.direction || transitionPreset.direction || '').trim();
                        const transitionDurationMs = Math.max(0, Number(transitionStyle.durationMs ?? transitionPreset.durationMs ?? 0));
                        const transitionLabel = transitionPreset.id !== 'none'
                            ? transitionPreset.label
                            : (transitionKind && transitionKind !== 'none' ? transitionKind : '');
                        const clipPixelsPerSecond = width / Math.max(0.1, visibleDurationSeconds);
                        const transitionSeriesWidth = transitionLabel
                            ? Math.max(16, Math.min(width * 0.42, (transitionDurationMs / 1000) * clipPixelsPerSecond + 14))
                            : 0;
                        const subtitlePresetLabel = String(subtitleStyle.presetId || '').trim();
                        const textPresetLabel = String(textStyle.presetId || '').trim();
                        const resolvedSubtitlePreset = resolveSubtitlePreset(subtitlePresetLabel || undefined);
                        const resolvedTextPreset = resolveTextPreset(textPresetLabel || undefined);
                        const clipSummaryText = summarizeClipText(clip?.name);
                        const subtitleAnimationLabel = String(subtitleStyle.animation || resolvedSubtitlePreset.animation || '').trim();
                        const textAnimationLabel = String(textStyle.animation || resolvedTextPreset.animation || '').trim();
                        const subtitleEmphasisCount = Array.isArray(subtitleStyle.emphasisWords) ? subtitleStyle.emphasisWords.length : 0;
                        const subtitleTokens = visualKind === 'subtitle' ? clipCaptionTokens(clip?.name) : [];
                        const subtitleTokenCount = subtitleTokens.length;
                        const subtitleSegmentationMode = String(subtitleStyle.segmentationMode || 'punctuationOrPause') as 'punctuationOrPause' | 'time' | 'singleWord';
                        const subtitleLinesPerCaption = Math.max(1, Number(subtitleStyle.linesPerCaption || 1));
                        const subtitleSegments = visualKind === 'subtitle'
                            ? buildCaptionSegments(subtitleTokens, subtitleSegmentationMode, subtitleLinesPerCaption, visibleDurationSeconds)
                            : [];
                        const subtitleSegmentCount = subtitleSegments.length;
                        const emphasizedSegmentCount = subtitleSegmentCount > 0
                            ? Math.max(0, Math.min(subtitleSegmentCount, Math.round((subtitleEmphasisCount / Math.max(1, subtitleTokenCount)) * subtitleSegmentCount)))
                            : 0;
                        const sceneItemId = sceneItemIdForClip(clip);
                        const sceneHidden = sceneItemId ? sceneItemVisibility[sceneItemId] === false : false;
                        const sceneLocked = sceneItemId ? !!sceneItemLocks[sceneItemId] : false;
                        const sceneGrouped = sceneItemId ? !!sceneItemGroups[sceneItemId] : false;
                        const stripFrameCount = buildClipStripFrameCount(width);
                        const stripCacheKey = `${clipId}:${stripFrameCount}:${Math.round(normalizeNumber(clip?.trimInMs, 0))}:${Math.round(visibleDurationSeconds * 1000)}`;
                        const generatedFrames = videoStripFrames[stripCacheKey] || [];
                        const showContentCard = (visualKind === 'subtitle' || kind === 'text') && width >= 168 && (selected || width >= 236);
                        const showRichContentCard = selected || width >= 296;
                        return (
                            <div
                                key={clipId}
                                className="redbox-editable-timeline__canvas-clip"
                                style={{
                                    left,
                                    width,
                                    top,
                                    height,
                                }}
                            >
                                {transitionLabel && transitionLabel !== 'none' ? (
                                    <div
                                        className="redbox-editable-timeline__clip-transition-series"
                                        style={{
                                            width: transitionSeriesWidth,
                                            background: transitionPreset.preview,
                                            borderColor: `${transitionPreset.accent}55`,
                                        }}
                                    >
                                        <div
                                            className="redbox-editable-timeline__clip-transition-series-glow"
                                            style={{ background: `linear-gradient(90deg, ${transitionPreset.accent}bb, transparent)` }}
                                        />
                                    </div>
                                ) : null}
                                <div
                                    className={clsx(
                                        'redbox-editable-timeline__clip',
                                        visualKind === 'audio' && 'redbox-editable-timeline__clip--audio',
                                        visualKind === 'video' && 'redbox-editable-timeline__clip--video',
                                        kind === 'image' && 'redbox-editable-timeline__clip--image',
                                        kind === 'text' && 'redbox-editable-timeline__clip--text',
                                        visualKind === 'subtitle' && 'redbox-editable-timeline__clip--subtitle',
                                        isCompactClip && 'redbox-editable-timeline__clip--compact',
                                        selected && 'redbox-editable-timeline__clip--selected',
                                        clipInteraction?.clipId === clipId && 'redbox-editable-timeline__clip--dragging'
                                    )}
                                    onPointerDown={(event) => beginClipInteraction(event, 'move', trackId, action)}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        const additive = event.metaKey || event.ctrlKey || event.shiftKey;
                                        if (additive) {
                                            const nextIds = selectedClipIdSet.has(clipId)
                                                ? effectiveSelectedClipIds.filter((id) => id !== clipId)
                                                : [...effectiveSelectedClipIds, clipId];
                                            applySelectionState(nextIds, clipId);
                                        } else {
                                            applySelectionState([clipId], clipId);
                                        }
                                        setContextMenu(null);
                                    }}
                                >
                                    <div className="redbox-editable-timeline__clip-strip">
                                        {kind === 'audio' ? (
                                            Array.from({ length: Math.max(10, Math.floor(width / 6)) }).map((_, index) => (
                                                <span
                                                    key={`${clipId}-wave-${index}`}
                                                    className="redbox-editable-timeline__clip-wave"
                                                    style={{
                                                        height: `${35 + ((index * 17) % 45)}%`,
                                                    }}
                                                />
                                            ))
                                        ) : assetUrl && (kind === 'image' || mimeType.startsWith('image/')) ? (
                                            Array.from({ length: stripFrameCount }).map((_, index) => (
                                                <img
                                                    key={`${clipId}-frame-${index}`}
                                                    src={assetUrl}
                                                    alt=""
                                                    className="redbox-editable-timeline__clip-frame"
                                                    draggable={false}
                                                />
                                            ))
                                        ) : assetUrl && kind === 'video' && generatedFrames.length > 0 ? (
                                            generatedFrames.map((frameUrl, index) => (
                                                <img
                                                    key={`${clipId}-video-frame-${index}`}
                                                    src={frameUrl}
                                                    alt=""
                                                    className="redbox-editable-timeline__clip-frame"
                                                    draggable={false}
                                                />
                                            ))
                                        ) : (
                                            Array.from({ length: stripFrameCount }).map((_, index) => (
                                                <div
                                                    key={`${clipId}-placeholder-${index}`}
                                                    className="redbox-editable-timeline__clip-frame redbox-editable-timeline__clip-frame--placeholder"
                                                >
                                                    <span>{typeLabel}</span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                    <div className="redbox-editable-timeline__clip-video-tag">
                                        {visualKind === 'audio' ? <AudioLines size={11} /> : null}
                                        {visualKind === 'video' ? <Clapperboard size={11} /> : null}
                                        {visualKind === 'subtitle' ? <Type size={11} /> : null}
                                        {kind === 'image' ? <ImageIcon size={11} /> : null}
                                        <span>{assetUrl && visualKind === 'video' && !mimeType.startsWith('image/') ? '视频' : typeLabel}</span>
                                    </div>
                                    {transitionLabel && transitionLabel !== 'none' ? (
                                        <>
                                            <div
                                                className="redbox-editable-timeline__clip-transition-edge"
                                                style={{ background: `linear-gradient(180deg, ${transitionPreset.accent}, ${transitionPreset.accent}33)` }}
                                            />
                                            <div
                                                className="redbox-editable-timeline__clip-transition-pill"
                                                style={{
                                                    background: `linear-gradient(135deg, ${transitionPreset.accent}26, rgba(8, 47, 73, 0.82))`,
                                                    borderColor: `${transitionPreset.accent}4d`,
                                                }}
                                            >
                                            <span>{transitionLabel}</span>
                                            {transitionDurationMs > 0 ? <span>{transitionDurationMs}ms</span> : null}
                                            {transitionDirection ? <span>{transitionDirection.replace('from-', '')}</span> : null}
                                            </div>
                                        </>
                                    ) : null}
                                    {showContentCard ? (
                                        <div className="redbox-editable-timeline__clip-content-card">
                                            <div className="redbox-editable-timeline__clip-content-pills">
                                                <span className="redbox-editable-timeline__clip-content-pill">
                                                    {visualKind === 'subtitle' ? resolvedSubtitlePreset.label : resolvedTextPreset.label}
                                                </span>
                                                {(showRichContentCard || width >= 228) && (visualKind === 'subtitle' ? subtitleAnimationLabel : textAnimationLabel) ? (
                                                    <span className="redbox-editable-timeline__clip-content-pill redbox-editable-timeline__clip-content-pill--ghost">
                                                        {visualKind === 'subtitle' ? subtitleAnimationLabel : textAnimationLabel}
                                                    </span>
                                                ) : null}
                                                {showRichContentCard && visualKind === 'subtitle' && subtitleEmphasisCount > 0 ? (
                                                    <span className="redbox-editable-timeline__clip-content-pill redbox-editable-timeline__clip-content-pill--accent">
                                                        {subtitleEmphasisCount} 重点
                                                    </span>
                                                ) : null}
                                            </div>
                                            {(showRichContentCard || width >= 208) && clipSummaryText ? (
                                                <div className="redbox-editable-timeline__clip-content-text">{clipSummaryText}</div>
                                            ) : null}
                                            {showRichContentCard && (sceneHidden || sceneLocked || sceneGrouped) ? (
                                                <div className="redbox-editable-timeline__clip-content-pills">
                                                    {sceneHidden ? (
                                                        <span className="redbox-editable-timeline__clip-content-pill redbox-editable-timeline__clip-content-pill--ghost">
                                                            hidden
                                                        </span>
                                                    ) : null}
                                                    {sceneGrouped ? (
                                                        <span className="redbox-editable-timeline__clip-content-pill redbox-editable-timeline__clip-content-pill--group">
                                                            group
                                                        </span>
                                                    ) : null}
                                                    {sceneLocked ? (
                                                        <span className="redbox-editable-timeline__clip-content-pill redbox-editable-timeline__clip-content-pill--lock">
                                                            lock
                                                        </span>
                                                    ) : null}
                                                </div>
                                            ) : null}
                                            {showRichContentCard && visualKind === 'subtitle' && subtitleTokenCount > 0 ? (
                                                <div className="redbox-editable-timeline__clip-subtitle-rhythm">
                                                    <div className="redbox-editable-timeline__clip-subtitle-rhythm-bars">
                                                        {Array.from({ length: Math.min(Math.max(1, subtitleSegmentCount), 18) }).map((_, markerIndex) => (
                                                            <span
                                                                key={`${clipId}-subtitle-marker-${markerIndex}`}
                                                                className={clsx(
                                                                    'redbox-editable-timeline__clip-subtitle-rhythm-bar',
                                                                    markerIndex < emphasizedSegmentCount && 'redbox-editable-timeline__clip-subtitle-rhythm-bar--emphasis'
                                                                )}
                                                            />
                                                        ))}
                                                    </div>
                                                    <span className="redbox-editable-timeline__clip-subtitle-rhythm-label">
                                                        {subtitleSegmentCount || 1} 段
                                                    </span>
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}
                                    <div className="redbox-editable-timeline__clip-overlay" />
                                    {showTitle ? (
                                        <div className="redbox-editable-timeline__clip-title">
                                            {String(clip?.name || clipId || '片段')}
                                        </div>
                                    ) : null}
                                    {showMeta ? (
                                        <div className="redbox-editable-timeline__clip-meta">
                                            <span>{typeLabel}</span>
                                            <span>{formatSeconds(visibleDurationSeconds)}</span>
                                            {transitionLabel && transitionLabel !== 'none' ? <span>{transitionLabel}</span> : null}
                                            {subtitlePresetLabel ? <span>{subtitleSegmentationMode === 'singleWord' ? '逐词字幕' : subtitleSegmentationMode === 'time' ? '时间字幕' : '停顿字幕'}</span> : null}
                                            {textPresetLabel ? <span>文本预设</span> : null}
                                            {sceneHidden ? <span>已隐藏</span> : null}
                                            {sceneGrouped ? <span>组对象</span> : null}
                                            {sceneLocked ? <span>已锁定</span> : null}
                                            {action.disable ? <span>禁用</span> : null}
                                        </div>
                                    ) : isTinyClip ? null : (
                                        <div className="redbox-editable-timeline__clip-meta redbox-editable-timeline__clip-meta--minimal">
                                            <span>{formatSeconds(visibleDurationSeconds)}</span>
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__clip-handle redbox-editable-timeline__clip-handle--start"
                                        onPointerDown={(event) => beginClipInteraction(event, 'resize-start', trackId, action)}
                                        aria-label="调整片段入点"
                                    />
                                    <button
                                        type="button"
                                        className="redbox-editable-timeline__clip-handle redbox-editable-timeline__clip-handle--end"
                                        onPointerDown={(event) => beginClipInteraction(event, 'resize-end', trackId, action)}
                                        aria-label="调整片段时长"
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
                <TimelinePlayheadOverlay
                    left={playheadLeft}
                    onScrubToClientX={seekBodyCursorToClientX}
                />
                {interactionGuide ? (
                    <div className="redbox-editable-timeline__edit-guide">
                        <div
                            className="redbox-editable-timeline__edit-guide-line redbox-editable-timeline__edit-guide-line--start"
                            style={{
                                left: interactionGuide.left,
                                top: interactionGuide.top,
                                height: interactionGuide.height,
                            }}
                        />
                        <div
                            className="redbox-editable-timeline__edit-guide-line redbox-editable-timeline__edit-guide-line--end"
                            style={{
                                left: interactionGuide.right,
                                top: interactionGuide.top,
                                height: interactionGuide.height,
                            }}
                        />
                        <div
                            className="redbox-editable-timeline__edit-guide-chip"
                            style={{
                                left: Math.max(START_LEFT + 12, interactionGuide.left + 12),
                                top: Math.max(8, interactionGuide.top - 18),
                            }}
                        >
                            {interactionGuide.label}
                        </div>
                    </div>
                ) : null}
                {interactionSnapGuide ? (
                    <div className="redbox-editable-timeline__edit-guide redbox-editable-timeline__edit-guide--snap">
                        <div
                            className="redbox-editable-timeline__edit-guide-line redbox-editable-timeline__edit-guide-line--snap"
                            style={{
                                left: interactionSnapGuide.left,
                                top: interactionSnapGuide.top,
                                height: interactionSnapGuide.height,
                            }}
                        />
                        <div
                            className="redbox-editable-timeline__edit-guide-chip redbox-editable-timeline__edit-guide-chip--snap"
                            style={{
                                left: interactionSnapGuide.left,
                                top: Math.max(8, interactionSnapGuide.top - 18),
                            }}
                        >
                            {interactionSnapGuide.label}
                        </div>
                    </div>
                ) : null}
                {dropIndicator ? (
                    <div
                        className="redbox-editable-timeline__drop-indicator"
                        style={{ left: dropIndicator.x }}
                    >
                        <div className="redbox-editable-timeline__drop-chip">
                            <span>{dropIndicator.rowLabel}</span>
                            <span>{formatSeconds(dropIndicator.time)}</span>
                            {dropIndicator.snapLabel ? <span>{dropIndicator.snapLabel}</span> : null}
                            <span>{dropIndicator.splitTarget ? '切开插入' : '直接插入'}</span>
                        </div>
                        <div className="redbox-editable-timeline__drop-line" />
                    </div>
                ) : null}
                <Timeline
                    ref={timelineRef as any}
                    style={{ width: '100%', height: '100%' }}
                    editorData={editorRows as any}
                    effects={TIMELINE_EFFECTS as any}
                    scale={1}
                    scaleSplitCount={4}
                    scaleWidth={scaleWidth}
                    startLeft={START_LEFT}
                    rowHeight={TIMELINE_ROW_HEIGHT}
                    gridSnap={true}
                    dragLine={true}
                    hideCursor={true}
                    disableDrag={true}
                    enableRowDrag={false}
                    autoScroll={true}
                    onScroll={(params) => {
                        const nextScrollLeft = Number(params.scrollLeft || 0);
                        const nextScrollTop = Number(params.scrollTop || 0);
                        const nextMaxScrollTop = Math.max(
                            0,
                            Number(params.scrollHeight || 0) - Number(params.clientHeight || 0)
                        );
                        setScrollLeft((current) => (
                            Math.abs(current - nextScrollLeft) < SCROLL_LEFT_EPSILON ? current : nextScrollLeft
                        ));
                        setScrollTop((current) => (
                            Math.abs(current - nextScrollTop) < SCROLL_TOP_EPSILON ? current : nextScrollTop
                        ));
                        setMaxScrollTop((current) => (
                            Math.abs(current - nextMaxScrollTop) < SCROLL_TOP_EPSILON ? current : nextMaxScrollTop
                        ));
                    }}
                    onChange={(nextRows) => {
                        setEditorRows(cloneRows(nextRows as TimelineRowShape[]));
                    }}
                    onCursorDrag={(time) => {
                        if (isSyncingTimelineCursorRef.current) return;
                        commitCursorTime(Number(time || 0), { syncTimeline: false });
                    }}
                    onClickTimeArea={(time) => {
                        commitCursorTime(Number(time || 0), { syncTimeline: false });
                        return true;
                    }}
                    onClickRow={(_, param) => {
                        const nextTrackId = String(
                            (param as { row?: { id?: string } })?.row?.id
                            || (param as { row?: { rowId?: string } })?.row?.rowId
                            || ''
                        ).trim();
                        if (nextTrackId) {
                            focusTrack(nextTrackId, { clearClipSelection: true, selectTrack: true });
                        }
                        commitCursorTime(Number(param.time || 0), { syncTimeline: false });
                    }}
                    onClickActionOnly={(_, param) => {
                        const nextClipId = String(param.action?.id || '').trim() || null;
                        if (nextClipId) {
                            applySelectionState([nextClipId], nextClipId);
                        } else {
                            clearSelectionState();
                        }
                        commitCursorTime(Number(param.time || 0), { syncTimeline: false });
                    }}
                    onContextMenuAction={(event, param) => {
                        event.preventDefault();
                        const nextClipId = String(param.action?.id || '').trim();
                        if (!nextClipId) return;
                        applySelectionState([nextClipId], nextClipId);
                        commitCursorTime(Number(param.time || 0), { syncTimeline: false });
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            clipId: nextClipId,
                        });
                    }}
                    getScaleRender={(scale) => (
                        <div className="redbox-editable-timeline__scale-label">{formatSeconds(Number(scale || 0))}</div>
                    )}
                    getActionRender={() => null}
                />
                {normalizedClips.length === 0 ? (
                    <div className="redbox-editable-timeline__empty">
                        <div className="redbox-editable-timeline__empty-title">{emptyLabel}</div>
                        <div className="redbox-editable-timeline__empty-subtitle">把左侧素材直接拖到底部轨道里，就能开始基础剪辑。</div>
                        <div className="redbox-editable-timeline__empty-actions">
                            <button
                                type="button"
                                className="redbox-editable-timeline__empty-action"
                                onClick={() => void handleAddTrack('video')}
                            >
                                新建视频轨
                            </button>
                            <button
                                type="button"
                                className="redbox-editable-timeline__empty-action"
                                onClick={() => void handleAddTrack('audio')}
                            >
                                新建音频轨
                            </button>
                            <button
                                type="button"
                                className="redbox-editable-timeline__empty-action redbox-editable-timeline__empty-action--accent"
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('redbox-video-editor:request-import-assets'));
                                }}
                            >
                                导入素材并开始
                            </button>
                        </div>
                    </div>
                ) : null}
                {contextMenu ? (
                    <div
                        className="fixed z-[120] min-w-[140px] rounded-xl border border-white/10 bg-[#111111] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                        onMouseLeave={() => setContextMenu(null)}
                    >
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                setContextMenu(null);
                                void handleSplitClipAtCursor(contextMenu.clipId);
                            }}
                        >
                            剪切
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                setContextMenu(null);
                                void handleDeleteClipById(contextMenu.clipId);
                            }}
                        >
                            删除
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                setContextMenu(null);
                                applySelectionState([contextMenu.clipId], contextMenu.clipId);
                            }}
                        >
                            选中片段
                        </button>
                        {contextMenuSceneItemId ? (
                            <>
                                <div className="my-1 h-px bg-white/10" />
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        setContextMenu(null);
                                        onToggleSceneItemVisibility?.(contextMenuSceneItemId);
                                    }}
                                >
                                    {contextMenuSceneHidden ? '显示图层' : '隐藏图层'}
                                </button>
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        setContextMenu(null);
                                        onToggleSceneItemLock?.(contextMenuSceneItemId);
                                    }}
                                >
                                    {contextMenuSceneLocked ? '解锁图层' : '锁定图层'}
                                </button>
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        setContextMenu(null);
                                        onMoveSceneItemsToEdge?.([contextMenuSceneItemId], 'front');
                                    }}
                                >
                                    图层置前
                                </button>
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        setContextMenu(null);
                                        onMoveSceneItemsToEdge?.([contextMenuSceneItemId], 'back');
                                    }}
                                >
                                    图层置后
                                </button>
                            </>
                        ) : null}
                    </div>
                ) : null}
                {trackContextMenu ? (
                    <div
                        className="fixed z-[120] min-w-[170px] rounded-xl border border-white/10 bg-[#111111] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
                        style={{ left: trackContextMenu.x, top: trackContextMenu.y }}
                        onMouseLeave={() => setTrackContextMenu(null)}
                    >
                        {trackContextMenu.trackIds.length > 1 ? (
                            <div className="px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                                已选 {trackContextMenu.trackIds.length} 条轨道
                            </div>
                        ) : null}
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                handleBatchTrackUi(trackContextMenu.trackIds, (current) => ({ ...current, collapsed: !current.collapsed }));
                                setTrackContextMenu(null);
                            }}
                        >
                            折叠 / 展开轨道
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                handleBatchTrackUi(trackContextMenu.trackIds, (current) => ({ ...current, hidden: !current.hidden }));
                                setTrackContextMenu(null);
                            }}
                        >
                            隐藏 / 显示轨道
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                handleBatchTrackUi(trackContextMenu.trackIds, (current) => ({ ...current, locked: !current.locked }));
                                setTrackContextMenu(null);
                            }}
                        >
                            锁定 / 解锁轨道
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                void handleMoveTracks(trackContextMenu.trackIds, 'up');
                                setTrackContextMenu(null);
                            }}
                        >
                            选中轨整体上移
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                void handleMoveTracks(trackContextMenu.trackIds, 'down');
                                setTrackContextMenu(null);
                            }}
                        >
                            选中轨整体下移
                        </button>
                        {trackContextMenu.trackIds.every((trackId) => trackIdToKind(trackId) === 'audio') ? (
                            <>
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        handleBatchTrackUi(trackContextMenu.trackIds, (current) => ({ ...current, muted: !current.muted }));
                                        setTrackContextMenu(null);
                                    }}
                                >
                                    静音 / 取消静音
                                </button>
                                <button
                                    type="button"
                                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                                    onClick={() => {
                                        handleBatchTrackUi(trackContextMenu.trackIds, (current) => ({ ...current, solo: !current.solo }));
                                        setTrackContextMenu(null);
                                    }}
                                >
                                    独奏 / 取消独奏
                                </button>
                            </>
                        ) : null}
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                void handleClearTracks(trackContextMenu.trackIds);
                                setTrackContextMenu(null);
                            }}
                        >
                            清空轨道内容
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                if (trackContextMenu.trackIds.length === 1) {
                                    void handleDuplicateTrack(trackContextMenu.trackIds[0]);
                                }
                                setTrackContextMenu(null);
                            }}
                            disabled={trackContextMenu.trackIds.length !== 1}
                        >
                            复制整轨到下一条同类轨
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                if (trackContextMenu.trackIds.length === 1) {
                                    void handleInsertTrackAdjacent(trackContextMenu.trackIds[0], 'up');
                                }
                                setTrackContextMenu(null);
                            }}
                            disabled={trackContextMenu.trackIds.length !== 1}
                        >
                            在上方插入同类轨
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                if (trackContextMenu.trackIds.length === 1) {
                                    void handleInsertTrackAdjacent(trackContextMenu.trackIds[0], 'down');
                                }
                                setTrackContextMenu(null);
                            }}
                            disabled={trackContextMenu.trackIds.length !== 1}
                        >
                            在下方插入同类轨
                        </button>
                        <button
                            type="button"
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                            onClick={() => {
                                void handleDeleteTracks(trackContextMenu.trackIds);
                                setTrackContextMenu(null);
                            }}
                            disabled={!canDeleteTrackSet(trackContextMenu.trackIds)}
                        >
                            删除轨道
                        </button>
                    </div>
                ) : null}
            </div>
            <TimelineScrollbar
                scrollLeft={scrollLeft}
                maxScrollLeft={maxScrollLeft}
                onChange={(nextLeft) => {
                    syncTimelineScrollLeft(nextLeft);
                }}
            />
        </div>
    );
});
