import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Plus, Scissors, Trash2 } from 'lucide-react';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
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
};

type TimelineActionShape = {
    id: string;
    start: number;
    end: number;
    effectId: string;
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
    onCursorTimeChange?: (time: number) => void;
    onSelectedClipChange?: (clipId: string | null) => void;
};

export type EditableTrackTimelineHandle = {
    setCursorTime: (time: number) => void;
};

const DEFAULT_CLIP_MS = 4000;
const MIN_CLIP_MS = 1000;
const SCALE_WIDTH = 72;
const START_LEFT = 60;
const TIMELINE_HEADER_HEIGHT = 40;
const TIMELINE_ROW_HEIGHT = 64;

const TIMELINE_EFFECTS = {
    video: { id: 'video', name: 'Video' },
    audio: { id: 'audio', name: 'Audio' },
    image: { id: 'image', name: 'Image' },
    default: { id: 'default', name: 'Clip' },
} as const;

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
    if (durationMs > 0) return Math.max(MIN_CLIP_MS, durationMs);
    return DEFAULT_CLIP_MS;
}

function getEffectId(assetKind: unknown): string {
    const normalized = String(assetKind || '').trim().toLowerCase();
    if (normalized === 'video') return 'video';
    if (normalized === 'audio') return 'audio';
    if (normalized === 'image') return 'image';
    return 'default';
}

