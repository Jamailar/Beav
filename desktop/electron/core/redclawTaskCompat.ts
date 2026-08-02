import { randomUUID } from 'node:crypto';
import { getRedClawBackgroundRunner } from './redclawBackgroundRunner';

type TaskIntent = Record<string, unknown>;

type DraftRecord = {
  draftId: string;
  intent: TaskIntent;
  createdAt: string;
};

const previews = new Map<string, { intent: TaskIntent; createdAt: number }>();
const drafts = new Map<string, DraftRecord>();
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function text(value: unknown): string {
  return String(value || '').trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function numberValue(value: unknown, fallback?: number): number | undefined {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeIntent(payload: Record<string, unknown>): TaskIntent {
  const raw = payload.intent && typeof payload.intent === 'object' && !Array.isArray(payload.intent)
    ? payload.intent as TaskIntent
    : payload;
  const intent = { ...raw };
  if (!text(intent.prompt)) intent.prompt = text(intent.message) || text(intent.description) || text(intent.goal);
  if (!text(intent.goal)) intent.goal = text(intent.description) || text(intent.prompt);
  if (!text(intent.actionType)) intent.actionType = text(intent.type) || (text(intent.objective) ? 'long_cycle' : 'redclaw_prompt');
  if (!text(intent.kind)) intent.kind = text(intent.objective) || text(intent.stepPrompt) ? 'long_cycle' : 'scheduled';
  if (!text(intent.name)) intent.name = intent.kind === 'long_cycle' ? '长周期任务' : '定时任务';
  if (!text(intent.ownerScope)) intent.ownerScope = 'manual:redclaw';
  return intent;
}

function parseCron(cron: string): { mode: 'interval' | 'daily' | 'weekly'; time?: string; weekdays?: number[] } {
  const normalized = text(cron);
  if (normalized === '0 * * * *') return { mode: 'interval', time: undefined };
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return { mode: 'daily', time: '09:00' };
  const minute = Math.max(0, Math.min(59, Number(fields[0]) || 0));
  const hour = Math.max(0, Math.min(23, Number(fields[1]) || 0));
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const day = fields[4];
  if (day && day !== '*') {
    const weekdays = day.split(',').map((item) => Number(item)).filter((item) => Number.isFinite(item));
    return { mode: 'weekly', time, weekdays };
  }
  return { mode: 'daily', time };
}

function taskListItem(task: Record<string, unknown>, kind: 'scheduled' | 'long_cycle'): Record<string, unknown> {
  const isLongCycle = kind === 'long_cycle';
  const lastResult = text(task.lastResult);
  const lastError = text(task.lastError);
  const status = lastResult === 'success' ? 'succeeded' : lastResult === 'error' ? 'failed' : undefined;
  return {
    definitionId: task.id,
    title: task.name,
    kind,
    sourceKind: kind,
    sourceTaskId: task.id,
    enabled: Boolean(task.enabled),
    ownerScope: 'manual:redclaw',
    createdBy: 'electron-archive',
    creatorMode: 'local',
    requiresConfirmation: false,
    policyDecision: 'allow',
    triggerKind: isLongCycle ? 'interval' : task.mode,
    progressionKind: isLongCycle ? 'multi_round' : 'single_run',
    nextDueAt: task.nextRunAt || null,
    timezone: 'local',
    missedRunPolicy: 'single',
    actionType: isLongCycle ? 'long_cycle' : 'redclaw_prompt',
    goal: isLongCycle ? task.objective : task.prompt,
    prompt: isLongCycle ? task.stepPrompt : task.prompt,
    objective: isLongCycle ? task.objective : null,
    stepPrompt: isLongCycle ? task.stepPrompt : null,
    intervalMinutes: task.intervalMinutes || null,
    time: task.time || null,
    weekdays: task.weekdays || null,
    runAt: task.runAt || null,
    totalRounds: isLongCycle ? task.totalRounds : null,
    completedRounds: isLongCycle ? task.completedRounds : null,
    latestExecution: status ? {
      executionId: `${task.id}:latest`,
      runId: null,
      status,
      scheduledForAt: task.lastRunAt || null,
      attemptNo: 1,
      retryBucket: null,
      lastError: lastError || null,
      updatedAt: task.updatedAt,
    } : null,
    lastUpdatedReason: lastError || null,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
  };
}

async function findTask(taskId: string): Promise<{ kind: 'scheduled' | 'long_cycle'; task: Record<string, unknown> } | null> {
  const runner = getRedClawBackgroundRunner();
  const scheduled = runner.listScheduledTasks().find((item) => item.id === taskId);
  if (scheduled) return { kind: 'scheduled', task: scheduled as unknown as Record<string, unknown> };
  const longCycle = runner.listLongCycleTasks().find((item) => item.id === taskId);
  if (longCycle) return { kind: 'long_cycle', task: longCycle as unknown as Record<string, unknown> };
  return null;
}

export async function listRedClawTasks(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const runner = getRedClawBackgroundRunner();
  const ownerScope = text(payload.ownerScope);
  const includeDrafts = payload.includeDrafts !== false;
  const items = [
    ...runner.listScheduledTasks().map((task) => taskListItem(task as unknown as Record<string, unknown>, 'scheduled')),
    ...runner.listLongCycleTasks().map((task) => taskListItem(task as unknown as Record<string, unknown>, 'long_cycle')),
  ].filter((item) => !ownerScope || item.ownerScope === ownerScope);
  if (includeDrafts) {
    for (const draft of drafts.values()) {
      items.push({
        ...taskListItem({
          id: draft.draftId,
          name: draft.intent.name,
          enabled: false,
          mode: draft.intent.mode || 'daily',
          prompt: draft.intent.prompt || draft.intent.goal,
          objective: draft.intent.objective,
          stepPrompt: draft.intent.stepPrompt,
          createdAt: draft.createdAt,
          updatedAt: draft.createdAt,
          nextRunAt: null,
        }, text(draft.intent.kind) === 'long_cycle' ? 'long_cycle' : 'scheduled'),
        definitionId: draft.draftId,
        draftId: draft.draftId,
        sourceTaskId: null,
        requiresConfirmation: true,
        policyDecision: 'require_confirm',
      });
    }
  }
  items.sort((left, right) => String(left.nextDueAt || '').localeCompare(String(right.nextDueAt || '')) || String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return { success: true, items, count: items.length };
}

export async function previewRedClawTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const intent = normalizeIntent(payload);
  const previewToken = id('task-preview');
  previews.set(previewToken, { intent, createdAt: Date.now() });
  for (const [token, preview] of previews) {
    if (Date.now() - preview.createdAt > PREVIEW_TTL_MS) previews.delete(token);
  }
  return {
    success: true,
    decision: 'allow',
    previewToken,
    previewRunAt: nowIso(),
    policyDecision: 'allow',
    policyWarnings: [],
    rejectionReasons: [],
    conflictTasks: [],
    requiresConfirmation: true,
    definitionFingerprint: `${text(intent.kind)}:${text(intent.name)}:${text(intent.prompt)}:${text(intent.cron)}`,
    policySignature: 'electron-archive-local-v1',
    normalized: intent,
  };
}

export async function createRedClawTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const previewToken = text(payload.previewToken);
  const preview = previews.get(previewToken);
  if (!preview || Date.now() - preview.createdAt > PREVIEW_TTL_MS) {
    return { success: false, error: 'previewToken 已过期或不存在' };
  }
  const draftId = id('redclaw-draft');
  drafts.set(draftId, { draftId, intent: preview.intent, createdAt: nowIso() });
  previews.delete(previewToken);
  return { success: true, draftId, definition: { id: draftId, requiresConfirmation: true, ...preview.intent }, created: true };
}

export async function confirmRedClawTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const draftId = text(payload.draftId);
  const draft = drafts.get(draftId);
  if (!draft) return { success: false, error: '任务草稿不存在' };
  drafts.delete(draftId);
  if (payload.confirm !== true) return { success: true, result: { confirmed: false, cancelled: true, draftId } };
  const intent = draft.intent;
  const runner = getRedClawBackgroundRunner();
  if (text(intent.kind) === 'long_cycle') {
    const task = await runner.addLongCycleTask({
      name: text(intent.name) || '长周期任务',
      objective: text(intent.objective) || text(intent.goal),
      stepPrompt: text(intent.stepPrompt) || text(intent.prompt),
      projectId: text(intent.projectId) || undefined,
      intervalMinutes: numberValue(intent.intervalMinutes, 30),
      totalRounds: numberValue(intent.totalRounds, 8),
      enabled: intent.enabled !== false,
    });
    return { success: true, result: { confirmed: true, draftId, jobDefinitionId: task.id, definition: task } };
  }
  const schedule = text(intent.cron) ? parseCron(text(intent.cron)) : {
    mode: (text(intent.mode) || 'daily') as 'interval' | 'daily' | 'weekly' | 'once',
    time: text(intent.time) || undefined,
    weekdays: Array.isArray(intent.weekdays) ? intent.weekdays.map(Number) : undefined,
  };
  const task = await runner.addScheduledTask({
    name: text(intent.name) || '定时任务',
    mode: schedule.mode,
    prompt: text(intent.prompt) || text(intent.goal),
    projectId: text(intent.projectId) || undefined,
    intervalMinutes: numberValue(intent.intervalMinutes, schedule.mode === 'interval' ? 60 : undefined),
    time: schedule.time,
    weekdays: schedule.weekdays,
    runAt: text(intent.runAt) || undefined,
    enabled: intent.enabled !== false,
  });
  return { success: true, result: { confirmed: true, draftId, jobDefinitionId: task.id, definition: task } };
}

