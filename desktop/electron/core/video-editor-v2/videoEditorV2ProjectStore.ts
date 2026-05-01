import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getWorkspacePaths } from '../../db';
import type {
  MediaAssetRecord,
  SrtSegment,
  SrtSegmentTag,
  TranscriptTrack,
  AutoEditRunRecord,
  VideoCanvasSpec,
  VideoEditorV2AssetKind,
  VideoEditorV2Project,
  VideoEditorV2UndoRecord,
  VideoTimelineClip,
  VideoTimelineV2,
} from '../../../shared/videoAutoEdit';
import { normalizeSrtSegments, parseSrt, serializeSegmentsToSrt } from '../video-auto-edit/srtParser';
import { buildHeuristicAutoEditPlan } from '../video-auto-edit/autoEditPlanner';
import { buildTimelineFromAutoEditPlan } from '../video-auto-edit/editDecisionEngine';
import { probeMediaAsset } from '../video-auto-edit/mediaProbeService';

const PROJECTS_DIR_NAME = 'video-editor-v2';
const PROJECT_FILE_NAME = 'project.json';
const MAX_UNDO_RECORDS = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStorePath(value: string): string {
  return String(value || '').replace(/\\/g, '/');
}

function getMediaRootDir(): string {
  const paths = getWorkspacePaths() as ReturnType<typeof getWorkspacePaths> & { media?: string };
  return paths.media || path.join(paths.base, 'media');
}

function getProjectsRootDir(): string {
  return path.join(getMediaRootDir(), PROJECTS_DIR_NAME);
}

function getProjectDir(projectId: string): string {
  return path.join(getProjectsRootDir(), projectId);
}

function getProjectFilePath(projectId: string): string {
  return path.join(getProjectDir(projectId), PROJECT_FILE_NAME);
}

function defaultCanvas(): VideoCanvasSpec {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    aspectRatio: '16:9',
  };
}

function defaultProject(input: {
  id: string;
  title: string;
  sourceManuscriptPath?: string | null;
  projectDir: string;
}): VideoEditorV2Project {
  const createdAt = nowIso();
  return {
    version: 1,
    id: input.id,
    title: input.title || '未命名剪辑项目',
    sourceManuscriptPath: input.sourceManuscriptPath || null,
    projectDir: input.projectDir,
    createdAt,
    updatedAt: createdAt,
    status: 'draft',
    canvas: defaultCanvas(),
    assets: [],
    transcriptTracks: [],
    timeline: {
      id: `timeline_${input.id}`,
      durationMs: 0,
      tracks: [
        { id: 'track_primary_video', kind: 'primary-video', name: '主视频', clips: [] },
        { id: 'track_subtitle', kind: 'subtitle', name: '字幕', clips: [] },
      ],
    },
    autoEditRuns: [],
    undoStack: [],
    remotionSnapshot: null,
    renderOutputs: [],
    lastError: null,
  };
}

async function ensureProjectDirs(projectId: string): Promise<void> {
  const root = getProjectDir(projectId);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'proxy'), { recursive: true });
  await fs.mkdir(path.join(root, 'thumbs'), { recursive: true });
  await fs.mkdir(path.join(root, 'subtitles'), { recursive: true });
  await fs.mkdir(path.join(root, 'analysis'), { recursive: true });
  await fs.mkdir(path.join(root, 'remotion'), { recursive: true });
  await fs.mkdir(path.join(root, 'renders'), { recursive: true });
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

function enrichProject(project: VideoEditorV2Project): VideoEditorV2Project {
  const projectDir = getProjectDir(project.id);
  return {
    ...project,
    projectDir,
    autoEditRuns: project.autoEditRuns || [],
    undoStack: project.undoStack || [],
    renderOutputs: project.renderOutputs || [],
    assets: (project.assets || []).map((asset) => ({
      ...asset,
      relativePath: normalizeStorePath(asset.relativePath),
      projectPath: path.isAbsolute(asset.projectPath)
        ? asset.projectPath
        : path.join(projectDir, normalizeStorePath(asset.relativePath || asset.projectPath)),
    })),
    transcriptTracks: (project.transcriptTracks || []).map((track) => ({
      ...track,
      sourceSrtPath: path.isAbsolute(track.sourceSrtPath) ? track.sourceSrtPath : path.join(projectDir, normalizeStorePath(track.sourceSrtPath)),
      normalizedJsonPath: path.isAbsolute(track.normalizedJsonPath) ? track.normalizedJsonPath : path.join(projectDir, normalizeStorePath(track.normalizedJsonPath)),
      editedSrtPath: track.editedSrtPath
        ? (path.isAbsolute(track.editedSrtPath) ? track.editedSrtPath : path.join(projectDir, normalizeStorePath(track.editedSrtPath)))
        : null,
    })),
  };
}

function pushTimelineUndo(project: VideoEditorV2Project, label: string): VideoEditorV2Project {
  const record: VideoEditorV2UndoRecord = {
    id: `undo_${Date.now()}_${randomUUID().slice(0, 8)}`,
    createdAt: nowIso(),
    label,
    timeline: project.timeline,
    autoEditRuns: project.autoEditRuns || [],
  };
  return {
    ...project,
    undoStack: [
      record,
      ...(project.undoStack || []),
    ].slice(0, MAX_UNDO_RECORDS),
  };
}

function inferAssetKind(filePath: string): VideoEditorV2AssetKind {
  const ext = path.extname(filePath).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext)) return 'audio';
  return 'image';
}

function syncTimelineSubtitleText(timeline: VideoTimelineV2, segment: SrtSegment): VideoTimelineV2 {
  let changed = false;
  const tracks = timeline.tracks.map((track) => {
    if (track.kind !== 'subtitle') return track;
    const clips = track.clips.map((clip) => {
      if (!(clip.transcriptSegmentIds || []).includes(segment.id)) return clip;
      changed = true;
      return {
        ...clip,
        text: segment.text,
      };
    });
    return { ...track, clips };
  });
  return changed ? { ...timeline, tracks } : timeline;
}

function dedupeTags(tags: SrtSegmentTag[]): SrtSegmentTag[] {
  return Array.from(new Set(tags));
}

