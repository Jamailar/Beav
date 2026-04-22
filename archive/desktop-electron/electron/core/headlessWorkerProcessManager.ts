import { app } from 'electron';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getWorkspacePaths } from '../db';
import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';
import { evaluateRuntimeToolPermission } from './runtimePermissions';
import { applyToolResultBudget } from './toolResultBudget';
import { getSessionRuntimeStore } from './sessionRuntimeStore';
import { getToolResultStore } from './toolResultStore';
import { summarizeToolBatch } from './toolBatchSummary';
import { SkillManager } from './skillManager';
import {
  createErrorResult,
  ToolErrorType,
  ToolConfirmationOutcome,
  ToolExecutor,
  ToolRegistry,
  type ToolCallRequest,
  type ToolCallResponse,
} from './toolRegistry';
import { createBuiltinTools } from './tools';
import type { BuiltinToolPack } from './tools/catalog';

type JsonWorkerResult = {
  response: string;
  usage?: unknown;
  finishReason?: string | null;
};

type RuntimeWorkerResult = {
  response: string;
  usage?: unknown;
  finishReason?: string | null;
};

type HostedToolFeedback = {
  toolName: string;
  promptText: string;
  success: boolean;
};

type PendingRunBase = {
  runId: string;
  taskId: string;
  sessionId: string;
  rollback?: () => Promise<void> | void;
  attemptSignal?: AbortSignal;
  onAttemptAbort?: () => void;
};

type PendingJsonRun = PendingRunBase & {
  resolve: (value: JsonWorkerResult) => void;
  reject: (reason?: unknown) => void;
};

type PendingRuntimeRun = PendingRunBase & {
  toolPack: BuiltinToolPack;
  runtimeMode?: string;
  requiresHumanApproval?: boolean;
  toolAbortController: AbortController;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  resolve: (value: RuntimeWorkerResult) => void;
  reject: (reason?: unknown) => void;
};

type WorkerMode = 'child-json-worker' | 'child-runtime-worker';

type ToolCallMessage = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type BaseWorkerSlot<TPending extends PendingRunBase> = {
  id: string;
  mode: WorkerMode;
  fileName: string;
  child: ChildProcess | null;
  ready: boolean;
  currentRun: TPending | null;
  readyResolvers: Array<() => void>;
  lastHeartbeatAt?: string;
  lastUsedAt: number;
};

type JsonWorkerSlot = BaseWorkerSlot<PendingJsonRun>;

type RuntimeWorkerSlot = BaseWorkerSlot<PendingRuntimeRun>;

export type WorkerPoolSlotSnapshot = {
  id: string;
  mode: WorkerMode;
  ready: boolean;
  busy: boolean;
  pid?: number;
  sessionId?: string;
  taskId?: string;
  lastHeartbeatAt?: string;
  lastUsedAt?: string;
};

const MAX_JSON_WORKERS = 2;
const MAX_RUNTIME_WORKERS = 3;

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveWorkerPath(fileName: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'workers', fileName);
  }
  return path.join(app.getAppPath(), 'electron', 'workers', fileName);
}

