import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import clsx from 'clsx';
import { AudioLines, Eye, EyeOff, Lock, Pause, Play, Plus, Rows, Scissors, Trash2, Type, Unlock, Video } from 'lucide-react';
import {
    buildAssetMap,
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
    selectedItemIds: string[];
    primaryItemId: string | null;
    selectedTrackIds: string[];
    zoomPercent: number;
    onApplyCommands: (commands: EditorCommand[]) => void;
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
    initialItems: Array<{ id: string; fromMs: number; durationMs: number; trimInMs?: number }>;
    targetTrackId?: string;
};

type DragPreviewMap = Record<string, { fromMs: number; durationMs: number; trimInMs?: number }>;

const RAIL_WIDTH = 184;
const RULER_HEIGHT = 38;
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
    if (kind === 'motion') return Rows;
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

function itemLabel(item: EditorItem, assetMap: Record<string, EditorAsset>) {
    if (item.type === 'media') return assetMap[item.assetId]?.title || item.assetId;
    if (item.type === 'motion') return String(item.props.overlayTitle || item.templateId || 'Motion');
    return item.text;
}

function itemToneClass(item: EditorItem, assetMap: Record<string, EditorAsset>) {
    if (item.type === 'motion') return 'border-fuchsia-300/35 bg-fuchsia-400/18';
    if (item.type === 'subtitle') return 'border-amber-300/35 bg-amber-400/18';
    if (item.type === 'text') return 'border-violet-300/35 bg-violet-400/18';
    const assetKind = assetMap[item.assetId]?.kind || 'video';
    if (assetKind === 'audio') return 'border-pink-300/35 bg-pink-400/18';
    if (assetKind === 'image') return 'border-emerald-300/35 bg-emerald-400/18';
    return 'border-cyan-300/35 bg-cyan-400/18';
}

