import { useState, useEffect, useRef, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { FileText, Link2, Loader2, MessageSquareWarning, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { AppDialogsHost } from './components/AppDialogsHost';
import { Layout } from './components/Layout';
import { AppOnboarding, hasSeenAppOnboarding, markAppOnboardingSeen } from './components/AppOnboarding';
import { StartupMigrationModal } from './components/StartupMigrationModal';
import { FeedbackReportDialog, OPEN_FEEDBACK_REPORT_EVENT, type FeedbackReportContext } from './components/FeedbackReportDialog';
import { useOfficialAuthLifecycle } from './hooks/useOfficialAuthLifecycle';
import { useOfficialAuthState } from './hooks/useOfficialAuthState';
import { NotificationsHost } from './notifications/NotificationsHost';
import { REDBOX_NAVIGATE_EVENT } from './notifications/types';
import { RedClawOnboardingFlowHost } from './pages/redclaw/RedClawOnboardingFlowHost';
import { useI18n } from './i18n';
import { APP_BRAND } from './config/brand';
import googleIcon from './assets/auth/google.svg';
import wechatIcon from './assets/auth/wechat.svg';
import type { AuthoringTaskHints } from './utils/redclawAuthoring';
import { uiTraceInteraction } from './utils/uiDebug';

const HomePage = lazy(async () => ({ default: (await import('./pages/Home')).Home }));
const SkillsPage = lazy(async () => ({ default: (await import('./pages/Skills')).Skills }));
const KnowledgePage = lazy(async () => ({ default: (await import('./pages/Knowledge')).Knowledge }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/Settings')).Settings }));
const ManuscriptEditorHost = lazy(async () => ({ default: (await import('./components/manuscripts/ManuscriptEditorHost')).ManuscriptEditorHost }));
const ArchivesPage = lazy(async () => ({ default: (await import('./pages/Archives')).Archives }));
const WanderPage = lazy(async () => ({ default: (await import('./pages/Wander')).Wander }));
const RedClawPage = lazy(async () => ({ default: (await import('./pages/RedClaw')).RedClaw }));
const MediaLibraryPage = lazy(async () => ({ default: (await import('./pages/MediaLibrary')).MediaLibrary }));
const CoverStudioPage = lazy(async () => ({ default: (await import('./pages/CoverStudio')).CoverStudio }));
const GenerationStudioPage = lazy(async () => ({ default: (await import('./pages/GenerationStudio')).GenerationStudio }));
const SubjectsPage = lazy(async () => ({ default: (await import('./pages/Subjects')).Subjects }));
const AutomationPage = lazy(async () => ({ default: (await import('./pages/Automation')).Automation }));
const ApprovalPage = lazy(async () => ({ default: (await import('./pages/Approval')).Approval }));

export type ViewType = 'home' | 'skills' | 'knowledge' | 'settings' | 'archives' | 'wander' | 'redclaw' | 'media-library' | 'cover-studio' | 'generation-studio' | 'subjects' | 'automation' | 'approval';
export type ImmersiveMode = false | 'theme' | 'dark';
export type TeamSection = 'team-workbench' | 'members';
type SettingsNavigationTarget = {
  tab?: 'general' | 'ai' | 'tools' | 'profile' | 'remote' | 'experimental';
  aiModelSubTab?: 'custom' | 'login';
  nonce: number;
};
type RedClawNavigationAction = {
  action: 'new' | 'open-team' | 'open-session';
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
  'approval',
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
    attachmentId?: string;
    type: 'uploaded-file';
    name: string;
    ext?: string;
    size?: number;
    thumbnailDataUrl?: string;
    inlineDataUrl?: string;
    workspaceRelativePath?: string;
    toolPath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    kind?: 'text' | 'image' | 'audio' | 'video' | 'document' | 'binary' | string;
    mimeType?: string;
    storageMode?: 'staged' | string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: 'direct-input' | 'tool-read';
    intakeStatus?: 'ready' | 'unsupported' | 'failed' | string;
    capabilities?: Record<string, boolean | undefined>;
    deliveryPlan?: {
      mode?: string;
      toolPath?: string;
      toolName?: string;
      requiresTool?: boolean;
      reason?: string;
    };
    summary?: string;
    requiresMultimodal?: boolean;
  };
  attachments?: Array<{
    type: 'uploaded-file';
    name: string;
    attachmentId?: string;
    workspaceRelativePath?: string;
    toolPath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    inlineDataUrl?: string;
    thumbnailDataUrl?: string;
    kind?: string;
    mimeType?: string;
    size?: number;
    ext?: string;
    storageMode?: string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: string;
    intakeStatus?: string;
    capabilities?: Record<string, boolean | undefined>;
    deliveryPlan?: Record<string, unknown>;
    summary?: string;
    requiresMultimodal?: boolean;
    attachmentLifecycle?: string;
  }>;
}

export interface GenerationIntent {
  mode: 'image' | 'video' | 'audio';
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

function AuthenticatedApp({ onOpenAppOnboarding }: { onOpenAppOnboarding: () => void }) {
  const { t } = useI18n();

  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [immersiveMode, setImmersiveMode] = useState<ImmersiveMode>(false);
  const [redclawOnboardingOpen, setRedclawOnboardingOpen] = useState(false);
  const [redclawOnboardingVersion, setRedclawOnboardingVersion] = useState(0);
  const [pendingRedClawMessage, setPendingRedClawMessage] = useState<PendingChatMessage | null>(null);
  const [redClawGlobalSidebarContent, setRedClawGlobalSidebarContent] = useState<ReactNode>(null);
  const [redClawTitleBarActions, setRedClawTitleBarActions] = useState<ReactNode>(null);
  const [subjectsModalOpen, setSubjectsModalOpen] = useState(false);
  const [activeManuscriptEditorFile, setActiveManuscriptEditorFile] = useState<string | null>(null);
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
  const [feedbackReportOpen, setFeedbackReportOpen] = useState(false);
  const [feedbackReportContext, setFeedbackReportContext] = useState<FeedbackReportContext | null>(null);
  const [settingsNavigationTarget, setSettingsNavigationTarget] = useState<SettingsNavigationTarget | null>(null);
  const [redClawNavigationAction, setRedClawNavigationAction] = useState<RedClawNavigationAction | null>(null);
  const [wanderTitleBarContent, setWanderTitleBarContent] = useState<ReactNode>(null);
  const [knowledgeTitleBarContent, setKnowledgeTitleBarContent] = useState<ReactNode>(null);
  const [approvalTargetDocketId, setApprovalTargetDocketId] = useState('');

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

  const openSubjectsModal = useCallback(() => {
    setSubjectsModalOpen(true);
  }, []);

  const closeSubjectsModal = useCallback(() => {
    setSubjectsModalOpen(false);
  }, []);

  const navigateToView = useCallback((view: ViewType) => {
    if (view === 'subjects') {
      openSubjectsModal();
      return;
    }
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
    setCurrentView(view);
  }, [openSubjectsModal]);

  const openFeedbackReport = useCallback((context?: FeedbackReportContext | null) => {
    setFeedbackReportContext({
      sourcePage: currentView,
      ...(context || {}),
    });
    setFeedbackReportOpen(true);
  }, [currentView]);

  useEffect(() => {
    const handleOpenFeedbackReport = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      openFeedbackReport(detail && typeof detail === 'object' ? detail as FeedbackReportContext : null);
    };
    window.addEventListener(OPEN_FEEDBACK_REPORT_EVENT, handleOpenFeedbackReport);
    return () => window.removeEventListener(OPEN_FEEDBACK_REPORT_EVENT, handleOpenFeedbackReport);
  }, [openFeedbackReport]);

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
        docketId?: string;
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
        setActiveManuscriptEditorFile(null);
        setRedClawNavigationAction({
          action: 'new',
          nonce: Date.now(),
        });
      }
      if (nextView === 'redclaw' && detail.redclawAction === 'open-team' && detail.teamSessionId) {
        setActiveManuscriptEditorFile(null);
        setRedClawNavigationAction({
          action: 'open-team',
          sessionId: detail.teamSessionId,
          nonce: Date.now(),
        });
      }
      if (nextView === 'approval') {
        setApprovalTargetDocketId(String(detail.docketId || ''));
      }
      navigateToView(nextView);
    };

    window.addEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => {
      window.removeEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    };
  }, [navigateToView]);

  useEffect(() => {
    if (!subjectsModalOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSubjectsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [subjectsModalOpen]);

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

  const navigateToManuscript = (filePath: string) => {
    uiTraceInteraction('app', 'open_manuscript_editor', { sourceView: currentView });
    setActiveManuscriptEditorFile(filePath);
    setCurrentView('redclaw');
  };

  const closeManuscriptEditor = () => {
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
  };

  const openRedClawChatSurface = useCallback(() => {
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
    setCurrentView('redclaw');
  }, []);

  const openRedClawSession = useCallback((sessionId: string) => {
    const nextSessionId = String(sessionId || '').trim();
    if (!nextSessionId) return;
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
    setRedClawNavigationAction({
      action: 'open-session',
      sessionId: nextSessionId,
      nonce: Date.now(),
    });
    setCurrentView('redclaw');
  }, []);

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
  const isManuscriptEditorActive = currentView === 'redclaw' && Boolean(activeManuscriptEditorFile);
  const effectiveImmersiveMode: ImmersiveMode = isManuscriptEditorActive ? false : immersiveMode;

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
        onNavigate={navigateToView}
        immersiveMode={effectiveImmersiveMode}
        hideGlobalSidebar={currentView === 'settings'}
        globalNotice={globalAuthNotice}
        globalSidebarContent={redClawGlobalSidebarContent}
        activeModalView={subjectsModalOpen ? 'subjects' : undefined}
        renderTitleBarContent={({ currentView }) => {
          if (isManuscriptEditorActive) {
            return (
              <div className="inline-flex min-w-0 items-center gap-2 text-[12px] font-semibold text-text-secondary">
                <FileText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                <span className="truncate">稿件编辑器</span>
              </div>
            );
          }
          if (currentView === 'wander') return wanderTitleBarContent;
          if (currentView === 'knowledge') return knowledgeTitleBarContent;
          return null;
        }}
        renderTitleBarActions={({ currentView }) => (
          <>
            {currentView === 'redclaw' && !isManuscriptEditorActive ? redClawTitleBarActions : null}
            <button
              type="button"
              onClick={() => openFeedbackReport({ sourcePage: currentView })}
              className="app-titlebar-button"
              title="反馈问题"
              aria-label="反馈问题"
            >
              <MessageSquareWarning className="w-[13px] h-[13px]" strokeWidth={1.75} />
            </button>
          </>
        )}
      >
        {isManuscriptEditorActive && activeManuscriptEditorFile && (
          <div className="h-full min-h-0 flex flex-col overflow-hidden">
            <Suspense fallback={<ViewLoadingFallback />}>
              <ManuscriptEditorHost
                filePath={activeManuscriptEditorFile}
                onNavigateToRedClaw={navigateToRedClaw}
                onNavigateToGenerationStudio={navigateToGenerationStudio}
                isActive={true}
                onClose={closeManuscriptEditor}
                onImmersiveModeChange={setImmersiveMode}
              />
            </Suspense>
          </div>
        )}
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
                onOpenAppOnboarding={onOpenAppOnboarding}
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
          <div className={currentView === 'redclaw' && !isManuscriptEditorActive ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
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
                onTitleBarActionsChange={setRedClawTitleBarActions}
                onOpenChatSurface={openRedClawChatSurface}
                onOpenManuscriptEditor={navigateToManuscript}
                activeManuscriptPath={activeManuscriptEditorFile}
                titleBarActive={currentView === 'redclaw' && !isManuscriptEditorActive}
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
              <AutomationPage
                isActive={currentView === 'automation'}
                onOpenRedClawSession={openRedClawSession}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'approval') && (
          <div className={currentView === 'approval' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'approval' ? <ViewLoadingFallback /> : null}>
              <ApprovalPage
                isActive={currentView === 'approval'}
                targetDocketId={approvalTargetDocketId}
              />
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
                className="h-9 px-4 rounded-md bg-[rgb(var(--color-accent-primary))] text-white text-sm hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-50 inline-flex items-center gap-2"
              >
                {captureStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('app.confirmCapture')}
              </button>
            </div>
          </div>
        </div>
      )}
      {subjectsModalOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="资产库"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeSubjectsModal();
            }
          }}
        >
          <div className="h-[min(860px,calc(100vh-48px))] w-[min(1180px,calc(100vw-40px))] overflow-hidden rounded-2xl bg-white shadow-2xl">
            <Suspense fallback={<ViewLoadingFallback />}>
              <SubjectsPage
                isActive={subjectsModalOpen}
                variant="modal"
                onClose={closeSubjectsModal}
              />
            </Suspense>
          </div>
        </div>
      )}
      <FeedbackReportDialog
        open={feedbackReportOpen}
        context={feedbackReportContext}
        onClose={() => setFeedbackReportOpen(false)}
        onSubmitted={() => window.dispatchEvent(new CustomEvent('redbox:feedback-report-submitted'))}
      />
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
      <NotificationsHost currentView={currentView} />
      <AppDialogsHost />
    </>
  );
}

