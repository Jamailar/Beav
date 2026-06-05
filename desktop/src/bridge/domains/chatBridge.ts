import { preflightInlineAttachmentPayload } from '../../utils/mediaReferencePreflight';
import type { BridgeCore } from '../types';

export function createChatBridge(core: BridgeCore) {
  return {
    sessions: {
      list: () => core.invokeChannel('sessions:list'),
      get: (sessionId: string) => core.invokeChannel('sessions:get', { sessionId }),
      resume: (sessionId: string) => core.invokeChannel('sessions:resume', { sessionId }),
      fork: (sessionId: string) => core.invokeChannel('sessions:fork', { sessionId }),
      getTranscript: (sessionId: string, limit?: number) =>
        core.invokeChannel('sessions:get-transcript', { sessionId, limit }),
      getToolResults: (sessionId: string, limit?: number) =>
        core.invokeChannel('sessions:get-tool-results', { sessionId, limit }),
    },
    sessionBridge: {
      getStatus: () => core.invokeChannel('session-bridge:status'),
      listSessions: () => core.invokeChannel('session-bridge:list-sessions'),
      getSession: (sessionId: string) => core.invokeChannel('session-bridge:get-session', { sessionId }),
      listPermissions: (payload?: { sessionId?: string }) =>
        core.invokeChannel('session-bridge:list-permissions', payload || {}),
      createSession: (payload?: Record<string, unknown>) =>
        core.invokeChannel('session-bridge:create-session', payload || {}),
      sendMessage: (payload: { sessionId: string; message: string }) =>
        core.invokeChannel('session-bridge:send-message', payload),
      resolvePermission: (payload: { requestId: string; outcome: 'proceed_once' | 'proceed_always' | 'cancel' }) =>
        core.invokeChannel('session-bridge:resolve-permission', payload),
    },
    startChat: (message: string, modelConfig?: unknown) =>
      core.sendChannel('ai:start-chat', { message, modelConfig }),
    cancelChat: () => core.sendChannel('ai:cancel'),
    confirmTool: (callId: string, confirmed: boolean) =>
      core.sendChannel('ai:confirm-tool', { callId, confirmed }),
    chat: {
      send: (data: Record<string, unknown>) => core.sendChannel('chat:send-message', data),
      pickAttachment: (payload?: { sessionId?: string }) =>
        core.invokeChannel('chat:pick-attachment', payload || {}),
      createPathAttachment: (payload: { path: string; sessionId?: string }) =>
        core.invokeChannel('chat:create-path-attachment', payload),
      createInlineAttachment: async (payload: { dataUrl: string; fileName?: string; sessionId?: string }) =>
        core.invokeChannel('chat:create-inline-attachment', await preflightInlineAttachmentPayload(payload)),
      createVideoThumbnail: (payload: { path?: string; source?: string; sessionId?: string }) =>
        core.invokeChannel('chat:create-video-thumbnail', payload),
      discardAttachments: (payload: { attachments: unknown[] }) =>
        core.invokeChannel('chat:discard-attachments', payload),
      transcribeAudio: (payload: Record<string, unknown>) => core.invokeChannel('chat:transcribe-audio', payload),
      cancel: (data?: { sessionId?: string } | string) => core.sendChannel('chat:cancel', data),
      confirmTool: (callId: string, confirmed: boolean) =>
        core.sendChannel('chat:confirm-tool', { callId, confirmed }),
      getSessions: () => core.invokeChannel('chat:get-sessions'),
      createSession: (title?: string) => core.invokeChannel('chat:create-session', title),
      createDiagnosticsSession: (payload?: { title?: string; contextId?: string; contextType?: string }) =>
        core.invokeChannel('chat:create-diagnostics-session', payload || {}),
      listContextSessions: (payload: { contextId: string; contextType: string }) =>
        core.invokeChannel('chat:list-context-sessions', payload),
      listContextSessionsGuarded: <T = Record<string, unknown>>(payload: { contextId: string; contextType: string }) =>
        core.invokeChannelGuarded<Array<T> | null>('chat:list-context-sessions', payload, {
          timeoutMs: 3200,
          fallback: null,
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        }),
      createContextSession: (payload: {
        contextId: string;
        contextType: string;
        title?: string;
        initialContext?: string;
        workingDirectory?: string;
        metadata?: Record<string, unknown>;
      }) => core.invokeChannel('chat:create-context-session', payload),
      createContextSessionGuarded: <T = Record<string, unknown>>(payload: {
        contextId: string;
        contextType: string;
        title?: string;
        initialContext?: string;
        workingDirectory?: string;
        metadata?: Record<string, unknown>;
      }) => core.invokeChannelGuarded<T | null>('chat:create-context-session', payload, {
        timeoutMs: 3200,
        fallback: null,
      }),
      getOrCreateContextSession: (params: {
        contextId: string;
        contextType: string;
        title: string;
        initialContext?: string;
        workingDirectory?: string;
        metadata?: Record<string, unknown>;
      }) => core.invokeChannel('chat:getOrCreateContextSession', params),
      renameSession: (payload: { sessionId: string; title: string }) =>
        core.invokeChannel('chat:rename-session', payload),
      deleteSession: (sessionId: string) => core.invokeChannel('chat:delete-session', sessionId),
      archiveSession: (sessionId: string) => core.invokeChannel('chat:archive-session', sessionId),
      unarchiveSession: (sessionId: string) => core.invokeChannel('chat:unarchive-session', sessionId),
      listArchivedSessions: () => core.invokeChannel('chat:list-archived-sessions'),
      getMessages: (sessionId: string) => core.invokeChannel('chat:get-messages', sessionId),
      clearMessages: (sessionId: string) => core.invokeChannel('chat:clear-messages', sessionId),
      compactContext: (sessionId: string) => core.invokeChannel('chat:compact-context', sessionId),
      getContextUsage: (sessionId: string) => core.invokeChannel('chat:get-context-usage', sessionId),
      getRuntimeState: (sessionId: string) => core.invokeChannel('chat:get-runtime-state', sessionId),
      bindEditorSession: (payload: Record<string, unknown>) =>
        core.invokeChannel('chat:bind-editor-session', payload),
    },
  };
}
