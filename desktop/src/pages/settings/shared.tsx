import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, FileText, Image as ImageIcon, Video, AudioLines } from 'lucide-react';
import clsx from 'clsx';
import {
  type AiSourcePreset,
  type AiSourceConfig,
  DEFAULT_AI_PRESET_ID,
  findAiPresetById,
  inferPresetIdByEndpoint,
} from '../../config/aiSources';
import {
  getForcedModelCapabilities,
  getModelInputCapabilities,
  MODEL_CAPABILITY_META,
  inferModelCapabilities,
  normalizeModelCapabilities,
  type ModelCapability,
  type ModelInputCapability,
} from '../../../shared/modelCapabilities';

const REDBOX_OFFICIAL_LOGO_URL = new URL('../../../redbox.png', import.meta.url).href;

export interface UserMemory {
  id: string;
  content: string;
  type: 'general' | 'preference' | 'fact';
  tags: string[];
  created_at: number;
  updated_at?: number;
  last_accessed?: number;
  status?: 'active' | 'archived';
  archived_at?: number;
  archive_reason?: string;
  origin_id?: string;
  canonical_key?: string;
  revision?: number;
  last_conflict_at?: number;
}

export interface MemoryHistoryEntry {
  id: string;
  memory_id: string;
  origin_id: string;
  action: 'create' | 'update' | 'dedupe' | 'archive' | 'delete' | 'access';
  reason?: string;
  timestamp: number;
  before?: Partial<UserMemory>;
  after?: Partial<UserMemory>;
  archived_memory_id?: string;
}

export interface MemorySearchResult extends UserMemory {
  score: number;
  matchReasons: string[];
}

export interface MemoryMaintenanceStatus {
  started: boolean;
  running: boolean;
  lockState: 'owner' | 'passive';
  blockedBy: string | null;
  pendingMutations: number;
  lastRunAt: string | null;
  lastScanAt: string | null;
  lastReason: 'init' | 'mutation' | 'periodic' | 'workspace-change' | 'manual' | null;
  lastSummary: string;
  lastError: string | null;
  nextScheduledAt: string | null;
}

export interface ToolDiagnosticDescriptor {
  name: string;
  displayName: string;
  description: string;
  kind: string;
  visibility: 'public' | 'developer' | 'internal';
  contexts: string[];
  availabilityStatus: 'available' | 'missing_context' | 'internal_only' | 'not_in_current_pack' | 'registration_error';
  availabilityReason: string;
}

export interface ToolDiagnosticRunResult {
  success: boolean;
  mode: 'direct' | 'ai';
  toolName: string;
  request: unknown;
  response?: unknown;
  error?: string;
  toolCallReturned?: boolean;
  toolNameMatched?: boolean;
  argumentsParsed?: boolean;
  executionSucceeded?: boolean;
}

export interface AgentTaskNode {
  id: string;
  type: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}

export interface AgentTaskCheckpoint {
  id: string;
  nodeId: string;
  summary: string;
  payload?: unknown;
  createdAt: number;
}

export interface AgentTaskArtifact {
  id: string;
  type: string;
  label: string;
  path?: string;
  metadata?: unknown;
  createdAt: number;
}

export interface IntentRouteInfo {
  intent: string;
  goal: string;
  requiredCapabilities: string[];
  recommendedRole: string;
  requiresLongRunningTask: boolean;
  requiresMultiAgent: boolean;
  requiresHumanApproval: boolean;
  confidence: number;
  reasoning: string;
}

