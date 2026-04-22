import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { AudioLines, Eye, EyeOff, GripVertical, Lock, Minus, Orbit, Pause, Play, Plus, Scissors, Trash2, Type, Unlock, Video } from 'lucide-react';
import {
    buildAssetMap,
    deriveProjectedEditorItems,
    type EditorCommand,
    type EditorAsset,
    type EditorItem,
    type EditorProjectFile,
    type EditorTrackKind,
    isMediaItem,
    timelineTracks,
} from './editorProject';

type ExperimentalTimelineProps = {
    project: EditorProjectFile;
    currentTimeMs: number;
    isPlaying: boolean;
    canAutoTranscribeSubtitles?: boolean;
    isTranscribingSubtitles?: boolean;
    selectedItemIds: string[];
    primaryItemId: string | null;
    selectedTrackIds: string[];
    subtitleTranscriptionNotice?: string | null;
    zoomPercent: number;
    onApplyCommands: (commands: EditorCommand[]) => void;
    onAutoTranscribeSubtitles: () => void;
    onSeekTimeMs: (timeMs: number) => void;
    onTogglePlayback: () => void;
    onSelectionChange: (selection: { itemIds: string[]; primaryItemId: string | null; trackIds: string[] }) => void;
    onZoomPercentChange: (zoomPercent: number) => void;
};

type DragState = {
    mode: 'move' | 'trim-start' | 'trim-end' | 'playhead';
    itemId?: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    initialItems: Array<{
        id: string;
        fromMs: number;
        durationMs: number;
        trimInMs?: number;
        trackId: string;
        kind: EditorTrackKind;
    }>;
    targetTrackId?: string;
};

type DragPreviewMap = Record<string, {
    fromMs: number;
    durationMs: number;
    trimInMs?: number;
    trackId?: string;
    virtualTrackPlacement?: 'above' | 'below';
}>;

type TrackReorderState = {
    pointerId: number;
    trackId: string;
    startClientY: number;
};

const RAIL_WIDTH = 160;
const RULER_HEIGHT = 38;
const PRIMARY_TRACK_ID = 'V1';
const ROW_HEIGHT: Record<EditorTrackKind, number> = {
    video: 54,
    audio: 48,
    subtitle: 42,
    text: 42,
    motion: 42,
};

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function trackPrefix(kind: EditorTrackKind): string {
    if (kind === 'audio') return 'A';
    if (kind === 'subtitle') return 'S';
    if (kind === 'text') return 'T';
    if (kind === 'motion') return 'M';
    return 'V';
}

function nextTrackId(project: EditorProjectFile, kind: EditorTrackKind): string {
    const prefix = trackPrefix(kind);
    const values = project.tracks
        .filter((track) => track.kind === kind)
        .map((track) => Number(track.id.slice(1)))
        .filter(Number.isFinite);
    return `${prefix}${(Math.max(0, ...values) + 1) || 1}`;
}

function kindIcon(kind: EditorTrackKind) {
    if (kind === 'audio') return AudioLines;
    if (kind === 'subtitle' || kind === 'text') return Type;
    if (kind === 'motion') return Orbit;
    return Video;
}

function assetTrackKind(asset: EditorAsset): EditorTrackKind {
    if (asset.kind === 'audio') return 'audio';
    if (asset.kind === 'subtitle') return 'subtitle';
    if (asset.kind === 'text') return 'text';
    return 'video';
}

function compatibleTrackId(project: EditorProjectFile, kind: EditorTrackKind, preferredTrackId?: string | null): string {
    if (preferredTrackId) {
        const preferred = project.tracks.find((track) => track.id === preferredTrackId && track.kind === kind);
        if (preferred) return preferred.id;
    }
    return timelineTracks(project).find((track) => track.kind === kind)?.id || nextTrackId(project, kind);
}

function rowHeight(track: { kind: EditorTrackKind; ui: { collapsed: boolean } }) {
    return track.ui.collapsed ? 34 : ROW_HEIGHT[track.kind];
}

function isProtectedTrackId(trackId: string) {
    return trackId === PRIMARY_TRACK_ID;
}

function itemLabel(item: EditorItem, assetMap: Record<string, EditorAsset>) {
    if (item.type === 'media') return assetMap[item.assetId]?.title || item.assetId;
    if (item.type === 'motion') return String(item.props.overlayTitle || item.templateId || 'Motion');
    return item.text;
}

function itemToneClass(item: EditorItem, assetMap: Record<string, EditorAsset>) {
    if (item.type === 'motion') return 'border-violet-300/40 bg-violet-500/22';
    if (item.type === 'subtitle') return 'border-amber-700/45 bg-amber-700/30';
    if (item.type === 'text') return 'border-amber-700/45 bg-amber-700/30';
    const assetKind = assetMap[item.assetId]?.kind || 'video';
    if (assetKind === 'audio') return 'border-sky-300/40 bg-sky-500/22';
    if (assetKind === 'image') return 'border-emerald-300/40 bg-emerald-500/22';
    return 'border-emerald-300/40 bg-emerald-500/22';
}