function formatSeconds(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const totalSeconds = Math.round(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainSeconds = totalSeconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, '0')}`;
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
    onCursorTimeChange,
    onSelectedClipChange,
}, ref) {
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const timelineRef = useRef<TimelineState | null>(null);
    const normalizedClips = useMemo(() => clips.map((item) => item as TimelineClipSummary), [clips]);
    const externalRows = useMemo(
        () => buildTimelineRows(normalizedClips, fallbackTracks),
        [fallbackTracks, normalizedClips]
    );
    const externalSignature = useMemo(() => serializeRows(externalRows), [externalRows]);
    const [editorRows, setEditorRows] = useState<TimelineRowShape[]>(externalRows);
    const [isPersisting, setIsPersisting] = useState(false);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [cursorTime, setCursorTime] = useState(0);
    const [isDraggingAsset, setIsDraggingAsset] = useState(false);
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        clipId: string;
    } | null>(null);

    const clipById = useMemo(() => {
        const map = new Map<string, TimelineClipSummary>();
        normalizedClips.forEach((clip, index) => {
            const trackName = String(clip.track || '').trim() || fallbackTracks[0] || 'V1';
            map.set(getClipId(clip, trackName, index), clip);
        });
        return map;
    }, [fallbackTracks, normalizedClips]);

    useEffect(() => {
        setEditorRows(externalRows);
    }, [externalRows, externalSignature]);

    useEffect(() => {
        if (!selectedClipId) return;
        if (!clipById.has(selectedClipId)) {
            setSelectedClipId(null);
        }
    }, [clipById, selectedClipId]);

    useEffect(() => {
        onSelectedClipChange?.(selectedClipId);
    }, [onSelectedClipChange, selectedClipId]);

    useEffect(() => {
        onCursorTimeChange?.(cursorTime);
    }, [cursorTime, onCursorTimeChange]);

    useEffect(() => {
        if (!Number.isFinite(controlledCursorTime ?? NaN)) return;
        const nextTime = Number(controlledCursorTime);
        if (Math.abs(nextTime - cursorTime) < 0.05) return;
        timelineRef.current?.setTime(nextTime);
        setCursorTime(nextTime);
    }, [controlledCursorTime, cursorTime]);

    useImperativeHandle(ref, () => ({
        setCursorTime: (time: number) => {
            if (!Number.isFinite(time)) return;
            timelineRef.current?.setTime(time);
            setCursorTime(time);
        },
    }), []);

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
                        MIN_CLIP_MS,
                        Math.round(Math.max(0.1, action.end - action.start) * 1000)
                    );
                    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
                        filePath,
                        clipId: action.id,
                        assetId: String(originalClip.assetId || ''),
                        track: row.id,
                        order: index,
                        durationMs: nextDurationMs,
                        trimInMs: normalizeNumber(originalClip.trimInMs, 0),
                        trimOutMs: normalizeNumber(originalClip.trimOutMs, 0),
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
        const timer = window.setTimeout(() => {
            void persistRows(editorRows);
        }, 220);
        return () => window.clearTimeout(timer);
    }, [editorRows, externalSignature, persistRows]);

    const handleAddTrack = useCallback(async (kind: 'video' | 'audio') => {
        if (!filePath) return;
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:add-package-track', {
                filePath,
                kind,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to add package track:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [filePath, onPackageStateChange]);

    const handleDeleteSelectedClip = useCallback(async () => {
        if (!filePath || !selectedClipId) return;
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                filePath,
                clipId: selectedClipId,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
                setSelectedClipId(null);
            }
        } catch (error) {
            console.error('Failed to delete selected clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [filePath, onPackageStateChange, selectedClipId]);

    const handleSplitSelectedClip = useCallback(async () => {
        if (!filePath || !selectedClipId) return;
        const selectedAction = editorRows.flatMap((row) => row.actions).find((action) => action.id === selectedClipId);
        if (!selectedAction) return;
        const actionStart = Number(selectedAction.start || 0);
        const actionEnd = Number(selectedAction.end || 0);
        const actionDuration = Math.max(0.1, actionEnd - actionStart);
        const relativeCursor = cursorTime > actionStart && cursorTime < actionEnd
            ? (cursorTime - actionStart) / actionDuration
            : 0.5;
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
    }, [cursorTime, editorRows, filePath, onPackageStateChange, selectedClipId]);

    const handleDeleteClipById = useCallback(async (clipId: string) => {
        if (!filePath || !clipId) return;
        setIsPersisting(true);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
                filePath,
                clipId,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
                setSelectedClipId((current) => (current === clipId ? null : current));
            }
        } catch (error) {
            console.error('Failed to delete selected clip:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [filePath, onPackageStateChange]);

    const handleSplitClipAtCursor = useCallback(async (clipId: string, splitAtTime?: number) => {
        if (!filePath || !clipId) return;
        const selectedAction = editorRows.flatMap((row) => row.actions).find((action) => action.id === clipId);
        if (!selectedAction) return;
        const actionStart = Number(selectedAction.start || 0);
        const actionEnd = Number(selectedAction.end || 0);
        const actionDuration = Math.max(0.1, actionEnd - actionStart);
        const activeTime = typeof splitAtTime === 'number' ? splitAtTime : cursorTime;
        const relativeCursor = activeTime > actionStart && activeTime < actionEnd
            ? (activeTime - actionStart) / actionDuration
            : 0.5;
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
    }, [cursorTime, editorRows, filePath, onPackageStateChange]);

    const handleToggleSelectedClip = useCallback(async () => {
        if (!filePath || !selectedClipId) return;
        const clip = clipById.get(selectedClipId);
        const currentRow = editorRows.find((row) => row.actions.some((action) => action.id === selectedClipId));
        if (!clip || !currentRow) return;
        const order = [...currentRow.actions].findIndex((action) => action.id === selectedClipId);
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
    }, [clipById, editorRows, filePath, onPackageStateChange, selectedClipId]);

    const handleAssetDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDraggingAsset(false);
        const assetId = event.dataTransfer.getData('application/x-redbox-asset-id');
        if (!assetId || !bodyRef.current || !filePath) return;

        const rect = bodyRef.current.getBoundingClientRect();
        const relativeY = event.clientY - rect.top - TIMELINE_HEADER_HEIGHT;
        const rowIndex = Math.max(0, Math.min(Math.floor(relativeY / TIMELINE_ROW_HEIGHT), Math.max(editorRows.length - 1, 0)));
        const targetRow = editorRows[rowIndex] || editorRows[0];
        if (!targetRow) return;

        const relativeX = Math.max(0, event.clientX - rect.left - START_LEFT);
        const dropTime = Math.max(0, relativeX / SCALE_WIDTH);
        const sortedActions = [...targetRow.actions].sort((a, b) => a.start - b.start);
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
                track: targetRow.id,
                order: desiredOrder,
            }) as { success?: boolean; state?: Record<string, unknown> };
            if (result?.success && result.state) {
                onPackageStateChange?.(result.state);
            }
        } catch (error) {
            console.error('Failed to add clip from drag-and-drop:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [editorRows, filePath, onPackageStateChange]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tagName = target?.tagName?.toLowerCase();
            const isTyping =
                tagName === 'input' ||
                tagName === 'textarea' ||
                !!target?.isContentEditable;
            if (isTyping) return;

            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClipId) {
                event.preventDefault();
                void handleDeleteClipById(selectedClipId);
                return;
            }

            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && selectedClipId) {
                event.preventDefault();
                void handleSplitClipAtCursor(selectedClipId);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleDeleteClipById, handleSplitClipAtCursor, selectedClipId]);

    const selectedClip = selectedClipId ? clipById.get(selectedClipId) : null;

    return (
        <div className={clsx('redbox-editable-timeline', accent === 'emerald' ? 'redbox-editable-timeline--emerald' : 'redbox-editable-timeline--cyan')}>
            <div className="redbox-editable-timeline__toolbar">
                <div className="redbox-editable-timeline__toolbar-left">
                    <div className="redbox-editable-timeline__toolbar-label">时间轴</div>
                    <div className="redbox-editable-timeline__toolbar-meta">
                        <span>{normalizedClips.length} 个片段</span>
                        <span>{editorRows.length} 条轨道</span>
                        <span>{isPersisting ? '保存中…' : '已同步'}</span>
                    </div>
                </div>
                <div className="redbox-editable-timeline__toolbar-actions">
                    <button type="button" className="redbox-editable-timeline__button" onClick={() => handleAddTrack('video')}>
                        <Plus size={14} />
                        视频轨
                    </button>
                    <button type="button" className="redbox-editable-timeline__button" onClick={() => handleAddTrack('audio')}>
                        <Plus size={14} />
                        音频轨
                    </button>
                    <button type="button" className="redbox-editable-timeline__button" onClick={handleSplitSelectedClip} disabled={!selectedClipId}>
                        <Scissors size={14} />
                        剪切
                    </button>
                    <button type="button" className="redbox-editable-timeline__button" onClick={handleDeleteSelectedClip} disabled={!selectedClipId}>
                        <Trash2 size={14} />
                        删除
                    </button>
                    <button type="button" className="redbox-editable-timeline__button" onClick={handleToggleSelectedClip} disabled={!selectedClipId}>
                        {selectedClip?.enabled === false ? '启用片段' : '禁用片段'}
                    </button>
                </div>
            </div>
            <div
                ref={bodyRef}
                className={clsx('redbox-editable-timeline__body', isDraggingAsset && 'redbox-editable-timeline__body--dragging')}
                onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingAsset(true);
                }}
                onDragEnter={(event) => {
                    event.preventDefault();
                    setIsDraggingAsset(true);
                }}
                onDragLeave={(event) => {
                    if (!bodyRef.current?.contains(event.relatedTarget as Node | null)) {
                        setIsDraggingAsset(false);
                    }
                }}
                onDrop={handleAssetDrop}
            >
                <Timeline
                    ref={timelineRef as any}
                    style={{ width: '100%', height: '100%' }}
                    editorData={editorRows as any}
                    effects={TIMELINE_EFFECTS as any}
                    scale={1}
                    scaleSplitCount={4}
                    scaleWidth={SCALE_WIDTH}
                    startLeft={START_LEFT}
                    rowHeight={TIMELINE_ROW_HEIGHT}
                    gridSnap={true}
                    dragLine={true}
                    enableRowDrag={false}
                    autoScroll={true}
                    onChange={(nextRows) => {
                        setEditorRows(cloneRows(nextRows as TimelineRowShape[]));
                    }}
                    onCursorDrag={(time) => setCursorTime(Number(time || 0))}
                    onClickTimeArea={(time) => {
                        setCursorTime(Number(time || 0));
                        return true;
                    }}
                    onClickActionOnly={(_, param) => {
                        setSelectedClipId(String(param.action?.id || '').trim() || null);
                        setCursorTime(Number(param.time || 0));
                    }}
                    onContextMenuAction={(event, param) => {
                        event.preventDefault();
                        const nextClipId = String(param.action?.id || '').trim();
                        if (!nextClipId) return;
                        setSelectedClipId(nextClipId);
                        setCursorTime(Number(param.time || 0));
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            clipId: nextClipId,
                        });
                    }}
                    getScaleRender={(scale) => (
                        <div className="redbox-editable-timeline__scale-label">{formatSeconds(Number(scale || 0))}</div>
                    )}
                    getActionRender={(action) => {
                        const clip = clipById.get(String(action.id || '').trim());
                        const visibleDurationSeconds = Math.max(0.1, Number(action.end || 0) - Number(action.start || 0));
                        const kind = String(clip?.assetKind || '').trim().toLowerCase();
                        const typeLabel = kind === 'audio' ? '音频' : kind === 'image' ? '图片' : kind === 'video' ? '视频' : '片段';
                        return (
                            <div
                                className={clsx(
                                    'redbox-editable-timeline__clip',
                                    kind === 'audio' && 'redbox-editable-timeline__clip--audio',
                                    kind === 'video' && 'redbox-editable-timeline__clip--video',
                                    kind === 'image' && 'redbox-editable-timeline__clip--image',
                                    selectedClipId === action.id && 'redbox-editable-timeline__clip--selected'
                                )}
                                onMouseDown={() => setContextMenu(null)}
                            >
                                <div className="redbox-editable-timeline__clip-title">
                                    {String(clip?.name || action.id || '片段')}
                                </div>
                                <div className="redbox-editable-timeline__clip-meta">
                                    <span>{typeLabel}</span>
                                    <span>{formatSeconds(visibleDurationSeconds)}</span>
                                    {action.disable ? <span>禁用</span> : null}
                                </div>
                            </div>
                        );
                    }}
                />
                {normalizedClips.length === 0 ? (
                    <div className="redbox-editable-timeline__empty">
                        <div className="redbox-editable-timeline__empty-title">{emptyLabel}</div>
                        <div className="redbox-editable-timeline__empty-subtitle">把左侧素材直接拖到底部轨道里，就能开始基础剪辑。</div>
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
                                setSelectedClipId(contextMenu.clipId);
                            }}
                        >
                            选中片段
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
});
