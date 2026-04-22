import path from 'node:path';
import { getChatMessages, getChatSessions, getSettings, getWorkspacePaths, type ChatMessage, type ChatSession } from '../db';
import { resolveScopedModelName } from './modelScopeSettings';
import { loadAndRenderPrompt } from '../prompts/runtime';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import { getTaskGraphRuntime } from './ai/taskGraphRuntime';
import type { IntentRoute } from './ai/types';
import {
  addMemoryMutationListener,
  addUserMemoryToFile,
  archiveUserMemoryInFile,
  deleteUserMemoryFromFile,
  listArchivedMemoriesFromFile,
  listMemoryHistoryFromFile,
  listUserMemoriesFromFile,
  updateUserMemoryInFile,
  type FileUserMemory,
  type MemoryHistoryEntry,
  type MemoryMutationEvent,
  type MemoryType,
} from './fileMemoryStore';
import {
  releaseBackgroundRuntimeLock,
  tryAcquireBackgroundRuntimeLock,
} from './backgroundRuntimeLock';
import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';
import { getHeadlessAgentRunner } from './headlessAgentRunner';
import { getHeadlessTaskSupervisor } from './headlessTaskSupervisor';
import { getHeadlessWorkerProcessManager } from './headlessWorkerProcessManager';
import { getBackgroundSessionStore } from './backgroundSessionStore';

const MAINTENANCE_PROMPT_PATH = 'runtime/memory/maintenance_manager.txt';
const DEFAULT_MODEL_FALLBACK = 'gpt-4o-mini';
const DEBOUNCE_MS = 90 * 1000;
const FAST_DEBOUNCE_MS = 15 * 1000;
const PERIODIC_MS = 30 * 60 * 1000;
const MIN_PENDING_MUTATIONS = 5;
const MAX_ACTIVE_PROMPT_ITEMS = 80;
const MAX_ARCHIVED_PROMPT_ITEMS = 40;
const MAX_HISTORY_PROMPT_ITEMS = 120;
const MAX_ACTIONS = 12;
const MAX_RECENT_SESSION_ITEMS = 5;
const MAX_RECENT_MESSAGES_PER_SESSION = 12;
const MAX_MESSAGE_CONTENT_CHARS = 280;
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const MIN_RUN_INTERVAL_MS = 20 * 60 * 1000;
const QUERY_AFTER_MIN_RUN_INTERVAL_MS = 5 * 60 * 1000;

function buildMaintenanceRoute(reason: MaintenanceTriggerReason, pendingMutations: number): IntentRoute {
  return {
    intent: 'memory_maintenance',
    goal: `维护长期记忆（reason=${reason}; pending=${pendingMutations}）`,
    requiredCapabilities: ['memory-read', 'memory-write', 'profile-doc'],
    recommendedRole: 'ops-coordinator',
    requiresLongRunningTask: false,
    requiresMultiAgent: false,
    requiresHumanApproval: false,
    confidence: 0.92,
    reasoning: `memory-maintenance:${reason}`,
  };
}

type MaintenanceTriggerReason = 'init' | 'mutation' | 'periodic' | 'workspace-change' | 'manual' | 'query-after';

type SessionLifecycleSignal = {
  sessionId: string;
  runtimeMode?: string;
  responseLength?: number;
  compacted?: boolean;
  updatedAt: number;
};

type MaintenanceAction = {
  type: 'create' | 'update' | 'archive' | 'delete' | 'noop';
  targetMemoryId?: string;
  content?: string;
  memoryType?: MemoryType;
  tags?: string[];
  reason?: string;
};

type MaintenanceResponse = {
  summary?: string;
  actions?: MaintenanceAction[];
};

export interface MemoryMaintenanceStatus {
  started: boolean;
  running: boolean;
  lockState: 'owner' | 'passive';
  blockedBy: string | null;
  pendingMutations: number;
  lastRunAt: string | null;
  lastScanAt: string | null;
  lastReason: MaintenanceTriggerReason | null;
  lastSummary: string;
  lastError: string | null;
  nextScheduledAt: string | null;
}

type RecentConversationSummary = {
  sessionId: string;
  title: string;
  updatedAt: number;
  contextType: string;
  messageCount: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
};

