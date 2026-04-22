import { EventEmitter } from 'events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspacePaths } from '../db';

export type WorkItemType =
  | 'generic'
  | 'redclaw-note'
  | 'redclaw-project'
  | 'research'
  | 'review'
  | 'automation'
  | 'background-run'
  | 'external-message';

export type WorkItemStatus = 'pending' | 'active' | 'waiting' | 'done' | 'cancelled';
export type WorkItemEffectiveStatus = WorkItemStatus | 'ready' | 'blocked';

export interface WorkItemRefs {
  projectIds: string[];
  sessionIds: string[];
  taskIds: string[];
  backgroundTaskIds: string[];
  filePaths: string[];
}

export interface WorkItemRecord {
  id: string;
  title: string;
  description?: string;
  type: WorkItemType;
  status: WorkItemStatus;
  priority: number;
  tags: string[];
  dependsOn: string[];
  parentId?: string;
  summary?: string;
  refs: WorkItemRefs;
  metadata?: Record<string, unknown>;
  schedule?: {
    mode: 'none' | 'once' | 'interval' | 'daily' | 'weekly' | 'long-cycle';
    enabled: boolean;
    intervalMinutes?: number;
    time?: string;
    weekdays?: number[];
    runAt?: string;
    totalRounds?: number;
    completedRounds?: number;
    nextRunAt?: string;
    lastRunAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkItemSnapshot extends WorkItemRecord {
  effectiveStatus: WorkItemEffectiveStatus;
  blockedBy: string[];
  ready: boolean;
}

interface ListWorkItemsOptions {
  status?: WorkItemEffectiveStatus | WorkItemStatus;
  type?: WorkItemType;
  limit?: number;
  tag?: string;
}

interface CreateWorkItemInput {
  title: string;
  description?: string;
  type?: WorkItemType;
  status?: WorkItemStatus;
  priority?: number;
  tags?: string[];
  dependsOn?: string[];
  parentId?: string;
  summary?: string;
  refs?: Partial<WorkItemRefs>;
  metadata?: Record<string, unknown>;
  schedule?: WorkItemRecord['schedule'];
}

interface UpdateWorkItemInput {
  title?: string;
  description?: string;
  type?: WorkItemType;
  status?: WorkItemStatus;
  priority?: number;
  tags?: string[];
  parentId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  schedule?: WorkItemRecord['schedule'];
}

const nowIso = (): string => new Date().toISOString();

const DEFAULT_REFS = (): WorkItemRefs => ({
  projectIds: [],
  sessionIds: [],
  taskIds: [],
  backgroundTaskIds: [],
  filePaths: [],
});

const normalizeStringList = (input: unknown): string[] => Array.from(new Set(
  (Array.isArray(input) ? input : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean),
));

const clampPriority = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(3, Math.max(0, Math.floor(parsed)));
};

const buildId = (): string => `wk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export class WorkItemStore extends EventEmitter {
  private getRootDir(): string {
    return path.join(getWorkspacePaths().redclaw, 'work-items');
  }

  private resolveFilePath(id: string): string {
    return path.join(this.getRootDir(), `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.getRootDir(), { recursive: true });
  }

  private normalizeRefs(input?: Partial<WorkItemRefs>): WorkItemRefs {
    return {
      projectIds: normalizeStringList(input?.projectIds),
      sessionIds: normalizeStringList(input?.sessionIds),
      taskIds: normalizeStringList(input?.taskIds),
      backgroundTaskIds: normalizeStringList(input?.backgroundTaskIds),
      filePaths: normalizeStringList(input?.filePaths),
    };
  }

  private normalizeRecord(raw: Partial<WorkItemRecord>): WorkItemRecord {
    const status = (['pending', 'active', 'waiting', 'done', 'cancelled'] as const).includes(raw.status as WorkItemStatus)
      ? raw.status as WorkItemStatus
      : 'pending';
    return {
      id: String(raw.id || '').trim() || buildId(),
      title: String(raw.title || '').trim() || '未命名工作项',
      description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
      type: ([
        'generic',
        'redclaw-note',
        'redclaw-project',
        'research',
        'review',
        'automation',
        'background-run',
        'external-message',
      ] as const).includes(raw.type as WorkItemType)
        ? raw.type as WorkItemType
        : 'generic',
      status,
      priority: clampPriority(raw.priority),
      tags: normalizeStringList(raw.tags),
      dependsOn: normalizeStringList(raw.dependsOn),
      parentId: typeof raw.parentId === 'string' && raw.parentId.trim() ? raw.parentId.trim() : undefined,
      summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : undefined,
      refs: this.normalizeRefs(raw.refs),
      metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined,
      schedule: raw.schedule && typeof raw.schedule === 'object'
        ? {
          mode: (['none', 'once', 'interval', 'daily', 'weekly', 'long-cycle'] as const).includes((raw.schedule as any).mode)
            ? (raw.schedule as any).mode
            : 'none',
          enabled: (raw.schedule as any).enabled !== false,
          intervalMinutes: Number.isFinite(Number((raw.schedule as any).intervalMinutes)) ? Math.max(1, Math.floor(Number((raw.schedule as any).intervalMinutes))) : undefined,
          time: typeof (raw.schedule as any).time === 'string' ? (raw.schedule as any).time : undefined,
          weekdays: normalizeStringList((raw.schedule as any).weekdays).map((item) => Number(item)).filter((item) => Number.isFinite(item)),
          runAt: typeof (raw.schedule as any).runAt === 'string' ? (raw.schedule as any).runAt : undefined,
          totalRounds: Number.isFinite(Number((raw.schedule as any).totalRounds)) ? Math.max(1, Math.floor(Number((raw.schedule as any).totalRounds))) : undefined,
          completedRounds: Number.isFinite(Number((raw.schedule as any).completedRounds)) ? Math.max(0, Math.floor(Number((raw.schedule as any).completedRounds))) : undefined,
          nextRunAt: typeof (raw.schedule as any).nextRunAt === 'string' ? (raw.schedule as any).nextRunAt : undefined,
          lastRunAt: typeof (raw.schedule as any).lastRunAt === 'string' ? (raw.schedule as any).lastRunAt : undefined,
        }
        : undefined,
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : nowIso(),
      completedAt: typeof raw.completedAt === 'string' && raw.completedAt ? raw.completedAt : undefined,
    };
  }

  private async writeRecord(record: WorkItemRecord): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.resolveFilePath(record.id), JSON.stringify(record, null, 2), 'utf-8');
  }

  private materializeSnapshot(record: WorkItemRecord, map: Map<string, WorkItemRecord>): WorkItemSnapshot {
    const blockedBy = record.dependsOn.filter((dependencyId) => {
      const dependency = map.get(dependencyId);
      if (!dependency) return true;
      return dependency.status !== 'done' && dependency.status !== 'cancelled';
    });

    let effectiveStatus: WorkItemEffectiveStatus = record.status;
    if (record.status === 'pending') {
      effectiveStatus = blockedBy.length > 0 ? 'blocked' : 'ready';
    }

    return {
      ...record,
      effectiveStatus,
      blockedBy,
      ready: effectiveStatus === 'ready',
    };
  }

  private async loadAllRecords(): Promise<Map<string, WorkItemRecord>> {
    await this.ensureDir();
    const entries = await fs.readdir(this.getRootDir(), { withFileTypes: true });
    const map = new Map<string, WorkItemRecord>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.getRootDir(), entry.name), 'utf-8');
        const parsed = JSON.parse(raw) as Partial<WorkItemRecord>;
        const record = this.normalizeRecord(parsed);
        map.set(record.id, record);
      } catch {
        // ignore malformed work item files
      }
    }
    return map;
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemSnapshot> {
    const id = buildId();
    const record = this.normalizeRecord({
      id,
      title: input.title,
      description: input.description,
      type: input.type || 'generic',
      status: input.status || 'pending',
      priority: input.priority,
      tags: input.tags || [],
      dependsOn: input.dependsOn || [],
      parentId: input.parentId,
      summary: input.summary,
      refs: {
        ...DEFAULT_REFS(),
        ...(input.refs || {}),
      },
      metadata: input.metadata,
      schedule: input.schedule,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: input.status === 'done' ? nowIso() : undefined,
    });
    await this.writeRecord(record);
    const snapshot = this.materializeSnapshot(record, new Map([[record.id, record]]));
    this.emit('work-item-updated', snapshot);
    return snapshot;
  }

  async getWorkItem(id: string): Promise<WorkItemSnapshot | null> {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) return null;
    const map = await this.loadAllRecords();
    const record = map.get(normalizedId);
    return record ? this.materializeSnapshot(record, map) : null;
  }

  async listWorkItems(options?: ListWorkItemsOptions): Promise<WorkItemSnapshot[]> {
    const map = await this.loadAllRecords();
    let items = Array.from(map.values()).map((record) => this.materializeSnapshot(record, map));
    if (options?.status) {
      items = items.filter((item) => item.effectiveStatus === options.status || item.status === options.status);
    }
    if (options?.type) {
      items = items.filter((item) => item.type === options.type);
    }
    if (options?.tag) {
      const tag = String(options.tag || '').trim();
      if (tag) items = items.filter((item) => item.tags.includes(tag));
    }
    items.sort((left, right) => {
      if (left.effectiveStatus === 'active' && right.effectiveStatus !== 'active') return -1;
      if (right.effectiveStatus === 'active' && left.effectiveStatus !== 'active') return 1;
      if (left.ready && !right.ready) return -1;
      if (right.ready && !left.ready) return 1;
      if (left.priority !== right.priority) return left.priority - right.priority;
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    });
    return items.slice(0, Math.max(1, options?.limit || items.length || 1));
  }

  async listReadyWorkItems(limit = 20): Promise<WorkItemSnapshot[]> {
    return this.listWorkItems({ status: 'ready', limit });
  }

  async updateWorkItem(id: string, input: UpdateWorkItemInput): Promise<WorkItemSnapshot> {
    const existing = await this.getWorkItem(id);
    if (!existing) {
      throw new Error(`Work item not found: ${id}`);
    }
    const nextStatus = input.status || existing.status;
    const record = this.normalizeRecord({
      ...existing,
      title: input.title !== undefined ? input.title : existing.title,
      description: input.description !== undefined ? input.description : existing.description,
      type: input.type || existing.type,
      status: nextStatus,
      priority: input.priority !== undefined ? input.priority : existing.priority,
      tags: input.tags !== undefined ? input.tags : existing.tags,
      parentId: input.parentId === null ? undefined : (input.parentId !== undefined ? input.parentId : existing.parentId),
      summary: input.summary === null ? undefined : (input.summary !== undefined ? input.summary : existing.summary),
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      schedule: input.schedule !== undefined ? input.schedule : existing.schedule,
      updatedAt: nowIso(),
      completedAt: nextStatus === 'done' ? (existing.completedAt || nowIso()) : undefined,
    });
    await this.writeRecord(record);
    const map = await this.loadAllRecords();
    const snapshot = this.materializeSnapshot(record, map);
    this.emit('work-item-updated', snapshot);
    return snapshot;
  }

  async attachRefs(id: string, refs: Partial<WorkItemRefs>): Promise<WorkItemSnapshot> {
    const existing = await this.getWorkItem(id);
    if (!existing) {
      throw new Error(`Work item not found: ${id}`);
    }
    const nextRefs = this.normalizeRefs({
      projectIds: [...existing.refs.projectIds, ...(refs.projectIds || [])],
      sessionIds: [...existing.refs.sessionIds, ...(refs.sessionIds || [])],
      taskIds: [...existing.refs.taskIds, ...(refs.taskIds || [])],
      backgroundTaskIds: [...existing.refs.backgroundTaskIds, ...(refs.backgroundTaskIds || [])],
      filePaths: [...existing.refs.filePaths, ...(refs.filePaths || [])],
    });
    const map = await this.loadAllRecords();
    const record = map.get(existing.id);
    if (!record) {
      throw new Error(`Work item not found after load: ${existing.id}`);
    }
    record.refs = nextRefs;
    record.updatedAt = nowIso();
    await this.writeRecord(record);
    const snapshot = this.materializeSnapshot(record, map);
    this.emit('work-item-updated', snapshot);
    return snapshot;
  }

  async addDependency(id: string, dependencyId: string): Promise<WorkItemSnapshot> {
    const existing = await this.getWorkItem(id);
    if (!existing) {
      throw new Error(`Work item not found: ${id}`);
    }
    const normalizedDependencyId = String(dependencyId || '').trim();
    if (!normalizedDependencyId) {
      throw new Error('dependencyId is required');
    }
    const dependencies = Array.from(new Set([...existing.dependsOn, normalizedDependencyId]));
    const record = this.normalizeRecord({
      ...existing,
      dependsOn: dependencies,
      updatedAt: nowIso(),
    });
    await this.writeRecord(record);
    const map = await this.loadAllRecords();
    const snapshot = this.materializeSnapshot(record, map);
    this.emit('work-item-updated', snapshot);
    return snapshot;
  }

  async removeDependency(id: string, dependencyId: string): Promise<WorkItemSnapshot> {
    const existing = await this.getWorkItem(id);
    if (!existing) {
      throw new Error(`Work item not found: ${id}`);
    }
    const normalizedDependencyId = String(dependencyId || '').trim();
    const record = this.normalizeRecord({
      ...existing,
      dependsOn: existing.dependsOn.filter((item) => item !== normalizedDependencyId),
      updatedAt: nowIso(),
    });
    await this.writeRecord(record);
    const map = await this.loadAllRecords();
    const snapshot = this.materializeSnapshot(record, map);
    this.emit('work-item-updated', snapshot);
    return snapshot;
  }

  async buildContextPrompt(limit = 12): Promise<string> {
    const items = await this.listWorkItems({ limit: Math.max(limit * 2, limit) });
    if (items.length === 0) return '';
    const prioritized = items.slice(0, Math.max(1, limit));
    const activeItems = prioritized.filter((item) => item.effectiveStatus === 'active');
    const readyItems = prioritized.filter((item) => item.effectiveStatus === 'ready');
    const waitingItems = prioritized.filter((item) => item.effectiveStatus === 'waiting');
    const blockedItems = prioritized.filter((item) => item.effectiveStatus === 'blocked');
    const automationItems = prioritized.filter((item) => item.type === 'automation');

    const renderItem = (item: WorkItemSnapshot): string => {
      const subagentRoles = Array.isArray((item.metadata as Record<string, unknown> | undefined)?.subagentRoles)
        ? ((item.metadata as Record<string, unknown>).subagentRoles as unknown[]).map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      return [
        `- [${item.id}] status=${item.effectiveStatus}; type=${item.type}; priority=P${item.priority}; title=${item.title}`,
        item.summary ? `  summary=${item.summary}` : '',
        item.blockedBy.length > 0 ? `  blockedBy=${item.blockedBy.join(',')}` : '',
        item.schedule?.mode && item.schedule.mode !== 'none'
          ? `  schedule=${item.schedule.mode}; next=${item.schedule.nextRunAt || item.schedule.runAt || '-'}`
          : '',
        subagentRoles.length > 0 ? `  subagents=${subagentRoles.join('->')}` : '',
        item.refs.projectIds.length > 0 ? `  projects=${item.refs.projectIds.join(',')}` : '',
      ].filter(Boolean).join('\n');
    };

    const sections = [
      activeItems.length > 0
        ? ['## Active Work Items', ...activeItems.map(renderItem)].join('\n')
        : '',
      readyItems.length > 0
        ? ['## Ready Queue', ...readyItems.map(renderItem)].join('\n')
        : '',
      waitingItems.length > 0
        ? ['## Waiting Work Items', ...waitingItems.map(renderItem)].join('\n')
        : '',
      blockedItems.length > 0
        ? ['## Blocked Work Items', ...blockedItems.map(renderItem)].join('\n')
        : '',
      automationItems.length > 0
        ? ['## Automation Work Items', ...automationItems.map(renderItem)].join('\n')
        : '',
    ].filter(Boolean);

    return [
      '<workboard>',
      ...sections,
      '</workboard>',
    ].join('\n');
  }
}

let workItemStore: WorkItemStore | null = null;

export function getWorkItemStore(): WorkItemStore {
  if (!workItemStore) {
    workItemStore = new WorkItemStore();
  }
  return workItemStore;
}
