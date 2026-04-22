import { useCallback, useEffect, useRef } from 'react';

const FOREGROUND_RECHECK_THROTTLE_MS = 15_000;

type OfficialAuthBootstrapResult = {
  success?: boolean;
  error?: string;
};

export function useOfficialAuthLifecycle(): void {
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastRunAtRef = useRef(0);

  const runBootstrap = useCallback((reason: string, force = false) => {
    const now = Date.now();
    if (!force) {
      if (inFlightRef.current) return;
      if (now - lastRunAtRef.current < FOREGROUND_RECHECK_THROTTLE_MS) return;
    }

    lastRunAtRef.current = now;
    const request = (window.ipcRenderer.officialAuth.bootstrap({ reason }) as Promise<OfficialAuthBootstrapResult | null>)
      .then((result) => {
        if (result?.success === false && result.error && result.error !== '官方账号未登录') {
          console.warn('[RedBox official auth bootstrap] failed:', result.error);
        }
      })
      .catch((error) => {
        console.warn('[RedBox official auth bootstrap] invoke failed:', error);
      });
    const tracked = request.finally(() => {
      if (inFlightRef.current === tracked) {
        inFlightRef.current = null;
      }
    });
    inFlightRef.current = tracked;
  }, []);

  useEffect(() => {
    runBootstrap('app-startup', true);

    const handleFocus = () => {
      runBootstrap('window-focus');
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runBootstrap('app-visible');
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [runBootstrap]);
}
