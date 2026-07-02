import { createBridgeCore } from './core';
import { createAccountsBridge } from './domains/accountsBridge';
import { createAdvisorsBridge } from './domains/advisorsBridge';
import { createAiConfigBridge } from './domains/aiConfigBridge';
import { createAnalyticsBridge } from './domains/analyticsBridge';
import { createAppBridge } from './domains/appBridge';
import { createArchivesBridge } from './domains/archivesBridge';
import { createAssistantControlBridge } from './domains/assistantControlBridge';
import { createAuthBridge } from './domains/authBridge';
import { createAudioVoiceBridge } from './domains/audioVoiceBridge';
import { createCaptureBridge } from './domains/captureBridge';
import { createChatBridge } from './domains/chatBridge';
import { createCliRuntimeBridge } from './domains/cliRuntimeBridge';
import { createCoverBridge } from './domains/coverBridge';
import { createFilesBridge } from './domains/filesBridge';
import { createGenerationBridge } from './domains/generationBridge';
import { createKnowledgeBridge } from './domains/knowledgeBridge';
import { createManuscriptsBridge } from './domains/manuscriptsBridge';
import { createMediaBridge } from './domains/mediaBridge';
import { createMcpBridge } from './domains/mcpBridge';
import { createNotificationsBridge } from './domains/notificationsBridge';
import { createPluginsBridge } from './domains/pluginsBridge';
import { createRedClawBridge } from './domains/redclawBridge';
import { createRuntimeBridge } from './domains/runtimeBridge';
import { createSettingsBridge } from './domains/settingsBridge';
import { createSessionsBridge } from './domains/sessionsBridge';
import { createSkillsBridge } from './domains/skillsBridge';
import { createSpacesBridge } from './domains/spacesBridge';
import { createSubjectsBridge } from './domains/subjectsBridge';
import { createSystemBridge } from './domains/systemBridge';
import { createTeamRuntimeBridge } from './domains/teamRuntimeBridge';
import { createToolsBridge } from './domains/toolsBridge';
import { createTopicCenterBridge } from './domains/topicCenterBridge';
import { createWanderBridge } from './domains/wanderBridge';
import { createVideoEditorBridge } from './domains/videoEditorBridge';
import { createWindowControlsBridge } from './domains/windowControlsBridge';

type Listener = (...args: any[]) => void;
type ElectronIpcTransport = {
  on: (channel: string, listener: Listener) => void;
  off: (channel: string, listener: Listener) => void;
  removeAllListeners: (channel: string) => void;
  send: (channel: string, payload?: unknown) => void;
  invoke: (channel: string, payload?: unknown) => Promise<any>;
};
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
  'knowledge:get-file-index-dashboard': 'knowledge_get_file_index_dashboard',
  'knowledge:get-file-index-scope-status': 'knowledge_get_file_index_scope_status',
  'redclaw:runner-status': 'redclaw_runner_status',
};
const explicitChannelByCommand = Object.fromEntries(
  Object.entries(explicitCommandRoutes).map(([channel, command]) => [command, channel]),
) as Record<string, string>;

function getElectronTransport(): ElectronIpcTransport | null {
  if (typeof window === 'undefined') return null;
  const transport = (window as typeof window & { __RED_ELECTRON_IPC__?: Partial<ElectronIpcTransport> }).__RED_ELECTRON_IPC__;
  if (
    transport
    && typeof transport.invoke === 'function'
    && typeof transport.send === 'function'
    && typeof transport.on === 'function'
    && typeof transport.off === 'function'
    && typeof transport.removeAllListeners === 'function'
  ) {
    return transport as ElectronIpcTransport;
  }
  return null;
}

async function invokeChannel(channel: string, payload?: unknown): Promise<any> {
  try {
    const transport = getElectronTransport();
    if (!transport) {
      throw new Error('Electron IPC transport is unavailable');
    }
    return await transport.invoke(channel, payload ?? null);
  } catch (error) {
    console.warn(`[RedBox] invoke failed for ${channel}:`, error);
    return buildFallbackResponse(channel, error);
  }
}

function sendChannel(channel: string, payload?: unknown): void {
  const transport = getElectronTransport();
  if (!transport) {
    console.warn(`[RedBox] send skipped for ${channel}: Electron IPC transport is unavailable`);
    return;
  }
  transport.send(channel, payload ?? null);
}

