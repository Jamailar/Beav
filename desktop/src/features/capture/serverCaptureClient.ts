import type {
  ClipboardCaptureCandidate,
  ServerCaptureJob,
  ServerCaptureJobListResponse,
  ServerCaptureJobRequest,
  ServerCaptureJobResponse,
} from './captureTypes';
import { clipboardCaptureDedupeKey } from './clipboardDetector';

interface ServerCaptureOptions {
  includeComments?: boolean;
}

const CAPTURE_JOB_POLL_INTERVAL_MS = 1500;
const CAPTURE_JOB_POLL_TIMEOUT_MS = 120_000;

export function buildServerCaptureJobRequest(
  candidate: ClipboardCaptureCandidate,
  options: ServerCaptureOptions = {},
): ServerCaptureJobRequest {
  return {
    source: 'clipboard',
    kind: candidate.kind,
    platform: candidate.platform,
    url: candidate.rawUrl,
    canonicalUrl: candidate.canonicalUrl,
    externalId: candidate.externalId,
    includeComments: options.includeComments === true,
    clientRequestId: clipboardCaptureDedupeKey(candidate),
    options: {
      downloadMedia: true,
      includeComments: options.includeComments === true,
    },
  };
}

export async function createServerCaptureJob(
  candidate: ClipboardCaptureCandidate,
  options: ServerCaptureOptions = {},
): Promise<ServerCaptureJobResponse> {
  const payload = buildServerCaptureJobRequest(candidate, options);
  const captureBridge = window.ipcRenderer.capture as typeof window.ipcRenderer.capture & {
    createServerJob?: (payload: ServerCaptureJobRequest) => Promise<ServerCaptureJobResponse>;
  };

  if (typeof captureBridge.createServerJob !== 'function') {
    return {
      success: false,
      status: 'unavailable',
      error: '服务端采集 API 尚未接入',
    };
  }

  return captureBridge.createServerJob(payload);
}

export async function getServerCaptureJob(jobId: string): Promise<ServerCaptureJobResponse> {
  const captureBridge = window.ipcRenderer.capture as typeof window.ipcRenderer.capture & {
    getServerJob?: (payload: { jobId: string }) => Promise<ServerCaptureJobResponse>;
  };
  if (typeof captureBridge.getServerJob !== 'function') {
    return { success: false, status: 'unavailable', error: '服务端采集 API 尚未接入' };
  }
  return captureBridge.getServerJob({ jobId });
}

export async function listServerCaptureJobs(limit = 20): Promise<ServerCaptureJobListResponse> {
  const captureBridge = window.ipcRenderer.capture as typeof window.ipcRenderer.capture & {
    listServerJobs?: (payload: { limit: number }) => Promise<ServerCaptureJobListResponse>;
  };
  if (typeof captureBridge.listServerJobs !== 'function') {
    return { success: false, jobs: [], error: '服务端采集 API 尚未接入' };
  }
  return captureBridge.listServerJobs({ limit });
}

export async function pollServerCaptureJob(
  jobId: string,
  onJob?: (job: ServerCaptureJob) => void,
): Promise<ServerCaptureJob> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CAPTURE_JOB_POLL_TIMEOUT_MS) {
    const response = await getServerCaptureJob(jobId);
    if (!response.success || !response.job) {
      throw new Error(response.error || '采集任务状态读取失败');
    }
    onJob?.(response.job);
    if (response.job.status === 'completed') return response.job;
    if (response.job.status === 'failed') {
      throw new Error(response.job.error?.message || '采集任务处理失败');
    }
    await delay(CAPTURE_JOB_POLL_INTERVAL_MS);
  }
  throw new Error('采集任务处理超时');
}

export async function ingestServerCaptureJobResult(job: ServerCaptureJob): Promise<{ success: boolean; count?: number; error?: string }> {
  const entries = Array.isArray(job.result?.entries) ? job.result.entries : [];
  if (entries.length === 0) {
    return { success: true, count: 0 };
  }
  const result = await window.ipcRenderer.knowledge.batchIngest({
    entries,
    documentSources: [],
    mediaAssets: [],
  }) as { success?: boolean; count?: number; error?: string } | null;
  if (!result?.success) {
    throw new Error(result?.error || '采集结果入库失败');
  }
  return { success: true, count: result.count || entries.length };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
