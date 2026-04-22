import { loadAndRenderPrompt } from '../../prompts/runtime';
import { normalizeApiBaseUrl, safeUrlJoin } from '../urlUtils';
import { getTaskGraphRuntime } from './taskGraphRuntime';
import { getRoleSpec } from './roleRegistry';
import type { IntentRoute, RoleId, RuntimeMode } from './types';
import { ROLE_OUTPUT_SCHEMA_HINT, validateSubagentOutput } from './subagentSchemas';

type RuntimeLlmConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
};

export type SubagentOutput = {
  roleId: RoleId;
  summary: string;
  artifact?: string;
  handoff?: string;
  risks?: string[];
  approved?: boolean;
  issues?: string[];
  raw?: unknown;
};

export type SubagentOrchestrationResult = {
  outputs: SubagentOutput[];
  promptSection: string;
};

const ORCHESTRATION_PROMPT_PATH = 'runtime/ai/subagent_orchestrator.txt';
const MAX_PRIOR_OUTPUTS_IN_PROMPT = 3;
const MAX_SUBAGENT_SUMMARY_CHARS = 320;
const MAX_SUBAGENT_ARTIFACT_CHARS = 220;
const MAX_SUBAGENT_HANDOFF_CHARS = 220;
const MAX_SUBAGENT_USER_INPUT_CHARS = 6000;

export const ROLE_SEQUENCE_BY_INTENT: Record<string, RoleId[]> = {
  manuscript_creation: ['planner', 'researcher', 'copywriter', 'reviewer'],
  advisor_persona: ['planner', 'researcher', 'copywriter', 'reviewer'],
  cover_generation: ['planner', 'researcher', 'image-director', 'reviewer'],
  image_creation: ['planner', 'researcher', 'image-director', 'reviewer'],
  knowledge_retrieval: ['planner', 'researcher', 'reviewer'],
  long_running_task: ['planner', 'ops-coordinator', 'reviewer'],
  automation: ['planner', 'ops-coordinator', 'reviewer'],
};

const DEFAULT_TIMEOUT_MS = 90000;

