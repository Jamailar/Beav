import { useState, useEffect, useRef, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { AppDialogsHost } from './components/AppDialogsHost';
import { Layout } from './components/Layout';
import { FirstRunTour } from './components/FirstRunTour';
import { StartupMigrationModal } from './components/StartupMigrationModal';
import { useOfficialAuthLifecycle } from './hooks/useOfficialAuthLifecycle';
import { NotificationsHost } from './notifications/NotificationsHost';
import { REDBOX_NAVIGATE_EVENT } from './notifications/types';
import { RedClawOnboardingFlowHost } from './pages/redclaw/RedClawOnboardingFlowHost';
import { useI18n } from './i18n';
import type { AuthoringTaskHints } from './utils/redclawAuthoring';
import { uiTraceInteraction } from './utils/uiDebug';

const HomePage = lazy(async () => ({ default: (await import('./pages/Home')).Home }));
const SkillsPage = lazy(async () => ({ default: (await import('./pages/Skills')).Skills }));
const KnowledgePage = lazy(async () => ({ default: (await import('./pages/Knowledge')).Knowledge }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/Settings')).Settings }));
const ArchivesPage = lazy(async () => ({ default: (await import('./pages/Archives')).Archives }));
const WanderPage = lazy(async () => ({ default: (await import('./pages/Wander')).Wander }));
const RedClawPage = lazy(async () => ({ default: (await import('./pages/RedClaw')).RedClaw }));
const MediaLibraryPage = lazy(async () => ({ default: (await import('./pages/MediaLibrary')).MediaLibrary }));
const CoverStudioPage = lazy(async () => ({ default: (await import('./pages/CoverStudio')).CoverStudio }));
const GenerationStudioPage = lazy(async () => ({ default: (await import('./pages/GenerationStudio')).GenerationStudio }));
const SubjectsPage = lazy(async () => ({ default: (await import('./pages/Subjects')).Subjects }));
const AutomationPage = lazy(async () => ({ default: (await import('./pages/Automation')).Automation }));

export type ViewType = 'home' | 'skills' | 'knowledge' | 'settings' | 'archives' | 'wander' | 'redclaw' | 'media-library' | 'cover-studio' | 'generation-studio' | 'subjects' | 'automation';
export type ImmersiveMode = false | 'theme' | 'dark';
export type TeamSection = 'team-workbench' | 'members';
type SettingsNavigationTarget = {
  tab?: 'general' | 'ai' | 'tools' | 'profile' | 'remote' | 'experimental';
  aiModelSubTab?: 'custom' | 'login';
  nonce: number;
};
type RedClawNavigationAction = {
  action: 'new' | 'open-team';
  sessionId?: string;
  nonce: number;
};

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shouldAutoOpenTeamSession(session: Record<string, unknown>): boolean {
  const status = String(session.status || '').trim().toLowerCase();
  if (status === 'archived' || status === 'completed') return false;
  const source = String(session.source || '').trim().toLowerCase();
  const metadata = recordFromUnknown(session.metadata);
  const surface = String(metadata.surface || '').trim().toLowerCase();
  if (surface === 'redclaw' || source === 'team-workbench') return false;
  return source === 'real-subagent-orchestration'
    || source === 'ai_coordinator'
    || source === 'internal'
    || Boolean(metadata.sourceTaskId || metadata.intent || metadata.recommendedRole);
}

const PINNED_VIEWS: ViewType[] = [];
const MAX_CACHED_VIEWS = 0;
const NON_CACHEABLE_VIEWS = new Set<ViewType>([
  'home',
  'skills',
  'knowledge',
  'settings',
  'archives',
  'wander',
  'redclaw',
  'media-library',
  'cover-studio',
  'generation-studio',
  'subjects',
  'automation',
]);
const CLIPBOARD_POLL_BOOT_DELAY_MS = 4000;
const OFFICIAL_AUTH_NOTICE_ENABLED = false;
const OFFICIAL_AUTH_SNAPSHOT_KEYS = [
  'redbox-auth:panel-display',
] as const;

// 待发送的聊天消息（用于跨页面传递）
export interface PendingChatMessage {
  content: string;          // 实际发送给 AI 的完整内容
  displayContent?: string;  // UI 上显示的简短内容
  sessionRouting?: 'current' | 'new';
  deliveryMode?: 'send' | 'draft';
  taskHints?: AuthoringTaskHints;
  knowledgeReferences?: Array<{
    id: string;
    title: string;
    sourceKind?: string;
    summary?: string;
    cover?: string;
    sourceUrl?: string;
    folderPath?: string;
    rootPath?: string;
    tags?: string[];
    updatedAt?: string;
    fileCount?: number;
    hasTranscript?: boolean;
  }>;
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
  } | {
    type: 'uploaded-file';
    name: string;
    ext?: string;
    size?: number;
    thumbnailDataUrl?: string;
    inlineDataUrl?: string;
    workspaceRelativePath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    kind?: 'text' | 'image' | 'audio' | 'video' | 'binary' | string;
    mimeType?: string;
    storageMode?: 'staged' | string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: 'direct-input' | 'tool-read';
    summary?: string;
    requiresMultimodal?: boolean;
  };
}

export interface GenerationIntent {
  mode: 'image' | 'video';
  source: 'standalone' | 'media-library' | 'manuscripts' | 'cover-studio';
  sourceTitle?: string;
  bindTarget?: {
    manuscriptPath?: string;
    projectId?: string;
  };
  preset?: {
    aspectRatio?: string;
    resolution?: '720p' | '1080p';
    durationSeconds?: number;
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
  const { t } = useI18n();
  return (
    <div className="h-full min-h-0 flex items-center justify-center text-text-tertiary">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      {t('app.loadingPage')}
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
  const { t } = useI18n();
  useOfficialAuthLifecycle();

  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [immersiveMode, setImmersiveMode] = useState<ImmersiveMode>(false);
  const [redclawOnboardingOpen, setRedclawOnboardingOpen] = useState(false);
  const [redclawOnboardingVersion, setRedclawOnboardingVersion] = useState(0);
  const [pendingRedClawMessage, setPendingRedClawMessage] = useState<PendingChatMessage | null>(null);
  const [redClawGlobalSidebarContent, setRedClawGlobalSidebarContent] = useState<ReactNode>(null);
  const [pendingGenerationIntent, setPendingGenerationIntent] = useState<GenerationIntent | null>(null);
  const [mountedViews, setMountedViews] = useState<Set<ViewType>>(() => computeMountedViews(['home']));
  const [persistentViews, setPersistentViews] = useState<Set<ViewType>>(() => new Set());
  const [clipboardCandidate, setClipboardCandidate] = useState<YouTubeClipboardCandidate | null>(null);
  const [isCapturePromptOpen, setIsCapturePromptOpen] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [captureMessage, setCaptureMessage] = useState('');
  const [startupMigration, setStartupMigration] = useState<StartupMigrationState | null>(null);
  const [startupMigrationBusy, setStartupMigrationBusy] = useState(false);
  const [startupMigrationDismissed, setStartupMigrationDismissed] = useState(false);
  const [globalAuthNotice, setGlobalAuthNotice] = useState<string | null>(null);
  const [settingsNavigationTarget, setSettingsNavigationTarget] = useState<SettingsNavigationTarget | null>(null);
  const [redClawNavigationAction, setRedClawNavigationAction] = useState<RedClawNavigationAction | null>(null);
  const [wanderTitleBarContent, setWanderTitleBarContent] = useState<ReactNode>(null);
  const [knowledgeTitleBarContent, setKnowledgeTitleBarContent] = useState<ReactNode>(null);

  const lastClipboardTextRef = useRef('');
  const clipboardPollingRef = useRef(false);
  const capturedYouTubeSetRef = useRef<Set<string>>(new Set());
  const viewHistoryRef = useRef<ViewType[]>(['home']);
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
        setGlobalAuthNotice(OFFICIAL_AUTH_NOTICE_ENABLED ? t('app.authExpired') : null);
        return;
      }
      if (nextStatus === 'anonymous') {
        const cleared = clearStaleOfficialAuthSnapshots();
        setGlobalAuthNotice(cleared && OFFICIAL_AUTH_NOTICE_ENABLED ? t('app.authExpired') : null);
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
          setGlobalAuthNotice(OFFICIAL_AUTH_NOTICE_ENABLED ? t('app.authExpired') : null);
          return;
        }
        if (nextStatus === 'anonymous') {
          const cleared = clearStaleOfficialAuthSnapshots();
          setGlobalAuthNotice(cleared && OFFICIAL_AUTH_NOTICE_ENABLED ? t('app.authExpired') : null);
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
  }, [t]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{
        view?: ViewType;
        settingsTab?: SettingsNavigationTarget['tab'];
        aiModelSubTab?: SettingsNavigationTarget['aiModelSubTab'];
        redclawAction?: RedClawNavigationAction['action'];
        teamSessionId?: string;
      }>).detail;
      const nextView = detail?.view;
      if (!nextView) return;
      if (nextView === 'settings') {
        setSettingsNavigationTarget({
          tab: detail.settingsTab,
          aiModelSubTab: detail.aiModelSubTab,
          nonce: Date.now(),
        });
      }
      if (nextView === 'redclaw' && detail.redclawAction === 'new') {
        setRedClawNavigationAction({
          action: 'new',
          nonce: Date.now(),
        });
      }
      if (nextView === 'redclaw' && detail.redclawAction === 'open-team' && detail.teamSessionId) {
        setRedClawNavigationAction({
          action: 'open-team',
          sessionId: detail.teamSessionId,
          nonce: Date.now(),
        });
      }
      setCurrentView(nextView);
    };

    window.addEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => {
      window.removeEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    };
  }, []);

  useEffect(() => {
    const openedSessionIds = new Set<string>();
    const handleTeamRuntimeEvent = (event: { eventType?: string; payload?: unknown }) => {
      if (event.eventType !== 'runtime:collab-session-changed') return;
      const payload = recordFromUnknown(event.payload);
      const session = recordFromUnknown(payload.session);
      const sessionId = String(session.id || payload.collabSessionId || '').trim();
      if (!sessionId || openedSessionIds.has(sessionId)) return;
      if (!shouldAutoOpenTeamSession(session)) return;
      openedSessionIds.add(sessionId);
      setRedClawNavigationAction({
        action: 'open-team',
        sessionId,
        nonce: Date.now(),
      });
      setCurrentView('redclaw');
    };

    window.ipcRenderer.teamRuntime.onEvent(handleTeamRuntimeEvent);
    return () => {
      window.ipcRenderer.teamRuntime.offEvent(handleTeamRuntimeEvent);
    };
  }, []);

  useEffect(() => {
    capturePromptOpenRef.current = isCapturePromptOpen;
  }, [isCapturePromptOpen]);

  useEffect(() => {
    captureStatusRef.current = captureStatus;
  }, [captureStatus]);

  const openRedClawOnboarding = useCallback(() => {
    setRedclawOnboardingOpen(true);
  }, []);

  const navigateToRedClaw = (message: PendingChatMessage) => {
    uiTraceInteraction('app', 'nav_to_redclaw', { to: 'redclaw' });
    setPendingRedClawMessage(message);
    setCurrentView('redclaw');
  };

  const clearPendingRedClawMessage = () => {
    setPendingRedClawMessage(null);
  };

  const clearRedClawNavigationAction = () => {
    setRedClawNavigationAction(null);
  };

  const navigateToGenerationStudio = (intent: GenerationIntent) => {
    uiTraceInteraction('app', 'nav_to_generation_studio', { to: 'generation-studio', mode: intent.mode, source: intent.source });
    setPendingGenerationIntent(intent);
    setCurrentView('generation-studio');
  };

  const clearPendingGenerationIntent = () => {
    setPendingGenerationIntent(null);
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

  const handleWanderExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('wander', active);
  }, [setViewPersistent]);

  const handleRedClawExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('redclaw', active);
  }, [setViewPersistent]);

  const handleGenerationStudioExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('generation-studio', active);
  }, [setViewPersistent]);

  const handleCoverStudioExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('cover-studio', active);
  }, [setViewPersistent]);

  const returnHomeFromEmbeddedTool = useCallback(() => {
    setCurrentView('home');
  }, []);

  const returnFromSettings = useCallback(() => {
    const previousView = [...viewHistoryRef.current].reverse().find((view) => view !== 'settings') || 'home';
    setCurrentView(previousView);
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
  const effectiveImmersiveMode: ImmersiveMode = currentView === 'subjects' ? 'theme' : immersiveMode;

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
        immersiveMode={effectiveImmersiveMode}
        hideGlobalSidebar={currentView === 'settings'}
        globalNotice={globalAuthNotice}
        globalSidebarContent={redClawGlobalSidebarContent}
        renderTitleBarContent={({ currentView }) => {
          if (currentView === 'wander') return wanderTitleBarContent;
          if (currentView === 'knowledge') return knowledgeTitleBarContent;
          return null;
        }}
      >
        {shouldRenderView(mountedViews, currentView, persistentViews, 'home') && (
          <div className={currentView === 'home' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'home' ? <ViewLoadingFallback /> : null}>
              <HomePage
                isActive={currentView === 'home'}
                onNavigateToCoverStudio={() => setCurrentView('cover-studio')}
                onNavigateToGenerationStudio={(mode) => navigateToGenerationStudio({ mode, source: 'standalone' })}
                onNavigateToRedClaw={navigateToRedClaw}
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
                onNavigateToRedClaw={navigateToRedClaw}
                isActive={currentView === 'knowledge'}
                onTitleBarContentChange={setKnowledgeTitleBarContent}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'settings') && (
          <div className={currentView === 'settings' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'settings' ? <ViewLoadingFallback /> : null}>
              <SettingsPage
                isActive={currentView === 'settings'}
                onOpenRedClawOnboarding={openRedClawOnboarding}
                redclawOnboardingVersion={redclawOnboardingVersion}
                navigationTarget={settingsNavigationTarget}
                onReturn={returnFromSettings}
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
                onNavigateToRedClaw={navigateToRedClaw}
                onExecutionStateChange={handleWanderExecutionStateChange}
                onTitleBarContentChange={setWanderTitleBarContent}
                isActive={currentView === 'wander'}
              />
            </Suspense>
          </div>
        )}
        {(currentView !== 'redclaw' || shouldRenderView(mountedViews, currentView, persistentViews, 'redclaw')) && (
          <div className={currentView === 'redclaw' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'redclaw' ? <ViewLoadingFallback /> : null}>
              <RedClawPage
                pendingMessage={pendingRedClawMessage}
                onPendingMessageConsumed={clearPendingRedClawMessage}
                navigationAction={redClawNavigationAction}
                onNavigationActionConsumed={clearRedClawNavigationAction}
                isActive={currentView === 'redclaw' || persistentViews.has('redclaw')}
                onExecutionStateChange={handleRedClawExecutionStateChange}
                onOpenRedClawOnboarding={openRedClawOnboarding}
                redclawOnboardingVersion={redclawOnboardingVersion}
                onGlobalSidebarContentChange={setRedClawGlobalSidebarContent}
                onOpenChatSurface={() => setCurrentView('redclaw')}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'subjects') && (
          <div className={currentView === 'subjects' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'subjects' ? <ViewLoadingFallback /> : null}>
              <SubjectsPage
                isActive={currentView === 'subjects'}
                onReturnHome={() => setCurrentView('home')}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'media-library') && (
          <div className={currentView === 'media-library' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'media-library' ? <ViewLoadingFallback /> : null}>
              <MediaLibraryPage
                isActive={currentView === 'media-library'}
                onNavigateToGenerationStudio={navigateToGenerationStudio}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'cover-studio') && (
          <div className={currentView === 'cover-studio' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'cover-studio' ? <ViewLoadingFallback /> : null}>
              <CoverStudioPage
                isActive={currentView === 'cover-studio' || persistentViews.has('cover-studio')}
                onExecutionStateChange={handleCoverStudioExecutionStateChange}
                onReturnHome={returnHomeFromEmbeddedTool}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'generation-studio') && (
          <div className={currentView === 'generation-studio' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'generation-studio' ? <ViewLoadingFallback /> : null}>
              <GenerationStudioPage
                isActive={currentView === 'generation-studio' || persistentViews.has('generation-studio')}
                pendingIntent={pendingGenerationIntent}
                onIntentConsumed={clearPendingGenerationIntent}
                onExecutionStateChange={handleGenerationStudioExecutionStateChange}
                onReturnHome={returnHomeFromEmbeddedTool}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'automation') && (
          <div className={currentView === 'automation' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'automation' ? <ViewLoadingFallback /> : null}>
              <AutomationPage isActive={currentView === 'automation'} />
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
                <h3 className="text-base font-semibold text-text-primary">{t('app.youtubeDetected')}</h3>
                <p className="text-sm text-text-secondary mt-1">{t('app.youtubeCaptureDescription')}</p>
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
                {t('app.cancel')}
              </button>
              <button
                onClick={() => void confirmCaptureFromClipboard()}
                disabled={captureStatus === 'saving'}
                className="h-9 px-4 rounded-md bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {captureStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('app.confirmCapture')}
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
      <RedClawOnboardingFlowHost
        open={redclawOnboardingOpen}
        onClose={() => setRedclawOnboardingOpen(false)}
        onCompleted={() => {
          setRedclawOnboardingOpen(false);
          setRedclawOnboardingVersion((value) => value + 1);
        }}
      />
      <FirstRunTour currentView={currentView} onNavigate={setCurrentView} />
      <NotificationsHost currentView={currentView} />
      <AppDialogsHost />
    </>
  );
}

export default App;
