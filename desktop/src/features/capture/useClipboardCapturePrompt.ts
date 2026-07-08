import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardCaptureCandidate, ClipboardCaptureExecutionResult, ClipboardCaptureSource, ClipboardCaptureTask } from './captureTypes';
import { clipboardCaptureQueue } from './captureQueue';
import {
  clipboardCapturePlatformLabel,
  detectClipboardCaptureCandidate,
} from './clipboardDetector';
import { clipboardCaptureDedupeStore } from './captureDedupeStore';
import {
  captureResponseError,
  ClipboardCaptureError,
  createServerCaptureJob,
  formatServerJobDebugDetails,
  ingestServerCaptureJobResult,
  pollServerCaptureJob,
} from './serverCaptureClient';

const CLIPBOARD_POLL_BOOT_DELAY_MS = 350;
const CLIPBOARD_POLL_FOCUS_DELAY_MS = 300;
const CLIPBOARD_POLL_MIN_INTERVAL_MS = 2500;
const CLIPBOARD_POLL_IDLE_INTERVAL_MS = 15_000;
const CLIPBOARD_POLL_MAX_INTERVAL_MS = 45_000;
const DEFAULT_XHS_PROFILE_LIMIT = 20;
const MIN_XHS_PROFILE_LIMIT = 1;
const MAX_XHS_PROFILE_LIMIT = 100;

export type ClipboardCaptureStatus = 'idle' | 'saving' | 'success' | 'error';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function clampProfileLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_XHS_PROFILE_LIMIT;
  return Math.max(MIN_XHS_PROFILE_LIMIT, Math.min(MAX_XHS_PROFILE_LIMIT, Math.floor(parsed)));
}

function isProfileCaptureKind(kind: ClipboardCaptureCandidate['kind']): boolean {
  return kind === 'xhs-profile'
    || kind === 'douyin-profile'
    || kind === 'bilibili-profile'
    || kind === 'youtube-channel'
    || kind === 'tiktok-profile';
}

