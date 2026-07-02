import { useEffect, useState, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { AppDialogsHost } from './components/AppDialogsHost';
import { AppOnboarding, getAppOnboardingStatus, markAppOnboardingSeenOnDevice } from './components/AppOnboarding';
import { FeedbackReportDialog } from './components/FeedbackReportDialog';
import { Layout } from './components/Layout';
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
import type { PendingChatMessage } from './features/app-shell/types';
import { ClipboardCapturePrompt } from './features/capture/ClipboardCapturePrompt';
import { useOfficialAuthLifecycle } from './hooks/useOfficialAuthLifecycle';
import { useI18n } from './i18n';
import { NotificationsHost } from './notifications/NotificationsHost';

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

export type { GenerationIntent, ImmersiveMode, PendingChatMessage, TeamSection, ViewType } from './features/app-shell/types';

function ViewLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="h-full min-h-0 flex items-center justify-center text-text-tertiary">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      {t('app.loadingPage')}
    </div>
  );
}

function App() {
  useOfficialAuthLifecycle();

  const {
    currentView,
    setCurrentView,
    navigateToView,
    immersiveMode,
    setImmersiveMode,
    activeManuscriptEditorFile,
    setActiveManuscriptEditorFile,
    mountedViews,
    persistentViews,
    setViewPersistent,
    returnFromSettings,
  } = useViewNavigation();
  const [redClawGlobalSidebarContent, setRedClawGlobalSidebarContent] = useState<ReactNode>(null);
  const [redClawTitleBarActions, setRedClawTitleBarActions] = useState<ReactNode>(null);
  const [knowledgeTitleBarContent, setKnowledgeTitleBarContent] = useState<ReactNode>(null);
  const [appOnboardingOpen, setAppOnboardingOpen] = useState(false);
  const globalAuthNotice = useOfficialAuthNotice();
  const {
    subjectsModalOpen,
    openSubjectsModal,
    closeSubjectsModal,
  } = useSubjectsModal();
  const {
    settingsNavigationTarget,
    setSettingsNavigationTarget,
  } = useSettingsShellNavigation();
  const [skillsNavigationAction, setSkillsNavigationAction] = useState<{ action: 'open-market'; nonce: number } | null>(null);
  const [approvalTargetRequestId, setApprovalTargetRequestId] = useState('');
  const {
    redclawOnboardingVersion,
    pendingRedClawMessage,
    redClawNavigationAction,
    setRedClawNavigationAction,
    openRedClawOnboarding,
    navigateToRedClaw,
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
    openCoverStudio,
    returnToFreeCreation,
  } = useGenerationShellNavigation({ setCurrentView });
  const {
    handleWanderExecutionStateChange,
    handleRedClawExecutionStateChange,
    handleCoverStudioExecutionStateChange,
    handleGenerationStudioExecutionStateChange,
  } = useExecutionPersistence(setViewPersistent);
  const {
    feedbackReportOpen,
    feedbackReportContext,
    openFeedbackReport,
    closeFeedbackReport,
    notifyFeedbackReportSubmitted,
  } = useFeedbackReportDialog(currentView);

  useEffect(() => {
    let disposed = false;
    void getAppOnboardingStatus().then((status) => {
      if (!disposed && !status.seen) {
        setAppOnboardingOpen(true);
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  const closeAppOnboarding = useCallback(() => {
    void markAppOnboardingSeenOnDevice();
    setAppOnboardingOpen(false);
  }, []);

  useGlobalIntentRouter({
    navigateToView,
    setCurrentView,
    setActiveManuscriptEditorFile,
    setSettingsNavigationTarget,
    setRedClawNavigationAction,
    setApprovalTargetRequestId,
    setPendingGenerationIntent,
    setSkillsNavigationAction,
  });

  const navigateToTeamMembers = useCallback(() => {
    setSettingsNavigationTarget({
      tab: 'team',
      nonce: Date.now(),
    });
    navigateToView('settings');
  }, [navigateToView, setSettingsNavigationTarget]);
  const isManuscriptEditorActive = currentView === 'redclaw' && Boolean(activeManuscriptEditorFile);
  const effectiveImmersiveMode = isManuscriptEditorActive ? false : immersiveMode;

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
          if (currentView === 'knowledge') return knowledgeTitleBarContent;
          return null;
        }}
        renderTitleBarActions={({ currentView }) => (
          currentView === 'redclaw' && !isManuscriptEditorActive ? redClawTitleBarActions : null
        )}
        onOpenFeedbackReport={() => openFeedbackReport({ sourcePage: currentView })}
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
              <SkillsPage isActive={currentView === 'skills'} navigationAction={skillsNavigationAction} />
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
                onNavigateToManuscript={navigateToManuscript}
                onNavigateToRedClaw={navigateToRedClaw}
                onExecutionStateChange={handleWanderExecutionStateChange}
                isActive={currentView === 'wander'}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'redclaw') && (
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
                onOpenTeamMembers={navigateToTeamMembers}
                titleBarActive={currentView === 'redclaw' && !isManuscriptEditorActive}
              />
            </Suspense>
          </div>
        )}
        {shouldRenderView(mountedViews, currentView, persistentViews, 'subjects') && (
          <div className={currentView === 'subjects' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Suspense fallback={currentView === 'subjects' ? <ViewLoadingFallback /> : null}>
              <SubjectsPage
                isActive={currentView === 'subjects'}
                onReturnHome={returnToFreeCreation}
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
                onReturnHome={returnToFreeCreation}
                onOpenAssets={openSubjectsModal}
                onOpenCoverStudio={openCoverStudio}
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
                targetRequestId={approvalTargetRequestId}
                onOpenRedClawSession={openRedClawSession}
              />
            </Suspense>
          </div>
        )}
      </Layout>
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
      <ClipboardCapturePrompt />
      <StartupMigrationGate />
      <AppOnboarding open={appOnboardingOpen} onClose={closeAppOnboarding} />
      <NotificationsHost currentView={currentView} />
      <FeedbackReportDialog
        open={feedbackReportOpen}
        context={feedbackReportContext}
        onClose={closeFeedbackReport}
        onSubmitted={notifyFeedbackReportSubmitted}
      />
      <AppDialogsHost />
    </>
  );
}

export default App;
