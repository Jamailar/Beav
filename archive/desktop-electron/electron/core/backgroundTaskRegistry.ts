import { EventEmitter } from 'events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspacePaths } from '../db';
import { getWorkItemStore } from './workItemStore';

export type BackgroundTaskKind =
  | 'redclaw-project'
  | 'scheduled-task'
  | 'long-cycle'
  | 'heartbeat'
  | 'memory-maintenance'
  | 'headless-runtime'
  | 'external-message';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type BackgroundTaskPhase =
  | 'starting'
  | 'thinking'
  | 'tooling'
  | 'responding'
  | 'updating'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type BackgroundTaskRollbackState = 'idle' | 'running' | 'completed' | 'failed' | 'not_required';
export type BackgroundTaskWorkerState = 'idle' | 'starting' | 'running' | 'retry_wait' | 'timed_out' | 'stopping';

export interface BackgroundTaskProgressTurn {
  id: string;
  at: string;
  text: string;
  source: 'thought' | 'tool' | 'response' | 'system';
}

export interface BackgroundTaskRecord {
  id: string;
  kind: BackgroundTaskKind;
  spaceId?: string;
  title: string;
  workItemId?: string;
  status: BackgroundTaskStatus;
  phase: BackgroundTaskPhase;
  sessionId?: string;
  contextId?: string;
  error?: string;
  summary?: string;
  latestText?: string;
  attemptCount: number;
  workerState: BackgroundTaskWorkerState;
  workerMode?: 'main-process' | 'child-json-worker' | 'child-runtime-worker';
  workerPid?: number;
  workerLabel?: string;
  workerLastHeartbeatAt?: string;
  cancelReason?: string;
  rollbackState: BackgroundTaskRollbackState;
  rollbackError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  turns: BackgroundTaskProgressTurn[];
}

type CancelHandle = {
  cancel: () => Promise<void> | void;
  rollback?: () => Promise<void> | void;
};

type PersistedPayload = {
  tasks: BackgroundTaskRecord[];
};

