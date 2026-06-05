import { createAccountsBridge } from './domains/accountsBridge';
import { createAdvisorsBridge } from './domains/advisorsBridge';
import { createArchivesBridge } from './domains/archivesBridge';
import { createAudioVoiceBridge } from './domains/audioVoiceBridge';
import { createAuthBridge } from './domains/authBridge';
import { createBridgeCore } from './core';
import { createChatBridge } from './domains/chatBridge';
import { createCliRuntimeBridge } from './domains/cliRuntimeBridge';
import { createCoverBridge } from './domains/coverBridge';
import { createGenerationBridge } from './domains/generationBridge';
import { createKnowledgeBridge } from './domains/knowledgeBridge';
import { createManuscriptsBridge } from './domains/manuscriptsBridge';
import { createMcpBridge } from './domains/mcpBridge';
import { createMediaBridge } from './domains/mediaBridge';
import { createPluginsBridge } from './domains/pluginsBridge';
import { createRedClawBridge } from './domains/redclawBridge';
import { createRuntimeBridge } from './domains/runtimeBridge';
import { createSkillsBridge } from './domains/skillsBridge';
import { createSpacesBridge } from './domains/spacesBridge';
import { createSubjectsBridge } from './domains/subjectsBridge';
import { createSystemBridge } from './domains/systemBridge';
import { createTeamRuntimeBridge } from './domains/teamRuntimeBridge';
import { createToolsBridge } from './domains/toolsBridge';
import { createVideoEditorBridge } from './domains/videoEditorBridge';
import { createWanderBridge } from './domains/wanderBridge';
import type { InvokeGuardOptions } from './types';

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

    ...createSpacesBridge(core),
    ...createAdvisorsBridge(core),

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
    ...createChatBridge(core),
    ...createSubjectsBridge(core),
    ...createVideoEditorBridge(core),
    aiRoles: {
      list: () => invokeChannel('ai:roles:list')
    },
    detectAiProtocol: (config: unknown) => invokeChannel('ai:detect-protocol', config),
    testAiConnection: (config: unknown) => invokeChannel('ai:test-connection', config),
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
    ...createCoverBridge(core),
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
