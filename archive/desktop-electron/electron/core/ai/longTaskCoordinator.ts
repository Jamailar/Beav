import {
  addChatMessage,
  createChatSession,
  getChatMessages,
  getChatSession,
  getSettings,
  getWorkspacePaths,
} from '../../db';
import { getBackgroundTaskRegistry } from '../backgroundTaskRegistry';
import { getHeadlessTaskSupervisor } from '../headlessTaskSupervisor';
import { resolveScopedModelName, type ModelScope } from '../modelScopeSettings';
import { QueryRuntime } from '../queryRuntime';
import { SkillManager } from '../skillManager';
import {
  ToolConfirmationOutcome,
  ToolExecutor,
  ToolRegistry,
} from '../toolRegistry';
import { createBuiltinTools } from '../tools';
import { normalizeApiBaseUrl } from '../urlUtils';
import { getSessionRuntimeStore } from '../sessionRuntimeStore';
import { assembleRuntimeSystemPrompt } from './contextAssembler';
import { getRoleSpec } from './roleRegistry';
import { ROLE_SEQUENCE_BY_INTENT, runStructuredSubagent, type SubagentOutput } from './subagentRuntime';
import { getTaskGraphRuntime } from './taskGraphRuntime';
import type { AgentTaskSnapshot, RoleId, RuntimeMode } from './types';
import type { RuntimeEvent } from '../runtimeTypes';
import type { BuiltinToolPack } from '../tools/catalog';

const PREP_ROLE_SEQUENCE_BY_INTENT: Partial<Record<NonNullable<AgentTaskSnapshot['intent']>, RoleId[]>> = {
  manuscript_creation: ['planner', 'researcher', 'copywriter'],
  advisor_persona: ['planner', 'researcher', 'copywriter'],
  cover_generation: ['planner', 'researcher', 'image-director'],
  image_creation: ['planner', 'researcher', 'image-director'],
  knowledge_retrieval: ['planner', 'researcher'],
  long_running_task: ['planner', 'ops-coordinator'],
  automation: ['planner', 'ops-coordinator'],
};

const PREP_ROLE_BATCHES_BY_INTENT: Partial<Record<NonNullable<AgentTaskSnapshot['intent']>, RoleId[][]>> = {
  manuscript_creation: [['planner'], ['researcher'], ['copywriter']],
  advisor_persona: [['planner'], ['researcher'], ['copywriter']],
  cover_generation: [['planner'], ['researcher', 'image-director']],
  image_creation: [['planner'], ['researcher', 'image-director']],
  knowledge_retrieval: [['planner'], ['researcher']],
  long_running_task: [['planner'], ['ops-coordinator']],
  automation: [['planner'], ['ops-coordinator']],
};

const MODEL_SCOPE_BY_MODE: Record<RuntimeMode, ModelScope> = {
  redclaw: 'redclaw',
  knowledge: 'knowledge',
  chatroom: 'chatroom',
  'advisor-discussion': 'chatroom',
  'background-maintenance': 'redclaw',
};

type CoordinatorRunOptions = {
  emitChatEvent?: (channel: string, data: unknown) => void;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  baseSystemPrompt?: string;
};

type BatchSubagentInput = {
  sourceContext: string;
  batchIndex: number;
  batchRoles: RoleId[];
};

type LlmConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
};

type SubagentBatchResult = {
  roleId: RoleId;
  output: SubagentOutput;
};

type CoordinatorChatErrorPayload = {
  message: string;
  raw: string;
  hint: string;
  category: 'execution' | 'validation';
};

type CoordinatorSourceContext = {
  sourceContext: string;
  attachmentType: string | null;
  hasReferenceMaterials: boolean;
};

const normalizeRoleSequence = (task: AgentTaskSnapshot, context?: CoordinatorSourceContext): RoleId[] => {
  const byIntent = PREP_ROLE_SEQUENCE_BY_INTENT[task.intent as keyof typeof PREP_ROLE_SEQUENCE_BY_INTENT];
  if (byIntent && byIntent.length > 0) {
    if (
      task.intent === 'manuscript_creation'
      && context?.attachmentType === 'wander-references'
      && context.hasReferenceMaterials
    ) {
      return byIntent.filter((roleId) => roleId !== 'planner');
    }
    return byIntent;
  }
  const fallback = ROLE_SEQUENCE_BY_INTENT[task.taskType] || [];
  return fallback.filter((roleId) => roleId !== 'reviewer');
};

