export type MediaJobStatus =
    | 'accepted'
    | 'queued'
    | 'submitting'
    | 'submitted'
    | 'polling'
    | 'downloading'
    | 'persisting'
    | 'binding'
    | 'completed'
    | 'failed'
    | 'cancel_requested'
    | 'cancelled'
    | 'dead_lettered';

export type MediaJobKind = 'image' | 'video';

export type MediaJobArtifact = {
    artifactId: string;
    kind: string;
    relativePath?: string | null;
    absolutePath?: string | null;
    mimeType?: string | null;
    previewUrl?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt: string;
};

export type MediaJobEvent = {
    eventType: string;
    message: string;
    payload?: Record<string, unknown> | null;
    createdAt: string;
};

export type MediaJobAttemptProjection = {
    attemptId: string;
    attemptNo: number;
    status: string;
    providerTaskId?: string | null;
    providerStatusUrl?: string | null;
    idempotencyKey?: string | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
    nextPollAt?: number | null;
    retryNotBeforeAt?: number | null;
    lastError?: string | null;
    response?: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
};

export type MediaJobProjection = {
    jobId: string;
    kind: MediaJobKind;
    source: string;
    priority: string;
    status: MediaJobStatus | string;
    providerKey: string;
    providerModel?: string | null;
    request?: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
    projectId?: string | null;
    manuscriptPath?: string | null;
    videoProjectPath?: string | null;
    ownerSessionId?: string | null;
    cancelReason?: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt?: string | null;
    attempt?: MediaJobAttemptProjection | null;
    artifacts: MediaJobArtifact[];
    recentEvents: MediaJobEvent[];
};

export type MediaJobLogRecord = {
    jobId: string;
    message: string;
    payload?: Record<string, unknown> | null;
    createdAt: string;
};

export type MediaJobListFilter = {
    kind?: MediaJobKind;
    status?: string;
    source?: string;
    manuscriptPath?: string;
    videoProjectPath?: string;
    ownerSessionId?: string;
    limit?: number;
};

export function isMediaJobTerminal(status: string | null | undefined): boolean {
    return status === 'completed'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'dead_lettered';
}

export function isMediaJobSuccessful(status: string | null | undefined): boolean {
    return status === 'completed';
}

export function normalizeMediaJobProjection(value: unknown): MediaJobProjection | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.jobId !== 'string' || typeof raw.kind !== 'string' || typeof raw.status !== 'string') {
        return null;
    }
    return {
        jobId: raw.jobId,
        kind: raw.kind as MediaJobKind,
        source: typeof raw.source === 'string' ? raw.source : 'generation_studio',
        priority: typeof raw.priority === 'string' ? raw.priority : 'interactive',
        status: raw.status,
        providerKey: typeof raw.providerKey === 'string' ? raw.providerKey : '',
        providerModel: typeof raw.providerModel === 'string' ? raw.providerModel : null,
        request: raw.request && typeof raw.request === 'object' ? raw.request as Record<string, unknown> : null,
        result: raw.result && typeof raw.result === 'object' ? raw.result as Record<string, unknown> : null,
        projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
        manuscriptPath: typeof raw.manuscriptPath === 'string' ? raw.manuscriptPath : null,
        videoProjectPath: typeof raw.videoProjectPath === 'string' ? raw.videoProjectPath : null,
        ownerSessionId: typeof raw.ownerSessionId === 'string' ? raw.ownerSessionId : null,
        cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
        completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
        attempt: raw.attempt && typeof raw.attempt === 'object' ? raw.attempt as MediaJobAttemptProjection : null,
        artifacts: Array.isArray(raw.artifacts) ? raw.artifacts as MediaJobArtifact[] : [],
        recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents as MediaJobEvent[] : [],
    };
}

export function normalizeMediaJobLog(value: unknown): MediaJobLogRecord | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.jobId !== 'string' || typeof raw.message !== 'string') return null;
    return {
        jobId: raw.jobId,
        message: raw.message,
        payload: raw.payload && typeof raw.payload === 'object' ? raw.payload as Record<string, unknown> : null,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    };
}