function truncateText(value: string, maxChars: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function parseSessionMetadata(session: ChatSession): Record<string, unknown> {
  if (!session.metadata) return {};
  try {
    return JSON.parse(session.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isUserOrAssistantMessage(message: ChatMessage): message is ChatMessage & { role: 'user' | 'assistant' } {
  return message.role === 'user' || message.role === 'assistant';
}

function buildRecentConversationSummaries(prioritizedSessionIds: string[] = []): RecentConversationSummary[] {
  const sessions = getChatSessions();
  const preferred = sessions.filter((session) => {
    const metadata = parseSessionMetadata(session);
    return String(metadata.contextType || '').trim().toLowerCase() === 'redclaw';
  });
  const baseSessions = preferred.length > 0 ? preferred : sessions;
  const prioritizedSet = new Set(prioritizedSessionIds.filter(Boolean));
  const prioritizedSessions = baseSessions.filter((session) => prioritizedSet.has(session.id));
  const remainingSessions = baseSessions.filter((session) => !prioritizedSet.has(session.id));
  const candidateSessions = [...prioritizedSessions, ...remainingSessions].slice(0, MAX_RECENT_SESSION_ITEMS);

  return candidateSessions.map((session) => {
    const metadata = parseSessionMetadata(session);
    const messages = getChatMessages(session.id)
      .filter(isUserOrAssistantMessage)
      .slice(-MAX_RECENT_MESSAGES_PER_SESSION)
      .map((message) => ({
        role: message.role,
        content: truncateText(message.content, MAX_MESSAGE_CONTENT_CHARS),
        timestamp: message.timestamp,
      }));

    return {
      sessionId: session.id,
      title: String(session.title || 'Untitled'),
      updatedAt: Number(session.updated_at || session.created_at || Date.now()),
      contextType: String(metadata.contextType || 'unknown'),
      messageCount: messages.length,
      messages,
    };
  }).filter((item) => item.messageCount > 0);
}

function parseJsonResponse(raw: string): MaintenanceResponse {
  const text = String(raw || '').trim();
  if (!text) {
    return { summary: 'empty-response', actions: [{ type: 'noop', reason: 'empty-response' }] };
  }
  const parsed = JSON.parse(text) as MaintenanceResponse;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid memory maintenance response payload');
  }
  return parsed;
}

function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 12);
}

function sanitizeAction(raw: unknown): MaintenanceAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = String(record.type || '').trim() as MaintenanceAction['type'];
  if (!['create', 'update', 'archive', 'delete', 'noop'].includes(type)) {
    return null;
  }
  const next: MaintenanceAction = {
    type,
    targetMemoryId: typeof record.targetMemoryId === 'string' ? record.targetMemoryId.trim() : undefined,
    content: typeof record.content === 'string' ? record.content.trim() : undefined,
    memoryType: record.memoryType === 'preference' || record.memoryType === 'fact' ? record.memoryType : 'general',
    tags: sanitizeTags(record.tags),
    reason: typeof record.reason === 'string' ? record.reason.trim() : undefined,
  };
  if ((type === 'update' || type === 'archive' || type === 'delete') && !next.targetMemoryId) {
    return null;
  }
  if ((type === 'create' || type === 'update') && !next.content) {
    return null;
  }
  return next;
}

function buildPromptPayload(params: {
  reason: MaintenanceTriggerReason;
  pendingMutations: number;
  active: FileUserMemory[];
  archived: FileUserMemory[];
  history: MemoryHistoryEntry[];
  recentConversations: RecentConversationSummary[];
}): string {
  return loadAndRenderPrompt(MAINTENANCE_PROMPT_PATH, {
    trigger_reason: params.reason,
    current_date: new Date().toISOString(),
    pending_mutation_count: params.pendingMutations,
    active_memory_count: params.active.length,
    archived_memory_count: params.archived.length,
    history_count: params.history.length,
    recent_conversations_count: params.recentConversations.length,
    active_memories_json: JSON.stringify(params.active.slice(0, MAX_ACTIVE_PROMPT_ITEMS), null, 2),
    archived_memories_json: JSON.stringify(params.archived.slice(0, MAX_ARCHIVED_PROMPT_ITEMS), null, 2),
    history_json: JSON.stringify(params.history.slice(0, MAX_HISTORY_PROMPT_ITEMS), null, 2),
    recent_conversations_json: JSON.stringify(params.recentConversations, null, 2),
  }, 'You are a memory maintenance manager. Output strict JSON only.');
}