async function persistTranscriptTrack(track: TranscriptTrack): Promise<void> {
  await writeJsonAtomic(track.normalizedJsonPath, track.segments);
  if (track.editedSrtPath) {
    await fs.writeFile(track.editedSrtPath, serializeSegmentsToSrt(track.segments), 'utf-8');
  }
}

function syncTimelineMergedSegments(timeline: VideoTimelineV2, mergedIds: Set<string>, mergedSegment: SrtSegment): VideoTimelineV2 {
  let changed = false;
  const tracks = timeline.tracks.map((track) => {
    if (track.kind !== 'subtitle') {
      const clips = track.clips.map((clip) => {
        const ids = clip.transcriptSegmentIds || [];
        if (!ids.some((id) => mergedIds.has(id))) return clip;
        changed = true;
        return {
          ...clip,
          transcriptSegmentIds: Array.from(new Set(ids.map((id) => mergedIds.has(id) ? mergedSegment.id : id))),
        };
      });
      return { ...track, clips };
    }

    const affected = track.clips.filter((clip) => (clip.transcriptSegmentIds || []).some((id) => mergedIds.has(id)));
    if (affected.length === 0) return track;
    changed = true;
    const timelineStartMs = Math.min(...affected.map((clip) => clip.timelineStartMs));
    const timelineEndMs = Math.max(...affected.map((clip) => clip.timelineEndMs));
    const clips = [
      ...track.clips.filter((clip) => !(clip.transcriptSegmentIds || []).some((id) => mergedIds.has(id))),
      {
        ...affected[0],
        id: `subtitle_${mergedSegment.id}`,
        assetId: mergedSegment.assetId,
        transcriptSegmentIds: [mergedSegment.id],
        sourceStartMs: mergedSegment.startMs,
        sourceEndMs: mergedSegment.endMs,
        timelineStartMs,
        timelineEndMs,
        text: mergedSegment.text,
      },
    ].sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
    return { ...track, clips };
  });
  return changed ? { ...timeline, tracks } : timeline;
}

function syncTimelineSplitSegment(timeline: VideoTimelineV2, original: SrtSegment, first: SrtSegment, second: SrtSegment): VideoTimelineV2 {
  let changed = false;
  const splitRatio = Math.max(0.05, Math.min(0.95, (first.endMs - original.startMs) / Math.max(1, original.endMs - original.startMs)));
  const tracks = timeline.tracks.map((track) => {
    if (track.kind !== 'subtitle') {
      const clips = track.clips.map((clip) => {
        const ids = clip.transcriptSegmentIds || [];
        if (!ids.includes(original.id)) return clip;
        changed = true;
        const nextIds: string[] = [];
        for (const id of ids) {
          nextIds.push(id);
          if (id === original.id && !nextIds.includes(second.id)) {
            nextIds.push(second.id);
          }
        }
        return {
          ...clip,
          transcriptSegmentIds: nextIds,
        };
      });
      return { ...track, clips };
    }

    const clips = track.clips.flatMap((clip) => {
      if (!(clip.transcriptSegmentIds || []).includes(original.id)) return [clip];
      changed = true;
      const splitTimelineMs = Math.round(clip.timelineStartMs + ((clip.timelineEndMs - clip.timelineStartMs) * splitRatio));
      return [
        {
          ...clip,
          assetId: first.assetId,
          transcriptSegmentIds: [first.id],
          sourceStartMs: first.startMs,
          sourceEndMs: first.endMs,
          timelineEndMs: Math.max(clip.timelineStartMs + 1, splitTimelineMs),
          text: first.text,
        },
        {
          ...clip,
          id: `subtitle_${second.id}`,
          assetId: second.assetId,
          transcriptSegmentIds: [second.id],
          sourceStartMs: second.startMs,
          sourceEndMs: second.endMs,
          timelineStartMs: Math.max(clip.timelineStartMs + 1, splitTimelineMs),
          timelineEndMs: clip.timelineEndMs,
          text: second.text,
        },
      ];
    }).sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
    return { ...track, clips };
  });
  return changed ? { ...timeline, tracks } : timeline;
}

function setTimelineClipDisabled(timeline: VideoTimelineV2, clipId: string, disabled: boolean): VideoTimelineV2 {
  let changed = false;
  let linkedSegmentIds = new Set<string>();
  const tracksWithPrimaryUpdated = timeline.tracks.map((track) => {
    const clips = track.clips.map((clip) => {
      if (clip.id !== clipId) return clip;
      changed = true;
      if (track.kind === 'primary-video') {
        linkedSegmentIds = new Set(clip.transcriptSegmentIds || []);
      }
      return {
        ...clip,
        disabled,
      };
    });
    return { ...track, clips };
  });
  const tracks = linkedSegmentIds.size === 0
    ? tracksWithPrimaryUpdated
    : tracksWithPrimaryUpdated.map((track) => {
      if (track.kind !== 'subtitle') return track;
      return {
        ...track,
        clips: track.clips.map((clip) => {
          if (!(clip.transcriptSegmentIds || []).some((id) => linkedSegmentIds.has(id))) return clip;
          changed = true;
          return {
            ...clip,
            disabled,
          };
        }),
      };
    });
  return changed ? { ...timeline, tracks } : timeline;
}

function calculateTimelineDuration(timeline: VideoTimelineV2): number {
  return Math.max(0, ...timeline.tracks.flatMap((track) => track.clips.map((clip) => Math.max(0, clip.timelineEndMs))));
}

