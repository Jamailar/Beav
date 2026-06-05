import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';

const OFFICIAL_AUTH_NOTICE_ENABLED = false;
const OFFICIAL_AUTH_SNAPSHOT_KEYS = [
  'redbox-auth:panel-display',
] as const;

function clearStaleOfficialAuthSnapshots(): boolean {
  let cleared = false;
  try {
    for (const key of OFFICIAL_AUTH_SNAPSHOT_KEYS) {
      if (window.localStorage.getItem(key) == null) continue;
      window.localStorage.removeItem(key);
      cleared = true;
    }
  } catch {
    return cleared;
  }
  return cleared;
}

function getAuthStatus(event: { payload?: { status?: string } } | { status?: string } | null | undefined): string {
  const payload = (event && typeof event === 'object' && 'payload' in event)
    ? (event as { payload?: { status?: string } }).payload
    : (event as { status?: string } | null | undefined);
  return String((payload as { status?: string } | null | undefined)?.status || '');
}

export function useOfficialAuthNotice() {
  const { t } = useI18n();
  const [globalAuthNotice, setGlobalAuthNotice] = useState<string | null>(null);
  const lastAuthStatusRef = useRef('');

  useEffect(() => {
    let mounted = true;
    const applyAuthStatus = (nextStatus: string) => {
      const prevStatus = lastAuthStatusRef.current;
      lastAuthStatusRef.current = nextStatus;
      if (!mounted) return;

      if (nextStatus === 'reauthRequired') {
        clearStaleOfficialAuthSnapshots();
        setGlobalAuthNotice(OFFICIAL_AUTH_NOTICE_ENABLED ? t('app.authExpired') : null);
        return;
      }

      if (nextStatus === 'anonymous') {
        const cleared = clearStaleOfficialAuthSnapshots();
        setGlobalAuthNotice(cleared && OFFICIAL_AUTH_NOTICE_ENABLED ? t('app.authExpired') : null);
        return;
      }

      if (prevStatus === 'reauthRequired' || prevStatus === 'anonymous') {
        setGlobalAuthNotice(null);
        return;
      }

      setGlobalAuthNotice(null);
    };

    const handleAuthStateChanged = (event: { payload?: { status?: string } } | { status?: string } | null | undefined) => {
      applyAuthStatus(getAuthStatus(event));
    };

    void window.ipcRenderer.auth.getState()
      .then((snapshot) => {
        applyAuthStatus(getAuthStatus(snapshot));
      })
      .catch(() => {});

    window.ipcRenderer.auth.onStateChanged(handleAuthStateChanged);
    return () => {
      mounted = false;
      window.ipcRenderer.auth.offStateChanged(handleAuthStateChanged);
    };
  }, [t]);

  return globalAuthNotice;
}
