import { useState, useEffect, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { FileText, Loader2, MessageSquareWarning } from 'lucide-react';
import { AppDialogsHost } from './components/AppDialogsHost';
import { Layout } from './components/Layout';
import { AppOnboarding, hasSeenAppOnboarding, markAppOnboardingSeen } from './components/AppOnboarding';
import { FeedbackReportDialog } from './components/FeedbackReportDialog';
import { useLlmReadinessLifecycle } from './hooks/useLlmReadinessLifecycle';
import { useLlmReadinessState } from './hooks/useLlmReadinessState';
import { useOfficialAuthLifecycle } from './hooks/useOfficialAuthLifecycle';
import { useOfficialAuthState } from './hooks/useOfficialAuthState';
import { NotificationsHost } from './notifications/NotificationsHost';
import { useI18n } from './i18n';
import { OfficialLoginGate } from './features/app-shell/OfficialLoginGate';
import { StartupMigrationGate } from './features/app-shell/StartupMigrationGate';
import { useFeedbackReportDialog } from './features/app-shell/useFeedbackReportDialog';
import { useGlobalIntentRouter } from './features/app-shell/useGlobalIntentRouter';
import { useOfficialAuthNotice } from './features/app-shell/useOfficialAuthNotice';
import { shouldRenderView, useViewNavigation } from './features/app-shell/useViewNavigation';
import type { GenerationIntent, ImmersiveMode, PendingChatMessage, RedClawNavigationAction, SettingsNavigationTarget } from './features/app-shell/types';
import { ClipboardCapturePrompt } from './features/capture/ClipboardCapturePrompt';
import type { AuthoringTaskHints } from './utils/redclawAuthoring';
import { uiTraceInteraction } from './utils/uiDebug';

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
  const [redclawOnboardingVersion, setRedclawOnboardingVersion] = useState(0);
  const [pendingRedClawMessage, setPendingRedClawMessage] = useState<PendingChatMessage | null>(null);
  const [redClawGlobalSidebarContent, setRedClawGlobalSidebarContent] = useState<ReactNode>(null);
  const [redClawTitleBarActions, setRedClawTitleBarActions] = useState<ReactNode>(null);
  const [subjectsModalOpen, setSubjectsModalOpen] = useState(false);
  const [pendingGenerationIntent, setPendingGenerationIntent] = useState<GenerationIntent | null>(null);
  const [settingsNavigationTarget, setSettingsNavigationTarget] = useState<SettingsNavigationTarget | null>(null);
  const [redClawNavigationAction, setRedClawNavigationAction] = useState<RedClawNavigationAction | null>(null);
  const [wanderTitleBarContent, setWanderTitleBarContent] = useState<ReactNode>(null);
  const [knowledgeTitleBarContent, setKnowledgeTitleBarContent] = useState<ReactNode>(null);
  const [approvalTargetDocketId, setApprovalTargetDocketId] = useState('');

  const globalAuthNotice = useOfficialAuthNotice();

  const openSubjectsModal = useCallback(() => {
    setSubjectsModalOpen(true);
  }, []);

  const closeSubjectsModal = useCallback(() => {
    setSubjectsModalOpen(false);
  }, []);

  const {
    feedbackReportOpen,
    feedbackReportContext,
    openFeedbackReport,
    closeFeedbackReport,
    notifyFeedbackReportSubmitted,
  } = useFeedbackReportDialog(currentView);

  useGlobalIntentRouter({
    navigateToView,
    setCurrentView,
    setActiveManuscriptEditorFile,
    setSettingsNavigationTarget,
    setRedClawNavigationAction,
    setApprovalTargetDocketId,
    setPendingGenerationIntent,
  });

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

  const navigateToRedClaw = (message: PendingChatMessage) => {
    uiTraceInteraction('app', 'nav_to_redclaw', { to: 'redclaw' });
    setPendingRedClawMessage(message);
    setCurrentView('redclaw');
  };

  const openRedClawOnboarding = useCallback(() => {
    void (async () => {
      try {
        await window.ipcRenderer.redclawProfile.startStyleDefinition({
          forceRestart: true,
          source: 'manual-redefine',
        });
        setRedclawOnboardingVersion((value) => value + 1);
      } catch (error) {
        console.error('Failed to start RedClaw style definition:', error);
      }
      navigateToRedClaw({
        content: '我想重新定义这个空间的自媒体定位和写作风格。请先让我上传账号主页截图来确认账号定位，可以让我发 1 到 3 张主页相关截图一起分析；确认后，再让我上传一篇自己的文章截图或对标账号文章截图来学习创作风格。不要直接写稿。',
        displayContent: '重新定义这个空间的风格',
        sessionRouting: 'new',
        deliveryMode: 'send',
        taskHints: {
          activeSkills: ['redclaw-style-definition'],
          requiredSkill: 'redclaw-style-definition',
          allowedOperateActions: [
            'redclaw.profile.bundle',
            'redclaw.profile.read',
            'redclaw.profile.update',
            'redclaw.profile.completeStyleDefinition',
          ],
          initialContext: '用户从界面入口手动请求重新定义当前 RedClaw 空间风格。',
        } as AuthoringTaskHints,
      });
    })();
  }, []);

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

  const returnToFreeCreation = useCallback(() => {
    setCurrentView('generation-studio');
  }, []);

  const isManuscriptEditorActive = currentView === 'redclaw' && Boolean(activeManuscriptEditorFile);
  const effectiveImmersiveMode: ImmersiveMode = isManuscriptEditorActive ? false : immersiveMode;

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
      <ClipboardCapturePrompt />
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
  const { snapshot: officialAuthState } = useOfficialAuthState();
  const { snapshot: llmReadinessState, bootstrapped: llmReadinessBootstrapped } = useLlmReadinessState();
  const [appOnboardingOpen, setAppOnboardingOpen] = useState(false);
  const officialAuthStatus = String(officialAuthState?.status || '').trim();
  const authOrLlmPending = !llmReadinessBootstrapped;

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

  if (authOrLlmPending) {
    return (
      <>
        <OfficialLoginGate mode="checking" />
        <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      </>
    );
  }

  if (!llmReadinessState?.ready) {
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
