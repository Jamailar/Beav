import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createChatSession, getWorkspacePaths } from '../db';
import { getSessionBridgeService } from './sessionBridgeService';

type TeamSession = {
  id: string;
  ownerSessionId?: string | null;
  coordinatorMemberId?: string | null;
  workspaceRoot?: string | null;
  title: string;
  objective: string;
  status: string;
  runtimeMode: string;
  source: string;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
};

type TeamMember = {
  id: string;
  sessionId: string;
  displayName: string;
  roleId: string;
  sourceKind: string;
  backend: string;
  adapterKind: string;
  status: string;
  currentTaskId?: string | null;
  conversationId?: string | null;
  runtimeId?: string | null;
  capabilities: string[];
  allowedTools: string[];
  desiredModelConfig?: Record<string, unknown> | null;
  currentModelConfig?: Record<string, unknown> | null;
  progressIntervalMs: number;
  reportIntervalSeconds: number;
  lastSeenAt?: number | null;
  lastReportAt?: number | null;
  lastActivityAt?: number | null;
  lastError?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
};

type TeamTask = {
  id: string;
  sessionId: string;
  parentTaskId?: string | null;
  source: string;
  memberId?: string | null;
  assigneeAgentId?: string | null;
  reviewerMemberId?: string | null;
  title: string;
  objective: string;
  description: string;
  status: string;
  priority: number;
  taskType: string;
  dependsOnTaskIds: string[];
  blockedByTaskIds: string[];
  blocksTaskIds: string[];
  runtimeTaskId?: string | null;
  externalTaskRef?: string | null;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  sessionResumeId?: string | null;
  workDir?: string | null;
  failureReason?: string | null;
  resultSummary?: string | null;
  progressPercent?: number | null;
  artifacts: unknown[];
  artifactIds: string[];
  dueAt?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
};

type TeamMessage = {
  id: string;
  sessionId: string;
  fromMemberId?: string | null;
  toMemberId?: string | null;
  fromKind: string;
  taskId?: string | null;
  kind: string;
  messageType: string;
  status: string;
  subject?: string | null;
  body: string;
  attachmentRefs: string[];
  payload?: Record<string, unknown> | null;
  createdAt: number;
  readAt?: number | null;
};

type TeamReport = {
  id: string;
  sessionId: string;
  memberId: string;
  taskId?: string | null;
  reportType: string;
  status: string;
  summary: string;
  nextAction?: string | null;
  nextSteps: string[];
  progressPercent?: number | null;
  blockers: string[];
  artifacts: unknown[];
  artifactIds: string[];
  payload?: Record<string, unknown> | null;
  createdAt: number;
};

type ReviewDocket = {
  id: string;
  sourceKind: string;
  sourceId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  title: string;
  summary: string;
  body: string;
  decisionType: string;
  priority: string;
  status: string;
  riskLevel: string;
  proposedAction?: Record<string, unknown> | null;
  evidenceRefs: unknown[];
  artifactRefs: string[];
  options: unknown[];
  createdByAgentId?: string | null;
  assignedToUserId?: string | null;
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number | null;
};

type ReviewDecision = {
  id: string;
  docketId: string;
  decision: string;
  comment?: string | null;
  selectedOptionId?: string | null;
  patch?: Record<string, unknown> | null;
  decidedAt: number;
};

type TeamState = {
  version: 1;
  sessions: TeamSession[];
  members: TeamMember[];
  tasks: TeamTask[];
  messages: TeamMessage[];
  reports: TeamReport[];
  dockets: ReviewDocket[];
  decisions: ReviewDecision[];
};

type BridgeEvent = {
  sessionId: string;
  message?: {
    type?: string;
    payload?: {
      channel?: string;
      data?: unknown;
    };
  };
};

const STATE_VERSION = 1;
const MAX_MESSAGES = 10_000;
const MAX_REPORTS = 5_000;
const MAX_DOCKETS = 2_000;

