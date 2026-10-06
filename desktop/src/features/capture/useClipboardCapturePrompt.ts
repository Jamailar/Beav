import { useCallback, useEffect, useRef, useState } from 'react';
import { extractYouTubeCandidateFromClipboard, type YouTubeClipboardCandidate } from './youtubeClipboard';

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
  const [candidate, setCandidate] = useState<YouTubeClipboardCandidate | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClipboardCaptureStatus>('idle');
  const [message, setMessage] = useState('');

  const lastClipboardTextRef = useRef('');
  const pollingRef = useRef(false);
  const capturedYouTubeSetRef = useRef<Set<string>>(new Set());
  const promptOpenRef = useRef(false);
  const statusRef = useRef<ClipboardCaptureStatus>('idle');

  useEffect(() => {
    promptOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const enqueueYoutubeFromClipboard = useCallback(async (nextCandidate: YouTubeClipboardCandidate) => {
    const payload = {
      videoId: nextCandidate.videoId,
      videoUrl: nextCandidate.videoUrl,
      title: `YouTube_${nextCandidate.videoId}`,
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

    return result;
  }, []);

  const close = useCallback(() => {
    if (status === 'saving') return;
    setOpen(false);
    setCandidate(null);
    setStatus('idle');
    setMessage('');
  }, [status]);

  const confirm = useCallback(async () => {
    if (!candidate || status === 'saving') return;

    setStatus('saving');
    setMessage('正在加入后台采集...');

    try {
      const result = await enqueueYoutubeFromClipboard(candidate);
      capturedYouTubeSetRef.current.add(candidate.videoId);
      setStatus('success');
      setMessage(
        result?.duplicate
          ? '该视频已在知识库中，已跳过重复采集。'
          : '已加入后台采集，稍后可在知识库看到处理结果。',
      );
      window.setTimeout(() => {
        setOpen(false);
        setCandidate(null);
        setStatus('idle');
        setMessage('');
      }, 1000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus('error');
      setMessage(`采集失败：${errorMessage}`);
    }
  }, [candidate, enqueueYoutubeFromClipboard, status]);

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

    const applyClipboardText = (text: string): boolean => {
      const normalizedText = String(text || '').trim();
      if (!normalizedText || normalizedText === lastClipboardTextRef.current) {
        return false;
      }

      lastClipboardTextRef.current = normalizedText;
      const nextCandidate = extractYouTubeCandidateFromClipboard(normalizedText);
      if (!nextCandidate) return false;
      if (capturedYouTubeSetRef.current.has(nextCandidate.videoId)) return false;

      setCandidate(nextCandidate);
      setStatus('idle');
      setMessage('检测到剪贴板里的 YouTube 链接，是否开始后台采集？');
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
        const foundCandidate = applyClipboardText(text);
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
      if (applyClipboardText(event.clipboardData?.getData('text') || '')) {
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
    close,
    confirm,
  };
}