export class MemoryMaintenanceService {
  private started = false;
  private running = false;
  private lockState: 'owner' | 'passive' = 'passive';
  private blockedBy: string | null = null;
  private pendingMutations = 0;
  private lastRunAt: string | null = null;
  private lastScanAt: string | null = null;
  private lastReason: MaintenanceTriggerReason | null = null;
  private lastSummary = '';
  private lastError: string | null = null;
  private nextScheduledAt: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private unsubscribeMutationListener: (() => void) | null = null;
  private readonly lockOwnerId = `memory-maintenance:${process.pid}:${Date.now().toString(36)}`;
  private readonly recentSessionSignals = new Map<string, SessionLifecycleSignal>();

  private getLockPath(): string {
    return path.join(getWorkspacePaths().redclaw, 'memory-maintenance.lock');
  }

  private async acquireRunLock(): Promise<boolean> {
    const result = await tryAcquireBackgroundRuntimeLock(this.getLockPath(), this.lockOwnerId);
    if (result.acquired) {
      this.lockState = 'owner';
      this.blockedBy = null;
      return true;
    }
    this.lockState = 'passive';
    this.blockedBy = result.blockedBy || null;
    return false;
  }

  private async releaseRunLock(): Promise<void> {
    await releaseBackgroundRuntimeLock(this.getLockPath(), this.lockOwnerId);
    this.lockState = 'passive';
    this.blockedBy = null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeMutationListener = addMemoryMutationListener((event) => {
      this.handleMutation(event);
    });
    this.periodicTimer = setInterval(() => {
      void this.runIfNeeded('periodic');
    }, PERIODIC_MS);
    this.scheduleDebouncedRun('init', 2 * 60 * 1000);
    console.log('[MemoryMaintenance] started');
  }

  stop(): void {
    this.started = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    this.nextScheduledAt = null;
    void this.releaseRunLock();
    this.unsubscribeMutationListener?.();
    this.unsubscribeMutationListener = null;
  }

  async reloadForWorkspaceChange(): Promise<void> {
    this.pendingMutations = 0;
    this.lastScanAt = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.releaseRunLock();
    this.scheduleDebouncedRun('workspace-change', 30 * 1000);
  }

  getStatus(): MemoryMaintenanceStatus {
    return {
      started: this.started,
      running: this.running,
      lockState: this.lockState,
      blockedBy: this.blockedBy,
      pendingMutations: this.pendingMutations,
      lastRunAt: this.lastRunAt,
      lastScanAt: this.lastScanAt,
      lastReason: this.lastReason,
      lastSummary: this.lastSummary,
      lastError: this.lastError,
      nextScheduledAt: this.nextScheduledAt,
    };
  }

  async runNow(): Promise<MemoryMaintenanceStatus> {
    if (!this.started) {
      this.start();
    }
    await this.runIfNeeded('manual', true);
    return this.getStatus();
  }

  notifyQueryLifecycleEvent(params: {
    sessionId: string;
    runtimeMode?: string;
    responseLength?: number;
    compacted?: boolean;
  }): void {
    if (!params.sessionId) return;
    if (!this.started) {
      this.start();
    }
    this.recentSessionSignals.set(params.sessionId, {
      sessionId: params.sessionId,
      runtimeMode: params.runtimeMode,
      responseLength: params.responseLength,
      compacted: params.compacted,
      updatedAt: Date.now(),
    });
    const delay = params.compacted || Number(params.responseLength || 0) > 1200 ? FAST_DEBOUNCE_MS : DEBOUNCE_MS;
    this.scheduleDebouncedRun('query-after', delay);
  }

  private handleMutation(event: MemoryMutationEvent): void {
    if (event.source === 'maintenance') {
      return;
    }
    this.pendingMutations += 1;
    const delay = this.pendingMutations >= MIN_PENDING_MUTATIONS ? FAST_DEBOUNCE_MS : DEBOUNCE_MS;
    this.scheduleDebouncedRun('mutation', delay);
  }

  private scheduleDebouncedRun(reason: MaintenanceTriggerReason, delayMs: number): void {
    if (!this.started) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.nextScheduledAt = new Date(Date.now() + delayMs).toISOString();
    this.debounceTimer = setTimeout(() => {
      void this.runIfNeeded(reason);
    }, delayMs);
  }

