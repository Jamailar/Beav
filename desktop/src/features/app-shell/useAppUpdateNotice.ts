import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscribeAppUpdateAvailable } from '../../bridge/appEvents';
import { SHOW_CURRENT_RELEASE_NOTES_EVENT, currentReleaseNotesMarkdown } from '../../utils/currentReleaseNotes';
import { appAlert } from '../../utils/appDialogs';

export interface AppUpdateNoticePayload {
  currentVersion: string;
  latestVersion: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
  body: string;
  mode?: 'update' | 'current';
}

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
    // Ignore storage failures; update checks should never break the shell.
  }
}

export function useAppUpdateNotice(openDownloadFailedLabel: string) {
  const [updateNotice, setUpdateNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [isOpeningReleasePage, setIsOpeningReleasePage] = useState(false);

  useEffect(() => {
    const handleUpdateNotice = (_event: unknown, payload: AppUpdateNoticePayload) => {
      if (!payload || !payload.latestVersion) return;
      if (!shouldShowAppUpdateNotice(payload)) return;
      markAppUpdateNoticeShown(payload);
      setUpdateNotice(payload);
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

  return {
    updateNotice,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    openReleasePage,
    closeUpdateNotice,
  };
}