function now(): number {
  return Date.now();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => text(item)).filter(Boolean))) : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sessionChatId(sessionId: string, memberId: string): string {
  return `team_member_${sessionId}_${memberId}`.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function chatMetadata(session: TeamSession, member: TeamMember): Record<string, unknown> {
  const memberMetadata = member.metadata || {};
  const activeSkills = Array.isArray(memberMetadata.activeSkills) ? memberMetadata.activeSkills : [];
  return {
    contextType: text(member.roleId) === 'coordinator' ? 'advisor' : 'advisor',
    runtimeMode: 'team',
    createdBy: 'team-runtime',
    collabSessionId: session.id,
    collabMemberId: member.id,
    advisorId: text(memberMetadata.advisorId) || member.roleId,
    activeSkills,
    activeSpeaker: {
      speakerId: member.roleId,
      memberId: member.id,
      collabMemberId: member.id,
      displayName: member.displayName,
    },
  };
}

function emptyState(): TeamState {
  return {
    version: STATE_VERSION,
    sessions: [],
    members: [],
    tasks: [],
    messages: [],
    reports: [],
    dockets: [],
    decisions: [],
  };
}

function normalizeState(value: unknown): TeamState {
  if (!value || typeof value !== 'object') return emptyState();
  const raw = value as Partial<TeamState>;
  return {
    version: STATE_VERSION,
    sessions: Array.isArray(raw.sessions) ? raw.sessions as TeamSession[] : [],
    members: Array.isArray(raw.members) ? raw.members as TeamMember[] : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks as TeamTask[] : [],
    messages: Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES) as TeamMessage[] : [],
    reports: Array.isArray(raw.reports) ? raw.reports.slice(-MAX_REPORTS) as TeamReport[] : [],
    dockets: Array.isArray(raw.dockets) ? raw.dockets.slice(-MAX_DOCKETS) as ReviewDocket[] : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions as ReviewDecision[] : [],
  };
}

export class TeamRuntimeStore extends EventEmitter {
  private state: TeamState = emptyState();
  private loadedPath = '';
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private bridgeListenerAttached = false;
  private readonly responseBuffers = new Map<string, string>();

  private statePath(): string {
    return path.join(getWorkspacePaths().base, '.redbox', 'team-runtime.json');
  }

