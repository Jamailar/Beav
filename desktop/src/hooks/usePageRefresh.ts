import { useCallback, useEffect, useRef } from 'react';

const EMPTY_DATA_SCOPES: string[] = [];
const FOREGROUND_REFRESH_DELAY_MS = 120;

type DataChangedPayload = {
    scope?: string;
    action?: string;
    entityId?: string;
};

interface UsePageRefreshOptions {
    isActive?: boolean;
    refresh: () => void | Promise<void>;
    debounceMs?: number;
    triggerOnMount?: boolean;
    triggerOnActivate?: boolean;
    triggerOnWindowFocus?: boolean;
    triggerOnVisibility?: boolean;
    triggerOnSpaceChange?: boolean;
    triggerOnSettingsChange?: boolean;
    dataScopes?: string[];
}

function matchesDataScope(payload: DataChangedPayload | null | undefined, scopes: string[]): boolean {
    if (!payload?.scope) return false;
    return scopes.includes(payload.scope) || scopes.includes('*');
}

export function usePageRefresh({
    isActive = true,
    refresh,
    debounceMs = 600,
    triggerOnMount = true,
    triggerOnActivate = true,
    triggerOnWindowFocus = true,
    triggerOnVisibility = true,
    triggerOnSpaceChange = true,
    triggerOnSettingsChange = false,
    dataScopes = EMPTY_DATA_SCOPES,
}: UsePageRefreshOptions) {
    const refreshRef = useRef(refresh);
    const dataScopesRef = useRef(dataScopes);
    const lastRefreshAtRef = useRef(0);
    const mountedRef = useRef(false);
    const wasActiveRef = useRef(false);
    const inFlightRefreshRef = useRef<Promise<void> | null>(null);
    const queuedForceRefreshRef = useRef(false);
    const scheduledRefreshTimerRef = useRef<number | null>(null);
    const scheduledForceRefreshRef = useRef(false);
    const dataScopesKey = dataScopes.join('\u0000');

    useEffect(() => {
        refreshRef.current = refresh;
    }, [refresh]);

    useEffect(() => {
        dataScopesRef.current = dataScopes;
    }, [dataScopesKey]);

    const runRefresh = useCallback((force = false) => {
        if (!force && !isActive) return;
        const now = Date.now();
        if (!force && now - lastRefreshAtRef.current < debounceMs) {
            return;
        }
        if (inFlightRefreshRef.current) {
            queuedForceRefreshRef.current = queuedForceRefreshRef.current || force;
            return;
        }
        lastRefreshAtRef.current = now;
        const refreshPromise = Promise.resolve(refreshRef.current())
            .catch((error) => {
                console.error('[usePageRefresh] refresh failed:', error);
            })
            .finally(() => {
                inFlightRefreshRef.current = null;
                if (queuedForceRefreshRef.current) {
                    queuedForceRefreshRef.current = false;
                    runRefresh(true);
                }
            });
        inFlightRefreshRef.current = refreshPromise;
    }, [debounceMs, isActive]);

    const scheduleRefresh = useCallback((force = false, delayMs = 0) => {
        if (!force && !isActive) return;
        scheduledForceRefreshRef.current = scheduledForceRefreshRef.current || force;
        if (scheduledRefreshTimerRef.current !== null) return;

        scheduledRefreshTimerRef.current = window.setTimeout(() => {
            scheduledRefreshTimerRef.current = null;
            const shouldForce = scheduledForceRefreshRef.current;
            scheduledForceRefreshRef.current = false;
            runRefresh(shouldForce);
        }, Math.max(0, delayMs));
    }, [isActive, runRefresh]);

    useEffect(() => {
        return () => {
            if (scheduledRefreshTimerRef.current !== null) {
                window.clearTimeout(scheduledRefreshTimerRef.current);
                scheduledRefreshTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (mountedRef.current) return;
        mountedRef.current = true;
        wasActiveRef.current = Boolean(isActive);
        if (triggerOnMount && isActive) {
            scheduleRefresh(true);
        }
    }, [isActive, scheduleRefresh, triggerOnMount]);

    useEffect(() => {
        if (!triggerOnActivate) {
            wasActiveRef.current = Boolean(isActive);
            return;
        }
        if (isActive && !wasActiveRef.current) {
            scheduleRefresh(true);
        }
        wasActiveRef.current = Boolean(isActive);
    }, [isActive, scheduleRefresh, triggerOnActivate]);

    useEffect(() => {
        if (!isActive) return;

        const handleWindowFocus = () => {
            if (triggerOnWindowFocus) {
                scheduleRefresh(false, FOREGROUND_REFRESH_DELAY_MS);
            }
        };

        const handleVisibilityChange = () => {
            if (triggerOnVisibility && document.visibilityState === 'visible') {
                scheduleRefresh(false, FOREGROUND_REFRESH_DELAY_MS);
            }
        };

        const handleSpaceChanged = () => {
            if (triggerOnSpaceChange) {
                scheduleRefresh(true);
            }
        };

        const handleSettingsUpdated = () => {
            if (triggerOnSettingsChange) {
                scheduleRefresh(false, FOREGROUND_REFRESH_DELAY_MS);
            }
        };

        const handleDataChanged = (_event: unknown, payload?: DataChangedPayload) => {
            const scopes = dataScopesRef.current;
            if (scopes.length > 0 && matchesDataScope(payload, scopes)) {
                scheduleRefresh(false, FOREGROUND_REFRESH_DELAY_MS);
            }
        };

        if (triggerOnWindowFocus) {
            window.addEventListener('focus', handleWindowFocus);
        }
        if (triggerOnVisibility) {
            document.addEventListener('visibilitychange', handleVisibilityChange);
        }
        if (triggerOnSpaceChange) {
            window.ipcRenderer.on('space:changed', handleSpaceChanged);
        }
        if (triggerOnSettingsChange) {
            window.ipcRenderer.on('settings:updated', handleSettingsUpdated);
        }
        if (dataScopesRef.current.length > 0) {
            window.ipcRenderer.on('data:changed', handleDataChanged);
        }

        return () => {
            if (triggerOnWindowFocus) {
                window.removeEventListener('focus', handleWindowFocus);
            }
            if (triggerOnVisibility) {
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            }
            if (triggerOnSpaceChange) {
                window.ipcRenderer.off('space:changed', handleSpaceChanged);
            }
            if (triggerOnSettingsChange) {
                window.ipcRenderer.off('settings:updated', handleSettingsUpdated);
            }
            if (dataScopesRef.current.length > 0) {
                window.ipcRenderer.off('data:changed', handleDataChanged);
            }
        };
    }, [
        dataScopesKey,
        isActive,
        scheduleRefresh,
        triggerOnSettingsChange,
        triggerOnSpaceChange,
        triggerOnVisibility,
        triggerOnWindowFocus,
    ]);

    return {
        refreshNow: () => runRefresh(true),
    };
}
