import type { BridgeCore, Listener } from '../types';

export function createSystemBridge(core: BridgeCore) {
  const reportPendingListeners = new Map<Listener, Listener>();
  return {
    debug: {
      getStatus: () => core.invokeChannel('debug:get-status'),
      getRecent: (limit?: number) => core.invokeChannel('debug:get-recent', { limit }),
      getRuntimeSummary: () => core.invokeChannel('debug:get-runtime-summary'),
      openLogDir: () => core.invokeChannel('debug:open-log-dir'),
    },
    logs: {
      getStatus: () => core.invokeChannel('logs:get-status'),
      getRecent: (limit?: number) => core.invokeChannel('logs:get-recent', { limit }),
      openDir: () => core.invokeChannel('logs:open-dir'),
      listPendingReports: () => core.invokeChannel('logs:list-pending-reports'),
      exportBundle: (reportId?: string, payload?: { includeAdvancedContext?: boolean }) =>
        core.invokeChannel('logs:export-bundle', { reportId, ...(payload || {}) }),
      createFeedbackReport: (payload: {
        title?: string;
        content: string;
        category?: string;
        priority?: 'low' | 'medium' | 'high' | 'urgent';
        source?: string;
        contact?: string;
        includeAdvancedContext?: boolean;
        uploadNow?: boolean;
        context?: Record<string, unknown>;
      }) => core.invokeChannel('logs:create-feedback-report', payload),
      uploadReport: (reportId: string) => core.invokeChannel('logs:upload-report', { reportId }),
      dismissReport: (reportId: string) => core.invokeChannel('logs:dismiss-report', { reportId }),
      setUploadConsent: (payload: { consent: 'none' | 'prompt' | 'approved'; autoSendSameCrash?: boolean }) =>
        core.invokeChannel('logs:set-upload-consent', payload),
      appendRenderer: (payload: {
        level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
        category?: string;
        event?: string;
        message?: string;
        fields?: unknown;
      }) => core.invokeChannel('logs:append-renderer', payload),
      createAutoReport: (payload: {
        level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
        category?: string;
        event?: string;
        message?: string;
        fields?: unknown;
        trigger?: string;
      }) => core.invokeChannel('logs:create-auto-report', payload),
      onReportPending: (listener: Listener) => {
        const wrapped: Listener = (_event, payload) => listener(payload);
        reportPendingListeners.set(listener, wrapped);
        core.on('diagnostics:report-pending', wrapped);
      },
      offReportPending: (listener: Listener) => {
        const wrapped = reportPendingListeners.get(listener);
        core.off('diagnostics:report-pending', wrapped || listener);
        reportPendingListeners.delete(listener);
      },
    },
    startupMigration: {
      getStatus: <T = Record<string, unknown>>() => core.invokeChannelGuarded<T>(
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
      start: <T = Record<string, unknown>>() => core.invokeChannelGuarded<T>(
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
      onStatus: (listener: Listener) => core.on('app:startup-migration-status', listener),
      offStatus: (listener: Listener) => core.off('app:startup-migration-status', listener),
    },
    openRichpostThemeGuide: () => core.invokeChannel('app:open-richpost-theme-guide'),
    browserPlugin: {
      getStatus: () => core.invokeChannel('plugin:browser-extension-status'),
      prepare: () => core.invokeChannel('plugin:prepare-browser-extension'),
      openDir: () => core.invokeChannel('plugin:open-browser-extension-dir'),
    },
    checkYtdlp: () => core.invokeChannel('youtube:check-ytdlp'),
    installYtdlp: () => core.invokeChannel('youtube:install'),
    updateYtdlp: () => core.invokeChannel('youtube:update'),
    saveYoutubeNote: <T = unknown>(payload: Record<string, unknown>) =>
      core.invokeChannel('youtube:save-note', payload) as Promise<T>,
  };
}
