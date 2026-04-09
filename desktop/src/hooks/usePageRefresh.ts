import { useCallback, useEffect, useRef } from 'react';

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
    dataScopes = [],
}: UsePageRefreshOptions) {
    const refreshRef = useRef(refresh);
    const lastRefreshAtRef = useRef(0);
    const mountedRef = useRef(false);
    const wasActiveRef = useRef(false);
    const inFlightRefreshRef = useRef<Promise<void> | null>(null);
    const queuedForceRefreshRef = useRef(false);

    useEffect(() => {
        refreshRef.current = refresh;
    }, [refresh]);

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

    useEffect(() => {
        if (mountedRef.current) return;
        mountedRef.current = true;
        wasActiveRef.current = Boolean(isActive);
        if (triggerOnMount && isActive) {
            runRefresh(true);
        }
    }, [isActive, runRefresh, triggerOnMount]);

    useEffect(() => {
        if (!triggerOnActivate) {
            wasActiveRef.current = Boolean(isActive);
            return;
        }
        if (isActive && !wasActiveRef.current) {
            runRefresh(true);
        }
        wasActiveRef.current = Boolean(isActive);
    }, [isActive, runRefresh, triggerOnActivate]);

    useEffect(() => {
        if (!isActive) return;

        const handleWindowFocus = () => {
            if (triggerOnWindowFocus) {
                runRefresh();
            }
        };

        const handleVisibilityChange = () => {
            if (triggerOnVisibility && document.visibilityState === 'visible') {
                runRefresh();
            }
        };

        const handleSpaceChanged = () => {
            if (triggerOnSpaceChange) {
                runRefresh(true);
            }
        };

        const handleSettingsUpdated = () => {
            if (triggerOnSettingsChange) {
                runRefresh();
            }
        };

        const handleDataChanged = (_event: unknown, payload?: DataChangedPayload) => {
            if (dataScopes.length > 0 && matchesDataScope(payload, dataScopes)) {
                runRefresh();
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
        if (dataScopes.length > 0) {
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
            if (dataScopes.length > 0) {
                window.ipcRenderer.off('data:changed', handleDataChanged);
            }
        };
    }, [
        dataScopes,
        isActive,
        runRefresh,
        triggerOnSettingsChange,
        triggerOnSpaceChange,
        triggerOnVisibility,
        triggerOnWindowFocus,
    ]);

    return {
        refreshNow: () => runRefresh(true),
    };
}
