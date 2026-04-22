import {
  addAgentTaskTrace,
  createAgentTask,
  getAgentTask,
  listAgentTasks,
  listAgentTaskTraces,
  parseAgentTaskRecord,
  parseAgentTaskTraceRecord,
  updateAgentTask,
  type AgentTaskArtifactRecord,
  type AgentTaskCheckpointRecord,
  type AgentTaskNodeRecord,
} from '../../db';
import type { AgentTaskSnapshot, IntentRoute, RoleId, RuntimeMode } from './types';
import { getWorkItemStore } from '../workItemStore';

const now = () => Date.now();

const createNode = (type: string, title: string): AgentTaskNodeRecord => ({
  id: `${type}_${Math.random().toString(36).slice(2, 8)}`,
  type,
  title,
  status: 'pending',
});

const buildGraphForIntent = (params: { intent: string; multiAgent: boolean; longRunning: boolean }): AgentTaskNodeRecord[] => {
  const basePrefix = [
    createNode('route', '初始化任务上下文'),
    createNode('plan', '生成执行计划'),
  ];
  const collaborationPrefix = params.multiAgent
    ? [
      createNode('spawn_agents', '调度子角色'),
      createNode('handoff', '整理角色交接'),
    ]
    : [];

  switch (params.intent) {
    case 'discussion':
      return [
        createNode('route', '初始化讨论上下文'),
        createNode('spawn_agents', '推进成员讨论'),
        createNode('save_artifact', '保存讨论记录'),
        createNode('complete', '完成任务'),
      ];
    case 'manuscript_creation':
      return [
        ...basePrefix,
        ...collaborationPrefix,
        createNode('retrieve', '检索素材'),
        createNode('execute_tools', '调用工具执行'),
        createNode('review', '校验结果'),
        createNode('save_artifact', '保存产物'),
        createNode('complete', '完成任务'),
      ];
    case 'image_creation':
    case 'cover_generation':
    case 'advisor_persona':
      return [
        ...basePrefix,
        ...collaborationPrefix,
        createNode('retrieve', '检索素材'),
        createNode('execute_tools', '调用工具执行'),
        createNode('review', '校验结果'),
        createNode('save_artifact', '保存产物'),
        createNode('complete', '完成任务'),
      ];
    case 'knowledge_retrieval':
      return [
        ...basePrefix,
        ...collaborationPrefix,
        createNode('retrieve', '检索素材'),
        createNode('execute_tools', '调用工具执行'),
        createNode('review', '校验结果'),
        createNode('complete', '完成任务'),
      ];
    case 'automation':
    case 'long_running_task':
      return [
        ...basePrefix,
        ...(params.multiAgent ? collaborationPrefix : [createNode('spawn_agents', '调度后台角色')]),
        createNode('execute_tools', '推进后台执行'),
        createNode('review', '检查执行结果'),
        createNode('handoff', '记录下一步'),
        createNode('complete', '完成任务'),
      ];
    default:
      return [
        ...basePrefix,
        ...collaborationPrefix,
        createNode('execute_tools', '调用工具执行'),
        ...(params.longRunning ? [createNode('handoff', '记录后续动作')] : []),
        createNode('complete', '完成任务'),
      ];
  }
};

const hydrateTask = (taskId: string): AgentTaskSnapshot | null => {
  const parsed = parseAgentTaskRecord(getAgentTask(taskId));
  if (!parsed) return null;
  return {
    id: parsed.id,
    taskType: parsed.task_type,
    status: parsed.status,
    runtimeMode: parsed.runtime_mode as RuntimeMode,
    ownerSessionId: parsed.owner_session_id,
    intent: parsed.intent,
    roleId: parsed.role_id,
    goal: parsed.goal,
    currentNode: parsed.current_node,
    route: parsed.route as IntentRoute | null,
    graph: parsed.graph,
    artifacts: parsed.artifacts,
    checkpoints: parsed.checkpoints,
    metadata: parsed.metadata,
    lastError: parsed.last_error,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    startedAt: parsed.started_at,
    completedAt: parsed.completed_at,
  };
};

const resolveWorkItemId = (task: AgentTaskSnapshot | null): string => {
  const candidate = task?.metadata && typeof task.metadata === 'object'
    ? (task.metadata as Record<string, unknown>).workItemId
    : undefined;
  return typeof candidate === 'string' ? candidate.trim() : '';
};

