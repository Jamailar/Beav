import { getCurrentWindow } from '@tauri-apps/api/window';
import type { BridgeCore, Listener } from '../types';

interface AppUpdateNotice {
  currentVersion: string;
  latestVersion: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
  body: string;
  installable?: boolean;
}

interface AppUpdateCheckResult {
  success: boolean;
  hasUpdate: boolean;
  notice?: AppUpdateNotice | null;
  throttled?: boolean;
  inFlight?: boolean;
  message?: string;
  error?: string;
}

interface AppUpdateInstallResult {
  success: boolean;
  status?: string;
  version?: string;
  error?: string;
}

interface AppReleaseNotesResult {
  success: boolean;
  version?: string;
  tag?: string;
  name?: string;
  htmlUrl?: string;
  publishedAt?: string;
  body?: string;
  error?: string;
}

export function createSystemBridge(core: BridgeCore) {
  return {
    files: {
      showInFolder: (payload: { source: string }) => core.invokeChannel('file:show-in-folder', payload),
      copyImage: (payload: { source: string }) => core.invokeChannel('file:copy-image', payload),
      saveAs: (payload: { source: string; defaultName?: string }) => core.invokeChannel('file:save-as', payload),
      saveZip: (payload: { defaultName?: string; files: Array<{ source: string; name?: string }> }) => core.invokeChannel('file:save-zip', payload),
      resolvePreview: (payload: { source: string }) => core.invokeChannel('file:preview-resolve', payload),
    },
    notifications: {
      getPermissionState: () => core.invokeCommandGuarded('notifications_permission_state', undefined, {
        fallback: { state: 'unknown' },
      }),
      requestPermission: () => core.invokeCommandGuarded('notifications_request_permission', undefined, {
        fallback: { state: 'unknown' },
      }),
      showSystem: (payload: { title: string; body?: string; sound?: string }) => core.invokeCommandGuarded(
        'notifications_show_system',
        payload,
        {
          fallback: { success: false, error: 'System notifications unavailable' },
        },
      ),
      syncRemote: (payload?: { cursor?: string | null; limit?: number; unreadOnly?: boolean }) => core.invokeCommandGuarded(
        'notifications_sync_remote',
        {
          cursor: payload?.cursor || null,
          limit: payload?.limit,
          unreadOnly: payload?.unreadOnly,
        },
        {
          timeoutMs: 6000,
          fallback: { success: false, error: 'Notification sync unavailable' },
        },
      ),
      listRemote: (payload?: { limit?: number; unreadOnly?: boolean }) => core.invokeCommandGuarded(
        'notifications_list_remote',
        {
          limit: payload?.limit,
          unreadOnly: payload?.unreadOnly,
        },
        {
          timeoutMs: 6000,
          fallback: { success: false, error: 'Notification list unavailable' },
        },
      ),
      markRemoteRead: (payload: { notificationId: string }) => core.invokeCommandGuarded(
        'notifications_mark_remote_read',
        { notificationId: payload.notificationId },
        {
          timeoutMs: 6000,
          fallback: { success: false, error: 'Notification read unavailable' },
        },
      ),
      markAllRemoteRead: () => core.invokeCommandGuarded(
        'notifications_mark_all_remote_read',
        undefined,
        {
          timeoutMs: 6000,
          fallback: { success: false, error: 'Notification read-all unavailable' },
        },
      ),
    },

    saveSettings: (settings: unknown) => core.invokeChannel('db:save-settings', settings),
    getSettings: () => core.invokeChannel('db:get-settings'),
    onSettingsUpdated: (listener: Listener) => core.on('settings:updated', listener),
    offSettingsUpdated: (listener: Listener) => core.off('settings:updated', listener),
    onDataChanged: (listener: Listener) => core.on('data:changed', listener),
    offDataChanged: (listener: Listener) => core.off('data:changed', listener),
    pickWorkspaceDir: () => core.invokeChannel('settings:pick-workspace-dir'),
    debug: {
      getStatus: () => core.invokeChannel('debug:get-status'),
      getRecent: (limit?: number) => core.invokeChannel('debug:get-recent', { limit }),
      getRuntimeSummary: () => core.invokeChannel('debug:get-runtime-summary'),
      openLogDir: () => core.invokeChannel('debug:open-log-dir')
    },
    logs: {
      getStatus: () => core.invokeChannel('logs:get-status'),
      getRecent: (limit?: number) => core.invokeChannel('logs:get-recent', { limit }),
      openDir: () => core.invokeChannel('logs:open-dir'),
      listPendingReports: () => core.invokeChannel('logs:list-pending-reports'),
      exportBundle: (reportId?: string, payload?: { includeAdvancedContext?: boolean }) => core.invokeChannel('logs:export-bundle', { reportId, ...(payload || {}) }),
      createFeedbackReport: (payload: { title?: string; content: string; category?: string; priority?: 'low' | 'medium' | 'high' | 'urgent'; source?: string; contact?: string; includeAdvancedContext?: boolean; uploadNow?: boolean; context?: Record<string, unknown> }) => core.invokeChannel('logs:create-feedback-report', payload),
      uploadReport: (reportId: string) => core.invokeChannel('logs:upload-report', { reportId }),
      dismissReport: (reportId: string) => core.invokeChannel('logs:dismiss-report', { reportId }),
      setUploadConsent: (payload: { consent: 'none' | 'prompt' | 'approved'; autoSendSameCrash?: boolean }) => core.invokeChannel('logs:set-upload-consent', payload),
      appendRenderer: (payload: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'; category?: string; event?: string; message?: string; fields?: unknown }) => core.invokeChannel('logs:append-renderer', payload),
      createAutoReport: (payload: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'; category?: string; event?: string; message?: string; fields?: unknown; trigger?: string }) => core.invokeChannel('logs:create-auto-report', payload),
      onReportPending: (listener: Listener) => core.on('diagnostics:report-pending', listener),
      offReportPending: (listener: Listener) => core.off('diagnostics:report-pending', listener),
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
    getAppVersion: () => core.invokeChannel('app:get-version'),
    getAppReleaseNotes: (version?: string) => core.invokeChannelGuarded<AppReleaseNotesResult>(
      'app:get-release-notes',
      { version },
      {
        timeoutMs: 12000,
        fallback: { success: false, error: 'Release notes unavailable' },
      },
    ),
    checkAppUpdate: (force = false) => core.invokeCommandGuarded<AppUpdateCheckResult>(
      'app_check_update',
      { force },
      {
        fallbackChannel: 'app:check-update',
        fallback: { success: true, hasUpdate: false },
      },
    ),
    installAppUpdate: () => core.invokeCommandGuarded<AppUpdateInstallResult>(
      'app_install_update',
      undefined,
      {
        fallbackChannel: 'app:install-update',
        fallback: { success: false, error: 'App updater unavailable' },
      },
    ),
    onAppUpdateAvailable: (listener: Listener) => core.on('app:update-available', listener),
    offAppUpdateAvailable: (listener: Listener) => core.off('app:update-available', listener),
    onAppUpdateInstallProgress: (listener: Listener) => core.on('app:update-install-progress', listener),
    offAppUpdateInstallProgress: (listener: Listener) => core.off('app:update-install-progress', listener),
    openAppReleasePage: (url?: string) => core.invokeChannel('app:open-release-page', { url }),
    openExternalUrl: (url: string) => core.invokeChannel('app:open-external-url', { url }),
    openPath: (path: string) => core.invokeChannel('app:open-path', { path }),
    clipboardReadText: () => core.invokeChannel('clipboard:read-text'),
    clipboardWriteText: (text: string) => core.invokeChannel('clipboard:write-html', { text }),
    capture: {
      saveYoutubeNote: (payload: {
        videoId: string;
        videoUrl: string;
        title: string;
        description?: string;
        thumbnailUrl?: string;
      }) => core.invokeChannel('youtube:save-note', payload),
    },
    openKnowledgeApiGuide: () => core.invokeChannel('app:open-knowledge-api-guide'),
    windowControls: {
      startDragging: () => core.isTauriRuntime()
        ? getCurrentWindow().startDragging()
        : Promise.resolve(),
      minimize: () => core.isTauriRuntime()
        ? getCurrentWindow().minimize()
        : Promise.resolve(),
      toggleMaximize: () => core.isTauriRuntime()
        ? getCurrentWindow().toggleMaximize()
        : Promise.resolve(),
      close: () => core.isTauriRuntime()
        ? getCurrentWindow().close()
        : Promise.resolve(),
    },
  };
}
