import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { AppDialogsHost } from './components/AppDialogsHost';
import { Layout } from './components/Layout';
import { FirstRunTour } from './components/FirstRunTour';
import { StartupMigrationModal } from './components/StartupMigrationModal';
import { useOfficialAuthLifecycle } from './hooks/useOfficialAuthLifecycle';
import type { AuthoringTaskHints } from './utils/redclawAuthoring';
import { uiTraceInteraction } from './utils/uiDebug';

const ChatPage = lazy(async () => ({ default: (await import('./pages/Chat')).Chat }));
const SkillsPage = lazy(async () => ({ default: (await import('./pages/Skills')).Skills }));
const KnowledgePage = lazy(async () => ({ default: (await import('./pages/Knowledge')).Knowledge }));
const TeamPage = lazy(async () => ({ default: (await import('./pages/Team')).Team }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/Settings')).Settings }));
const ManuscriptsPage = lazy(async () => ({ default: (await import('./pages/Manuscripts')).Manuscripts }));
const ArchivesPage = lazy(async () => ({ default: (await import('./pages/Archives')).Archives }));
const WanderPage = lazy(async () => ({ default: (await import('./pages/Wander')).Wander }));
const RedClawPage = lazy(async () => ({ default: (await import('./pages/RedClaw')).RedClaw }));
const MediaLibraryPage = lazy(async () => ({ default: (await import('./pages/MediaLibrary')).MediaLibrary }));
const CoverStudioPage = lazy(async () => ({ default: (await import('./pages/CoverStudio')).CoverStudio }));
const SubjectsPage = lazy(async () => ({ default: (await import('./pages/Subjects')).Subjects }));
const WorkboardPage = lazy(async () => ({ default: (await import('./pages/Workboard')).Workboard }));

export type ViewType = 'chat' | 'team' | 'skills' | 'knowledge' | 'settings' | 'manuscripts' | 'archives' | 'wander' | 'redclaw' | 'media-library' | 'cover-studio' | 'subjects' | 'workboard';
export type ImmersiveMode = false | 'theme' | 'dark';
export type TeamSection = 'group-chat' | 'members';

const PINNED_VIEWS: ViewType[] = [];
const MAX_CACHED_VIEWS = 0;
const NON_CACHEABLE_VIEWS = new Set<ViewType>([
  'chat',
  'team',
  'skills',
  'knowledge',
  'settings',
  'manuscripts',
  'archives',
  'wander',
  'redclaw',
  'media-library',
  'cover-studio',
  'subjects',
  'workboard',
]);
const CLIPBOARD_POLL_BOOT_DELAY_MS = 4000;
const OFFICIAL_AUTH_NOTICE_ENABLED = false;
const OFFICIAL_AUTH_NOTICE_TEXT = '当前账号登陆失效，请重新登陆。';
const OFFICIAL_AUTH_SNAPSHOT_KEYS = [
  'redbox-auth:display-session',
  'redbox-auth:panel-display',
] as const;

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

const CLIPBOARD_POLL_INTERVAL_MS = 3200;

interface YouTubeClipboardCandidate {
  videoId: string;
  videoUrl: string;
  rawUrl: string;
}

type StartupMigrationState = {
  status?: string;
  needsDbImport?: boolean;
  needsProjectUpgrade?: boolean;
  shouldShowModal?: boolean;
  legacyDbPath?: string | null;
  legacyWorkspacePath?: string | null;
  workspacePath?: string | null;
  currentStep?: string | null;
  message?: string | null;
  error?: string | null;
  progress?: number;
  legacyMarkdownCount?: number | null;
  importedCounts?: Record<string, number> | null;
  projectUpgradeCounts?: Record<string, number> | null;
};

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
  const next = new Set<ViewType>();
  const recent = history.slice(-MAX_CACHED_VIEWS);
  for (const view of recent) {
    if (!NON_CACHEABLE_VIEWS.has(view)) {
      next.add(view);
    }
  }
  return next;
}

function shouldRenderView(
  mountedViews: Set<ViewType>,
  currentView: ViewType,
  persistentViews: Set<ViewType>,
  view: ViewType,
): boolean {
  if (currentView === view || persistentViews.has(view)) {
    return true;
  }
  if (NON_CACHEABLE_VIEWS.has(view)) {
    return false;
  }
  return mountedViews.has(view);
}

function clearStaleOfficialAuthSnapshots(): boolean {
  let cleared = false;
  try {
    for (const key of OFFICIAL_AUTH_SNAPSHOT_KEYS) {
      if (window.localStorage.getItem(key) == null) continue;
      window.localStorage.removeItem(key);
      cleared = true;
    }
  } catch {
    return cleared;
  }
  return cleared;
}

function App() {
  useOfficialAuthLifecycle();

  const [currentView, setCurrentView] = useState<ViewType>('manuscripts');
  const [immersiveMode, setImmersiveMode] = useState<ImmersiveMode>(false);
  const [pendingChatMessage, setPendingChatMessage] = useState<PendingChatMessage | null>(null);
  const [pendingRedClawMessage, setPendingRedClawMessage] = useState<PendingChatMessage | null>(null);
  const [pendingManuscriptFile, setPendingManuscriptFile] = useState<string | null>(null);
  const [mountedViews, setMountedViews] = useState<Set<ViewType>>(() => computeMountedViews(['manuscripts']));
  const [persistentViews, setPersistentViews] = useState<Set<ViewType>>(() => new Set());
  const [clipboardCandidate, setClipboardCandidate] = useState<YouTubeClipboardCandidate | null>(null);
  const [isCapturePromptOpen, setIsCapturePromptOpen] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [captureMessage, setCaptureMessage] = useState('');
  const [startupMigration, setStartupMigration] = useState<StartupMigrationState | null>(null);
  const [startupMigrationBusy, setStartupMigrationBusy] = useState(false);
  const [startupMigrationDismissed, setStartupMigrationDismissed] = useState(false);
  const [globalAuthNotice, setGlobalAuthNotice] = useState<string | null>(null);

  const lastClipboardTextRef = useRef('');
  const clipboardPollingRef = useRef(false);
  const capturedYouTubeSetRef = useRef<Set<string>>(new Set());
  const viewHistoryRef = useRef<ViewType[]>(['manuscripts']);
  const capturePromptOpenRef = useRef(false);
  const captureStatusRef = useRef<'idle' | 'saving' | 'success' | 'error'>('idle');
  const lastAuthStatusRef = useRef('');

  useEffect(() => {
    viewHistoryRef.current = [...viewHistoryRef.current.filter((item) => item !== currentView), currentView];
    const nextMounted = computeMountedViews(viewHistoryRef.current);
    nextMounted.add(currentView);
    setMountedViews(nextMounted);
  }, [currentView]);

  useEffect(() => {
    let mounted = true;
    const handleAuthStateChanged = (event: { payload?: { status?: string } } | { status?: string } | null | undefined) => {
      const payload = (event && typeof event === 'object' && 'payload' in event)
        ? (event as { payload?: { status?: string } }).payload
        : (event as { status?: string } | null | undefined);
      const nextStatus = String((payload as { status?: string } | null | undefined)?.status || '');
      const prevStatus = lastAuthStatusRef.current;
      lastAuthStatusRef.current = nextStatus;
      if (!mounted) {
        return;
      }
      if (nextStatus === 'reauthRequired') {
        clearStaleOfficialAuthSnapshots();
        setGlobalAuthNotice(OFFICIAL_AUTH_NOTICE_ENABLED ? OFFICIAL_AUTH_NOTICE_TEXT : null);
        return;
      }
      if (nextStatus === 'anonymous') {
        const cleared = clearStaleOfficialAuthSnapshots();
        setGlobalAuthNotice(cleared && OFFICIAL_AUTH_NOTICE_ENABLED ? OFFICIAL_AUTH_NOTICE_TEXT : null);
        return;
      }
      if (prevStatus === 'reauthRequired') {
        setGlobalAuthNotice(null);
      }
      if (prevStatus === 'anonymous') {
        setGlobalAuthNotice(null);
      }
    };

    void window.ipcRenderer.auth.getState()
      .then((snapshot) => {
        if (!mounted) return;
        const nextStatus = String((snapshot as { status?: string } | null | undefined)?.status || '');
        lastAuthStatusRef.current = nextStatus;
        if (nextStatus === 'reauthRequired') {
          clearStaleOfficialAuthSnapshots();
          setGlobalAuthNotice(OFFICIAL_AUTH_NOTICE_ENABLED ? OFFICIAL_AUTH_NOTICE_TEXT : null);
          return;
        }
        if (nextStatus === 'anonymous') {
          const cleared = clearStaleOfficialAuthSnapshots();
          setGlobalAuthNotice(cleared && OFFICIAL_AUTH_NOTICE_ENABLED ? OFFICIAL_AUTH_NOTICE_TEXT : null);
          return;
        }
        setGlobalAuthNotice(null);
      })
      .catch(() => {});

    window.ipcRenderer.auth.onStateChanged(handleAuthStateChanged);
    return () => {
      mounted = false;
      window.ipcRenderer.auth.offStateChanged(handleAuthStateChanged);
    };
  }, []);

  useEffect(() => {
    if (currentView !== 'manuscripts' && immersiveMode) {
      setImmersiveMode(false);
    }
  }, [currentView, immersiveMode]);

  useEffect(() => {
    capturePromptOpenRef.current = isCapturePromptOpen;
  }, [isCapturePromptOpen]);

  useEffect(() => {
    captureStatusRef.current = captureStatus;
  }, [captureStatus]);

  // 导航到 Chat 页面并发送消息
  const navigateToChat = (message: PendingChatMessage) => {
    uiTraceInteraction('app', 'nav_to_chat', { to: 'chat' });
    setPendingChatMessage(message);
    setCurrentView('chat');
  };

  // Chat 页面消费消息后清除
  const clearPendingMessage = () => {
    setPendingChatMessage(null);
  };

  const navigateToRedClaw = (message: PendingChatMessage) => {
    uiTraceInteraction('app', 'nav_to_redclaw', { to: 'redclaw' });
    setPendingRedClawMessage(message);
    setCurrentView('redclaw');
  };

  const clearPendingRedClawMessage = () => {
    setPendingRedClawMessage(null);
  };

  // 导航到稿件页面并打开指定文件
  const navigateToManuscript = (filePath: string) => {
    uiTraceInteraction('app', 'nav_to_manuscripts', { to: 'manuscripts' });
    setPendingManuscriptFile(filePath);
    setCurrentView('manuscripts');
  };

  // 稿件页面消费后清除
  const clearPendingManuscriptFile = () => {
    setPendingManuscriptFile(null);
  };

  const setViewPersistent = useCallback((view: ViewType, persistent: boolean) => {
    setPersistentViews((prev) => {
      const alreadyPersistent = prev.has(view);
      if (alreadyPersistent === persistent) {
        return prev;
      }
      const next = new Set(prev);
      if (persistent) {
        next.add(view);
      } else {
        next.delete(view);
      }
      return next;
    });
  }, []);

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
          if (capturePromptOpenRef.current || captureStatusRef.current === 'saving') return;
          if (document.visibilityState !== 'visible') return;
          if (!document.hasFocus()) return;

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
  }, []);

  useEffect(() => {
    let disposed = false;

    const applyStatus = (value: unknown) => {
      if (disposed || !value || typeof value !== 'object') return;
      const next = value as StartupMigrationState;
      setStartupMigration(next);
      if (next.status === 'running') {
        setStartupMigrationBusy(true);
        setStartupMigrationDismissed(false);
      } else {
        setStartupMigrationBusy(false);
      }
    };

    void window.ipcRenderer.startupMigration.getStatus<StartupMigrationState>().then(applyStatus);
    const handleStatus = (_event: unknown, payload: unknown) => applyStatus(payload);
    window.ipcRenderer.on('app:startup-migration-status', handleStatus as (...args: unknown[]) => void);

    return () => {
      disposed = true;
      window.ipcRenderer.off('app:startup-migration-status', handleStatus as (...args: unknown[]) => void);
    };
  }, []);

  const shouldShowStartupMigration = Boolean(
    startupMigration
      && startupMigration.shouldShowModal
      && !startupMigrationDismissed
      && (
        startupMigration.status === 'running'
        || startupMigration.status === 'completed'
        || startupMigration.status === 'failed'
        || startupMigration.status === 'pending'
      ),
  );

  const handleStartStartupMigration = useCallback(async () => {
    setStartupMigrationBusy(true);
    setStartupMigrationDismissed(false);
    try {
      const next = await window.ipcRenderer.startupMigration.start<StartupMigrationState>();
      if (next && typeof next === 'object') {
        setStartupMigration(next);
      }
    } finally {
      setStartupMigrationBusy(false);
    }
  }, []);

  const handleCloseStartupMigration = useCallback(() => {
    if (startupMigration?.status === 'running') return;
    setStartupMigration((current) => {
      if (!current) return current;
      return {
        ...current,
        shouldShowModal: false,
      };
    });
    setStartupMigrationDismissed(true);
  }, [startupMigration?.status]);

  return (
    <>
      <Layout
        currentView={currentView}
        onNavigate={setCurrentView}
        immersiveMode={immersiveMode}
        globalNotice={globalAuthNotice}
      >
        {shouldRenderView(mountedViews, currentView, persistentViews, 'chat') && (
          <div className={currentView === 'chat' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'chat' ? <ViewLoadingFallback /> : null}>
              <ChatPage
                isActive={currentView === 'chat' || persistentViews.has('chat')}
                onExecutionStateChange={(active) => setViewPersistent('chat', active)}
                pendingMessage={pendingChatMessage}
                onMessageConsumed={clearPendingMessage}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'team') && (
          <div className={currentView === 'team' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'team' ? <ViewLoadingFallback /> : null}>
              <TeamPage
                isActive={currentView === 'team' || persistentViews.has('team')}
                onExecutionStateChange={(active) => setViewPersistent('team', active)}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'skills') && (
          <div className={currentView === 'skills' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'skills' ? <ViewLoadingFallback /> : null}>
              <SkillsPage isActive={currentView === 'skills'} />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'knowledge') && (
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
        {shouldRenderView(mountedViews, currentView, persistentViews, 'settings') && (
          <div className={currentView === 'settings' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'settings' ? <ViewLoadingFallback /> : null}>
              <SettingsPage isActive={currentView === 'settings'} />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'manuscripts') && (
          <div className={currentView === 'manuscripts' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'manuscripts' ? <ViewLoadingFallback /> : null}>
              <ManuscriptsPage
                pendingFile={pendingManuscriptFile}
                onFileConsumed={clearPendingManuscriptFile}
                onNavigateToRedClaw={navigateToRedClaw}
                isActive={currentView === 'manuscripts'}
                onImmersiveModeChange={setImmersiveMode}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'archives') && (
          <div className={currentView === 'archives' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'archives' ? <ViewLoadingFallback /> : null}>
              <ArchivesPage isActive={currentView === 'archives'} />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'wander') && (
          <div className={currentView === 'wander' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'wander' ? <ViewLoadingFallback /> : null}>
              <WanderPage
                onNavigateToManuscript={navigateToManuscript}
                onNavigateToRedClaw={navigateToRedClaw}
                onExecutionStateChange={(active) => setViewPersistent('wander', active)}
                isActive={currentView === 'wander'}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'redclaw') && (
          <div className={currentView === 'redclaw' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'redclaw' ? <ViewLoadingFallback /> : null}>
              <RedClawPage
                pendingMessage={pendingRedClawMessage}
                onPendingMessageConsumed={clearPendingRedClawMessage}
                isActive={currentView === 'redclaw' || persistentViews.has('redclaw')}
                onExecutionStateChange={(active) => setViewPersistent('redclaw', active)}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'subjects') && (
          <div className={currentView === 'subjects' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'subjects' ? <ViewLoadingFallback /> : null}>
              <SubjectsPage isActive={currentView === 'subjects'} />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'media-library') && (
          <div className={currentView === 'media-library' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'media-library' ? <ViewLoadingFallback /> : null}>
              <MediaLibraryPage isActive={currentView === 'media-library'} />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'cover-studio') && (
          <div className={currentView === 'cover-studio' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'cover-studio' ? <ViewLoadingFallback /> : null}>
              <CoverStudioPage isActive={currentView === 'cover-studio'} />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'workboard') && (
          <div className={currentView === 'workboard' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'workboard' ? <ViewLoadingFallback /> : null}>
              <WorkboardPage isActive={currentView === 'workboard'} />
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
      <StartupMigrationModal
        open={shouldShowStartupMigration}
        state={startupMigration}
        busy={startupMigrationBusy}
        onStart={() => void handleStartStartupMigration()}
        onClose={handleCloseStartupMigration}
      />
      <FirstRunTour currentView={currentView} onNavigate={setCurrentView} />
      <AppDialogsHost />
    </>
  );
}

export default App;