export class TaskGraphRuntime {
  createInteractiveTask(params: {
    runtimeMode: RuntimeMode;
    ownerSessionId: string;
    userInput: string;
    route: IntentRoute;
    roleId: RoleId;
    metadata?: unknown;
  }): AgentTaskSnapshot {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const graph = buildGraphForIntent({
      intent: params.route.intent,
      multiAgent: params.route.requiresMultiAgent,
      longRunning: params.route.requiresLongRunningTask,
    });
    const created = createAgentTask({
      id,
      task_type: params.route.intent,
      status: 'running',
      runtime_mode: params.runtimeMode,
      owner_session_id: params.ownerSessionId,
      intent: params.route.intent,
      role_id: params.roleId,
      goal: params.route.goal,
      current_node: graph[0]?.id || null,
      route: params.route,
      graph,
      artifacts: [],
      checkpoints: [],
      metadata: {
        userInput: params.userInput,
        ...((params.metadata && typeof params.metadata === 'object') ? params.metadata as Record<string, unknown> : {}),
      },
      started_at: now(),
    });
    addAgentTaskTrace({
      task_id: id,
      node_id: graph[0]?.id || null,
      event_type: 'task.created',
      payload: {
        runtimeMode: params.runtimeMode,
        route: params.route,
        roleId: params.roleId,
      },
    });
    const workItemId = typeof (params.metadata as Record<string, unknown> | undefined)?.workItemId === 'string'
      ? String((params.metadata as Record<string, unknown>).workItemId || '').trim()
      : '';
    if (workItemId) {
      void getWorkItemStore().attachRefs(workItemId, {
        taskIds: [id],
        sessionIds: [params.ownerSessionId],
      }).then(() => getWorkItemStore().updateWorkItem(workItemId, {
        status: 'active',
        summary: `AI 任务已启动：${params.route.goal}`,
      })).catch((error) => {
        console.warn('[TaskGraphRuntime] failed to attach work item:', error);
      });
    }
    return hydrateTask(created.id)!;
  }

  getTask(taskId: string): AgentTaskSnapshot | null {
    return hydrateTask(taskId);
  }

  listTasks(params?: { status?: AgentTaskSnapshot['status']; ownerSessionId?: string; limit?: number }): AgentTaskSnapshot[] {
    return listAgentTasks({
      status: params?.status,
      ownerSessionId: params?.ownerSessionId,
      limit: params?.limit,
    }).map((task) => hydrateTask(task.id)).filter((task): task is AgentTaskSnapshot => Boolean(task));
  }

  listTraces(taskId: string, limit?: number) {
    return listAgentTaskTraces(taskId, limit).map((trace) => parseAgentTaskTraceRecord(trace));
  }

  addTrace(taskId: string, eventType: string, payload?: unknown, nodeType?: string) {
    const task = this.getTask(taskId);
    const node = nodeType ? task?.graph.find((item) => item.type === nodeType) : undefined;
    addAgentTaskTrace({
      task_id: taskId,
      node_id: node?.id || null,
      event_type: eventType,
      payload,
    });
  }

  startNode(taskId: string, nodeType: string, summary?: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const graph = task.graph.map((node) => {
      if (node.type !== nodeType) return node;
      return {
        ...node,
        status: 'running' as const,
        startedAt: node.startedAt || now(),
        summary: summary || node.summary,
      };
    });
    updateAgentTask(taskId, {
      current_node: graph.find((node) => node.type === nodeType)?.id || task.currentNode,
      graph,
    });
    this.addTrace(taskId, 'node.started', { nodeType, summary }, nodeType);
    return this.getTask(taskId);
  }

  completeNode(taskId: string, nodeType: string, summary?: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const graph = task.graph.map((node) => {
      if (node.type !== nodeType) return node;
      return {
        ...node,
        status: 'completed' as const,
        startedAt: node.startedAt || now(),
        completedAt: now(),
        summary: summary || node.summary,
      };
    });
    updateAgentTask(taskId, {
      graph,
      current_node: graph.find((node) => node.status === 'running')?.id || task.currentNode,
    });
    this.addTrace(taskId, 'node.completed', { nodeType, summary }, nodeType);
    return this.getTask(taskId);
  }

