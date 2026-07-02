import { OFFICIAL_AUTO_SOURCE_ID, canonicalizeOfficialAutoSourceId } from '../../config/aiSources';
import type { McpServerConfig, RuntimePerfPreset } from '../../pages/settings/shared';
import { createDefaultMcpServer } from '../../pages/settings/shared';

export const DEFAULT_VOICE_TTS_MODEL = 'cosyvoice-v3.5-plus';
export const DEFAULT_VOICE_CLONE_MODEL = 'cosyvoice-v3.5-plus-voice-clone';
export const MINIMAX_VOICE_CLONE_MODEL = 'minimax-voice-clone';
export const FILE_INDEX_DASHBOARD_CACHE_TTL_MS = 60_000;
export const FILE_INDEX_DASHBOARD_POLL_MS = 30_000;
export const DEFAULT_VISUAL_INDEX_PROMPT_VERSION = 'visual-manifest-v2-zh';
export const RUNTIME_PERF_HISTORY_LIMIT = 12;
export const RUNTIME_PERF_TIMELINE_LIMIT = 40;
export const RUNTIME_PERF_CHECKPOINT_WINDOW_MS = 1500;
export type AiPricingRate = Record<string, unknown>;

export type AiPricingModel = {
  model: string;
  display_name?: string;
  provider?: string;
  capability?: string;
  pricing_mode?: string;
  points_per_mtoken?: number;
  points_input_per_mtoken?: number;
  points_cached_input_per_mtoken?: number;
  points_cache_write_5m_per_mtoken?: number;
  points_cache_write_1h_per_mtoken?: number;
  points_output_per_mtoken?: number;
  points_per_call?: number;
  points_per_minute?: number;
  points_per_100_chars?: number;
  billing_unit?: string;
  tts_character_rate?: AiPricingRate;
  is_default?: boolean;
  price_table?: AiPricingRate[];
  image_quality_resolution_rates?: AiPricingRate[];
  video_resolution_rates?: AiPricingRate[];
};

export type AiPricingGroup = {
  type: string;
  label: string;
  models: AiPricingModel[];
};

export type AiPricingCatalog = {
  object?: string;
  updated_at?: number | string;
  groups: AiPricingGroup[];
};

export const normalizePricingNumber = (value: unknown): number | null => {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

export const formatPricingPoints = (value: unknown): string => {
  const numberValue = normalizePricingNumber(value);
  if (numberValue === null || numberValue <= 0) return '-';
  return numberValue.toLocaleString();
};

export const hasMeaningfulPricingValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return false;
    const numberValue = Number(normalized);
    return !Number.isFinite(numberValue) || numberValue !== 0;
  }
  return true;
};

export const formatPricingUpdatedAt = (value: unknown): string => {
  const numberValue = normalizePricingNumber(value);
  if (numberValue && numberValue > 0) {
    const timestamp = numberValue > 10_000_000_000 ? numberValue : numberValue * 1000;
    return new Date(timestamp).toLocaleString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  return '未同步';
};

export const parseAiPricingCatalog = (value: unknown): AiPricingCatalog | null => {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const groups = Array.isArray(root?.groups) ? root.groups : [];
  const normalizedGroups = groups
    .map((group) => {
      const groupRecord = group && typeof group === 'object' ? group as Record<string, unknown> : {};
      const models = Array.isArray(groupRecord.models) ? groupRecord.models : [];
      return {
        type: String(groupRecord.type || '').trim() || 'other',
        label: String(groupRecord.label || groupRecord.type || '其他模型').trim(),
        models: models
          .filter((model): model is AiPricingModel => Boolean(model && typeof model === 'object'))
          .map((model) => model as AiPricingModel),
      };
    })
    .filter((group) => group.models.length > 0);
  if (!normalizedGroups.length) return null;
  return {
    object: typeof root?.object === 'string' ? root.object : undefined,
    updated_at: typeof root?.updated_at === 'number' || typeof root?.updated_at === 'string' ? root.updated_at : undefined,
    groups: normalizedGroups,
  };
};

export const pricingModeLabel = (mode?: string): string => {
  switch (mode) {
    case 'per_mtoken':
      return '每百万 tokens';
    case 'per_call':
      return '按次';
    case 'per_minute':
      return '按分钟';
    case 'per_mchar':
      return '每 100 字符';
    default:
      return mode || '-';
  }
};

export const pricingRateLabel = (key: string): string => {
  switch (key) {
    case 'quality':
      return '质量';
    case 'resolution':
      return '分辨率';
    case 'points_per_call':
      return '积分/次';
    case 'points_per_second':
      return '积分/秒';
    case 'points_per_minute':
      return '积分/分钟';
    case 'points_per_100_chars':
      return '积分/100 字符';
    case 'price_rmb_per_call':
      return '人民币/次';
    case 'price_rmb_per_second':
      return '人民币/秒';
    case 'billing_unit':
      return '单位';
    case 'note':
      return '备注';
    default:
      return key;
  }
};

export const pricingRateValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number') {
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(value);
};

