import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Listener = (...args: any[]) => void;
type GuardedFallbackValue<T> = T | null | (() => T | null);
type InvokeGuardOptions<T> = {
  timeoutMs?: number;
  fallback?: GuardedFallbackValue<T>;
  normalize?: (value: unknown) => T;
};
type ListenerRecord = {
  pending?: Promise<() => void>;
  dispose?: () => void;
  disposed?: boolean;
};

const channelListeners = new Map<string, Map<Listener, ListenerRecord>>();
const explicitCommandRoutes: Record<string, string> = {
  'spaces:list': 'spaces_list',
  'advisors:list': 'advisors_list',
  'advisors:list-templates': 'advisors_list_templates',
  'knowledge:list': 'knowledge_list',
  'knowledge:list-youtube': 'knowledge_list_youtube',
  'knowledge:docs:list': 'knowledge_docs_list',
  'knowledge:list-page': 'knowledge_list_page',
  'knowledge:get-item-detail': 'knowledge_get_item_detail',
  'knowledge:get-index-status': 'knowledge_get_index_status',
  'knowledge:rebuild-catalog': 'knowledge_rebuild_catalog',
  'knowledge:open-index-root': 'knowledge_open_index_root',
  'redclaw:runner-status': 'redclaw_runner_status',
};

async function invokeChannel(channel: string, payload?: unknown): Promise<any> {
  try {
    const explicitCommand = explicitCommandRoutes[channel];
    if (explicitCommand) {
      return await invokeCommand(explicitCommand, payload);
    }
    return await invoke('ipc_invoke', { channel, payload: payload ?? null });
  } catch (error) {
    console.warn(`[RedBox] invoke failed for ${channel}:`, error);
    return buildFallbackResponse(channel, error);
  }
}

function sendChannel(channel: string, payload?: unknown): void {
  void invoke('ipc_send', { channel, payload: payload ?? null }).catch((error) => {
    console.warn(`[RedBox] send failed for ${channel}:`, error);
  });
}

async function invokeCommand(command: string, args?: unknown): Promise<any> {
  try {
    return await invoke(command, args as Record<string, unknown> | undefined);
  } catch (error) {
    console.warn(`[RedBox] command invoke failed for ${command}:`, error);
    throw error;
  }
}

function resolveGuardFallback<T>(channel: string, error: unknown, fallback?: GuardedFallbackValue<T>): T {
  if (typeof fallback === 'function') {
    return (fallback as () => T | null)() as T;
  }
  if (fallback !== undefined) {
    return fallback as T;
  }
  return buildFallbackResponse(channel, error) as T;
}

