import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import {
  hasModelCapability,
  inferModelCapabilities,
  type ModelCapability,
} from '../../shared/modelCapabilities';

export type AiProtocol = 'openai' | 'anthropic' | 'gemini';

export interface AiSourceConnectionInput {
  apiKey: string;
  baseURL: string;
  presetId?: string;
  protocol?: AiProtocol;
  purpose?: 'chat' | 'image';
}

export interface AiModelInfo {
  id: string;
  capabilities?: ModelCapability[];
}

export interface AiConnectionTestResult {
  success: boolean;
  protocol: AiProtocol;
  models: AiModelInfo[];
  message: string;
}

const GEMINI_HOST_HINTS = ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'googleapis.com'];
const ANTHROPIC_HOST_HINTS = ['anthropic.com'];
const LOCAL_HOST_HINTS = ['127.0.0.1', 'localhost', '0.0.0.0', '::1'];
const OPENAI_MODEL_PATH_HINTS = [
  '/v1',
  '/openai',
  '/api/v1',
  '/openai/v1',
  '/compatible-mode/v1',
  '/compatible-mode',
  '/compatibility/v1',
  '/v2',
  '/api/v3',
  '/v1beta/openai',
  '/api/paas/v4',
];
const IMAGE_MODEL_KEYWORDS = [
  'image',
  'dall-e',
  'dalle',
  'wan',
  'seedream',
  'banana',
  'jimeng',
  'imagen',
  'flux',
  'stable-diffusion',
  'sdxl',
  'midjourney',
  'mj',
];

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 12000): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const isLikelyLocalEndpoint = (baseURL: string): boolean => {
  const normalized = normalizeApiBaseUrl(baseURL).toLowerCase();
  if (!normalized) return false;
  return LOCAL_HOST_HINTS.some((hint) => normalized.includes(hint));
};

const isLocalPreset = (presetId?: string): boolean => {
  const normalized = String(presetId || '').trim().toLowerCase();
  return normalized.endsWith('-local') || normalized.includes('local');
};

const isGeminiOpenAiCompatibleEndpoint = (baseURL: string): boolean => {
  const normalized = normalizeApiBaseUrl(baseURL).toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('/openai') ||
    normalized.includes('/compatible-mode')
  );
};

const normalizeGeminiNativeBaseUrl = (baseURL: string): string => {
  const normalized = normalizeApiBaseUrl(baseURL);
  if (!normalized) {
    return 'https://generativelanguage.googleapis.com/v1beta';
  }
  try {
    const url = new URL(normalized);
    const pathname = String(url.pathname || '')
      .replace(/\/+$/, '')
      .replace(/\/openai(?:\/v1)?$/i, '');
    url.pathname = pathname || '/v1beta';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return normalized.replace(/\/openai(?:\/v1)?$/i, '').replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com/v1beta';
  }
};

const toModelInfoList = (modelIds: string[]): AiModelInfo[] => {
  return modelIds.map((id) => ({ id, capabilities: inferModelCapabilities(id) }));
};

const dedupeModelIds = (modelIds: string[]): string[] => {
  return Array.from(new Set(modelIds.map((id) => String(id || '').trim()).filter(Boolean)));
};

const isLikelyImageModelId = (modelId: string): boolean => {
  const normalized = String(modelId || '').trim().toLowerCase();
  if (!normalized) return false;
  return hasModelCapability(modelId, 'image') || IMAGE_MODEL_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const filterImageModels = (models: AiModelInfo[]): AiModelInfo[] => {
  return models.filter((item) => isLikelyImageModelId(item.id));
};

const buildOpenAiModelEndpointCandidates = (baseURL: string): string[] => {
  const normalized = normalizeApiBaseUrl(baseURL);
  if (!normalized) return [];

  const candidates = new Set<string>();
  candidates.add(safeUrlJoin(normalized, '/models'));
  candidates.add(safeUrlJoin(normalized, '/v1/models'));

  try {
    const parsed = new URL(normalized);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const pathname = String(parsed.pathname || '').replace(/\/+$/, '');

    for (const hintPath of OPENAI_MODEL_PATH_HINTS) {
      candidates.add(`${origin}${hintPath}/models`);
    }

    if (pathname && pathname !== '/') {
      candidates.add(`${origin}${pathname}/models`);
      for (const hintPath of OPENAI_MODEL_PATH_HINTS) {
        if (pathname.endsWith(hintPath)) {
          candidates.add(`${origin}${hintPath}/models`);
        }
      }
    }
  } catch {
    // ignore parse fallback
  }

  return Array.from(candidates);
};

const normalizeModelId = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = String(record.id || record.name || record.model || '').trim();
    return id;
  }
  return '';
};

const parseOpenAiModelPayload = (payload: unknown): AiModelInfo[] => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const body = payload as Record<string, unknown>;
  const modelIds: string[] = [];

  const dataModels = Array.isArray(body.data) ? body.data : [];
  for (const item of dataModels) {
    const id = normalizeModelId(item);
    if (id) modelIds.push(id);
  }

  const fallbackModels = Array.isArray(body.models) ? body.models : [];
  for (const item of fallbackModels) {
    const id = normalizeModelId(item);
    if (id) modelIds.push(id);
  }

  return toModelInfoList(dedupeModelIds(modelIds));
};

const allowEmptyApiKeyForOpenAiCompatible = (input: { baseURL: string; presetId?: string; protocol?: AiProtocol }): boolean => {
  if (input.protocol && input.protocol !== 'openai') return false;
  return isLocalPreset(input.presetId) || isLikelyLocalEndpoint(input.baseURL);
};

