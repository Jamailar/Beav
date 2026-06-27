import type {
  ClipboardCaptureCandidate,
  ClipboardCaptureExecutionResult,
  ClipboardCaptureTask,
} from './captureTypes';

type QueueEntry = {
  task: ClipboardCaptureTask;
  execute: (
    candidate: ClipboardCaptureCandidate,
    context: { updateTask: (patch: Partial<ClipboardCaptureTask>) => void },
  ) => Promise<ClipboardCaptureExecutionResult>;
  resolve: (result: ClipboardCaptureExecutionResult) => void;
};

export interface ClipboardCaptureQueueSnapshot {
  active: ClipboardCaptureTask | null;
  queued: ClipboardCaptureTask[];
  recent: ClipboardCaptureTask[];
}

type QueueListener = (state: ClipboardCaptureQueueSnapshot) => void;

function createTaskId(candidate: ClipboardCaptureCandidate): string {
  return `clipboard-${candidate.id}-${Date.now()}`;
}

class ClipboardCaptureQueue {
  private active: QueueEntry | null = null;
  private readonly queued: QueueEntry[] = [];
  private readonly recent: ClipboardCaptureTask[] = [];
  private readonly listeners = new Set<QueueListener>();

  enqueue(
    candidate: ClipboardCaptureCandidate,
    execute: QueueEntry['execute'],
  ): Promise<ClipboardCaptureExecutionResult> {
    return new Promise((resolve) => {
      const now = new Date().toISOString();
      const entry: QueueEntry = {
        task: {
          id: createTaskId(candidate),
          candidate,
          status: 'queued',
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
        execute,
        resolve,
      };
      this.queued.push(entry);
      this.publish();
      void this.runNext();
    });
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private async runNext(): Promise<void> {
    if (this.active || this.queued.length === 0) return;
    const entry = this.queued.shift();
    if (!entry) return;

    this.active = entry;
    entry.task.status = 'running';
    entry.task.attempts += 1;
    entry.task.updatedAt = new Date().toISOString();
    this.publish();

    try {
      const updateTask = (patch: Partial<ClipboardCaptureTask>) => {
        Object.assign(entry.task, patch, { updatedAt: new Date().toISOString() });
        this.publish();
      };
      const result = await entry.execute(entry.task.candidate, { updateTask });
      entry.task.status = result.skipped ? 'skipped' : result.success ? 'success' : 'failed';
      entry.task.error = result.error;
      entry.task.serverJobId = result.jobId || entry.task.serverJobId;
      entry.task.updatedAt = new Date().toISOString();
      entry.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.task.status = 'failed';
      entry.task.error = message;
      entry.task.updatedAt = new Date().toISOString();
      entry.resolve({ success: false, error: message });
    } finally {
      this.pushRecent(entry.task);
      this.active = null;
      this.publish();
      void this.runNext();
    }
  }

  getSnapshot(): ClipboardCaptureQueueSnapshot {
    return this.snapshot();
  }

  private snapshot(): ClipboardCaptureQueueSnapshot {
    return {
      active: this.active?.task || null,
      queued: this.queued.map((entry) => entry.task),
      recent: [...this.recent],
    };
  }

  private pushRecent(task: ClipboardCaptureTask): void {
    this.recent.unshift({ ...task });
    this.recent.splice(8);
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export const clipboardCaptureQueue = new ClipboardCaptureQueue();
