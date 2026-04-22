import { assembleRuntimeSystemPrompt } from './contextAssembler';
import { getRoleSpec } from './roleRegistry';
import { runSubagentOrchestration } from './subagentRuntime';
import { getTaskGraphRuntime } from './taskGraphRuntime';
import type {
  IntentName,
  IntentRoute,
  PreparedRuntimeExecution,
  RuntimeContext,
  RuntimeMode,
  RoleId,
  ThinkingBudget,
} from './types';

const DEFAULT_INTENT_BY_MODE: Record<RuntimeMode, IntentRoute['intent']> = {
  redclaw: 'manuscript_creation',
  knowledge: 'knowledge_retrieval',
  chatroom: 'discussion',
  'advisor-discussion': 'discussion',
  'background-maintenance': 'automation',
};

const DEFAULT_ROLE_BY_MODE: Record<RuntimeMode, RoleId> = {
  redclaw: 'copywriter',
  knowledge: 'researcher',
  chatroom: 'ops-coordinator',
  'advisor-discussion': 'researcher',
  'background-maintenance': 'ops-coordinator',
};

const DEFAULT_CAPABILITIES_BY_MODE: Record<RuntimeMode, string[]> = {
  redclaw: ['planning', 'writing', 'artifact-save'],
  knowledge: ['knowledge-retrieval', 'evidence-synthesis'],
  chatroom: ['multi-agent-discussion'],
  'advisor-discussion': ['advisor-response', 'knowledge-retrieval'],
  'background-maintenance': ['task-graph', 'background-runner', 'artifact-save'],
};

const normalizeIntentHint = (value: unknown): IntentName | null => {
  const normalized = String(value || '').trim() as IntentName;
  if (!normalized) return null;
  if (
    normalized === 'direct_answer'
    || normalized === 'file_operation'
    || normalized === 'manuscript_creation'
    || normalized === 'image_creation'
    || normalized === 'cover_generation'
    || normalized === 'knowledge_retrieval'
    || normalized === 'long_running_task'
    || normalized === 'discussion'
    || normalized === 'memory_maintenance'
    || normalized === 'automation'
    || normalized === 'advisor_persona'
  ) {
    return normalized;
  }
  return null;
};

const normalizeRoleHint = (value: unknown): RoleId | null => {
  const normalized = String(value || '').trim() as RoleId;
  if (!normalized) return null;
  try {
    return getRoleSpec(normalized).roleId;
  } catch {
    return null;
  }
};

const extractHints = (context: RuntimeContext) => {
  const metadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata as Record<string, unknown>
    : {};
  const subagentRoles = Array.isArray(metadata.subagentRoles)
    ? metadata.subagentRoles
      .map((item) => String(item || '').trim())
      .filter(Boolean)
    : [];
  return {
    metadata,
    forcedIntent: normalizeIntentHint(metadata.intent),
    preferredRole: normalizeRoleHint(metadata.preferredRole),
    forceMultiAgent: Boolean(metadata.forceMultiAgent),
    forceLongRunningTask: Boolean(metadata.forceLongRunningTask),
    requiresHumanApproval: Boolean(metadata.requiresHumanApproval),
    subagentRoles,
  };
};

const inferIntent = (runtimeMode: RuntimeMode, hints: ReturnType<typeof extractHints>): IntentName => {
  if (hints.forcedIntent) return hints.forcedIntent;
  if (runtimeMode === 'background-maintenance') return 'automation';
  if (runtimeMode === 'knowledge') return 'knowledge_retrieval';
  if (runtimeMode === 'chatroom' || runtimeMode === 'advisor-discussion') return 'discussion';
  if (runtimeMode !== 'redclaw') return DEFAULT_INTENT_BY_MODE[runtimeMode];

  const metadata = hints.metadata;
  if (metadata.longCycleTaskId || metadata.longCycleRound || metadata.longCycleStep) {
    return 'long_running_task';
  }
  if (metadata.scheduledTaskId || metadata.automationId || metadata.runnerReason) {
    return 'automation';
  }
  if (metadata.attachmentType === 'wander-references') {
    return 'manuscript_creation';
  }
  if (metadata.channelProvider === 'weixin' && metadata.weixinSecretaryMode === true) {
    return 'direct_answer';
  }

  return 'manuscript_creation';
};

const inferRoleForIntent = (runtimeMode: RuntimeMode, intent: IntentName): RoleId => {
  if (runtimeMode !== 'redclaw') return DEFAULT_ROLE_BY_MODE[runtimeMode];
  switch (intent) {
    case 'cover_generation':
    case 'image_creation':
      return 'image-director';
    case 'knowledge_retrieval':
      return 'researcher';
    case 'long_running_task':
    case 'automation':
      return 'ops-coordinator';
    case 'advisor_persona':
      return 'planner';
    default:
      return 'copywriter';
  }
};

