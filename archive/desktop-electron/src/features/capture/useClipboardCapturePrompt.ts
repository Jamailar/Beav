import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardCaptureCandidate, ClipboardCaptureSource, ClipboardCaptureTask } from './captureTypes';
import { clipboardCaptureQueue } from './captureQueue';
import { clipboardCaptureDedupeStore } from './captureDedupeStore';
import {
  clipboardCapturePlatformLabel,
  detectClipboardCaptureCandidate,
} from './clipboardDetector';

const CLIPBOARD_POLL_BOOT_DELAY_MS = 350;
const CLIPBOARD_POLL_FOCUS_DELAY_MS = 300;
const CLIPBOARD_POLL_MIN_INTERVAL_MS = 2500;
const CLIPBOARD_POLL_IDLE_INTERVAL_MS = 15_000;
const CLIPBOARD_POLL_MAX_INTERVAL_MS = 45_000;

export type ClipboardCaptureStatus = 'idle' | 'saving' | 'success' | 'error';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

async function enqueueYoutubeFromClipboard(candidate: ClipboardCaptureCandidate) {
  const videoId = candidate.externalId || '';
  if (!videoId) {
    throw new Error('YouTube 链接缺少 videoId');
  }

  const result = await window.ipcRenderer.capture.saveYoutubeNote({
    videoId,
    videoUrl: candidate.canonicalUrl,
    title: candidate.title || `YouTube_${videoId}`,
    description: '',
    thumbnailUrl: '',
  }) as {
    success?: boolean;
    duplicate?: boolean;
    error?: string;
    noteId?: string;
  } | null;

  if (!result?.success) {
    throw new Error(result?.error || '保存 YouTube 任务失败');
  }

  return result;
}

export function useClipboardCapturePrompt() {
  const [candidate, setCandidate] = useState<ClipboardCaptureCandidate | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClipboardCaptureStatus>('idle');
  const [message, setMessage] = useState('');
  const [activeTask, setActiveTask] = useState<ClipboardCaptureTask | null>(null);
  const lastClipboardTextRef = useRef('');
  const pollingRef = useRef(false);
  const promptOpenRef = useRef(false);
  const statusRef = useRef<ClipboardCaptureStatus>('idle');
  const candidateRef = useRef<ClipboardCaptureCandidate | null>(null);

  useEffect(() => {
    promptOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    candidateRef.current = candidate;
  }, [candidate]);

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

  const close = useCallback(() => {
    if (status === 'saving') return;
    setOpen(false);
    setCandidate(null);
    setActiveTask(null);
    setStatus('idle');
    setMessage('');
  }, [status]);

  const confirm = useCallback(async () => {
    if (!candidate || status === 'saving') return;

    setStatus('saving');
    setMessage('正在加入后台采集...');

    try {
      const result = await clipboardCaptureQueue.enqueue(candidate, async (queuedCandidate, { updateTask, appendLog }) => {
        updateTask({ progressMessage: '正在保存 YouTube 采集任务' });
        appendLog(`保存 YouTube 视频：${queuedCandidate.externalId || queuedCandidate.canonicalUrl}`);
        const nextResult = await enqueueYoutubeFromClipboard(queuedCandidate);
        appendLog(nextResult?.duplicate ? '已跳过重复内容' : '已写入知识库采集任务');
        updateTask({
          progressMessage: nextResult?.duplicate
            ? '该内容已存在'
            : '已加入后台处理',
        });
        return nextResult;
      });
      setStatus('success');
      setMessage(
        result?.duplicate
          ? '该内容已在知识库中，已跳过重复采集。'
          : '已加入后台采集，稍后可在知识库看到处理结果。'
      );
      window.setTimeout(() => {
        setOpen(false);
        setCandidate(null);
        setActiveTask(null);
        setStatus('idle');
        setMessage('');
      }, 1000);
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : String(error);
      setStatus('error');
      setMessage(`采集失败：${nextMessage}`);
    }
  }, [candidate, status]);

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
      setActiveTask(null);
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
        const text = await window.ipcRenderer.clipboardReadText();
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
    open,
    candidate,
    status,
    message,
    activeTask,
    close,
    confirm,
  };
}