export async function updateRedClawTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const taskId = text(payload.jobDefinitionId) || text(payload.taskId);
  const found = await findTask(taskId);
  if (!found) return { success: false, error: '任务定义不存在' };
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch as TaskIntent : {};
  const runner = getRedClawBackgroundRunner();
  if (found.kind === 'long_cycle') {
    const task = await runner.updateLongCycleTask(taskId, {
      name: patch.name as string | undefined,
      objective: (patch.objective || patch.goal) as string | undefined,
      stepPrompt: (patch.stepPrompt || patch.prompt) as string | undefined,
      projectId: patch.projectId as string | null | undefined,
      intervalMinutes: numberValue(patch.intervalMinutes),
      totalRounds: numberValue(patch.totalRounds),
    });
    return { success: true, result: { jobDefinitionId: taskId, definition: task } };
  }
  const cron = text(patch.cron);
  const schedule = cron ? parseCron(cron) : null;
  const task = await runner.updateScheduledTask(taskId, {
    name: patch.name as string | undefined,
    prompt: (patch.prompt || patch.goal) as string | undefined,
    mode: schedule?.mode,
    time: schedule?.time,
    weekdays: schedule?.weekdays,
    intervalMinutes: numberValue(patch.intervalMinutes),
    runAt: text(patch.runAt) || undefined,
  });
  return { success: true, result: { jobDefinitionId: taskId, definition: task } };
}

