import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import type { PlayerRef } from '@remotion/player';
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Download,
  FolderOpen,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  Redo2,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Type,
  Trash2,
  GitBranchPlus,
  Undo2,
  Wand2,
} from 'lucide-react';
import { EditorLayoutToggleButton } from './EditorLayoutToggleButton';
import { VendoredFreecutTimeline } from './VendoredFreecutTimeline';
import { TimelinePreviewComposition } from './TimelinePreviewComposition';
import { VideoEditorSidebarShell } from './VideoEditorSidebarShell';
import { VideoEditorStageShell } from './VideoEditorStageShell';
import { VideoEditorTimelineShell } from './VideoEditorTimelineShell';
import { resolveAssetUrl } from '../../utils/pathManager';
import { subscribeRuntimeEventStream } from '../../runtime/runtimeEventStream';
import { RemotionVideoPreview } from './remotion/RemotionVideoPreview';
import { RemotionTransportBar } from './remotion/RemotionTransportBar';
import { SUBTITLE_PRESETS, resolveSubtitlePreset } from './subtitles/subtitlePresets';
import { TEXT_PRESETS, resolveTextPreset } from './texts/textPresets';
import { TRANSITION_PRESETS, resolveTransitionPreset } from './transitions/transitionPresets';
import {
  createVideoEditorStore,
  useVideoEditorStore,
  type VideoEditorStore,
} from '../../features/video-editor/store/useVideoEditorStore';
import type {
  SceneItemTransform,
  VideoEditorLeftPanel,
  VideoEditorRatioPreset,
  VideoEditorState,
  VideoEditorViewportMetrics,
} from '../../features/video-editor/store/useVideoEditorStore';
import {
  deriveProjectedEditorItems,
  deriveTrackNames,
  deriveTrackUiMap,
  isMotionItem,
  projectDurationMs,
  type EditorProjectFile,
} from './editorProject';
import type {
  MotionPreset,
  OverlayAnimation,
  RemotionCompositionConfig,
  RemotionScene,
} from './remotion/types';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type MediaAssetLike = {
  id: string;
  title?: string;
  relativePath?: string;
  absolutePath?: string;
  previewUrl?: string;
  mimeType?: string;
};

type ScriptApprovalLike = {
  status?: 'pending' | 'confirmed';
  lastScriptUpdateAt?: number | null;
  lastScriptUpdateSource?: 'user' | 'ai' | 'system' | null;
  confirmedAt?: number | null;
};

type PackageStateLike = Record<string, unknown> & {
  editorProject?: EditorProjectFile | null;
};

type VideoClipLike = {
  clipId?: string;
  assetId?: string;
  name?: string;
  order?: number;
  track?: string;
  durationMs?: number;
  trimInMs?: number;
  enabled?: boolean;
  assetKind?: string;
  startSeconds?: number;
  endSeconds?: number;
  subtitleStyle?: {
    position?: 'top' | 'center' | 'bottom';
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
    emphasisColor?: string;
    align?: 'left' | 'center' | 'right';
    presetId?: string;
    animation?: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
    fontWeight?: number;
    textTransform?: 'none' | 'uppercase';
    letterSpacing?: number;
    borderRadius?: number;
    paddingX?: number;
    paddingY?: number;
    emphasisWords?: string[];
    segmentationMode?: 'punctuationOrPause' | 'time' | 'singleWord';
    linesPerCaption?: number;
  };
  textStyle?: {
    presetId?: string;
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
    align?: 'left' | 'center' | 'right';
    fontWeight?: number;
    animation?: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
  };
  transitionStyle?: {
    presetId?: string;
    kind?: 'none' | 'fade' | 'slide' | 'wipe' | 'flip' | 'clock-wipe' | 'star' | 'circle' | 'rectangle';
    direction?: 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
    durationMs?: number;
  };
};

type DragTarget = 'materials' | 'timeline';

type DragState = {
  target: DragTarget;
  startX: number;
  startY: number;
  materialPaneWidth: number;
  timelineHeight: number;
};

type MaterialDragPreviewState = {
  asset: MediaAssetLike;
  x: number;
  y: number;
  overTimeline: boolean;
};

type MaterialFilter = 'all' | 'video' | 'image' | 'audio';

const RIGHT_PANEL_WIDTH = 420;

const DEFAULT_CLIP_MS = 4000;
const IMAGE_CLIP_MS = 500;

const MOTION_PRESETS: Array<{ value: MotionPreset; label: string }> = [
  { value: 'static', label: '静止' },
  { value: 'slow-zoom-in', label: '慢推' },
  { value: 'slow-zoom-out', label: '慢拉' },
  { value: 'pan-left', label: '左平移' },
  { value: 'pan-right', label: '右平移' },
  { value: 'slide-up', label: '上推' },
  { value: 'slide-down', label: '下压' },
];

const OVERLAY_ANIMATIONS: Array<{ value: OverlayAnimation; label: string }> = [
  { value: 'fade-up', label: '淡入上浮' },
  { value: 'fade-in', label: '淡入' },
  { value: 'slide-left', label: '左滑入' },
  { value: 'pop', label: '弹出' },
];

const RATIO_PRESET_SIZE: Record<VideoEditorRatioPreset, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '4:3': { width: 1440, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
};

function syncEditorProjectSnapshot(
  editorStore: VideoEditorStore,
  project: EditorProjectFile | null,
) {
  const projectedItems = project ? deriveProjectedEditorItems(project) : [];
  const tracksById = new Map(project?.tracks.map((track) => [track.id, track]) || []);
  const nextTrackUi = project ? deriveTrackUiMap(project) : null;

  editorStore.setState((state) => ({
    ...(nextTrackUi && Object.keys(nextTrackUi).length > 0
      ? {
          timeline: {
            ...state.timeline,
            trackUi: nextTrackUi,
          },
        }
      : {}),
    editor: {
      ...state.editor,
      projectFile: project,
      derived: {
        ...state.editor.derived,
        durationMs: project ? projectDurationMs(project) : 0,
        visibleItems: projectedItems.filter((item) => {
          const track = tracksById.get(item.trackId);
          return item.enabled && !track?.ui.hidden;
        }),
        audibleItems: projectedItems.filter((item) => {
          const track = tracksById.get(item.trackId);
          return item.enabled
            && !track?.ui.muted
            && (track?.kind === 'audio' || (item.type === 'media' && track?.kind === 'video'));
        }),
        activeMotionItems: projectedItems.filter(isMotionItem),
      },
    },
  }));
}

function syncEditorSelectionSnapshot(
  editorStore: VideoEditorStore,
  selection: {
    selectedClipId: string | null;
    activeTrackId: string | null;
  },
) {
  editorStore.setState((state) => ({
    editor: {
      ...state.editor,
      selection: {
        itemIds: selection.selectedClipId ? [selection.selectedClipId] : [],
        primaryItemId: selection.selectedClipId,
        trackIds: selection.activeTrackId ? [selection.activeTrackId] : [],
      },
    },
  }));
}

function inferAssetKind(asset: MediaAssetLike): 'image' | 'video' | 'audio' | 'unknown' {
  const mimeType = String(asset.mimeType || '').toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  const source = String(asset.previewUrl || asset.absolutePath || asset.relativePath || '').toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/.test(source)) return 'image';
  if (/\.(mp4|mov|webm|m4v|mkv|avi)(\?|$)/.test(source)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)(\?|$)/.test(source)) return 'audio';
  return 'unknown';
}

function assetDurationMs(asset: MediaAssetLike): number | undefined {
  return inferAssetKind(asset) === 'image' ? IMAGE_CLIP_MS : undefined;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function formatSecondsLabel(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const frames = Math.round((safe - Math.floor(safe)) * 100);
  return `${mins}:${String(secs).padStart(2, '0')}.${String(frames).padStart(2, '0')}`;
}

function normalizeClipText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clipTokenCount(text: string): number {
  const normalized = normalizeClipText(text);
  if (!normalized) return 0;
  const tokens = normalized.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g);
  return tokens?.length || 0;
}

function clipPreviewText(text: string, maxLength = 48): string {
  const normalized = normalizeClipText(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function extractCaptionTokens(text: string): string[] {
  const normalized = normalizeClipText(text);
  if (!normalized) return [];
  const matches = normalized.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*|[\u4e00-\u9fff]|[^\s]/g);
  return (matches || []).map((token) => token.trim()).filter(Boolean);
}

function normalizeCaptionToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}_-]+/gu, '').toLowerCase();
}

function subtitleSegmentationLabel(value: string | undefined): string {
  if (value === 'singleWord') return '逐词';
  if (value === 'time') return '按时间';
  return '按停顿';
}

function scriptParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\r\n\r\n/)
    .map((section) => section.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function buildVideoExecutionPrompts(options: {
  title: string;
  script: string;
  clipCount: number;
  trackCount: number;
  motionPrompt: string;
}) {
  const paragraphs = scriptParagraphs(options.script);
  const beats = (paragraphs.length > 0 ? paragraphs : [options.script.replace(/\s+/g, ' ').trim() || '暂无脚本内容'])
    .slice(0, 8)
    .map((paragraph, index) => `${index + 1}. ${paragraph}`);
  const scriptSummary = beats.join('\n');
  const editPrompt = [
    `你现在要先做“脚本执行规划”，再做时间轴剪辑。没有脚本确认前，不要改时间线。`,
    `项目：${options.title}`,
    `当前工程：${options.trackCount} 条轨道，${options.clipCount} 个片段。`,
    `脚本要点：`,
    scriptSummary,
    `请先输出一个执行 brief，至少包含：镜头段落、每段要保留/删减的素材、节奏点、字幕策略、转场策略、动画配合策略。`,
    `等用户确认脚本后，再说明应该如何调用剪辑工具按顺序执行。`,
  ].join('\n');
  const motionExecutionPrompt = [
    `你现在要基于脚本先规划动画，再调用 Remotion 生成。没有脚本确认前，不要生成动画。`,
    `项目：${options.title}`,
    `脚本段落：`,
    scriptSummary,
    `当前动画提示：${options.motionPrompt || '尚未设置'}`,
    `请先给出动画执行 brief：每段应该用什么运动、标题、字幕节奏、强调方式；再给出可直接用于 Remotion 的动画提示词。`,
    `Remotion 在当前工程里是按帧场景系统：scene.durationInFrames 控制片段时长，overlay.startFrame / overlay.durationInFrames 控制字幕或标题出现时间，先做简单可执行的推拉、平移、标题卡和底部字幕卡。`,
  ].join('\n');
  const masterPrompt = [
    `严格按照“script_read -> script_update -> 用户阅读 -> script_confirm -> 时间轴剪辑 -> Remotion 动画”的顺序完成当前视频工程。`,
    `项目：${options.title}`,
    `时间轴概况：${options.trackCount} 轨 / ${options.clipCount} 段`,
    `脚本：`,
    scriptSummary,
    `要求：先输出一版可直接给用户阅读的完整脚本草案，并写回脚本区；用户确认前不要动时间轴和动画。`,
  ].join('\n');
  return {
    beats,
    editPrompt,
    motionExecutionPrompt,
    masterPrompt,
  };
}

function isSubtitleClipLike(clip?: VideoClipLike | null): boolean {
  if (!clip) return false;
  const assetKind = String(clip.assetKind || '').trim().toLowerCase();
  const track = String(clip.track || '').trim().toUpperCase();
  return assetKind === 'subtitle' || assetKind === 'caption' || track.startsWith('S') || track.startsWith('C');
}

function sceneSelectionForClip(clip?: VideoClipLike | null): { sceneItemKind: 'asset' | 'text' | 'subtitle'; sceneItemId: string | null } {
  const clipId = String(clip?.clipId || '').trim();
  if (!clipId) {
    return { sceneItemKind: 'asset', sceneItemId: null };
  }
  if (String(clip?.assetKind || '').trim().toLowerCase() === 'text') {
    return { sceneItemKind: 'text', sceneItemId: `${clipId}:text` };
  }
  if (isSubtitleClipLike(clip)) {
    return { sceneItemKind: 'subtitle', sceneItemId: `${clipId}:subtitle` };
  }
  return { sceneItemKind: 'asset', sceneItemId: clipId };
}

function clipIdFromSceneItem(kind: 'asset' | 'overlay' | 'title' | 'text' | 'subtitle', id: string): string {
  if (kind === 'text') return id.replace(/:text$/, '');
  if (kind === 'subtitle') return id.replace(/:subtitle$/, '');
  return id;
}

function clipIdFromAnySceneItemId(id: string): string {
  return id.replace(/:(text|subtitle)$/, '');
}

function inferSceneItemKindFromId(id: string): 'asset' | 'text' | 'subtitle' {
  if (id.endsWith(':text')) return 'text';
  if (id.endsWith(':subtitle')) return 'subtitle';
  return 'asset';
}

function clipOrderInTrack(clip: VideoClipLike, timelineClips: VideoClipLike[]): number {
  const track = String(clip.track || '').trim();
  const clipId = String(clip.clipId || '').trim();
  const sameTrack = timelineClips
    .filter((item) => String(item.track || '').trim() === track)
    .sort((left, right) => Number(left.startSeconds || 0) - Number(right.startSeconds || 0));
  const index = sameTrack.findIndex((item) => String(item.clipId || '').trim() === clipId);
  return index >= 0 ? index : sameTrack.length;
}

function buildTimelineTrackOrder(trackNames: string[], timelineClips: VideoClipLike[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const appendTrack = (value: unknown) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };
  trackNames.forEach(appendTrack);
  timelineClips.forEach((clip) => appendTrack(clip.track));
  return ordered;
}

function trackOrderValue(trackId: string, trackOrderIndex: Map<string, number>): number {
  return trackOrderIndex.get(String(trackId || '').trim()) ?? Number.MAX_SAFE_INTEGER;
}

function makeSceneGroupId() {
  return `group-${Math.random().toString(36).slice(2, 10)}`;
}

function computeTimelineDurationSeconds(clips: VideoClipLike[]): number {
  const trackTotals = new Map<string, number>();
  clips.forEach((clip) => {
    const track = String(clip.track || 'V1').trim() || 'V1';
    const assetKind = String(clip.assetKind || '').trim().toLowerCase();
    const minDurationMs = assetKind === 'image' ? IMAGE_CLIP_MS : 1000;
    const defaultDurationMs = assetKind === 'image' ? IMAGE_CLIP_MS : DEFAULT_CLIP_MS;
    const durationMs = Math.max(minDurationMs, Number(clip.durationMs || 0) || defaultDurationMs);
    trackTotals.set(track, (trackTotals.get(track) || 0) + durationMs / 1000);
  });
  return Math.max(...Array.from(trackTotals.values()), 0);
}

function createDefaultMotionPrompt() {
  return '请根据当前时间线和脚本，生成适合短视频的 Remotion 动画：前段更抓人，中段稳住信息，结尾强化 CTA；多用慢推拉、平移、标题卡和底部字幕。';
}

function buildEditableOverlay(scene: RemotionScene) {
  return scene.overlays?.[0] || {
    id: `${scene.id}-overlay-1`,
    text: scene.overlayBody || '',
    startFrame: 8,
    durationInFrames: Math.max(24, scene.durationInFrames - 12),
    position: 'bottom' as const,
    animation: 'fade-up' as const,
    fontSize: 36,
  };
}

function buildDefaultSceneItemTransform(
  kind: 'asset' | 'title' | 'overlay' | 'text' | 'subtitle',
  stageWidth: number,
  stageHeight: number
): SceneItemTransform {
  if (kind === 'subtitle') {
    return {
      x: stageWidth * 0.12,
      y: stageHeight * 0.78,
      width: stageWidth * 0.76,
      height: stageHeight * 0.12,
      lockAspectRatio: false,
      minWidth: 240,
      minHeight: 56,
    };
  }
  if (kind === 'text') {
    return {
      x: stageWidth * 0.14,
      y: stageHeight * 0.22,
      width: stageWidth * 0.56,
      height: stageHeight * 0.12,
      lockAspectRatio: false,
      minWidth: 220,
      minHeight: 56,
    };
  }
  if (kind === 'title') {
    return {
      x: stageWidth * 0.1,
      y: stageHeight * 0.12,
      width: stageWidth * 0.42,
      height: stageHeight * 0.12,
      lockAspectRatio: false,
      minWidth: 180,
      minHeight: 48,
    };
  }
  if (kind === 'overlay') {
    return {
      x: stageWidth * 0.22,
      y: stageHeight * 0.72,
      width: stageWidth * 0.56,
      height: stageHeight * 0.14,
      lockAspectRatio: false,
      minWidth: 220,
      minHeight: 64,
    };
  }
  const width = Math.min(stageWidth * 0.24, 320);
  return {
    x: (stageWidth - width) / 2,
    y: stageHeight * 0.35,
    width,
    height: width * 1.35,
    lockAspectRatio: true,
    minWidth: 96,
    minHeight: 96,
  };
}

function normalizeSceneItemTransforms(
  value: unknown,
  fallbackWidth: number,
  fallbackHeight: number
): Record<string, SceneItemTransform> {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, Partial<SceneItemTransform>>;
  const result: Record<string, SceneItemTransform> = {};
  Object.entries(source).forEach(([key, item]) => {
    const inferredKind = key.endsWith(':title')
      ? 'title'
      : key.endsWith(':overlay')
        ? 'overlay'
        : key.endsWith(':text')
          ? 'text'
          : key.endsWith(':subtitle')
            ? 'subtitle'
        : 'asset';
    const fallback = buildDefaultSceneItemTransform(inferredKind, fallbackWidth, fallbackHeight);
    result[key] = {
      ...fallback,
      ...(item || {}),
      lockAspectRatio: typeof item?.lockAspectRatio === 'boolean' ? item.lockAspectRatio : fallback.lockAspectRatio,
      minWidth: Number.isFinite(Number(item?.minWidth)) ? Number(item?.minWidth) : fallback.minWidth,
      minHeight: Number.isFinite(Number(item?.minHeight)) ? Number(item?.minHeight) : fallback.minHeight,
    };
  });
  return result;
}

export interface VideoDraftWorkbenchProps {
  title: string;
  editorFile: string;
  packageAssets: Array<Record<string, unknown>>;
  packageState?: PackageStateLike | null;
  packagePreviewAssets: MediaAssetLike[];
  primaryVideoAsset?: MediaAssetLike | null;
  timelineClipCount: number;
  timelineTrackNames: string[];
  timelineClips: VideoClipLike[];
  editorBody: string;
  editorBodyDirty: boolean;
  isSavingEditorBody: boolean;
  materialsCollapsed?: boolean;
  timelineCollapsed?: boolean;
  isActive?: boolean;
  editorChatSessionId: string | null;
  remotionComposition?: RemotionCompositionConfig | null;
  remotionRenderPath?: string | null;
  isGeneratingRemotion?: boolean;
  isRenderingRemotion?: boolean;
  onEditorBodyChange: (value: string) => void;
  onOpenBindAssets: () => void;
  onPackageStateChange: (state: PackageStateLike) => void;
  onConfirmScript: () => void;
  onGenerateRemotionScene: (instructions?: string) => void;
  onSaveRemotionScene: (scene: RemotionCompositionConfig) => void;
  onRenderRemotionVideo: () => void;
  onOpenRenderedVideo?: () => void;
}

export function VideoDraftWorkbench({
  title,
  editorFile,
  packageAssets: _packageAssets,
  packageState,
  packagePreviewAssets,
  primaryVideoAsset,
  timelineClipCount,
  timelineTrackNames,
  timelineClips,
  editorBody,
  editorBodyDirty,
  isSavingEditorBody,
  materialsCollapsed: externalMaterialsCollapsed = false,
  timelineCollapsed: externalTimelineCollapsed = false,
  isActive = true,
  editorChatSessionId,
  remotionComposition,
  remotionRenderPath,
  isGeneratingRemotion = false,
  isRenderingRemotion = false,
  onEditorBodyChange,
  onOpenBindAssets,
  onPackageStateChange,
  onConfirmScript,
  onGenerateRemotionScene,
  onSaveRemotionScene,
  onRenderRemotionVideo,
  onOpenRenderedVideo,
}: VideoDraftWorkbenchProps) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [materialDragPreview, setMaterialDragPreview] = useState<MaterialDragPreviewState | null>(null);
  const [selectedClipDraft, setSelectedClipDraft] = useState<{
    track: string;
    durationMs: number;
    trimInMs: number;
    enabled: boolean;
  } | null>(null);
  const [subtitleDraftText, setSubtitleDraftText] = useState('');
  const [subtitleDraftDurationMs, setSubtitleDraftDurationMs] = useState(2200);
  const [subtitlePresetId, setSubtitlePresetId] = useState('classic-bottom');
  const [isTranscribingSubtitles, setIsTranscribingSubtitles] = useState(false);
  const [subtitleTranscriptionNotice, setSubtitleTranscriptionNotice] = useState<string | null>(null);
  const [textDraftText, setTextDraftText] = useState('输入标题');
  const [textDraftDurationMs, setTextDraftDurationMs] = useState(2500);
  const [textPresetId, setTextPresetId] = useState('headline-hero');
  const [isSavingSelectedClip, setIsSavingSelectedClip] = useState(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastAutoSavedSceneRef = useRef('');
  const remotionPlayerRef = useRef<PlayerRef | null>(null);
  const previewPlaybackRafRef = useRef<number | null>(null);
  const previewPlaybackLastTickRef = useRef<number | null>(null);
  const previewTimeSyncSuspendUntilRef = useRef(0);
  const editorStore = useMemo(
    () =>
      createVideoEditorStore({
        project: {
          title,
          filePath: editorFile,
          width: remotionComposition?.width || 1080,
          height: remotionComposition?.height || 1920,
          ratioPreset: (remotionComposition?.width || 1080) >= (remotionComposition?.height || 1920) ? '16:9' : '9:16',
          fps: remotionComposition?.fps || 30,
          durationInFrames: remotionComposition?.durationInFrames || 1,
          exportPath: remotionRenderPath || null,
          isExporting: isRenderingRemotion,
        },
        assets: {
          currentPreviewAssetId: primaryVideoAsset?.id || null,
          selectedAssetId: null,
          materialSearch: '',
        },
        timeline: {
          selectedClipId: null,
          activeTrackId: null,
          viewport: {
            scrollLeft: 0,
            maxScrollLeft: 0,
            scrollTop: 0,
            maxScrollTop: 0,
          },
          zoomPercent: 100,
          playheadSeconds: 0,
          trackUi: {},
        },
        player: {
          previewTab: 'preview',
          isPlaying: false,
          currentTime: 0,
          currentFrame: 0,
        },
        scene: {
          selectedSceneId: remotionComposition?.scenes?.[0]?.id || null,
          editableComposition: remotionComposition || null,
          guidesVisible: true,
          safeAreaVisible: true,
          itemTransforms: normalizeSceneItemTransforms(
            (remotionComposition as RemotionCompositionConfig | null)?.sceneItemTransforms || {},
            remotionComposition?.width || 1080,
            remotionComposition?.height || 1920
          ),
          itemVisibility: {},
          itemOrder: [],
          itemLocks: {},
          itemGroups: {},
          focusedGroupId: null,
        },
        panels: {
          leftPanel: 'uploads',
          materialPaneWidth: 320,
          timelineHeight: 296,
          redclawDrawerOpen: true,
        },
        remotion: {
          motionPrompt: createDefaultMotionPrompt(),
        },
        script: {
          dirty: editorBodyDirty,
        },
      }),
    [editorFile]
  );

  const currentPreviewAssetId = useVideoEditorStore(editorStore, (state) => state.assets.currentPreviewAssetId);
  const materialSearch = useVideoEditorStore(editorStore, (state) => state.assets.materialSearch);
  const previewCurrentTime = useVideoEditorStore(editorStore, (state) => state.player.currentTime);
  const previewTab = useVideoEditorStore(editorStore, (state) => state.player.previewTab);
  const isPreviewPlaying = useVideoEditorStore(editorStore, (state) => state.player.isPlaying);
  const motionPrompt = useVideoEditorStore(editorStore, (state) => state.remotion.motionPrompt);
  const editableComposition = useVideoEditorStore(editorStore, (state) => state.scene.editableComposition);
  const selectedSceneId = useVideoEditorStore(editorStore, (state) => state.scene.selectedSceneId);
  const selectedClipId = useVideoEditorStore(editorStore, (state) => state.timeline.selectedClipId);
  const activeTrackId = useVideoEditorStore(editorStore, (state) => state.timeline.activeTrackId);
  const timelineViewport = useVideoEditorStore(editorStore, (state) => state.timeline.viewport);
  const timelineZoomPercent = useVideoEditorStore(editorStore, (state) => state.timeline.zoomPercent);
  const timelineTrackUi = useVideoEditorStore(editorStore, (state) => state.timeline.trackUi);
  const canUndo = useVideoEditorStore(editorStore, (state) => state.editor.history.canUndo);
  const canRedo = useVideoEditorStore(editorStore, (state) => state.editor.history.canRedo);
  const projectWidth = useVideoEditorStore(editorStore, (state) => state.project.width);
  const projectHeight = useVideoEditorStore(editorStore, (state) => state.project.height);
  const ratioPreset = useVideoEditorStore(editorStore, (state) => state.project.ratioPreset);
  const leftPanel = useVideoEditorStore(editorStore, (state) => state.panels.leftPanel);
  const materialPaneWidth = useVideoEditorStore(editorStore, (state) => state.panels.materialPaneWidth);
  const timelineHeight = useVideoEditorStore(editorStore, (state) => state.panels.timelineHeight);
  const redclawDrawerOpen = useVideoEditorStore(editorStore, (state) => state.panels.redclawDrawerOpen);
  const [materialsCollapsed, setMaterialsCollapsed] = useState(externalMaterialsCollapsed);
  const [timelineCollapsed, setTimelineCollapsed] = useState(externalTimelineCollapsed);
  const selectedSceneItemId = useVideoEditorStore(editorStore, (state) => state.selection.sceneItemId);
  const selectedSceneItemIds = useVideoEditorStore(editorStore, (state) => state.selection.sceneItemIds);
  const selectedSceneItemKind = useVideoEditorStore(editorStore, (state) => state.selection.sceneItemKind);
  const guidesVisible = useVideoEditorStore(editorStore, (state) => state.scene.guidesVisible);
  const safeAreaVisible = useVideoEditorStore(editorStore, (state) => state.scene.safeAreaVisible);
  const itemTransforms = useVideoEditorStore(editorStore, (state) => state.scene.itemTransforms);
  const sceneItemVisibility = useVideoEditorStore(editorStore, (state) => state.scene.itemVisibility);
  const sceneItemOrder = useVideoEditorStore(editorStore, (state) => state.scene.itemOrder);
  const sceneItemLocks = useVideoEditorStore(editorStore, (state) => state.scene.itemLocks);
  const sceneItemGroups = useVideoEditorStore(editorStore, (state) => state.scene.itemGroups);
  const focusedGroupId = useVideoEditorStore(editorStore, (state) => state.scene.focusedGroupId);
  const activeSidebarTab = leftPanel;
  const packageEditorProject = useMemo(() => {
    if (!packageState?.editorProject || typeof packageState.editorProject !== 'object') {
      return null;
    }
    return packageState.editorProject as EditorProjectFile;
  }, [packageState?.editorProject]);
  const effectiveTimelineTrackNames = useMemo(
    () => packageEditorProject ? deriveTrackNames(packageEditorProject, false) : timelineTrackNames,
    [packageEditorProject, timelineTrackNames]
  );
  const effectiveFps = editableComposition?.fps || 30;
  const timelineDurationSeconds = useMemo(
    () => Math.max(0.1, computeTimelineDurationSeconds(timelineClips)),
    [timelineClips]
  );
  const timelineDurationInFrames = Math.max(1, Math.round(timelineDurationSeconds * effectiveFps));
  const scriptApproval = packageState?.editorProject?.ai?.scriptApproval || null;
  const scriptConfirmed = scriptApproval?.status === 'confirmed';
  const scriptStatusLabel = isSavingEditorBody
    ? '脚本保存中...'
    : editorBodyDirty
      ? '脚本待保存'
      : scriptConfirmed
        ? '脚本已确认'
        : '脚本待确认';
  const canRunAiExecution = scriptConfirmed && !editorBodyDirty && !isSavingEditorBody;

  useEffect(() => {
    setMaterialsCollapsed(externalMaterialsCollapsed);
  }, [externalMaterialsCollapsed]);

  useEffect(() => {
    setTimelineCollapsed(externalTimelineCollapsed);
  }, [externalTimelineCollapsed]);

  const setPreviewTab = useCallback((tab: VideoEditorState['player']['previewTab']) => {
    editorStore.setState((state) => ({
      player: {
        ...state.player,
        previewTab: tab,
      },
    }));
  }, [editorStore]);

  const setLeftPanel = useCallback((panel: VideoEditorLeftPanel) => {
    editorStore.setState((state) => ({
      panels: {
        ...state.panels,
        leftPanel: panel,
      },
    }));
  }, [editorStore]);
  const quantizePreviewTime = useCallback((seconds: number) => {
    const safeSeconds = Math.max(0, seconds);
    const frameStep = 1 / Math.max(1, effectiveFps);
    return Math.round(safeSeconds / frameStep) * frameStep;
  }, [effectiveFps]);
  const suspendPreviewTimeSync = useCallback((durationMs = 180) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    previewTimeSyncSuspendUntilRef.current = now + durationMs;
  }, []);

  const displayAssets = useMemo(
    () => (packagePreviewAssets.length > 0 ? packagePreviewAssets : ([primaryVideoAsset].filter(Boolean) as MediaAssetLike[])),
    [packagePreviewAssets, primaryVideoAsset]
  );

  const effectiveMaterialFilter = useMemo<MaterialFilter>(() => {
    if (activeSidebarTab === 'videos') return 'video';
    if (activeSidebarTab === 'images') return 'image';
    if (activeSidebarTab === 'audios') return 'audio';
    return 'all';
  }, [activeSidebarTab]);

  const searchableAssets = useMemo(() => {
    const keyword = materialSearch.trim().toLowerCase();
    return displayAssets
      .map((asset) => ({
        asset,
        kind: inferAssetKind(asset),
        title: String(asset.title || asset.relativePath || asset.id || '').trim(),
      }))
      .filter(({ asset, kind, title }) => {
        if (!keyword) return true;
        const haystack = [
          title,
          String(asset.relativePath || ''),
          String(asset.absolutePath || ''),
          kind,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(keyword);
      })
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }, [displayAssets, materialSearch]);

  const materialSections = useMemo(() => {
    return [
      {
        id: 'video',
        label: '视频',
        icon: Clapperboard,
        accentClass: 'text-cyan-200',
        assets: searchableAssets.filter((item) => item.kind === 'video'),
      },
      {
        id: 'image',
        label: '图片',
        icon: ImageIcon,
        accentClass: 'text-amber-200',
        assets: searchableAssets.filter((item) => item.kind === 'image'),
      },
      {
        id: 'audio',
        label: '音频',
        icon: AudioLines,
        accentClass: 'text-pink-200',
        assets: searchableAssets.filter((item) => item.kind === 'audio'),
      },
    ].filter((section) => section.assets.length > 0 && (effectiveMaterialFilter === 'all' || section.id === effectiveMaterialFilter));
  }, [effectiveMaterialFilter, searchableAssets]);

  const materialCountsByKind = useMemo(
    () => ({
      video: searchableAssets.filter((item) => item.kind === 'video').length,
      image: searchableAssets.filter((item) => item.kind === 'image').length,
      audio: searchableAssets.filter((item) => item.kind === 'audio').length,
    }),
    [searchableAssets]
  );
  const totalSearchableAssetCount = searchableAssets.length;

  const visibleAssetCount = useMemo(
    () => materialSections.reduce((sum, section) => sum + section.assets.length, 0),
    [materialSections]
  );

  useEffect(() => {
    editorStore.setState((state) => {
      if (!displayAssets.length) {
        return state.assets.currentPreviewAssetId ? {
          assets: {
            ...state.assets,
            currentPreviewAssetId: null,
          },
        } : {};
      }
      if (state.assets.currentPreviewAssetId && displayAssets.some((asset) => asset.id === state.assets.currentPreviewAssetId)) {
        return {};
      }
      return {
        assets: {
          ...state.assets,
          currentPreviewAssetId:
            primaryVideoAsset && displayAssets.some((asset) => asset.id === primaryVideoAsset.id)
              ? primaryVideoAsset.id
              : displayAssets[0]?.id || null,
        },
      };
    });
  }, [currentPreviewAssetId, displayAssets, editorStore, primaryVideoAsset]);

  useEffect(() => {
    syncEditorProjectSnapshot(editorStore, packageEditorProject);
  }, [editorStore, packageEditorProject]);

  useEffect(() => {
    syncEditorSelectionSnapshot(editorStore, {
      selectedClipId,
      activeTrackId,
    });
  }, [activeTrackId, editorStore, selectedClipId]);

  useEffect(() => {
    editorStore.setState((state) => {
      const nextComposition = remotionComposition || null;
      const nextSelectedSceneId = nextComposition?.scenes?.some((scene) => scene.id === state.scene.selectedSceneId)
        ? state.scene.selectedSceneId
        : nextComposition?.scenes?.[0]?.id || null;
      const inferredRatioPreset: VideoEditorRatioPreset = (nextComposition?.width || state.project.width) >= (nextComposition?.height || state.project.height) ? '16:9' : '9:16';
      const packageTrackUi = packageEditorProject
        ? deriveTrackUiMap(packageEditorProject)
        : state.timeline.trackUi;
      const packageSceneUi = packageState && typeof (packageState as { sceneUi?: unknown }).sceneUi === 'object'
        ? ((packageState as { sceneUi?: {
          itemVisibility?: Record<string, boolean>;
          itemOrder?: string[];
          itemLocks?: Record<string, boolean>;
          itemGroups?: Record<string, string>;
          focusedGroupId?: string | null;
        } }).sceneUi || {})
        : {};
      return {
        project: {
          ...state.project,
          title,
          filePath: editorFile,
          width: nextComposition?.width || state.project.width,
          height: nextComposition?.height || state.project.height,
          ratioPreset: inferredRatioPreset,
          fps: nextComposition?.fps || state.project.fps,
          durationInFrames: nextComposition?.durationInFrames || state.project.durationInFrames,
          exportPath: remotionRenderPath || null,
          isExporting: isRenderingRemotion,
        },
        timeline: {
          ...state.timeline,
          trackUi: Object.keys(packageTrackUi).length > 0 ? packageTrackUi : state.timeline.trackUi,
        },
        scene: {
          ...state.scene,
          editableComposition: nextComposition,
          selectedSceneId: nextSelectedSceneId,
          itemTransforms: normalizeSceneItemTransforms(
            nextComposition?.sceneItemTransforms || state.scene.itemTransforms,
            nextComposition?.width || state.project.width,
            nextComposition?.height || state.project.height
          ),
          itemVisibility: packageSceneUi.itemVisibility || state.scene.itemVisibility,
          itemOrder: Array.isArray(packageSceneUi.itemOrder) ? packageSceneUi.itemOrder : state.scene.itemOrder,
          itemLocks: packageSceneUi.itemLocks || state.scene.itemLocks,
          itemGroups: packageSceneUi.itemGroups || state.scene.itemGroups,
          focusedGroupId: typeof packageSceneUi.focusedGroupId === 'string' ? packageSceneUi.focusedGroupId : state.scene.focusedGroupId,
        },
        script: {
          ...state.script,
          dirty: editorBodyDirty,
        },
      };
    });
  }, [editorBodyDirty, editorFile, editorStore, isRenderingRemotion, packageEditorProject, packageState, remotionComposition, remotionRenderPath, title]);

  useEffect(() => {
    if (!editorFile) return;
    let cancelled = false;
    void window.ipcRenderer
      .invoke('manuscripts:get-editor-runtime-state', { filePath: editorFile })
      .then((result) => {
        if (cancelled || !result?.success || !result.state) return;
        const runtimeState = result.state as Record<string, unknown>;
        const nextPreviewTime = Number(runtimeState.playheadSeconds || 0);
        const nextSelectedClipId = String(runtimeState.selectedClipId || '').trim() || null;
        const nextActiveTrackId = String(runtimeState.activeTrackId || '').trim() || null;
        const nextSelectedSceneId = String(runtimeState.selectedSceneId || '').trim() || null;
        const nextPreviewTab = String(runtimeState.previewTab || '').trim();
        const nextRatioPreset = String(runtimeState.canvasRatioPreset || '').trim();
        const nextPanel = String(runtimeState.activePanel || '').trim();
        const hasDrawerPanel = Object.prototype.hasOwnProperty.call(runtimeState, 'drawerPanel');
        const nextDrawerPanel = String(runtimeState.drawerPanel || '').trim();
        const nextTrackUi = runtimeState.trackUi && typeof runtimeState.trackUi === 'object'
          ? runtimeState.trackUi as VideoEditorState['timeline']['trackUi']
          : null;
        const nextSceneItemLocks = runtimeState.sceneItemLocks && typeof runtimeState.sceneItemLocks === 'object'
          ? runtimeState.sceneItemLocks as VideoEditorState['scene']['itemLocks']
          : null;
        const nextSceneItemGroups = runtimeState.sceneItemGroups && typeof runtimeState.sceneItemGroups === 'object'
          ? runtimeState.sceneItemGroups as VideoEditorState['scene']['itemGroups']
          : null;
        const nextSceneItemVisibility = runtimeState.sceneItemVisibility && typeof runtimeState.sceneItemVisibility === 'object'
          ? runtimeState.sceneItemVisibility as VideoEditorState['scene']['itemVisibility']
          : null;
        const nextSceneItemOrder = Array.isArray(runtimeState.sceneItemOrder)
          ? runtimeState.sceneItemOrder as VideoEditorState['scene']['itemOrder']
          : null;
        const nextFocusedGroupId = String(runtimeState.focusedGroupId || '').trim() || null;
        editorStore.setState((state) => {
          const nextSceneItemTransforms = runtimeState.sceneItemTransforms && typeof runtimeState.sceneItemTransforms === 'object'
            ? normalizeSceneItemTransforms(runtimeState.sceneItemTransforms, state.project.width, state.project.height)
            : null;
          return {
            player: {
              ...state.player,
              currentTime: Number.isFinite(nextPreviewTime) ? quantizePreviewTime(nextPreviewTime) : 0,
              previewTab: nextPreviewTab === 'preview' || nextPreviewTab === 'motion' || nextPreviewTab === 'script'
                ? nextPreviewTab
                : state.player.previewTab,
            },
            project: {
              ...state.project,
              ratioPreset: nextRatioPreset === '16:9' || nextRatioPreset === '9:16' || nextRatioPreset === '4:3' || nextRatioPreset === '3:4'
                ? nextRatioPreset
                : state.project.ratioPreset,
            },
            timeline: {
              ...state.timeline,
              selectedClipId: nextSelectedClipId,
              activeTrackId: nextActiveTrackId,
              viewport: {
                scrollLeft: Number(runtimeState.viewportScrollLeft || 0) || 0,
                maxScrollLeft: Number(runtimeState.viewportMaxScrollLeft || 0) || 0,
                scrollTop: Number(runtimeState.viewportScrollTop || state.timeline.viewport.scrollTop || 0) || 0,
                maxScrollTop: Number(runtimeState.viewportMaxScrollTop || state.timeline.viewport.maxScrollTop || 0) || 0,
              },
              zoomPercent: Number(runtimeState.timelineZoomPercent || 100) || 100,
              playheadSeconds: Number.isFinite(nextPreviewTime) ? quantizePreviewTime(nextPreviewTime) : 0,
              trackUi: nextTrackUi || state.timeline.trackUi,
            },
            scene: {
              ...state.scene,
              selectedSceneId: nextSelectedSceneId,
              itemTransforms: nextSceneItemTransforms || state.scene.itemTransforms,
              itemVisibility: nextSceneItemVisibility || state.scene.itemVisibility,
              itemOrder: nextSceneItemOrder || state.scene.itemOrder,
              itemLocks: nextSceneItemLocks || state.scene.itemLocks,
              itemGroups: nextSceneItemGroups || state.scene.itemGroups,
              focusedGroupId: nextFocusedGroupId ?? state.scene.focusedGroupId,
            },
            panels: {
              ...state.panels,
              leftPanel: nextPanel ? nextPanel as VideoEditorLeftPanel : state.panels.leftPanel,
              redclawDrawerOpen: hasDrawerPanel ? nextDrawerPanel === 'redclaw' : true,
            },
            editor: {
              ...state.editor,
              history: {
                ...state.editor.history,
                canUndo: Boolean(runtimeState.canUndo),
                canRedo: Boolean(runtimeState.canRedo),
              },
            },
          };
        });
      })
      .catch((error) => {
        console.error('Failed to restore editor runtime state:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [editorFile, editorStore, quantizePreviewTime]);

  const handleRuntimeHistoryAvailabilityChange = useCallback((history: { canUndo: boolean; canRedo: boolean }) => {
    editorStore.setState((state) => ({
      editor: {
        ...state.editor,
        history: {
          ...state.editor.history,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
        },
      },
    }));
  }, [editorStore]);

  const refreshRuntimeHistoryAvailability = useCallback(async () => {
    if (!editorFile) return;
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:get-editor-runtime-state', {
        filePath: editorFile,
      }) as { success?: boolean; state?: Record<string, unknown> };
      if (!result?.success || !result.state) {
        return;
      }
      handleRuntimeHistoryAvailabilityChange({
        canUndo: Boolean(result.state.canUndo),
        canRedo: Boolean(result.state.canRedo),
      });
    } catch (error) {
      console.error('Failed to refresh editor runtime history availability:', error);
    }
  }, [editorFile, handleRuntimeHistoryAvailabilityChange]);

  const handleUndoEditorProject = useCallback(async () => {
    if (!editorFile || !canUndo) return;
    const result = await window.ipcRenderer.invoke('manuscripts:undo-editor-project', {
      filePath: editorFile,
    }) as { success?: boolean; state?: PackageStateLike; error?: string };
    if (!result?.success || !result.state) {
      console.error('Failed to undo editor project:', result?.error || 'Unknown error');
      return;
    }
    onPackageStateChange(result.state);
    await refreshRuntimeHistoryAvailability();
  }, [canUndo, editorFile, onPackageStateChange, refreshRuntimeHistoryAvailability]);

  const handleRedoEditorProject = useCallback(async () => {
    if (!editorFile || !canRedo) return;
    const result = await window.ipcRenderer.invoke('manuscripts:redo-editor-project', {
      filePath: editorFile,
    }) as { success?: boolean; state?: PackageStateLike; error?: string };
    if (!result?.success || !result.state) {
      console.error('Failed to redo editor project:', result?.error || 'Unknown error');
      return;
    }
    onPackageStateChange(result.state);
    await refreshRuntimeHistoryAvailability();
  }, [canRedo, editorFile, onPackageStateChange, refreshRuntimeHistoryAvailability]);

  useEffect(() => {
    void refreshRuntimeHistoryAvailability();
  }, [refreshRuntimeHistoryAvailability]);

  useEffect(() => {
    if (!editorFile) return;
    const timer = window.setTimeout(() => {
      void window.ipcRenderer.invoke('manuscripts:update-editor-runtime-state', {
        filePath: editorFile,
        sessionId: editorChatSessionId,
        playheadSeconds: previewCurrentTime,
        selectedClipId,
        selectedClipIds: selectedClipId ? [selectedClipId] : [],
        activeTrackId,
        selectedTrackIds: activeTrackId ? [activeTrackId] : [],
        selectedSceneId,
        previewTab,
        canvasRatioPreset: ratioPreset,
        activePanel: leftPanel,
        drawerPanel: 'redclaw',
        sceneItemTransforms: itemTransforms,
        sceneItemVisibility: sceneItemVisibility,
        sceneItemOrder: sceneItemOrder,
        sceneItemLocks: sceneItemLocks,
        sceneItemGroups: sceneItemGroups,
        focusedGroupId,
        viewportScrollLeft: timelineViewport.scrollLeft,
        viewportMaxScrollLeft: timelineViewport.maxScrollLeft,
        viewportScrollTop: timelineViewport.scrollTop,
        viewportMaxScrollTop: timelineViewport.maxScrollTop,
        timelineZoomPercent: editorStore.getState().timeline.zoomPercent,
        trackUi: editorStore.getState().timeline.trackUi,
      }).then((result) => {
        if (!result?.success || !result.state) {
          return;
        }
        const runtimeState = result.state as Record<string, unknown>;
        handleRuntimeHistoryAvailabilityChange({
          canUndo: Boolean(runtimeState.canUndo),
          canRedo: Boolean(runtimeState.canRedo),
        });
      }).catch((error) => {
        console.error('Failed to persist editor runtime state:', error);
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    editorChatSessionId,
    editorFile,
    previewCurrentTime,
    selectedClipId,
    activeTrackId,
    selectedSceneId,
    previewTab,
    ratioPreset,
    leftPanel,
    redclawDrawerOpen,
    itemTransforms,
    sceneItemOrder,
    sceneItemVisibility,
    sceneItemGroups,
    sceneItemLocks,
    focusedGroupId,
    timelineViewport.maxScrollLeft,
    timelineViewport.scrollLeft,
    timelineViewport.maxScrollTop,
    timelineViewport.scrollTop,
    handleRuntimeHistoryAvailabilityChange,
  ]);

  useEffect(() => {
    if (!editorFile) return;
    const timer = window.setTimeout(() => {
      void window.ipcRenderer.invoke('manuscripts:update-package-track-ui', {
        filePath: editorFile,
        trackUi: timelineTrackUi,
      }).then((result) => {
        if (result?.success && result.state) {
          onPackageStateChange(result.state as PackageStateLike);
        }
      }).catch((error) => {
        console.error('Failed to persist package track ui:', error);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [editorFile, onPackageStateChange, timelineTrackUi]);

  useEffect(() => {
    if (!editorFile) return;
    const timer = window.setTimeout(() => {
      void window.ipcRenderer.invoke('manuscripts:update-package-scene-ui', {
        filePath: editorFile,
        sceneUi: {
          itemVisibility: sceneItemVisibility,
          itemOrder: sceneItemOrder,
          itemLocks: sceneItemLocks,
          itemGroups: sceneItemGroups,
          focusedGroupId,
        },
      }).then((result) => {
        if (result?.success && result.state) {
          onPackageStateChange(result.state as PackageStateLike);
        }
      }).catch((error) => {
        console.error('Failed to persist package scene ui:', error);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [editorFile, focusedGroupId, onPackageStateChange, sceneItemGroups, sceneItemLocks, sceneItemOrder, sceneItemVisibility]);

  const currentPreviewAsset = useMemo(
    () => displayAssets.find((asset) => asset.id === currentPreviewAssetId) || primaryVideoAsset || displayAssets[0] || null,
    [currentPreviewAssetId, displayAssets, primaryVideoAsset]
  );
  const timelineTrackOrder = useMemo(
    () => buildTimelineTrackOrder(effectiveTimelineTrackNames, timelineClips),
    [effectiveTimelineTrackNames, timelineClips]
  );
  const timelineTrackOrderIndex = useMemo(
    () => new Map(timelineTrackOrder.map((trackId, index) => [trackId, index])),
    [timelineTrackOrder]
  );
  const assetsById = useMemo(
    () => Object.fromEntries(displayAssets.map((asset) => [asset.id, asset])),
    [displayAssets]
  );
  const compareTimelineClipsByTrackOrder = useCallback((left: VideoClipLike, right: VideoClipLike) => {
    const trackDelta = trackOrderValue(String(left.track || '').trim(), timelineTrackOrderIndex)
      - trackOrderValue(String(right.track || '').trim(), timelineTrackOrderIndex);
    if (trackDelta !== 0) return trackDelta;
    const startDelta = Number(left.startSeconds || 0) - Number(right.startSeconds || 0);
    if (Math.abs(startDelta) > 0.0001) return startDelta;
    const orderDelta = clipOrderInTrack(left, timelineClips) - clipOrderInTrack(right, timelineClips);
    if (orderDelta !== 0) return orderDelta;
    return String(left.clipId || '').localeCompare(String(right.clipId || ''), 'zh-CN');
  }, [timelineClips, timelineTrackOrderIndex]);
  const timelineRenderableClips = useMemo(
    () => timelineClips.filter((clip) => {
      const trackId = String(clip.track || '').trim();
      return !(timelineTrackUi[trackId]?.hidden);
    }),
    [timelineClips, timelineTrackUi]
  );
  const timelinePlayableAudioClips = useMemo(
    () => timelineRenderableClips.filter((clip) => String(clip.assetKind || '').trim().toLowerCase() === 'audio'),
    [timelineRenderableClips]
  );
  const timelineSoloAudioClips = useMemo(
    () => timelinePlayableAudioClips.filter((clip) => {
      const trackId = String(clip.track || '').trim();
      return !!timelineTrackUi[trackId]?.solo;
    }),
    [timelinePlayableAudioClips, timelineTrackUi]
  );
  const timelineAudibleClips = useMemo(
    () => {
      const source = timelineSoloAudioClips.length > 0 ? timelineSoloAudioClips : timelinePlayableAudioClips;
      return source.filter((clip) => {
        const trackId = String(clip.track || '').trim();
        return !(timelineTrackUi[trackId]?.muted);
      });
    },
    [timelinePlayableAudioClips, timelineSoloAudioClips, timelineTrackUi]
  );

  const clipAtTime = useMemo(() => {
    return (timeInSeconds: number) => {
      const targetTime = Math.max(0, timeInSeconds);
      const containingClip = [...timelineRenderableClips]
        .filter((clip) => {
          const start = Number(clip.startSeconds || 0);
          const end = Number(clip.endSeconds || 0);
          return Number.isFinite(start) && Number.isFinite(end) && targetTime >= start && targetTime <= end;
        })
        .sort(compareTimelineClipsByTrackOrder)[0];
      return containingClip || null;
    };
  }, [compareTimelineClipsByTrackOrder, timelineRenderableClips]);
  const activeTimelineClip = useMemo(
    () => clipAtTime(previewCurrentTime),
    [clipAtTime, previewCurrentTime]
  );
  const visibleTimelineClips = useMemo(
    () => [...timelineRenderableClips]
      .filter((clip) => {
        const start = Number(clip.startSeconds || 0);
        const end = Number(clip.endSeconds || 0);
        return Number.isFinite(start) && Number.isFinite(end) && previewCurrentTime >= start && previewCurrentTime <= end;
      })
      .sort(compareTimelineClipsByTrackOrder),
    [compareTimelineClipsByTrackOrder, previewCurrentTime, timelineRenderableClips]
  );
  const activeVisualTimelineClip = useMemo(
    () => visibleTimelineClips.find((clip) => {
      const kind = String(clip.assetKind || '').trim().toLowerCase();
      return kind === 'video' || kind === 'image';
    }) || null,
    [visibleTimelineClips]
  );
  const activeAudioTimelineClip = useMemo(
    () => [...timelineAudibleClips]
      .filter((clip) => {
        const start = Number(clip.startSeconds || 0);
        const end = Number(clip.endSeconds || 0);
        return Number.isFinite(start)
          && Number.isFinite(end)
          && previewCurrentTime >= start
          && previewCurrentTime <= end;
      })
      .sort(compareTimelineClipsByTrackOrder)[0] || null,
    [compareTimelineClipsByTrackOrder, previewCurrentTime, timelineAudibleClips]
  );
  const selectedTimelineClip = useMemo(() => {
    const normalizedSelectedClipId = String(selectedClipId || '').trim();
    if (normalizedSelectedClipId) {
      const matched = timelineClips.find((clip) => String(clip.clipId || '').trim() === normalizedSelectedClipId);
      if (matched) return matched;
    }
    return activeTimelineClip;
  }, [activeTimelineClip, selectedClipId, timelineClips]);
  const selectedClipAsset = useMemo(() => {
    const assetId = String(selectedTimelineClip?.assetId || '').trim();
    if (!assetId) return null;
    return displayAssets.find((asset) => asset.id === assetId) || null;
  }, [displayAssets, selectedTimelineClip]);
  const subtitleRecognitionClip = useMemo(() => {
    const candidates = [selectedTimelineClip, activeAudioTimelineClip, activeVisualTimelineClip];
    return candidates.find((clip) => {
      const kind = String(clip?.assetKind || '').trim().toLowerCase();
      return kind === 'audio' || kind === 'video';
    }) || null;
  }, [activeAudioTimelineClip, activeVisualTimelineClip, selectedTimelineClip]);
  const subtitleClips = useMemo(
    () => timelineClips.filter((clip) => {
      const kind = String(clip.assetKind || '').trim().toLowerCase();
      const track = String(clip.track || '').trim().toUpperCase();
      return kind === 'subtitle' || kind === 'caption' || track.startsWith('S') || track.startsWith('C');
    }),
    [timelineClips]
  );
  const textClips = useMemo(
    () => timelineClips.filter((clip) => String(clip.assetKind || '').trim().toLowerCase() === 'text'),
    [timelineClips]
  );
  const transitionClipCount = useMemo(
    () => timelineClips.filter((clip) => {
      const presetId = String(clip.transitionStyle?.presetId || '').trim();
      const kind = String(clip.transitionStyle?.kind || '').trim();
      return (presetId && presetId !== 'none') || (kind && kind !== 'none');
    }).length,
    [timelineClips]
  );
  const activeTrackSummary = useMemo(() => {
    const normalizedTrackId = String(activeTrackId || '').trim();
    if (!normalizedTrackId) return null;
    const trackClips = timelineClips.filter((clip) => String(clip.track || '').trim() === normalizedTrackId);
    const totalSeconds = trackClips.reduce((sum, clip) => {
      const start = Number(clip.startSeconds || 0);
      const end = Number(clip.endSeconds || 0);
      return sum + Math.max(0, end - start);
    }, 0);
    const kind = normalizedTrackId.startsWith('A') ? '音频轨' : normalizedTrackId.startsWith('S') ? '字幕轨' : '视频轨';
    return {
      id: normalizedTrackId,
      kind,
      clipCount: trackClips.length,
      totalSeconds,
      ui: timelineTrackUi[normalizedTrackId] || { locked: false, hidden: false, collapsed: false, muted: false, solo: false, volume: 1 },
    };
  }, [activeTrackId, timelineClips, timelineTrackUi]);
  const canDeleteActiveTrack = useMemo(() => {
    if (!activeTrackSummary) {
      return false;
    }
    const prefix = activeTrackSummary.id.startsWith('A')
      ? 'A'
      : activeTrackSummary.id.startsWith('S')
        ? 'S'
        : 'V';
    return timelineTrackNames.filter((trackId) => trackId.startsWith(prefix)).length > 1;
  }, [activeTrackSummary, timelineTrackNames]);
  const sidebarTabs = useMemo(
    () => [
      { id: 'uploads' as const, label: '素材', icon: Plus, count: totalSearchableAssetCount },
      { id: 'videos' as const, label: '视频', icon: Clapperboard, count: materialCountsByKind.video },
      { id: 'images' as const, label: '图片', icon: ImageIcon, count: materialCountsByKind.image },
      { id: 'audios' as const, label: '音频', icon: AudioLines, count: materialCountsByKind.audio },
      { id: 'texts' as const, label: '文本', icon: Type, count: textClips.length },
      { id: 'captions' as const, label: '字幕', icon: MessageSquare, count: subtitleClips.length },
      { id: 'transitions' as const, label: '转场', icon: GitBranchPlus, count: transitionClipCount },
      { id: 'selection' as const, label: '编辑', icon: SlidersHorizontal, count: selectedTimelineClip ? 1 : 0 },
    ],
    [materialCountsByKind.audio, materialCountsByKind.image, materialCountsByKind.video, selectedTimelineClip, subtitleClips.length, textClips.length, totalSearchableAssetCount, transitionClipCount]
  );
  useEffect(() => {
    const visibleClipIds = visibleTimelineClips
      .map((clip) => String(clip.clipId || '').trim())
      .filter(Boolean);
    const orderedClipIds = [...timelineClips]
      .filter((clip) => {
        const trackId = String(clip.track || '').trim();
        return !(timelineTrackUi[trackId]?.hidden);
      })
      .sort((left, right) => {
        const startDelta = Number(left.startSeconds || 0) - Number(right.startSeconds || 0);
        if (Math.abs(startDelta) > 0.0001) return startDelta;
        return compareTimelineClipsByTrackOrder(left, right);
      })
      .map((clip) => String(clip.clipId || '').trim())
      .filter(Boolean);
    const activeClipId = String((activeVisualTimelineClip || activeAudioTimelineClip || activeTimelineClip)?.clipId || '').trim() || null;
    const activeAssetId = String((activeVisualTimelineClip || activeAudioTimelineClip || activeTimelineClip)?.assetId || '').trim() || null;
    editorStore.setState((state) => ({
      timelinePreview: {
        ...state.timelinePreview,
        activeClipId,
        visibleClipIds,
        orderedClipIds,
        timelineDurationSeconds,
        playbackStatus: state.player.isPlaying ? 'playing' : (previewCurrentTime >= timelineDurationSeconds ? 'ended' : 'idle'),
      },
      assets: {
        ...state.assets,
        currentPreviewAssetId: activeAssetId || state.assets.currentPreviewAssetId,
      },
    }));
  }, [activeAudioTimelineClip, activeTimelineClip, activeVisualTimelineClip, compareTimelineClipsByTrackOrder, editorStore, previewCurrentTime, timelineClips, timelineDurationSeconds, timelineTrackUi, visibleTimelineClips]);

  useEffect(() => {
    if (!isActive || !editorChatSessionId) return;
    const parseJsonOutput = (raw: unknown): Record<string, unknown> | null => {
      const text = String(raw || '').trim();
      if (!text) return null;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    };
    return subscribeRuntimeEventStream({
      getActiveSessionId: () => editorChatSessionId,
      onToolResult: ({ name, output }) => {
        if (name !== 'redbox_editor' || !output?.success) return;
        const parsed = parseJsonOutput(output.content);
        const nextState = parsed?.state;
        if (nextState && typeof nextState === 'object') {
          onPackageStateChange(nextState as PackageStateLike);
        }
      },
      onTaskCheckpointSaved: ({ checkpointType, checkpointPayload }) => {
        if (checkpointType === 'editor.timeline_changed') {
          void window.ipcRenderer
            .invoke('manuscripts:get-package-state', editorFile)
            .then((result) => {
              if (result?.success && result.state) {
                onPackageStateChange(result.state as PackageStateLike);
              }
            })
            .catch((error) => {
              console.error('Failed to refresh package state after editor timeline change:', error);
            });
          return;
        }
        if (checkpointType === 'editor.playhead_changed') {
          const nextSeconds = Number(checkpointPayload.seconds || 0);
          if (Number.isFinite(nextSeconds)) {
            editorStore.setState((state) => ({
              player: {
                ...state.player,
                currentTime: Math.max(0, nextSeconds),
              },
              timeline: {
                ...state.timeline,
                playheadSeconds: Math.max(0, nextSeconds),
              },
            }));
          }
          return;
        }
        if (checkpointType === 'editor.selection_changed') {
          const nextClipId = String(checkpointPayload.clipId || '').trim();
          editorStore.setState((state) => ({
            timeline: {
              ...state.timeline,
              selectedClipId: nextClipId || null,
            },
            selection: {
              ...state.selection,
              kind: nextClipId ? 'clip' : state.selection.kind,
            },
            panels: {
              ...state.panels,
              leftPanel: nextClipId ? 'selection' : state.panels.leftPanel,
            },
          }));
          return;
        }
        if (checkpointType === 'editor.panel_changed') {
          const nextPreviewTab = String(checkpointPayload.previewTab || '').trim();
          const nextPanel = String(checkpointPayload.activePanel || '').trim();
          const hasDrawerPanel = Object.prototype.hasOwnProperty.call(checkpointPayload, 'drawerPanel');
          const nextDrawerPanel = String(checkpointPayload.drawerPanel || '').trim();
          editorStore.setState((state) => ({
            player: {
              ...state.player,
              previewTab: nextPreviewTab === 'preview' || nextPreviewTab === 'motion' || nextPreviewTab === 'script'
                ? nextPreviewTab
                : state.player.previewTab,
            },
            panels: {
              ...state.panels,
              leftPanel: nextPanel ? nextPanel as VideoEditorLeftPanel : state.panels.leftPanel,
              redclawDrawerOpen: hasDrawerPanel ? nextDrawerPanel === 'redclaw' : true,
            },
          }));
        }
      },
    });
  }, [editorChatSessionId, editorFile, editorStore, isActive, onPackageStateChange]);

  const selectedScene = useMemo(() => {
    if (!editableComposition?.scenes?.length) return null;
    return editableComposition.scenes.find((scene) => scene.id === selectedSceneId) || editableComposition.scenes[0] || null;
  }, [editableComposition, selectedSceneId]);

  const motionDurationInFrames = editableComposition?.durationInFrames
    || Math.max(1, Math.round(computeTimelineDurationSeconds(timelineClips) * effectiveFps));
  const effectiveDurationInFrames = previewTab === 'motion' ? motionDurationInFrames : timelineDurationInFrames;
  const currentFrame = Math.max(0, Math.round(previewCurrentTime * effectiveFps));

  useEffect(() => {
    if (previewTab !== 'preview') return;
    suspendPreviewTimeSync(220);
  }, [currentPreviewAssetId, previewTab, suspendPreviewTimeSync]);

  useEffect(() => {
    if (!dragState) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (dragState.target === 'materials') {
        const deltaX = event.clientX - dragState.startX;
        editorStore.setState((state) => ({
          panels: {
            ...state.panels,
            materialPaneWidth: clamp(dragState.materialPaneWidth + deltaX, 272, 420),
          },
        }));
        return;
      }
      const deltaY = dragState.startY - event.clientY;
      editorStore.setState((state) => ({
        panels: {
          ...state.panels,
          timelineHeight: clamp(dragState.timelineHeight + deltaY, 240, 480),
        },
      }));
    };

    const handlePointerUp = () => {
      setDragState(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = dragState.target === 'timeline' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragState]);

  useEffect(() => {
    if (!materialDragPreview) return;

    const handleDragOver = (event: DragEvent) => {
      setMaterialDragPreview((current) => current ? {
        ...current,
        x: event.clientX,
        y: event.clientY,
      } : current);
    };

    const handleDragEnd = () => {
      setMaterialDragPreview(null);
    };

    const handleTimelineDragState = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setMaterialDragPreview((current) => current ? {
        ...current,
        overTimeline: !!detail?.active,
      } : current);
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragend', handleDragEnd);
    window.addEventListener('redbox-video-editor:timeline-drag-state', handleTimelineDragState as EventListener);
    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragend', handleDragEnd);
      window.removeEventListener('redbox-video-editor:timeline-drag-state', handleTimelineDragState as EventListener);
    };
  }, [!!materialDragPreview]);

  useEffect(() => {
    const handleImportRequest = () => {
      onOpenBindAssets();
    };
    window.addEventListener('redbox-video-editor:request-import-assets', handleImportRequest);
    return () => {
      window.removeEventListener('redbox-video-editor:request-import-assets', handleImportRequest);
    };
  }, [onOpenBindAssets]);

  useEffect(() => {
    if (previewTab !== 'preview' || !isPreviewPlaying) {
      if (previewPlaybackRafRef.current !== null) {
        window.cancelAnimationFrame(previewPlaybackRafRef.current);
        previewPlaybackRafRef.current = null;
      }
      previewPlaybackLastTickRef.current = null;
      return;
    }

    const totalDurationSeconds = Math.max(0, timelineDurationSeconds);
    const tick = (now: number) => {
      const lastTick = previewPlaybackLastTickRef.current ?? now;
      const deltaSeconds = Math.max(0, (now - lastTick) / 1000);
      previewPlaybackLastTickRef.current = now;
      const currentState = editorStore.getState();
      const nextTime = quantizePreviewTime(Math.min(totalDurationSeconds, currentState.player.currentTime + deltaSeconds));
      const nextFrame = Math.max(0, Math.round(nextTime * effectiveFps));

      editorStore.setState((state) => ({
        player: {
          ...state.player,
          currentTime: nextTime,
          currentFrame: nextFrame,
          isPlaying: nextTime < totalDurationSeconds,
        },
        timeline: {
          ...state.timeline,
          playheadSeconds: nextTime,
        },
      }));

      if (nextTime >= totalDurationSeconds) {
        previewPlaybackRafRef.current = null;
        previewPlaybackLastTickRef.current = null;
        return;
      }

      previewPlaybackRafRef.current = window.requestAnimationFrame(tick);
    };

    previewPlaybackRafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (previewPlaybackRafRef.current !== null) {
        window.cancelAnimationFrame(previewPlaybackRafRef.current);
        previewPlaybackRafRef.current = null;
      }
      previewPlaybackLastTickRef.current = null;
    };
  }, [editorStore, effectiveFps, isPreviewPlaying, previewTab, quantizePreviewTime, timelineDurationSeconds]);

  useEffect(() => {
    const player = remotionPlayerRef.current;
    if (!player || previewTab !== 'motion') return;
    const handleFrameUpdate = (event: { detail: { frame: number } }) => {
      const nextTime = quantizePreviewTime((event.detail.frame || 0) / effectiveFps);
      editorStore.setState((state) => ({
        player: {
          ...state.player,
          currentTime: nextTime,
          currentFrame: Math.max(0, event.detail.frame || 0),
        },
        timeline: {
          ...state.timeline,
          playheadSeconds: nextTime,
        },
      }));
    };
    const handlePlay = () => editorStore.setState((state) => ({ player: { ...state.player, isPlaying: true } }));
    const handlePause = () => editorStore.setState((state) => ({ player: { ...state.player, isPlaying: false } }));
    const handleEnded = () => editorStore.setState((state) => ({ player: { ...state.player, isPlaying: false } }));
    player.addEventListener('frameupdate', handleFrameUpdate);
    player.addEventListener('play', handlePlay);
    player.addEventListener('pause', handlePause);
    player.addEventListener('ended', handleEnded);
    return () => {
      player.removeEventListener('frameupdate', handleFrameUpdate);
      player.removeEventListener('play', handlePlay);
      player.removeEventListener('pause', handlePause);
      player.removeEventListener('ended', handleEnded);
    };
  }, [editableComposition?.durationInFrames, editableComposition?.scenes?.length, editorStore, effectiveFps, previewTab, quantizePreviewTime]);

  useEffect(() => {
    const player = remotionPlayerRef.current;
    if (!player || previewTab !== 'motion') return;
    const playerFrame = player.getCurrentFrame();
    if (Math.abs(playerFrame - currentFrame) > 0) {
      player.seekTo(currentFrame);
    }
  }, [currentFrame, previewTab]);

  useEffect(() => {
    const player = remotionPlayerRef.current;
    if (!player || previewTab !== 'motion') return;
    if (isPreviewPlaying) {
      if (!player.isPlaying()) {
        player.play();
      }
      return;
    }
    if (player.isPlaying()) {
      player.pause();
    }
  }, [isPreviewPlaying, previewTab]);

  const seekPreviewFrame = (frame: number) => {
    const boundedFrame = clamp(frame, 0, Math.max(0, effectiveDurationInFrames - 1));
    const nextTime = quantizePreviewTime(boundedFrame / effectiveFps);
    editorStore.setState((state) => ({
      player: {
        ...state.player,
        currentTime: nextTime,
        currentFrame: boundedFrame,
      },
      timeline: {
        ...state.timeline,
        playheadSeconds: nextTime,
      },
    }));
    if (previewTab === 'motion') {
      remotionPlayerRef.current?.seekTo(boundedFrame);
      return;
    }
  };

  const togglePreviewPlayback = () => {
    if (previewTab === 'motion') {
      const player = remotionPlayerRef.current;
      if (!player) return;
      if (player.isPlaying()) {
        player.pause();
      } else {
        player.play();
      }
      return;
    }
    editorStore.setState((state) => ({
      player: {
        ...state.player,
        isPlaying: !state.player.isPlaying,
      },
    }));
  };

  const stepPreviewFrame = (deltaFrames: number) => {
    const nextFrame = currentFrame + deltaFrames;
    seekPreviewFrame(nextFrame);
  };

  const resolveTargetTrackForAsset = async (asset: MediaAssetLike) => {
    if (!editorFile || !asset?.id) return;
    const kind = inferAssetKind(asset);
    const targetKind = kind === 'audio' ? 'audio' : 'video';
    let targetTrack = activeTrackId
      && (targetKind === 'audio' ? activeTrackId.startsWith('A') : activeTrackId.startsWith('V'))
      ? activeTrackId
      : [...timelineTrackNames]
        .reverse()
        .find((track) => (targetKind === 'audio' ? track.startsWith('A') : track.startsWith('V')));

    if (!targetTrack) {
      const createTrackResult = await window.ipcRenderer.invoke('manuscripts:add-package-track', {
        filePath: editorFile,
        kind: targetKind,
      }) as { success?: boolean; state?: Record<string, unknown> };
      if (createTrackResult?.success && createTrackResult.state) {
        onPackageStateChange(createTrackResult.state as PackageStateLike);
        const nextTrackNames = (
          (createTrackResult.state as { timelineSummary?: { trackNames?: string[] } })?.timelineSummary?.trackNames || []
        )
          .map((item) => String(item || '').trim())
          .filter(Boolean);
        targetTrack = [...nextTrackNames]
          .reverse()
          .find((track) => (targetKind === 'audio' ? track.startsWith('A') : track.startsWith('V')));
      }
    }

    return targetTrack || (targetKind === 'audio' ? 'A1' : 'V1');
  };

  const appendAssetToTimeline = async (asset: MediaAssetLike) => {
    if (!editorFile || !asset?.id) return;
    const desiredTrack = await resolveTargetTrackForAsset(asset);
    if (!desiredTrack) return;

    const order = timelineClips.filter((clip) => String(clip.track || '').trim() === desiredTrack).length;
    const result = await window.ipcRenderer.invoke('manuscripts:add-package-clip', {
      filePath: editorFile,
      assetId: asset.id,
      track: desiredTrack,
      order,
      durationMs: assetDurationMs(asset),
    }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
      const insertedClipId = String(result.insertedClipId || '').trim();
      if (insertedClipId) {
        editorStore.setState((state) => ({
          timeline: {
            ...state.timeline,
            selectedClipId: insertedClipId,
            activeTrackId: desiredTrack,
          },
          panels: {
            ...state.panels,
            leftPanel: 'selection',
          },
        }));
      }
    }
  };

  const insertAssetAtPlayhead = async (asset: MediaAssetLike) => {
    if (!editorFile || !asset?.id) return;
    const desiredTrack = await resolveTargetTrackForAsset(asset);
    if (!desiredTrack) return;
    const result = await window.ipcRenderer.invoke('manuscripts:insert-package-clip-at-playhead', {
      filePath: editorFile,
      assetId: asset.id,
      track: desiredTrack,
      durationMs: assetDurationMs(asset),
    }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
      const insertedClipId = String(result.insertedClipId || '').trim();
      if (insertedClipId) {
        editorStore.setState((state) => ({
          timeline: {
            ...state.timeline,
            selectedClipId: insertedClipId,
            activeTrackId: desiredTrack,
          },
          panels: {
            ...state.panels,
            leftPanel: 'selection',
          },
        }));
      }
    }
  };

  const insertSubtitleAtPlayhead = useCallback(async (text: string, durationMs = subtitleDraftDurationMs) => {
    if (!editorFile) return;
    const normalizedText = text.trim();
    if (!normalizedText) return;
    const preset = resolveSubtitlePreset(subtitlePresetId);
    const result = await window.ipcRenderer.invoke('manuscripts:insert-package-subtitle-at-playhead', {
      filePath: editorFile,
      track: activeTrackId && activeTrackId.startsWith('S') ? activeTrackId : undefined,
      text: normalizedText,
      durationMs: Math.max(500, Math.round(durationMs)),
      subtitleStyle: {
        position: preset.position,
        fontSize: preset.fontSize,
        color: preset.color,
        backgroundColor: preset.backgroundColor,
        align: preset.align,
        presetId: preset.id,
        animation: preset.animation,
        segmentationMode: preset.type === 'word' ? 'singleWord' : 'punctuationOrPause',
        linesPerCaption: 1,
      },
    }) as { success?: boolean; state?: Record<string, unknown>; insertedClipId?: string };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
      const insertedClipId = String(result.insertedClipId || '').trim();
      if (insertedClipId) {
        editorStore.setState((state) => ({
          timeline: {
            ...state.timeline,
            selectedClipId: insertedClipId,
          },
          panels: {
            ...state.panels,
            leftPanel: 'selection',
          },
        }));
      }
      setSubtitleDraftText('');
    }
  }, [activeTrackId, editorFile, editorStore, onPackageStateChange, subtitleDraftDurationMs, subtitlePresetId]);

  const transcribeSubtitlesForClip = useCallback(async () => {
    const clipId = String(subtitleRecognitionClip?.clipId || '').trim();
    if (!editorFile || !clipId || isTranscribingSubtitles) return;
    const preset = resolveSubtitlePreset(subtitlePresetId);
    setIsTranscribingSubtitles(true);
    setSubtitleTranscriptionNotice(null);
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:transcribe-package-subtitles', {
        filePath: editorFile,
        clipId,
        track: activeTrackId && activeTrackId.startsWith('S') ? activeTrackId : undefined,
        subtitleStyle: {
          position: preset.position,
          fontSize: preset.fontSize,
          color: preset.color,
          backgroundColor: preset.backgroundColor,
          emphasisColor: preset.emphasisColor,
          align: preset.align,
          presetId: preset.id,
          animation: preset.animation,
          fontWeight: preset.fontWeight,
          textTransform: preset.textTransform,
          letterSpacing: preset.letterSpacing,
          borderRadius: preset.borderRadius,
          paddingX: preset.paddingX,
          paddingY: preset.paddingY,
          segmentationMode: preset.type === 'word' ? 'singleWord' : 'punctuationOrPause',
          linesPerCaption: 1,
        },
      }) as {
        success?: boolean;
        error?: string;
        subtitleCount?: number;
        subtitleFile?: string;
        insertedClipId?: string;
        state?: Record<string, unknown>;
      };
      if (!result?.success || !result.state) {
        throw new Error(result?.error || '字幕识别失败');
      }
      onPackageStateChange(result.state as PackageStateLike);
      const insertedClipId = String(result.insertedClipId || '').trim();
      if (insertedClipId) {
        editorStore.setState((state) => ({
          timeline: {
            ...state.timeline,
            selectedClipId: insertedClipId,
            activeTrackId: activeTrackId && activeTrackId.startsWith('S') ? activeTrackId : state.timeline.activeTrackId,
          },
        }));
      }
      setSubtitleTranscriptionNotice(
        `已生成 ${Math.max(0, Number(result.subtitleCount || 0))} 段字幕，并保存到 ${String(result.subtitleFile || 'subtitles/')}`
      );
    } catch (error) {
      setSubtitleTranscriptionNotice(error instanceof Error ? error.message : String(error || '字幕识别失败'));
    } finally {
      setIsTranscribingSubtitles(false);
    }
  }, [activeTrackId, editorFile, editorStore, isTranscribingSubtitles, onPackageStateChange, subtitlePresetId, subtitleRecognitionClip]);

  const updateSubtitleClipText = useCallback(async (clipId: string, nextText: string) => {
    if (!editorFile || !clipId) return;
    const normalizedText = nextText.trim();
    if (!normalizedText) return;
    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
      filePath: editorFile,
      clipId,
      name: normalizedText,
      assetKind: 'subtitle',
      track: String(selectedTimelineClip?.track || activeTrackId || 'S1').trim() || 'S1',
      durationMs: Math.max(500, Number(selectedTimelineClip?.durationMs || subtitleDraftDurationMs)),
      trimInMs: Math.max(0, Number(selectedTimelineClip?.trimInMs || 0)),
      enabled: selectedTimelineClip?.enabled !== false,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange, selectedTimelineClip, subtitleDraftDurationMs]);

  const updateSubtitleClipStyle = useCallback(async (
    clipId: string,
    patch: NonNullable<VideoClipLike['subtitleStyle']>
  ) => {
    if (!editorFile || !clipId) return;
    const currentStyle = selectedTimelineClip?.subtitleStyle || {};
    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
      filePath: editorFile,
      clipId,
      name: String(selectedTimelineClip?.name || ''),
      assetKind: 'subtitle',
      subtitleStyle: {
        ...currentStyle,
        ...patch,
      },
      track: String(selectedTimelineClip?.track || activeTrackId || 'S1').trim() || 'S1',
      durationMs: Math.max(500, Number(selectedTimelineClip?.durationMs || subtitleDraftDurationMs)),
      trimInMs: Math.max(0, Number(selectedTimelineClip?.trimInMs || 0)),
      enabled: selectedTimelineClip?.enabled !== false,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange, selectedTimelineClip, subtitleDraftDurationMs]);

  const insertTextAtPlayhead = useCallback(async (text: string, durationMs = textDraftDurationMs) => {
    if (!editorFile) return;
    const normalizedText = text.trim();
    if (!normalizedText) return;
    const preset = resolveTextPreset(textPresetId);
    const result = await window.ipcRenderer.invoke('manuscripts:insert-package-text-at-playhead', {
      filePath: editorFile,
      text: normalizedText,
      track: activeTrackId && activeTrackId.startsWith('T') ? activeTrackId : undefined,
      durationMs: Math.max(600, Math.round(durationMs)),
      textStyle: {
        presetId: preset.id,
        fontSize: preset.fontSize,
        color: preset.color,
        backgroundColor: preset.backgroundColor,
        align: preset.align,
        fontWeight: preset.fontWeight,
        animation: preset.animation,
      },
    }) as { success?: boolean; state?: Record<string, unknown>; insertedClipId?: string };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
      const insertedClipId = String(result.insertedClipId || '').trim();
      if (insertedClipId) {
        editorStore.setState((state) => ({
          timeline: {
            ...state.timeline,
            selectedClipId: insertedClipId,
          },
          panels: {
            ...state.panels,
            leftPanel: 'selection',
          },
        }));
      }
    }
  }, [activeTrackId, editorFile, editorStore, onPackageStateChange, textDraftDurationMs, textPresetId]);

  const updateTextClipStyle = useCallback(async (
    clipId: string,
    patch: NonNullable<VideoClipLike['textStyle']>
  ) => {
    if (!editorFile || !clipId) return;
    const currentStyle = selectedTimelineClip?.textStyle || {};
    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
      filePath: editorFile,
      clipId,
      name: String(selectedTimelineClip?.name || ''),
      assetKind: 'text',
      textStyle: {
        ...currentStyle,
        ...patch,
      },
      track: String(selectedTimelineClip?.track || activeTrackId || 'T1').trim() || 'T1',
      durationMs: Math.max(600, Number(selectedTimelineClip?.durationMs || textDraftDurationMs)),
      trimInMs: Math.max(0, Number(selectedTimelineClip?.trimInMs || 0)),
      enabled: selectedTimelineClip?.enabled !== false,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange, selectedTimelineClip, textDraftDurationMs]);

  const updateTextClipText = useCallback(async (clipId: string, nextText: string) => {
    if (!editorFile || !clipId) return;
    const normalizedText = nextText.trim();
    if (!normalizedText) return;
    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
      filePath: editorFile,
      clipId,
      name: normalizedText,
      assetKind: 'text',
      textStyle: {
        ...(selectedTimelineClip?.textStyle || {}),
      },
      track: String(selectedTimelineClip?.track || activeTrackId || 'T1').trim() || 'T1',
      durationMs: Math.max(600, Number(selectedTimelineClip?.durationMs || textDraftDurationMs)),
      trimInMs: Math.max(0, Number(selectedTimelineClip?.trimInMs || 0)),
      enabled: selectedTimelineClip?.enabled !== false,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange, selectedTimelineClip, textDraftDurationMs]);

  const updateClipTransitionStyle = useCallback(async (
    clipId: string,
    patch: NonNullable<VideoClipLike['transitionStyle']>
  ) => {
    if (!editorFile || !clipId) return;
    const currentStyle = selectedTimelineClip?.transitionStyle || {};
    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
      filePath: editorFile,
      clipId,
      name: String(selectedTimelineClip?.name || ''),
      assetKind: String(selectedTimelineClip?.assetKind || ''),
      transitionStyle: {
        ...currentStyle,
        ...patch,
      },
      track: String(selectedTimelineClip?.track || activeTrackId || 'V1').trim() || 'V1',
      durationMs: Math.max(500, Number(selectedTimelineClip?.durationMs || DEFAULT_CLIP_MS)),
      trimInMs: Math.max(0, Number(selectedTimelineClip?.trimInMs || 0)),
      enabled: selectedTimelineClip?.enabled !== false,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange, selectedTimelineClip]);

  const selectedTransitionPreset = useMemo(
    () => resolveTransitionPreset(selectedTimelineClip?.transitionStyle?.presetId),
    [selectedTimelineClip]
  );
  const subtitleDraftPreset = useMemo(() => resolveSubtitlePreset(subtitlePresetId), [subtitlePresetId]);
  const textDraftPreset = useMemo(() => resolveTextPreset(textPresetId), [textPresetId]);
  const transitionPresetsByGroup = useMemo(() => ({
    dissolve: TRANSITION_PRESETS.filter((preset) => preset.group === 'dissolve'),
    motion: TRANSITION_PRESETS.filter((preset) => preset.group === 'motion'),
    mask: TRANSITION_PRESETS.filter((preset) => preset.group === 'mask'),
  }), []);
  const transitionEligibleClips = useMemo(
    () => [...timelineClips]
      .filter((clip) => {
        const kind = String(clip.assetKind || '').trim().toLowerCase();
        return kind === 'video' || kind === 'image';
      })
      .sort((left, right) => {
        const startDelta = Number(left.startSeconds || 0) - Number(right.startSeconds || 0);
        if (Math.abs(startDelta) > 0.0001) return startDelta;
        return compareTimelineClipsByTrackOrder(left, right);
      }),
    [compareTimelineClipsByTrackOrder, timelineClips]
  );
  const selectedTransitionContext = useMemo(() => {
    const selectedClipIdValue = String(selectedTimelineClip?.clipId || '').trim();
    if (!selectedClipIdValue) return null;
    const clipIndex = transitionEligibleClips.findIndex((clip) => String(clip.clipId || '').trim() === selectedClipIdValue);
    if (clipIndex === -1) return null;
    const current = transitionEligibleClips[clipIndex];
    const previous = clipIndex > 0 ? transitionEligibleClips[clipIndex - 1] : null;
    const next = clipIndex < transitionEligibleClips.length - 1 ? transitionEligibleClips[clipIndex + 1] : null;
    const durationMs = Math.max(0, Number(current.transitionStyle?.durationMs ?? selectedTransitionPreset.durationMs ?? 0));
    const direction = String(current.transitionStyle?.direction || selectedTransitionPreset.direction || '').trim();
    return {
      previous,
      current,
      next,
      durationMs,
      direction,
      preset: selectedTransitionPreset,
      isHead: clipIndex === 0,
      index: clipIndex + 1,
      total: transitionEligibleClips.length,
    };
  }, [selectedTimelineClip, selectedTransitionPreset, transitionEligibleClips]);
  const selectedClipSupportsTransition = useMemo(() => {
    const kind = String(selectedTimelineClip?.assetKind || '').trim().toLowerCase();
    return kind === 'video' || kind === 'image';
  }, [selectedTimelineClip]);
  const selectedSubtitleTokens = useMemo(
    () => extractCaptionTokens(String(selectedTimelineClip?.name || '')),
    [selectedTimelineClip]
  );
  const selectedSubtitleEmphasisSet = useMemo(
    () => new Set(
      (Array.isArray(selectedTimelineClip?.subtitleStyle?.emphasisWords) ? selectedTimelineClip?.subtitleStyle?.emphasisWords : [])
        .map((word) => normalizeCaptionToken(String(word || '')))
        .filter(Boolean)
    ),
    [selectedTimelineClip]
  );
  const [draggingSceneItemId, setDraggingSceneItemId] = useState<string | null>(null);
  const [layerDropTarget, setLayerDropTarget] = useState<{ kind: 'item' | 'group' | 'ungroup'; id: string } | null>(null);
  const [layerContextMenu, setLayerContextMenu] = useState<{
    kind: 'item' | 'group';
    x: number;
    y: number;
    itemId?: string;
    groupId?: string;
  } | null>(null);

  const updateScene = (sceneId: string, updater: (scene: RemotionScene) => RemotionScene) => {
    editorStore.setState((state) => {
      const current = state.scene.editableComposition;
      if (!current) return {};
      const nextScenes = current.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene));
      return {
        scene: {
          ...state.scene,
          editableComposition: {
            ...current,
            durationInFrames: nextScenes.reduce((sum, scene) => sum + scene.durationInFrames, 0),
            scenes: nextScenes,
          },
        },
      };
    });
  };

  const selectSceneInspector = useCallback((
    kind: 'asset' | 'overlay' | 'title' | 'text' | 'subtitle',
    id: string,
    options?: { additive?: boolean; preserveSelection?: boolean }
  ) => {
    editorStore.setState((state) => {
      const nextIds = options?.preserveSelection
        ? (state.selection.sceneItemIds.includes(id) ? state.selection.sceneItemIds : [...state.selection.sceneItemIds.filter(Boolean), id])
        : options?.additive
        ? (state.selection.sceneItemIds.includes(id)
            ? state.selection.sceneItemIds.filter((itemId) => itemId !== id)
            : [...state.selection.sceneItemIds.filter(Boolean), id])
        : [id];
      const nextPrimaryId = nextIds.includes(id) ? id : nextIds[0] || null;
      const nextClipId = nextPrimaryId ? clipIdFromAnySceneItemId(nextPrimaryId) : null;
      const nextKind = nextPrimaryId
        ? (kind === 'overlay' || kind === 'title'
            ? kind
            : inferSceneItemKindFromId(nextPrimaryId))
        : null;
      return {
      timeline: {
        ...state.timeline,
        selectedClipId: nextClipId || null,
      },
        selection: {
          ...state.selection,
          kind: nextPrimaryId ? 'scene-item' : null,
          sceneItemId: nextPrimaryId,
          sceneItemIds: nextIds,
          sceneItemKind: nextKind,
        },
      panels: {
        ...state.panels,
        leftPanel: 'selection',
      },
      };
    });
  }, [editorStore]);

  const saveEditedComposition = () => {
    if (!editableComposition) return;
    let frameCursor = 0;
    const normalized: RemotionCompositionConfig = {
      ...editableComposition,
      scenes: editableComposition.scenes.map((scene) => {
        const nextScene = {
          ...scene,
          startFrame: frameCursor,
          durationInFrames: Math.max(12, Number(scene.durationInFrames || 0)),
        };
        frameCursor += nextScene.durationInFrames;
        return nextScene;
      }),
      durationInFrames: frameCursor,
      sceneItemTransforms: {
        ...itemTransforms,
      },
    };
    editorStore.setState((state) => ({
      project: {
        ...state.project,
        durationInFrames: normalized.durationInFrames,
      },
      scene: {
        ...state.scene,
        editableComposition: normalized,
      },
    }));
    onSaveRemotionScene(normalized);
    lastAutoSavedSceneRef.current = JSON.stringify(normalized);
  };

  const handleChangeRatioPreset = useCallback((preset: VideoEditorRatioPreset) => {
    const nextSize = RATIO_PRESET_SIZE[preset];
    editorStore.setState((state) => ({
      project: {
        ...state.project,
        width: nextSize.width,
        height: nextSize.height,
        ratioPreset: preset,
      },
      scene: {
        ...state.scene,
        editableComposition: state.scene.editableComposition
          ? {
              ...state.scene.editableComposition,
              width: nextSize.width,
              height: nextSize.height,
            }
          : state.scene.editableComposition,
      },
    }));
  }, [editorStore]);

  const handleUpdateSceneItemTransform = useCallback((id: string, patch: Partial<SceneItemTransform>) => {
    editorStore.setState((state) => {
      const current = state.scene.itemTransforms[id];
      if (!current) return state;
      return {
        scene: {
          ...state.scene,
          itemTransforms: {
            ...state.scene.itemTransforms,
            [id]: {
              ...current,
              ...patch,
            },
          },
        },
      };
    });
  }, [editorStore]);

  const handleUpdateSceneItemTransforms = useCallback((ids: string[], updater: (current: SceneItemTransform, id: string) => Partial<SceneItemTransform>) => {
    editorStore.setState((state) => {
      const nextTransforms = { ...state.scene.itemTransforms };
      let changed = false;
      ids.forEach((id) => {
        const current = nextTransforms[id];
        if (!current) return;
        const patch = updater(current, id);
        if (!patch || Object.keys(patch).length === 0) return;
        nextTransforms[id] = {
          ...current,
          ...patch,
        };
        changed = true;
      });
      if (!changed) return {};
      return {
        scene: {
          ...state.scene,
          itemTransforms: nextTransforms,
        },
      };
    });
  }, [editorStore]);

  const handleAlignSceneItems = useCallback((mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    const ids = Array.from(new Set(selectedSceneItemIds.filter(Boolean)));
    if (ids.length < 2) return;
    const sourceItems = ids
      .map((id) => ({ id, transform: itemTransforms[id] }))
      .filter((item): item is { id: string; transform: SceneItemTransform } => !!item.transform);
    if (sourceItems.length < 2) return;

    if (mode === 'left') {
      const target = Math.min(...sourceItems.map((item) => item.transform.x));
      handleUpdateSceneItemTransforms(ids, () => ({ x: target }));
      return;
    }
    if (mode === 'center') {
      const target = sourceItems.reduce((sum, item) => sum + item.transform.x + item.transform.width / 2, 0) / sourceItems.length;
      handleUpdateSceneItemTransforms(ids, (current) => ({ x: target - current.width / 2 }));
      return;
    }
    if (mode === 'right') {
      const target = Math.max(...sourceItems.map((item) => item.transform.x + item.transform.width));
      handleUpdateSceneItemTransforms(ids, (current) => ({ x: target - current.width }));
      return;
    }
    if (mode === 'top') {
      const target = Math.min(...sourceItems.map((item) => item.transform.y));
      handleUpdateSceneItemTransforms(ids, () => ({ y: target }));
      return;
    }
    if (mode === 'middle') {
      const target = sourceItems.reduce((sum, item) => sum + item.transform.y + item.transform.height / 2, 0) / sourceItems.length;
      handleUpdateSceneItemTransforms(ids, (current) => ({ y: target - current.height / 2 }));
      return;
    }
    const target = Math.max(...sourceItems.map((item) => item.transform.y + item.transform.height));
    handleUpdateSceneItemTransforms(ids, (current) => ({ y: target - current.height }));
  }, [handleUpdateSceneItemTransforms, itemTransforms, selectedSceneItemIds]);

  const handleDistributeSceneItems = useCallback((axis: 'horizontal' | 'vertical') => {
    const ids = Array.from(new Set(selectedSceneItemIds.filter(Boolean)));
    if (ids.length < 3) return;
    const sourceItems = ids
      .map((id) => ({ id, transform: itemTransforms[id] }))
      .filter((item): item is { id: string; transform: SceneItemTransform } => !!item.transform);
    if (sourceItems.length < 3) return;

    const sorted = [...sourceItems].sort((left, right) => axis === 'horizontal'
      ? left.transform.x - right.transform.x
      : left.transform.y - right.transform.y
    );

    if (axis === 'horizontal') {
      const minX = sorted[0].transform.x;
      const maxRight = Math.max(...sorted.map((item) => item.transform.x + item.transform.width));
      const totalWidth = sorted.reduce((sum, item) => sum + item.transform.width, 0);
      const gap = (maxRight - minX - totalWidth) / Math.max(1, sorted.length - 1);
      let cursor = minX;
      const nextPositions = new Map<string, number>();
      sorted.forEach((item) => {
        nextPositions.set(item.id, cursor);
        cursor += item.transform.width + gap;
      });
      handleUpdateSceneItemTransforms(ids, (_, id) => ({ x: nextPositions.get(id) }));
      return;
    }

    const minY = sorted[0].transform.y;
    const maxBottom = Math.max(...sorted.map((item) => item.transform.y + item.transform.height));
    const totalHeight = sorted.reduce((sum, item) => sum + item.transform.height, 0);
    const gap = (maxBottom - minY - totalHeight) / Math.max(1, sorted.length - 1);
    let cursor = minY;
    const nextPositions = new Map<string, number>();
    sorted.forEach((item) => {
      nextPositions.set(item.id, cursor);
      cursor += item.transform.height + gap;
    });
    handleUpdateSceneItemTransforms(ids, (_, id) => ({ y: nextPositions.get(id) }));
  }, [handleUpdateSceneItemTransforms, itemTransforms, selectedSceneItemIds]);

  const handleSetSceneSelection = useCallback((ids: string[], primaryId: string | null) => {
    const nextIds = Array.from(new Set(ids.filter(Boolean)));
    const nextPrimaryId = primaryId && nextIds.includes(primaryId) ? primaryId : nextIds[0] || null;
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        selectedClipId: nextPrimaryId ? clipIdFromAnySceneItemId(nextPrimaryId) : null,
      },
      selection: {
        ...state.selection,
        kind: nextPrimaryId ? 'scene-item' : null,
        sceneItemId: nextPrimaryId,
        sceneItemIds: nextIds,
        sceneItemKind: nextPrimaryId ? inferSceneItemKindFromId(nextPrimaryId) : null,
      },
      panels: {
        ...state.panels,
        leftPanel: nextPrimaryId ? 'selection' : state.panels.leftPanel,
      },
    }));
  }, [editorStore]);

  const handleSetSceneItemLocks = useCallback((ids: string[], locked: boolean) => {
    const nextIds = Array.from(new Set(ids.filter(Boolean)));
    if (nextIds.length === 0) return;
    editorStore.setState((state) => {
      const nextLocks = { ...state.scene.itemLocks };
      nextIds.forEach((id) => {
        if (locked) {
          nextLocks[id] = true;
        } else {
          delete nextLocks[id];
        }
      });
      return {
        scene: {
          ...state.scene,
          itemLocks: nextLocks,
        },
      };
    });
  }, [editorStore]);

  const handleToggleSceneSelectionLock = useCallback(() => {
    const ids = Array.from(new Set(selectedSceneItemIds.filter(Boolean)));
    if (ids.length === 0) return;
    const shouldLock = ids.some((id) => !sceneItemLocks[id]);
    handleSetSceneItemLocks(ids, shouldLock);
  }, [handleSetSceneItemLocks, sceneItemLocks, selectedSceneItemIds]);

  const handleSetSceneItemVisibility = useCallback((ids: string[], visible: boolean) => {
    const nextIds = Array.from(new Set(ids.filter(Boolean)));
    if (nextIds.length === 0) return;
    editorStore.setState((state) => {
      const nextVisibility = { ...state.scene.itemVisibility };
      nextIds.forEach((id) => {
        nextVisibility[id] = visible;
      });
      return {
        scene: {
          ...state.scene,
          itemVisibility: nextVisibility,
        },
      };
    });
  }, [editorStore]);

  const handleGroupSceneItems = useCallback(() => {
    const ids = Array.from(new Set(selectedSceneItemIds.filter(Boolean)));
    if (ids.length < 2) return;
    const groupId = makeSceneGroupId();
    editorStore.setState((state) => ({
      scene: {
        ...state.scene,
        itemGroups: {
          ...state.scene.itemGroups,
          ...Object.fromEntries(ids.map((id) => [id, groupId])),
        },
      },
    }));
  }, [editorStore, selectedSceneItemIds]);

  const handleUngroupSceneItems = useCallback(() => {
    const ids = Array.from(new Set(selectedSceneItemIds.filter(Boolean)));
    if (ids.length === 0) return;
    editorStore.setState((state) => {
      const nextGroups = { ...state.scene.itemGroups };
      ids.forEach((id) => {
        delete nextGroups[id];
      });
      return {
        scene: {
          ...state.scene,
          itemGroups: nextGroups,
        },
      };
    });
  }, [editorStore, selectedSceneItemIds]);

  const handleAssignSceneItemsToGroup = useCallback((ids: string[], groupId: string | null) => {
    const nextIds = Array.from(new Set(ids.filter(Boolean)));
    if (nextIds.length === 0) return;
    editorStore.setState((state) => {
      const nextGroups = { ...state.scene.itemGroups };
      nextIds.forEach((id) => {
        if (groupId) {
          nextGroups[id] = groupId;
        } else {
          delete nextGroups[id];
        }
      });
      return {
        scene: {
          ...state.scene,
          itemGroups: nextGroups,
          focusedGroupId: groupId === null && state.scene.focusedGroupId && nextIds.some((id) => state.scene.itemGroups[id] === state.scene.focusedGroupId)
            ? null
            : state.scene.focusedGroupId,
        },
      };
    });
  }, [editorStore]);

  const handleEnterGroupEditing = useCallback((groupId: string | null) => {
    editorStore.setState((state) => ({
      scene: {
        ...state.scene,
        focusedGroupId: groupId,
      },
    }));
  }, [editorStore]);

  const handleSetGroupVisibility = useCallback((groupId: string, visible: boolean) => {
    if (!groupId) return;
    const ids = Object.entries(sceneItemGroups)
      .filter(([, currentGroupId]) => currentGroupId === groupId)
      .map(([id]) => id);
    handleSetSceneItemVisibility(ids, visible);
  }, [handleSetSceneItemVisibility, sceneItemGroups]);

  const handleSetGroupLocks = useCallback((groupId: string, locked: boolean) => {
    if (!groupId) return;
    const ids = Object.entries(sceneItemGroups)
      .filter(([, currentGroupId]) => currentGroupId === groupId)
      .map(([id]) => id);
    handleSetSceneItemLocks(ids, locked);
  }, [handleSetSceneItemLocks, sceneItemGroups]);

  const handleToggleSceneItemVisibility = useCallback((id: string) => {
    if (!id) return;
    editorStore.setState((state) => ({
      scene: {
        ...state.scene,
        itemVisibility: {
          ...state.scene.itemVisibility,
          [id]: !(state.scene.itemVisibility[id] ?? true),
        },
      },
    }));
  }, [editorStore]);

  const handleMoveSceneItemInOrder = useCallback((id: string, direction: 'up' | 'down') => {
    if (!id) return;
    editorStore.setState((state) => {
      const baseOrder = Array.from(new Set([...state.scene.itemOrder, ...Object.keys(state.scene.itemTransforms)]));
      const currentIndex = baseOrder.indexOf(id);
      if (currentIndex === -1) return {};
      const nextIndex = direction === 'up' ? Math.min(baseOrder.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
      if (nextIndex === currentIndex) return {};
      const nextOrder = [...baseOrder];
      const [moved] = nextOrder.splice(currentIndex, 1);
      nextOrder.splice(nextIndex, 0, moved);
      return {
        scene: {
          ...state.scene,
          itemOrder: nextOrder,
        },
      };
    });
  }, [editorStore]);

  const handleReorderSceneItem = useCallback((sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    editorStore.setState((state) => {
      const baseOrder = Array.from(new Set([...state.scene.itemOrder, ...Object.keys(state.scene.itemTransforms)]));
      const sourceIndex = baseOrder.indexOf(sourceId);
      const targetIndex = baseOrder.indexOf(targetId);
      if (sourceIndex === -1 || targetIndex === -1) return {};
      const nextOrder = [...baseOrder];
      const [moved] = nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(targetIndex, 0, moved);
      return {
        scene: {
          ...state.scene,
          itemOrder: nextOrder,
        },
      };
    });
  }, [editorStore]);

  const handleMoveSceneItemsToEdge = useCallback((ids: string[], edge: 'front' | 'back') => {
    const nextIds = Array.from(new Set(ids.filter(Boolean)));
    if (nextIds.length === 0) return;
    editorStore.setState((state) => {
      const baseOrder = Array.from(new Set([...state.scene.itemOrder, ...Object.keys(state.scene.itemTransforms)]));
      const movingIds = nextIds.filter((id) => baseOrder.includes(id));
      if (movingIds.length === 0) return {};
      const stationary = baseOrder.filter((id) => !movingIds.includes(id));
      const nextOrder = edge === 'front'
        ? [...movingIds, ...stationary]
        : [...stationary, ...movingIds];
      return {
        scene: {
          ...state.scene,
          itemOrder: nextOrder,
        },
      };
    });
  }, [editorStore]);

  const handleDeleteSceneItem = useCallback(async (kind: 'asset' | 'overlay' | 'title' | 'text' | 'subtitle', id: string) => {
    if (!id) return;

    if (kind === 'asset' || kind === 'text' || kind === 'subtitle') {
      if (!editorFile) return;
      const clipId = clipIdFromSceneItem(kind, id);
      try {
        const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
          filePath: editorFile,
          clipId,
        }) as { success?: boolean; state?: Record<string, unknown> };
        if (result?.success && result.state) {
          onPackageStateChange(result.state as PackageStateLike);
          editorStore.setState((state) => {
            const nextTransforms = { ...state.scene.itemTransforms };
            const nextLocks = { ...state.scene.itemLocks };
            const nextGroups = { ...state.scene.itemGroups };
            delete nextTransforms[id];
            delete nextTransforms[clipId];
            delete nextLocks[id];
            delete nextLocks[clipId];
            delete nextGroups[id];
            delete nextGroups[clipId];
            return {
              timeline: {
                ...state.timeline,
                selectedClipId: null,
              },
              selection: {
                ...state.selection,
                kind: null,
                sceneItemId: null,
                sceneItemIds: [],
                sceneItemKind: null,
              },
              scene: {
                ...state.scene,
                itemTransforms: nextTransforms,
                itemLocks: nextLocks,
                itemGroups: nextGroups,
              },
            };
          });
        }
      } catch (error) {
        console.error('Failed to delete stage asset clip:', error);
      }
      return;
    }

    if (!selectedScene) return;
    const transformKey = id;
    editorStore.setState((state) => {
      const nextTransforms = { ...state.scene.itemTransforms };
      const nextLocks = { ...state.scene.itemLocks };
      const nextGroups = { ...state.scene.itemGroups };
      delete nextTransforms[transformKey];
      delete nextLocks[transformKey];
      delete nextGroups[transformKey];
      return {
        selection: {
          ...state.selection,
          kind: null,
          sceneItemId: null,
          sceneItemIds: [],
          sceneItemKind: null,
        },
        scene: {
          ...state.scene,
          itemTransforms: nextTransforms,
          itemLocks: nextLocks,
          itemGroups: nextGroups,
        },
      };
    });

    if (kind === 'title') {
      updateScene(selectedScene.id, (scene) => ({ ...scene, overlayTitle: '' }));
      return;
    }

    updateScene(selectedScene.id, (scene) => ({
      ...scene,
      overlayBody: '',
      overlays: [],
    }));
  }, [editorFile, editorStore, onPackageStateChange, selectedScene]);

  const handleDeleteSceneItems = useCallback(async (items: Array<{ kind: 'asset' | 'overlay' | 'title' | 'text' | 'subtitle'; id: string }>) => {
    for (const item of items) {
      // Keep deletion sequential so package state refreshes do not race each other.
      // eslint-disable-next-line no-await-in-loop
      await handleDeleteSceneItem(item.kind, item.id);
    }
  }, [handleDeleteSceneItem]);

  const handleBatchUpdateTextStyle = useCallback(async (sceneItemIds: string[], patch: NonNullable<VideoClipLike['textStyle']>) => {
    if (!editorFile) return;
    for (const sceneItemId of sceneItemIds) {
      const clipId = clipIdFromAnySceneItemId(sceneItemId);
      const clip = timelineClips.find((item) => String(item.clipId || '').trim() === clipId);
      if (!clip) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
        filePath: editorFile,
        clipId,
        name: String(clip.name || ''),
        assetKind: 'text',
        textStyle: {
          ...(clip.textStyle || {}),
          ...patch,
        },
        track: String(clip.track || activeTrackId || 'T1').trim() || 'T1',
        durationMs: Math.max(600, Number(clip.durationMs || textDraftDurationMs)),
        trimInMs: Math.max(0, Number(clip.trimInMs || 0)),
        enabled: clip.enabled !== false,
      }) as { success?: boolean; state?: Record<string, unknown> };
      if (result?.success && result.state) {
        onPackageStateChange(result.state as PackageStateLike);
      }
    }
  }, [activeTrackId, editorFile, onPackageStateChange, textDraftDurationMs, timelineClips]);

  const handleBatchUpdateSubtitleStyle = useCallback(async (sceneItemIds: string[], patch: NonNullable<VideoClipLike['subtitleStyle']>) => {
    if (!editorFile) return;
    for (const sceneItemId of sceneItemIds) {
      const clipId = clipIdFromAnySceneItemId(sceneItemId);
      const clip = timelineClips.find((item) => String(item.clipId || '').trim() === clipId);
      if (!clip) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
        filePath: editorFile,
        clipId,
        name: String(clip.name || ''),
        assetKind: 'subtitle',
        subtitleStyle: {
          ...(clip.subtitleStyle || {}),
          ...patch,
        },
        track: String(clip.track || activeTrackId || 'S1').trim() || 'S1',
        durationMs: Math.max(500, Number(clip.durationMs || subtitleDraftDurationMs)),
        trimInMs: Math.max(0, Number(clip.trimInMs || 0)),
        enabled: clip.enabled !== false,
      }) as { success?: boolean; state?: Record<string, unknown> };
      if (result?.success && result.state) {
        onPackageStateChange(result.state as PackageStateLike);
      }
    }
  }, [activeTrackId, editorFile, onPackageStateChange, subtitleDraftDurationMs, timelineClips]);

  const handleBatchUpdateTextContentStyle = useCallback(async (
    sceneItemIds: string[],
    patch: Partial<Pick<NonNullable<VideoClipLike['textStyle']>, 'fontSize' | 'color' | 'backgroundColor' | 'align' | 'fontWeight' | 'animation'>>
  ) => {
    await handleBatchUpdateTextStyle(sceneItemIds, patch);
  }, [handleBatchUpdateTextStyle]);

  const handleBatchUpdateSubtitleContentStyle = useCallback(async (
    sceneItemIds: string[],
    patch: Partial<Pick<NonNullable<VideoClipLike['subtitleStyle']>, 'fontSize' | 'color' | 'backgroundColor' | 'emphasisColor' | 'align' | 'fontWeight' | 'animation' | 'segmentationMode'>>
  ) => {
    await handleBatchUpdateSubtitleStyle(sceneItemIds, patch);
  }, [handleBatchUpdateSubtitleStyle]);

  const handleDuplicateSceneItems = useCallback(async (ids: string[]) => {
    if (!editorFile) return;
    const normalizedIds = Array.from(new Set(ids.filter(Boolean)));
    if (normalizedIds.length === 0) return;
    const nextSelectedIds: string[] = [];

    for (const sceneItemId of normalizedIds) {
      const kind = inferSceneItemKindFromId(sceneItemId);
      const clipId = clipIdFromAnySceneItemId(sceneItemId);
      const sourceClip = timelineClips.find((clip) => String(clip.clipId || '').trim() === clipId);
      if (!sourceClip) continue;

      if (kind === 'asset') {
        const assetId = String(sourceClip.assetId || '').trim();
        if (!assetId) continue;
        const result = await window.ipcRenderer.invoke('manuscripts:add-package-clip', {
          filePath: editorFile,
          assetId,
          track: String(sourceClip.track || 'V1').trim() || 'V1',
          order: clipOrderInTrack(sourceClip, timelineClips) + 1,
          durationMs: Math.max(100, Math.round(Number(sourceClip.durationMs || DEFAULT_CLIP_MS))),
        }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
        if (result?.success && result.state) {
          onPackageStateChange(result.state as PackageStateLike);
          const insertedClipId = String(result.insertedClipId || '').trim();
          if (insertedClipId) {
            const sourceTransform = itemTransforms[sceneItemId];
            if (sourceTransform) {
              editorStore.setState((state) => ({
                scene: {
                  ...state.scene,
                  itemTransforms: {
                    ...state.scene.itemTransforms,
                    [insertedClipId]: {
                      ...sourceTransform,
                      x: sourceTransform.x + 28,
                      y: sourceTransform.y + 28,
                    },
                  },
                },
              }));
            }
            nextSelectedIds.push(insertedClipId);
          }
        }
        continue;
      }

      if (kind === 'text') {
        const result = await window.ipcRenderer.invoke('manuscripts:insert-package-text-at-playhead', {
          filePath: editorFile,
          track: String(sourceClip.track || 'T1').trim() || 'T1',
          text: String(sourceClip.name || ''),
          durationMs: Math.max(600, Math.round(Number(sourceClip.durationMs || DEFAULT_CLIP_MS))),
          textStyle: {
            ...(sourceClip.textStyle || {}),
          },
        }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
        if (result?.success && result.state) {
          onPackageStateChange(result.state as PackageStateLike);
          const insertedClipId = String(result.insertedClipId || '').trim();
          if (insertedClipId) {
            const sourceTransform = itemTransforms[sceneItemId];
            if (sourceTransform) {
              editorStore.setState((state) => ({
                scene: {
                  ...state.scene,
                  itemTransforms: {
                    ...state.scene.itemTransforms,
                    [`${insertedClipId}:text`]: {
                      ...sourceTransform,
                      x: sourceTransform.x + 28,
                      y: sourceTransform.y + 28,
                    },
                  },
                },
              }));
            }
            nextSelectedIds.push(`${insertedClipId}:text`);
          }
        }
        continue;
      }

      const result = await window.ipcRenderer.invoke('manuscripts:insert-package-subtitle-at-playhead', {
        filePath: editorFile,
        track: String(sourceClip.track || 'S1').trim() || 'S1',
        text: String(sourceClip.name || ''),
        durationMs: Math.max(500, Math.round(Number(sourceClip.durationMs || DEFAULT_CLIP_MS))),
        subtitleStyle: {
          ...(sourceClip.subtitleStyle || {}),
        },
      }) as { success?: boolean; insertedClipId?: string; state?: Record<string, unknown> };
      if (result?.success && result.state) {
        onPackageStateChange(result.state as PackageStateLike);
        const insertedClipId = String(result.insertedClipId || '').trim();
        if (insertedClipId) {
          const sourceTransform = itemTransforms[sceneItemId];
          if (sourceTransform) {
            editorStore.setState((state) => ({
              scene: {
                ...state.scene,
                itemTransforms: {
                  ...state.scene.itemTransforms,
                  [`${insertedClipId}:subtitle`]: {
                    ...sourceTransform,
                    x: sourceTransform.x + 28,
                    y: sourceTransform.y + 28,
                  },
                },
              },
            }));
          }
          nextSelectedIds.push(`${insertedClipId}:subtitle`);
        }
      }
    }

    if (nextSelectedIds.length > 0) {
      handleSetSceneSelection(nextSelectedIds, nextSelectedIds[0]);
    }
  }, [editorFile, editorStore, handleSetSceneSelection, itemTransforms, onPackageStateChange, timelineClips]);
  const previewStatusLabel = `${formatSecondsLabel(previewCurrentTime)} / ${formatSecondsLabel(effectiveDurationInFrames / effectiveFps)}`;

  useEffect(() => {
    if (!editableComposition) return;
    const snapshot: RemotionCompositionConfig = {
      ...editableComposition,
      width: projectWidth,
      height: projectHeight,
      durationInFrames: editableComposition.durationInFrames,
      sceneItemTransforms: {
        ...itemTransforms,
      },
    };
    const serialized = JSON.stringify(snapshot);
    if (!lastAutoSavedSceneRef.current) {
      lastAutoSavedSceneRef.current = serialized;
      return;
    }
    if (serialized === lastAutoSavedSceneRef.current) {
      return;
    }
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      onSaveRemotionScene(snapshot);
      lastAutoSavedSceneRef.current = serialized;
      autoSaveTimerRef.current = null;
    }, 450);
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [editableComposition, itemTransforms, onSaveRemotionScene, projectHeight, projectWidth]);

  useEffect(() => {
    if (!selectedTimelineClip) {
      setSelectedClipDraft(null);
      return;
    }
    const fallbackDurationMs = assetDurationMs(selectedClipAsset || { id: '' }) || DEFAULT_CLIP_MS;
    setSelectedClipDraft({
      track: String(selectedTimelineClip.track || activeTrackId || 'V1').trim() || 'V1',
      durationMs: Math.max(100, Number(selectedTimelineClip.durationMs || 0) || fallbackDurationMs),
      trimInMs: Math.max(0, Number(selectedTimelineClip.trimInMs || 0)),
      enabled: selectedTimelineClip.enabled !== false,
    });
  }, [activeTrackId, selectedClipAsset, selectedTimelineClip]);

  const persistSelectedClipDraft = async () => {
    if (!editorFile || !selectedTimelineClip || !selectedClipDraft || isSavingSelectedClip) return;
    setIsSavingSelectedClip(true);
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
        filePath: editorFile,
        clipId: String(selectedTimelineClip.clipId || '').trim(),
        track: selectedClipDraft.track,
        durationMs: Math.max(100, Math.round(selectedClipDraft.durationMs)),
        trimInMs: Math.max(0, Math.round(selectedClipDraft.trimInMs)),
        enabled: selectedClipDraft.enabled,
      }) as { success?: boolean; state?: Record<string, unknown> };
      if (result?.success && result.state) {
        onPackageStateChange(result.state as PackageStateLike);
      }
    } catch (error) {
      console.error('Failed to update selected clip from editor sidebar:', error);
    } finally {
      setIsSavingSelectedClip(false);
    }
  };

  const handleTimelineCursorChange = useCallback((time: number) => {
    const nextPreviewTime = quantizePreviewTime(time);
    const activeClip = clipAtTime(nextPreviewTime);
    const activeAssetId = activeClip ? String(activeClip.assetId || '').trim() : '';
    const currentState = editorStore.getState();
    const nextFrame = Math.max(0, Math.round(nextPreviewTime * effectiveFps));
    const sameTime = Math.abs(currentState.player.currentTime - nextPreviewTime) < 0.0001;
    const sameFrame = currentState.player.currentFrame === nextFrame;
    const samePlayhead = Math.abs(currentState.timeline.playheadSeconds - nextPreviewTime) < 0.0001;
    const sameAsset = !activeAssetId || currentState.assets.currentPreviewAssetId === activeAssetId;
    if (sameTime && sameFrame && samePlayhead && sameAsset) {
      return;
    }
    editorStore.setState((state) => ({
      player: {
        ...state.player,
        currentTime: nextPreviewTime,
        currentFrame: nextFrame,
      },
      timeline: {
        ...state.timeline,
        playheadSeconds: nextPreviewTime,
      },
      assets: {
        ...state.assets,
        currentPreviewAssetId: activeAssetId || state.assets.currentPreviewAssetId,
      },
    }));
  }, [clipAtTime, editorStore, effectiveFps, quantizePreviewTime]);

  const handleTimelineSelectedClipChange = useCallback((clipId: string | null) => {
    const currentState = editorStore.getState();
    if (currentState.timeline.selectedClipId === clipId) {
      return;
    }
    const nextClip = clipId
      ? timelineClips.find((clip) => String(clip.clipId || '').trim() === clipId) || null
      : null;
    const sceneSelection = sceneSelectionForClip(nextClip);
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        selectedClipId: clipId,
      },
      selection: {
        ...state.selection,
        kind: clipId ? 'scene-item' : null,
        sceneItemKind: clipId ? sceneSelection.sceneItemKind : null,
        sceneItemId: clipId ? sceneSelection.sceneItemId : null,
        sceneItemIds: clipId && sceneSelection.sceneItemId ? [sceneSelection.sceneItemId] : [],
      },
      panels: {
        ...state.panels,
        leftPanel: clipId ? 'selection' : state.panels.leftPanel,
      },
    }));
  }, [editorStore, timelineClips]);

  const handleTimelineActiveTrackChange = useCallback((trackId: string | null) => {
    const currentState = editorStore.getState();
    if (currentState.timeline.activeTrackId === trackId) {
      return;
    }
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        activeTrackId: trackId,
      },
    }));
  }, [editorStore]);

  const handleTimelineViewportChange = useCallback((metrics: VideoEditorViewportMetrics) => {
    const currentViewport = editorStore.getState().timeline.viewport;
    if (
      currentViewport.scrollLeft === metrics.scrollLeft
      && currentViewport.maxScrollLeft === metrics.maxScrollLeft
      && currentViewport.scrollTop === metrics.scrollTop
      && currentViewport.maxScrollTop === metrics.maxScrollTop
    ) {
      return;
    }
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        viewport: metrics,
      },
    }));
  }, [editorStore]);

  const handleTimelineZoomChange = useCallback((zoomPercent: number) => {
    const safeZoomPercent = Math.round(Number(zoomPercent) || 100);
    if (editorStore.getState().timeline.zoomPercent === safeZoomPercent) {
      return;
    }
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        zoomPercent: safeZoomPercent,
      },
    }));
  }, [editorStore]);

  const handleTimelineTrackUiChange = useCallback((trackUi: VideoEditorState['timeline']['trackUi']) => {
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        trackUi,
      },
    }));
  }, [editorStore]);

  const handleToggleActiveTrackUi = useCallback((key: 'locked' | 'hidden' | 'collapsed' | 'muted' | 'solo') => {
    if (!activeTrackId) return;
    editorStore.setState((state) => {
      const current = state.timeline.trackUi[activeTrackId] || { locked: false, hidden: false, collapsed: false, muted: false, solo: false, volume: 1 };
      return {
        timeline: {
          ...state.timeline,
          trackUi: {
            ...state.timeline.trackUi,
            [activeTrackId]: {
              ...current,
              [key]: !current[key],
            },
          },
        },
      };
    });
  }, [activeTrackId, editorStore]);

  const handleAddTrackFromInspector = useCallback(async (kind: 'video' | 'audio' | 'subtitle') => {
    if (!editorFile) return;
    const result = await window.ipcRenderer.invoke('manuscripts:add-package-track', {
      filePath: editorFile,
      kind,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [editorFile, onPackageStateChange]);

  const handleMoveActiveTrack = useCallback(async (direction: 'up' | 'down') => {
    if (!editorFile || !activeTrackId) return;
    const result = await window.ipcRenderer.invoke('manuscripts:move-package-track', {
      filePath: editorFile,
      trackId: activeTrackId,
      direction,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange]);

  const handleDeleteActiveTrack = useCallback(async () => {
    if (!editorFile || !activeTrackId || !canDeleteActiveTrack) return;
    const result = await window.ipcRenderer.invoke('manuscripts:delete-package-track', {
      filePath: editorFile,
      trackId: activeTrackId,
    }) as { success?: boolean; state?: Record<string, unknown> };
    if (result?.success && result.state) {
      onPackageStateChange(result.state as PackageStateLike);
    }
  }, [activeTrackId, canDeleteActiveTrack, editorFile, onPackageStateChange]);

  const handleClearActiveTrack = useCallback(async () => {
    if (!editorFile || !activeTrackId) return;
    const trackClips = timelineClips.filter((clip) => String(clip.track || '').trim() === activeTrackId);
    if (trackClips.length === 0) return;
    for (const clip of trackClips) {
      await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
        filePath: editorFile,
        clipId: String(clip.clipId || '').trim(),
      });
    }
    const refresh = await window.ipcRenderer.invoke('manuscripts:get-package-state', editorFile) as { success?: boolean; state?: Record<string, unknown> };
    if (refresh?.success && refresh.state) {
      onPackageStateChange(refresh.state as PackageStateLike);
    }
  }, [activeTrackId, editorFile, onPackageStateChange, timelineClips]);

  const sidebarShellTitle = activeSidebarTab === 'selection' ? 'Inspector' : 'Resource Panel';
  const sidebarShellSubtitle = activeSidebarTab === 'selection'
    ? '当前选中对象属性'
    : activeSidebarTab === 'texts'
      ? `${textClips.length} 段文本图层`
      : activeSidebarTab === 'captions'
        ? `${subtitleClips.length} 段字幕片段`
        : activeSidebarTab === 'transitions'
          ? `${transitionClipCount} 段片段已应用转场`
          : `${visibleAssetCount} 个可用素材`;
  const sidebarTrackLabel = activeTrackId ? `轨道 ${activeTrackId}` : previewTab.toUpperCase();
  const sidebarNavTabs = useMemo(
    () => sidebarTabs.map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon })),
    [sidebarTabs]
  );
  const stageShellTitle = previewTab === 'motion' ? 'Motion Studio' : previewTab === 'script' ? 'Script Workspace' : 'Stage Preview';
  const stageShellSubtitle = previewTab === 'script'
    ? (scriptConfirmed ? `${scriptStatusLabel} · 允许进入剪辑与动画` : `${scriptStatusLabel} · 先确认脚本再进入剪辑与动画`)
    : previewTab === 'motion'
      ? `${editableComposition?.scenes?.length || 0} 个动画场景 · ${scriptStatusLabel}`
      : `${timelineClipCount} 个片段 · ${previewStatusLabel}`;
  const stageShellCompact = previewTab === 'preview';
  const scriptExecutionPrompts = useMemo(
    () => buildVideoExecutionPrompts({
      title,
      script: editorBody,
      clipCount: timelineClipCount,
      trackCount: timelineTrackNames.length,
      motionPrompt,
    }),
    [editorBody, motionPrompt, timelineClipCount, timelineTrackNames.length, title]
  );
  const videoEditingShortcuts = useMemo(
    () => [
      { label: '改写脚本', text: scriptExecutionPrompts.masterPrompt },
      { label: '规划剪辑', text: scriptExecutionPrompts.editPrompt },
      { label: '规划动画', text: scriptExecutionPrompts.motionExecutionPrompt },
      { label: '确认后导出', text: `${scriptExecutionPrompts.editPrompt}\n\n如果用户已经明确确认脚本，并且工程具备导出条件，按 brief 先执行再导出。` },
    ],
    [scriptExecutionPrompts]
  );
  const selectedSceneItemTransform = selectedSceneItemId ? itemTransforms[selectedSceneItemId] || null : null;
  const selectedSceneItemLabel = useMemo(() => {
    if (selectedSceneItemIds.length > 1) return `${selectedSceneItemIds.length} 个对象`;
    if (!selectedSceneItemId || !selectedSceneItemKind) return '';
    if (selectedSceneItemKind === 'asset') {
      return timelineClips.find((clip) => String(clip.clipId || '').trim() === selectedSceneItemId)?.name
        || selectedSceneItemId;
    }
    if (selectedSceneItemKind === 'title') return '标题层';
    if (selectedSceneItemKind === 'text') return '文本层';
    if (selectedSceneItemKind === 'subtitle') return '字幕层';
    if (selectedSceneItemKind === 'overlay') return '文案层';
    return selectedSceneItemId;
  }, [selectedSceneItemId, selectedSceneItemIds.length, selectedSceneItemKind, timelineClips]);
  const selectedSceneItemsSummary = useMemo(() => {
    const items = selectedSceneItemIds
      .map((id) => ({ id, kind: inferSceneItemKindFromId(id), transform: itemTransforms[id] }))
      .filter((item): item is { id: string; kind: 'asset' | 'text' | 'subtitle'; transform: SceneItemTransform } => !!item.transform);
    if (items.length === 0) return null;
    const left = Math.min(...items.map((item) => item.transform.x));
    const top = Math.min(...items.map((item) => item.transform.y));
    const right = Math.max(...items.map((item) => item.transform.x + item.transform.width));
    const bottom = Math.max(...items.map((item) => item.transform.y + item.transform.height));
    return {
      count: items.length,
      assetCount: items.filter((item) => item.kind === 'asset').length,
      textCount: items.filter((item) => item.kind === 'text').length,
      subtitleCount: items.filter((item) => item.kind === 'subtitle').length,
      width: right - left,
      height: bottom - top,
      left,
      top,
      lockedCount: items.filter((item) => sceneItemLocks[item.id]).length,
      groupedCount: items.filter((item) => !!sceneItemGroups[item.id]).length,
    };
  }, [itemTransforms, sceneItemGroups, sceneItemLocks, selectedSceneItemIds]);
  const selectedTextSceneItemIds = useMemo(
    () => selectedSceneItemIds.filter((id) => inferSceneItemKindFromId(id) === 'text'),
    [selectedSceneItemIds]
  );
  const selectedSubtitleSceneItemIds = useMemo(
    () => selectedSceneItemIds.filter((id) => inferSceneItemKindFromId(id) === 'subtitle'),
    [selectedSceneItemIds]
  );
  const sceneHierarchyItems = useMemo(() => {
    const items = Object.keys(itemTransforms)
      .filter((id) => !id.endsWith(':overlay') || buildEditableOverlay(selectedScene || { id: '', durationInFrames: 0, src: '' } as RemotionScene).text)
      .map((id) => ({
        id,
        kind: id.endsWith(':text')
          ? 'text'
          : id.endsWith(':subtitle')
            ? 'subtitle'
            : id.endsWith(':title')
              ? 'title'
              : id.endsWith(':overlay')
                ? 'overlay'
                : 'asset',
        label: (() => {
          if (id.endsWith(':title')) return '标题层';
          if (id.endsWith(':overlay')) return '文案层';
          if (id.endsWith(':subtitle')) return '字幕层';
          if (id.endsWith(':text')) return '文本层';
          return timelineClips.find((clip) => String(clip.clipId || '').trim() === id)?.name || id;
        })(),
        groupId: sceneItemGroups[id] || null,
        locked: !!sceneItemLocks[id],
        visible: sceneItemVisibility[id] !== false,
      }));
    const orderIndex = new Map(sceneItemOrder.map((id, index) => [id, index]));
    const orderedItems = [...items].sort((left, right) => (orderIndex.get(right.id) ?? -1) - (orderIndex.get(left.id) ?? -1));
    const groups = Array.from(new Set(orderedItems.map((item) => item.groupId).filter(Boolean))) as string[];
    return {
      groups: groups.map((groupId) => ({
        id: groupId,
        focused: focusedGroupId === groupId,
        items: orderedItems.filter((item) => item.groupId === groupId),
      })),
      looseItems: orderedItems.filter((item) => !item.groupId),
    };
  }, [focusedGroupId, itemTransforms, sceneItemGroups, sceneItemLocks, sceneItemOrder, sceneItemVisibility, selectedScene, timelineClips]);

  useEffect(() => {
    if (!layerContextMenu) return;
    const handlePointerDown = () => {
      setLayerContextMenu(null);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [layerContextMenu]);

  useEffect(() => {
    const visibleTransformDefaults: Record<string, SceneItemTransform> = {};
    const activeClipId = String((activeVisualTimelineClip || activeAudioTimelineClip || activeTimelineClip)?.clipId || '').trim();
    if (activeClipId && !itemTransforms[activeClipId]) {
      visibleTransformDefaults[activeClipId] = buildDefaultSceneItemTransform('asset', projectWidth, projectHeight);
    }
    const titleTransformId = selectedScene ? `${selectedScene.id}:title` : '';
    if (titleTransformId && selectedScene?.overlayTitle && !itemTransforms[titleTransformId]) {
      visibleTransformDefaults[titleTransformId] = buildDefaultSceneItemTransform('title', projectWidth, projectHeight);
    }
    const overlayTransformId = selectedScene ? `${selectedScene.id}:overlay` : '';
    if (overlayTransformId && buildEditableOverlay(selectedScene || { id: '', durationInFrames: 0, src: '' } as RemotionScene).text && !itemTransforms[overlayTransformId]) {
      visibleTransformDefaults[overlayTransformId] = buildDefaultSceneItemTransform('overlay', projectWidth, projectHeight);
    }
    visibleTimelineClips
      .filter((clip) => String(clip.assetKind || '').trim().toLowerCase() === 'text')
      .forEach((clip) => {
        const clipId = String(clip.clipId || '').trim();
        if (clipId && !itemTransforms[`${clipId}:text`]) {
          visibleTransformDefaults[`${clipId}:text`] = buildDefaultSceneItemTransform('text', projectWidth, projectHeight);
        }
      });
    visibleTimelineClips
      .filter((clip) => isSubtitleClipLike(clip))
      .forEach((clip) => {
        const clipId = String(clip.clipId || '').trim();
        if (clipId && !itemTransforms[`${clipId}:subtitle`]) {
          visibleTransformDefaults[`${clipId}:subtitle`] = buildDefaultSceneItemTransform('subtitle', projectWidth, projectHeight);
        }
      });
    if (Object.keys(visibleTransformDefaults).length === 0) return;
    editorStore.setState((state) => ({
      scene: {
        ...state.scene,
        itemTransforms: {
          ...state.scene.itemTransforms,
          ...visibleTransformDefaults,
        },
      },
    }));
  }, [activeAudioTimelineClip, activeTimelineClip, activeVisualTimelineClip, editorStore, itemTransforms, projectHeight, projectWidth, selectedScene, visibleTimelineClips]);

  useEffect(() => {
    if (!['asset', 'text', 'subtitle'].includes(String(selectedSceneItemKind || ''))) return;
    if (!selectedSceneItemId) return;
    const visibleIds = new Set(visibleTimelineClips.map((clip) => String(clip.clipId || '').trim()).filter(Boolean));
    const candidateClipId = selectedSceneItemKind === 'text'
      ? selectedSceneItemId.replace(/:text$/, '')
      : selectedSceneItemKind === 'subtitle'
        ? selectedSceneItemId.replace(/:subtitle$/, '')
        : selectedSceneItemId;
    if (visibleIds.has(candidateClipId)) return;
    editorStore.setState((state) => ({
      selection: {
        ...state.selection,
        kind: null,
        sceneItemId: null,
        sceneItemIds: [],
        sceneItemKind: null,
      },
    }));
  }, [editorStore, selectedSceneItemId, selectedSceneItemKind, visibleTimelineClips]);

  useEffect(() => {
    const validIds = new Set<string>();
    if (activeVisualTimelineClip?.clipId) validIds.add(String(activeVisualTimelineClip.clipId));
    if (activeAudioTimelineClip?.clipId) validIds.add(String(activeAudioTimelineClip.clipId));
    visibleTimelineClips.forEach((clip) => {
      const clipId = String(clip.clipId || '').trim();
      if (!clipId) return;
      validIds.add(clipId);
      if (String(clip.assetKind || '').trim().toLowerCase() === 'text') {
        validIds.add(`${clipId}:text`);
      }
      if (isSubtitleClipLike(clip)) {
        validIds.add(`${clipId}:subtitle`);
      }
    });
    if (selectedScene?.overlayTitle) validIds.add(`${selectedScene.id}:title`);
    if (buildEditableOverlay(selectedScene || { id: '', durationInFrames: 0, src: '' } as RemotionScene).text) {
      validIds.add(`${selectedScene?.id || ''}:overlay`);
    }

    const staleLocks = Object.keys(sceneItemLocks).filter((id) => !validIds.has(id));
    const staleGroups = Object.keys(sceneItemGroups).filter((id) => !validIds.has(id));
    if (staleLocks.length === 0 && staleGroups.length === 0) return;

    editorStore.setState((state) => {
      const nextLocks = { ...state.scene.itemLocks };
      const nextGroups = { ...state.scene.itemGroups };
      staleLocks.forEach((id) => delete nextLocks[id]);
      staleGroups.forEach((id) => delete nextGroups[id]);
      return {
        scene: {
          ...state.scene,
          itemLocks: nextLocks,
          itemGroups: nextGroups,
        },
      };
    });
  }, [activeAudioTimelineClip, activeVisualTimelineClip, editorStore, sceneItemGroups, sceneItemLocks, selectedScene, visibleTimelineClips]);

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#111113] text-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#141417] px-5 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.24em] text-cyan-200/65">RedBox Editor</div>
            <div className="mt-1 truncate text-lg font-semibold text-white">{title}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {([
              ['preview', 'Preview'],
              ['motion', 'Remotion'],
              ['script', 'Script'],
            ] as const).map(([tabId, label]) => (
              <button
                key={tabId}
                type="button"
                onClick={() => setPreviewTab(tabId)}
                className={clsx(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                  previewTab === tabId
                    ? 'border-cyan-300/45 bg-cyan-400/14 text-cyan-100'
                    : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/20 hover:text-white'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void handleUndoEditorProject();
              }}
              disabled={!canUndo}
              title={canUndo ? '撤销上一步编辑' : '没有可撤销的编辑'}
              className={clsx(
                'inline-flex h-9 w-9 items-center justify-center rounded-full border transition',
                canUndo
                  ? 'border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/6 hover:text-white'
                  : 'border-white/10 bg-white/[0.03] text-white/35'
              )}
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                void handleRedoEditorProject();
              }}
              disabled={!canRedo}
              title={canRedo ? '重做上一步编辑' : '没有可重做的编辑'}
              className={clsx(
                'inline-flex h-9 w-9 items-center justify-center rounded-full border transition',
                canRedo
                  ? 'border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/6 hover:text-white'
                  : 'border-white/10 bg-white/[0.03] text-white/35'
              )}
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onRenderRemotionVideo}
              disabled={isRenderingRemotion || !editableComposition?.scenes?.length || !canRunAiExecution}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                isRenderingRemotion || !editableComposition?.scenes?.length || !canRunAiExecution
                  ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                  : 'border-cyan-400/40 bg-cyan-400/14 text-cyan-100 hover:border-cyan-300/70'
              )}
              title={canRunAiExecution ? '导出当前 Remotion 成片' : '先确认脚本，再导出成片'}
            >
              <Download className="h-3.5 w-3.5" />
              {isRenderingRemotion ? '导出中...' : '导出 MP4'}
            </button>
            <EditorLayoutToggleButton
              kind="timeline"
              collapsed={timelineCollapsed}
              onClick={() => setTimelineCollapsed((value) => !value)}
              title={timelineCollapsed ? '展开时间轴' : '折叠时间轴'}
            />
            <EditorLayoutToggleButton
              kind="materials"
              collapsed={materialsCollapsed}
              onClick={() => setMaterialsCollapsed((value) => !value)}
              title={materialsCollapsed ? '展开素材栏' : '折叠素材栏'}
            />
            <div
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium',
                scriptConfirmed
                  ? 'border-emerald-400/25 bg-emerald-400/12 text-emerald-100'
                  : 'border-amber-300/25 bg-amber-400/12 text-amber-100'
              )}
            >
              <Save className="h-3.5 w-3.5" />
              {scriptStatusLabel}
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-xs font-medium text-cyan-100">
              <MessageSquare className="h-3.5 w-3.5" />
              AI 对话常驻
            </div>
          </div>
        </header>

        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: `${materialsCollapsed ? 0 : materialPaneWidth}px ${materialsCollapsed ? 0 : 8}px minmax(0,1fr) 8px ${RIGHT_PANEL_WIDTH}px`,
            gridTemplateRows: `minmax(0,1fr) ${timelineCollapsed ? '0px' : '8px'} ${timelineCollapsed ? '0px' : `${timelineHeight}px`}`,
          }}
        >
          {!materialsCollapsed ? (
          <VideoEditorSidebarShell
            title={sidebarShellTitle}
            subtitle={sidebarShellSubtitle}
            tabs={sidebarNavTabs}
            activeTabId={activeSidebarTab}
            trackLabel={sidebarTrackLabel}
            onSelectTab={setLeftPanel}
          >
                {activeSidebarTab === 'selection' ? (
                  <div className="space-y-3">
                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-white">对象层级</div>
                          <div className="mt-1 text-[11px] text-white/45">组与对象的当前结构，可直接拖拽排序</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedSceneItemIds.length > 0 ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleMoveSceneItemsToEdge(selectedSceneItemIds, 'front')}
                                className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                              >
                                置前
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveSceneItemsToEdge(selectedSceneItemIds, 'back')}
                                className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                              >
                                置后
                              </button>
                            </>
                          ) : null}
                          {focusedGroupId ? (
                            <button
                              type="button"
                              onClick={() => handleEnterGroupEditing(null)}
                              className="inline-flex items-center rounded-full border border-fuchsia-300/35 bg-fuchsia-400/12 px-3 py-1 text-[11px] text-fuchsia-100 transition hover:border-fuchsia-300/60"
                            >
                              退出组内编辑
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {selectedSceneItemIds.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handleSetSceneItemVisibility(selectedSceneItemIds, false)}
                            className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            隐藏所选
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetSceneItemVisibility(selectedSceneItemIds, true)}
                            className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            显示所选
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleSceneSelectionLock()}
                            className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            {selectedSceneItemsSummary?.lockedCount === selectedSceneItemIds.length ? '解锁所选' : '锁定所选'}
                          </button>
                        </div>
                      ) : null}
                      <div className="mt-4 space-y-2">
                        {sceneHierarchyItems.groups.map((group) => (
                          <div
                            key={group.id}
                            onDragOver={(event) => {
                              event.preventDefault();
                              setLayerDropTarget({ kind: 'group', id: group.id });
                            }}
                            onDragLeave={() => {
                              if (layerDropTarget?.kind === 'group' && layerDropTarget.id === group.id) {
                                setLayerDropTarget(null);
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (draggingSceneItemId) {
                                handleAssignSceneItemsToGroup([draggingSceneItemId], group.id);
                              }
                              setDraggingSceneItemId(null);
                              setLayerDropTarget(null);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setLayerContextMenu({
                                kind: 'group',
                                x: event.clientX,
                                y: event.clientY,
                                groupId: group.id,
                              });
                            }}
                            className={clsx(
                              'rounded-xl border bg-black/20 p-3 transition',
                              layerDropTarget?.kind === 'group' && layerDropTarget.id === group.id
                                ? 'border-fuchsia-300/45 bg-fuchsia-400/10'
                                : 'border-white/10'
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => handleEnterGroupEditing(group.id)}
                                className="text-left text-sm font-medium text-white transition hover:text-cyan-100"
                              >
                                组 {group.id}
                              </button>
                              <div className="flex items-center gap-2">
                                {group.focused ? <span className="rounded-full border border-fuchsia-300/35 bg-fuchsia-400/14 px-2 py-0.5 text-[10px] text-fuchsia-100">editing</span> : null}
                                <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/60">{group.items.length}</span>
                              </div>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => handleSetSceneSelection(group.items.map((item) => item.id), group.items[0]?.id || null)}
                                className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                              >
                                选中整组
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSetGroupVisibility(group.id, group.items.some((item) => item.visible === false))}
                                className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                              >
                                {group.items.every((item) => item.visible !== false) ? '隐藏整组' : '显示整组'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSetGroupLocks(group.id, group.items.some((item) => !item.locked))}
                                className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-300/45 hover:text-cyan-100"
                              >
                                {group.items.every((item) => item.locked) ? '解锁整组' : '锁定整组'}
                              </button>
                            </div>
                            <div className="mt-2 space-y-1">
                              {group.items.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  draggable
                                  onDragStart={() => setDraggingSceneItemId(item.id)}
                                  onDragEnd={() => {
                                    setDraggingSceneItemId(null);
                                    setLayerDropTarget(null);
                                  }}
                                  onDragOver={(event) => {
                                    event.preventDefault();
                                    setLayerDropTarget({ kind: 'item', id: item.id });
                                  }}
                                  onDragLeave={() => {
                                    if (layerDropTarget?.kind === 'item' && layerDropTarget.id === item.id) {
                                      setLayerDropTarget(null);
                                    }
                                  }}
                                  onDrop={(event) => {
                                    event.preventDefault();
                                    if (draggingSceneItemId) {
                                      handleAssignSceneItemsToGroup([draggingSceneItemId], group.id);
                                      handleReorderSceneItem(draggingSceneItemId, item.id);
                                    }
                                    setDraggingSceneItemId(null);
                                    setLayerDropTarget(null);
                                  }}
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    setLayerContextMenu({
                                      kind: 'item',
                                      x: event.clientX,
                                      y: event.clientY,
                                      itemId: item.id,
                                    });
                                  }}
                                  onClick={() => handleSetSceneSelection([item.id], item.id)}
                                  className={clsx(
                                    'flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left text-xs transition',
                                    draggingSceneItemId === item.id && 'opacity-70',
                                    layerDropTarget?.kind === 'item' && layerDropTarget.id === item.id && 'border-fuchsia-300/45 bg-fuchsia-400/10',
                                    selectedSceneItemIds.includes(item.id)
                                      ? 'border-cyan-300/35 bg-cyan-400/10 text-cyan-100'
                                      : 'border-white/10 bg-white/[0.03] text-white/70 hover:border-white/20'
                                  )}
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/45">::</span>
                                    <span className="truncate">{item.label}</span>
                                  </span>
                                  <span className="ml-2 flex shrink-0 items-center gap-1 text-[10px] text-white/45">
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleMoveSceneItemInOrder(item.id, 'up');
                                      }}
                                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/60"
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleMoveSceneItemInOrder(item.id, 'down');
                                      }}
                                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/60"
                                    >
                                      ↓
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleToggleSceneItemVisibility(item.id);
                                      }}
                                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/60"
                                    >
                                      {item.visible ? 'SHOW' : 'HIDE'}
                                    </button>
                                    <span>{item.locked ? 'lock' : item.kind}</span>
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                        {sceneHierarchyItems.looseItems.length > 0 ? (
                          <div
                            onDragOver={(event) => {
                              event.preventDefault();
                              setLayerDropTarget({ kind: 'ungroup', id: 'ungroup' });
                            }}
                            onDragLeave={() => {
                              if (layerDropTarget?.kind === 'ungroup') {
                                setLayerDropTarget(null);
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (draggingSceneItemId) {
                                handleAssignSceneItemsToGroup([draggingSceneItemId], null);
                              }
                              setDraggingSceneItemId(null);
                              setLayerDropTarget(null);
                            }}
                            className={clsx(
                              'rounded-xl border bg-black/20 p-3 transition',
                              layerDropTarget?.kind === 'ungroup'
                                ? 'border-fuchsia-300/45 bg-fuchsia-400/10'
                                : 'border-white/10'
                            )}
                          >
                            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/35">Ungrouped</div>
                            <div className="mt-2 space-y-1">
                              {sceneHierarchyItems.looseItems.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  draggable
                                  onDragStart={() => setDraggingSceneItemId(item.id)}
                                  onDragEnd={() => {
                                    setDraggingSceneItemId(null);
                                    setLayerDropTarget(null);
                                  }}
                                  onDragOver={(event) => {
                                    event.preventDefault();
                                    setLayerDropTarget({ kind: 'item', id: item.id });
                                  }}
                                  onDragLeave={() => {
                                    if (layerDropTarget?.kind === 'item' && layerDropTarget.id === item.id) {
                                      setLayerDropTarget(null);
                                    }
                                  }}
                                  onDrop={(event) => {
                                    event.preventDefault();
                                    if (draggingSceneItemId) {
                                      handleAssignSceneItemsToGroup([draggingSceneItemId], null);
                                      handleReorderSceneItem(draggingSceneItemId, item.id);
                                    }
                                    setDraggingSceneItemId(null);
                                    setLayerDropTarget(null);
                                  }}
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    setLayerContextMenu({
                                      kind: 'item',
                                      x: event.clientX,
                                      y: event.clientY,
                                      itemId: item.id,
                                    });
                                  }}
                                  onClick={() => handleSetSceneSelection([item.id], item.id)}
                                  className={clsx(
                                    'flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left text-xs transition',
                                    draggingSceneItemId === item.id && 'opacity-70',
                                    layerDropTarget?.kind === 'item' && layerDropTarget.id === item.id && 'border-fuchsia-300/45 bg-fuchsia-400/10',
                                    selectedSceneItemIds.includes(item.id)
                                      ? 'border-cyan-300/35 bg-cyan-400/10 text-cyan-100'
                                      : 'border-white/10 bg-white/[0.03] text-white/70 hover:border-white/20'
                                  )}
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/45">::</span>
                                    <span className="truncate">{item.label}</span>
                                  </span>
                                  <span className="ml-2 flex shrink-0 items-center gap-1 text-[10px] text-white/45">
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleMoveSceneItemInOrder(item.id, 'up');
                                      }}
                                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/60"
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleMoveSceneItemInOrder(item.id, 'down');
                                      }}
                                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/60"
                                    >
                                      ↓
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleToggleSceneItemVisibility(item.id);
                                      }}
                                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/60"
                                    >
                                      {item.visible ? 'SHOW' : 'HIDE'}
                                    </button>
                                    <span>{item.locked ? 'lock' : item.kind}</span>
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {selectedSceneItemIds.length > 1 ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-white">{selectedSceneItemIds.length} 个对象</div>
                            <div className="mt-1 text-[11px] text-white/45">批量对齐与分布</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleDuplicateSceneItems(selectedSceneItemIds)}
                              className="inline-flex items-center rounded-full border border-cyan-300/35 bg-cyan-400/12 px-3 py-1 text-[11px] text-cyan-100 transition hover:border-cyan-300/60"
                            >
                              复制
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSetSceneSelection([], null)}
                              className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:border-white/20 hover:text-white"
                            >
                              清空
                            </button>
                          </div>
                        </div>
                        {selectedSceneItemsSummary ? (
                          <div className="mt-4 grid grid-cols-3 gap-2">
                            <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">范围</div>
                              <div className="mt-1 text-sm text-white">{Math.round(selectedSceneItemsSummary.width)} × {Math.round(selectedSceneItemsSummary.height)}</div>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">左上角</div>
                              <div className="mt-1 text-sm text-white">{Math.round(selectedSceneItemsSummary.left)} / {Math.round(selectedSceneItemsSummary.top)}</div>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">类型</div>
                              <div className="mt-1 text-sm text-white">
                                A {selectedSceneItemsSummary.assetCount} · T {selectedSceneItemsSummary.textCount} · S {selectedSceneItemsSummary.subtitleCount}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => handleSetSceneItemVisibility(selectedSceneItemIds, false)}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            全部隐藏
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetSceneItemVisibility(selectedSceneItemIds, true)}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            全部显示
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleSceneSelectionLock()}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            {selectedSceneItemsSummary?.lockedCount === selectedSceneItemIds.length ? '全部解锁' : '全部锁定'}
                          </button>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => handleGroupSceneItems()}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            组对象
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUngroupSceneItems()}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            解组
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleSceneSelectionLock()}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            {selectedSceneItemsSummary?.lockedCount === selectedSceneItemIds.length ? '解锁选择' : '锁定选择'}
                          </button>
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          {([
                            ['left', '左对齐'],
                            ['center', '水平居中'],
                            ['right', '右对齐'],
                            ['top', '顶对齐'],
                            ['middle', '垂直居中'],
                            ['bottom', '底对齐'],
                          ] as const).map(([mode, label]) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => handleAlignSceneItems(mode)}
                              className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => handleDistributeSceneItems('horizontal')}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            水平分布
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDistributeSceneItems('vertical')}
                            className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            垂直分布
                          </button>
                        </div>
                        <div className="mt-3 rounded-xl border border-white/8 bg-black/20 px-3 py-3 text-[11px] leading-5 text-white/50">
                          画布支持 `Cmd/Ctrl/Shift + 点击` 多选，也支持直接拖拽框选。拖动任意已选对象会整体移动。已锁定 {selectedSceneItemsSummary?.lockedCount || 0} 个，已成组 {selectedSceneItemsSummary?.groupedCount || 0} 个。
                        </div>
                      </div>
                    ) : null}
                    {selectedTextSceneItemIds.length > 0 ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-white">批量文本样式</div>
                            <div className="mt-1 text-[11px] text-white/45">{selectedTextSceneItemIds.length} 个文本对象</div>
                          </div>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          {TEXT_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => void handleBatchUpdateTextStyle(selectedTextSceneItemIds, {
                                presetId: preset.id,
                                fontSize: preset.fontSize,
                                color: preset.color,
                                backgroundColor: preset.backgroundColor,
                                align: preset.align,
                                fontWeight: preset.fontWeight,
                                animation: preset.animation,
                              })}
                              className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-left text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                            >
                              <div className="font-medium">{preset.label}</div>
                              <div className="mt-1 text-[10px] text-white/45">{preset.animation} · {preset.align}</div>
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">文字颜色</div>
                            <input
                              type="color"
                              onChange={(event) => {
                                void handleBatchUpdateTextContentStyle(selectedTextSceneItemIds, {
                                  color: event.target.value,
                                });
                              }}
                              defaultValue="#ffffff"
                              className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">背景颜色</div>
                            <input
                              type="text"
                              defaultValue="rgba(15, 23, 42, 0.42)"
                              onBlur={(event) => {
                                void handleBatchUpdateTextContentStyle(selectedTextSceneItemIds, {
                                  backgroundColor: event.target.value,
                                });
                              }}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">对齐</div>
                            <select
                              defaultValue="center"
                              onChange={(event) => {
                                void handleBatchUpdateTextContentStyle(selectedTextSceneItemIds, {
                                  align: event.target.value as 'left' | 'center' | 'right',
                                });
                              }}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            >
                              <option value="left">左对齐</option>
                              <option value="center">居中</option>
                              <option value="right">右对齐</option>
                            </select>
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">动画</div>
                            <select
                              defaultValue="fade-up"
                              onChange={(event) => {
                                void handleBatchUpdateTextContentStyle(selectedTextSceneItemIds, {
                                  animation: event.target.value as 'fade-up' | 'fade-in' | 'pop' | 'slide-left',
                                });
                              }}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            >
                              <option value="fade-up">淡入上浮</option>
                              <option value="fade-in">淡入</option>
                              <option value="pop">弹出</option>
                              <option value="slide-left">左滑入</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    ) : null}
                    {selectedSubtitleSceneItemIds.length > 0 ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-sm font-medium text-white">批量字幕样式</div>
                        <div className="mt-1 text-[11px] text-white/45">{selectedSubtitleSceneItemIds.length} 个字幕对象</div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          {SUBTITLE_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => void handleBatchUpdateSubtitleStyle(selectedSubtitleSceneItemIds, {
                                presetId: preset.id,
                                position: preset.position,
                                fontSize: preset.fontSize,
                                color: preset.color,
                                backgroundColor: preset.backgroundColor,
                                emphasisColor: preset.emphasisColor,
                                align: preset.align,
                                animation: preset.animation,
                                fontWeight: preset.fontWeight,
                                textTransform: preset.textTransform,
                                letterSpacing: preset.letterSpacing,
                                borderRadius: preset.borderRadius,
                                paddingX: preset.paddingX,
                                paddingY: preset.paddingY,
                                segmentationMode: preset.type === 'word' ? 'singleWord' : 'punctuationOrPause',
                              })}
                              className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-left text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                            >
                              <div className="font-medium">{preset.label}</div>
                              <div className="mt-1 text-[10px] text-white/45">{preset.position} · {preset.animation}</div>
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          {([
                            ['punctuationOrPause', '按停顿'],
                            ['time', '按时间'],
                            ['singleWord', '逐词'],
                          ] as const).map(([mode, label]) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => void handleBatchUpdateSubtitleStyle(selectedSubtitleSceneItemIds, {
                                segmentationMode: mode,
                              })}
                              className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">文字颜色</div>
                            <input
                              type="color"
                              defaultValue="#ffffff"
                              onChange={(event) => {
                                void handleBatchUpdateSubtitleContentStyle(selectedSubtitleSceneItemIds, {
                                  color: event.target.value,
                                });
                              }}
                              className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">强调颜色</div>
                            <input
                              type="color"
                              defaultValue="#facc15"
                              onChange={(event) => {
                                void handleBatchUpdateSubtitleContentStyle(selectedSubtitleSceneItemIds, {
                                  emphasisColor: event.target.value,
                                });
                              }}
                              className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">位置</div>
                            <select
                              defaultValue="bottom"
                              onChange={(event) => {
                                void handleBatchUpdateSubtitleStyle(selectedSubtitleSceneItemIds, {
                                  position: event.target.value as 'top' | 'center' | 'bottom',
                                });
                              }}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            >
                              <option value="top">顶部</option>
                              <option value="center">中间</option>
                              <option value="bottom">底部</option>
                            </select>
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">动画</div>
                            <select
                              defaultValue="fade-up"
                              onChange={(event) => {
                                void handleBatchUpdateSubtitleContentStyle(selectedSubtitleSceneItemIds, {
                                  animation: event.target.value as 'fade-up' | 'fade-in' | 'pop' | 'slide-left',
                                });
                              }}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            >
                              <option value="fade-up">淡入上浮</option>
                              <option value="fade-in">淡入</option>
                              <option value="pop">弹出</option>
                              <option value="slide-left">左滑入</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    ) : null}
                    {selectedSceneItemTransform ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-sm font-medium text-white">{selectedSceneItemLabel || '舞台对象'}</div>
                        <div className="mt-1 text-[11px] text-white/45">
                          {selectedSceneItemKind === 'asset' ? '素材层' : selectedSceneItemKind === 'title' ? '标题层' : selectedSceneItemKind === 'text' ? '文本层' : selectedSceneItemKind === 'subtitle' ? '字幕层' : '文案层'}
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">X</div>
                            <input
                              type="number"
                              value={Math.round(selectedSceneItemTransform.x)}
                              onChange={(event) => handleUpdateSceneItemTransform(selectedSceneItemId!, { x: Number(event.target.value || 0) })}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">Y</div>
                            <input
                              type="number"
                              value={Math.round(selectedSceneItemTransform.y)}
                              onChange={(event) => handleUpdateSceneItemTransform(selectedSceneItemId!, { y: Number(event.target.value || 0) })}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">宽度</div>
                            <input
                              type="number"
                              min={selectedSceneItemTransform.minWidth}
                              value={Math.round(selectedSceneItemTransform.width)}
                              onChange={(event) => handleUpdateSceneItemTransform(selectedSceneItemId!, { width: Number(event.target.value || 0) })}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">高度</div>
                            <input
                              type="number"
                              min={selectedSceneItemTransform.minHeight}
                              value={Math.round(selectedSceneItemTransform.height)}
                              onChange={(event) => handleUpdateSceneItemTransform(selectedSceneItemId!, { height: Number(event.target.value || 0) })}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="col-span-2 flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            <span className="text-sm text-white">等比缩放</span>
                            <input
                              type="checkbox"
                              checked={selectedSceneItemTransform.lockAspectRatio}
                              onChange={(event) => handleUpdateSceneItemTransform(selectedSceneItemId!, { lockAspectRatio: event.target.checked })}
                              className="h-4 w-4 accent-cyan-400"
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}
                    {selectedTimelineClip && String(selectedTimelineClip.assetKind || '').trim().toLowerCase() === 'text' ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">文本样式</div>
                        <div className="mt-3 space-y-3">
                          <div>
                            <div className="mb-1 text-[11px] text-white/45">文本内容</div>
                            <textarea
                              value={String(selectedTimelineClip.name || '')}
                              onChange={(event) => {
                                void updateTextClipText(String(selectedTimelineClip.clipId || ''), event.target.value);
                              }}
                              className="h-20 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <label className="col-span-2 block">
                              <div className="mb-1 text-[11px] text-white/45">文本预设</div>
                              <div className="grid grid-cols-2 gap-2">
                                {TEXT_PRESETS.map((preset) => {
                                  const active = (selectedTimelineClip.textStyle?.presetId || 'headline-hero') === preset.id;
                                  return (
                                    <button
                                      key={preset.id}
                                      type="button"
                                      onClick={() => {
                                        void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                          presetId: preset.id,
                                          fontSize: preset.fontSize,
                                          color: preset.color,
                                          backgroundColor: preset.backgroundColor,
                                          align: preset.align,
                                          fontWeight: preset.fontWeight,
                                          animation: preset.animation,
                                        });
                                      }}
                                      className={clsx(
                                        'rounded-xl border px-3 py-2 text-left text-xs transition',
                                        active ? 'border-cyan-300/45 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                                      )}
                                    >
                                      <div className="font-medium">{preset.label}</div>
                                      <div className="mt-1 text-[10px] text-white/45">{preset.animation}</div>
                                    </button>
                                  );
                                })}
                              </div>
                            </label>
                            <label className="block">
                              <div className="mb-1 text-[11px] text-white/45">字号</div>
                              <input
                                type="number"
                                min={18}
                                max={96}
                                step={1}
                                value={Number(selectedTimelineClip.textStyle?.fontSize || 42)}
                                onChange={(event) => {
                                  void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                    fontSize: Number(event.target.value || 42),
                                  });
                                }}
                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              />
                            </label>
                            <label className="block">
                              <div className="mb-1 text-[11px] text-white/45">对齐</div>
                              <select
                                value={selectedTimelineClip.textStyle?.align || 'center'}
                                onChange={(event) => {
                                  void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                    align: event.target.value as 'left' | 'center' | 'right',
                                  });
                                }}
                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              >
                                <option value="left">左对齐</option>
                                <option value="center">居中</option>
                                <option value="right">右对齐</option>
                              </select>
                            </label>
                            <label className="block">
                              <div className="mb-1 text-[11px] text-white/45">动画</div>
                              <select
                                value={selectedTimelineClip.textStyle?.animation || resolveTextPreset(selectedTimelineClip.textStyle?.presetId).animation}
                                onChange={(event) => {
                                  void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                    animation: event.target.value as 'fade-up' | 'fade-in' | 'pop' | 'slide-left',
                                  });
                                }}
                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              >
                                <option value="fade-up">淡入上浮</option>
                                <option value="fade-in">淡入</option>
                                <option value="pop">弹出</option>
                                <option value="slide-left">左滑入</option>
                              </select>
                            </label>
                            <label className="block">
                              <div className="mb-1 text-[11px] text-white/45">文字颜色</div>
                              <input
                                type="color"
                                value={String(selectedTimelineClip.textStyle?.color || '#ffffff')}
                                onChange={(event) => {
                                  void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                    color: event.target.value,
                                  });
                                }}
                                className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                              />
                            </label>
                            <label className="block">
                              <div className="mb-1 text-[11px] text-white/45">背景颜色</div>
                              <input
                                type="text"
                                value={String(selectedTimelineClip.textStyle?.backgroundColor || 'rgba(15, 23, 42, 0.42)')}
                                onChange={(event) => {
                                  void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                    backgroundColor: event.target.value,
                                  });
                                }}
                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">Session</div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-white/70">
                        <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
                          <div className="text-white/35">播放头</div>
                          <div className="mt-1 font-medium text-white">{previewStatusLabel}</div>
                        </div>
                        <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
                          <div className="text-white/35">预览素材</div>
                          <div className="mt-1 truncate font-medium text-white">{currentPreviewAsset?.title || currentPreviewAsset?.id || '未选择'}</div>
                        </div>
                      </div>
                    </div>

                    {selectedTimelineClip && selectedClipDraft ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-sm font-medium text-white">{String(selectedTimelineClip.name || selectedClipAsset?.title || selectedTimelineClip.clipId || '未命名片段')}</div>
                        <div className="mt-1 text-[11px] text-white/45">
                          {String(selectedTimelineClip.track || '-')} · {String(selectedTimelineClip.assetKind || inferAssetKind(selectedClipAsset || { id: '' }))}
                        </div>
                        {String(selectedTimelineClip.assetKind || '').trim().toLowerCase() === 'subtitle' || String(selectedTimelineClip.track || '').trim().toUpperCase().startsWith('S') ? (
                          <div className="mt-4 space-y-3">
                            <div>
                              <div className="mb-1 text-[11px] text-white/45">字幕文案</div>
                              <textarea
                                value={String(selectedTimelineClip.name || '')}
                                onChange={(event) => {
                                  void updateSubtitleClipText(String(selectedTimelineClip.clipId || ''), event.target.value);
                                }}
                                className="h-20 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <label className="col-span-2 block">
                                <div className="mb-1 text-[11px] text-white/45">字幕预设</div>
                                <div className="grid grid-cols-2 gap-2">
                                  {SUBTITLE_PRESETS.map((preset) => {
                                    const active = (selectedTimelineClip.subtitleStyle?.presetId || 'classic-bottom') === preset.id;
                                    return (
                                      <button
                                        key={preset.id}
                                        type="button"
                                        onClick={() => {
                                          void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                            presetId: preset.id,
                                            position: preset.position,
                                            fontSize: preset.fontSize,
                                            color: preset.color,
                                            backgroundColor: preset.backgroundColor,
                                            align: preset.align,
                                            animation: preset.animation,
                                            segmentationMode: preset.type === 'word' ? 'singleWord' : 'punctuationOrPause',
                                            linesPerCaption: 1,
                                          });
                                        }}
                                        className={clsx(
                                          'rounded-xl border px-3 py-2 text-xs text-left transition',
                                          active ? 'border-cyan-300/45 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                                        )}
                                      >
                                        <div className="font-medium">{preset.label}</div>
                                        <div className="mt-1 text-[10px] text-white/45">{preset.position} · {preset.animation}</div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">位置</div>
                                <select
                                  value={selectedTimelineClip.subtitleStyle?.position || 'bottom'}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      position: event.target.value as 'top' | 'center' | 'bottom',
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  <option value="top">顶部</option>
                                  <option value="center">中间</option>
                                  <option value="bottom">底部</option>
                                </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">动画</div>
                                <select
                                  value={selectedTimelineClip.subtitleStyle?.animation || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).animation}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      animation: event.target.value as 'fade-up' | 'fade-in' | 'pop' | 'slide-left',
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  <option value="fade-up">淡入上浮</option>
                                  <option value="fade-in">淡入</option>
                                  <option value="pop">弹出</option>
                                  <option value="slide-left">左滑入</option>
                                </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">字号</div>
                                <input
                                  type="number"
                                  min={18}
                                  max={72}
                                  step={1}
                                  value={Number(selectedTimelineClip.subtitleStyle?.fontSize || 34)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      fontSize: Number(event.target.value || 34),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">文字颜色</div>
                                <input
                                  type="color"
                                  value={String(selectedTimelineClip.subtitleStyle?.color || '#ffffff')}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      color: event.target.value,
                                    });
                                  }}
                                  className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">强调颜色</div>
                                <input
                                  type="color"
                                  value={String(selectedTimelineClip.subtitleStyle?.emphasisColor || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).emphasisColor)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      emphasisColor: event.target.value,
                                    });
                                  }}
                                  className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">背景颜色</div>
                                <input
                                  type="text"
                                  value={String(selectedTimelineClip.subtitleStyle?.backgroundColor || 'rgba(6, 8, 12, 0.58)')}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      backgroundColor: event.target.value,
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">字重</div>
                                <input
                                  type="number"
                                  min={400}
                                  max={900}
                                  step={100}
                                  value={Number(selectedTimelineClip.subtitleStyle?.fontWeight || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).fontWeight)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      fontWeight: Number(event.target.value || 700),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="col-span-2 block">
                                <div className="mb-1 text-[11px] text-white/45">对齐</div>
                                <select
                                  value={selectedTimelineClip.subtitleStyle?.align || 'center'}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      align: event.target.value as 'left' | 'center' | 'right',
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  <option value="left">左对齐</option>
                                  <option value="center">居中</option>
                                  <option value="right">右对齐</option>
                                  </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">圆角</div>
                                <input
                                  type="number"
                                  min={0}
                                  max={48}
                                  step={1}
                                  value={Number(selectedTimelineClip.subtitleStyle?.borderRadius || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).borderRadius)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      borderRadius: Number(event.target.value || 0),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">字距</div>
                                <input
                                  type="number"
                                  min={0}
                                  max={4}
                                  step={0.1}
                                  value={Number(selectedTimelineClip.subtitleStyle?.letterSpacing || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).letterSpacing)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      letterSpacing: Number(event.target.value || 0),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">大小写</div>
                                <select
                                  value={selectedTimelineClip.subtitleStyle?.textTransform || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).textTransform}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      textTransform: event.target.value as 'none' | 'uppercase',
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  <option value="none">正常</option>
                                  <option value="uppercase">全大写</option>
                                </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">横向内边距</div>
                                <input
                                  type="number"
                                  min={0}
                                  max={48}
                                  step={1}
                                  value={Number(selectedTimelineClip.subtitleStyle?.paddingX || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).paddingX)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      paddingX: Number(event.target.value || 0),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">纵向内边距</div>
                                <input
                                  type="number"
                                  min={0}
                                  max={32}
                                  step={1}
                                  value={Number(selectedTimelineClip.subtitleStyle?.paddingY || resolveSubtitlePreset(selectedTimelineClip.subtitleStyle?.presetId).paddingY)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      paddingY: Number(event.target.value || 0),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">分段模式</div>
                                <select
                                  value={selectedTimelineClip.subtitleStyle?.segmentationMode || 'punctuationOrPause'}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      segmentationMode: event.target.value as 'punctuationOrPause' | 'time' | 'singleWord',
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  <option value="punctuationOrPause">按停顿 / 标点</option>
                                  <option value="time">按时间块</option>
                                  <option value="singleWord">逐词</option>
                                </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">每屏行数</div>
                                <input
                                  type="number"
                                  min={1}
                                  max={5}
                                  step={1}
                                  value={Number(selectedTimelineClip.subtitleStyle?.linesPerCaption || 1)}
                                  onChange={(event) => {
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      linesPerCaption: Math.min(5, Math.max(1, Number(event.target.value || 1))),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="col-span-2 block">
                                <div className="mb-1 text-[11px] text-white/45">强调词（空格分隔）</div>
                                <input
                                  type="text"
                                  value={Array.isArray(selectedTimelineClip.subtitleStyle?.emphasisWords) ? selectedTimelineClip.subtitleStyle?.emphasisWords.join(' ') : ''}
                                  onChange={(event) => {
                                    const emphasisWords = event.target.value.split(/\s+/).map((word) => word.trim()).filter(Boolean);
                                    void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      emphasisWords,
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              {selectedSubtitleTokens.length > 0 ? (
                                <div className="col-span-2 rounded-[18px] border border-white/8 bg-black/15 p-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/38">Caption Words</div>
                                    <div className="text-[11px] text-white/45">
                                      {selectedSubtitleEmphasisSet.size} / {selectedSubtitleTokens.length} 已强调
                                    </div>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">
                                      {subtitleSegmentationLabel(String(selectedTimelineClip.subtitleStyle?.segmentationMode || 'punctuationOrPause'))}
                                    </span>
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">
                                      {Number(selectedTimelineClip.subtitleStyle?.linesPerCaption || 1)} 行 / 屏
                                    </span>
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {selectedSubtitleTokens.map((token, index) => {
                                      const normalizedToken = normalizeCaptionToken(token);
                                      const active = !!normalizedToken && selectedSubtitleEmphasisSet.has(normalizedToken);
                                      return (
                                        <button
                                          key={`${token}-${index}`}
                                          type="button"
                                          onClick={() => {
                                            if (!normalizedToken) return;
                                            const currentWords = Array.isArray(selectedTimelineClip.subtitleStyle?.emphasisWords)
                                              ? selectedTimelineClip.subtitleStyle?.emphasisWords
                                              : [];
                                            const currentSet = new Set(currentWords.map((word) => normalizeCaptionToken(String(word || ''))).filter(Boolean));
                                            if (currentSet.has(normalizedToken)) {
                                              currentSet.delete(normalizedToken);
                                            } else {
                                              currentSet.add(normalizedToken);
                                            }
                                            const nextWords = Array.from(currentSet);
                                            void updateSubtitleClipStyle(String(selectedTimelineClip.clipId || ''), {
                                              emphasisWords: nextWords,
                                            });
                                          }}
                                          className={clsx(
                                            'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                                            active
                                              ? 'border-amber-300/45 bg-amber-400/14 text-amber-100'
                                              : 'border-white/10 bg-white/[0.05] text-white/70 hover:border-white/20 hover:text-white'
                                          )}
                                        >
                                          {token}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <div className="mt-3 text-[11px] text-white/45">
                                    直接点词切换强调状态。预览画布会按播放进度高亮当前词，并保留这些重点词的强调色。
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        {String(selectedTimelineClip.assetKind || '').trim().toLowerCase() === 'text' ? (
                          <div className="mt-4 space-y-3 rounded-[18px] border border-white/8 bg-black/15 p-3">
                            <div>
                              <div className="mb-1 text-[11px] text-white/45">文本内容</div>
                              <textarea
                                value={String(selectedTimelineClip.name || '')}
                                onChange={(event) => {
                                  void updateSubtitleClipText(String(selectedTimelineClip.clipId || ''), event.target.value);
                                }}
                                className="h-20 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">字号</div>
                                <input
                                  type="number"
                                  min={18}
                                  max={96}
                                  step={1}
                                  value={Number(selectedTimelineClip.textStyle?.fontSize || 42)}
                                  onChange={(event) => {
                                    void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      fontSize: Number(event.target.value || 42),
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">对齐</div>
                                <select
                                  value={selectedTimelineClip.textStyle?.align || 'center'}
                                  onChange={(event) => {
                                    void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      align: event.target.value as 'left' | 'center' | 'right',
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  <option value="left">左对齐</option>
                                  <option value="center">居中</option>
                                  <option value="right">右对齐</option>
                                </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">文字颜色</div>
                                <input
                                  type="color"
                                  value={String(selectedTimelineClip.textStyle?.color || '#ffffff')}
                                  onChange={(event) => {
                                    void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      color: event.target.value,
                                    });
                                  }}
                                  className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-2 py-1"
                                />
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">背景颜色</div>
                                <input
                                  type="text"
                                  value={String(selectedTimelineClip.textStyle?.backgroundColor || 'rgba(15, 23, 42, 0.42)')}
                                  onChange={(event) => {
                                    void updateTextClipStyle(String(selectedTimelineClip.clipId || ''), {
                                      backgroundColor: event.target.value,
                                    });
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                            </div>
                          </div>
                        ) : null}
                        {String(selectedTimelineClip.assetKind || '').trim().toLowerCase() !== 'audio'
                          && !(String(selectedTimelineClip.track || '').trim().toUpperCase().startsWith('S'))
                          ? (
                            <div className="mt-4 space-y-3 rounded-[18px] border border-white/8 bg-black/15 p-3">
                              <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">转场</div>
                              <div className="grid grid-cols-2 gap-2">
                                {TRANSITION_PRESETS.map((preset) => {
                                  const active = (selectedTimelineClip.transitionStyle?.presetId || 'none') === preset.id;
                                  return (
                                    <button
                                      key={preset.id}
                                      type="button"
                                      onClick={() => {
                                        void updateClipTransitionStyle(String(selectedTimelineClip.clipId || ''), {
                                          presetId: preset.id,
                                          kind: preset.kind,
                                          direction: preset.direction,
                                          durationMs: preset.durationMs,
                                        });
                                      }}
                                      className={clsx(
                                        'rounded-xl border px-3 py-2 text-left text-xs transition',
                                        active ? 'border-cyan-300/45 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                                      )}
                                    >
                                      <div className="font-medium">{preset.label}</div>
                                      <div className="mt-1 text-[10px] text-white/45">{preset.kind} · {preset.durationMs}ms</div>
                                    </button>
                                  );
                                })}
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <label className="block">
                                  <div className="mb-1 text-[11px] text-white/45">当前转场</div>
                                  <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white">
                                    {selectedTransitionPreset.label}
                                  </div>
                                  <div className="mt-1 text-[10px] text-white/40">
                                    {selectedTransitionPreset.kind}
                                    {selectedTimelineClip.transitionStyle?.direction || selectedTransitionPreset.direction
                                      ? ` · ${String(selectedTimelineClip.transitionStyle?.direction || selectedTransitionPreset.direction).replace('from-', '')}`
                                      : ''}
                                  </div>
                                </label>
                                <label className="block">
                                  <div className="mb-1 text-[11px] text-white/45">转场时长 (ms)</div>
                                  <input
                                    type="number"
                                    min={0}
                                    max={2000}
                                    step={50}
                                    value={Number(selectedTimelineClip.transitionStyle?.durationMs ?? selectedTransitionPreset.durationMs)}
                                    onChange={(event) => {
                                      void updateClipTransitionStyle(String(selectedTimelineClip.clipId || ''), {
                                        durationMs: Number(event.target.value || 0),
                                      });
                                    }}
                                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                  />
                                </label>
                              </div>
                            </div>
                          ) : null}
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">轨道</div>
                            <select
                              value={selectedClipDraft.track}
                              onChange={(event) => setSelectedClipDraft((prev) => prev ? { ...prev, track: event.target.value } : prev)}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            >
                              {timelineTrackNames.map((track) => <option key={track} value={track}>{track}</option>)}
                            </select>
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">时长 (ms)</div>
                            <input
                              type="number"
                              min={inferAssetKind(selectedClipAsset || { id: '' }) === 'image' ? IMAGE_CLIP_MS : 100}
                              step={100}
                              value={selectedClipDraft.durationMs}
                              onChange={(event) => setSelectedClipDraft((prev) => prev ? { ...prev, durationMs: Number(event.target.value || 0) } : prev)}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">Trim In (ms)</div>
                            <input
                              type="number"
                              min={0}
                              step={100}
                              value={selectedClipDraft.trimInMs}
                              onChange={(event) => setSelectedClipDraft((prev) => prev ? { ...prev, trimInMs: Number(event.target.value || 0) } : prev)}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                          <label className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            <span className="text-sm text-white">{selectedClipDraft.enabled ? '已启用' : '已禁用'}</span>
                            <input
                              type="checkbox"
                              checked={selectedClipDraft.enabled}
                              onChange={(event) => setSelectedClipDraft((prev) => prev ? { ...prev, enabled: event.target.checked } : prev)}
                              className="h-4 w-4 accent-cyan-400"
                            />
                          </label>
                        </div>
                        <button
                          type="button"
                          onClick={() => void persistSelectedClipDraft()}
                          disabled={isSavingSelectedClip}
                          className={clsx(
                            'mt-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                            isSavingSelectedClip
                              ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                              : 'border-cyan-300/45 bg-cyan-400/14 text-cyan-100 hover:border-cyan-300/70'
                          )}
                        >
                          <Save className="h-3.5 w-3.5" />
                          {isSavingSelectedClip ? '保存中...' : '保存片段设置'}
                        </button>
                      </div>
                    ) : selectedScene ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-sm font-medium text-white">{selectedScene.overlayTitle || '当前 Remotion 场景'}</div>
                        <div className="mt-4 space-y-3">
                          <input
                            value={selectedScene.overlayTitle || ''}
                            onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, overlayTitle: event.target.value }))}
                            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          />
                          <textarea
                            value={selectedScene.overlayBody || ''}
                            onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, overlayBody: event.target.value }))}
                            className="h-24 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          />
                          <div className="grid grid-cols-2 gap-3">
                            <select
                              value={selectedScene.motionPreset || 'static'}
                              onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, motionPreset: event.target.value as MotionPreset }))}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            >
                              {MOTION_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                            </select>
                            <input
                              type="number"
                              min={12}
                              step={1}
                              value={selectedScene.durationInFrames}
                              onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, durationInFrames: Math.max(12, Number(event.target.value || 0)) }))}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </div>
                          <select
                            value={buildEditableOverlay(selectedScene).animation || 'fade-up'}
                            onChange={(event) => updateScene(selectedScene.id, (scene) => ({
                              ...scene,
                              overlays: [{ ...buildEditableOverlay(scene), animation: event.target.value as OverlayAnimation }],
                            }))}
                            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          >
                            {OVERLAY_ANIMATIONS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                          </select>
                        </div>
                      </div>
                    ) : activeTrackSummary ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">当前轨道</div>
                        <div className="mt-2 text-sm font-medium text-white">{activeTrackSummary.id}</div>
                        <div className="mt-1 text-[11px] text-white/45">{activeTrackSummary.kind}</div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-white/70">
                          <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
                            <div className="text-white/35">片段数</div>
                            <div className="mt-1 font-medium text-white">{activeTrackSummary.clipCount}</div>
                          </div>
                          <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
                            <div className="text-white/35">总时长</div>
                            <div className="mt-1 font-medium text-white">{formatSecondsLabel(activeTrackSummary.totalSeconds)}</div>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className={clsx('rounded-full border px-2.5 py-1 text-[10px]', activeTrackSummary.ui.locked ? 'border-amber-300/35 bg-amber-300/12 text-amber-100' : 'border-white/10 bg-white/[0.03] text-white/55')}>
                            {activeTrackSummary.ui.locked ? '已锁定' : '未锁定'}
                          </span>
                          <span className={clsx('rounded-full border px-2.5 py-1 text-[10px]', activeTrackSummary.ui.hidden ? 'border-white/20 bg-white/[0.06] text-white/75' : 'border-white/10 bg-white/[0.03] text-white/55')}>
                            {activeTrackSummary.ui.hidden ? '已隐藏' : '可见'}
                          </span>
                          <span className={clsx('rounded-full border px-2.5 py-1 text-[10px]', activeTrackSummary.ui.collapsed ? 'border-cyan-300/30 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-white/[0.03] text-white/55')}>
                            {activeTrackSummary.ui.collapsed ? '已折叠' : '已展开'}
                          </span>
                          {activeTrackSummary.id.startsWith('A') ? (
                            <span className={clsx('rounded-full border px-2.5 py-1 text-[10px]', activeTrackSummary.ui.muted ? 'border-rose-300/30 bg-rose-400/12 text-rose-100' : 'border-white/10 bg-white/[0.03] text-white/55')}>
                              {activeTrackSummary.ui.muted ? '已静音' : '有声'}
                            </span>
                          ) : null}
                          {activeTrackSummary.id.startsWith('A') ? (
                            <span className={clsx('rounded-full border px-2.5 py-1 text-[10px]', activeTrackSummary.ui.solo ? 'border-violet-300/30 bg-violet-400/12 text-violet-100' : 'border-white/10 bg-white/[0.03] text-white/55')}>
                              {activeTrackSummary.ui.solo ? '独奏中' : '未独奏'}
                            </span>
                          ) : null}
                          {activeTrackSummary.id.startsWith('A') ? (
                            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] text-white/55">
                              音量 {Math.round((activeTrackSummary.ui.volume ?? 1) * 100)}%
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => void handleAddTrackFromInspector(activeTrackSummary.id.startsWith('A') ? 'audio' : activeTrackSummary.id.startsWith('S') ? 'subtitle' : 'video')}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-cyan-300/45 hover:text-cyan-100"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            同类新轨
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleMoveActiveTrack('up')}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                            上移
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleMoveActiveTrack('down')}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                            下移
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteActiveTrack()}
                            disabled={!canDeleteActiveTrack}
                            className={clsx(
                              'inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition',
                              !canDeleteActiveTrack
                                ? 'cursor-not-allowed border-white/10 bg-white/[0.02] text-white/30'
                                : 'border-red-400/20 bg-red-400/10 text-red-100 hover:border-red-300/50'
                            )}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删轨
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleClearActiveTrack()}
                            disabled={activeTrackSummary.clipCount === 0}
                            className={clsx(
                              'inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition',
                              activeTrackSummary.clipCount === 0
                                ? 'cursor-not-allowed border-white/10 bg-white/[0.02] text-white/30'
                                : 'border-white/10 bg-white/[0.04] text-white/80 hover:border-white/20 hover:text-white'
                            )}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            清空轨
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleActiveTrackUi('locked')}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                          >
                            {activeTrackSummary.ui.locked ? '解锁' : '锁轨'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleActiveTrackUi('hidden')}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                          >
                            {activeTrackSummary.ui.hidden ? '显示' : '隐藏'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleActiveTrackUi('collapsed')}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                          >
                            {activeTrackSummary.ui.collapsed ? '展开' : '折叠'}
                          </button>
                          {activeTrackSummary.id.startsWith('A') ? (
                            <button
                              type="button"
                              onClick={() => handleToggleActiveTrackUi('muted')}
                              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                            >
                              {activeTrackSummary.ui.muted ? '取消静音' : '静音'}
                            </button>
                          ) : null}
                          {activeTrackSummary.id.startsWith('A') ? (
                            <button
                              type="button"
                              onClick={() => handleToggleActiveTrackUi('solo')}
                              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:border-white/20 hover:text-white"
                            >
                              {activeTrackSummary.ui.solo ? '取消独奏' : '独奏'}
                            </button>
                          ) : null}
                          {activeTrackSummary.id.startsWith('A') ? (
                            <label className="col-span-2 block">
                              <div className="mb-1 text-[11px] text-white/45">轨道音量</div>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={Math.round((activeTrackSummary.ui.volume ?? 1) * 100)}
                                onChange={(event) => {
                                  const nextVolume = Number(event.target.value || 0) / 100;
                                  editorStore.setState((state) => {
                                    if (!activeTrackId) return {};
                                    const current = state.timeline.trackUi[activeTrackId] || { locked: false, hidden: false, collapsed: false, muted: false, solo: false, volume: 1 };
                                    return {
                                      timeline: {
                                        ...state.timeline,
                                        trackUi: {
                                          ...state.timeline.trackUi,
                                          [activeTrackId]: {
                                            ...current,
                                            volume: Math.min(Math.max(nextVolume, 0), 1),
                                          },
                                        },
                                      },
                                    };
                                  });
                                }}
                                className="w-full accent-cyan-300"
                              />
                            </label>
                          ) : null}
                        </div>
                        <div className="mt-4 text-xs text-white/50">
                          当前没有选中片段时，Inspector 会显示激活轨道的摘要。轨道重排、删轨和跨轨移动现在在时间轴工具栏中可直接操作。
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/55">
                        当前还没有选中对象。点击时间轴片段或舞台中的可视层后，这里会切换为 inspector。
                      </div>
                    )}
                  </div>
                ) : activeSidebarTab === 'captions' ? (
                  <div className="space-y-4">
                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">字幕轨</div>
                          <div className="mt-2 text-sm text-white/80">在当前游标处插入字幕片段，并让预览画布直接显示。</div>
                        </div>
                        <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/65">
                          {subtitleClips.length} 段
                        </div>
                      </div>
                      <div className="mt-4 rounded-[20px] border border-white/10 bg-black/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">自动识别</div>
                            <div className="mt-1 text-sm text-white/85">
                              {subtitleRecognitionClip
                                ? `从 ${clipPreviewText(String(subtitleRecognitionClip.name || subtitleRecognitionClip.clipId || '当前片段'))} 生成字幕段`
                                : '先选中一个音频或视频片段，再识别字幕'}
                            </div>
                            {subtitleRecognitionClip ? (
                              <div className="mt-2 text-[11px] text-white/45">
                                {String(subtitleRecognitionClip.track || '-')} · {String(subtitleRecognitionClip.assetKind || 'media')} · {Math.round(Number(subtitleRecognitionClip.durationMs || 0))}ms
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => void transcribeSubtitlesForClip()}
                            disabled={!subtitleRecognitionClip || isTranscribingSubtitles}
                            className={clsx(
                              'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-medium transition',
                              !subtitleRecognitionClip || isTranscribingSubtitles
                                ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                                : 'border-cyan-300/45 bg-cyan-400/14 text-cyan-100 hover:border-cyan-300/70'
                            )}
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            {isTranscribingSubtitles ? '识别中...' : '识别当前片段字幕'}
                          </button>
                        </div>
                        {subtitleTranscriptionNotice ? (
                          <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] text-white/70">
                            {subtitleTranscriptionNotice}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-4 rounded-[20px] border border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.45),rgba(8,47,73,0.22))] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Caption Preset</div>
                            <div className="mt-1 text-sm font-medium text-white">{subtitleDraftPreset.label}</div>
                          </div>
                          <div className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/60">
                            {subtitleDraftPreset.type}
                          </div>
                        </div>
                        <div
                          className="mt-3 flex min-h-[84px] items-center justify-center rounded-2xl border border-white/10 px-4 text-center"
                          style={{
                            color: subtitleDraftPreset.color,
                            background: subtitleDraftPreset.backgroundColor,
                            fontSize: `${Math.max(16, subtitleDraftPreset.fontSize * 0.52)}px`,
                            fontWeight: subtitleDraftPreset.fontWeight,
                            letterSpacing: `${subtitleDraftPreset.letterSpacing}px`,
                            textTransform: subtitleDraftPreset.textTransform,
                            borderRadius: `${subtitleDraftPreset.borderRadius}px`,
                            padding: `${Math.max(8, subtitleDraftPreset.paddingY * 0.6)}px ${Math.max(12, subtitleDraftPreset.paddingX * 0.6)}px`,
                          }}
                        >
                          <span>Caption rhythm stays readable, bold and timed.</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">{subtitleDraftPreset.position}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">{subtitleDraftPreset.animation}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">#{subtitleDraftPreset.fontSize}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">{subtitleSegmentationLabel('punctuationOrPause')}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">重点色</span>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {SUBTITLE_PRESETS.map((preset) => {
                          const active = subtitlePresetId === preset.id;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => setSubtitlePresetId(preset.id)}
                              className={clsx(
                                'rounded-2xl border px-3 py-3 text-left transition',
                                active ? 'border-cyan-300/45 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                              )}
                            >
                              <div className="text-sm font-medium">{preset.label}</div>
                              <div className="mt-1 text-[10px] text-white/45">{preset.position} · {preset.animation}</div>
                            </button>
                          );
                        })}
                      </div>
                      <textarea
                        value={subtitleDraftText}
                        onChange={(event) => setSubtitleDraftText(event.target.value)}
                        placeholder="输入字幕内容，例如：今天我们来讲这个镜头为什么要这样剪。"
                        className="mt-3 h-24 w-full resize-none rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                      />
                      <div className="mt-3 flex items-center gap-3">
                        <label className="block flex-1">
                          <div className="mb-1 text-[11px] text-white/45">时长 (ms)</div>
                          <input
                            type="number"
                            min={500}
                            step={100}
                            value={subtitleDraftDurationMs}
                            onChange={(event) => setSubtitleDraftDurationMs(Number(event.target.value || 0))}
                            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void insertSubtitleAtPlayhead(subtitleDraftText, subtitleDraftDurationMs)}
                          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-cyan-300/45 bg-cyan-400/14 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/70"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          在游标处加字幕
                        </button>
                      </div>
                    </div>

                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">当前字幕片段</div>
                        <div className="text-[11px] text-white/45">{subtitleClips.length} 段</div>
                      </div>
                      <div className="mt-3 space-y-2">
                        {subtitleClips.length > 0 ? subtitleClips.map((clip) => {
                          const clipId = String(clip.clipId || '').trim();
                          const isSelected = clipId && clipId === selectedClipId;
                          const resolvedPreset = resolveSubtitlePreset(clip.subtitleStyle?.presetId);
                          const normalizedText = normalizeClipText(clip.name);
                          const emphasisCount = Array.isArray(clip.subtitleStyle?.emphasisWords) ? clip.subtitleStyle?.emphasisWords.length : 0;
                          return (
                            <button
                              key={clipId || `${clip.track}-${clip.startSeconds}`}
                              type="button"
                              onClick={() => handleTimelineSelectedClipChange(clipId || null)}
                              className={clsx(
                                'block w-full rounded-2xl border px-3 py-3 text-left transition',
                                isSelected ? 'border-cyan-300/45 bg-cyan-400/10' : 'border-white/10 bg-black/15 hover:border-white/20'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-white">
                                    {normalizedText || '未命名字幕'}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-white/70">
                                      {resolvedPreset.label}
                                    </span>
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-white/60">
                                      {String(clip.subtitleStyle?.animation || resolvedPreset.animation)}
                                    </span>
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-white/60">
                                      {subtitleSegmentationLabel(String(clip.subtitleStyle?.segmentationMode || 'punctuationOrPause'))}
                                    </span>
                                  </div>
                                </div>
                                <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] text-white/65">
                                  {clipTokenCount(normalizedText)} 词
                                </div>
                              </div>
                              <div className="mt-2 text-[11px] leading-5 text-white/55">
                                {clipPreviewText(normalizedText, 72)}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/45">
                                {String(clip.track || 'S1')} · {formatSecondsLabel(Number(clip.startSeconds || 0))} - {formatSecondsLabel(Number(clip.endSeconds || 0))}
                                <span>·</span>
                                <span>{String(clip.subtitleStyle?.position || resolvedPreset.position)}</span>
                                {emphasisCount > 0 ? (
                                  <>
                                    <span>·</span>
                                    <span>{emphasisCount} 个重点词</span>
                                  </>
                                ) : null}
                                {Number(clip.subtitleStyle?.linesPerCaption || 1) > 1 ? (
                                  <>
                                    <span>·</span>
                                    <span>{Number(clip.subtitleStyle?.linesPerCaption || 1)} 行</span>
                                  </>
                                ) : null}
                              </div>
                            </button>
                          );
                        }) : (
                          <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-4 text-sm text-white/50">
                            还没有字幕片段。先在上方输入一句字幕并插入到时间轴。
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : activeSidebarTab === 'texts' ? (
                  <div className="space-y-4">
                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">文本图层</div>
                          <div className="mt-2 text-sm text-white/80">在当前游标处插入文本图层，并在视频画布中直接编辑位置与样式。</div>
                        </div>
                        <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/65">
                          {textClips.length} 段
                        </div>
                      </div>
                      <div className="mt-4 rounded-[20px] border border-white/10 bg-[linear-gradient(135deg,rgba(59,7,100,0.38),rgba(15,23,42,0.24))] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Text Preset</div>
                            <div className="mt-1 text-sm font-medium text-white">{textDraftPreset.label}</div>
                          </div>
                          <div className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/60">
                            {textDraftPreset.animation}
                          </div>
                        </div>
                        <div
                          className="mt-3 flex min-h-[84px] items-center rounded-2xl border border-white/10 px-4"
                          style={{
                            color: textDraftPreset.color,
                            background: textDraftPreset.backgroundColor,
                            justifyContent: textDraftPreset.align === 'left' ? 'flex-start' : textDraftPreset.align === 'right' ? 'flex-end' : 'center',
                            fontSize: `${Math.max(16, textDraftPreset.fontSize * 0.5)}px`,
                            fontWeight: textDraftPreset.fontWeight,
                          }}
                        >
                          <span>{textDraftPreset.label} SAMPLE</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">{textDraftPreset.align}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">#{textDraftPreset.fontSize}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">weight {textDraftPreset.fontWeight}</span>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {TEXT_PRESETS.map((preset) => {
                          const active = textPresetId === preset.id;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => setTextPresetId(preset.id)}
                              className={clsx(
                                'rounded-2xl border px-3 py-3 text-left transition',
                                active ? 'border-cyan-300/45 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                              )}
                            >
                              <div className="text-sm font-medium">{preset.label}</div>
                              <div className="mt-1 text-[10px] text-white/45">{preset.animation}</div>
                            </button>
                          );
                        })}
                      </div>
                      <textarea
                        value={textDraftText}
                        onChange={(event) => setTextDraftText(event.target.value)}
                        placeholder="输入标题或强调文案"
                        className="mt-3 h-20 w-full resize-none rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                      />
                      <div className="mt-3 flex items-center gap-3">
                        <label className="block flex-1">
                          <div className="mb-1 text-[11px] text-white/45">时长 (ms)</div>
                          <input
                            type="number"
                            min={600}
                            step={100}
                            value={textDraftDurationMs}
                            onChange={(event) => setTextDraftDurationMs(Number(event.target.value || 0))}
                            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void insertTextAtPlayhead(textDraftText, textDraftDurationMs)}
                          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-cyan-300/45 bg-cyan-400/14 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/70"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          在游标处加文本
                        </button>
                      </div>
                    </div>

                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">当前文本片段</div>
                        <div className="text-[11px] text-white/45">{textClips.length} 段</div>
                      </div>
                      <div className="mt-3 space-y-2">
                        {textClips.length > 0 ? textClips.map((clip) => {
                          const clipId = String(clip.clipId || '').trim();
                          const isSelected = clipId && clipId === selectedClipId;
                          const resolvedPreset = resolveTextPreset(clip.textStyle?.presetId);
                          const normalizedText = normalizeClipText(clip.name);
                          return (
                            <button
                              key={clipId || `${clip.track}-${clip.startSeconds}`}
                              type="button"
                              onClick={() => handleTimelineSelectedClipChange(clipId || null)}
                              className={clsx(
                                'block w-full rounded-2xl border px-3 py-3 text-left transition',
                                isSelected ? 'border-cyan-300/45 bg-cyan-400/10 text-cyan-100' : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{normalizedText || '未命名文本'}</div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-white/70">
                                      {resolvedPreset.label}
                                    </span>
                                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-white/60">
                                      {String(clip.textStyle?.animation || resolvedPreset.animation)}
                                    </span>
                                  </div>
                                </div>
                                <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] text-white/65">
                                  {clipTokenCount(normalizedText)} 词
                                </div>
                              </div>
                              <div className="mt-2 text-[11px] leading-5 text-white/55">
                                {clipPreviewText(normalizedText, 72)}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/45">
                                {String(clip.track || 'T1')} · {formatSecondsLabel(Number(clip.startSeconds || 0))} - {formatSecondsLabel(Number(clip.endSeconds || 0))}
                                <span>·</span>
                                <span>{String(clip.textStyle?.align || resolvedPreset.align)}</span>
                                <span>·</span>
                                <span>{Math.round(Number(clip.textStyle?.fontSize || resolvedPreset.fontSize))} px</span>
                              </div>
                            </button>
                          );
                        }) : (
                          <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-4 text-sm text-white/50">
                            还没有文本片段。先在上方输入一段文案并插入到时间轴。
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : activeSidebarTab === 'transitions' ? (
                  <div className="space-y-4">
                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">Transitions</div>
                          <div className="mt-2 text-sm text-white/80">
                            转场现在按“上一镜头 → 当前镜头”的关系工作，时间轴、预览画布和片段 inspector 会同步显示这段连接。
                          </div>
                        </div>
                        <div className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-3 py-1 text-[11px] font-medium text-cyan-100">
                          {transitionClipCount} 段已配置
                        </div>
                      </div>

                      {selectedTransitionContext ? (
                        <div className="mt-4 rounded-[20px] border border-white/10 bg-[linear-gradient(135deg,rgba(8,47,73,0.22),rgba(15,23,42,0.22))] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Transition Series</div>
                              <div className="mt-1 text-sm text-white/80">
                                第 {selectedTransitionContext.index} / {selectedTransitionContext.total} 个视觉片段
                              </div>
                            </div>
                            <div
                              className="rounded-full border px-3 py-1 text-[11px] font-medium"
                              style={{
                                borderColor: `${selectedTransitionContext.preset.accent}55`,
                                background: `${selectedTransitionContext.preset.accent}1c`,
                                color: '#e0f2fe',
                              }}
                            >
                              {selectedTransitionContext.preset.label}
                            </div>
                          </div>
                          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
                            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">From</div>
                              <div className="mt-1 truncate text-sm font-medium text-white">
                                {selectedTransitionContext.previous ? String(selectedTransitionContext.previous.name || selectedTransitionContext.previous.clipId || '未命名片段') : '序列开头'}
                              </div>
                              <div className="mt-1 text-[11px] text-white/45">
                                {selectedTransitionContext.previous
                                  ? `${String(selectedTransitionContext.previous.track || 'V1')} · ${formatSecondsLabel(Number(selectedTransitionContext.previous.startSeconds || 0))}`
                                  : '首个视觉片段不需要入场转场'}
                              </div>
                            </div>
                            <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] font-medium text-white/70">
                              {selectedTransitionContext.durationMs}ms
                            </div>
                            <div className="rounded-2xl border border-cyan-300/35 bg-cyan-400/10 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/60">To</div>
                              <div className="mt-1 truncate text-sm font-medium text-cyan-50">
                                {String(selectedTransitionContext.current.name || selectedTransitionContext.current.clipId || '未命名片段')}
                              </div>
                              <div className="mt-1 text-[11px] text-cyan-100/60">
                                {String(selectedTransitionContext.current.track || 'V1')} · {formatSecondsLabel(Number(selectedTransitionContext.current.startSeconds || 0))}
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">
                              类型：{selectedTransitionContext.preset.kind}
                            </span>
                            {selectedTransitionContext.direction ? (
                              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">
                                方向：{selectedTransitionContext.direction.replace('from-', '')}
                              </span>
                            ) : null}
                            {selectedTransitionContext.next ? (
                              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70">
                                下一镜头：{String(selectedTransitionContext.next.name || selectedTransitionContext.next.clipId || '未命名片段')}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-4 space-y-4">
                        {([
                          ['dissolve', 'Dissolve'],
                          ['motion', 'Motion'],
                          ['mask', 'Mask'],
                        ] as const).map(([groupId, groupLabel]) => (
                          <div key={groupId}>
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/35">{groupLabel}</div>
                              <div className="text-[11px] text-white/35">
                                {transitionPresetsByGroup[groupId].length} 种
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              {transitionPresetsByGroup[groupId].map((preset) => {
                                const active = (selectedTimelineClip?.transitionStyle?.presetId || 'none') === preset.id;
                                return (
                                  <button
                                    key={preset.id}
                                    type="button"
                                    disabled={!selectedClipSupportsTransition}
                                    onClick={() => {
                                      if (!selectedTimelineClip?.clipId) return;
                                      void updateClipTransitionStyle(String(selectedTimelineClip.clipId), {
                                        presetId: preset.id,
                                        kind: preset.kind,
                                        direction: preset.direction,
                                        durationMs: preset.durationMs,
                                      });
                                    }}
                                    className={clsx(
                                      'rounded-2xl border px-3 py-3 text-left transition',
                                      !selectedClipSupportsTransition
                                        ? 'cursor-not-allowed border-white/10 bg-black/10 text-white/30'
                                        : active
                                          ? 'border-cyan-300/45 bg-cyan-400/12 text-cyan-100'
                                          : 'border-white/10 bg-black/15 text-white/75 hover:border-white/20'
                                    )}
                                  >
                                    <div
                                      className="h-16 rounded-xl border border-white/10"
                                      style={{ background: preset.preview }}
                                    />
                                    <div className="mt-3 flex items-start justify-between gap-2">
                                      <div className="text-sm font-medium">{preset.label}</div>
                                      <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: preset.accent }} />
                                    </div>
                                    <div className="mt-1 text-[10px] text-white/45">{preset.description}</div>
                                    <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-white/40">
                                      {preset.kind}{preset.direction ? ` · ${preset.direction.replace('from-', '')}` : ''} · {preset.durationMs}ms
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>

                      {selectedClipSupportsTransition ? (
                        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            <div className="text-[11px] text-white/45">当前转场</div>
                            <div className="mt-1 text-sm text-white">{selectedTransitionPreset.label}</div>
                            <div className="mt-1 text-[11px] text-white/45">{selectedTransitionPreset.description}</div>
                          </div>
                          <label className="block">
                            <div className="mb-1 text-[11px] text-white/45">时长 (ms)</div>
                            <input
                              type="number"
                              min={0}
                              max={2000}
                              step={50}
                              value={Number(selectedTimelineClip?.transitionStyle?.durationMs ?? selectedTransitionPreset.durationMs)}
                              onChange={(event) => {
                                if (!selectedTimelineClip?.clipId) return;
                                void updateClipTransitionStyle(String(selectedTimelineClip.clipId), {
                                  durationMs: Number(event.target.value || 0),
                                });
                              }}
                              className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>
                    <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-5 text-sm text-white/55">
                      {selectedTimelineClip
                        ? selectedClipSupportsTransition
                          ? `当前片段：${String(selectedTimelineClip.name || selectedTimelineClip.clipId || '未命名片段')}。转场会同时在时间轴左缘、片段徽标和预览画布中可见。`
                          : '当前选中的不是视频或图片片段。转场只应用在视觉片段之间。'
                        : '先在时间轴里选中一个视频或图片片段，再应用转场。'}
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onOpenBindAssets}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.04] px-4 py-4 text-sm text-white/80 hover:border-cyan-400/40 hover:bg-white/[0.06]"
                    >
                      <Plus className="h-4 w-4" />
                      导入素材
                    </button>
                    <div className="mt-4 relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                      <input
                        value={materialSearch}
                        onChange={(event) => editorStore.setState((state) => ({
                          assets: {
                            ...state.assets,
                            materialSearch: event.target.value,
                          },
                        }))}
                        placeholder="搜索素材名或路径"
                        className="h-10 w-full rounded-2xl border border-white/10 bg-white/[0.04] pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-cyan-300/45 focus:bg-white/[0.06]"
                      />
                    </div>
                    <div className="mt-4 space-y-5">
                      {materialSections.map((section) => {
                        const SectionIcon = section.icon;
                        return (
                          <section key={section.id}>
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <SectionIcon className={clsx('h-4 w-4', section.accentClass)} />
                                <span className="text-xs font-medium uppercase tracking-[0.22em] text-white/45">{section.label}</span>
                              </div>
                              <span className="text-[11px] text-white/35">{section.assets.length}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2.5">
                              {section.assets.map(({ asset, kind }, index) => {
                                const assetUrl = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
                                const isDraggingThisAsset = materialDragPreview?.asset.id === asset.id;
                                const isActiveAsset = currentPreviewAsset?.id === asset.id;
                                const durationMs = assetDurationMs(asset);
                                return (
                                  <div
                                    key={asset.id || `${section.id}-${index}`}
                                    draggable
                                    onDragStart={(event) => {
                                      event.dataTransfer.setData('application/x-redbox-asset-id', asset.id);
                                      event.dataTransfer.setData('application/x-redbox-asset', JSON.stringify({
                                        assetId: asset.id,
                                        kind,
                                        title: asset.title || asset.id,
                                        previewUrl: asset.previewUrl || asset.absolutePath || asset.relativePath || '',
                                        durationMs,
                                      }));
                                      event.dataTransfer.effectAllowed = 'copyMove';
                                      event.dataTransfer.setDragImage(new Image(), 0, 0);
                                      setMaterialDragPreview({
                                        asset,
                                        x: event.clientX,
                                        y: event.clientY,
                                        overTimeline: false,
                                      });
                                    }}
                                    onDragEnd={() => setMaterialDragPreview(null)}
                                    className={clsx(
                                      'group rounded-[18px] border bg-white/[0.04] p-2 text-left transition',
                                      isActiveAsset ? 'border-cyan-400/55 ring-1 ring-cyan-400/35' : 'border-white/10 hover:border-white/20',
                                      isDraggingThisAsset && 'scale-[0.98] border-cyan-300/55 opacity-45'
                                    )}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        suspendPreviewTimeSync(220);
                                        editorStore.setState((state) => ({
                                          assets: {
                                            ...state.assets,
                                            currentPreviewAssetId: asset.id,
                                            selectedAssetId: asset.id,
                                          },
                                        }));
                                      }}
                                      className="relative block w-full overflow-hidden rounded-xl bg-black/30"
                                    >
                                      {kind === 'video' ? (
                                        <video src={assetUrl} className="h-24 w-full object-cover" muted playsInline />
                                      ) : kind === 'image' ? (
                                        <img src={assetUrl} alt={asset.title || asset.id} className="h-24 w-full object-cover" />
                                      ) : (
                                        <div className="flex h-24 w-full items-center justify-center bg-[linear-gradient(180deg,rgba(131,24,67,0.22),rgba(17,17,17,0.2))] text-white/60">
                                          <AudioLines className="h-8 w-8" />
                                        </div>
                                      )}
                                      <div className="absolute left-2 top-2 rounded-full border border-black/10 bg-black/60 px-2 py-1 text-[10px] text-white/80">
                                        {kind === 'video' ? '视频' : kind === 'image' ? '图片' : '音频'}
                                      </div>
                                      {durationMs ? (
                                        <div className="absolute bottom-2 right-2 rounded-full border border-black/10 bg-black/70 px-2 py-1 text-[10px] text-white/80">
                                          {Math.max(0.5, durationMs / 1000)}s
                                        </div>
                                      ) : null}
                                    </button>
                                    <div className="mt-2 flex items-center justify-between gap-2">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          suspendPreviewTimeSync(220);
                                          editorStore.setState((state) => ({
                                            assets: {
                                              ...state.assets,
                                              currentPreviewAssetId: asset.id,
                                              selectedAssetId: asset.id,
                                            },
                                          }));
                                        }}
                                        className="min-w-0 flex-1 text-left"
                                      >
                                        <div className="truncate text-xs font-medium text-white">{asset.title || asset.relativePath || asset.id}</div>
                                      </button>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void insertAssetAtPlayhead(asset);
                                          }}
                                          className="inline-flex h-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] px-2.5 text-[11px] font-medium text-white/80 transition hover:border-cyan-300/45 hover:bg-cyan-400/14 hover:text-cyan-100"
                                        >
                                          插入
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void appendAssetToTimeline(asset);
                                          }}
                                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/80 transition hover:border-cyan-300/45 hover:bg-cyan-400/14 hover:text-cyan-100"
                                        >
                                          <Plus className="h-3.5 w-3.5" />
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                      {visibleAssetCount === 0 ? (
                        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-6 text-center text-sm text-white/55">
                          {displayAssets.length === 0 ? '还没有关联素材。先导入视频、图片或关键帧。' : '没有匹配的素材，试试换个关键词或切换菜单。'}
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
          </VideoEditorSidebarShell>
          ) : null}

          {!materialsCollapsed ? (
          <div
            className="col-start-2 row-start-1 cursor-col-resize border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
            onPointerDown={(event) => {
              event.preventDefault();
              setDragState({
                target: 'materials',
                startX: event.clientX,
                startY: event.clientY,
                materialPaneWidth,
                timelineHeight,
              });
            }}
          />
          ) : null}

          <VideoEditorStageShell
            title={stageShellTitle}
            subtitle={stageShellSubtitle}
            compact={stageShellCompact}
            toolbar={(
                <>
                  {previewTab === 'motion' ? (
                    <button
                      type="button"
                      onClick={() => onGenerateRemotionScene(motionPrompt)}
                      disabled={isGeneratingRemotion || timelineClipCount <= 0 || !canRunAiExecution}
                      className={clsx(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                        isGeneratingRemotion || timelineClipCount <= 0 || !canRunAiExecution
                          ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                          : 'border-fuchsia-400/40 bg-fuchsia-400/14 text-fuchsia-100 hover:border-fuchsia-300/70'
                      )}
                      title={canRunAiExecution ? '基于已确认脚本生成动画' : '先确认脚本，再生成动画'}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {isGeneratingRemotion ? 'AI 生成中...' : 'AI 生成动画'}
                    </button>
                  ) : null}
                  {previewTab === 'preview' ? (
                    <button
                      type="button"
                      onClick={() => handleChangeRatioPreset(ratioPreset === '16:9' ? '9:16' : '16:9')}
                      className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/35 bg-cyan-400/12 px-3 py-1.5 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/18"
                      title="切换画面比例"
                    >
                      {ratioPreset}
                    </button>
                  ) : null}
                </>
            )}
          >
                {previewTab === 'preview' ? (
                  <TimelinePreviewComposition
                    currentFrame={currentFrame}
                    durationInFrames={effectiveDurationInFrames}
                    fps={effectiveFps}
                    currentTime={previewCurrentTime}
                    isPlaying={isPreviewPlaying}
                    stageWidth={projectWidth}
                    stageHeight={projectHeight}
                    ratioPreset={ratioPreset}
                    timelineClips={timelineClips}
                    trackOrder={timelineTrackOrder}
                    trackUi={timelineTrackUi}
                    assetsById={assetsById}
                    motionComposition={editableComposition}
                    selectedScene={selectedScene}
                    selectedSceneItemId={selectedSceneItemId}
                    selectedSceneItemIds={selectedSceneItemIds}
                    selectedSceneItemKind={selectedSceneItemKind}
                    guidesVisible={guidesVisible}
                    safeAreaVisible={safeAreaVisible}
                    itemTransforms={itemTransforms}
                    itemLocks={sceneItemLocks}
                    itemGroups={sceneItemGroups}
                    focusedGroupId={focusedGroupId}
                    itemVisibility={sceneItemVisibility}
                    itemOrder={sceneItemOrder}
                    onTogglePlayback={togglePreviewPlayback}
                    onSeekFrame={seekPreviewFrame}
                    onStepFrame={stepPreviewFrame}
                    onChangeRatioPreset={handleChangeRatioPreset}
                    onSelectSceneItem={selectSceneInspector}
                    onUpdateItemTransform={handleUpdateSceneItemTransform}
                    onDeleteSceneItem={handleDeleteSceneItem}
                    onDeleteSceneItems={handleDeleteSceneItems}
                    onAlignSceneItems={handleAlignSceneItems}
                    onDistributeSceneItems={handleDistributeSceneItems}
                    onSetSceneSelection={handleSetSceneSelection}
                    onDuplicateSceneItems={handleDuplicateSceneItems}
                  />
                ) : previewTab === 'motion' ? (
                  editableComposition?.scenes?.length ? (
                    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px]">
                      <div className="flex min-h-0 flex-col border-r border-white/10">
                        <div className="border-b border-white/10 px-4 py-3">
                          <RemotionTransportBar
                            fps={effectiveFps}
                            durationInFrames={effectiveDurationInFrames}
                            currentFrame={currentFrame}
                            playing={isPreviewPlaying}
                            onTogglePlayback={togglePreviewPlayback}
                            onSeekFrame={seekPreviewFrame}
                            onStepFrame={stepPreviewFrame}
                          />
                        </div>
                        <div className="min-h-0 flex-1">
                          <RemotionVideoPreview composition={editableComposition} playerRef={remotionPlayerRef} />
                        </div>
                      </div>
                      <div className="min-h-0 overflow-y-auto bg-[#121318] px-4 py-4">
                        <textarea
                          value={motionPrompt}
                          onChange={(event) => editorStore.setState((state) => ({
                            remotion: {
                              ...state.remotion,
                              motionPrompt: event.target.value,
                            },
                          }))}
                          placeholder="告诉 AI 你要的动画节奏、字幕风格、镜头运动和强调方式。"
                          className="h-24 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                        />
                        <div className="mt-4 space-y-3">
                          {editableComposition.scenes.map((scene, index) => (
                            <button
                              key={scene.id}
                              type="button"
                              onClick={() => editorStore.setState((state) => ({
                                scene: {
                                  ...state.scene,
                                  selectedSceneId: scene.id,
                                },
                                panels: {
                                  ...state.panels,
                                  leftPanel: 'selection',
                                },
                              }))}
                              className={clsx(
                                'block w-full rounded-2xl border px-3 py-3 text-left transition',
                                scene.id === selectedScene?.id ? 'border-fuchsia-400/45 bg-fuchsia-400/10' : 'border-white/10 bg-white/[0.03] hover:border-white/20'
                              )}
                            >
                              <div className="truncate text-sm font-medium text-white">{scene.overlayTitle || `场景 ${index + 1}`}</div>
                              <div className="mt-1 text-[11px] text-white/45">{scene.motionPreset || 'static'} · {scene.durationInFrames}f</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center px-8 text-center text-white/55">
                      <div>
                        <Wand2 className="mx-auto h-10 w-10 text-fuchsia-300/35" />
                        <div className="mt-3 text-sm">还没有动画方案</div>
                        <div className="mt-1 text-xs text-white/35">点击“AI 生成动画”，让 AI 基于当前脚本和时间线生成 Remotion 镜头运动、字幕和动画层。</div>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px]">
                    <textarea
                      value={editorBody}
                      onChange={(event) => onEditorBodyChange(event.target.value)}
                      placeholder="在这里写视频脚本、镜头安排、剪辑目标和导出要求。"
                      className="h-full w-full resize-none bg-transparent px-5 py-5 text-sm leading-7 text-white outline-none placeholder:text-white/30"
                    />
                    <div className="min-h-0 overflow-y-auto border-l border-white/10 bg-[#121318] px-4 py-4">
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/35">Script First</div>
                        <div className="mt-2 text-sm text-white/80">
                          先让 AI 改脚本文字并写回脚本区，用户读完并确认后，才能去做时间轴剪辑和 Remotion 动画。
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <div
                            className={clsx(
                              'inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium',
                              scriptConfirmed
                                ? 'border-emerald-400/25 bg-emerald-400/12 text-emerald-100'
                                : 'border-amber-300/25 bg-amber-400/12 text-amber-100'
                            )}
                          >
                            {scriptStatusLabel}
                          </div>
                          <button
                            type="button"
                            onClick={onConfirmScript}
                            disabled={scriptConfirmed || editorBodyDirty || isSavingEditorBody}
                            className={clsx(
                              'rounded-full border px-3 py-1 text-[11px] font-medium transition',
                              scriptConfirmed || editorBodyDirty || isSavingEditorBody
                                ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                                : 'border-emerald-400/35 bg-emerald-400/12 text-emerald-100 hover:border-emerald-300/60'
                            )}
                          >
                            {scriptConfirmed ? '脚本已确认' : editorBodyDirty || isSavingEditorBody ? '保存后确认脚本' : '确认脚本，解锁剪辑/动画'}
                          </button>
                        </div>
                        <div className="mt-4 space-y-2">
                          {scriptExecutionPrompts.beats.map((beat) => (
                            <div key={beat} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs leading-5 text-white/75">
                              {beat}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="mt-4 rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-white">执行面板</div>
                          <div className="inline-flex items-center rounded-full border border-cyan-300/25 bg-cyan-400/10 px-3 py-1 text-[11px] text-cyan-100/90">
                            AI 助手常驻
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">剪辑 Brief</div>
                            <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-white/72">{scriptExecutionPrompts.editPrompt}</div>
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard?.writeText(scriptExecutionPrompts.editPrompt);
                                }}
                                className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/75 transition hover:border-white/20 hover:text-white"
                              >
                                复制
                              </button>
                            </div>
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">动画 Brief</div>
                            <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-white/72">{scriptExecutionPrompts.motionExecutionPrompt}</div>
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                onClick={() => editorStore.setState((state) => ({
                                  remotion: {
                                    ...state.remotion,
                                    motionPrompt: scriptExecutionPrompts.motionExecutionPrompt,
                                  },
                                }))}
                                className="rounded-full border border-fuchsia-300/35 bg-fuchsia-400/12 px-3 py-1 text-[11px] text-fuchsia-100 transition hover:border-fuchsia-300/60"
                              >
                                同步到动画提示
                              </button>
                              <button
                                type="button"
                                onClick={() => onGenerateRemotionScene(scriptExecutionPrompts.motionExecutionPrompt)}
                                disabled={!canRunAiExecution}
                                className={clsx(
                                  'rounded-full border px-3 py-1 text-[11px] transition',
                                  canRunAiExecution
                                    ? 'border-white/10 bg-white/[0.05] text-white/75 hover:border-white/20 hover:text-white'
                                    : 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                                )}
                              >
                                直接生成动画
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
          </VideoEditorStageShell>

          <div
            className="col-start-4 row-start-1 row-span-3 border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
          />

          <div
            className="col-start-5 row-start-1 row-end-4 min-h-0 border-l border-white/10 bg-[#131417] shadow-[-24px_0_60px_rgba(0,0,0,0.4)]"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <MessageSquare className="h-4 w-4 text-cyan-400" />
                视频剪辑助手
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-white/55">始终显示</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {editorChatSessionId ? (
                <Suspense fallback={<div className="flex h-full items-center justify-center text-white/45">AI 会话加载中...</div>}>
                  <ChatWorkspace
                    fixedSessionId={editorChatSessionId}
                    defaultCollapsed={true}
                    showClearButton={true}
                    fixedSessionBannerText=""
                    showWelcomeShortcuts={false}
                    showComposerShortcuts={true}
                    shortcuts={videoEditingShortcuts}
                    welcomeShortcuts={videoEditingShortcuts}
                    welcomeTitle="视频剪辑助手"
                    welcomeSubtitle="先改脚本并确认，再去剪辑时间轴和制作 Remotion 动画"
                    contentLayout="default"
                    contentWidthPreset="narrow"
                    allowFileUpload={true}
                    messageWorkflowPlacement="bottom"
                    messageWorkflowVariant="compact"
                    messageWorkflowEmphasis="default"
                  />
                </Suspense>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/45">正在初始化视频剪辑会话...</div>
              )}
            </div>
          </div>

          {!timelineCollapsed ? (
          <VideoEditorTimelineShell
            sectionClassName="col-start-1 col-end-4 row-start-3 min-h-0 overflow-hidden rounded-[20px] bg-[#121315] shadow-[0_12px_32px_rgba(0,0,0,0.22)]"
            onResizeStart={(event) => {
              event.preventDefault();
              setDragState({
                target: 'timeline',
                startX: event.clientX,
                startY: event.clientY,
                materialPaneWidth,
                timelineHeight,
              });
            }}
          >
            <VendoredFreecutTimeline
              filePath={editorFile}
              packageState={packageState as PackageStateLike}
              fallbackTracks={effectiveTimelineTrackNames}
              onPackageStateChange={onPackageStateChange}
              controlledCursorTime={previewCurrentTime}
              controlledSelectedClipId={selectedClipId}
              controlledActiveTrackId={activeTrackId}
              onCursorTimeChange={handleTimelineCursorChange}
              fps={effectiveFps}
              currentFrame={currentFrame}
              durationInFrames={effectiveDurationInFrames}
              isPlaying={isPreviewPlaying}
              onTogglePlayback={togglePreviewPlayback}
              onSeekFrame={seekPreviewFrame}
              onSelectedClipChange={handleTimelineSelectedClipChange}
              onActiveTrackChange={handleTimelineActiveTrackChange}
              onViewportMetricsChange={handleTimelineViewportChange}
              controlledViewport={timelineViewport}
              controlledZoomPercent={timelineZoomPercent}
              onZoomPercentChange={handleTimelineZoomChange}
              controlledTrackUi={timelineTrackUi}
              onTrackUiChange={handleTimelineTrackUiChange}
              onHistoryAvailabilityChange={handleRuntimeHistoryAvailabilityChange}
            />
          </VideoEditorTimelineShell>
          ) : null}
        </div>

      </div>

      {layerContextMenu ? createPortal(
        <div
          className="fixed z-[140] min-w-[180px] overflow-hidden rounded-2xl border border-white/10 bg-[#17181c] p-1 shadow-[0_24px_60px_rgba(0,0,0,0.45)]"
          style={{
            left: `${layerContextMenu.x}px`,
            top: `${layerContextMenu.y}px`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {layerContextMenu.kind === 'item' && layerContextMenu.itemId ? (
            <>
              <button
                type="button"
                onClick={() => {
                  handleSetSceneSelection([layerContextMenu.itemId!], layerContextMenu.itemId!);
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                选中图层
              </button>
              <button
                type="button"
                onClick={() => {
                  handleToggleSceneItemVisibility(layerContextMenu.itemId!);
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                切换显隐
              </button>
              <button
                type="button"
                onClick={() => {
                  handleSetSceneItemLocks([layerContextMenu.itemId!], !sceneItemLocks[layerContextMenu.itemId!]);
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                {sceneItemLocks[layerContextMenu.itemId] ? '解锁图层' : '锁定图层'}
              </button>
              <button
                type="button"
                onClick={() => {
                  handleMoveSceneItemsToEdge([layerContextMenu.itemId!], 'front');
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                置前
              </button>
              <button
                type="button"
                onClick={() => {
                  handleMoveSceneItemsToEdge([layerContextMenu.itemId!], 'back');
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                置后
              </button>
              {sceneItemGroups[layerContextMenu.itemId] ? (
                <button
                  type="button"
                  onClick={() => {
                    handleAssignSceneItemsToGroup([layerContextMenu.itemId!], null);
                    setLayerContextMenu(null);
                  }}
                  className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
                >
                  移出分组
                </button>
              ) : null}
            </>
          ) : null}
          {layerContextMenu.kind === 'group' && layerContextMenu.groupId ? (
            <>
              <button
                type="button"
                onClick={() => {
                  handleEnterGroupEditing(layerContextMenu.groupId!);
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                进入组内编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = Object.entries(sceneItemGroups).filter(([, groupId]) => groupId === layerContextMenu.groupId).map(([id]) => id);
                  handleSetSceneSelection(ids, ids[0] || null);
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                选中整组
              </button>
              <button
                type="button"
                onClick={() => {
                  const groupItems = sceneHierarchyItems.groups.find((group) => group.id === layerContextMenu.groupId)?.items || [];
                  handleSetGroupVisibility(layerContextMenu.groupId!, groupItems.some((item) => item.visible === false));
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                切换整组显隐
              </button>
              <button
                type="button"
                onClick={() => {
                  const groupItems = sceneHierarchyItems.groups.find((group) => group.id === layerContextMenu.groupId)?.items || [];
                  handleSetGroupLocks(layerContextMenu.groupId!, groupItems.some((item) => !item.locked));
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                切换整组锁定
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = Object.entries(sceneItemGroups).filter(([, groupId]) => groupId === layerContextMenu.groupId).map(([id]) => id);
                  handleAssignSceneItemsToGroup(ids, null);
                  setLayerContextMenu(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.06] hover:text-white"
              >
                解组
              </button>
            </>
          ) : null}
        </div>,
        document.body
      ) : null}

      {materialDragPreview && !materialDragPreview.overTimeline ? createPortal(
        <div
          className="pointer-events-none fixed z-[160] -translate-x-1/2 -translate-y-1/2"
          style={{
            left: materialDragPreview.x,
            top: materialDragPreview.y,
          }}
        >
          <div className="w-28 overflow-hidden rounded-2xl border border-cyan-300/40 bg-[#111111]/92 shadow-[0_20px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            <div className="h-20 w-full bg-black/40">
              {inferAssetKind(materialDragPreview.asset) === 'video' ? (
                <video
                  src={resolveAssetUrl(materialDragPreview.asset.previewUrl || materialDragPreview.asset.absolutePath || materialDragPreview.asset.relativePath || '')}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                />
              ) : inferAssetKind(materialDragPreview.asset) === 'image' ? (
                <img
                  src={resolveAssetUrl(materialDragPreview.asset.previewUrl || materialDragPreview.asset.absolutePath || materialDragPreview.asset.relativePath || '')}
                  alt={materialDragPreview.asset.title || materialDragPreview.asset.id}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-white/60">
                  <AudioLines className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="space-y-1 px-3 py-2">
              <div className="truncate text-[11px] font-medium text-white">{materialDragPreview.asset.title || materialDragPreview.asset.id}</div>
              <div className="flex items-center justify-between text-[10px] text-white/55">
                <span>{inferAssetKind(materialDragPreview.asset) === 'image' ? '图片' : inferAssetKind(materialDragPreview.asset) === 'video' ? '视频' : '音频'}</span>
                <span>{assetDurationMs(materialDragPreview.asset) === IMAGE_CLIP_MS ? '0.5s' : '素材'}</span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}
    </>
  );
}
