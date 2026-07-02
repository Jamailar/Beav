import type { BridgeCore } from '../types';

export function createSessionsBridge(core: BridgeCore) {
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
  };
}
