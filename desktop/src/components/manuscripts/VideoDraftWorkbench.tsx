import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import type { PlayerRef } from '@remotion/player';
import {
  AudioLines,
  Clapperboard,
  Download,
  FolderOpen,
  Image as ImageIcon,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Redo2,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Type,
  GitBranchPlus,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { EditableTrackTimeline } from './EditableTrackTimeline';
import { TimelinePreviewComposition } from './TimelinePreviewComposition';
import { VideoEditorSidebarShell } from './VideoEditorSidebarShell';
import { VideoEditorStageShell } from './VideoEditorStageShell';
import { VideoEditorTimelineShell } from './VideoEditorTimelineShell';
import { resolveAssetUrl } from '../../utils/pathManager';
import { subscribeRuntimeEventStream } from '../../runtime/runtimeEventStream';
import { RemotionVideoPreview } from './remotion/RemotionVideoPreview';
import { RemotionTransportBar } from './remotion/RemotionTransportBar';
import { createVideoEditorStore, useVideoEditorStore } from '../../features/video-editor/store/useVideoEditorStore';
import type {
  SceneItemTransform,
  VideoEditorLeftPanel,
  VideoEditorRatioPreset,
  VideoEditorState,
} from '../../features/video-editor/store/useVideoEditorStore';
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

type PackageStateLike = Record<string, unknown>;

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

const VIDEO_EDITING_SHORTCUTS = [
  { label: '查看时间线', text: '请先查看当前视频工程的时间线片段，概括当前结构、轨道和明显问题。' },
  { label: '生成字幕', text: '请为当前视频工程规划字幕策略，并说明下一步如何生成和对齐字幕。' },
  { label: '粗剪 30 秒', text: '请基于当前视频工程，提出一个 30 秒内的粗剪方案，说明应该保留、删除和重排哪些片段。' },
  { label: '导出粗剪', text: '请检查当前视频工程是否具备导出条件；如果条件满足，直接导出当前粗剪版本。' },
];

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
};

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
  kind: 'asset' | 'title' | 'overlay',
  stageWidth: number,
  stageHeight: number
): SceneItemTransform {
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
  editorChatSessionId: string | null;
  remotionComposition?: RemotionCompositionConfig | null;
  remotionRenderPath?: string | null;
  isGeneratingRemotion?: boolean;
  isRenderingRemotion?: boolean;
  onEditorBodyChange: (value: string) => void;
  onOpenBindAssets: () => void;
  onPackageStateChange: (state: PackageStateLike) => void;
  onGenerateRemotionScene: (instructions?: string) => void;
  onSaveRemotionScene: (scene: RemotionCompositionConfig) => void;
  onRenderRemotionVideo: () => void;
  onOpenRenderedVideo?: () => void;
}

