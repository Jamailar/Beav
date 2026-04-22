import { loadAndRenderPrompt } from '../../prompts/runtime';
import { normalizeApiBaseUrl, safeUrlJoin } from '../urlUtils';
import type { IntentName, IntentRoute, RoleId, RuntimeContext } from './types';

type RuntimeLlmConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
};

const ROUTE_INTENT_SYSTEM_PROMPT_PATH = 'runtime/ai/route_intent_system.txt';
const ROUTE_INTENT_USER_PROMPT_PATH = 'runtime/ai/route_intent_user.txt';
const DEFAULT_ROUTE_TIMEOUT_MS = 20000;

const INTENT_NAMES: IntentName[] = [
  'direct_answer',
  'file_operation',
  'manuscript_creation',
  'image_creation',
  'cover_generation',
  'knowledge_retrieval',
  'long_running_task',
  'discussion',
  'memory_maintenance',
  'automation',
  'advisor_persona',
];

const ROLE_IDS: RoleId[] = [
  'planner',
  'researcher',
  'copywriter',
  'image-director',
  'reviewer',
  'ops-coordinator',
];

const recommendedRoleForIntent = (intent: IntentName): RoleId => {
  switch (intent) {
    case 'knowledge_retrieval':
    case 'advisor_persona':
      return 'researcher';
    case 'image_creation':
    case 'cover_generation':
      return 'image-director';
    case 'automation':
    case 'long_running_task':
    case 'memory_maintenance':
      return 'ops-coordinator';
    case 'manuscript_creation':
      return 'copywriter';
    case 'discussion':
      return 'planner';
    case 'file_operation':
    case 'direct_answer':
    default:
      return 'planner';
  }
};

const requiredCapabilitiesForIntent = (intent: IntentName): string[] => {
  switch (intent) {
    case 'manuscript_creation':
      return ['planning', 'writing', 'artifact-save'];
    case 'image_creation':
    case 'cover_generation':
      return ['planning', 'image-generation', 'artifact-save'];
    case 'knowledge_retrieval':
    case 'advisor_persona':
      return ['knowledge-retrieval', 'evidence-synthesis'];
    case 'automation':
    case 'long_running_task':
      return ['task-graph', 'background-runner', 'artifact-save'];
    case 'memory_maintenance':
      return ['memory-read', 'memory-write', 'profile-doc'];
    case 'discussion':
      return ['multi-agent-discussion'];
    case 'file_operation':
      return ['file-read-write'];
    default:
      return ['direct-answer'];
  }
};

const normalizeIntentName = (value: unknown): IntentName | null => {
  const text = String(value || '').trim() as IntentName;
  return INTENT_NAMES.includes(text) ? text : null;
};

const normalizeRoleId = (value: unknown): RoleId | null => {
  const text = String(value || '').trim() as RoleId;
  return ROLE_IDS.includes(text) ? text : null;
};

const normalizeIntentList = (value: unknown): IntentName[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeIntentName(item))
    .filter((item): item is IntentName => Boolean(item));
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 16);
};

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  const text = String(raw || '').trim();
  if (!text) return null;

  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return null;
};

const inferStructuredIntent = (context: RuntimeContext): IntentName => {
  const metadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata as Record<string, unknown>
    : {};
  const forcedIntent = normalizeIntentName(metadata.intent);
  if (forcedIntent) return forcedIntent;
  switch (context.runtimeMode) {
    case 'background-maintenance':
      return 'automation';
    case 'knowledge':
      return 'knowledge_retrieval';
    case 'chatroom':
    case 'advisor-discussion':
      return 'discussion';
    case 'redclaw':
    default:
      break;
  }
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
  return context.runtimeMode === 'redclaw' ? 'manuscript_creation' : 'direct_answer';
};

const shouldRequireMultiAgent = (context: RuntimeContext, intent: IntentName): boolean => {
  const metadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata as Record<string, unknown>
    : {};
  if (Boolean(metadata.forceMultiAgent)) return true;
  if (context.runtimeMode === 'chatroom') return true;
  if (intent === 'advisor_persona') return true;
  return Array.isArray(metadata.subagentRoles) && metadata.subagentRoles.length > 0;
};

const shouldRequireLongRunningTask = (context: RuntimeContext, intent: IntentName): boolean => {
  const metadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata as Record<string, unknown>
    : {};
  if (Boolean(metadata.forceLongRunningTask)) return true;
  if (context.runtimeMode === 'background-maintenance') return true;
  if (intent === 'long_running_task' || intent === 'automation') return true;
  if (metadata.longCycleTaskId || metadata.longCycleRound || metadata.longCycleStep) return true;
  return Boolean(metadata.scheduledTaskId || metadata.automationId || metadata.runnerReason);
};

const buildFallbackRoute = (context: RuntimeContext): IntentRoute => {
  const input = String(context.userInput || '').trim();
  const metadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata as Record<string, unknown>
    : {};
  const contextType = String((metadata.contextType as string) || '').trim().toLowerCase();
  const intent = inferStructuredIntent(context);
  const recommendedRole = recommendedRoleForIntent(intent);
  const requiresLongRunningTask = shouldRequireLongRunningTask(context, intent);
  const requiresMultiAgent = shouldRequireMultiAgent(context, intent);
  const requiresHumanApproval = Boolean(metadata.requiresHumanApproval);

  return {
    intent,
    secondaryIntents: [],
    goal: input || '处理当前用户请求',
    deliverables: [],
    requiredCapabilities: requiredCapabilitiesForIntent(intent),
    recommendedRole,
    requiresLongRunningTask,
    requiresMultiAgent,
    requiresHumanApproval,
    confidence: intent === 'direct_answer' ? 0.55 : 0.82,
    reasoning: `rule-fallback:intent=${intent}; contextType=${contextType || 'none'}; role=${recommendedRole}`,
    source: 'rule',
  };
};

