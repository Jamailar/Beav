import { Lock, Minus, Pause, Play, Plus, Scissors, Search, SkipBack, SkipForward, Trash2, Unlock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type TimelineToolbarProps = {
    clipCount: number;
    trackCount: number;
    isPersisting: boolean;
    selectedClipLabel?: string | null;
    activeTrackLabel?: string | null;
    cursorLabel: string;
    totalLabel: string;
    zoomPercent: number;
    canUseTransport: boolean;
    playing: boolean;
    currentTimeLabel: string;
    totalTimeLabel: string;
    boundedFrame: number;
    maxFrame: number;
    onSeekFrame?: (frame: number) => void;
    stepFramesPerSecond: number;
    onStepFrame?: (deltaFrames: number) => void;
    onTogglePlayback?: () => void;
    onZoomOut: () => void;
    onZoomReset: () => void;
    onZoomFit: () => void;
    onZoomIn: () => void;
    onFocusCursor: () => void;
    onFocusSelection: () => void;
    onJumpSelectionStart: () => void;
    onJumpSelectionEnd: () => void;
    onAddVideoTrack: () => void;
    onAddAudioTrack: () => void;
    onAddSubtitleTrack: () => void;
    onMoveSelectionToPrevTrack: () => void;
    onMoveSelectionToNextTrack: () => void;
    onMoveTrackUp: () => void;
    onMoveTrackDown: () => void;
    onDeleteTrack: () => void;
    onToggleTrackLock: () => void;
    onToggleTrackMute: () => void;
    onToggleLayerVisibility?: () => void;
    onToggleLayerLock?: () => void;
    onBringLayerFront?: () => void;
    onSendLayerBack?: () => void;
    onSplit: () => void;
    onDelete: () => void;
    onToggleClipEnabled: () => void;
    splitDisabled: boolean;
    deleteDisabled: boolean;
    toggleDisabled: boolean;
    toggleLabel: string;
    layerLabel?: string | null;
    layerVisibilityDisabled?: boolean;
    layerVisibilityLabel?: string;
    layerLockDisabled?: boolean;
    layerLockLabel?: string;
    layerOrderDisabled?: boolean;
    selectionNavDisabled: boolean;
    moveSelectionTrackDisabled: boolean;
    moveTrackDisabled: boolean;
    deleteTrackDisabled: boolean;
    trackLockDisabled: boolean;
    trackLockLabel: string;
    trackMuteDisabled: boolean;
    trackMuteLabel: string;
};

type ToolbarActionButtonProps = {
    icon?: LucideIcon;
    label: string;
    title?: string;
    onClick: () => void;
    disabled?: boolean;
    ghost?: boolean;
    compactLabel?: boolean;
};

function ToolbarActionButton({
    icon: Icon,
    label,
    title,
    onClick,
    disabled = false,
    ghost = false,
    compactLabel = true,
}: ToolbarActionButtonProps) {
    return (
        <button
            type="button"
            className={`redbox-editable-timeline__button${ghost ? ' redbox-editable-timeline__button--ghost' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title || label}
            aria-label={title || label}
        >
            {Icon ? <Icon size={14} /> : null}
            <span className={compactLabel ? 'redbox-editable-timeline__button-label redbox-editable-timeline__button-label--compact' : 'redbox-editable-timeline__button-label'}>
                {label}
            </span>
        </button>
    );
}

export function TimelineToolbar({
    clipCount,
    trackCount,
    isPersisting,
    selectedClipLabel,
    activeTrackLabel,
    cursorLabel,
    totalLabel,
    zoomPercent,
    canUseTransport,
    playing,
    currentTimeLabel,
    totalTimeLabel,
    boundedFrame,
    maxFrame,
    onSeekFrame,
    stepFramesPerSecond,
    onStepFrame,
    onTogglePlayback,
    onZoomOut,
    onZoomReset,
    onZoomFit,
    onZoomIn,
    onFocusCursor,
    onFocusSelection,
    onJumpSelectionStart,
    onJumpSelectionEnd,
    onAddVideoTrack,
    onAddAudioTrack,
    onAddSubtitleTrack,
    onMoveSelectionToPrevTrack,
    onMoveSelectionToNextTrack,
    onMoveTrackUp,
    onMoveTrackDown,
    onDeleteTrack,
    onToggleTrackLock,
    onToggleTrackMute,
    onToggleLayerVisibility,
    onToggleLayerLock,
    onBringLayerFront,
    onSendLayerBack,
    onSplit,
    onDelete,
    onToggleClipEnabled,
    splitDisabled,
    deleteDisabled,
    toggleDisabled,
    toggleLabel,
    layerLabel,
    layerVisibilityDisabled = true,
    layerVisibilityLabel = '切换图层显隐',
    layerLockDisabled = true,
    layerLockLabel = '切换图层锁定',
    layerOrderDisabled = true,
    selectionNavDisabled,
    moveSelectionTrackDisabled,
    moveTrackDisabled,
    deleteTrackDisabled,
    trackLockDisabled,
    trackLockLabel,
    trackMuteDisabled,
    trackMuteLabel,
}: TimelineToolbarProps) {
    const toggleShortLabel = toggleLabel.includes('禁用') ? '禁用' : '启用';
    return (
        <div className="redbox-editable-timeline__toolbar">
            <div className="redbox-editable-timeline__toolbar-group redbox-editable-timeline__toolbar-group--left">
                <div className="redbox-editable-timeline__toolbar-meta redbox-editable-timeline__toolbar-meta--dense">
                    <span>时间轴</span>
                    <span>{clipCount} 段</span>
                    <span>{trackCount} 轨</span>
                    <span>{isPersisting ? '保存中' : '已同步'}</span>
                </div>
                <div className="redbox-editable-timeline__toolbar-action-row">
                    <ToolbarActionButton icon={Scissors} label="剪切" title="剪切片段 (Cmd/Ctrl+B)" onClick={onSplit} disabled={splitDisabled} ghost />
                    <ToolbarActionButton icon={Trash2} label="删除" title="删除片段" onClick={onDelete} disabled={deleteDisabled} ghost />
                    <ToolbarActionButton label={toggleShortLabel} title={toggleLabel} onClick={onToggleClipEnabled} disabled={toggleDisabled} ghost />
                </div>
            </div>
            {canUseTransport ? (
                <div className="redbox-editable-timeline__toolbar-group redbox-editable-timeline__toolbar-group--center">
                    <div className="redbox-editable-timeline__transport">
                        <button
                            type="button"
                            className="redbox-editable-timeline__icon-button"
                            onClick={() => onStepFrame?.(-stepFramesPerSecond)}
                            disabled={!onStepFrame}
                            title="后退 1 秒 (Shift+←)"
                        >
                            <SkipBack size={14} />
                        </button>
                        <button
                            type="button"
                            className="redbox-editable-timeline__play-button"
                            onClick={() => onTogglePlayback?.()}
                            disabled={!onTogglePlayback}
                            title={playing ? '暂停 (Space)' : '播放 (Space)'}
                        >
                            {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
                        </button>
                        <button
                            type="button"
                            className="redbox-editable-timeline__icon-button"
                            onClick={() => onStepFrame?.(stepFramesPerSecond)}
                            disabled={!onStepFrame}
                            title="前进 1 秒 (Shift+→)"
                        >
                            <SkipForward size={14} />
                        </button>
                        <div className="redbox-editable-timeline__transport-time">
                            <span className="redbox-editable-timeline__transport-time-current">{currentTimeLabel}</span>
                            <span className="redbox-editable-timeline__transport-time-divider">|</span>
                            <span>{totalTimeLabel}</span>
                        </div>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(1, maxFrame)}
                        value={boundedFrame}
                        onChange={(event) => onSeekFrame?.(Number(event.target.value || 0))}
                        disabled={!onSeekFrame || maxFrame <= 0}
                        className="redbox-editable-timeline__transport-slider"
                    />
                </div>
            ) : null}
            <div className="redbox-editable-timeline__toolbar-group redbox-editable-timeline__toolbar-group--right">
                <div className="redbox-editable-timeline__toolbar-chips">
                    <div className="redbox-editable-timeline__toolbar-chip">
                        游标 {cursorLabel}
                    </div>
                    <div className="redbox-editable-timeline__toolbar-chip">
                        总长 {totalLabel}
                    </div>
                    <div className="redbox-editable-timeline__toolbar-chip">
                        {zoomPercent}%
                    </div>
                    {selectedClipLabel ? (
                        <div className="redbox-editable-timeline__toolbar-chip redbox-editable-timeline__toolbar-chip--accent">
                            {selectedClipLabel}
                        </div>
                    ) : null}
                    {activeTrackLabel ? (
                        <div className="redbox-editable-timeline__toolbar-chip">
                            {activeTrackLabel}
                        </div>
                    ) : null}
                    {layerLabel ? (
                        <div className="redbox-editable-timeline__toolbar-chip redbox-editable-timeline__toolbar-chip--accent">
                            {layerLabel}
                        </div>
                    ) : null}
                </div>
                <div className="redbox-editable-timeline__toolbar-action-row redbox-editable-timeline__toolbar-action-row--wrap">
                    <ToolbarActionButton icon={Minus} label="缩小" title="缩小时间轴 (Cmd/Ctrl+-)" onClick={onZoomOut} />
                    <ToolbarActionButton label="100%" title="缩放重置 (Cmd/Ctrl+0)" onClick={onZoomReset} compactLabel={false} />
                    <ToolbarActionButton label="适配" title="适配时间轴 (Cmd/Ctrl+9)" onClick={onZoomFit} compactLabel={false} />
                    <ToolbarActionButton icon={Plus} label="放大" title="放大时间轴 (Cmd/Ctrl++)" onClick={onZoomIn} />
                    <ToolbarActionButton icon={Search} label="游标" title="定位游标" onClick={onFocusCursor} />
                    <ToolbarActionButton label="片段" title="定位选中片段" onClick={onFocusSelection} disabled={selectionNavDisabled} />
                    <ToolbarActionButton label="入点" title="跳到片段起点" onClick={onJumpSelectionStart} disabled={selectionNavDisabled} />
                    <ToolbarActionButton label="出点" title="跳到片段终点" onClick={onJumpSelectionEnd} disabled={selectionNavDisabled} />
                    <ToolbarActionButton label="图层显隐" title={layerVisibilityLabel} onClick={() => onToggleLayerVisibility?.()} disabled={layerVisibilityDisabled || !onToggleLayerVisibility} />
                    <ToolbarActionButton label="图层锁定" title={layerLockLabel} onClick={() => onToggleLayerLock?.()} disabled={layerLockDisabled || !onToggleLayerLock} />
                    <ToolbarActionButton label="置前" title="将当前图层置前" onClick={() => onBringLayerFront?.()} disabled={layerOrderDisabled || !onBringLayerFront} />
                    <ToolbarActionButton label="置后" title="将当前图层置后" onClick={() => onSendLayerBack?.()} disabled={layerOrderDisabled || !onSendLayerBack} />
                    <ToolbarActionButton label="上轨" title="将选中片段移动到上一条同类轨道" onClick={onMoveSelectionToPrevTrack} disabled={moveSelectionTrackDisabled} />
                    <ToolbarActionButton label="下轨" title="将选中片段移动到下一条同类轨道" onClick={onMoveSelectionToNextTrack} disabled={moveSelectionTrackDisabled} />
                    <ToolbarActionButton icon={trackLockLabel.includes('解锁') ? Unlock : Lock} label={trackLockLabel.includes('解锁') ? '解锁' : '锁轨'} title={trackLockLabel} onClick={onToggleTrackLock} disabled={trackLockDisabled} />
                    <ToolbarActionButton label={trackMuteLabel.includes('取消') ? '取消静音' : '静音'} title={trackMuteLabel} onClick={onToggleTrackMute} disabled={trackMuteDisabled} />
                    <ToolbarActionButton label="轨上" title="激活轨道上移" onClick={onMoveTrackUp} disabled={moveTrackDisabled} />
                    <ToolbarActionButton label="轨下" title="激活轨道下移" onClick={onMoveTrackDown} disabled={moveTrackDisabled} />
                    <ToolbarActionButton icon={Trash2} label="删轨" title="删除激活轨道（仅空轨）" onClick={onDeleteTrack} disabled={deleteTrackDisabled} />
                    <ToolbarActionButton icon={Plus} label="视频" title="新增视频轨" onClick={onAddVideoTrack} />
                    <ToolbarActionButton icon={Plus} label="音频" title="新增音频轨" onClick={onAddAudioTrack} />
                    <ToolbarActionButton icon={Plus} label="字幕" title="新增字幕轨" onClick={onAddSubtitleTrack} />
                </div>
            </div>
        </div>
    );
}
