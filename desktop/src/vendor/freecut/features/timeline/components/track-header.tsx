import { memo } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { AudioLines, FoldHorizontal, GripVertical, Link2, Lock, Power, PowerOff, Radio, Rows, Type, Video } from 'lucide-react';
import type { TimelineTrack } from '@/types/timeline';
import { useTrackDrag } from '../hooks/use-track-drag';
import { TIMELINE_SIDEBAR_WIDTH } from '../constants';
import { EDITOR_LAYOUT_CSS_VALUES } from '@/shared/ui/editor-layout';
import { useItemsStore } from '../stores/items-store';
import { getTrackKind } from '@/features/timeline/utils/classic-tracks';
import { isTrackSyncLockActive } from '../utils/track-sync-lock';

interface TrackHeaderProps {
  track: TimelineTrack;
  isActive: boolean;
  isSelected: boolean;
  canDeleteTrack: boolean;
  canDeleteEmptyTracks: boolean;
  onToggleLock: () => void;
  onToggleSyncLock: () => void;
  onToggleDisabled: () => void;
  onToggleSolo: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onCloseGaps?: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  onDeleteTrack: () => void;
  onDeleteEmptyTracks: () => void;
}

/**
 * Custom equality for TrackHeader memo - ignores callback props which are recreated each render
 */
function areTrackHeaderPropsEqual(prev: TrackHeaderProps, next: TrackHeaderProps): boolean {
  return (
    prev.track === next.track &&
    prev.isActive === next.isActive &&
    prev.isSelected === next.isSelected &&
    prev.canDeleteTrack === next.canDeleteTrack &&
    prev.canDeleteEmptyTracks === next.canDeleteEmptyTracks
  );
  // Callbacks (onToggleLock, etc.) are ignored - they're recreated each render but functionality is same
}

/**
 * Track Header Component
 *
 * Displays track name, controls, and handles selection.
 * Shows active state with background color.
 * Supports group tracks with collapse/expand and indentation.
 * Right-click context menu for track actions.
 * Memoized to prevent re-renders when props haven't changed.
 */
