import { useEffect } from 'react';
import { REDBOX_NAVIGATE_EVENT } from '../../notifications/types';
import type { AppIntent, AppNavigateEventDetail, GenerationIntent, RedClawNavigationAction, SettingsNavigationTarget, SkillsNavigationTarget, ViewType } from './types';

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
  const metadataAutoOpen = metadata.autoOpen === true
    || String(metadata.autoOpen || '').trim().toLowerCase() === 'true';
  if (source === 'team-guide' || metadataAutoOpen) return true;
  return source === 'real-subagent-orchestration'
    || source === 'ai_coordinator'
    || source === 'internal'
    || Boolean(metadata.sourceTaskId || metadata.intent || metadata.recommendedRole);
}

function isAppIntent(detail: AppNavigateEventDetail | null | undefined): detail is AppIntent {
  return Boolean(detail && typeof detail === 'object' && 'type' in detail);
}

function normalizeNavigateIntent(detail: AppNavigateEventDetail | null | undefined): AppIntent | null {
  if (isAppIntent(detail)) return detail;

  const view = detail?.view;
  if (!view) return null;

  if (view === 'settings') {
    return {
      type: 'settings.open',
      tab: detail.settingsTab,
      aiModelSubTab: detail.aiModelSubTab,
    };
  }

  if (view === 'redclaw') {
    return {
      type: 'redclaw.open',
      action: detail.redclawAction,
      sessionId: detail.teamSessionId || detail.sessionId,
    };
  }

  if (view === 'approval') {
    return {
      type: 'approval.open',
      docketId: detail.docketId,
    };
  }

  return {
    type: 'view.open',
    view,
  };
}

type UseGlobalIntentRouterParams = {
  navigateToView: (view: ViewType) => void;
  setCurrentView: (view: ViewType) => void;
  setActiveManuscriptEditorFile: (value: string | null) => void;
  setSettingsNavigationTarget: (value: SettingsNavigationTarget | null) => void;
  setRedClawNavigationAction: (value: RedClawNavigationAction | null) => void;
  setSkillsNavigationTarget: (value: SkillsNavigationTarget | null) => void;
  setApprovalTargetDocketId: (value: string) => void;
  setPendingGenerationIntent: (value: GenerationIntent | null) => void;
};

export function useGlobalIntentRouter({
  navigateToView,
  setCurrentView,
  setActiveManuscriptEditorFile,
  setSettingsNavigationTarget,
  setRedClawNavigationAction,
  setSkillsNavigationTarget,
  setApprovalTargetDocketId,
  setPendingGenerationIntent,
}: UseGlobalIntentRouterParams) {
  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const intent = normalizeNavigateIntent((event as CustomEvent<AppNavigateEventDetail>).detail);
      if (!intent) return;

      if (intent.type === 'settings.open') {
        setSettingsNavigationTarget({
          tab: intent.tab,
          aiModelSubTab: intent.aiModelSubTab,
          nonce: Date.now(),
        });
        navigateToView('settings');
        return;
      }

      if (intent.type === 'skills.open') {
        setSkillsNavigationTarget({
          packageId: intent.packageId,
          id: intent.id,
          marketId: intent.marketId,
          query: intent.query,
          nonce: Date.now(),
        });
        navigateToView('skills');
        return;
      }

      if (intent.type === 'redclaw.open' && intent.action === 'new') {
        setActiveManuscriptEditorFile(null);
        setRedClawNavigationAction({
          action: 'new',
          nonce: Date.now(),
        });
        navigateToView('redclaw');
        return;
      }

      if (intent.type === 'redclaw.open' && intent.action === 'open-team' && intent.sessionId) {
        setActiveManuscriptEditorFile(null);
        setRedClawNavigationAction({
          action: 'open-team',
          sessionId: intent.sessionId,
          nonce: Date.now(),
        });
        navigateToView('redclaw');
        return;
      }

      if (intent.type === 'redclaw.open' && intent.action === 'open-session' && intent.sessionId) {
        setActiveManuscriptEditorFile(null);
        setRedClawNavigationAction({
          action: 'open-session',
          sessionId: intent.sessionId,
          nonce: Date.now(),
        });
        navigateToView('redclaw');
        return;
      }

      if (intent.type === 'redclaw.open') {
        navigateToView('redclaw');
        return;
      }

      if (intent.type === 'approval.open') {
        setApprovalTargetDocketId(String(intent.docketId || ''));
        navigateToView('approval');
        return;
      }

      if (intent.type === 'generation.open') {
        setPendingGenerationIntent(intent.intent);
        navigateToView('generation-studio');
        return;
      }

      if (intent.type === 'manuscript.open') {
        const manuscriptPath = String(intent.manuscriptPath || '').trim();
        if (!manuscriptPath) return;
        setActiveManuscriptEditorFile(manuscriptPath);
        navigateToView('redclaw');
        return;
      }

      if (intent.type === 'view.open') {
        navigateToView(intent.view);
      }
    };

    window.addEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => {
      window.removeEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    };
  }, [
    navigateToView,
    setActiveManuscriptEditorFile,
    setApprovalTargetDocketId,
    setPendingGenerationIntent,
    setRedClawNavigationAction,
    setSettingsNavigationTarget,
    setSkillsNavigationTarget,
  ]);

  useEffect(() => {
    const openedSessionIds = new Set<string>();
    const handleTeamRuntimeEvent = (_event: unknown, envelope?: { eventType?: string; payload?: unknown }) => {
      const event = envelope || {};
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
  }, [setCurrentView, setRedClawNavigationAction]);
}
