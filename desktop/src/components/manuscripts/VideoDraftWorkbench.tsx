import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Clapperboard,
  Download,
  FolderOpen,
  MessageSquare,
  Plus,
  Save,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { EditableTrackTimeline } from './EditableTrackTimeline';
import { resolveAssetUrl } from '../../utils/pathManager';
import { RemotionVideoPreview } from './remotion/RemotionVideoPreview';
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
  previewUrl?: string;
};

type PackageStateLike = Record<string, unknown>;

type VideoClipLike = {
  clipId?: string;
  assetId?: string;
  name?: string;
  order?: number;
  track?: string;
  durationMs?: number;
  enabled?: boolean;
};

type PreviewTab = 'preview' | 'motion' | 'script';
type DragTarget = 'materials' | 'chat' | 'timeline';

type DragState = {
  target: DragTarget;
  startX: number;
  startY: number;
  materialPaneWidth: number;
  chatPaneWidth: number;
  timelineHeight: number;
};

const VIDEO_EDITING_SHORTCUTS = [
  { label: '查看时间线', text: '请先查看当前视频工程的时间线片段，概括当前结构、轨道和明显问题。' },
  { label: '生成字幕', text: '请为当前视频工程规划字幕策略，并说明下一步如何生成和对齐字幕。' },
  { label: '粗剪 30 秒', text: '请基于当前视频工程，提出一个 30 秒内的粗剪方案，说明应该保留、删除和重排哪些片段。' },
  { label: '导出粗剪', text: '请检查当前视频工程是否具备导出条件；如果条件满足，直接导出当前粗剪版本。' },
];

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