export const pricingRateCellValue = (key: string, value: unknown): string => {
  if (key === 'billing_unit') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'call') return '次';
    if (normalized === '100_characters') return '100 字符';
  }
  return pricingRateValue(value);
};

export const pricingModelFields = (model: AiPricingModel, groupType?: string): Array<{ label: string; value: string }> => {
  if (groupType === 'chat') {
    return hasMeaningfulPricingValue(model.points_per_mtoken)
      ? [{ label: '百万 tokens', value: formatPricingPoints(model.points_per_mtoken) }]
      : [];
  }
  const usesCharacterBilling = hasMeaningfulPricingValue(model.points_per_100_chars)
    || String(model.billing_unit || '').trim().toLowerCase() === '100_characters';
  const fields: Array<{ label: string; raw: unknown; suffix?: string }> = [
    { label: '百万 tokens', raw: model.points_per_mtoken },
    { label: '输入', raw: model.points_input_per_mtoken, suffix: ' / 百万 tokens' },
    { label: '缓存输入', raw: model.points_cached_input_per_mtoken, suffix: ' / 百万 tokens' },
    { label: '缓存写入 5m', raw: model.points_cache_write_5m_per_mtoken, suffix: ' / 百万 tokens' },
    { label: '缓存写入 1h', raw: model.points_cache_write_1h_per_mtoken, suffix: ' / 百万 tokens' },
    { label: '输出', raw: model.points_output_per_mtoken, suffix: ' / 百万 tokens' },
    { label: '每 100 字符', raw: model.points_per_100_chars, suffix: ' / 100 字符' },
    { label: '按次', raw: usesCharacterBilling ? 0 : model.points_per_call, suffix: ' / 次' },
    { label: '按分钟', raw: model.points_per_minute, suffix: ' / 分钟' },
  ];
  return fields
    .filter((field) => hasMeaningfulPricingValue(field.raw))
    .map((field) => ({
      label: field.label,
      value: `${formatPricingPoints(field.raw)}${field.suffix || ''}`,
    }));
};

export const RUNTIME_PERF_PRESETS: RuntimePerfPreset[] = [
  {
    id: 'latency-smoke',
    label: '延迟冒烟',
    description: '验证纯文本响应路径，观察 thinking 到首个 response 的延迟。',
    message: '请直接回答：用三句话说明当前 runtime mode 的职责、主要风险和最先检查的观测点。不要调用工具。',
  },
  {
    id: 'tooling-probe',
    label: '工具探测',
    description: '尽量触发一次真实工具调用，检查 tool-start/tool-end 延迟和成功率。',
    message: '先调用一个最适合当前运行时的诊断类工具读取状态，再用两条结论总结发现。若当前上下文没有合适工具，再明确说明原因。',
  },
  {
    id: 'long-response',
    label: '长响应',
    description: '拉长输出链路，观察持续流式输出和总耗时。',
    message: '围绕当前 runtime mode 输出一个结构化调试清单，至少包含：入口、关键事件、常见瓶颈、建议日志位、回归检查项，每项 2 到 3 句。',
  },
];

export type SettingsTab = 'general' | 'ai' | 'team' | 'platforms' | 'mcp' | 'tools' | 'profile' | 'remote' | 'experimental';
export type SettingsNavigationTarget = {
  tab?: SettingsTab;
  aiModelSubTab?: 'custom' | 'login';
  nonce?: number;
};

export type AiModelRouteMode = 'official' | 'custom' | 'disabled';
export type AiModelRouteScope =
  | 'chat'
  | 'wander'
  | 'team'
  | 'knowledge'
  | 'redclaw'
  | 'transcription'
  | 'embedding'
  | 'image'
  | 'visualIndex'
  | 'videoAnalysis'
  | 'voiceTts'
  | 'voiceClone';

export type AiModelRouteConfig = {
  mode: AiModelRouteMode;
  sourceId?: string;
  model?: string;
};

export type AiModelRoutes = Record<AiModelRouteScope, AiModelRouteConfig>;

export const DEFAULT_VIDEO_ANALYSIS_ENABLED = true;
export const DEFAULT_VISUAL_INDEX_ENABLED = false;

export const DEFAULT_AI_MODEL_ROUTES: AiModelRoutes = {
  chat: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  wander: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  team: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  knowledge: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  redclaw: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  transcription: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  embedding: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  image: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  visualIndex: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  videoAnalysis: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: '' },
  voiceTts: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: DEFAULT_VOICE_TTS_MODEL },
  voiceClone: { mode: 'official', sourceId: OFFICIAL_AUTO_SOURCE_ID, model: DEFAULT_VOICE_CLONE_MODEL },
};

