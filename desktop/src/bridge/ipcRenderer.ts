import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  preflightGenerationMediaPayload,
  preflightInlineAttachmentPayload,
} from '../utils/mediaReferencePreflight';
import { APP_BRAND } from '../config/brand';

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
  'knowledge:get-file-index-dashboard': 'knowledge_get_file_index_dashboard',
  'knowledge:rebuild-catalog': 'knowledge_rebuild_catalog',
  'knowledge:open-index-root': 'knowledge_open_index_root',
  'redclaw:runner-status': 'redclaw_runner_status',
};
const explicitChannelByCommand = Object.fromEntries(
  Object.entries(explicitCommandRoutes).map(([channel, command]) => [command, channel]),
) as Record<string, string>;
const BROWSER_IPC_BASE_URL = 'http://127.0.0.1:31937/api/ipc';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const tauriWindow = window as unknown as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(tauriWindow.__TAURI_INTERNALS__ || tauriWindow.__TAURI__);
}

async function invokeBrowserHost(channel: string, payload?: unknown): Promise<any> {
  const response = await fetch(`${BROWSER_IPC_BASE_URL}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, payload: payload ?? null }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value
      ? String((value as { error?: unknown }).error || response.statusText)
      : response.statusText;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return value;
}

function browserPayloadForCommand(command: string, args?: unknown): unknown {
  if (
    command.startsWith('knowledge_')
    && args
    && typeof args === 'object'
    && Object.prototype.hasOwnProperty.call(args, 'payload')
  ) {
    return (args as { payload?: unknown }).payload ?? null;
  }
  return args;
}

async function invokeChannel(channel: string, payload?: unknown): Promise<any> {
  try {
    if (!isTauriRuntime()) {
      return await invokeBrowserHost(channel, payload);
    }
    const explicitCommand = explicitCommandRoutes[channel];
    if (explicitCommand) {
      return await invokeCommand(explicitCommand, payload);
    }
    return await invoke('ipc_invoke', { channel, payload: payload ?? null });
  } catch (error) {
    console.warn(`[] invoke failed for ${channel}:`, error);
    return buildFallbackResponse(channel, error, payload);
  }
}

function sendChannel(channel: string, payload?: unknown): void {
  if (!isTauriRuntime()) {
    void invokeBrowserHost(channel, payload).catch((error) => {
      console.warn(`[] browser send failed for ${channel}:`, error);
    });
    return;
  }
  void invoke('ipc_send', { channel, payload: payload ?? null }).catch((error) => {
    console.warn(`[] send failed for ${channel}:`, error);
  });
}

async function invokeCommand(command: string, args?: unknown): Promise<any> {
  try {
    if (!isTauriRuntime()) {
      const channel = explicitChannelByCommand[command];
      if (!channel) {
        throw new Error(`Browser host does not expose command "${command}"`);
      }
      return await invokeBrowserHost(channel, browserPayloadForCommand(command, args));
    }
    return await invoke(command, args as Record<string, unknown> | undefined);
  } catch (error) {
    console.warn(`[] command invoke failed for ${command}:`, error);
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
      console.warn(`[] invoke timed out for ${channel}:`, timeoutError.message);
      return resolveGuardFallback(channel, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[] invoke normalization failed for ${channel}:`, error);
        return resolveGuardFallback(channel, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    console.warn(`[] guarded invoke failed for ${channel}:`, error);
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
      console.warn(`[] command invoke timed out for ${command}:`, timeoutError.message);
      return resolveGuardFallback(fallbackKey, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[] command normalization failed for ${command}:`, error);
        return resolveGuardFallback(fallbackKey, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    return resolveGuardFallback(fallbackKey, error, options?.fallback);
  }
}

function dataUrlMimeType(dataUrl: string): string {
  const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
  return String(match?.[1] || '').trim().toLowerCase();
}

function dataUrlPayloadByteSize(dataUrl: string): number {
  const base64 = String(dataUrl || '').split(',', 2)[1] || '';
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function fileExtFromName(fileName: string): string {
  const match = String(fileName || '').match(/\.([^.]+)$/);
  return String(match?.[1] || '').trim().toLowerCase();
}

function inlineAttachmentFallback(payload: unknown): any {
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {};
  const dataUrl = String(record.dataUrl || '').trim();
  if (!dataUrl.startsWith('data:')) {
    return { success: false, error: `${APP_BRAND.displayName} inline attachment fallback missing dataUrl` };
  }
  const fileName = String(record.fileName || '').trim() || `inline-image-${Date.now()}.png`;
  const mimeType = dataUrlMimeType(dataUrl) || 'application/octet-stream';
  const kind = mimeType.startsWith('image/')
    ? 'image'
    : mimeType.startsWith('video/')
      ? 'video'
      : mimeType.startsWith('audio/')
        ? 'audio'
        : mimeType.startsWith('text/')
          ? 'text'
          : 'binary';

  return {
    success: true,
    attachment: {
      attachmentId: `inline-${Date.now()}`,
      type: 'uploaded-file',
      name: fileName,
      ext: fileExtFromName(fileName),
      size: dataUrlPayloadByteSize(dataUrl),
      thumbnailDataUrl: kind === 'image' ? dataUrl : undefined,
      inlineDataUrl: dataUrl,
      kind,
      mimeType,
      storageMode: 'inline',
      directUploadEligible: kind === 'image',
      processingStrategy: kind === 'image' ? 'media-tool' : 'unsupported',
      deliveryMode: kind === 'image' ? 'direct-input' : 'tool-read',
      intakeStatus: kind === 'image' ? 'ready' : 'unsupported',
      attachmentLifecycle: 'pending',
      capabilities: {
        directInput: kind === 'image',
        workspaceRead: false,
        textExtract: false,
        documentExtract: false,
        imageVision: kind === 'image',
        audioTranscribe: false,
        videoAnalyze: false,
        videoEdit: false,
      },
      deliveryPlan: {
        mode: kind === 'image' ? 'direct-input' : 'unsupported',
        requiresTool: kind !== 'image',
        reason: kind === 'image' ? '' : '浏览器回退上传没有工作区暂存路径，当前工具无法稳定读取。',
      },
      summary: fileName,
      requiresMultimodal: kind === 'image' || kind === 'audio' || kind === 'video',
    },
  };
}

function buildFallbackResponse(channel: string, error: unknown, payload?: unknown): any {
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
  if (channel.startsWith('videoEditorV2:')) {
    return { success: false, error: `${APP_BRAND.displayName} video editor V2 action failed: ${message}` };
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
        visualIndex: {
          totalUnits: 0,
          indexedUnits: 0,
          metadataOnlyUnits: 0,
          failedUnits: 0,
          retryDeferredUnits: 0,
          retryReadyUnits: 0,
          lastAttemptedAt: null,
        },
        pendingCount: 0,
        failedCount: 0,
        rebuildProgress: null,
        lastIndexedAt: null,
        isBuilding: false,
        lastError: null,
        migrationStatus: null,
        pendingRebuildReason: null,
      };
  }
  if (channel === 'knowledge:get-file-index-dashboard') {
    return {
      overall: {
        status: 'idle',
        indexedFiles: 0,
        totalFiles: 0,
        failedFiles: 0,
        lastIndexedAt: null,
      },
      lanes: [],
      scopes: [],
    };
  }
  if (channel === 'chat:get-sessions' || channel === 'work:list' || channel === 'work:ready') {
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
  if (channel === 'collab:sessions:list' || channel === 'team-runtime:list-sessions') {
    return [];
  }
  if (channel === 'team-runtime:list-agent-backends' || channel === 'team-runtime:list-tools') {
    return [];
  }
  if (channel === 'review:dockets:list' || channel === 'team-runtime:list-review-dockets') {
    return [];
  }
  if (channel.startsWith('review:dockets:')) {
    return { success: false, error: `${APP_BRAND.displayName} review docket action failed for "${channel}": ${message}` };
  }
  if (channel === 'collab:sessions:get' || channel === 'team-runtime:get-session') {
    return {
      session: null,
      members: [],
      tasks: [],
      mailbox: [],
      reports: [],
    };
  }
  if (channel.startsWith('collab:')) {
    return { success: false, error: `${APP_BRAND.displayName} collaboration action failed for "${channel}": ${message}` };
  }
  if (channel.startsWith('team-runtime:')) {
    return { success: false, error: `${APP_BRAND.displayName} team runtime action failed for "${channel}": ${message}` };
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
  if (channel === 'chat:create-inline-attachment') {
    return inlineAttachmentFallback(payload);
  }
  if (channel === 'chat:create-path-attachment') {
    return { success: false, error: `${APP_BRAND.displayName} path attachment unavailable: ${message}` };
  }
  if (channel === 'chat:discard-attachments') {
    return { success: true };
  }
  if (channel === 'chat:transcribe-audio') {
    return { success: false, error: `${APP_BRAND.displayName} audio transcription failed: ${message}` };
  }
  if (channel === 'audio:get-capture-capability') {
    return {
      success: true,
      available: false,
      activeRecording: false,
      reason: 'host_unavailable',
      message: `${APP_BRAND.displayName} audio capture unavailable: ${message}`,
    };
  }
  if (
    channel === 'audio:start-recording'
    || channel === 'audio:stop-recording'
    || channel === 'audio:cancel-recording'
    || channel === 'audio:open-microphone-settings'
  ) {
    return { success: false, error: `${APP_BRAND.displayName} audio action failed for "${channel}": ${message}` };
  }
  if (channel === 'file:show-in-folder' || channel === 'file:copy-image' || channel === 'file:save-as' || channel === 'file:preview-resolve') {
    return { success: false, error: `${APP_BRAND.displayName} file action failed for "${channel}": ${message}` };
  }
  if (channel === 'plugins:list') {
    return {
      success: true,
      schemaVersion: 1,
      root: '',
      plugins: [],
    };
  }
  if (channel === 'plugins:marketplace') {
    return {
      success: true,
      registryUrl: '',
      plugins: [],
    };
  }
  if (
    channel === 'plugins:install'
    || channel === 'plugins:install-marketplace'
    || channel === 'plugins:set-enabled'
    || channel === 'plugins:uninstall'
    || channel === 'plugins:open-data-dir'
    || channel === 'plugins:sync-capabilities'
    || channel === 'plugins:read-data'
  ) {
    return { success: false, error: `Thrive plugin action failed for "${channel}": ${message}` };
  }
  if (channel === 'plugins:home') {
    return { success: true, widgets: [], sidebarSections: [], quickActions: [] };
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
  if (channel === 'cli-runtime:inspect' || channel === 'cli-runtime:diagnose' || channel === 'cli-runtime:poll-execution') {
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
    return { success: false, error: `${APP_BRAND.displayName} CLI runtime action failed for "${channel}": ${message}` };
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
    return { success: false, error: `${APP_BRAND.displayName} diagnostics action failed for "${channel}": ${message}` };
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
    error: `${APP_BRAND.displayName} host request failed for "${channel}": ${message}`
  };
}

function on(channel: string, listener: Listener): void {
  if (!isTauriRuntime()) {
    return;
  }
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
            const visualRaw = (raw.visualIndex && typeof raw.visualIndex === 'object')
              ? raw.visualIndex as Record<string, unknown>
              : {};
            return {
              indexedCount: typeof raw.indexedCount === 'number' ? raw.indexedCount : 0,
              visualIndex: {
                totalUnits: typeof visualRaw.totalUnits === 'number' ? visualRaw.totalUnits : 0,
                indexedUnits: typeof visualRaw.indexedUnits === 'number' ? visualRaw.indexedUnits : 0,
                metadataOnlyUnits: typeof visualRaw.metadataOnlyUnits === 'number' ? visualRaw.metadataOnlyUnits : 0,
                failedUnits: typeof visualRaw.failedUnits === 'number' ? visualRaw.failedUnits : 0,
                retryDeferredUnits: typeof visualRaw.retryDeferredUnits === 'number' ? visualRaw.retryDeferredUnits : 0,
                retryReadyUnits: typeof visualRaw.retryReadyUnits === 'number' ? visualRaw.retryReadyUnits : 0,
                lastAttemptedAt: typeof visualRaw.lastAttemptedAt === 'string' ? visualRaw.lastAttemptedAt : null,
              },
              pendingCount: typeof raw.pendingCount === 'number' ? raw.pendingCount : 0,
              failedCount: typeof raw.failedCount === 'number' ? raw.failedCount : 0,
              rebuildProgress: typeof raw.rebuildProgress === 'number' ? raw.rebuildProgress : null,
              lastIndexedAt: typeof raw.lastIndexedAt === 'string' ? raw.lastIndexedAt : null,
              isBuilding: raw.isBuilding === true,
              lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
              migrationStatus: typeof raw.migrationStatus === 'string' ? raw.migrationStatus : null,
              pendingRebuildReason: typeof raw.pendingRebuildReason === 'string' ? raw.pendingRebuildReason : null,
            } as T;
          },
        },
      ),
      getFileIndexDashboard: async <T = Record<string, unknown>>() => {
        const value = await invokeCommand('knowledge_get_file_index_dashboard');
        return (value && typeof value === 'object') ? value as T : null as T;
      },
      rebuildCatalog: (payload?: { mode?: 'full' | 'fts' | 'canonicalBlocks' | 'canonicalReparse'; sourceId?: string; includeVisualIndex?: boolean }) => invokeCommandGuarded(
        'knowledge_rebuild_catalog',
        payload ? { payload } : undefined,
        {
        timeoutMs: 1800,
        fallbackChannel: 'knowledge:rebuild-catalog',
        },
      ),
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
      resolvePreview: (payload: { source: string }) => invokeChannel('file:preview-resolve', payload),
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
      delete: (payload: { id: string }) => invokeChannel('subjects:delete', payload),
      search: (payload?: Record<string, unknown>) => invokeChannel('subjects:search', payload || {}),
      categories: {
        list: () => invokeChannel('subjects:categories:list'),
        create: (payload: { name: string }) => invokeChannel('subjects:categories:create', payload),
        update: (payload: { id: string; name: string }) => invokeChannel('subjects:categories:update', payload),
        delete: (payload: { id: string }) => invokeChannel('subjects:categories:delete', payload)
      }
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
    getAppVersion: () => invokeChannel('app:get-version'),
    checkAppUpdate: (force = false) => invokeChannel('app:check-update', { force }),
    openAppReleasePage: (url?: string) => invokeChannel('app:open-release-page', { url }),
    openPath: (path: string) => invokeChannel('app:open-path', { path }),
    clipboardReadText: () => invokeChannel('clipboard:read-text'),
    openKnowledgeApiGuide: () => invokeChannel('app:open-knowledge-api-guide'),
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
      createPathAttachment: (payload: { path: string; sessionId?: string }) =>
        invokeChannel('chat:create-path-attachment', payload),
      createInlineAttachment: async (payload: { dataUrl: string; fileName?: string; sessionId?: string }) =>
        invokeChannel('chat:create-inline-attachment', await preflightInlineAttachmentPayload(payload)),
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
      createContextSession: (payload: { contextId: string; contextType: string; title?: string; initialContext?: string; metadata?: Record<string, unknown> }) =>
        invokeChannel('chat:create-context-session', payload),
      getOrCreateContextSession: (params: { contextId: string; contextType: string; title: string; initialContext?: string; metadata?: Record<string, unknown> }) =>
        invokeChannel('chat:getOrCreateContextSession', params),
      renameSession: (payload: { sessionId: string; title: string }) => invokeChannel('chat:rename-session', payload),
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
      submitImage: async (payload: Record<string, unknown>) =>
        invokeChannel('generation:submit-image', await preflightGenerationMediaPayload(payload)),
      submitVideo: async (payload: Record<string, unknown>) =>
        invokeChannel('generation:submit-video', await preflightGenerationMediaPayload(payload)),
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
    windowControls: {
      startDragging: () => isTauriRuntime()
        ? getCurrentWindow().startDragging()
        : Promise.resolve(),
    },
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
