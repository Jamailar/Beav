export type ClipboardCapturePlatform = 'youtube' | 'xiaohongshu' | 'douyin' | 'bilibili' | 'tiktok';

export type ClipboardCaptureKind =
  | 'youtube-video'
  | 'youtube-channel'
  | 'xhs-note'
  | 'xhs-profile'
  | 'douyin-video'
  | 'douyin-profile'
  | 'bilibili-profile'
  | 'tiktok-profile';

export type ClipboardCaptureConfidence = 'exact' | 'probable';

export type ClipboardCaptureSource = 'paste' | 'poll';

export interface ClipboardCaptureCandidate {
  id: string;
  kind: ClipboardCaptureKind;
  platform: ClipboardCapturePlatform;
  rawText: string;
  rawUrl: string;
  canonicalUrl: string;
  externalId?: string;
  confidence: ClipboardCaptureConfidence;
  source: ClipboardCaptureSource;
  detectedAt: string;
  title?: string;
}

export type ClipboardCaptureTaskStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped';

export interface ClipboardCaptureTask {
  id: string;
  candidate: ClipboardCaptureCandidate;
  status: ClipboardCaptureTaskStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  serverJobId?: string;
  progressMessage?: string;
  pointsCost?: number;
  error?: string;
  logs?: ClipboardCaptureTaskLog[];
  debugDetails?: string;
}

export interface ClipboardCaptureExecutionResult {
  success: boolean;
  duplicate?: boolean;
  skipped?: boolean;
  jobId?: string;
  noteId?: string;
  error?: string;
  debugDetails?: string;
}

export interface ClipboardCaptureTaskLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ServerCaptureJobRequest {
  source: 'clipboard';
  kind: ClipboardCaptureKind;
  platform: ClipboardCapturePlatform;
  url: string;
  canonicalUrl: string;
  externalId?: string;
  clientRequestId: string;
  includeComments?: boolean;
  options?: {
    downloadMedia?: boolean;
    includeComments?: boolean;
    noteType?: string;
    limit?: number;
    maxPages?: number;
    maxItems?: number;
    collectionMode?: string;
    sortBy?: string;
  };
}

export interface ServerCaptureJob {
  id: string;
  kind: ClipboardCaptureKind;
  source: string;
  url: string;
  canonicalUrl: string;
  externalId?: string | null;
  includeComments?: boolean;
  options?: Record<string, unknown>;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: {
    current: number;
    total: number;
    message?: string | null;
  };
  result?: {
    entries?: unknown[];
    [key: string]: unknown;
  } | null;
  error?: {
    code?: string | null;
    message?: string | null;
    details?: unknown;
  } | null;
  logs?: Array<string | { message?: string | null; level?: string | null; timestamp?: string | null }>;
  pointsCost?: number;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

export interface ServerCaptureJobResponse {
  success: boolean;
  duplicate?: boolean;
  job?: ServerCaptureJob;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'unavailable';
  error?: string;
  httpStatus?: number;
  raw?: unknown;
  details?: unknown;
}

export interface ServerCaptureJobListResponse {
  success: boolean;
  jobs?: ServerCaptureJob[];
  error?: string;
}