function appendAssetsToBaselineTimeline(timeline: VideoTimelineV2, assets: MediaAssetRecord[]): VideoTimelineV2 {
  const timelineAssets = assets.filter((asset) => asset.kind === 'video' || asset.kind === 'audio');
  if (timelineAssets.length === 0) return timeline;

  const existingPrimaryTrack = timeline.tracks.find((track) => track.kind === 'primary-video');
  const existingClipAssetIds = new Set((existingPrimaryTrack?.clips || [])
    .map((clip) => clip.assetId)
    .filter((assetId): assetId is string => Boolean(assetId)));
  const nextAssets = timelineAssets.filter((asset) => !existingClipAssetIds.has(asset.id));
  if (nextAssets.length === 0) return timeline;

  let cursorMs = Math.max(calculateTimelineDuration(timeline), ...(existingPrimaryTrack?.clips || []).map((clip) => clip.timelineEndMs));
  const appendedClips: VideoTimelineClip[] = nextAssets.map((asset) => {
    const durationMs = Math.max(1000, Math.round(Number(asset.durationMs || 0) || 3000));
    const clip: VideoTimelineClip = {
      id: `baseline_${asset.id}`,
      assetId: asset.id,
      sourceStartMs: 0,
      sourceEndMs: durationMs,
      timelineStartMs: cursorMs,
      timelineEndMs: cursorMs + durationMs,
      playbackRate: 1,
      text: asset.title,
    };
    cursorMs += durationMs;
    return clip;
  });

  let hasPrimaryTrack = false;
  const tracks = timeline.tracks.map((track) => {
    if (track.kind !== 'primary-video') return track;
    hasPrimaryTrack = true;
    return {
      ...track,
      clips: [
        ...track.clips,
        ...appendedClips,
      ].sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs),
    };
  });
  if (!hasPrimaryTrack) {
    tracks.unshift({
      id: 'track_primary_video',
      kind: 'primary-video',
      name: '主视频',
      clips: appendedClips,
    });
  }
  if (!tracks.some((track) => track.kind === 'subtitle')) {
    tracks.push({ id: 'track_subtitle', kind: 'subtitle', name: '字幕', clips: [] });
  }

  const nextTimeline = {
    ...timeline,
    tracks,
  };
  return {
    ...nextTimeline,
    durationMs: calculateTimelineDuration(nextTimeline),
  };
}

function trimLinkedSubtitleClip(input: {
  clip: VideoTimelineClip;
  edge: 'start' | 'end';
  trimMs: number;
  oldTargetStartMs: number;
  oldTargetEndMs: number;
  newTargetEndMs: number;
}): VideoTimelineClip {
  const { clip, edge, trimMs, oldTargetStartMs, newTargetEndMs } = input;
  if (edge === 'start') {
    const removedTimelineEndMs = oldTargetStartMs + trimMs;
    if (clip.timelineEndMs <= removedTimelineEndMs) {
      return {
        ...clip,
        disabled: true,
        timelineStartMs: oldTargetStartMs,
        timelineEndMs: oldTargetStartMs + 1,
        sourceStartMs: Math.min(clip.sourceEndMs, clip.sourceStartMs + Math.max(0, clip.timelineEndMs - clip.timelineStartMs)),
      };
    }
    const sourceTrimMs = Math.max(0, removedTimelineEndMs - clip.timelineStartMs);
    const nextStartMs = Math.max(oldTargetStartMs, clip.timelineStartMs - trimMs);
    const nextEndMs = Math.min(newTargetEndMs, Math.max(nextStartMs + 1, clip.timelineEndMs - trimMs));
    return {
      ...clip,
      sourceStartMs: Math.min(clip.sourceEndMs - 1, clip.sourceStartMs + sourceTrimMs),
      timelineStartMs: nextStartMs,
      timelineEndMs: nextEndMs,
      disabled: nextEndMs - nextStartMs <= 1 ? true : clip.disabled,
    };
  }

  if (clip.timelineStartMs >= newTargetEndMs) {
    return {
      ...clip,
      disabled: true,
      timelineStartMs: newTargetEndMs,
      timelineEndMs: newTargetEndMs + 1,
      sourceEndMs: Math.max(clip.sourceStartMs, clip.sourceStartMs + 1),
    };
  }
  const nextEndMs = Math.min(clip.timelineEndMs, newTargetEndMs);
  const sourceTrimMs = Math.max(0, clip.timelineEndMs - nextEndMs);
  return {
    ...clip,
    sourceEndMs: Math.max(clip.sourceStartMs + 1, clip.sourceEndMs - sourceTrimMs),
    timelineEndMs: Math.max(clip.timelineStartMs + 1, nextEndMs),
    disabled: nextEndMs - clip.timelineStartMs <= 1 ? true : clip.disabled,
  };
}

function trimPrimaryTimelineClip(input: {
  timeline: VideoTimelineV2;
  clipId: string;
  edge: 'start' | 'end';
  deltaMs: number;
}): VideoTimelineV2 {
  const clipId = String(input.clipId || '').trim();
  const edge = input.edge;
  const requestedDeltaMs = Math.max(1, Math.round(Number(input.deltaMs || 0)));
  const minClipDurationMs = 500;
  const primaryTrack = input.timeline.tracks.find((track) => track.kind === 'primary-video');
  const targetClip = primaryTrack?.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    throw new Error('只能裁剪主视频时间线片段');
  }
  if (!targetClip.assetId) {
    throw new Error('标题卡等非素材片段暂不支持裁剪');
  }
  if (targetClip.disabled) {
    throw new Error('已删除的片段不能裁剪，请先恢复片段');
  }
  const targetDurationMs = targetClip.timelineEndMs - targetClip.timelineStartMs;
  const sourceDurationMs = targetClip.sourceEndMs - targetClip.sourceStartMs;
  const maxTrimMs = Math.min(targetDurationMs, sourceDurationMs) - minClipDurationMs;
  if (maxTrimMs < 1) {
    throw new Error('片段过短，无法继续裁剪');
  }
  const trimMs = Math.min(requestedDeltaMs, maxTrimMs);
  const oldTargetStartMs = targetClip.timelineStartMs;
  const oldTargetEndMs = targetClip.timelineEndMs;
  const newTargetEndMs = targetClip.timelineEndMs - trimMs;
  const linkedSegmentIds = new Set(targetClip.transcriptSegmentIds || []);

  const tracks = input.timeline.tracks.map((track) => {
    const clips = track.clips.map((clip) => {
      if (clip.id === clipId) {
        return {
          ...clip,
          sourceStartMs: edge === 'start' ? clip.sourceStartMs + trimMs : clip.sourceStartMs,
          sourceEndMs: edge === 'end' ? clip.sourceEndMs - trimMs : clip.sourceEndMs,
          timelineEndMs: newTargetEndMs,
        };
      }

      const isLinkedSubtitle = track.kind === 'subtitle'
        && linkedSegmentIds.size > 0
        && (clip.transcriptSegmentIds || []).some((id) => linkedSegmentIds.has(id));
      if (isLinkedSubtitle) {
        return trimLinkedSubtitleClip({
          clip,
          edge,
          trimMs,
          oldTargetStartMs,
          oldTargetEndMs,
          newTargetEndMs,
        });
      }

      if (clip.timelineStartMs >= oldTargetEndMs) {
        return {
          ...clip,
          timelineStartMs: Math.max(0, clip.timelineStartMs - trimMs),
          timelineEndMs: Math.max(1, clip.timelineEndMs - trimMs),
        };
      }
      return clip;
    }).sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
    return { ...track, clips };
  });
  const nextTimeline = { ...input.timeline, tracks };
  return {
    ...nextTimeline,
    durationMs: calculateTimelineDuration(nextTimeline),
  };
}