const resolveRecommendedRole = (
  runtimeMode: RuntimeMode,
  intent: IntentName,
  hints: ReturnType<typeof extractHints>,
): RoleId => {
  if (hints.preferredRole) return hints.preferredRole;
  return inferRoleForIntent(runtimeMode, intent);
};

const shouldTriggerMultiAgent = (params: {
  runtimeMode: RuntimeMode;
  hints: ReturnType<typeof extractHints>;
}): boolean => {
  if (params.hints.forceMultiAgent) return true;
  if (params.hints.subagentRoles.length > 0) return true;
  return false;
};

const shouldTriggerLongRunning = (params: {
  runtimeMode: RuntimeMode;
  intent: IntentName;
  hints: ReturnType<typeof extractHints>;
}): boolean => {
  if (params.hints.forceLongRunningTask) return true;
  if (params.runtimeMode === 'background-maintenance') return true;
  if (params.intent === 'long_running_task' || params.intent === 'automation') return true;
  if (params.hints.metadata.longCycleTaskId || params.hints.metadata.longCycleRound || params.hints.metadata.longCycleStep) {
    return true;
  }
  if (params.hints.metadata.scheduledTaskId || params.hints.metadata.automationId || params.hints.metadata.runnerReason) {
    return true;
  }
  return false;
};

const buildDirectRoute = (context: RuntimeContext): IntentRoute => {
  const runtimeMode = context.runtimeMode;
  const hints = extractHints(context);
  const intent = inferIntent(runtimeMode, hints);
  const recommendedRole = resolveRecommendedRole(runtimeMode, intent, hints);
  const requiresMultiAgent = shouldTriggerMultiAgent({
    runtimeMode,
    hints,
  });
  const requiresLongRunningTask = shouldTriggerLongRunning({
    runtimeMode,
    intent,
    hints,
  });

  return {
    intent,
    secondaryIntents: [],
    goal: String(context.userInput || '').trim() || '处理当前用户请求',
    deliverables: [],
    requiredCapabilities: DEFAULT_CAPABILITIES_BY_MODE[runtimeMode],
    recommendedRole,
    requiresLongRunningTask,
    requiresMultiAgent,
    requiresHumanApproval: hints.requiresHumanApproval,
    confidence: 1,
    reasoning: `runtime-mode-default:${runtimeMode}; intent=${intent}; role=${recommendedRole}`,
    source: 'rule',
  };
};

const resolveThinkingBudget = (runtimeMode: RuntimeMode, route: IntentRoute): ThinkingBudget => {
  if (route.requiresLongRunningTask) return 'high';
  if (route.requiresMultiAgent) return 'medium';
  if (runtimeMode === 'redclaw') return 'low';
  if (runtimeMode === 'knowledge') return 'medium';
  if (runtimeMode === 'advisor-discussion') return 'low';
  return 'low';
};

const shouldRunSubagentOrchestration = (params: {
  runtimeMode: RuntimeMode;
  route: IntentRoute;
}): boolean => {
  if (params.runtimeMode === 'background-maintenance') {
    return true;
  }
  if (params.route.intent === 'automation' || params.route.intent === 'long_running_task') {
    return true;
  }
  return params.route.requiresMultiAgent;
};

export class AgentRuntime {
  analyzeRuntimeContext(params: { runtimeContext: RuntimeContext }) {
    const route = buildDirectRoute(params.runtimeContext);
    const role = getRoleSpec(route.recommendedRole);
    const thinkingBudget = resolveThinkingBudget(params.runtimeContext.runtimeMode, route);
    const orchestrationEnabled = shouldRunSubagentOrchestration({
      runtimeMode: params.runtimeContext.runtimeMode,
      route,
    });
    return {
      route,
      role,
      thinkingBudget,
      orchestrationEnabled,
      shouldUseCoordinator: Boolean(
        params.runtimeContext.runtimeMode === 'background-maintenance'
        || route.intent === 'automation'
        || route.intent === 'long_running_task'
        || route.requiresMultiAgent
      ),
    };
  }