async function invokeChannelGuarded<T = unknown>(
  channel: string,
  payload?: unknown,
  options?: InvokeGuardOptions<T>,
): Promise<T> {
  const timeoutMs = Math.max(1, Number(options?.timeoutMs || 0));

  try {
    const value = timeoutMs > 0
      ? await Promise.race<unknown>([
          invokeChannel(channel, payload),
          new Promise((resolve) => {
            window.setTimeout(() => resolve(Symbol.for('__redbox_ipc_timeout__')), timeoutMs);
          }),
        ])
      : await invokeChannel(channel, payload);

    if (value === Symbol.for('__redbox_ipc_timeout__')) {
      const timeoutError = new Error(`Timed out after ${timeoutMs}ms`);
      console.warn(`[RedBox] invoke timed out for ${channel}:`, timeoutError.message);
      return resolveGuardFallback(channel, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[RedBox] invoke normalization failed for ${channel}:`, error);
        return resolveGuardFallback(channel, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    console.warn(`[RedBox] guarded invoke failed for ${channel}:`, error);
    return resolveGuardFallback(channel, error, options?.fallback);
  }
}

async function invokeCommandGuarded<T = unknown>(
  command: string,
  args?: unknown,
  options?: InvokeGuardOptions<T> & { fallbackChannel?: string },
): Promise<T> {
  const timeoutMs = Math.max(1, Number(options?.timeoutMs || 0));
  const fallbackKey = options?.fallbackChannel || command;

  try {
    const value = timeoutMs > 0
      ? await Promise.race<unknown>([
          invokeCommand(command, args),
          new Promise((resolve) => {
            window.setTimeout(() => resolve(Symbol.for('__redbox_ipc_timeout__')), timeoutMs);
          }),
        ])
      : await invokeCommand(command, args);

    if (value === Symbol.for('__redbox_ipc_timeout__')) {
      const timeoutError = new Error(`Timed out after ${timeoutMs}ms`);
      console.warn(`[RedBox] command invoke timed out for ${command}:`, timeoutError.message);
      return resolveGuardFallback(fallbackKey, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[RedBox] command normalization failed for ${command}:`, error);
        return resolveGuardFallback(fallbackKey, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    return resolveGuardFallback(fallbackKey, error, options?.fallback);
  }
}

function buildFallbackResponse(channel: string, error: unknown): any {
  const message = error instanceof Error ? error.message : String(error);

  if (channel === 'spaces:list') {
    return {
      activeSpaceId: 'default',
      spaces: [{ id: 'default', name: '默认空间' }],
    };
  }
  if (channel === 'media:list') {
    return { success: true, assets: [] };
  }
  if (channel === 'cover:list') {
    return { success: true, assets: [] };
  }
  if (
    channel === 'knowledge:list'
    || channel === 'knowledge:list-youtube'
    || channel === 'knowledge:docs:list'
    || channel === 'knowledge:list-page'
  ) {
    return [];
  }
  if (channel === 'knowledge:get-index-status') {
    return {
      indexedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      lastIndexedAt: null,
      isBuilding: false,
      lastError: null,
    };
  }
  if (channel === 'chat:get-sessions' || channel === 'chatrooms:list' || channel === 'work:list' || channel === 'work:ready') {
    return [];
  }
  if (channel === 'chat:list-context-sessions') {
    return [];
  }
  if (channel === 'chat:get-messages') {
    return [];
  }
  if (channel === 'chat:get-runtime-state') {
    return {
      success: true,
      isProcessing: false,
      partialResponse: '',
      updatedAt: Date.now(),
    };
  }
  if (channel === 'chat:get-context-usage') {
    return {
      success: true,
      estimatedTotalTokens: 0,
      estimatedEffectiveTokens: 0,
      compactThreshold: 0,
      compactRatio: 0,
      compactRounds: 0,
      compactUpdatedAt: null,
    };
  }
  if (channel === 'chat:pick-attachment') {
    return { success: true, canceled: true };
  }
  if (channel === 'chat:transcribe-audio') {
    return { success: false, error: `RedBox audio transcription failed: ${message}` };
  }
  if (channel === 'audio:get-capture-capability') {
    return {
      success: true,
      available: false,
      activeRecording: false,
      reason: 'host_unavailable',
      message: `RedBox audio capture unavailable: ${message}`,
    };
  }
  if (
    channel === 'audio:start-recording'
    || channel === 'audio:stop-recording'
    || channel === 'audio:cancel-recording'
    || channel === 'audio:open-microphone-settings'
  ) {
    return { success: false, error: `RedBox audio action failed for "${channel}": ${message}` };
  }
  if (channel === 'file:show-in-folder' || channel === 'file:copy-image' || channel === 'file:save-as') {
    return { success: false, error: `RedBox file action failed for "${channel}": ${message}` };
  }
  if (channel === 'youtube:check-ytdlp') {
    return { success: false, installed: false, error: `RedBox yt-dlp check failed: ${message}` };
  }
  if (channel === 'youtube:install' || channel === 'youtube:update') {
    return { success: false, error: `RedBox yt-dlp action failed: ${message}` };
  }
  if (channel === 'plugin:browser-extension-status') {
    return {
      success: true,
      bundled: false,
      exported: false,
      exportPath: '',
      bundledPath: '',
    };
  }
  if (channel === 'cli-runtime:detect') {
    return {
      success: true,
      tools: [],
    };
  }
  if (channel === 'cli-runtime:discover') {
    return {
      success: true,
      tools: [],
      query: null,
      limit: 100,
      truncated: false,
    };
  }
  if (channel === 'cli-runtime:list-tools' || channel === 'cli-runtime:list-environments') {
    return [];
  }
  if (channel === 'cli-runtime:inspect' || channel === 'cli-runtime:poll-execution') {
    return null;
  }
  if (
    channel === 'cli-runtime:create-environment'
    || channel === 'cli-runtime:install'
    || channel === 'cli-runtime:execute'
    || channel === 'cli-runtime:cancel-execution'
    || channel === 'cli-runtime:verify'
    || channel === 'cli-runtime:approve-escalation'
    || channel === 'cli-runtime:deny-escalation'
  ) {
    return { success: false, error: `RedBox CLI runtime action failed for "${channel}": ${message}` };
  }
  if (channel === 'indexing:get-stats') {
    return { totalStats: { vectors: 0, documents: 0 }, queue: [] };
  }
  if (channel === 'manuscripts:get-layout') {
    return {};
  }
  if (channel === 'generation:list-jobs') {
    return { success: true, items: [] };
  }
  if (channel === 'generation:list-job-summaries') {
    return { success: true, items: [] };
  }
  if (channel === 'generation:get-runtime-status') {
    return { success: true, runtimeReady: false, runtimeRunning: false };
  }
  if (channel === 'generation:get-job') {
    return null;
  }
  if (channel === 'wechat-official:get-status') {
    return { success: true, activeBinding: null, bindings: [] };
  }
  if (channel === 'app:check-update') {
    return { success: true, hasUpdate: false };
  }
  if (channel === 'debug:get-runtime-summary') {
    return {
      generatedAt: Date.now(),
      runtimeWarm: { lastWarmedAt: 0, entries: [] },
      approvals: { pendingCount: 0, resolvedCount: 0, pending: [], recent: [] },
      phase0: {
        personaGeneration: { count: 0, byAdvisor: [], recent: [] },
        knowledgeIngest: { count: 0, byAdvisor: [], recent: [] },
        runtimeQueries: { count: 0, byAdvisor: [], byMode: [], recent: [] },
        skillInvocations: { count: 0, bySkill: [], recent: [] },
        toolCalls: { count: 0, successCount: 0, successRate: 0, byAdvisor: [], byTool: [], recent: [] },
      }
    };
  }
  if (channel === 'logs:get-status') {
    return {
      enabled: true,
      logDirectory: '',
      reportDirectory: '',
      retentionDays: 7,
      maxFileMb: 10,
      recentPreviewLimit: 200,
      uploadConfigured: false,
      uploadEndpoint: null,
      pendingCount: 0,
      debugVerboseEnabled: false,
      previousUncleanShutdown: false,
    };
  }
  if (channel === 'logs:get-recent') {
    return { lines: [] };
  }
  if (channel === 'logs:list-pending-reports') {
    return [];
  }
  if (
    channel === 'logs:open-dir'
    || channel === 'logs:export-bundle'
    || channel === 'logs:upload-report'
    || channel === 'logs:dismiss-report'
    || channel === 'logs:set-upload-consent'
    || channel === 'logs:append-renderer'
  ) {
    return { success: false, error: `RedBox diagnostics action failed for "${channel}": ${message}` };
  }
  if (
    channel.endsWith(':list')
    || channel.includes('get-sessions')
    || channel.includes('list-sessions')
    || channel.includes('get-trace')
    || channel.includes('get-tool-results')
    || channel.includes('get-checkpoints')
    || channel.includes('messages')
    || channel.includes('history')
  ) {
    return [];
  }
  if (
    channel.includes(':get')
    || channel.includes(':status')
    || channel.includes(':oauth-status')
  ) {
    return null;
  }

  return {
    success: false,
    error: `RedBox host request failed for "${channel}": ${message}`
  };
}

function on(channel: string, listener: Listener): void {
  const entry: ListenerRecord = {};
  if (!channelListeners.has(channel)) {
    channelListeners.set(channel, new Map());
  }
  channelListeners.get(channel)!.set(listener, entry);

  entry.pending = listen(channel, (event) => {
    listener({ __tauri: true, channel }, event.payload);
  }).then((dispose) => {
    if (entry.disposed) {
      dispose();
      return dispose;
    }
    entry.dispose = dispose;
    return dispose;
  });
}

function off(channel: string, listener: Listener): void {
  const channelMap = channelListeners.get(channel);
  const record = channelMap?.get(listener);
  if (!record) return;

  record.disposed = true;
  if (record.dispose) {
    record.dispose();
  } else if (record.pending) {
    void record.pending.then((dispose) => dispose());
  }
  channelMap?.delete(listener);
  if (channelMap && channelMap.size === 0) {
    channelListeners.delete(channel);
  }
}

function removeAllListeners(channel: string): void {
  const channelMap = channelListeners.get(channel);
  if (!channelMap) return;
  for (const [listener, record] of channelMap.entries()) {
    record.disposed = true;
    if (record.dispose) {
      record.dispose();
    } else if (record.pending) {
      void record.pending.then((dispose) => dispose());
    }
    channelMap.delete(listener);
  }
  channelListeners.delete(channel);
}

function createIpcRenderer() {
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
              activeSpaceId: typeof raw.activeSpaceId === 'string' ? raw.activeSpaceId : 'default',
              spaces: Array.isArray(raw.spaces) ? raw.spaces as Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }> : [],
            };
          },
        },
      ),
      switch: (spaceId: string) => invokeChannel('spaces:switch', spaceId),
      create: (name: string) => invokeChannel('spaces:create', name),
      rename: (payload: { id: string; name: string }) => invokeChannel('spaces:rename', payload),
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
      uploadKnowledge: (payload: string | { advisorId: string; filePaths?: string[] }) => invokeChannel('advisors:upload-knowledge', payload),
      deleteKnowledge: (payload: { advisorId: string; fileName: string }) => invokeChannel('advisors:delete-knowledge', payload),
      optimizePrompt: (payload: Record<string, unknown>) => invokeChannel('advisors:optimize-prompt', payload),
      optimizePromptDeep: (payload: Record<string, unknown>) => invokeChannel('advisors:optimize-prompt-deep', payload),
      generatePersona: (payload: Record<string, unknown>) => invokeChannel('advisors:generate-persona', payload),
      selectAvatar: () => invokeChannel('advisors:select-avatar'),
    },

    knowledge: {
      listNotes: <T = Record<string, unknown>>() => invokeCommandGuarded<Array<T>>(
        'knowledge_list',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:list',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listYoutube: <T = Record<string, unknown>>() => invokeCommandGuarded<Array<T>>(
        'knowledge_list_youtube',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:list-youtube',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listDocs: <T = Record<string, unknown>>() => invokeCommandGuarded<Array<T>>(
        'knowledge_docs_list',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:docs:list',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listPage: <T = Record<string, unknown>>(payload?: Record<string, unknown>) => invokeCommandGuarded<T>(
        'knowledge_list_page',
        { payload: payload || {} },
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:list-page',
          normalize: (value) => {
            const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
            return {
              items: Array.isArray(raw.items) ? raw.items : [],
              nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
              total: typeof raw.total === 'number' ? raw.total : 0,
              kindCounts: (raw.kindCounts && typeof raw.kindCounts === 'object') ? raw.kindCounts : {},
            } as T;
          },
        },
      ),
      getItemDetail: <T = Record<string, unknown>>(payload: Record<string, unknown>) => invokeCommandGuarded<T | null>(
        'knowledge_get_item_detail',
        { payload },
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:get-item-detail',
          normalize: (value) => (value && typeof value === 'object') ? value as T : null,
        },
      ),
      getIndexStatus: <T = Record<string, unknown>>() => invokeCommandGuarded<T>(
        'knowledge_get_index_status',
        undefined,
        {
          timeoutMs: 1800,
          fallbackChannel: 'knowledge:get-index-status',
          normalize: (value) => {
            const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
            return {
              indexedCount: typeof raw.indexedCount === 'number' ? raw.indexedCount : 0,
              pendingCount: typeof raw.pendingCount === 'number' ? raw.pendingCount : 0,
              failedCount: typeof raw.failedCount === 'number' ? raw.failedCount : 0,
              lastIndexedAt: typeof raw.lastIndexedAt === 'string' ? raw.lastIndexedAt : null,
              isBuilding: raw.isBuilding === true,
              lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
            } as T;
          },
        },
      ),
      rebuildCatalog: () => invokeCommandGuarded('knowledge_rebuild_catalog', undefined, {
        timeoutMs: 1800,
        fallbackChannel: 'knowledge:rebuild-catalog',
      }),
      openIndexRoot: () => invokeCommandGuarded('knowledge_open_index_root', undefined, {
        timeoutMs: 1800,
        fallbackChannel: 'knowledge:open-index-root',
      }),
      deleteNote: (noteId: string) => invokeChannel('knowledge:delete', noteId),
      transcribe: (noteId: string) => invokeChannel('knowledge:transcribe', noteId),
      deleteYoutube: (videoId: string) => invokeChannel('knowledge:delete-youtube', videoId),
      retryYoutubeSubtitle: (videoId: string) => invokeChannel('knowledge:retry-youtube-subtitle', videoId),
      regenerateYoutubeSummaries: () => invokeChannel('knowledge:youtube-regenerate-summaries'),
      addDocFiles: () => invokeChannel('knowledge:docs:add-files'),
      addDocFolder: () => invokeChannel('knowledge:docs:add-folder'),
      addObsidianVault: () => invokeChannel('knowledge:docs:add-obsidian-vault'),
      deleteDocSource: (sourceId: string) => invokeChannel('knowledge:docs:delete-source', sourceId),
    },

    embedding: {
      getManuscriptCache: (manuscriptId: string) => invokeChannel('embedding:get-manuscript-cache', manuscriptId),
      compute: (content: string) => invokeChannel('embedding:compute', content),
      saveManuscriptCache: (payload: Record<string, unknown>) => invokeChannel('embedding:save-manuscript-cache', payload),
      getSortedSources: (embedding: unknown) => invokeChannel('embedding:get-sorted-sources', embedding),
    },

    similarity: {
      getCache: (manuscriptId: string) => invokeChannel('similarity:get-cache', manuscriptId),
      getKnowledgeVersion: () => invokeChannel('similarity:get-knowledge-version'),
      saveCache: (payload: Record<string, unknown>) => invokeChannel('similarity:save-cache', payload),
    },

    files: {
      showInFolder: (payload: { source: string }) => invokeChannel('file:show-in-folder', payload),
      copyImage: (payload: { source: string }) => invokeChannel('file:copy-image', payload),
      saveAs: (payload: { source: string; defaultName?: string }) => invokeChannel('file:save-as', payload),
    },
    notifications: {
      getPermissionState: () => invokeCommandGuarded('notifications_permission_state', undefined, {
        fallback: { state: 'unknown' },
      }),
      requestPermission: () => invokeCommandGuarded('notifications_request_permission', undefined, {
        fallback: { state: 'unknown' },
      }),
      showSystem: (payload: { title: string; body?: string; sound?: string }) => invokeCommandGuarded(
        'notifications_show_system',
        payload,
        {
          fallback: { success: false, error: 'System notifications unavailable' },
        },
      ),
    },

    saveSettings: (settings: unknown) => invokeChannel('db:save-settings', settings),
    getSettings: () => invokeChannel('db:get-settings'),
    pickWorkspaceDir: () => invokeChannel('settings:pick-workspace-dir'),
    debug: {
      getStatus: () => invokeChannel('debug:get-status'),
      getRecent: (limit?: number) => invokeChannel('debug:get-recent', { limit }),
      getRuntimeSummary: () => invokeChannel('debug:get-runtime-summary'),
      openLogDir: () => invokeChannel('debug:open-log-dir')
    },
    logs: {
      getStatus: () => invokeChannel('logs:get-status'),
      getRecent: (limit?: number) => invokeChannel('logs:get-recent', { limit }),
      openDir: () => invokeChannel('logs:open-dir'),
      listPendingReports: () => invokeChannel('logs:list-pending-reports'),
      exportBundle: (reportId?: string, payload?: { includeAdvancedContext?: boolean }) => invokeChannel('logs:export-bundle', { reportId, ...(payload || {}) }),
      uploadReport: (reportId: string) => invokeChannel('logs:upload-report', { reportId }),
      dismissReport: (reportId: string) => invokeChannel('logs:dismiss-report', { reportId }),
      setUploadConsent: (payload: { consent: 'none' | 'prompt' | 'approved'; autoSendSameCrash?: boolean }) => invokeChannel('logs:set-upload-consent', payload),
      appendRenderer: (payload: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'; category?: string; event?: string; message?: string; fields?: unknown }) => invokeChannel('logs:append-renderer', payload),
    },
    startupMigration: {
      getStatus: <T = Record<string, unknown>>() => invokeChannelGuarded<T>(
        'app:startup-migration-status',
        undefined,
        {
          timeoutMs: 1800,
          fallback: {
            status: 'not-needed',
            needsDbImport: false,
            needsProjectUpgrade: false,
            shouldShowModal: false,
            progress: 0,
            legacyMarkdownCount: 0,
            projectUpgradeCounts: null,
          } as T,
        },
      ),
      start: <T = Record<string, unknown>>() => invokeChannelGuarded<T>(
        'app:startup-migration-start',
        undefined,
        {
          timeoutMs: 1800,
          fallback: {
            status: 'failed',
            needsDbImport: true,
            needsProjectUpgrade: false,
            shouldShowModal: true,
            progress: 0,
            legacyMarkdownCount: 0,
            projectUpgradeCounts: null,
            error: '启动迁移失败',
          } as T,
        },
      ),
    },
    officialAuth: {
      bootstrap: (payload?: { reason?: string }) => invokeChannel('redbox-auth:bootstrap', payload || {}),
      refresh: () => invokeChannel('redbox-auth:refresh')
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
    cliRuntime: {
      detect: (payload?: { commands?: string[] }) => invokeChannel('cli-runtime:detect', payload || {}),
      discover: (payload?: { query?: string; limit?: number }) => invokeChannel('cli-runtime:discover', payload || {}),
      listTools: () => invokeChannel('cli-runtime:list-tools'),
      inspect: (payload: { toolId?: string; command?: string; executable?: string }) => invokeChannel('cli-runtime:inspect', payload),
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
      }) => invokeChannel('cli-runtime:install', payload),
      execute: (payload: {
        environmentId: string;
        toolId?: string;
        argv: string[];
        cwd: string;
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
      delete: (payload: { id: string }) => invokeChannel('subjects:delete', payload),
      search: (payload?: Record<string, unknown>) => invokeChannel('subjects:search', payload || {}),
      categories: {
        list: () => invokeChannel('subjects:categories:list'),
        create: (payload: { name: string }) => invokeChannel('subjects:categories:create', payload),
        update: (payload: { id: string; name: string }) => invokeChannel('subjects:categories:update', payload),
        delete: (payload: { id: string }) => invokeChannel('subjects:categories:delete', payload)
      }
    },
    getAppVersion: () => invokeChannel('app:get-version'),
    checkAppUpdate: (force = false) => invokeChannel('app:check-update', { force }),
    openAppReleasePage: (url?: string) => invokeChannel('app:open-release-page', { url }),
    openPath: (path: string) => invokeChannel('app:open-path', { path }),
    clipboardReadText: () => invokeChannel('clipboard:read-text'),
    openKnowledgeApiGuide: () => invokeChannel('app:open-knowledge-api-guide'),
    openRichpostThemeGuide: () => invokeChannel('app:open-richpost-theme-guide'),
    audio: {
      getCaptureCapability: () => invokeChannel('audio:get-capture-capability'),
      startRecording: () => invokeChannel('audio:start-recording'),
      stopRecording: () => invokeChannel('audio:stop-recording'),
      cancelRecording: () => invokeChannel('audio:cancel-recording'),
      openMicrophoneSettings: () => invokeChannel('audio:open-microphone-settings'),
    },
    browserPlugin: {
      getStatus: () => invokeChannel('plugin:browser-extension-status'),
      prepare: () => invokeChannel('plugin:prepare-browser-extension'),
      openDir: () => invokeChannel('plugin:open-browser-extension-dir')
    },
    fetchModels: (config: unknown) => invokeChannel('ai:fetch-models', config),
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
      createInlineAttachment: (payload: { dataUrl: string; fileName?: string; sessionId?: string }) =>
        invokeChannel('chat:create-inline-attachment', payload),
      transcribeAudio: (payload: Record<string, unknown>) => invokeChannel('chat:transcribe-audio', payload),
      cancel: (data?: { sessionId?: string } | string) => sendChannel('chat:cancel', data),
      confirmTool: (callId: string, confirmed: boolean) => sendChannel('chat:confirm-tool', { callId, confirmed }),
      getSessions: () => invokeChannel('chat:get-sessions'),
      createSession: (title?: string) => invokeChannel('chat:create-session', title),
      createDiagnosticsSession: (payload?: { title?: string; contextId?: string; contextType?: string }) =>
        invokeChannel('chat:create-diagnostics-session', payload || {}),
      listContextSessions: (payload: { contextId: string; contextType: string }) =>
        invokeChannel('chat:list-context-sessions', payload),
      createContextSession: (payload: { contextId: string; contextType: string; title?: string; initialContext?: string; metadata?: Record<string, unknown> }) =>
        invokeChannel('chat:create-context-session', payload),
      getOrCreateContextSession: (params: { contextId: string; contextType: string; title: string; initialContext?: string; metadata?: Record<string, unknown> }) =>
        invokeChannel('chat:getOrCreateContextSession', params),
      deleteSession: (sessionId: string) => invokeChannel('chat:delete-session', sessionId),
      getMessages: (sessionId: string) => invokeChannel('chat:get-messages', sessionId),
      clearMessages: (sessionId: string) => invokeChannel('chat:clear-messages', sessionId),
      compactContext: (sessionId: string) => invokeChannel('chat:compact-context', sessionId),
      getContextUsage: (sessionId: string) => invokeChannel('chat:get-context-usage', sessionId),
      getRuntimeState: (sessionId: string) => invokeChannel('chat:get-runtime-state', sessionId)
    },
    manuscripts: {
      confirmPackageScript: (payload: { filePath: string }) =>
        invokeChannel('manuscripts:confirm-package-script', payload),
    },
    generation: {
      submitImage: (payload: Record<string, unknown>) => invokeChannel('generation:submit-image', payload),
      submitVideo: (payload: Record<string, unknown>) => invokeChannel('generation:submit-video', payload),
      listJobSummaries: (payload?: Record<string, unknown>) => invokeChannel('generation:list-job-summaries', payload || {}),
      listJobs: (payload?: Record<string, unknown>) => invokeChannel('generation:list-jobs', payload || {}),
      getJob: (jobId: string) => invokeChannel('generation:get-job', { jobId }),
      getJobArtifacts: (jobId: string) => invokeChannel('generation:get-job-artifacts', { jobId }),
      awaitJob: (payload: { jobId: string; timeoutMs?: number }) => invokeChannel('generation:await-job', payload),
      cancelJob: (jobId: string) => invokeChannel('generation:cancel-job', { jobId }),
      retryJob: (jobId: string) => invokeChannel('generation:retry-job', { jobId }),
      getRuntimeStatus: () => invokeChannel('generation:get-runtime-status'),
      onJobUpdated: (listener: Listener) => on('generation:job-updated', listener),
      offJobUpdated: (listener: Listener) => off('generation:job-updated', listener),
      onJobLog: (listener: Listener) => on('generation:job-log', listener),
      offJobLog: (listener: Listener) => off('generation:job-log', listener),
    },
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
      taskCancel: (payload: { jobDefinitionId: string; reason?: string }) => invokeChannel('redclaw:task-cancel', payload),
      taskList: (payload?: { ownerScope?: string; includeDrafts?: boolean }) => invokeChannel('redclaw:task-list', payload || {}),
      taskStats: () => invokeChannel('redclaw:task-stats'),
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
      marketInstall: (payload: { slug: string; tag?: string }) => invokeChannel('skills:market-install', payload),
    },
    toolDiagnostics: {
      list: () => invokeChannel('tools:diagnostics:list'),
      runDirect: (toolName: string) => invokeChannel('tools:diagnostics:run-direct', { toolName }),
      runAi: (toolName: string) => invokeChannel('tools:diagnostics:run-ai', { toolName })
    },
    mcp: {
      list: () => invokeChannel('mcp:list'),
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
    checkYtdlp: () => invokeChannel('youtube:check-ytdlp'),
    installYtdlp: () => invokeChannel('youtube:install'),
    updateYtdlp: () => invokeChannel('youtube:update'),
    fetchYoutubeInfo: (channelUrl: string) => invokeChannel('advisors:fetch-youtube-info', { channelUrl }),
    downloadYoutubeSubtitles: (params: Record<string, unknown>) => invokeChannel('advisors:download-youtube-subtitles', params),
    readYoutubeSubtitle: (videoId: string) => invokeChannel('knowledge:read-youtube-subtitle', videoId),
    refreshVideos: (advisorId: string, limit?: number) => invokeChannel('advisors:refresh-videos', { advisorId, limit }),
    getVideos: (advisorId: string) => invokeChannel('advisors:get-videos', { advisorId }),
    downloadVideo: (advisorId: string, videoId: string) => invokeChannel('advisors:download-video', { advisorId, videoId }),
    retryFailedVideos: (advisorId: string) => invokeChannel('advisors:retry-failed', { advisorId }),
    updateAdvisorYoutubeSettings: (advisorId: string, settings: unknown) => invokeChannel('advisors:update-youtube-settings', { advisorId, settings }),
    getAdvisorYoutubeRunnerStatus: () => invokeChannel('advisors:youtube-runner-status'),
    runAdvisorYoutubeNow: (advisorId?: string) => invokeChannel('advisors:youtube-runner-run-now', { advisorId })
    ,
    cover: {
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