const normalizeRoleBatches = (task: AgentTaskSnapshot, context?: CoordinatorSourceContext): RoleId[][] => {
  const byIntent = PREP_ROLE_BATCHES_BY_INTENT[task.intent as keyof typeof PREP_ROLE_BATCHES_BY_INTENT];
  if (byIntent && byIntent.length > 0) {
    if (
      task.intent === 'manuscript_creation'
      && context?.attachmentType === 'wander-references'
      && context.hasReferenceMaterials
    ) {
      return byIntent.filter((batch) => !batch.includes('planner'));
    }
    return byIntent;
  }
  return normalizeRoleSequence(task, context).map((roleId) => [roleId]);
};

const inferArtifactType = (roleId: RoleId): string => {
  switch (roleId) {
    case 'planner':
      return 'plan';
    case 'researcher':
      return 'research-note';
    case 'copywriter':
      return 'manuscript';
    case 'image-director':
      return 'image-plan';
    case 'ops-coordinator':
      return 'ops-report';
    case 'reviewer':
      return 'review-report';
    default:
      return 'artifact';
  }
};

const buildCoordinatorChatErrorPayload = (params: {
  message: string;
  raw: string;
  hint: string;
  category: 'execution' | 'validation';
}): CoordinatorChatErrorPayload => ({
  message: params.message,
  raw: params.raw,
  hint: params.hint,
  category: params.category,
});

const buildCoordinatorError = (params: {
  message: string;
  raw: string;
  hint: string;
  category: 'execution' | 'validation';
}): Error => Object.assign(new Error(params.raw), {
  chatErrorMessage: params.message,
  chatErrorHint: params.hint,
  chatErrorCategory: params.category,
});

const normalizeBuiltinPack = (value: string): BuiltinToolPack => {
  if (value === 'redclaw' || value === 'knowledge' || value === 'chatroom' || value === 'diagnostics' || value === 'full') {
    return value;
  }
  return 'redclaw';
};

const shouldUseCoordinator = (task: AgentTaskSnapshot): boolean => {
  return Boolean(task.route?.requiresLongRunningTask || task.route?.requiresMultiAgent);
};

const buildCoordinatorSourceContext = (sessionId: string): CoordinatorSourceContext => {
  const messages = getChatMessages(sessionId);
  const latestUser = [...messages].reverse().find((item) => item.role === 'user' && String(item.content || '').trim());
  if (!latestUser) {
    return {
      sourceContext: '',
      attachmentType: null,
      hasReferenceMaterials: false,
    };
  }

  const sections: string[] = [];
  const userContent = String(latestUser.content || '').trim();
  let attachmentType: string | null = null;
  let hasReferenceMaterials = false;
  if (userContent) {
    sections.push('## Original User Request');
    sections.push(userContent.slice(0, 6000));
  }

  const attachmentRaw = String(latestUser.attachment || '').trim();
  if (attachmentRaw) {
    try {
      const attachment = JSON.parse(attachmentRaw) as Record<string, unknown>;
      attachmentType = String(attachment?.type || '').trim() || null;
      if (attachment?.type === 'wander-references' && Array.isArray(attachment.items)) {
        const items = attachment.items as Array<Record<string, unknown>>;
        hasReferenceMaterials = items.length > 0;
        sections.push('');
        sections.push('## Attached Reference Materials');
        sections.push(...items.map((item, index) => [
          `${index + 1}. ${String(item.title || '(无标题)')}`,
          `- type: ${String(item.itemType || 'unknown')}`,
          `- tag: ${String(item.tag || '') || '未标记'}`,
          `- folderPath: ${String(item.folderPath || '').trim() || '(missing)'}`,
          `- summary: ${String(item.summary || '').trim() || '(none)'}`,
        ].join('\n')));
      }
      if (attachment?.type === 'uploaded-file') {
        sections.push('');
        sections.push('## Uploaded File');
        sections.push(`- name: ${String(attachment.name || '').trim() || '(unknown)'}`);
        sections.push(`- absolutePath: ${String(attachment.absolutePath || '').trim() || '(missing)'}`);
        sections.push(`- kind: ${String(attachment.kind || '').trim() || 'unknown'}`);
        if (String(attachment.summary || '').trim()) {
          sections.push(`- summary: ${String(attachment.summary || '').trim()}`);
        }
      }
    } catch {
      // ignore invalid attachment payload
    }
  }

  return {
    sourceContext: sections.filter(Boolean).join('\n'),
    attachmentType,
    hasReferenceMaterials,
  };
};