function itemTrackKind(item: EditorItem, assetMap: Record<string, EditorAsset>): EditorTrackKind {
    if (item.type === 'media') {
        const asset = assetMap[item.assetId];
        return asset ? assetTrackKind(asset) : 'video';
    }
    return item.type;
}

function audioWaveHeights(seed: string, count: number): number[] {
    const base = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0) || 37;
    return Array.from({ length: count }, (_, index) => {
        const value = (base + index * 17) % 100;
        return 26 + (value % 56);
    });
}

function splitPointWithinItem(item: EditorItem, currentTimeMs: number): number | null {
    if (item.type === 'motion') return null;
    const minEdgeOffset = Math.min(120, Math.max(1, Math.floor(item.durationMs / 4)));
    const minSplitMs = item.fromMs + minEdgeOffset;
    const maxSplitMs = item.fromMs + item.durationMs - minEdgeOffset;
    if (maxSplitMs <= minSplitMs) return null;
    return clamp(currentTimeMs, minSplitMs, maxSplitMs);
}

function splitPointForItem(item: EditorItem, currentTimeMs: number): number | null {
    const clamped = splitPointWithinItem(item, currentTimeMs);
    if (clamped !== null) return clamped;
    if (item.type === 'motion' || item.durationMs <= 2) return null;
    return item.fromMs + Math.floor(item.durationMs / 2);
}