export function ExperimentalTimeline({
    project,
    currentTimeMs,
    isPlaying,
    selectedItemIds,
    primaryItemId,
    selectedTrackIds,
    zoomPercent,
    onApplyCommands,
    onSeekTimeMs,
    onTogglePlayback,
    onSelectionChange,
    onZoomPercentChange,
}: ExperimentalTimelineProps) {
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const [dragPreview, setDragPreview] = useState<DragPreviewMap | null>(null);
    const tracks = useMemo(() => timelineTracks(project), [project]);
    const assetMap = useMemo(() => buildAssetMap(project), [project]);
    const pixelsPerSecond = 72 * (zoomPercent / 100);
    const totalDurationMs = useMemo(() => project.items.reduce((max, item) => Math.max(max, item.fromMs + item.durationMs), 6000), [project.items]);
    const contentWidth = RAIL_WIDTH + Math.max(12_000, totalDurationMs) / 1000 * pixelsPerSecond + 120;
    const rowOffsets = useMemo(() => {
        let top = 0;
        return tracks.map((track) => {
            const current = { track, top, height: rowHeight(track) };
            top += current.height;
            return current;
        });
    }, [tracks]);

    useEffect(() => {
        if (!dragState) return;
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerId !== dragState.pointerId) return;
            if (dragState.mode === 'playhead') {
                if (!bodyRef.current) return;
                const rect = bodyRef.current.getBoundingClientRect();
                const relativeX = clamp(event.clientX - rect.left - RAIL_WIDTH, 0, Math.max(0, rect.width - RAIL_WIDTH));
                onSeekTimeMs((relativeX / pixelsPerSecond) * 1000);
                return;
            }
            const deltaMs = Math.round(((event.clientX - dragState.startClientX) / pixelsPerSecond) * 1000);
            if (dragState.mode === 'move') {
                setDragPreview(Object.fromEntries(
                    dragState.initialItems.map((item) => [
                        item.id,
                        {
                            fromMs: Math.max(0, item.fromMs + deltaMs),
                            durationMs: item.durationMs,
                            trimInMs: item.trimInMs,
                        },
                    ])
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
                        commands.push({
                            type: 'update_item',
                            itemId: initial.id,
                            patch: {
                                fromMs: preview.fromMs,
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
    }, [dragPreview, dragState, onApplyCommands, onSeekTimeMs, pixelsPerSecond]);

    const selectedItems = project.items.filter((item) => selectedItemIds.includes(item.id));
    const primaryItem = primaryItemId ? project.items.find((item) => item.id === primaryItemId) || null : null;
    const activeTrack = selectedTrackIds[0] ? project.tracks.find((track) => track.id === selectedTrackIds[0]) || null : null;

    const addTrack = (kind: EditorTrackKind) => {
        onApplyCommands([{ type: 'add_track', kind, trackId: nextTrackId(project, kind) }]);
    };

    const deleteSelected = () => {
        if (selectedItemIds.length > 0) {
            onApplyCommands([{ type: 'delete_items', itemIds: selectedItemIds }]);
            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [] });
            return;
        }
        if (selectedTrackIds.length > 0) {
            onApplyCommands([{ type: 'delete_tracks', trackIds: selectedTrackIds }]);
            onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [] });
        }
    };

    const splitPrimary = () => {
        if (!primaryItem || primaryItem.type === 'motion') return;
        onApplyCommands([{
            type: 'split_item',
            itemId: primaryItem.id,
            splitMs: currentTimeMs,
        }]);
    };

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
        if (!rect) return;
        const relativeX = clamp(event.clientX - rect.left - RAIL_WIDTH, 0, Math.max(0, rect.width - RAIL_WIDTH));
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

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onTogglePlayback}
                    className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80 hover:border-cyan-300/45 hover:text-white"
                >
                    {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {isPlaying ? '暂停' : '播放'}
                </button>
                <button type="button" onClick={() => onZoomPercentChange(clamp(zoomPercent - 10, 40, 240))} className="inline-flex h-8 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80">缩小</button>
                <button type="button" onClick={() => onZoomPercentChange(100)} className="inline-flex h-8 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80">{zoomPercent}%</button>
                <button type="button" onClick={() => onZoomPercentChange(clamp(zoomPercent + 10, 40, 240))} className="inline-flex h-8 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80">放大</button>
                <button type="button" onClick={splitPrimary} disabled={!primaryItem || primaryItem.type === 'motion'} className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80 disabled:opacity-40"><Scissors className="h-3.5 w-3.5" />分割</button>
                <button type="button" onClick={deleteSelected} disabled={selectedItemIds.length === 0 && selectedTrackIds.length === 0} className="inline-flex h-8 items-center gap-2 rounded-full border border-red-400/20 bg-red-400/10 px-3 text-xs text-red-100 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />删除</button>
                <span className="mx-1 h-5 w-px bg-white/10" />
                <button type="button" onClick={() => addTrack('video')} className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80"><Plus className="h-3.5 w-3.5" />视频轨</button>
                <button type="button" onClick={() => addTrack('audio')} className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80"><Plus className="h-3.5 w-3.5" />音频轨</button>
                <button type="button" onClick={() => addTrack('subtitle')} className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80"><Plus className="h-3.5 w-3.5" />字幕轨</button>
                <button type="button" onClick={() => addTrack('text')} className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs text-white/80"><Plus className="h-3.5 w-3.5" />文本轨</button>
            </div>

            <div
                ref={bodyRef}
                className="min-h-0 flex-1 overflow-auto rounded-2xl border border-white/10 bg-[#0f1013]"
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDropAsset}
            >
                <div style={{ width: contentWidth, minHeight: RULER_HEIGHT + rowOffsets.reduce((sum, row) => sum + row.height, 0) }}>
                    <div className="sticky top-0 z-20 flex h-[38px] border-b border-white/10 bg-[#141519]">
                        <div className="flex w-[184px] items-center px-4 text-[11px] uppercase tracking-[0.2em] text-white/35">Tracks</div>
                        <div
                            className="relative flex-1 cursor-pointer"
                            onPointerDown={(event) => {
                                setDragState({
                                    mode: 'playhead',
                                    pointerId: event.pointerId,
                                    startClientX: event.clientX,
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
                        </div>
                    </div>

                    {rowOffsets.map(({ track, top, height }) => {
                        const TrackIcon = kindIcon(track.kind);
                        const rowItems = project.items
                            .filter((item) => item.trackId === track.id)
                            .slice()
                            .sort((left, right) => left.fromMs - right.fromMs);
                        return (
                            <div key={track.id} className="relative flex border-b border-white/[0.06]" style={{ height }}>
                                <div
                                    className={clsx(
                                        'sticky left-0 z-10 flex w-[184px] shrink-0 items-center justify-between gap-2 border-r border-white/10 px-3',
                                        selectedTrackIds.includes(track.id) ? 'bg-cyan-400/10' : 'bg-[#141519]'
                                    )}
                                    onClick={() => onSelectionChange({ itemIds: [], primaryItemId: null, trackIds: [track.id] })}
                                >
                                    <div className="flex min-w-0 items-center gap-2">
                                        <TrackIcon className="h-4 w-4 text-white/65" />
                                        <div className="min-w-0">
                                            <div className="truncate text-xs font-medium text-white">{track.name}</div>
                                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">{track.kind}</div>
                                        </div>
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
                                <div className={clsx('relative flex-1', selectedTrackIds.includes(track.id) && 'bg-cyan-400/[0.04]')}>
                                    {rowItems.map((item) => {
                                        const preview = dragPreview?.[item.id] || null;
                                        const effectiveFromMs = preview?.fromMs ?? item.fromMs;
                                        const effectiveDurationMs = preview?.durationMs ?? item.durationMs;
                                        const left = (effectiveFromMs / 1000) * pixelsPerSecond;
                                        const width = Math.max(28, (effectiveDurationMs / 1000) * pixelsPerSecond);
                                        const selected = selectedItemIds.includes(item.id);
                                        return (
                                            <div
                                                key={item.id}
                                                className={clsx(
                                                    'absolute top-1.5 bottom-1.5 rounded-xl border text-left shadow-[0_6px_16px_rgba(0,0,0,0.18)] transition-shadow',
                                                    itemToneClass(item, assetMap),
                                                    dragPreview?.[item.id] && 'z-10 shadow-[0_10px_28px_rgba(0,0,0,0.26)]',
                                                    selected && 'ring-1 ring-white/70'
                                                )}
                                                style={{ left, width }}
                                                onPointerDown={(event) => {
                                                    if (track.ui.locked) return;
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
                                                        initialItems: project.items
                                                            .filter((candidate) => nextSelection.includes(candidate.id))
                                                            .map((candidate) => ({
                                                                id: candidate.id,
                                                                fromMs: candidate.fromMs,
                                                                durationMs: candidate.durationMs,
                                                                trimInMs: candidate.type === 'media' ? candidate.trimInMs : 0,
                                                            })),
                                                    });
                                                }}
                                                onDoubleClick={() => onSeekTimeMs(item.fromMs)}
                                            >
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
                                                                    initialItems: [{
                                                                        id: item.id,
                                                                        fromMs: item.fromMs,
                                                                        durationMs: item.durationMs,
                                                                        trimInMs: isMediaItem(item) ? item.trimInMs : 0,
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
                                                                    initialItems: [{
                                                                        id: item.id,
                                                                        fromMs: item.fromMs,
                                                                        durationMs: item.durationMs,
                                                                        trimInMs: isMediaItem(item) ? item.trimInMs : 0,
                                                                    }],
                                                                });
                                                            }}
                                                        />
                                                    </>
                                                ) : null}
                                                <div className="truncate px-3 py-2 text-xs font-medium text-white">
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

            {activeTrack ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/75">
                    <span>{activeTrack.name}</span>
                    <button type="button" onClick={() => onApplyCommands([{ type: 'reorder_tracks', trackId: activeTrack.id, direction: 'up' }])} className="rounded-full border border-white/10 px-3 py-1">上移</button>
                    <button type="button" onClick={() => onApplyCommands([{ type: 'reorder_tracks', trackId: activeTrack.id, direction: 'down' }])} className="rounded-full border border-white/10 px-3 py-1">下移</button>
                    <button type="button" onClick={() => deleteSelected()} className="rounded-full border border-red-400/20 bg-red-400/10 px-3 py-1 text-red-100">删除轨道</button>
                </div>
            ) : null}

            {selectedItems.length > 0 ? (
                <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/65">
                    已选 {selectedItems.length} 项
                </div>
            ) : null}
        </div>
    );
}
