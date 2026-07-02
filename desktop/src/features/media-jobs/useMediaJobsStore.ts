import { useCallback, useRef, useSyncExternalStore } from 'react';
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
    removeJob: (jobId: string) => void;
    removeJobs: (jobIds: string[]) => void;
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

export function shallowArrayEqual<T>(left: T[], right: T[]): boolean {
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

function mediaJobChanged(current: MediaJobProjection | undefined, next: MediaJobProjection): boolean {
    if (!current) return true;
    return current.status !== next.status
        || current.updatedAt !== next.updatedAt
        || current.completedAt !== next.completedAt
        || current.archivedAt !== next.archivedAt
        || current.archiveReason !== next.archiveReason
        || current.cancelReason !== next.cancelReason
        || current.artifacts.length !== next.artifacts.length
        || current.recentEvents.length !== next.recentEvents.length
        || current.attempt?.attemptId !== next.attempt?.attemptId
        || current.attempt?.attemptNo !== next.attempt?.attemptNo
        || current.attempt?.updatedAt !== next.attempt?.updatedAt
        || current.attempt?.leaseExpiresAt !== next.attempt?.leaseExpiresAt
        || current.attempt?.nextPollAt !== next.attempt?.nextPollAt;
}

export const mediaJobsStore: MediaJobsStore = {
    getState: () => state,
    subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    upsertJob: (job) => {
        const current = state.jobsById[job.jobId];
        if (!mediaJobChanged(current, job)) return;
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
            if (!mediaJobChanged(current, job)) continue;
            nextJobsById[job.jobId] = job;
            changed = true;
        }
        if (!changed) return;
        replaceState({
            ...state,
            jobsById: nextJobsById,
        });
    },
    removeJob: (jobId) => {
        if (!state.jobsById[jobId] && !state.logsByJobId[jobId]) return;
        const nextJobsById = { ...state.jobsById };
        const nextLogsByJobId = { ...state.logsByJobId };
        delete nextJobsById[jobId];
        delete nextLogsByJobId[jobId];
        replaceState({
            jobsById: nextJobsById,
            logsByJobId: nextLogsByJobId,
        });
    },
    removeJobs: (jobIds) => {
        if (jobIds.length === 0) return;
        let changed = false;
        const nextJobsById = { ...state.jobsById };
        const nextLogsByJobId = { ...state.logsByJobId };
        for (const jobId of jobIds) {
            if (nextJobsById[jobId] || nextLogsByJobId[jobId]) {
                changed = true;
                delete nextJobsById[jobId];
                delete nextLogsByJobId[jobId];
            }
        }
        if (!changed) return;
        replaceState({
            jobsById: nextJobsById,
            logsByJobId: nextLogsByJobId,
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

export function useMediaJobsStore<T>(
    selector: Selector<T>,
    isEqual: (left: T, right: T) => boolean = Object.is,
): T {
    const selectedSnapshotRef = useRef<{
        state: MediaJobsState;
        selector: Selector<T>;
        isEqual: (left: T, right: T) => boolean;
        selected: T;
    } | null>(null);
    const getSelectedSnapshot = useCallback(() => {
        const nextState = mediaJobsStore.getState();
        const nextSelected = selector(nextState);
        const previous = selectedSnapshotRef.current;
        if (
            previous &&
            previous.state === nextState &&
            previous.selector === selector &&
            previous.isEqual === isEqual
        ) {
            return previous.selected;
        }
        if (previous && isEqual(previous.selected, nextSelected)) {
            selectedSnapshotRef.current = {
                state: nextState,
                selector,
                isEqual,
                selected: previous.selected,
            };
            return previous.selected;
        }
        selectedSnapshotRef.current = {
            state: nextState,
            selector,
            isEqual,
            selected: nextSelected,
        };
        return nextSelected;
    }, [isEqual, selector]);

    return useSyncExternalStore(
        mediaJobsStore.subscribe,
        getSelectedSnapshot,
        getSelectedSnapshot,
    );
}

export function useMediaJobsByIds(jobIds: string[]): MediaJobProjection[] {
    const jobIdsKey = jobIds.join('\u0000');
    const selectJobsById = useCallback((nextState: MediaJobsState) => (
        (jobIdsKey ? jobIdsKey.split('\u0000') : [])
            .map((jobId) => nextState.jobsById[jobId])
            .filter((job): job is MediaJobProjection => Boolean(job))
    ), [jobIdsKey]);

    return useMediaJobsStore(selectJobsById, shallowArrayEqual);
}