function distributeSplitSegmentIds(input: {
  timeline: VideoTimelineV2;
  originalClip: VideoTimelineClip;
  splitTimelineMs: number;
}): { firstIds: string[]; secondIds: string[] } {
  const originalIds = input.originalClip.transcriptSegmentIds || [];
  if (originalIds.length === 0) {
    return { firstIds: [], secondIds: [] };
  }
  const originalSet = new Set(originalIds);
  const firstIds = new Set<string>();
  const secondIds = new Set<string>();
  for (const track of input.timeline.tracks) {
    if (track.kind !== 'subtitle') continue;
    for (const clip of track.clips) {
      const ids = (clip.transcriptSegmentIds || []).filter((id) => originalSet.has(id));
      if (ids.length === 0) continue;
      for (const id of ids) {
        if (clip.timelineEndMs <= input.splitTimelineMs) {
          firstIds.add(id);
        } else if (clip.timelineStartMs >= input.splitTimelineMs) {
          secondIds.add(id);
        } else {
          firstIds.add(id);
          secondIds.add(id);
        }
      }
    }
  }
  if (firstIds.size === 0 && secondIds.size === 0) {
    return { firstIds: originalIds, secondIds: originalIds };
  }
  for (const id of originalIds) {
    if (!firstIds.has(id) && !secondIds.has(id)) {
      firstIds.add(id);
      secondIds.add(id);
    }
  }
  return {
    firstIds: originalIds.filter((id) => firstIds.has(id)),
    secondIds: originalIds.filter((id) => secondIds.has(id)),
  };
}

function splitPrimaryTimelineClip(input: {
  timeline: VideoTimelineV2;
  clipId: string;
  splitOffsetMs?: number;
}): VideoTimelineV2 {
  const clipId = String(input.clipId || '').trim();
  const primaryTrack = input.timeline.tracks.find((track) => track.kind === 'primary-video');
  const targetClip = primaryTrack?.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    throw new Error('只能拆分主视频时间线片段');
  }
  if (!targetClip.assetId) {
    throw new Error('标题卡等非素材片段暂不支持拆分');
  }
  if (targetClip.disabled) {
    throw new Error('已删除的片段不能拆分，请先恢复片段');
  }
  const durationMs = targetClip.timelineEndMs - targetClip.timelineStartMs;
  if (durationMs < 1000) {
    throw new Error('片段过短，无法拆分');
  }
  const requestedOffsetMs = Math.round(Number(input.splitOffsetMs || 0));
  const splitOffsetMs = requestedOffsetMs > 250 && requestedOffsetMs < durationMs - 250
    ? requestedOffsetMs
    : Math.round(durationMs / 2);
  const splitTimelineMs = targetClip.timelineStartMs + splitOffsetMs;
  const splitSourceMs = targetClip.sourceStartMs + splitOffsetMs;
  const { firstIds, secondIds } = distributeSplitSegmentIds({
    timeline: input.timeline,
    originalClip: targetClip,
    splitTimelineMs,
  });
  const tracks = input.timeline.tracks.map((track) => {
    if (track.kind !== 'primary-video') return track;
    const clips = track.clips.flatMap((clip) => {
      if (clip.id !== clipId) return [clip];
      return [
        {
          ...clip,
          transcriptSegmentIds: firstIds.length > 0 ? firstIds : clip.transcriptSegmentIds,
          sourceEndMs: splitSourceMs,
          timelineEndMs: splitTimelineMs,
        },
        {
          ...clip,
          id: `${clip.id}_split_${randomUUID().slice(0, 8)}`,
          transcriptSegmentIds: secondIds.length > 0 ? secondIds : clip.transcriptSegmentIds,
          sourceStartMs: splitSourceMs,
          timelineStartMs: splitTimelineMs,
        },
      ];
    }).sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
    return { ...track, clips };
  });
  const nextTimeline = { ...input.timeline, tracks };
  return {
    ...nextTimeline,
    durationMs: calculateTimelineDuration(nextTimeline),
  };
}

function overlapDurationMs(left: VideoTimelineClip, right: VideoTimelineClip): number {
  return Math.max(0, Math.min(left.timelineEndMs, right.timelineEndMs) - Math.max(left.timelineStartMs, right.timelineStartMs));
}

function findPrimaryOwnerForClip(primaryClips: VideoTimelineClip[], clip: VideoTimelineClip): VideoTimelineClip | null {
  const clipIds = new Set(clip.transcriptSegmentIds || []);
  let best: { clip: VideoTimelineClip; score: number } | null = null;
  for (const primaryClip of primaryClips) {
    const primaryIds = primaryClip.transcriptSegmentIds || [];
    const segmentScore = primaryIds.some((id) => clipIds.has(id)) ? 1000000 : 0;
    const score = segmentScore + overlapDurationMs(primaryClip, clip);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { clip: primaryClip, score };
    }
  }
  return best?.clip || null;
}

