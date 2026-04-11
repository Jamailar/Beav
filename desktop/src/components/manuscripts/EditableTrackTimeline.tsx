import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import clsx from 'clsx';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import { AudioLines, ChevronDown, ChevronUp, Clapperboard, ImageIcon, Trash2, Type } from 'lucide-react';
import { TimelinePlayheadOverlay } from './timeline/TimelinePlayheadOverlay';
import { TimelineRuler } from './timeline/TimelineRuler';
import { TimelineScrollbar } from './timeline/TimelineScrollbar';
import { TimelineToolbar } from './timeline/TimelineToolbar';
import { resolveAssetUrl } from '../../utils/pathManager';
import './editable-track-timeline.css';

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
    onCursorTimeChange?: (time: number) => void;
    onSelectedClipChange?: (clipId: string | null) => void;
    onActiveTrackChange?: (trackId: string | null) => void;
    onViewportMetricsChange?: (metrics: { scrollLeft: number; maxScrollLeft: number }) => void;
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
const START_LEFT = 144;
const TIMELINE_HEADER_HEIGHT = 40;
const TIMELINE_ROW_HEIGHT = 64;
const CURSOR_TIME_EPSILON = 0.01;
const SCROLL_LEFT_EPSILON = 0.5;
const TIMELINE_SNAP_SECONDS = 0.25;
const TIMELINE_WHEEL_SCROLL_STEP = 1;
const TIMELINE_WHEEL_ZOOM_STEP = 12;

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
            rowHeight: TIMELINE_ROW_HEIGHT,
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
    onCursorTimeChange,
    onSelectedClipChange,
    onActiveTrackChange,
    onViewportMetricsChange,
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
        () => buildTimelineRows(normalizedClips, fallbackTracks),
        [fallbackTracks, normalizedClips]
    );
    const externalSignature = useMemo(() => serializeRows(externalRows), [externalRows]);
    const [editorRows, setEditorRows] = useState<TimelineRowShape[]>(externalRows);
    const [isPersisting, setIsPersisting] = useState(false);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
    const [focusedTrackId, setFocusedTrackId] = useState<string | null>(null);
    const [internalCursorTime, setInternalCursorTime] = useState(0);
    const [scaleWidth, setScaleWidth] = useState(SCALE_WIDTH);
    const [viewportWidth, setViewportWidth] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [isDraggingAsset, setIsDraggingAsset] = useState(false);
    const [draggingAssetKind, setDraggingAssetKind] = useState<'video' | 'audio' | 'image' | 'default' | null>(null);
    const [dropIndicator, setDropIndicator] = useState<DropIndicatorState | null>(null);
    const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
    const [clipInteraction, setClipInteraction] = useState<ClipInteractionState | null>(null);
    const [interactionSnapGuide, setInteractionSnapGuide] = useState<InteractionSnapGuide | null>(null);
    const [videoStripFrames, setVideoStripFrames] = useState<Record<string, string[]>>({});
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        clipId: string;
    } | null>(null);
    const clipboardRef = useRef<TimelineClipboardItem[]>([]);
    const undoStackRef = useRef<TimelineSelectionSnapshot[]>([]);
    const redoStackRef = useRef<TimelineSelectionSnapshot[]>([]);
    const pendingHistorySnapshotRef = useRef<TimelineSelectionSnapshot | null>(null);

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
        rows: cloneRows(rows),
        selectedClipIds: [...ids],
        primaryClipId: primaryId,
    }), [editorRows, effectiveSelectedClipIds, selectedClipId]);

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
        if (!focusedTrackId) return;
        if (editorRows.some((row) => row.id === focusedTrackId)) return;
        setFocusedTrackId(null);
    }, [editorRows, focusedTrackId]);

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

    const activeTrackId = selectedTrackId || focusedTrackId;

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

    const focusTrack = useCallback((trackId: string | null, options?: { clearClipSelection?: boolean }) => {
        const nextTrackId = String(trackId || '').trim();
        if (!nextTrackId) return;
        if (!editorRows.some((row) => row.id === nextTrackId)) return;
        setFocusedTrackId(nextTrackId);
        if (options?.clearClipSelection) {
            clearSelectionState();
        }
        setContextMenu(null);
    }, [clearSelectionState, editorRows]);

    const findCompatibleTrackId = useCallback((
        kind: TrackKind,
        options?: { preferredTrackId?: string | null; fallbackTrackId?: string | null }
    ) => {
        const compatibleTrackIds = editorRows
            .map((row) => row.id)
            .filter((trackId) => trackIdToKind(trackId) === kind);
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
    }, [activeTrackId, editorRows]);

    const ensureTrackIdForKind = useCallback(async (
        kind: TrackKind,
        options?: { preferredTrackId?: string | null; fallbackTrackId?: string | null }
    ) => {
        const existingTrackId = findCompatibleTrackId(kind, options);
        if (existingTrackId) return existingTrackId;
        if (!filePath) return null;
        const result = await window.ipcRenderer.invoke('manuscripts:add-package-track', {
            filePath,
            kind,
        }) as { success?: boolean; state?: Record<string, unknown> };
        if (result?.success && result.state) {
            onPackageStateChange?.(result.state);
            const nextTrackNames = (
                (result.state as { timelineSummary?: { trackNames?: string[] } })?.timelineSummary?.trackNames || []
            )
                .map((item) => String(item || '').trim())
                .filter(Boolean);
            const createdTrackId = [...nextTrackNames]
                .reverse()
                .find((trackId) => trackIdToKind(trackId) === kind) || null;
            if (createdTrackId) {
                setFocusedTrackId(createdTrackId);
            }
            return createdTrackId;
        }
        return null;
    }, [filePath, findCompatibleTrackId, onPackageStateChange]);

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
        const timer = window.setTimeout(() => {
            void persistRows(editorRows);
        }, 220);
        return () => window.clearTimeout(timer);
    }, [clipInteraction, editorRows, externalSignature, persistRows]);

    const handleAddTrack = useCallback(async (kind: TrackKind) => {
        if (!filePath) return;
        captureUndoSnapshot();
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:add-package-track', {
                filePath,
                kind,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                const nextTrackNames = (
                    (result.state as { timelineSummary?: { trackNames?: string[] } })?.timelineSummary?.trackNames || []
                )
                    .map((item) => String(item || '').trim())
                    .filter(Boolean);
                const createdTrackId = [...nextTrackNames]
                    .reverse()
                    .find((trackId) => trackIdToKind(trackId) === kind) || null;
                if (createdTrackId) {
                    setFocusedTrackId(createdTrackId);
                }
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to add package track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [captureUndoSnapshot, filePath, onPackageStateChange]);

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

    const handleDeleteTrack = useCallback(async (trackId: string) => {
        if (!filePath || !trackId) return;
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete-package-track', {
                filePath,
                trackId,
            }) as { success?: boolean; state?: Record<string, unknown>; error?: string };
            if (result?.success && result.state) {
                if (focusedTrackId === trackId) {
                    setFocusedTrackId(null);
                }
                onPackageStateChange?.(result.state);
                return;
            }
            if (result?.error) {
                console.warn('Failed to delete package track:', result.error);
            }
        } catch (error) {
            console.error('Failed to delete package track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [filePath, focusedTrackId, onPackageStateChange]);

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

    const handleAssetDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
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
        const relativeY = event.clientY - rect.top - TIMELINE_HEADER_HEIGHT;
        const rowIndex = Math.max(0, Math.min(Math.floor(relativeY / TIMELINE_ROW_HEIGHT), Math.max(editorRows.length - 1, 0)));
        const hoveredRow = editorRows[rowIndex] || editorRows[0];
        const ensuredTrackId = await ensureTrackIdForKind(assetTrackKind, {
            preferredTrackId: hoveredRow?.id || null,
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

        const relativeX = Math.max(0, event.clientX - rect.left - START_LEFT);
        const dropTime = Math.max(0, (relativeX + scrollLeft) / scaleWidth);
        const sortedActions = targetRow
            ? [...targetRow.actions].sort((a, b) => a.start - b.start)
            : [];
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
    }, [captureUndoSnapshot, editorRows, ensureTrackIdForKind, filePath, onPackageStateChange, scaleWidth, scrollLeft]);

    const selectedClip = selectedClipId ? clipById.get(selectedClipId) : null;
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
            return {
                id: row.id,
                title: row.id,
                kindLabel: definition.kindLabel,
                emptyLabel: definition.emptyLabel,
                kind: visualKind,
                clipCount: row.actions.length,
                top,
                height,
                canMoveUp: index > 0,
                canMoveDown: index < editorRows.length - 1,
            };
        });
    }, [editorRows]);
    const visualClips = useMemo<TrackVisualClip[]>(() => {
        const trackMap = new Map(trackSummaries.map((track) => [track.id, track]));
        return editorRows.flatMap((row) => {
            const track = trackMap.get(row.id);
            if (!track) return [];
            return row.actions.map((action) => ({
                trackId: row.id,
                clipId: action.id,
                left: START_LEFT + Number(action.start || 0) * scaleWidth - scrollLeft,
                width: Math.max(24, (Number(action.end || 0) - Number(action.start || 0)) * scaleWidth),
                top: track.top + 4,
                height: Math.max(44, track.height - 8),
                selected: selectedClipIdSet.has(action.id),
                action,
                clip: clipById.get(String(action.id || '').trim()),
            }));
        });
    }, [clipById, editorRows, scaleWidth, scrollLeft, selectedClipIdSet, trackSummaries]);
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
    }, [applySelectionState, editorRows, snapshotSelectionState]);

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
                const relativeY = event.clientY - rect.top - TIMELINE_HEADER_HEIGHT;
                const rowIndex = Math.max(0, Math.min(Math.floor(relativeY / TIMELINE_ROW_HEIGHT), Math.max(editorRows.length - 1, 0)));
                const hoveredRow = editorRows[rowIndex] || null;
                if (hoveredRow && trackIdToKind(hoveredRow.id) === sourceTrackKind) {
                    targetRowId = hoveredRow.id;
                }
            }
            const guideTop = trackSummaries.find((track) => track.id === targetRowId)?.top ?? 0;
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
    }, [clipById, clipInteraction, effectiveCursorTime, editorRows, pushUndoSnapshot, scaleWidth, scrollLeft, trackSummaries, updateRowActions]);
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

        const primaryDelta = Math.abs(normalizedDeltaX) > Math.abs(normalizedDeltaY)
            ? normalizedDeltaX
            : normalizedDeltaY;
        if (Math.abs(primaryDelta) < TIMELINE_WHEEL_SCROLL_STEP && !event.shiftKey) {
            return;
        }

        event.preventDefault();
        const scrollDelta = event.shiftKey && Math.abs(normalizedDeltaX) < Math.abs(normalizedDeltaY)
            ? normalizedDeltaY
            : primaryDelta;
        syncTimelineScrollLeft(scrollLeft + scrollDelta);
    }, [scrollLeft, syncTimelineScrollLeft, viewportWidth, zoomInTimeline, zoomOutTimeline]);

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
        };
        update();
        const observer = new ResizeObserver(() => update());
        observer.observe(bodyRef.current);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        onViewportMetricsChange?.({
            scrollLeft,
            maxScrollLeft,
        });
    }, [maxScrollLeft, onViewportMetricsChange, scrollLeft]);

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
                onSplit={handleSplitSelectedClip}
                onDelete={handleDeleteSelectedClip}
                onToggleClipEnabled={handleToggleSelectedClip}
                splitDisabled={!selectedClipId || effectiveSelectedClipIds.length > 1}
                deleteDisabled={effectiveSelectedClipIds.length === 0}
                toggleDisabled={!selectedClipId || effectiveSelectedClipIds.length > 1}
                toggleLabel={selectedClip?.enabled === false ? '启用片段' : '禁用片段'}
                selectionNavDisabled={!selectedClipAction}
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
                    const relativeY = event.clientY - rect.top - TIMELINE_HEADER_HEIGHT;
                    const rowIndex = Math.max(0, Math.min(Math.floor(relativeY / TIMELINE_ROW_HEIGHT), Math.max(editorRows.length - 1, 0)));
                    const hoveredRow = editorRows[rowIndex] || editorRows[0];
                    const targetTrackId = assetPayload
                        ? findCompatibleTrackId(assetKindToTrackKind(assetPayload.kind), { preferredTrackId: hoveredRow?.id || null })
                        : hoveredRow?.id || null;
                    const targetRow = editorRows.find((row) => row.id === targetTrackId) || hoveredRow;
                    if (!targetRow) {
                        setDropIndicator(null);
                        setDragPreview(null);
                        return;
                    }
                    const relativeX = Math.max(0, event.clientX - rect.left - START_LEFT);
                    const baseNextTime = Math.max(0, (relativeX + scrollLeft) / scaleWidth);
                    const sortedActions = [...targetRow.actions].sort((a, b) => a.start - b.start);
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
                    setDropIndicator({
                        x: indicatorX,
                        time: nextTime,
                        rowId: targetRow.id,
                        rowLabel: `${targetRow.id} · ${TRACK_DEFINITIONS[trackIdToKind(targetRow.id)].kindLabel}`,
                        splitTarget,
                        snapLabel: snappedDrop.snapped
                            ? (snappedDrop.candidate === effectiveCursorTime ? '吸附游标' : '吸附边界')
                            : null,
                    });
                    if (assetPayload) {
                        const previewDurationMs = assetPayload.durationMs
                            ?? (assetPayload.kind === 'image' ? DEFAULT_IMAGE_CLIP_MS : DEFAULT_CLIP_MS);
                        const previewWidth = Math.max(28, (previewDurationMs / 1000) * scaleWidth);
                        setDragPreview({
                            x: indicatorX + 2,
                            y: targetRow.rowHeight
                                ? rowIndex * targetRow.rowHeight + 4
                                : rowIndex * TIMELINE_ROW_HEIGHT + 4,
                            width: previewWidth,
                            height: Math.max(44, (targetRow.rowHeight || TIMELINE_ROW_HEIGHT) - 8),
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
                <div className="redbox-editable-timeline__quick-add">
                    <button
                        type="button"
                        className="redbox-editable-timeline__quick-add-button"
                        onClick={() => void handleAddTrack('video')}
                    >
                        + 视频轨
                    </button>
                    <button
                        type="button"
                        className="redbox-editable-timeline__quick-add-button"
                        onClick={() => void handleAddTrack('audio')}
                    >
                        + 音频轨
                    </button>
                    <button
                        type="button"
                        className="redbox-editable-timeline__quick-add-button"
                        onClick={() => void handleAddTrack('subtitle')}
                    >
                        + 字幕轨
                    </button>
                </div>
                <div className="redbox-editable-timeline__track-rail">
                    {trackSummaries.map((track) => {
                        const isSelectedTrack = activeTrackId === track.id;
                        const isDropTrack = dropIndicator?.rowId === track.id;
                        return (
                            <div
                                key={track.id}
                                className={clsx(
                                    'redbox-editable-timeline__track-pill',
                                    `redbox-editable-timeline__track-pill--${track.kind}`,
                                    isSelectedTrack && 'redbox-editable-timeline__track-pill--selected',
                                    isDropTrack && 'redbox-editable-timeline__track-pill--drop',
                                    isDraggingAsset && draggingAssetKind && trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-pill--accepting',
                                    isDraggingAsset && draggingAssetKind && !trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-pill--blocked'
                                )}
                                style={{
                                    top: track.top + 8,
                                    height: Math.max(44, track.height - 16),
                                }}
                                onClick={() => {
                                    focusTrack(track.id, { clearClipSelection: true });
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        focusTrack(track.id, { clearClipSelection: true });
                                    }
                                }}
                                role="button"
                                tabIndex={0}
                            >
                                <div className="redbox-editable-timeline__track-title-row">
                                    <div className="redbox-editable-timeline__track-title">{track.title}</div>
                                    <div className="redbox-editable-timeline__track-actions">
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                void handleMoveTrack(track.id, 'up');
                                            }}
                                            disabled={!track.canMoveUp || isPersisting}
                                            title="轨道上移"
                                        >
                                            <ChevronUp size={11} />
                                        </button>
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                void handleMoveTrack(track.id, 'down');
                                            }}
                                            disabled={!track.canMoveDown || isPersisting}
                                            title="轨道下移"
                                        >
                                            <ChevronDown size={11} />
                                        </button>
                                        <button
                                            type="button"
                                            className="redbox-editable-timeline__track-action redbox-editable-timeline__track-action--danger"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                void handleDeleteTrack(track.id);
                                            }}
                                            disabled={track.clipCount > 0 || isPersisting}
                                            title={track.clipCount > 0 ? '仅支持删除空轨道' : '删除轨道'}
                                        >
                                            <Trash2 size={11} />
                                        </button>
                                    </div>
                                </div>
                                <div className="redbox-editable-timeline__track-meta">
                                    <span>{track.kindLabel}</span>
                                    <span>{track.clipCount} 段</span>
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
                                isDraggingAsset && draggingAssetKind && trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-hit--accepting',
                                isDraggingAsset && draggingAssetKind && !trackAcceptsAssetPayloadKind(track.id, draggingAssetKind) && 'redbox-editable-timeline__track-hit--blocked'
                            )}
                            style={{
                                left: START_LEFT,
                                top: track.top,
                                height: track.height,
                            }}
                            onClick={(event) => {
                                event.stopPropagation();
                                focusTrack(track.id, { clearClipSelection: true });
                            }}
                        />
                    ))}
                    {trackSummaries
                        .filter((track) => track.clipCount === 0)
                        .map((track) => (
                            <div
                                key={`empty-track-${track.id}`}
                                className="redbox-editable-timeline__empty-track"
                                style={{
                                    left: START_LEFT + 14,
                                    top: track.top + 10,
                                    height: Math.max(38, track.height - 20),
                                }}
                                onClick={() => {
                                    focusTrack(track.id, { clearClipSelection: true });
                                }}
                            >
                                <div className={clsx(
                                    'redbox-editable-timeline__empty-track-chip',
                                    `redbox-editable-timeline__empty-track-chip--${track.kind}`,
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
                        const typeLabel = visualKind === 'audio' ? '音频' : visualKind === 'subtitle' ? '字幕' : kind === 'image' ? '图片' : '视频';
                        const isCompactClip = width < 132;
                        const isTinyClip = width < 88;
                        const showTitle = width >= 96;
                        const showMeta = width >= 136;
                        const stripFrameCount = buildClipStripFrameCount(width);
                        const stripCacheKey = `${clipId}:${stripFrameCount}:${Math.round(normalizeNumber(clip?.trimInMs, 0))}:${Math.round(visibleDurationSeconds * 1000)}`;
                        const generatedFrames = videoStripFrames[stripCacheKey] || [];
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
                                <div
                                    className={clsx(
                                        'redbox-editable-timeline__clip',
                                        visualKind === 'audio' && 'redbox-editable-timeline__clip--audio',
                                        visualKind === 'video' && 'redbox-editable-timeline__clip--video',
                                        kind === 'image' && 'redbox-editable-timeline__clip--image',
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
                        setScrollLeft((current) => (
                            Math.abs(current - nextScrollLeft) < SCROLL_LEFT_EPSILON ? current : nextScrollLeft
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
                            focusTrack(nextTrackId, { clearClipSelection: true });
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