export function VideoDraftWorkbench({
  title,
  editorFile,
  packageState,
  packagePreviewAssets,
  primaryVideoAsset,
  timelineClipCount,
  timelineTrackNames,
  timelineClips,
  editorBody,
  editorBodyDirty,
  isSavingEditorBody,
  editorChatSessionId,
  remotionComposition,
  remotionRenderPath,
  isGeneratingRemotion = false,
  isRenderingRemotion = false,
  onEditorBodyChange,
  onOpenBindAssets,
  onPackageStateChange,
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
          },
          zoomPercent: 100,
          playheadSeconds: 0,
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
        },
        panels: {
          leftPanel: 'uploads',
          materialPaneWidth: 320,
          timelineHeight: 296,
          redclawDrawerOpen: false,
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
  const projectWidth = useVideoEditorStore(editorStore, (state) => state.project.width);
  const projectHeight = useVideoEditorStore(editorStore, (state) => state.project.height);
  const ratioPreset = useVideoEditorStore(editorStore, (state) => state.project.ratioPreset);
  const leftPanel = useVideoEditorStore(editorStore, (state) => state.panels.leftPanel);
  const materialPaneWidth = useVideoEditorStore(editorStore, (state) => state.panels.materialPaneWidth);
  const timelineHeight = useVideoEditorStore(editorStore, (state) => state.panels.timelineHeight);
  const redclawDrawerOpen = useVideoEditorStore(editorStore, (state) => state.panels.redclawDrawerOpen);
  const selectedSceneItemId = useVideoEditorStore(editorStore, (state) => state.selection.sceneItemId);
  const selectedSceneItemKind = useVideoEditorStore(editorStore, (state) => state.selection.sceneItemKind);
  const guidesVisible = useVideoEditorStore(editorStore, (state) => state.scene.guidesVisible);
  const safeAreaVisible = useVideoEditorStore(editorStore, (state) => state.scene.safeAreaVisible);
  const itemTransforms = useVideoEditorStore(editorStore, (state) => state.scene.itemTransforms);
  const activeSidebarTab = leftPanel;
  const effectiveFps = editableComposition?.fps || 30;
  const timelineDurationSeconds = useMemo(
    () => Math.max(0.1, computeTimelineDurationSeconds(timelineClips)),
    [timelineClips]
  );
  const timelineDurationInFrames = Math.max(1, Math.round(timelineDurationSeconds * effectiveFps));

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
    editorStore.setState((state) => {
      const nextComposition = remotionComposition || null;
      const nextSelectedSceneId = nextComposition?.scenes?.some((scene) => scene.id === state.scene.selectedSceneId)
        ? state.scene.selectedSceneId
        : nextComposition?.scenes?.[0]?.id || null;
      const inferredRatioPreset: VideoEditorRatioPreset = (nextComposition?.width || state.project.width) >= (nextComposition?.height || state.project.height) ? '16:9' : '9:16';
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
        scene: {
          ...state.scene,
          editableComposition: nextComposition,
          selectedSceneId: nextSelectedSceneId,
          itemTransforms: normalizeSceneItemTransforms(
            nextComposition?.sceneItemTransforms || state.scene.itemTransforms,
            nextComposition?.width || state.project.width,
            nextComposition?.height || state.project.height
          ),
        },
        script: {
          ...state.script,
          dirty: editorBodyDirty,
        },
      };
    });
  }, [editorBodyDirty, editorFile, editorStore, isRenderingRemotion, remotionComposition, remotionRenderPath, title]);

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
        const nextSelectedSceneId = String(runtimeState.selectedSceneId || '').trim() || null;
        const nextPreviewTab = String(runtimeState.previewTab || '').trim();
        const nextRatioPreset = String(runtimeState.canvasRatioPreset || '').trim();
        const nextPanel = String(runtimeState.activePanel || '').trim();
        const hasDrawerPanel = Object.prototype.hasOwnProperty.call(runtimeState, 'drawerPanel');
        const nextDrawerPanel = String(runtimeState.drawerPanel || '').trim();
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
              ratioPreset: nextRatioPreset === '16:9' || nextRatioPreset === '9:16'
                ? nextRatioPreset
                : state.project.ratioPreset,
            },
            timeline: {
              ...state.timeline,
              selectedClipId: nextSelectedClipId,
              viewport: {
                scrollLeft: Number(runtimeState.viewportScrollLeft || 0) || 0,
                maxScrollLeft: Number(runtimeState.viewportMaxScrollLeft || 0) || 0,
              },
              zoomPercent: Number(runtimeState.timelineZoomPercent || 100) || 100,
              playheadSeconds: Number.isFinite(nextPreviewTime) ? quantizePreviewTime(nextPreviewTime) : 0,
            },
            scene: {
              ...state.scene,
              selectedSceneId: nextSelectedSceneId,
              itemTransforms: nextSceneItemTransforms || state.scene.itemTransforms,
            },
            panels: {
              ...state.panels,
              leftPanel: nextPanel ? nextPanel as VideoEditorLeftPanel : state.panels.leftPanel,
              redclawDrawerOpen: hasDrawerPanel ? nextDrawerPanel === 'redclaw' : false,
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

  useEffect(() => {
    if (!editorFile) return;
    const timer = window.setTimeout(() => {
      void window.ipcRenderer.invoke('manuscripts:update-editor-runtime-state', {
        filePath: editorFile,
        sessionId: editorChatSessionId,
        playheadSeconds: previewCurrentTime,
        selectedClipId,
        selectedSceneId,
        previewTab,
        canvasRatioPreset: ratioPreset,
        activePanel: leftPanel,
        drawerPanel: redclawDrawerOpen ? 'redclaw' : null,
        sceneItemTransforms: itemTransforms,
        viewportScrollLeft: timelineViewport.scrollLeft,
        viewportMaxScrollLeft: timelineViewport.maxScrollLeft,
        timelineZoomPercent: editorStore.getState().timeline.zoomPercent,
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    editorChatSessionId,
    editorFile,
    previewCurrentTime,
    selectedClipId,
    selectedSceneId,
    previewTab,
    ratioPreset,
    leftPanel,
    redclawDrawerOpen,
    itemTransforms,
    timelineViewport.maxScrollLeft,
    timelineViewport.scrollLeft,
  ]);

  const currentPreviewAsset = useMemo(
    () => displayAssets.find((asset) => asset.id === currentPreviewAssetId) || primaryVideoAsset || displayAssets[0] || null,
    [currentPreviewAssetId, displayAssets, primaryVideoAsset]
  );
  const assetsById = useMemo(
    () => Object.fromEntries(displayAssets.map((asset) => [asset.id, asset])),
    [displayAssets]
  );

  const clipAtTime = useMemo(() => {
    return (timeInSeconds: number) => {
      const targetTime = Math.max(0, timeInSeconds);
      const containingClip = timelineClips.find((clip) => {
        const start = Number(clip.startSeconds || 0);
        const end = Number(clip.endSeconds || 0);
        return Number.isFinite(start) && Number.isFinite(end) && targetTime >= start && targetTime <= end;
      });
      return containingClip || null;
    };
  }, [timelineClips]);
  const activeTimelineClip = useMemo(
    () => clipAtTime(previewCurrentTime),
    [clipAtTime, previewCurrentTime]
  );
  const visibleTimelineClips = useMemo(
    () => timelineClips.filter((clip) => {
      const start = Number(clip.startSeconds || 0);
      const end = Number(clip.endSeconds || 0);
      return Number.isFinite(start) && Number.isFinite(end) && previewCurrentTime >= start && previewCurrentTime <= end;
    }),
    [previewCurrentTime, timelineClips]
  );
  const activeVisualTimelineClip = useMemo(
    () => visibleTimelineClips.find((clip) => {
      const kind = String(clip.assetKind || '').trim().toLowerCase();
      return kind === 'video' || kind === 'image';
    }) || null,
    [visibleTimelineClips]
  );
  const activeAudioTimelineClip = useMemo(
    () => visibleTimelineClips.find((clip) => String(clip.assetKind || '').trim().toLowerCase() === 'audio') || null,
    [visibleTimelineClips]
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
  const sidebarTabs = useMemo(
    () => [
      { id: 'uploads' as const, label: '素材', icon: Plus, count: totalSearchableAssetCount },
      { id: 'videos' as const, label: '视频', icon: Clapperboard, count: materialCountsByKind.video },
      { id: 'images' as const, label: '图片', icon: ImageIcon, count: materialCountsByKind.image },
      { id: 'audios' as const, label: '音频', icon: AudioLines, count: materialCountsByKind.audio },
      { id: 'texts' as const, label: '文本', icon: Type, count: 0 },
      { id: 'captions' as const, label: '字幕', icon: MessageSquare, count: editableComposition?.scenes?.length || 0 },
      { id: 'transitions' as const, label: '转场', icon: GitBranchPlus, count: 0 },
      { id: 'selection' as const, label: '编辑', icon: SlidersHorizontal, count: selectedTimelineClip ? 1 : 0 },
    ],
    [editableComposition?.scenes?.length, materialCountsByKind.audio, materialCountsByKind.image, materialCountsByKind.video, selectedTimelineClip, totalSearchableAssetCount]
  );
  useEffect(() => {
    const visibleClipIds = visibleTimelineClips
      .map((clip) => String(clip.clipId || '').trim())
      .filter(Boolean);
    const orderedClipIds = [...timelineClips]
      .sort((left, right) => Number(left.startSeconds || 0) - Number(right.startSeconds || 0))
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
  }, [activeAudioTimelineClip, activeTimelineClip, activeVisualTimelineClip, editorStore, previewCurrentTime, timelineClips, timelineDurationSeconds, visibleTimelineClips]);

  useEffect(() => {
    if (!editorChatSessionId) return;
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
              redclawDrawerOpen: hasDrawerPanel ? nextDrawerPanel === 'redclaw' : false,
            },
          }));
        }
      },
    });
  }, [editorChatSessionId, editorFile, editorStore, onPackageStateChange]);

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

  const selectSceneInspector = useCallback((kind: 'asset' | 'overlay' | 'title', id: string) => {
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        selectedClipId: kind === 'asset' ? id : state.timeline.selectedClipId,
      },
      selection: {
        ...state.selection,
        kind: 'scene-item',
        sceneItemId: id,
        sceneItemKind: kind,
      },
      panels: {
        ...state.panels,
        leftPanel: 'selection',
      },
    }));
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

  const handleDeleteSceneItem = useCallback(async (kind: 'asset' | 'overlay' | 'title', id: string) => {
    if (!id) return;

    if (kind === 'asset') {
      if (!editorFile) return;
      try {
        const result = await window.ipcRenderer.invoke('manuscripts:delete-package-clip', {
          filePath: editorFile,
          clipId: id,
        }) as { success?: boolean; state?: Record<string, unknown> };
        if (result?.success && result.state) {
          onPackageStateChange(result.state as PackageStateLike);
          editorStore.setState((state) => {
            const nextTransforms = { ...state.scene.itemTransforms };
            delete nextTransforms[id];
            return {
              timeline: {
                ...state.timeline,
                selectedClipId: null,
              },
              selection: {
                ...state.selection,
                kind: null,
                sceneItemId: null,
                sceneItemKind: null,
              },
              scene: {
                ...state.scene,
                itemTransforms: nextTransforms,
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
      delete nextTransforms[transformKey];
      return {
        selection: {
          ...state.selection,
          kind: null,
          sceneItemId: null,
          sceneItemKind: null,
        },
        scene: {
          ...state.scene,
          itemTransforms: nextTransforms,
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
    editorStore.setState((state) => ({
      timeline: {
        ...state.timeline,
        selectedClipId: clipId,
      },
      selection: {
        ...state.selection,
        kind: clipId ? 'scene-item' : null,
        sceneItemKind: clipId ? 'asset' : null,
        sceneItemId: clipId,
      },
      panels: {
        ...state.panels,
        leftPanel: clipId ? 'selection' : state.panels.leftPanel,
      },
    }));
  }, [editorStore]);

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

  const handleTimelineViewportChange = useCallback((metrics: { scrollLeft: number; maxScrollLeft: number }) => {
    const currentViewport = editorStore.getState().timeline.viewport;
    if (
      currentViewport.scrollLeft === metrics.scrollLeft
      && currentViewport.maxScrollLeft === metrics.maxScrollLeft
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

  const sidebarShellTitle = activeSidebarTab === 'selection' ? 'Inspector' : 'Resource Panel';
  const sidebarShellSubtitle = activeSidebarTab === 'selection'
    ? '当前选中对象属性'
    : `${visibleAssetCount} 个可用素材`;
  const sidebarTrackLabel = activeTrackId ? `轨道 ${activeTrackId}` : previewTab.toUpperCase();
  const sidebarNavTabs = useMemo(
    () => sidebarTabs.map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon })),
    [sidebarTabs]
  );
  const stageShellTitle = previewTab === 'motion' ? 'Motion Studio' : previewTab === 'script' ? 'Script Workspace' : 'Stage Preview';
  const stageShellSubtitle = previewTab === 'script'
    ? (isSavingEditorBody ? '脚本保存中...' : editorBodyDirty ? '脚本待保存' : '脚本已保存')
    : previewTab === 'motion'
      ? `${editableComposition?.scenes?.length || 0} 个动画场景`
      : `${timelineClipCount} 个片段 · ${previewStatusLabel}`;
  const stageShellCompact = previewTab === 'preview';
  const selectedSceneItemTransform = selectedSceneItemId ? itemTransforms[selectedSceneItemId] || null : null;
  const selectedSceneItemLabel = useMemo(() => {
    if (!selectedSceneItemId || !selectedSceneItemKind) return '';
    if (selectedSceneItemKind === 'asset') {
      return timelineClips.find((clip) => String(clip.clipId || '').trim() === selectedSceneItemId)?.name
        || selectedSceneItemId;
    }
    if (selectedSceneItemKind === 'title') return '标题层';
    if (selectedSceneItemKind === 'overlay') return '文案层';
    return selectedSceneItemId;
  }, [selectedSceneItemId, selectedSceneItemKind, timelineClips]);

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
  }, [activeAudioTimelineClip, activeTimelineClip, activeVisualTimelineClip, editorStore, itemTransforms, projectHeight, projectWidth, selectedScene]);

  useEffect(() => {
    if (selectedSceneItemKind !== 'asset') return;
    if (!selectedSceneItemId) return;
    const visibleIds = new Set(visibleTimelineClips.map((clip) => String(clip.clipId || '').trim()).filter(Boolean));
    if (visibleIds.has(selectedSceneItemId)) return;
    editorStore.setState((state) => ({
      selection: {
        ...state.selection,
        kind: null,
        sceneItemId: null,
        sceneItemKind: null,
      },
    }));
  }, [editorStore, selectedSceneItemId, selectedSceneItemKind, visibleTimelineClips]);

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#111113] text-white">
        <div className="border-b border-white/10 bg-[#141417] px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.24em] text-cyan-200/65">LexBox Editor</div>
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
              <button type="button" disabled className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/35">
                <Undo2 className="h-4 w-4" />
              </button>
              <button type="button" disabled className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/35">
                <Redo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onRenderRemotionVideo}
                disabled={isRenderingRemotion || !editableComposition?.scenes?.length}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                  isRenderingRemotion || !editableComposition?.scenes?.length
                    ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                    : 'border-cyan-400/40 bg-cyan-400/14 text-cyan-100 hover:border-cyan-300/70'
                )}
              >
                <Download className="h-3.5 w-3.5" />
                {isRenderingRemotion ? '导出中...' : '导出 MP4'}
              </button>
              <button
                type="button"
                onClick={() => editorStore.setState((state) => ({
                  panels: {
                    ...state.panels,
                    redclawDrawerOpen: !state.panels.redclawDrawerOpen,
                  },
                }))}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white/75 transition hover:border-white/20 hover:text-white"
              >
                {redclawDrawerOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                AI 对话
              </button>
            </div>
          </div>
        </div>

        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: `${materialPaneWidth}px 8px minmax(0,1fr) ${redclawDrawerOpen ? '8px' : '0px'} ${redclawDrawerOpen ? `${RIGHT_PANEL_WIDTH}px` : '0px'}`,
            gridTemplateRows: `minmax(0,1fr) 8px ${timelineHeight}px`,
          }}
        >
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
                    {selectedSceneItemTransform ? (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-sm font-medium text-white">{selectedSceneItemLabel || '舞台对象'}</div>
                        <div className="mt-1 text-[11px] text-white/45">
                          {selectedSceneItemKind === 'asset' ? '素材层' : selectedSceneItemKind === 'title' ? '标题层' : '文案层'}
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
                    ) : (
                      <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/55">
                        当前还没有选中对象。点击时间轴片段或舞台中的可视层后，这里会切换为 inspector。
                      </div>
                    )}
                  </div>
                ) : activeSidebarTab === 'texts' || activeSidebarTab === 'captions' || activeSidebarTab === 'transitions' ? (
                  <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/55">
                    该面板已预留在新版壳层中，当前版本优先完成素材、舞台、时间轴与 inspector 主流程。
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
                      disabled={isGeneratingRemotion || timelineClipCount <= 0}
                      className={clsx(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                        isGeneratingRemotion || timelineClipCount <= 0
                          ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                          : 'border-fuchsia-400/40 bg-fuchsia-400/14 text-fuchsia-100 hover:border-fuchsia-300/70'
                      )}
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
                    assetsById={assetsById}
                    selectedScene={selectedScene}
                    selectedSceneItemId={selectedSceneItemId}
                    selectedSceneItemKind={selectedSceneItemKind}
                    guidesVisible={guidesVisible}
                    safeAreaVisible={safeAreaVisible}
                    itemTransforms={itemTransforms}
                    onTogglePlayback={togglePreviewPlayback}
                    onSeekFrame={seekPreviewFrame}
                    onStepFrame={stepPreviewFrame}
                    onChangeRatioPreset={handleChangeRatioPreset}
                    onSelectSceneItem={selectSceneInspector}
                    onUpdateItemTransform={handleUpdateSceneItemTransform}
                    onDeleteSceneItem={handleDeleteSceneItem}
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
                  <textarea
                    value={editorBody}
                    onChange={(event) => onEditorBodyChange(event.target.value)}
                    placeholder="在这里写视频脚本、镜头安排、剪辑目标和导出要求。"
                    className="h-full w-full resize-none bg-transparent px-5 py-5 text-sm leading-7 text-white outline-none placeholder:text-white/30"
                  />
                )}
          </VideoEditorStageShell>

          <div
            className="col-start-4 row-start-1 row-span-3 border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
            hidden={!redclawDrawerOpen}
          />

          <div
            className="col-start-5 row-start-1 row-end-4 min-h-0 border-l border-white/10 bg-[#131417] shadow-[-24px_0_60px_rgba(0,0,0,0.4)]"
            hidden={!redclawDrawerOpen}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <MessageSquare className="h-4 w-4 text-cyan-400" />
                视频剪辑助手
              </div>
              <button
                type="button"
                onClick={() => editorStore.setState((state) => ({
                  panels: {
                    ...state.panels,
                    redclawDrawerOpen: false,
                  },
                }))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/70 transition hover:border-white/20 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
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
                    shortcuts={VIDEO_EDITING_SHORTCUTS}
                    welcomeShortcuts={VIDEO_EDITING_SHORTCUTS}
                    welcomeTitle="视频剪辑助手"
                    welcomeSubtitle="围绕当前视频工程做粗剪、调序、trim、字幕、Remotion 动画和导出建议"
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

          <VideoEditorTimelineShell
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
            <EditableTrackTimeline
              filePath={editorFile}
              clips={timelineClips as Array<Record<string, unknown>>}
              fallbackTracks={timelineTrackNames}
              accent="cyan"
              emptyLabel="把视频、图片或关键帧拖入时间轴开始排布"
              onPackageStateChange={onPackageStateChange}
              controlledCursorTime={previewCurrentTime}
              controlledSelectedClipId={selectedClipId}
              onCursorTimeChange={handleTimelineCursorChange}
              fps={effectiveFps}
              currentFrame={currentFrame}
              durationInFrames={effectiveDurationInFrames}
              isPlaying={isPreviewPlaying}
              onTogglePlayback={togglePreviewPlayback}
              onStepFrame={stepPreviewFrame}
              onSeekFrame={seekPreviewFrame}
              onSelectedClipChange={handleTimelineSelectedClipChange}
              onActiveTrackChange={handleTimelineActiveTrackChange}
              onViewportMetricsChange={handleTimelineViewportChange}
            />
          </VideoEditorTimelineShell>
        </div>

      </div>

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