function reorderPrimaryTimelineClip(input: {
  timeline: VideoTimelineV2;
  clipId: string;
  targetClipId?: string;
  position?: 'before' | 'after';
  direction?: 'left' | 'right';
}): VideoTimelineV2 {
  const clipId = String(input.clipId || '').trim();
  const primaryTrack = input.timeline.tracks.find((track) => track.kind === 'primary-video');
  if (!primaryTrack) {
    throw new Error('主视频轨不存在');
  }
  const orderedPrimaryClips = [...primaryTrack.clips].sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
  const currentIndex = orderedPrimaryClips.findIndex((clip) => clip.id === clipId);
  if (currentIndex < 0) {
    throw new Error('Timeline clip not found');
  }
  let targetIndex = currentIndex;
  if (input.direction === 'left') {
    targetIndex = Math.max(0, currentIndex - 1);
  } else if (input.direction === 'right') {
    targetIndex = Math.min(orderedPrimaryClips.length - 1, currentIndex + 1);
  } else {
    const targetClipId = String(input.targetClipId || '').trim();
    const foundTargetIndex = orderedPrimaryClips.findIndex((clip) => clip.id === targetClipId);
    if (foundTargetIndex < 0) {
      throw new Error('Target timeline clip not found');
    }
    targetIndex = foundTargetIndex;
  }
  if (targetIndex === currentIndex) return input.timeline;

  const movingClip = orderedPrimaryClips[currentIndex];
  const withoutMoving = orderedPrimaryClips.filter((clip) => clip.id !== clipId);
  let insertIndex = targetIndex;
  if (input.direction === 'right') {
    insertIndex = targetIndex;
  } else if (input.position === 'after') {
    insertIndex = currentIndex < targetIndex ? targetIndex : targetIndex + 1;
  } else {
    insertIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
  }
  insertIndex = Math.max(0, Math.min(withoutMoving.length, insertIndex));
  const nextPrimaryClips = [
    ...withoutMoving.slice(0, insertIndex),
    movingClip,
    ...withoutMoving.slice(insertIndex),
  ];

  const deltaByPrimaryClipId = new Map<string, number>();
  let cursorMs = 0;
  const relaidPrimaryClips = nextPrimaryClips.map((clip) => {
    const durationMs = Math.max(1, clip.timelineEndMs - clip.timelineStartMs);
    const nextClip = {
      ...clip,
      timelineStartMs: cursorMs,
      timelineEndMs: cursorMs + durationMs,
    };
    deltaByPrimaryClipId.set(clip.id, nextClip.timelineStartMs - clip.timelineStartMs);
    cursorMs += durationMs;
    return nextClip;
  });
  const tracks = input.timeline.tracks.map((track) => {
    if (track.kind === 'primary-video') {
      return { ...track, clips: relaidPrimaryClips };
    }
    if (track.kind !== 'subtitle') return track;
    const clips = track.clips.map((clip) => {
      const owner = findPrimaryOwnerForClip(orderedPrimaryClips, clip);
      if (!owner) return clip;
      const deltaMs = deltaByPrimaryClipId.get(owner.id) || 0;
      return {
        ...clip,
        timelineStartMs: Math.max(0, clip.timelineStartMs + deltaMs),
        timelineEndMs: Math.max(1, clip.timelineEndMs + deltaMs),
      };
    }).sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
    return { ...track, clips };
  });
  const nextTimeline = { ...input.timeline, tracks };
  return {
    ...nextTimeline,
    durationMs: Math.max(cursorMs, calculateTimelineDuration(nextTimeline)),
  };
}

function splitTextByMidpoint(text: string): [string, string] {
  const normalized = String(text || '').trim();
  if (normalized.length <= 1) return [normalized, normalized];
  const midpoint = Math.floor(normalized.length / 2);
  const candidates = [
    normalized.lastIndexOf('，', midpoint),
    normalized.lastIndexOf('。', midpoint),
    normalized.lastIndexOf(',', midpoint),
    normalized.lastIndexOf('.', midpoint),
    normalized.lastIndexOf(' ', midpoint),
  ].filter((index) => index > 0);
  const splitIndex = candidates.length > 0 ? Math.max(...candidates) + 1 : midpoint;
  const first = normalized.slice(0, splitIndex).trim();
  const second = normalized.slice(splitIndex).trim();
  return [first || normalized.slice(0, midpoint).trim(), second || normalized.slice(midpoint).trim()];
}

function sanitizeFileBaseName(fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const normalized = base
    .normalize('NFKD')
    .replace(/[^\w\-.一-龥]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
  return normalized || `asset_${Date.now()}`;
}

async function quickFileHash(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  return createHash('sha1')
    .update(path.resolve(filePath))
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex');
}

export async function saveVideoEditorV2Project(project: VideoEditorV2Project): Promise<VideoEditorV2Project> {
  const next: VideoEditorV2Project = {
    ...project,
    version: 1,
    projectDir: getProjectDir(project.id),
    autoEditRuns: project.autoEditRuns || [],
    undoStack: project.undoStack || [],
    renderOutputs: project.renderOutputs || [],
    updatedAt: nowIso(),
  };
  await ensureProjectDirs(next.id);
  await writeJsonAtomic(getProjectFilePath(next.id), next);
  return enrichProject(next);
}

export async function getVideoEditorV2Project(projectId: string): Promise<VideoEditorV2Project | null> {
  const project = await readJsonIfExists<VideoEditorV2Project>(getProjectFilePath(projectId));
  if (!project || project.version !== 1) return null;
  return enrichProject(project);
}

export async function listVideoEditorV2Projects(): Promise<VideoEditorV2Project[]> {
  await fs.mkdir(getProjectsRootDir(), { recursive: true });
  const entries = await fs.readdir(getProjectsRootDir(), { withFileTypes: true }).catch(() => []);
  const projects = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => getVideoEditorV2Project(entry.name)));
  return projects
    .filter((project): project is VideoEditorV2Project => Boolean(project))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export async function createVideoEditorV2Project(input: {
  title?: string;
  sourceManuscriptPath?: string | null;
}): Promise<VideoEditorV2Project> {
  const id = `video_edit_v2_${Date.now()}_${randomUUID().slice(0, 8)}`;
  await ensureProjectDirs(id);
  const project = defaultProject({
    id,
    title: String(input.title || '').trim() || '未命名剪辑项目',
    sourceManuscriptPath: input.sourceManuscriptPath || null,
    projectDir: getProjectDir(id),
  });
  return saveVideoEditorV2Project(project);
}

export async function getOrCreateVideoEditorV2ProjectForManuscript(input: {
  manuscriptPath: string;
  title?: string;
}): Promise<VideoEditorV2Project> {
  const normalizedPath = normalizeStorePath(input.manuscriptPath);
  const existing = (await listVideoEditorV2Projects()).find((project) => normalizeStorePath(project.sourceManuscriptPath || '') === normalizedPath);
  if (existing) return existing;
  return createVideoEditorV2Project({
    title: input.title || path.basename(normalizedPath),
    sourceManuscriptPath: normalizedPath,
  });
}