async function invokeCommand(command: string, args?: unknown): Promise<any> {
  try {
    const transport = getElectronTransport();
    if (!transport) {
      throw new Error('Electron IPC transport is unavailable');
    }
    return await transport.invoke(explicitChannelByCommand[command] || command, args ?? null);
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

  if (channel === 'auth:get-state') {
    return {
      status: 'anonymous',
      loggedIn: false,
      session: null,
      user: null,
      points: null,
      models: [],
      callRecords: [],
      degradedReason: 'electron-archive-official-auth-unavailable',
      lastError: null,
      lastErrorKind: null,
      lastRefreshAt: null,
      nextRefreshAtMs: null,
    };
  }
  if (channel === 'redbox-auth:bootstrap') {
    return {
      success: false,
      loggedIn: false,
      session: null,
      data: null,
      error: '官方账号未登录',
      reason: 'electron-archive-official-auth-unavailable',
    };
  }
  if (
    channel === 'redbox-auth:refresh'
    || channel === 'redbox-auth:me'
    || channel === 'redbox-auth:points'
    || channel === 'redbox-auth:call-records'
    || channel === 'auth:refresh-now'
  ) {
    return {
      success: false,
      loggedIn: false,
      session: null,
      data: null,
      error: '官方账号未登录',
      reason: 'electron-archive-official-auth-unavailable',
    };
  }
  if (channel === 'redbox-auth:get-config') {
    return {
      success: true,
      realm: 'cn',
      baseURL: '',
      loggedIn: false,
      unavailable: true,
    };
  }
  if (channel === 'redbox-auth:products' || channel === 'redbox-auth:pricing' || channel === 'redbox-auth:pricing-refresh') {
    return {
      success: true,
      products: [],
      pricing: [],
      unavailable: true,
    };
  }
  if (channel === 'redbox-auth:product') {
    return {
      success: false,
      product: null,
      error: 'Official products are unavailable in the Electron archive',
    };
  }
  if (
    channel === 'redbox-auth:set-realm'
    || channel === 'redbox-auth:wechat-status'
    || channel === 'redbox-auth:wechat-url'
    || channel === 'redbox-auth:send-sms-code'
    || channel === 'redbox-auth:login-sms'
    || channel === 'redbox-auth:register-sms'
    || channel === 'redbox-auth:logout'
    || channel === 'redbox-auth:create-page-pay-order'
    || channel === 'redbox-auth:order-status'
    || channel === 'redbox-auth:open-payment-form'
  ) {
    return {
      success: false,
      loggedIn: false,
      error: 'Official auth is unavailable in the Electron archive',
    };
  }
  if (channel === 'llm-readiness:get-state') {
    return {
      ready: false,
      mode: 'custom',
      reason: 'electron-archive-official-auth-unavailable',
      officialLoggedIn: false,
      canUseOfficial: false,
      canUseCustom: true,
      updatedAt: new Date().toISOString(),
    };
  }
  if (channel === 'llm-readiness:refresh' || channel === 'llm-readiness:configure-custom-source') {
    return {
      success: false,
      ready: false,
      reason: 'electron-archive-official-auth-unavailable',
    };
  }
  if (
    channel === 'auth:login-sms'
    || channel === 'auth:login-wechat-start'
    || channel === 'auth:login-wechat-poll'
    || channel === 'auth:logout'
  ) {
    return {
      success: false,
      status: 'anonymous',
      loggedIn: false,
      error: 'Official auth is unavailable in the Electron archive',
    };
  }
  if (channel === 'spaces:list') {
    return {
      activeSpaceId: 'default',
      spaces: [{ id: 'default', name: '默认空间' }],
    };
  }
  if (
    channel === 'advisors:distill-member-skill'
    || channel === 'advisors:promote-member-skill-candidate'
    || channel === 'advisors:discard-member-skill-candidate'
    || channel === 'advisors:rollback-member-skill-version'
  ) {
    return {
      success: false,
      error: '成员技能管理后端尚未迁移到 Electron 开源版',
    };
  }
  if (channel === 'subjects:generate-character-card') {
    return {
      success: false,
      error: `RedBox subject character card generation failed: ${message}`,
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
  if (channel === 'knowledge:get-file-index-scope-status') {
    return {
      scopeId: '',
      name: '',
      scopeType: '',
      ownerId: '',
      ownerName: '',
      fileCount: 0,
      status: 'idle',
      failedCount: 0,
      lanes: [],
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
  if (channel === 'task-panel:list') {
    return { success: true, items: [], count: 0 };
  }
  if (channel === 'background-tasks:list') {
    return [];
  }
  if (channel === 'background-tasks:get') {
    return null;
  }
  if (
    channel === 'background-tasks:cancel'
    || channel === 'background-tasks:retry'
    || channel === 'background-tasks:archive'
  ) {
    return { success: false, error: `RedBox background task action failed for "${channel}": ${message}` };
  }
  if (channel === 'background-workers:get-pool-state') {
    return { json: [], runtime: [] };
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
  if (channel === 'review:dockets:stats') {
    return {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      changesRequested: 0,
      skipped: 0,
      archived: 0,
      expiredPending: 0,
      linkedTasks: 0,
    };
  }
  if (channel.startsWith('review:dockets:')) {
    return { success: false, error: `RedBox review docket action failed for "${channel}": ${message}` };
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
    return { success: false, error: `RedBox collaboration action failed for "${channel}": ${message}` };
  }
  if (channel.startsWith('team-runtime:')) {
    return { success: false, error: `RedBox team runtime action failed for "${channel}": ${message}` };
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
  if (channel === 'chat:create-path-attachment') {
    return { success: false, error: `RedBox path attachment failed: ${message}` };
  }
  if (channel === 'chat:create-video-thumbnail') {
    return { success: false, error: `RedBox video thumbnail failed: ${message}` };
  }
  if (channel === 'chat:discard-attachments') {
    return { success: false, error: `RedBox attachment cleanup failed: ${message}` };
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
  if (
    channel === 'capture:create-server-job'
    || channel === 'capture:get-server-job'
    || channel === 'capture:list-server-jobs'
  ) {
    return {
      success: false,
      status: 'unavailable',
      jobs: channel === 'capture:list-server-jobs' ? [] : undefined,
      error: 'Server capture is unavailable in the Electron archive',
    };
  }
  if (channel === 'accounts:list') {
    return { success: true, accounts: [] };
  }
  if (channel === 'accounts:get') {
    return { success: false, account: null, error: 'Creator account profiles are unavailable in the Electron archive' };
  }
  if (channel === 'mcp:list') {
    return { success: true, servers: [], items: [], sessions: [] };
  }
  if (channel === 'mcp:sessions') {
    return { success: true, sessions: [] };
  }
  if (channel === 'mcp:discover-local') {
    return { success: true, items: [] };
  }
  if (channel === 'mcp:disconnect' || channel === 'mcp:disconnect-all') {
    return { success: true, disconnected: channel === 'mcp:disconnect-all' ? 0 : true, sessions: [] };
  }
  if (channel === 'mcp:oauth-status') {
    return { success: true, connected: false, tokenPath: '' };
  }
  if (
    channel === 'mcp:list-tools'
    || channel === 'mcp:list-resources'
    || channel === 'mcp:list-resource-templates'
  ) {
    return { success: true, response: [], session: null, capabilities: null };
  }
  if (
    channel === 'mcp:add'
    || channel === 'mcp:get'
    || channel === 'mcp:remove'
    || channel === 'mcp:enable'
    || channel === 'mcp:disable'
    || channel === 'mcp:save'
    || channel === 'mcp:test'
    || channel === 'mcp:call'
    || channel === 'mcp:import-local'
  ) {
    return { success: false, servers: [], error: `RedBox MCP action failed for "${channel}": ${message}` };
  }
  if (channel === 'plugins:list') {
    return {
      success: true,
      schemaVersion: 1,
      root: '',
      plugins: [],
    };
  }
  if (channel === 'plugins:connectors') {
    return {
      success: true,
      connectors: [],
    };
  }
  if (channel === 'plugins:marketplace') {
    return {
      success: true,
      registryUrl: '',
      plugins: [],
    };
  }
  if (channel === 'plugins:codex-marketplace') {
    return {
      success: true,
      sourceRoots: [],
      plugins: [],
      errors: [],
    };
  }
  if (channel === 'plugins:discover-local') {
    return {
      success: true,
      sourceRoot: '',
      kind: 'directory',
      plugins: [],
    };
  }
  if (
    channel === 'plugins:install'
    || channel === 'plugins:install-codex'
    || channel === 'plugins:install-marketplace'
    || channel === 'plugins:set-enabled'
    || channel === 'plugins:uninstall'
    || channel === 'plugins:open-data-dir'
    || channel === 'plugins:sync-capabilities'
    || channel === 'plugins:read-data'
  ) {
    return { success: false, error: `RedBox plugin action failed for "${channel}": ${message}` };
  }
  if (channel === 'plugins:home') {
    return { success: true, widgets: [], sidebarSections: [], quickActions: [] };
  }
  if (
    channel === 'notifications:sync-remote'
    || channel === 'notifications:list-remote'
    || channel === 'notifications:mark-remote-read'
    || channel === 'notifications:mark-all-remote-read'
  ) {
    return {
      success: true,
      data: {
        items: [],
        notifications: [],
        unreadCount: 0,
        cursor: null,
        next_poll_after_seconds: 300,
      },
      context: { appSlug: 'redbox', userId: 'anonymous' },
    };
  }
  if (channel === 'knowledge:batch-ingest') {
    return {
      success: false,
      count: 0,
      error: 'Server capture ingest is unavailable in the Electron archive',
    };
  }
  if (channel === 'knowledge:delete-batch') {
    return {
      success: false,
      deleted: 0,
      failed: 0,
      results: [],
      error: `RedBox knowledge batch delete failed: ${message}`,
    };
  }
  if (
    channel === 'file:show-in-folder'
    || channel === 'file:copy-image'
    || channel === 'file:save-as'
    || channel === 'file:save-zip'
    || channel === 'file:preview-resolve'
  ) {
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
  if (channel === 'app:get-release-notes') {
    return { success: false, error: 'Release notes unavailable' };
  }
  if (channel === 'app:install-update') {
    return { success: false, error: 'App updater unavailable in Electron archive' };
  }
  if (channel === 'app:open-external-url' || channel === 'clipboard:write-html') {
    return { success: false, error: `RedBox system action failed for "${channel}": ${message}` };
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
    || channel === 'logs:create-feedback-report'
    || channel === 'logs:upload-report'
    || channel === 'logs:dismiss-report'
    || channel === 'logs:set-upload-consent'
    || channel === 'logs:append-renderer'
    || channel === 'logs:create-auto-report'
  ) {
    return { success: false, error: `RedBox diagnostics action failed for "${channel}": ${message}` };
  }
  if (
    channel === 'assistant:daemon-acp-client-create'
    || channel === 'assistant:daemon-acp-client-revoke'
  ) {
    return {
      success: false,
      error: 'ACP client token management is unavailable in the Electron archive',
    };
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
  const transport = getElectronTransport();
  if (!transport) {
    console.warn(`[RedBox] listener skipped for ${channel}: Electron IPC transport is unavailable`);
    return;
  }
  const entry: ListenerRecord = {};
  if (!channelListeners.has(channel)) {
    channelListeners.set(channel, new Map());
  }
  channelListeners.get(channel)!.set(listener, entry);

  const wrappedListener: Listener = (...args: unknown[]) => {
    listener({ __electron: true, channel }, ...args);
  };
  transport.on(channel, wrappedListener);
  entry.dispose = () => transport.off(channel, wrappedListener);
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
  const transport = getElectronTransport();
  for (const [listener, record] of channelMap.entries()) {
    record.disposed = true;
    if (record.dispose) {
      record.dispose();
    } else if (record.pending) {
      void record.pending.then((dispose) => dispose());
    } else if (transport) {
      transport.off(channel, listener);
    }
    channelMap.delete(listener);
  }
  transport?.removeAllListeners(channel);
  channelListeners.delete(channel);
}

function createIpcRenderer() {
  const bridgeCore = createBridgeCore();

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

    ...createWindowControlsBridge(bridgeCore),
    ...createAnalyticsBridge(bridgeCore),
    ...createSpacesBridge(bridgeCore),
    ...createAdvisorsBridge(bridgeCore),
    ...createKnowledgeBridge(bridgeCore),
    ...createChatBridge(bridgeCore),
    ...createTopicCenterBridge(bridgeCore),

    ...createFilesBridge(bridgeCore),
    ...createNotificationsBridge(bridgeCore),
    ...createSettingsBridge(bridgeCore),
    ...createAppBridge(bridgeCore),
    ...createCaptureBridge(bridgeCore),
    ...createAccountsBridge(bridgeCore),
    ...createAiConfigBridge(bridgeCore),
    ...createAudioVoiceBridge(bridgeCore),
    ...createAssistantControlBridge(bridgeCore),
    ...createCliRuntimeBridge(bridgeCore),
    ...createRuntimeBridge(bridgeCore),
    ...createToolsBridge(bridgeCore),
    ...createSubjectsBridge(bridgeCore),
    ...createArchivesBridge(bridgeCore),
    ...createWanderBridge(bridgeCore),
    ...createMediaBridge(bridgeCore),
    ...createCoverBridge(bridgeCore),
    ...createGenerationBridge(bridgeCore),
    ...createMcpBridge(bridgeCore),
    ...createPluginsBridge(bridgeCore),
    ...createSkillsBridge(bridgeCore),
    ...createAuthBridge(bridgeCore),
    ...createVideoEditorBridge(bridgeCore),
    ...createSessionsBridge(bridgeCore),
    ...createManuscriptsBridge(bridgeCore),
    ...createRedClawBridge(bridgeCore),
    ...createTeamRuntimeBridge(bridgeCore),
    ...createSystemBridge(bridgeCore),
  };
}

export type IpcRendererBridge = ReturnType<typeof createIpcRenderer>;

declare global {
  interface Window {
    ipcRenderer: IpcRendererBridge;
  }
}

export function installIpcRendererBridge(): void {
  if (typeof window === 'undefined') return;
  if ((window as any).ipcRenderer) return;
  window.ipcRenderer = createIpcRenderer();
}
