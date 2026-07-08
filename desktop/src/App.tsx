import { useState, useEffect, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { FileText, Loader2, MessageSquareWarning } from 'lucide-react';
import { AppDialogsHost } from './components/AppDialogsHost';
import { Layout } from './components/Layout';
import { AppOnboarding, getAppAcquisitionSource, getAppOnboardingStatus, markAppOnboardingSeenOnDevice } from './components/AppOnboarding';
import { FeedbackReportDialog } from './components/FeedbackReportDialog';
import { useLlmReadinessLifecycle } from './hooks/useLlmReadinessLifecycle';
import { useLlmReadinessState } from './hooks/useLlmReadinessState';
import { useOfficialAuthLifecycle } from './hooks/useOfficialAuthLifecycle';
import { useOfficialAuthState } from './hooks/useOfficialAuthState';
import { NotificationsHost } from './notifications/NotificationsHost';
import { useI18n } from './i18n';
import { OfficialLoginGate } from './features/app-shell/OfficialLoginGate';
import { AppSubjectsModal } from './features/app-shell/AppSubjectsModal';
import { StartupMigrationGate } from './features/app-shell/StartupMigrationGate';
import { useExecutionPersistence } from './features/app-shell/useExecutionPersistence';
import { useFeedbackReportDialog } from './features/app-shell/useFeedbackReportDialog';
import { useGenerationShellNavigation } from './features/app-shell/useGenerationShellNavigation';
import { useGlobalIntentRouter } from './features/app-shell/useGlobalIntentRouter';
import { useOfficialAuthNotice } from './features/app-shell/useOfficialAuthNotice';
import { useRedClawShellNavigation } from './features/app-shell/useRedClawShellNavigation';
import { useSettingsShellNavigation } from './features/app-shell/useSettingsShellNavigation';
import { useSubjectsModal } from './features/app-shell/useSubjectsModal';
import { shouldRenderView, useViewNavigation } from './features/app-shell/useViewNavigation';
import type { GenerationIntent, ImmersiveMode, PendingChatMessage, SkillsNavigationTarget } from './features/app-shell/types';
import { ClipboardCapturePrompt } from './features/capture/ClipboardCapturePrompt';
import { useDeepLinkRouter } from './features/deep-link/useDeepLinkRouter';
import { SpaceInitializationPage } from './features/space-init/SpaceInitializationPage';
import {
  platformLabel,
  runSpaceInitAccountCapture,
  type SpaceInitCaptureProgress,
  type SpaceInitCaptureStartPayload,
} from './features/space-init/spaceInitAccountCapture';
import type { SpaceInitState } from './bridge/domains/spacesBridge';
import { REDCLAW_CONTEXT_ID, REDCLAW_CONTEXT_TYPE } from './pages/redclaw/config';

export type { GenerationIntent, ImmersiveMode, PendingChatMessage, TeamSection, ViewType } from './features/app-shell/types';

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

function ViewLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="h-full min-h-0 flex items-center justify-center text-text-tertiary">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      {t('app.loadingPage')}
    </div>
  );
}

