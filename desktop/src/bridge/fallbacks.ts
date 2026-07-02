import { APP_BRAND } from '../config/brand';

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

export function buildFallbackResponse(channel: string, error: unknown, payload?: unknown): any {
  const message = error instanceof Error ? error.message : String(error);

  if (channel === 'spaces:list') {
    return {};
  }
  if (channel === 'media:list') {
    return { success: true, assets: [] };
  }
  if (channel === 'voice:list') {
    return { success: true, voices: [] };
  }
  if (
    channel === 'voice:get'
    || channel === 'voice:clone'
    || channel === 'voice:bind-asset'
    || channel === 'assets:bind-voice'
    || channel === 'voice:speech'
    || channel === 'voice:delete'
  ) {
    return { success: false, error: `${APP_BRAND.displayName} voice action failed for "${channel}": ${message}` };
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
  if (channel === 'chat:create-video-thumbnail') {
    return { success: false, error: `${APP_BRAND.displayName} video thumbnail unavailable: ${message}` };
  }
  if (channel === 'chat:discard-attachments') {
    return { success: true };
  }
  if (channel === 'chat:transcribe-audio') {
    const normalized = message.toLowerCase();
    if (
      normalized.includes('program not found')
      || normalized.includes('not found')
      || normalized.includes('未找到')
      || normalized.includes('transcription_unavailable')
    ) {
      return {
        success: false,
        reason: 'transcription_unavailable',
        error: '音频已接收，但当前转写服务不可用',
        diagnostic: message,
      };
    }
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
  if (channel === 'file:show-in-folder' || channel === 'file:copy-image' || channel === 'file:download-to-downloads' || channel === 'file:save-as' || channel === 'file:save-zip' || channel === 'file:preview-resolve') {
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
    return { success: false, error: `${APP_BRAND.displayName} plugin action failed for "${channel}": ${message}` };
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
  if (channel === 'generation:submit-audio' || channel === 'generation:submit-voice-clone') {
    return { success: false, error: `${APP_BRAND.displayName} media generation is unavailable in this environment.` };
  }
  if (channel === 'generation:get-runtime-status') {
    return { success: true, runtimeReady: false, runtimeRunning: false };
  }
  if (channel === 'generation:delete-job') {
    return { success: true, status: 'archived' };
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
    || channel === 'logs:create-feedback-report'
    || channel === 'logs:upload-report'
    || channel === 'logs:dismiss-report'
    || channel === 'logs:set-upload-consent'
    || channel === 'logs:append-renderer'
    || channel === 'logs:create-auto-report'
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
