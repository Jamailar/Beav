import { createAccountsBridge } from './domains/accountsBridge';
import { createArchivesBridge } from './domains/archivesBridge';
import { createAudioVoiceBridge } from './domains/audioVoiceBridge';
import { createAuthBridge } from './domains/authBridge';
import { createBridgeCore } from './core';
import { createCliRuntimeBridge } from './domains/cliRuntimeBridge';
import { createGenerationBridge } from './domains/generationBridge';
import { createKnowledgeBridge } from './domains/knowledgeBridge';
import { createManuscriptsBridge } from './domains/manuscriptsBridge';
import { createMcpBridge } from './domains/mcpBridge';
import { createMediaBridge } from './domains/mediaBridge';
import { createPluginsBridge } from './domains/pluginsBridge';
import { createRedClawBridge } from './domains/redclawBridge';
import { createRuntimeBridge } from './domains/runtimeBridge';
import { createSkillsBridge } from './domains/skillsBridge';
import { createSystemBridge } from './domains/systemBridge';
import { createTeamRuntimeBridge } from './domains/teamRuntimeBridge';
import { createToolsBridge } from './domains/toolsBridge';
import { createWanderBridge } from './domains/wanderBridge';
import type { InvokeGuardOptions } from './types';
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
    ...createAccountsBridge(core),
    ...createArchivesBridge(core),
    ...createMediaBridge(core),
    ...createManuscriptsBridge(core),
    ...createSkillsBridge(core),
    ...createWanderBridge(core),

    ...createSystemBridge(core),
    ...createRuntimeBridge(core),
    ...createTeamRuntimeBridge(core),
    ...createCliRuntimeBridge(core),
    ...createAudioVoiceBridge(core),
    ...createPluginsBridge(core),
    ...createToolsBridge(core),
    ...createAuthBridge(core),
    ...createMcpBridge(core),
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
    ...createRedClawBridge(core),
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
