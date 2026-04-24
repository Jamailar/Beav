import { useSyncExternalStore } from 'react';
import type { MediaJobLogRecord, MediaJobProjection } from './types';

type MediaJobsState = {
    jobsById: Record<string, MediaJobProjection>;
    logsByJobId: Record<string, MediaJobLogRecord[]>;
};

type Listener = () => void;
type Selector<T> = (state: MediaJobsState) => T;

type MediaJobsStore = {
    getState: () => MediaJobsState;
    subscribe: (listener: Listener) => () => void;
    upsertJob: (job: MediaJobProjection) => void;
    upsertJobs: (jobs: MediaJobProjection[]) => void;
    appendLog: (log: MediaJobLogRecord) => void;
};

const listeners = new Set<Listener>();

let state: MediaJobsState = {
    jobsById: {},
    logsByJobId: {},
};

function emit(): void {
    for (const listener of listeners) {
        listener();
    }
}

function shallowArrayEqual<T>(left: T[], right: T[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (!Object.is(left[index], right[index])) return false;
    }
    return true;
}

function replaceState(next: MediaJobsState): void {
    if (next === state) return;
    state = next;
    emit();
}

export const mediaJobsStore: MediaJobsStore = {
    getState: () => state,
    subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    upsertJob: (job) => {
        const current = state.jobsById[job.jobId];
        if (current && JSON.stringify(current) === JSON.stringify(job)) return;
        replaceState({
            ...state,
            jobsById: {
                ...state.jobsById,
                [job.jobId]: job,
            },
        });
    },
    upsertJobs: (jobs) => {
        if (jobs.length === 0) return;
        let changed = false;
        const nextJobsById = { ...state.jobsById };
        for (const job of jobs) {
            const current = nextJobsById[job.jobId];
            if (current && JSON.stringify(current) === JSON.stringify(job)) continue;
            nextJobsById[job.jobId] = job;
            changed = true;
        }
        if (!changed) return;
        replaceState({
            ...state,
            jobsById: nextJobsById,
        });
    },
    appendLog: (log) => {
        const current = state.logsByJobId[log.jobId] || [];
        const nextLogs = [...current, log].slice(-50);
        if (shallowArrayEqual(current, nextLogs)) return;
        replaceState({
            ...state,
            logsByJobId: {
                ...state.logsByJobId,
                [log.jobId]: nextLogs,
            },
        });
    },
};

export function useMediaJobsStore<T>(selector: Selector<T>): T {
    return useSyncExternalStore(
        mediaJobsStore.subscribe,
        () => selector(mediaJobsStore.getState()),
        () => selector(mediaJobsStore.getState()),
    );
}
