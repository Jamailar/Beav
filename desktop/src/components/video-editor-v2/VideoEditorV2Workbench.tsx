import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type { PlayerRef } from '@remotion/player';
import clsx from 'clsx';
import {
  Check,
  FileVideo,
  FolderOpen,
  Loader2,
  Mic,
  Scissors,
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


const TIMELINE_ZOOM_LEVELS = [1, 2, 4, 8] as const;

function formatTime(ms: number): string {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const milliseconds = safe % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function formatAssetMeta(asset: MediaAssetRecord): string {
  const parts: string[] = [asset.kind];
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
  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  const [selectedTrackId, setSelectedTrackId] = useState<string>('');
  const [selectedClipId, setSelectedClipId] = useState<string>('');
  const [autoEditGoal, setAutoEditGoal] = useState('剪成一版节奏紧凑的口播粗剪');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(60);
  const [pacing, setPacing] = useState<'tight' | 'balanced' | 'slow'>('tight');
  const [renderProgress, setRenderProgress] = useState<{ stage: string; percent: number; outputPath?: string } | null>(null);
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

  const handleGenerateAutoEdit = useCallback((
    nextGoal = autoEditGoal,
    nextDurationSeconds = targetDurationSeconds,
    nextPacing = pacing,
  ) => {
    if (!project || !activeTrack) return;
    void runProjectAction(
      { kind: 'auto-edit', message: '生成自动粗剪计划...' },
      () => window.ipcRenderer.videoEditorV2.generateAutoEdit({
        projectId: project.id,
        trackId: activeTrack.id,
        userGoal: nextGoal,
        targetDurationMs: Math.max(1, Number(nextDurationSeconds || 0)) * 1000,
        pacing: nextPacing,
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

  const assetCount = project?.assets.length || 0;
  const transcriptCount = activeTrack?.segments.length || 0;
  const clipCount = timelineTracks.reduce((sum, track) => sum + track.clips.length, 0);
  const hasAutoEditPlan = Boolean(latestAutoEditRun);
  const hasAppliedAutoEdit = latestAutoEditRun?.status === 'applied';
  const workflowSteps = [
    { label: '素材', done: assetCount > 0 },
    { label: '字幕', done: transcriptCount > 0 },
    { label: '粗剪', done: clipCount > 0 || hasAppliedAutoEdit },
    { label: '导出', done: Boolean(latestRenderOutput?.path) },
  ];
  const timelinePreviewClips = primaryTimelineClips.slice(0, 8);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-text-primary">
      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-[12px] font-semibold text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_320px] gap-0 overflow-hidden">
        <aside className="flex min-h-0 flex-col border-r border-border bg-surface-primary/72">
          <div className="p-4">
            <button
              type="button"
              onClick={handleImportAssets}
              disabled={!project || isBusy}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-accent-primary px-3 text-[12px] font-black text-primary-text transition hover:bg-accent-hover disabled:opacity-45"
            >
              <Upload className="h-3.5 w-3.5" />
              导入素材
            </button>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleImportSrt}
                disabled={!project || isBusy || !selectedAsset}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface-primary text-[11px] font-bold text-text-secondary transition hover:border-accent-border hover:text-text-primary disabled:opacity-45"
              >
                <Subtitles className="h-3.5 w-3.5" />
                导入字幕
              </button>
              <button
                type="button"
                onClick={handleRunAsr}
                disabled={!project || isBusy || !selectedAsset || selectedAsset.kind === 'image'}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface-primary text-[11px] font-bold text-text-secondary transition hover:border-accent-border hover:text-text-primary disabled:opacity-45"
              >
                <Mic className="h-3.5 w-3.5" />
                识别字幕
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {assetCount === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-surface-secondary/70 px-4 py-8 text-center">
                <FileVideo className="mx-auto h-8 w-8 text-text-tertiary/45" />
                <div className="mt-3 text-[13px] font-black text-text-primary">还没有素材</div>
                <div className="mt-1 text-[12px] font-medium text-text-tertiary">导入后就可以让 AI 剪。</div>
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
                        ? 'border-accent-border bg-accent-muted/70 shadow-sm'
                        : 'border-border bg-surface-primary hover:border-accent-border hover:bg-surface-secondary/70',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <FileVideo className="h-4 w-4 text-accent-primary" />
                      <div className="min-w-0 flex-1 truncate text-[12px] font-black text-text-primary">{asset.title}</div>
                    </div>
                    <div className="mt-1 truncate text-[10px] font-bold uppercase tracking-wider text-text-tertiary">{formatAssetMeta(asset)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col overflow-hidden bg-background">
          <div className="flex items-center gap-3 border-b border-border bg-surface-primary/58 px-5 py-3">
            {workflowSteps.map((step, index) => (
              <div key={step.label} className="flex items-center gap-3">
                <div className={clsx(
                  'flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] font-black',
                  step.done ? 'bg-accent-muted text-accent-primary' : 'bg-surface-secondary text-text-tertiary',
                )}>
                  {step.done ? <Check className="h-3.5 w-3.5" /> : null}
                  {step.label}
                </div>
                {index < workflowSteps.length - 1 ? <div className="h-px w-5 bg-border" /> : null}
              </div>
            ))}
          </div>

          <div className="min-h-0 flex-1 p-5">
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-border bg-surface-primary shadow-sm">
              <div className="min-h-0 flex-1 bg-[rgb(var(--color-text-primary)/0.94)]">
                {remotionComposition ? (
                  <RemotionVideoPreview composition={remotionComposition} playerRef={remotionPlayerRef} />
                ) : (
                  <div className="flex h-full items-center justify-center p-8">
                    <div className="max-w-sm text-center">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-surface-primary/10 text-primary-text">
                        <Scissors className="h-7 w-7" />
                      </div>
                      <div className="mt-4 text-[18px] font-black text-primary-text">等待 AI 剪辑</div>
                      <div className="mt-2 text-[13px] leading-6 text-primary-text/55">
                        导入素材和字幕后，生成一版可预览、可导出的粗剪。
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-border bg-surface-primary px-5 py-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-black text-text-primary">剪辑摘要</div>
                    <div className="mt-0.5 text-[11px] font-semibold text-text-tertiary">
                      {clipCount ? `${clipCount} 个片段 · ${formatTime(timelineDurationMs)}` : '还没有生成时间线'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {latestUndoRecord ? (
                      <button
                        type="button"
                        onClick={handleUndoTimeline}
                        disabled={isBusy}
                        className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-surface-primary px-3 text-[11px] font-bold text-text-secondary transition hover:bg-surface-secondary/70 disabled:opacity-45"
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        撤销
                      </button>
                    ) : null}
                    {latestRenderOutput?.path ? (
                      <button
                        type="button"
                        onClick={() => void window.ipcRenderer.openPath(latestRenderOutput.path)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-surface-primary px-3 text-[11px] font-bold text-text-secondary transition hover:bg-surface-secondary/70"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        打开导出
                      </button>
                    ) : null}
                  </div>
                </div>

                {timelinePreviewClips.length > 0 ? (
                  <div className="space-y-2">
                    {timelinePreviewClips.map((clip) => (
                      <button
                        type="button"
                        key={clip.id}
                        onClick={() => handleSelectClip(clip)}
                        className={clsx(
                          'grid w-full grid-cols-[72px_minmax(0,1fr)_72px] items-center gap-3 rounded-xl border px-3 py-2 text-left transition',
                          selectedClipId === clip.id ? 'border-accent-border bg-accent-muted/70' : 'border-border bg-surface-secondary/45 hover:bg-surface-secondary/75',
                        )}
                      >
                        <span className="text-[10px] font-black text-text-tertiary">{formatTime(clip.timelineStartMs)}</span>
                        <span className={clsx('truncate text-[12px] font-bold', clip.disabled ? 'text-text-tertiary line-through' : 'text-text-primary')}>
                          {clip.text || clip.transcriptSegmentIds?.join(', ') || clip.id}
                        </span>
                        <span className="text-right text-[10px] font-black text-text-tertiary">{formatTime(clip.timelineEndMs - clip.timelineStartMs)}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border bg-surface-secondary/70 px-4 py-6 text-center text-[12px] font-semibold text-text-tertiary">
                    生成后这里会显示剪辑片段。
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-border bg-surface-primary/80">
          <div className="border-b border-border px-4 py-3">
            <div className="text-[13px] font-black text-text-primary">AI 剪辑助手</div>
            <div className="mt-1 text-[12px] font-medium text-text-tertiary">直接告诉它这版怎么剪。</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-3">
              <div className="max-w-[86%] rounded-2xl rounded-tl-md border border-border bg-surface-secondary/75 px-3 py-2.5 text-[12px] font-semibold leading-5 text-text-secondary">
                我会根据素材、字幕和目标时长生成剪辑方案，再应用到时间线。
              </div>

              {hasAutoEditPlan ? (
                <div className="ml-auto max-w-[92%] rounded-2xl rounded-tr-md border border-accent-border bg-accent-muted/70 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-black text-accent-primary">剪辑方案</div>
                    <div className="rounded-full bg-surface-primary px-2 py-1 text-[9px] font-black uppercase tracking-wider text-accent-primary">
                      {latestAutoEditRun?.status === 'planned' ? '待应用' : '已应用'}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] font-semibold leading-5 text-accent-primary/75">{latestAutoEditRun?.plan.summary}</div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-black">
                    <div className="rounded-xl bg-surface-primary p-2 text-accent-primary">保留 {latestAutoEditRun?.plan.selectedSegments.length || 0}</div>
                    <div className="rounded-xl bg-surface-primary p-2 text-red-600">移除 {latestAutoEditRun?.plan.removedSegments.length || 0}</div>
                  </div>
                  {latestAutoEditRun?.status === 'planned' ? (
                    <button
                      type="button"
                      onClick={handleApplyAutoEdit}
                      disabled={!project || isBusy}
                      className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-accent-primary px-3 text-[12px] font-black text-primary-text transition hover:bg-accent-hover disabled:opacity-45"
                    >
                      <Check className="h-3.5 w-3.5" />
                      应用到时间线
                    </button>
                  ) : null}
                </div>
              ) : null}

            </div>
          </div>

          <div className="border-t border-border bg-surface-primary p-4">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[
                { label: '剪掉废话', goal: '剪掉废话、长停顿、重复表达，保留信息密度高的口播内容。', seconds: 90, nextPacing: 'tight' as const },
                { label: '60 秒短视频', goal: '提炼成一版 60 秒以内的短视频，开头要快，保留最有价值的观点。', seconds: 60, nextPacing: 'tight' as const },
                { label: '完整讲解版', goal: '整理成一版结构完整、节奏均衡的讲解视频，尽量保留上下文。', seconds: 180, nextPacing: 'balanced' as const },
              ].map((task) => (
                <button
                  type="button"
                  key={task.label}
                  onClick={() => {
                    setAutoEditGoal(task.goal);
                    setTargetDurationSeconds(task.seconds);
                    setPacing(task.nextPacing);
                  }}
                  className="rounded-full border border-border bg-surface-secondary/70 px-2.5 py-1 text-[11px] font-bold text-text-secondary transition hover:border-accent-border hover:bg-accent-muted hover:text-text-primary"
                >
                  {task.label}
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-border bg-surface-secondary/55 p-2 shadow-sm focus-within:border-accent-primary/30 focus-within:ring-2 focus-within:ring-accent-primary/10">
              <textarea
                value={autoEditGoal}
                onChange={(event) => setAutoEditGoal(event.target.value)}
                className="min-h-[78px] w-full resize-none bg-transparent px-2 py-2 text-[13px] font-semibold leading-5 text-text-primary outline-none placeholder:text-text-tertiary"
                placeholder="例如：剪掉废话，保留观点，控制在 60 秒"
              />
              <div className="flex justify-end px-1 pb-1">
                <button
                  type="button"
                  onClick={() => handleGenerateAutoEdit()}
                  disabled={!project || !activeTrack || isBusy || !autoEditGoal.trim()}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-primary text-primary-text transition hover:bg-accent-hover disabled:opacity-45"
                  title="发送"
                  aria-label="发送"
                >
                  {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