  private async ensureLoaded(): Promise<void> {
    const targetPath = this.statePath();
    if (this.loadedPath === targetPath) {
      this.attachBridgeListener();
      return;
    }
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        this.state = normalizeState(JSON.parse(await fs.readFile(targetPath, 'utf-8')));
      } catch {
        this.state = emptyState();
      }
      this.loadedPath = targetPath;
      this.loadPromise = null;
      this.attachBridgeListener();
    })();
    return this.loadPromise;
  }

  private attachBridgeListener(): void {
    if (this.bridgeListenerAttached) return;
    this.bridgeListenerAttached = true;
    getSessionBridgeService().on('session-message', (event: BridgeEvent) => {
      void this.handleBridgeEvent(event);
    });
  }

  private async persist(): Promise<void> {
    const targetPath = this.statePath();
    const snapshot = clone(this.state);
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      await fs.rename(tempPath, targetPath);
    });
    await this.writeQueue;
  }

  private emitEvent(eventType: string, sessionId: string | null, payload: Record<string, unknown>): void {
    this.emit('runtime-event', {
      eventType,
      sessionId,
      runtimeId: null,
      parentRuntimeId: null,
      taskId: payload.taskId || null,
      payload: { collabSessionId: sessionId, ...payload },
      timestamp: now(),
    });
  }

  private sessionOrThrow(sessionId: string): TeamSession {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('协作会话不存在');
    return session;
  }

  private memberOrThrow(sessionId: string, memberId: string): TeamMember {
    const member = this.state.members.find((item) => item.sessionId === sessionId && item.id === memberId);
    if (!member) throw new Error('协作成员不存在或不属于该会话');
    return member;
  }

  private taskOrThrow(sessionId: string, taskId: string): TeamTask {
    const task = this.state.tasks.find((item) => item.sessionId === sessionId && item.id === taskId);
    if (!task) throw new Error('协作任务不存在或不属于该会话');
    return task;
  }

  private createMember(session: TeamSession, payload: Record<string, unknown>, coordinator = false): TeamMember {
    const timestamp = now();
    const memberId = text(payload.memberId) || id('team-member');
    const member: TeamMember = {
      id: memberId,
      sessionId: session.id,
      displayName: text(payload.displayName) || (coordinator ? 'RedClaw' : '协作成员'),
      roleId: text(payload.roleId) || (coordinator ? 'coordinator' : 'member'),
      sourceKind: text(payload.sourceKind) || 'local',
      backend: text(payload.backend) || 'pi-agent-core',
      adapterKind: text(payload.adapterKind) || 'embedded',
      status: text(payload.status) || (coordinator ? 'active' : 'idle'),
      currentTaskId: null,
      conversationId: sessionChatId(session.id, memberId),
      runtimeId: null,
      capabilities: stringList(payload.capabilities).length ? stringList(payload.capabilities) : ['discussion', 'creation'],
      allowedTools: stringList(payload.allowedTools),
      desiredModelConfig: objectValue(payload.desiredModelConfig),
      currentModelConfig: objectValue(payload.currentModelConfig),
      progressIntervalMs: Number(payload.progressIntervalMs) || 15_000,
      reportIntervalSeconds: Number(payload.reportIntervalSeconds) || 60,
      lastSeenAt: timestamp,
      lastReportAt: null,
      lastActivityAt: timestamp,
      lastError: null,
      metadata: objectValue(payload.metadata),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const chatId = member.conversationId!;
    createChatSession(chatId, `${session.title} · ${member.displayName}`, chatMetadata(session, member));
    this.state.members.push(member);
    return member;
  }

  private async handleBridgeEvent(event: BridgeEvent): Promise<void> {
    await this.ensureLoaded();
    const conversationId = text(event.sessionId);
    if (!conversationId) return;
    const member = this.state.members.find((item) => item.conversationId === conversationId);
    if (!member) return;
    const bridgePayload = event.message?.payload;
    if (event.message?.type !== 'bridge_event' || !bridgePayload) return;
    const channel = text(bridgePayload.channel);
    const data = objectValue(bridgePayload.data) || {};
    const session = this.state.sessions.find((item) => item.id === member.sessionId);
    if (!session) return;
    if (channel === 'chat:response-chunk') {
      this.responseBuffers.set(conversationId, `${this.responseBuffers.get(conversationId) || ''}${text(data.content)}`);
      return;
    }
    if (channel === 'chat:response-end') {
      const body = text(data.content) || this.responseBuffers.get(conversationId) || '';
      this.responseBuffers.delete(conversationId);
      if (body) {
        this.state.messages.push({
          id: id('team-message'),
          sessionId: session.id,
          fromMemberId: member.id,
          toMemberId: null,
          fromKind: 'agent',
          taskId: member.currentTaskId || null,
          kind: 'message',
          messageType: 'assistant',
          status: 'delivered',
          subject: null,
          body,
          attachmentRefs: [],
          payload: { conversationId },
          createdAt: now(),
          readAt: null,
        });
      }
      member.status = 'idle';
      member.lastSeenAt = now();
      member.lastActivityAt = now();
      member.updatedAt = now();
      await this.persist();
      this.emitEvent('runtime:collab-message-delivered', session.id, { memberId: member.id, messageType: 'assistant' });
      return;
    }
    if (channel === 'chat:error') {
      const body = text(data.message) || text(data.error) || '成员执行失败';
      this.responseBuffers.delete(conversationId);
      this.state.messages.push({
        id: id('team-message'),
        sessionId: session.id,
        fromMemberId: member.id,
        toMemberId: null,
        fromKind: 'agent',
        taskId: member.currentTaskId || null,
        kind: 'error',
        messageType: 'error',
        status: 'failed',
        subject: null,
        body,
        attachmentRefs: [],
        payload: { conversationId },
        createdAt: now(),
        readAt: null,
      });
      member.status = 'failed';
      member.lastError = body;
      member.updatedAt = now();
      await this.persist();
      this.emitEvent('runtime:collab-message-delivered', session.id, { memberId: member.id, error: body });
    }
  }

  async listSessions(): Promise<TeamSession[]> {
    await this.ensureLoaded();
    return clone(this.state.sessions.filter((session) => session.source !== 'acp' && session.status !== 'archived'));
  }

  async createSession(payload: Record<string, unknown>): Promise<TeamSession> {
    await this.ensureLoaded();
    const timestamp = now();
    const session: TeamSession = {
      id: text(payload.id) || id('team-session'),
      ownerSessionId: text(payload.ownerSessionId) || null,
      coordinatorMemberId: null,
      workspaceRoot: getWorkspacePaths().base,
      title: text(payload.title) || '团队协作',
      objective: text(payload.objective) || '拆解、执行并汇总这个任务。',
      status: text(payload.status) || 'active',
      runtimeMode: text(payload.runtimeMode) || 'team',
      source: text(payload.source) || 'team-workbench',
      metadata: objectValue(payload.metadata),
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    this.state.sessions.push(session);
    if (session.runtimeMode === 'team' || session.source === 'team-workbench') {
      const coordinator = this.createMember(session, {
        displayName: 'RedClaw',
        roleId: 'coordinator',
        backend: 'pi-agent-core',
        status: 'active',
        capabilities: ['discussion', 'creation', 'coordination'],
        metadata: { source: 'team-coordinator' },
      }, true);
      session.coordinatorMemberId = coordinator.id;
    }
    await this.persist();
    this.emitEvent('runtime:collab-session-changed', session.id, { session: clone(session) });
    return clone(session);
  }

  async getSession(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    const session = this.sessionOrThrow(sessionId);
    const mailboxLimit = Math.max(1, Math.min(500, Number(payload.mailboxLimit) || 80));
    const reportLimit = Math.max(1, Math.min(500, Number(payload.reportLimit) || 80));
    return {
      session: clone(session),
      members: clone(this.state.members.filter((item) => item.sessionId === sessionId)),
      tasks: clone(this.state.tasks.filter((item) => item.sessionId === sessionId)),
      mailbox: clone(this.state.messages.filter((item) => item.sessionId === sessionId).slice(-mailboxLimit)),
      reports: clone(this.state.reports.filter((item) => item.sessionId === sessionId).slice(-reportLimit)),
    };
  }

  async listMembers(payload: Record<string, unknown>): Promise<TeamMember[]> {
    await this.ensureLoaded();
    this.sessionOrThrow(text(payload.sessionId));
    return clone(this.state.members.filter((item) => item.sessionId === text(payload.sessionId)));
  }

  async addMember(payload: Record<string, unknown>): Promise<TeamMember> {
    await this.ensureLoaded();
    const session = this.sessionOrThrow(text(payload.sessionId));
    const member = this.createMember(session, payload);
    session.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-member-changed', session.id, { member: clone(member) });
    return clone(member);
  }

  async setSessionCoordinator(payload: Record<string, unknown>): Promise<TeamSession> {
    await this.ensureLoaded();
    const session = this.sessionOrThrow(text(payload.sessionId));
    const member = this.memberOrThrow(session.id, text(payload.memberId) || text(payload.coordinatorMemberId));
    session.coordinatorMemberId = member.id;
    session.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-session-changed', session.id, { session: clone(session) });
    return clone(session);
  }

  async renameMember(payload: Record<string, unknown>): Promise<TeamMember> {
    await this.ensureLoaded();
    const member = this.memberOrThrow(text(payload.sessionId), text(payload.memberId));
    member.displayName = text(payload.displayName) || member.displayName;
    member.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-member-changed', member.sessionId, { member: clone(member) });
    return clone(member);
  }

  async shutdownMember(payload: Record<string, unknown>): Promise<TeamMember> {
    await this.ensureLoaded();
    const member = this.memberOrThrow(text(payload.sessionId), text(payload.memberId));
    member.status = text(payload.status) || 'offline';
    member.lastError = text(payload.reason) || null;
    member.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-member-changed', member.sessionId, { member: clone(member) });
    return clone(member);
  }

  async listTasks(payload: Record<string, unknown>): Promise<TeamTask[]> {
    await this.ensureLoaded();
    this.sessionOrThrow(text(payload.sessionId));
    return clone(this.state.tasks.filter((item) => item.sessionId === text(payload.sessionId)));
  }

  async createTask(payload: Record<string, unknown>): Promise<TeamTask> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    const timestamp = now();
    const task: TeamTask = {
      id: text(payload.id) || id('team-task'),
      sessionId,
      parentTaskId: text(payload.parentTaskId) || null,
      source: text(payload.source) || 'user',
      memberId: text(payload.memberId) || null,
      assigneeAgentId: text(payload.assigneeAgentId) || null,
      reviewerMemberId: text(payload.reviewerMemberId) || null,
      title: text(payload.title) || '未命名任务',
      objective: text(payload.objective) || text(payload.title),
      description: text(payload.description),
      status: text(payload.status) || 'todo',
      priority: Number(payload.priority) || 0,
      taskType: text(payload.taskType) || 'general',
      dependsOnTaskIds: stringList(payload.dependsOnTaskIds),
      blockedByTaskIds: stringList(payload.blockedByTaskIds),
      blocksTaskIds: stringList(payload.blocksTaskIds),
      runtimeTaskId: text(payload.runtimeTaskId) || null,
      externalTaskRef: text(payload.externalTaskRef) || null,
      attempt: Number(payload.attempt) || 1,
      maxAttempts: Number(payload.maxAttempts) || 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      sessionResumeId: text(payload.sessionResumeId) || null,
      workDir: text(payload.workDir) || null,
      failureReason: null,
      resultSummary: null,
      progressPercent: typeof payload.progressPercent === 'number' ? payload.progressPercent : 0,
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
      artifactIds: stringList(payload.artifactIds),
      dueAt: typeof payload.dueAt === 'number' ? payload.dueAt : null,
      metadata: objectValue(payload.metadata),
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
    };
    this.state.tasks.push(task);
    await this.persist();
    this.emitEvent('runtime:collab-task-changed', sessionId, { task: clone(task) });
    return clone(task);
  }

  async updateTask(payload: Record<string, unknown>): Promise<TeamTask> {
    await this.ensureLoaded();
    const task = this.taskOrThrow(text(payload.sessionId), text(payload.taskId) || text(payload.id));
    const fields: Array<keyof TeamTask> = [
      'title', 'objective', 'description', 'memberId', 'reviewerMemberId', 'priority', 'taskType',
      'progressPercent', 'resultSummary', 'failureReason', 'metadata', 'dueAt',
    ];
    for (const field of fields) {
      if (payload[field] !== undefined) (task[field] as unknown) = payload[field] as never;
    }
    task.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-task-changed', task.sessionId, { task: clone(task) });
    return clone(task);
  }

  async transitionTask(payload: Record<string, unknown>, transition: string): Promise<TeamTask> {
    await this.ensureLoaded();
    const task = this.taskOrThrow(text(payload.sessionId), text(payload.taskId) || text(payload.id));
    const timestamp = now();
    const statusByTransition: Record<string, string> = {
      claim: 'claimed',
      start: 'running',
      'wait-review': 'waiting_for_review',
      complete: 'completed',
      fail: 'failed',
      cancel: 'cancelled',
    };
    task.status = statusByTransition[transition] || text(payload.status) || task.status;
    if (task.status === 'running') task.startedAt = task.startedAt || timestamp;
    if (['completed', 'failed', 'cancelled'].includes(task.status)) task.completedAt = timestamp;
    if (payload.resultSummary !== undefined) task.resultSummary = text(payload.resultSummary) || null;
    if (payload.failureReason !== undefined) task.failureReason = text(payload.failureReason) || null;
    if (typeof payload.progressPercent === 'number') task.progressPercent = payload.progressPercent;
    task.updatedAt = timestamp;
    const member = task.memberId ? this.state.members.find((item) => item.id === task.memberId && item.sessionId === task.sessionId) : null;
    if (member) {
      member.currentTaskId = ['completed', 'failed', 'cancelled'].includes(task.status) ? null : task.id;
      member.status = task.status === 'running' ? 'active' : member.status;
      member.updatedAt = timestamp;
    }
    await this.persist();
    this.emitEvent('runtime:collab-task-changed', task.sessionId, { task: clone(task), transition });
    return clone(task);
  }

  async pinTaskSession(payload: Record<string, unknown>): Promise<TeamTask> {
    await this.ensureLoaded();
    const task = this.taskOrThrow(text(payload.sessionId), text(payload.taskId) || text(payload.id));
    task.sessionResumeId = text(payload.sessionResumeId) || task.sessionResumeId || null;
    task.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-task-changed', task.sessionId, { task, transition: 'pin-session' });
    return clone(task);
  }

  async retryTask(payload: Record<string, unknown>): Promise<TeamTask> {
    await this.ensureLoaded();
    const task = this.taskOrThrow(text(payload.sessionId), text(payload.taskId) || text(payload.id));
    task.attempt += 1;
    task.status = 'todo';
    task.failureReason = null;
    task.completedAt = null;
    task.updatedAt = now();
    await this.persist();
    this.emitEvent('runtime:collab-task-changed', task.sessionId, { task, transition: 'retry' });
    return clone(task);
  }

  async listMessages(payload: Record<string, unknown>, markRead = false): Promise<TeamMessage[]> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    const memberId = text(payload.memberId);
    const taskId = text(payload.taskId);
    const unreadOnly = payload.unreadOnly === true;
    const limit = Math.max(1, Math.min(500, Number(payload.limit) || 100));
    const messages = this.state.messages.filter((message) => message.sessionId === sessionId)
      .filter((message) => !memberId || message.toMemberId === memberId || message.fromMemberId === memberId)
      .filter((message) => !taskId || message.taskId === taskId)
      .filter((message) => !unreadOnly || !message.readAt)
      .slice(-limit);
    if (markRead) {
      const timestamp = now();
      for (const message of messages) message.readAt = message.readAt || timestamp;
      await this.persist();
    }
    return clone(messages);
  }

  async sendMessage(payload: Record<string, unknown>): Promise<TeamMessage> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    const toMemberId = text(payload.toMemberId) || null;
    const member = toMemberId ? this.memberOrThrow(sessionId, toMemberId) : null;
    const message: TeamMessage = {
      id: id('team-message'),
      sessionId,
      fromMemberId: text(payload.fromMemberId) || null,
      toMemberId,
      fromKind: text(payload.fromKind) || 'user',
      taskId: text(payload.taskId) || member?.currentTaskId || null,
      kind: text(payload.kind) || 'message',
      messageType: text(payload.messageType) || 'message',
      status: 'delivered',
      subject: text(payload.subject) || null,
      body: text(payload.body) || text(payload.message),
      attachmentRefs: stringList(payload.attachmentRefs),
      payload: objectValue(payload.payload),
      createdAt: now(),
      readAt: null,
    };
    if (!message.body) throw new Error('消息内容不能为空');
    this.state.messages.push(message);
    if (member) {
      member.status = 'active';
      member.lastActivityAt = now();
      member.updatedAt = now();
    }
    await this.persist();
    this.emitEvent('runtime:collab-message-delivered', sessionId, { message: clone(message) });
    if (member?.conversationId && message.fromKind === 'user') {
      void getSessionBridgeService().sendSessionMessage(member.conversationId, message.body).catch(async (error) => {
        const failed = this.state.messages.find((item) => item.id === message.id);
        if (failed) failed.status = 'failed';
        member.status = 'failed';
        member.lastError = error instanceof Error ? error.message : String(error);
        await this.persist();
        this.emitEvent('runtime:collab-message-delivered', sessionId, { messageId: message.id, error: member.lastError });
      });
    }
    return clone(message);
  }

  async requestReport(payload: Record<string, unknown>): Promise<TeamMessage> {
    return this.sendMessage({
      ...payload,
      kind: 'report_request',
      messageType: 'report_request',
      fromKind: text(payload.fromKind) || 'user',
      body: text(payload.body) || '请汇报当前进展、阻塞和下一步。',
    });
  }

  async runExternalMember(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const message = await this.sendMessage({
      ...payload,
      body: text(payload.body) || text(payload.message) || text(payload.prompt),
      fromKind: text(payload.fromKind) || 'user',
    });
    return { success: true, message };
  }

  async listReports(payload: Record<string, unknown>): Promise<TeamReport[]> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    const limit = Math.max(1, Math.min(500, Number(payload.limit) || 100));
    return clone(this.state.reports.filter((report) => report.sessionId === sessionId)
      .filter((report) => !text(payload.memberId) || report.memberId === text(payload.memberId))
      .filter((report) => !text(payload.taskId) || report.taskId === text(payload.taskId))
      .slice(-limit));
  }

  async submitReport(payload: Record<string, unknown>): Promise<TeamReport> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    const memberId = text(payload.memberId) || text(payload.fromMemberId);
    this.memberOrThrow(sessionId, memberId);
    const report: TeamReport = {
      id: id('team-report'),
      sessionId,
      memberId,
      taskId: text(payload.taskId) || null,
      reportType: text(payload.reportType) || 'progress',
      status: text(payload.status) || 'submitted',
      summary: text(payload.summary) || text(payload.body),
      nextAction: text(payload.nextAction) || null,
      nextSteps: stringList(payload.nextSteps),
      progressPercent: typeof payload.progressPercent === 'number' ? payload.progressPercent : null,
      blockers: stringList(payload.blockers),
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
      artifactIds: stringList(payload.artifactIds),
      payload: objectValue(payload.payload),
      createdAt: now(),
    };
    this.state.reports.push(report);
    const member = this.memberOrThrow(sessionId, memberId);
    member.lastReportAt = report.createdAt;
    member.updatedAt = report.createdAt;
    await this.persist();
    this.emitEvent('runtime:collab-report-submitted', sessionId, { report: clone(report) });
    return clone(report);
  }

  async tickReports(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    this.emitEvent('runtime:collab-report-tick', sessionId, { sessionId });
    return { success: true, sessionId, requestedAt: now(), pending: 0 };
  }

  async updateSessionStatus(payload: Record<string, unknown>, status: string): Promise<TeamSession> {
    await this.ensureLoaded();
    const session = this.sessionOrThrow(text(payload.sessionId));
    session.status = status;
    session.updatedAt = now();
    if (status === 'archived' || status === 'completed') session.completedAt = session.updatedAt;
    await this.persist();
    this.emitEvent('runtime:collab-session-changed', session.id, { session: clone(session) });
    return clone(session);
  }

  async listDockets(payload: Record<string, unknown> = {}): Promise<ReviewDocket[]> {
    await this.ensureLoaded();
    return clone(this.state.dockets.filter((docket) => !text(payload.sessionId) || docket.sessionId === text(payload.sessionId))
      .filter((docket) => payload.includeArchived === true || !['archived', 'skipped'].includes(docket.status)));
  }

  async getDocket(payload: Record<string, unknown>): Promise<ReviewDocket> {
    await this.ensureLoaded();
    const docket = this.state.dockets.find((item) => item.id === text(payload.docketId));
    if (!docket) throw new Error('review docket 不存在');
    return clone(docket);
  }

  async createDocket(payload: Record<string, unknown>): Promise<ReviewDocket> {
    await this.ensureLoaded();
    const timestamp = now();
    const docket: ReviewDocket = {
      id: id('review-docket'),
      sourceKind: text(payload.sourceKind) || 'team',
      sourceId: text(payload.sourceId) || null,
      sessionId: text(payload.sessionId) || null,
      taskId: text(payload.taskId) || null,
      title: text(payload.title) || '待审阅事项',
      summary: text(payload.summary),
      body: text(payload.body),
      decisionType: text(payload.decisionType) || 'approval',
      priority: text(payload.priority) || 'normal',
      status: 'pending',
      riskLevel: text(payload.riskLevel) || 'normal',
      proposedAction: objectValue(payload.proposedAction),
      evidenceRefs: Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [],
      artifactRefs: stringList(payload.artifactRefs),
      options: Array.isArray(payload.options) ? payload.options : [],
      createdByAgentId: text(payload.createdByAgentId) || null,
      assignedToUserId: text(payload.assignedToUserId) || null,
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
    };
    this.state.dockets.push(docket);
    await this.persist();
    return clone(docket);
  }

  async decideDocket(payload: Record<string, unknown>): Promise<ReviewDecision> {
    await this.ensureLoaded();
    const docket = this.state.dockets.find((item) => item.id === text(payload.docketId));
    if (!docket) throw new Error('review docket 不存在');
    const decision: ReviewDecision = {
      id: id('review-decision'),
      docketId: docket.id,
      decision: text(payload.decision) || 'approved',
      comment: text(payload.comment) || null,
      selectedOptionId: text(payload.selectedOptionId) || null,
      patch: objectValue(payload.patch),
      decidedAt: now(),
    };
    docket.status = decision.decision === 'rejected' ? 'rejected' : decision.decision === 'changes_requested' ? 'changes_requested' : 'approved';
    docket.updatedAt = decision.decidedAt;
    docket.decidedAt = decision.decidedAt;
    this.state.decisions.push(decision);
    await this.persist();
    return clone(decision);
  }

  async archiveDocket(payload: Record<string, unknown>, status: 'archived' | 'skipped'): Promise<ReviewDocket> {
    await this.ensureLoaded();
    const docket = this.state.dockets.find((item) => item.id === text(payload.docketId));
    if (!docket) throw new Error('review docket 不存在');
    docket.status = status;
    docket.updatedAt = now();
    await this.persist();
    return clone(docket);
  }

  async docketStats(): Promise<Record<string, number>> {
    await this.ensureLoaded();
    const total = this.state.dockets.length;
    const count = (status: string) => this.state.dockets.filter((item) => item.status === status).length;
    return {
      total,
      pending: count('pending'),
      approved: count('approved'),
      rejected: count('rejected'),
      changesRequested: count('changes_requested'),
      skipped: count('skipped'),
      archived: count('archived'),
      expiredPending: 0,
      linkedTasks: this.state.dockets.filter((item) => Boolean(item.taskId)).length,
    };
  }

  async matchMember(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const sessionId = text(payload.sessionId);
    this.sessionOrThrow(sessionId);
    const query = objectValue(payload.query) || payload;
    const needle = `${text(query.roleId)} ${text(query.displayName)} ${text(query.capability)} ${text(query.taskType)}`.toLowerCase();
    const candidates = this.state.members.filter((member) => member.sessionId === sessionId).map((member) => {
      const haystack = `${member.displayName} ${member.roleId} ${member.capabilities.join(' ')}`.toLowerCase();
      const score = needle && haystack.includes(needle) ? 1 : needle.split(/\s+/).filter(Boolean).some((part) => haystack.includes(part)) ? 0.5 : 0;
      return {
        memberId: member.id,
        displayName: member.displayName,
        roleId: member.roleId,
        status: member.status,
        score,
        reasons: score > 0 ? ['匹配角色或能力'] : [],
        activeExecutorCount: member.status === 'active' ? 1 : 0,
        maxExecutorThreads: 1,
      };
    }).sort((left, right) => Number(right.score) - Number(left.score));
    return { sessionId, query, candidates };
  }

  async executeTool(payload: { action?: string; payload?: Record<string, unknown> }): Promise<unknown> {
    const action = text(payload.action);
    const inner = payload.payload || {};
    if (action === 'team.member.match') return this.matchMember(inner);
    if (action === 'team.task.create') return this.createTask(inner);
    if (action === 'team.artifact.attach') return this.submitReport({ ...inner, reportType: 'artifact', summary: text(inner.summary) || '已附加产物' });
    if (action === 'team.blocker.raise') return this.submitReport({ ...inner, reportType: 'blocker', status: 'blocked', summary: text(inner.summary) || '成员报告阻塞' });
    return { success: false, error: `未支持的 Team tool: ${action || 'unknown'}` };
  }

  async listAgentBackends(): Promise<Array<Record<string, unknown>>> {
    return [{ id: 'pi-agent-core', name: '本地 Pi Agent', status: 'ready', adapterKind: 'embedded' }];
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    return [
      { name: 'team.member.match', description: '匹配当前团队成员' },
      { name: 'team.task.create', description: '创建团队任务' },
      { name: 'team.artifact.attach', description: '附加团队产物' },
      { name: 'team.blocker.raise', description: '报告团队阻塞' },
    ];
  }
}

let teamRuntimeStore: TeamRuntimeStore | null = null;

export function getTeamRuntimeStore(): TeamRuntimeStore {
  if (!teamRuntimeStore) teamRuntimeStore = new TeamRuntimeStore();
  return teamRuntimeStore;
}