const buildExecutionPrompt = (task: AgentTaskSnapshot, outputs: SubagentOutput[], sourceContext?: string): string => {
  const sections = [
    `当前任务目标：${task.goal || task.route?.goal || task.taskType}`,
    '',
    sourceContext ? sourceContext : '',
    sourceContext ? '' : '',
    '请严格按照以下多角色协作结果执行，不要跳过落盘和工具回执校验：',
    ...outputs.map((output) => {
      const lines = [
        `### ${output.roleId}`,
        `- summary: ${output.summary}`,
      ];
      if (output.artifact) lines.push(`- artifact: ${output.artifact}`);
      if (output.handoff) lines.push(`- handoff: ${output.handoff}`);
      if (output.risks?.length) lines.push(`- risks: ${output.risks.join('；')}`);
      return lines.join('\n');
    }),
    '',
    '执行要求：',
    '- 先完成当前最关键的执行动作，再给出结果。',
    '- 对创作任务，必须优先读取原始素材，不得只依赖子 agent 摘要和推断。',
    '- 如果用户消息或附件里给了明确文件夹/文件路径，先读取这些路径对应的内容，再开始写作。',
    '- 如果形成了稿件、配图方案或自动化动作，必须推动保存并给出真实工具回执。',
    '- 若当前任务是稿件创作且没有 projectId，必须调用 `app_cli(command="manuscripts write --path ...", payload={ content: "完整 markdown" })` 落盘。',
    '- 未收到工具成功返回前，禁止声称“已经保存”。',
    '- 如果工具没有成功，不得宣称成功。',
  ];
  return sections.join('\n');
};


