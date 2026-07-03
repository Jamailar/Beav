import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscribeAppUpdateAvailable, subscribeAppUpdateInstallProgress } from '../../bridge/appEvents';
import { SHOW_CURRENT_RELEASE_NOTES_EVENT } from '../../utils/currentReleaseNotes';
import { appAlert } from '../../utils/appDialogs';

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
  | 'downloaded'
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

export function useAppUpdateNotice(openDownloadFailedLabel: string) {
  const [updateNotice, setUpdateNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [lastInstallableNotice, setLastInstallableNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [hasInstallableUpdate, setHasInstallableUpdate] = useState(false);
  const [isOpeningReleasePage, setIsOpeningReleasePage] = useState(false);
  const [installState, setInstallState] = useState<AppUpdateInstallState>(initialInstallState);

  useEffect(() => {
    const handleUpdateNotice = (_event: unknown, payload: AppUpdateNoticePayload) => {
      if (!payload || !payload.latestVersion) return;
      if (payload.mode !== 'current') {
        setHasInstallableUpdate(true);
        setLastInstallableNotice(payload);
        setUpdateNotice((current) => current?.mode === 'current' ? current : null);
        return;
      }
      setInstallState(initialInstallState);
      setUpdateNotice(payload);
    };
    const handleInstallProgress = (_event: unknown, payload: AppUpdateInstallProgressPayload) => {
      if (!payload?.status) return;
      setInstallState((current) => ({
        status: payload.status || current.status,
        version: String(payload.version || current.version || ''),
        downloaded: Number(payload.downloaded ?? current.downloaded) || 0,
        contentLength: Object.prototype.hasOwnProperty.call(payload, 'contentLength')
          ? typeof payload.contentLength === 'number'
            ? payload.contentLength
            : null
          : current.contentLength,
        error: String(payload.error || ''),
      }));
      if (payload.status === 'downloading') {
        setHasInstallableUpdate(false);
      } else if (payload.status === 'installed') {
        setHasInstallableUpdate(false);
        setLastInstallableNotice(null);
      }
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
          name: String(result.name || `Beav v${result.version || version}`),
          publishedAt: String(result.publishedAt || ''),
          body: String(result.body || ''),
          mode: 'current',
        });
        setInstallState(initialInstallState);
      }).catch((error) => {
        console.error('Failed to load current release notes:', error);
        void appAlert('读取更新日志失败');
      });
    };
    const updateCheckTimer = window.setTimeout(() => {
      void window.ipcRenderer.checkAppUpdate(false).then((result) => {
        if (result?.hasUpdate && result.notice && (result.downloaded || result.readyToInstall)) {
          setHasInstallableUpdate(true);
          setLastInstallableNotice(result.notice);
        }
      }).catch((error) => {
        console.warn('[AppUpdate] check failed:', error);
      });
    }, 1800);
    const unsubscribeAppUpdateAvailable = subscribeAppUpdateAvailable(handleUpdateNotice);
    const unsubscribeAppUpdateInstallProgress = subscribeAppUpdateInstallProgress(handleInstallProgress);
    window.addEventListener(SHOW_CURRENT_RELEASE_NOTES_EVENT, handleCurrentReleaseNotes);
    return () => {
      window.clearTimeout(updateCheckTimer);
      unsubscribeAppUpdateAvailable();
      unsubscribeAppUpdateInstallProgress();
      window.removeEventListener(SHOW_CURRENT_RELEASE_NOTES_EVENT, handleCurrentReleaseNotes);
    };
  }, []);

  const closeUpdateNotice = useCallback(() => {
    setUpdateNotice(null);
    setInstallState(initialInstallState);
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

  const isInstallingUpdate = ['checking', 'downloading', 'installing'].includes(installState.status);

  const checkForUpdateNow = useCallback(async () => {
    if (isInstallingUpdate) return false;
    try {
      const result = await window.ipcRenderer.checkAppUpdate(true);
      if (result?.hasUpdate && result.notice && (result.downloaded || result.readyToInstall)) {
        setHasInstallableUpdate(true);
        setLastInstallableNotice(result.notice);
        setInstallState(initialInstallState);
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
  }, [isInstallingUpdate]);

  const installUpdate = useCallback(async () => {
    if (isInstallingUpdate) return;
    if (!lastInstallableNotice) {
      const ready = await checkForUpdateNow();
      if (!ready) return;
    }
    const version = lastInstallableNotice?.latestVersion || installState.version || '';
    setInstallState({
      ...initialInstallState,
      status: 'installing',
      version,
    });
    try {
      const result = await window.ipcRenderer.installAppUpdate();
      if (result?.success) {
        setHasInstallableUpdate(false);
        setLastInstallableNotice(null);
        setUpdateNotice((current) => current?.mode === 'current' ? current : null);
        return;
      }
      if (!result?.success) {
        const error = result?.error || openDownloadFailedLabel;
        setInstallState((current) => ({
          ...current,
          status: 'failed',
          error,
        }));
        void appAlert(error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : openDownloadFailedLabel;
      console.error('Failed to install update:', error);
      setInstallState((current) => ({
        ...current,
        status: 'failed',
        error: message,
      }));
      void appAlert(message);
    }
  }, [checkForUpdateNow, installState.version, isInstallingUpdate, lastInstallableNotice, openDownloadFailedLabel]);

  return {
    updateNotice,
    hasInstallableUpdate,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    installState,
    isInstallingUpdate,
    checkForUpdateNow,
    openReleasePage,
    installUpdate,
    closeUpdateNotice,
  };
}
