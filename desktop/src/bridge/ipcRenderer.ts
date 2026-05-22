import { createBridgeCore } from './core';
import { createGenerationBridge } from './domains/generationBridge';
import { createKnowledgeBridge } from './domains/knowledgeBridge';
import { createManuscriptsBridge } from './domains/manuscriptsBridge';
import { createMediaBridge } from './domains/mediaBridge';
import { createSystemBridge } from './domains/systemBridge';
import type { InvokeGuardOptions, Listener } from './types';
import { preflightInlineAttachmentPayload } from '../utils/mediaReferencePreflight';

function createIpcRenderer() {
  const core = createBridgeCore();
  const {
    on,
    off,
    removeAllListeners,
    sendChannel,
    invokeChannel,
    invokeChannelGuarded,
    invokeCommand,
    invokeCommandGuarded,
  } = core;

  return {
    on,
    off,
    removeAllListeners,
    send: (channel: string, ...args: unknown[]) => sendChannel(channel, args.length <= 1 ? args[0] : args),
    invoke: (channel: string, ...args: unknown[]) => invokeChannel(channel, args.length <= 1 ? args[0] : args),
    invokeGuarded: <T = unknown>(channel: string, payload?: unknown, options?: InvokeGuardOptions<T>) =>
      invokeChannelGuarded<T>(channel, payload, options),
    command: <T = unknown>(command: string, args?: unknown) => invokeCommand(command, args) as Promise<T>,
    commandGuarded: <T = unknown>(command: string, args?: unknown, options?: InvokeGuardOptions<T> & { fallbackChannel?: string }) =>
      invokeCommandGuarded<T>(command, args, options),

    spaces: {
      list: () => invokeCommandGuarded<{ activeSpaceId?: string; spaces?: Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }> }>(
        'spaces_list',
        undefined,
        {
          timeoutMs: 2200,
          fallbackChannel: 'spaces:list',
          normalize: (value) => {
            const raw = (value && typeof value === 'object') ? value as {
              activeSpaceId?: unknown;
              spaces?: unknown;
            } : {};
            return {
              activeSpaceId: typeof raw.activeSpaceId === 'string' ? raw.activeSpaceId : undefined,
              spaces: Array.isArray(raw.spaces) ? raw.spaces as Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }> : undefined,
            };
          },
        },
      ),
      switch: (spaceId: string) => invokeChannel('spaces:switch', spaceId),
      create: () => Promise.resolve({ success: false, error: '创建新空间功能已关闭' }),
      rename: (payload: { id: string; name: string }) => invokeChannel('spaces:rename', payload),
      delete: (spaceId: string) => invokeChannel('spaces:delete', spaceId),
    },

    advisors: {
      list: <T = Record<string, unknown>>() => invokeCommandGuarded<Array<T>>(
        'advisors_list',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'advisors:list',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listTemplates: <T = Record<string, unknown>>() => invokeCommandGuarded<Array<T>>(
        'advisors_list_templates',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'advisors:list-templates',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      create: (payload: Record<string, unknown>) => invokeChannel('advisors:create', payload),
      update: (payload: Record<string, unknown>) => invokeChannel('advisors:update', payload),
      delete: (advisorId: string) => invokeChannel('advisors:delete', advisorId),
      pickKnowledgeFiles: <T = Record<string, unknown>>() => invokeChannel('advisors:pick-knowledge-files') as Promise<T>,
      pickKnowledgeFolder: <T = Record<string, unknown>>() => invokeChannel('advisors:pick-knowledge-folder') as Promise<T>,
      uploadKnowledge: (payload: string | { advisorId: string; filePaths?: string[] }) => invokeChannel('advisors:upload-knowledge', payload),
      deleteKnowledge: (payload: { advisorId: string; fileName: string }) => invokeChannel('advisors:delete-knowledge', payload),
      inspectMemberSkill: (payload: { advisorId: string }) => invokeChannel('advisors:inspect-member-skill', payload),
      distillMemberSkill: (payload: { advisorId: string }) => invokeChannel('members:enqueue-distillation', payload),
      promoteMemberSkillCandidate: (payload: { advisorId: string; candidateVersion?: string }) => invokeChannel('advisors:promote-member-skill-candidate', payload),
      discardMemberSkillCandidate: (payload: { advisorId: string }) => invokeChannel('advisors:discard-member-skill-candidate', payload),
      rollbackMemberSkillVersion: (payload: { advisorId: string; version: string }) => invokeChannel('advisors:rollback-member-skill-version', payload),
      optimizePrompt: (payload: Record<string, unknown>) => invokeChannel('advisors:optimize-prompt', payload),
      optimizePromptDeep: (payload: Record<string, unknown>) => invokeChannel('advisors:optimize-prompt-deep', payload),
      generatePersona: (payload: Record<string, unknown>) => invokeChannel('advisors:generate-persona', payload),
      selectAvatar: () => invokeChannel('advisors:select-avatar'),
    },

    ...createKnowledgeBridge(core),
    ...createMediaBridge(core),
    ...createManuscriptsBridge(core),

    ...createSystemBridge(core),
    officialAuth: {
      bootstrap: (payload?: { reason?: string }) => invokeChannel('redbox-auth:bootstrap', payload || {}),
      refresh: () => invokeChannel('redbox-auth:refresh'),
      getConfig: () => invokeChannel('redbox-auth:get-config'),
      getWechatStatus: (payload: { sessionId: string }) => invokeChannel('redbox-auth:wechat-status', payload),
      getWechatUrl: (payload?: { state?: string }) => invokeChannel('redbox-auth:wechat-url', payload || {}),
      sendSmsCode: (payload: { phone: string }) => invokeChannel('redbox-auth:send-sms-code', payload),
      loginSms: (payload: { phone: string; code: string; inviteCode?: string }) => invokeChannel('redbox-auth:login-sms', payload),
      registerSms: (payload: { phone: string; code: string; inviteCode?: string }) => invokeChannel('redbox-auth:register-sms', payload),
      getPricing: () => invokeChannel('redbox-auth:pricing'),
      refreshPricing: () => invokeChannel('redbox-auth:pricing-refresh')
    },
    llmReadiness: {
      getState: () => invokeChannel('llm-readiness:get-state'),
      refresh: () => invokeChannel('llm-readiness:refresh'),
      configureCustomSource: (payload: unknown) => invokeChannel('llm-readiness:configure-custom-source', payload),
      onStateChanged: (listener: Listener) => on('llm-readiness:state-changed', listener),
      offStateChanged: (listener: Listener) => off('llm-readiness:state-changed', listener),
    },
    auth: {
      getState: () => invokeChannel('auth:get-state'),
      loginSms: (payload: { phone: string; code: string; inviteCode?: string }) => invokeChannel('auth:login-sms', payload),
      loginWechatStart: (payload?: { state?: string }) => invokeChannel('auth:login-wechat-start', payload || {}),
      loginWechatPoll: (payload: { sessionId: string }) => invokeChannel('auth:login-wechat-poll', payload),
      logout: () => invokeChannel('auth:logout'),
      refreshNow: () => invokeChannel('auth:refresh-now'),
      onStateChanged: (listener: Listener) => on('auth:state-changed', listener),
      offStateChanged: (listener: Listener) => off('auth:state-changed', listener),
      onDataChanged: (listener: Listener) => on('auth:data-changed', listener),
      offDataChanged: (listener: Listener) => off('auth:data-changed', listener),
    },
    sessions: {
      list: () => invokeChannel('sessions:list'),
      get: (sessionId: string) => invokeChannel('sessions:get', { sessionId }),
      resume: (sessionId: string) => invokeChannel('sessions:resume', { sessionId }),
      fork: (sessionId: string) => invokeChannel('sessions:fork', { sessionId }),
      getTranscript: (sessionId: string, limit?: number) => invokeChannel('sessions:get-transcript', { sessionId, limit }),
      getToolResults: (sessionId: string, limit?: number) => invokeChannel('sessions:get-tool-results', { sessionId, limit })
    },
    sessionBridge: {
      getStatus: () => invokeChannel('session-bridge:status'),
      listSessions: () => invokeChannel('session-bridge:list-sessions'),
      getSession: (sessionId: string) => invokeChannel('session-bridge:get-session', { sessionId }),
      listPermissions: (payload?: { sessionId?: string }) => invokeChannel('session-bridge:list-permissions', payload || {}),
      createSession: (payload?: Record<string, unknown>) => invokeChannel('session-bridge:create-session', payload || {}),
      sendMessage: (payload: { sessionId: string; message: string }) => invokeChannel('session-bridge:send-message', payload),
      resolvePermission: (payload: { requestId: string; outcome: 'proceed_once' | 'proceed_always' | 'cancel' }) => invokeChannel('session-bridge:resolve-permission', payload)
    },
    runtime: {
      query: (payload: { sessionId?: string; message: string; modelConfig?: unknown }) => invokeChannel('runtime:query', payload),
      resume: (payload: { sessionId: string }) => invokeChannel('runtime:resume', payload),
      forkSession: (payload: { sessionId: string }) => invokeChannel('runtime:fork-session', payload),
      getTrace: (payload: { sessionId: string; limit?: number }) => invokeChannel('runtime:get-trace', payload),
      getCheckpoints: (payload: { sessionId: string; limit?: number }) => invokeChannel('runtime:get-checkpoints', payload),
      getToolResults: (payload: { sessionId: string; limit?: number }) => invokeChannel('runtime:get-tool-results', payload),
      listApprovals: () => invokeChannel('runtime:list-approvals')
    },
    taskPanel: {
      list: (payload?: { limit?: number }) => invokeChannel('task-panel:list', payload || {})
    },
    teamRuntime: {
      listSessions: () => invokeChannel('team-runtime:list-sessions'),
      createSession: (payload: Record<string, unknown>) => invokeChannel('team-runtime:create-session', payload),
      getSession: (payload: { sessionId: string; mailboxLimit?: number; reportLimit?: number }) =>
        invokeChannel('team-runtime:get-session', payload),
      listMembers: (payload: { sessionId: string }) => invokeChannel('team-runtime:list-members', payload),
      addMember: (payload: Record<string, unknown>) => invokeChannel('team-runtime:add-member', payload),
      setSessionCoordinator: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:set-session-coordinator', payload),
      matchMember: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:execute-tool', { action: 'team.member.match', payload }),
      renameMember: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:rename-member', payload),
      shutdownMember: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:shutdown-member', payload),
      listTasks: (payload: { sessionId: string }) => invokeChannel('team-runtime:list-tasks', payload),
      createTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:create-task', payload),
      updateTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:update-task', payload),
      claimTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:claim-task', payload),
      startTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:start-task', payload),
      waitReviewTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:wait-review-task', payload),
      completeTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:complete-task', payload),
      failTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:fail-task', payload),
      cancelTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:cancel-task', payload),
      pinTaskSession: (payload: Record<string, unknown>) => invokeChannel('team-runtime:pin-task-session', payload),
      retryTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:retry-task', payload),
      listReviewDockets: (payload: Record<string, unknown> = {}) => invokeChannel('review:dockets:list', payload),
      getReviewDocket: (payload: { docketId: string }) => invokeChannel('review:dockets:get', payload),
      reviewDocketStats: () => invokeChannel('review:dockets:stats', {}),
      createReviewDocket: (payload: Record<string, unknown>) => invokeChannel('review:dockets:create', payload),
      decideReviewDocket: (payload: Record<string, unknown>) => invokeChannel('review:dockets:decide', payload),
      skipReviewDocket: (payload: { docketId: string }) => invokeChannel('review:dockets:skip', payload),
      archiveReviewDocket: (payload: { docketId: string }) => invokeChannel('review:dockets:archive', payload),
      listMessages: (payload: Record<string, unknown>) => invokeChannel('team-runtime:list-messages', payload),
      readMailbox: (payload: Record<string, unknown>) => invokeChannel('team-runtime:read-mailbox', payload),
      sendMessage: (payload: Record<string, unknown>) => invokeChannel('team-runtime:send-message', payload),
      postMessage: (payload: Record<string, unknown>) => invokeChannel('team-runtime:send-message', payload),
      listReports: (payload: Record<string, unknown>) => invokeChannel('team-runtime:list-reports', payload),
      requestReport: (payload: Record<string, unknown>) => invokeChannel('team-runtime:request-report', payload),
      submitReport: (payload: Record<string, unknown>) => invokeChannel('team-runtime:submit-report', payload),
      attachArtifact: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:execute-tool', { action: 'team.artifact.attach', payload }),
      raiseBlocker: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:execute-tool', { action: 'team.blocker.raise', payload }),
      pauseSession: (payload: { sessionId: string }) => invokeChannel('team-runtime:pause-session', payload),
      resumeSession: (payload: { sessionId: string }) => invokeChannel('team-runtime:resume-session', payload),
      archiveSession: (payload: { sessionId: string }) => invokeChannel('team-runtime:archive-session', payload),
      tickReports: (payload: { sessionId: string }) => invokeChannel('team-runtime:tick-reports', payload),
      listAgentBackends: () => invokeChannel('team-runtime:list-agent-backends'),
      listTools: () => invokeChannel('team-runtime:list-tools'),
      executeTool: (payload: { action: string; payload?: Record<string, unknown> }) =>
        invokeChannel('team-runtime:execute-tool', payload),
      onEvent: (listener: Listener) => on('runtime:event', listener),
      offEvent: (listener: Listener) => off('runtime:event', listener)
    },
    collab: {
      listSessions: () => invokeChannel('team-runtime:list-sessions'),
      createSession: (payload: Record<string, unknown>) => invokeChannel('team-runtime:create-session', payload),
      getSession: (payload: { sessionId: string; mailboxLimit?: number; reportLimit?: number }) =>
        invokeChannel('team-runtime:get-session', payload),
      listMembers: (payload: { sessionId: string }) => invokeChannel('team-runtime:list-members', payload),
      addMember: (payload: Record<string, unknown>) => invokeChannel('team-runtime:add-member', payload),
      setSessionCoordinator: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:set-session-coordinator', payload),
      matchMember: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:execute-tool', { action: 'team.member.match', payload }),
      renameMember: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:rename-member', payload),
      shutdownMember: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:shutdown-member', payload),
      listTasks: (payload: { sessionId: string }) => invokeChannel('team-runtime:list-tasks', payload),
      createTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:create-task', payload),
      updateTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:update-task', payload),
      claimTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:claim-task', payload),
      startTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:start-task', payload),
      waitReviewTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:wait-review-task', payload),
      completeTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:complete-task', payload),
      failTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:fail-task', payload),
      cancelTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:cancel-task', payload),
      pinTaskSession: (payload: Record<string, unknown>) => invokeChannel('team-runtime:pin-task-session', payload),
      retryTask: (payload: Record<string, unknown>) => invokeChannel('team-runtime:retry-task', payload),
      listReviewDockets: (payload: Record<string, unknown> = {}) => invokeChannel('review:dockets:list', payload),
      getReviewDocket: (payload: { docketId: string }) => invokeChannel('review:dockets:get', payload),
      reviewDocketStats: () => invokeChannel('review:dockets:stats', {}),
      createReviewDocket: (payload: Record<string, unknown>) => invokeChannel('review:dockets:create', payload),
      decideReviewDocket: (payload: Record<string, unknown>) => invokeChannel('review:dockets:decide', payload),
      skipReviewDocket: (payload: { docketId: string }) => invokeChannel('review:dockets:skip', payload),
      archiveReviewDocket: (payload: { docketId: string }) => invokeChannel('review:dockets:archive', payload),
      listMessages: (payload: Record<string, unknown>) => invokeChannel('team-runtime:list-messages', payload),
      readMailbox: (payload: Record<string, unknown>) => invokeChannel('team-runtime:read-mailbox', payload),
      sendMessage: (payload: Record<string, unknown>) => invokeChannel('team-runtime:send-message', payload),
      postMessage: (payload: Record<string, unknown>) => invokeChannel('team-runtime:send-message', payload),
      listReports: (payload: Record<string, unknown>) => invokeChannel('team-runtime:list-reports', payload),
      requestReport: (payload: Record<string, unknown>) => invokeChannel('team-runtime:request-report', payload),
      submitReport: (payload: Record<string, unknown>) => invokeChannel('team-runtime:submit-report', payload),
      attachArtifact: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:execute-tool', { action: 'team.artifact.attach', payload }),
      raiseBlocker: (payload: Record<string, unknown>) =>
        invokeChannel('team-runtime:execute-tool', { action: 'team.blocker.raise', payload }),
      pauseSession: (payload: { sessionId: string }) => invokeChannel('team-runtime:pause-session', payload),
      resumeSession: (payload: { sessionId: string }) => invokeChannel('team-runtime:resume-session', payload),
      archiveSession: (payload: { sessionId: string }) => invokeChannel('team-runtime:archive-session', payload),
      tickReports: (payload: { sessionId: string }) => invokeChannel('team-runtime:tick-reports', payload),
      listAgentBackends: () => invokeChannel('team-runtime:list-agent-backends'),
      listTools: () => invokeChannel('team-runtime:list-tools'),
      executeTool: (payload: { action: string; payload?: Record<string, unknown> }) =>
        invokeChannel('team-runtime:execute-tool', payload),
      onEvent: (listener: Listener) => on('runtime:event', listener),
      offEvent: (listener: Listener) => off('runtime:event', listener)
    },
    cliRuntime: {
      detect: (payload?: { commands?: string[] }) => invokeChannel('cli-runtime:detect', payload || {}),
      discover: (payload?: { query?: string; limit?: number }) => invokeChannel('cli-runtime:discover', payload || {}),
      listTools: () => invokeChannel('cli-runtime:list-tools'),
      inspect: (payload: { toolId?: string; command?: string; executable?: string }) => invokeChannel('cli-runtime:inspect', payload),
      diagnose: (payload: { command: string; environmentId?: string; cwd?: string; executionMode?: string }) =>
        invokeChannel('cli-runtime:diagnose', payload),
      listEnvironments: () => invokeChannel('cli-runtime:list-environments'),
      createEnvironment: (payload: {
        scope: 'app-global' | 'workspace-local' | 'task-ephemeral';
        workspaceRoot?: string;
        taskId?: string;
      }) => invokeChannel('cli-runtime:create-environment', payload),
      install: (payload: {
        environmentId?: string;
        installMethod: string;
        spec: string;
        toolName?: string;
        executionMode?: string;
      }) => invokeChannel('cli-runtime:install', payload),
      execute: (payload: {
        environmentId: string;
        toolId?: string;
        argv: string[];
        cwd: string;
        executionMode?: string;
        usePty?: boolean;
        verificationRules?: unknown[];
      }) => invokeChannel('cli-runtime:execute', payload),
      cancelExecution: (payload: { executionId: string }) => invokeChannel('cli-runtime:cancel-execution', payload),
      pollExecution: (payload: { executionId: string }) => invokeChannel('cli-runtime:poll-execution', payload),
      verify: (payload: { executionId: string; rules: unknown[] }) => invokeChannel('cli-runtime:verify', payload),
      approveEscalation: (payload: { escalationId: string; scope: 'once' | 'session' | 'always' }) =>
        invokeChannel('cli-runtime:approve-escalation', payload),
      denyEscalation: (payload: { escalationId: string; reason?: string }) =>
        invokeChannel('cli-runtime:deny-escalation', payload),
    },
    toolHooks: {
      list: () => invokeChannel('tools:hooks:list'),
      register: (hook: unknown) => invokeChannel('tools:hooks:register', hook),
      remove: (hookId: string) => invokeChannel('tools:hooks:remove', { hookId })
    },
    backgroundTasks: {
      list: () => invokeChannel('background-tasks:list'),
      get: (taskId: string) => invokeChannel('background-tasks:get', { taskId }),
      cancel: (taskId: string) => invokeChannel('background-tasks:cancel', { taskId }),
      retry: (taskId: string) => invokeChannel('background-tasks:retry', { taskId }),
      archive: (taskId: string) => invokeChannel('background-tasks:archive', { taskId })
    },
    backgroundWorkers: {
      getPoolState: () => invokeChannel('background-workers:get-pool-state')
    },
    tasks: {
      create: (payload?: Record<string, unknown>) => invokeChannel('tasks:create', payload || {}),
      list: (payload?: Record<string, unknown>) => invokeChannel('tasks:list', payload || {}),
      get: (payload: { taskId: string }) => invokeChannel('tasks:get', payload),
      resume: (payload: { taskId: string }) => invokeChannel('tasks:resume', payload),
      cancel: (payload: { taskId: string }) => invokeChannel('tasks:cancel', payload),
      trace: (payload: { taskId: string; limit?: number }) => invokeChannel('tasks:trace', payload)
    },
    work: {
      list: (payload?: Record<string, unknown>) => invokeChannel('work:list', payload || {}),
      get: (payload: { id: string }) => invokeChannel('work:get', payload),
      ready: (payload?: Record<string, unknown>) => invokeChannel('work:ready', payload || {}),
      update: (payload: Record<string, unknown>) => invokeChannel('work:update', payload)
    },
    subjects: {
      list: (payload?: Record<string, unknown>) => invokeChannel('subjects:list', payload || {}),
      get: (payload: { id: string }) => invokeChannel('subjects:get', payload),
      create: (payload: unknown) => invokeChannel('subjects:create', payload),
      update: (payload: unknown) => invokeChannel('subjects:update', payload),
      generateCharacterCard: (payload: { id: string }) => invokeChannel('subjects:generate-character-card', payload),
      delete: (payload: { id: string }) => invokeChannel('subjects:delete', payload),
      search: (payload?: Record<string, unknown>) => invokeChannel('subjects:search', payload || {}),
      categories: {
        list: () => invokeChannel('subjects:categories:list'),
        create: (payload: { name: string }) => invokeChannel('subjects:categories:create', payload),
        update: (payload: { id: string; name: string }) => invokeChannel('subjects:categories:update', payload),
        delete: (payload: { id: string }) => invokeChannel('subjects:categories:delete', payload)
      }
    },
    brandWorkspace: {
      list: () => invokeChannel('brand-workspace:list'),
      get: (payload: { id: string }) => invokeChannel('brand-workspace:get', payload),
      upsertBrand: (payload: unknown) => invokeChannel('brand-workspace:brand:upsert', payload),
      upsertProduct: (payload: unknown) => invokeChannel('brand-workspace:product:upsert', payload),
      upsertSku: (payload: unknown) => invokeChannel('brand-workspace:sku:upsert', payload),
      upsertProductDetailPage: (payload: unknown) => invokeChannel('brand-workspace:product-detail-page:upsert', payload),
      rebuildAiIndex: () => invokeChannel('brand-workspace:rebuild-ai-index')
    },
    voice: {
      list: (payload?: Record<string, unknown>) => invokeChannel('voice:list', payload || {}),
      get: (payload: { voiceId: string }) => invokeChannel('voice:get', payload),
      clone: (payload: Record<string, unknown>) => invokeChannel('voice:clone', payload),
      bindAsset: (payload: Record<string, unknown>) => invokeChannel('voice:bind-asset', payload),
      speech: (payload: Record<string, unknown>) => invokeChannel('voice:speech', payload),
      delete: (payload: { voiceId: string }) => invokeChannel('voice:delete', payload),
    },
    videoEditorV2: {
      getOrCreateForManuscript: (payload: { manuscriptPath: string; title?: string }) =>
        invokeChannel('videoEditorV2:get-or-create-for-manuscript', payload),
      createProject: (payload?: Record<string, unknown>) => invokeChannel('videoEditorV2:create-project', payload || {}),
      getProject: (payload: { projectId: string }) => invokeChannel('videoEditorV2:get-project', payload),
      importAssets: (payload: { projectId: string; sourcePaths?: string[] }) => invokeChannel('videoEditorV2:import-assets', payload),
      importSrt: (payload: { projectId: string; assetId?: string; srtPath?: string; srtContent?: string; language?: string }) =>
        invokeChannel('videoEditorV2:import-srt', payload),
      runAsr: (payload: { projectId: string; assetId: string; language?: string }) => invokeChannel('videoEditorV2:run-asr', payload),
      updateSrtSegment: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:update-srt-segment', payload),
      mergeSrtSegments: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:merge-srt-segments', payload),
      splitSrtSegment: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:split-srt-segment', payload),
      setTimelineClipDisabled: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:set-timeline-clip-disabled', payload),
      trimTimelineClip: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:trim-timeline-clip', payload),
      splitTimelineClip: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:split-timeline-clip', payload),
      reorderTimelineClip: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:reorder-timeline-clip', payload),
      undoTimeline: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:undo-timeline', payload),
      generateAutoEdit: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:generate-auto-edit', payload),
      applyAutoEdit: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:apply-auto-edit', payload),
      render: (payload: Record<string, unknown>) => invokeChannel('videoEditorV2:render', payload),
    },
    audio: {
      getCaptureCapability: () => invokeChannel('audio:get-capture-capability'),
      startRecording: () => invokeChannel('audio:start-recording'),
      stopRecording: () => invokeChannel('audio:stop-recording'),
      cancelRecording: () => invokeChannel('audio:cancel-recording'),
      openMicrophoneSettings: () => invokeChannel('audio:open-microphone-settings'),
    },
    plugins: {
      list: () => invokeChannel('plugins:list'),
      marketplace: (payload?: { url?: string }) => invokeChannel('plugins:marketplace', payload || {}),
      install: (payload: { path: string }) => invokeChannel('plugins:install', payload),
      installMarketplace: (payload: { id?: string; repo: string; version?: string; packageUrl?: string }) =>
        invokeChannel('plugins:install-marketplace', payload),
      setEnabled: (payload: { pluginId: string; enabled: boolean }) =>
        invokeChannel('plugins:set-enabled', payload),
      uninstall: (payload: { pluginId: string }) => invokeChannel('plugins:uninstall', payload),
      openDataDir: (payload?: { pluginId?: string }) => invokeChannel('plugins:open-data-dir', payload || {}),
      syncCapabilities: () => invokeChannel('plugins:sync-capabilities'),
      readData: (payload: { pluginId: string; source: string; limit?: number; kind?: string; query?: string }) =>
        invokeChannel('plugins:read-data', payload),
      home: () => invokeChannel('plugins:home'),
    },
    aiRoles: {
      list: () => invokeChannel('ai:roles:list')
    },
    detectAiProtocol: (config: unknown) => invokeChannel('ai:detect-protocol', config),
    testAiConnection: (config: unknown) => invokeChannel('ai:test-connection', config),
    startChat: (message: string, modelConfig?: unknown) => sendChannel('ai:start-chat', { message, modelConfig }),
    cancelChat: () => sendChannel('ai:cancel'),
    confirmTool: (callId: string, confirmed: boolean) => sendChannel('ai:confirm-tool', { callId, confirmed }),
    chat: {
      send: (data: Record<string, unknown>) => sendChannel('chat:send-message', data),
      pickAttachment: (payload?: { sessionId?: string }) => invokeChannel('chat:pick-attachment', payload || {}),
      createPathAttachment: (payload: { path: string; sessionId?: string }) =>
        invokeChannel('chat:create-path-attachment', payload),
      createInlineAttachment: async (payload: { dataUrl: string; fileName?: string; sessionId?: string }) =>
        invokeChannel('chat:create-inline-attachment', await preflightInlineAttachmentPayload(payload)),
      createVideoThumbnail: (payload: { path?: string; source?: string; sessionId?: string }) =>
        invokeChannel('chat:create-video-thumbnail', payload),
      discardAttachments: (payload: { attachments: unknown[] }) =>
        invokeChannel('chat:discard-attachments', payload),
      transcribeAudio: (payload: Record<string, unknown>) => invokeChannel('chat:transcribe-audio', payload),
      cancel: (data?: { sessionId?: string } | string) => sendChannel('chat:cancel', data),
      confirmTool: (callId: string, confirmed: boolean) => sendChannel('chat:confirm-tool', { callId, confirmed }),
      getSessions: () => invokeChannel('chat:get-sessions'),
      createSession: (title?: string) => invokeChannel('chat:create-session', title),
      createDiagnosticsSession: (payload?: { title?: string; contextId?: string; contextType?: string }) =>
        invokeChannel('chat:create-diagnostics-session', payload || {}),
      listContextSessions: (payload: { contextId: string; contextType: string }) =>
        invokeChannel('chat:list-context-sessions', payload),
      createContextSession: (payload: { contextId: string; contextType: string; title?: string; initialContext?: string; workingDirectory?: string; metadata?: Record<string, unknown> }) =>
        invokeChannel('chat:create-context-session', payload),
      getOrCreateContextSession: (params: { contextId: string; contextType: string; title: string; initialContext?: string; workingDirectory?: string; metadata?: Record<string, unknown> }) =>
        invokeChannel('chat:getOrCreateContextSession', params),
      renameSession: (payload: { sessionId: string; title: string }) => invokeChannel('chat:rename-session', payload),
      deleteSession: (sessionId: string) => invokeChannel('chat:delete-session', sessionId),
      archiveSession: (sessionId: string) => invokeChannel('chat:archive-session', sessionId),
      unarchiveSession: (sessionId: string) => invokeChannel('chat:unarchive-session', sessionId),
      listArchivedSessions: () => invokeChannel('chat:list-archived-sessions'),
      getMessages: (sessionId: string) => invokeChannel('chat:get-messages', sessionId),
      clearMessages: (sessionId: string) => invokeChannel('chat:clear-messages', sessionId),
      compactContext: (sessionId: string) => invokeChannel('chat:compact-context', sessionId),
      getContextUsage: (sessionId: string) => invokeChannel('chat:get-context-usage', sessionId),
      getRuntimeState: (sessionId: string) => invokeChannel('chat:get-runtime-state', sessionId),
      bindEditorSession: (payload: Record<string, unknown>) => invokeChannel('chat:bind-editor-session', payload)
    },
    ...createGenerationBridge(core),
    redclawRunner: {
      getStatus: () => invokeCommandGuarded('redclaw_runner_status', undefined, {
        timeoutMs: 2800,
        fallbackChannel: 'redclaw:runner-status',
      }),
      start: (payload?: Record<string, unknown>) => invokeChannel('redclaw:runner-start', payload || {}),
      stop: () => invokeChannel('redclaw:runner-stop'),
      runNow: (payload?: Record<string, unknown>) => invokeChannel('redclaw:runner-run-now', payload || {}),
      setProject: (payload: Record<string, unknown>) => invokeChannel('redclaw:runner-set-project', payload),
      setConfig: (payload?: Record<string, unknown>) => invokeChannel('redclaw:runner-set-config', payload || {}),
      listScheduled: () => invokeChannel('redclaw:runner-list-scheduled'),
      addScheduled: (payload: Record<string, unknown>) => invokeChannel('redclaw:runner-add-scheduled', payload),
      removeScheduled: (payload: { taskId: string }) => invokeChannel('redclaw:runner-remove-scheduled', payload),
      setScheduledEnabled: (payload: { taskId: string; enabled: boolean }) => invokeChannel('redclaw:runner-set-scheduled-enabled', payload),
      runScheduledNow: (payload: { taskId: string }) => invokeChannel('redclaw:runner-run-scheduled-now', payload),
      listLongCycle: () => invokeChannel('redclaw:runner-list-long-cycle'),
      addLongCycle: (payload: Record<string, unknown>) => invokeChannel('redclaw:runner-add-long-cycle', payload),
      removeLongCycle: (payload: { taskId: string }) => invokeChannel('redclaw:runner-remove-long-cycle', payload),
      setLongCycleEnabled: (payload: { taskId: string; enabled: boolean }) => invokeChannel('redclaw:runner-set-long-cycle-enabled', payload),
      runLongCycleNow: (payload: { taskId: string }) => invokeChannel('redclaw:runner-run-long-cycle-now', payload),
      taskPreview: (payload: Record<string, unknown>) => invokeChannel('redclaw:task-preview', payload),
      taskCreate: (payload: Record<string, unknown>) => invokeChannel('redclaw:task-create', payload),
      taskConfirm: (payload: { draftId: string; confirm: boolean }) => invokeChannel('redclaw:task-confirm', payload),
      taskUpdate: (payload: { jobDefinitionId: string; patch: Record<string, unknown>; reason: string }) => invokeChannel('redclaw:task-update', payload),
      taskCancel: (payload: { jobDefinitionId: string; reason?: string; deleteSource?: boolean }) => invokeChannel('redclaw:task-cancel', payload),
      taskList: (payload?: { ownerScope?: string; includeDrafts?: boolean }) => invokeChannel('redclaw:task-list', payload || {}),
      taskStats: () => invokeChannel('redclaw:task-stats'),
    },
    redclawOrchestration: {
      createRun: (payload: { goal: string; sessionId?: string; projectId?: string; platform?: string; format?: string }) =>
        invokeChannel('redclaw:orchestration-create-run', payload),
      getRegistry: () => invokeChannel('redclaw:orchestration-registry'),
    },
    redclawProjects: {
      list: () => invokeChannel('redclaw:list-projects'),
      updateLearningCandidate: (payload: { projectId: string; candidateId: string; status: 'accepted' | 'rejected' | 'pending' }) =>
        invokeChannel('redclaw:learning-candidate-update', payload),
      updateSection: (payload: { projectId: string; sectionId: string; content: string }) =>
        invokeChannel('redclaw:project-section-update', payload),
      exportMediaPlan: (payload: { projectId: string }) =>
        invokeChannel('redclaw:media-plan-export', payload),
      renderRoughCut: (payload: { projectId: string }) =>
        invokeChannel('redclaw:media-plan-render', payload),
      exportPublishPackage: (payload: { projectId: string }) =>
        invokeChannel('redclaw:publish-package-export', payload),
      exportReviewReport: (payload: { projectId: string }) =>
        invokeChannel('redclaw:review-report-export', payload),
      exportXhsPackage: (payload: { projectId: string }) =>
        invokeChannel('redclaw:xhs-package-export', payload),
    },
    redclawProfile: {
      getBundle: () => invokeChannel('redclaw:profile:get-bundle'),
      updateDoc: (payload: { docType: 'agent' | 'soul' | 'user' | 'creator_profile'; markdown: string; reason?: string }) =>
        invokeChannel('redclaw:profile:update-doc', payload),
      getOnboardingStatus: () => invokeChannel('redclaw:profile:onboarding-status'),
      onboardingTurn: (payload: { input: string }) => invokeChannel('redclaw:profile:onboarding-turn', payload),
      saveInitializationProgress: (payload: { stepIndex: number; answers: Record<string, unknown> }) =>
        invokeChannel('redclaw:profile:save-initialization-progress', payload),
      completeInitialization: (payload: { answers: Record<string, unknown> }) =>
        invokeChannel('redclaw:profile:complete-initialization', payload),
      startStyleDefinition: (payload?: { forceRestart?: boolean; source?: string; sessionId?: string }) =>
        invokeChannel('redclaw:profile:start-style-definition', payload || {}),
      completeStyleDefinition: (payload: Record<string, unknown>) =>
        invokeChannel('redclaw:profile:complete-style-definition', payload),
    },
    assistantDaemon: {
      getStatus: () => invokeChannel('assistant:daemon-status'),
      start: (payload?: Record<string, unknown>) => invokeChannel('assistant:daemon-start', payload || {}),
      stop: () => invokeChannel('assistant:daemon-stop'),
      setConfig: (payload?: Record<string, unknown>) => invokeChannel('assistant:daemon-set-config', payload || {}),
      startWeixinLogin: (payload?: Record<string, unknown>) => invokeChannel('assistant:daemon-weixin-login-start', payload || {}),
      waitForWeixinLogin: (payload?: Record<string, unknown>) => invokeChannel('assistant:daemon-weixin-login-wait', payload || {})
    },
    wechatOfficial: {
      getStatus: () => invokeChannel('wechat-official:get-status'),
      bind: (payload: Record<string, unknown>) => invokeChannel('wechat-official:bind', payload),
      unbind: (payload?: Record<string, unknown>) => invokeChannel('wechat-official:unbind', payload || {}),
      createDraft: (payload: Record<string, unknown>) => invokeChannel('wechat-official:create-draft', payload)
    },
    listSkills: () => invokeChannel('skills:list'),
    skills: {
      save: (payload: Record<string, unknown>) => invokeChannel('skills:save', payload),
      create: (payload: { name: string }) => invokeChannel('skills:create', payload),
      enable: (payload: { name: string }) => invokeChannel('skills:enable', payload),
      disable: (payload: { name: string }) => invokeChannel('skills:disable', payload),
      uninstall: (payload: { name: string; scope?: 'user' | 'workspace' | string }) => invokeChannel('skills:uninstall', payload),
      marketplace: (payload?: { url?: string }) => invokeChannel('skills:marketplace', payload || {}),
      marketInstall: (payload: { slug?: string; id?: string; repo?: string; tag?: string; ref?: string; refName?: string }) =>
        invokeChannel('skills:market-install', payload),
      installFromRepo: (payload: {
        source?: string;
        url?: string;
        repo?: string;
        ref?: string;
        refName?: string;
        path?: string;
        paths?: string[];
        scope?: 'user' | 'workspace' | string;
      }) => invokeChannel('skills:install-from-repo', payload),
    },
    toolDiagnostics: {
      list: () => invokeChannel('tools:diagnostics:list'),
      runDirect: (toolName: string) => invokeChannel('tools:diagnostics:run-direct', { toolName }),
      runAi: (toolName: string) => invokeChannel('tools:diagnostics:run-ai', { toolName })
    },
    mcp: {
      list: () => invokeChannel('mcp:list'),
      add: (payload: {
        name: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        transport?: string;
        enabled?: boolean;
        bearerTokenEnvVar?: string;
      }) => invokeChannel('mcp:add', payload),
      get: (serverId: string) => invokeChannel('mcp:get', { serverId }),
      remove: (serverId: string) => invokeChannel('mcp:remove', { serverId }),
      enable: (serverId: string) => invokeChannel('mcp:enable', { serverId }),
      disable: (serverId: string) => invokeChannel('mcp:disable', { serverId }),
      save: (servers: unknown[]) => invokeChannel('mcp:save', { servers }),
      test: (server: unknown) => invokeChannel('mcp:test', { server }),
      call: (server: unknown, method: string, params?: unknown) => invokeChannel('mcp:call', { server, method, params: params ?? {} }),
      sessions: () => invokeChannel('mcp:sessions'),
      listTools: (server: unknown) => invokeChannel('mcp:list-tools', { server }),
      listResources: (server: unknown) => invokeChannel('mcp:list-resources', { server }),
      listResourceTemplates: (server: unknown) => invokeChannel('mcp:list-resource-templates', { server }),
      disconnect: (server: unknown) => invokeChannel('mcp:disconnect', { server }),
      disconnectAll: () => invokeChannel('mcp:disconnect-all'),
      discoverLocal: () => invokeChannel('mcp:discover-local'),
      importLocal: () => invokeChannel('mcp:import-local'),
      oauthStatus: (serverId: string) => invokeChannel('mcp:oauth-status', { serverId })
    },
    fetchYoutubeInfo: (channelUrl: string) => invokeChannel('advisors:fetch-youtube-info', { channelUrl }),
    downloadYoutubeSubtitles: (params: Record<string, unknown>) => invokeChannel('advisors:download-youtube-subtitles', params),
    refreshVideos: (advisorId: string, limit?: number) => invokeChannel('advisors:refresh-videos', { advisorId, limit }),
    getVideos: (advisorId: string) => invokeChannel('advisors:get-videos', { advisorId }),
    downloadVideo: (advisorId: string, videoId: string) => invokeChannel('advisors:download-video', { advisorId, videoId }),
    retryFailedVideos: (advisorId: string) => invokeChannel('advisors:retry-failed', { advisorId }),
    updateAdvisorYoutubeSettings: (advisorId: string, settings: unknown) => invokeChannel('advisors:update-youtube-settings', { advisorId, settings }),
    getAdvisorYoutubeRunnerStatus: () => invokeChannel('advisors:youtube-runner-status'),
    runAdvisorYoutubeNow: (advisorId?: string) => invokeChannel('advisors:youtube-runner-run-now', { advisorId })
    ,
    cover: {
      list: (payload?: Record<string, unknown>) => invokeChannel('cover:list', payload || {}),
      generate: (payload: Record<string, unknown>) => invokeChannel('cover:generate', payload),
      openRoot: () => invokeChannel('cover:open-root'),
      open: (payload: { assetId: string }) => invokeChannel('cover:open', payload),
      saveTemplateImage: (payload: { imageSource: string }) => invokeChannel('cover:save-template-image', payload),
      templates: {
        list: () => invokeChannel('cover:templates:list'),
        save: (payload: { template: Record<string, unknown> }) => invokeChannel('cover:templates:save', payload),
        delete: (payload: { templateId: string }) => invokeChannel('cover:templates:delete', payload),
        importLegacy: (payload: { templates: Record<string, unknown>[] }) => invokeChannel('cover:templates:import-legacy', payload),
      }
    }
  };
}

declare global {
  interface Window {
    ipcRenderer: ReturnType<typeof createIpcRenderer>;
  }
}

export function installIpcRendererBridge(): void {
  if (typeof window === 'undefined') return;
  if ((window as any).ipcRenderer) return;
  window.ipcRenderer = createIpcRenderer();
}
