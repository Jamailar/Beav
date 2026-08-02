import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscribeAppUpdateAvailable, subscribeAppUpdateInstallProgress } from '../../bridge/appEvents';
import { SHOW_CURRENT_RELEASE_NOTES_EVENT, currentReleaseNotesMarkdown } from '../../utils/currentReleaseNotes';
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

const UPDATE_NOTICE_SHOWN_VERSION_STORAGE_KEY = 'redbox:update-notice-shown-version:v1';

const initialInstallState: AppUpdateInstallState = {
  status: 'idle',
  version: '',
  downloaded: 0,
  contentLength: null,
  error: '',
};

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
    // Ignore storage failures; update checks should never break the shell.
  }
}

export function useAppUpdateNotice(openDownloadFailedLabel: string) {
  const [updateNotice, setUpdateNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [isOpeningReleasePage, setIsOpeningReleasePage] = useState(false);
  const [installState, setInstallState] = useState<AppUpdateInstallState>(initialInstallState);

  useEffect(() => {
    const handleUpdateNotice = (_event: unknown, payload: AppUpdateNoticePayload) => {
      if (!payload || !payload.latestVersion) return;
      if (!shouldShowAppUpdateNotice(payload)) return;
      markAppUpdateNoticeShown(payload);
      setInstallState(initialInstallState);
      setUpdateNotice(payload);
    };
    const handleInstallProgress = (_event: unknown, payload: AppUpdateInstallProgressPayload) => {
      if (!payload?.status) return;
      setInstallState((current) => ({
        status: payload.status || current.status,
        version: String(payload.version || current.version || ''),
        downloaded: Number(payload.downloaded ?? current.downloaded) || 0,
        contentLength: typeof payload.contentLength === 'number' ? payload.contentLength : current.contentLength,
        error: String(payload.error || ''),
      }));
    };
    const handleCurrentReleaseNotes = (event: Event) => {
      const detail = event instanceof CustomEvent
        ? event.detail as { version?: unknown } | null
        : null;
      const version = String(detail?.version || '').trim() || '2.0.0';
      setUpdateNotice({
        currentVersion: version,
        latestVersion: version,
        htmlUrl: '',
        name: `RedBox v${version}`,
        publishedAt: '2026-05-14',
        body: currentReleaseNotesMarkdown(),
        mode: 'current',
      });
      setInstallState(initialInstallState);
    };
    const updateCheckTimer = window.setTimeout(() => {
      void window.ipcRenderer.checkAppUpdate(false).then((result) => {
        if (result?.hasUpdate && result.notice) {
          if (!shouldShowAppUpdateNotice(result.notice)) return;
          markAppUpdateNoticeShown(result.notice);
          setUpdateNotice(result.notice);
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

  const installUpdate = useCallback(async () => {
    if (!updateNotice || updateNotice.mode === 'current' || isInstallingUpdate) return;
    setInstallState({
      ...initialInstallState,
      status: 'checking',
      version: updateNotice.latestVersion,
    });
    try {
      const result = await window.ipcRenderer.installAppUpdate();
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
  }, [isInstallingUpdate, openDownloadFailedLabel, updateNotice]);

  return {
    updateNotice,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    installState,
    isInstallingUpdate,
    openReleasePage,
    installUpdate,
    closeUpdateNotice,
  };
}