export interface AgentTaskSnapshot {
  id: string;
  taskType: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  runtimeMode: string;
  ownerSessionId?: string | null;
  intent?: string | null;
  roleId?: string | null;
  goal?: string | null;
  currentNode?: string | null;
  route?: IntentRouteInfo | null;
  graph: AgentTaskNode[];
  artifacts: AgentTaskArtifact[];
  checkpoints: AgentTaskCheckpoint[];
  metadata?: unknown;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface AgentTaskTrace {
  id: number;
  taskId: string;
  nodeId?: string | null;
  eventType: string;
  payload?: unknown;
  createdAt: number;
}

export interface RoleSpec {
  roleId: string;
  purpose: string;
  systemPrompt: string;
  allowedToolPack: string;
  inputSchema: string;
  outputSchema: string;
  handoffContract: string;
  artifactTypes: string[];
}

export interface BackgroundTaskTurn {
  id: string;
  at: string;
  text: string;
  source: 'thought' | 'tool' | 'response' | 'system';
}

export interface BackgroundTaskItem {
  id: string;
  kind: 'redclaw-project' | 'scheduled-task' | 'long-cycle' | 'heartbeat' | 'memory-maintenance' | 'headless-runtime';
  title: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: 'queued' | 'starting' | 'thinking' | 'tooling' | 'responding' | 'updating' | 'completed' | 'failed' | 'cancelled';
  sessionId?: string;
  contextId?: string;
  error?: string;
  summary?: string;
  latestText?: string;
  attemptCount: number;
  workerState:
    | 'idle'
    | 'queued'
    | 'leased'
    | 'running'
    | 'retrying'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'dead_lettered'
    | 'retry_wait'
    | 'timed_out'
    | 'stopping';
  workerMode?: 'main-process' | 'child-json-worker' | 'child-runtime-worker';
  workerPid?: number;
  workerLabel?: string;
  workerLastHeartbeatAt?: string;
  cancelReason?: string;
  rollbackState: 'idle' | 'running' | 'completed' | 'failed' | 'not_required';
  rollbackError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  turns: BackgroundTaskTurn[];
}

export interface BackgroundWorkerPoolSlot {
  id: string;
  mode: 'child-json-worker' | 'child-runtime-worker';
  ready: boolean;
  busy: boolean;
  pid?: number;
  sessionId?: string;
  taskId?: string;
  lastHeartbeatAt?: string;
  lastUsedAt?: string;
}

export interface BackgroundWorkerPoolState {
  json: BackgroundWorkerPoolSlot[];
  runtime: BackgroundWorkerPoolSlot[];
}

export interface RuntimeToolResultItem {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  command?: string;
  success: boolean;
  resultText?: string;
  summaryText?: string;
  promptText?: string;
  originalChars?: number;
  promptChars?: number;
  truncated: boolean;
  payload?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface OfficialModelInfo {
  id: string;
  capability?: string;
  capabilities?: ModelCapability[];
  apiType?: string;
  ownedBy?: string;
}

export interface AiModelDescriptor {
  id: string;
  capabilities: ModelCapability[];
  inputCapabilities: ModelInputCapability[];
}

export const normalizeAiModelDescriptors = (
  models: Array<
    | string
    | null
    | undefined
    | { id?: string; capability?: ModelCapability | string | null | undefined; capabilities?: Array<ModelCapability | string | null | undefined> }
  >,
): AiModelDescriptor[] => {
  const merged = new Map<string, AiModelDescriptor>();
  for (const raw of models) {
    const descriptor = toAiModelDescriptor(raw as string | { id?: string; capability?: ModelCapability | string | null | undefined; capabilities?: Array<ModelCapability | string | null | undefined> });
    if (!descriptor) continue;
    const previous = merged.get(descriptor.id);
    merged.set(descriptor.id, {
      id: descriptor.id,
      capabilities: normalizeModelCapabilities([...(previous?.capabilities || []), ...descriptor.capabilities]),
      inputCapabilities: normalizeModelInputCapabilities([...(previous?.inputCapabilities || []), ...descriptor.inputCapabilities]),
    });
  }
  return Array.from(merged.values());
};

const MODEL_INPUT_META: Record<ModelInputCapability, {
  label: string;
  icon: typeof FileText;
  className: string;
}> = {
  file: {
    label: '文件',
    icon: FileText,
    className: 'text-sky-600 bg-sky-500/12 ring-1 ring-sky-500/15',
  },
  image: {
    label: '图片',
    icon: ImageIcon,
    className: 'text-emerald-600 bg-emerald-500/12 ring-1 ring-emerald-500/15',
  },
  video: {
    label: '视频',
    icon: Video,
    className: 'text-violet-600 bg-violet-500/12 ring-1 ring-violet-500/15',
  },
  audio: {
    label: '音频',
    icon: AudioLines,
    className: 'text-amber-600 bg-amber-500/12 ring-1 ring-amber-500/15',
  },
};

const MODEL_CAPABILITY_BADGE_META: Record<ModelCapability, string> = {
  chat: 'text-slate-700',
  image: 'text-emerald-700',
  video: 'text-violet-700',
  audio: 'text-amber-700',
  transcription: 'text-cyan-700',
  embedding: 'text-rose-700',
};

const normalizeModelInputCapabilities = (values: Array<ModelInputCapability | string | null | undefined>): ModelInputCapability[] => {
  const allowed: ModelInputCapability[] = ['image', 'audio', 'video', 'file'];
  const normalized = new Set<ModelInputCapability>();
  for (const value of values) {
    const text = String(value || '').trim().toLowerCase();
    if (allowed.includes(text as ModelInputCapability)) {
      normalized.add(text as ModelInputCapability);
    }
  }
  return allowed.filter((item) => normalized.has(item));
};

export type AiProtocol = 'openai' | 'anthropic' | 'gemini';

export const IMAGE_PROVIDER_TEMPLATE_OPTIONS = [
  { value: 'openai-images', label: 'OpenAI Images API' },
  { value: 'gemini-openai-images', label: 'Gemini OpenAI 兼容 Images' },
  { value: 'gemini-imagen-native', label: 'Gemini Imagen 原生协议' },
  { value: 'dashscope-wan-native', label: 'DashScope / Wan 原生协议' },
  { value: 'ark-seedream-native', label: '方舟 Ark / Seedream 官方协议' },
  { value: 'midjourney-proxy', label: 'Midjourney Proxy 协议' },
  { value: 'jimeng-openai-wrapper', label: '即梦 OpenAI 包装协议（需自建网关）' },
  { value: 'gemini-generate-content', label: 'Gemini generateContent（Legacy）' },
  { value: 'jimeng-images', label: '即梦 / Jimeng Images（Legacy，需自建网关）' },
] as const;

export const IMAGE_PROVIDER_TEMPLATE_VALUES: Set<string> = new Set(
  IMAGE_PROVIDER_TEMPLATE_OPTIONS.map((item) => item.value)
);

export const inferImageTemplateByProvider = (provider: string, currentTemplate = ''): string => {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedTemplate = String(currentTemplate || '').trim();
  if (IMAGE_PROVIDER_TEMPLATE_VALUES.has(normalizedTemplate)) {
    return normalizedTemplate;
  }
  if (normalizedProvider.includes('gemini-imagen') || normalizedProvider.includes('imagen')) {
    return 'gemini-imagen-native';
  }
  if (normalizedProvider.includes('gemini') || normalizedProvider.includes('nanobanana') || normalizedProvider.includes('nano-banana')) {
    return 'gemini-openai-images';
  }
  if (normalizedProvider.includes('dashscope') || normalizedProvider.includes('wan') || normalizedProvider.includes('通义万相')) {
    return 'dashscope-wan-native';
  }
  if (normalizedProvider.includes('buts')) {
    return 'dashscope-wan-native';
  }
  if (normalizedProvider.includes('ark') || normalizedProvider.includes('volc') || normalizedProvider.includes('seedream') || normalizedProvider.includes('方舟')) {
    return 'ark-seedream-native';
  }
  if (normalizedProvider.includes('midjourney') || normalizedProvider === 'mj') {
    return 'midjourney-proxy';
  }
  if (normalizedProvider.includes('jimeng') || normalizedProvider.includes('即梦')) {
    return 'ark-seedream-native';
  }
  if (normalizedProvider === 'openai' || normalizedProvider === 'openai-compatible') {
    return 'openai-images';
  }
  return 'openai-images';
};

export const resolveImageModelFetchProtocol = (template: string): AiProtocol => {
  const normalized = String(template || '').trim();
  if (normalized === 'gemini-openai-images' || normalized === 'gemini-imagen-native' || normalized === 'gemini-generate-content') {
    return 'gemini';
  }
  return 'openai';
};

export const resolveImageModelFetchPresetId = (provider: string, template: string, endpoint: string): string | undefined => {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedTemplate = String(template || '').trim().toLowerCase();
  const normalizedEndpoint = String(endpoint || '').trim().toLowerCase();
  const merged = `${normalizedProvider} ${normalizedTemplate} ${normalizedEndpoint}`;

  if (merged.includes('buts')) return 'buts';
  if (
    normalizedTemplate === 'dashscope-wan-native' ||
    merged.includes('dashscope') ||
    merged.includes('bailian') ||
    merged.includes('wan')
  ) {
    return 'dashscope';
  }
  if (
    normalizedTemplate === 'ark-seedream-native' ||
    merged.includes('ark') ||
    merged.includes('volc') ||
    merged.includes('seedream') ||
    merged.includes('doubao') ||
    merged.includes('jimeng')
  ) {
    return 'ark';
  }
  if (
    normalizedTemplate === 'gemini-openai-images' ||
    normalizedTemplate === 'gemini-imagen-native' ||
    normalizedTemplate === 'gemini-generate-content' ||
    merged.includes('gemini') ||
    merged.includes('generativelanguage.googleapis.com')
  ) {
    return 'gemini';
  }
  if (merged.includes('openrouter')) return 'openrouter';
  if (merged.includes('deepseek')) return 'deepseek';
  if (merged.includes('minimax')) return 'minimax-cn';
  if (merged.includes('api.openai.com') || normalizedTemplate === 'openai-images') return 'openai';
  return undefined;
};

export const normalizeImageModelFetchBaseURL = (baseURL: string, template: string): string => {
  const normalizedBase = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!normalizedBase) return '';
  if (template === 'gemini-openai-images' && /generativelanguage\.googleapis\.com/i.test(normalizedBase)) {
    return normalizedBase.replace(/\/openai(?:\/.*)?$/i, '');
  }
  if (template === 'dashscope-wan-native') {
    const stripped = normalizedBase
      .replace(/\/compatible-mode\/v\d+(\.\d+)?(?:\/.*)?$/i, '')
      .replace(/\/api\/v1(?:\/.*)?$/i, '')
      .replace(/\/v1(?:\/.*)?$/i, '');
    return `${stripped}/compatible-mode/v1`;
  }
  return normalizedBase;
};

export const isLikelyLocalEndpoint = (baseURL: string): boolean => {
  const normalized = String(baseURL || '').toLowerCase();
  return (
    normalized.includes('127.0.0.1') ||
    normalized.includes('localhost') ||
    normalized.includes('0.0.0.0') ||
    normalized.includes('::1')
  );
};

export const AI_PRESET_LOGO_BY_ID: Record<string, string> = {
  'redbox-official': REDBOX_OFFICIAL_LOGO_URL,
  redbox_official_auto: REDBOX_OFFICIAL_LOGO_URL,
  openai: 'provider-logos/openai.svg',
  anthropic: 'provider-logos/anthropic.svg',
  gemini: 'provider-logos/gemini.svg',
  deepseek: 'provider-logos/deepseek.svg',
  openrouter: 'provider-logos/openrouter.svg',
  dashscope: 'provider-logos/qwen.svg',
  'dashscope-coding-openai': 'provider-logos/qwen.svg',
  'dashscope-coding-anthropic': 'provider-logos/qwen.svg',
  'zhipu-coding-openai': 'provider-logos/zhipu.svg',
  'zhipu-coding-anthropic': 'provider-logos/zhipu.svg',
  'moonshot-cn': 'provider-logos/kimi.svg',
  'moonshot-global': 'provider-logos/kimi.svg',
  'kimi-coding-openai': 'provider-logos/kimi.svg',
  'kimi-coding-anthropic': 'provider-logos/kimi.svg',
  'minimax-cn': 'provider-logos/minimax.png',
  'minimax-global': 'provider-logos/minimax.png',
  'minimax-coding-openai': 'provider-logos/minimax.png',
  'minimax-coding-anthropic': 'provider-logos/minimax.png',
  'siliconflow-cn': 'provider-logos/siliconflow.png',
  siliconflow: 'provider-logos/siliconflow.png',
  zhipu: 'provider-logos/zhipu.svg',
  xai: 'provider-logos/xai.svg',
  ark: 'provider-logos/volcengine.svg',
  'ark-coding-openai': 'provider-logos/volcengine.svg',
  'ark-coding-anthropic': 'provider-logos/volcengine.svg',
  qianfan: 'provider-logos/baidu.svg',
  'qianfan-coding-openai': 'provider-logos/baidu.svg',
  'qianfan-coding-anthropic': 'provider-logos/baidu.svg',
  hunyuan: 'provider-logos/tencent.svg',
  'tencent-coding-openai': 'provider-logos/tencent.svg',
  'tencent-coding-anthropic': 'provider-logos/tencent.svg',
  lingyi: 'provider-logos/lingyiwanwu.svg',
  poe: 'provider-logos/poe.svg',
  ppio: 'provider-logos/ppio.svg',
  modelscope: 'provider-logos/modelscope.svg',
  infiniai: 'provider-logos/infiniai.svg',
  ctyun: 'provider-logos/ctyun.svg',
  stepfun: 'provider-logos/stepfun.svg',
  'stepfun-coding-openai': 'provider-logos/stepfun.svg',
  'stepfun-coding-anthropic': 'provider-logos/stepfun.svg',
};

export const resolveRuntimeAssetUrl = (assetPath: string): string => {
  const normalized = String(assetPath || '').trim().replace(/^\.?\//, '');
  if (!normalized) return '';
  if (/^(https?:|file:|local-file:|redbox-asset:|data:|blob:)/i.test(normalized)) {
    return normalized;
  }
  if (typeof window === 'undefined') {
    return `./${normalized}`;
  }
  try {
    const href = String(window.location.href || '');
    if (/^(local-file|redbox-asset):/i.test(href)) {
      const fileBaseHref = href
        .replace(/^local-file:/i, 'file:')
        .replace(/^redbox-asset:\/\/asset\//i, 'file:///');
      return new URL(normalized, fileBaseHref).toString();
    }
    return new URL(normalized, href).toString();
  } catch {
    return `./${normalized}`;
  }
};

export const resolveAiPresetLogoCandidates = (presetId: string): string[] => {
  const normalized = String(presetId || '').trim().toLowerCase();
  const mapped = AI_PRESET_LOGO_BY_ID[normalized];
  if (!mapped) {
    return [];
  }
  const assetPath = String(mapped).trim().replace(/^\.?\//, '');
  const primary = resolveRuntimeAssetUrl(assetPath);
  const fallbacks = [
    primary,
    `./${assetPath}`,
    `/${assetPath}`,
  ].filter(Boolean);
  return Array.from(new Set(fallbacks));
};

export const AiPresetLogo = ({ presetId, label }: { presetId: string; label: string }) => {
  const logoCandidates = resolveAiPresetLogoCandidates(presetId);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const logoUrl = logoCandidates[candidateIndex] || '';

  useEffect(() => {
    setCandidateIndex(0);
  }, [presetId]);

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={label}
        className="w-4 h-4 rounded-sm object-contain shrink-0"
        loading="lazy"
        onError={() => setCandidateIndex((prev) => prev + 1)}
      />
    );
  }
  return (
    <span className="w-4 h-4 rounded-sm border border-border bg-surface-secondary/50 text-[9px] leading-4 text-center text-text-tertiary shrink-0">
      {String(label || 'C').trim().charAt(0).toUpperCase() || 'C'}
    </span>
  );
};

export const AiSourceLogo = ({
  source,
}: {
  source: Pick<AiSourceConfig, 'id' | 'name' | 'baseURL' | 'presetId'>;
}) => {
  const normalizedId = String(source.id || '').trim().toLowerCase();
  const normalizedName = String(source.name || '').trim().toLowerCase();
  const resolvedPresetId = (
    normalizedId === 'redbox_official_auto' || normalizedName === 'redbox official'
      ? 'redbox-official'
      : source.presetId
  );
  return <AiPresetLogo presetId={resolvedPresetId} label={source.name || 'AI'} />;
};

export interface AiPresetGroup {
  id: string;
  label: string;
  items: AiSourcePreset[];
}

export interface CreateAiSourceDraft {
  presetId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  protocol: AiProtocol;
  setAsDefault: boolean;
}

export const AiPresetSelect = ({
  value,
  groups,
  onChange,
  className,
}: {
  value: string;
  groups: AiPresetGroup[];
  onChange: (presetId: string) => void;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const presets = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selectedPreset = useMemo(() => {
    return presets.find((item) => item.id === value) || findAiPresetById(value) || presets[0] || null;
  }, [presets, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors flex items-center justify-between gap-2"
      >
        <span className="min-w-0 flex items-center gap-2">
          <AiPresetLogo presetId={selectedPreset?.id || ''} label={selectedPreset?.label || 'Custom'} />
          <span className="truncate">{selectedPreset?.label || '选择平台预设'}</span>
        </span>
        <ChevronDown className={clsx('w-4 h-4 text-text-tertiary transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-[120] mt-1 w-full max-h-80 overflow-auto rounded-lg border border-border bg-surface-primary shadow-xl">
          {groups.map((group) => (
            <div key={group.id} className="border-b border-border/60 last:border-b-0">
              <div className="px-3 py-1.5 text-[11px] font-medium text-text-tertiary bg-surface-secondary/20">
                {group.label}
              </div>
              {group.items.map((presetOption) => {
                const active = presetOption.id === value;
                return (
                  <button
                    key={presetOption.id}
                    type="button"
                    onClick={() => {
                      onChange(presetOption.id);
                      setOpen(false);
                    }}
                    className={clsx(
                      'w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between gap-2',
                      active ? 'bg-accent-primary/10 text-text-primary' : 'hover:bg-surface-secondary/40 text-text-secondary'
                    )}
                  >
                    <span className="min-w-0 flex items-center gap-2">
                      <AiPresetLogo presetId={presetOption.id} label={presetOption.label} />
                      <span className="truncate">{presetOption.label}</span>
                    </span>
                    <Check className={clsx('w-4 h-4', active ? 'opacity-100 text-accent-primary' : 'opacity-0')} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const AiSourceSelect = ({
  value,
  sources,
  onChange,
  className,
}: {
  value: string;
  sources: AiSourceConfig[];
  onChange: (sourceId: string) => void;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSource = useMemo(() => {
    return sources.find((item) => item.id === value) || sources[0] || null;
  }, [sources, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors flex items-center justify-between gap-2"
      >
        <span className="min-w-0 flex items-center gap-2">
          {selectedSource ? (
            <AiSourceLogo source={selectedSource} />
          ) : (
            <span className="w-4 h-4 rounded-sm border border-border bg-surface-secondary/50" />
          )}
          <span className="truncate">{selectedSource?.name || '选择 AI 源'}</span>
        </span>
        <ChevronDown className={clsx('w-4 h-4 text-text-tertiary transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-[120] mt-1 w-full max-h-80 overflow-auto rounded-lg border border-border bg-surface-primary shadow-xl">
          {sources.map((source) => {
            const active = source.id === value;
            return (
              <button
                key={source.id}
                type="button"
                onClick={() => {
                  onChange(source.id);
                  setOpen(false);
                }}
                className={clsx(
                  'w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between gap-2',
                  active ? 'bg-accent-primary/10 text-text-primary' : 'hover:bg-surface-secondary/40 text-text-secondary'
                )}
              >
                <span className="min-w-0 flex items-center gap-2">
                  <AiSourceLogo source={source} />
                  <span className="truncate">{source.name || '未命名模型源'}</span>
                </span>
                <Check className={clsx('w-4 h-4', active ? 'opacity-100 text-accent-primary' : 'opacity-0')} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export interface AiModelOption {
  id: string;
  label?: string;
  badgeText?: string;
  badgeTone?: 'neutral' | 'recommended';
  badges?: Array<{
    text: string;
    tone?: 'neutral' | 'recommended';
    className?: string;
  }>;
  inputIcons?: Array<{
    key: string;
    label: string;
    icon: typeof FileText;
    className?: string;
  }>;
}

export const AiModelSelect = ({
  value,
  options,
  onChange,
  placeholder = '请选择模型',
  disabled = false,
  className,
}: {
  value: string;
  options: AiModelOption[];
  onChange: (modelId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = useMemo(() => {
    return options.find((item) => item.id === value) || null;
  }, [options, value]);
  const resolveBadges = (option: AiModelOption | null | undefined) => {
    if (!option) return [] as Array<{ text: string; tone?: 'neutral' | 'recommended'; className?: string }>;
    if (Array.isArray(option.badges) && option.badges.length > 0) {
      return option.badges;
    }
    if (option.badgeText) {
      return [{ text: option.badgeText, tone: option.badgeTone }];
    }
    return [] as Array<{ text: string; tone?: 'neutral' | 'recommended'; className?: string }>;
  };
  const renderInputIcons = (option: AiModelOption | null | undefined) => {
    const icons = Array.isArray(option?.inputIcons) ? option?.inputIcons || [] : [];
    if (!icons.length) return null;
    return (
      <span className="flex items-center gap-1">
        {icons.map((item) => {
          const Icon = item.icon;
          return (
            <span
              key={`${option?.id || 'selected'}-${item.key}`}
              title={item.label}
              aria-label={item.label}
              className={clsx(
                'inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors',
                item.className || 'text-text-tertiary bg-surface-secondary/60 ring-1 ring-border'
              )}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2.1} />
            </span>
          );
        })}
      </span>
    );
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        disabled={disabled}
        className={clsx(
          'w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors flex items-center justify-between gap-2',
          disabled && 'opacity-60 cursor-not-allowed'
        )}
      >
        <span className="min-w-0 flex items-center gap-2 overflow-hidden">
          <span className="truncate">{selectedOption?.label || selectedOption?.id || placeholder}</span>
          {resolveBadges(selectedOption).map((badge) => (
            <span
              key={`${selectedOption?.id || 'selected'}-${badge.text}`}
              className={clsx(
                'px-1.5 py-0.5 rounded text-[10px] leading-none whitespace-nowrap font-medium',
                badge.tone === 'recommended'
                  ? 'text-emerald-700'
                  : badge.className || 'text-text-tertiary'
              )}
            >
              {badge.text}
            </span>
          ))}
          {renderInputIcons(selectedOption)}
        </span>
        <ChevronDown className={clsx('w-4 h-4 text-text-tertiary transition-transform', open && 'rotate-180')} />
      </button>

      {open && !disabled && (
        <div className="absolute z-[120] mt-1 w-full max-h-80 overflow-auto rounded-lg border border-border bg-surface-primary shadow-xl">
          {!options.length ? (
            <div className="px-3 py-2 text-sm text-text-tertiary">{placeholder}</div>
          ) : (
            options.map((option) => {
              const active = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  className={clsx(
                    'w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between gap-2',
                    active ? 'bg-accent-primary/10 text-text-primary' : 'hover:bg-surface-secondary/40 text-text-secondary'
                  )}
                >
                  <span className="min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="truncate">{option.label || option.id}</span>
                    {resolveBadges(option).map((badge) => (
                      <span
                        key={`${option.id}-${badge.text}`}
                        className={clsx(
                          'px-1.5 py-0.5 rounded text-[10px] leading-none whitespace-nowrap font-medium',
                          badge.tone === 'recommended'
                            ? 'text-emerald-700'
                            : badge.className || 'text-text-tertiary'
                        )}
                      >
                        {badge.text}
                      </span>
                    ))}
                  </span>
                  <span className="flex items-center gap-2 pl-2">
                    {renderInputIcons(option)}
                    <Check className={clsx('w-4 h-4', active ? 'opacity-100 text-accent-primary' : 'opacity-0')} />
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export const IMAGE_TEMPLATE_DEFAULT_ENDPOINTS: Record<string, string> = {
  'openai-images': 'https://api.openai.com/v1',
  'gemini-openai-images': 'https://generativelanguage.googleapis.com/v1beta/openai',
  'gemini-imagen-native': 'https://generativelanguage.googleapis.com/v1beta',
  'dashscope-wan-native': 'https://dashscope.aliyuncs.com',
  'ark-seedream-native': 'https://ark.cn-beijing.volces.com/api/v3',
  'midjourney-proxy': 'http://127.0.0.1:8080',
  'jimeng-openai-wrapper': '',
  'gemini-generate-content': 'https://generativelanguage.googleapis.com/v1beta',
  'jimeng-images': '',
};
export const DASHSCOPE_LOCKED_IMAGE_MODEL = 'wan2.6-image';

export const resolveDefaultImageEndpoint = (provider: string, template: string): string => {
  const normalizedTemplate = inferImageTemplateByProvider(provider, template);
  if (Object.prototype.hasOwnProperty.call(IMAGE_TEMPLATE_DEFAULT_ENDPOINTS, normalizedTemplate)) {
    return IMAGE_TEMPLATE_DEFAULT_ENDPOINTS[normalizedTemplate];
  }
  return IMAGE_TEMPLATE_DEFAULT_ENDPOINTS['openai-images'];
};

export const isImageTemplateRemoteModelFetchEnabled = (template: string): boolean => {
  const normalized = String(template || '').trim();
  return (
    normalized === 'openai-images' ||
    normalized === 'gemini-openai-images' ||
    normalized === 'gemini-imagen-native' ||
    normalized === 'gemini-generate-content' ||
    normalized === 'dashscope-wan-native' ||
    normalized === 'ark-seedream-native'
  );
};

export const IMAGE_ASPECT_RATIO_OPTIONS = [
  { value: '3:4', label: '3:4 竖版封面' },
  { value: '4:3', label: '4:3 横版封面' },
  { value: '9:16', label: '9:16 竖屏视频' },
  { value: '16:9', label: '16:9 横屏视频' },
  { value: 'auto', label: 'auto' },
] as const;

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  oauth?: {
    enabled?: boolean;
    tokenPath?: string;
  };
}

export interface McpCapabilitySnapshot {
  connectionStrategy: string;
  initializeResponse?: unknown;
  toolsResponse?: unknown;
  resourcesResponse?: unknown;
  resourceTemplatesResponse?: unknown;
}

export interface McpSessionState {
  key: string;
  serverId: string;
  serverName: string;
  transport: 'stdio' | 'sse' | 'streamable-http' | string;
  connectionStrategy: string;
  initializedAt: number;
  lastUsedAt: number;
  callCount: number;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
}

export interface McpServerRuntimeItem {
  server: McpServerConfig;
  session?: McpSessionState | null;
}

export interface LocalAiGuide {
  title: string;
  command: string;
  tip: string;
}

export interface RedboxAuthUiSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number | null;
  apiKey: string;
  user: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface RedboxProductItem {
  id: string;
  name: string;
  amount?: number;
  points_topup?: number;
  [key: string]: unknown;
}

export interface RedboxCallRecordItem {
  id: string;
  model: string;
  endpoint: string;
  tokens: number;
  points: number;
  createdAt: string;
  status: string;
}

export const generateAiSourceId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai_source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

export const normalizeSourceModels = (models: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      models
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );
};

export const createAiSourceFromPreset = (presetId: string = DEFAULT_AI_PRESET_ID): AiSourceConfig => {
  const preset = findAiPresetById(presetId) || findAiPresetById(DEFAULT_AI_PRESET_ID);
  return {
    id: generateAiSourceId(),
    name: preset?.label || '自定义 AI 源',
    presetId: preset?.id || 'custom',
    baseURL: preset?.baseURL || '',
    apiKey: '',
    models: [],
    modelsMeta: [],
    model: '',
    protocol: preset?.protocol || 'openai',
  };
};

export const createAiSourceDraftFromPreset = (presetId: string = DEFAULT_AI_PRESET_ID): CreateAiSourceDraft => {
  const preset = findAiPresetById(presetId) || findAiPresetById(DEFAULT_AI_PRESET_ID);
  return {
    presetId: preset?.id || 'custom',
    name: preset?.label || '自定义 AI 源',
    baseURL: preset?.baseURL || '',
    apiKey: '',
    protocol: preset?.protocol || 'openai',
    setAsDefault: false,
  };
};

export const parseAiSources = (raw: string | undefined): AiSourceConfig[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => {
        const baseURL = String(item.baseURL || item.baseUrl || '');
        const presetId = String(item.presetId || inferPresetIdByEndpoint(baseURL) || 'custom');
        const model = String(item.model || item.modelName || '');
        const modelsMeta = normalizeAiModelDescriptors(
          Array.isArray(item.modelsMeta)
            ? item.modelsMeta.map((value) => (value && typeof value === 'object' ? value as { id?: string; capability?: ModelCapability | string | null | undefined; capabilities?: Array<ModelCapability | string | null | undefined> } : null))
            : [],
        );
        const models = Array.isArray(item.models)
          ? normalizeSourceModels(item.models.map((value) => String(value || '')))
          : normalizeSourceModels([model]);
        return {
          id: String(item.id || generateAiSourceId()),
          name: String(item.name || findAiPresetById(presetId)?.label || 'AI 源'),
          presetId,
          baseURL,
          apiKey: String(item.apiKey || item.key || ''),
          models,
          modelsMeta,
          model,
          protocol: (String(item.protocol || findAiPresetById(presetId)?.protocol || 'openai') as AiProtocol),
        } satisfies AiSourceConfig;
      });
    const seen = new Set<string>();
    return normalized.filter((source) => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    });
  } catch {
    return [];
  }
};

export const generateMcpServerId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

export const createDefaultMcpServer = (): McpServerConfig => ({
  id: generateMcpServerId(),
  name: 'New MCP Server',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  oauth: {
    enabled: false,
  },
});

export const parseMcpServers = (raw: string | undefined): McpServerConfig[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String(item.id || generateMcpServerId()),
        name: String(item.name || 'MCP Server'),
        enabled: item.enabled === undefined ? true : Boolean(item.enabled),
        transport: (item.transport === 'sse' || item.transport === 'streamable-http' ? item.transport : 'stdio'),
        command: String(item.command || ''),
        args: Array.isArray(item.args) ? item.args.map((arg) => String(arg || '').trim()).filter(Boolean) : [],
        env: item.env && typeof item.env === 'object'
          ? Object.fromEntries(
              Object.entries(item.env as Record<string, unknown>)
                .map(([key, value]) => [key, String(value || '').trim()])
                .filter(([, value]) => Boolean(value))
            )
          : {},
        url: String(item.url || ''),
        oauth: item.oauth && typeof item.oauth === 'object'
          ? {
              enabled: (item.oauth as Record<string, unknown>).enabled === undefined
                ? undefined
                : Boolean((item.oauth as Record<string, unknown>).enabled),
              tokenPath: String((item.oauth as Record<string, unknown>).tokenPath || ''),
            }
          : undefined,
      }));
  } catch {
    return [];
  }
};

export const stringifyEnvRecord = (env?: Record<string, string>): string => {
  if (!env) return '';
  return Object.entries(env)
    .filter(([key, value]) => Boolean(key.trim()) && Boolean(String(value || '').trim()))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
};

export const parseEnvText = (raw: string): Record<string, string> => {
  const lines = String(raw || '').split('\n');
  const entries: Array<[string, string]> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key || !value) continue;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

export const isLikelyTranscriptionModel = (modelId: string): boolean => {
  const id = String(modelId || '').toLowerCase();
  return id.includes('whisper')
    || id.includes('transcrib')
    || id.includes('asr')
    || id.includes('speech-to-text')
    || id.includes('stt');
};

export const isLikelyImageModel = (modelId: string): boolean => {
  const id = String(modelId || '').toLowerCase();
  return id.includes('image')
    || id.includes('dall')
    || id.includes('seedream')
    || id.includes('banana')
    || id.includes('wan')
    || id.includes('jimeng')
    || id.includes('flux')
    || id.includes('sd')
    || id.includes('stable')
    || id.includes('midjourney')
    || id.includes('imagen');
};

export const normalizeRechargeAmountInput = (raw: string): string => {
  const text = String(raw || '').trim();
  if (!text) return '';
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return numeric.toFixed(2);
};

export const isSettledSuccessOrderStatus = (status: string, tradeStatus: string, topupStatus: string): boolean => {
  const statusUpper = String(status || '').trim().toUpperCase();
  const tradeUpper = String(tradeStatus || '').trim().toUpperCase();
  const topupUpper = String(topupStatus || '').trim().toUpperCase();
  const paidByStatus = ['PAID', 'SUCCESS', 'COMPLETED', 'TRADE_SUCCESS', 'TRADE_FINISHED'].includes(statusUpper);
  const paidByTrade = /SUCCESS|FINISH|PAID/.test(tradeUpper);
  const topupDone = !topupUpper || topupUpper === 'SUCCESS' || topupUpper === 'NONE';
  return (paidByStatus || paidByTrade) && topupDone;
};

export const isSettledFailedOrderStatus = (status: string, tradeStatus: string): boolean => {
  const statusUpper = String(status || '').trim().toUpperCase();
  const tradeUpper = String(tradeStatus || '').trim().toUpperCase();
  return /CLOSE|FAIL|CANCEL|ERROR/.test(statusUpper) || /CLOSE|FAIL|CANCEL|ERROR/.test(tradeUpper);
};

export const decodeHtmlEntities = (value: string): string => {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
};

export const extractAlipayUrlFromForm = (paymentForm: string): string => {
  const raw = String(paymentForm || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;

  const formMatch = raw.match(/<form[\s\S]*?<\/form>/i);
  const formHtml = formMatch ? formMatch[0] : raw;
  const actionMatch = formHtml.match(/action\s*=\s*["']([^"']+)["']/i);
  const action = decodeHtmlEntities(String(actionMatch?.[1] || '').trim());
  if (!action) return '';

  const inputTagRegex = /<input\b[^>]*>/gi;
  const attrRegex = /([a-zA-Z_:][\w:.-]*)\s*=\s*["']([^"']*)["']/g;
  const params = new URLSearchParams();

  const inputTags = formHtml.match(inputTagRegex) || [];
  for (const inputTag of inputTags) {
    let name = '';
    let value = '';
    let attrMatch: RegExpExecArray | null;
    attrRegex.lastIndex = 0;
    while ((attrMatch = attrRegex.exec(inputTag)) !== null) {
      const key = String(attrMatch[1] || '').toLowerCase();
      const attrValue = decodeHtmlEntities(String(attrMatch[2] || ''));
      if (key === 'name') name = attrValue;
      if (key === 'value') value = attrValue;
    }
    if (name) {
      params.append(name, value);
    }
  }

  try {
    const url = new URL(action);
    params.forEach((value, key) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  } catch {
    return '';
  }
};

export const extractAlipayPayQrContent = (order: Record<string, unknown>): string => {
  const candidates = [
    order.payment_url,
    order.payment_form,
    order.url,
    order.code_url,
    order.qr_code,
    order.qrcode,
    order.qrCode,
  ];
  for (const value of candidates) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (/^https?:\/\//i.test(normalized)) return normalized;
    if (/<form[\s>]/i.test(normalized)) {
      const parsed = extractAlipayUrlFromForm(normalized);
      if (parsed) return parsed;
    }
  }
  return '';
};

export const filterOfficialModelsByCapability = (
  models: OfficialModelInfo[],
  capability: 'chat' | 'stt' | 'image' | 'embedding' | 'video' | 'audio',
): OfficialModelInfo[] => {
  const normalizedCapability = capability === 'stt' ? 'transcription' : capability;
  return models.filter((item) => {
    const capabilities = Array.isArray(item.capabilities) && item.capabilities.length > 0
      ? normalizeModelCapabilities(item.capabilities)
      : normalizeModelCapabilities([
        ...(item.capability ? [item.capability] : []),
        ...inferModelCapabilities(item.id),
      ]);
    return capabilities.includes(normalizedCapability as ModelCapability);
  });
};

export const toAiModelDescriptor = (
  model: string | { id?: string; capability?: ModelCapability | string | null | undefined; capabilities?: Array<ModelCapability | string | null | undefined> },
): AiModelDescriptor | null => {
  if (typeof model === 'string') {
    const id = model.trim();
    if (!id) return null;
    const forcedCapabilities = getForcedModelCapabilities(id);
    return {
      id,
      capabilities: forcedCapabilities.length > 0 ? forcedCapabilities : inferModelCapabilities(id),
      inputCapabilities: getModelInputCapabilities(id),
    };
  }

  const id = String(model?.id || '').trim();
  if (!id) return null;
  const forcedCapabilities = getForcedModelCapabilities(id);
  const explicitCapabilities = [
    ...(Array.isArray(model?.capabilities) ? model.capabilities : []),
    model?.capability,
  ];
  const capabilities = explicitCapabilities.some((value) => String(value || '').trim())
    ? normalizeModelCapabilities(explicitCapabilities)
    : inferModelCapabilities(id);
  return {
    id,
    capabilities: forcedCapabilities.length > 0 ? forcedCapabilities : capabilities,
    inputCapabilities: getModelInputCapabilities(id),
  };
};

export const filterAiModelsByCapability = (
  models: AiModelDescriptor[],
  capability: ModelCapability,
): AiModelDescriptor[] => {
  return models.filter((item) => item.capabilities.includes(capability));
};

export const buildModelCapabilityBadges = (
  capabilities: ModelCapability[],
  options?: { recommended?: boolean },
): Array<{ text: string; tone?: 'neutral' | 'recommended'; className?: string }> => {
  const badges: Array<{ text: string; tone?: 'neutral' | 'recommended'; className?: string }> = capabilities.map((capability) => ({
    text: MODEL_CAPABILITY_META[capability]?.shortLabel || capability,
    tone: 'neutral' as const,
    className: MODEL_CAPABILITY_BADGE_META[capability],
  }));
  if (options?.recommended) {
    badges.unshift({ text: '推荐', tone: 'recommended', className: 'text-emerald-700' });
  }
  return badges;
};

export const buildModelInputIcons = (
  inputCapabilities: ModelInputCapability[],
): Array<{ key: ModelInputCapability; label: string; icon: typeof FileText; className: string }> => {
  return normalizeModelInputCapabilities(inputCapabilities)
    .map((capability) => {
      const meta = MODEL_INPUT_META[capability];
      return {
        key: capability,
        label: meta.label,
        icon: meta.icon,
        className: meta.className,
      };
    });
};

export function PasswordInput({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={clsx(className, "pr-10")}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors"
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}
