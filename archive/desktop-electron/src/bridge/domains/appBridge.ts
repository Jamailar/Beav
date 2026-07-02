import type { BridgeCore, Listener } from '../types';

const APP_ONBOARDING_SEEN_KEY = 'redbox:app-onboarding:v2:seen';
const APP_ONBOARDING_SEEN_AT_KEY = 'redbox:app-onboarding:v2:seen-at';

type AppReleaseNotesResult = {
  success: boolean;
  version?: string;
  tag?: string;
  name?: string;
  htmlUrl?: string;
  publishedAt?: string;
  body?: string;
  error?: string;
};

type AppUpdateInstallResult = {
  success: boolean;
  installed?: boolean;
  hasUpdate?: boolean;
  inFlight?: boolean;
  error?: string;
};

export function createAppBridge(core: BridgeCore) {
  return {
    getAppVersion: () => core.invokeChannel('app:get-version'),
    getAppOnboardingStatus: async (payload?: { legacySeen?: boolean }) => {
      const legacySeen = Boolean(payload?.legacySeen);
      try {
        const seen = window.localStorage.getItem(APP_ONBOARDING_SEEN_KEY) === '1' || legacySeen;
        return {
          success: true,
          seen,
          seenAt: window.localStorage.getItem(APP_ONBOARDING_SEEN_AT_KEY) || undefined,
          migrated: legacySeen && !seen,
        };
      } catch (error) {
        return {
          success: false,
          seen: legacySeen,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    markAppOnboardingSeen: async () => {
      const seenAt = new Date().toISOString();
      try {
        window.localStorage.setItem(APP_ONBOARDING_SEEN_KEY, '1');
        window.localStorage.setItem(APP_ONBOARDING_SEEN_AT_KEY, seenAt);
        return { success: true, seen: true, seenAt };
      } catch (error) {
        return {
          success: false,
          seen: true,
          seenAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    getAppReleaseNotes: (version?: string) => core.invokeChannelGuarded<AppReleaseNotesResult>(
      'app:get-release-notes',
      { version },
      {
        timeoutMs: 12000,
        fallback: { success: false, error: 'Release notes unavailable' },
      },
    ),
    checkAppUpdate: (force = false) => core.invokeChannel('app:check-update', { force }),
    installAppUpdate: () => core.invokeChannelGuarded<AppUpdateInstallResult>(
      'app:install-update',
      undefined,
      {
        fallback: { success: false, error: 'App updater unavailable in Electron archive' },
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
    openKnowledgeApiGuide: () => core.invokeChannel('app:open-knowledge-api-guide'),
  };
}
