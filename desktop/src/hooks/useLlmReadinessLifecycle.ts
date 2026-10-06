import { useCallback, useEffect, useRef } from 'react';
import { APP_BRAND } from '../config/brand';

const FOREGROUND_RECHECK_THROTTLE_MS = 15_000;

export function useLlmReadinessLifecycle(): void {
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastRunAtRef = useRef(0);

  const runRefresh = useCallback((force = false) => {
    const now = Date.now();
    if (!force) {
      if (inFlightRef.current) return;
      if (now - lastRunAtRef.current < FOREGROUND_RECHECK_THROTTLE_MS) return;
    }

    lastRunAtRef.current = now;
    const request = (window.ipcRenderer.llmReadiness.refresh() as Promise<unknown>)
      .then(() => undefined)
      .catch((error) => {
        console.warn(`[${APP_BRAND.displayName} LLM readiness] refresh failed:`, error);
      });
    const tracked = request.finally(() => {
      if (inFlightRef.current === tracked) {
        inFlightRef.current = null;
      }
    });
    inFlightRef.current = tracked;
  }, []);

  useEffect(() => {
    runRefresh(true);

    const handleFocus = () => runRefresh();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runRefresh();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [runRefresh]);
}
