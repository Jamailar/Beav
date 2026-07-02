import type { BridgeCore, Listener } from '../types';

export type RedClawTaskListPayload = {
  ownerScope?: string;
  includeDrafts?: boolean;
};

export type RedClawTaskUpdatePayload = {
  jobDefinitionId: string;
  patch: Record<string, unknown>;
  reason: string;
};

export type RedClawTaskCancelPayload = {
  jobDefinitionId: string;
  reason?: string;
  deleteSource?: boolean;
};

export type RedClawTaskConfirmPayload = {
  draftId: string;
  confirm: boolean;
};

export type RedClawScheduledTaskPayload = Record<string, unknown>;

const unavailable = (feature: string) => ({
  success: false,
  error: `${feature} is not available in the Electron archive build.`,
});

export function createRedClawBridge(core: BridgeCore) {
  return {
    redclawRunner: {
      getStatus: () => core.invokeCommandGuarded('redclaw_runner_status', undefined, {
        timeoutMs: 2800,
        fallbackChannel: 'redclaw:runner-status',
      }),
      start: (payload?: Record<string, unknown>) => core.invokeChannel('redclaw:runner-start', payload || {}),
      stop: () => core.invokeChannel('redclaw:runner-stop'),
      runNow: (payload?: Record<string, unknown>) => core.invokeChannel('redclaw:runner-run-now', payload || {}),
      setProject: (payload: Record<string, unknown>) => core.invokeChannel('redclaw:runner-set-project', payload),
      setConfig: (payload?: Record<string, unknown>) => core.invokeChannel('redclaw:runner-set-config', payload || {}),
      listScheduled: () => core.invokeChannel('redclaw:runner-list-scheduled'),
      addScheduled: (payload: RedClawScheduledTaskPayload) => core.invokeChannel('redclaw:runner-add-scheduled', payload),
      removeScheduled: (payload: { taskId: string }) => core.invokeChannel('redclaw:runner-remove-scheduled', payload),
      setScheduledEnabled: (payload: { taskId: string; enabled: boolean }) =>
        core.invokeChannel('redclaw:runner-set-scheduled-enabled', payload),
      runScheduledNow: (payload: { taskId: string }) => core.invokeChannel('redclaw:runner-run-scheduled-now', payload),
      listLongCycle: () => core.invokeChannel('redclaw:runner-list-long-cycle'),
      addLongCycle: (payload: Record<string, unknown>) => core.invokeChannel('redclaw:runner-add-long-cycle', payload),
      removeLongCycle: (payload: { taskId: string }) => core.invokeChannel('redclaw:runner-remove-long-cycle', payload),
      setLongCycleEnabled: (payload: { taskId: string; enabled: boolean }) =>
        core.invokeChannel('redclaw:runner-set-long-cycle-enabled', payload),
      runLongCycleNow: (payload: { taskId: string }) => core.invokeChannel('redclaw:runner-run-long-cycle-now', payload),
      taskPreview: (payload: Record<string, unknown>) => core.invokeChannel('redclaw:task-preview', payload),
      taskCreate: (payload: Record<string, unknown>) => core.invokeChannel('redclaw:task-create', payload),
      taskConfirm: (payload: RedClawTaskConfirmPayload) => core.invokeChannel('redclaw:task-confirm', payload),
      taskUpdate: (payload: RedClawTaskUpdatePayload) => core.invokeChannel('redclaw:task-update', payload),
      taskCancel: (payload: RedClawTaskCancelPayload) => core.invokeChannel('redclaw:task-cancel', payload),
      taskList: (payload?: RedClawTaskListPayload) => core.invokeChannel('redclaw:task-list', payload || {}),
      taskStats: () => core.invokeChannel('redclaw:task-stats'),
      onStatus: (listener: Listener) => core.on('redclaw:runner-status', listener),
      offStatus: (listener: Listener) => core.off('redclaw:runner-status', listener),
      onTaskEvent: (listener: Listener) => core.on('redclaw:task-event', listener),
      offTaskEvent: (listener: Listener) => core.off('redclaw:task-event', listener),
    },
    redclawOrchestration: {
      createRun: (payload: { goal: string; sessionId?: string; projectId?: string; platform?: string; format?: string }) =>
        core.invokeChannelGuarded('redclaw:orchestration-create-run', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw orchestration runs'),
        }),
      getRegistry: () => core.invokeChannelGuarded('redclaw:orchestration-registry', undefined, {
        timeoutMs: 3200,
        fallback: { success: true, registry: {}, unavailable: true },
      }),
    },
    redclawProjects: {
      list: () => core.invokeChannel('redclaw:list-projects'),
      updateLearningCandidate: (payload: { projectId: string; candidateId: string; status: 'accepted' | 'rejected' | 'pending' }) =>
        core.invokeChannelGuarded('redclaw:learning-candidate-update', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw learning candidate updates'),
        }),
      updateSection: (payload: { projectId: string; sectionId: string; content: string }) =>
        core.invokeChannelGuarded('redclaw:project-section-update', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw project section updates'),
        }),
      exportMediaPlan: (payload: { projectId: string }) =>
        core.invokeChannelGuarded('redclaw:media-plan-export', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw media plan export'),
        }),
      renderRoughCut: (payload: { projectId: string }) =>
        core.invokeChannelGuarded('redclaw:media-plan-render', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw rough cut render'),
        }),
      exportPublishPackage: (payload: { projectId: string }) =>
        core.invokeChannelGuarded('redclaw:publish-package-export', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw publish package export'),
        }),
      exportReviewReport: (payload: { projectId: string }) =>
        core.invokeChannelGuarded('redclaw:review-report-export', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw review report export'),
        }),
      exportXhsPackage: (payload: { projectId: string }) =>
        core.invokeChannelGuarded('redclaw:xhs-package-export', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw XHS package export'),
        }),
    },
    redclawProfile: {
      getBundle: () => core.invokeChannel('redclaw:profile:get-bundle'),
      updateDoc: (payload: { docType: 'agent' | 'soul' | 'user' | 'creator_profile'; markdown: string; reason?: string }) =>
        core.invokeChannel('redclaw:profile:update-doc', payload),
      getOnboardingStatus: () => core.invokeChannel('redclaw:profile:onboarding-status'),
      onboardingTurn: (payload: { input: string }) => core.invokeChannel('redclaw:profile:onboarding-turn', payload),
      saveInitializationProgress: (payload: { stepIndex: number; answers: Record<string, unknown> }) =>
        core.invokeChannel('redclaw:profile:save-initialization-progress', payload),
      completeInitialization: (payload: { answers: Record<string, unknown> }) =>
        core.invokeChannel('redclaw:profile:complete-initialization', payload),
      startStyleDefinition: (payload?: { forceRestart?: boolean; source?: string; sessionId?: string }) =>
        core.invokeChannelGuarded('redclaw:profile:start-style-definition', payload || {}, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw style definition'),
        }),
      completeStyleDefinition: (payload: Record<string, unknown>) =>
        core.invokeChannelGuarded('redclaw:profile:complete-style-definition', payload, {
          timeoutMs: 3200,
          fallback: unavailable('RedClaw style definition completion'),
        }),
    },
  };
}
