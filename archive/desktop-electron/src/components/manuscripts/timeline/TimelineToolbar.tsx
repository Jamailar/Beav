import { AudioLines, Eye, EyeOff, Lock, Minus, Pause, Play, Plus, Scissors, Search, SkipBack, SkipForward, Trash2, Type, Unlock, Video } from 'lucide-react';
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
    onToggleTrackVisibility: () => void;
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
    trackVisibilityDisabled: boolean;
    trackVisibilityLabel: string;
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
    iconOnly?: boolean;
};

function ToolbarActionButton({
    icon: Icon,
    label,
    title,
    onClick,
    disabled = false,
    ghost = false,
    compactLabel = true,
    iconOnly = false,
}: ToolbarActionButtonProps) {
    return (
        <button
            type="button"
            className={`redbox-editable-timeline__button${ghost ? ' redbox-editable-timeline__button--ghost' : ''}${iconOnly ? ' redbox-editable-timeline__button--icon-only' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title || label}
            aria-label={title || label}
        >
            {Icon ? <Icon size={14} /> : null}
            {!iconOnly ? (
                <span className={compactLabel ? 'redbox-editable-timeline__button-label redbox-editable-timeline__button-label--compact' : 'redbox-editable-timeline__button-label'}>
                    {label}
                </span>
            ) : null}
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
    onToggleTrackVisibility,
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
    trackVisibilityDisabled,
    trackVisibilityLabel,
    trackLockDisabled,
    trackLockLabel,
    trackMuteDisabled,
    trackMuteLabel,
}: TimelineToolbarProps) {
    const toggleShortLabel = toggleLabel.includes('禁用') ? '禁用' : '启用';
    return (
        <div className="redbox-editable-timeline__toolbar">
            <div className="redbox-editable-timeline__toolbar-group redbox-editable-timeline__toolbar-group--compact">
                <div className="redbox-editable-timeline__toolbar-strip">
                    <ToolbarActionButton icon={Video} label="新增视频轨" title="新增视频轨" onClick={onAddVideoTrack} iconOnly />
                    <ToolbarActionButton icon={AudioLines} label="新增音频轨" title="新增音频轨" onClick={onAddAudioTrack} iconOnly />
                    <ToolbarActionButton icon={Type} label="新增字幕轨" title="新增字幕轨" onClick={onAddSubtitleTrack} iconOnly />
                    <div className="redbox-editable-timeline__toolbar-divider" />
                    <ToolbarActionButton icon={Search} label="定位游标" title="定位游标" onClick={onFocusCursor} iconOnly />
                    <ToolbarActionButton icon={Scissors} label="剪切" title="剪切片段 (Cmd/Ctrl+B)" onClick={onSplit} disabled={splitDisabled} iconOnly />
                    <ToolbarActionButton icon={Trash2} label="删除" title="删除片段" onClick={onDelete} disabled={deleteDisabled} iconOnly />
                    <ToolbarActionButton label={toggleShortLabel} title={toggleLabel} onClick={onToggleClipEnabled} disabled={toggleDisabled} compactLabel={false} />
                    <div className="redbox-editable-timeline__toolbar-divider" />
                    <ToolbarActionButton icon={Minus} label="缩小时间轴" title="缩小时间轴 (Cmd/Ctrl+-)" onClick={onZoomOut} iconOnly />
                    <ToolbarActionButton label="100%" title="缩放重置 (Cmd/Ctrl+0)" onClick={onZoomReset} compactLabel={false} />
                    <ToolbarActionButton icon={Plus} label="放大时间轴" title="放大时间轴 (Cmd/Ctrl++)" onClick={onZoomIn} iconOnly />
                </div>
                <div className="redbox-editable-timeline__toolbar-readout">
                    <span className="redbox-editable-timeline__toolbar-readout-time">{currentTimeLabel}</span>
                    <span className="redbox-editable-timeline__toolbar-readout-divider">/</span>
                    <span>{totalTimeLabel}</span>
                </div>
                <div className="redbox-editable-timeline__toolbar-strip redbox-editable-timeline__toolbar-strip--right">
                    {canUseTransport ? (
                        <>
                            <ToolbarActionButton icon={SkipBack} label="后退一秒" title="后退 1 秒 (Shift+←)" onClick={() => onStepFrame?.(-stepFramesPerSecond)} disabled={!onStepFrame} iconOnly />
                            <ToolbarActionButton icon={playing ? Pause : Play} label={playing ? '暂停' : '播放'} title={playing ? '暂停 (Space)' : '播放 (Space)'} onClick={() => onTogglePlayback?.()} disabled={!onTogglePlayback} iconOnly />
                            <ToolbarActionButton icon={SkipForward} label="前进一秒" title="前进 1 秒 (Shift+→)" onClick={() => onStepFrame?.(stepFramesPerSecond)} disabled={!onStepFrame} iconOnly />
                            <div className="redbox-editable-timeline__toolbar-divider" />
                        </>
                    ) : null}
                    <ToolbarActionButton icon={trackVisibilityLabel.includes('显示') ? Eye : EyeOff} label={trackVisibilityLabel} title={trackVisibilityLabel} onClick={onToggleTrackVisibility} disabled={trackVisibilityDisabled} iconOnly />
                    <ToolbarActionButton icon={trackLockLabel.includes('解锁') ? Unlock : Lock} label={trackLockLabel} title={trackLockLabel} onClick={onToggleTrackLock} disabled={trackLockDisabled} iconOnly />
                    <ToolbarActionButton label={trackMuteLabel.includes('取消') ? '静音开' : '静音关'} title={trackMuteLabel} onClick={onToggleTrackMute} disabled={trackMuteDisabled} compactLabel={false} />
                    <ToolbarActionButton icon={Trash2} label="删除轨道" title="删除当前轨道" onClick={onDeleteTrack} disabled={deleteTrackDisabled} iconOnly />
                    <div className="redbox-editable-timeline__toolbar-meta redbox-editable-timeline__toolbar-meta--inline">
                        <span>{clipCount} 段</span>
                        <span>{trackCount} 轨</span>
                        <span>{zoomPercent}%</span>
                        <span>{isPersisting ? '保存中' : '已同步'}</span>
                    </div>
                </div>
            </div>
            {(selectedClipLabel || activeTrackLabel || layerLabel) ? (
                <div className="redbox-editable-timeline__toolbar-selection-strip">
                    {selectedClipLabel ? <span>{selectedClipLabel}</span> : null}
                    {activeTrackLabel ? <span>{activeTrackLabel}</span> : null}
                    {layerLabel ? <span>{layerLabel}</span> : null}
                </div>
            ) : null}
        </div>
    );
}