export const TrackHeader = memo(function TrackHeader({
  track,
  isActive,
  isSelected,
  canDeleteTrack,
  canDeleteEmptyTracks,
  onToggleLock,
  onToggleSyncLock,
  onToggleDisabled,
  onToggleSolo,
  onSelect,
  onCloseGaps,
  onAddVideoTrack,
  onAddAudioTrack,
  onDeleteTrack,
  onDeleteEmptyTracks,
}: TrackHeaderProps) {
  const itemCount = useItemsStore((s) => s.itemsByTrackId[track.id]?.length ?? 0);
  const trackKind = getTrackKind(track);
  const syncLockEnabled = isTrackSyncLockActive(track);
  const isTrackDisabled = trackKind === 'audio'
    ? track.muted
    : trackKind === 'video'
      ? track.visible === false
      : track.visible === false || track.muted;

  // Use track drag hook (visuals handled centrally by timeline.tsx via DOM)
  const { handleDragStart } = useTrackDrag(track);
  const itemCountLabel = `${itemCount} ${itemCount === 1 ? 'Clip' : 'Clips'}`;
  const TrackKindIcon = trackKind === 'audio'
    ? AudioLines
    : trackKind === 'text' || trackKind === 'subtitle'
      ? Type
      : trackKind === 'motion'
        ? Rows
        : Video;
  const trackKindLabel = trackKind === 'audio'
    ? 'Audio'
    : trackKind === 'text'
      ? 'Text'
      : trackKind === 'subtitle'
        ? 'Sub'
        : trackKind === 'motion'
          ? 'FX'
          : 'Video';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`
            track-header-item group relative flex flex-col overflow-hidden rounded-[14px] border px-1.5 py-1.5
            cursor-grab active:cursor-grabbing
            ${isSelected ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-secondary/50 hover:border-border/70'}
            ${isActive ? 'shadow-[inset_2px_0_0_rgba(255,140,58,0.95)]' : ''}
            transition-[background-color,border-color,box-shadow] duration-150
          `}
          style={{
            height: `${track.height}px`,
            // content-visibility optimization for long track lists (rendering-content-visibility)
            contentVisibility: 'auto',
            containIntrinsicSize: `${TIMELINE_SIDEBAR_WIDTH}px ${track.height}px`,
          }}
          onClick={onSelect}
          onMouseDown={handleDragStart}
          data-track-id={track.id}
          data-track-header
          data-track-kind={trackKind}
          data-active={isActive}
          data-selected={isSelected}
        >
          <div
            className="flex h-6 shrink-0 items-center gap-0.5 overflow-hidden rounded-[10px] border border-border/50 bg-background/35 px-0.5"
            data-track-header-controls
          >
            <div className="flex h-5 w-4 shrink-0 items-center justify-center">
              <GripVertical className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
            </div>
            {/* Disable Button */}
            <Button
              variant="ghost"
              size="icon"
              className="rounded hover:bg-secondary"
              style={{ width: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize, height: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleDisabled();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={isTrackDisabled ? 'Enable track' : 'Disable track'}
              data-tooltip={isTrackDisabled ? 'Enable track' : 'Disable track'}
            >
              {isTrackDisabled ? (
                <PowerOff className="w-3 h-3 text-primary" />
              ) : (
                <Power className="w-3 h-3 opacity-70" />
              )}
            </Button>

            {/* Solo Button */}
            <Button
              variant="ghost"
              size="icon"
              className="rounded hover:bg-secondary"
              style={{ width: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize, height: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSolo();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={track.solo ? 'Unsolo track' : 'Solo track'}
              data-tooltip={track.solo ? 'Unsolo track' : 'Solo track'}
            >
              <Radio
                className={`w-3 h-3 ${track.solo ? 'text-primary' : ''}`}
              />
            </Button>

            {/* Lock Button */}
            <Button
              variant="ghost"
              size="icon"
              className="rounded hover:bg-secondary"
              style={{ width: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize, height: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleLock();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={track.locked ? 'Unlock track' : 'Lock track'}
              data-tooltip={track.locked ? 'Unlock track' : 'Lock track'}
            >
              <Lock
                className={`w-3 h-3 ${track.locked ? 'text-primary' : 'opacity-70'}`}
              />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="rounded hover:bg-secondary"
              style={{ width: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize, height: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSyncLock();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={syncLockEnabled ? 'Disable sync lock' : 'Enable sync lock'}
              data-tooltip={syncLockEnabled ? 'Disable sync lock' : 'Enable sync lock'}
            >
              <Link2
                className={`w-3 h-3 ${syncLockEnabled ? 'text-primary' : 'opacity-70'}`}
              />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="rounded hover:bg-secondary"
              style={{ width: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize, height: EDITOR_LAYOUT_CSS_VALUES.toolbarButtonSize }}
              onClick={(e) => {
                e.stopPropagation();
                onCloseGaps?.();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Close all gaps"
              data-tooltip="Close all gaps"
            >
              <FoldHorizontal className="w-3 h-3" />
            </Button>
          </div>

          <div className="flex min-h-0 flex-1 items-center gap-2 overflow-hidden px-1 pt-1" data-track-header-body>
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border border-border/60 bg-background/55"
              data-track-kind-icon
            >
              <TrackKindIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold leading-none font-mono">
                  {track.name}
                </span>
                <span
                  className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
                  data-track-kind-badge
                >
                  {trackKindLabel}
                </span>
              </div>
              <div className="mt-1 text-[10px] leading-none text-muted-foreground">
                {itemCountLabel}
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={onCloseGaps}>
          Close All Gaps
        </ContextMenuItem>

        <ContextMenuSeparator />
        <ContextMenuItem onClick={onAddVideoTrack}>
          Add Video Track
        </ContextMenuItem>
        <ContextMenuItem onClick={onAddAudioTrack}>
          Add Audio Track
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canDeleteTrack} onClick={onDeleteTrack}>
          Delete Track
        </ContextMenuItem>
        <ContextMenuItem disabled={!canDeleteEmptyTracks} onClick={onDeleteEmptyTracks}>
          Delete Empty Tracks
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}, areTrackHeaderPropsEqual);