export function ExperimentalTimeline({
    project,
    currentTimeMs,
    isPlaying,
    canAutoTranscribeSubtitles = true,
    isTranscribingSubtitles = false,
    selectedItemIds,
    primaryItemId,
    selectedTrackIds,
    subtitleTranscriptionNotice = null,
    zoomPercent,
    onApplyCommands,
    onAutoTranscribeSubtitles,
    onSeekTimeMs,
    onTogglePlayback,
    onSelectionChange,
    onZoomPercentChange,
}: ExperimentalTimelineProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const contextMenuRef = useRef<HTMLDivElement | null>(null);
    const trackContextMenuRef = useRef<HTMLDivElement | null>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const [dragPreview, setDragPreview] = useState<DragPreviewMap | null>(null);
    const [trackReorderState, setTrackReorderState] = useState<TrackReorderState | null>(null);
    const [trackReorderInsertIndex, setTrackReorderInsertIndex] = useState<number | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemId: string } | null>(null);
    const [trackContextMenu, setTrackContextMenu] = useState<{ x: number; y: number; trackId: string } | null>(null);
    const tracks = useMemo(() => timelineTracks(project), [project]);
    const projectedItems = useMemo(() => deriveProjectedEditorItems(project), [project]);
    const assetMap = useMemo(() => buildAssetMap(project), [project]);
    const pixelsPerSecond = 72 * (zoomPercent / 100);
    const totalDurationMs = useMemo(() => projectedItems.reduce((max, item) => Math.max(max, item.fromMs + item.durationMs), 0), [projectedItems]);
    const contentWidth = RAIL_WIDTH + Math.max(12_000, totalDurationMs) / 1000 * pixelsPerSecond + 120;
    const playheadLeft = RAIL_WIDTH + (currentTimeMs / 1000) * pixelsPerSecond;
    const rowOffsets = useMemo(() => {
        let top = 0;
        return tracks.map((track) => {
            const current = { track, top, height: rowHeight(track) };
            top += current.height;
            return current;
        });
    }, [tracks]);
    const rowTopByTrackId = useMemo(
        () => new Map(rowOffsets.map((row) => [row.track.id, row.top])),
        [rowOffsets],
    );
    const trackContentHeight = rowOffsets.reduce((sum, row) => sum + row.height, 0);

    const clientXToTimelineMs = (clientX: number) => {
        const rect = bodyRef.current?.getBoundingClientRect();
        const scrollLeft = bodyRef.current?.scrollLeft || 0;
        if (!rect) return 0;
        const contentX = clamp(clientX - rect.left - RAIL_WIDTH + scrollLeft, 0, Math.max(0, contentWidth - RAIL_WIDTH));
        return (contentX / pixelsPerSecond) * 1000;
    };

    const clientYToTrack = (clientY: number) => {
        const rect = bodyRef.current?.getBoundingClientRect();
        const scrollTop = bodyRef.current?.scrollTop || 0;
        if (!rect) return null;
        const contentY = clientY - rect.top - RULER_HEIGHT + scrollTop;
        return rowOffsets.find((row) => contentY >= row.top && contentY < row.top + row.height)?.track || null;
    };

    const clientYToTrackBounds = (clientY: number) => {
        const rect = bodyRef.current?.getBoundingClientRect();
        const scrollTop = bodyRef.current?.scrollTop || 0;
        if (!rect) return null;
        const contentY = clientY - rect.top - RULER_HEIGHT + scrollTop;
        return {
            contentY,
            isAbove: contentY < 0,
            isBelow: contentY > trackContentHeight,
        };
    };

    const clientYToTrackInsertIndex = (clientY: number) => {
        const rect = bodyRef.current?.getBoundingClientRect();
        const scrollTop = bodyRef.current?.scrollTop || 0;
        if (!rect) return 0;
        const contentY = clientY - rect.top - RULER_HEIGHT + scrollTop;

        for (let index = 0; index < rowOffsets.length; index += 1) {
            const row = rowOffsets[index]!;
            if (contentY < row.top + row.height / 2) {
                return index;
            }
        }

        return rowOffsets.length;
    };

    const resolveMoveTargetTrack = (kind: EditorTrackKind, clientY: number, fallbackTrackId: string) => {
        const hoveredTrack = clientYToTrack(clientY);
        if (hoveredTrack) {
            if (hoveredTrack.ui.locked || hoveredTrack.kind !== kind) {
                return { trackId: fallbackTrackId } as const;
            }
            return { trackId: hoveredTrack.id } as const;
        }

        const bounds = clientYToTrackBounds(clientY);
        if (!bounds) return { trackId: fallbackTrackId } as const;
        if (bounds.isAbove) {
            return {
                trackId: nextTrackId(project, kind),
                virtualTrackPlacement: 'above' as const,
            };
        }
        if (bounds.isBelow) {
            return {
                trackId: nextTrackId(project, kind),
                virtualTrackPlacement: 'below' as const,
            };
        }

        return { trackId: fallbackTrackId } as const;
    };

    useEffect(() => {
        if (!dragState) return;
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerId !== dragState.pointerId) return;
            if (dragState.mode === 'playhead') {
                onSeekTimeMs(clientXToTimelineMs(event.clientX));
                return;
            }
            const deltaMs = Math.round(((event.clientX - dragState.startClientX) / pixelsPerSecond) * 1000);
            if (dragState.mode === 'move') {
                setDragPreview(Object.fromEntries(
                    dragState.initialItems.map((item) => {
                        const moveTarget = dragState.initialItems.length === 1
                            ? resolveMoveTargetTrack(item.kind, event.clientY, item.trackId)
                            : { trackId: item.trackId };
                        return [
                            item.id,
                            {
                                fromMs: Math.max(0, item.fromMs + deltaMs),
                                durationMs: item.durationMs,
                                trimInMs: item.trimInMs,
                                trackId: moveTarget.trackId,
                                virtualTrackPlacement: moveTarget.virtualTrackPlacement,
                            },
                        ];
                    })
                ));
                return;
            }
            if (!dragState.itemId) return;
            const initial = dragState.initialItems[0];
            if (!initial) return;
            const targetDuration = dragState.mode === 'trim-start'
                ? initial.durationMs - deltaMs
                : initial.durationMs + deltaMs;
            const nextDuration = Math.max(300, targetDuration);
            const nextFromMs = dragState.mode === 'trim-start'
                ? Math.max(0, initial.fromMs + deltaMs)
                : initial.fromMs;
            setDragPreview({
                [dragState.itemId]: {
                    fromMs: nextFromMs,
                    durationMs: nextDuration,
                    trimInMs: dragState.mode === 'trim-start' && typeof initial.trimInMs === 'number'
                        ? Math.max(0, initial.trimInMs + deltaMs)
                        : initial.trimInMs,
                },
            });
        };
        const handlePointerUp = (event: PointerEvent) => {
            if (event.pointerId !== dragState.pointerId) return;
            if (dragPreview) {
                const commands: EditorCommand[] = [];
                if (dragState.mode === 'move') {
                    for (const initial of dragState.initialItems) {
                        const preview = dragPreview[initial.id];
                        if (!preview) continue;
                        const shouldCreateTrack = Boolean(
                            preview.trackId
                            && preview.trackId !== initial.trackId
                            && !project.tracks.some((track) => track.id === preview.trackId)
                        );
                        if (shouldCreateTrack) {
                            commands.push({
                                type: 'add_track',
                                kind: initial.kind,
                                trackId: preview.trackId,
                            });
                            if (preview.virtualTrackPlacement === 'above') {
                                commands.push(...Array.from({ length: tracks.length }, () => ({
                                    type: 'reorder_tracks' as const,
                                    trackId: preview.trackId!,
                                    direction: 'up' as const,
                                })));
                            }
                        }
                        commands.push({
                            type: 'update_item',
                            itemId: initial.id,
                            patch: {
                                fromMs: preview.fromMs,
                                ...(preview.trackId && preview.trackId !== initial.trackId ? { trackId: preview.trackId } : {}),
                            } as Partial<EditorItem>,
                        });
                    }
                } else if (dragState.itemId) {
                    const preview = dragPreview[dragState.itemId];
                    if (preview) {
                        commands.push({
                            type: 'update_item',
                            itemId: dragState.itemId,
                            patch: {
                                fromMs: preview.fromMs,
                                durationMs: preview.durationMs,
                                ...(typeof preview.trimInMs === 'number' ? { trimInMs: preview.trimInMs } : {}),
                            } as Partial<EditorItem>,
                        });
                    }
                }
                if (commands.length > 0) {
                    onApplyCommands(commands);
                }
            }
            setDragPreview(null);
            setDragState(null);
        };
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [clientXToTimelineMs, contentWidth, dragPreview, dragState, onApplyCommands, onSeekTimeMs, pixelsPerSecond, rowOffsets, tracks]);

    useEffect(() => {
        if (!trackReorderState) return;

        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerId !== trackReorderState.pointerId) return;
            setTrackReorderInsertIndex(clientYToTrackInsertIndex(event.clientY));
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (event.pointerId !== trackReorderState.pointerId) return;

            const currentIndex = tracks.findIndex((track) => track.id === trackReorderState.trackId);
            const rawInsertIndex = trackReorderInsertIndex ?? currentIndex;
            let targetIndex = rawInsertIndex;
            if (targetIndex > currentIndex) {
                targetIndex -= 1;
            }
            targetIndex = clamp(targetIndex, 0, Math.max(0, tracks.length - 1));

            if (currentIndex >= 0 && targetIndex !== currentIndex) {
                const direction: 'up' | 'down' = targetIndex > currentIndex ? 'down' : 'up';
                const distance = Math.abs(targetIndex - currentIndex);
                onApplyCommands(Array.from({ length: distance }, () => ({
                    type: 'reorder_tracks',
                    trackId: trackReorderState.trackId,
                    direction,
                } as EditorCommand)));
                onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [trackReorderState.trackId] });
            }

            setTrackReorderState(null);
            setTrackReorderInsertIndex(null);
        };

        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ns-resize';
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };
    }, [clientYToTrackInsertIndex, onApplyCommands, onSelectionChange, rowOffsets.length, trackReorderInsertIndex, trackReorderState, tracks]);

    const selectedItems = projectedItems.filter((item) => selectedItemIds.includes(item.id));
    const primaryItem = primaryItemId ? projectedItems.find((item) => item.id === primaryItemId) || null : null;
    const contextMenuItem = contextMenu ? projectedItems.find((item) => item.id === contextMenu.itemId) || null : null;
    const trackContextMenuTrack = trackContextMenu ? project.tracks.find((track) => track.id === trackContextMenu.trackId) || null : null;
    const itemAtPlayhead = projectedItems.find((item) => (
        item.type !== 'motion'
        && currentTimeMs >= item.fromMs
        && currentTimeMs <= item.fromMs + item.durationMs
    )) || null;
    const splitTargetItem = primaryItem || selectedItems[0] || itemAtPlayhead;
    const primarySplitMs = splitTargetItem ? splitPointForItem(splitTargetItem, currentTimeMs) : null;
    const contextSplitMs = contextMenuItem ? splitPointForItem(contextMenuItem, currentTimeMs) : null;
    const canSplitPrimary = primarySplitMs !== null;
    const canSplitContextItem = contextSplitMs !== null;
    const activeDragTrackId = dragState?.mode === 'move' && dragState.itemId
        ? dragPreview?.[dragState.itemId]?.trackId || null
        : null;
    const activeTrackReorderId = trackReorderState?.trackId || null;
    const trackReorderIndicatorTop = trackReorderInsertIndex === null
        ? null
        : trackReorderInsertIndex >= rowOffsets.length
            ? trackContentHeight
            : rowOffsets[trackReorderInsertIndex]?.top ?? 0;
    const deletableSelectedTrackIds = selectedTrackIds.filter((trackId) => !isProtectedTrackId(trackId));
    const canDeleteSelection = selectedItemIds.length > 0 || deletableSelectedTrackIds.length > 0;

    const deleteSelected = () => {
        if (selectedItemIds.length > 0) {
            const commands = selectedItems.map((item) => (
                item.type === 'motion'
                    ? ({ type: 'animation_layer_delete', layerId: item.id } as EditorCommand)
                    : ({ type: 'delete_item', itemId: item.id } as EditorCommand)
            ));
            onApplyCommands(commands);
            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [] });
            return;
        }
        if (deletableSelectedTrackIds.length > 0) {
            onApplyCommands([{ type: 'delete_tracks', trackIds: deletableSelectedTrackIds }]);
            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [] });
        }
    };

    const focusTimeline = () => {
        rootRef.current?.focus();
    };

    const handleTimelineKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const isDeleteKey = event.key === 'Delete' || event.key === 'Backspace';
        if (!isDeleteKey) return;
        const target = event.target as HTMLElement | null;
        if (target) {
            const tagName = target.tagName;
            const isEditable = target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
            if (isEditable) return;
        }
        if (!canDeleteSelection) return;
        event.preventDefault();
        event.stopPropagation();
        deleteSelected();
    };

    const splitPrimary = () => {
        if (!splitTargetItem || primarySplitMs === null) return;
        onApplyCommands([{
            type: 'split_item',
            itemId: splitTargetItem.id,
            splitMs: primarySplitMs,
        }]);
    };

    useEffect(() => {
        if (!contextMenu && !trackContextMenu) return;
        const closeMenu = (event: Event) => {
            const target = event.target as Node | null;
            if (
                (contextMenuRef.current && target && contextMenuRef.current.contains(target))
                || (trackContextMenuRef.current && target && trackContextMenuRef.current.contains(target))
            ) {
                return;
            }
            setContextMenu(null);
            setTrackContextMenu(null);
        };
        window.addEventListener('pointerdown', closeMenu);
        window.addEventListener('scroll', closeMenu, true);
        return () => {
            window.removeEventListener('pointerdown', closeMenu);
            window.removeEventListener('scroll', closeMenu, true);
        };
    }, [contextMenu, trackContextMenu]);

    const onDropAsset = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData('application/x-redbox-editor-asset');
        if (!raw) return;
        let asset: EditorAsset | null = null;
        try {
            asset = JSON.parse(raw) as EditorAsset;
        } catch {
            asset = null;
        }
        if (!asset) return;
        const rect = bodyRef.current?.getBoundingClientRect();
        const scrollLeft = bodyRef.current?.scrollLeft || 0;
        if (!rect) return;
        const relativeX = clamp(event.clientX - rect.left - RAIL_WIDTH + scrollLeft, 0, Math.max(0, contentWidth - RAIL_WIDTH));
        const relativeY = event.clientY - rect.top - RULER_HEIGHT;
        const row = rowOffsets.find((offset) => relativeY >= offset.top && relativeY < offset.top + offset.height) || null;
        const desiredKind = assetTrackKind(asset);
        const trackId = compatibleTrackId(project, desiredKind, row?.track.id || null);
        const item: EditorItem = {
            id: `item-${Math.random().toString(36).slice(2, 10)}`,
            type: 'media',
            trackId,
            assetId: asset.id,
            fromMs: Math.round((relativeX / pixelsPerSecond) * 1000),
            durationMs: Math.max(500, Number(asset.durationMs || (asset.kind === 'image' ? 1500 : 4000))),
            trimInMs: 0,
            trimOutMs: 0,
            enabled: true,
        };
        const commands: EditorCommand[] = [];
        if (!project.assets.some((existing) => existing.id === asset.id)) {
            commands.push({ type: 'upsert_assets', assets: [asset] });
        }
        if (!project.tracks.some((track) => track.id === trackId)) {
            commands.push({ type: 'add_track', kind: desiredKind, trackId });
        }
        commands.push({ type: 'add_item', item });
        onApplyCommands(commands);
        onSelectionChange({ itemIds: [item.id], primaryItemId: item.id, trackIds: [] });
    };

    const seekFromPointer = (clientX: number) => {
        onSeekTimeMs(clientXToTimelineMs(clientX));
    };

    const toolbarIconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-white/60 transition hover:bg-white/[0.06] hover:text-white';

    return (
        <div
            ref={rootRef}
            className="flex h-full min-h-0 flex-col outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70"
            tabIndex={0}
            onKeyDown={handleTimelineKeyDown}
            onPointerDownCapture={focusTimeline}
        >
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <button
                    type="button"
                    onClick={onTogglePlayback}
                    className={toolbarIconButtonClass}
                    title={isPlaying ? '暂停' : '播放'}
                    aria-label={isPlaying ? '暂停' : '播放'}
                >
                    {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                </button>
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        onClick={() => onZoomPercentChange(clamp(zoomPercent - 10, 40, 240))}
                        className={toolbarIconButtonClass}
                        title="缩小时间轴"
                        aria-label="缩小时间轴"
                    >
                        <Minus className="h-3.5 w-3.5" />
                    </button>
                    <div className="min-w-[42px] text-center text-[11px] font-medium tabular-nums text-white/42">
                        {zoomPercent}%
                    </div>
                    <button
                        type="button"
                        onClick={() => onZoomPercentChange(clamp(zoomPercent + 10, 40, 240))}
                        className={toolbarIconButtonClass}
                        title="放大时间轴"
                        aria-label="放大时间轴"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>
                </div>
                <button
                    type="button"
                    onClick={splitPrimary}
                    disabled={!canSplitPrimary}
                    className={clsx(toolbarIconButtonClass, 'disabled:opacity-40')}
                    title="分割"
                    aria-label="分割"
                >
                    <Scissors className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={deleteSelected}
                    disabled={!canDeleteSelection}
                    className={clsx(toolbarIconButtonClass, 'text-red-200/80 hover:bg-red-400/10 hover:text-red-100 disabled:opacity-40')}
                    title="删除"
                    aria-label="删除"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={onAutoTranscribeSubtitles}
                    disabled={!canAutoTranscribeSubtitles || isTranscribingSubtitles}
                    className={clsx(
                        toolbarIconButtonClass,
                        'text-cyan-100/85 hover:bg-cyan-400/10 hover:text-cyan-50 disabled:opacity-40',
                        isTranscribingSubtitles && 'animate-pulse',
                    )}
                    title={isTranscribingSubtitles ? '字幕识别中' : '自动识别字幕'}
                    aria-label={isTranscribingSubtitles ? '字幕识别中' : '自动识别字幕'}
                >
                    <Type className="h-3.5 w-3.5" />
                </button>
            </div>

            <div
                ref={bodyRef}
                className="min-h-0 flex-1 overflow-auto rounded-2xl border border-white/10 bg-[#0f1013]"
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDropAsset}
            >
                <div className="relative" style={{ width: contentWidth, minHeight: RULER_HEIGHT + rowOffsets.reduce((sum, row) => sum + row.height, 0) }}>
                    <div className="sticky top-0 z-20 flex h-[38px] border-b border-white/10 bg-[#141519]">
                        <div className="flex items-center px-3 text-[11px] uppercase tracking-[0.2em] text-white/35" style={{ width: RAIL_WIDTH }}>Tracks</div>
                        <div
                            className="relative flex-1 cursor-pointer"
                            onPointerDown={(event) => {
                                onSeekTimeMs(clientXToTimelineMs(event.clientX));
                                setDragState({
                                    mode: 'playhead',
                                    pointerId: event.pointerId,
                                    startClientX: event.clientX,
                                    startClientY: event.clientY,
                                    initialItems: [],
                                });
                            }}
                        >
                            {Array.from({ length: Math.ceil((contentWidth - RAIL_WIDTH) / pixelsPerSecond) + 1 }).map((_, index) => (
                                <div key={index} className="absolute inset-y-0 border-l border-white/[0.06]" style={{ left: index * pixelsPerSecond }}>
                                    <div className="absolute left-2 top-2 text-[11px] text-white/35">{index}s</div>
                                </div>
                            ))}
                            <div className="absolute inset-y-0 w-[2px] bg-cyan-300" style={{ left: (currentTimeMs / 1000) * pixelsPerSecond }} />
                            <div className="absolute -top-[1px] h-3.5 w-3.5 -translate-x-1/2 rounded-full border border-cyan-200/70 bg-cyan-300 shadow-[0_0_0_3px_rgba(34,211,238,0.18)]" style={{ left: (currentTimeMs / 1000) * pixelsPerSecond }} />
                        </div>
                    </div>
                    <div
                        className="pointer-events-none absolute z-[18] w-[2px] bg-cyan-300/95 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
                        style={{
                            left: playheadLeft,
                            top: RULER_HEIGHT,
                            height: rowOffsets.reduce((sum, row) => sum + row.height, 0),
                        }}
                    />
                    {trackReorderIndicatorTop !== null ? (
                        <div
                            className="pointer-events-none absolute left-0 right-0 z-[19] h-[2px] bg-cyan-300 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
                            style={{ top: RULER_HEIGHT + trackReorderIndicatorTop }}
                        />
                    ) : null}

                    {rowOffsets.map(({ track, top, height }) => {
                        const TrackIcon = kindIcon(track.kind);
                        const rowItems = projectedItems
                            .filter((item) => item.trackId === track.id)
                            .slice()
                            .sort((left, right) => left.fromMs - right.fromMs);
                        return (
                            <div key={track.id} className="relative flex border-b border-white/[0.06]" style={{ height }}>
                                <div
                                    className={clsx(
                                        'sticky left-0 z-10 flex shrink-0 items-center justify-between gap-1.5 border-r border-white/10 px-2.5',
                                        selectedTrackIds.includes(track.id) ? 'bg-cyan-400/10' : 'bg-[#141519]',
                                        activeTrackReorderId === track.id && 'bg-cyan-400/14'
                                    )}
                                    style={{ width: RAIL_WIDTH }}
                                    onClick={() => onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [track.id] })}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        setContextMenu(null);
                                        onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [track.id] });
                                        setTrackContextMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                            trackId: track.id,
                                        });
                                    }}
                                >
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <button
                                            type="button"
                                            className={clsx(
                                                'group inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/35 transition hover:bg-white/[0.06] hover:text-white/70',
                                                activeTrackReorderId === track.id ? 'cursor-grabbing' : 'cursor-grab',
                                            )}
                                            style={{ cursor: activeTrackReorderId === track.id ? 'grabbing' : 'grab' }}
                                            title="拖动调整轨道顺序"
                                            aria-label={`拖动调整 ${track.name} 顺序`}
                                            onPointerDown={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [track.id] });
                                                setTrackReorderState({
                                                    pointerId: event.pointerId,
                                                    trackId: track.id,
                                                    startClientY: event.clientY,
                                                });
                                                setTrackReorderInsertIndex(rowOffsets.findIndex((row) => row.track.id === track.id));
                                            }}
                                        >
                                            <GripVertical
                                                className={clsx('h-4.5 w-4.5', activeTrackReorderId === track.id ? 'cursor-grabbing' : 'cursor-grab')}
                                                style={{ cursor: activeTrackReorderId === track.id ? 'grabbing' : 'grab' }}
                                            />
                                        </button>
                                        <TrackIcon className="h-4 w-4 text-white/65" />
                                        <div className="min-w-0 truncate text-xs font-medium text-white">{track.name}</div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button type="button" onClick={(event) => { event.stopPropagation(); onApplyCommands([{ type: 'set_track_ui', trackId: track.id, patch: { hidden: !track.ui.hidden } }]); }} className="text-white/55 hover:text-white">{track.ui.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
                                        {track.kind === 'audio' ? (
                                            <button type="button" onClick={(event) => { event.stopPropagation(); onApplyCommands([{ type: 'set_track_ui', trackId: track.id, patch: { muted: !track.ui.muted } }]); }} className="text-white/55 hover:text-white">
                                                <AudioLines className="h-3.5 w-3.5" />
                                            </button>
                                        ) : null}
                                        <button type="button" onClick={(event) => { event.stopPropagation(); onApplyCommands([{ type: 'set_track_ui', trackId: track.id, patch: { locked: !track.ui.locked } }]); }} className="text-white/55 hover:text-white">{track.ui.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}</button>
                                    </div>
                                </div>
                                <div
                                    className={clsx(
                                        'relative flex-1',
                                        selectedTrackIds.includes(track.id) && 'bg-cyan-400/[0.04]',
                                        activeDragTrackId === track.id && 'bg-cyan-300/[0.08]',
                                    )}
                                    onPointerDown={(event) => {
                                        if (event.target !== event.currentTarget) return;
                                        seekFromPointer(event.clientX);
                                        onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [track.id] });
                                    }}
                                >
                                    {rowItems.map((item) => {
                                        const preview = dragPreview?.[item.id] || null;
                                        const effectiveFromMs = preview?.fromMs ?? item.fromMs;
                                        const effectiveDurationMs = preview?.durationMs ?? item.durationMs;
                                        const rawLeft = (effectiveFromMs / 1000) * pixelsPerSecond;
                                        const rawWidth = Math.max(28, (effectiveDurationMs / 1000) * pixelsPerSecond);
                                        const left = rawLeft + 1;
                                        const width = Math.max(24, rawWidth - 2);
                                        const selected = selectedItemIds.includes(item.id);
                                        const previewTrackId = preview?.trackId || item.trackId;
                                        const previewTrackTop = rowTopByTrackId.get(previewTrackId)
                                            ?? (preview?.virtualTrackPlacement === 'above'
                                                ? 0
                                                : preview?.virtualTrackPlacement === 'below'
                                                    ? trackContentHeight
                                                    : top);
                                        const translateY = previewTrackTop - top;
                                        return (
                                            <div
                                                key={item.id}
                                                className={clsx(
                                                    'absolute top-1.5 bottom-1.5 rounded-md border text-left shadow-[0_6px_16px_rgba(0,0,0,0.18)] transition-[box-shadow,transform,border-color] cursor-grab active:cursor-grabbing select-none overflow-hidden hover:shadow-[0_10px_24px_rgba(0,0,0,0.24)]',
                                                    itemToneClass(item, assetMap),
                                                    dragPreview?.[item.id] && 'z-10 shadow-[0_10px_28px_rgba(0,0,0,0.26)]',
                                                    selected && 'ring-1 ring-white/70'
                                                )}
                                                style={{
                                                    left,
                                                    width,
                                                    transform: translateY !== 0 ? `translateY(${translateY}px)` : undefined,
                                                }}
                                                onContextMenu={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    onSelectionChange({ itemIds: [item.id], primaryItemId: item.id, trackIds: [] });
                                                    setContextMenu({
                                                        x: event.clientX,
                                                        y: event.clientY,
                                                        itemId: item.id,
                                                    });
                                                }}
                                                onPointerDown={(event) => {
                                                    if (track.ui.locked) return;
                                                    setContextMenu(null);
                                                    event.stopPropagation();
                                                    const nextSelection = event.metaKey || event.ctrlKey
                                                        ? Array.from(new Set(selected ? selectedItemIds.filter((id) => id !== item.id) : [...selectedItemIds, item.id]))
                                                        : [item.id];
                                                    onSelectionChange({ itemIds: nextSelection, primaryItemId: item.id, trackIds: [] });
                                                    setDragState({
                                                        mode: 'move',
                                                        itemId: item.id,
                                                        pointerId: event.pointerId,
                                                        startClientX: event.clientX,
                                                        startClientY: event.clientY,
                                                        initialItems: projectedItems
                                                            .filter((candidate) => nextSelection.includes(candidate.id))
                                                            .map((candidate) => ({
                                                                id: candidate.id,
                                                                fromMs: candidate.fromMs,
                                                                durationMs: candidate.durationMs,
                                                                trimInMs: candidate.type === 'media' ? candidate.trimInMs : 0,
                                                                trackId: candidate.trackId,
                                                                kind: itemTrackKind(candidate, assetMap),
                                                            })),
                                                    });
                                                }}
                                                onDoubleClick={() => onSeekTimeMs(item.fromMs)}
                                            >
                                                {item.type === 'media' && assetMap[item.assetId]?.kind === 'audio' ? (
                                                    <div className="pointer-events-none absolute inset-x-2 bottom-1.5 top-1.5 flex items-end gap-[2px] opacity-90">
                                                        {audioWaveHeights(item.id, Math.max(12, Math.floor(width / 5))).map((heightPercent, index) => (
                                                            <span
                                                                key={`${item.id}-wave-${index}`}
                                                                className="min-w-[2px] flex-1 rounded-full bg-white/70"
                                                                style={{ height: `${heightPercent}%` }}
                                                            />
                                                        ))}
                                                    </div>
                                                ) : null}
                                                {item.type !== 'motion' ? (
                                                    <>
                                                        <div
                                                            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
                                                            onPointerDown={(event) => {
                                                                event.stopPropagation();
                                                                if (track.ui.locked) return;
                                                                onSelectionChange({ itemIds: [item.id], primaryItemId: item.id, trackIds: [] });
                                                                setDragState({
                                                                    mode: 'trim-start',
                                                                    itemId: item.id,
                                                                    pointerId: event.pointerId,
                                                                    startClientX: event.clientX,
                                                                    startClientY: event.clientY,
                                                                    initialItems: [{
                                                                        id: item.id,
                                                                        fromMs: item.fromMs,
                                                                        durationMs: item.durationMs,
                                                                        trimInMs: isMediaItem(item) ? item.trimInMs : 0,
                                                                        trackId: item.trackId,
                                                                        kind: itemTrackKind(item, assetMap),
                                                                    }],
                                                                });
                                                            }}
                                                        />
                                                        <div
                                                            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize"
                                                            onPointerDown={(event) => {
                                                                event.stopPropagation();
                                                                if (track.ui.locked) return;
                                                                onSelectionChange({ itemIds: [item.id], primaryItemId: item.id, trackIds: [] });
                                                                setDragState({
                                                                    mode: 'trim-end',
                                                                    itemId: item.id,
                                                                    pointerId: event.pointerId,
                                                                    startClientX: event.clientX,
                                                                    startClientY: event.clientY,
                                                                    initialItems: [{
                                                                        id: item.id,
                                                                        fromMs: item.fromMs,
                                                                        durationMs: item.durationMs,
                                                                        trimInMs: isMediaItem(item) ? item.trimInMs : 0,
                                                                        trackId: item.trackId,
                                                                        kind: itemTrackKind(item, assetMap),
                                                                    }],
                                                                });
                                                            }}
                                                        />
                                                    </>
                                                ) : null}
                                                <div className="pointer-events-none truncate px-2.5 py-1.5 text-[10px] font-medium text-white/78">
                                                    {itemLabel(item, assetMap)}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {selectedItems.length > 0 ? (
                <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/65">
                    已选 {selectedItems.length} 项
                </div>
            ) : null}
            {subtitleTranscriptionNotice ? (
                <div className="mt-3 rounded-2xl border border-cyan-300/18 bg-cyan-400/[0.06] px-3 py-2 text-xs text-cyan-100/85">
                    {subtitleTranscriptionNotice}
                </div>
            ) : null}
            {trackContextMenu && trackContextMenuTrack ? (
                <div
                    ref={trackContextMenuRef}
                    className="fixed z-[120] min-w-[150px] rounded-xl border border-white/10 bg-[#111111] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
                    style={{ left: trackContextMenu.x, top: trackContextMenu.y }}
                >
                    <button
                        type="button"
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                        onClick={() => {
                            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [trackContextMenuTrack.id] });
                            setTrackContextMenu(null);
                        }}
                    >
                        选中轨道
                    </button>
                    <button
                        type="button"
                        disabled={isProtectedTrackId(trackContextMenuTrack.id)}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-200 hover:bg-red-400/10 disabled:cursor-not-allowed disabled:text-red-200/40 disabled:hover:bg-transparent"
                        onClick={() => {
                            if (isProtectedTrackId(trackContextMenuTrack.id)) return;
                            onApplyCommands([{ type: 'delete_tracks', trackIds: [trackContextMenuTrack.id] }]);
                            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [] });
                            setTrackContextMenu(null);
                        }}
                    >
                        {isProtectedTrackId(trackContextMenuTrack.id) ? '主轨不可删除' : '删除轨道'}
                    </button>
                </div>
            ) : null}
            {contextMenu && contextMenuItem ? (
                <div
                    ref={contextMenuRef}
                    className="fixed z-[120] min-w-[150px] rounded-xl border border-white/10 bg-[#111111] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <button
                        type="button"
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                        onClick={() => {
                            onSelectionChange({ itemIds: [contextMenuItem.id], primaryItemId: contextMenuItem.id, trackIds: [] });
                            setContextMenu(null);
                        }}
                    >
                        选中片段
                    </button>
                    <button
                        type="button"
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                        onClick={() => {
                            onSeekTimeMs(contextMenuItem.fromMs);
                            setContextMenu(null);
                        }}
                    >
                        定位到开始
                    </button>
                    <button
                        type="button"
                        disabled={!canSplitContextItem}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => {
                            if (!canSplitContextItem) return;
                            onApplyCommands([{
                                type: 'split_item',
                                itemId: contextMenuItem.id,
                                splitMs: contextSplitMs!,
                            }]);
                            setContextMenu(null);
                        }}
                    >
                        在播放头分割
                    </button>
                    <button
                        type="button"
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-200 hover:bg-red-400/10"
                        onClick={() => {
                            onApplyCommands([
                                contextMenuItem.type === 'motion'
                                    ? ({ type: 'animation_layer_delete', layerId: contextMenuItem.id } as EditorCommand)
                                    : ({ type: 'delete_item', itemId: contextMenuItem.id } as EditorCommand),
                            ]);
                            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [] });
                            setContextMenu(null);
                        }}
                    >
                        删除
                    </button>
                </div>
            ) : null}
        </div>
    );
}