  private async runIfNeeded(reason: MaintenanceTriggerReason, force = false): Promise<void> {
    if ((!this.started && !force) || this.running) return;
    this.lastReason = reason;
    this.lastError = null;
    this.nextScheduledAt = null;

    const nowMs = Date.now();
    const lastRunMs = this.lastRunAt ? new Date(this.lastRunAt).getTime() : 0;
    const requiredRunInterval = reason === 'query-after' ? QUERY_AFTER_MIN_RUN_INTERVAL_MS : MIN_RUN_INTERVAL_MS;
    if (!force && lastRunMs > 0 && nowMs - lastRunMs < requiredRunInterval) {
      return;
    }

    const lastScanMs = this.lastScanAt ? new Date(this.lastScanAt).getTime() : 0;
    if (!force && lastScanMs > 0 && nowMs - lastScanMs < SESSION_SCAN_INTERVAL_MS) {
      return;
    }
    this.lastScanAt = new Date(nowMs).toISOString();

    const prioritizedSessionIds = [...this.recentSessionSignals.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_SESSION_ITEMS)
      .map((item) => item.sessionId);

    const active = await listUserMemoriesFromFile();
    const archived = await listArchivedMemoriesFromFile();
    const history = await listMemoryHistoryFromFile();
    const recentConversations = buildRecentConversationSummaries(prioritizedSessionIds);

    const shouldRun = force
      || this.pendingMutations > 0
      || (reason === 'query-after' && prioritizedSessionIds.length > 0)
      || (reason === 'periodic' && active.length >= 20)
      || (reason === 'init' && (active.length >= 10 || history.length >= 20))
      || (recentConversations.length >= 4 && history.length >= 12);

    if (!shouldRun) {
      return;
    }

    const acquired = await this.acquireRunLock();
    if (!acquired) {
      return;
    }

    this.running = true;
    let taskId: string | null = null;

    try {

      const runtime = getTaskGraphRuntime();
      const task = runtime.createInteractiveTask({
        runtimeMode: 'background-maintenance',
        ownerSessionId: 'memory-maintenance',
        userInput: `memory-maintenance:${reason}`,
        route: buildMaintenanceRoute(reason, this.pendingMutations),
        roleId: 'ops-coordinator',
        metadata: {
          source: 'memory-maintenance',
          pendingMutations: this.pendingMutations,
          activeCount: active.length,
          archivedCount: archived.length,
          historyCount: history.length,
        },
      });
      taskId = task.id;
      runtime.startNode(taskId, 'route', `reason=${reason}`);
      runtime.completeNode(taskId, 'route', `reason=${reason}`);
      runtime.startNode(taskId, 'plan', `pendingMutations=${this.pendingMutations}`);
      runtime.completeNode(taskId, 'plan', `active=${active.length}; archived=${archived.length}; history=${history.length}`);
      runtime.startNode(taskId, 'execute_tools', '开始执行记忆整理');
      runtime.addTrace(taskId, 'memory.plan_input', {
        reason,
        pendingMutations: this.pendingMutations,
        activeCount: active.length,
        archivedCount: archived.length,
        historyCount: history.length,
        recentConversationCount: recentConversations.length,
      }, 'execute_tools');

      const settings = (getSettings() || {}) as Record<string, unknown>;
      const apiKey = String(settings.api_key || '').trim();
      const baseURL = normalizeApiBaseUrl(String(settings.api_endpoint || ''), 'https://api.openai.com/v1');
      const model = resolveScopedModelName(settings, 'redclaw', DEFAULT_MODEL_FALLBACK);

      if (!apiKey || !baseURL || !model) {
        this.lastError = 'missing-model-config';
        console.warn('[MemoryMaintenance] skipped: model config missing', { hasApiKey: Boolean(apiKey), baseURL, model });
        if (taskId) {
          runtime.failTask(taskId, this.lastError, 'execute_tools');
        }
        return;
      }

      const prompt = buildPromptPayload({
        reason,
        pendingMutations: this.pendingMutations,
        active,
        archived,
        history,
        recentConversations,
      });

      const backgroundTask = await getBackgroundTaskRegistry().registerTask({
        kind: 'memory-maintenance',
        title: `记忆维护 · ${reason}`,
        contextId: `memory-maintenance:${reason}`,
      });
      const backgroundSession = getBackgroundSessionStore().ensureSession({
        contextId: `memory-maintenance:${reason}`,
        contextType: 'background-maintenance',
        title: `记忆维护 · ${reason}`,
        runtimeMode: 'background-maintenance',
        metadata: {
          maintenanceReason: reason,
        },
      });
      await getBackgroundTaskRegistry().attachSession(backgroundTask.id, backgroundSession.id);
      const planResult = await getHeadlessTaskSupervisor().run({
        taskId: backgroundTask.id,
        title: `Memory Maintenance ${reason}`,
        backoff: {
          initialDelayMs: 1000,
          maxDelayMs: 20000,
          maxAttempts: 2,
          giveUpAfterMs: 5 * 60 * 1000,
          timeoutMs: 75 * 1000,
        },
        execute: (signal) => getHeadlessWorkerProcessManager().runJsonTask({
          taskId: backgroundTask.id,
          sessionId: backgroundSession.id,
          model,
          apiKey,
          baseURL,
          systemPrompt: prompt,
          userInput: 'Return the memory maintenance actions now as strict JSON.',
          temperature: 0.1,
          rollback: () => this.releaseRunLock(),
          attemptSignal: signal,
        }),
      });
      const plan = parseJsonResponse(planResult.response);
      if (taskId) {
        runtime.addTrace(taskId, 'memory.plan_received', {
          summary: plan.summary || '',
          actionsCount: Array.isArray(plan.actions) ? plan.actions.length : 0,
        }, 'execute_tools');
      }

      const actions = Array.isArray(plan.actions)
        ? plan.actions.map(sanitizeAction).filter((item): item is MaintenanceAction => Boolean(item)).slice(0, MAX_ACTIONS)
        : [];

      console.log('[MemoryMaintenance] actions', {
        summary: plan.summary || '',
        count: actions.length,
        actions,
      });

      await getBackgroundTaskRegistry().updatePhase(backgroundTask.id, 'updating');
      for (const action of actions) {
        await this.applyAction(action);
        if (taskId) {
          runtime.addTrace(taskId, 'memory.action_applied', action, 'execute_tools');
        }
      }

      this.lastSummary = String(plan.summary || '').trim() || `actions=${actions.length}`;
      this.pendingMutations = 0;
      this.lastRunAt = new Date().toISOString();
      for (const sessionId of prioritizedSessionIds) {
        this.recentSessionSignals.delete(sessionId);
      }
      await getBackgroundTaskRegistry().completeTask(backgroundTask.id, this.lastSummary);
      if (taskId) {
        runtime.completeNode(taskId, 'execute_tools', this.lastSummary);
        runtime.completeTask(taskId, this.lastSummary);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      console.error('[MemoryMaintenance] run failed:', error);
      if (taskId) {
        getTaskGraphRuntime().failTask(taskId, message, 'execute_tools');
      }
    } finally {
      this.running = false;
      await this.releaseRunLock();
    }
  }

  private async applyAction(action: MaintenanceAction): Promise<void> {
    const reason = action.reason || `maintenance-${action.type}`;
    switch (action.type) {
      case 'create':
        await addUserMemoryToFile(
          String(action.content || '').trim(),
          action.memoryType || 'general',
          action.tags || [],
          { source: 'maintenance', reason }
        );
        return;
      case 'update':
        if (!action.targetMemoryId) return;
        await updateUserMemoryInFile(
          action.targetMemoryId,
          {
            content: String(action.content || '').trim(),
            type: action.memoryType || 'general',
            tags: action.tags || [],
          },
          { source: 'maintenance', reason }
        );
        return;
      case 'archive':
        if (!action.targetMemoryId) return;
        await archiveUserMemoryInFile(action.targetMemoryId, reason, { source: 'maintenance' });
        return;
      case 'delete':
        if (!action.targetMemoryId) return;
        await deleteUserMemoryFromFile(action.targetMemoryId, { source: 'maintenance', reason });
        return;
      case 'noop':
      default:
        return;
    }
  }
}

let globalMemoryMaintenanceService: MemoryMaintenanceService | null = null;

export function getMemoryMaintenanceService(): MemoryMaintenanceService {
  if (!globalMemoryMaintenanceService) {
    globalMemoryMaintenanceService = new MemoryMaintenanceService();
  }
  return globalMemoryMaintenanceService;
}
