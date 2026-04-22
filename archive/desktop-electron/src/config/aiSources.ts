import { REDBOX_OFFICIAL_VIDEO_BASE_URL } from '../../shared/redboxVideo';

export interface AiSourcePreset {
  id: string;
  label: string;
  baseURL: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  group?: 'general' | 'coding-plan';
}

export interface AiSourceConfig {
  id: string;
  name: string;
  presetId: string;
  baseURL: string;
  apiKey: string;
  models?: string[];
  modelsMeta?: Array<{
    id: string;
    capabilities?: string[];
  }>;
  model: string;
  protocol?: 'openai' | 'anthropic' | 'gemini';
}

export const DEFAULT_AI_PRESET_ID = 'openai';

// Presets aligned with common OpenAI-compatible providers (referencing AionUi design).
export const AI_SOURCE_PRESETS: AiSourcePreset[] = [
  { id: 'redbox-official', label: 'RedBox Official', baseURL: REDBOX_OFFICIAL_VIDEO_BASE_URL, protocol: 'openai' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', protocol: 'openai' },
  { id: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com', protocol: 'anthropic' },
  { id: 'gemini', label: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' },
  { id: 'ollama-local', label: 'Ollama (Local)', baseURL: 'http://127.0.0.1:11434/v1', protocol: 'openai' },
  { id: 'lmstudio-local', label: 'LM Studio (Local)', baseURL: 'http://127.0.0.1:1234/v1', protocol: 'openai' },
  { id: 'vllm-local', label: 'vLLM (Local)', baseURL: 'http://127.0.0.1:8000/v1', protocol: 'openai' },
  { id: 'localai-local', label: 'LocalAI (Local)', baseURL: 'http://127.0.0.1:8080/v1', protocol: 'openai' },
  { id: 'llama-cpp-local', label: 'llama.cpp Server (Local)', baseURL: 'http://127.0.0.1:8080/v1', protocol: 'openai' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', protocol: 'openai' },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', protocol: 'openai' },
  { id: 'dashscope', label: 'Alibaba Bailian / DashScope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai' },
  { id: 'dashscope-coding-openai', label: 'Alibaba Bailian Coding Plan (OpenAI)', baseURL: 'https://coding.dashscope.aliyuncs.com/v1', protocol: 'openai', group: 'coding-plan' },
  { id: 'dashscope-coding-anthropic', label: 'Alibaba Bailian Coding Plan (Anthropic)', baseURL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'zhipu-coding-openai', label: 'Zhipu Coding Plan (OpenAI)', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', protocol: 'openai', group: 'coding-plan' },
  { id: 'zhipu-coding-anthropic', label: 'Zhipu Coding Plan (Anthropic)', baseURL: 'https://open.bigmodel.cn/api/anthropic', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'moonshot-cn', label: 'Moonshot (CN)', baseURL: 'https://api.moonshot.cn/v1', protocol: 'openai' },
  { id: 'moonshot-global', label: 'Moonshot (Global)', baseURL: 'https://api.moonshot.ai/v1', protocol: 'openai' },
  { id: 'kimi-coding-openai', label: 'Kimi Code (OpenAI)', baseURL: 'https://api.kimi.com/coding/v1', protocol: 'openai', group: 'coding-plan' },
  { id: 'kimi-coding-anthropic', label: 'Kimi Code (Anthropic)', baseURL: 'https://api.kimi.com/coding', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'minimax-cn', label: 'MiniMax (CN)', baseURL: 'https://api.minimaxi.com/v1', protocol: 'openai' },
  { id: 'minimax-global', label: 'MiniMax (Global)', baseURL: 'https://api.minimax.io/v1', protocol: 'openai' },
  { id: 'minimax-coding-openai', label: 'MiniMax Token Plan (OpenAI)', baseURL: 'https://api.minimaxi.com/v1', protocol: 'openai', group: 'coding-plan' },
  { id: 'minimax-coding-anthropic', label: 'MiniMax Token Plan (Anthropic)', baseURL: 'https://api.minimaxi.com/anthropic', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'siliconflow-cn', label: 'SiliconFlow (CN)', baseURL: 'https://api.siliconflow.cn/v1', protocol: 'openai' },
  { id: 'siliconflow', label: 'SiliconFlow', baseURL: 'https://api.siliconflow.com/v1', protocol: 'openai' },
  { id: 'zhipu', label: 'Zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai' },
  { id: 'xai', label: 'xAI', baseURL: 'https://api.x.ai/v1', protocol: 'openai' },
  { id: 'ark', label: 'Volcengine Ark', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai' },
  { id: 'ark-coding-openai', label: 'Volcengine Coding Plan (OpenAI)', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', protocol: 'openai', group: 'coding-plan' },
  { id: 'ark-coding-anthropic', label: 'Volcengine Coding Plan (Anthropic)', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'qianfan', label: 'Qianfan', baseURL: 'https://qianfan.baidubce.com/v2', protocol: 'openai' },
  { id: 'qianfan-coding-openai', label: 'Qianfan Coding Plan (OpenAI)', baseURL: 'https://qianfan.baidubce.com/v2/coding', protocol: 'openai', group: 'coding-plan' },
  { id: 'qianfan-coding-anthropic', label: 'Qianfan Coding Plan (Anthropic)', baseURL: 'https://qianfan.baidubce.com/anthropic/coding', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'hunyuan', label: 'Hunyuan', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', protocol: 'openai' },
  { id: 'tencent-coding-openai', label: 'Tencent Coding Plan (OpenAI)', baseURL: 'https://api.lkeap.cloud.tencent.com/coding/v3', protocol: 'openai', group: 'coding-plan' },
  { id: 'tencent-coding-anthropic', label: 'Tencent Coding Plan (Anthropic)', baseURL: 'https://api.lkeap.cloud.tencent.com/coding/anthropic', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'lingyi', label: 'Lingyi', baseURL: 'https://api.lingyiwanwu.com/v1', protocol: 'openai' },
  { id: 'poe', label: 'Poe', baseURL: 'https://api.poe.com/v1', protocol: 'openai' },
  { id: 'ppio', label: 'PPIO', baseURL: 'https://api.ppinfra.com/v3/openai', protocol: 'openai' },
  { id: 'modelscope', label: 'ModelScope', baseURL: 'https://api-inference.modelscope.cn/v1', protocol: 'openai' },
  { id: 'infiniai', label: 'InfiniAI', baseURL: 'https://cloud.infini-ai.com/maas/v1', protocol: 'openai' },
  { id: 'ctyun', label: 'Ctyun', baseURL: 'https://wishub-x1.ctyun.cn/v1', protocol: 'openai' },
  { id: 'stepfun', label: 'StepFun', baseURL: 'https://api.stepfun.com/v1', protocol: 'openai' },
  { id: 'stepfun-coding-openai', label: 'StepFun Step Plan (OpenAI)', baseURL: 'https://api.stepfun.com/step_plan/v1', protocol: 'openai', group: 'coding-plan' },
  { id: 'stepfun-coding-anthropic', label: 'StepFun Step Plan (Anthropic)', baseURL: 'https://api.stepfun.com/step_plan', protocol: 'anthropic', group: 'coding-plan' },
  { id: 'custom', label: 'Custom', baseURL: '', protocol: 'openai' },
];

const normalizeEndpoint = (endpoint: string): string => {
  const value = endpoint.trim().replace(/\/+$/, '');
  return value.toLowerCase();
};

export const findAiPresetById = (presetId: string): AiSourcePreset | undefined => {
  return AI_SOURCE_PRESETS.find((preset) => preset.id === presetId);
};

export const inferPresetIdByEndpoint = (endpoint: string): string => {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) return DEFAULT_AI_PRESET_ID;

  const exact = AI_SOURCE_PRESETS.find((preset) => {
    if (!preset.baseURL) return false;
    return normalizeEndpoint(preset.baseURL) === normalized;
  });
  if (exact) return exact.id;

  const prefixMatches = AI_SOURCE_PRESETS
    .map((preset) => {
      if (!preset.baseURL) return null;
      const presetBase = normalizeEndpoint(preset.baseURL);
      if (!presetBase) return null;
      return normalized.startsWith(presetBase)
        ? { id: preset.id, baseLength: presetBase.length }
        : null;
    })
    .filter((item): item is { id: string; baseLength: number } => Boolean(item))
    .sort((a, b) => b.baseLength - a.baseLength);

  if (prefixMatches.length > 0) {
    return prefixMatches[0].id;
  }

  const fuzzyMatches = AI_SOURCE_PRESETS
    .map((preset) => {
      if (!preset.baseURL) return null;
      const presetHost = normalizeEndpoint(preset.baseURL)
        .replace(/^https?:\/\//, '')
        .split('/')[0];
      if (!presetHost || !normalized.includes(presetHost)) return null;
      return { id: preset.id, hostLength: presetHost.length };
    })
    .filter((item): item is { id: string; hostLength: number } => Boolean(item))
    .sort((a, b) => b.hostLength - a.hostLength);

  return fuzzyMatches[0]?.id || 'custom';
};
