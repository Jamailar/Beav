import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

type IpcListener = (...args: any[]) => void;
type ListenerMap = Map<IpcListener, () => void>;

const listenerRegistry = new Map<string, ListenerMap>();

function normalizePayload(payload: unknown[]): unknown {
  if (payload.length === 0) return undefined;
  if (payload.length === 1) return payload[0];
  return payload;
}

async function invokeChannel<T>(channel: string, payload?: unknown): Promise<T> {
  return invoke<T>('ipc_invoke', { channel, payload: payload ?? null });
}

async function sendChannel(channel: string, payload?: unknown): Promise<void> {
  await invoke('ipc_send', { channel, payload: payload ?? null });
}

function registerListener(channel: string, listener: IpcListener) {
  void listen(channel, (event) => {
    listener(event, event.payload);
  }).then((unlisten) => {
    const channelListeners = listenerRegistry.get(channel) ?? new Map<IpcListener, () => void>();
    channelListeners.set(listener, unlisten);
    listenerRegistry.set(channel, channelListeners);
  });
}

function removeListener(channel: string, listener: IpcListener) {
  const channelListeners = listenerRegistry.get(channel);
  const unlisten = channelListeners?.get(listener);
  if (!unlisten) return;
  unlisten();
  channelListeners?.delete(listener);
  if (channelListeners && channelListeners.size === 0) {
    listenerRegistry.delete(channel);
  }
}

function removeAllListeners(channel: string) {
  const channelListeners = listenerRegistry.get(channel);
  if (!channelListeners) return;
  for (const [, unlisten] of channelListeners.entries()) {
    unlisten();
  }
  listenerRegistry.delete(channel);
}

