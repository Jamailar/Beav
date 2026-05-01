import { randomUUID } from 'node:crypto';
import type {
  AutoEditPlan,
  EditDecision,
  SrtSegment,
  TranscriptTrack,
  VideoTimelineClip,
  VideoTimelineV2,
} from '../../../shared/videoAutoEdit';

type SegmentGroup = {
  id: string;
  segments: SrtSegment[];
};

function durationMs(startMs: number, endMs: number): number {
  return Math.max(1, Math.round(endMs - startMs));
}

function groupSelectedSegments(segments: SrtSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const segment of segments) {
    const previous = groups[groups.length - 1];
    const previousSegment = previous?.segments[previous.segments.length - 1];
    if (previous && previousSegment && segment.startMs - previousSegment.endMs <= 500) {
      previous.segments.push(segment);
      continue;
    }
    groups.push({
      id: `group_${groups.length + 1}_${randomUUID().slice(0, 8)}`,
      segments: [segment],
    });
  }
  return groups;
}

export function buildTimelineFromAutoEditPlan(input: {
  transcript: TranscriptTrack;
  plan: AutoEditPlan;
}): {
  timeline: VideoTimelineV2;
  decisions: EditDecision[];
} {
  const selectedIds = new Set(input.plan.selectedSegments.map((item) => item.segmentId));
  const selectedSegments = input.transcript.segments
    .filter((segment) => selectedIds.has(segment.id))
    .sort((left, right) => left.startMs - right.startMs);
  const groups = groupSelectedSegments(selectedSegments);
  const decisions: EditDecision[] = [];
  const primaryClips: VideoTimelineClip[] = [];
  const subtitleClips: VideoTimelineClip[] = [];
  let cursorMs = 0;

  const addTitleCard = (titleCard: AutoEditPlan['titleCards'][number]) => {
    const text = String(titleCard.text || '').trim();
    if (!text) return;
    const duration = Math.max(500, Math.round(Number(titleCard.durationMs || 0) || 1200));
    const clipId = `title_card_${randomUUID().slice(0, 8)}`;
    primaryClips.push({
      id: clipId,
      sourceStartMs: 0,
      sourceEndMs: duration,
      timelineStartMs: cursorMs,
      timelineEndMs: cursorMs + duration,
      text,
      style: {
        subtitlePreset: 'title-card',
      },
    });
    decisions.push({
      id: `decision_${clipId}`,
      kind: 'title-card',
      segmentIds: titleCard.afterSegmentId ? [titleCard.afterSegmentId] : [],
      reason: '自动剪辑计划生成片头卡',
    });
    cursorMs += duration;
  };

  for (const titleCard of input.plan.titleCards.filter((item) => !item.afterSegmentId)) {
    addTitleCard(titleCard);
  }

  for (const group of groups) {
    const first = group.segments[0];
    const last = group.segments[group.segments.length - 1];
    const sourceStartMs = Math.max(0, first.startMs - 120);
    const sourceEndMs = last.endMs + 120;
    const clipDurationMs = durationMs(sourceStartMs, sourceEndMs);
    const timelineStartMs = cursorMs;
    const timelineEndMs = cursorMs + clipDurationMs;
    const clipId = `clip_${group.id}`;

    primaryClips.push({
      id: clipId,
      assetId: input.transcript.assetId,
      transcriptSegmentIds: group.segments.map((segment) => segment.id),
      sourceStartMs,
      sourceEndMs,
      timelineStartMs,
      timelineEndMs,
      playbackRate: 1,
    });

    for (const segment of group.segments) {
      const subtitleStartMs = timelineStartMs + Math.max(0, segment.startMs - sourceStartMs);
      const subtitleEndMs = timelineStartMs + Math.max(1, segment.endMs - sourceStartMs);
      subtitleClips.push({
        id: `subtitle_${segment.id}`,
        assetId: input.transcript.assetId,
        transcriptSegmentIds: [segment.id],
        sourceStartMs: segment.startMs,
        sourceEndMs: segment.endMs,
        timelineStartMs: subtitleStartMs,
        timelineEndMs: subtitleEndMs,
        text: segment.text,
      });
    }

    decisions.push({
      id: `decision_keep_${group.id}`,
      kind: group.segments.length > 1 ? 'merge' : 'keep',
      segmentIds: group.segments.map((segment) => segment.id),
      reason: group.segments.length > 1 ? '相邻字幕间隔较短，合并为一个粗剪片段' : '保留为粗剪片段',
    });

    cursorMs = timelineEndMs;

    for (const titleCard of input.plan.titleCards.filter((item) => {
      return item.afterSegmentId && group.segments.some((segment) => segment.id === item.afterSegmentId);
    })) {
      addTitleCard(titleCard);
    }
  }

  for (const removed of input.plan.removedSegments) {
    decisions.push({
      id: `decision_remove_${removed.segmentId}`,
      kind: 'remove',
      segmentIds: [removed.segmentId],
      reason: removed.reason,
    });
  }

  return {
    timeline: {
      id: `timeline_auto_${Date.now()}`,
      durationMs: cursorMs,
      tracks: [
        {
          id: 'track_primary_video',
          kind: 'primary-video',
          name: '主视频',
          clips: primaryClips,
        },
        {
          id: 'track_subtitle',
          kind: 'subtitle',
          name: '字幕',
          clips: subtitleClips,
        },
      ],
    },
    decisions,
  };
}