export const detectAiProtocol = (input: {
  baseURL: string;
  presetId?: string;
  protocol?: string;
}): AiProtocol => {
  const explicit = String(input.protocol || '').trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'gemini' || explicit === 'openai') {
    return explicit as AiProtocol;
  }

  const preset = String(input.presetId || '').trim().toLowerCase();
  if (preset === 'anthropic') return 'anthropic';
  if (preset === 'gemini' || preset === 'google') return 'gemini';

  const base = normalizeApiBaseUrl(input.baseURL).toLowerCase();
  if (base.includes('/anthropic')) {
    return 'anthropic';
  }
  if (ANTHROPIC_HOST_HINTS.some((hint) => base.includes(hint))) {
    return 'anthropic';
  }
  if (isGeminiOpenAiCompatibleEndpoint(base)) {
    return 'openai';
  }
  if (GEMINI_HOST_HINTS.some((hint) => base.includes(hint)) && !base.includes('compatible-mode')) {
    return 'gemini';
  }
  return 'openai';
};

const fetchOpenAiModels = async (baseURL: string, apiKey: string): Promise<AiModelInfo[]> => {
  const candidates = buildOpenAiModelEndpointCandidates(baseURL);
  const attemptErrors: string[] = [];

  for (const endpoint of candidates) {
    const response = await withTimeout(fetch(endpoint, {
      headers: apiKey
        ? {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          }
        : {
            'Content-Type': 'application/json',
          },
    }));

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenAI-compatible API auth error (${response.status}): ${text || response.statusText}`);
      }
      attemptErrors.push(`${endpoint} -> ${response.status}: ${text || response.statusText}`);
      continue;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attemptErrors.push(`${endpoint} -> invalid json: ${message}`);
      continue;
    }

    const models = parseOpenAiModelPayload(data);

    if (models.length > 0) {
      return models;
    }

    attemptErrors.push(`${endpoint} -> empty model list`);
  }

  if (attemptErrors.length > 0) {
    const preview = attemptErrors.slice(0, 4).join(' | ');
    const more = attemptErrors.length > 4 ? ` | ...(${attemptErrors.length - 4} more)` : '';
    throw new Error(`OpenAI-compatible model listing failed: ${preview}${more}`);
  }

  return [];
};

const fetchAnthropicModels = async (baseURL: string, apiKey: string): Promise<AiModelInfo[]> => {
  const endpoint = safeUrlJoin(baseURL, '/v1/models');
  const response = await withTimeout(fetch(endpoint, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  }));

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic API error (${response.status}): ${text || response.statusText}`);
  }

  const data = await response.json() as { data?: Array<{ id?: string }> };
  return Array.isArray(data?.data)
    ? data.data
        .map((item) => String(item?.id || '').trim())
        .filter(Boolean)
        .map((id) => ({ id }))
    : [];
};

const fetchGeminiModels = async (baseURL: string, apiKey: string): Promise<AiModelInfo[]> => {
  const normalized = normalizeGeminiNativeBaseUrl(baseURL);
  const endpoint = `${safeUrlJoin(normalized, '/models')}?key=${encodeURIComponent(apiKey)}`;

  let response: Response;
  try {
    response = await withTimeout(fetch(endpoint, {
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Gemini models request failed at ${endpoint}: ${message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gemini API error (${response.status}) at ${endpoint}: ${text || response.statusText}`);
  }

  const data = await response.json() as { models?: Array<{ name?: string; displayName?: string }> };
  return Array.isArray(data?.models)
    ? data.models
        .map((item) => String(item?.name || item?.displayName || '').replace(/^models\//, '').trim())
        .filter(Boolean)
        .map((id) => ({ id }))
    : [];
};

export async function fetchModelsForAiSource(input: AiSourceConnectionInput): Promise<{ protocol: AiProtocol; models: AiModelInfo[] }> {
  const protocol = detectAiProtocol(input);
  const baseURL = normalizeApiBaseUrl(input.baseURL);
  const apiKey = String(input.apiKey || '').trim();
  const purpose: 'chat' | 'image' = input.purpose === 'image' ? 'image' : 'chat';

  if (!baseURL) {
    throw new Error('Base URL is required');
  }
  if (!apiKey && !(protocol === 'openai' && allowEmptyApiKeyForOpenAiCompatible({ ...input, protocol }))) {
    throw new Error('API Key is required');
  }

  let models: AiModelInfo[] = [];
  if (protocol === 'anthropic') {
    models = await fetchAnthropicModels(baseURL, apiKey);
  } else if (protocol === 'gemini') {
    const remoteModels = await fetchGeminiModels(baseURL, apiKey);
    if (purpose === 'image') {
      const imageModels = filterImageModels(remoteModels);
      models = imageModels.length > 0 ? imageModels : remoteModels;
    } else {
      models = remoteModels;
    }
  } else {
    const remoteModels = await fetchOpenAiModels(baseURL, apiKey);
    if (purpose === 'image') {
      const imageModels = filterImageModels(remoteModels);
      models = imageModels.length > 0 ? imageModels : remoteModels;
    } else {
      models = remoteModels;
    }
  }

  return { protocol, models };
}

export async function testAiSourceConnection(input: AiSourceConnectionInput): Promise<AiConnectionTestResult> {
  const { protocol, models } = await fetchModelsForAiSource(input);
  return {
    success: true,
    protocol,
    models,
    message: `连接成功（${protocol}），可用模型 ${models.length} 个`,
  };
}