function inferAssetKind(asset: MediaAssetLike): 'image' | 'video' | 'audio' | 'unknown' {
  const source = String(asset.previewUrl || asset.relativePath || '').toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/.test(source)) return 'image';
  if (/\.(mp4|mov|webm|m4v|mkv|avi)(\?|$)/.test(source)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)(\?|$)/.test(source)) return 'audio';
  return 'unknown';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
  const [previewTab, setPreviewTab] = useState<PreviewTab>('preview');
  const [materialPaneWidth, setMaterialPaneWidth] = useState(300);
  const [chatPaneWidth, setChatPaneWidth] = useState(380);
  const [timelineHeight, setTimelineHeight] = useState(280);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [currentPreviewAssetId, setCurrentPreviewAssetId] = useState<string | null>(primaryVideoAsset?.id || null);
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0);
  const [motionPrompt, setMotionPrompt] = useState(createDefaultMotionPrompt());
  const [editableComposition, setEditableComposition] = useState<RemotionCompositionConfig | null>(remotionComposition || null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(remotionComposition?.scenes?.[0]?.id || null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const displayAssets = useMemo(
    () => (packagePreviewAssets.length > 0 ? packagePreviewAssets : ([primaryVideoAsset].filter(Boolean) as MediaAssetLike[])),
    [packagePreviewAssets, primaryVideoAsset]
  );

  useEffect(() => {
    if (!displayAssets.length) {
      setCurrentPreviewAssetId(null);
      return;
    }
    if (currentPreviewAssetId && displayAssets.some((asset) => asset.id === currentPreviewAssetId)) {
      return;
    }
    setCurrentPreviewAssetId(
      primaryVideoAsset && displayAssets.some((asset) => asset.id === primaryVideoAsset.id)
        ? primaryVideoAsset.id
        : displayAssets[0]?.id || null
    );
  }, [currentPreviewAssetId, displayAssets, primaryVideoAsset]);

  useEffect(() => {
    setEditableComposition(remotionComposition || null);
    setSelectedSceneId(remotionComposition?.scenes?.[0]?.id || null);
  }, [remotionComposition]);

  const currentPreviewAsset = useMemo(
    () => displayAssets.find((asset) => asset.id === currentPreviewAssetId) || primaryVideoAsset || displayAssets[0] || null,
    [currentPreviewAssetId, displayAssets, primaryVideoAsset]
  );

  const clipAssetMap = useMemo(() => {
    const map = new Map<string, string>();
    timelineClips.forEach((clip) => {
      const clipId = String(clip.clipId || '').trim();
      const assetId = String(clip.assetId || '').trim();
      if (clipId && assetId) {
        map.set(clipId, assetId);
      }
    });
    return map;
  }, [timelineClips]);

  const selectedScene = useMemo(() => {
    if (!editableComposition?.scenes?.length) return null;
    return editableComposition.scenes.find((scene) => scene.id === selectedSceneId) || editableComposition.scenes[0] || null;
  }, [editableComposition, selectedSceneId]);

  useEffect(() => {
    if (!dragState) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (dragState.target === 'materials') {
        const deltaX = event.clientX - dragState.startX;
        setMaterialPaneWidth(clamp(dragState.materialPaneWidth + deltaX, 240, 420));
        return;
      }
      if (dragState.target === 'chat') {
        const deltaX = dragState.startX - event.clientX;
        setChatPaneWidth(clamp(dragState.chatPaneWidth + deltaX, 300, 560));
        return;
      }
      const deltaY = dragState.startY - event.clientY;
      setTimelineHeight(clamp(dragState.timelineHeight + deltaY, 220, 460));
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
    const video = previewVideoRef.current;
    if (!video || previewTab !== 'preview') return;
    if (Math.abs(video.currentTime - previewCurrentTime) < 0.08) return;
    video.currentTime = previewCurrentTime;
  }, [previewCurrentTime, previewTab, currentPreviewAssetId]);

  const updateScene = (sceneId: string, updater: (scene: RemotionScene) => RemotionScene) => {
    setEditableComposition((current) => {
      if (!current) return current;
      return {
        ...current,
        durationInFrames: current.scenes.reduce((sum, scene) => sum + (scene.id === sceneId ? updater(scene).durationInFrames : scene.durationInFrames), 0),
        scenes: current.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene)),
      };
    });
  };

  const saveEditedComposition = () => {
    if (!editableComposition) return;
    let currentFrame = 0;
    const normalized: RemotionCompositionConfig = {
      ...editableComposition,
      scenes: editableComposition.scenes.map((scene) => {
        const nextScene = {
          ...scene,
          startFrame: currentFrame,
          durationInFrames: Math.max(12, Number(scene.durationInFrames || 0)),
        };
        currentFrame += nextScene.durationInFrames;
        return nextScene;
      }),
      durationInFrames: currentFrame,
    };
    setEditableComposition(normalized);
    onSaveRemotionScene(normalized);
  };

  return (
    <div
      className="flex-1 min-h-0 grid bg-[#171717] text-white"
      style={{
        gridTemplateColumns: `minmax(0,1fr) 8px ${chatPaneWidth}px`,
        gridTemplateRows: `minmax(0,1fr) 8px ${timelineHeight}px`,
      }}
    >
      <div
        className="min-h-0 grid"
        style={{
          gridTemplateColumns: `${materialPaneWidth}px 8px minmax(0,1fr)`,
        }}
      >
        <div className="min-h-0 border-r border-b border-white/10 bg-[#1f1f1f]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-white/10 px-4 py-3">
              <div className="text-sm font-medium text-cyan-300">素材</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <button
                type="button"
                onClick={onOpenBindAssets}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.04] px-4 py-4 text-sm text-white/80 hover:border-cyan-400/40 hover:bg-white/[0.06]"
              >
                <Plus className="h-4 w-4" />
                导入素材
              </button>
              <div className="mt-4 text-xs font-medium uppercase tracking-[0.22em] text-white/35">素材</div>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                {displayAssets.map((asset, index) => {
                  const kind = inferAssetKind(asset);
                  return (
                    <button
                      key={asset.id || index}
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('application/x-redbox-asset-id', asset.id);
                        event.dataTransfer.effectAllowed = 'copyMove';
                      }}
                      onClick={() => setCurrentPreviewAssetId(asset.id)}
                      className={clsx(
                        'rounded-2xl border bg-white/[0.04] p-2 text-left transition',
                        currentPreviewAsset?.id === asset.id ? 'border-cyan-400/55 ring-1 ring-cyan-400/35' : 'border-white/10 hover:border-white/20'
                      )}
                    >
                      <div className="overflow-hidden rounded-xl bg-black/30">
                        {kind === 'video' ? (
                          <video src={resolveAssetUrl(asset.previewUrl || asset.relativePath || '')} className="h-20 w-full object-cover" muted playsInline />
                        ) : (
                          <img src={resolveAssetUrl(asset.previewUrl || asset.relativePath || '')} alt={asset.title || asset.id} className="h-20 w-full object-cover" />
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-white">{asset.title || asset.relativePath || asset.id}</div>
                          <div className="mt-0.5 text-[11px] text-white/45">{kind === 'video' ? '视频' : kind === 'image' ? '图片/关键帧' : '素材'}</div>
                        </div>
                        <div className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/55">
                          {asset.id === currentPreviewAsset?.id ? '预览' : '拖入'}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {displayAssets.length === 0 && (
                  <div className="col-span-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-5 text-sm text-white/55">
                    还没有关联素材。先导入视频、图片或关键帧。
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className="cursor-col-resize border-b border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
          onPointerDown={(event) => {
            event.preventDefault();
            setDragState({
              target: 'materials',
              startX: event.clientX,
              startY: event.clientY,
              materialPaneWidth,
              chatPaneWidth,
              timelineHeight,
            });
          }}
        />

        <div className="min-h-0 border-r border-b border-white/10 bg-[#111111]">
          <div className="flex h-full min-h-0 flex-col px-5 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-5 text-sm">
                <button
                  type="button"
                  onClick={() => setPreviewTab('preview')}
                  className={previewTab === 'preview' ? 'font-medium text-white' : 'font-medium text-white/45'}
                >
                  预览
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewTab('motion')}
                  className={previewTab === 'motion' ? 'font-medium text-fuchsia-200' : 'font-medium text-white/45'}
                >
                  Remotion
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewTab('script')}
                  className={previewTab === 'script' ? 'font-medium text-white' : 'font-medium text-white/45'}
                >
                  脚本
                </button>
              </div>
              <div className="text-xs text-white/45">
                {previewTab === 'script'
                  ? (isSavingEditorBody ? '保存中...' : editorBodyDirty ? '待保存' : '已保存')
                  : previewTab === 'motion'
                    ? `${editableComposition?.scenes?.length || 0} 个动画场景`
                    : `${timelineClipCount} 个片段`}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
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
              <button
                type="button"
                onClick={saveEditedComposition}
                disabled={!editableComposition?.scenes?.length}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                  !editableComposition?.scenes?.length
                    ? 'cursor-not-allowed border-white/10 bg-white/[0.03] text-white/35'
                    : 'border-emerald-400/40 bg-emerald-400/14 text-emerald-100 hover:border-emerald-300/70'
                )}
              >
                <Save className="h-3.5 w-3.5" />
                保存动画稿
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
              {remotionRenderPath && onOpenRenderedVideo ? (
                <button
                  type="button"
                  onClick={onOpenRenderedVideo}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white/80 transition hover:border-white/20"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  打开导出
                </button>
              ) : null}
              {remotionRenderPath ? (
                <span className="ml-auto truncate text-xs text-cyan-200/80">
                  最新导出: {remotionRenderPath}
                </span>
              ) : null}
            </div>

            <div className="mt-4 flex-1 overflow-hidden rounded-[24px] border border-white/10 bg-[#1b1b1b]">
              {previewTab === 'preview' ? (
                currentPreviewAsset ? (
                  inferAssetKind(currentPreviewAsset) === 'video' ? (
                    <video
                      ref={previewVideoRef}
                      src={resolveAssetUrl(currentPreviewAsset.previewUrl || currentPreviewAsset.relativePath || '')}
                      className="h-full w-full object-contain"
                      controls
                      playsInline
                      onTimeUpdate={(event) => {
                        setPreviewCurrentTime(event.currentTarget.currentTime);
                      }}
                    />
                  ) : (
                    <img
                      src={resolveAssetUrl(currentPreviewAsset.previewUrl || currentPreviewAsset.relativePath || '')}
                      alt={currentPreviewAsset.title || title}
                      className="h-full w-full object-contain"
                    />
                  )
                ) : (
                  <div className="flex h-full items-center justify-center text-center text-white/55">
                    <div>
                      <Clapperboard className="mx-auto h-10 w-10 text-white/35" />
                      <div className="mt-3 text-sm">还没有可预览的视频素材</div>
                      <div className="mt-1 text-xs text-white/35">先在左侧导入或关联视频、图片或关键帧</div>
                    </div>
                  </div>
                )
              ) : previewTab === 'motion' ? (
                editableComposition?.scenes?.length ? (
                  <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px]">
                    <div className="flex min-h-0 flex-col border-r border-white/10">
                      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3 text-xs text-white/55">
                        <span>{editableComposition.width}×{editableComposition.height}</span>
                        <span>{editableComposition.fps} FPS</span>
                        <span>{editableComposition.durationInFrames} 帧</span>
                        <span>{(packageState as any)?.remotion?.title || title}</span>
                      </div>
                      <div className="min-h-0 flex-1">
                        <RemotionVideoPreview composition={editableComposition} />
                      </div>
                    </div>
                    <div className="min-h-0 overflow-y-auto bg-[#121318] px-4 py-4">
                      <div className="text-xs font-medium uppercase tracking-[0.22em] text-white/35">动画导演提示</div>
                      <textarea
                        value={motionPrompt}
                        onChange={(event) => setMotionPrompt(event.target.value)}
                        placeholder="告诉 AI 你要的动画节奏、字幕风格、镜头运动和强调方式。"
                        className="mt-3 h-24 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                      />
                      <div className="mt-4 text-xs font-medium uppercase tracking-[0.22em] text-white/35">场景</div>
                      <div className="mt-3 space-y-3">
                        {editableComposition.scenes.map((scene, index) => {
                          const isSelected = scene.id === selectedScene?.id;
                          return (
                            <button
                              key={scene.id}
                              type="button"
                              onClick={() => setSelectedSceneId(scene.id)}
                              className={clsx(
                                'block w-full rounded-2xl border px-3 py-3 text-left transition',
                                isSelected ? 'border-fuchsia-400/45 bg-fuchsia-400/10' : 'border-white/10 bg-white/[0.03] hover:border-white/20'
                              )}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-white">
                                    {scene.overlayTitle || `场景 ${index + 1}`}
                                  </div>
                                  <div className="mt-1 text-[11px] text-white/45">
                                    {scene.motionPreset || 'static'} · {scene.durationInFrames}f
                                  </div>
                                </div>
                                <div className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/55">
                                  {scene.assetKind || 'scene'}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {selectedScene ? (
                        <div className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                          <div className="text-xs font-medium uppercase tracking-[0.22em] text-white/35">当前场景</div>
                          <div className="mt-3 space-y-3">
                            <div>
                              <div className="mb-1 text-[11px] text-white/45">标题</div>
                              <input
                                value={selectedScene.overlayTitle || ''}
                                onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, overlayTitle: event.target.value }))}
                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              />
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] text-white/45">屏幕文案</div>
                              <textarea
                                value={selectedScene.overlayBody || ''}
                                onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, overlayBody: event.target.value }))}
                                className="h-20 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">镜头运动</div>
                                <select
                                  value={selectedScene.motionPreset || 'static'}
                                  onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, motionPreset: event.target.value as MotionPreset }))}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                >
                                  {MOTION_PRESETS.map((preset) => (
                                    <option key={preset.value} value={preset.value}>{preset.label}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="block">
                                <div className="mb-1 text-[11px] text-white/45">时长 (帧)</div>
                                <input
                                  type="number"
                                  min={12}
                                  step={1}
                                  value={selectedScene.durationInFrames}
                                  onChange={(event) => updateScene(selectedScene.id, (scene) => ({ ...scene, durationInFrames: Math.max(12, Number(event.target.value || 0)) }))}
                                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                                />
                              </label>
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] text-white/45">字幕入场动画</div>
                              <select
                                value={buildEditableOverlay(selectedScene).animation || 'fade-up'}
                                onChange={(event) =>
                                  updateScene(selectedScene.id, (scene) => ({
                                    ...scene,
                                    overlays: [
                                      {
                                        ...buildEditableOverlay(scene),
                                        animation: event.target.value as OverlayAnimation,
                                      },
                                    ],
                                  }))
                                }
                                className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                              >
                                {OVERLAY_ANIMATIONS.map((preset) => (
                                  <option key={preset.value} value={preset.value}>{preset.label}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center px-8 text-center text-white/55">
                    <div>
                      <Wand2 className="mx-auto h-10 w-10 text-fuchsia-300/35" />
                      <div className="mt-3 text-sm">还没有动画方案</div>
                      <div className="mt-1 text-xs text-white/35">
                        点击“AI 生成动画”，让 AI 基于当前脚本和时间线，为视频生成 Remotion 镜头运动、字幕和动画层。
                      </div>
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
            </div>
          </div>
        </div>
      </div>

      <div
        className="row-span-3 cursor-col-resize bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragState({
            target: 'chat',
            startX: event.clientX,
            startY: event.clientY,
            materialPaneWidth,
            chatPaneWidth,
            timelineHeight,
          });
        }}
      />

      <div className="row-span-3 min-h-0 border-l border-white/10 bg-[#131313] text-white">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <MessageSquare className="h-4 w-4 text-cyan-400" />
              视频剪辑助手
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {editorChatSessionId ? (
              <Suspense fallback={<div className="h-full flex items-center justify-center text-white/45">AI 会话加载中...</div>}>
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
              <div className="h-full flex items-center justify-center px-6 text-center text-sm text-white/45">正在初始化视频剪辑会话...</div>
            )}
          </div>
        </div>
      </div>

      <div
        className="col-span-1 border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragState({
            target: 'timeline',
            startX: event.clientX,
            startY: event.clientY,
            materialPaneWidth,
            chatPaneWidth,
            timelineHeight,
          });
        }}
      />

      <div className="min-h-0 border-r border-white/10 bg-[#151515] px-5 py-4">
        <EditableTrackTimeline
          filePath={editorFile}
          clips={timelineClips as Array<Record<string, unknown>>}
          fallbackTracks={timelineTrackNames}
          accent="cyan"
          emptyLabel="把视频、图片或关键帧拖入时间轴开始排布"
          onPackageStateChange={onPackageStateChange}
          controlledCursorTime={previewCurrentTime}
          onCursorTimeChange={(time) => setPreviewCurrentTime(time)}
          onSelectedClipChange={(clipId) => {
            if (!clipId) return;
            const assetId = clipAssetMap.get(clipId);
            if (assetId) {
              setCurrentPreviewAssetId(assetId);
            }
          }}
        />
      </div>
    </div>
  );
}
