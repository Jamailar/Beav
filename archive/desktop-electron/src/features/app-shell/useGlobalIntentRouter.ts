import { useEffect } from 'react';
import { REDBOX_NAVIGATE_EVENT } from '../../notifications/types';
import type {
  AppIntent,
  AppNavigateEventDetail,
  GenerationIntent,
  RedClawNavigationAction,
  SettingsNavigationTarget,
  ViewType,
} from './types';

type TeamRuntimeEvent = {
  eventType?: string;
  sessionId?: string | null;
  payload?: unknown;
};

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventFromArgs(args: unknown[]): TeamRuntimeEvent | null {
  const candidate = args.length > 1 ? args[1] : args[0];
  const event = recordFromUnknown(candidate);
  return typeof event.eventType === 'string' ? event as TeamRuntimeEvent : null;
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

function normalizeRedClawNavigationAction(action: RedClawNavigationAction['action'] | undefined): RedClawNavigationAction['action'] | undefined {
  if (action === 'open-team') return 'open-session';
  return action;
}

function normalizeNavigateIntent(detail: AppNavigateEventDetail | null | undefined): AppIntent | null {
  if (!detail || typeof detail !== 'object') return null;
  if (isAppIntent(detail)) {
    if (detail.type === 'redclaw.open') {
      return {
        ...detail,
        action: normalizeRedClawNavigationAction(detail.action),
      };
    }
    return detail;
  }

  if (detail.settingsTab) {
    return {
      type: 'settings.open',
      tab: detail.settingsTab,
      aiModelSubTab: detail.aiModelSubTab,
    };
  }

  if (detail.manuscriptPath) {
    return {
      type: 'manuscript.open',
      manuscriptPath: detail.manuscriptPath,
    };
  }

  const view = detail.view;
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
      action: normalizeRedClawNavigationAction(detail.redclawAction || detail.action),
      sessionId: detail.teamSessionId || detail.sessionId,
    };
  }

  if (view === 'approval') {
    return {
      type: 'approval.open',
      requestId: detail.requestId || detail.docketId || detail.escalationId,
      docketId: detail.docketId,
      escalationId: detail.escalationId,
    };
  }

  if (view === 'generation-studio' && detail.intent) {
    return {
      type: 'generation.open',
      intent: detail.intent,
    };
  }

  return {
    type: 'view.open',
    view,
    skillsAction: detail.skillsAction || (view === 'skills' && detail.action === 'open-market' ? 'open-market' : undefined),
  };
}

type UseGlobalIntentRouterParams = {
  setCurrentView: (view: ViewType) => void;
  navigateToView?: (view: ViewType) => void;
  setActiveManuscriptEditorFile: (value: string | null) => void;
  setSettingsNavigationTarget: (value: SettingsNavigationTarget | null) => void;
  setRedClawNavigationAction: (value: RedClawNavigationAction | null) => void;
  setApprovalTargetRequestId: (value: string) => void;
  setPendingGenerationIntent: (value: GenerationIntent | null) => void;
  setSkillsNavigationAction: (value: { action: 'open-market'; nonce: number } | null) => void;
};

export function useGlobalIntentRouter({
  setCurrentView,
  navigateToView,
  setActiveManuscriptEditorFile,
  setSettingsNavigationTarget,
  setRedClawNavigationAction,
  setApprovalTargetRequestId,
  setPendingGenerationIntent,
  setSkillsNavigationAction,
}: UseGlobalIntentRouterParams) {
  const openView = navigateToView || setCurrentView;

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
        openView('settings');
        return;
      }

      if (intent.type === 'redclaw.open') {
        setActiveManuscriptEditorFile(null);
        if (intent.action) {
          setRedClawNavigationAction({
            action: intent.action,
            sessionId: intent.sessionId,
            nonce: Date.now(),
          });
        }
        openView('redclaw');
        return;
      }

      if (intent.type === 'approval.open') {
        setApprovalTargetRequestId(String(intent.requestId || intent.docketId || intent.escalationId || ''));
        openView('approval');
        return;
      }

      if (intent.type === 'generation.open') {
        if (intent.intent.mode === 'cover') {
          setPendingGenerationIntent(null);
          openView('cover-studio');
          return;
        }
        setPendingGenerationIntent(intent.intent);
        openView('generation-studio');
        return;
      }

      if (intent.type === 'manuscript.open') {
        const manuscriptPath = String(intent.manuscriptPath || '').trim();
        if (!manuscriptPath) return;
        setActiveManuscriptEditorFile(manuscriptPath);
        openView('redclaw');
        return;
      }

      if (intent.type === 'view.open') {
        if (intent.view === 'approval') {
          setApprovalTargetRequestId('');
        }
        if (intent.view === 'skills' && intent.skillsAction === 'open-market') {
          setSkillsNavigationAction({ action: 'open-market', nonce: Date.now() });
        }
        openView(intent.view);
      }
    };

    window.addEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => {
      window.removeEventListener(REDBOX_NAVIGATE_EVENT, handleNavigate as EventListener);
    };
  }, [
    openView,
    setActiveManuscriptEditorFile,
    setApprovalTargetRequestId,
    setPendingGenerationIntent,
    setRedClawNavigationAction,
    setSettingsNavigationTarget,
    setSkillsNavigationAction,
  ]);

  useEffect(() => {
    const openedSessionIds = new Set<string>();
    const handleTeamRuntimeEvent = (...args: unknown[]) => {
      const event = eventFromArgs(args);
      if (event?.eventType !== 'runtime:collab-session-changed') return;
      const payload = recordFromUnknown(event.payload);
      const session = recordFromUnknown(payload.session);
      const sessionId = String(session.id || payload.collabSessionId || event.sessionId || '').trim();
      if (!sessionId || openedSessionIds.has(sessionId)) return;
      if (!shouldAutoOpenTeamSession(session)) return;
      openedSessionIds.add(sessionId);
      setRedClawNavigationAction({
        action: 'open-session',
        sessionId,
        nonce: Date.now(),
      });
      openView('redclaw');
    };

    window.ipcRenderer.teamRuntime.onEvent(handleTeamRuntimeEvent);
    return () => {
      window.ipcRenderer.teamRuntime.offEvent(handleTeamRuntimeEvent);
    };
  }, [openView, setRedClawNavigationAction]);
}