const MAX_TURNS_PER_TASK = 80;
const MAX_TASKS = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class BackgroundTaskRegistry extends EventEmitter {
  private loadedPath: string | null = null;
  private tasks = new Map<string, BackgroundTaskRecord>();
  private cancelHandles = new Map<string, CancelHandle>();

  private getStorePath(): string {
    return path.join(getWorkspacePaths().workspaceRoot, 'redclaw', 'background-tasks.json');
  }

  private async ensureLoaded(): Promise<void> {
    const nextPath = this.getStorePath();
    if (this.loadedPath === nextPath) {
      return;
    }

    this.loadedPath = nextPath;
    this.tasks.clear();
    try {
      const raw = await fs.readFile(nextPath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedPayload;
      for (const item of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
        if (!item?.id) continue;
        this.tasks.set(item.id, item);
      }
    } catch {
      // ignore
    }
  }

  private async persist(): Promise<void> {
    if (!this.loadedPath) {
      this.loadedPath = this.getStorePath();
    }
    const payload: PersistedPayload = {
      tasks: Array.from(this.tasks.values())
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, MAX_TASKS),
    };
    await fs.mkdir(path.dirname(this.loadedPath), { recursive: true });
    await fs.writeFile(this.loadedPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  private emitUpdate(task: BackgroundTaskRecord): void {
    this.emit('task-updated', task);
  }

  async listTasks(): Promise<BackgroundTaskRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getTask(taskId: string): Promise<BackgroundTaskRecord | null> {
    await this.ensureLoaded();
    return this.tasks.get(taskId) || null;
  }

  async isCancelled(taskId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.tasks.get(taskId)?.status === 'cancelled';
  }

  async registerTask(input: {
    id?: string;
    kind: BackgroundTaskKind;
    title: string;
    contextId?: string;
    sessionId?: string;
    workItemId?: string;
    spaceId?: string;
  }): Promise<BackgroundTaskRecord> {
    await this.ensureLoaded();
    const now = nowIso();
    const task: BackgroundTaskRecord = {
      id: input.id || nextId('bg_task'),
      kind: input.kind,
      spaceId: input.spaceId || getWorkspacePaths().activeSpaceId,
      title: input.title,
      workItemId: input.workItemId,
      status: 'running',
      phase: 'starting',
      contextId: input.contextId,
      sessionId: input.sessionId,
      attemptCount: 0,
      workerState: 'idle',
      rollbackState: 'idle',
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    this.tasks.set(task.id, task);
    await this.persist();
    if (task.workItemId) {
      await getWorkItemStore().attachRefs(task.workItemId, {
        backgroundTaskIds: [task.id],
        sessionIds: task.sessionId ? [task.sessionId] : [],
      });
      await getWorkItemStore().updateWorkItem(task.workItemId, {
        status: 'active',
        summary: `后台任务已启动：${task.title}`,
      });
    }
    this.emitUpdate(task);
    return task;
  }

  registerCancelHandle(taskId: string, handle: CancelHandle): void {
    this.cancelHandles.set(taskId, handle);
  }

  clearCancelHandle(taskId: string): void {
    this.cancelHandles.delete(taskId);
  }

  async attachSession(taskId: string, sessionId: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.sessionId = sessionId;
    task.updatedAt = nowIso();
    await this.persist();
    if (task.workItemId) {
      await getWorkItemStore().attachRefs(task.workItemId, {
        sessionIds: [sessionId],
      });
    }
    this.emitUpdate(task);
  }

  async updatePhase(taskId: string, phase: BackgroundTaskPhase): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status !== 'running') return;
    if (task.phase === phase) return;
    task.phase = phase;
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async setWorkerState(taskId: string, workerState: BackgroundTaskWorkerState): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.workerState = workerState;
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async updateWorkerProcess(taskId: string, input: {
    workerMode?: 'main-process' | 'child-json-worker' | 'child-runtime-worker';
    workerPid?: number;
    workerLabel?: string;
    heartbeatAt?: string;
  }): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (input.workerMode) {
      task.workerMode = input.workerMode;
    }
    if (typeof input.workerPid === 'number' && Number.isFinite(input.workerPid)) {
      task.workerPid = input.workerPid;
    }
    if (typeof input.workerLabel === 'string' && input.workerLabel.trim()) {
      task.workerLabel = input.workerLabel.trim();
    }
    if (input.heartbeatAt) {
      task.workerLastHeartbeatAt = input.heartbeatAt;
    }
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async incrementAttempt(taskId: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.attemptCount += 1;
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async setRollbackState(taskId: string, rollbackState: BackgroundTaskRollbackState, rollbackError?: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.rollbackState = rollbackState;
    task.rollbackError = rollbackError;
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async appendTurn(taskId: string, turn: Omit<BackgroundTaskProgressTurn, 'id' | 'at'>): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status !== 'running') return;
    const text = String(turn.text || '').trim();
    if (!text) return;
    task.turns.push({
      id: nextId('turn'),
      at: nowIso(),
      text,
      source: turn.source,
    });
    task.turns = task.turns.slice(-MAX_TURNS_PER_TASK);
    task.latestText = text;
    if (turn.source === 'thought' && task.phase === 'starting') {
      task.phase = 'thinking';
    } else if (turn.source === 'tool') {
      task.phase = 'tooling';
    } else if (turn.source === 'response') {
      task.phase = 'responding';
    }
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async completeTask(taskId: string, summary?: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === 'cancelled') return;
    if (task.status === 'completed') return;
    const now = nowIso();
    task.status = 'completed';
    task.phase = 'completed';
    task.workerState = 'idle';
    task.summary = summary || task.summary;
    task.updatedAt = now;
    task.completedAt = now;
    if (task.rollbackState === 'idle') {
      task.rollbackState = 'not_required';
    }
    this.cancelHandles.delete(taskId);
    await this.persist();
    if (task.workItemId) {
      await getWorkItemStore().updateWorkItem(task.workItemId, {
        status: 'done',
        summary: summary || task.summary || '后台任务已完成。',
      });
    }
    this.emitUpdate(task);
  }

  async failTask(taskId: string, error: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === 'cancelled') return;
    if (task.status === 'failed') return;
    const now = nowIso();
    task.status = 'failed';
    task.phase = 'failed';
    task.workerState = 'idle';
    task.error = error;
    task.updatedAt = now;
    task.completedAt = now;
    if (task.rollbackState === 'idle') {
      task.rollbackState = 'not_required';
    }
    this.cancelHandles.delete(taskId);
    await this.persist();
    if (task.workItemId) {
      await getWorkItemStore().updateWorkItem(task.workItemId, {
        status: 'waiting',
        summary: `后台任务失败：${error}`,
      });
    }
    this.emitUpdate(task);
  }

  async cancelTask(taskId: string): Promise<BackgroundTaskRecord | null> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status !== 'running') {
      return task;
    }

    const handle = this.cancelHandles.get(taskId);
    task.cancelReason = 'user-cancelled';
    task.workerState = 'stopping';
    task.rollbackState = handle?.rollback ? 'running' : 'not_required';
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
    try {
      await handle?.cancel?.();
    } catch {
      // ignore cancel errors and still mark task cancelled
    }
    try {
      await handle?.rollback?.();
      if (handle?.rollback) {
        task.rollbackState = 'completed';
      }
    } catch {
      task.rollbackState = 'failed';
      task.rollbackError = 'rollback failed';
    }

    const now = nowIso();
    task.status = 'cancelled';
    task.phase = 'cancelled';
    task.workerState = 'idle';
    task.error = 'Background task cancelled';
    task.updatedAt = now;
    task.completedAt = now;
    this.cancelHandles.delete(taskId);
    await this.persist();
    if (task.workItemId) {
      await getWorkItemStore().updateWorkItem(task.workItemId, {
        status: 'cancelled',
        summary: '后台任务已取消。',
      });
    }
    this.emitUpdate(task);
    return task;
  }
}

let backgroundTaskRegistry: BackgroundTaskRegistry | null = null;

export function getBackgroundTaskRegistry(): BackgroundTaskRegistry {
  if (!backgroundTaskRegistry) {
    backgroundTaskRegistry = new BackgroundTaskRegistry();
  }
  return backgroundTaskRegistry;
}
