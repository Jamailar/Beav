import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';

export type HeadlessTaskBackoffConfig = {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  giveUpAfterMs: number;
  timeoutMs?: number;
};

type HeadlessTaskRunInput<T> = {
  taskId: string;
  title: string;
  backoff?: Partial<HeadlessTaskBackoffConfig>;
  classifyError?: (error: unknown) => 'retryable' | 'fatal';
  execute: (signal: AbortSignal, attempt: number) => Promise<T>;
};

const DEFAULT_BACKOFF: HeadlessTaskBackoffConfig = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 3,
  giveUpAfterMs: 10 * 60 * 1000,
  timeoutMs: 90 * 1000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function classifyHeadlessError(error: unknown): 'retryable' | 'fatal' {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (!message) return 'retryable';
  if (
    message.includes('invalid access token')
    || message.includes('unauthorized')
    || message.includes('missing-model-config')
    || message.includes('api key')
  ) {
    return 'fatal';
  }
  if (
    message.includes('timeout')
    || message.includes('timed out')
    || message.includes('fetch failed')
    || message.includes('socket')
    || message.includes('econnreset')
    || message.includes('temporarily unavailable')
    || message.includes('service unavailable')
    || message.includes('rate limit')
    || message.includes('429')
    || message.includes('502')
    || message.includes('503')
    || message.includes('504')
    || message.includes('network')
  ) {
    return 'retryable';
  }
  return 'fatal';
}

function mergeBackoff(input?: Partial<HeadlessTaskBackoffConfig>): HeadlessTaskBackoffConfig {
  return {
    ...DEFAULT_BACKOFF,
    ...(input || {}),
  };
}

export class HeadlessTaskSupervisor {
  async run<T>(input: HeadlessTaskRunInput<T>): Promise<T> {
    const registry = getBackgroundTaskRegistry();
    const backoff = mergeBackoff(input.backoff);
    const startedAt = Date.now();
    let attempt = 0;
    let delayMs = backoff.initialDelayMs;
    let lastError: unknown = null;

    while (attempt < backoff.maxAttempts && (Date.now() - startedAt) < backoff.giveUpAfterMs) {
      attempt += 1;
      await registry.incrementAttempt(input.taskId);
      await registry.setWorkerState(input.taskId, 'starting');
      await registry.appendTurn(input.taskId, {
        source: 'system',
        text: `[supervisor] attempt ${attempt}/${backoff.maxAttempts} starting`,
      });

      const controller = new AbortController();
      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        if (backoff.timeoutMs && backoff.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => controller.abort(), backoff.timeoutMs);
        }
        await registry.setWorkerState(input.taskId, 'running');
        const result = await input.execute(controller.signal, attempt);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        await registry.setWorkerState(input.taskId, 'idle');
        return result;
      } catch (error) {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        lastError = error;
        const wasTimeout = controller.signal.aborted;
        const classification = (input.classifyError || classifyHeadlessError)(error);
        await registry.setWorkerState(input.taskId, wasTimeout ? 'timed_out' : 'retry_wait');
        await registry.appendTurn(input.taskId, {
          source: 'system',
          text: `[supervisor] attempt ${attempt} ${wasTimeout ? 'timed out' : 'failed'} (${classification}): ${String(error instanceof Error ? error.message : error)}`,
        });
        if (classification === 'fatal' || attempt >= backoff.maxAttempts || (Date.now() - startedAt) >= backoff.giveUpAfterMs) {
          await registry.setWorkerState(input.taskId, 'idle');
          throw error;
        }
        await sleep(delayMs);
        delayMs = Math.min(backoff.maxDelayMs, delayMs * 2);
      }
    }

    await getBackgroundTaskRegistry().setWorkerState(input.taskId, 'idle');
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Headless task failed'));
  }
}

let headlessTaskSupervisor: HeadlessTaskSupervisor | null = null;

export function getHeadlessTaskSupervisor(): HeadlessTaskSupervisor {
  if (!headlessTaskSupervisor) {
    headlessTaskSupervisor = new HeadlessTaskSupervisor();
  }
  return headlessTaskSupervisor;
}