  async prepareExecution(params: {
    runtimeContext: RuntimeContext;
    baseSystemPrompt: string;
    llm?: {
      apiKey: string;
      baseURL: string;
      model: string;
      timeoutMs?: number;
    };
  }): Promise<PreparedRuntimeExecution> {
    const analysis = this.analyzeRuntimeContext({ runtimeContext: params.runtimeContext });
    const { route, role, thinkingBudget, orchestrationEnabled } = analysis;
    const hints = extractHints(params.runtimeContext);
    const runtime = getTaskGraphRuntime();
    const task = runtime.createInteractiveTask({
      runtimeMode: params.runtimeContext.runtimeMode,
      ownerSessionId: params.runtimeContext.sessionId,
      userInput: params.runtimeContext.userInput,
      route,
      roleId: role.roleId,
      metadata: params.runtimeContext.metadata,
    });

    runtime.startNode(task.id, 'route', route.reasoning);
    runtime.completeNode(task.id, 'route', route.reasoning);
    runtime.startNode(task.id, 'plan', `role=${role.roleId}`);
    runtime.completeNode(task.id, 'plan', `role=${role.roleId}; confidence=${route.confidence}`);

    let orchestration: PreparedRuntimeExecution['orchestration'] = null;
    let orchestrationSection = '';
    console.log('[AgentRuntime] prepared-route', {
      sessionId: params.runtimeContext.sessionId,
      runtimeMode: params.runtimeContext.runtimeMode,
      intent: route.intent,
      routeSource: route.source || 'rule',
      roleId: role.roleId,
      requiresMultiAgent: route.requiresMultiAgent,
      requiresLongRunningTask: route.requiresLongRunningTask,
      orchestrationEnabled,
    });

    if (orchestrationEnabled && params.llm?.apiKey && params.llm?.baseURL && params.llm?.model) {
      try {
        runtime.addTrace(task.id, 'runtime.orchestration_start', {
          intent: route.intent,
          roleId: role.roleId,
        }, 'spawn_agents');
        const orchestrationResult = await runSubagentOrchestration({
          llm: params.llm,
          route,
          runtimeMode: params.runtimeContext.runtimeMode,
          taskId: task.id,
          userInput: params.runtimeContext.userInput,
          roleSequenceOverride: route.requiresMultiAgent && hints.subagentRoles.length > 0
            ? hints.subagentRoles as RoleId[]
            : undefined,
        });
        if (orchestrationResult) {
          orchestrationSection = orchestrationResult.promptSection;
          orchestration = {
            outputs: orchestrationResult.outputs,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.addTrace(task.id, 'runtime.orchestration_failed', { error: message }, 'spawn_agents');
      }
    } else if (task.graph.some((node) => node.type === 'spawn_agents')) {
      runtime.skipNode(
        task.id,
        'spawn_agents',
        orchestrationEnabled
          ? '当前未配置可用的协作 LLM，上游 orchestration 跳过'
          : '当前请求未启用 subagent orchestration',
      );
      if (task.graph.some((node) => node.type === 'handoff')) {
        runtime.skipNode(
          task.id,
          'handoff',
          orchestrationEnabled ? '未生成子角色 handoff' : '当前请求未启用 subagent handoff',
        );
      }
    }

    if (runtime.getTask(task.id)?.graph.some((node) => node.type === 'execute_tools')) {
      runtime.startNode(task.id, 'execute_tools', '准备执行主代理');
    }

    const systemPrompt = assembleRuntimeSystemPrompt({
      baseSystemPrompt: params.baseSystemPrompt,
      runtimeMode: params.runtimeContext.runtimeMode,
      route,
      role,
      task,
    });

    const systemPromptWithOrchestration = orchestrationSection
      ? `${systemPrompt}\n\n${orchestrationSection}`
      : systemPrompt;
    runtime.addTrace(task.id, 'runtime.prepared', {
      route,
      roleId: role.roleId,
      thinkingBudget,
      runtimeMode: params.runtimeContext.runtimeMode,
      orchestrationRoles: orchestration?.outputs.map((item) => item.roleId) || [],
    });

    return {
      task,
      route,
      role,
      systemPrompt: systemPromptWithOrchestration,
      thinkingBudget,
      orchestration,
    };
  }

  completeExecution(taskId: string, payload?: unknown) {
    const runtime = getTaskGraphRuntime();
    runtime.completeNode(taskId, 'execute_tools', '主代理执行完成');
    if (payload !== undefined) {
      runtime.addArtifact(taskId, {
        type: 'runtime-result',
        label: '主代理执行结果',
        metadata: payload,
      });
    }
    if (runtime.getTask(taskId)?.graph.some((node) => node.type === 'review')) {
      runtime.skipNode(taskId, 'review', '当前路径未执行独立 reviewer，默认跳过');
    }
    if (runtime.getTask(taskId)?.graph.some((node) => node.type === 'save_artifact')) {
      runtime.completeNode(taskId, 'save_artifact', '执行结果已归档');
    }
    runtime.completeTask(taskId, '运行完成');
  }

  failExecution(taskId: string, error: string) {
    getTaskGraphRuntime().failTask(taskId, error, 'execute_tools');
  }
}

let runtime: AgentRuntime | null = null;

export const getAgentRuntime = (): AgentRuntime => {
  if (!runtime) {
    runtime = new AgentRuntime();
  }
  return runtime;
};
