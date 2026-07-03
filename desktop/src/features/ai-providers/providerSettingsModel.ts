import type { AiSourceConfig } from '../../config/aiSources';
import { canonicalizeOfficialAutoSourceId, isOfficialAutoSourceId } from '../../config/aiSources';
import type { AiModelRouteConfig, AiModelRouteScope, AiModelRoutes } from '../settings/settingsModel';
import { DEFAULT_AI_MODEL_ROUTES } from '../settings/settingsModel';

export type AiModelDescriptor = {
  id: string;
  capabilities: string[];
  inputCapabilities: string[];
};

export type FetchProviderModelsResult = {
  success: boolean;
  models: Array<{ id: string; ownedBy?: string | null }>;
  attemptedUrls?: string[];
  resolvedUrl?: string | null;
  error?: string | null;
};

export const normalizeModelId = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.id || record.model || record.modelName || record.model_name || '').trim();
  }
  return '';
};

export const normalizeAiModelDescriptor = (value: unknown): AiModelDescriptor | null => {
  const id = normalizeModelId(value);
  if (!id) return null;
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const inputCapabilities = Array.isArray(record.inputCapabilities)
    ? record.inputCapabilities.map((item) => String(item || '').trim()).filter(Boolean)
    : Array.isArray(record.input_capabilities)
      ? record.input_capabilities.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
  return {
    id,
    capabilities: Array.from(new Set(capabilities)),
    inputCapabilities: Array.from(new Set(inputCapabilities)),
  };
};

export const sourceModelDescriptors = (source: AiSourceConfig | null | undefined): AiModelDescriptor[] => {
  if (!source) return [];
  const merged = new Map<string, AiModelDescriptor>();
  const add = (value: unknown) => {
    const descriptor = normalizeAiModelDescriptor(value);
    if (!descriptor) return;
    const previous = merged.get(descriptor.id);
    merged.set(descriptor.id, {
      id: descriptor.id,
      capabilities: Array.from(new Set([...(previous?.capabilities || []), ...descriptor.capabilities])),
      inputCapabilities: Array.from(new Set([...(previous?.inputCapabilities || []), ...descriptor.inputCapabilities])),
    });
  };
  (source.modelsMeta || []).forEach(add);
  (source.models || []).forEach(add);
  add(source.model);
  return Array.from(merged.values());
};

export const filterModelsByCapability = (
  models: AiModelDescriptor[],
  capability: string,
): AiModelDescriptor[] => {
  const normalized = String(capability || '').trim();
  if (!normalized) return models;
  return models.filter((model) => (
    model.capabilities.includes(normalized)
    || (normalized === 'chat' && model.capabilities.length === 0)
  ));
};

export const pickBestModelForSource = (
  source: AiSourceConfig | null | undefined,
  preferredModel: string,
  capability = 'chat',
): string => {
  if (!source) return '';
  const preferred = String(preferredModel || '').trim();
  const models = sourceModelDescriptors(source);
  const matching = filterModelsByCapability(models, capability);
  if (preferred && matching.some((model) => model.id === preferred)) return preferred;
  const sourceDefault = String(source.model || '').trim();
  if (sourceDefault && matching.some((model) => model.id === sourceDefault)) return sourceDefault;
  return String(matching[0]?.id || sourceDefault || models[0]?.id || '').trim();
};

export const normalizeRouteForSource = (
  route: AiModelRouteConfig | undefined,
  fallbackSourceId: string,
): AiModelRouteConfig => {
  const sourceId = canonicalizeOfficialAutoSourceId(String(route?.sourceId || fallbackSourceId || '').trim());
  const mode = route?.mode === 'disabled'
    ? 'disabled'
    : isOfficialAutoSourceId(sourceId)
      ? 'official'
      : 'custom';
  return {
    mode,
    sourceId,
    model: String(route?.model || '').trim(),
  };
};

export const normalizeAiModelRoutes = (
  raw: unknown,
  fallbackSourceId = '',
): AiModelRoutes => {
  const parsed = typeof raw === 'string'
    ? safeJsonParse<Record<string, unknown>>(raw)
    : raw && typeof raw === 'object'
      ? raw as Record<string, unknown>
      : {};
  const next = { ...DEFAULT_AI_MODEL_ROUTES };
  (Object.keys(DEFAULT_AI_MODEL_ROUTES) as AiModelRouteScope[]).forEach((scope) => {
    const route = parsed?.[scope] && typeof parsed[scope] === 'object'
      ? parsed[scope] as AiModelRouteConfig
      : undefined;
    next[scope] = normalizeRouteForSource(route || DEFAULT_AI_MODEL_ROUTES[scope], fallbackSourceId);
  });
  return next;
};

export const mergeFetchedModelsIntoSource = (
  source: AiSourceConfig,
  result: FetchProviderModelsResult,
): AiSourceConfig => {
  if (!result.success || !Array.isArray(result.models)) return source;
  const ids = result.models.map((model) => String(model.id || '').trim()).filter(Boolean);
  const mergedIds = Array.from(new Set([...(source.models || []), ...ids]));
  const metaIds = new Set((source.modelsMeta || []).map((model) => String(model.id || '').trim()));
  const fetchedMeta = ids
    .filter((id) => !metaIds.has(id))
    .map((id) => ({ id }));
  return {
    ...source,
    models: mergedIds,
    modelsMeta: [...(source.modelsMeta || []), ...fetchedMeta],
    model: source.model || ids[0] || '',
  };
};

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