export function useClipboardCapturePrompt({ disabled = false }: { disabled?: boolean } = {}) {
  const [candidate, setCandidate] = useState<ClipboardCaptureCandidate | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClipboardCaptureStatus>('idle');
  const [message, setMessage] = useState('');
  const [includeComments, setIncludeComments] = useState(false);
  const [profileLimit, setProfileLimitState] = useState(DEFAULT_XHS_PROFILE_LIMIT);
  const [activeTask, setActiveTask] = useState<ClipboardCaptureTask | null>(null);

  const lastClipboardTextRef = useRef('');
  const pollingRef = useRef(false);
  const promptOpenRef = useRef(false);
  const statusRef = useRef<ClipboardCaptureStatus>('idle');
  const candidateRef = useRef<ClipboardCaptureCandidate | null>(null);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    promptOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    candidateRef.current = candidate;
  }, [candidate]);

  useEffect(() => {
    disabledRef.current = disabled;
    if (!disabled) return;
    setOpen(false);
    setCandidate(null);
    setActiveTask(null);
    setStatus('idle');
    setMessage('');
    setIncludeComments(false);
    setProfileLimitState(DEFAULT_XHS_PROFILE_LIMIT);
  }, [disabled]);

  useEffect(() => clipboardCaptureQueue.subscribe((snapshot) => {
    const currentCandidate = candidateRef.current;
    if (!currentCandidate) {
      setActiveTask(null);
      return;
    }
    const nextTask = [
      ...(snapshot.active ? [snapshot.active] : []),
      ...snapshot.queued,
      ...snapshot.recent,
    ].find((task) => task.candidate.id === currentCandidate.id) || null;
    setActiveTask(nextTask);
  }), []);

  const executeCaptureCandidate = useCallback(async (
    nextCandidate: ClipboardCaptureCandidate,
    context: {
      updateTask: (patch: Partial<ClipboardCaptureTask>) => void;
      appendLog: (message: string, level?: 'info' | 'warn' | 'error') => void;
    },
  ): Promise<ClipboardCaptureExecutionResult> => {
    if (nextCandidate.kind !== 'youtube-video') {
      context.updateTask({ progressMessage: '创建服务端采集任务' });
      context.appendLog(`创建服务端采集任务：${nextCandidate.canonicalUrl}`);
      const response = await createServerCaptureJob(nextCandidate, {
        includeComments: includeComments && nextCandidate.kind === 'xhs-note',
        limit: isProfileCaptureKind(nextCandidate.kind) ? profileLimit : undefined,
      });
      const jobId = response.job?.id || response.jobId;
      if (!response.success || !jobId) {
        throw captureResponseError(response, '服务端采集任务创建失败');
      }
      context.appendLog(`服务端任务已创建：${jobId}`);
      context.updateTask({
        serverJobId: jobId,
        progressMessage: response.job?.progress?.message || '等待处理',
      });
      const job = await pollServerCaptureJob(jobId, (nextJob) => {
        if (nextJob.progress?.message) {
          context.appendLog(nextJob.progress.message);
        }
        context.updateTask({
          serverJobId: nextJob.id,
          progressMessage: nextJob.progress?.message || nextJob.status,
          pointsCost: nextJob.pointsCost,
          debugDetails: formatServerJobDebugDetails(nextJob),
        });
      });
      context.appendLog('服务端处理完成，写入知识库');
      await ingestServerCaptureJobResult(job);
      context.appendLog('知识库写入完成');
      return {
        success: true,
        duplicate: response.duplicate,
        jobId,
      };
    }

    const videoId = nextCandidate.externalId || '';
    if (!videoId) {
      throw new Error('YouTube 链接缺少 videoId');
    }
    context.updateTask({ progressMessage: '保存 YouTube 视频到知识库' });
    context.appendLog(`保存 YouTube 视频：${videoId}`);
    const payload = {
      videoId,
      videoUrl: nextCandidate.canonicalUrl,
      title: nextCandidate.title || `YouTube_${videoId}`,
      description: '',
      thumbnailUrl: '',
    };

    const result = await window.ipcRenderer.capture.saveYoutubeNote(payload) as {
      success?: boolean;
      duplicate?: boolean;
      error?: string;
      noteId?: string;
    } | null;

    if (!result?.success) {
      throw new Error(result?.error || '保存 YouTube 任务失败');
    }
    context.appendLog('YouTube 视频保存完成');

    return {
      success: true,
      duplicate: result.duplicate,
      noteId: result.noteId,
    };
  }, [includeComments, profileLimit]);

  const setProfileLimit = useCallback((value: number | string) => {
    setProfileLimitState(clampProfileLimit(value));
  }, []);

  const close = useCallback(() => {
    if (status === 'saving') return;
    setOpen(false);
    setCandidate(null);
    setActiveTask(null);
    setStatus('idle');
    setMessage('');
    setIncludeComments(false);
    setProfileLimitState(DEFAULT_XHS_PROFILE_LIMIT);
  }, [status]);

  const confirm = useCallback(async () => {
    if (!candidate || status === 'saving') return;

    setStatus('saving');
    setMessage('正在加入后台采集...');

    try {
      const result = await clipboardCaptureQueue.enqueue(candidate, executeCaptureCandidate);
      if (!result.success) {
        throw new ClipboardCaptureError(result.error || '采集任务失败', result.debugDetails);
      }
      setStatus('success');
      setMessage(
        result?.duplicate
          ? '该内容已在队列中，已跳过重复采集。'
          : result?.jobId
            ? '采集完成，已保存到知识库。'
            : '已加入后台采集，稍后可在知识库看到处理结果。',
      );
      window.setTimeout(() => {
        setOpen(false);
        setCandidate(null);
        setActiveTask(null);
        setStatus('idle');
        setMessage('');
        setIncludeComments(false);
        setProfileLimitState(DEFAULT_XHS_PROFILE_LIMIT);
      }, 1000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const debugDetails = error instanceof ClipboardCaptureError ? error.debugDetails : undefined;
      setStatus('error');
      setMessage(`采集失败：${errorMessage}`);
      if (debugDetails) {
        setActiveTask((current) => current ? { ...current, debugDetails } : current);
      }
    }
  }, [candidate, executeCaptureCandidate, status]);

  useEffect(() => {
    (window as unknown as { __redboxGlobalClipboardWatcher?: boolean }).__redboxGlobalClipboardWatcher = true;
    let disposed = false;
    let pollTimerId: number | null = null;
    let nextPollDelayMs = CLIPBOARD_POLL_MIN_INTERVAL_MS;

    const clearPollTimer = () => {
      if (pollTimerId !== null) {
        window.clearTimeout(pollTimerId);
        pollTimerId = null;
      }
    };

    const shouldReadClipboard = () => (
      !disposed
      && !disabledRef.current
      && !pollingRef.current
      && !promptOpenRef.current
      && statusRef.current !== 'saving'
      && document.visibilityState === 'visible'
      && document.hasFocus()
      && !isEditableElement(document.activeElement)
    );

    const applyClipboardText = (text: string, source: ClipboardCaptureSource): boolean => {
      const normalizedText = String(text || '').trim();
      if (disabledRef.current) return false;
      if (!normalizedText || normalizedText === lastClipboardTextRef.current) {
        return false;
      }

      lastClipboardTextRef.current = normalizedText;
      const nextCandidate = detectClipboardCaptureCandidate(normalizedText, source);
      if (!nextCandidate) return false;
      if (clipboardCaptureDedupeStore.has(nextCandidate)) return false;

      clipboardCaptureDedupeStore.mark(nextCandidate);
      setCandidate(nextCandidate);
      setActiveTask(null);
      setIncludeComments(false);
      setProfileLimitState(DEFAULT_XHS_PROFILE_LIMIT);
      setStatus('idle');
      setMessage(`检测到剪贴板里的${clipboardCapturePlatformLabel(nextCandidate)}链接，是否开始后台采集？`);
      setOpen(true);
      return true;
    };

    const schedulePoll = (delayMs = nextPollDelayMs) => {
      if (disposed) return;
      clearPollTimer();
      pollTimerId = window.setTimeout(() => {
        pollTimerId = null;
        void runPoll();
      }, Math.max(0, delayMs));
    };

    const runPoll = async () => {
      if (!shouldReadClipboard()) {
        schedulePoll(CLIPBOARD_POLL_IDLE_INTERVAL_MS);
        return;
      }

      pollingRef.current = true;
      try {
        const text = await window.ipcRenderer.clipboardReadText() as string;
        const foundCandidate = applyClipboardText(text, 'poll');
        nextPollDelayMs = foundCandidate
          ? CLIPBOARD_POLL_IDLE_INTERVAL_MS
          : Math.min(Math.max(nextPollDelayMs * 2, CLIPBOARD_POLL_MIN_INTERVAL_MS), CLIPBOARD_POLL_MAX_INTERVAL_MS);
      } finally {
        pollingRef.current = false;
        schedulePoll(nextPollDelayMs);
      }
    };

    const bootTimerId = window.setTimeout(() => {
      schedulePoll(CLIPBOARD_POLL_FOCUS_DELAY_MS);
    }, CLIPBOARD_POLL_BOOT_DELAY_MS);

    const handleFocus = () => {
      if (disabledRef.current) return;
      nextPollDelayMs = CLIPBOARD_POLL_MIN_INTERVAL_MS;
      schedulePoll(CLIPBOARD_POLL_FOCUS_DELAY_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleFocus();
      } else {
        clearPollTimer();
      }
    };
    const handlePaste = (event: ClipboardEvent) => {
      if (disabledRef.current) return;
      if (promptOpenRef.current || statusRef.current === 'saving') return;
      if (applyClipboardText(event.clipboardData?.getData('text') || '', 'paste')) {
        nextPollDelayMs = CLIPBOARD_POLL_IDLE_INTERVAL_MS;
        schedulePoll(nextPollDelayMs);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('paste', handlePaste);

    return () => {
      disposed = true;
      window.clearTimeout(bootTimerId);
      clearPollTimer();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('paste', handlePaste);
    };
  }, [disabled]);

  return {
    candidate,
    open,
    status,
    message,
    activeTask,
    includeComments,
    setIncludeComments,
    profileLimit,
    setProfileLimit,
    minProfileLimit: MIN_XHS_PROFILE_LIMIT,
    maxProfileLimit: MAX_XHS_PROFILE_LIMIT,
    isProfileCapture: candidate ? isProfileCaptureKind(candidate.kind) : false,
    close,
    confirm,
  };
}
