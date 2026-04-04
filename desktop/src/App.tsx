import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { FirstRunTour } from './components/FirstRunTour';
import type { AuthoringTaskHints } from './utils/redclawAuthoring';

const ChatPage = lazy(async () => ({ default: (await import('./pages/Chat')).Chat }));
const CreativeChatPage = lazy(async () => ({ default: (await import('./pages/CreativeChat')).CreativeChat }));
const SkillsPage = lazy(async () => ({ default: (await import('./pages/Skills')).Skills }));
const KnowledgePage = lazy(async () => ({ default: (await import('./pages/Knowledge')).Knowledge }));
const AdvisorsPage = lazy(async () => ({ default: (await import('./pages/Advisors')).Advisors }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/Settings')).Settings }));
const ManuscriptsPage = lazy(async () => ({ default: (await import('./pages/Manuscripts')).Manuscripts }));
const ArchivesPage = lazy(async () => ({ default: (await import('./pages/Archives')).Archives }));
const WanderPage = lazy(async () => ({ default: (await import('./pages/Wander')).Wander }));
const RedClawPage = lazy(async () => ({ default: (await import('./pages/RedClaw')).RedClaw }));
const MediaLibraryPage = lazy(async () => ({ default: (await import('./pages/MediaLibrary')).MediaLibrary }));
const CoverStudioPage = lazy(async () => ({ default: (await import('./pages/CoverStudio')).CoverStudio }));
const SubjectsPage = lazy(async () => ({ default: (await import('./pages/Subjects')).Subjects }));
const WorkboardPage = lazy(async () => ({ default: (await import('./pages/Workboard')).Workboard }));

export type ViewType = 'chat' | 'creative-chat' | 'skills' | 'knowledge' | 'advisors' | 'settings' | 'manuscripts' | 'archives' | 'wander' | 'redclaw' | 'media-library' | 'cover-studio' | 'subjects' | 'workboard';

const PINNED_VIEWS: ViewType[] = ['manuscripts'];
const MAX_CACHED_VIEWS = 5;
const CLIPBOARD_POLL_BOOT_DELAY_MS = 4000;

// 待发送的聊天消息（用于跨页面传递）
export interface PendingChatMessage {
  content: string;          // 实际发送给 AI 的完整内容
  displayContent?: string;  // UI 上显示的简短内容
  taskHints?: AuthoringTaskHints;
  attachment?: {
    type: 'youtube-video';
    title: string;
    thumbnailUrl?: string;
    videoId?: string;
  } | {
    type: 'wander-references';
    title?: string;
    items: Array<{
      title: string;
      itemType: 'note' | 'video';
      tag?: string;
      folderPath?: string;
      summary?: string;
      cover?: string;
    }>;
  };
}

const CLIPBOARD_POLL_INTERVAL_MS = 1600;

interface YouTubeClipboardCandidate {
  videoId: string;
  videoUrl: string;
  rawUrl: string;
}

function parseYouTubeCandidateFromUrl(rawInput: string): YouTubeClipboardCandidate | null {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  const sanitized = trimmed
    .replace(/[)\]}>,.!?，。！？、]+$/g, '')
    .replace(/^<|>$/g, '');

  let parsed: URL;
  try {
    parsed = new URL(sanitized);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isYouTubeHost = host === 'youtu.be'
    || host.endsWith('.youtu.be')
    || host === 'youtube.com'
    || host.endsWith('.youtube.com');
  if (!isYouTubeHost) return null;

  let videoId = '';
  if (host.includes('youtu.be')) {
    videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
  } else {
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts[0] === 'watch') {
      videoId = parsed.searchParams.get('v') || '';
    } else if (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') {
      videoId = pathParts[1] || '';
    } else if (pathParts[0] === 'clip') {
      videoId = parsed.searchParams.get('v') || '';
    }
  }

  const normalizedVideoId = videoId.trim();
  if (!normalizedVideoId || !/^[a-zA-Z0-9_-]{6,}$/.test(normalizedVideoId)) {
    return null;
  }

  return {
    videoId: normalizedVideoId,
    videoUrl: `https://www.youtube.com/watch?v=${normalizedVideoId}`,
    rawUrl: sanitized,
  };
}

