import { useEffect } from 'react';
import { REDBOX_NAVIGATE_EVENT } from '../../notifications/types';
import type { RedClawNavigationAction, SettingsNavigationTarget, ViewType } from './types';

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

type UseGlobalIntentRouterParams = {
  navigateToView: (view: ViewType) => void;
  setCurrentView: (view: ViewType) => void;
  setActiveManuscriptEditorFile: (value: string | null) => void;
  setSettingsNavigationTarget: (value: SettingsNavigationTarget | null) => void;
  setRedClawNavigationAction: (value: RedClawNavigationAction | null) => void;
  setApprovalTargetDocketId: (value: string) => void;
};

export function useGlobalIntentRouter({
  navigateToView,
  setCurrentView,
  setActiveManuscriptEditorFile,
  setSettingsNavigationTarget,
  setRedClawNavigationAction,
  setApprovalTargetDocketId,
}: UseGlobalIntentRouterParams) {
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
  }, [
    navigateToView,
    setActiveManuscriptEditorFile,
    setApprovalTargetDocketId,
    setRedClawNavigationAction,
    setSettingsNavigationTarget,
  ]);

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
  }, [setCurrentView, setRedClawNavigationAction]);
}
