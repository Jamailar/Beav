import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type { PlayerRef } from '@remotion/player';
import clsx from 'clsx';
import {
  Check,
  Download,
  FileVideo,
  FolderOpen,
  Loader2,
  Mic,
  RefreshCw,
  Scissors,
  Search,
  Subtitles,
  Undo2,
  Upload,
} from 'lucide-react';
import type { MediaAssetRecord, SrtSegment, SrtSegmentTag, VideoEditorV2Project, VideoTimelineClip } from '../../../shared/videoAutoEdit';
import { RemotionVideoPreview } from '../manuscripts/remotion/RemotionVideoPreview';
import { buildRemotionCompositionFromV2Project } from '../../features/video-editor-v2/remotionAdapter';

type VideoEditorV2WorkbenchProps = {
  title: string;
  editorFile: string;
  isActive?: boolean;
};

type RequestState = {
  kind: 'idle' | 'loading' | 'importing-assets' | 'importing-srt' | 'asr' | 'saving' | 'merge-srt' | 'split-srt' | 'trim-clip' | 'split-clip' | 'reorder-clip' | 'undo' | 'auto-edit' | 'apply-auto-edit' | 'render';
  message?: string;
};

const TAGS: Array<{ value: SrtSegmentTag; label: string; className: string }> = [
  { value: 'keep', label: '保留', className: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300' },
  { value: 'remove', label: '删除', className: 'border-rose-400/40 bg-rose-500/10 text-rose-300' },
  { value: 'highlight', label: '亮点', className: 'border-amber-400/40 bg-amber-500/10 text-amber-300' },
  { value: 'hook', label: '开头', className: 'border-sky-400/40 bg-sky-500/10 text-sky-300' },
  { value: 'filler', label: '废话', className: 'border-zinc-400/30 bg-zinc-500/10 text-zinc-300' },
  { value: 'unclear', label: '不清楚', className: 'border-violet-400/40 bg-violet-500/10 text-violet-300' },
];

const TIMELINE_ZOOM_LEVELS = [1, 2, 4, 8] as const;

function formatTime(ms: number): string {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const milliseconds = safe % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function formatAssetMeta(asset: MediaAssetRecord): string {
  const parts = [asset.kind];
  if (asset.durationMs) {
    parts.push(formatTime(asset.durationMs));
  }
  if (asset.width && asset.height) {
    parts.push(`${asset.width}x${asset.height}`);
  }
  if (asset.fps) {
    parts.push(`${asset.fps}fps`);
  }
  if (asset.proxyPath) {
    parts.push('proxy');
  }
  return parts.join(' · ');
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '未知错误');
}

export function VideoEditorV2Workbench({
  title,
  editorFile,
  isActive = true,
}: VideoEditorV2WorkbenchProps) {
  const [project, setProject] = useState<VideoEditorV2Project | null>(null);
  const [requestState, setRequestState] = useState<RequestState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  const [selectedTrackId, setSelectedTrackId] = useState<string>('');
  const [selectedClipId, setSelectedClipId] = useState<string>('');
  const [autoEditGoal, setAutoEditGoal] = useState('剪成一版节奏紧凑的口播粗剪');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(60);
  const [pacing, setPacing] = useState<'tight' | 'balanced' | 'slow'>('tight');
  const [renderProgress, setRenderProgress] = useState<{ stage: string; percent: number; outputPath?: string } | null>(null);
  const [visibleSegmentLimit, setVisibleSegmentLimit] = useState(160);
  const [timelineZoom, setTimelineZoom] = useState<(typeof TIMELINE_ZOOM_LEVELS)[number]>(1);
  const [timelineViewportStartMs, setTimelineViewportStartMs] = useState(0);
  const [timelinePlayheadMs, setTimelinePlayheadMs] = useState(0);
  const [draggingClipId, setDraggingClipId] = useState('');
  const remotionPlayerRef = useRef<PlayerRef | null>(null);

  const isBusy = requestState.kind !== 'idle';

  const activeTrack = useMemo(() => {
    if (!project) return null;
    return project.transcriptTracks.find((track) => track.id === selectedTrackId)
      || project.transcriptTracks[0]
      || null;
  }, [project, selectedTrackId]);

  const selectedAsset = useMemo(() => {
    if (!project) return null;
    return project.assets.find((asset) => asset.id === selectedAssetId)
      || project.assets.find((asset) => asset.kind === 'video' || asset.kind === 'audio')
      || project.assets[0]
      || null;
  }, [project, selectedAssetId]);

  const filteredSegments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const segments = activeTrack?.segments || [];
    if (!normalizedQuery) return segments;
    return segments.filter((segment) => {
      return segment.text.toLowerCase().includes(normalizedQuery)
        || segment.tags.some((tag) => tag.includes(normalizedQuery))
        || String(segment.index).includes(normalizedQuery);
    });
  }, [activeTrack?.segments, query]);
  const visibleSegments = useMemo(() => {
    return filteredSegments.slice(0, visibleSegmentLimit);
  }, [filteredSegments, visibleSegmentLimit]);

  const latestAutoEditRun = project?.autoEditRuns?.[0] || null;
  const latestUndoRecord = project?.undoStack?.[0] || null;
  const latestRenderOutput = project?.renderOutputs?.[0] || null;
  const timelineTracks = project?.timeline?.tracks || [];
  const primaryTimelineClips = useMemo(() => {
    return (timelineTracks.find((track) => track.kind === 'primary-video')?.clips || [])
      .slice()
      .sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs);
  }, [timelineTracks]);
  const timelineDurationMs = Math.max(1, Number(project?.timeline?.durationMs || 0));
  const timelineViewportDurationMs = Math.max(1, Math.ceil(timelineDurationMs / timelineZoom));
  const maxTimelineViewportStartMs = Math.max(0, timelineDurationMs - timelineViewportDurationMs);
  const timelineViewportEndMs = Math.min(timelineDurationMs, timelineViewportStartMs + timelineViewportDurationMs);
  const timelinePlayheadVisible = timelinePlayheadMs >= timelineViewportStartMs && timelinePlayheadMs <= timelineViewportEndMs;
  const timelinePlayheadLeft = Math.max(0, Math.min(100, ((timelinePlayheadMs - timelineViewportStartMs) / timelineViewportDurationMs) * 100));
  const selectedClip = useMemo(() => {
    for (const track of timelineTracks) {
      const clip = track.clips.find((item) => item.id === selectedClipId);
      if (clip) {
        return {
          trackId: track.id,
          trackKind: track.kind,
          trackName: track.name,
          clip,
        };
      }
    }
    return null;
  }, [selectedClipId, timelineTracks]);
  const selectedPrimaryClipIndex = useMemo(() => {
    if (!selectedClip || selectedClip.trackKind !== 'primary-video') return -1;
    return primaryTimelineClips.findIndex((clip) => clip.id === selectedClip.clip.id);
  }, [primaryTimelineClips, selectedClip]);
  const remotionComposition = useMemo(() => {
    return project ? buildRemotionCompositionFromV2Project(project) : null;
  }, [project]);
  const segmentTimelineMs = useMemo(() => {
    const map = new Map<string, number>();
    for (const track of project?.timeline?.tracks || []) {
      if (track.kind !== 'subtitle') continue;
      for (const clip of track.clips) {
        for (const segmentId of clip.transcriptSegmentIds || []) {
          if (!map.has(segmentId)) {
            map.set(segmentId, clip.timelineStartMs);
          }
        }
      }
    }
    return map;
  }, [project?.timeline?.tracks]);

  const loadProject = useCallback(async () => {
    if (!editorFile) return;
    setRequestState({ kind: 'loading', message: '加载 V2 剪辑项目...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.getOrCreateForManuscript({
        manuscriptPath: editorFile,
        title,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      if (!result?.success || !result.project) {
        throw new Error(result?.error || '无法创建 V2 剪辑项目');
      }
      setProject(result.project);
      const firstAsset = result.project.assets.find((asset) => asset.kind === 'video' || asset.kind === 'audio') || result.project.assets[0];
      setSelectedAssetId((current) => current || firstAsset?.id || '');
      setSelectedTrackId((current) => current || result.project!.transcriptTracks[0]?.id || '');
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [editorFile, title]);

  useEffect(() => {
    if (!isActive) return;
    void loadProject();
  }, [isActive, loadProject]);

  useEffect(() => {
    setVisibleSegmentLimit(160);
  }, [activeTrack?.id, query]);

  useEffect(() => {
    setTimelineViewportStartMs((current) => Math.max(0, Math.min(current, maxTimelineViewportStartMs)));
  }, [maxTimelineViewportStartMs]);

  useEffect(() => {
    setTimelinePlayheadMs((current) => Math.max(0, Math.min(current, timelineDurationMs)));
  }, [timelineDurationMs]);

  useEffect(() => {
    if (!project?.id) return undefined;
    const handleProgress = (first?: unknown, second?: unknown) => {
      const payload = (second || first) as { projectId?: string; stage?: string; percent?: number; outputPath?: string } | undefined;
      if (payload?.projectId !== project.id) return;
      setRenderProgress({
        stage: String(payload.stage || '渲染中'),
        percent: Math.max(0, Math.min(100, Number(payload.percent || 0))),
        outputPath: payload.outputPath,
      });
    };
    window.ipcRenderer.on('videoEditorV2:render-progress', handleProgress);
    return () => {
      window.ipcRenderer.off('videoEditorV2:render-progress', handleProgress);
    };
  }, [project?.id]);

  const applyProjectResult = useCallback((result: { success?: boolean; canceled?: boolean; project?: VideoEditorV2Project; error?: string }) => {
    if (result?.canceled) return;
    if (!result?.success || !result.project) {
      throw new Error(result?.error || '操作失败');
    }
    setProject(result.project);
    const nextAsset = result.project.assets.find((asset) => asset.id === selectedAssetId)
      || result.project.assets.find((asset) => asset.kind === 'video' || asset.kind === 'audio')
      || result.project.assets[0];
    const nextTrack = result.project.transcriptTracks.find((track) => track.id === selectedTrackId)
      || result.project.transcriptTracks[0];
    setSelectedAssetId(nextAsset?.id || '');
    setSelectedTrackId(nextTrack?.id || '');
  }, [selectedAssetId, selectedTrackId]);

  const runProjectAction = useCallback(async (
    state: RequestState,
    action: () => Promise<{ success?: boolean; canceled?: boolean; project?: VideoEditorV2Project; error?: string }>,
  ) => {
    if (!project || isBusy) return;
    setRequestState(state);
    setError(null);
    try {
      const result = await action();
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [applyProjectResult, isBusy, project]);

  const handleImportAssets = useCallback(() => {
    if (!project) return;
    void runProjectAction(
      { kind: 'importing-assets', message: '导入素材...' },
      () => window.ipcRenderer.videoEditorV2.importAssets({ projectId: project.id }) as Promise<{ success?: boolean; canceled?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [project, runProjectAction]);

  const handleImportSrt = useCallback(() => {
    if (!project) return;
    void runProjectAction(
      { kind: 'importing-srt', message: '导入 SRT...' },
      () => window.ipcRenderer.videoEditorV2.importSrt({
        projectId: project.id,
        assetId: selectedAsset?.id,
      }) as Promise<{ success?: boolean; canceled?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [project, runProjectAction, selectedAsset?.id]);

  const handleRunAsr = useCallback(() => {
    if (!project || !selectedAsset) return;
    void runProjectAction(
      { kind: 'asr', message: 'ASR 识别中，等待模型返回 SRT...' },
      () => window.ipcRenderer.videoEditorV2.runAsr({
        projectId: project.id,
        assetId: selectedAsset.id,
      }) as Promise<{ success?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [project, runProjectAction, selectedAsset]);

  const handleGenerateAutoEdit = useCallback(() => {
    if (!project || !activeTrack) return;
    void runProjectAction(
      { kind: 'auto-edit', message: '生成自动粗剪计划...' },
      () => window.ipcRenderer.videoEditorV2.generateAutoEdit({
        projectId: project.id,
        trackId: activeTrack.id,
        userGoal: autoEditGoal,
        targetDurationMs: Math.max(1, Number(targetDurationSeconds || 0)) * 1000,
        pacing,
      }) as Promise<{ success?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [activeTrack, autoEditGoal, pacing, project, runProjectAction, targetDurationSeconds]);

  const handleApplyAutoEdit = useCallback(() => {
    if (!project || !latestAutoEditRun) return;
    void runProjectAction(
      { kind: 'apply-auto-edit', message: '应用自动粗剪计划...' },
      () => window.ipcRenderer.videoEditorV2.applyAutoEdit({
        projectId: project.id,
        runId: latestAutoEditRun.id,
      }) as Promise<{ success?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [latestAutoEditRun, project, runProjectAction]);

  const handleUndoTimeline = useCallback(() => {
    if (!project || !latestUndoRecord) return;
    void runProjectAction(
      { kind: 'undo', message: `撤销：${latestUndoRecord.label}` },
      () => window.ipcRenderer.videoEditorV2.undoTimeline({
        projectId: project.id,
      }) as Promise<{ success?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [latestUndoRecord, project, runProjectAction]);

  const focusTimelineAt = useCallback((timelineMs: number) => {
    const safeTimelineMs = Math.max(0, Math.min(timelineDurationMs, Math.round(Number(timelineMs) || 0)));
    const centeredStartMs = safeTimelineMs - Math.round(timelineViewportDurationMs / 2);
    setTimelineViewportStartMs(Math.max(0, Math.min(maxTimelineViewportStartMs, centeredStartMs)));
  }, [maxTimelineViewportStartMs, timelineDurationMs, timelineViewportDurationMs]);

  const seekPreviewToTimeline = useCallback((timelineMs: number, shouldFocus = false) => {
    const safeTimelineMs = Math.max(0, Math.min(timelineDurationMs, Math.round(Number(timelineMs) || 0)));
    setTimelinePlayheadMs(safeTimelineMs);
    if (shouldFocus) {
      focusTimelineAt(safeTimelineMs);
    }
    if (!remotionComposition) return;
    const frame = Math.max(0, Math.round((safeTimelineMs / 1000) * remotionComposition.fps));
    remotionPlayerRef.current?.seekTo(Math.min(frame, Math.max(0, remotionComposition.durationInFrames - 1)));
  }, [focusTimelineAt, remotionComposition, timelineDurationMs]);

  const handleSeekSegment = useCallback((segment: SrtSegment) => {
    if (!project || !remotionComposition) return;
    const timelineMs = segmentTimelineMs.get(segment.id);
    if (timelineMs === undefined) return;
    seekPreviewToTimeline(timelineMs, true);
  }, [project, remotionComposition, seekPreviewToTimeline, segmentTimelineMs]);

  const handleSelectClip = useCallback((clip: VideoTimelineClip) => {
    setSelectedClipId(clip.id);
    seekPreviewToTimeline(clip.timelineStartMs, true);
  }, [seekPreviewToTimeline]);

  const handleTimelineRailClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!project?.timeline?.durationMs) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const timelineMs = timelineViewportStartMs + (Math.max(0, Math.min(1, ratio)) * timelineViewportDurationMs);
    seekPreviewToTimeline(timelineMs);
  }, [project?.timeline?.durationMs, seekPreviewToTimeline, timelineViewportDurationMs, timelineViewportStartMs]);

  const handleRender = useCallback(() => {
    if (!project || !remotionComposition) return;
    setRenderProgress({ stage: '准备导出', percent: 0 });
    void runProjectAction(
      { kind: 'render', message: '导出 Remotion MP4...' },
      () => window.ipcRenderer.videoEditorV2.render({
        projectId: project.id,
        renderVideo: true,
      }) as Promise<{ success?: boolean; project?: VideoEditorV2Project; error?: string }>,
    );
  }, [project, remotionComposition, runProjectAction]);

  const handleToggleTag = useCallback(async (segment: SrtSegment, tag: SrtSegmentTag) => {
    if (!project || !activeTrack) return;
    const nextTags = segment.tags.includes(tag)
      ? segment.tags.filter((item) => item !== tag)
      : [...segment.tags.filter((item) => item !== tag), tag];
    setRequestState({ kind: 'saving', message: '保存字幕标签...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.updateSrtSegment({
        projectId: project.id,
        trackId: activeTrack.id,
        segmentId: segment.id,
        tags: nextTags,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [activeTrack, applyProjectResult, project]);

  const handleTextBlur = useCallback(async (segment: SrtSegment, text: string) => {
    if (!project || !activeTrack || text === segment.text) return;
    setRequestState({ kind: 'saving', message: '保存字幕文本...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.updateSrtSegment({
        projectId: project.id,
        trackId: activeTrack.id,
        segmentId: segment.id,
        text,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [activeTrack, applyProjectResult, project]);

  const handleMergeWithNext = useCallback(async (segment: SrtSegment) => {
    if (!project || !activeTrack) return;
    const index = activeTrack.segments.findIndex((item) => item.id === segment.id);
    const nextSegment = index >= 0 ? activeTrack.segments[index + 1] : null;
    if (!nextSegment) return;
    setRequestState({ kind: 'merge-srt', message: '合并相邻字幕...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.mergeSrtSegments({
        projectId: project.id,
        trackId: activeTrack.id,
        segmentIds: [segment.id, nextSegment.id],
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [activeTrack, applyProjectResult, project]);

  const handleSplitSegment = useCallback(async (segment: SrtSegment) => {
    if (!project || !activeTrack) return;
    setRequestState({ kind: 'split-srt', message: '拆分字幕...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.splitSrtSegment({
        projectId: project.id,
        trackId: activeTrack.id,
        segmentId: segment.id,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [activeTrack, applyProjectResult, project]);

  const handleToggleTimelineClipDisabled = useCallback(async () => {
    if (!project || !selectedClip) return;
    setRequestState({ kind: 'saving', message: selectedClip.clip.disabled ? '恢复时间线片段...' : '删除时间线片段...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.setTimelineClipDisabled({
        projectId: project.id,
        clipId: selectedClip.clip.id,
        disabled: !selectedClip.clip.disabled,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [applyProjectResult, project, selectedClip]);

  const handleTrimSelectedClip = useCallback(async (edge: 'start' | 'end') => {
    if (!project || !selectedClip || selectedClip.trackKind !== 'primary-video') return;
    setRequestState({ kind: 'trim-clip', message: edge === 'start' ? '裁剪片段开头...' : '裁剪片段结尾...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.trimTimelineClip({
        projectId: project.id,
        clipId: selectedClip.clip.id,
        edge,
        deltaMs: 500,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [applyProjectResult, project, selectedClip]);

  const handleSplitSelectedClip = useCallback(async () => {
    if (!project || !selectedClip || selectedClip.trackKind !== 'primary-video') return;
    const durationMs = selectedClip.clip.timelineEndMs - selectedClip.clip.timelineStartMs;
    setRequestState({ kind: 'split-clip', message: '拆分时间线片段...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.splitTimelineClip({
        projectId: project.id,
        clipId: selectedClip.clip.id,
        splitOffsetMs: Math.round(durationMs / 2),
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [applyProjectResult, project, selectedClip]);

  const handleReorderTimelineClip = useCallback(async (input: {
    clipId: string;
    targetClipId?: string;
    position?: 'before' | 'after';
    direction?: 'left' | 'right';
  }) => {
    if (!project || !input.clipId) return;
    setRequestState({ kind: 'reorder-clip', message: '重排时间线片段...' });
    setError(null);
    try {
      const result = await window.ipcRenderer.videoEditorV2.reorderTimelineClip({
        projectId: project.id,
        clipId: input.clipId,
        targetClipId: input.targetClipId,
        position: input.position,
        direction: input.direction,
      }) as { success?: boolean; project?: VideoEditorV2Project; error?: string };
      applyProjectResult(result);
      setSelectedClipId(input.clipId);
    } catch (nextError) {
      setError(resolveErrorMessage(nextError));
    } finally {
      setRequestState({ kind: 'idle' });
    }
  }, [applyProjectResult, project]);

  const handleDropPrimaryClip = useCallback((event: DragEvent<HTMLButtonElement>, targetClip: VideoTimelineClip) => {
    event.preventDefault();
    event.stopPropagation();
    const clipId = event.dataTransfer.getData('text/plain') || draggingClipId;
    setDraggingClipId('');
    if (!clipId || clipId === targetClip.id) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX > rect.left + (rect.width / 2) ? 'after' : 'before';
    void handleReorderTimelineClip({
      clipId,
      targetClipId: targetClip.id,
      position,
    });
  }, [draggingClipId, handleReorderTimelineClip]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1117] text-zinc-100">
      <div className="flex items-center justify-between border-b border-white/10 bg-[#111722]/95 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
            <Scissors className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-black tracking-tight">自动剪辑 V2</div>
            <div className="truncate text-[11px] font-semibold text-zinc-500">{project?.id || '初始化中'} · SRT 驱动剪辑骨架</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {requestState.message ? (
            <div className="hidden items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-bold text-zinc-300 md:flex">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {requestState.message}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void loadProject()}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-bold text-zinc-300 transition hover:bg-white/[0.08] disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          {project?.projectDir ? (
            <button
              type="button"
              onClick={() => void window.ipcRenderer.openPath(project.projectDir)}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-bold text-zinc-300 transition hover:bg-white/[0.08]"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              项目目录
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="border-b border-rose-400/20 bg-rose-500/10 px-5 py-2 text-[12px] font-semibold text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_260px] overflow-hidden">
        <aside className="flex min-h-0 flex-col border-r border-white/10 bg-[#0f141d]">
          <div className="border-b border-white/10 p-4">
            <div className="text-[11px] font-black uppercase tracking-[0.24em] text-zinc-500">Assets</div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleImportAssets}
                disabled={!project || isBusy}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-400 px-3 py-2 text-[12px] font-black text-slate-950 transition hover:bg-cyan-300 disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" />
                导入素材
              </button>
              <button
                type="button"
                onClick={handleImportSrt}
                disabled={!project || isBusy || !selectedAsset}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-[12px] font-black text-zinc-200 transition hover:bg-white/[0.09] disabled:opacity-40"
              >
                <Subtitles className="h-3.5 w-3.5" />
                导入 SRT
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {(project?.assets || []).length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-4 text-[12px] leading-5 text-zinc-500">
                先导入一个视频或音频素材。素材和 SRT 会成为自动粗剪、预览和 Remotion 导出的主轴。
              </div>
            ) : (
              <div className="space-y-2">
                {project!.assets.map((asset) => (
                  <button
                    type="button"
                    key={asset.id}
                    onClick={() => setSelectedAssetId(asset.id)}
                    className={clsx(
                      'w-full rounded-2xl border p-3 text-left transition',
                      selectedAsset?.id === asset.id
                        ? 'border-cyan-400/60 bg-cyan-400/10'
                        : 'border-white/10 bg-white/[0.035] hover:bg-white/[0.06]',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <FileVideo className="h-4 w-4 text-cyan-200" />
                      <div className="min-w-0 flex-1 truncate text-[12px] font-black text-zinc-100">{asset.title}</div>
                    </div>
                    <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{formatAssetMeta(asset)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col">
          <div className="grid h-[240px] shrink-0 grid-cols-[minmax(0,1fr)_220px] border-b border-white/10 bg-[#090d13]">
            <div className="min-w-0">
              {remotionComposition ? (
                <RemotionVideoPreview composition={remotionComposition} playerRef={remotionPlayerRef} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Scissors className="mx-auto h-8 w-8 text-zinc-600" />
                    <div className="mt-3 text-[13px] font-black text-zinc-300">等待粗剪预览</div>
                    <div className="mt-1 text-[11px] leading-5 text-zinc-600">
                      生成自动粗剪后，这里会通过 adapter 使用现有 Remotion preview。
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="border-l border-white/10 p-4">
              <div className="text-[10px] font-black uppercase tracking-[0.24em] text-zinc-600">Remotion</div>
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                <div className="text-[12px] font-black text-zinc-100">
                  {remotionComposition ? `${remotionComposition.width}x${remotionComposition.height}` : '未生成'}
                </div>
                <div className="mt-2 text-[11px] leading-5 text-zinc-500">
                  {remotionComposition
                    ? `${remotionComposition.scenes.length} scenes · ${remotionComposition.fps}fps · ${remotionComposition.durationInFrames} frames`
                    : 'Remotion 模块未改动，仅消费 V2 adapter 输出。'}
                </div>
              </div>
              <button
                type="button"
                onClick={handleRender}
                disabled={!project || !remotionComposition || isBusy}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-3 py-2 text-[12px] font-black text-slate-950 transition hover:bg-cyan-200 disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                导出 MP4
              </button>
              {renderProgress ? (
                <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-2">
                  <div className="flex items-center justify-between text-[10px] font-black text-cyan-100">
                    <span>{renderProgress.stage}</span>
                    <span>{Math.round(renderProgress.percent)}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30">
                    <div className="h-full rounded-full bg-cyan-300" style={{ width: `${renderProgress.percent}%` }} />
                  </div>
                </div>
              ) : null}
              {latestRenderOutput?.path ? (
                <button
                  type="button"
                  onClick={() => void window.ipcRenderer.openPath(latestRenderOutput.path)}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-black text-zinc-200 transition hover:bg-white/[0.08]"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  打开最近导出
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <div>
              <div className="text-[13px] font-black">字幕段</div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {activeTrack ? `${activeTrack.segments.length} 条字幕 · 绑定素材 ${activeTrack.assetId}` : '还没有 SRT'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <Search className="h-3.5 w-3.5 text-zinc-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索字幕"
                  className="w-44 bg-transparent text-[12px] font-semibold text-zinc-200 outline-none placeholder:text-zinc-600"
                />
              </div>
              <button
                type="button"
                onClick={handleRunAsr}
                disabled={!project || isBusy || !selectedAsset || selectedAsset.kind === 'image'}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-3 py-2 text-[12px] font-black text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-40"
              >
                <Mic className="h-3.5 w-3.5" />
                ASR 识别
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!activeTrack ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-sm rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center">
                  <Subtitles className="mx-auto h-8 w-8 text-cyan-200" />
                  <div className="mt-3 text-[14px] font-black">等待 SRT</div>
                  <div className="mt-2 text-[12px] leading-5 text-zinc-500">
                    导入 SRT 或运行 ASR。SRT 解析后会成为 V2 自动剪辑的源真相。
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {visibleSegments.map((segment) => (
                  <div key={segment.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => handleSeekSegment(segment)}
                        disabled={!segmentTimelineMs.has(segment.id)}
                        className="w-16 shrink-0 rounded-xl border border-white/10 bg-white/[0.03] px-2 py-1 text-left transition hover:border-cyan-300/40 hover:bg-cyan-300/10 disabled:cursor-default disabled:opacity-60"
                        title={segmentTimelineMs.has(segment.id) ? '跳到粗剪预览中的这句字幕' : '生成粗剪后可跳转预览'}
                      >
                        <div className="text-[11px] font-black text-zinc-300">#{segment.index}</div>
                        <div className="mt-1 text-[10px] font-bold leading-4 text-zinc-600">
                          {formatTime(segment.startMs)}
                          <br />
                          {formatTime(segment.endMs)}
                        </div>
                      </button>
                      <textarea
                        key={`${segment.id}:${segment.text}`}
                        defaultValue={segment.text}
                        onBlur={(event) => void handleTextBlur(segment, event.target.value)}
                        className="min-h-[58px] flex-1 resize-y rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[13px] font-semibold leading-5 text-zinc-100 outline-none transition focus:border-cyan-400/40"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 pl-[76px]">
                      {TAGS.map((tag) => {
                        const active = segment.tags.includes(tag.value);
                        return (
                          <button
                            type="button"
                            key={tag.value}
                            onClick={() => void handleToggleTag(segment, tag.value)}
                            disabled={isBusy}
                            className={clsx(
                              'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-black transition disabled:opacity-40',
                              active ? tag.className : 'border-white/10 bg-white/[0.03] text-zinc-500 hover:bg-white/[0.07]',
                            )}
                          >
                            {active ? <Check className="h-3 w-3" /> : null}
                            {tag.label}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => void handleMergeWithNext(segment)}
                        disabled={isBusy || !activeTrack?.segments.some((item, index) => item.id === segment.id && Boolean(activeTrack.segments[index + 1]))}
                        className="inline-flex items-center rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-2 py-1 text-[10px] font-black text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-40"
                      >
                        合并下句
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSplitSegment(segment)}
                        disabled={isBusy || (segment.endMs - segment.startMs < 200 && segment.text.trim().length < 2)}
                        className="inline-flex items-center rounded-lg border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[10px] font-black text-amber-100 transition hover:bg-amber-300/20 disabled:opacity-40"
                      >
                        拆分
                      </button>
                    </div>
                  </div>
                ))}
                {visibleSegments.length < filteredSegments.length ? (
                  <button
                    type="button"
                    onClick={() => setVisibleSegmentLimit((current) => current + 160)}
                    className="w-full rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-3 text-[12px] font-black text-zinc-400 transition hover:border-cyan-300/30 hover:bg-cyan-300/10 hover:text-cyan-100"
                  >
                    继续显示 {Math.min(160, filteredSegments.length - visibleSegments.length)} 条字幕 · 已显示 {visibleSegments.length}/{filteredSegments.length}
                  </button>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-[12px] font-black text-zinc-100">V2 Timeline</div>
                <div className="mt-0.5 text-[10px] font-bold text-zinc-600">
                  {project?.timeline?.durationMs
                    ? `粗剪时长 ${Math.round(project.timeline.durationMs / 1000)} 秒 · 播放头 ${formatTime(timelinePlayheadMs)} · 视窗 ${formatTime(timelineViewportStartMs)} - ${formatTime(timelineViewportEndMs)}`
                    : '还没有生成粗剪'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUndoTimeline}
                  disabled={!latestUndoRecord || isBusy}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-black text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100 disabled:opacity-40"
                  title={latestUndoRecord ? `撤销：${latestUndoRecord.label}` : '暂无可撤销操作'}
                >
                  <Undo2 className="h-3 w-3" />
                  撤销
                </button>
                <div className="flex overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                  {TIMELINE_ZOOM_LEVELS.map((zoom) => (
                    <button
                      type="button"
                      key={zoom}
                      onClick={() => setTimelineZoom(zoom)}
                      className={clsx(
                        'px-2.5 py-1.5 text-[10px] font-black transition',
                        timelineZoom === zoom
                          ? 'bg-cyan-300 text-slate-950'
                          : 'text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200',
                      )}
                    >
                      {zoom === 1 ? 'Fit' : `${zoom}x`}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">
                  {timelineTracks.reduce((sum, track) => sum + track.clips.length, 0)} clips
                  {latestUndoRecord ? ` · undo ${project?.undoStack?.length || 0}` : ''}
                </div>
              </div>
            </div>
            {timelineZoom > 1 ? (
              <input
                type="range"
                min={0}
                max={maxTimelineViewportStartMs}
                value={Math.min(timelineViewportStartMs, maxTimelineViewportStartMs)}
                onChange={(event) => setTimelineViewportStartMs(Math.max(0, Math.min(maxTimelineViewportStartMs, Number(event.target.value) || 0)))}
                className="mb-3 h-1 w-full accent-cyan-300"
              />
            ) : null}
            <div className="space-y-2">
              {timelineTracks.map((track) => (
                <div key={track.id} className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
                  <div className="truncate text-[10px] font-black uppercase tracking-wider text-zinc-500">{track.name}</div>
                  <div
                    className="relative h-9 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
                    onClick={handleTimelineRailClick}
                    title="点击时间线定位播放头"
                  >
                    {track.clips.length === 0 ? (
                      <div className="flex h-full items-center px-3 text-[10px] font-semibold text-zinc-700">empty</div>
                    ) : track.clips.map((clip) => {
                      const visibleStartMs = Math.max(clip.timelineStartMs, timelineViewportStartMs);
                      const visibleEndMs = Math.min(clip.timelineEndMs, timelineViewportEndMs);
                      if (visibleEndMs <= visibleStartMs) return null;
                      const left = Math.max(0, ((visibleStartMs - timelineViewportStartMs) / timelineViewportDurationMs) * 100);
                      const width = Math.max(1.5, ((visibleEndMs - visibleStartMs) / timelineViewportDurationMs) * 100);
                      return (
                        <button
                          type="button"
                          key={clip.id}
                          draggable={track.kind === 'primary-video'}
                          onDragStart={(event) => {
                            if (track.kind !== 'primary-video') return;
                            event.dataTransfer.setData('text/plain', clip.id);
                            event.dataTransfer.effectAllowed = 'move';
                            setDraggingClipId(clip.id);
                          }}
                          onDragEnd={() => setDraggingClipId('')}
                          onDragOver={(event) => {
                            if (track.kind !== 'primary-video' || !draggingClipId || draggingClipId === clip.id) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                          }}
                          onDrop={(event) => {
                            if (track.kind !== 'primary-video') return;
                            handleDropPrimaryClip(event, clip);
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleSelectClip(clip);
                          }}
                          className={clsx(
                            'absolute top-1 h-7 overflow-hidden rounded-lg border px-2 py-1 text-left text-[10px] font-black leading-5 transition',
                            selectedClipId === clip.id
                              ? 'ring-2 ring-white/70'
                              : '',
                            draggingClipId === clip.id
                              ? 'opacity-50'
                              : '',
                            clip.disabled
                              ? 'border-zinc-500/30 bg-zinc-700/20 text-zinc-500 line-through'
                              : track.kind === 'subtitle'
                              ? 'border-amber-300/30 bg-amber-300/15 text-amber-100'
                              : 'border-cyan-300/30 bg-cyan-300/15 text-cyan-100',
                          )}
                          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                          title={`${clip.disabled ? '[已删除] ' : ''}${clip.text || clip.transcriptSegmentIds?.join(', ') || clip.id}`}
                        >
                          <span className="block truncate">{clip.text || clip.transcriptSegmentIds?.length || clip.id}</span>
                        </button>
                      );
                    })}
                    {timelinePlayheadVisible ? (
                      <div
                        className="pointer-events-none absolute top-0 z-10 h-full w-px bg-cyan-200 shadow-[0_0_10px_rgba(103,232,249,0.8)]"
                        style={{ left: `${timelinePlayheadLeft}%` }}
                      >
                        <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-cyan-200" />
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-white/10 bg-[#0f141d]">
          <div className="border-b border-white/10 p-4">
            <div className="text-[11px] font-black uppercase tracking-[0.24em] text-zinc-500">Inspector</div>
            <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
              <div className="text-[12px] font-black text-zinc-100">{project?.title || title}</div>
              <div className="mt-2 text-[11px] leading-5 text-zinc-500">
                状态：{project?.status || 'loading'}
                <br />
                素材：{project?.assets.length || 0}
                <br />
                字幕轨：{project?.transcriptTracks.length || 0}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
              <div className="text-[12px] font-black text-zinc-100">时间线选择</div>
              {selectedClip ? (
                <div className="mt-3">
                  <div className="rounded-xl bg-black/20 p-2 text-[11px] leading-5 text-zinc-400">
                    <span className="font-black text-zinc-200">{selectedClip.trackName}</span>
                    <br />
                    {formatTime(selectedClip.clip.timelineStartMs)} - {formatTime(selectedClip.clip.timelineEndMs)}
                    <br />
                    {selectedClip.clip.text || selectedClip.clip.transcriptSegmentIds?.join(', ') || selectedClip.clip.id}
                  </div>
                  {selectedClip.trackKind === 'primary-video' ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void handleTrimSelectedClip('start')}
                        disabled={!project || isBusy || !selectedClip.clip.assetId || Boolean(selectedClip.clip.disabled) || selectedClip.clip.timelineEndMs - selectedClip.clip.timelineStartMs <= 600}
                        className="inline-flex items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-2 py-2 text-[11px] font-black text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-40"
                      >
                        裁开头 0.5s
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleTrimSelectedClip('end')}
                        disabled={!project || isBusy || !selectedClip.clip.assetId || Boolean(selectedClip.clip.disabled) || selectedClip.clip.timelineEndMs - selectedClip.clip.timelineStartMs <= 600}
                        className="inline-flex items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-2 py-2 text-[11px] font-black text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-40"
                      >
                        裁结尾 0.5s
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSplitSelectedClip()}
                        disabled={!project || isBusy || !selectedClip.clip.assetId || Boolean(selectedClip.clip.disabled) || selectedClip.clip.timelineEndMs - selectedClip.clip.timelineStartMs < 1000}
                        className="col-span-2 inline-flex items-center justify-center rounded-xl border border-amber-300/20 bg-amber-300/10 px-2 py-2 text-[11px] font-black text-amber-100 transition hover:bg-amber-300/20 disabled:opacity-40"
                      >
                        中点拆分
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReorderTimelineClip({ clipId: selectedClip.clip.id, direction: 'left' })}
                        disabled={!project || isBusy || selectedPrimaryClipIndex <= 0}
                        className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-2 py-2 text-[11px] font-black text-zinc-200 transition hover:bg-white/[0.08] disabled:opacity-40"
                      >
                        前移
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReorderTimelineClip({ clipId: selectedClip.clip.id, direction: 'right' })}
                        disabled={!project || isBusy || selectedPrimaryClipIndex < 0 || selectedPrimaryClipIndex >= primaryTimelineClips.length - 1}
                        className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-2 py-2 text-[11px] font-black text-zinc-200 transition hover:bg-white/[0.08] disabled:opacity-40"
                      >
                        后移
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleToggleTimelineClipDisabled}
                    disabled={!project || isBusy}
                    className={clsx(
                      'mt-3 inline-flex w-full items-center justify-center rounded-xl px-3 py-2 text-[12px] font-black transition disabled:opacity-40',
                      selectedClip.clip.disabled
                        ? 'bg-emerald-300 text-emerald-950 hover:bg-emerald-200'
                        : 'bg-rose-300 text-rose-950 hover:bg-rose-200',
                    )}
                  >
                    {selectedClip.clip.disabled ? '恢复片段' : '删除片段'}
                  </button>
                  {selectedClip.trackKind === 'primary-video' ? (
                    <div className="mt-2 text-[10px] leading-4 text-zinc-600">
                      可拖拽 primary clip 排序；排序会同步平移关联字幕。裁剪主视频会同步收缩关联字幕，并让后续 clip 前移；拆分会把主视频分成两段并按字幕位置分配 segment；删除主视频片段会同步隐藏其关联字幕，源字幕不删除。
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-2 text-[11px] leading-5 text-zinc-500">
                  点击 timeline clip 后可定位预览，并在这里删除或恢复片段。
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
              <div className="text-[12px] font-black text-zinc-100">自动粗剪</div>
              <div className="mt-3 space-y-3">
                <textarea
                  value={autoEditGoal}
                  onChange={(event) => setAutoEditGoal(event.target.value)}
                  className="min-h-[74px] w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] font-semibold leading-5 text-zinc-100 outline-none transition focus:border-cyan-400/40"
                  placeholder="描述这一版粗剪目标"
                />
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-600">目标秒数</span>
                    <input
                      type="number"
                      min={5}
                      max={1800}
                      value={targetDurationSeconds}
                      onChange={(event) => setTargetDurationSeconds(Number(event.target.value || 60))}
                      className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] font-black text-zinc-100 outline-none focus:border-cyan-400/40"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-600">节奏</span>
                    <select
                      value={pacing}
                      onChange={(event) => setPacing(event.target.value as typeof pacing)}
                      className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] font-black text-zinc-100 outline-none focus:border-cyan-400/40"
                    >
                      <option value="tight">紧凑</option>
                      <option value="balanced">均衡</option>
                      <option value="slow">舒缓</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={handleGenerateAutoEdit}
                  disabled={!project || !activeTrack || isBusy}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-3 py-2 text-[12px] font-black text-amber-950 transition hover:bg-amber-200 disabled:opacity-40"
                >
                  <Scissors className="h-3.5 w-3.5" />
                  生成自动粗剪
                </button>
              </div>
            </div>

            {latestAutoEditRun ? (
              <div className="mt-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[12px] font-black text-emerald-100">最近一次计划</div>
                  <div className={clsx(
                    'rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-wider',
                    latestAutoEditRun.status === 'planned'
                      ? 'bg-amber-300/20 text-amber-100'
                      : 'bg-emerald-300/20 text-emerald-100',
                  )}
                  >
                    {latestAutoEditRun.status === 'planned' ? '未应用' : '已应用'}
                  </div>
                </div>
                <div className="mt-2 text-[11px] leading-5 text-emerald-100/75">{latestAutoEditRun.plan.summary}</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-black uppercase tracking-wider">
                  <div className="rounded-xl bg-black/20 p-2 text-emerald-100">
                    保留 {latestAutoEditRun.plan.selectedSegments.length}
                  </div>
                  <div className="rounded-xl bg-black/20 p-2 text-rose-100">
                    移除 {latestAutoEditRun.plan.removedSegments.length}
                  </div>
                </div>
                {latestAutoEditRun.plan.warnings.length > 0 ? (
                  <div className="mt-2 rounded-xl border border-amber-300/20 bg-amber-300/10 p-2 text-[11px] leading-5 text-amber-100">
                    {latestAutoEditRun.plan.warnings.join('；')}
                  </div>
                ) : null}
                {latestAutoEditRun.status === 'planned' ? (
                  <button
                    type="button"
                    onClick={handleApplyAutoEdit}
                    disabled={!project || isBusy}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-300 px-3 py-2 text-[12px] font-black text-emerald-950 transition hover:bg-emerald-200 disabled:opacity-40"
                  >
                    <Check className="h-3.5 w-3.5" />
                    应用到时间线
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
              <div className="text-[12px] font-black text-cyan-100">当前阶段范围</div>
              <div className="mt-2 text-[11px] leading-5 text-cyan-100/70">
                已接入 V2 项目、素材导入、SRT 导入、ASR 返回 SRT、字幕编辑、合并/拆分、标签保存、自动粗剪计划、V2 timeline、Remotion preview adapter 和 MP4 导出入口。
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
