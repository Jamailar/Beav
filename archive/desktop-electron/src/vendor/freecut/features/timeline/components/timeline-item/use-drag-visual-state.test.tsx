import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRef } from 'react';
import type { VideoItem } from '@/types/timeline';
import { useSelectionStore } from '@/shared/state/selection';
import { useItemsStore } from '../../stores/items-store';
import { dragOffsetRef, dragPreviewOffsetByItemRef } from '../../hooks/use-timeline-drag';
import { useDragVisualState } from './use-drag-visual-state';

function makeVideoItem(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id: 'item-1',
    type: 'video',
    trackId: 'track-1',
    from: 20,
    durationInFrames: 30,
    label: 'clip.mp4',
    src: 'blob:test',
    mediaId: 'media-1',
    ...overrides,
  };
}

function DragVisualHarness({
  item,
  isDragging = false,
}: {
  item: VideoItem;
  isDragging?: boolean;
}) {
  const transformRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragVisualState = useDragVisualState({
    item,
    gestureMode: 'none',
    isDragging,
    transformRef,
    ghostRef,
  });

  return (
    <>
      <div data-testid="body" ref={transformRef} />
      <div data-testid="ghost" ref={ghostRef} />
      <div data-testid="join-state">
        {String(dragVisualState.dragAffectsJoin.left)}
        :
        {String(dragVisualState.dragAffectsJoin.right)}
      </div>
    </>
  );
}

function setDragState(itemIds: string[], isAltDrag = false) {
  act(() => {
    useSelectionStore.getState().setDragState({
      isDragging: true,
      draggedItemIds: itemIds,
      offset: { x: 0, y: 0 },
      isAltDrag,
    });
  });
}

describe('useDragVisualState', () => {
  beforeEach(() => {
    useItemsStore.getState().setItems([]);
    useItemsStore.getState().setTracks([]);
    useSelectionStore.getState().clearSelection();
    useSelectionStore.getState().setDragState(null);
    useSelectionStore.getState().setActiveTool('select');
    dragOffsetRef.current = { x: 0, y: 0 };
    dragPreviewOffsetByItemRef.current = {};
  });

  it('shows join indicators when adjacent items are dragged and clears them afterward', () => {
    const left = makeVideoItem({ id: 'left', from: 0 });
    const item = makeVideoItem({ id: 'item-1', from: 30 });
    const right = makeVideoItem({ id: 'right', from: 60 });
    useItemsStore.getState().setItems([left, item, right]);

    render(<DragVisualHarness item={item} />);

    expect(screen.getByTestId('join-state')).toHaveTextContent('false:false');

    setDragState(['left']);
    expect(screen.getByTestId('join-state')).toHaveTextContent('true:false');

    setDragState(['right']);
    expect(screen.getByTestId('join-state')).toHaveTextContent('false:true');

    act(() => {
      useSelectionStore.getState().setDragState(null);
    });
    expect(screen.getByTestId('join-state')).toHaveTextContent('false:false');
  });

  it('applies follower transforms during move drags and cleans them up when the drag ends', async () => {
    const item = makeVideoItem();
    render(<DragVisualHarness item={item} />);

    dragOffsetRef.current = { x: 18, y: 6 };
    setDragState([item.id]);

    const body = screen.getByTestId('body');
    await waitFor(() => {
      expect(body.style.transform).toBe('translate(18px, 6px)');
      expect(body.style.opacity).toBe('0.8');
      expect(body.style.pointerEvents).toBe('none');
      expect(body.style.zIndex).toBe('50');
    });

    act(() => {
      useSelectionStore.getState().setDragState(null);
    });

    await waitFor(() => {
      expect(body.style.transform).toBe('');
      expect(body.style.opacity).toBe('');
      expect(body.style.pointerEvents).toBe('');
      expect(body.style.zIndex).toBe('');
    });
  });

  it('uses the ghost element for alt drags instead of moving the item body', async () => {
    const item = makeVideoItem();
    render(<DragVisualHarness item={item} />);

    dragPreviewOffsetByItemRef.current = {
      [item.id]: { x: 11, y: 7 },
    };
    setDragState([item.id], true);

    const body = screen.getByTestId('body');
    const ghost = screen.getByTestId('ghost');
    await waitFor(() => {
      expect(body.style.transform).toBe('');
      expect(body.style.opacity).toBe('');
      expect(body.style.pointerEvents).toBe('none');
      expect(ghost.style.display).toBe('block');
      expect(ghost.style.transform).toBe('translate(11px, 7px)');
    });
  });
});