const ipcRenderer = {
  on(channel: string, listener: IpcListener) {
    registerListener(channel, listener);
  },
  off(channel: string, listener: IpcListener) {
    removeListener(channel, listener);
  },
  removeAllListeners(channel: string) {
    removeAllListeners(channel);
  },
  send(channel: string, ...args: unknown[]) {
    void sendChannel(channel, normalizePayload(args));
  },
  invoke(channel: string, payload?: unknown) {
    return invokeChannel(channel, payload);
  },

  saveSettings: (settings: unknown) => invokeChannel('db:save-settings', settings),
  getSettings: () => invokeChannel('db:get-settings'),
  getAppVersion: () => invokeChannel('app:get-version'),
  checkAppUpdate: (force = false) => invokeChannel('app:check-update', { force }),
  openAppReleasePage: (url?: string) => invokeChannel('app:open-release-page', { url }),

  debug: {
    getStatus: () => invokeChannel('debug:get-status'),
    getRecent: (limit?: number) => invokeChannel('debug:get-recent', { limit }),
    openLogDir: () => invokeChannel('debug:open-log-dir'),
  },

  sessionBridge: {
    getStatus: () => invokeChannel('session-bridge:status'),
    listSessions: () => invokeChannel('session-bridge:list-sessions'),
    getSession: (sessionId: string) => invokeChannel('session-bridge:get-session', { sessionId }),
    listPermissions: (payload?: unknown) => invokeChannel('session-bridge:list-permissions', payload ?? {}),
    createSession: (payload?: unknown) => invokeChannel('session-bridge:create-session', payload ?? {}),
    sendMessage: (payload: unknown) => invokeChannel('session-bridge:send-message', payload),
    resolvePermission: (payload: unknown) => invokeChannel('session-bridge:resolve-permission', payload),
  },

  browserPlugin: {
    getStatus: () => invokeChannel('plugin:browser-extension-status'),
    prepare: () => invokeChannel('plugin:prepare-browser-extension'),
    openDir: () => invokeChannel('plugin:open-browser-extension-dir'),
  },

  aiRoles: {
    list: () => invokeChannel('ai:roles:list'),
  },

  detectAiProtocol: (config: unknown) => invokeChannel('ai:detect-protocol', config),
  testAiConnection: (config: unknown) => invokeChannel('ai:test-connection', config),
  fetchModels: (config: unknown) => invokeChannel('ai:fetch-models', config),
  startChat: (message: string, modelConfig?: unknown) => {
    void sendChannel('ai:start-chat', { message, modelConfig });
  },
  cancelChat: () => {
    void sendChannel('ai:cancel');
  },
  confirmTool: (callId: string, confirmed: boolean) => {
    void sendChannel('ai:confirm-tool', { callId, confirmed });
  },

  sessions: {
    list: () => invokeChannel('sessions:list'),
    get: (sessionId: string) => invokeChannel('sessions:get', { sessionId }),
    resume: (sessionId: string) => invokeChannel('sessions:resume', { sessionId }),
    fork: (sessionId: string) => invokeChannel('sessions:fork', { sessionId }),
    getTranscript: (sessionId: string, limit?: number) => invokeChannel('sessions:get-transcript', { sessionId, limit }),
    getToolResults: (sessionId: string, limit?: number) => invokeChannel('sessions:get-tool-results', { sessionId, limit }),
  },

  runtime: {
    query: (payload: unknown) => invokeChannel('runtime:query', payload),
    resume: (payload: unknown) => invokeChannel('runtime:resume', payload),
    forkSession: (payload: unknown) => invokeChannel('runtime:fork-session', payload),
    getTrace: (payload: unknown) => invokeChannel('runtime:get-trace', payload),
    getCheckpoints: (payload: unknown) => invokeChannel('runtime:get-checkpoints', payload),
    getToolResults: (payload: unknown) => invokeChannel('runtime:get-tool-results', payload),
  },

  toolHooks: {
    list: () => invokeChannel('tools:hooks:list'),
    register: (hook: unknown) => invokeChannel('tools:hooks:register', hook),
    remove: (hookId: string) => invokeChannel('tools:hooks:remove', { hookId }),
  },

  toolDiagnostics: {
    list: () => invokeChannel('tools:diagnostics:list'),
    runDirect: (toolName: string) => invokeChannel('tools:diagnostics:run-direct', { toolName }),
    runAi: (toolName: string) => invokeChannel('tools:diagnostics:run-ai', { toolName }),
  },

  backgroundTasks: {
    list: () => invokeChannel('background-tasks:list'),
    get: (taskId: string) => invokeChannel('background-tasks:get', { taskId }),
    cancel: (taskId: string) => invokeChannel('background-tasks:cancel', { taskId }),
  },

  backgroundWorkers: {
    getPoolState: () => invokeChannel('background-workers:get-pool-state'),
  },

  tasks: {
    create: (payload?: unknown) => invokeChannel('tasks:create', payload ?? {}),
    list: (payload?: unknown) => invokeChannel('tasks:list', payload ?? {}),
    get: (payload: unknown) => invokeChannel('tasks:get', payload),
    resume: (payload: unknown) => invokeChannel('tasks:resume', payload),
    cancel: (payload: unknown) => invokeChannel('tasks:cancel', payload),
    trace: (payload: unknown) => invokeChannel('tasks:trace', payload),
  },

  work: {
    list: (payload?: unknown) => invokeChannel('work:list', payload ?? {}),
    get: (payload: unknown) => invokeChannel('work:get', payload),
    ready: (payload?: unknown) => invokeChannel('work:ready', payload ?? {}),
    update: (payload: unknown) => invokeChannel('work:update', payload),
  },

  subjects: {
    list: (payload?: unknown) => invokeChannel('subjects:list', payload ?? {}),
    get: (payload: unknown) => invokeChannel('subjects:get', payload),
    create: (payload: unknown) => invokeChannel('subjects:create', payload),
    update: (payload: unknown) => invokeChannel('subjects:update', payload),
    delete: (payload: unknown) => invokeChannel('subjects:delete', payload),
    search: (payload?: unknown) => invokeChannel('subjects:search', payload ?? {}),
    categories: {
      list: () => invokeChannel('subjects:categories:list'),
      create: (payload: unknown) => invokeChannel('subjects:categories:create', payload),
      update: (payload: unknown) => invokeChannel('subjects:categories:update', payload),
      delete: (payload: unknown) => invokeChannel('subjects:categories:delete', payload),
    },
  },

  chat: {
    send: (payload: unknown) => {
      void sendChannel('chat:send-message', payload);
    },
    pickAttachment: (payload?: unknown) => invokeChannel('chat:pick-attachment', payload ?? {}),
    transcribeAudio: (payload: unknown) => invokeChannel('chat:transcribe-audio', payload),
    cancel: (payload?: unknown) => {
      void sendChannel('chat:cancel', payload ?? {});
    },
    confirmTool: (callId: string, confirmed: boolean) => {
      void sendChannel('chat:confirm-tool', { callId, confirmed });
    },
    getSessions: () => invokeChannel('chat:get-sessions'),
    createSession: (title?: string) => invokeChannel('chat:create-session', title),
    getOrCreateContextSession: (payload: unknown) => invokeChannel('chat:getOrCreateContextSession', payload),
    deleteSession: (sessionId: string) => invokeChannel('chat:delete-session', sessionId),
    getMessages: (sessionId: string) => invokeChannel('chat:get-messages', sessionId),
    clearMessages: (sessionId: string) => invokeChannel('chat:clear-messages', sessionId),
    compactContext: (sessionId: string) => invokeChannel('chat:compact-context', sessionId),
    getContextUsage: (sessionId: string) => invokeChannel('chat:get-context-usage', sessionId),
    getRuntimeState: (sessionId: string) => invokeChannel('chat:get-runtime-state', sessionId),
  },

  redclawRunner: {
    getStatus: () => invokeChannel('redclaw:runner-status'),
    start: (payload?: unknown) => invokeChannel('redclaw:runner-start', payload ?? {}),
    stop: () => invokeChannel('redclaw:runner-stop'),
    runNow: (payload?: unknown) => invokeChannel('redclaw:runner-run-now', payload ?? {}),
    setProject: (payload: unknown) => invokeChannel('redclaw:runner-set-project', payload),
    setConfig: (payload?: unknown) => invokeChannel('redclaw:runner-set-config', payload ?? {}),
    listScheduled: () => invokeChannel('redclaw:runner-list-scheduled'),
    addScheduled: (payload: unknown) => invokeChannel('redclaw:runner-add-scheduled', payload),
    removeScheduled: (payload: unknown) => invokeChannel('redclaw:runner-remove-scheduled', payload),
    setScheduledEnabled: (payload: unknown) => invokeChannel('redclaw:runner-set-scheduled-enabled', payload),
    runScheduledNow: (payload: unknown) => invokeChannel('redclaw:runner-run-scheduled-now', payload),
    listLongCycle: () => invokeChannel('redclaw:runner-list-long-cycle'),
    addLongCycle: (payload: unknown) => invokeChannel('redclaw:runner-add-long-cycle', payload),
    removeLongCycle: (payload: unknown) => invokeChannel('redclaw:runner-remove-long-cycle', payload),
    setLongCycleEnabled: (payload: unknown) => invokeChannel('redclaw:runner-set-long-cycle-enabled', payload),
    runLongCycleNow: (payload: unknown) => invokeChannel('redclaw:runner-run-long-cycle-now', payload),
  },

  assistantDaemon: {
    getStatus: () => invokeChannel('assistant:daemon-status'),
    start: (payload?: unknown) => invokeChannel('assistant:daemon-start', payload ?? {}),
    stop: () => invokeChannel('assistant:daemon-stop'),
    setConfig: (payload?: unknown) => invokeChannel('assistant:daemon-set-config', payload ?? {}),
    startWeixinLogin: (payload?: unknown) => invokeChannel('assistant:daemon-weixin-login-start', payload ?? {}),
    waitForWeixinLogin: (payload?: unknown) => invokeChannel('assistant:daemon-weixin-login-wait', payload ?? {}),
  },

  wechatOfficial: {
    getStatus: () => invokeChannel('wechat-official:get-status'),
    bind: (payload: unknown) => invokeChannel('wechat-official:bind', payload),
    unbind: (payload?: unknown) => invokeChannel('wechat-official:unbind', payload ?? {}),
    createDraft: (payload: unknown) => invokeChannel('wechat-official:create-draft', payload),
  },

  mcp: {
    list: () => invokeChannel('mcp:list'),
    save: (servers: unknown[]) => invokeChannel('mcp:save', { servers }),
    test: (server: unknown) => invokeChannel('mcp:test', { server }),
    discoverLocal: () => invokeChannel('mcp:discover-local'),
    importLocal: () => invokeChannel('mcp:import-local'),
    oauthStatus: (serverId: string) => invokeChannel('mcp:oauth-status', { serverId }),
  },

  listSkills: () => invokeChannel('skills:list'),
  checkYtdlp: () => invokeChannel('youtube:check-ytdlp'),
  installYtdlp: () => invokeChannel('youtube:install'),
  updateYtdlp: () => invokeChannel('youtube:update'),
  fetchYoutubeInfo: (channelUrl: string) => invokeChannel('advisors:fetch-youtube-info', { channelUrl }),
  downloadYoutubeSubtitles: (params: unknown) => invokeChannel('advisors:download-youtube-subtitles', params),
  readYoutubeSubtitle: (videoId: string) => invokeChannel('knowledge:read-youtube-subtitle', videoId),
  refreshVideos: (advisorId: string, limit?: number) => invokeChannel('advisors:refresh-videos', { advisorId, limit }),
  getVideos: (advisorId: string) => invokeChannel('advisors:get-videos', { advisorId }),
  downloadVideo: (advisorId: string, videoId: string) => invokeChannel('advisors:download-video', { advisorId, videoId }),
  retryFailedVideos: (advisorId: string) => invokeChannel('advisors:retry-failed', { advisorId }),
  updateAdvisorYoutubeSettings: (advisorId: string, settings: unknown) => invokeChannel('advisors:update-youtube-settings', { advisorId, settings }),
  getAdvisorYoutubeRunnerStatus: () => invokeChannel('advisors:youtube-runner-status'),
  runAdvisorYoutubeNow: (advisorId?: string) => invokeChannel('advisors:youtube-runner-run-now', { advisorId }),
};

;(window as any).ipcRenderer = ipcRenderer;

// Tauri can also receive app-level events, so expose a thin bridge for future host events.
void emit('lexbox:renderer-ready', { ready: true });