function extractYouTubeCandidateFromClipboard(text: string): YouTubeClipboardCandidate | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const direct = parseYouTubeCandidateFromUrl(raw);
  if (direct) return direct;

  const matches = raw.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const item of matches) {
    const candidate = parseYouTubeCandidateFromUrl(item);
    if (candidate) return candidate;
  }

  return null;
}

function ViewLoadingFallback() {
  return (
    <div className="h-full min-h-0 flex items-center justify-center text-text-tertiary">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      页面加载中...
    </div>
  );
}

function computeMountedViews(history: ViewType[]): Set<ViewType> {
  const next = new Set<ViewType>(PINNED_VIEWS);
  const recent = history.slice(-MAX_CACHED_VIEWS);
  for (const view of recent) {
    next.add(view);
  }
  return next;
}

function App() {
  const [currentView, setCurrentView] = useState<ViewType>('manuscripts');
  const [pendingChatMessage, setPendingChatMessage] = useState<PendingChatMessage | null>(null);
  const [pendingRedClawMessage, setPendingRedClawMessage] = useState<PendingChatMessage | null>(null);
  const [pendingManuscriptFile, setPendingManuscriptFile] = useState<string | null>(null);
  const [mountedViews, setMountedViews] = useState<Set<ViewType>>(() => computeMountedViews(['manuscripts']));
  const [clipboardCandidate, setClipboardCandidate] = useState<YouTubeClipboardCandidate | null>(null);
  const [isCapturePromptOpen, setIsCapturePromptOpen] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [captureMessage, setCaptureMessage] = useState('');

  const lastClipboardTextRef = useRef('');
  const clipboardPollingRef = useRef(false);
  const capturedYouTubeSetRef = useRef<Set<string>>(new Set());
  const viewHistoryRef = useRef<ViewType[]>(['manuscripts']);

  useEffect(() => {
    viewHistoryRef.current = [...viewHistoryRef.current.filter((item) => item !== currentView), currentView];
    setMountedViews(computeMountedViews(viewHistoryRef.current));
  }, [currentView]);

  // 导航到 Chat 页面并发送消息
  const navigateToChat = (message: PendingChatMessage) => {
    setPendingChatMessage(message);
    setCurrentView('chat');
  };

  // Chat 页面消费消息后清除
  const clearPendingMessage = () => {
    setPendingChatMessage(null);
  };

  const navigateToRedClaw = (message: PendingChatMessage) => {
    setPendingRedClawMessage(message);
    setCurrentView('redclaw');
  };

  const clearPendingRedClawMessage = () => {
    setPendingRedClawMessage(null);
  };

  // 导航到稿件页面并打开指定文件
  const navigateToManuscript = (filePath: string) => {
    setPendingManuscriptFile(filePath);
    setCurrentView('manuscripts');
  };

  // 稿件页面消费后清除
  const clearPendingManuscriptFile = () => {
    setPendingManuscriptFile(null);
  };

  const enqueueYoutubeFromClipboard = useCallback(async (candidate: YouTubeClipboardCandidate) => {
    const payload = {
      videoId: candidate.videoId,
      videoUrl: candidate.videoUrl,
      title: `YouTube_${candidate.videoId}`,
      description: '',
      thumbnailUrl: '',
    };

    const result = await window.ipcRenderer.invoke('youtube:save-note', payload) as {
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

  const closeCapturePrompt = useCallback(() => {
    if (captureStatus === 'saving') return;
    setIsCapturePromptOpen(false);
    setClipboardCandidate(null);
    setCaptureStatus('idle');
    setCaptureMessage('');
  }, [captureStatus]);

  const confirmCaptureFromClipboard = useCallback(async () => {
    if (!clipboardCandidate || captureStatus === 'saving') return;

    setCaptureStatus('saving');
    setCaptureMessage('正在加入后台采集...');

    try {
      const result = await enqueueYoutubeFromClipboard(clipboardCandidate);
      capturedYouTubeSetRef.current.add(clipboardCandidate.videoId);
      setCaptureStatus('success');
      setCaptureMessage(
        result?.duplicate
          ? '该视频已在知识库中，已跳过重复采集。'
          : '已加入后台采集，稍后可在知识库看到处理结果。'
      );
      window.setTimeout(() => {
        setIsCapturePromptOpen(false);
        setClipboardCandidate(null);
        setCaptureStatus('idle');
        setCaptureMessage('');
      }, 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCaptureStatus('error');
      setCaptureMessage(`采集失败：${message}`);
    }
  }, [captureStatus, clipboardCandidate, enqueueYoutubeFromClipboard]);

  useEffect(() => {
    (window as unknown as { __redboxGlobalClipboardWatcher?: boolean }).__redboxGlobalClipboardWatcher = true;
    let intervalId: number | null = null;
    const bootTimerId = window.setTimeout(() => {
      intervalId = window.setInterval(() => {
        void (async () => {
          if (clipboardPollingRef.current) return;
          if (isCapturePromptOpen || captureStatus === 'saving') return;
          if (document.visibilityState !== 'visible') return;

          clipboardPollingRef.current = true;
          try {
            const text = await window.ipcRenderer.invoke('clipboard:read-text') as string;
            const normalizedText = String(text || '').trim();
            if (!normalizedText || normalizedText === lastClipboardTextRef.current) {
              return;
            }

            lastClipboardTextRef.current = normalizedText;
            const candidate = extractYouTubeCandidateFromClipboard(normalizedText);
            if (!candidate) return;
            if (capturedYouTubeSetRef.current.has(candidate.videoId)) return;

            setClipboardCandidate(candidate);
            setCaptureStatus('idle');
            setCaptureMessage('检测到剪贴板里的 YouTube 链接，是否开始后台采集？');
            setIsCapturePromptOpen(true);
          } finally {
            clipboardPollingRef.current = false;
          }
        })();
      }, CLIPBOARD_POLL_INTERVAL_MS);
    }, CLIPBOARD_POLL_BOOT_DELAY_MS);

    return () => {
      window.clearTimeout(bootTimerId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [captureStatus, isCapturePromptOpen]);

  return (
    <>
      <Layout currentView={currentView} onNavigate={setCurrentView}>
        {mountedViews.has('chat') && (
          <div className={currentView === 'chat' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'chat' ? <ViewLoadingFallback /> : null}>
              <ChatPage
                pendingMessage={pendingChatMessage}
                onMessageConsumed={clearPendingMessage}
              />
            </Suspense>
          </div>
        )}
        {mountedViews.has('creative-chat') && (
          <div className={currentView === 'creative-chat' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'creative-chat' ? <ViewLoadingFallback /> : null}>
              <CreativeChatPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('skills') && (
          <div className={currentView === 'skills' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'skills' ? <ViewLoadingFallback /> : null}>
              <SkillsPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('knowledge') && (
          <div className={currentView === 'knowledge' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'knowledge' ? <ViewLoadingFallback /> : null}>
              <KnowledgePage
                onNavigateToChat={navigateToChat}
                onNavigateToRedClaw={navigateToRedClaw}
                isActive={currentView === 'knowledge'}
              />
            </Suspense>
          </div>
        )}
        {mountedViews.has('advisors') && (
          <div className={currentView === 'advisors' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'advisors' ? <ViewLoadingFallback /> : null}>
              <AdvisorsPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('settings') && (
          <div className={currentView === 'settings' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'settings' ? <ViewLoadingFallback /> : null}>
              <SettingsPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('manuscripts') && (
          <div className={currentView === 'manuscripts' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'manuscripts' ? <ViewLoadingFallback /> : null}>
              <ManuscriptsPage
                pendingFile={pendingManuscriptFile}
                onFileConsumed={clearPendingManuscriptFile}
                onNavigateToRedClaw={navigateToRedClaw}
                isActive={currentView === 'manuscripts'}
              />
            </Suspense>
          </div>
        )}
        {mountedViews.has('archives') && (
          <div className={currentView === 'archives' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'archives' ? <ViewLoadingFallback /> : null}>
              <ArchivesPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('wander') && (
          <div className={currentView === 'wander' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'wander' ? <ViewLoadingFallback /> : null}>
              <WanderPage
                onNavigateToManuscript={navigateToManuscript}
                onNavigateToRedClaw={navigateToRedClaw}
              />
            </Suspense>
          </div>
        )}
        {mountedViews.has('redclaw') && (
          <div className={currentView === 'redclaw' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'redclaw' ? <ViewLoadingFallback /> : null}>
              <RedClawPage
                pendingMessage={pendingRedClawMessage}
                onPendingMessageConsumed={clearPendingRedClawMessage}
                onNavigateWorkboard={() => setCurrentView('workboard')}
              />
            </Suspense>
          </div>
        )}
        {mountedViews.has('subjects') && (
          <div className={currentView === 'subjects' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'subjects' ? <ViewLoadingFallback /> : null}>
              <SubjectsPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('media-library') && (
          <div className={currentView === 'media-library' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'media-library' ? <ViewLoadingFallback /> : null}>
              <MediaLibraryPage />
            </Suspense>
          </div>
        )}
        {mountedViews.has('cover-studio') && (
          <div className={currentView === 'cover-studio' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'cover-studio' ? <ViewLoadingFallback /> : null}>
              <CoverStudioPage isActive={currentView === 'cover-studio'} />
            </Suspense>
          </div>
        )}
        {mountedViews.has('workboard') && (
          <div className={currentView === 'workboard' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'workboard' ? <ViewLoadingFallback /> : null}>
              <WorkboardPage />
            </Suspense>
          </div>
        )}
      </Layout>
      {isCapturePromptOpen && clipboardCandidate && (
        <div className="fixed inset-0 z-[10000] bg-black/35 flex items-center justify-center px-4">
          <div className="w-full max-w-[560px] rounded-xl border border-border bg-surface-primary shadow-2xl p-5">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-red-50 text-red-600 inline-flex items-center justify-center shrink-0">
                <Link2 className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-text-primary">检测到 YouTube 链接</h3>
                <p className="text-sm text-text-secondary mt-1">确认后将立即在后台采集并保存到知识库（YouTube）。</p>
                <div className="mt-3 rounded-md border border-border bg-surface-secondary px-3 py-2 text-xs text-text-tertiary break-all">
                  {clipboardCandidate.rawUrl}
                </div>
                <div className="mt-2 text-xs text-text-secondary">
                  videoId: <span className="font-mono">{clipboardCandidate.videoId}</span>
                </div>
              </div>
            </div>

            {captureMessage && (
              <div className={`mt-4 text-sm ${
                captureStatus === 'error' ? 'text-red-600' : captureStatus === 'success' ? 'text-green-600' : 'text-text-secondary'
              }`}>
                {captureMessage}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={closeCapturePrompt}
                disabled={captureStatus === 'saving'}
                className="h-9 px-4 rounded-md border border-border text-sm text-text-secondary hover:text-text-primary hover:bg-surface-secondary disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void confirmCaptureFromClipboard()}
                disabled={captureStatus === 'saving'}
                className="h-9 px-4 rounded-md bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {captureStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
                确认采集
              </button>
            </div>
          </div>
        </div>
      )}
      <FirstRunTour currentView={currentView} onNavigate={setCurrentView} />
    </>
  );
}

export default App;