function truncateText(value: unknown, limit: number): string {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...<truncated>`;
}

function compactPriorOutputs(priorOutputs: SubagentOutput[]): string {
  if (!priorOutputs.length) {
    return '[]';
  }
  return JSON.stringify(
    priorOutputs.slice(-MAX_PRIOR_OUTPUTS_IN_PROMPT).map((output) => ({
      roleId: output.roleId,
      summary: truncateText(output.summary, MAX_SUBAGENT_SUMMARY_CHARS),
      artifact: output.artifact ? truncateText(output.artifact, MAX_SUBAGENT_ARTIFACT_CHARS) : undefined,
      handoff: output.handoff ? truncateText(output.handoff, MAX_SUBAGENT_HANDOFF_CHARS) : undefined,
      risks: Array.isArray(output.risks) ? output.risks.slice(0, 4).map((item) => truncateText(item, 80)) : [],
      approved: output.approved,
    })),
    null,
    2,
  );
}

function parseStructuredContent(raw: string): Record<string, unknown> {
  const text = String(raw || '').trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      summary: text,
    };
  }
}

function sanitizeOutput(roleId: RoleId, parsed: Record<string, unknown>): SubagentOutput {
  const summary = String(parsed.summary || '').trim();
  const artifact = typeof parsed.artifact === 'string' ? parsed.artifact.trim() : undefined;
  const handoff = typeof parsed.handoff === 'string' ? parsed.handoff.trim() : undefined;
  const risks = Array.isArray(parsed.risks)
    ? parsed.risks.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const approved = typeof parsed.approved === 'boolean'
    ? parsed.approved
    : (typeof parsed.pass === 'boolean' ? parsed.pass : undefined);
  const output: SubagentOutput = {
    roleId,
    summary,
    artifact,
    handoff,
    risks,
    approved,
    issues,
    raw: parsed,
  };
  validateSubagentOutput(roleId, output);
  return output;
}

export async function runStructuredSubagent(input: {
  llm: RuntimeLlmConfig;
  roleId: RoleId;
  route: IntentRoute;
  runtimeMode: RuntimeMode;
  taskId: string;
  userInput: string;
  priorOutputs: SubagentOutput[];
  signal?: AbortSignal;
}): Promise<SubagentOutput> {
  const role = getRoleSpec(input.roleId);
  console.log('[SubagentRuntime] start', {
    taskId: input.taskId,
    roleId: input.roleId,
    intent: input.route.intent,
    runtimeMode: input.runtimeMode,
    model: input.llm.model,
  });
  const systemPrompt = loadAndRenderPrompt(ORCHESTRATION_PROMPT_PATH, {
    role_id: role.roleId,
    role_purpose: role.purpose,
    role_directive: role.systemPrompt,
    role_handoff: role.handoffContract,
    role_output_schema: role.outputSchema,
    runtime_mode: input.runtimeMode,
    task_id: input.taskId,
    intent: input.route.intent,
    goal: input.route.goal,
    required_capabilities: input.route.requiredCapabilities.join(', '),
    previous_outputs_json: compactPriorOutputs(input.priorOutputs),
  }, role.systemPrompt);

  const payload = {
    model: input.llm.model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          `用户请求：${truncateText(input.userInput, MAX_SUBAGENT_USER_INPUT_CHARS)}`,
          `任务目标：${input.route.goal}`,
          ROLE_OUTPUT_SCHEMA_HINT[input.roleId],
          '不要输出 markdown，不要输出解释，只输出一个合法 JSON 对象。',
        ].join('\n'),
      },
    ],
  };

  const controller = new AbortController();
  const effectiveTimeoutMs = Math.max(30000, Number(input.llm.timeoutMs || DEFAULT_TIMEOUT_MS));
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);
  try {
    if (input.signal?.aborted) {
      throw new Error(`subagent ${input.roleId} cancelled before start`);
    }
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const response = await fetch(safeUrlJoin(normalizeApiBaseUrl(input.llm.baseURL), '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.llm.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`subagent ${input.roleId} failed (${response.status}): ${rawText || response.statusText}`);
    }
    const parsedOuter = JSON.parse(rawText) as any;
    const content = String(parsedOuter?.choices?.[0]?.message?.content || '').trim();
    const parsed = parseStructuredContent(content);
    const sanitized = sanitizeOutput(input.roleId, parsed);
    console.log('[SubagentRuntime] completed', {
      taskId: input.taskId,
      roleId: input.roleId,
      summary: sanitized.summary.slice(0, 160),
    });
    return sanitized;
  } catch (error) {
    if (controller.signal.aborted) {
      if (timedOut) {
        throw new Error(`subagent ${input.roleId} timed out after ${effectiveTimeoutMs}ms`);
      }
      if (input.signal?.aborted) {
        throw new Error(`subagent ${input.roleId} cancelled by coordinator`);
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function runSubagentOrchestration(input: {
  llm: RuntimeLlmConfig;
  route: IntentRoute;
  runtimeMode: RuntimeMode;
  taskId: string;
  userInput: string;
  roleSequenceOverride?: RoleId[];
}): Promise<SubagentOrchestrationResult | null> {
  const roleSequence = input.roleSequenceOverride?.length
    ? input.roleSequenceOverride
    : (ROLE_SEQUENCE_BY_INTENT[input.route.intent] || []);
  if (roleSequence.length === 0) {
    return null;
  }

  const runtime = getTaskGraphRuntime();
  runtime.startNode(input.taskId, 'spawn_agents', roleSequence.join(' -> '));
  const outputs: SubagentOutput[] = [];

  try {
    for (const roleId of roleSequence) {
      runtime.addTrace(input.taskId, 'subagent.start', { roleId, priorOutputs: outputs.length }, 'spawn_agents');
      const output = await runStructuredSubagent({
        llm: input.llm,
        roleId,
        route: input.route,
        runtimeMode: input.runtimeMode,
        taskId: input.taskId,
        userInput: input.userInput,
        priorOutputs: outputs,
      });
      outputs.push(output);
      runtime.addCheckpoint(input.taskId, 'spawn_agents', `${roleId}: ${output.summary}`, output);
      runtime.addTrace(input.taskId, 'subagent.completed', {
        roleId,
        summary: output.summary,
        handoff: output.handoff,
        artifact: output.artifact,
      }, 'spawn_agents');
    }

    runtime.completeNode(input.taskId, 'spawn_agents', `subagents=${outputs.map((item) => item.roleId).join(',')}`);
    runtime.startNode(input.taskId, 'handoff', '生成角色交接上下文');
    const promptSection = [
      '## Multi-Agent Orchestration',
      '以下是受控子角色协作产出的结构化结果。主代理必须继承这些结论，不得无故偏离：',
      ...outputs.map((item) => {
        const lines = [
          `### ${item.roleId}`,
          `- summary: ${item.summary}`,
        ];
        if (item.artifact) lines.push(`- artifact: ${item.artifact}`);
        if (item.handoff) lines.push(`- handoff: ${item.handoff}`);
        if (item.risks?.length) lines.push(`- risks: ${item.risks.join('；')}`);
        return lines.join('\n');
      }),
    ].join('\n');
    runtime.completeNode(input.taskId, 'handoff', 'subagent handoff prepared');
    return {
      outputs,
      promptSection,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[SubagentRuntime] failed', {
      taskId: input.taskId,
      intent: input.route.intent,
      error: message,
    });
    runtime.addTrace(input.taskId, 'subagent.failed', { error: message }, 'spawn_agents');
    runtime.failTask(input.taskId, message, 'spawn_agents');
    throw error;
  }
}