export async function cancelRedClawTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const taskId = text(payload.jobDefinitionId) || text(payload.draftId) || text(payload.taskId);
  if (drafts.delete(taskId)) return { success: true, result: { cancelled: true, draft: true, jobDefinitionId: taskId } };
  const found = await findTask(taskId);
  if (!found) return { success: false, error: '任务定义不存在' };
  const runner = getRedClawBackgroundRunner();
  if (found.kind === 'long_cycle') {
    if (payload.deleteSource === true) await runner.removeLongCycleTask(taskId);
    else await runner.setLongCycleTaskEnabled(taskId, false);
  } else if (payload.deleteSource === true) {
    await runner.removeScheduledTask(taskId);
  } else {
    await runner.setScheduledTaskEnabled(taskId, false);
  }
  return { success: true, result: { cancelled: true, deleted: payload.deleteSource === true, jobDefinitionId: taskId } };
}

export async function redClawTaskStats(): Promise<Record<string, unknown>> {
  const result = await listRedClawTasks({ includeDrafts: true });
  const items = result.items as Array<Record<string, unknown>>;
  return {
    success: true,
    definitions: {
      total: items.length,
      drafts: items.filter((item) => item.requiresConfirmation === true).length,
      active: items.filter((item) => item.requiresConfirmation !== true && item.enabled === true).length,
    },
    executions: {
      total: items.filter((item) => item.latestExecution).length,
      running: 0,
      failed: items.filter((item) => (item.latestExecution as Record<string, unknown> | null)?.status === 'failed').length,
      recent: items.map((item) => item.latestExecution).filter(Boolean),
    },
  };
}
