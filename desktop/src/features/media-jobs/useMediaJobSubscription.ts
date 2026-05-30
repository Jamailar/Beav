import { useEffect, useMemo } from 'react';
import { mediaJobsStore } from './useMediaJobsStore';
import {
    normalizeMediaJobLog,
    normalizeMediaJobProjection,
    type MediaJobListFilter,
} from './types';

type Options = {
    enabled?: boolean;
    bootstrapFilter?: MediaJobListFilter | null;
};

export function useMediaJobSubscription(
    jobIds: Array<string | null | undefined>,
    options?: Options,
): void {
    const enabled = options?.enabled !== false;
    const normalizedJobIds = useMemo(
        () => Array.from(new Set(jobIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))),
        [jobIds],
    );
    const jobIdsKey = normalizedJobIds.join('|');
    const bootstrapFilterKey = JSON.stringify(options?.bootstrapFilter || null);

    useEffect(() => {
        if (!enabled) return undefined;

        let cancelled = false;
        const handleJobUpdated = (_event: unknown, payload: unknown) => {
            const projection = normalizeMediaJobProjection(payload);
            if (!projection) return;
            if (projection.archivedAt && !options?.bootstrapFilter?.includeArchived) {
                mediaJobsStore.removeJob(projection.jobId);
                return;
            }
            mediaJobsStore.upsertJob(projection);
        };
        const handleJobLog = (_event: unknown, payload: unknown) => {
            const log = normalizeMediaJobLog(payload);
            if (!log) return;
            mediaJobsStore.appendLog(log);
        };
        const refreshSnapshot = async () => {
            try {
                if (options?.bootstrapFilter) {
                    const result = await window.ipcRenderer.generation.listJobs(options.bootstrapFilter) as {
                        items?: unknown[];
                    };
                    if (!cancelled && Array.isArray(result?.items)) {
                        mediaJobsStore.upsertJobs(
                            result.items
                                .map(normalizeMediaJobProjection)
                                .filter((item): item is NonNullable<typeof item> => Boolean(item)),
                        );
                    }
                }

                for (const jobId of normalizedJobIds) {
                    const projection = normalizeMediaJobProjection(
                        await window.ipcRenderer.generation.getJob(jobId),
                    );
                    if (cancelled || !projection) continue;
                    mediaJobsStore.upsertJob(projection);
                }
            } catch (error) {
                console.warn('Failed to refresh media jobs snapshot:', error);
            }
        };
        const handleVisibilityRefresh = () => {
            if (document.visibilityState === 'visible') {
                void refreshSnapshot();
            }
        };

        window.ipcRenderer.generation.onJobUpdated(handleJobUpdated);
        window.ipcRenderer.generation.onJobLog(handleJobLog);
        window.addEventListener('focus', handleVisibilityRefresh);
        document.addEventListener('visibilitychange', handleVisibilityRefresh);
        const reconcileTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void refreshSnapshot();
            }
        }, 15_000);
        void refreshSnapshot();

        return () => {
            cancelled = true;
            window.clearInterval(reconcileTimer);
            window.removeEventListener('focus', handleVisibilityRefresh);
            document.removeEventListener('visibilitychange', handleVisibilityRefresh);
            window.ipcRenderer.generation.offJobUpdated(handleJobUpdated);
            window.ipcRenderer.generation.offJobLog(handleJobLog);
        };
    }, [bootstrapFilterKey, enabled, jobIdsKey, normalizedJobIds, options?.bootstrapFilter]);
}