type OfficialAuthGateMode = 'checking' | 'login' | 'expired';
type LoginNoticeType = 'idle' | 'success' | 'error';
type OfficialAuthRealm = 'cn' | 'global';

function isOfficialAuthLoggedIn(
  snapshot: Awaited<ReturnType<typeof window.ipcRenderer.auth.getState>> | null,
  bootstrapped: boolean,
): boolean {
  if (!bootstrapped || !snapshot?.loggedIn) return false;
  const status = String(snapshot.status || '').trim();
  return status !== 'anonymous'
    && status !== 'reauthRequired'
    && status !== 'restoring'
    && status !== 'refreshing';
}

function isLikelyImageUrl(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('data:image/')
    || normalized.startsWith('blob:')
    || /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?(#.*)?$/i.test(normalized);
}

async function buildWechatQrDataUrl(value: string): Promise<string> {
  const content = String(value || '').trim();
  if (!content) {
    throw new Error('二维码内容为空');
  }
  if (isLikelyImageUrl(content)) {
    return content;
  }
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 420,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  });
}

function OfficialLoginGate({ mode }: { mode: OfficialAuthGateMode }) {
  const [activeRealm, setActiveRealm] = useState<OfficialAuthRealm>('cn');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsForm, setSmsForm] = useState({ phone: '', code: '', inviteCode: '' });
  const [wechatBusy, setWechatBusy] = useState(false);
  const [wechatQrUrl, setWechatQrUrl] = useState('');
  const [wechatStatus, setWechatStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<LoginNoticeType>('idle');
  const wechatSessionIdRef = useRef('');
  const wechatPollTimerRef = useRef<number | null>(null);
  const wechatPollTokenRef = useRef(0);

  const setLoginNotice = useCallback((type: LoginNoticeType, message: string) => {
    setNoticeType(type);
    setNotice(message);
  }, []);

  const refreshAuthAfterLogin = useCallback(() => {
    void window.ipcRenderer.officialAuth.bootstrap({ reason: 'login-gate-authenticated' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async () => {
      try {
        const result = await window.ipcRenderer.invoke('redbox-auth:get-config') as {
          success?: boolean;
          activeRealm?: OfficialAuthRealm;
        };
        if (!cancelled && result?.success) {
          setActiveRealm(result.activeRealm === 'global' ? 'global' : 'cn');
        }
      } catch {
        if (!cancelled) {
          setActiveRealm('cn');
        }
      }
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const stopWechatPolling = useCallback(() => {
    wechatPollTokenRef.current += 1;
    if (wechatPollTimerRef.current !== null) {
      window.clearTimeout(wechatPollTimerRef.current);
      wechatPollTimerRef.current = null;
    }
  }, []);

  const pollWechatStatus = useCallback((sessionId: string, token: number) => {
    const run = async () => {
      if (wechatPollTokenRef.current !== token) return;
      try {
        const result = await window.ipcRenderer.invoke('redbox-auth:wechat-status', { sessionId }) as {
          success?: boolean;
          data?: {
            status?: string;
            session?: unknown;
          };
          error?: string;
        };
        if (!result?.success) {
          throw new Error(result?.error || '微信登录状态检查失败');
        }

        const nextStatus = String(result.data?.status || '').toUpperCase();
        setWechatStatus(nextStatus);
        if (nextStatus === 'CONFIRMED') {
          stopWechatPolling();
          setLoginNotice('success', '登录成功，正在进入工作台…');
          refreshAuthAfterLogin();
          return;
        }
        if (nextStatus === 'EXPIRED' || nextStatus === 'FAILED') {
          stopWechatPolling();
          setLoginNotice('error', nextStatus === 'EXPIRED' ? '二维码已过期，请重新获取。' : '微信登录失败，请重试。');
          return;
        }
      } catch (error) {
        setWechatStatus('FAILED');
        setLoginNotice('error', error instanceof Error ? error.message : '微信登录状态检查失败');
      }

      if (wechatPollTokenRef.current === token) {
        wechatPollTimerRef.current = window.setTimeout(run, 900);
      }
    };

    wechatPollTimerRef.current = window.setTimeout(run, 300);
  }, [refreshAuthAfterLogin, setLoginNotice, stopWechatPolling]);

  useEffect(() => {
    return () => stopWechatPolling();
  }, [stopWechatPolling]);

  const startWechatLogin = useCallback(async () => {
    setWechatBusy(true);
    stopWechatPolling();
    try {
      const result = await window.ipcRenderer.invoke('redbox-auth:wechat-url', { state: 'redconvert-desktop' }) as {
        success?: boolean;
        data?: {
          sessionId?: string;
          qrContentUrl?: string;
          url?: string;
        };
        error?: string;
      };
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '微信登录初始化失败');
      }
      const sessionId = String(result.data.sessionId || '').trim();
      const qrContent = String(result.data.qrContentUrl || result.data.url || '').trim();
      if (!sessionId || !qrContent) {
        throw new Error('微信登录二维码数据不完整');
      }
      const qrUrl = await buildWechatQrDataUrl(qrContent);
      wechatSessionIdRef.current = sessionId;
      setWechatQrUrl(qrUrl);
      setWechatStatus('PENDING');
      setLoginNotice('idle', '');
      const token = wechatPollTokenRef.current + 1;
      wechatPollTokenRef.current = token;
      pollWechatStatus(sessionId, token);
    } catch (error) {
      setWechatStatus('');
      setWechatQrUrl('');
      setLoginNotice('error', error instanceof Error ? error.message : '微信登录初始化失败');
    } finally {
      setWechatBusy(false);
    }
  }, [pollWechatStatus, setLoginNotice, stopWechatPolling]);

  const sendSmsCode = useCallback(async () => {
    const phone = String(smsForm.phone || '').trim();
    if (!phone) {
      setLoginNotice('error', '请先输入手机号');
      return;
    }
    setSmsBusy(true);
    try {
      const result = await window.ipcRenderer.invoke('redbox-auth:send-sms-code', { phone }) as {
        success?: boolean;
        error?: string;
      };
      if (!result?.success) {
        throw new Error(result?.error || '验证码发送失败');
      }
      setLoginNotice('success', '验证码已发送');
    } catch (error) {
      setLoginNotice('error', error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setSmsBusy(false);
    }
  }, [setLoginNotice, smsForm.phone]);

  const handleSmsAuth = useCallback(async (mode: 'login' | 'register') => {
    const phone = String(smsForm.phone || '').trim();
    const code = String(smsForm.code || '').trim();
    if (!phone || !code) {
      setLoginNotice('error', '请输入手机号和验证码');
      return;
    }
    setSmsBusy(true);
    try {
      const result = await window.ipcRenderer.invoke(
        mode === 'login' ? 'redbox-auth:login-sms' : 'redbox-auth:register-sms',
        { phone, code, inviteCode: smsForm.inviteCode.trim() || undefined },
      ) as {
        success?: boolean;
        session?: unknown;
        error?: string;
      };
      if (!result?.success || !result.session) {
        throw new Error(result?.error || (mode === 'login' ? '登录失败' : '注册失败'));
      }
      setLoginNotice('success', mode === 'login' ? '登录成功，正在进入工作台…' : '注册成功，正在进入工作台…');
      refreshAuthAfterLogin();
    } catch (error) {
      setLoginNotice('error', error instanceof Error ? error.message : (mode === 'login' ? '登录失败' : '注册失败'));
    } finally {
      setSmsBusy(false);
    }
  }, [refreshAuthAfterLogin, setLoginNotice, smsForm.code, smsForm.inviteCode, smsForm.phone]);

  const startGoogleLogin = useCallback(() => {
    setLoginNotice('error', 'Google 登录通道尚未接入。');
  }, [setLoginNotice]);

  const returnToSmsLogin = useCallback(() => {
    stopWechatPolling();
    setWechatQrUrl('');
    setWechatStatus('');
    setLoginNotice('idle', '');
  }, [setLoginNotice, stopWechatPolling]);

  const isMainlandRealm = activeRealm === 'cn';
  const authBusy = wechatBusy || smsBusy;
  const showMainlandWechatQr = isMainlandRealm && Boolean(wechatQrUrl);
  const title = mode === 'checking'
    ? 'Checking session'
    : 'Welcome back';
  const subtitle = mode === 'checking'
    ? `Restoring ${APP_BRAND.displayName}.`
    : mode === 'expired'
      ? 'Your session expired. Log in to continue.'
      : `Log in to continue to ${APP_BRAND.displayName}.`;

  return (
    <>
      <div className="min-h-screen overflow-hidden bg-[rgb(var(--color-background))] text-slate-950">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_15%_85%,rgb(var(--color-accent-primary)/0.18),transparent_34%),radial-gradient(circle_at_32%_45%,rgb(var(--color-accent-muted)/0.5),transparent_28%),linear-gradient(135deg,rgb(var(--color-background))_0%,rgb(var(--color-surface-primary))_52%,rgb(var(--color-surface-secondary))_100%)]" />
        <div className="relative grid min-h-screen grid-cols-1 lg:grid-cols-[1fr_520px]">
          <section className="hidden lg:flex min-h-screen flex-col justify-center px-[11vw]">
            <div className="relative h-[420px] w-[360px]">
              <img
                src={APP_BRAND.logoSrc}
                alt=""
                className="absolute left-0 top-0 h-[300px] w-[300px] object-contain opacity-20 blur-[1px]"
              />
              <div className="absolute left-10 bottom-0 flex items-center gap-3">
                <img src={APP_BRAND.logoSrc} alt="" className="h-9 w-9 object-contain" />
                <div className="text-4xl font-semibold tracking-[0]">{APP_BRAND.displayName}</div>
              </div>
            </div>
            <p className="mt-3 max-w-[340px] text-[19px] leading-8 text-slate-700">
              The AI content workspace that helps your ideas <span className="font-semibold text-emerald-500">thrive.</span>
            </p>
            <div className="absolute bottom-10 left-12 flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck className="h-4 w-4 text-[rgb(var(--color-accent-primary))]" />
              Your data is encrypted and secure.
            </div>
          </section>

          <main className="flex min-h-screen items-center justify-center px-6 py-8 lg:justify-start lg:px-0">
            <div className="w-full max-w-[432px]">
              <div className="mb-10 text-center lg:text-left">
                <h1 className="text-4xl font-semibold tracking-[0] text-slate-950">{title}</h1>
                <p className="mt-3 text-base text-slate-500">{subtitle}</p>
              </div>

          {mode === 'checking' ? (
                <div className="flex h-52 items-center justify-center rounded-2xl border border-slate-200/80 bg-white/70 text-slate-500 shadow-sm">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在恢复账号
                </div>
              ) : (
                <div className="space-y-5">
                  {showMainlandWechatQr ? (
                    <div className="space-y-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-700">微信扫码登录</div>
                        <button
                          type="button"
                          onClick={returnToSmsLogin}
                          className="text-sm font-medium text-slate-500 transition hover:text-slate-700"
                        >
                          手机号登录
                        </button>
                      </div>
                      <div className="flex justify-center py-2">
                        <img src={wechatQrUrl} alt="微信登录二维码" className="h-64 w-64 rounded-xl bg-white object-contain p-3 shadow-[0_16px_44px_rgba(15,23,42,0.08)]" />
                      </div>
                    </div>
                  ) : isMainlandRealm && (
                    <form
                      className="space-y-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleSmsAuth('login');
                      }}
                    >
                      <div className="text-sm font-medium text-slate-700">手机号登录</div>
                      <input
                        type="tel"
                        value={smsForm.phone}
                        onChange={(event) => setSmsForm((prev) => ({ ...prev, phone: event.target.value }))}
                        placeholder="手机号"
                        autoComplete="tel"
                        disabled={authBusy}
                        className="h-12 w-full rounded-xl border border-slate-200/80 bg-white/80 px-4 text-sm text-slate-700 shadow-[0_8px_24px_rgba(15,23,42,0.04)] outline-none transition placeholder:text-slate-400 focus:border-emerald-300 focus:bg-white disabled:opacity-60"
                      />
                      <div className="grid grid-cols-[1fr_auto] gap-3">
                        <input
                          type="text"
                          value={smsForm.code}
                          onChange={(event) => setSmsForm((prev) => ({ ...prev, code: event.target.value }))}
                          placeholder="短信验证码"
                          autoComplete="one-time-code"
                          disabled={authBusy}
                          className="h-12 min-w-0 rounded-xl border border-slate-200/80 bg-white/80 px-4 text-sm text-slate-700 shadow-[0_8px_24px_rgba(15,23,42,0.04)] outline-none transition placeholder:text-slate-400 focus:border-emerald-300 focus:bg-white disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => void sendSmsCode()}
                          disabled={authBusy}
                          className="h-12 rounded-xl border border-slate-200/80 bg-white/80 px-4 text-sm font-medium text-slate-600 shadow-[0_8px_24px_rgba(15,23,42,0.04)] transition hover:bg-white disabled:opacity-60"
                        >
                          发送验证码
                        </button>
                      </div>
                      <button
                        type="submit"
                        disabled={authBusy}
                        className="h-12 w-full rounded-xl bg-[rgb(var(--color-accent-primary))] text-sm font-medium text-white shadow-[0_14px_28px_rgba(16,185,129,0.22)] transition hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-60"
                      >
                        {smsBusy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '登录 / 注册'}
                      </button>
                    </form>
                  )}

                  {!showMainlandWechatQr && (
                    <div className="space-y-4">
                    {!isMainlandRealm && (
                      <button
                        type="button"
                        onClick={startGoogleLogin}
                        disabled={authBusy}
                        className="flex h-[56px] w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white/80 text-base font-medium text-slate-600 shadow-[0_10px_34px_rgba(15,23,42,0.04)] transition hover:bg-white disabled:opacity-60"
                      >
                        <img src={googleIcon} alt="" className="h-5 w-5" />
                        Continue with Google
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void startWechatLogin()}
                      disabled={authBusy}
                      className="flex h-[56px] w-full items-center justify-center gap-3 rounded-xl border border-slate-200/80 bg-white/80 text-base font-medium text-slate-600 shadow-[0_10px_34px_rgba(15,23,42,0.04)] transition hover:bg-white disabled:opacity-60"
                    >
                      {wechatBusy ? <Loader2 className="h-5 w-5 animate-spin text-emerald-500" /> : <img src={wechatIcon} alt="" className="h-5 w-5" />}
                      Continue with WeChat
                    </button>
                    </div>
                  )}

                  {wechatQrUrl && !showMainlandWechatQr && (
                    <div className="flex items-center gap-4">
                      <img src={wechatQrUrl} alt="微信登录二维码" className="h-24 w-24 rounded-lg bg-white object-contain" />
                      <div className="min-w-0 text-sm text-slate-500">
                        <div className="font-medium text-slate-700">微信扫码登录</div>
                      </div>
                    </div>
                  )}

                  {notice && (
                    <div className={`text-center text-sm ${
                      noticeType === 'error'
                        ? 'text-red-500'
                        : noticeType === 'success'
                          ? 'text-emerald-600'
                          : 'text-slate-500'
                    }`}>
                      {notice}
                    </div>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
      <AppDialogsHost />
    </>
  );
}

function App() {
  useOfficialAuthLifecycle();
  const { snapshot: officialAuthState, bootstrapped: officialAuthBootstrapped } = useOfficialAuthState();
  const [appOnboardingOpen, setAppOnboardingOpen] = useState(false);
  const officialAuthStatus = String(officialAuthState?.status || '').trim();
  const officialAuthPending = !officialAuthBootstrapped
    || officialAuthStatus === 'restoring'
    || officialAuthStatus === 'refreshing';

  const openAppOnboarding = useCallback(() => {
    setAppOnboardingOpen(true);
  }, []);

  const closeAppOnboarding = useCallback(() => {
    markAppOnboardingSeen();
    setAppOnboardingOpen(false);
  }, []);

  useEffect(() => {
    if (!hasSeenAppOnboarding()) {
      setAppOnboardingOpen(true);
    }
  }, []);

  if (officialAuthPending) {
    return (
      <>
        <OfficialLoginGate mode="checking" />
        <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      </>
    );
  }

  if (!isOfficialAuthLoggedIn(officialAuthState, officialAuthBootstrapped)) {
    return (
      <>
        <OfficialLoginGate mode={officialAuthStatus === 'reauthRequired' ? 'expired' : 'login'} />
        <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      </>
    );
  }

  return (
    <>
      <AuthenticatedApp onOpenAppOnboarding={openAppOnboarding} />
      <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
    </>
  );
}

export default App;