const buildSubagentUserInput = (task: AgentTaskSnapshot, route: NonNullable<AgentTaskSnapshot['route']>, roleId: RoleId, priorOutputs: SubagentOutput[], input: BatchSubagentInput): string => {
  const truncate = (value: string, limit: number): string => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...<truncated>`;
  };
  const sections = [
    `Current task intent: ${task.intent || task.taskType}`,
    `Current role: ${roleId}`,
    `Goal: ${route.goal}`,
    `Batch: ${input.batchIndex + 1} / roles=${input.batchRoles.join(',')}`,
  ];

  if (input.sourceContext.trim()) {
    sections.push('', truncate(input.sourceContext.trim(), 3500));
  }

  sections.push(
    '',
    'Hard requirements:',
    '- You must reason over the original user request and attached file/folder references, not only the short goal line.',
    '- If explicit file or folder paths are present, treat them as mandatory evidence to read in the later execution chain.',
    '- Do not claim files are already read or saved unless the later execution agent can prove it via tool results.',
    priorOutputs.length > 0 ? `- Prior subagent context has already been summarized into the system prompt; reuse it instead of repeating it.` : '',
  );

  return sections.filter(Boolean).join('\n');
};

const isReviewerApproved = (review: SubagentOutput): boolean => {
  if (typeof review.approved === 'boolean') return review.approved;
  const raw = (review.raw && typeof review.raw === 'object') ? review.raw as Record<string, unknown> : null;
  if (raw && raw.approved === false) return false;
  if (raw && raw.pass === false) return false;
  const summary = String(review.summary || '').toLowerCase();
  if (summary.includes('未通过') || summary.includes('fail') || summary.includes('不满足')) {
    return false;
  }
  return true;
};

const hasSuccessfulManuscriptWrite = (sessionId: string): boolean => {
  const toolResults = getSessionRuntimeStore().listToolResults(sessionId, 20);
  return [...toolResults].reverse().some((result) => {
    if (!result.success) return false;
    if (result.toolName !== 'app_cli') return false;
    const command = String(result.command || '').trim().toLowerCase();
    const resultText = String(result.resultText || result.summaryText || result.promptText || '').toLowerCase();
    return command.startsWith('manuscripts write') || resultText.includes('manuscript saved successfully');
  });
};

const buildSaveRepairPrompt = (): string => [
  'Save repair mode:',
  '- The manuscript content is already being discussed in the current session context.',
  '- Do not restart planning or rewrite everything from scratch unless absolutely necessary.',
  '- Your primary job is to save the current manuscript to the manuscripts workspace now.',
  '- You must call app_cli manuscripts write and wait for a real success response before claiming completion.',
  '- After save succeeds, report the real saved path and nothing speculative.',
].join('\n');

const buildReviewerInput = (executionResponse: string, sessionId: string): string => {
  const recentToolResults = getSessionRuntimeStore().listToolResults(sessionId, 12).slice(-8);
  const toolEvidence = recentToolResults.length > 0
    ? recentToolResults.map((result) => {
      const command = result.command ? `command=${result.command}` : '';
      const summary = String(result.summaryText || result.promptText || result.resultText || '').slice(0, 320);
      return `- ${result.toolName} [${result.success ? 'ok' : 'fail'}] ${command} ${summary}`.trim();
    }).join('\n')
    : '(no tool results captured)';
  return [
    '请审核以下执行结果是否满足目标：',
    executionResponse,
    '',
    '## Tool Evidence',
    toolEvidence,
  ].join('\n');
};

const forwardRuntimeEventToChat = (event: RuntimeEvent, emit?: (channel: string, data: unknown) => void) => {
  if (!emit) return;
  switch (event.type) {
    case 'thinking':
      emit('chat:thought-delta', { content: event.content });
      break;
    case 'response_chunk':
      emit('chat:response-chunk', { content: event.content });
      break;
    case 'response_end':
      emit('chat:response-end', { content: event.content });
      break;
    case 'tool_start':
      emit('chat:tool-start', {
        callId: event.callId,
        name: event.name,
        input: event.params,
        description: event.description,
      });
      break;
    case 'tool_output':
      emit('chat:tool-update', {
        callId: event.callId,
        name: event.name,
        partial: event.chunk,
      });
      break;
    case 'tool_end':
      emit('chat:tool-end', {
        callId: event.callId,
        name: event.name,
        output: {
          success: event.result.success,
          content: event.result.display || event.result.llmContent || event.result.error?.message || '',
        },
      });
      break;
    case 'compact_start':
      emit('chat:thought-delta', { content: `上下文整理中（${event.strategy}）...` });
      break;
    case 'error':
      emit('chat:error', buildCoordinatorChatErrorPayload({
        message: '任务执行失败',
        raw: event.message,
        hint: '执行阶段发生错误，请检查素材读取、工具调用、文件路径或权限。',
        category: 'execution',
      }));
      break;
    default:
      break;
  }
};

const emitCoordinatorThought = (content: string, options: CoordinatorRunOptions) => {
  if (options.onRuntimeEvent) {
    options.onRuntimeEvent({ type: 'thinking', phase: 'analyze', content });
    return;
  }
  options.emitChatEvent?.('chat:thought-delta', { content });
};

const emitCoordinatorPhase = (name: string, options: CoordinatorRunOptions) => {
  options.emitChatEvent?.('chat:phase-start', { name });
};

const getCoordinatorPhaseLabel = (batch: RoleId[]): string => {
  if (batch.length === 1) {
    switch (batch[0]) {
      case 'planner':
        return '规划执行方案';
      case 'researcher':
        return '读取素材与提炼要点';
      case 'copywriter':
        return '生成文案初稿';
      case 'reviewer':
        return '复核执行结果';
      case 'image-director':
        return '构思视觉方案';
      case 'ops-coordinator':
        return '编排执行任务';
      default:
        return `子角色处理中：${batch[0]}`;
    }
  }
  return `并行处理中：${batch.join(' / ')}`;
};

export class LongTaskCoordinator {
  private readonly inflightRuns = new Map<string, Promise<AgentTaskSnapshot | null>>();

  private async runSubagentBatchWithRetry(input: {
    llm: LlmConfig;
    task: AgentTaskSnapshot;
    route: NonNullable<AgentTaskSnapshot['route']>;
    batch: RoleId[];
    priorOutputs: SubagentOutput[];
    backgroundTaskId: string;
    signal: AbortSignal;
    options: CoordinatorRunOptions;
    maxAttempts?: number;
    sourceContext: string;
    batchIndex: number;
  }): Promise<SubagentBatchResult[]> {
    const runtime = getTaskGraphRuntime();
    const backgroundRegistry = getBackgroundTaskRegistry();
    const maxAttempts = Math.max(1, Number(input.maxAttempts || 2));
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (input.signal.aborted) {
        throw new Error('Coordinator cancelled');
      }
      runtime.addTrace(input.task.id, 'coordinator.batch.attempt', {
        batch: input.batch,
        attempt,
        priorOutputs: input.priorOutputs.length,
      }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
      await backgroundRegistry.appendTurn(input.backgroundTaskId, {
        source: 'system',
        text: `[coordinator] batch ${input.batch.join(',')} attempt ${attempt}/${maxAttempts}`,
      });

      try {
        const batchController = new AbortController();
        const abortBatch = () => {
          if (!batchController.signal.aborted) {
            batchController.abort();
          }
        };
        const onParentAbort = () => abortBatch();
        input.signal.addEventListener('abort', onParentAbort, { once: true });
        const batchInput: BatchSubagentInput = {
          sourceContext: input.sourceContext,
          batchIndex: input.batchIndex,
          batchRoles: input.batch,
        };
        const rolePromises = input.batch.map(async (roleId) => {
          runtime.addTrace(input.task.id, 'coordinator.role.started', {
            roleId,
            priorOutputs: input.priorOutputs.length,
            batch: input.batch,
            attempt,
          }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
          try {
            const output = await runStructuredSubagent({
              llm: input.llm,
              roleId,
              route: input.route,
              runtimeMode: input.task.runtimeMode,
              taskId: input.task.id,
              userInput: buildSubagentUserInput(input.task, input.route, roleId, input.priorOutputs, batchInput),
              priorOutputs: input.priorOutputs,
              signal: batchController.signal,
            });
            return { roleId, output };
          } catch (error) {
            abortBatch();
            throw error;
          }
        });
        let results: SubagentBatchResult[];
        try {
          results = await Promise.all(rolePromises);
        } catch (error) {
          await Promise.allSettled(rolePromises);
          throw error;
        } finally {
          input.signal.removeEventListener('abort', onParentAbort);
        }
        runtime.addTrace(input.task.id, 'coordinator.batch.succeeded', {
          batch: input.batch,
          attempt,
        }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
        return results;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        runtime.addTrace(input.task.id, 'coordinator.batch.failed', {
          batch: input.batch,
          attempt,
          error: lastError.message,
        }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
        await backgroundRegistry.appendTurn(input.backgroundTaskId, {
          source: 'system',
          text: `[coordinator] batch ${input.batch.join(',')} failed on attempt ${attempt}: ${lastError.message}`,
        });
        if (attempt >= maxAttempts) {
          break;
        }
        emitCoordinatorThought(`${input.batch.join(' / ')} 失败，正在重试第 ${attempt + 1} 次...`, input.options);
      }
    }

    throw lastError || new Error(`subagent batch failed: ${input.batch.join(',')}`);
  }

  async maybeRun(taskId: string, options: CoordinatorRunOptions = {}): Promise<AgentTaskSnapshot | null> {
    const existing = this.inflightRuns.get(taskId);
    if (existing) {
      return existing;
    }

    const runPromise = this.runMaybeRun(taskId, options)
      .finally(() => {
        this.inflightRuns.delete(taskId);
      });
    this.inflightRuns.set(taskId, runPromise);
    return runPromise;
  }

  private async runMaybeRun(taskId: string, options: CoordinatorRunOptions = {}): Promise<AgentTaskSnapshot | null> {
    const runtime = getTaskGraphRuntime();
    const task = runtime.getTask(taskId);
    if (!task) return null;
    if (!shouldUseCoordinator(task)) {
      return runtime.resumeTask(taskId);
    }

    const llm = this.resolveLlmConfig(task.runtimeMode);
    const backgroundRegistry = getBackgroundTaskRegistry();
    const existingBgTask = await backgroundRegistry.getTask(task.id);
    const backgroundTask = (!existingBgTask || existingBgTask.status !== 'running')
      ? await backgroundRegistry.registerTask({
          kind: 'headless-runtime',
          title: `Coordinator · ${task.goal || task.taskType}`,
          contextId: task.ownerSessionId || task.id,
          sessionId: task.ownerSessionId || undefined,
        })
      : existingBgTask;

    await getHeadlessTaskSupervisor().run({
      taskId: backgroundTask.id,
      title: `Coordinator ${task.goal || task.taskType}`,
      backoff: {
        initialDelayMs: 1000,
        maxDelayMs: 15000,
        maxAttempts: 2,
        giveUpAfterMs: 6 * 60 * 1000,
        timeoutMs: 2 * 60 * 1000,
      },
      execute: async (signal) => {
        await this.executeCoordinatedTask(taskId, backgroundTask.id, llm, signal, options);
        return true;
      },
    });
    return runtime.getTask(taskId);
  }

  private resolveLlmConfig(runtimeMode: RuntimeMode): LlmConfig {
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = String(settings.api_key || '').trim();
    const baseURL = normalizeApiBaseUrl(String(settings.api_endpoint || '').trim(), 'https://api.openai.com/v1');
    const model = resolveScopedModelName(settings, MODEL_SCOPE_BY_MODE[runtimeMode], String(settings.model_name || 'gpt-4o-mini'));
    if (!apiKey) {
      throw new Error('Coordinator missing api key');
    }
    return {
      apiKey,
      baseURL,
      model,
      timeoutMs: 90000,
    };
  }

  private ensureOwnerSession(task: AgentTaskSnapshot): string {
    const sessionId = String(task.ownerSessionId || `session_${Date.now()}`).trim();
    if (!getChatSession(sessionId)) {
      createChatSession(sessionId, task.goal || task.taskType, {
        contextType: task.runtimeMode,
        contextId: task.id,
      });
    }
    return sessionId;
  }

  private async executeCoordinatedTask(taskId: string, backgroundTaskId: string, llm: LlmConfig, signal: AbortSignal, options: CoordinatorRunOptions = {}): Promise<void> {
    const runtime = getTaskGraphRuntime();
    const backgroundRegistry = getBackgroundTaskRegistry();
    const task = runtime.getTask(taskId);
    if (!task || !task.route) {
      throw new Error(`Coordinator task not found: ${taskId}`);
    }
    const route = task.route;

    const sessionId = this.ensureOwnerSession(task);
    await backgroundRegistry.attachSession(backgroundTaskId, sessionId);
    emitCoordinatorPhase('协调器已接管', options);
    options.emitChatEvent?.('chat:thought-start', {});
    emitCoordinatorThought('正在读取任务上下文并准备协作链路...', options);
    await backgroundRegistry.appendTurn(backgroundTaskId, {
      source: 'system',
      text: '[coordinator] long task planning started',
    });

    const coordinatorContext = buildCoordinatorSourceContext(sessionId);
    const prepRoles = normalizeRoleSequence(task, coordinatorContext);
    const prepRoleBatches = normalizeRoleBatches(task, coordinatorContext);
    const outputs: SubagentOutput[] = [];
    const sourceContext = coordinatorContext.sourceContext;

    if (prepRoles.length === 0) {
      emitCoordinatorPhase('进入主执行链路', options);
      emitCoordinatorThought('当前任务无需预备分工，直接开始执行。', options);
    } else {
      const plannerSkipped = !prepRoles.includes('planner')
        && task.intent === 'manuscript_creation'
        && coordinatorContext.attachmentType === 'wander-references';
      emitCoordinatorPhase(plannerSkipped ? '跳过规划，直接处理素材' : '准备协作分工', options);
      emitCoordinatorThought(
        plannerSkipped
          ? '已检测到漫步参考素材，跳过 planner，直接进入素材读取与文案生成。'
          : `已进入多角色协作，准备角色：${prepRoles.join(' -> ')}`,
        options,
      );
    }

    runtime.addTrace(task.id, 'coordinator.start', {
      route: task.route,
      prepRoles,
      prepRoleBatches,
      runtimeMode: task.runtimeMode,
    }, 'plan');

    for (const [batchIndex, batch] of prepRoleBatches.entries()) {
      if (signal.aborted) {
        throw new Error('Coordinator cancelled');
      }
      const isPlannerBatch = batch.length === 1 && batch[0] === 'planner';
      emitCoordinatorPhase(getCoordinatorPhaseLabel(batch), options);
      if (isPlannerBatch) {
        runtime.startNode(task.id, 'plan', 'coordinator planner running');
      } else if (task.graph.some((node) => node.type === 'spawn_agents' && node.status !== 'completed')) {
        runtime.startNode(task.id, 'spawn_agents', `running ${batch.join(',')}`);
      }

      const priorOutputs = [...outputs];
      await Promise.all(batch.map(async (roleId) => {
        await backgroundRegistry.appendTurn(backgroundTaskId, {
          source: 'thought',
          text: `[coordinator] ${roleId} 正在处理`,
        });
        emitCoordinatorThought(`${roleId} 正在规划/处理...`, options);
      }));

      const batchOutputs = await this.runSubagentBatchWithRetry({
        llm,
        task,
        route,
        batch,
        priorOutputs,
        backgroundTaskId,
        signal,
        options,
        sourceContext,
        batchIndex,
      });

      for (const { roleId, output } of batchOutputs) {
        outputs.push(output);
        runtime.addCheckpoint(task.id, roleId === 'planner' ? 'plan' : 'spawn_agents', `${roleId}: ${output.summary}`, output);
        runtime.addArtifact(task.id, {
          type: inferArtifactType(roleId),
          label: `${roleId}: ${output.summary.slice(0, 120)}`,
          metadata: output.raw,
        });
        runtime.addTrace(task.id, 'coordinator.role.completed', {
          roleId,
          summary: output.summary,
          handoff: output.handoff,
          risks: output.risks || [],
          approved: output.approved,
          issues: output.issues || [],
          batch,
        }, roleId === 'planner' ? 'plan' : 'spawn_agents');

        if (roleId === 'planner') {
          runtime.completeNode(task.id, 'plan', output.summary);
        } else if (roleId === 'researcher' && task.graph.some((node) => node.type === 'retrieve')) {
          runtime.startNode(task.id, 'retrieve', output.summary);
          runtime.completeNode(task.id, 'retrieve', output.summary);
        }
      }
    }

    if (task.graph.some((node) => node.type === 'spawn_agents')) {
      runtime.completeNode(task.id, 'spawn_agents', `subagents=${prepRoles.filter((roleId) => roleId !== 'planner').join(',')}`);
    }

    const executionPrompt = buildExecutionPrompt(task, outputs, sourceContext);
    const activeRoleId = [...outputs].reverse().find((item) => item.roleId === 'copywriter' || item.roleId === 'image-director' || item.roleId === 'ops-coordinator')?.roleId
      || task.roleId as RoleId
      || task.route.recommendedRole;
    const activeRole = getRoleSpec(activeRoleId);
    const systemPrompt = assembleRuntimeSystemPrompt({
      baseSystemPrompt: options.baseSystemPrompt || '你是 RedBox 的协调执行代理。你接收的是已经过计划和子角色拆解后的任务，必须严格按协作结果执行。',
      runtimeMode: task.runtimeMode,
      route: task.route,
      role: activeRole,
      task,
    });
    const finalSystemPrompt = `${systemPrompt}\n\n## Coordinator Handoff\n${executionPrompt}`;

    addChatMessage({
      id: `coord_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      role: 'user',
      content: executionPrompt,
    });

    const executionToolPack = normalizeBuiltinPack(activeRole.allowedToolPack);
    const toolRegistry = new ToolRegistry();
    const skillManager = new SkillManager();
    await skillManager.discoverSkills(getWorkspacePaths().base);
    toolRegistry.registerTools(createBuiltinTools({ pack: executionToolPack, skillManager }));
    const toolExecutor = new ToolExecutor(toolRegistry, async () => ToolConfirmationOutcome.ProceedOnce);

    emitCoordinatorPhase('执行与工具调用', options);
    emitCoordinatorThought('子角色预备完成，正在读取原始素材并进入执行。', options);
    runtime.startNode(task.id, 'execute_tools', `coordinator executing as ${activeRole.roleId}`);
    const queryRuntime = new QueryRuntime(
      toolRegistry,
      toolExecutor,
      {
        onEvent: (event) => {
          options.onRuntimeEvent?.(event);
          forwardRuntimeEventToChat(event, options.emitChatEvent);
          if (event.type === 'thinking') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'thought', text: event.content });
          } else if (event.type === 'tool_start') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'tool', text: `调用工具：${event.name}` });
          } else if (event.type === 'response_chunk') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'response', text: event.content });
          } else if (event.type === 'error') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'system', text: `错误：${event.message}` });
          }
        },
      },
      {
        sessionId,
        apiKey: llm.apiKey,
        baseURL: llm.baseURL,
        model: llm.model,
        systemPrompt: finalSystemPrompt,
        messages: [],
        signal,
        maxTurns: task.route.requiresLongRunningTask ? 18 : 12,
        maxTimeMinutes: task.route.requiresLongRunningTask ? 8 : 5,
        temperature: 0.3,
        toolPack: executionToolPack,
        runtimeMode: task.runtimeMode,
        interactive: true,
        requiresHumanApproval: task.route.requiresHumanApproval,
      },
    );
    const execution = await queryRuntime.run(executionPrompt);
    if (execution.error) {
      runtime.failTask(task.id, execution.error, 'execute_tools');
      await backgroundRegistry.failTask(backgroundTaskId, execution.error);
      options.emitChatEvent?.('chat:error', buildCoordinatorChatErrorPayload({
        message: '任务执行失败',
        raw: execution.error,
        hint: '执行阶段发生错误，请检查素材读取、工具调用、文件路径或权限。',
        category: 'execution',
      }));
      throw buildCoordinatorError({
        message: '任务执行失败',
        raw: execution.error,
        hint: '执行阶段发生错误，请检查素材读取、工具调用、文件路径或权限。',
        category: 'execution',
      });
    }
    runtime.completeNode(task.id, 'execute_tools', `responseLength=${execution.response.length}`);
    addChatMessage({
      id: `coord_assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      role: 'assistant',
      content: execution.response,
    });

    let repairResponse = '';
    if (task.intent === 'manuscript_creation' && !hasSuccessfulManuscriptWrite(sessionId)) {
      emitCoordinatorPhase('补保存稿件', options);
      emitCoordinatorThought('检测到稿件尚未真实落盘，正在执行强制保存步骤...', options);
      runtime.addTrace(task.id, 'coordinator.save_repair.started', {
        sessionId,
        activeRoleId: activeRole.roleId,
      }, 'save_artifact');
      await backgroundRegistry.appendTurn(backgroundTaskId, {
        source: 'system',
        text: '[coordinator] manuscript save repair started',
      });

      const repairPrompt = buildSaveRepairPrompt();
      addChatMessage({
        id: `coord_repair_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        role: 'user',
        content: repairPrompt,
      });

      const repairRuntime = new QueryRuntime(
        toolRegistry,
        toolExecutor,
        {
          onEvent: (event) => {
            options.onRuntimeEvent?.(event);
            forwardRuntimeEventToChat(event, options.emitChatEvent);
            if (event.type === 'thinking') {
              void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'thought', text: event.content });
            } else if (event.type === 'tool_start') {
              void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'tool', text: `调用工具：${event.name}` });
            } else if (event.type === 'response_chunk') {
              void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'response', text: event.content });
            } else if (event.type === 'error') {
              void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'system', text: `错误：${event.message}` });
            }
          },
        },
        {
          sessionId,
          apiKey: llm.apiKey,
          baseURL: llm.baseURL,
          model: llm.model,
          systemPrompt: `${finalSystemPrompt}

## Save Repair Pass
You are in a repair-only pass. The manuscript must be saved for real before you can conclude.`,
          messages: [],
          signal,
          maxTurns: 4,
          maxTimeMinutes: 2,
          temperature: 0.1,
          toolPack: executionToolPack,
          runtimeMode: task.runtimeMode,
          interactive: true,
          requiresHumanApproval: task.route.requiresHumanApproval,
        },
      );
      const repair = await repairRuntime.run(repairPrompt);
      if (repair.error) {
        runtime.failTask(task.id, repair.error, 'save_artifact');
        await backgroundRegistry.failTask(backgroundTaskId, repair.error);
        throw new Error(repair.error);
      }
      repairResponse = repair.response;
      addChatMessage({
        id: `coord_repair_assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        role: 'assistant',
        content: repair.response,
      });
      runtime.addTrace(task.id, 'coordinator.save_repair.completed', {
        responseLength: repair.response.length,
        hasSavedManuscript: hasSuccessfulManuscriptWrite(sessionId),
      }, 'save_artifact');
    }

    if (task.graph.some((node) => node.type === 'handoff')) {
      runtime.startNode(task.id, 'handoff', '整合下一步交接');
      runtime.completeNode(task.id, 'handoff', outputs.map((item) => `${item.roleId}:${item.handoff || item.summary}`).join(' | '));
    }

    if (task.graph.some((node) => node.type === 'review')) {
      emitCoordinatorPhase('结果复核', options);
      emitCoordinatorThought('主执行已完成，正在做最终复核。', options);
      runtime.startNode(task.id, 'review', 'reviewer validating coordinated execution');
      const reviewOutput = await runStructuredSubagent({
        llm,
        roleId: 'reviewer',
        route: task.route,
        runtimeMode: task.runtimeMode,
        taskId: task.id,
        userInput: buildReviewerInput([execution.response, repairResponse].filter(Boolean).join('\n\n'), sessionId),
        priorOutputs: [
          ...outputs,
          {
            roleId: activeRole.roleId,
            summary: execution.response.slice(0, 1200),
            artifact: execution.response,
            handoff: 'review current execution',
            raw: { executionResponse: execution.response },
          },
        ],
        signal,
      });
      runtime.addCheckpoint(task.id, 'review', reviewOutput.summary, reviewOutput);
      runtime.addArtifact(task.id, {
        type: 'review-report',
        label: `reviewer: ${reviewOutput.summary.slice(0, 120)}`,
        metadata: reviewOutput.raw,
      });
      if (!isReviewerApproved(reviewOutput)) {
        runtime.failTask(task.id, reviewOutput.summary || 'reviewer rejected execution', 'review');
        await backgroundRegistry.failTask(backgroundTaskId, reviewOutput.summary || 'reviewer rejected execution');
        throw buildCoordinatorError({
          message: '执行校验未通过',
          raw: reviewOutput.summary || 'reviewer rejected execution',
          hint: '当前结果未通过独立评审，请先修复素材读取、证据链或保存回执问题后再重试。',
          category: 'validation',
        });
      }
      runtime.completeNode(task.id, 'review', reviewOutput.summary);
    }

    if (task.intent === 'manuscript_creation' && !hasSuccessfulManuscriptWrite(sessionId)) {
      const saveError = 'coordinator execution missing successful manuscripts write tool result';
      runtime.failTask(task.id, saveError, 'save_artifact');
      await backgroundRegistry.failTask(backgroundTaskId, saveError);
      throw buildCoordinatorError({
        message: '执行校验未通过',
        raw: saveError,
        hint: '稿件内容虽然可能已生成，但没有检测到真实保存成功的工具回执。',
        category: 'validation',
      });
    }

    if (task.graph.some((node) => node.type === 'save_artifact')) {
      runtime.completeNode(task.id, 'save_artifact', 'coordinator 已记录执行产物');
    }
    runtime.completeTask(task.id, 'Coordinator multi-agent execution completed');
    options.emitChatEvent?.('chat:response-end', { content: execution.response });
    await backgroundRegistry.completeTask(backgroundTaskId, execution.response.slice(0, 240) || 'Coordinator completed');
  }
}

let longTaskCoordinator: LongTaskCoordinator | null = null;

export const getLongTaskCoordinator = (): LongTaskCoordinator => {
  if (!longTaskCoordinator) {
    longTaskCoordinator = new LongTaskCoordinator();
  }
  return longTaskCoordinator;
};