function createWorker(mode: WorkerMode, fileName: string): ChildProcess {
  return spawn(process.execPath, [resolveWorkerPath(fileName)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function createWorkerSlot<TPending extends PendingRunBase>(
  id: string,
  mode: WorkerMode,
  fileName: string,
): BaseWorkerSlot<TPending> {
  return {
    id,
    mode,
    fileName,
    child: null,
    ready: false,
    currentRun: null,
    readyResolvers: [],
    lastUsedAt: 0,
  };
}

export class HeadlessWorkerProcessManager {
  private readonly runtimeStore = getSessionRuntimeStore();
  private readonly toolResultStore = getToolResultStore();

  private readonly jsonSlots: JsonWorkerSlot[] = [];
  private readonly runtimeSlots: RuntimeWorkerSlot[] = [];
  private readonly jsonSessionAffinity = new Map<string, string>();
  private readonly runtimeSessionAffinity = new Map<string, string>();
  private readonly jsonAvailabilityWaiters: Array<() => void> = [];
  private readonly runtimeAvailabilityWaiters: Array<() => void> = [];

  private getOrCreateJsonSlot(index?: number): JsonWorkerSlot {
    if (typeof index === 'number' && this.jsonSlots[index]) {
      return this.jsonSlots[index];
    }
    const slot = createWorkerSlot<PendingJsonRun>(
      `json-worker-${this.jsonSlots.length + 1}`,
      'child-json-worker',
      'json-runtime-worker.mjs',
    );
    this.jsonSlots.push(slot);
    return slot;
  }

  private getOrCreateRuntimeSlot(index?: number): RuntimeWorkerSlot {
    if (typeof index === 'number' && this.runtimeSlots[index]) {
      return this.runtimeSlots[index];
    }
    const slot = createWorkerSlot<PendingRuntimeRun>(
      `runtime-worker-${this.runtimeSlots.length + 1}`,
      'child-runtime-worker',
      'query-runtime-worker.mjs',
    );
    this.runtimeSlots.push(slot);
    return slot;
  }

  private resolvePoolWaiters(waiters: Array<() => void>): void {
    for (const resolve of waiters.splice(0)) {
      resolve();
    }
  }

  private notifyJsonAvailability(): void {
    this.resolvePoolWaiters(this.jsonAvailabilityWaiters);
  }

  private notifyRuntimeAvailability(): void {
    this.resolvePoolWaiters(this.runtimeAvailabilityWaiters);
  }

  private async waitForJsonAvailability(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.jsonAvailabilityWaiters.push(resolve);
    });
  }

  private async waitForRuntimeAvailability(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.runtimeAvailabilityWaiters.push(resolve);
    });
  }

  private clearAffinityForSlot(slotId: string, map: Map<string, string>): void {
    for (const [sessionId, currentSlotId] of map.entries()) {
      if (currentSlotId === slotId) {
        map.delete(sessionId);
      }
    }
  }

  private async ensureJsonSlot(slot: JsonWorkerSlot): Promise<ChildProcess> {
    if (slot.child && !slot.child.killed && slot.ready) {
      return slot.child;
    }
    if (slot.child && !slot.child.killed && !slot.ready) {
      await new Promise<void>((resolve) => {
        slot.readyResolvers.push(resolve);
      });
      return slot.child;
    }

    const child = createWorker(slot.mode, slot.fileName);
    slot.child = child;
    slot.ready = false;

    child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        slot.ready = true;
        slot.lastHeartbeatAt = new Date().toISOString();
        for (const resolve of slot.readyResolvers.splice(0)) {
          resolve();
        }
        this.notifyJsonAvailability();
        return;
      }

      const run = slot.currentRun;

      if (message.type === 'heartbeat') {
        slot.lastHeartbeatAt = new Date().toISOString();
        if (run && (!message.runId || message.runId === run.runId)) {
          void getBackgroundTaskRegistry().updateWorkerProcess(run.taskId, {
            workerMode: slot.mode,
            workerPid: child.pid || undefined,
            workerLabel: slot.id,
            heartbeatAt: slot.lastHeartbeatAt,
          });
        }
        return;
      }

      if (!run || (message.runId && message.runId !== run.runId)) {
        return;
      }

      if (message.type === 'progress') {
        this.handleWorkerProgress({
          taskId: run.taskId,
          sessionId: run.sessionId,
          workerMode: slot.mode,
          workerPid: child.pid || undefined,
          workerLabel: slot.id,
          phase: String(message.phase || ''),
          text: typeof message.text === 'string' ? message.text : '',
        });
        return;
      }

      if (message.type === 'result') {
        this.finishJsonRun(slot, () => {
          const result = {
            response: String(message.response || ''),
            usage: message.usage,
            finishReason: message.finishReason ?? null,
          };
          this.appendRuntimeFinalRecord({
            sessionId: run.sessionId,
            response: result.response,
            usage: result.usage,
            finishReason: result.finishReason,
          });
          run.resolve(result);
        });
        return;
      }

      if (message.type === 'error') {
        this.finishJsonRun(slot, () => {
          const messageText = String(message.error || 'Worker execution failed');
          this.appendRuntimeFailureRecord(run.sessionId, messageText);
          run.reject(new Error(messageText));
        });
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text && slot.currentRun) {
        void getBackgroundTaskRegistry().appendTurn(slot.currentRun.taskId, {
          source: 'system',
          text: `[worker-stderr][${slot.id}] ${text}`,
        });
      }
    });

    const handleExit = (reason: string) => {
      const run = slot.currentRun;
      slot.child = null;
      slot.ready = false;
      this.clearAffinityForSlot(slot.id, this.jsonSessionAffinity);
      if (run) {
        this.finishJsonRun(slot, () => run.reject(new Error(reason)));
      } else {
        this.notifyJsonAvailability();
      }
    };

    child.on('error', (error) => {
      handleExit(error instanceof Error ? error.message : String(error));
    });

    child.on('exit', (code, signal) => {
      handleExit(`JSON worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    await new Promise<void>((resolve) => {
      slot.readyResolvers.push(resolve);
    });

    return child;
  }

  private async ensureRuntimeSlot(slot: RuntimeWorkerSlot): Promise<ChildProcess> {
    if (slot.child && !slot.child.killed && slot.ready) {
      return slot.child;
    }
    if (slot.child && !slot.child.killed && !slot.ready) {
      await new Promise<void>((resolve) => {
        slot.readyResolvers.push(resolve);
      });
      return slot.child;
    }

    const child = createWorker(slot.mode, slot.fileName);
    slot.child = child;
    slot.ready = false;

    child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        slot.ready = true;
        slot.lastHeartbeatAt = new Date().toISOString();
        for (const resolve of slot.readyResolvers.splice(0)) {
          resolve();
        }
        this.notifyRuntimeAvailability();
        return;
      }

      const run = slot.currentRun;

      if (message.type === 'heartbeat') {
        slot.lastHeartbeatAt = new Date().toISOString();
        if (run && (!message.runId || message.runId === run.runId)) {
          void getBackgroundTaskRegistry().updateWorkerProcess(run.taskId, {
            workerMode: slot.mode,
            workerPid: child.pid || undefined,
            workerLabel: slot.id,
            heartbeatAt: slot.lastHeartbeatAt,
          });
        }
        return;
      }

      if (!run || (message.runId && message.runId !== run.runId)) {
        return;
      }

      if (message.type === 'progress') {
        this.handleWorkerProgress({
          taskId: run.taskId,
          sessionId: run.sessionId,
          workerMode: slot.mode,
          workerPid: child.pid || undefined,
          workerLabel: slot.id,
          phase: String(message.phase || ''),
          text: typeof message.text === 'string' ? message.text : '',
        });
        return;
      }

      if (message.type === 'tool-call-batch') {
        void this.handleRuntimeToolBatch(slot, Array.isArray(message.calls) ? message.calls : []);
        return;
      }

      if (message.type === 'result') {
        this.finishRuntimeRun(slot, () => {
          const result = {
            response: String(message.response || ''),
            usage: message.usage,
            finishReason: message.finishReason ?? null,
          };
          this.appendRuntimeFinalRecord({
            sessionId: run.sessionId,
            response: result.response,
            usage: result.usage,
            finishReason: result.finishReason,
          });
          run.resolve(result);
        });
        return;
      }

      if (message.type === 'error') {
        this.finishRuntimeRun(slot, () => {
          const messageText = String(message.error || 'Runtime worker execution failed');
          this.appendRuntimeFailureRecord(run.sessionId, messageText);
          run.reject(new Error(messageText));
        });
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text && slot.currentRun) {
        void getBackgroundTaskRegistry().appendTurn(slot.currentRun.taskId, {
          source: 'system',
          text: `[runtime-worker-stderr][${slot.id}] ${text}`,
        });
      }
    });

    const handleExit = (reason: string) => {
      const run = slot.currentRun;
      slot.child = null;
      slot.ready = false;
      this.clearAffinityForSlot(slot.id, this.runtimeSessionAffinity);
      if (run) {
        run.toolAbortController.abort();
        this.finishRuntimeRun(slot, () => run.reject(new Error(reason)));
      } else {
        this.notifyRuntimeAvailability();
      }
    };

    child.on('error', (error) => {
      handleExit(error instanceof Error ? error.message : String(error));
    });

    child.on('exit', (code, signal) => {
      handleExit(`Runtime worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    await new Promise<void>((resolve) => {
      slot.readyResolvers.push(resolve);
    });

    return child;
  }

  private async acquireJsonSlot(sessionId: string): Promise<JsonWorkerSlot> {
    while (true) {
      const preferredSlotId = this.jsonSessionAffinity.get(sessionId);
      if (preferredSlotId) {
        const preferred = this.jsonSlots.find((slot) => slot.id === preferredSlotId);
        if (preferred) {
          await this.ensureJsonSlot(preferred);
          if (!preferred.currentRun) {
            return preferred;
          }
        }
      }

      for (const slot of this.jsonSlots) {
        await this.ensureJsonSlot(slot);
      }
      const idleExisting = this.jsonSlots
        .filter((slot) => slot.ready && !slot.currentRun)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (idleExisting) {
        return idleExisting;
      }

      if (this.jsonSlots.length < MAX_JSON_WORKERS) {
        const slot = this.getOrCreateJsonSlot();
        await this.ensureJsonSlot(slot);
        if (!slot.currentRun) {
          return slot;
        }
      }

      await this.waitForJsonAvailability();
    }
  }

  private async acquireRuntimeSlot(sessionId: string): Promise<RuntimeWorkerSlot> {
    while (true) {
      const preferredSlotId = this.runtimeSessionAffinity.get(sessionId);
      if (preferredSlotId) {
        const preferred = this.runtimeSlots.find((slot) => slot.id === preferredSlotId);
        if (preferred) {
          await this.ensureRuntimeSlot(preferred);
          if (!preferred.currentRun) {
            return preferred;
          }
        }
      }

      for (const slot of this.runtimeSlots) {
        await this.ensureRuntimeSlot(slot);
      }
      const idleExisting = this.runtimeSlots
        .filter((slot) => slot.ready && !slot.currentRun)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (idleExisting) {
        return idleExisting;
      }

      if (this.runtimeSlots.length < MAX_RUNTIME_WORKERS) {
        const slot = this.getOrCreateRuntimeSlot();
        await this.ensureRuntimeSlot(slot);
        if (!slot.currentRun) {
          return slot;
        }
      }

      await this.waitForRuntimeAvailability();
    }
  }

  private handleWorkerProgress(input: {
    taskId: string;
    sessionId: string;
    workerMode: WorkerMode;
    workerPid?: number;
    workerLabel?: string;
    phase: string;
    text: string;
  }): void {
    const registry = getBackgroundTaskRegistry();
    const normalizedPhase = String(input.phase || '').trim();
    if (normalizedPhase === 'starting') {
      void registry.updatePhase(input.taskId, 'starting');
    } else if (normalizedPhase === 'thinking') {
      void registry.updatePhase(input.taskId, 'thinking');
    } else if (normalizedPhase === 'tooling') {
      void registry.updatePhase(input.taskId, 'tooling');
    } else if (normalizedPhase === 'responding') {
      void registry.updatePhase(input.taskId, 'responding');
    }
    void registry.updateWorkerProcess(input.taskId, {
      workerMode: input.workerMode,
      workerPid: input.workerPid,
      workerLabel: input.workerLabel,
      heartbeatAt: new Date().toISOString(),
    });
    if (input.text) {
      void registry.appendTurn(input.taskId, {
        source: normalizedPhase === 'responding' ? 'response' : normalizedPhase === 'tooling' ? 'tool' : 'system',
        text: input.text,
      });
      this.runtimeStore.appendTranscript({
        sessionId: input.sessionId,
        recordType: 'worker.progress',
        role: normalizedPhase === 'responding' ? 'assistant' : 'system',
        content: input.text,
        payload: {
          kind: 'worker.progress',
          data: {
            phase: normalizedPhase,
            workerMode: input.workerMode,
            workerPid: input.workerPid,
            workerLabel: input.workerLabel,
          },
        },
      });
    }
  }

  private appendRuntimeStartRecord(params: {
    sessionId: string;
    toolPack: string;
    workerMode: WorkerMode;
    workerPid?: number;
    workerLabel?: string;
    userInput: string;
  }): void {
    this.runtimeStore.appendTranscript({
      sessionId: params.sessionId,
      recordType: 'query.user',
      role: 'user',
      content: params.userInput,
      payload: {
        kind: 'query.user',
        data: {
          toolPack: params.toolPack,
          workerMode: params.workerMode,
          workerPid: params.workerPid,
          workerLabel: params.workerLabel,
        },
      },
    });
    this.runtimeStore.addCheckpoint({
      sessionId: params.sessionId,
      checkpointType: 'query.start',
      summary: '后台任务已进入统一运行时',
      payload: {
        toolPack: params.toolPack,
        workerMode: params.workerMode,
        workerPid: params.workerPid,
        workerLabel: params.workerLabel,
      },
    });
  }

  private appendRuntimeFinalRecord(params: {
    sessionId: string;
    response: string;
    finishReason?: string | null;
    usage?: unknown;
  }): void {
    this.runtimeStore.appendTranscript({
      sessionId: params.sessionId,
      recordType: 'assistant.response',
      role: 'assistant',
      content: params.response,
      payload: {
        kind: 'assistant.response',
        data: {
          finishReason: params.finishReason ?? null,
          usage: params.usage ?? null,
        },
      },
    });
    this.runtimeStore.addCheckpoint({
      sessionId: params.sessionId,
      checkpointType: 'response.final',
      summary: params.response.slice(0, 240) || '后台 assistant response completed',
      payload: {
        responseLength: params.response.length,
        finishReason: params.finishReason ?? null,
        usage: params.usage ?? null,
      },
    });
  }

  private appendRuntimeFailureRecord(sessionId: string, message: string): void {
    this.runtimeStore.appendTranscript({
      sessionId,
      recordType: 'runtime.error',
      role: 'system',
      content: message,
      payload: {
        kind: 'runtime.error',
        data: {},
      },
    });
    this.runtimeStore.addCheckpoint({
      sessionId,
      checkpointType: 'stop.failure',
      summary: message,
      payload: {},
    });
  }

  private finishJsonRun(slot: JsonWorkerSlot, fn: () => void): void {
    const run = slot.currentRun;
    if (!run) return;
    if (run.attemptSignal && run.onAttemptAbort) {
      run.attemptSignal.removeEventListener('abort', run.onAttemptAbort);
    }
    getBackgroundTaskRegistry().clearCancelHandle(run.taskId);
    slot.currentRun = null;
    slot.lastUsedAt = Date.now();
    fn();
    this.notifyJsonAvailability();
  }

  private finishRuntimeRun(slot: RuntimeWorkerSlot, fn: () => void): void {
    const run = slot.currentRun;
    if (!run) return;
    if (run.attemptSignal && run.onAttemptAbort) {
      run.attemptSignal.removeEventListener('abort', run.onAttemptAbort);
    }
    run.toolAbortController.abort();
    getBackgroundTaskRegistry().clearCancelHandle(run.taskId);
    slot.currentRun = null;
    slot.lastUsedAt = Date.now();
    fn();
    this.notifyRuntimeAvailability();
  }

  private abortJsonRun(slot: JsonWorkerSlot): void {
    if (!slot.child || !slot.currentRun) return;
    slot.child.send?.({ type: 'abort', runId: slot.currentRun.runId });
  }

  private abortRuntimeRun(slot: RuntimeWorkerSlot): void {
    if (!slot.child || !slot.currentRun) return;
    slot.currentRun.toolAbortController.abort();
    slot.child.send?.({ type: 'abort', runId: slot.currentRun.runId });
  }

  async runJsonTask(input: {
    taskId: string;
    sessionId: string;
    model: string;
    apiKey: string;
    baseURL: string;
    systemPrompt: string;
    userInput: string;
    temperature?: number;
    rollback?: () => Promise<void> | void;
    attemptSignal?: AbortSignal;
  }): Promise<JsonWorkerResult> {
    return await new Promise<JsonWorkerResult>(async (resolve, reject) => {
      try {
        const slot = await this.acquireJsonSlot(input.sessionId);
        const child = await this.ensureJsonSlot(slot);
        const runId = nextId('json_run');
        const registry = getBackgroundTaskRegistry();
        const onAttemptAbort = () => this.abortJsonRun(slot);
        this.currentAffinity('json', input.sessionId, slot.id);
        slot.currentRun = {
          runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          rollback: input.rollback,
          attemptSignal: input.attemptSignal,
          onAttemptAbort,
          resolve,
          reject,
        };

        registry.registerCancelHandle(input.taskId, {
          cancel: () => {
            this.abortJsonRun(slot);
          },
          rollback: input.rollback,
        });

        await registry.updateWorkerProcess(input.taskId, {
          workerMode: slot.mode,
          workerPid: child.pid || undefined,
          workerLabel: slot.id,
          heartbeatAt: new Date().toISOString(),
        });
        await registry.appendTurn(input.taskId, {
          source: 'system',
          text: `[worker] connected to persistent JSON child ${slot.id} pid=${child.pid || 'unknown'}`,
        });
        this.appendRuntimeStartRecord({
          sessionId: input.sessionId,
          toolPack: 'background-maintenance',
          workerMode: slot.mode,
          workerPid: child.pid || undefined,
          workerLabel: slot.id,
          userInput: input.userInput,
        });

        if (input.attemptSignal) {
          if (input.attemptSignal.aborted) {
            this.abortJsonRun(slot);
          } else {
            input.attemptSignal.addEventListener('abort', onAttemptAbort, { once: true });
          }
        }

        child.send?.({
          type: 'run-json-task',
          runId,
          payload: {
            model: input.model,
            apiKey: input.apiKey,
            baseURL: input.baseURL,
            systemPrompt: input.systemPrompt,
            userInput: input.userInput,
            temperature: input.temperature ?? 0.1,
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async runRuntimeTask(input: {
    taskId: string;
    sessionId: string;
    model: string;
    apiKey: string;
    baseURL: string;
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    userInput: string;
    toolPack: BuiltinToolPack;
    runtimeMode?: string;
    requiresHumanApproval?: boolean;
    temperature?: number;
    maxTurns?: number;
    maxTimeMinutes?: number;
    workspaceRoot?: string;
    projectRoot?: string;
    rollback?: () => Promise<void> | void;
    attemptSignal?: AbortSignal;
  }): Promise<RuntimeWorkerResult> {
    return await new Promise<RuntimeWorkerResult>(async (resolve, reject) => {
      try {
        const slot = await this.acquireRuntimeSlot(input.sessionId);
        const child = await this.ensureRuntimeSlot(slot);
        const runId = nextId('runtime_run');
        const registry = getBackgroundTaskRegistry();
        const toolRegistry = new ToolRegistry();
        const skillManager = new SkillManager();
        await skillManager.discoverSkills(input.projectRoot || input.workspaceRoot || getWorkspacePaths().base);
        toolRegistry.registerTools(createBuiltinTools({
          pack: input.toolPack,
          skillManager,
          workspaceRootOverride: input.workspaceRoot,
        }));
        const toolExecutor = new ToolExecutor(toolRegistry, async () => ToolConfirmationOutcome.ProceedOnce);
        const onAttemptAbort = () => this.abortRuntimeRun(slot);

        this.currentAffinity('runtime', input.sessionId, slot.id);
        slot.currentRun = {
          runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          toolPack: input.toolPack,
          runtimeMode: input.runtimeMode,
          requiresHumanApproval: input.requiresHumanApproval,
          rollback: input.rollback,
          attemptSignal: input.attemptSignal,
          onAttemptAbort,
          toolAbortController: new AbortController(),
          toolRegistry,
          toolExecutor,
          resolve,
          reject,
        };

        registry.registerCancelHandle(input.taskId, {
          cancel: () => {
            this.abortRuntimeRun(slot);
          },
          rollback: input.rollback,
        });

        await registry.updateWorkerProcess(input.taskId, {
          workerMode: slot.mode,
          workerPid: child.pid || undefined,
          workerLabel: slot.id,
          heartbeatAt: new Date().toISOString(),
        });
        await registry.appendTurn(input.taskId, {
          source: 'system',
          text: `[worker] connected to persistent runtime child ${slot.id} pid=${child.pid || 'unknown'} pack=${input.toolPack}`,
        });
        this.appendRuntimeStartRecord({
          sessionId: input.sessionId,
          toolPack: input.toolPack,
          workerMode: slot.mode,
          workerPid: child.pid || undefined,
          workerLabel: slot.id,
          userInput: input.userInput,
        });

        if (input.attemptSignal) {
          if (input.attemptSignal.aborted) {
            this.abortRuntimeRun(slot);
          } else {
            input.attemptSignal.addEventListener('abort', onAttemptAbort, { once: true });
          }
        }

        child.send?.({
          type: 'run-query-task',
          runId,
          payload: {
            model: input.model,
            apiKey: input.apiKey,
            baseURL: input.baseURL,
            systemPrompt: input.systemPrompt,
            messages: input.messages,
            userInput: input.userInput,
            temperature: input.temperature ?? 0.6,
            maxTurns: input.maxTurns ?? 24,
            maxTimeMinutes: input.maxTimeMinutes ?? 12,
            toolSchemas: toolRegistry.getToolSchemas(),
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private currentAffinity(kind: 'json' | 'runtime', sessionId: string, slotId: string): void {
    if (kind === 'json') {
      this.jsonSessionAffinity.set(sessionId, slotId);
      return;
    }
    this.runtimeSessionAffinity.set(sessionId, slotId);
  }

  getPoolSnapshot(): {
    json: WorkerPoolSlotSnapshot[];
    runtime: WorkerPoolSlotSnapshot[];
  } {
    const toSnapshot = <TPending extends PendingRunBase>(slot: BaseWorkerSlot<TPending>): WorkerPoolSlotSnapshot => ({
      id: slot.id,
      mode: slot.mode,
      ready: slot.ready,
      busy: Boolean(slot.currentRun),
      pid: slot.child?.pid || undefined,
      sessionId: slot.currentRun?.sessionId,
      taskId: slot.currentRun?.taskId,
      lastHeartbeatAt: slot.lastHeartbeatAt,
      lastUsedAt: slot.lastUsedAt ? new Date(slot.lastUsedAt).toISOString() : undefined,
    });
    return {
      json: this.jsonSlots.map(toSnapshot),
      runtime: this.runtimeSlots.map(toSnapshot),
    };
  }

  private async handleRuntimeToolBatch(
    slot: RuntimeWorkerSlot,
    calls: ToolCallMessage[],
  ): Promise<void> {
    const child = slot.child;
    const run = slot.currentRun;
    if (!child || !run) {
      return;
    }
    try {
      const results = await this.executeHostedToolBatch(slot, run, calls);
      child.send?.({
        type: 'tool-result-batch',
        runId: run.runId,
        results,
      });
    } catch (error) {
      child.send?.({
        type: 'tool-result-batch',
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeHostedToolBatch(
    slot: RuntimeWorkerSlot,
    run: PendingRuntimeRun,
    calls: ToolCallMessage[],
  ): Promise<HostedToolFeedback[]> {
    this.runtimeStore.appendTranscript({
      sessionId: run.sessionId,
      recordType: 'assistant.tool_call',
      role: 'assistant',
      content: '',
      payload: {
        kind: 'assistant.tool_call',
        data: {
          calls: calls.map((call) => ({ id: call.id, name: call.name, args: call.args })),
          workerMode: slot.mode,
          workerLabel: slot.id,
        },
      },
    });

    const responses: ToolCallResponse[] = [];
    for (const call of calls) {
      await getBackgroundTaskRegistry().appendTurn(run.taskId, {
        source: 'tool',
        text: `调用工具：${call.name}`,
      });
      const tool = run.toolRegistry.getTool(call.name);
      if (!tool) {
        const missingResult = createErrorResult(`Tool "${call.name}" not found`, ToolErrorType.EXECUTION_FAILED);
        responses.push({
          callId: call.id,
          name: call.name,
          result: missingResult,
          durationMs: 0,
        });
        await getBackgroundTaskRegistry().appendTurn(run.taskId, {
          source: 'system',
          text: `${call.name}: error | tool not found`,
        });
        continue;
      }
      const permission = evaluateRuntimeToolPermission({
        tool,
        toolName: call.name,
        args: call.args,
        context: {
          sessionId: run.sessionId,
          toolPack: run.toolPack,
          runtimeMode: run.runtimeMode,
          interactive: false,
          requiresHumanApproval: run.requiresHumanApproval,
        },
      });
      if (permission.outcome === 'deny') {
        this.runtimeStore.appendTranscript({
          sessionId: run.sessionId,
          recordType: 'tool.permission',
          role: 'system',
          content: `${call.name}: deny - ${permission.reason}`,
          payload: {
            kind: 'tool.permission',
            data: {
              callId: call.id,
              toolName: call.name,
              outcome: 'deny',
              workerMode: slot.mode,
              workerLabel: slot.id,
            },
          },
        });
        this.runtimeStore.addCheckpoint({
          sessionId: run.sessionId,
          checkpointType: 'tool.permission.denied',
          summary: `${call.name}: ${permission.reason}`,
          payload: {
            callId: call.id,
            toolName: call.name,
            workerMode: slot.mode,
            workerLabel: slot.id,
          },
        });
        const deniedResult = createErrorResult(permission.reason, ToolErrorType.PERMISSION_DENIED);
        const deniedResponse: ToolCallResponse = {
          callId: call.id,
          name: call.name,
          result: deniedResult,
          durationMs: 0,
        };
        responses.push(deniedResponse);
        await getBackgroundTaskRegistry().appendTurn(run.taskId, {
          source: 'system',
          text: `${call.name}: permission denied | ${permission.reason}`,
        });
      } else {
        if (permission.outcome === 'confirm') {
          this.runtimeStore.appendTranscript({
            sessionId: run.sessionId,
            recordType: 'tool.permission',
            role: 'system',
            content: `${call.name}: confirm - ${permission.reason}`,
            payload: {
              kind: 'tool.permission',
              data: {
                callId: call.id,
                toolName: call.name,
                outcome: 'confirm',
                workerMode: slot.mode,
                workerLabel: slot.id,
              },
            },
          });
          await getBackgroundTaskRegistry().appendTurn(run.taskId, {
            source: 'system',
            text: `${call.name}: auto-approved in hosted worker | ${permission.reason}`,
          });
        }
        const response = await run.toolExecutor.execute({
          callId: call.id,
          name: call.name,
          params: call.args,
          forceConfirmation: permission.outcome === 'confirm',
          confirmationDetails: permission.details || null,
        } satisfies ToolCallRequest, run.toolAbortController.signal);
        responses.push(response);
      }
      const response = responses[responses.length - 1];
      const resultText = String(response.result.llmContent || response.result.display || response.result.error?.message || '').trim();
      const summaryText = resultText.length > 4_000
        ? `${resultText.slice(0, 4_000)}\n\n[tool result summarized for runtime event]`
        : resultText;
      const persisted = this.toolResultStore.add({
        sessionId: run.sessionId,
        callId: response.callId,
        toolName: response.name,
        command: typeof call.args.command === 'string' ? call.args.command : undefined,
        result: response.result,
        summaryText,
        payload: {
          durationMs: response.durationMs,
          workerMode: slot.mode,
          workerLabel: slot.id,
        },
      });
      this.runtimeStore.appendTranscript({
        sessionId: run.sessionId,
        recordType: 'tool.result',
        role: 'tool',
        content: summaryText || response.result.llmContent,
        payload: {
          kind: 'tool.result',
          data: {
            toolResultId: persisted.id,
            callId: response.callId,
            toolName: response.name,
            success: response.result.success,
            durationMs: response.durationMs,
            workerLabel: slot.id,
          },
        },
      });
      await getBackgroundTaskRegistry().appendTurn(run.taskId, {
        source: 'tool',
        text: `${call.name}: ${response.result.success ? 'success' : 'error'}${response.result.error?.message ? ` | ${response.result.error.message}` : ''}`,
      });
    }

    const budgeted = applyToolResultBudget(
      run.toolRegistry,
      responses.map((response) => ({
        toolName: response.name,
        result: response.result,
      })),
    );

    const feedback = budgeted.map((item, index) => {
      const response = responses[index];
      const persisted = response
        ? this.toolResultStore.applyBudget({
            sessionId: run.sessionId,
            callId: response.callId,
            promptText: item.promptText,
            originalChars: item.originalChars,
            promptChars: item.promptChars,
            truncated: item.truncated,
          })
        : null;
      if (item.truncated) {
        this.runtimeStore.appendTranscript({
          sessionId: run.sessionId,
          recordType: 'tool.result.budget',
          role: 'system',
          content: `tool=${item.toolName}; original=${item.originalChars}; prompt=${item.promptChars}`,
          payload: {
            kind: 'tool.result.budget',
            data: {
              toolName: item.toolName,
              callId: response?.callId,
              toolResultId: persisted?.id,
              originalChars: item.originalChars,
              promptChars: item.promptChars,
            },
          },
        });
      }
      return {
        toolName: item.toolName,
        promptText: item.promptText,
        success: response?.result.success ?? true,
      };
    });

    this.runtimeStore.addCheckpoint({
      sessionId: run.sessionId,
      checkpointType: 'tool.batch',
      summary: summarizeToolBatch(
        calls.map((call, index) => ({
          name: call.name,
          args: call.args,
          result: responses[index]?.result,
        })).filter((item): item is { name: string; args: Record<string, unknown>; result: ToolCallResponse['result'] } => Boolean(item.result)),
      ) || `Completed ${responses.length} hosted tool call(s)`,
      payload: {
        workerLabel: slot.id,
        tools: responses.map((response) => ({
          callId: response.callId,
          name: response.name,
          success: response.result.success,
        })),
      },
    });

    return feedback;
  }

  async dispose(): Promise<void> {
    for (const slot of this.jsonSlots) {
      if (slot.currentRun && slot.child) {
        slot.child.send?.({ type: 'abort', runId: slot.currentRun.runId });
      }
    }
    for (const slot of this.runtimeSlots) {
      if (slot.currentRun && slot.child) {
        slot.currentRun.toolAbortController.abort();
        slot.child.send?.({ type: 'abort', runId: slot.currentRun.runId });
      }
    }

    for (const slot of [...this.jsonSlots, ...this.runtimeSlots]) {
      if (slot.child && !slot.child.killed) {
        slot.child.kill();
      }
      slot.child = null;
      slot.ready = false;
      slot.currentRun = null as any;
      slot.readyResolvers = [];
    }

    this.jsonSessionAffinity.clear();
    this.runtimeSessionAffinity.clear();
    this.resolvePoolWaiters(this.jsonAvailabilityWaiters);
    this.resolvePoolWaiters(this.runtimeAvailabilityWaiters);
  }
}

let headlessWorkerProcessManager: HeadlessWorkerProcessManager | null = null;

export function getHeadlessWorkerProcessManager(): HeadlessWorkerProcessManager {
  if (!headlessWorkerProcessManager) {
    headlessWorkerProcessManager = new HeadlessWorkerProcessManager();
  }
  return headlessWorkerProcessManager;
}