export async function importAssetsToVideoEditorV2Project(projectId: string, sourcePaths: string[]): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  await ensureProjectDirs(projectId);
  const projectDir = getProjectDir(projectId);
  const probeCachePath = path.join(projectDir, 'analysis', 'probe-cache.json');

  const imported: MediaAssetRecord[] = [];
  for (const sourcePathRaw of sourcePaths) {
    const sourcePath = path.resolve(path.normalize(String(sourcePathRaw || '')));
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) continue;
    const hash = await quickFileHash(sourcePath);
    const existing = project.assets.find((asset) => asset.hash === hash);
    if (existing) continue;

    const ext = path.extname(sourcePath).toLowerCase();
    const base = sanitizeFileBaseName(path.basename(sourcePath));
    const assetId = `asset_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const relativePath = normalizeStorePath(path.join('assets', `${assetId}_${base}${ext}`));
    const projectPath = path.join(getProjectDir(projectId), relativePath);
    await fs.copyFile(sourcePath, projectPath);
    const createdAt = nowIso();
    const kind = inferAssetKind(sourcePath);
    const thumbnailRelativePath = normalizeStorePath(path.join('thumbs', `${assetId}.jpg`));
    const proxyRelativePath = normalizeStorePath(path.join('proxy', `${assetId}.mp4`));
    const probeResult = await probeMediaAsset({
      mediaPath: projectPath,
      assetKind: kind,
      assetHash: hash,
      cachePath: probeCachePath,
      thumbnailPath: path.join(projectDir, thumbnailRelativePath),
      proxyPath: path.join(projectDir, proxyRelativePath),
    }).catch((error) => {
      console.warn('[VideoEditorV2] media probe failed:', error);
      return null;
    });
    imported.push({
      id: assetId,
      kind,
      title: path.basename(sourcePath),
      sourcePath,
      projectPath,
      relativePath,
      proxyPath: probeResult?.proxyPath ? path.join(projectDir, proxyRelativePath) : null,
      thumbnailPath: probeResult?.thumbnailPath ? path.join(projectDir, thumbnailRelativePath) : null,
      durationMs: probeResult?.probe.durationMs,
      width: probeResult?.probe.width,
      height: probeResult?.probe.height,
      fps: probeResult?.probe.fps,
      probe: probeResult?.probe,
      hash,
      createdAt,
      updatedAt: createdAt,
    });
  }

  if (imported.length === 0) return project;
  const firstVideo = imported.find((asset) => asset.kind === 'video' && asset.width && asset.height);
  const nextCanvas = firstVideo
    ? {
      ...project.canvas,
      width: firstVideo.width || project.canvas.width,
      height: firstVideo.height || project.canvas.height,
      fps: firstVideo.fps || project.canvas.fps,
      aspectRatio: project.canvas.aspectRatio,
    }
    : project.canvas;

  return saveVideoEditorV2Project({
    ...project,
    status: project.status === 'draft' ? 'ready' : project.status,
    canvas: nextCanvas,
    assets: [...project.assets, ...imported],
    timeline: appendAssetsToBaselineTimeline(project.timeline, imported),
  });
}

export async function importSrtContentToVideoEditorV2Project(input: {
  projectId: string;
  assetId?: string;
  srtContent: string;
  sourceName?: string;
  language?: string;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const assetId = String(input.assetId || project.assets.find((asset) => asset.kind === 'video' || asset.kind === 'audio')?.id || '').trim();
  if (!assetId) {
    throw new Error('导入 SRT 前需要先导入一个视频或音频素材');
  }
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) {
    throw new Error('SRT 绑定的素材不存在');
  }

  const trackId = `track_srt_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const sourceSrtRelativePath = normalizeStorePath(path.join('subtitles', `${trackId}.source.srt`));
  const normalizedRelativePath = normalizeStorePath(path.join('subtitles', `${trackId}.segments.json`));
  const editedSrtRelativePath = normalizeStorePath(path.join('subtitles', `${trackId}.edited.srt`));
  const projectDir = getProjectDir(project.id);
  const sourceSrtPath = path.join(projectDir, sourceSrtRelativePath);
  const normalizedJsonPath = path.join(projectDir, normalizedRelativePath);
  const editedSrtPath = path.join(projectDir, editedSrtRelativePath);

  await fs.writeFile(sourceSrtPath, input.srtContent, 'utf-8');
  const segments = parseSrt(input.srtContent, { assetId, trackId });
  if (segments.length === 0) {
    throw new Error('SRT 内容为空或格式无法解析');
  }
  await writeJsonAtomic(normalizedJsonPath, segments);
  await fs.writeFile(editedSrtPath, serializeSegmentsToSrt(segments), 'utf-8');

  const createdAt = nowIso();
  const track: TranscriptTrack = {
    id: trackId,
    assetId,
    language: input.language,
    sourceSrtPath,
    normalizedJsonPath,
    editedSrtPath,
    segments,
    createdAt,
    updatedAt: createdAt,
  };

  const timelineDurationMs = Math.max(project.timeline.durationMs || 0, segments[segments.length - 1]?.endMs || 0);
  return saveVideoEditorV2Project({
    ...project,
    status: 'ready',
    transcriptTracks: [
      ...project.transcriptTracks.filter((item) => item.assetId !== assetId),
      track,
    ],
    timeline: {
      ...project.timeline,
      durationMs: timelineDurationMs,
    },
  });
}

export async function importSrtFileToVideoEditorV2Project(input: {
  projectId: string;
  assetId?: string;
  srtPath: string;
  language?: string;
}): Promise<VideoEditorV2Project> {
  const srtContent = await fs.readFile(path.resolve(path.normalize(input.srtPath)), 'utf-8');
  return importSrtContentToVideoEditorV2Project({
    projectId: input.projectId,
    assetId: input.assetId,
    srtContent,
    sourceName: path.basename(input.srtPath),
    language: input.language,
  });
}

