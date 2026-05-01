import { toRedboxAssetUrl } from './localAsset';
import type { VideoEditorV2Project, VideoTimelineClip } from './videoAutoEdit';

export const VIDEO_EDITOR_V2_REMOTION_COMPOSITION_ID = 'RedBoxVideoMotion';

export interface VideoEditorV2RemotionOverlay {
  id: string;
  text: string;
  startFrame: number;
  durationInFrames: number;
  position?: 'top' | 'center' | 'bottom';
  animation?: 'fade-up' | 'fade-in' | 'slide-left' | 'pop';
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  align?: 'left' | 'center' | 'right';
}

export interface VideoEditorV2RemotionScene {
  id: string;
  clipId?: string;
  assetId?: string;
  assetKind?: 'video' | 'image' | 'audio' | 'unknown';
  src: string;
  startFrame: number;
  durationInFrames: number;
  trimInFrames?: number;
  motionPreset?: 'static' | 'slow-zoom-in' | 'slow-zoom-out' | 'pan-left' | 'pan-right' | 'slide-up' | 'slide-down';
  overlayTitle?: string;
  overlayBody?: string;
  overlays?: VideoEditorV2RemotionOverlay[];
}

export interface VideoEditorV2RemotionComposition {
  version: number;
  title: string;
  entryCompositionId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  backgroundColor?: string;
  renderMode: 'full' | 'motion-layer';
  scenes: VideoEditorV2RemotionScene[];
  transitions: [];
  baseMedia: {
    sourceAssetIds: string[];
    durationMs: number;
    width: number;
    height: number;
    status: string;
    updatedAt: number;
  };
  ffmpegRecipe: {
    operations: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    summary: string;
    updatedAt: number;
  };
  render?: {
    outputPath?: string;
    renderedAt?: number;
    durationInFrames?: number;
    renderMode?: 'full' | 'motion-layer';
    compositionId?: string;
    codec?: string;
    imageFormat?: 'jpeg' | 'png';
    pixelFormat?: string;
    proResProfile?: string;
    sampleRate?: number;
  };
}

function msToFrames(ms: number, fps: number): number {
  return Math.max(0, Math.round((Math.max(0, Number(ms) || 0) / 1000) * fps));
}

function clipDurationFrames(clip: VideoTimelineClip, fps: number): number {
  return Math.max(1, msToFrames(clip.timelineEndMs - clip.timelineStartMs, fps));
}

function intersects(left: VideoTimelineClip, right: VideoTimelineClip): boolean {
  return left.timelineStartMs < right.timelineEndMs && right.timelineStartMs < left.timelineEndMs;
}

export function buildVideoEditorV2RemotionComposition(project: VideoEditorV2Project): VideoEditorV2RemotionComposition | null {
  const timeline = project.timeline;
  const primaryTrack = timeline.tracks.find((track) => track.kind === 'primary-video');
  if (!primaryTrack || primaryTrack.clips.length === 0) return null;

  const fps = Math.max(1, Number(project.canvas?.fps || 30));
  const width = Math.max(1, Number(project.canvas?.width || 1920));
  const height = Math.max(1, Number(project.canvas?.height || 1080));
  const subtitleClips = timeline.tracks
    .filter((track) => track.kind === 'subtitle')
    .flatMap((track) => track.clips)
    .filter((clip) => !clip.disabled);

  const activePrimaryClips = primaryTrack.clips.filter((clip) => !clip.disabled);
  if (activePrimaryClips.length === 0) return null;

  const scenes: VideoEditorV2RemotionScene[] = activePrimaryClips.map((clip, index) => {
    const asset = project.assets.find((item) => item.id === clip.assetId);
    const src = toRedboxAssetUrl(asset?.projectPath || asset?.sourcePath || '');
    if (!asset && String(clip.text || '').trim()) {
      return {
        id: `scene_${clip.id}`,
        clipId: clip.id,
        assetKind: 'unknown',
        src: '',
        startFrame: msToFrames(clip.timelineStartMs, fps),
        durationInFrames: clipDurationFrames(clip, fps),
        motionPreset: 'static',
        overlayTitle: String(clip.text || '').trim(),
      } as VideoEditorV2RemotionScene;
    }
    const overlays: VideoEditorV2RemotionOverlay[] = subtitleClips
      .filter((subtitle) => intersects(clip, subtitle))
      .map((subtitle) => ({
        id: `overlay_${subtitle.id}`,
        text: subtitle.text || '',
        startFrame: msToFrames(Math.max(0, subtitle.timelineStartMs - clip.timelineStartMs), fps),
        durationInFrames: Math.max(1, msToFrames(subtitle.timelineEndMs - subtitle.timelineStartMs, fps)),
        position: 'bottom',
        animation: 'fade-in',
        fontSize: Math.round(height * 0.044),
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.58)',
        align: 'center',
      }));

    return {
      id: `scene_${clip.id}`,
      clipId: clip.id,
      assetId: clip.assetId,
      assetKind: asset?.kind || 'unknown',
      src,
      startFrame: msToFrames(clip.timelineStartMs, fps),
      durationInFrames: clipDurationFrames(clip, fps),
      trimInFrames: msToFrames(clip.sourceStartMs, fps),
      motionPreset: index % 2 === 0 ? 'static' : 'slow-zoom-in',
      overlays,
    };
  });

  return {
    version: 1,
    title: project.title,
    entryCompositionId: VIDEO_EDITOR_V2_REMOTION_COMPOSITION_ID,
    width,
    height,
    fps,
    durationInFrames: Math.max(1, msToFrames(timeline.durationMs, fps)),
    backgroundColor: '#0d1117',
    renderMode: 'full',
    scenes,
    transitions: [],
    baseMedia: {
      sourceAssetIds: project.assets.map((asset) => asset.id),
      durationMs: timeline.durationMs,
      width,
      height,
      status: 'derived-from-video-editor-v2',
      updatedAt: Date.now(),
    },
    ffmpegRecipe: {
      operations: [],
      artifacts: [],
      summary: `V2 自动剪辑生成 ${scenes.length} 个场景，${subtitleClips.length} 条字幕 overlay。`,
      updatedAt: Date.now(),
    },
  };
}