const validateLlmRoute = (parsed: Record<string, unknown>, fallback: IntentRoute): IntentRoute | null => {
  const intent = normalizeIntentName(parsed.primary_intent || parsed.intent);
  const recommendedRole = normalizeRoleId(parsed.recommended_role || parsed.role_id);
  if (!intent || !recommendedRole) {
    return null;
  }

  const goal = String(parsed.goal || parsed.primary_goal || fallback.goal || '').trim();
  const confidenceRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : fallback.confidence;

  return {
    intent,
    secondaryIntents: normalizeIntentList(parsed.secondary_intents),
    goal: goal || fallback.goal,
    deliverables: normalizeStringList(parsed.deliverables),
    requiredCapabilities: normalizeStringList(parsed.required_capabilities).length
      ? normalizeStringList(parsed.required_capabilities)
      : requiredCapabilitiesForIntent(intent),
    recommendedRole,
    requiresLongRunningTask: parsed.requires_long_running_task === undefined
      ? fallback.requiresLongRunningTask
      : Boolean(parsed.requires_long_running_task),
    requiresMultiAgent: parsed.requires_multi_agent === undefined
      ? fallback.requiresMultiAgent
      : Boolean(parsed.requires_multi_agent),
    requiresHumanApproval: parsed.requires_human_approval === undefined
      ? fallback.requiresHumanApproval
      : Boolean(parsed.requires_human_approval),
    confidence,
    reasoning: String(parsed.reasoning || parsed.route_reasoning || '').trim() || fallback.reasoning,
    source: 'llm+rule',
  };
};

const callLlmRouter = async (params: {
  context: RuntimeContext;
  llm: RuntimeLlmConfig;
  fallback: IntentRoute;
}): Promise<IntentRoute | null> => {
  const systemPrompt = loadAndRenderPrompt(ROUTE_INTENT_SYSTEM_PROMPT_PATH, {}, [
    'You are the intent router for RedBox.',
    'Return strict JSON only.',
  ].join('\n'));
  const userPrompt = loadAndRenderPrompt(ROUTE_INTENT_USER_PROMPT_PATH, {
    runtime_mode: params.context.runtimeMode,
    user_input: params.context.userInput,
    context_type: String((params.context.metadata?.contextType as string) || ''),
    context_id: String((params.context.metadata?.contextId as string) || ''),
    associated_file_path: String((params.context.metadata?.associatedFilePath as string) || ''),
    fallback_intent: params.fallback.intent,
    fallback_role: params.fallback.recommendedRole,
    fallback_reasoning: params.fallback.reasoning,
    intent_names: INTENT_NAMES.join(', '),
    role_ids: ROLE_IDS.join(', '),
  }, [
    'User input:',
    '{{user_input}}',
  ].join('\n'));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(8000, Number(params.llm.timeoutMs || DEFAULT_ROUTE_TIMEOUT_MS)));
  try {
    const commonMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const attempt = async (body: Record<string, unknown>) => {
      const response = await fetch(safeUrlJoin(normalizeApiBaseUrl(params.llm.baseURL), '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const rawText = await response.text().catch(() => '');
      return { response, rawText };
    };

    let firstAttempt = await attempt({
      model: params.llm.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: commonMessages,
    });

    if (!firstAttempt.response.ok) {
      const lower = `${firstAttempt.rawText} ${firstAttempt.response.statusText}`.toLowerCase();
      const responseFormatRejected = lower.includes('response_format') || lower.includes('json_object');
      if (responseFormatRejected) {
        firstAttempt = await attempt({
          model: params.llm.model,
          temperature: 0,
          messages: commonMessages,
        });
      }
    }

    if (!firstAttempt.response.ok) {
      throw new Error(`intent-router failed (${firstAttempt.response.status}): ${firstAttempt.rawText || firstAttempt.response.statusText}`);
    }

    const parsedOuter = parseJsonObject(firstAttempt.rawText);
    const content = parsedOuter
      ? String((parsedOuter.choices as any)?.[0]?.message?.content || '')
      : '';
    const parsed = parseJsonObject(content);
    if (!parsed) {
      throw new Error(`intent-router returned non-json content: ${content.slice(0, 400)}`);
    }
    return validateLlmRoute(parsed, params.fallback);
  } finally {
    clearTimeout(timeout);
  }
};

export const routeIntent = async (params: {
  context: RuntimeContext;
  llm?: RuntimeLlmConfig;
}): Promise<IntentRoute> => {
  const fallback = buildFallbackRoute(params.context);
  if (!params.llm?.apiKey || !params.llm.baseURL || !params.llm.model) {
    return fallback;
  }

  try {
    const routed = await callLlmRouter({
      context: params.context,
      llm: params.llm,
      fallback,
    });
    if (routed) {
      return routed;
    }
  } catch (error) {
    console.warn('[IntentRouter] llm-route-failed', {
      sessionId: params.context.sessionId,
      runtimeMode: params.context.runtimeMode,
      error: error instanceof Error ? error.message : String(error),
      fallbackIntent: fallback.intent,
    });
  }

  return fallback;
};