  skipNode(taskId: string, nodeType: string, summary?: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const graph = task.graph.map((node) => node.type === nodeType ? {
      ...node,
      status: 'skipped' as const,
      completedAt: now(),
      summary: summary || node.summary,
    } : node);
    updateAgentTask(taskId, { graph });
    this.addTrace(taskId, 'node.skipped', { nodeType, summary }, nodeType);
    return this.getTask(taskId);
  }

  failTask(taskId: string, error: string, nodeType?: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const graph = nodeType ? task.graph.map((node) => node.type === nodeType ? {
      ...node,
      status: 'failed' as const,
      completedAt: now(),
      error,
    } : node) : task.graph;
    updateAgentTask(taskId, {
      status: 'failed',
      graph,
      last_error: error,
      completed_at: now(),
    });
    this.addTrace(taskId, 'task.failed', { error, nodeType }, nodeType);
    const workItemId = resolveWorkItemId(task);
    if (workItemId) {
      void getWorkItemStore().updateWorkItem(workItemId, {
        status: 'waiting',
        summary: `AI 任务失败：${error}`,
      }).catch((workItemError) => {
        console.warn('[TaskGraphRuntime] failed to update failed work item:', workItemError);
      });
    }
    return this.getTask(taskId);
  }

  completeTask(taskId: string, summary?: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const graph = task.graph.map((node) => node.type === 'complete'
      ? { ...node, status: 'completed' as const, startedAt: node.startedAt || now(), completedAt: now(), summary: summary || node.summary }
      : node);
    updateAgentTask(taskId, {
      status: 'completed',
      graph,
      completed_at: now(),
    });
    this.addTrace(taskId, 'task.completed', { summary }, 'complete');
    const workItemId = resolveWorkItemId(task);
    if (workItemId) {
      void getWorkItemStore().updateWorkItem(workItemId, {
        status: 'done',
        summary: summary || task.goal || 'AI 任务已完成。',
      }).catch((workItemError) => {
        console.warn('[TaskGraphRuntime] failed to update completed work item:', workItemError);
      });
    }
    return this.getTask(taskId);
  }

  addCheckpoint(taskId: string, nodeType: string, summary: string, payload?: unknown): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const node = task.graph.find((item) => item.type === nodeType);
    const checkpoint: AgentTaskCheckpointRecord = {
      id: `checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      nodeId: node?.id || nodeType,
      summary,
      payload,
      createdAt: now(),
    };
    const checkpoints = [...task.checkpoints, checkpoint];
    updateAgentTask(taskId, { checkpoints });
    this.addTrace(taskId, 'task.checkpoint', checkpoint, nodeType);
    return this.getTask(taskId);
  }

  addArtifact(taskId: string, artifact: Omit<AgentTaskArtifactRecord, 'id' | 'createdAt'>): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const nextArtifact: AgentTaskArtifactRecord = {
      id: `artifact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now(),
      ...artifact,
    };
    const artifacts = [...task.artifacts, nextArtifact];
    updateAgentTask(taskId, { artifacts });
    this.addTrace(taskId, 'task.artifact-added', nextArtifact, 'save_artifact');
    return this.getTask(taskId);
  }

  resumeTask(taskId: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    updateAgentTask(taskId, {
      status: 'running',
      started_at: task.startedAt || now(),
      completed_at: null,
    });
    this.addTrace(taskId, 'task.resumed');
    const workItemId = resolveWorkItemId(task);
    if (workItemId) {
      void getWorkItemStore().updateWorkItem(workItemId, {
        status: 'active',
        summary: 'AI 任务已恢复执行。',
      }).catch((workItemError) => {
        console.warn('[TaskGraphRuntime] failed to update resumed work item:', workItemError);
      });
    }
    return this.getTask(taskId);
  }

  cancelTask(taskId: string): AgentTaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    updateAgentTask(taskId, {
      status: 'cancelled',
      completed_at: now(),
    });
    this.addTrace(taskId, 'task.cancelled');
    const workItemId = resolveWorkItemId(task);
    if (workItemId) {
      void getWorkItemStore().updateWorkItem(workItemId, {
        status: 'cancelled',
        summary: 'AI 任务已取消。',
      }).catch((workItemError) => {
        console.warn('[TaskGraphRuntime] failed to update cancelled work item:', workItemError);
      });
    }
    return this.getTask(taskId);
  }
}

let runtime: TaskGraphRuntime | null = null;

export const getTaskGraphRuntime = (): TaskGraphRuntime => {
  if (!runtime) {
    runtime = new TaskGraphRuntime();
  }
  return runtime;
};