function SpaceInitCaptureProgressBanner({ progress }: { progress: SpaceInitCaptureProgress }) {
  const account = progress.account || null;
  const percent = Math.max(4, Math.min(100, Math.round(progress.percent)));
  const isFailed = progress.phase === 'failed';
  return (
    <div className="mx-auto w-full max-w-[860px] rounded-[24px] border border-accent-primary/20 bg-surface-primary/90 p-4 text-left shadow-[0_14px_36px_rgb(68_51_36/0.10)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-surface-secondary text-xs font-bold text-accent-primary">
            {account?.avatarUrl ? <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" /> : platformLabel(account?.platform).slice(0, 2)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-text-primary">{account?.username || '账号数据下载'}</div>
            <div className="truncate text-xs text-text-tertiary">{progress.message}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm font-bold text-text-secondary">
          {isFailed ? <MessageSquareWarning className="h-4 w-4 text-red-500" /> : <Loader2 className="h-4 w-4 animate-spin text-accent-primary" />}
          {isFailed ? '失败' : `${percent}%`}
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-secondary">
        <div className="h-full rounded-full bg-accent-primary transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-text-tertiary">
        <span>{progress.title}</span>
        <span>{progress.posts} 内容 · {progress.media} 媒体 · {progress.comments} 评论</span>
      </div>
    </div>
  );
}

async function countRedClawConversationsForSpace(spaceId: string): Promise<number> {
  const normalizedSpaceId = String(spaceId || 'default').trim() || 'default';
  const sessions = await window.ipcRenderer.chat.listContextSessionsGuarded({
    contextId: `${REDCLAW_CONTEXT_ID}:${normalizedSpaceId}`,
    contextType: REDCLAW_CONTEXT_TYPE,
  });
  return Array.isArray(sessions) ? sessions.length : 0;
}

function AuthenticatedApp({ onOpenAppOnboarding }: { onOpenAppOnboarding: () => void }) {
  const {
    currentView,
    setCurrentView,
    immersiveMode,
    setImmersiveMode,
    activeManuscriptEditorFile,
    setActiveManuscriptEditorFile,
    mountedViews,
    persistentViews,
    navigateToView,
    setViewPersistent,
    returnFromSettings,
  } = useViewNavigation();
  const [redClawGlobalSidebarContent, setRedClawGlobalSidebarContent] = useState<ReactNode>(null);
  const [redClawTitleBarActions, setRedClawTitleBarActions] = useState<ReactNode>(null);
  const [wanderTitleBarContent, setWanderTitleBarContent] = useState<ReactNode>(null);
  const [knowledgeTitleBarContent, setKnowledgeTitleBarContent] = useState<ReactNode>(null);
  const [approvalTargetDocketId, setApprovalTargetDocketId] = useState('');
  const [skillsNavigationTarget, setSkillsNavigationTarget] = useState<SkillsNavigationTarget | null>(null);
  const [spaceInitState, setSpaceInitState] = useState<SpaceInitState | null>(null);
  const [spaceInitBootstrapped, setSpaceInitBootstrapped] = useState(false);
  const [spaceInitLoading, setSpaceInitLoading] = useState(false);
  const [activeSpaceId, setActiveSpaceId] = useState('');
  const [spaceInitCaptureProgress, setSpaceInitCaptureProgress] = useState<SpaceInitCaptureProgress | null>(null);

  const globalAuthNotice = useOfficialAuthNotice();
  const {
    subjectsModalOpen,
    openSubjectsModal,
    closeSubjectsModal,
  } = useSubjectsModal();

  const {
    feedbackReportOpen,
    feedbackReportContext,
    openFeedbackReport,
    closeFeedbackReport,
    notifyFeedbackReportSubmitted,
  } = useFeedbackReportDialog(currentView);

  const {
    settingsNavigationTarget,
    setSettingsNavigationTarget,
  } = useSettingsShellNavigation();

  const {
    redclawOnboardingVersion,
    pendingRedClawMessage,
    redClawNavigationAction,
    setRedClawNavigationAction,
    navigateToRedClaw,
    openRedClawOnboarding,
    clearPendingRedClawMessage,
    clearRedClawNavigationAction,
    navigateToManuscript,
    closeManuscriptEditor,
    openRedClawChatSurface,
    openRedClawSession,
  } = useRedClawShellNavigation({
    currentView,
    setCurrentView,
    setActiveManuscriptEditorFile,
    setImmersiveMode,
  });

  const handleTrySkillInChat = useCallback((message: PendingChatMessage) => {
    navigateToRedClaw(message);
  }, [navigateToRedClaw]);

  const {
    pendingGenerationIntent,
    setPendingGenerationIntent,
    navigateToGenerationStudio,
    clearPendingGenerationIntent,
    returnToFreeCreation,
  } = useGenerationShellNavigation({ setCurrentView });

  useGlobalIntentRouter({
    navigateToView,
    setCurrentView,
    setActiveManuscriptEditorFile,
    setSettingsNavigationTarget,
    setRedClawNavigationAction,
    setSkillsNavigationTarget,
    setApprovalTargetDocketId,
    setPendingGenerationIntent,
  });

  useDeepLinkRouter({
    navigateToView,
    navigateToRedClaw,
    setRedClawNavigationAction,
    setSkillsNavigationTarget,
  });

  const {
    handleWanderExecutionStateChange,
    handleRedClawExecutionStateChange,
    handleGenerationStudioExecutionStateChange,
    handleCoverStudioExecutionStateChange,
  } = useExecutionPersistence(setViewPersistent);

  const isManuscriptEditorActive = currentView === 'redclaw' && Boolean(activeManuscriptEditorFile);
  const effectiveImmersiveMode: ImmersiveMode = isManuscriptEditorActive ? false : immersiveMode;
  const loadSpaceInitState = useCallback(async () => {
    setSpaceInitLoading(true);
    try {
      const [next, spacesResult] = await Promise.all([
        window.ipcRenderer.spaces.init.get<SpaceInitState>(),
        window.ipcRenderer.spaces.list().catch(() => null),
      ]);
      const nextActiveSpaceId = String(spacesResult?.activeSpaceId || '');
      setActiveSpaceId(nextActiveSpaceId);
      const nextSpaceCount = Array.isArray(spacesResult?.spaces) ? spacesResult.spaces.length : 0;
      let resolvedState = next;
      let aiConversationCount: number | null = null;
      let legacyAutoBypassed = false;

      if (String(next?.status || 'not_started') !== 'completed') {
        aiConversationCount = await countRedClawConversationsForSpace(nextActiveSpaceId);
        if (aiConversationCount > 1) {
          const now = new Date().toISOString();
          resolvedState = await window.ipcRenderer.spaces.init.complete<SpaceInitState>({
            homepageUrl: String(next?.homepageUrl || ''),
            platform: String(next?.platform || 'legacy'),
            accountId: next?.accountId || undefined,
            account: null,
            skipProfileWrite: true,
            progress: {
              ...(next?.progress || {}),
              legacyAutoBypass: true,
              legacyAutoBypassReason: 'ai_conversation_count',
              aiConversationCount,
              updatedAt: now,
            },
          });
          legacyAutoBypassed = true;
        }
      }

      setSpaceInitState(resolvedState);
      console.info('[space-init] renderer state', {
        activeSpaceId: nextActiveSpaceId,
        canClose: Boolean(nextActiveSpaceId && nextActiveSpaceId !== 'default'),
        spaceCount: nextSpaceCount,
        aiConversationCount,
        legacyAutoBypassed,
        status: resolvedState?.status || 'not_started',
        phase: resolvedState?.phase || 'branch',
      });
    } catch (error) {
      console.error('Failed to load space initialization state:', error);
      setSpaceInitState({ status: 'not_started' });
      setActiveSpaceId('');
    } finally {
      setSpaceInitBootstrapped(true);
      setSpaceInitLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSpaceInitState();
    const handleSpaceChanged = () => {
      setSpaceInitBootstrapped(false);
      void loadSpaceInitState();
    };
    window.ipcRenderer.spaces.onChanged(handleSpaceChanged);
    return () => window.ipcRenderer.spaces.offChanged(handleSpaceChanged);
  }, [loadSpaceInitState]);

  const spaceInitStatus = String(spaceInitState?.status || 'not_started');
  const spaceInitPhase = String(spaceInitState?.phase || 'branch');
  const spaceInitIncomplete = spaceInitBootstrapped
    && spaceInitStatus !== 'completed';
  const spaceInitIntroPhase = !spaceInitPhase || spaceInitPhase === 'branch' || spaceInitPhase === 'input';
  const spaceInitBlocksApp = spaceInitBootstrapped
    && spaceInitIncomplete
    && spaceInitIntroPhase;
  const clipboardCaptureDisabled = currentView === 'settings' || !spaceInitBootstrapped || spaceInitLoading || spaceInitIncomplete;

  useEffect(() => {
    if (!spaceInitBootstrapped || spaceInitBlocksApp || !spaceInitIncomplete) return;
    if (currentView === 'redclaw') return;
    setCurrentView('redclaw');
  }, [currentView, setCurrentView, spaceInitBlocksApp, spaceInitBootstrapped, spaceInitIncomplete]);

  const handleSpaceInitBranchStart = useCallback((message: PendingChatMessage, nextState?: SpaceInitState | null) => {
    if (nextState) setSpaceInitState(nextState);
    navigateToRedClaw(message);
  }, [navigateToRedClaw]);

  const handleSpaceInitHomepageCaptureStart = useCallback((payload: SpaceInitCaptureStartPayload & { progressBase: Record<string, unknown> }) => {
    const homepageUrl = payload.url.trim();
    if (!homepageUrl) return;
    const optimisticState: SpaceInitState = {
      ...(spaceInitState || {}),
      status: 'running',
      phase: 'capture',
      homepageUrl,
      platform: payload.candidate.platform,
      progress: {
        ...(payload.progressBase || {}),
        branch: 'homepage',
        uiStage: 'deterministic_capture',
        updatedAt: new Date().toISOString(),
      },
    };
    setSpaceInitState(optimisticState);
    setSpaceInitCaptureProgress({
      phase: 'creating',
      title: '创建账号档案',
      message: '正在建立当前空间的账号档案。',
      percent: 8,
      account: null,
      posts: 0,
      media: 0,
      comments: 0,
      requested: 25,
    });
    openRedClawChatSurface();
    void (async () => {
      try {
        const result = await runSpaceInitAccountCapture({
          homepageUrl,
          candidate: payload.candidate,
          progressBase: payload.progressBase,
          onProgress: setSpaceInitCaptureProgress,
        });
        setSpaceInitState(result.nextState);
        await window.ipcRenderer.redclawProfile.startStyleDefinition({
          source: 'space-initialization',
        }).catch((error) => {
          console.warn('Failed to start RedClaw style definition flow:', error);
        });
        setSpaceInitCaptureProgress(null);
        navigateToRedClaw(result.message);
      } catch (error) {
        console.error('Failed to run deterministic space initialization capture:', error);
        const message = error instanceof Error ? error.message : '账号采集失败';
        setSpaceInitCaptureProgress((current) => current ? {
          ...current,
          phase: 'failed',
          title: '下载失败',
          message,
        } : {
          phase: 'failed',
          title: '下载失败',
          message,
          percent: 0,
          account: null,
          posts: 0,
          media: 0,
          comments: 0,
          requested: 25,
        });
      }
    })();
  }, [navigateToRedClaw, openRedClawChatSurface, spaceInitState]);

  useEffect(() => {
    const acquisitionSource = getAppAcquisitionSource();
    void window.ipcRenderer.analytics.track('app_launched', {
      surface: 'app-shell',
      origin: 'renderer',
      properties: acquisitionSource ? { acquisitionSource } : {},
    });
  }, []);

  useEffect(() => {
    void window.ipcRenderer.analytics.track('surface_viewed', {
      surface: currentView,
      origin: 'renderer',
      properties: {
        surface: currentView,
      },
    });
  }, [currentView]);

  if (!spaceInitBootstrapped) {
    return (
      <>
        <div className="h-screen min-h-0 flex items-center justify-center bg-background text-text-tertiary">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          加载空间
        </div>
        <ClipboardCapturePrompt disabled />
      </>
    );
  }

  if (spaceInitBlocksApp) {
    return (
      <>
        <SpaceInitializationPage
          state={spaceInitState}
          canClose={Boolean(activeSpaceId && activeSpaceId !== 'default')}
          onCompleted={loadSpaceInitState}
          onBranchStart={handleSpaceInitBranchStart}
          onHomepageCaptureStart={handleSpaceInitHomepageCaptureStart}
        />
        <ClipboardCapturePrompt disabled />
      </>
    );
  }

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
        {shouldRenderView(mountedViews, currentView, persistentViews, 'skills') && (
          <div className={currentView === 'skills' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'skills' ? <ViewLoadingFallback /> : null}>
              <SkillsPage
                isActive={currentView === 'skills'}
                onTrySkillInChat={handleTrySkillInChat}
                navigationTarget={skillsNavigationTarget}
              />
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
                messageListHeader={spaceInitCaptureProgress ? <SpaceInitCaptureProgressBanner progress={spaceInitCaptureProgress} /> : null}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'media-library') && (
          <div className={currentView === 'media-library' ? 'min-h-full bg-background flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'media-library' ? <ViewLoadingFallback /> : null}>
              <MediaLibraryPage
                isActive={currentView === 'media-library'}
                onNavigateToGenerationStudio={navigateToGenerationStudio}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'subjects') && (
          <div className={currentView === 'subjects' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'subjects' ? <ViewLoadingFallback /> : null}>
              <SubjectsPage
                isActive={currentView === 'subjects'}
                variant="page"
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
                onReturnHome={returnToFreeCreation}
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
                onOpenAssets={openSubjectsModal}
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
      <ClipboardCapturePrompt disabled={clipboardCaptureDisabled} />
      {subjectsModalOpen && (
        <AppSubjectsModal close={closeSubjectsModal}>
          <Suspense fallback={<ViewLoadingFallback />}>
            <SubjectsPage
              isActive={subjectsModalOpen}
              variant="modal"
              onClose={closeSubjectsModal}
            />
          </Suspense>
        </AppSubjectsModal>
      )}
      <FeedbackReportDialog
        open={feedbackReportOpen}
        context={feedbackReportContext}
        onClose={closeFeedbackReport}
        onSubmitted={notifyFeedbackReportSubmitted}
      />
      <StartupMigrationGate />
      <NotificationsHost currentView={currentView} />
      <AppDialogsHost />
    </>
  );
}

function App() {
  useOfficialAuthLifecycle();
  useLlmReadinessLifecycle();
  const { snapshot: officialAuthState, bootstrapped: officialAuthBootstrapped } = useOfficialAuthState();
  const { snapshot: llmReadinessState, bootstrapped: llmReadinessBootstrapped } = useLlmReadinessState();
  const [appOnboardingOpen, setAppOnboardingOpen] = useState(false);
  const officialAuthStatus = String(officialAuthState?.status || '').trim();
  const officialAuthPending = !officialAuthBootstrapped
    || officialAuthStatus === 'restoring'
    || officialAuthStatus === 'refreshing';
  const officialAuthLoggedIn = officialAuthBootstrapped
    && officialAuthStatus !== 'anonymous'
    && officialAuthStatus !== 'reauthRequired'
    && officialAuthStatus !== 'restoring'
    && Boolean(officialAuthState?.loggedIn);
  const officialAuthNeedsLogin = officialAuthBootstrapped
    && !officialAuthPending
    && !officialAuthLoggedIn;
  const llmReady = Boolean(llmReadinessState?.ready);
  const llmReadinessMode = String(llmReadinessState?.mode || '').trim();
  const canEnterWithCustomAi = llmReady && (llmReadinessMode === 'custom' || llmReadinessMode === 'local');
  const canEnterWorkspace = officialAuthLoggedIn ? llmReady : canEnterWithCustomAi;
  const llmReadinessPending = officialAuthLoggedIn && !llmReadinessBootstrapped;

  const openAppOnboarding = useCallback(() => {
    setAppOnboardingOpen(true);
  }, []);

  const closeAppOnboarding = useCallback(() => {
    void markAppOnboardingSeenOnDevice();
    setAppOnboardingOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAppOnboardingStatus().then((status) => {
      if (!cancelled && !status.seen) {
        setAppOnboardingOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (officialAuthPending) {
    return (
      <>
        <OfficialLoginGate mode="checking" />
        <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      </>
    );
  }

  if (officialAuthNeedsLogin && !canEnterWithCustomAi) {
    return (
      <>
        <OfficialLoginGate mode={officialAuthStatus === 'reauthRequired' ? 'expired' : 'login'} />
        <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      </>
    );
  }

  if (llmReadinessPending) {
    return (
      <>
        <OfficialLoginGate mode="checking" />
        <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      </>
    );
  }

  if (!canEnterWorkspace) {
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
