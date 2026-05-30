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

export type KnownMediaJobKind = 'image' | 'video' | 'video_sequence' | 'audio' | 'audio_sequence' | 'voice_clone';
export type MediaJobKind = KnownMediaJobKind | (string & {});
export type MediaJobQueueMode = 'free_creation' | 'ai_generation';

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
    queueMode: MediaJobQueueMode;
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
    archivedAt?: string | null;
    archiveReason?: string | null;
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
    queueMode?: MediaJobQueueMode;
    manuscriptPath?: string;
    videoProjectPath?: string;
    ownerSessionId?: string;
    includeArchived?: boolean;
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

function normalizeTimestamp(value: unknown, fallback: number): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return new Date(fallback).toISOString();
        if (/^\d+$/.test(trimmed)) {
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
        }
        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    return new Date(fallback).toISOString();
}

function normalizeMediaJobAttempt(value: unknown): MediaJobAttemptProjection | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    return {
        attemptId: typeof raw.attemptId === 'string' ? raw.attemptId : '',
        attemptNo: typeof raw.attemptNo === 'number' ? raw.attemptNo : Number(raw.attemptNo || 0) || 0,
        status: typeof raw.status === 'string' ? raw.status : '',
        providerTaskId: typeof raw.providerTaskId === 'string' ? raw.providerTaskId : null,
        providerStatusUrl: typeof raw.providerStatusUrl === 'string' ? raw.providerStatusUrl : null,
        idempotencyKey: typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : null,
        leaseOwner: typeof raw.leaseOwner === 'string' ? raw.leaseOwner : null,
        leaseExpiresAt: typeof raw.leaseExpiresAt === 'number' ? raw.leaseExpiresAt : null,
        nextPollAt: typeof raw.nextPollAt === 'number' ? raw.nextPollAt : null,
        retryNotBeforeAt: typeof raw.retryNotBeforeAt === 'number' ? raw.retryNotBeforeAt : null,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
        response: raw.response && typeof raw.response === 'object' ? raw.response as Record<string, unknown> : null,
        createdAt: normalizeTimestamp(raw.createdAt, 0),
        updatedAt: normalizeTimestamp(raw.updatedAt, 0),
    };
}

function normalizeMediaJobArtifacts(value: unknown): MediaJobArtifact[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item): MediaJobArtifact | null => {
            if (!item || typeof item !== 'object') return null;
            const raw = item as Record<string, unknown>;
            if (typeof raw.artifactId !== 'string' || typeof raw.kind !== 'string') return null;
            return {
                artifactId: raw.artifactId,
                kind: raw.kind,
                relativePath: typeof raw.relativePath === 'string' ? raw.relativePath : null,
                absolutePath: typeof raw.absolutePath === 'string' ? raw.absolutePath : null,
                mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : null,
                previewUrl: typeof raw.previewUrl === 'string' ? raw.previewUrl : null,
                metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : null,
                createdAt: normalizeTimestamp(raw.createdAt, 0),
            };
        })
        .filter((item): item is MediaJobArtifact => Boolean(item));
}

function normalizeMediaJobEvents(value: unknown): MediaJobEvent[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item): MediaJobEvent | null => {
            if (!item || typeof item !== 'object') return null;
            const raw = item as Record<string, unknown>;
            if (typeof raw.eventType !== 'string' || typeof raw.message !== 'string') return null;
            return {
                eventType: raw.eventType,
                message: raw.message,
                payload: raw.payload && typeof raw.payload === 'object' ? raw.payload as Record<string, unknown> : null,
                createdAt: normalizeTimestamp(raw.createdAt, Date.now()),
            };
        })
        .filter((item): item is MediaJobEvent => Boolean(item));
}

function normalizeMediaJobQueueMode(raw: Record<string, unknown>): MediaJobQueueMode {
    const explicit = typeof raw.queueMode === 'string'
        ? raw.queueMode
        : typeof raw.queue_mode === 'string'
            ? raw.queue_mode
            : '';
    if (explicit === 'free_creation' || explicit === 'ai_generation') {
        return explicit;
    }
    const request = raw.request && typeof raw.request === 'object' ? raw.request as Record<string, unknown> : null;
    const requestMode = request && typeof request.queueMode === 'string' ? request.queueMode : '';
    if (requestMode === 'free_creation' || requestMode === 'ai_generation') {
        return requestMode;
    }
    return raw.source === 'generation_studio' && !raw.ownerSessionId ? 'free_creation' : 'ai_generation';
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
        queueMode: normalizeMediaJobQueueMode(raw),
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
        archivedAt: raw.archivedAt == null ? null : normalizeTimestamp(raw.archivedAt, 0),
        archiveReason: typeof raw.archiveReason === 'string' ? raw.archiveReason : null,
        createdAt: normalizeTimestamp(raw.createdAt, 0),
        updatedAt: normalizeTimestamp(raw.updatedAt, 0),
        completedAt: raw.completedAt == null ? null : normalizeTimestamp(raw.completedAt, 0),
        attempt: normalizeMediaJobAttempt(raw.attempt),
        artifacts: normalizeMediaJobArtifacts(raw.artifacts),
        recentEvents: normalizeMediaJobEvents(raw.recentEvents),
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
        createdAt: normalizeTimestamp(raw.createdAt, Date.now()),
    };
}