export const normalizeModelKey = (value: string) => String(value || '').trim().toLowerCase();

export const cloneModelForVoiceTtsModel = (ttsModel: string, fallback = DEFAULT_VOICE_CLONE_MODEL) => {
  const key = normalizeModelKey(ttsModel);
  if (key.includes('cosyvoice')) return DEFAULT_VOICE_CLONE_MODEL;
  if (key.startsWith('speech-') || key.startsWith('speech_') || key.includes('minimax')) return MINIMAX_VOICE_CLONE_MODEL;
  return fallback || DEFAULT_VOICE_CLONE_MODEL;
};

export type SettingsSkill = {
  name: string;
  description: string;
  location: string;
  sourceScope?: string;
  isBuiltin?: boolean;
  disabled?: boolean;
};

export type McpServerDraft = McpServerConfig & {
  envPassthrough: string[];
};

export function formatSettingsSkillSource(scope?: string) {
  switch (scope) {
    case 'builtin':
      return '内置';
    case 'workspace':
      return '当前空间';
    case 'user':
      return '用户目录';
    case 'market':
      return '市场';
    default:
      return scope?.startsWith('thrive-plugin:') ? '插件' : scope || '技能';
  }
}

export function formatMcpTime(value?: number) {
  if (!value) return '未使用';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未使用' : date.toLocaleString();
}

export function mcpDraftFromServer(server?: McpServerConfig): McpServerDraft {
  const base = server || { ...createDefaultMcpServer(), name: '' };
  return {
    ...base,
    name: base.name === 'New MCP Server' ? '' : base.name,
    enabled: base.enabled !== false,
    transport: base.transport || 'stdio',
    command: base.command || '',
    args: Array.isArray(base.args) ? base.args : [],
    env: base.env || {},
    cwd: base.cwd || '',
    url: base.url || '',
    oauth: {
      ...(base.oauth || {}),
      redbox: {
        ...(base.oauth?.redbox || {}),
        envPassthrough: base.oauth?.redbox?.envPassthrough || [],
      },
    },
    envPassthrough: base.oauth?.redbox?.envPassthrough || [],
  };
}

export function mcpServerFromDraft(draft: McpServerDraft): McpServerConfig {
  const env = Object.fromEntries(
    Object.entries(draft.env || {})
      .map(([key, value]) => [key.trim(), String(value || '').trim()])
      .filter(([key, value]) => Boolean(key && value)),
  );
  const envPassthrough = draft.envPassthrough.map((item) => item.trim()).filter(Boolean);
  return {
    ...draft,
    name: draft.name.trim() || 'MCP Server',
    command: draft.transport === 'stdio' ? String(draft.command || '').trim() : '',
    args: draft.transport === 'stdio' ? (draft.args || []).map((item) => item.trim()).filter(Boolean) : [],
    env,
    cwd: draft.transport === 'stdio' ? String(draft.cwd || '').trim() : '',
    url: draft.transport === 'stdio' ? '' : String(draft.url || '').trim(),
    oauth: {
      ...(draft.oauth || {}),
      redbox: {
        ...(draft.oauth?.redbox || {}),
        envPassthrough,
      },
    },
  };
}

export function normalizeVisualIndexPromptVersion(value: unknown): string {
  const text = String(value || '').trim();
  if (!text || text === 'visual-manifest-v1') {
    return DEFAULT_VISUAL_INDEX_PROMPT_VERSION;
  }
  return text;
}


export function normalizeAiModelRoutes(value: unknown): AiModelRoutes {
  const parsed = typeof value === 'string'
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })()
    : value;
  const source = parsed && typeof parsed === 'object' ? parsed as Partial<Record<AiModelRouteScope, Partial<AiModelRouteConfig>>> : {};
  const next = { ...DEFAULT_AI_MODEL_ROUTES } as AiModelRoutes;
  for (const key of Object.keys(DEFAULT_AI_MODEL_ROUTES) as AiModelRouteScope[]) {
    const route = source[key];
    if (!route || typeof route !== 'object') continue;
    const mode = String(route.mode || '').trim();
    next[key] = {
      mode: mode === 'custom' || mode === 'disabled' || mode === 'official'
        ? mode
        : mode === 'inherit'
          ? 'official'
          : DEFAULT_AI_MODEL_ROUTES[key].mode,
      sourceId: canonicalizeOfficialAutoSourceId(String(route.sourceId || '').trim()) || DEFAULT_AI_MODEL_ROUTES[key].sourceId,
      model: String(route.model || '').trim() || DEFAULT_AI_MODEL_ROUTES[key].model,
    };
  }
  return next;
}
