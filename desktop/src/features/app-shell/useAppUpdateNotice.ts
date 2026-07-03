import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscribeAppUpdateAvailable } from '../../bridge/appEvents';
import { appAlert } from '../../utils/appDialogs';
import { SHOW_CURRENT_RELEASE_NOTES_EVENT } from '../../utils/currentReleaseNotes';

export interface AppUpdateNoticePayload {
  currentVersion: string;
  latestVersion: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
  body: string;
  installable?: boolean;
  mode?: 'update' | 'current';
}

export type AppUpdateInstallStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'failed';

export interface AppUpdateInstallProgressPayload {
  status?: AppUpdateInstallStatus;
  version?: string;
  downloaded?: number;
  contentLength?: number | null;
  error?: string;
}

export interface AppUpdateInstallState {
  status: AppUpdateInstallStatus;
  version: string;
  downloaded: number;
  contentLength: number | null;
  error: string;
}

const initialInstallState: AppUpdateInstallState = {
  status: 'idle',
  version: '',
  downloaded: 0,
  contentLength: null,
  error: '',
};

const UPDATE_NOTICE_SHOWN_VERSION_STORAGE_KEY = 'redbox:update-notice-shown-version:v1';

function shouldShowAppUpdateNotice(payload: AppUpdateNoticePayload): boolean {
  if (payload.mode === 'current') return true;
  const latestVersion = String(payload.latestVersion || '').trim();
  if (!latestVersion || typeof window === 'undefined') return Boolean(latestVersion);
  try {
    return window.localStorage.getItem(UPDATE_NOTICE_SHOWN_VERSION_STORAGE_KEY) !== latestVersion;
  } catch {
    return true;
  }
}

function markAppUpdateNoticeShown(payload: AppUpdateNoticePayload): void {
  if (payload.mode === 'current') return;
  const latestVersion = String(payload.latestVersion || '').trim();
  if (!latestVersion || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UPDATE_NOTICE_SHOWN_VERSION_STORAGE_KEY, latestVersion);
  } catch {
    // Storage failures should not break the shell.
  }
}

export function useAppUpdateNotice(openDownloadFailedLabel = '打开下载页面失败') {
  const [updateNotice, setUpdateNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [lastInstallableNotice, setLastInstallableNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [hasInstallableUpdate, setHasInstallableUpdate] = useState(false);
  const [isOpeningReleasePage, setIsOpeningReleasePage] = useState(false);

  useEffect(() => {
    const handleUpdateNotice = (_event: unknown, payload: AppUpdateNoticePayload) => {
      if (!payload || !payload.latestVersion) return;
      if (payload.mode !== 'current') {
        setHasInstallableUpdate(true);
        setLastInstallableNotice(payload);
      }
      if (!shouldShowAppUpdateNotice(payload)) return;
      markAppUpdateNoticeShown(payload);
      setUpdateNotice(payload);
    };
    const handleCurrentReleaseNotes = (event: Event) => {
      const detail = event instanceof CustomEvent
        ? event.detail as { version?: unknown } | null
        : null;
      const version = String(detail?.version || '').trim() || '2.0.0';
      void window.ipcRenderer.getAppReleaseNotes(version).then((result) => {
        if (!result?.success) {
          void appAlert(result?.error || '读取更新日志失败');
          return;
        }
        setUpdateNotice({
          currentVersion: version,
          latestVersion: String(result.version || version),
          htmlUrl: String(result.htmlUrl || ''),
          name: String(result.name || `RedBox v${result.version || version}`),
          publishedAt: String(result.publishedAt || ''),
          body: String(result.body || ''),
          mode: 'current',
        });
      }).catch((error) => {
        console.error('Failed to load current release notes:', error);
        void appAlert('读取更新日志失败');
      });
    };
    const updateCheckTimer = window.setTimeout(() => {
      void window.ipcRenderer.checkAppUpdate(false).then((result) => {
        if (result?.hasUpdate && result.notice) {
          setHasInstallableUpdate(true);
          setLastInstallableNotice(result.notice);
          if (!shouldShowAppUpdateNotice(result.notice)) return;
          markAppUpdateNoticeShown(result.notice);
          setUpdateNotice(result.notice);
        }
      }).catch((error) => {
        console.warn('[AppUpdate] check failed:', error);
      });
    }, 1800);
    const unsubscribeAppUpdateAvailable = subscribeAppUpdateAvailable(handleUpdateNotice);
    window.addEventListener(SHOW_CURRENT_RELEASE_NOTES_EVENT, handleCurrentReleaseNotes);
    return () => {
      window.clearTimeout(updateCheckTimer);
      unsubscribeAppUpdateAvailable();
      window.removeEventListener(SHOW_CURRENT_RELEASE_NOTES_EVENT, handleCurrentReleaseNotes);
    };
  }, []);

  const closeUpdateNotice = useCallback(() => {
    setUpdateNotice(null);
  }, []);

  useEffect(() => {
    if (!updateNotice) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeUpdateNotice();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeUpdateNotice, updateNotice]);

  const updatePublishedDateLabel = useMemo(() => {
    if (!updateNotice?.publishedAt) return '';
    const ts = Date.parse(updateNotice.publishedAt);
    if (!Number.isFinite(ts)) return '';
    return new Date(ts).toLocaleDateString();
  }, [updateNotice?.publishedAt]);

  const openReleasePage = useCallback(async () => {
    if (!updateNotice?.htmlUrl || isOpeningReleasePage) return;
    setIsOpeningReleasePage(true);
    try {
      const result = await window.ipcRenderer.openAppReleasePage(updateNotice.htmlUrl);
      if (!result?.success) {
        void appAlert(result?.error || openDownloadFailedLabel);
      }
    } catch (error) {
      console.error('Failed to open release page:', error);
      void appAlert(openDownloadFailedLabel);
    } finally {
      setIsOpeningReleasePage(false);
    }
  }, [isOpeningReleasePage, openDownloadFailedLabel, updateNotice?.htmlUrl]);

  const checkForUpdateNow = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.checkAppUpdate(true);
      if (result?.hasUpdate && result.notice) {
        setHasInstallableUpdate(true);
        setLastInstallableNotice(result.notice);
        setUpdateNotice(result.notice);
        markAppUpdateNoticeShown(result.notice);
        return true;
      }
      setHasInstallableUpdate(false);
      setLastInstallableNotice(null);
      if (result && !result.success) {
        console.warn('[AppUpdate] manual check failed:', result.message);
      }
    } catch (error) {
      console.warn('[AppUpdate] manual check failed:', error);
    }
    return false;
  }, []);

  const openInstallableUpdateNotice = useCallback(async () => {
    if (lastInstallableNotice) {
      setUpdateNotice(lastInstallableNotice);
      return true;
    }
    return checkForUpdateNow();
  }, [checkForUpdateNow, lastInstallableNotice]);

  const installUpdate = useCallback(async () => {
    await openReleasePage();
  }, [openReleasePage]);

  return {
    updateNotice,
    hasInstallableUpdate,
    closeUpdateNotice,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    installState: initialInstallState,
    isInstallingUpdate: false,
    openInstallableUpdateNotice,
    openReleasePage,
    installUpdate,
  };
}
