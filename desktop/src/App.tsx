import { useState, useEffect, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { FileText, Loader2, MessageSquareWarning } from 'lucide-react';
import { AppDialogsHost } from './components/AppDialogsHost';
import { Layout } from './components/Layout';
import { AppOnboarding, getAppAcquisitionSource, hasSeenAppOnboarding, markAppOnboardingSeen } from './components/AppOnboarding';
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
import type { GenerationIntent, ImmersiveMode } from './features/app-shell/types';
import { ClipboardCapturePrompt } from './features/capture/ClipboardCapturePrompt';

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
  const [redClawGlobalSidebarContent, setRedClawGlobalSidebarContent] = useState<ReactNode>(null);
  const [redClawTitleBarActions, setRedClawTitleBarActions] = useState<ReactNode>(null);
  const [wanderTitleBarContent, setWanderTitleBarContent] = useState<ReactNode>(null);
  const [knowledgeTitleBarContent, setKnowledgeTitleBarContent] = useState<ReactNode>(null);
  const [approvalTargetDocketId, setApprovalTargetDocketId] = useState('');

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
    setApprovalTargetDocketId,
    setPendingGenerationIntent,
  });

  const {
    handleWanderExecutionStateChange,
    handleRedClawExecutionStateChange,
    handleGenerationStudioExecutionStateChange,
    handleCoverStudioExecutionStateChange,
  } = useExecutionPersistence(setViewPersistent);

  const isManuscriptEditorActive = currentView === 'redclaw' && Boolean(activeManuscriptEditorFile);
  const effectiveImmersiveMode: ImmersiveMode = isManuscriptEditorActive ? false : immersiveMode;

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
  const llmReadinessPending = officialAuthLoggedIn && !llmReadinessBootstrapped;

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

  if (officialAuthNeedsLogin) {
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
