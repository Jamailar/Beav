import { describe, expect, it } from 'vitest';
import type { TimelineItem, TimelineTrack } from '@/types/timeline';
import { findCompatibleTrackForItemType } from './track-item-compatibility';

function makeTrack(id: string, order: number, kind: 'video' | 'audio'): TimelineTrack {
  return {
    id,
    name: id,
    kind,
    order,
    height: 64,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    items: [],
  };
}

describe('findCompatibleTrackForItemType', () => {
  it('can fall back to a compatible track by default', () => {
    const tracks = [
      makeTrack('video-1', 0, 'video'),
      makeTrack('audio-1', 1, 'audio'),
    ];

    expect(findCompatibleTrackForItemType({
      tracks,
      items: [],
      itemType: 'text',
      preferredTrackId: 'audio-1',
    })?.id).toBe('video-1');
  });

  it('does not fall back when strict preferred track matching is requested', () => {
    const tracks = [
      makeTrack('video-1', 0, 'video'),
      makeTrack('audio-1', 1, 'audio'),
    ];

    expect(findCompatibleTrackForItemType({
      tracks,
      items: [] as TimelineItem[],
      itemType: 'text',
      preferredTrackId: 'audio-1',
      allowPreferredTrackFallback: false,
    })).toBeNull();
  });
});