export async function updateVideoEditorV2SrtSegment(input: {
  projectId: string;
  trackId: string;
  segmentId: string;
  text?: string;
  tags?: SrtSegmentTag[];
  startMs?: number;
  endMs?: number;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  let updatedTrack: TranscriptTrack | null = null;
  const transcriptTracks = project.transcriptTracks.map((track) => {
    if (track.id !== input.trackId) return track;
    const segments: SrtSegment[] = track.segments.map((segment) => {
      if (segment.id !== input.segmentId) return segment;
      return {
        ...segment,
        text: input.text !== undefined ? String(input.text) : segment.text,
        tags: Array.isArray(input.tags) ? input.tags : segment.tags,
        startMs: input.startMs !== undefined ? Math.max(0, Math.round(Number(input.startMs) || 0)) : segment.startMs,
        endMs: input.endMs !== undefined ? Math.max(0, Math.round(Number(input.endMs) || 0)) : segment.endMs,
      };
    });
    updatedTrack = {
      ...track,
      segments,
      updatedAt: nowIso(),
    };
    return updatedTrack;
  });
  if (!updatedTrack) {
    throw new Error('字幕轨不存在');
  }
  const updatedSegment = (updatedTrack as TranscriptTrack).segments.find((segment) => segment.id === input.segmentId);
  await persistTranscriptTrack(updatedTrack as TranscriptTrack);
  return saveVideoEditorV2Project({
    ...project,
    transcriptTracks,
    timeline: updatedSegment ? syncTimelineSubtitleText(project.timeline, updatedSegment) : project.timeline,
  });
}

export async function mergeVideoEditorV2SrtSegments(input: {
  projectId: string;
  trackId: string;
  segmentIds: string[];
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const track = project.transcriptTracks.find((item) => item.id === input.trackId);
  if (!track) {
    throw new Error('字幕轨不存在');
  }
  const requestedIds = input.segmentIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (requestedIds.length < 2) {
    throw new Error('合并字幕至少需要两个 segmentIds');
  }
  const requestedSet = new Set(requestedIds);
  const sortedSegments = [...track.segments].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const selected = sortedSegments.filter((segment) => requestedSet.has(segment.id));
  if (selected.length !== requestedSet.size) {
    throw new Error('部分字幕段不存在，无法合并');
  }
  const firstIndex = sortedSegments.findIndex((segment) => segment.id === selected[0].id);
  const isAdjacent = selected.every((segment, index) => sortedSegments[firstIndex + index]?.id === segment.id);
  if (firstIndex < 0 || !isAdjacent) {
    throw new Error('只能合并相邻字幕段');
  }

  const first = selected[0];
  const last = selected[selected.length - 1];
  const merged: SrtSegment = {
    ...first,
    startMs: first.startMs,
    endMs: last.endMs,
    text: selected.map((segment) => segment.text.trim()).filter(Boolean).join('\n'),
    confidence: selected.every((segment) => typeof segment.confidence === 'number')
      ? selected.reduce((sum, segment) => sum + Number(segment.confidence || 0), 0) / selected.length
      : first.confidence ?? null,
    speaker: selected.every((segment) => segment.speaker && segment.speaker === first.speaker) ? first.speaker : first.speaker ?? null,
    tags: dedupeTags(selected.flatMap((segment) => segment.tags || [])),
  };
  const nextSegments = normalizeSrtSegments([
    ...sortedSegments.slice(0, firstIndex),
    merged,
    ...sortedSegments.slice(firstIndex + selected.length),
  ], {
    assetId: track.assetId,
    trackId: track.id,
  });
  const nextMerged = nextSegments.find((segment) => segment.id === merged.id) || nextSegments[firstIndex];
  const updatedTrack: TranscriptTrack = {
    ...track,
    segments: nextSegments,
    updatedAt: nowIso(),
  };
  await persistTranscriptTrack(updatedTrack);
  return saveVideoEditorV2Project({
    ...project,
    transcriptTracks: project.transcriptTracks.map((item) => item.id === updatedTrack.id ? updatedTrack : item),
    timeline: nextMerged ? syncTimelineMergedSegments(project.timeline, requestedSet, nextMerged) : project.timeline,
  });
}

export async function splitVideoEditorV2SrtSegment(input: {
  projectId: string;
  trackId: string;
  segmentId: string;
  splitMs?: number;
  firstText?: string;
  secondText?: string;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const track = project.transcriptTracks.find((item) => item.id === input.trackId);
  if (!track) {
    throw new Error('字幕轨不存在');
  }
  const sortedSegments = [...track.segments].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const segmentIndex = sortedSegments.findIndex((segment) => segment.id === input.segmentId);
  const segment = sortedSegments[segmentIndex];
  if (!segment) {
    throw new Error('字幕段不存在');
  }
  const duration = Math.max(1, segment.endMs - segment.startMs);
  if (duration < 200 && segment.text.trim().length < 2) {
    throw new Error('字幕段过短，无法拆分');
  }
  const splitMsRaw = Number(input.splitMs || 0);
  const splitMs = Number.isFinite(splitMsRaw) && splitMsRaw > segment.startMs && splitMsRaw < segment.endMs
    ? Math.round(splitMsRaw)
    : Math.round(segment.startMs + (duration / 2));
  const [fallbackFirstText, fallbackSecondText] = splitTextByMidpoint(segment.text);
  const firstText = String(input.firstText || '').trim() || fallbackFirstText;
  const secondText = String(input.secondText || '').trim() || fallbackSecondText;
  if (!firstText || !secondText) {
    throw new Error('拆分字幕需要两段非空文本');
  }
  const firstSegment: SrtSegment = {
    ...segment,
    endMs: splitMs,
    text: firstText,
  };
  const secondSegment: SrtSegment = {
    ...segment,
    id: `${segment.id}_split_${randomUUID().slice(0, 8)}`,
    startMs: splitMs,
    text: secondText,
  };
  const nextSegments = normalizeSrtSegments([
    ...sortedSegments.slice(0, segmentIndex),
    firstSegment,
    secondSegment,
    ...sortedSegments.slice(segmentIndex + 1),
  ], {
    assetId: track.assetId,
    trackId: track.id,
  });
  const nextFirst = nextSegments.find((item) => item.id === firstSegment.id) || nextSegments[segmentIndex];
  const nextSecond = nextSegments.find((item) => item.id === secondSegment.id) || nextSegments[segmentIndex + 1];
  const updatedTrack: TranscriptTrack = {
    ...track,
    segments: nextSegments,
    updatedAt: nowIso(),
  };
  await persistTranscriptTrack(updatedTrack);
  return saveVideoEditorV2Project({
    ...project,
    transcriptTracks: project.transcriptTracks.map((item) => item.id === updatedTrack.id ? updatedTrack : item),
    timeline: nextFirst && nextSecond ? syncTimelineSplitSegment(project.timeline, segment, nextFirst, nextSecond) : project.timeline,
  });
}

export async function setVideoEditorV2TimelineClipDisabled(input: {
  projectId: string;
  clipId: string;
  disabled: boolean;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const clipId = String(input.clipId || '').trim();
  if (!clipId) {
    throw new Error('clipId is required');
  }
  const exists = project.timeline.tracks.some((track) => track.clips.some((clip) => clip.id === clipId));
  if (!exists) {
    throw new Error('Timeline clip not found');
  }
  return saveVideoEditorV2Project({
    ...pushTimelineUndo(project, input.disabled ? '删除时间线片段' : '恢复时间线片段'),
    timeline: setTimelineClipDisabled(project.timeline, clipId, Boolean(input.disabled)),
  });
}

export async function trimVideoEditorV2TimelineClip(input: {
  projectId: string;
  clipId: string;
  edge: 'start' | 'end';
  deltaMs?: number;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const clipId = String(input.clipId || '').trim();
  if (!clipId) {
    throw new Error('clipId is required');
  }
  const edge = input.edge === 'start' ? 'start' : 'end';
  return saveVideoEditorV2Project({
    ...pushTimelineUndo(project, edge === 'start' ? '裁剪片段开头' : '裁剪片段结尾'),
    timeline: trimPrimaryTimelineClip({
      timeline: project.timeline,
      clipId,
      edge,
      deltaMs: Math.max(1, Math.round(Number(input.deltaMs || 500) || 500)),
    }),
  });
}

export async function splitVideoEditorV2TimelineClip(input: {
  projectId: string;
  clipId: string;
  splitOffsetMs?: number;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const clipId = String(input.clipId || '').trim();
  if (!clipId) {
    throw new Error('clipId is required');
  }
  return saveVideoEditorV2Project({
    ...pushTimelineUndo(project, '拆分时间线片段'),
    timeline: splitPrimaryTimelineClip({
      timeline: project.timeline,
      clipId,
      splitOffsetMs: input.splitOffsetMs,
    }),
  });
}

export async function reorderVideoEditorV2TimelineClip(input: {
  projectId: string;
  clipId: string;
  targetClipId?: string;
  position?: 'before' | 'after';
  direction?: 'left' | 'right';
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const clipId = String(input.clipId || '').trim();
  if (!clipId) {
    throw new Error('clipId is required');
  }
  return saveVideoEditorV2Project({
    ...pushTimelineUndo(project, '重排时间线片段'),
    timeline: reorderPrimaryTimelineClip({
      timeline: project.timeline,
      clipId,
      targetClipId: input.targetClipId,
      position: input.position === 'after' ? 'after' : 'before',
      direction: input.direction === 'left' || input.direction === 'right' ? input.direction : undefined,
    }),
  });
}

export async function generateAutoEditForVideoEditorV2Project(input: {
  projectId: string;
  trackId?: string;
  userGoal?: string;
  targetDurationMs?: number | null;
  pacing?: 'tight' | 'balanced' | 'slow';
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const transcript = project.transcriptTracks.find((track) => track.id === input.trackId)
    || project.transcriptTracks[0];
  if (!transcript) {
    throw new Error('生成自动剪辑前需要先导入或识别 SRT');
  }

  const plan = buildHeuristicAutoEditPlan({
    transcript,
    userGoal: input.userGoal,
    targetDurationMs: input.targetDurationMs,
    pacing: input.pacing,
  });
  const { decisions } = buildTimelineFromAutoEditPlan({
    transcript,
    plan,
  });
  const run: AutoEditRunRecord = {
    id: `auto_edit_${Date.now()}_${randomUUID().slice(0, 8)}`,
    createdAt: nowIso(),
    appliedAt: null,
    trackId: transcript.id,
    userGoal: String(input.userGoal || '').trim() || '字幕驱动自动粗剪',
    targetDurationMs: input.targetDurationMs ?? null,
    plan,
    decisions,
    status: 'planned',
  };

  return saveVideoEditorV2Project({
    ...project,
    status: 'ready',
    autoEditRuns: [run, ...(project.autoEditRuns || [])].slice(0, 20),
    lastError: null,
  });
}

export async function applyAutoEditRunToVideoEditorV2Project(input: {
  projectId: string;
  runId?: string;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const run = input.runId
    ? project.autoEditRuns.find((item) => item.id === input.runId)
    : project.autoEditRuns.find((item) => item.status === 'planned') || project.autoEditRuns[0];
  if (!run) {
    throw new Error('没有可应用的自动剪辑计划');
  }
  const plannedSegmentIds = new Set([
    ...run.plan.selectedSegments.map((item) => item.segmentId),
    ...run.plan.removedSegments.map((item) => item.segmentId),
  ]);
  const transcript = project.transcriptTracks.find((track) => track.id === run.trackId)
    || project.transcriptTracks.find((track) => track.segments.some((segment) => plannedSegmentIds.has(segment.id)))
    || project.transcriptTracks[0];
  if (!transcript) {
    throw new Error('应用自动剪辑前需要可用字幕轨');
  }
  const { timeline, decisions } = buildTimelineFromAutoEditPlan({
    transcript,
    plan: run.plan,
  });
  const appliedAt = nowIso();
  const autoEditRuns: AutoEditRunRecord[] = project.autoEditRuns.map((item) => {
    if (item.id !== run.id) return item;
    return {
      ...item,
      appliedAt,
      trackId: transcript.id,
      decisions,
      status: 'applied',
    };
  });

  return saveVideoEditorV2Project({
    ...pushTimelineUndo(project, '应用自动剪辑计划'),
    status: 'ready',
    timeline,
    autoEditRuns,
    lastError: null,
  });
}

export async function undoVideoEditorV2ProjectTimeline(input: {
  projectId: string;
}): Promise<VideoEditorV2Project> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const [latest, ...rest] = project.undoStack || [];
  if (!latest) {
    throw new Error('没有可撤销的时间线操作');
  }

  return saveVideoEditorV2Project({
    ...project,
    status: 'ready',
    timeline: latest.timeline,
    autoEditRuns: latest.autoEditRuns || project.autoEditRuns || [],
    undoStack: rest,
    lastError: null,
  });
}
