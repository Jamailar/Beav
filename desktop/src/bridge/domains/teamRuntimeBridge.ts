import type { BridgeCore, Listener } from '../types';

function createTeamRuntimeApi(core: BridgeCore) {
  return {
    listSessions: () => core.invokeChannel('team-runtime:list-sessions'),
    createSession: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:create-session', payload),
    getSession: (payload: { sessionId: string; mailboxLimit?: number; reportLimit?: number }) =>
      core.invokeChannel('team-runtime:get-session', payload),
    listMembers: (payload: { sessionId: string }) => core.invokeChannel('team-runtime:list-members', payload),
    addMember: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:add-member', payload),
    setSessionCoordinator: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:set-session-coordinator', payload),
    matchMember: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:execute-tool', { action: 'team.member.match', payload }),
    renameMember: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:rename-member', payload),
    shutdownMember: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:shutdown-member', payload),
    listTasks: (payload: { sessionId: string }) => core.invokeChannel('team-runtime:list-tasks', payload),
    createTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:create-task', payload),
    updateTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:update-task', payload),
    claimTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:claim-task', payload),
    startTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:start-task', payload),
    waitReviewTask: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:wait-review-task', payload),
    completeTask: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:complete-task', payload),
    failTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:fail-task', payload),
    cancelTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:cancel-task', payload),
    pinTaskSession: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:pin-task-session', payload),
    retryTask: (payload: Record<string, unknown>) => core.invokeChannel('team-runtime:retry-task', payload),
    listReviewDockets: (payload: Record<string, unknown> = {}) =>
      core.invokeChannel('review:dockets:list', payload),
    getReviewDocket: (payload: { docketId: string }) => core.invokeChannel('review:dockets:get', payload),
    reviewDocketStats: () => core.invokeChannel('review:dockets:stats', {}),
    createReviewDocket: (payload: Record<string, unknown>) =>
      core.invokeChannel('review:dockets:create', payload),
    decideReviewDocket: (payload: Record<string, unknown>) =>
      core.invokeChannel('review:dockets:decide', payload),
    skipReviewDocket: (payload: { docketId: string }) => core.invokeChannel('review:dockets:skip', payload),
    archiveReviewDocket: (payload: { docketId: string }) =>
      core.invokeChannel('review:dockets:archive', payload),
    listMessages: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:list-messages', payload),
    readMailbox: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:read-mailbox', payload),
    sendMessage: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:send-message', payload),
    postMessage: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:send-message', payload),
    listReports: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:list-reports', payload),
    requestReport: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:request-report', payload),
    submitReport: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:submit-report', payload),
    attachArtifact: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:execute-tool', { action: 'team.artifact.attach', payload }),
    raiseBlocker: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:execute-tool', { action: 'team.blocker.raise', payload }),
    pauseSession: (payload: { sessionId: string }) =>
      core.invokeChannel('team-runtime:pause-session', payload),
    resumeSession: (payload: { sessionId: string }) =>
      core.invokeChannel('team-runtime:resume-session', payload),
    archiveSession: (payload: { sessionId: string }) =>
      core.invokeChannel('team-runtime:archive-session', payload),
    tickReports: (payload: { sessionId: string }) => core.invokeChannel('team-runtime:tick-reports', payload),
    listAgentBackends: () => core.invokeChannel('team-runtime:list-agent-backends'),
    listTools: () => core.invokeChannel('team-runtime:list-tools'),
    executeTool: (payload: { action: string; payload?: Record<string, unknown> }) =>
      core.invokeChannel('team-runtime:execute-tool', payload),
    runExternalMember: (payload: Record<string, unknown>) =>
      core.invokeChannel('team-runtime:run-external-member', payload),
    onEvent: (listener: Listener) => core.on('runtime:event', listener),
    offEvent: (listener: Listener) => core.off('runtime:event', listener),
  };
}

export function createTeamRuntimeBridge(core: BridgeCore) {
  const teamRuntime = createTeamRuntimeApi(core);
  return {
    teamRuntime,
    collab: teamRuntime,
  };
}
