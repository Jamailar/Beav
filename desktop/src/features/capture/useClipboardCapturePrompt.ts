import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardCaptureCandidate, ClipboardCaptureExecutionResult, ClipboardCaptureSource, ClipboardCaptureTask } from './captureTypes';
import { clipboardCaptureQueue } from './captureQueue';
import {
  clipboardCapturePlatformLabel,
  detectClipboardCaptureCandidate,
} from './clipboardDetector';
import { clipboardCaptureDedupeStore } from './captureDedupeStore';
import {
  createServerCaptureJob,
  ingestServerCaptureJobResult,
  pollServerCaptureJob,
} from './serverCaptureClient';

const CLIPBOARD_POLL_BOOT_DELAY_MS = 4000;
const CLIPBOARD_POLL_FOCUS_DELAY_MS = 1500;
const CLIPBOARD_POLL_MIN_INTERVAL_MS = 12_000;
const CLIPBOARD_POLL_IDLE_INTERVAL_MS = 45_000;
const CLIPBOARD_POLL_MAX_INTERVAL_MS = 120_000;

export type ClipboardCaptureStatus = 'idle' | 'saving' | 'success' | 'error';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

export function useClipboardCapturePrompt() {
  const [candidate, setCandidate] = useState<ClipboardCaptureCandidate | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClipboardCaptureStatus>('idle');
  const [message, setMessage] = useState('');
  const [includeComments, setIncludeComments] = useState(false);

  const lastClipboardTextRef = useRef('');
  const pollingRef = useRef(false);
  const promptOpenRef = useRef(false);
  const statusRef = useRef<ClipboardCaptureStatus>('idle');

  useEffect(() => {
    promptOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const executeCaptureCandidate = useCallback(async (
    nextCandidate: ClipboardCaptureCandidate,
    context: { updateTask: (patch: Partial<ClipboardCaptureTask>) => void },
  ): Promise<ClipboardCaptureExecutionResult> => {
    if (nextCandidate.kind !== 'youtube-video') {
      const response = await createServerCaptureJob(nextCandidate, {
        includeComments: includeComments && nextCandidate.kind === 'xhs-note',
      });
      const jobId = response.job?.id || response.jobId;
      if (!response.success || !jobId) {
        throw new Error(response.error || '服务端采集任务创建失败');
      }
      context.updateTask({
        serverJobId: jobId,
        progressMessage: response.job?.progress?.message || '等待处理',
      });
      const job = await pollServerCaptureJob(jobId, (nextJob) => {
        context.updateTask({
          serverJobId: nextJob.id,
          progressMessage: nextJob.progress?.message || nextJob.status,
          pointsCost: nextJob.pointsCost,
        });
      });
      await ingestServerCaptureJobResult(job);
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

    return {
      success: true,
      duplicate: result.duplicate,
      noteId: result.noteId,
    };
  }, [includeComments]);

  const close = useCallback(() => {
    if (status === 'saving') return;
    setOpen(false);
    setCandidate(null);
    setStatus('idle');
    setMessage('');
    setIncludeComments(false);
  }, [status]);

  const confirm = useCallback(async () => {
    if (!candidate || status === 'saving') return;

    setStatus('saving');
    setMessage('正在加入后台采集...');

    try {
      const result = await clipboardCaptureQueue.enqueue(candidate, executeCaptureCandidate);
      if (!result.success) {
        throw new Error(result.error || '采集任务失败');
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
        setStatus('idle');
        setMessage('');
        setIncludeComments(false);
      }, 1000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus('error');
      setMessage(`采集失败：${errorMessage}`);
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
      && !pollingRef.current
      && !promptOpenRef.current
      && statusRef.current !== 'saving'
      && document.visibilityState === 'visible'
      && document.hasFocus()
      && !isEditableElement(document.activeElement)
    );

    const applyClipboardText = (text: string, source: ClipboardCaptureSource): boolean => {
      const normalizedText = String(text || '').trim();
      if (!normalizedText || normalizedText === lastClipboardTextRef.current) {
        return false;
      }

      lastClipboardTextRef.current = normalizedText;
      const nextCandidate = detectClipboardCaptureCandidate(normalizedText, source);
      if (!nextCandidate) return false;
      if (clipboardCaptureDedupeStore.has(nextCandidate)) return false;

      clipboardCaptureDedupeStore.mark(nextCandidate);
      setCandidate(nextCandidate);
      setIncludeComments(false);
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
  }, []);

  return {
    candidate,
    open,
    status,
    message,
    includeComments,
    setIncludeComments,
    close,
    confirm,
  };
}
