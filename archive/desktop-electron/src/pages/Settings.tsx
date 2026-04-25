import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SetStateAction } from 'react';
import { Save, RefreshCw, AlertCircle, FolderOpen, Wrench, Download, LayoutGrid, Cpu, Trash2, Eye, EyeOff, Info, Plus, Star, ChevronDown, Check, FileText } from 'lucide-react';
import clsx from 'clsx';
import {
  AI_SOURCE_PRESETS,
  type AiSourcePreset,
  type AiSourceConfig,
  DEFAULT_AI_PRESET_ID,
  findAiPresetById,
  inferPresetIdByEndpoint
} from '../config/aiSources';
import { appAlert } from '../utils/appDialogs';
import {
  type AgentTaskSnapshot,
  type AgentTaskTrace,
  type AiProtocol,
  type AiPresetGroup,
  type RoleSpec,
  type BackgroundTaskItem,
  type BackgroundWorkerPoolState,
  type CreateAiSourceDraft,
  type LocalAiGuide,
  type McpServerRuntimeItem,
  type McpServerConfig,
  type McpSessionState,
  type RuntimePerfBenchmarkMode,
  type RuntimePerfPreset,
  type RuntimePerfRunResult,
  type RuntimePerfTimelineItem,
  type ToolDiagnosticDescriptor,
  type ToolDiagnosticRunResult,
  AiPresetLogo,
  AiPresetSelect,
  AiModelSelect,
  AiSourceLogo,
  AiSourceSelect,
  DASHSCOPE_LOCKED_IMAGE_MODEL,
  IMAGE_ASPECT_RATIO_OPTIONS,
  PasswordInput,
  type AiModelDescriptor,
  createAiSourceDraftFromPreset,
  buildModelCapabilityBadges,
  buildModelInputIcons,
  createAiSourceFromPreset,
  createDefaultMcpServer,
  filterAiModelsByCapability,
  generateAiSourceId,
  inferImageTemplateByProvider,
  isImageTemplateRemoteModelFetchEnabled,
  isLikelyLocalEndpoint,
  normalizeImageModelFetchBaseURL,
  normalizeAiModelDescriptors,
  normalizeSourceModels,
  parseAiSources,
  parseEnvText,
  parseMcpServers,
  resolveDefaultImageEndpoint,
  resolveImageModelFetchPresetId,
  resolveImageModelFetchProtocol,
  stringifyEnvRecord,
  toAiModelDescriptor,
} from './settings/shared';
import { type ModelCapability } from '../../shared/modelCapabilities';
import type {
  CliRuntimeEnvironmentRecord,
  CliRuntimeEnvironmentScope,
  CliRuntimeToolRecord,
  DiagnosticsLogStatus,
  DiagnosticsPendingReport,
  NotificationPermissionState,
  NotificationSettingsPayload,
} from '../types';
import {
  REDBOX_OFFICIAL_VIDEO_BASE_URL,
  REDBOX_OFFICIAL_VIDEO_MODEL_LIST,
  REDBOX_OFFICIAL_VIDEO_MODELS,
} from '../../shared/redboxVideo';
import {
  isRedClawOnboardingCompleted,
  type RedclawOnboardingState,
} from './redclaw/onboardingState';
import { hasOfficialAiPanel, loadOfficialAiPanelModule, type OfficialAiPanelProps } from '../features/official';
import { useOfficialAuthState } from '../hooks/useOfficialAuthState';
import {
  GeneralSettingsSection,
  SettingsSaveBar,
  ToolsSettingsSection,
} from './settings/SettingsSections';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import { playTestNotificationSound } from '../notifications/audio';
import { DEFAULT_NOTIFICATION_SETTINGS, parseNotificationSettings } from '../notifications/types';

const MIN_CHAT_MAX_TOKENS = 1024;
const DEFAULT_CHAT_MAX_TOKENS = 262144;
const DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK = 131072;
const DEVELOPER_MODE_UNLOCK_TAP_COUNT = 7;
const DEVELOPER_MODE_TTL_MS = 24 * 60 * 60 * 1000;
const SETTINGS_ACTIVATION_DEBOUNCE_MS = 80;
const SETTINGS_TAB_POLL_DELAY_MS = 300;
const RUNTIME_PERF_HISTORY_LIMIT = 12;
const RUNTIME_PERF_TIMELINE_LIMIT = 40;
const RUNTIME_PERF_CHECKPOINT_WINDOW_MS = 1500;
const RUNTIME_PERF_PRESETS: RuntimePerfPreset[] = [
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

type SettingsTab = 'general' | 'ai' | 'tools' | 'profile' | 'remote';

type RedclawProfileDraft = {
  user: string;
  creatorProfile: string;
};

const EMPTY_REDCLAW_PROFILE_DRAFT: RedclawProfileDraft = {
  user: '',
  creatorProfile: '',
};

const DEFAULT_SPACE_ID = 'default';

function normalizeNotificationPermissionState(
  value: unknown,
): NotificationPermissionState['state'] {
  const state = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (state === 'granted' || state === 'denied' || state === 'prompt') {
    return state;
  }
  return 'unknown';
}

type AssistantDaemonStatus = Awaited<ReturnType<typeof window.ipcRenderer.assistantDaemon.getStatus>>;
type RuntimeDiagnosticsSummary = Awaited<ReturnType<typeof window.ipcRenderer.debug.getRuntimeSummary>>;
type CliRuntimeInstallMethodOption = 'npm' | 'pnpm' | 'python' | 'uv' | 'cargo' | 'go' | 'binary';
type CliRuntimeInstallQueueItem = {
  installId: string;
  toolName: string;
  environmentId?: string;
  installMethod?: string;
  spec?: string;
  status: string;
  summary?: string;
  updatedAt: number;
};
type AssistantDaemonDraft = {
  enabled: boolean;
  autoStart: boolean;
  keepAliveWhenNoWindow: boolean;
  host: string;
  port: string;
  feishu: {
    enabled: boolean;
    receiveMode: 'webhook' | 'websocket';
    endpointPath: string;
    verificationToken: string;
    encryptKey: string;
    appId: string;
    appSecret: string;
    replyUsingChatId: boolean;
  };
  relay: {
    enabled: boolean;
    endpointPath: string;
    authToken: string;
  };
  weixin: {
    enabled: boolean;
    endpointPath: string;
    authToken: string;
    accountId: string;
    autoStartSidecar: boolean;
    cursorFile: string;
    sidecarCommand: string;
    sidecarArgs: string;
    sidecarCwd: string;
    sidecarEnvText: string;
  };
};

type AssistantDaemonWeixinLoginState = {
  sessionKey?: string;
  qrcodeUrl?: string;
  qrcodeImageUrl?: string;
  message: string;
  accountId?: string;
  userId?: string;
  connected: boolean;
  stateDir?: string;
};

const createDefaultAssistantDaemonDraft = (): AssistantDaemonDraft => ({
  enabled: true,
  autoStart: true,
  keepAliveWhenNoWindow: true,
  host: '127.0.0.1',
  port: '31937',
  feishu: {
    enabled: false,
    receiveMode: 'webhook',
    endpointPath: '/hooks/feishu/events',
    verificationToken: '',
    encryptKey: '',
    appId: '',
    appSecret: '',
    replyUsingChatId: true,
  },
  relay: {
    enabled: true,
    endpointPath: '/hooks/channel/relay',
    authToken: '',
  },
  weixin: {
    enabled: false,
    endpointPath: '/hooks/weixin/relay',
    authToken: '',
    accountId: '',
    autoStartSidecar: false,
    cursorFile: '',
    sidecarCommand: '',
    sidecarArgs: '',
    sidecarCwd: '',
    sidecarEnvText: '',
  },
});

const assistantDaemonStatusToDraft = (status?: AssistantDaemonStatus | null): AssistantDaemonDraft => {
  if (!status) return createDefaultAssistantDaemonDraft();
  return {
    enabled: Boolean(status.enabled),
    autoStart: Boolean(status.autoStart),
    keepAliveWhenNoWindow: Boolean(status.keepAliveWhenNoWindow),
    host: String(status.host || '127.0.0.1'),
    port: String(status.port || 31937),
    feishu: {
      enabled: Boolean(status.feishu?.enabled),
      receiveMode: status.feishu?.receiveMode === 'websocket' ? 'websocket' : 'webhook',
      endpointPath: String(status.feishu?.endpointPath || '/hooks/feishu/events'),
      verificationToken: String(status.feishu?.verificationToken || ''),
      encryptKey: String(status.feishu?.encryptKey || ''),
      appId: String(status.feishu?.appId || ''),
      appSecret: String(status.feishu?.appSecret || ''),
      replyUsingChatId: status.feishu?.replyUsingChatId !== false,
    },
    relay: {
      enabled: status.relay?.enabled !== false,
      endpointPath: String(status.relay?.endpointPath || '/hooks/channel/relay'),
      authToken: String(status.relay?.authToken || ''),
    },
    weixin: {
      enabled: Boolean(status.weixin?.enabled),
      endpointPath: String(status.weixin?.endpointPath || '/hooks/weixin/relay'),
      authToken: String(status.weixin?.authToken || ''),
      accountId: String(status.weixin?.accountId || ''),
      autoStartSidecar: Boolean(status.weixin?.autoStartSidecar),
      cursorFile: String(status.weixin?.cursorFile || ''),
      sidecarCommand: String(status.weixin?.sidecarCommand || ''),
      sidecarArgs: Array.isArray(status.weixin?.sidecarArgs) ? status.weixin.sidecarArgs.join(' ') : '',
      sidecarCwd: String(status.weixin?.sidecarCwd || ''),
      sidecarEnvText: stringifyEnvRecord(status.weixin?.sidecarEnv || {}),
    },
  };
};

type RuntimeSessionListItem = {
  id: string;
  runtimeMode?: string;
  contextBinding?: {
    contextType?: string;
    contextId?: string;
    isContextBound?: boolean;
  } | null;
  transcriptCount: number;
  checkpointCount: number;
  chatSession?: {
    id: string;
    title?: string;
    updatedAt?: string;
  } | null;
};

type RuntimeSessionTranscriptItem = {
  id: number;
  sessionId: string;
  recordType: string;
  role: string;
  content: string;
  payload?: unknown;
  createdAt: number;
};

type RuntimeSessionCheckpointItem = {
  id: string;
  sessionId: string;
  checkpointType: string;
  summary: string;
  payload?: unknown;
  createdAt: number;
};

type RuntimeSessionToolResultItem = {
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
};

type RuntimeHookDefinition = {
  id: string;
  event: string;
  type: string;
  matcher?: string;
  enabled?: boolean;
};

type RuntimePerfCollector = {
  runId: string;
  sessionId: string;
  startedAt: number;
  thinkingStartedMs?: number;
  thoughtFirstTokenMs?: number;
  firstResponseMs?: number;
  firstToolStartMs?: number;
  firstCheckpointMs?: number;
  toolCalls: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  checkpointCount: number;
  checkpointTypes: string[];
  responseChars?: number;
  timeline: RuntimePerfTimelineItem[];
};

function toRuntimePerfRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function toRuntimePerfText(value: unknown): string {
  return String(value || '').trim();
}

function toRuntimePerfNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeCliRuntimeToolRecord(value: unknown): CliRuntimeToolRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || record.toolId || '').trim();
  const executable = String(record.executable || record.command || '').trim();
  const name = String(record.name || executable || id).trim();
  if (!id && !name && !executable) return null;
  return {
    id: id || name || executable,
    name: name || executable || id,
    executable: executable || name || id,
    resolvedPath: String(record.resolvedPath || record.resolved_path || '').trim() || null,
    resolvedFrom: String(record.resolvedFrom || record.resolved_from || '').trim().toLowerCase() as CliRuntimeToolRecord['resolvedFrom'],
    source: String(record.source || 'unknown').trim().toLowerCase() as CliRuntimeToolRecord['source'],
    installMethod: String(record.installMethod || record.install_method || '').trim() || null,
    installSpec: String(record.installSpec || record.install_spec || '').trim() || null,
    version: String(record.version || '').trim() || null,
    health: String(record.health || 'unknown').trim().toLowerCase() as CliRuntimeToolRecord['health'],
    manifestId: String(record.manifestId || record.manifest_id || '').trim() || null,
    environmentId: String(record.environmentId || record.environment_id || '').trim() || null,
    lastCheckedAt: toRuntimePerfNumber(record.lastCheckedAt) ?? null,
    effectivePathPreview: Array.isArray(record.effectivePathPreview)
      ? record.effectivePathPreview.map((item) => String(item || '').trim()).filter(Boolean)
      : Array.isArray(record.effective_path_preview)
        ? (record.effective_path_preview as unknown[]).map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    searchedPathEntriesCount:
      toRuntimePerfNumber(record.searchedPathEntriesCount)
      ?? toRuntimePerfNumber(record.searched_path_entries_count)
      ?? null,
    isInDefaultDetectCatalog:
      record.isInDefaultDetectCatalog === true || record.is_in_default_detect_catalog === true,
    metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : null,
  };
}

function normalizeCliRuntimeEnvironmentRecord(value: unknown): CliRuntimeEnvironmentRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || '').trim();
  const rootPath = String(record.rootPath || record.root_path || '').trim();
  if (!id && !rootPath) return null;
  return {
    id: id || rootPath,
    scope: String(record.scope || 'workspace-local').trim().toLowerCase() as CliRuntimeEnvironmentRecord['scope'],
    rootPath,
    workspaceRoot: String(record.workspaceRoot || record.workspace_root || '').trim() || null,
    pathEntries: Array.isArray(record.pathEntries)
      ? record.pathEntries.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    installedToolIds: Array.isArray(record.installedToolIds)
      ? record.installedToolIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    runtimes: record.runtimes && typeof record.runtimes === 'object' ? record.runtimes as Record<string, unknown> : null,
    createdAt: toRuntimePerfNumber(record.createdAt) ?? null,
    updatedAt: toRuntimePerfNumber(record.updatedAt) ?? null,
    metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : null,
  };
}

function runtimePerfContextTypeForMode(mode: RuntimePerfBenchmarkMode): string {
  if (mode === 'chatroom') return 'chatroom';
  if (mode === 'diagnostics') return 'diagnostics';
  return mode;
}

function formatRuntimePerfRunIndex(index: number): string {
  return `Run ${String(index).padStart(2, '0')}`;
}

const sanitizeChatMaxTokensInput = (value: string, fallback: number): string => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_CHAT_MAX_TOKENS) {
    return String(fallback);
  }
  return String(Math.floor(parsed));
};

export function Settings({
  isActive = true,
  onOpenRedClawOnboarding,
  redclawOnboardingVersion = 0,
}: {
  isActive?: boolean;
  onOpenRedClawOnboarding?: () => void;
  redclawOnboardingVersion?: number;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [formData, setFormData] = useState<any>({
    api_endpoint: '',
    api_key: '',
    model_name: '',
    workspace_dir: '',
    transcription_model: '',
    transcription_endpoint: '',
    transcription_key: '',
    embedding_endpoint: '',
    embedding_key: '',
    embedding_model: '',
    image_provider: 'openai-compatible',
    image_endpoint: '',
    image_api_key: '',
    image_model: 'gpt-image-1',
    video_endpoint: '',
    video_api_key: '',
    video_model: String(REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video']),
    image_provider_template: 'openai-images',
    image_aspect_ratio: '3:4',
    image_size: '',
    image_quality: 'auto',
    model_name_wander: '',
    model_name_chatroom: '',
    model_name_knowledge: '',
    model_name_redclaw: '',
    proxy_enabled: false,
    proxy_url: '',
    proxy_bypass: 'localhost,127.0.0.1,::1',
    redclaw_compact_target_tokens: '256000',
    chat_max_tokens_default: String(DEFAULT_CHAT_MAX_TOKENS),
    chat_max_tokens_deepseek: String(DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK),
    wander_deep_think_enabled: false,
    debug_log_enabled: false,
    diagnostics_upload_consent: 'prompt',
    diagnostics_include_advanced_context: false,
    diagnostics_auto_send_same_crash: false,
    diagnostics_last_prompted_at: '',
    release_log_retention_days: '7',
    release_log_max_file_mb: '10',
    developer_mode_enabled: false,
    developer_mode_unlocked_at: '',
  });
  const [aiSources, setAiSources] = useState<AiSourceConfig[]>([]);
  const [defaultAiSourceId, setDefaultAiSourceId] = useState('');
  const [activeAiSourceId, setActiveAiSourceId] = useState('');
  const [detectedAiProtocol, setDetectedAiProtocol] = useState<AiProtocol>('openai');
  const [aiSourceExpandState, setAiSourceExpandState] = useState<Record<string, boolean>>({});
  const [aiSourceModelExpandState, setAiSourceModelExpandState] = useState<Record<string, boolean>>({});
  const [sourceModelDrafts, setSourceModelDrafts] = useState<Record<string, string>>({});
  const [sourceModelCapabilityDrafts, setSourceModelCapabilityDrafts] = useState<Record<string, ModelCapability>>({});
  const [addModelModalSourceId, setAddModelModalSourceId] = useState('');
  const [isCreateAiSourceModalOpen, setIsCreateAiSourceModalOpen] = useState(false);
  const [createAiSourceDraft, setCreateAiSourceDraft] = useState<CreateAiSourceDraft>(() => createAiSourceDraftFromPreset(DEFAULT_AI_PRESET_ID));
  const [transcriptionSourceId, setTranscriptionSourceId] = useState('');
  const [embeddingSourceId, setEmbeddingSourceId] = useState('');
  const [imageSourceId, setImageSourceId] = useState('');
  const [modelsBySource, setModelsBySource] = useState<Record<string, AiModelDescriptor[]>>({});
  const [fetchingModelsBySourceId, setFetchingModelsBySourceId] = useState<Record<string, boolean>>({});
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [imageAvailableModels, setImageAvailableModels] = useState<Array<{ id: string; source: 'remote' | 'suggested' }>>([]);
  const [isFetchingImageModels, setIsFetchingImageModels] = useState(false);
  const [imageModelStatus, setImageModelStatus] = useState('');
  const [recentDebugLogs, setRecentDebugLogs] = useState<string[]>([]);
  const [isDebugLogsLoading, setIsDebugLogsLoading] = useState(false);
  const [logStatus, setLogStatus] = useState<DiagnosticsLogStatus | null>(null);
  const [pendingDiagnosticReports, setPendingDiagnosticReports] = useState<DiagnosticsPendingReport[]>([]);
  const [diagnosticsActionBusy, setDiagnosticsActionBusy] = useState<string | null>(null);
  const [toolDiagnostics, setToolDiagnostics] = useState<ToolDiagnosticDescriptor[]>([]);
  const [toolDiagnosticResults, setToolDiagnosticResults] = useState<Record<string, ToolDiagnosticRunResult | undefined>>({});
  const [toolDiagnosticRunning, setToolDiagnosticRunning] = useState<Record<string, 'direct' | 'ai' | undefined>>({});
  const [runtimeTasks, setRuntimeTasks] = useState<AgentTaskSnapshot[]>([]);
  const [runtimeRoles, setRuntimeRoles] = useState<RoleSpec[]>([]);
  const [runtimeDiagnosticsSummary, setRuntimeDiagnosticsSummary] = useState<RuntimeDiagnosticsSummary | null>(null);
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSessionListItem[]>([]);
  const [selectedRuntimeTaskId, setSelectedRuntimeTaskId] = useState('');
  const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = useState('');
  const [runtimeTaskTraces, setRuntimeTaskTraces] = useState<AgentTaskTrace[]>([]);
  const [runtimeSessionTranscript, setRuntimeSessionTranscript] = useState<RuntimeSessionTranscriptItem[]>([]);
  const [runtimeSessionCheckpoints, setRuntimeSessionCheckpoints] = useState<RuntimeSessionCheckpointItem[]>([]);
  const [runtimeSessionToolResults, setRuntimeSessionToolResults] = useState<RuntimeSessionToolResultItem[]>([]);
  const [runtimeHooks, setRuntimeHooks] = useState<RuntimeHookDefinition[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskItem[]>([]);
  const [backgroundWorkerPool, setBackgroundWorkerPool] = useState<BackgroundWorkerPoolState>({ json: [], runtime: [] });
  const [selectedBackgroundTaskId, setSelectedBackgroundTaskId] = useState('');
  const [selectedBackgroundTaskDetail, setSelectedBackgroundTaskDetail] = useState<BackgroundTaskItem | null>(null);
  const [runtimeDraftInput, setRuntimeDraftInput] = useState('');
  const [runtimeDraftMode, setRuntimeDraftMode] = useState<'redclaw' | 'knowledge' | 'chatroom' | 'advisor-discussion' | 'background-maintenance' | 'diagnostics'>('redclaw');
  const [isRuntimeLoading, setIsRuntimeLoading] = useState(false);
  const [isRuntimeTraceLoading, setIsRuntimeTraceLoading] = useState(false);
  const [isRuntimeSessionLoading, setIsRuntimeSessionLoading] = useState(false);
  const [isBackgroundTasksLoading, setIsBackgroundTasksLoading] = useState(false);
  const [isRuntimeCreating, setIsRuntimeCreating] = useState(false);
  const [runtimeTaskActionRunning, setRuntimeTaskActionRunning] = useState<Record<string, 'resume' | 'cancel' | undefined>>({});
  const [backgroundTaskActionRunning, setBackgroundTaskActionRunning] = useState<Record<string, 'cancel' | undefined>>({});
  const [runtimePerfMode, setRuntimePerfMode] = useState<RuntimePerfBenchmarkMode>('diagnostics');
  const [runtimePerfPresetId, setRuntimePerfPresetId] = useState<string>(RUNTIME_PERF_PRESETS[0].id);
  const [runtimePerfMessage, setRuntimePerfMessage] = useState<string>(RUNTIME_PERF_PRESETS[0].message);
  const [runtimePerfIterations, setRuntimePerfIterations] = useState(1);
  const [isRuntimePerfRunning, setIsRuntimePerfRunning] = useState(false);
  const [runtimePerfStatusMessage, setRuntimePerfStatusMessage] = useState('');
  const [runtimePerfResults, setRuntimePerfResults] = useState<RuntimePerfRunResult[]>([]);
  const [activeRuntimePerfRunId, setActiveRuntimePerfRunId] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [redclawProfileDraft, setRedclawProfileDraft] = useState<RedclawProfileDraft>(EMPTY_REDCLAW_PROFILE_DRAFT);
  const [savedRedclawProfileDraft, setSavedRedclawProfileDraft] = useState<RedclawProfileDraft>(EMPTY_REDCLAW_PROFILE_DRAFT);
  const [redclawProfileRoot, setRedclawProfileRoot] = useState('');
  const [isRedclawProfileLoading, setIsRedclawProfileLoading] = useState(false);
  const [redclawProfileDirty, setRedclawProfileDirty] = useState(false);
  const [redclawProfileMessage, setRedclawProfileMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [redclawOnboardingState, setRedclawOnboardingState] = useState<RedclawOnboardingState>(null);
  const [currentSpaceId, setCurrentSpaceId] = useState(DEFAULT_SPACE_ID);
  const [assistantDaemonStatus, setAssistantDaemonStatus] = useState<AssistantDaemonStatus | null>(null);
  const [assistantDaemonDraft, setAssistantDaemonDraftState] = useState<AssistantDaemonDraft>(() => createDefaultAssistantDaemonDraft());
  const [assistantDaemonLogs, setAssistantDaemonLogs] = useState<string[]>([]);
  const [assistantDaemonBusy, setAssistantDaemonBusy] = useState(false);
  const [assistantDaemonDraftDirty, setAssistantDaemonDraftDirty] = useState(false);
  const [assistantDaemonWeixinLoginBusy, setAssistantDaemonWeixinLoginBusy] = useState(false);
  const [assistantDaemonWeixinLogin, setAssistantDaemonWeixinLogin] = useState<AssistantDaemonWeixinLoginState | null>(null);
  const [showScopedModelOverrides, setShowScopedModelOverrides] = useState(false);
  const [developerVersionTapCount, setDeveloperVersionTapCount] = useState(0);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettingsPayload>(DEFAULT_NOTIFICATION_SETTINGS);
  const [notificationPermissionState, setNotificationPermissionState] = useState<NotificationPermissionState['state']>('unknown');
  const [notificationStatusMessage, setNotificationStatusMessage] = useState('');
  const hasSelectedRuntimeSession = useMemo(
    () => Boolean(selectedRuntimeSessionId && runtimeSessions.some((session) => session.id === selectedRuntimeSessionId)),
    [runtimeSessions, selectedRuntimeSessionId],
  );
  const redclawOnboardingCompleted = useMemo(
    () => isRedClawOnboardingCompleted(redclawOnboardingState),
    [redclawOnboardingState],
  );

  const updateRuntimePerfRun = useCallback((runId: string, updater: (run: RuntimePerfRunResult) => RuntimePerfRunResult) => {
    setRuntimePerfResults((prev) =>
      prev.map((run) => (run.id === runId ? updater(run) : run))
    );
  }, []);

  const snapshotRuntimePerfCollector = useCallback((collector: RuntimePerfCollector) => ({
    thinkingStartedMs: collector.thinkingStartedMs,
    thoughtFirstTokenMs: collector.thoughtFirstTokenMs,
    firstResponseMs: collector.firstResponseMs,
    firstToolStartMs: collector.firstToolStartMs,
    firstCheckpointMs: collector.firstCheckpointMs,
    responseChars: collector.responseChars,
    toolCalls: collector.toolCalls,
    toolSuccessCount: collector.toolSuccessCount,
    toolFailureCount: collector.toolFailureCount,
    checkpointCount: collector.checkpointCount,
    checkpointTypes: [...collector.checkpointTypes],
    timeline: [...collector.timeline],
  }), []);

  const appendRuntimePerfTimeline = useCallback((
    collector: RuntimePerfCollector,
    event: Omit<RuntimePerfTimelineItem, 'id' | 'offsetMs'> & { offsetMs?: number },
  ) => {
    const offsetMs = typeof event.offsetMs === 'number'
      ? event.offsetMs
      : Math.max(0, event.at - collector.startedAt);
    const item: RuntimePerfTimelineItem = {
      id: `${collector.runId}:${collector.timeline.length}:${event.eventType}:${event.at}`,
      at: event.at,
      offsetMs,
      eventType: event.eventType,
      label: event.label,
      detail: event.detail,
      tone: event.tone,
    };
    collector.timeline = [...collector.timeline, item].slice(-RUNTIME_PERF_TIMELINE_LIMIT);
  }, []);

  const buildWeixinQrImageUrl = useCallback(async (rawUrl?: string): Promise<string | undefined> => {
    const text = String(rawUrl || '').trim();
    if (!text) return undefined;
    try {
      const QRCode = await import('qrcode');
      return await QRCode.toDataURL(text, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      });
    } catch (error) {
      console.error('Failed to build Weixin QR image', error);
      return undefined;
    }
  }, []);

  const setRedclawProfileDirtyState = useCallback((next: boolean) => {
    redclawProfileDirtyRef.current = next;
    setRedclawProfileDirty(next);
  }, []);

  const setCurrentSpaceState = useCallback((spaceId?: string | null) => {
    const normalized = String(spaceId || '').trim() || DEFAULT_SPACE_ID;
    currentSpaceIdRef.current = normalized;
    setCurrentSpaceId(normalized);
    return normalized;
  }, []);

  const resetRedclawProfileState = useCallback(() => {
    redclawProfileLoadRequestRef.current += 1;
    setRedclawProfileRoot('');
    setSavedRedclawProfileDraft(EMPTY_REDCLAW_PROFILE_DRAFT);
    setRedclawProfileDraft(EMPTY_REDCLAW_PROFILE_DRAFT);
    setRedclawOnboardingState(null);
    setRedclawProfileDirtyState(false);
    setRedclawProfileMessage(null);
    setIsRedclawProfileLoading(false);
  }, [setRedclawProfileDirtyState]);

  const loadRedclawProfileBundle = useCallback(async (options?: { preserveDraft?: boolean; expectedSpaceId?: string }) => {
    const expectedSpaceId = String(options?.expectedSpaceId || currentSpaceIdRef.current || DEFAULT_SPACE_ID).trim() || DEFAULT_SPACE_ID;
    const requestId = ++redclawProfileLoadRequestRef.current;
    setIsRedclawProfileLoading(true);
    try {
      const bundle = await window.ipcRenderer.redclawProfile.getBundle();
      if (requestId !== redclawProfileLoadRequestRef.current) return;
      const responseSpaceId = String(bundle.activeSpaceId || expectedSpaceId).trim() || DEFAULT_SPACE_ID;
      if (responseSpaceId !== currentSpaceIdRef.current) {
        setCurrentSpaceState(responseSpaceId);
      }
      setRedclawOnboardingState(
        bundle.onboardingState && typeof bundle.onboardingState === 'object'
          ? bundle.onboardingState as Record<string, unknown>
          : null
      );
      if (options?.preserveDraft && redclawProfileDirtyRef.current) {
        setRedclawProfileRoot(String(bundle.profileRoot || '').trim());
        return;
      }
      const files = bundle.files || {};
      const nextDraft: RedclawProfileDraft = {
        user: String(bundle.user || files.user || ''),
        creatorProfile: String(bundle.creatorProfile || files.creatorProfile || ''),
      };
      setRedclawProfileRoot(String(bundle.profileRoot || '').trim());
      setSavedRedclawProfileDraft(nextDraft);
      setRedclawProfileDraft(nextDraft);
      setRedclawProfileDirtyState(false);
      setRedclawProfileMessage(null);
    } catch (error) {
      if (requestId !== redclawProfileLoadRequestRef.current) return;
      console.error('Failed to load RedClaw profile bundle', error);
      setRedclawProfileMessage({
        tone: 'error',
        text: `加载用户档案失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      if (requestId === redclawProfileLoadRequestRef.current) {
        setIsRedclawProfileLoading(false);
      }
    }
  }, [setRedclawProfileDirtyState]);

  const handleRedclawProfileDraftChange = useCallback((field: keyof RedclawProfileDraft, value: string) => {
    setRedclawProfileDraft((prev) => {
      const next = {
        ...prev,
        [field]: value,
      };
      const dirty = next.user !== savedRedclawProfileDraft.user
        || next.creatorProfile !== savedRedclawProfileDraft.creatorProfile;
      setRedclawProfileDirtyState(dirty);
      return next;
    });
    setRedclawProfileMessage(null);
    setStatus('idle');
  }, [savedRedclawProfileDraft.creatorProfile, savedRedclawProfileDraft.user, setRedclawProfileDirtyState]);

  const fetchModelsRequestRef = useRef<Record<string, number>>({});
  const fetchImageModelsRequestRef = useRef(0);
  const settingsLoadRequestRef = useRef(0);
  const debugLogsLoadRequestRef = useRef(0);
  const runtimeTasksLoadRequestRef = useRef(0);
  const runtimeSummaryLoadRequestRef = useRef(0);
  const runtimeSessionsLoadRequestRef = useRef(0);
  const runtimeTaskTracesLoadRequestRef = useRef(0);
  const runtimeSessionDetailsLoadRequestRef = useRef(0);
  const runtimeObservabilityRefreshTimerRef = useRef<number | null>(null);
  const runtimePerfCollectorRef = useRef<RuntimePerfCollector | null>(null);
  const runtimePerfRunCounterRef = useRef(0);
  const backgroundTasksLoadRequestRef = useRef(0);
  const backgroundWorkerPoolLoadRequestRef = useRef(0);
  const assistantDaemonLogBufferRef = useRef<string[]>([]);
  const assistantDaemonLogFlushTimerRef = useRef<number | null>(null);
  const aiSourceAutosaveTimerRef = useRef<number | null>(null);
  const remoteTabWarmTimerRef = useRef<number | null>(null);
  const settingsActivationTimerRef = useRef<number | null>(null);
  const redclawProfileLoadRequestRef = useRef(0);
  const baseSettingsLoadedRef = useRef(false);
  const baseSettingsInFlightRef = useRef(false);
  const aiSourceDraftDirtyRef = useRef(false);
  const redclawProfileDirtyRef = useRef(false);
  const currentSpaceIdRef = useRef(DEFAULT_SPACE_ID);
  const tabWarmRef = useRef<Record<SettingsTab, boolean>>({
    general: false,
    ai: false,
    tools: false,
    profile: false,
    remote: false,
  });
  const tabInFlightRef = useRef<Record<SettingsTab, boolean>>({
    general: false,
    ai: false,
    tools: false,
    profile: false,
    remote: false,
  });

  const defaultAiSource = useMemo(() => {
    if (!aiSources.length) return null;
    return aiSources.find((source) => source.id === defaultAiSourceId) || aiSources[0];
  }, [aiSources, defaultAiSourceId]);

  const activeAiSource = useMemo(() => {
    if (!aiSources.length) return null;
    return aiSources.find((source) => source.id === activeAiSourceId) || defaultAiSource || aiSources[0];
  }, [aiSources, activeAiSourceId, defaultAiSource]);

  const addModelModalSource = useMemo(() => {
    if (!addModelModalSourceId) return null;
    return aiSources.find((source) => source.id === addModelModalSourceId) || null;
  }, [aiSources, addModelModalSourceId]);

  const getSourceAvailableModels = useCallback((sourceId: string) => {
    return modelsBySource[sourceId] || [];
  }, [modelsBySource]);

  const getSourceModelList = useCallback((source: AiSourceConfig) => {
    const merged = new Map<string, AiModelDescriptor>();
    for (const raw of (source.modelsMeta || [])) {
      const descriptor = toAiModelDescriptor(raw);
      if (!descriptor) continue;
      merged.set(descriptor.id, descriptor);
    }
    for (const raw of [...(source.models || []), source.model]) {
      const descriptor = toAiModelDescriptor(raw);
      if (!descriptor) continue;
      const previous = merged.get(descriptor.id);
      merged.set(descriptor.id, {
        id: descriptor.id,
        capabilities: Array.from(new Set([...(previous?.capabilities || []), ...descriptor.capabilities])),
        inputCapabilities: Array.from(new Set([...(previous?.inputCapabilities || []), ...descriptor.inputCapabilities])),
      });
    }
    for (const remoteModel of (modelsBySource[source.id] || [])) {
      const descriptor = toAiModelDescriptor(remoteModel);
      if (!descriptor) continue;
      const previous = merged.get(descriptor.id);
      merged.set(descriptor.id, {
        id: descriptor.id,
        capabilities: Array.from(new Set([...(previous?.capabilities || []), ...descriptor.capabilities])),
        inputCapabilities: Array.from(new Set([...(previous?.inputCapabilities || []), ...descriptor.inputCapabilities])),
      });
    }
    return Array.from(merged.values());
  }, [modelsBySource]);

  const getAddedSourceModelList = useCallback((source: AiSourceConfig) => {
    return normalizeAiModelDescriptors([
      ...(source.modelsMeta || []),
      ...(source.models || []).map((id) => ({ id })),
      source.model ? { id: source.model } : null,
    ]);
  }, []);

  const getAiSourceById = useCallback((sourceId: string): AiSourceConfig | null => {
    const normalizedSourceId = String(sourceId || '').trim();
    if (!normalizedSourceId) return null;
    return aiSources.find((source) => source.id === normalizedSourceId) || null;
  }, [aiSources]);

  const pickBestModelForSource = useCallback((
    source: AiSourceConfig | null,
    preferredModel?: string,
    capability: ModelCapability = 'chat',
  ): string => {
    if (!source) return '';
    const normalizedPreferredModel = String(preferredModel || '').trim();
    const sourceModels = getSourceModelList(source);
    const matchingModels = filterAiModelsByCapability(sourceModels, capability);
    if (normalizedPreferredModel && matchingModels.some((item) => item.id === normalizedPreferredModel)) {
      return normalizedPreferredModel;
    }
    const currentDefault = String(source.model || '').trim();
    if (currentDefault && matchingModels.some((item) => item.id === currentDefault)) {
      return currentDefault;
    }
    return String(matchingModels[0]?.id || currentDefault || sourceModels[0]?.id || '').trim();
  }, [getSourceModelList]);

  const resolveLinkedSourceId = useCallback((options: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    fallbackId?: string;
  }): string => {
    if (!aiSources.length) return '';
    const normalizedEndpoint = String(options.endpoint || '').trim();
    const normalizedApiKey = String(options.apiKey || '').trim();
    const normalizedModel = String(options.model || '').trim();
    let bestSourceId = '';
    let bestScore = -1;

    for (const source of aiSources) {
      let score = 0;
      const sourceEndpoint = String(source.baseURL || '').trim();
      const sourceApiKey = String(source.apiKey || '').trim();
      const sourceModels = getSourceModelList(source).map((item) => item.id);
      if (normalizedEndpoint && sourceEndpoint === normalizedEndpoint) score += 4;
      if (normalizedApiKey && sourceApiKey && sourceApiKey === normalizedApiKey) score += 2;
      if (normalizedModel && sourceModels.includes(normalizedModel)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestSourceId = source.id;
      }
    }

    if (bestScore > 0 && bestSourceId) return bestSourceId;
    const fallbackId = String(options.fallbackId || '').trim();
    if (fallbackId && aiSources.some((source) => source.id === fallbackId)) return fallbackId;
    return defaultAiSourceId || aiSources[0]?.id || '';
  }, [aiSources, defaultAiSourceId, getSourceModelList]);

  const inferImageRoutingFromSource = useCallback((source: AiSourceConfig) => {
    const presetId = String(source.presetId || inferPresetIdByEndpoint(source.baseURL || '') || '').trim().toLowerCase();
    if (presetId === 'buts') {
      return { provider: 'buts', template: 'dashscope-wan-native' };
    }
    if (presetId.includes('dashscope') || presetId.includes('qwen')) {
      return { provider: 'dashscope', template: 'dashscope-wan-native' };
    }
    if (presetId.includes('jimeng')) {
      return { provider: 'jimeng', template: 'jimeng-openai-wrapper' };
    }
    if (presetId.includes('ark')) {
      return { provider: 'ark-seedream', template: 'ark-seedream-native' };
    }
    if (presetId.includes('gemini')) {
      return { provider: 'gemini', template: 'gemini-openai-images' };
    }
    return { provider: 'openai-compatible', template: 'openai-images' };
  }, []);

  const handleLinkedSourceChange = useCallback((feature: 'transcription' | 'embedding' | 'image' | 'video', nextSourceId: string) => {
    const source = getAiSourceById(nextSourceId);
    if (!source) return;

    if (feature === 'transcription') setTranscriptionSourceId(nextSourceId);
    if (feature === 'embedding') setEmbeddingSourceId(nextSourceId);
    if (feature === 'image') setImageSourceId(nextSourceId);
    setFormData((prev) => {
      if (feature === 'transcription') {
        return {
          ...prev,
          transcription_endpoint: String(source.baseURL || '').trim(),
          transcription_key: String(source.apiKey || '').trim(),
          transcription_model: pickBestModelForSource(source, prev.transcription_model, 'transcription'),
        };
      }
      if (feature === 'embedding') {
        return {
          ...prev,
          embedding_endpoint: String(source.baseURL || '').trim(),
          embedding_key: String(source.apiKey || '').trim(),
          embedding_model: pickBestModelForSource(source, prev.embedding_model, 'embedding'),
        };
      }
      if (feature === 'video') {
        return prev;
      }

      const nextRouting = inferImageRoutingFromSource(source);
      const nextTemplate = inferImageTemplateByProvider(nextRouting.provider, nextRouting.template);
      const nextModel = nextTemplate === 'dashscope-wan-native'
        ? DASHSCOPE_LOCKED_IMAGE_MODEL
        : pickBestModelForSource(source, prev.image_model, 'image');

      return {
        ...prev,
        image_provider: nextRouting.provider,
        image_provider_template: nextTemplate,
        image_endpoint: String(source.baseURL || '').trim(),
        image_api_key: String(source.apiKey || '').trim(),
        image_model: nextModel,
      };
    });
  }, [getAiSourceById, inferImageRoutingFromSource, pickBestModelForSource]);

  const selectedTranscriptionSource = useMemo(() => {
    return getAiSourceById(transcriptionSourceId);
  }, [getAiSourceById, transcriptionSourceId]);

  const selectedEmbeddingSource = useMemo(() => {
    return getAiSourceById(embeddingSourceId);
  }, [embeddingSourceId, getAiSourceById]);

  const selectedImageSource = useMemo(() => {
    return getAiSourceById(imageSourceId);
  }, [getAiSourceById, imageSourceId]);

  const transcriptionSourceModels = useMemo(() => {
    return selectedTranscriptionSource ? filterAiModelsByCapability(getSourceModelList(selectedTranscriptionSource), 'transcription') : [];
  }, [getSourceModelList, selectedTranscriptionSource]);

  const embeddingSourceModels = useMemo(() => {
    return selectedEmbeddingSource ? filterAiModelsByCapability(getSourceModelList(selectedEmbeddingSource), 'embedding') : [];
  }, [getSourceModelList, selectedEmbeddingSource]);

  const imageSourceModels = useMemo(() => {
    return selectedImageSource ? filterAiModelsByCapability(getSourceModelList(selectedImageSource), 'image') : [];
  }, [getSourceModelList, selectedImageSource]);

  const allConfiguredModels = useMemo(() => {
    const collected: string[] = [];
    for (const source of aiSources) {
      const models = getSourceModelList(source);
      collected.push(...models.map((item) => item.id));
    }
    return normalizeSourceModels(collected);
  }, [aiSources, getSourceModelList]);

  const scopedModelOverridesCount = useMemo(() => {
    return [
      formData.model_name_wander,
      formData.model_name_chatroom,
      formData.model_name_knowledge,
      formData.model_name_redclaw,
    ].filter((value) => String(value || '').trim()).length;
  }, [
    formData.model_name_wander,
    formData.model_name_chatroom,
    formData.model_name_knowledge,
    formData.model_name_redclaw,
  ]);

  const addModelModalRemoteModels = useMemo(() => {
    if (!addModelModalSource) return [];
    return getSourceAvailableModels(addModelModalSource.id);
  }, [addModelModalSource, getSourceAvailableModels]);

  const addModelModalDraft = addModelModalSource
    ? String(sourceModelDrafts[addModelModalSource.id] || '')
    : '';

  const addModelModalDraftTrimmed = addModelModalDraft.trim();
  const addModelModalCapability = addModelModalSource
    ? (sourceModelCapabilityDrafts[addModelModalSource.id] || 'chat')
    : 'chat';

  const groupedAiPresets = useMemo<AiPresetGroup[]>(() => {
    const codingPlan = AI_SOURCE_PRESETS.filter((preset) => preset.group === 'coding-plan');
    const general = AI_SOURCE_PRESETS.filter((preset) => preset.group !== 'coding-plan');
    return [
      { id: 'general', label: '通用 AI 源', items: general },
      { id: 'coding-plan', label: 'Coding Plan', items: codingPlan },
    ].filter((group) => group.items.length > 0);
  }, []);

  // Tools State
  const [ytdlpStatus, setYtdlpStatus] = useState<{ installed: boolean; version?: string; path?: string } | null>(null);
  const [isInstallingTool, setIsInstallingTool] = useState(false);
  const [installProgress, setInstallProgress] = useState(0);
  const [browserPluginStatus, setBrowserPluginStatus] = useState<{
    success: boolean;
    bundled: boolean;
    exportPath: string;
    pluginPath?: string;
    exported: boolean;
    bundledPath?: string;
    error?: string;
  } | null>(null);
  const [isPreparingBrowserPlugin, setIsPreparingBrowserPlugin] = useState(false);
  const [cliRuntimeTools, setCliRuntimeTools] = useState<CliRuntimeToolRecord[]>([]);
  const [cliRuntimeEnvironments, setCliRuntimeEnvironments] = useState<CliRuntimeEnvironmentRecord[]>([]);
  const [cliRuntimeInstallDraft, setCliRuntimeInstallDraft] = useState<{
    environmentId: string;
    installMethod: CliRuntimeInstallMethodOption;
    spec: string;
    toolName: string;
  }>({
    environmentId: '',
    installMethod: 'pnpm',
    spec: '',
    toolName: '',
  });
  const [cliRuntimeInstallQueue, setCliRuntimeInstallQueue] = useState<CliRuntimeInstallQueueItem[]>([]);
  const [cliRuntimeInstalling, setCliRuntimeInstalling] = useState(false);
  const [cliRuntimeStatusMessage, setCliRuntimeStatusMessage] = useState('');
  const [isCliRuntimeRefreshing, setIsCliRuntimeRefreshing] = useState(false);
  const [cliRuntimeInspectingToolId, setCliRuntimeInspectingToolId] = useState('');
  const [cliRuntimeDiagnosticCommand, setCliRuntimeDiagnosticCommand] = useState('');
  const [cliRuntimeDiscoverQuery, setCliRuntimeDiscoverQuery] = useState('');
  const [cliRuntimeDiscoverResults, setCliRuntimeDiscoverResults] = useState<CliRuntimeToolRecord[]>([]);
  const [cliRuntimeDiscovering, setCliRuntimeDiscovering] = useState(false);
  const [cliRuntimeCreatingEnvironment, setCliRuntimeCreatingEnvironment] = useState<CliRuntimeEnvironmentScope | ''>('');
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpStatusMessage, setMcpStatusMessage] = useState('');
  const [isSyncingMcp, setIsSyncingMcp] = useState(false);
  const [mcpTestingId, setMcpTestingId] = useState('');
  const [mcpOauthState, setMcpOauthState] = useState<Record<string, { connected: boolean; tokenPath?: string }>>({});
  const [mcpLiveSessions, setMcpLiveSessions] = useState<McpSessionState[]>([]);
  const [mcpRuntimeItems, setMcpRuntimeItems] = useState<McpServerRuntimeItem[]>([]);
  const [mcpInspectingId, setMcpInspectingId] = useState('');

  // Update State
  const [appVersion, setAppVersion] = useState<string | null>(null);

  const [aiModelSubTab, setAiModelSubTab] = useState<'custom' | 'login'>('custom');
  const [officialAiPanelEnabled, setOfficialAiPanelEnabled] = useState(false);
  const [OfficialAiPanelComponent, setOfficialAiPanelComponent] = useState<ComponentType<OfficialAiPanelProps> | null>(null);
  const { snapshot: officialAuthState, bootstrapped: officialAuthBootstrapped } = useOfficialAuthState();

  const isDeprecatedEmptyOpenAiSource = useCallback((source?: AiSourceConfig | null): boolean => {
    if (!source) return false;
    const presetId = String(source.presetId || '').trim().toLowerCase();
    const name = String(source.name || '').trim();
    const baseURL = String(source.baseURL || '').trim().replace(/\/+$/, '');
    const model = String(source.model || '').trim();
    const models = Array.isArray(source.models) ? source.models.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const apiKey = String(source.apiKey || '').trim();
    return (
      presetId === 'openai'
      && name === 'OpenAI'
      && baseURL === 'https://api.openai.com/v1'
      && !apiKey
      && !model
      && models.length === 0
    );
  }, []);

  useEffect(() => {
    if (!hasOfficialAiPanel) {
      setOfficialAiPanelEnabled(false);
      setOfficialAiPanelComponent(null);
      setAiModelSubTab('custom');
      return;
    }
    setOfficialAiPanelEnabled(true);
  }, []);

  useEffect(() => {
    if (!hasOfficialAiPanel || !officialAiPanelEnabled) return;
    if (activeTab !== 'ai' || aiModelSubTab !== 'login' || OfficialAiPanelComponent) return;
    let canceled = false;
    void loadOfficialAiPanelModule().then((module) => {
      if (canceled) return;
      const nextComponent = module?.default || null;
      setOfficialAiPanelComponent(() => nextComponent);
      if (!nextComponent) {
        setAiModelSubTab('custom');
      }
    });
    return () => {
      canceled = true;
    };
  }, [OfficialAiPanelComponent, activeTab, aiModelSubTab, officialAiPanelEnabled]);

  const isDashscopeImageTemplate = useMemo(() => {
    const template = inferImageTemplateByProvider(formData.image_provider, formData.image_provider_template);
    return template === 'dashscope-wan-native';
  }, [formData.image_provider, formData.image_provider_template]);

  const isLocalAiSource = useCallback((source?: { presetId?: string; baseURL?: string; protocol?: AiProtocol } | null): boolean => {
    if (!source) return false;
    if (source.protocol && source.protocol !== 'openai') return false;
    const preset = String(source.presetId || '').toLowerCase();
    const base = String(source.baseURL || '').toLowerCase();
    return (
      preset.endsWith('-local') ||
      preset.includes('local') ||
      base.includes('127.0.0.1') ||
      base.includes('localhost') ||
      base.includes('0.0.0.0') ||
      base.includes('::1')
    );
  }, []);

  const isOfficialManagedSource = useCallback((source?: {
    id?: string;
    name?: string;
    presetId?: string;
  } | null): boolean => {
    if (!source) return false;
    const sourceId = String(source.id || '').trim().toLowerCase();
    const sourceName = String(source.name || '').trim().toLowerCase();
    const presetId = String(source.presetId || '').trim().toLowerCase();
    return sourceId === 'redbox_official_auto' || sourceName === 'redbox official' || presetId === 'redbox-official';
  }, []);

  const hasOfficialManagedSource = useMemo(
    () => aiSources.some((source) => isOfficialManagedSource(source)),
    [aiSources, isOfficialManagedSource]
  );

  const displayedAiSources = useMemo<AiSourceConfig[]>(() => {
    if (!officialAiPanelEnabled || hasOfficialManagedSource) {
      return aiSources;
    }
    return [
      {
        id: 'redbox_official_auto',
        name: 'RedBox Official',
        presetId: 'redbox-official',
        baseURL: REDBOX_OFFICIAL_VIDEO_BASE_URL,
        apiKey: '',
        models: [],
        modelsMeta: [],
        model: '',
        protocol: 'openai',
      },
      ...aiSources,
    ];
  }, [aiSources, hasOfficialManagedSource, officialAiPanelEnabled]);

  const officialAuthStatus = String((officialAuthState as { status?: string } | null)?.status || '').trim();
  const officialAuthKnown = officialAuthBootstrapped;
  const officialAuthPending = !officialAuthBootstrapped
    || officialAuthStatus === 'restoring'
    || officialAuthStatus === 'refreshing';
  const officialAuthLoggedIn = officialAuthKnown
    && officialAuthStatus !== 'anonymous'
    && officialAuthStatus !== 'reauthRequired'
    && officialAuthStatus !== 'restoring'
    && Boolean((officialAuthState as { loggedIn?: boolean } | null)?.loggedIn);
  const officialAuthNeedsLogin = officialAuthKnown && !officialAuthPending && !officialAuthLoggedIn;

  const defaultSourceModels = useMemo(() => {
    if (!defaultAiSource) return [];
    if (isOfficialManagedSource(defaultAiSource) && !officialAuthLoggedIn) {
      return [];
    }
    return filterAiModelsByCapability(getSourceModelList(defaultAiSource), 'chat');
  }, [defaultAiSource, getSourceModelList, isOfficialManagedSource, officialAuthLoggedIn]);

  const defaultOfficialSourceUnavailable = Boolean(
    defaultAiSource && isOfficialManagedSource(defaultAiSource) && !officialAuthLoggedIn
  );

  const getLocalGuideForSource = useCallback((source?: AiSourceConfig | null): LocalAiGuide | null => {
    if (!source) return null;
    switch (source.presetId) {
      case 'ollama-local':
        return {
          title: 'Ollama 本地服务',
          command: 'ollama serve',
          tip: '建议先执行 `ollama pull <模型名>`，Endpoint 使用 http://127.0.0.1:11434/v1',
        };
      case 'lmstudio-local':
        return {
          title: 'LM Studio 本地服务',
          command: '在 LM Studio 中启动 Developer > Local Server',
          tip: '默认 Endpoint 为 http://127.0.0.1:1234/v1',
        };
      case 'vllm-local':
        return {
          title: 'vLLM 本地服务',
          command: 'vllm serve <model> --port 8000',
          tip: 'Endpoint 使用 http://127.0.0.1:8000/v1；如你配置了 --api-key，请在此填写对应 Key',
        };
      case 'localai-local':
        return {
          title: 'LocalAI 本地服务',
          command: 'docker run -p 8080:8080 localai/localai:latest',
          tip: 'Endpoint 使用 http://127.0.0.1:8080/v1；若设置了 LOCALAI_API_KEY，请同步填写 Key',
        };
      case 'llama-cpp-local':
        return {
          title: 'llama.cpp Server',
          command: 'llama-server -m model.gguf --port 8080',
          tip: 'Endpoint 使用 http://127.0.0.1:8080/v1；如启动时启用了 --api-key，请同步填写 Key',
        };
      default:
        return null;
    }
  }, []);

  const setAssistantDaemonDraft = useCallback((updater: SetStateAction<AssistantDaemonDraft>) => {
    setAssistantDaemonDraftDirty(true);
    setAssistantDaemonDraftState(updater);
  }, []);

  const replaceAssistantDaemonDraft = useCallback((nextDraft: AssistantDaemonDraft) => {
    setAssistantDaemonDraftDirty(false);
    setAssistantDaemonDraftState(nextDraft);
  }, []);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    if (activeTab !== 'remote') {
      return;
    }

    const flushAssistantDaemonLogs = () => {
      assistantDaemonLogFlushTimerRef.current = null;
      const nextLines = assistantDaemonLogBufferRef.current;
      assistantDaemonLogBufferRef.current = [];
      if (!nextLines.length) return;
      setAssistantDaemonLogs((prev) => [...nextLines.reverse(), ...prev].slice(0, 20));
    };

    const handleDaemonStatus = (_: unknown, status: AssistantDaemonStatus) => {
      setAssistantDaemonStatus(status);
      setAssistantDaemonDraftState((prev) => {
        if (assistantDaemonBusy || assistantDaemonDraftDirty) return prev;
        return assistantDaemonStatusToDraft(status);
      });
    };
    const handleDaemonLog = (_: unknown, payload: { at?: string; level?: string; message?: string; details?: Record<string, unknown> }) => {
      const line = [
        payload?.at || new Date().toISOString(),
        payload?.level || 'info',
        payload?.message || '',
        payload?.details ? JSON.stringify(payload.details) : '',
      ].filter(Boolean).join(' | ');
      assistantDaemonLogBufferRef.current.push(line);
      if (assistantDaemonLogFlushTimerRef.current == null) {
        assistantDaemonLogFlushTimerRef.current = window.setTimeout(flushAssistantDaemonLogs, 300);
      }
    };
    window.ipcRenderer.on('assistant:daemon-status', handleDaemonStatus);
    window.ipcRenderer.on('assistant:daemon-log', handleDaemonLog);
    return () => {
      window.ipcRenderer.off('assistant:daemon-status', handleDaemonStatus);
      window.ipcRenderer.off('assistant:daemon-log', handleDaemonLog);
      if (assistantDaemonLogFlushTimerRef.current != null) {
        window.clearTimeout(assistantDaemonLogFlushTimerRef.current);
        assistantDaemonLogFlushTimerRef.current = null;
      }
      assistantDaemonLogBufferRef.current = [];
    };
  }, [activeTab, assistantDaemonBusy, assistantDaemonDraftDirty, isActive]);

  useEffect(() => {
    if (!isActive) return;
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    const onBackgroundTaskUpdated = (_event: unknown, task: BackgroundTaskItem) => {
      if (!task?.id) return;
      setBackgroundTasks((prev) => {
        const next = [...prev];
        const index = next.findIndex((item) => item.id === task.id);
        if (index >= 0) {
          next[index] = task;
        } else {
          next.unshift(task);
        }
        return next.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 200);
      });
      setSelectedBackgroundTaskId((prev) => prev || task.id);
      setSelectedBackgroundTaskDetail((prev) => (prev?.id === task.id ? { ...prev, ...task } : prev));
    };
    window.ipcRenderer.on('background:task-updated', onBackgroundTaskUpdated);
    return () => {
      window.ipcRenderer.off('background:task-updated', onBackgroundTaskUpdated);
    };
  }, [activeTab, formData.developer_mode_enabled, isActive]);

  useEffect(() => {
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    if (!selectedRuntimeTaskId || !runtimeTasks.some((task) => task.id === selectedRuntimeTaskId)) return;
    void loadRuntimeTaskTraces(selectedRuntimeTaskId);
  }, [activeTab, formData.developer_mode_enabled, runtimeTasks, selectedRuntimeTaskId]);

  useEffect(() => {
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    if (!selectedRuntimeSessionId || !hasSelectedRuntimeSession) return;
    void loadRuntimeSessionDetails(selectedRuntimeSessionId);
  }, [activeTab, formData.developer_mode_enabled, hasSelectedRuntimeSession, selectedRuntimeSessionId]);

  useEffect(() => {
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    if (!selectedBackgroundTaskId) {
      setSelectedBackgroundTaskDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const detail = await window.ipcRenderer.backgroundTasks.get(selectedBackgroundTaskId);
      if (cancelled) return;
      setSelectedBackgroundTaskDetail(detail && typeof detail === 'object' ? detail as BackgroundTaskItem : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, formData.developer_mode_enabled, selectedBackgroundTaskId]);

  useEffect(() => {
    setTestStatus('idle');
    setTestMsg('');
    setDetectedAiProtocol((activeAiSource?.protocol || 'openai') as AiProtocol);
  }, [activeAiSourceId, activeAiSource?.protocol]);

  useEffect(() => {
    if (!mcpStatusMessage) return;
    const timer = window.setTimeout(() => setMcpStatusMessage(''), 2800);
    return () => window.clearTimeout(timer);
  }, [mcpStatusMessage]);

  useEffect(() => {
    if (!cliRuntimeStatusMessage) return;
    const timer = window.setTimeout(() => setCliRuntimeStatusMessage(''), 3200);
    return () => window.clearTimeout(timer);
  }, [cliRuntimeStatusMessage]);

  useEffect(() => {
    if (activeTab !== 'tools') return;
    void loadMcpRuntimeData();
    for (const server of mcpServers) {
      void handleRefreshMcpOAuth(server);
    }
  }, [activeTab, mcpServers]);

  const loadMcpRuntimeData = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.mcp.list();
      if (!result?.success) return;
      setMcpLiveSessions(Array.isArray(result.sessions) ? (result.sessions as McpSessionState[]) : []);
      setMcpRuntimeItems(Array.isArray(result.items) ? (result.items as McpServerRuntimeItem[]) : []);
    } catch (error) {
      console.error('Failed to load MCP runtime state:', error);
    }
  }, []);

  useEffect(() => {
    if (!activeAiSource) return;
    setDetectedAiProtocol((activeAiSource?.protocol || 'openai') as AiProtocol);
  }, [activeAiSource?.id, activeAiSource?.baseURL, activeAiSource?.presetId, activeTab]);

  useEffect(() => {
    return undefined;
  }, []);

  const markAiSourceDraftDirty = useCallback(() => {
    aiSourceDraftDirtyRef.current = true;
  }, []);

  const clearAiSourceDraftDirty = useCallback(() => {
    aiSourceDraftDirtyRef.current = false;
  }, []);

  const buildAiSourcePersistenceSnapshot = useCallback((
    sources: AiSourceConfig[] = aiSources,
    resolvedDefaultSourceId: string = defaultAiSourceId,
  ) => {
    const sanitizedSources: AiSourceConfig[] = sources
      .map((source) => ({
        ...source,
        name: source.name.trim(),
        presetId: source.presetId.trim() || 'custom',
        baseURL: source.baseURL.trim(),
        apiKey: source.apiKey.trim(),
        models: normalizeSourceModels([...(source.models || []), source.model]),
        modelsMeta: normalizeAiModelDescriptors([
          ...(source.modelsMeta || []),
          ...(source.models || []).map((id) => ({ id })),
          source.model ? { id: source.model } : null,
        ]),
        model: String(source.model || '').trim(),
        protocol: source.protocol || findAiPresetById(source.presetId)?.protocol || 'openai',
      }))
      .map((source) => ({
        ...source,
        model: source.model || source.models?.[0] || '',
        models: normalizeSourceModels([...(source.models || []), source.model]),
        modelsMeta: normalizeAiModelDescriptors([
          ...(source.modelsMeta || []),
          ...(source.models || []).map((id) => ({ id })),
          source.model ? { id: source.model } : null,
        ]),
      }))
      .filter((source) => !isDeprecatedEmptyOpenAiSource(source));

    const defaultSource = sanitizedSources.find((source) => source.id === resolvedDefaultSourceId) || sanitizedSources[0];
    return {
      sanitizedSources,
      resolvedDefaultSourceId,
      defaultSource,
      resolvedApiEndpoint: String(defaultSource?.baseURL || '').trim(),
      resolvedApiKey: String(defaultSource?.apiKey || '').trim(),
      resolvedModelName: String(defaultSource?.model || '').trim(),
    };
  }, [aiSources, defaultAiSourceId, isDeprecatedEmptyOpenAiSource]);

  const persistAiSourcesSnapshot = useCallback(async (
    sources: AiSourceConfig[] = aiSources,
    resolvedDefaultSourceId: string = defaultAiSourceId,
  ) => {
    const snapshot = buildAiSourcePersistenceSnapshot(sources, resolvedDefaultSourceId);
    await window.ipcRenderer.saveSettings({
      ai_sources_json: JSON.stringify(snapshot.sanitizedSources),
      default_ai_source_id: snapshot.resolvedDefaultSourceId || snapshot.defaultSource?.id || '',
      api_endpoint: snapshot.resolvedApiEndpoint,
      api_key: snapshot.resolvedApiKey,
      model_name: snapshot.resolvedModelName,
    });
    clearAiSourceDraftDirty();
  }, [aiSources, buildAiSourcePersistenceSnapshot, clearAiSourceDraftDirty, defaultAiSourceId]);

  const updateAiSource = useCallback((sourceId: string, updater: (source: AiSourceConfig) => AiSourceConfig) => {
    markAiSourceDraftDirty();
    setAiSources((prev) => prev.map((source) => (source.id === sourceId ? updater(source) : source)));
  }, [markAiSourceDraftDirty]);

  useEffect(() => {
    if (!baseSettingsLoadedRef.current) return;
    if (!aiSourceDraftDirtyRef.current) return;
    if (aiSourceAutosaveTimerRef.current != null) {
      window.clearTimeout(aiSourceAutosaveTimerRef.current);
    }
    aiSourceAutosaveTimerRef.current = window.setTimeout(() => {
      aiSourceAutosaveTimerRef.current = null;
      void persistAiSourcesSnapshot().catch((error) => {
        console.error('Failed to persist AI source snapshot:', error);
        setStatus('error');
        setTestStatus('error');
        setTestMsg(error instanceof Error ? error.message : 'AI 源配置自动保存失败');
      });
    }, 350);

    return () => {
      if (aiSourceAutosaveTimerRef.current != null) {
        window.clearTimeout(aiSourceAutosaveTimerRef.current);
        aiSourceAutosaveTimerRef.current = null;
      }
    };
  }, [aiSources, defaultAiSourceId, persistAiSourcesSnapshot]);

  const openCreateAiSourceModal = () => {
    setCreateAiSourceDraft(createAiSourceDraftFromPreset(DEFAULT_AI_PRESET_ID));
    setIsCreateAiSourceModalOpen(true);
  };

  const closeCreateAiSourceModal = () => {
    setIsCreateAiSourceModalOpen(false);
  };

  const handleCreateAiSource = () => {
    const preset = findAiPresetById(createAiSourceDraft.presetId) || findAiPresetById(DEFAULT_AI_PRESET_ID);
    const nextSource: AiSourceConfig = {
      id: generateAiSourceId(),
      name: String(createAiSourceDraft.name || '').trim() || preset?.label || '未命名模型源',
      presetId: createAiSourceDraft.presetId || preset?.id || 'custom',
      baseURL: String(createAiSourceDraft.baseURL || '').trim(),
      apiKey: String(createAiSourceDraft.apiKey || '').trim(),
      models: [],
      modelsMeta: [],
      model: '',
      protocol: createAiSourceDraft.protocol || preset?.protocol || 'openai',
    };

    markAiSourceDraftDirty();
    setAiSources((prev) => [...prev, nextSource]);
    setActiveAiSourceId(nextSource.id);
    setAiSourceExpandState((prev) => ({ ...prev, [nextSource.id]: true }));
    setDefaultAiSourceId((prev) => {
      if (!prev || createAiSourceDraft.setAsDefault) return nextSource.id;
      return prev;
    });
    setIsCreateAiSourceModalOpen(false);
  };

  const handleDeleteAiSource = (sourceId: string) => {
    markAiSourceDraftDirty();
    setAiSources((prev) => {
      const next = prev.filter((source) => source.id !== sourceId);
      if (!next.length) {
        const fallback = createAiSourceFromPreset(DEFAULT_AI_PRESET_ID);
        setActiveAiSourceId(fallback.id);
        setDefaultAiSourceId(fallback.id);
        return [fallback];
      }
      setDefaultAiSourceId((prevDefaultId) => (prevDefaultId === sourceId ? next[0].id : prevDefaultId));
      setActiveAiSourceId((prevActiveId) => (prevActiveId === sourceId ? next[0].id : prevActiveId));
      return next;
    });
    setAiSourceExpandState((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    setAiSourceModelExpandState((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    setFetchingModelsBySourceId((prev) => {
      if (!prev[sourceId]) return prev;
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    fetchModelsRequestRef.current = Object.fromEntries(
      Object.entries(fetchModelsRequestRef.current).filter(([id]) => id !== sourceId),
    );
    setSourceModelDrafts((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    setAddModelModalSourceId((prev) => (prev === sourceId ? '' : prev));
    setModelsBySource((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
  };

  const handleToggleAiSourceExpand = (sourceId: string) => {
    setAiSourceExpandState((prev) => {
      const currentExpanded = prev[sourceId] ?? false;
      if (currentExpanded) {
        return { ...prev, [sourceId]: false };
      }
      return aiSources.reduce<Record<string, boolean>>((acc, source) => {
        acc[source.id] = source.id === sourceId;
        return acc;
      }, {});
    });
    setActiveAiSourceId(sourceId);
  };

  const handleToggleAiSourceModelExpand = (sourceId: string) => {
    setAiSourceModelExpandState((prev) => ({
      ...prev,
      [sourceId]: !(prev[sourceId] ?? false),
    }));
  };

  const handleSetSourceDefaultModel = (sourceId: string, modelId: string) => {
    const normalizedModel = String(modelId || '').trim();
    if (!normalizedModel) return;
    updateAiSource(sourceId, (source) => ({
      ...source,
      model: normalizedModel,
      models: normalizeSourceModels([...(source.models || []), normalizedModel]),
      modelsMeta: normalizeAiModelDescriptors([
        ...(source.modelsMeta || []),
        ...((source.models || []).map((id) => ({ id }))),
        { id: normalizedModel, capabilities: (getSourceModelList(source).find((item) => item.id === normalizedModel)?.capabilities || ['chat']) },
      ]),
    }));
  };

  const handleRemoveSourceModel = (sourceId: string, modelId: string) => {
    const normalizedModel = String(modelId || '').trim();
    if (!normalizedModel) return;
    updateAiSource(sourceId, (source) => {
      const nextModels = normalizeSourceModels((source.models || []).filter((item) => item !== normalizedModel));
      const nextModelsMeta = normalizeAiModelDescriptors((source.modelsMeta || []).filter((item) => String(item?.id || '').trim() !== normalizedModel));
      const fallbackModel = source.model === normalizedModel ? (nextModels[0] || '') : source.model;
      return {
        ...source,
        models: nextModels,
        modelsMeta: nextModelsMeta,
        model: fallbackModel,
      };
    });
  };

  const handleAddSourceModel = (sourceId: string) => {
    const draft = String(sourceModelDrafts[sourceId] || '').trim();
    if (!draft) return;
    const selectedCapability = sourceModelCapabilityDrafts[sourceId] || 'chat';
    updateAiSource(sourceId, (source) => {
      const nextModels = normalizeSourceModels([...(source.models || []), draft]);
      return {
        ...source,
        models: nextModels,
        modelsMeta: normalizeAiModelDescriptors([
          ...(source.modelsMeta || []),
          ...nextModels.map((id) => ({ id })),
          { id: draft, capabilities: [selectedCapability] },
        ]),
        model: source.model || draft,
      };
    });
    setSourceModelDrafts((prev) => ({ ...prev, [sourceId]: '' }));
    setSourceModelCapabilityDrafts((prev) => ({ ...prev, [sourceId]: 'chat' }));
    setAddModelModalSourceId('');
  };

  const closeAddModelModal = useCallback(() => {
    setAddModelModalSourceId('');
  }, []);

  const openAddModelModal = (source: AiSourceConfig) => {
    setAddModelModalSourceId(source.id);
    setActiveAiSourceId(source.id);
    setSourceModelCapabilityDrafts((prev) => ({
      ...prev,
      [source.id]: prev[source.id] || 'chat',
    }));
  };

  const fetchModelsForSource = useCallback(async (
    source: AiSourceConfig,
    options?: { manual?: boolean }
  ) => {
    const sourceId = String(source.id || '').trim();
    const baseURL = source.baseURL.trim();
    const apiKey = source.apiKey.trim();
    const allowEmptyKey = isLocalAiSource(source);
    if (!baseURL || (!apiKey && !allowEmptyKey)) {
      setModelsBySource((prev) => ({ ...prev, [source.id]: [] }));
      setFetchingModelsBySourceId((prev) => {
        if (!prev[source.id]) return prev;
        const next = { ...prev };
        delete next[source.id];
        return next;
      });
      if (options?.manual) {
        setTestStatus('error');
        setTestMsg(allowEmptyKey ? '请先填写 Endpoint' : '请先填写 Endpoint 与 API Key');
      } else {
        setTestStatus('idle');
        setTestMsg('');
      }
      return;
    }

    const requestId = (fetchModelsRequestRef.current[sourceId] || 0) + 1;
    fetchModelsRequestRef.current = {
      ...fetchModelsRequestRef.current,
      [sourceId]: requestId,
    };
    setFetchingModelsBySourceId((prev) => ({ ...prev, [source.id]: true }));
    if (options?.manual) {
      setTestStatus('idle');
      setTestMsg('');
    }

    try {
      const detectResult = await window.ipcRenderer.detectAiProtocol({
        baseURL: source.baseURL,
        presetId: source.presetId,
        protocol: source.protocol,
      });

      const protocol = detectResult?.protocol || source.protocol || 'openai';
      if (requestId !== (fetchModelsRequestRef.current[sourceId] || 0)) return;

      if (source.protocol !== protocol) {
        updateAiSource(source.id, (prev) => ({ ...prev, protocol }));
      }
      if (source.id === activeAiSourceId) {
        setDetectedAiProtocol(protocol);
      }

      const models = await window.ipcRenderer.fetchModels({
        apiKey: source.apiKey,
        baseURL: source.baseURL,
        presetId: source.presetId,
        protocol,
      });
      if (requestId !== (fetchModelsRequestRef.current[sourceId] || 0)) return;

      const deduped = Array.from(new Map(
        ((models || []) as unknown[])
          .map((item) => toAiModelDescriptor(item as Record<string, unknown>))
          .filter((item): item is AiModelDescriptor => Boolean(item))
          .map((item) => [item.id, item]),
      ).values());
      setModelsBySource((prev) => ({ ...prev, [source.id]: deduped }));
      if (isOfficialManagedSource(source)) {
        updateAiSource(source.id, (prev) => {
          const fetchedIds = deduped.map((item) => item.id);
          const mergedModels = normalizeSourceModels([
            ...(prev.models || []),
            ...fetchedIds,
            prev.model,
          ]);
          const mergedMeta = normalizeAiModelDescriptors([
            ...(prev.modelsMeta || []),
            ...deduped,
            ...mergedModels.map((id) => ({ id })),
          ]);
          const nextModel = String(prev.model || '').trim() || mergedModels[0] || '';
          if (
            nextModel === String(prev.model || '').trim()
            && mergedModels.join('\n') === normalizeSourceModels(prev.models || []).join('\n')
            && JSON.stringify(mergedMeta) === JSON.stringify(normalizeAiModelDescriptors(prev.modelsMeta || []))
          ) {
            return prev;
          }
          return {
            ...prev,
            models: mergedModels,
            modelsMeta: mergedMeta,
            model: nextModel,
          };
        });
      }

      setTestStatus('success');
      setTestMsg(
        isOfficialManagedSource(source)
          ? `模型列表已更新（${deduped.length} 个）`
          : `候选模型已更新（${deduped.length} 个），请在“添加模型”中手动加入需要的模型`
      );
    } catch (e: unknown) {
      if (requestId !== (fetchModelsRequestRef.current[sourceId] || 0)) return;
      setModelsBySource((prev) => ({ ...prev, [source.id]: [] }));
      setTestStatus('error');
      const message = e instanceof Error ? e.message : '拉取模型列表失败';
      setTestMsg(message);
    } finally {
      if (requestId === (fetchModelsRequestRef.current[sourceId] || 0)) {
        setFetchingModelsBySourceId((prev) => {
          if (!prev[source.id]) return prev;
          const next = { ...prev };
          delete next[source.id];
          return next;
        });
      }
    }
  }, [activeAiSourceId, isLocalAiSource, isOfficialManagedSource, updateAiSource]);

  useEffect(() => {
    if (!activeAiSource) return;
    const baseURL = activeAiSource.baseURL.trim();
    const apiKey = activeAiSource.apiKey.trim();
    const allowEmptyKey = isLocalAiSource(activeAiSource);
    if (!baseURL || (!apiKey && !allowEmptyKey)) {
      setModelsBySource((prev) => ({ ...prev, [activeAiSource.id]: [] }));
      setTestStatus('idle');
      setTestMsg('');
    }
  }, [
    activeTab,
    activeAiSource?.id,
    activeAiSource?.baseURL,
    activeAiSource?.apiKey,
    activeAiSource?.presetId,
    activeAiSource?.protocol,
    fetchModelsForSource,
    isLocalAiSource,
  ]);

  const fetchImageModels = useCallback(async (options?: { manual?: boolean }) => {
    const provider = String(formData.image_provider || '').trim();
    const template = inferImageTemplateByProvider(provider, formData.image_provider_template);
    const defaultEndpoint = resolveDefaultImageEndpoint(provider, template);
    const endpointRaw = String(formData.image_endpoint || defaultEndpoint || formData.api_endpoint || '').trim();
    const resolvedBaseURL = normalizeImageModelFetchBaseURL(endpointRaw, template);
    const resolvedApiKey = String(formData.image_api_key || formData.api_key || '').trim();
    const protocol = resolveImageModelFetchProtocol(template);
    const presetId = resolveImageModelFetchPresetId(provider, template, resolvedBaseURL);
    const allowEmptyKey = protocol === 'openai' && isLikelyLocalEndpoint(resolvedBaseURL);
    const shouldFetchRemote = isImageTemplateRemoteModelFetchEnabled(template);
    const forceDashscopeModel = template === 'dashscope-wan-native';

    const applyModelOptions = (
      remoteIds: string[],
      statusMessage: string,
    ) => {
      const seen = new Set<string>();
      const optionsList: Array<{ id: string; source: 'remote' | 'suggested' }> = [];
      for (const id of remoteIds) {
        const normalized = String(id || '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        optionsList.push({ id: normalized, source: 'remote' });
      }
      setImageAvailableModels(optionsList);
      setImageModelStatus(statusMessage);
      setFormData((prev) => {
        const current = String(prev.image_model || '').trim();
        if (forceDashscopeModel) {
          if (current === DASHSCOPE_LOCKED_IMAGE_MODEL) return prev;
          return { ...prev, image_model: DASHSCOPE_LOCKED_IMAGE_MODEL };
        }
        if (current && optionsList.some((item) => item.id === current)) {
          return prev;
        }
        if (optionsList.length === 0) {
          return prev;
        }
        const nextModel = optionsList[0].id;
        return current === nextModel ? prev : { ...prev, image_model: nextModel };
      });
    };

    if (!resolvedBaseURL) {
      applyModelOptions([], '未配置生图 Endpoint，无法拉取模型列表');
      return;
    }

    if (!resolvedApiKey && !allowEmptyKey) {
      applyModelOptions([], '未配置生图 API Key，无法拉取模型列表');
      return;
    }

    if (!shouldFetchRemote) {
      applyModelOptions([], '当前模板不提供统一模型列表接口');
      return;
    }

    const requestId = ++fetchImageModelsRequestRef.current;
    setIsFetchingImageModels(true);
    if (options?.manual) {
      setImageModelStatus('正在拉取生图模型列表...');
    }

    try {
      const models = await window.ipcRenderer.fetchModels({
        apiKey: resolvedApiKey,
        baseURL: resolvedBaseURL,
        presetId,
        protocol,
        purpose: 'image',
      });
      if (requestId !== fetchImageModelsRequestRef.current) return;
      const remoteIds = Array.from(new Set(
        ((models || []) as Array<{ id?: string }>)
          .map((item) => String(item.id || '').trim())
          .filter(Boolean)
      ));
      const summary = remoteIds.length > 0 ? `已拉取远端模型 ${remoteIds.length} 个` : '远端未返回可用生图模型';
      applyModelOptions(remoteIds, summary);
    } catch (error) {
      if (requestId !== fetchImageModelsRequestRef.current) return;
      const message = error instanceof Error ? error.message : '拉取失败';
      applyModelOptions([], `拉取失败：${message}`);
    } finally {
      if (requestId === fetchImageModelsRequestRef.current) {
        setIsFetchingImageModels(false);
      }
    }
  }, [
    formData.api_endpoint,
    formData.api_key,
    formData.image_api_key,
    formData.image_endpoint,
    formData.image_provider,
    formData.image_provider_template,
  ]);

  useEffect(() => {
    if (!isDashscopeImageTemplate) return;
    setFormData((prev) => {
      const current = String(prev.image_model || '').trim();
      if (current === DASHSCOPE_LOCKED_IMAGE_MODEL) return prev;
      return { ...prev, image_model: DASHSCOPE_LOCKED_IMAGE_MODEL };
    });
  }, [activeTab, isDashscopeImageTemplate]);

  useEffect(() => {
    return;
  }, [
    activeTab,
    formData.api_endpoint,
    formData.api_key,
    formData.image_api_key,
    formData.image_endpoint,
    formData.image_provider,
    formData.image_provider_template,
    fetchImageModels,
  ]);

  const persistMcpServers = useCallback(async (nextServers: McpServerConfig[], tip?: string) => {
    setIsSyncingMcp(true);
    try {
      const result = await window.ipcRenderer.mcp.save(nextServers);
      if (!result?.success) {
        setMcpStatusMessage(result?.error || 'MCP 配置保存失败');
        return false;
      }
      setMcpServers((result.servers || nextServers) as McpServerConfig[]);
      await loadMcpRuntimeData();
      if (tip) setMcpStatusMessage(tip);
      return true;
    } catch (error) {
      console.error('Failed to persist MCP servers:', error);
      setMcpStatusMessage('MCP 配置保存失败');
      return false;
    } finally {
      setIsSyncingMcp(false);
    }
  }, [loadMcpRuntimeData]);

  const handleAddMcpServer = async () => {
    const next = [...mcpServers, createDefaultMcpServer()];
    await persistMcpServers(next, '已新增 MCP Server，请完善配置后保存');
  };

  const handleDeleteMcpServer = async (serverId: string) => {
    const next = mcpServers.filter((item) => item.id !== serverId);
    await persistMcpServers(next, '已删除 MCP Server');
  };

  const handleUpdateMcpServer = (serverId: string, updater: (server: McpServerConfig) => McpServerConfig) => {
    setMcpServers((prev) => prev.map((server) => (server.id === serverId ? updater(server) : server)));
  };

  const handleSaveMcpServers = async () => {
    await persistMcpServers(mcpServers, 'MCP 配置已保存');
  };

  const handleDiscoverAndImportMcp = useCallback(async () => {
    setIsSyncingMcp(true);
    try {
      const result = await window.ipcRenderer.mcp.importLocal();
      if (!result?.success) {
        setMcpStatusMessage(result?.error || '导入本机 MCP 配置失败');
        return;
      }
      setMcpServers((result.servers || []) as McpServerConfig[]);
      await loadMcpRuntimeData();
      setMcpStatusMessage(`已导入 ${result.imported || 0} 个 MCP Server（共 ${result.total || 0} 个）`);
    } catch (error) {
      console.error('Failed to import local MCP configs:', error);
      setMcpStatusMessage('导入本机 MCP 配置失败');
    } finally {
      setIsSyncingMcp(false);
    }
  }, [loadMcpRuntimeData]);

  const handleTestMcpServer = useCallback(async (server: McpServerConfig) => {
    setMcpTestingId(server.id);
    try {
      const result = await window.ipcRenderer.mcp.test(server);
      setMcpStatusMessage(`${server.name}：${result.message}`);
      await loadMcpRuntimeData();
    } catch (error) {
      console.error('Failed to test MCP server:', error);
      setMcpStatusMessage(`${server.name}：测试失败`);
    } finally {
      setMcpTestingId('');
    }
  }, [loadMcpRuntimeData]);

  const handleDisconnectMcpServer = useCallback(async (server: McpServerConfig) => {
    setMcpInspectingId(server.id);
    try {
      const result = await window.ipcRenderer.mcp.disconnect(server);
      if (result?.success) {
        setMcpLiveSessions(Array.isArray(result.sessions) ? (result.sessions as McpSessionState[]) : []);
        await loadMcpRuntimeData();
        setMcpStatusMessage(`${server.name}：连接已断开`);
      }
    } catch (error) {
      console.error('Failed to disconnect MCP server:', error);
      setMcpStatusMessage(`${server.name}：断开连接失败`);
    } finally {
      setMcpInspectingId('');
    }
  }, [loadMcpRuntimeData]);

  const handleDisconnectAllMcpSessions = useCallback(async () => {
    setMcpInspectingId('__all__');
    try {
      const result = await window.ipcRenderer.mcp.disconnectAll();
      if (result?.success) {
        setMcpLiveSessions(Array.isArray(result.sessions) ? (result.sessions as McpSessionState[]) : []);
        await loadMcpRuntimeData();
        setMcpStatusMessage('已断开全部 MCP 会话');
      }
    } catch (error) {
      console.error('Failed to disconnect all MCP sessions:', error);
      setMcpStatusMessage('断开全部 MCP 会话失败');
    } finally {
      setMcpInspectingId('');
    }
  }, [loadMcpRuntimeData]);

  const handleRefreshMcpOAuth = async (server: McpServerConfig) => {
    try {
      const result = await window.ipcRenderer.mcp.oauthStatus(server.id);
      if (!result?.success) return;
      setMcpOauthState((prev) => ({
        ...prev,
        [server.id]: {
          connected: Boolean(result.connected),
          tokenPath: result.tokenPath,
        },
      }));
    } catch (error) {
      console.error('Failed to query MCP oauth status:', error);
    }
  };

  const loadAppVersion = useCallback(async () => {
    try {
      const version = await window.ipcRenderer.getAppVersion();
      const normalizedVersion = typeof version === 'string'
        ? version.trim()
        : String(version || '').trim();
      setAppVersion(normalizedVersion || '未读取到版本号');
    } catch (e) {
      console.error('Failed to load app version:', e);
      setAppVersion('读取失败');
    }
  }, []);

  const loadRecentDebugLogs = useCallback(async () => {
    const requestId = ++debugLogsLoadRequestRef.current;
    setIsDebugLogsLoading(true);
    try {
      const result = await window.ipcRenderer.logs.getRecent(120);
      if (requestId !== debugLogsLoadRequestRef.current) return;
      setRecentDebugLogs(Array.isArray(result?.lines) ? result.lines : []);
    } catch (e) {
      console.error('Failed to load debug logs', e);
    } finally {
      if (requestId === debugLogsLoadRequestRef.current) {
        setIsDebugLogsLoading(false);
      }
    }
  }, []);

  const loadLoggingStatus = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.logs.getStatus();
      setLogStatus(result || null);
    } catch (error) {
      console.error('Failed to load logging status', error);
    }
  }, []);

  const loadPendingDiagnosticReports = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.logs.listPendingReports();
      setPendingDiagnosticReports(Array.isArray(result) ? result : []);
    } catch (error) {
      console.error('Failed to load pending diagnostic reports', error);
    }
  }, []);

  const openDebugLogDirectory = async () => {
    const result = await window.ipcRenderer.logs.openDir();
    if (!result?.success && result?.error) {
      void appAlert(`打开日志目录失败：${result.error}`);
    }
  };

  const handleExportDiagnosticBundle = useCallback(async (reportId?: string) => {
    setDiagnosticsActionBusy(reportId || 'manual-export');
    try {
      const result = await window.ipcRenderer.logs.exportBundle(reportId, {
        includeAdvancedContext: Boolean(formData.debug_log_enabled || formData.diagnostics_include_advanced_context),
      });
      if (!result?.success) {
        throw new Error(result?.error || '导出诊断包失败');
      }
      await appAlert(`诊断包已导出到：\n${result.path}`);
      await Promise.all([loadLoggingStatus(), loadPendingDiagnosticReports()]);
    } catch (error) {
      void appAlert(`导出诊断包失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDiagnosticsActionBusy(null);
    }
  }, [formData.debug_log_enabled, formData.diagnostics_include_advanced_context, loadLoggingStatus, loadPendingDiagnosticReports]);

  const handleUploadPendingReport = useCallback(async (reportId: string) => {
    setDiagnosticsActionBusy(reportId);
    try {
      const result = await window.ipcRenderer.logs.uploadReport(reportId);
      if (!result?.success) {
        throw new Error(result?.error || '上传诊断报告失败');
      }
      await appAlert('诊断报告已上传。');
      await Promise.all([loadLoggingStatus(), loadPendingDiagnosticReports()]);
    } catch (error) {
      void appAlert(`上传诊断报告失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDiagnosticsActionBusy(null);
    }
  }, [loadLoggingStatus, loadPendingDiagnosticReports]);

  const handleDismissPendingReport = useCallback(async (reportId: string) => {
    setDiagnosticsActionBusy(reportId);
    try {
      const result = await window.ipcRenderer.logs.dismissReport(reportId);
      if (!result?.success) {
        throw new Error(result?.error || '删除待发送报告失败');
      }
      await Promise.all([loadLoggingStatus(), loadPendingDiagnosticReports()]);
    } catch (error) {
      void appAlert(`删除待发送报告失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDiagnosticsActionBusy(null);
    }
  }, [loadLoggingStatus, loadPendingDiagnosticReports]);

  const loadToolDiagnostics = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.toolDiagnostics.list();
      setToolDiagnostics(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error('Failed to load tool diagnostics', e);
    }
  }, []);

  const loadRuntimeRoles = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.aiRoles.list();
      setRuntimeRoles(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error('Failed to load runtime roles', e);
    }
  }, []);

  const loadRuntimeSummary = useCallback(async () => {
    const requestId = ++runtimeSummaryLoadRequestRef.current;
    try {
      const result = await window.ipcRenderer.debug.getRuntimeSummary();
      if (requestId !== runtimeSummaryLoadRequestRef.current) return;
      setRuntimeDiagnosticsSummary(result || null);
    } catch (e) {
      console.error('Failed to load runtime diagnostics summary', e);
    }
  }, []);

  const loadRuntimeTasks = useCallback(async (preserveSelection = true) => {
    const requestId = ++runtimeTasksLoadRequestRef.current;
    setIsRuntimeLoading(true);
    try {
      const result = await window.ipcRenderer.tasks.list({ limit: 40 });
      if (requestId !== runtimeTasksLoadRequestRef.current) return;
      const taskList = Array.isArray(result) ? result : [];
      setRuntimeTasks(taskList);
      setSelectedRuntimeTaskId((prev) => {
        if (preserveSelection && prev && taskList.some((task) => task.id === prev)) {
          return prev;
        }
        return taskList[0]?.id || '';
      });
    } catch (e) {
      console.error('Failed to load runtime tasks', e);
      if (!preserveSelection) {
        setSelectedRuntimeTaskId('');
      }
    } finally {
      if (requestId === runtimeTasksLoadRequestRef.current) {
        setIsRuntimeLoading(false);
      }
    }
  }, []);

  const loadRuntimeSessions = useCallback(async (preserveSelection = true) => {
    const requestId = ++runtimeSessionsLoadRequestRef.current;
    try {
      const result = await window.ipcRenderer.sessions.list();
      if (requestId !== runtimeSessionsLoadRequestRef.current) return;
      const sessionList = Array.isArray(result) ? result as RuntimeSessionListItem[] : [];
      setRuntimeSessions(sessionList);
      setSelectedRuntimeSessionId((prev) => {
        if (preserveSelection && prev && sessionList.some((session) => session.id === prev)) {
          return prev;
        }
        return sessionList[0]?.id || '';
      });
    } catch (e) {
      console.error('Failed to load runtime sessions', e);
      if (!preserveSelection) {
        setSelectedRuntimeSessionId('');
      }
    }
  }, []);

  const loadRuntimeTaskTraces = useCallback(async (taskId: string) => {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      setRuntimeTaskTraces([]);
      return;
    }
    const requestId = ++runtimeTaskTracesLoadRequestRef.current;
    setIsRuntimeTraceLoading(true);
    try {
      const result = await window.ipcRenderer.tasks.trace({ taskId: normalizedTaskId, limit: 120 });
      if (requestId !== runtimeTaskTracesLoadRequestRef.current) return;
      setRuntimeTaskTraces(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error('Failed to load runtime task traces', e);
    } finally {
      if (requestId === runtimeTaskTracesLoadRequestRef.current) {
        setIsRuntimeTraceLoading(false);
      }
    }
  }, []);

  const loadRuntimeSessionDetails = useCallback(async (sessionId: string, options?: { background?: boolean }) => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      setRuntimeSessionTranscript([]);
      setRuntimeSessionCheckpoints([]);
      setRuntimeSessionToolResults([]);
      return;
    }
    const requestId = ++runtimeSessionDetailsLoadRequestRef.current;
    if (!options?.background) {
      setIsRuntimeSessionLoading(true);
    }
    try {
      const [transcript, checkpoints, toolResults] = await Promise.all([
        window.ipcRenderer.sessions.getTranscript(normalizedSessionId, 120),
        window.ipcRenderer.runtime.getCheckpoints({ sessionId: normalizedSessionId, limit: 80 }),
        window.ipcRenderer.runtime.getToolResults({ sessionId: normalizedSessionId, limit: 120 }),
      ]);
      if (requestId !== runtimeSessionDetailsLoadRequestRef.current) return;
      setRuntimeSessionTranscript(Array.isArray(transcript) ? transcript as RuntimeSessionTranscriptItem[] : []);
      setRuntimeSessionCheckpoints(Array.isArray(checkpoints) ? checkpoints as RuntimeSessionCheckpointItem[] : []);
      setRuntimeSessionToolResults(Array.isArray(toolResults) ? toolResults as RuntimeSessionToolResultItem[] : []);
    } catch (e) {
      console.error('Failed to load runtime session details', e);
    } finally {
      if (!options?.background && requestId === runtimeSessionDetailsLoadRequestRef.current) {
        setIsRuntimeSessionLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    const scheduleRefresh = () => {
      if (runtimeObservabilityRefreshTimerRef.current != null) {
        window.clearTimeout(runtimeObservabilityRefreshTimerRef.current);
      }
      runtimeObservabilityRefreshTimerRef.current = window.setTimeout(() => {
        runtimeObservabilityRefreshTimerRef.current = null;
        void loadRuntimeSessions();
        if (selectedRuntimeSessionId) {
          void loadRuntimeSessionDetails(selectedRuntimeSessionId, { background: true });
        }
      }, 450);
    };
    const onRuntimeEvent = () => scheduleRefresh();
    const onWanderProgress = () => scheduleRefresh();
    window.ipcRenderer.on('runtime:event', onRuntimeEvent as (...args: unknown[]) => void);
    window.ipcRenderer.on('wander:progress', onWanderProgress as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.off('runtime:event', onRuntimeEvent as (...args: unknown[]) => void);
      window.ipcRenderer.off('wander:progress', onWanderProgress as (...args: unknown[]) => void);
      if (runtimeObservabilityRefreshTimerRef.current != null) {
        window.clearTimeout(runtimeObservabilityRefreshTimerRef.current);
        runtimeObservabilityRefreshTimerRef.current = null;
      }
    };
  }, [activeTab, formData.developer_mode_enabled, isActive, loadRuntimeSessionDetails, loadRuntimeSessions, selectedRuntimeSessionId]);

  useEffect(() => {
    if (!isActive) return;
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;

    const onRuntimePerfEvent = (_event: unknown, envelope?: unknown) => {
      const collector = runtimePerfCollectorRef.current;
      if (!collector) return;

      const record = toRuntimePerfRecord(envelope);
      const eventType = toRuntimePerfText(record.eventType);
      const sessionId = toRuntimePerfText(record.sessionId);
      const timestamp = toRuntimePerfNumber(record.timestamp) || Date.now();
      if (!eventType || sessionId !== collector.sessionId) return;

      const payload = toRuntimePerfRecord(record.payload);
      let changed = false;

      if (eventType === 'runtime:stream-start') {
        const phase = toRuntimePerfText(payload.phase) || 'unknown';
        if (phase === 'thinking' && collector.thinkingStartedMs == null) {
          collector.thinkingStartedMs = Math.max(0, timestamp - collector.startedAt);
          changed = true;
        }
        appendRuntimePerfTimeline(collector, {
          at: timestamp,
          eventType,
          label: `phase · ${phase}`,
          detail: toRuntimePerfText(payload.runtimeMode) || undefined,
          tone: 'neutral',
        });
        changed = true;
      } else if (eventType === 'runtime:text-delta') {
        const stream = toRuntimePerfText(payload.stream);
        const content = toRuntimePerfText(payload.content);
        if (stream === 'thought' && collector.thoughtFirstTokenMs == null) {
          collector.thoughtFirstTokenMs = Math.max(0, timestamp - collector.startedAt);
          appendRuntimePerfTimeline(collector, {
            at: timestamp,
            eventType,
            label: 'thought first token',
            detail: `${content.length} chars`,
            tone: 'neutral',
          });
          changed = true;
        }
        if (stream === 'response') {
          if (collector.firstResponseMs == null) {
            collector.firstResponseMs = Math.max(0, timestamp - collector.startedAt);
            appendRuntimePerfTimeline(collector, {
              at: timestamp,
              eventType,
              label: 'response first token',
              detail: `${content.length} chars`,
              tone: 'success',
            });
            changed = true;
          }
          const nextChars = (collector.responseChars || 0) + content.length;
          if (nextChars !== collector.responseChars) {
            collector.responseChars = nextChars;
            changed = true;
          }
        }
      } else if (eventType === 'runtime:tool-start') {
        collector.toolCalls += 1;
        if (collector.firstToolStartMs == null) {
          collector.firstToolStartMs = Math.max(0, timestamp - collector.startedAt);
        }
        appendRuntimePerfTimeline(collector, {
          at: timestamp,
          eventType,
          label: `tool start · ${toRuntimePerfText(payload.name) || 'tool'}`,
          detail: toRuntimePerfText(payload.description) || undefined,
          tone: 'warning',
        });
        changed = true;
      } else if (eventType === 'runtime:tool-end') {
        const output = toRuntimePerfRecord(payload.output);
        const success = output.success !== false;
        if (success) {
          collector.toolSuccessCount += 1;
        } else {
          collector.toolFailureCount += 1;
        }
        appendRuntimePerfTimeline(collector, {
          at: timestamp,
          eventType,
          label: `tool ${success ? 'done' : 'failed'} · ${toRuntimePerfText(payload.name) || 'tool'}`,
          detail: toRuntimePerfText(output.content) || undefined,
          tone: success ? 'success' : 'error',
        });
        changed = true;
      } else if (eventType === 'runtime:checkpoint') {
        const checkpointType = toRuntimePerfText(payload.checkpointType) || 'checkpoint';
        collector.checkpointCount += 1;
        if (collector.firstCheckpointMs == null) {
          collector.firstCheckpointMs = Math.max(0, timestamp - collector.startedAt);
        }
        if (checkpointType && !collector.checkpointTypes.includes(checkpointType)) {
          collector.checkpointTypes = [...collector.checkpointTypes, checkpointType];
        }
        appendRuntimePerfTimeline(collector, {
          at: timestamp,
          eventType,
          label: `checkpoint · ${checkpointType}`,
          detail: toRuntimePerfText(payload.summary) || undefined,
          tone: checkpointType === 'chat.error' ? 'error' : 'neutral',
        });
        changed = true;
      } else if (eventType === 'runtime:done') {
        appendRuntimePerfTimeline(collector, {
          at: timestamp,
          eventType,
          label: `done · ${toRuntimePerfText(payload.status) || 'completed'}`,
          detail: toRuntimePerfText(payload.reason) || undefined,
          tone: toRuntimePerfText(payload.status) === 'error' ? 'error' : 'success',
        });
        const content = toRuntimePerfText(payload.content);
        if (content) {
          collector.responseChars = Math.max(collector.responseChars || 0, content.length);
        }
        changed = true;
      }

      if (!changed) return;

      updateRuntimePerfRun(collector.runId, (run) => ({
        ...run,
        ...snapshotRuntimePerfCollector(collector),
      }));
    };

    window.ipcRenderer.on('runtime:event', onRuntimePerfEvent as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.off('runtime:event', onRuntimePerfEvent as (...args: unknown[]) => void);
    };
  }, [
    activeTab,
    appendRuntimePerfTimeline,
    formData.developer_mode_enabled,
    isActive,
    snapshotRuntimePerfCollector,
    updateRuntimePerfRun,
  ]);

  const loadRuntimeHooks = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.toolHooks.list();
      setRuntimeHooks(Array.isArray(result) ? result as RuntimeHookDefinition[] : []);
    } catch (e) {
      console.error('Failed to load runtime hooks', e);
    }
  }, []);

  const loadBackgroundTasks = useCallback(async (preserveSelection = true) => {
    const requestId = ++backgroundTasksLoadRequestRef.current;
    setIsBackgroundTasksLoading(true);
    try {
      const result = await window.ipcRenderer.backgroundTasks.list();
      if (requestId !== backgroundTasksLoadRequestRef.current) return;
      const taskList = Array.isArray(result) ? result as BackgroundTaskItem[] : [];
      setBackgroundTasks(taskList);
      setSelectedBackgroundTaskId((prev) => {
        if (preserveSelection && prev && taskList.some((task) => task.id === prev)) {
          return prev;
        }
        return taskList[0]?.id || '';
      });
      setSelectedBackgroundTaskDetail((prev) => (
        prev && taskList.some((task) => task.id === prev.id) ? prev : null
      ));
    } catch (e) {
      console.error('Failed to load background tasks', e);
      if (!preserveSelection) {
        setSelectedBackgroundTaskId('');
      }
    } finally {
      if (requestId === backgroundTasksLoadRequestRef.current) {
        setIsBackgroundTasksLoading(false);
      }
    }
  }, []);

  const loadBackgroundWorkerPool = useCallback(async () => {
    const requestId = ++backgroundWorkerPoolLoadRequestRef.current;
    try {
      const result = await window.ipcRenderer.backgroundWorkers.getPoolState();
      if (requestId !== backgroundWorkerPoolLoadRequestRef.current) return;
      setBackgroundWorkerPool({
        json: Array.isArray(result?.json) ? result.json : [],
        runtime: Array.isArray(result?.runtime) ? result.runtime : [],
      });
    } catch (e) {
      console.error('Failed to load background worker pool', e);
    }
  }, []);

  const loadRuntimeDeveloperData = useCallback(async () => {
    await Promise.all([
      loadRuntimeRoles(),
      loadRuntimeSummary(),
      loadToolDiagnostics(),
    ]);
    await Promise.all([
      loadRuntimeTasks(),
      loadRuntimeSessions(),
      loadRuntimeHooks(),
    ]);
    await Promise.all([
      loadBackgroundTasks(),
      loadBackgroundWorkerPool(),
    ]);
  }, [
    loadBackgroundTasks,
    loadBackgroundWorkerPool,
    loadRuntimeHooks,
    loadRuntimeRoles,
    loadRuntimeSummary,
    loadRuntimeSessions,
    loadRuntimeTasks,
    loadToolDiagnostics,
  ]);

  const handleApplyRuntimePerfPreset = useCallback((presetId: string) => {
    const preset = RUNTIME_PERF_PRESETS.find((item) => item.id === presetId) || RUNTIME_PERF_PRESETS[0];
    setRuntimePerfPresetId(preset.id);
    setRuntimePerfMessage(preset.message);
  }, []);

  const ensureRuntimePerfSession = useCallback(async (
    mode: RuntimePerfBenchmarkMode,
    index: number,
  ): Promise<{ id: string }> => {
    const contextType = runtimePerfContextTypeForMode(mode);
    const timestamp = Date.now();
    const contextId = `developer-runtime-perf-${mode}-${timestamp}-${index}`;
    const title = `Runtime Perf · ${mode} · ${formatRuntimePerfRunIndex(index)}`;
    if (mode === 'diagnostics') {
      return await window.ipcRenderer.chat.createDiagnosticsSession({
        title,
        contextId,
        contextType,
      }) as { id: string };
    }
    return await window.ipcRenderer.chat.createContextSession({
      contextId,
      contextType,
      title,
    }) as { id: string };
  }, []);

  const handleClearRuntimePerfResults = useCallback(() => {
    runtimePerfCollectorRef.current = null;
    setActiveRuntimePerfRunId('');
    setRuntimePerfResults([]);
    setRuntimePerfStatusMessage('');
  }, []);

  const handleRunRuntimePerfBenchmark = useCallback(async () => {
    const trimmedMessage = runtimePerfMessage.trim();
    if (!trimmedMessage || isRuntimePerfRunning) return;

    setIsRuntimePerfRunning(true);
    setRuntimePerfStatusMessage(`准备执行 ${runtimePerfIterations} 轮 runtime benchmark...`);

    try {
      for (let iterationIndex = 0; iterationIndex < runtimePerfIterations; iterationIndex += 1) {
        const runNumber = ++runtimePerfRunCounterRef.current;
        const session = await ensureRuntimePerfSession(runtimePerfMode, runNumber);
        const sessionId = String(session?.id || '').trim();
        if (!sessionId) {
          throw new Error('性能测试未拿到有效 sessionId');
        }

        const startedAt = Date.now();
        const runId = `runtime-perf-${startedAt}-${runNumber}`;
        const collector: RuntimePerfCollector = {
          runId,
          sessionId,
          startedAt,
          toolCalls: 0,
          toolSuccessCount: 0,
          toolFailureCount: 0,
          checkpointCount: 0,
          checkpointTypes: [],
          timeline: [],
        };
        runtimePerfCollectorRef.current = collector;
        setActiveRuntimePerfRunId(runId);
        setSelectedRuntimeSessionId(sessionId);
        appendRuntimePerfTimeline(collector, {
          at: startedAt,
          eventType: 'run:start',
          label: '测试开始',
          detail: `${runtimePerfMode} · ${formatRuntimePerfRunIndex(runNumber)}`,
          tone: 'neutral',
          offsetMs: 0,
        });
        const pendingRun: RuntimePerfRunResult = {
          id: runId,
          index: runNumber,
          runtimeMode: runtimePerfMode,
          sessionId,
          presetId: runtimePerfPresetId,
          message: trimmedMessage,
          status: 'running',
          startedAt,
          toolCalls: 0,
          toolSuccessCount: 0,
          toolFailureCount: 0,
          checkpointCount: 0,
          checkpointTypes: [],
          timeline: [...collector.timeline],
        };
        setRuntimePerfResults((prev) => [
          pendingRun,
          ...prev,
        ].slice(0, RUNTIME_PERF_HISTORY_LIMIT));

        setRuntimePerfStatusMessage(`执行中：第 ${iterationIndex + 1}/${runtimePerfIterations} 轮`);

        let finalStatus: RuntimePerfRunResult['status'] = 'completed';
        let finalError = '';
        let finalResponseChars = 0;
        let routeValue: unknown = null;
        let orchestrationValue: unknown = null;

        try {
          const result = await window.ipcRenderer.runtime.query({
            sessionId,
            message: trimmedMessage,
          }) as {
            success?: boolean;
            response?: string;
            route?: unknown;
            orchestration?: unknown;
          };
          if (result?.success === false) {
            throw new Error('runtime query returned success=false');
          }
          finalResponseChars = String(result?.response || '').length;
          routeValue = result?.route;
          orchestrationValue = result?.orchestration;
        } catch (error) {
          finalStatus = 'failed';
          finalError = error instanceof Error ? error.message : String(error);
        }

        const completedAt = Date.now();
        appendRuntimePerfTimeline(collector, {
          at: completedAt,
          eventType: 'run:finish',
          label: finalStatus === 'completed' ? '测试完成' : '测试失败',
          detail: finalError || undefined,
          tone: finalStatus === 'completed' ? 'success' : 'error',
        });

        const [summary, checkpoints, toolResults] = await Promise.all([
          window.ipcRenderer.debug.getRuntimeSummary(),
          window.ipcRenderer.runtime.getCheckpoints({ sessionId, limit: 120 }),
          window.ipcRenderer.runtime.getToolResults({ sessionId, limit: 120 }),
        ]);
        setRuntimeDiagnosticsSummary(summary || null);

        const checkpointRows = (Array.isArray(checkpoints) ? checkpoints : []).filter((item) => {
          const createdAt = toRuntimePerfNumber((item as Record<string, unknown>)?.createdAt) || 0;
          return createdAt >= (startedAt - RUNTIME_PERF_CHECKPOINT_WINDOW_MS);
        }) as RuntimeSessionCheckpointItem[];
        const toolRows = (Array.isArray(toolResults) ? toolResults : []).filter((item) => {
          const createdAt = toRuntimePerfNumber((item as Record<string, unknown>)?.createdAt) || 0;
          return createdAt >= (startedAt - RUNTIME_PERF_CHECKPOINT_WINDOW_MS);
        }) as RuntimeSessionToolResultItem[];
        const recentRuntimeMetrics = Array.isArray(summary?.phase0?.runtimeQueries?.recent)
          ? summary.phase0.runtimeQueries.recent as Array<Record<string, unknown>>
          : [];
        const matchingMetric = recentRuntimeMetrics.find((item) =>
          String(item.sessionId || '').trim() === sessionId
          && (toRuntimePerfNumber(item.createdAt) || 0) >= (startedAt - RUNTIME_PERF_CHECKPOINT_WINDOW_MS)
        );

        const toolSuccessCount = toolRows.filter((item) => Boolean(item.success)).length;
        const toolFailureCount = toolRows.length - toolSuccessCount;
        const checkpointTypes = checkpointRows
          .map((item) => String(item.checkpointType || '').trim())
          .filter(Boolean);

        collector.responseChars = collector.responseChars ?? finalResponseChars;
        collector.toolCalls = Math.max(collector.toolCalls, toolRows.length);
        collector.toolSuccessCount = Math.max(collector.toolSuccessCount, toolSuccessCount);
        collector.toolFailureCount = Math.max(collector.toolFailureCount, toolFailureCount);
        collector.checkpointCount = Math.max(collector.checkpointCount, checkpointRows.length);
        collector.checkpointTypes = checkpointTypes.length ? checkpointTypes : collector.checkpointTypes;

        updateRuntimePerfRun(runId, (run) => ({
          ...run,
          status: finalStatus,
          completedAt,
          totalElapsedMs: Math.max(0, completedAt - startedAt),
          promptChars: toRuntimePerfNumber(matchingMetric?.promptChars),
          activeSkillCount: toRuntimePerfNumber(matchingMetric?.activeSkillCount),
          responseChars: collector.responseChars ?? finalResponseChars,
          toolCalls: collector.toolCalls,
          toolSuccessCount: collector.toolSuccessCount,
          toolFailureCount: collector.toolFailureCount,
          checkpointCount: collector.checkpointCount,
          checkpointTypes: [...collector.checkpointTypes],
          route: routeValue,
          orchestration: orchestrationValue,
          error: finalError || undefined,
          ...snapshotRuntimePerfCollector(collector),
        }));

        runtimePerfCollectorRef.current = null;
        setActiveRuntimePerfRunId('');
        await loadRuntimeSessions();
        await loadRuntimeSessionDetails(sessionId);
      }
      setRuntimePerfStatusMessage(`已完成 ${runtimePerfIterations} 轮 runtime benchmark`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimePerfStatusMessage(`runtime benchmark 失败：${message}`);
      const activeCollector = runtimePerfCollectorRef.current;
      if (activeCollector) {
        const completedAt = Date.now();
        appendRuntimePerfTimeline(activeCollector, {
          at: completedAt,
          eventType: 'run:error',
          label: '执行异常',
          detail: message,
          tone: 'error',
        });
        updateRuntimePerfRun(activeCollector.runId, (run) => ({
          ...run,
          status: 'failed',
          completedAt,
          totalElapsedMs: Math.max(0, completedAt - run.startedAt),
          error: message,
          ...snapshotRuntimePerfCollector(activeCollector),
        }));
      }
    } finally {
      runtimePerfCollectorRef.current = null;
      setActiveRuntimePerfRunId('');
      setIsRuntimePerfRunning(false);
    }
  }, [
    appendRuntimePerfTimeline,
    ensureRuntimePerfSession,
    isRuntimePerfRunning,
    loadRuntimeSessionDetails,
    loadRuntimeSessions,
    runtimePerfIterations,
    runtimePerfMessage,
    runtimePerfMode,
    runtimePerfPresetId,
    snapshotRuntimePerfCollector,
    updateRuntimePerfRun,
  ]);

  const handleCreateRuntimeTask = async () => {
    setIsRuntimeCreating(true);
    try {
      const created = await window.ipcRenderer.tasks.create({
        runtimeMode: runtimeDraftMode,
        sessionId: `dev_task_${Date.now()}`,
        userInput: runtimeDraftInput.trim() || '开发者手动创建任务',
        metadata: {
          source: 'settings-developer-runtime',
        },
      });
      setRuntimeDraftInput('');
      if (created?.id) {
        setSelectedRuntimeTaskId(created.id);
        await loadRuntimeTasks(false);
        await loadRuntimeTaskTraces(created.id);
      } else {
        await loadRuntimeTasks(false);
      }
    } catch (e) {
      console.error('Failed to create runtime task', e);
    } finally {
      setIsRuntimeCreating(false);
    }
  };

  const handleResumeRuntimeTask = async (taskId: string) => {
    setRuntimeTaskActionRunning((prev) => ({ ...prev, [taskId]: 'resume' }));
    try {
      await window.ipcRenderer.tasks.resume({ taskId });
      await loadRuntimeTasks();
      await loadRuntimeTaskTraces(taskId);
    } catch (e) {
      console.error('Failed to resume runtime task', e);
    } finally {
      setRuntimeTaskActionRunning((prev) => ({ ...prev, [taskId]: undefined }));
    }
  };

  const handleCancelRuntimeTask = async (taskId: string) => {
    setRuntimeTaskActionRunning((prev) => ({ ...prev, [taskId]: 'cancel' }));
    try {
      await window.ipcRenderer.tasks.cancel({ taskId });
      await loadRuntimeTasks();
      await loadRuntimeTaskTraces(taskId);
    } catch (e) {
      console.error('Failed to cancel runtime task', e);
    } finally {
      setRuntimeTaskActionRunning((prev) => ({ ...prev, [taskId]: undefined }));
    }
  };

  const handleCancelBackgroundTask = async (taskId: string) => {
    setBackgroundTaskActionRunning((prev) => ({ ...prev, [taskId]: 'cancel' }));
    try {
      await window.ipcRenderer.backgroundTasks.cancel(taskId);
      await loadBackgroundTasks();
    } catch (e) {
      console.error('Failed to cancel background task', e);
    } finally {
      setBackgroundTaskActionRunning((prev) => ({ ...prev, [taskId]: undefined }));
    }
  };

  const runToolDiagnostic = async (toolName: string, mode: 'direct' | 'ai') => {
    setToolDiagnosticRunning((prev) => ({ ...prev, [toolName]: mode }));
    try {
      const result = mode === 'direct'
        ? await window.ipcRenderer.toolDiagnostics.runDirect(toolName)
        : await window.ipcRenderer.toolDiagnostics.runAi(toolName);
      setToolDiagnosticResults((prev) => ({ ...prev, [toolName]: result }));
      await loadRecentDebugLogs();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      setToolDiagnosticResults((prev) => ({
        ...prev,
        [toolName]: {
          success: false,
          mode,
          toolName,
          request: null,
          error: errorMessage,
        },
      }));
    } finally {
      setToolDiagnosticRunning((prev) => ({ ...prev, [toolName]: undefined }));
    }
  };

  const runAllToolDiagnostics = async (mode: 'direct' | 'ai') => {
    const candidates = toolDiagnostics.filter((tool) => tool.availabilityStatus === 'available');
    for (const tool of candidates) {
      // eslint-disable-next-line no-await-in-loop
      await runToolDiagnostic(tool.name, mode);
    }
  };

  const persistDeveloperModeState = useCallback(async (enabled: boolean, unlockedAt: string | null) => {
    await window.ipcRenderer.saveSettings({
      developer_mode_enabled: enabled,
      developer_mode_unlocked_at: unlockedAt,
    } as any);
  }, []);

  const expireDeveloperMode = useCallback(async () => {
    setFormData((prev) => ({
      ...prev,
      developer_mode_enabled: false,
      developer_mode_unlocked_at: '',
    }));
    try {
      await persistDeveloperModeState(false, null);
    } catch (error) {
      console.error('Failed to persist developer mode expiration', error);
    }
  }, [persistDeveloperModeState]);

  const handleVersionTap = useCallback(() => {
    setDeveloperVersionTapCount((prev) => {
      const next = prev + 1;
      if (next < DEVELOPER_MODE_UNLOCK_TAP_COUNT) {
        return next;
      }

      const unlockedAt = new Date().toISOString();
      setFormData((current) => ({
        ...current,
        developer_mode_enabled: true,
        developer_mode_unlocked_at: unlockedAt,
      }));
      void persistDeveloperModeState(true, unlockedAt);
      if (activeTab === 'tools') {
        void loadToolDiagnostics();
        void loadRuntimeDeveloperData();
      }
      void appAlert('开发者模式已开启（24 小时内有效）');
      return 0;
    });
  }, [activeTab, persistDeveloperModeState]);

  const loadSettings = useCallback(async (options?: { preserveViewState?: boolean; preserveRemoteModels?: boolean }) => {
    const preserveViewState = Boolean(options?.preserveViewState);
    const preserveRemoteModels = options?.preserveRemoteModels ?? preserveViewState;
    const requestId = ++settingsLoadRequestRef.current;
    try {
      const settings = await window.ipcRenderer.getSettings();
      if (requestId !== settingsLoadRequestRef.current) return;
      if (preserveViewState && aiSourceDraftDirtyRef.current) {
        return;
      }
      if (settings) {
        const resolveLinkedSourceIdFromList = (params: {
          endpoint?: string;
          apiKey?: string;
          model?: string;
          fallbackId?: string;
        }): string => {
          const normalizedEndpoint = String(params.endpoint || '').trim();
          const normalizedApiKey = String(params.apiKey || '').trim();
          const normalizedModel = String(params.model || '').trim();
          let bestSourceId = '';
          let bestScore = -1;

          for (const source of sourceList) {
            let score = 0;
            const sourceEndpoint = String(source.baseURL || '').trim();
            const sourceApiKey = String(source.apiKey || '').trim();
            const sourceModels = [
              ...(source.models || []),
              source.model,
              ...(source.modelsMeta || []).map((item) => String(item?.id || '').trim()),
            ].filter(Boolean);
            if (normalizedEndpoint && sourceEndpoint === normalizedEndpoint) score += 4;
            if (normalizedApiKey && sourceApiKey && sourceApiKey === normalizedApiKey) score += 2;
            if (normalizedModel && sourceModels.includes(normalizedModel)) score += 1;
            if (score > bestScore) {
              bestScore = score;
              bestSourceId = source.id;
            }
          }

          if (bestScore > 0 && bestSourceId) return bestSourceId;
          const fallbackId = String(params.fallbackId || '').trim();
          if (fallbackId && sourceList.some((source) => source.id === fallbackId)) return fallbackId;
          return normalizedDefaultId;
        };

        const requestedDefaultSourceId = String(settings.default_ai_source_id || '').trim();
        const prefersOfficialDefault = requestedDefaultSourceId.toLowerCase() === 'redbox_official_auto';
        let sourceList = parseAiSources(settings.ai_sources_json).filter((source) => !isDeprecatedEmptyOpenAiSource(source));
        if (!sourceList.length && !prefersOfficialDefault && (settings.api_endpoint || settings.api_key || settings.model_name)) {
          const inferredPresetId = inferPresetIdByEndpoint(settings.api_endpoint || '');
          sourceList = [{
            id: generateAiSourceId(),
            name: findAiPresetById(inferredPresetId)?.label || '默认 AI 源',
            presetId: inferredPresetId,
            baseURL: settings.api_endpoint || '',
            apiKey: settings.api_key || '',
            models: normalizeSourceModels([settings.model_name || '']),
            modelsMeta: normalizeAiModelDescriptors([settings.model_name || '']),
            model: settings.model_name || '',
            protocol: findAiPresetById(inferredPresetId)?.protocol || 'openai',
          }];
        }

        const loadedDefaultId = requestedDefaultSourceId || sourceList[0]?.id || 'redbox_official_auto';
        const normalizedDefaultId = sourceList.some((source) => source.id === loadedDefaultId)
          ? loadedDefaultId
          : (loadedDefaultId === 'redbox_official_auto' ? 'redbox_official_auto' : (sourceList[0]?.id || 'redbox_official_auto'));
        const resolvedDefaultSource = sourceList.find((source) => source.id === normalizedDefaultId) || sourceList[0] || null;
        const resolvedTranscriptionSourceId = resolveLinkedSourceIdFromList({
          endpoint: String(settings.transcription_endpoint || settings.api_endpoint || '').trim(),
          apiKey: String(settings.transcription_key || settings.api_key || '').trim(),
          model: String(settings.transcription_model || '').trim(),
          fallbackId: normalizedDefaultId,
        });
        const resolvedEmbeddingSourceId = resolveLinkedSourceIdFromList({
          endpoint: String(settings.embedding_endpoint || settings.api_endpoint || '').trim(),
          apiKey: String(settings.embedding_key || settings.api_key || '').trim(),
          model: String(settings.embedding_model || '').trim(),
          fallbackId: normalizedDefaultId,
        });
        const resolvedImageSourceId = resolveLinkedSourceIdFromList({
          endpoint: String(settings.image_endpoint || settings.api_endpoint || '').trim(),
          apiKey: String(settings.image_api_key || settings.api_key || '').trim(),
          model: String(settings.image_model || '').trim(),
          fallbackId: normalizedDefaultId,
        });
        const unlockedAt = String(settings.developer_mode_unlocked_at || '').trim();
        const unlockedAtMs = unlockedAt ? Date.parse(unlockedAt) : NaN;
        const developerModeEnabled = Boolean(settings.developer_mode_enabled)
          && Number.isFinite(unlockedAtMs)
          && (Date.now() - unlockedAtMs) < DEVELOPER_MODE_TTL_MS;

        setCurrentSpaceState(
          (settings as { active_space_id?: string; activeSpaceId?: string }).active_space_id
          || (settings as { active_space_id?: string; activeSpaceId?: string }).activeSpaceId
        );

        setAiSources(sourceList);
        setDefaultAiSourceId(normalizedDefaultId);
        setActiveAiSourceId((prevActiveId) => {
          if (!preserveViewState) {
            return normalizedDefaultId;
          }
          const currentActiveId = String(prevActiveId || '').trim();
          if (currentActiveId === 'redbox_official_auto') {
            return currentActiveId;
          }
          if (currentActiveId && sourceList.some((source) => source.id === currentActiveId)) {
            return currentActiveId;
          }
          return normalizedDefaultId;
        });
        setModelsBySource((prev) => {
          if (!preserveRemoteModels) {
            return {};
          }
          const validSourceIds = new Set(sourceList.map((source) => source.id));
          return Object.fromEntries(
            Object.entries(prev).filter(([sourceId]) => sourceId === 'redbox_official_auto' || validSourceIds.has(sourceId))
          );
        });
        setFetchingModelsBySourceId((prev) => {
          if (!preserveRemoteModels) {
            return {};
          }
          const validSourceIds = new Set(sourceList.map((source) => source.id));
          return Object.fromEntries(
            Object.entries(prev).filter(([sourceId]) => sourceId === 'redbox_official_auto' || validSourceIds.has(sourceId))
          );
        });
        setDetectedAiProtocol((resolvedDefaultSource?.protocol || findAiPresetById(resolvedDefaultSource?.presetId || '')?.protocol || 'openai') as AiProtocol);
        setMcpServers(parseMcpServers(settings.mcp_servers_json));
        setTranscriptionSourceId(resolvedTranscriptionSourceId);
        setEmbeddingSourceId(resolvedEmbeddingSourceId);
        setImageSourceId(resolvedImageSourceId);
        setNotificationSettings(parseNotificationSettings(settings.notifications_json));
        clearAiSourceDraftDirty();
        console.log('[settings][ai] loadSettings-applied', {
          sourceCount: sourceList.length,
          defaultAiSourceId: normalizedDefaultId,
          transcriptionSourceId: resolvedTranscriptionSourceId,
          embeddingSourceId: resolvedEmbeddingSourceId,
          imageSourceId: resolvedImageSourceId,
        });

        setFormData({
          api_endpoint: resolvedDefaultSource?.baseURL || '',
          api_key: resolvedDefaultSource?.apiKey || '',
          model_name: resolvedDefaultSource?.model || '',
          workspace_dir: settings.workspace_dir || '',
          transcription_model: settings.transcription_model || '',
          transcription_endpoint: settings.transcription_endpoint || '',
          transcription_key: settings.transcription_key || '',
          embedding_endpoint: settings.embedding_endpoint || '',
          embedding_key: settings.embedding_key || '',
          embedding_model: settings.embedding_model || '',
          image_provider: settings.image_provider || 'openai-compatible',
          image_endpoint: settings.image_endpoint || resolveDefaultImageEndpoint(
            settings.image_provider || 'openai-compatible',
            settings.image_provider_template || 'openai-images'
          ),
          image_api_key: settings.image_api_key || '',
          image_provider_template: inferImageTemplateByProvider(
            settings.image_provider || 'openai-compatible',
            settings.image_provider_template || ''
          ),
          image_model: (() => {
            const loadedProvider = settings.image_provider || 'openai-compatible';
            const loadedTemplate = inferImageTemplateByProvider(
              loadedProvider,
              settings.image_provider_template || ''
            );
            if (loadedTemplate === 'dashscope-wan-native') {
              return DASHSCOPE_LOCKED_IMAGE_MODEL;
            }
            return settings.image_model || 'gpt-image-1';
          })(),
          video_endpoint: REDBOX_OFFICIAL_VIDEO_BASE_URL,
          video_api_key: settings.video_api_key || '',
          video_model: settings.video_model || REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video'],
          image_aspect_ratio: settings.image_aspect_ratio || '3:4',
          image_size: '',
          image_quality: settings.image_quality || 'auto',
          model_name_wander: settings.model_name_wander || '',
          model_name_chatroom: settings.model_name_chatroom || '',
          model_name_knowledge: settings.model_name_knowledge || '',
          model_name_redclaw: settings.model_name_redclaw || '',
          proxy_enabled: Boolean(settings.proxy_enabled),
          proxy_url: settings.proxy_url || '',
          proxy_bypass: settings.proxy_bypass || 'localhost,127.0.0.1,::1',
          redclaw_compact_target_tokens: String(settings.redclaw_compact_target_tokens || 256000),
          chat_max_tokens_default: sanitizeChatMaxTokensInput(String(settings.chat_max_tokens_default || DEFAULT_CHAT_MAX_TOKENS), DEFAULT_CHAT_MAX_TOKENS),
          chat_max_tokens_deepseek: sanitizeChatMaxTokensInput(String(settings.chat_max_tokens_deepseek || DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK), DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK),
          wander_deep_think_enabled: Boolean(settings.wander_deep_think_enabled),
          debug_log_enabled: Boolean(settings.debug_log_enabled),
          diagnostics_upload_consent: settings.diagnostics_upload_consent === 'approved'
            ? 'approved'
            : settings.diagnostics_upload_consent === 'none'
              ? 'none'
              : 'prompt',
          diagnostics_include_advanced_context: Boolean(settings.diagnostics_include_advanced_context),
          diagnostics_auto_send_same_crash: Boolean(settings.diagnostics_auto_send_same_crash),
          diagnostics_last_prompted_at: String(settings.diagnostics_last_prompted_at || ''),
          release_log_retention_days: String(settings.release_log_retention_days || 7),
          release_log_max_file_mb: String(settings.release_log_max_file_mb || 10),
          developer_mode_enabled: developerModeEnabled,
          developer_mode_unlocked_at: developerModeEnabled ? unlockedAt : '',
        });

        if (Boolean(settings.developer_mode_enabled) && !developerModeEnabled) {
          void persistDeveloperModeState(false, null);
        }
      } else {
        if (requestId !== settingsLoadRequestRef.current) return;
        setCurrentSpaceState(DEFAULT_SPACE_ID);
        setAiSources([]);
        setDefaultAiSourceId('redbox_official_auto');
        setActiveAiSourceId((prevActiveId) => {
          if (preserveViewState && String(prevActiveId || '').trim() === 'redbox_official_auto') {
            return prevActiveId;
          }
          return 'redbox_official_auto';
        });
        setModelsBySource((prev) => (preserveRemoteModels ? prev : {}));
        setFetchingModelsBySourceId((prev) => (preserveRemoteModels ? prev : {}));
        setDetectedAiProtocol('openai');
        setMcpServers([]);
        setNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
        clearAiSourceDraftDirty();
      }
    } catch (e) {
      if (requestId !== settingsLoadRequestRef.current) return;
      console.error("Failed to load settings", e);
    }
  }, [clearAiSourceDraftDirty, isDeprecatedEmptyOpenAiSource, persistDeveloperModeState, setCurrentSpaceState]);

  const reloadCustomAiSettings = useCallback(async (options?: { preserveViewState?: boolean; preserveRemoteModels?: boolean }) => {
    await loadSettings({
      preserveViewState: true,
      preserveRemoteModels: true,
      ...options,
    });
  }, [loadSettings]);

  const loadNotificationPermissionState = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.notifications.getPermissionState();
      setNotificationPermissionState(normalizeNotificationPermissionState(result?.state));
    } catch (error) {
      console.warn('Failed to load notification permission state:', error);
      setNotificationPermissionState('unknown');
    }
  }, []);


  useEffect(() => {
    if (!formData.developer_mode_enabled || !formData.developer_mode_unlocked_at) {
      return;
    }
    const unlockedAtMs = Date.parse(formData.developer_mode_unlocked_at);
    if (!Number.isFinite(unlockedAtMs)) {
      void expireDeveloperMode();
      return;
    }
    const remaining = DEVELOPER_MODE_TTL_MS - (Date.now() - unlockedAtMs);
    if (remaining <= 0) {
      void expireDeveloperMode();
      return;
    }
    const timer = window.setTimeout(() => {
      void expireDeveloperMode();
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [expireDeveloperMode, formData.developer_mode_enabled, formData.developer_mode_unlocked_at]);

  useEffect(() => {
    void loadNotificationPermissionState();
  }, [loadNotificationPermissionState]);

  const checkTools = useCallback(async () => {
    try {
      const status = await window.ipcRenderer.checkYtdlp();
      setYtdlpStatus(status);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const upsertCliRuntimeInstallQueueItem = useCallback((item: CliRuntimeInstallQueueItem) => {
    setCliRuntimeInstallQueue((prev) => {
      const next = prev.filter((entry) => entry.installId !== item.installId);
      next.unshift(item);
      return next
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 8);
    });
  }, []);

  const loadCliRuntimeDashboard = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsCliRuntimeRefreshing(true);
    }
    try {
      const [detectResult, environmentsResult] = await Promise.all([
        window.ipcRenderer.cliRuntime.detect(),
        window.ipcRenderer.cliRuntime.listEnvironments(),
      ]);
      const detectedToolsRaw = Array.isArray(detectResult)
        ? detectResult
        : Array.isArray((detectResult as { tools?: unknown[] } | null)?.tools)
          ? (detectResult as { tools?: unknown[] }).tools || []
          : [];
      const nextTools = detectedToolsRaw
        .map(normalizeCliRuntimeToolRecord)
        .filter((item): item is CliRuntimeToolRecord => Boolean(item))
        .sort((left, right) => left.name.localeCompare(right.name));
      const nextEnvironments = (Array.isArray(environmentsResult) ? environmentsResult : [])
        .map(normalizeCliRuntimeEnvironmentRecord)
        .filter((item): item is CliRuntimeEnvironmentRecord => Boolean(item))
        .sort((left, right) => left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id));
      setCliRuntimeTools(nextTools);
      setCliRuntimeEnvironments(nextEnvironments);
      if (!options?.silent) {
        setCliRuntimeStatusMessage(`已刷新 CLI runtime：${nextTools.length} 个工具，${nextEnvironments.length} 个环境`);
      }
      setCliRuntimeInstallDraft((current) => {
        if (current.environmentId && nextEnvironments.some((item) => item.id === current.environmentId)) {
          return current;
        }
        const fallbackEnvironment = nextEnvironments[0]?.id || '';
        if (!fallbackEnvironment || fallbackEnvironment === current.environmentId) {
          return current;
        }
        return {
          ...current,
          environmentId: fallbackEnvironment,
        };
      });
    } catch (error) {
      console.error('Failed to load CLI runtime dashboard', error);
      if (!options?.silent) {
        setCliRuntimeStatusMessage(`刷新 CLI runtime 失败：${String(error)}`);
      }
    } finally {
      if (!options?.silent) {
        setIsCliRuntimeRefreshing(false);
      }
    }
  }, []);

  const handleInspectCliRuntimeTool = useCallback(async (toolId: string) => {
    const normalizedToolId = String(toolId || '').trim();
    if (!normalizedToolId) return;
    setCliRuntimeInspectingToolId(normalizedToolId);
    try {
      const result = await window.ipcRenderer.cliRuntime.inspect({ toolId: normalizedToolId });
      const normalized = normalizeCliRuntimeToolRecord(result);
      if (normalized) {
        setCliRuntimeTools((prev) => {
          const next = prev.map((item) => (item.id === normalizedToolId ? { ...item, ...normalized } : item));
          if (!next.some((item) => item.id === normalizedToolId)) {
            next.unshift(normalized);
          }
          return next.sort((left, right) => left.name.localeCompare(right.name));
        });
        setCliRuntimeStatusMessage(`已检查 ${normalized.name || normalized.executable}`);
      } else {
        setCliRuntimeStatusMessage(`未返回 ${normalizedToolId} 的 inspect 数据`);
      }
    } catch (error) {
      console.error('Failed to inspect CLI runtime tool', error);
      setCliRuntimeStatusMessage(`Inspect 失败：${String(error)}`);
    } finally {
      setCliRuntimeInspectingToolId('');
    }
  }, []);

  const handleDiagnoseCliRuntimeCommand = useCallback(async () => {
    const command = String(cliRuntimeDiagnosticCommand || '').trim();
    if (!command) {
      setCliRuntimeStatusMessage('请先输入要诊断的 CLI 命令名，例如 lark-cli');
      return;
    }
    setCliRuntimeInspectingToolId(command);
    try {
      const result = await window.ipcRenderer.cliRuntime.inspect({ command, executable: command });
      const normalized = normalizeCliRuntimeToolRecord(result);
      if (normalized) {
        setCliRuntimeTools((prev) => {
          const next = prev.filter((item) => item.id !== normalized.id);
          next.unshift(normalized);
          return next.sort((left, right) => left.name.localeCompare(right.name));
        });
        setCliRuntimeStatusMessage(
          normalized.resolvedPath
            ? `已解析 ${command}：${normalized.resolvedPath}`
            : `未在当前 PATH 中解析到 ${command}`,
        );
      } else {
        setCliRuntimeStatusMessage(`未返回 ${command} 的诊断数据`);
      }
    } catch (error) {
      console.error('Failed to diagnose CLI runtime command', error);
      setCliRuntimeStatusMessage(`诊断失败：${String(error)}`);
    } finally {
      setCliRuntimeInspectingToolId('');
    }
  }, [cliRuntimeDiagnosticCommand]);

  const handleDiscoverCliRuntimeTools = useCallback(async () => {
    setCliRuntimeDiscovering(true);
    try {
      const result = await window.ipcRenderer.cliRuntime.discover({
        query: String(cliRuntimeDiscoverQuery || '').trim() || undefined,
        limit: 80,
      });
      const discoveredToolsRaw = Array.isArray((result as { tools?: unknown[] } | null)?.tools)
        ? (result as { tools?: unknown[] }).tools || []
        : Array.isArray(result)
          ? result
          : [];
      const normalizedTools = discoveredToolsRaw
        .map(normalizeCliRuntimeToolRecord)
        .filter((item): item is CliRuntimeToolRecord => Boolean(item))
        .sort((left, right) => left.name.localeCompare(right.name));
      setCliRuntimeDiscoverResults(normalizedTools);
      setCliRuntimeStatusMessage(
        normalizedTools.length > 0
          ? `已搜索 PATH，命中 ${normalizedTools.length} 个 CLI`
          : '当前 PATH 搜索没有命中结果',
      );
    } catch (error) {
      console.error('Failed to discover CLI runtime tools', error);
      setCliRuntimeStatusMessage(`PATH 搜索失败：${String(error)}`);
    } finally {
      setCliRuntimeDiscovering(false);
    }
  }, [cliRuntimeDiscoverQuery]);

  const handleCreateCliRuntimeEnvironment = useCallback(async (scope: CliRuntimeEnvironmentScope) => {
    setCliRuntimeCreatingEnvironment(scope);
    try {
      const workspaceRoot = scope === 'workspace-local'
        ? String(formData.workspace_dir || '').trim() || undefined
        : undefined;
      const result = await window.ipcRenderer.cliRuntime.createEnvironment({ scope, workspaceRoot });
      const normalized = normalizeCliRuntimeEnvironmentRecord(result);
      if (normalized) {
        setCliRuntimeEnvironments((prev) => {
          const next = prev.filter((item) => item.id !== normalized.id);
          next.unshift(normalized);
          return next.sort((left, right) => left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id));
        });
        setCliRuntimeStatusMessage(`已创建环境 ${normalized.id}`);
      } else if ((result as { success?: boolean; error?: string } | null)?.success === false) {
        setCliRuntimeStatusMessage((result as { error?: string }).error || '创建 CLI environment 失败');
      } else {
        await loadCliRuntimeDashboard({ silent: true });
        setCliRuntimeStatusMessage(`已触发环境创建：${scope}`);
      }
    } catch (error) {
      console.error('Failed to create CLI runtime environment', error);
      setCliRuntimeStatusMessage(`创建环境失败：${String(error)}`);
    } finally {
      setCliRuntimeCreatingEnvironment('');
    }
  }, [formData.workspace_dir, loadCliRuntimeDashboard]);

  const handleInstallCliRuntimeTool = useCallback(async () => {
    const environmentId = String(cliRuntimeInstallDraft.environmentId || '').trim()
      || cliRuntimeEnvironments[0]?.id
      || '';
    const spec = String(cliRuntimeInstallDraft.spec || '').trim();
    const toolName = String(cliRuntimeInstallDraft.toolName || '').trim();
    if (!environmentId) {
      setCliRuntimeStatusMessage('请先选择一个 CLI environment');
      return;
    }
    if (!spec) {
      setCliRuntimeStatusMessage('请填写要安装的 spec，例如 ffmpeg-static 或 @scope/tool');
      return;
    }
    setCliRuntimeInstalling(true);
    try {
      const result = await window.ipcRenderer.cliRuntime.install({
        environmentId,
        installMethod: cliRuntimeInstallDraft.installMethod,
        spec,
        toolName: toolName || undefined,
      });
      const installId = String((result as { installId?: string } | null)?.installId || '').trim();
      if (installId) {
        upsertCliRuntimeInstallQueueItem({
          installId,
          toolName: String((result as { toolName?: string } | null)?.toolName || toolName || spec),
          environmentId,
          installMethod: cliRuntimeInstallDraft.installMethod,
          spec,
          status: String((result as { status?: string } | null)?.status || 'queued'),
          summary: String((result as { summary?: string } | null)?.summary || ''),
          updatedAt: Date.now(),
        });
      }
      await loadCliRuntimeDashboard({ silent: true });
      setCliRuntimeStatusMessage(
        String((result as { summary?: string } | null)?.summary || `已触发安装：${toolName || spec}`),
      );
      setCliRuntimeInstallDraft((current) => ({
        ...current,
        toolName: '',
        spec: '',
        environmentId,
      }));
    } catch (error) {
      console.error('Failed to install CLI runtime tool', error);
      setCliRuntimeStatusMessage(`安装失败：${String(error)}`);
    } finally {
      setCliRuntimeInstalling(false);
    }
  }, [
    cliRuntimeEnvironments,
    cliRuntimeInstallDraft,
    loadCliRuntimeDashboard,
    upsertCliRuntimeInstallQueueItem,
  ]);

  const handleOpenCliRuntimeEnvironmentRoot = useCallback(async (rootPath: string) => {
    const normalizedPath = String(rootPath || '').trim();
    if (!normalizedPath) return;
    try {
      const result = await window.ipcRenderer.openPath(normalizedPath);
      if (!result?.success) {
        throw new Error(result?.error || '打开目录失败');
      }
    } catch (error) {
      console.error('Failed to open CLI runtime environment root', error);
      setCliRuntimeStatusMessage(`打开目录失败：${String(error)}`);
    }
  }, []);

  useEffect(() => subscribeRuntimeEventStream({
    onCliInstallStarted: ({
      installId,
      toolName,
      environmentId,
      installMethod,
      spec,
    }) => {
      const normalizedInstallId = String(installId || '').trim();
      if (!normalizedInstallId) return;
      upsertCliRuntimeInstallQueueItem({
        installId: normalizedInstallId,
        toolName,
        environmentId,
        installMethod,
        spec,
        status: 'running',
        summary: `正在安装 ${toolName}`,
        updatedAt: Date.now(),
      });
    },
    onCliInstallFinished: ({
      installId,
      toolName,
      environmentId,
      status,
      summary,
      raw,
    }) => {
      const normalizedInstallId = String(installId || '').trim();
      if (!normalizedInstallId) return;
      upsertCliRuntimeInstallQueueItem({
        installId: normalizedInstallId,
        toolName,
        environmentId,
        installMethod: typeof raw.installMethod === 'string' ? raw.installMethod : undefined,
        spec: typeof raw.spec === 'string' ? raw.spec : undefined,
        status,
        summary,
        updatedAt: Date.now(),
      });
      void loadCliRuntimeDashboard({ silent: true });
    },
  }), [loadCliRuntimeDashboard, upsertCliRuntimeInstallQueueItem]);

  const loadBrowserPluginStatus = useCallback(async () => {
    try {
      const status = await window.ipcRenderer.browserPlugin.getStatus();
      setBrowserPluginStatus(status);
    } catch (error) {
      console.error('Failed to load browser plugin status', error);
      setBrowserPluginStatus({
        success: false,
        bundled: false,
        exportPath: '',
        pluginPath: '',
        exported: false,
        bundledPath: '',
        error: String(error),
      });
    }
  }, []);

  useEffect(() => {
    if (!isActive || activeTab !== 'tools') return;
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadCliRuntimeDashboard({ silent: true });
      }, 450);
    };
    const handleRuntimeEvent = (_event: unknown, envelope?: unknown) => {
      const record = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
      const eventType = String(record.eventType || '').trim();
      if (eventType.startsWith('runtime:cli-')) {
        scheduleRefresh();
      }
    };
    window.ipcRenderer.on('runtime:event', handleRuntimeEvent as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.off('runtime:event', handleRuntimeEvent as (...args: unknown[]) => void);
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [activeTab, isActive, loadCliRuntimeDashboard]);

  const withTimeout = useCallback(<T,>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(label));
      }, timeoutMs);
      task.then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      }).catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
    });
  }, []);

  const loadAssistantDaemonStatus = useCallback(async (options?: {
    timeoutMs?: number;
    suppressAlert?: boolean;
  }) => {
    try {
      const request = window.ipcRenderer.assistantDaemon.getStatus() as Promise<AssistantDaemonStatus>;
      const status = typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
        ? await withTimeout(request, options.timeoutMs, '远程连接状态加载超时')
        : await request;
      setAssistantDaemonStatus(status);
      replaceAssistantDaemonDraft(assistantDaemonStatusToDraft(status));
    } catch (error) {
      console.error('Failed to load assistant daemon status', error);
      if (!options?.suppressAlert) {
        void appAlert(`加载远程连接状态失败：${String(error)}`);
      }
    }
  }, [replaceAssistantDaemonDraft, withTimeout]);

  const scheduleRemoteTabWarmup = useCallback(() => {
    if (remoteTabWarmTimerRef.current != null) {
      window.clearTimeout(remoteTabWarmTimerRef.current);
    }
    remoteTabWarmTimerRef.current = window.setTimeout(() => {
      remoteTabWarmTimerRef.current = null;
      void loadAssistantDaemonStatus({
        timeoutMs: 1500,
        suppressAlert: true,
      });
    }, 0);
  }, [loadAssistantDaemonStatus]);

  const buildAssistantDaemonPayload = useCallback(() => ({
    enabled: assistantDaemonDraft.enabled,
    autoStart: assistantDaemonDraft.autoStart,
    keepAliveWhenNoWindow: assistantDaemonDraft.keepAliveWhenNoWindow,
    host: String(assistantDaemonDraft.host || '').trim(),
    port: Number(assistantDaemonDraft.port || 0) || undefined,
    feishu: {
      enabled: assistantDaemonDraft.feishu.enabled,
      receiveMode: assistantDaemonDraft.feishu.receiveMode,
      endpointPath: String(assistantDaemonDraft.feishu.endpointPath || '').trim(),
      verificationToken: String(assistantDaemonDraft.feishu.verificationToken || '').trim() || undefined,
      encryptKey: String(assistantDaemonDraft.feishu.encryptKey || '').trim() || undefined,
      appId: String(assistantDaemonDraft.feishu.appId || '').trim() || undefined,
      appSecret: String(assistantDaemonDraft.feishu.appSecret || '').trim() || undefined,
      replyUsingChatId: assistantDaemonDraft.feishu.replyUsingChatId,
    },
    relay: {
      enabled: assistantDaemonDraft.relay.enabled,
      endpointPath: String(assistantDaemonDraft.relay.endpointPath || '').trim(),
      authToken: String(assistantDaemonDraft.relay.authToken || '').trim() || undefined,
    },
    weixin: {
      enabled: assistantDaemonDraft.weixin.enabled,
      endpointPath: String(assistantDaemonDraft.weixin.endpointPath || '').trim(),
      authToken: String(assistantDaemonDraft.weixin.authToken || '').trim() || undefined,
      accountId: String(assistantDaemonDraft.weixin.accountId || '').trim() || undefined,
      autoStartSidecar: assistantDaemonDraft.weixin.autoStartSidecar,
      cursorFile: String(assistantDaemonDraft.weixin.cursorFile || '').trim() || undefined,
      sidecarCommand: String(assistantDaemonDraft.weixin.sidecarCommand || '').trim() || undefined,
      sidecarArgs: String(assistantDaemonDraft.weixin.sidecarArgs || '').trim()
        ? String(assistantDaemonDraft.weixin.sidecarArgs || '').trim().split(/\s+/)
        : undefined,
      sidecarCwd: String(assistantDaemonDraft.weixin.sidecarCwd || '').trim() || undefined,
      sidecarEnv: parseEnvText(assistantDaemonDraft.weixin.sidecarEnvText || ''),
    },
  }), [assistantDaemonDraft]);

  const handleSaveAssistantDaemonConfig = useCallback(async () => {
    setAssistantDaemonBusy(true);
    try {
      const status = await window.ipcRenderer.assistantDaemon.setConfig(buildAssistantDaemonPayload()) as AssistantDaemonStatus;
      setAssistantDaemonStatus(status);
      replaceAssistantDaemonDraft(assistantDaemonStatusToDraft(status));
    } catch (error) {
      console.error('Failed to save assistant daemon config', error);
      void appAlert(`保存后台通信配置失败：${String(error)}`);
    } finally {
      setAssistantDaemonBusy(false);
    }
  }, [buildAssistantDaemonPayload, replaceAssistantDaemonDraft]);

  const handleStartAssistantDaemon = useCallback(async () => {
    setAssistantDaemonBusy(true);
    try {
      const status = await window.ipcRenderer.assistantDaemon.start(buildAssistantDaemonPayload()) as AssistantDaemonStatus;
      setAssistantDaemonStatus(status);
      replaceAssistantDaemonDraft(assistantDaemonStatusToDraft(status));
    } catch (error) {
      console.error('Failed to start assistant daemon', error);
      void appAlert(`启动后台值守失败：${String(error)}`);
    } finally {
      setAssistantDaemonBusy(false);
    }
  }, [buildAssistantDaemonPayload, replaceAssistantDaemonDraft]);

  const handleStopAssistantDaemon = useCallback(async () => {
    setAssistantDaemonBusy(true);
    try {
      const status = await window.ipcRenderer.assistantDaemon.stop() as AssistantDaemonStatus;
      setAssistantDaemonStatus(status);
      replaceAssistantDaemonDraft(assistantDaemonStatusToDraft(status));
    } catch (error) {
      console.error('Failed to stop assistant daemon', error);
      void appAlert(`停止后台值守失败：${String(error)}`);
    } finally {
      setAssistantDaemonBusy(false);
    }
  }, [replaceAssistantDaemonDraft]);

  const handleStartAssistantDaemonWeixinLogin = useCallback(async () => {
    setAssistantDaemonWeixinLoginBusy(true);
    try {
      const result = await window.ipcRenderer.assistantDaemon.startWeixinLogin({
        accountId: String(assistantDaemonDraft.weixin.accountId || '').trim() || undefined,
        force: true,
      });
      const qrcodeImageUrl = await buildWeixinQrImageUrl(result.qrcodeUrl);
      if (!result.success || !result.qrcodeUrl) {
        setAssistantDaemonWeixinLogin({
          sessionKey: result.sessionKey,
          qrcodeUrl: result.qrcodeUrl,
          qrcodeImageUrl,
          message: result.message,
          connected: false,
          stateDir: result.stateDir,
        });
        void appAlert(result.message || '启动微信扫码失败。');
        return;
      }
      setAssistantDaemonWeixinLogin({
        sessionKey: result.sessionKey,
        qrcodeUrl: result.qrcodeUrl,
        qrcodeImageUrl,
        message: result.message,
        connected: false,
        stateDir: result.stateDir,
      });
    } catch (error) {
      console.error('Failed to start Weixin login', error);
      void appAlert(`启动微信扫码失败：${String(error)}`);
    } finally {
      setAssistantDaemonWeixinLoginBusy(false);
    }
  }, [assistantDaemonDraft.weixin.accountId, buildWeixinQrImageUrl]);

  const handleCheckAssistantDaemonWeixinLogin = useCallback(async () => {
    const sessionKey = String(assistantDaemonWeixinLogin?.sessionKey || '').trim();
    if (!sessionKey) {
      void appAlert('请先点击“开始扫码”，生成微信二维码。');
      return;
    }
    setAssistantDaemonWeixinLoginBusy(true);
    try {
      const result = await window.ipcRenderer.assistantDaemon.waitForWeixinLogin({
        sessionKey,
        timeoutMs: 1500,
      });
      setAssistantDaemonWeixinLogin((prev) => ({
        sessionKey,
        qrcodeUrl: prev?.qrcodeUrl,
        qrcodeImageUrl: prev?.qrcodeImageUrl,
        stateDir: prev?.stateDir,
        message: result.message,
        connected: result.connected,
        accountId: result.accountId,
        userId: result.userId,
      }));
      if (result.connected) {
        setAssistantDaemonDraft((prev) => ({
          ...prev,
          weixin: {
            ...prev.weixin,
            enabled: true,
            autoStartSidecar: true,
            accountId: result.accountId || prev.weixin.accountId,
          },
        }));
        await loadAssistantDaemonStatus();
      }
    } catch (error) {
      console.error('Failed to wait for Weixin login', error);
      void appAlert(`检查微信登录状态失败：${String(error)}`);
    } finally {
      setAssistantDaemonWeixinLoginBusy(false);
    }
  }, [assistantDaemonWeixinLogin?.sessionKey, loadAssistantDaemonStatus, setAssistantDaemonDraft]);

  const handleClearAssistantDaemonWeixinLogin = useCallback(() => {
    setAssistantDaemonWeixinLogin(null);
  }, []);

  const ensureBaseSettingsLoaded = useCallback(async (force = false) => {
    if (baseSettingsInFlightRef.current) return;
    if (!force && baseSettingsLoadedRef.current) return;
    baseSettingsInFlightRef.current = true;
    try {
      await loadSettings({
        preserveViewState: true,
        preserveRemoteModels: true,
      });
      baseSettingsLoadedRef.current = true;
      tabWarmRef.current.ai = true;
    } finally {
      baseSettingsInFlightRef.current = false;
    }
  }, [loadSettings]);

  const ensureTabResourcesLoaded = useCallback(async (tab: SettingsTab, force = false) => {
    if (!isActive) return;
    if (tabInFlightRef.current[tab]) return;
    if (!force && tabWarmRef.current[tab]) return;
    tabInFlightRef.current[tab] = true;
    try {
      if (tab === 'general') {
        await Promise.all([
          loadAppVersion(),
          loadRecentDebugLogs(),
          loadLoggingStatus(),
          loadPendingDiagnosticReports(),
        ]);
      } else if (tab === 'profile') {
        await loadRedclawProfileBundle({
          preserveDraft: true,
        });
      } else if (tab === 'tools') {
        await Promise.all([
          checkTools(),
          loadCliRuntimeDashboard({ silent: true }),
          loadBrowserPluginStatus(),
          loadMcpRuntimeData(),
        ]);
        if (formData.developer_mode_enabled) {
          await Promise.all([
            loadToolDiagnostics(),
            loadRuntimeRoles(),
          ]);
        }
      } else if (tab === 'ai' && aiModelSubTab === 'login' && officialAiPanelEnabled && !OfficialAiPanelComponent) {
        const module = await loadOfficialAiPanelModule();
        const nextComponent = module?.default || null;
        setOfficialAiPanelComponent(() => nextComponent);
        if (!nextComponent) {
          setAiModelSubTab('custom');
        }
      }
      tabWarmRef.current[tab] = true;
    } finally {
      tabInFlightRef.current[tab] = false;
    }
  }, [
    OfficialAiPanelComponent,
    aiModelSubTab,
    checkTools,
    formData.developer_mode_enabled,
    isActive,
    loadRedclawProfileBundle,
    loadCliRuntimeDashboard,
    loadAppVersion,
    loadBackgroundTasks,
    loadBackgroundWorkerPool,
    loadBrowserPluginStatus,
    loadLoggingStatus,
    loadMcpRuntimeData,
    loadPendingDiagnosticReports,
    loadRecentDebugLogs,
    loadRuntimeHooks,
    loadRuntimeRoles,
    loadRuntimeSessions,
    loadRuntimeTasks,
    loadToolDiagnostics,
    officialAiPanelEnabled,
  ]);

  useEffect(() => {
    const handleProgress = (_: unknown, progress: number) => {
      setInstallProgress(progress);
    };
    window.ipcRenderer.on('youtube:install-progress', handleProgress);
    return () => {
      window.ipcRenderer.off('youtube:install-progress', handleProgress);
    };
  }, []);

  useEffect(() => {
    if (settingsActivationTimerRef.current != null) {
      window.clearTimeout(settingsActivationTimerRef.current);
    }

    settingsActivationTimerRef.current = window.setTimeout(() => {
      void ensureBaseSettingsLoaded();
      settingsActivationTimerRef.current = null;
    }, SETTINGS_ACTIVATION_DEBOUNCE_MS);

    return () => {
      if (settingsActivationTimerRef.current != null) {
        window.clearTimeout(settingsActivationTimerRef.current);
        settingsActivationTimerRef.current = null;
      }
    };
  }, [ensureBaseSettingsLoaded]);

  useEffect(() => {
    if (!isActive) return;
    const handleSettingsUpdated = () => {
      // Preserve local edits on form-driven tabs; otherwise external auth sync can
      // reload persisted settings and wipe unsaved AI source/model changes.
      const preserveLocalFormState = activeTab === 'general' || activeTab === 'ai';
      if (!preserveLocalFormState) {
        void ensureBaseSettingsLoaded(true);
      }
      tabWarmRef.current.profile = false;
      if (activeTab === 'remote') {
        scheduleRemoteTabWarmup();
      }
      if (activeTab === 'profile' && !redclawProfileDirtyRef.current) {
        void ensureTabResourcesLoaded('profile', true);
      }
      if (activeTab === 'general' || activeTab === 'tools') {
        tabWarmRef.current[activeTab] = false;
        void ensureTabResourcesLoaded(activeTab, true);
      }
    };
    window.ipcRenderer.on('settings:updated', handleSettingsUpdated);
    return () => {
      window.ipcRenderer.off('settings:updated', handleSettingsUpdated);
    };
  }, [activeTab, ensureBaseSettingsLoaded, ensureTabResourcesLoaded, isActive, scheduleRemoteTabWarmup]);

  useEffect(() => {
    if (!isActive) return;
    const handleSpaceChanged = (payload?: { spaceId?: string; activeSpaceId?: string }) => {
      const nextSpaceId = setCurrentSpaceState(payload?.activeSpaceId || payload?.spaceId);
      tabWarmRef.current.profile = false;
      resetRedclawProfileState();
      if (activeTab === 'profile') {
        void loadRedclawProfileBundle({ expectedSpaceId: nextSpaceId });
      }
    };
    window.ipcRenderer.on('space:changed', handleSpaceChanged);
    return () => {
      window.ipcRenderer.off('space:changed', handleSpaceChanged);
    };
  }, [activeTab, isActive, loadRedclawProfileBundle, resetRedclawProfileState, setCurrentSpaceState]);

  useEffect(() => {
    if (!redclawOnboardingVersion) return;
    void loadRedclawProfileBundle({ expectedSpaceId: currentSpaceIdRef.current });
  }, [loadRedclawProfileBundle, redclawOnboardingVersion]);

  useEffect(() => {
    const handleDiagnosticsReportPending = () => {
      void Promise.all([
        loadLoggingStatus(),
        loadPendingDiagnosticReports(),
      ]);
    };
    window.ipcRenderer.on('diagnostics:report-pending', handleDiagnosticsReportPending);
    return () => {
      window.ipcRenderer.off('diagnostics:report-pending', handleDiagnosticsReportPending);
    };
  }, [loadLoggingStatus, loadPendingDiagnosticReports]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    if (!baseSettingsLoadedRef.current) {
      return;
    }
    let runtimePollTimer: number | null = null;
    let backgroundTaskPollTimer: number | null = null;
    if (activeTab === 'remote') {
      scheduleRemoteTabWarmup();
    }
    if (activeTab === 'general') {
      void ensureTabResourcesLoaded('general');
    }
    if (activeTab === 'profile') {
      void ensureTabResourcesLoaded('profile');
    }
    if (activeTab === 'tools') {
      void ensureTabResourcesLoaded('tools');
      if (
        formData.developer_mode_enabled
        && (runtimeTasks.length > 0 || runtimeSessions.length > 0)
      ) {
        runtimePollTimer = window.setInterval(() => {
          void Promise.all([
            loadRuntimeTasks(),
            loadRuntimeSessions(),
          ]);
        }, Math.max(8000, SETTINGS_TAB_POLL_DELAY_MS));
      }
      if (
        formData.developer_mode_enabled
        && backgroundTasks.length > 0
      ) {
        backgroundTaskPollTimer = window.setInterval(() => {
          void Promise.all([
            loadBackgroundTasks(),
            loadBackgroundWorkerPool(),
          ]);
        }, Math.max(5000, SETTINGS_TAB_POLL_DELAY_MS));
      }
    }

    return () => {
      if (runtimePollTimer) {
        window.clearInterval(runtimePollTimer);
      }
      if (backgroundTaskPollTimer) {
        window.clearInterval(backgroundTaskPollTimer);
      }
      if (remoteTabWarmTimerRef.current != null) {
        window.clearTimeout(remoteTabWarmTimerRef.current);
        remoteTabWarmTimerRef.current = null;
      }
    };
  }, [
    activeTab,
    backgroundTasks.length,
    ensureTabResourcesLoaded,
    formData.developer_mode_enabled,
    isActive,
    loadBackgroundTasks,
    loadBackgroundWorkerPool,
    loadRuntimeSessions,
    loadRuntimeTasks,
    runtimeSessions.length,
    runtimeTasks.length,
    scheduleRemoteTabWarmup,
  ]);

  const handleInstallYtdlp = async () => {
    setIsInstallingTool(true);
    setInstallProgress(0);
    try {
      const res = await window.ipcRenderer.installYtdlp();
      if (res.success) {
        await checkTools();
        void appAlert('安装成功！');
      } else {
        void appAlert('安装失败: ' + res.error);
      }
    } catch (e) {
      void appAlert('安装出错');
    } finally {
      setIsInstallingTool(false);
    }
  };

  const handleUpdateYtdlp = async () => {
    setIsInstallingTool(true);
    try {
      const res = await window.ipcRenderer.updateYtdlp();
      if (res.success) {
        await checkTools();
        void appAlert('更新成功！');
      } else {
        void appAlert('更新失败: ' + res.error);
      }
    } catch (e) {
      void appAlert('更新出错');
    } finally {
      setIsInstallingTool(false);
    }
  };

  const handlePrepareBrowserPlugin = async () => {
    setIsPreparingBrowserPlugin(true);
    try {
      const result = await window.ipcRenderer.browserPlugin.prepare();
      if (!result.success) {
        void appAlert(`插件准备失败：${result.error || '未知错误'}`);
        return;
      }
      await loadBrowserPluginStatus();
      void appAlert(`插件已同步到最新内置版本。\n\n外层目录：${result.path}\n插件目录：${result.pluginPath || '未返回'}\n\n下一步请打开 Chrome / Edge 扩展管理页，开启开发者模式后，将里面的“RedBox Browser Extension”文件夹拖进浏览器，或在“加载已解压的扩展程序”里选择该插件文件夹。`);
    } catch (error) {
      console.error('Failed to prepare browser plugin', error);
      void appAlert(`插件准备失败：${String(error)}`);
    } finally {
      setIsPreparingBrowserPlugin(false);
    }
  };

  const handleOpenBrowserPluginDir = async () => {
    try {
      const result = await window.ipcRenderer.browserPlugin.openDir();
      if (!result.success) {
        void appAlert(`打开插件目录失败：${result.error || '未知错误'}`);
        return;
      }
      await loadBrowserPluginStatus();
    } catch (error) {
      console.error('Failed to open browser plugin dir', error);
      void appAlert(`打开插件目录失败：${String(error)}`);
    }
  };

  const handleOpenKnowledgeApiGuide = async () => {
    try {
      const result = await window.ipcRenderer.openKnowledgeApiGuide();
      if (!result.success) {
        void appAlert(`打开知识导入 API 文档失败：${result.error || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to open knowledge api guide', error);
      void appAlert(`打开知识导入 API 文档失败：${String(error)}`);
    }
  };

  const handlePickWorkspaceDir = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.pickWorkspaceDir();
      if (!result?.success || !String(result.path || '').trim()) {
        if (!result?.canceled && result?.error) {
          void appAlert(`选择工作区目录失败：${String(result.error)}`);
        }
        return;
      }
      setFormData((prev) => ({
        ...prev,
        workspace_dir: String(result.path || '').trim(),
      }));
    } catch (error) {
      console.error('Failed to pick workspace dir', error);
      void appAlert(`选择工作区目录失败：${String(error)}`);
    }
  }, []);

  const handleResetWorkspaceDir = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      workspace_dir: '',
    }));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (aiSourceAutosaveTimerRef.current != null) {
      window.clearTimeout(aiSourceAutosaveTimerRef.current);
      aiSourceAutosaveTimerRef.current = null;
    }
    setStatus('saving');
    try {
      if (activeTab === 'profile') {
        const userMarkdown = String(redclawProfileDraft.user || '').trim();
        const creatorProfileMarkdown = String(redclawProfileDraft.creatorProfile || '').trim();
        if (!userMarkdown) {
          throw new Error('用户画像不能为空');
        }
        if (!creatorProfileMarkdown) {
          throw new Error('创作档案不能为空');
        }
        let savedDocCount = 0;
        await window.ipcRenderer.redclawProfile.updateDoc({
          docType: 'user',
          markdown: userMarkdown,
          reason: 'settings-user-profile-save',
        });
        savedDocCount += 1;
        await window.ipcRenderer.redclawProfile.updateDoc({
          docType: 'creator_profile',
          markdown: creatorProfileMarkdown,
          reason: 'settings-user-profile-save',
        });
        savedDocCount += 1;
        const nextDraft: RedclawProfileDraft = {
          user: userMarkdown,
          creatorProfile: creatorProfileMarkdown,
        };
        setSavedRedclawProfileDraft(nextDraft);
        setRedclawProfileDraft(nextDraft);
        setRedclawProfileDirtyState(false);
        setRedclawProfileMessage({
          tone: 'success',
          text: savedDocCount === 2
            ? '用户档案已保存，RedClaw 后续会直接读取这两份长期档案。'
            : '用户档案已保存。',
        });
        tabWarmRef.current.profile = true;
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 2000);
        return;
      }

      const {
        sanitizedSources,
        resolvedDefaultSourceId,
        defaultSource,
        resolvedApiEndpoint,
        resolvedApiKey,
        resolvedModelName,
      } = buildAiSourcePersistenceSnapshot();
      if (defaultSource?.baseURL && (defaultSource?.apiKey || isLocalAiSource(defaultSource))) {
        const normalizedModel = (defaultSource.model || '').trim();
        if (!normalizedModel) {
          throw new Error('请为默认 AI 源填写模型名称（可手动填写，或从模型列表选择）');
        }
      }
      const resolvedTranscriptionSource = getAiSourceById(transcriptionSourceId) || defaultSource || null;
      const resolvedEmbeddingSource = getAiSourceById(embeddingSourceId) || defaultSource || null;
      const resolvedImageSource = getAiSourceById(imageSourceId) || defaultSource || null;
      const resolvedTranscriptionModel = String(formData.transcription_model || pickBestModelForSource(resolvedTranscriptionSource) || '').trim();
      const resolvedEmbeddingModel = String(formData.embedding_model || pickBestModelForSource(resolvedEmbeddingSource) || '').trim();
      const resolvedImageModel = String(formData.image_model || pickBestModelForSource(resolvedImageSource) || '').trim();
      const resolvedVideoModel = REDBOX_OFFICIAL_VIDEO_MODEL_LIST.includes(String(formData.video_model || '').trim() as typeof REDBOX_OFFICIAL_VIDEO_MODEL_LIST[number])
        ? String(formData.video_model || '').trim()
        : REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video'];
      const selectedImageModel = String(resolvedImageModel || '').trim();
      if (!selectedImageModel) {
        throw new Error('请填写生图模型（可手动输入或从列表选择）');
      }
      const parsedCompactTokens = Number(formData.redclaw_compact_target_tokens);
      const compactTargetTokens = Number.isFinite(parsedCompactTokens) && parsedCompactTokens > 0
        ? Math.max(16000, Math.floor(parsedCompactTokens))
        : 256000;
      const chatMaxTokensDefault = Number(sanitizeChatMaxTokensInput(
        formData.chat_max_tokens_default,
        DEFAULT_CHAT_MAX_TOKENS,
      ));
      const chatMaxTokensDeepseek = Number(sanitizeChatMaxTokensInput(
        formData.chat_max_tokens_deepseek,
        DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK,
      ));
      const releaseLogRetentionDays = Math.max(1, Number(formData.release_log_retention_days || 7) || 7);
      const releaseLogMaxFileMb = Math.max(1, Number(formData.release_log_max_file_mb || 10) || 10);
      if (formData.proxy_enabled && !String(formData.proxy_url || '').trim()) {
        throw new Error('启用代理时必须填写代理地址，例如 http://127.0.0.1:7890');
      }

      await window.ipcRenderer.saveSettings({
        ...formData,
        api_endpoint: resolvedApiEndpoint,
        api_key: resolvedApiKey,
        model_name: resolvedModelName,
        model_name_wander: String(formData.model_name_wander || '').trim(),
        model_name_chatroom: String(formData.model_name_chatroom || '').trim(),
        model_name_knowledge: String(formData.model_name_knowledge || '').trim(),
        model_name_redclaw: String(formData.model_name_redclaw || '').trim(),
        proxy_enabled: Boolean(formData.proxy_enabled),
        proxy_url: String(formData.proxy_url || '').trim(),
        proxy_bypass: String(formData.proxy_bypass || '').trim(),
        transcription_model: resolvedTranscriptionModel,
        transcription_endpoint: String(resolvedTranscriptionSource?.baseURL || formData.transcription_endpoint || resolvedApiEndpoint).trim(),
        transcription_key: String(resolvedTranscriptionSource?.apiKey || formData.transcription_key || '').trim(),
        embedding_model: resolvedEmbeddingModel,
        embedding_endpoint: String(resolvedEmbeddingSource?.baseURL || formData.embedding_endpoint || resolvedApiEndpoint).trim(),
        embedding_key: String(resolvedEmbeddingSource?.apiKey || formData.embedding_key || '').trim(),
        image_provider: formData.image_provider,
        image_provider_template: formData.image_provider_template,
        image_endpoint: String(resolvedImageSource?.baseURL || formData.image_endpoint || '').trim(),
        image_api_key: String(resolvedImageSource?.apiKey || formData.image_api_key || '').trim(),
        image_model: resolvedImageModel,
        video_endpoint: REDBOX_OFFICIAL_VIDEO_BASE_URL,
        video_api_key: String(formData.video_api_key || formData.api_key || '').trim(),
        video_model: resolvedVideoModel,
        ai_sources_json: JSON.stringify(sanitizedSources),
        default_ai_source_id: resolvedDefaultSourceId || defaultSource?.id || '',
        mcp_servers_json: JSON.stringify(mcpServers),
        redclaw_compact_target_tokens: compactTargetTokens,
        debug_log_enabled: Boolean(formData.debug_log_enabled),
        diagnostics_upload_consent: formData.diagnostics_upload_consent,
        diagnostics_include_advanced_context: Boolean(formData.diagnostics_include_advanced_context),
        diagnostics_auto_send_same_crash: Boolean(formData.diagnostics_auto_send_same_crash),
        diagnostics_last_prompted_at: formData.diagnostics_last_prompted_at || null,
        release_log_retention_days: releaseLogRetentionDays,
        release_log_max_file_mb: releaseLogMaxFileMb,
        notifications_json: JSON.stringify(notificationSettings),
        developer_mode_enabled: Boolean(formData.developer_mode_enabled),
        developer_mode_unlocked_at: formData.developer_mode_enabled
          ? (formData.developer_mode_unlocked_at || new Date().toISOString())
          : null,
        chat_max_tokens_default: chatMaxTokensDefault,
        chat_max_tokens_deepseek: chatMaxTokensDeepseek,
      });
      clearAiSourceDraftDirty();
      if (formData.debug_log_enabled) {
        await loadRecentDebugLogs();
      }
      await Promise.all([
        loadLoggingStatus(),
        loadPendingDiagnosticReports(),
      ]);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      console.error(e);
      if (activeTab === 'profile') {
        setRedclawProfileMessage({
          tone: 'error',
          text: e instanceof Error ? e.message : String(e),
        });
      }
      if (e instanceof Error && e.message) {
        setTestStatus('error');
        setTestMsg(e.message);
      }
      setStatus('error');
    }
  };

  const handleTestNotificationSound = useCallback(async () => {
    try {
      await playTestNotificationSound('attention', notificationSettings.sound.volume);
      setNotificationStatusMessage('已播放测试提醒音。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotificationStatusMessage(`播放测试提醒音失败：${message}`);
    }
  }, [notificationSettings.sound.volume]);

  const handleRequestNotificationPermission = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.notifications.requestPermission();
      const state = normalizeNotificationPermissionState(result?.state);
      setNotificationPermissionState(state);
      setNotificationStatusMessage(`系统通知权限状态：${state}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotificationStatusMessage(`请求系统通知权限失败：${message}`);
    }
  }, []);

  const handleSendTestSystemNotification = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.notifications.showSystem({
        title: 'RedBox 通知测试',
        body: '这是一条系统通知测试消息。',
      });
      if (!result?.success) {
        throw new Error(result?.error || '系统通知发送失败');
      }
      setNotificationStatusMessage('系统通知已发送。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotificationStatusMessage(`系统通知测试失败：${message}`);
    }
  }, []);

  const tabs = [
    { id: 'ai', label: 'AI 模型', icon: Cpu },
    { id: 'general', label: '常规设置', icon: LayoutGrid },
    { id: 'profile', label: '用户档案', icon: FileText },
    { id: 'tools', label: '工具管理', icon: Wrench },
  ] as const;

  return (
    <div className="flex h-full bg-background text-text-primary">
      {/* Sidebar */}
      <div className="w-48 border-r border-border pt-6 pb-4 flex flex-col gap-1 px-3 bg-surface-secondary/20">
        <h1 className="px-3 mb-4 text-xs font-bold text-text-tertiary uppercase tracking-wider">设置</h1>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
            }}
            className={clsx(
              "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              activeTab === tab.id ? "bg-surface-secondary text-text-primary" : "text-text-secondary hover:bg-surface-secondary/50 hover:text-text-primary"
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 pb-32">
          <form onSubmit={handleSave} className="space-y-10">

            {/* General Tab */}
            {activeTab === 'general' && (
              <GeneralSettingsSection
                appVersion={appVersion}
                formData={formData}
                setFormData={setFormData}
                notificationSettings={notificationSettings}
                setNotificationSettings={setNotificationSettings}
                notificationPermissionState={notificationPermissionState}
                notificationStatusMessage={notificationStatusMessage}
                handleTestNotificationSound={handleTestNotificationSound}
                handleRequestNotificationPermission={handleRequestNotificationPermission}
                handleSendTestSystemNotification={handleSendTestSystemNotification}
                handlePickWorkspaceDir={handlePickWorkspaceDir}
                handleResetWorkspaceDir={handleResetWorkspaceDir}
                handleOpenKnowledgeApiGuide={handleOpenKnowledgeApiGuide}
                recentDebugLogs={recentDebugLogs}
                isDebugLogsLoading={isDebugLogsLoading}
                handleRefreshDebugLogs={loadRecentDebugLogs}
                handleOpenDebugLogDir={openDebugLogDirectory}
                logStatus={logStatus}
                pendingReports={pendingDiagnosticReports}
                diagnosticsActionBusy={diagnosticsActionBusy}
                handleExportDiagnosticBundle={handleExportDiagnosticBundle}
                handleUploadPendingReport={handleUploadPendingReport}
                handleDismissPendingReport={handleDismissPendingReport}
                handleVersionTap={handleVersionTap}
              />
            )}

            {/* AI Tab */}
            {activeTab === 'ai' && (
              <div className="space-y-10">
                {/* LLM Connection Config */}
                <section className="space-y-6">
                  <h2 className="text-lg font-medium text-text-primary mb-6">AI 模型设置</h2>

                  <div className="flex justify-center">
                    <div className="inline-flex items-center rounded-full border border-border bg-surface-secondary/40 p-1 shadow-sm">
                      <button
                        type="button"
                        onClick={() => setAiModelSubTab('custom')}
                        className={clsx(
                          'px-6 py-2 text-xs rounded-full transition-colors',
                          aiModelSubTab === 'custom'
                            ? 'bg-surface-primary text-text-primary border border-border shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        自定义
                      </button>
                      {officialAiPanelEnabled && (
                        <button
                          type="button"
                          onClick={() => setAiModelSubTab('login')}
                          className={clsx(
                            'px-6 py-2 text-xs rounded-full transition-colors',
                            aiModelSubTab === 'login'
                              ? 'bg-surface-primary text-text-primary border border-border shadow-sm'
                              : 'text-text-secondary hover:text-text-primary'
                          )}
                        >
                          登录
                        </button>
                      )}
                    </div>
                  </div>

                  <>
                  {aiModelSubTab === 'custom' && (
                  <>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-medium text-text-primary">聊天 AI 源</h3>
                        <p className="text-[11px] text-text-tertiary mt-1">
                          支持多模型源、多模型，并可指定默认聊天源与默认模型。
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setModelsBySource({});
                            setTestStatus('idle');
                            setTestMsg('');
                          }}
                          className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                        >
                          清除状态
                        </button>
                        <button
                          type="button"
                          onClick={openCreateAiSourceModal}
                          className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                        >
                          <Plus className="w-3 h-3" />
                          添加模型源
                        </button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-border bg-surface-secondary/20 p-3 space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-text-secondary mb-1">默认聊天源</label>
                          <AiSourceSelect
                            value={defaultAiSourceId}
                            sources={aiSources}
                            onChange={(nextSourceId) => {
                              markAiSourceDraftDirty();
                              setDefaultAiSourceId(nextSourceId);
                              setActiveAiSourceId(nextSourceId);
                              setAiSourceExpandState((prev) => ({ ...prev, [nextSourceId]: true }));
                            }}
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-text-secondary mb-1">默认聊天模型</label>
                          <AiModelSelect
                            value={defaultAiSource?.model || ''}
                            disabled={!defaultAiSource || defaultSourceModels.length === 0}
                            onChange={(modelId) => {
                              if (!defaultAiSource) return;
                              handleSetSourceDefaultModel(defaultAiSource.id, modelId);
                              setActiveAiSourceId(defaultAiSource.id);
                            }}
                            className="w-full"
                            placeholder="请先为默认源添加模型"
                            options={defaultSourceModels.map((model) => ({
                              id: model.id,
                              label: model.id,
                              badges: buildModelCapabilityBadges(model.capabilities),
                              inputIcons: buildModelInputIcons(model.inputCapabilities),
                            }))}
                          />
                        </div>
                      </div>

                      <p className={clsx(
                        'text-[11px]',
                        defaultOfficialSourceUnavailable ? 'text-amber-600' : 'text-text-tertiary'
                      )}>
                        {defaultOfficialSourceUnavailable
                          ? '当前官方源未登录，请重新登录或切换到其他默认聊天源。'
                          : `当前生效：${defaultAiSource?.name || '未设置'} / ${defaultAiSource?.model || '未设置'}`}
                      </p>
                    </div>

                    <div className="rounded-xl border border-border bg-surface-secondary/20 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setShowScopedModelOverrides((prev) => !prev)}
                        className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-surface-secondary/40 transition-colors"
                      >
                        <span className="text-sm font-medium text-text-primary">高级：页面模型覆盖（可选）</span>
                        <span className="flex items-center gap-2 text-[11px] text-text-tertiary">
                          已设置 {scopedModelOverridesCount} 项
                          <ChevronDown className={clsx('w-4 h-4 transition-transform', showScopedModelOverrides && 'rotate-180')} />
                        </span>
                      </button>

                      {showScopedModelOverrides && (
                        <div className="px-3 pb-3 space-y-3 border-t border-border/70">
                          <p className="text-[11px] text-text-tertiary pt-3">
                            留空表示跟随“默认聊天模型”。此配置面向高级用户，分别作用于漫步、群聊、知识库、RedClaw。
                          </p>
                          <datalist id="scoped-model-candidates">
                            {allConfiguredModels.map((modelId) => (
                              <option key={modelId} value={modelId} />
                            ))}
                          </datalist>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[11px] text-text-secondary">漫步默认模型</label>
                              <input
                                type="text"
                                list="scoped-model-candidates"
                                value={formData.model_name_wander}
                                onChange={(e) => setFormData((d) => ({ ...d, model_name_wander: e.target.value }))}
                                placeholder="留空跟随默认模型"
                                className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] text-text-secondary">群聊默认模型</label>
                              <input
                                type="text"
                                list="scoped-model-candidates"
                                value={formData.model_name_chatroom}
                                onChange={(e) => setFormData((d) => ({ ...d, model_name_chatroom: e.target.value }))}
                                placeholder="留空跟随默认模型"
                                className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] text-text-secondary">知识库默认模型</label>
                              <input
                                type="text"
                                list="scoped-model-candidates"
                                value={formData.model_name_knowledge}
                                onChange={(e) => setFormData((d) => ({ ...d, model_name_knowledge: e.target.value }))}
                                placeholder="留空跟随默认模型"
                                className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] text-text-secondary">RedClaw 默认模型</label>
                              <input
                                type="text"
                                list="scoped-model-candidates"
                                value={formData.model_name_redclaw}
                                onChange={(e) => setFormData((d) => ({ ...d, model_name_redclaw: e.target.value }))}
                                placeholder="留空跟随默认模型"
                                className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-border bg-surface-secondary/20 p-2 space-y-2">
                      {displayedAiSources.map((source) => {
                        const preset = findAiPresetById(source.presetId);
                        const isDefaultSource = source.id === defaultAiSourceId;
                        const isExpanded = aiSourceExpandState[source.id] ?? false;
                        const isOfficialSource = isOfficialManagedSource(source);
                        const isOfficialPlaceholder = isOfficialSource && !hasOfficialManagedSource;
                        const isModelListExpanded = aiSourceModelExpandState[source.id] ?? false;
                        const sourceModels = getAddedSourceModelList(source);
                        const isOfficialSourcePending = isOfficialSource && officialAuthPending;
                        const isOfficialSourceLoggedIn = isOfficialSource && officialAuthLoggedIn;
                        const isOfficialSourceUnavailable = isOfficialSource && !officialAuthLoggedIn;
                        const sourceModelsForDisplay = isOfficialSource
                          ? (isOfficialSourceLoggedIn ? sourceModels : [])
                          : sourceModels;
                        const localGuide = getLocalGuideForSource(source);
                        const allowEmptyKey = isLocalAiSource(source);

                        return (
                          <div key={source.id} className="rounded-lg border border-border bg-surface-primary overflow-hidden">
                            <div className="px-3 py-2 border-b border-border/70 flex items-center gap-2.5">
                              <button
                                type="button"
                                onClick={() => handleToggleAiSourceExpand(source.id)}
                                className="text-text-tertiary hover:text-text-primary transition-colors"
                                title={isExpanded ? '收起' : '展开'}
                              >
                                <ChevronDown className={clsx('w-4 h-4 transition-transform', !isExpanded && '-rotate-90')} />
                              </button>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 min-w-0">
                                  <AiSourceLogo source={source} />
                                  <span className="text-sm font-medium text-text-primary truncate">{source.name || '未命名模型源'}</span>
                                  {isDefaultSource && !isOfficialPlaceholder && !isOfficialSourceUnavailable && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600">
                                      <Star className="w-2.5 h-2.5" />
                                      默认源
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] text-text-tertiary mt-0.5 truncate">
                                  {isOfficialSource
                                    ? isOfficialSourcePending
                                      ? '官方托管模型源 · 正在检查登录状态'
                                      : isOfficialSourceUnavailable
                                      ? '官方托管模型源 · 当前未登录，登录后自动同步官方模型与凭据'
                                      : `已托管登录态 · 默认模型：${source.model || '(未设置)'} · 已添加 ${sourceModelsForDisplay.length} 个模型`
                                    : `${preset?.label || 'Custom'} · 默认模型：${source.model || '(未设置)'} · 已添加 ${sourceModels.length} 个模型`}
                                </p>
                              </div>
                              {isOfficialSourceUnavailable ? (
                                <button
                                  type="button"
                                  onClick={() => setAiModelSubTab('login')}
                                  className="px-2 py-1 text-[11px] border rounded transition-colors border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
                                  disabled={isOfficialSourcePending}
                                >
                                  {isOfficialSourcePending ? '检查中' : '去登录'}
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      markAiSourceDraftDirty();
                                      setDefaultAiSourceId(source.id);
                                      setActiveAiSourceId(source.id);
                                    }}
                                    className={clsx(
                                      'px-2 py-1 text-[11px] border rounded transition-colors',
                                      isDefaultSource
                                        ? 'border-amber-500/40 text-amber-600 bg-amber-500/10'
                                        : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary'
                                    )}
                                  >
                                    设为默认
                                  </button>
                                  {!isOfficialSource && (
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteAiSource(source.id)}
                                      className="p-1.5 text-text-tertiary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                      title="删除模型源"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>

                            {isExpanded && (
                              <div className="p-3 space-y-3">
                                {isOfficialSourceUnavailable ? (
                                  <div className={clsx(
                                    'rounded border px-3 py-3 text-[11px] space-y-2',
                                    isOfficialSourcePending
                                      ? 'border-border bg-surface-secondary/30 text-text-secondary'
                                      : 'border-amber-500/25 bg-amber-500/5 text-text-secondary'
                                  )}>
                                    <div className={clsx(
                                      'font-medium',
                                      isOfficialSourcePending ? 'text-text-primary' : 'text-amber-600'
                                    )}>
                                      {isOfficialSourcePending
                                        ? '正在检查登录状态'
                                        : officialAuthNeedsLogin
                                        ? '当前账号登录已失效'
                                        : '当前账号未登录'}
                                    </div>
                                    <p>
                                      {isOfficialSourcePending
                                        ? '正在和宿主同步官方账号状态，完成后会自动刷新这里的模型与凭据。'
                                        : '官方源仍会固定显示在这里，但当前不会再使用旧模型和旧凭据。重新登录后会自动恢复同步。'}
                                    </p>
                                    {!isOfficialSourcePending && (
                                      <button
                                        type="button"
                                        onClick={() => setAiModelSubTab('login')}
                                        className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                      >
                                        前往登录
                                      </button>
                                    )}
                                  </div>
                                ) : isOfficialSource ? (
                                  <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-text-secondary">
                                    <div className="font-medium text-emerald-600">已登录</div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                      <input
                                        type="text"
                                        value={source.name}
                                        onChange={(e) => updateAiSource(source.id, (prev) => ({ ...prev, name: e.target.value }))}
                                        placeholder="来源名称"
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                      />
                                      <AiPresetSelect
                                        value={source.presetId}
                                        groups={groupedAiPresets}
                                        onChange={(nextPresetId) => {
                                          updateAiSource(source.id, (prev) => {
                                            const previousPreset = findAiPresetById(prev.presetId);
                                            const nextPreset = findAiPresetById(nextPresetId);
                                            const shouldSyncBaseURL = !prev.baseURL || (previousPreset?.baseURL && prev.baseURL === previousPreset.baseURL);
                                            const shouldSyncName = !prev.name || prev.name === previousPreset?.label;
                                            return {
                                              ...prev,
                                              presetId: nextPresetId,
                                              baseURL: shouldSyncBaseURL ? (nextPreset?.baseURL || '') : prev.baseURL,
                                              name: shouldSyncName ? (nextPreset?.label || prev.name) : prev.name,
                                              protocol: nextPreset?.protocol || prev.protocol || 'openai',
                                            };
                                          });
                                          setActiveAiSourceId(source.id);
                                        }}
                                      />
                                      <AiModelSelect
                                        value={source.protocol || 'openai'}
                                        onChange={(value) => {
                                          const protocol = value as AiProtocol;
                                          updateAiSource(source.id, (prev) => ({ ...prev, protocol }));
                                          setDetectedAiProtocol(protocol);
                                          setActiveAiSourceId(source.id);
                                        }}
                                        className="w-full"
                                        options={[
                                          { id: 'openai', label: 'OpenAI Compatible' },
                                          { id: 'anthropic', label: 'Anthropic Native' },
                                          { id: 'gemini', label: 'Gemini Native' },
                                        ]}
                                      />
                                    </div>

                                    <input
                                      type="text"
                                      value={source.baseURL}
                                      onChange={(e) => {
                                        updateAiSource(source.id, (prev) => ({ ...prev, baseURL: e.target.value }));
                                        setActiveAiSourceId(source.id);
                                      }}
                                      placeholder="API Endpoint (Base URL)"
                                      className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                    />

                                    {localGuide && (
                                      <div className="rounded border border-border bg-surface-secondary/30 px-3 py-2 text-[11px] text-text-secondary space-y-1">
                                        <div className="font-medium text-text-primary">{localGuide.title}</div>
                                        <div className="font-mono">{localGuide.command}</div>
                                        <div className="text-text-tertiary">{localGuide.tip}</div>
                                      </div>
                                    )}

                                    <PasswordInput
                                      value={source.apiKey}
                                      onChange={(e) => {
                                        updateAiSource(source.id, (prev) => ({ ...prev, apiKey: e.target.value }));
                                        setActiveAiSourceId(source.id);
                                      }}
                                      placeholder={allowEmptyKey ? '本地源可留空' : 'API Key'}
                                      className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                    />
                                  </>
                                )}

                                {(isOfficialSource && !isOfficialSourceLoggedIn) ? (
                                  <div className="rounded border border-dashed border-border px-2.5 py-2 text-[11px] text-text-tertiary">
                                    {isOfficialSourcePending
                                      ? '正在等待官方账号状态检查完成。'
                                      : '请先重新登录，登录后会自动同步官方模型列表。'}
                                  </div>
                                ) : (
                                  <div className="rounded border border-border bg-surface-secondary/20 p-2.5 space-y-2">
                                    <div className="flex items-center justify-between">
                                      <button
                                        type="button"
                                        onClick={() => handleToggleAiSourceModelExpand(source.id)}
                                        className="flex items-center gap-2 text-xs font-medium text-text-primary"
                                      >
                                        <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', !isModelListExpanded && '-rotate-90')} />
                                        已添加模型
                                      </button>
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => openAddModelModal(source)}
                                          className="px-2 py-1 text-[11px] border border-border rounded hover:bg-surface-secondary transition-colors"
                                        >
                                          添加模型
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveAiSourceId(source.id);
                                            void fetchModelsForSource(source, { manual: true });
                                          }}
                                          disabled={Boolean(fetchingModelsBySourceId[source.id])}
                                          className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                        >
                                          <RefreshCw className={clsx('w-3 h-3', fetchingModelsBySourceId[source.id] && 'animate-spin')} />
                                          拉取候选
                                        </button>
                                      </div>
                                    </div>

                                    {isModelListExpanded && (
                                      sourceModelsForDisplay.length ? (
                                      <div className="space-y-1">
                                        {sourceModelsForDisplay.map((model) => {
                                          const isDefaultModel = source.model === model.id;
                                          return (
                                            <div key={model.id} className="flex items-center justify-between gap-2 rounded border border-border bg-surface-primary px-2.5 py-1.5">
                                              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                                                <button
                                                  type="button"
                                                  onClick={() => handleSetSourceDefaultModel(source.id, model.id)}
                                                  className={clsx(
                                                    'text-[10px] px-1.5 py-0.5 rounded border',
                                                    isDefaultModel
                                                      ? 'border-amber-500/40 text-amber-600 bg-amber-500/10'
                                                      : 'border-border text-text-tertiary hover:text-text-primary'
                                                  )}
                                                >
                                                  默认
                                                </button>
                                                <span className="text-xs text-text-primary truncate">{model.id}</span>
                                                {buildModelCapabilityBadges(model.capabilities).map((badge) => (
                                                  <span
                                                    key={`${model.id}-${badge.text}`}
                                                    className={clsx(
                                                      'px-1.5 py-0.5 rounded text-[10px] leading-none whitespace-nowrap font-medium',
                                                      badge.className || 'text-text-tertiary'
                                                    )}
                                                  >
                                                    {badge.text}
                                                  </span>
                                                ))}
                                                <span className="ml-0.5 flex items-center gap-1">
                                                  {buildModelInputIcons(model.inputCapabilities).map((icon) => {
                                                    const Icon = icon.icon;
                                                    return (
                                                      <span
                                                        key={`${model.id}-${icon.key}`}
                                                        title={icon.label}
                                                        className={clsx('inline-flex h-5 w-5 items-center justify-center rounded-full', icon.className)}
                                                      >
                                                        <Icon className="h-3.5 w-3.5" strokeWidth={2.1} />
                                                      </span>
                                                    );
                                                  })}
                                                </span>
                                              </div>
                                              <button
                                                type="button"
                                                onClick={() => handleRemoveSourceModel(source.id, model.id)}
                                                className="p-1 text-text-tertiary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                                title="删除模型"
                                              >
                                                <Trash2 className="w-3 h-3" />
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <div className="text-[11px] text-text-tertiary rounded border border-dashed border-border px-2.5 py-2">
                                        暂无已添加模型，请先点击“添加模型”。
                                      </div>
                                      )
                                    )}
                                  </div>
                                )}

                                {activeAiSourceId === source.id && (
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] text-text-tertiary">
                                      当前协议: <span className="font-mono">{detectedAiProtocol}</span>
                                    </span>
                                    <span
                                      className={clsx(
                                        'text-[11px]',
                                        testStatus === 'success' && 'text-status-success',
                                        testStatus === 'error' && 'text-status-error',
                                        testStatus === 'idle' && 'text-text-tertiary'
                                      )}
                                    >
                                      {testMsg || '等待操作'}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-surface-secondary/20 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-text-primary">转录模型设置</h3>
                      <span className="text-[11px] text-text-tertiary">选择已保存的 AI 源与模型</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="group">
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                          转录 AI 源
                        </label>
                        <AiSourceSelect
                          value={transcriptionSourceId}
                          sources={aiSources}
                          onChange={(nextSourceId) => handleLinkedSourceChange('transcription', nextSourceId)}
                          className="w-full"
                        />
                      </div>
                      <div className="group">
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                          转录模型
                        </label>
                        <AiModelSelect
                          value={formData.transcription_model}
                          onChange={(modelId) => setFormData((d) => ({ ...d, transcription_model: modelId }))}
                          options={transcriptionSourceModels.map((model) => {
                            const isRecommended = String(model.id).trim().toLowerCase() === 'step-asr';
                            return {
                              id: model.id,
                              label: model.id,
                              badges: buildModelCapabilityBadges(model.capabilities, { recommended: isRecommended }),
                              inputIcons: buildModelInputIcons(model.inputCapabilities),
                            };
                          })}
                          disabled={!transcriptionSourceModels.length}
                          placeholder="请先在该源中添加模型"
                          className="w-full"
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-text-tertiary">
                      转录会自动复用所选 AI 源的 Endpoint 与 API Key。
                    </p>
                  </div>

                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-text-primary mb-4">Embedding 模型设置</h3>

                    <div className="rounded-xl border border-border bg-surface-secondary/20 p-3 space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="group">
                          <label className="block text-xs font-medium text-text-secondary mb-1.5">
                            Embedding AI 源
                          </label>
                          <AiSourceSelect
                            value={embeddingSourceId}
                            sources={aiSources}
                            onChange={(nextSourceId) => handleLinkedSourceChange('embedding', nextSourceId)}
                            className="w-full"
                          />
                        </div>
                        <div className="group">
                          <label className="block text-xs font-medium text-text-secondary mb-1.5">
                            Embedding 模型
                          </label>
                          <AiModelSelect
                            value={formData.embedding_model}
                            onChange={(modelId) => setFormData((d) => ({ ...d, embedding_model: modelId }))}
                            className="w-full"
                            disabled={!embeddingSourceModels.length}
                            placeholder="请先在该源中添加模型"
                            options={embeddingSourceModels.map((model) => ({
                              id: model.id,
                              label: model.id,
                              badges: buildModelCapabilityBadges(model.capabilities),
                              inputIcons: buildModelInputIcons(model.inputCapabilities),
                            }))}
                          />
                        </div>
                      </div>
                      <p className="text-[11px] text-text-tertiary">
                        Embedding 会自动复用所选 AI 源的 Endpoint 与 API Key。
                      </p>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-text-primary mb-4">生图模型设置</h3>

                    <div className="space-y-4">
                      <div className="rounded-xl border border-border bg-surface-secondary/20 p-3 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="group">
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">
                              生图 AI 源
                            </label>
                            <AiSourceSelect
                              value={imageSourceId}
                              sources={aiSources}
                              onChange={(nextSourceId) => handleLinkedSourceChange('image', nextSourceId)}
                              className="w-full"
                            />
                          </div>
                          <div className="group">
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">
                              生图模型
                            </label>
                            <AiModelSelect
                              value={formData.image_model}
                              onChange={(modelId) => setFormData((d) => ({ ...d, image_model: modelId }))}
                              className="w-full"
                              disabled={isDashscopeImageTemplate || !imageSourceModels.length}
                              placeholder={isDashscopeImageTemplate ? DASHSCOPE_LOCKED_IMAGE_MODEL : '请先在该源中添加模型'}
                              options={isDashscopeImageTemplate
                                ? [{ id: DASHSCOPE_LOCKED_IMAGE_MODEL, label: DASHSCOPE_LOCKED_IMAGE_MODEL }]
                                : imageSourceModels.map((model) => ({
                                  id: model.id,
                                  label: model.id,
                                  badges: buildModelCapabilityBadges(model.capabilities),
                                  inputIcons: buildModelInputIcons(model.inputCapabilities),
                                }))}
                            />
                          </div>
                        </div>
                        <p className="text-[11px] text-text-tertiary">
                          生图会自动复用所选 AI 源的 Endpoint 与 API Key；模型的增删请到上方对应源卡片中管理。
                        </p>
                      </div>

                    </div>
                  </div>

                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-text-primary mb-4">生视频模型设置</h3>

                    <div className="rounded-xl border border-border bg-surface-secondary/20 p-3 space-y-3">
                      <div className="rounded-lg border border-border bg-surface-primary/70 p-3 text-xs text-text-secondary">
                        由于各家视频api差异巨大，AI智能选择效果不佳，暂时仅支持RedBox官方源，其他厂商模型适配陆续开发中。
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="rounded-lg border border-border bg-surface-primary/70 p-3">
                          <div className="text-[11px] text-text-tertiary mb-1">文生视频</div>
                          <div className="text-sm font-medium text-text-primary">{REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video']}</div>
                        </div>
                        <div className="rounded-lg border border-border bg-surface-primary/70 p-3">
                          <div className="text-[11px] text-text-tertiary mb-1">参考图视频</div>
                          <div className="text-sm font-medium text-text-primary">{REDBOX_OFFICIAL_VIDEO_MODELS['reference-guided']}</div>
                        </div>
                        <div className="rounded-lg border border-border bg-surface-primary/70 p-3">
                          <div className="text-[11px] text-text-tertiary mb-1">图片/首尾帧视频</div>
                          <div className="text-sm font-medium text-text-primary">{REDBOX_OFFICIAL_VIDEO_MODELS['first-last-frame']}</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-text-primary mb-4">聊天输出上限（max_tokens）</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="group">
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                          通用模型 max_tokens
                        </label>
                        <input
                          type="number"
                          min={MIN_CHAT_MAX_TOKENS}
                          step={1}
                          value={formData.chat_max_tokens_default}
                          onChange={e => setFormData(d => ({ ...d, chat_max_tokens_default: e.target.value }))}
                          onBlur={e => setFormData(d => ({
                            ...d,
                            chat_max_tokens_default: sanitizeChatMaxTokensInput(e.target.value, DEFAULT_CHAT_MAX_TOKENS),
                          }))}
                          className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        />
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          默认 262144，最低 1024。用于除 DeepSeek 外的 OpenAI 兼容模型。
                        </p>
                      </div>

                      <div className="group">
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                          DeepSeek max_tokens
                        </label>
                        <input
                          type="number"
                          min={MIN_CHAT_MAX_TOKENS}
                          step={1}
                          value={formData.chat_max_tokens_deepseek}
                          onChange={e => setFormData(d => ({ ...d, chat_max_tokens_deepseek: e.target.value }))}
                          onBlur={e => setFormData(d => ({
                            ...d,
                            chat_max_tokens_deepseek: sanitizeChatMaxTokensInput(e.target.value, DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK),
                          }))}
                          className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        />
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          默认 131072，最低 1024。若服务端报 max_tokens 越界，可在此下调。
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-text-primary mb-4">RedClaw 上下文压缩策略</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="group">
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                          自动压缩阈值（tokens）
                        </label>
                        <input
                          type="number"
                          min={16000}
                          step={1000}
                          value={formData.redclaw_compact_target_tokens}
                          onChange={e => setFormData(d => ({ ...d, redclaw_compact_target_tokens: e.target.value }))}
                          className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        />
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          默认 256000。RedClaw 对话预计上下文超过该值时会自动 compact。
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-text-primary mb-4">漫步模式</h3>
                    <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-medium text-text-primary">多选题模式</h4>
                          <p className="text-xs text-text-tertiary mt-1.5 leading-relaxed">
                            漫步默认使用 Agent Runtime。关闭时每次生成 1 个方向；开启后每次基于同样素材一次性生成 3 个方向供选择。
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setFormData((d) => ({ ...d, wander_deep_think_enabled: !d.wander_deep_think_enabled }))}
                          className="ui-switch-track shrink-0 mt-0.5"
                          data-size="md"
                          data-state={formData.wander_deep_think_enabled ? 'on' : 'off'}
                        >
                          <div className="ui-switch-thumb" />
                        </button>
                      </div>
                    </div>
                  </div>
                  </>
                  )}
                  {officialAiPanelEnabled && (
                    <div className={aiModelSubTab === 'login' ? 'space-y-4' : 'hidden'} aria-hidden={aiModelSubTab !== 'login'}>
                      {OfficialAiPanelComponent ? (
                        <OfficialAiPanelComponent onReloadSettings={reloadCustomAiSettings} />
                      ) : (
                        <div className="rounded-xl border border-border bg-surface-secondary/20 p-4 text-sm text-text-tertiary">
                          正在加载登录面板...
                        </div>
                      )}
                    </div>
                  )}
                  </>

                </section>
              </div>
            )}

            {/* Profile Tab */}
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <h2 className="text-lg font-medium text-text-primary">用户创作档案</h2>
                        <button
                          type="button"
                          onClick={() => onOpenRedClawOnboarding?.()}
                          className="text-xs font-medium text-text-tertiary underline-offset-4 transition-colors hover:text-text-primary hover:underline"
                        >
                          {redclawOnboardingCompleted ? '重新自定义风格' : '去定义风格'}
                        </button>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                        <span
                          className="rounded-full bg-surface-secondary px-2 py-1 font-mono"
                          title={redclawProfileRoot || undefined}
                        >
                          空间：{currentSpaceId}
                        </span>
                        <span className={clsx(
                          'rounded-full px-2 py-1',
                          redclawProfileDirty
                            ? 'bg-amber-500/10 text-amber-600'
                            : 'bg-emerald-500/10 text-emerald-600'
                        )}>
                          {redclawProfileDirty ? '未保存' : '已同步'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void loadRedclawProfileBundle()}
                        disabled={isRedclawProfileLoading}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-surface-secondary disabled:opacity-50"
                      >
                        <RefreshCw className={clsx('h-3.5 w-3.5', isRedclawProfileLoading && 'animate-spin')} />
                        {isRedclawProfileLoading ? '刷新中' : '刷新'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRedclawProfileDraft(savedRedclawProfileDraft);
                          setRedclawProfileDirtyState(false);
                          setRedclawProfileMessage(null);
                          setStatus('idle');
                        }}
                        disabled={!redclawProfileDirty}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-surface-secondary disabled:opacity-50"
                      >
                        还原
                      </button>
                    </div>
                  </div>

                  {redclawProfileMessage && (
                    <div className={clsx(
                      'rounded-xl border px-4 py-3 text-sm',
                      redclawProfileMessage.tone === 'error'
                        ? 'border-red-500/25 bg-red-500/5 text-red-600'
                        : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-600'
                    )}>
                      {redclawProfileMessage.text}
                    </div>
                  )}
                </section>

                <section className="space-y-4">
                  <div className="rounded-xl border border-border bg-surface-secondary/20 p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-primary">用户画像</h3>
                      <p className="mt-1 text-xs leading-6 text-text-tertiary">
                        对应 `user.md`。适合记录称呼、长期目标、目标用户、内容赛道、风格偏好和发布节奏。
                      </p>
                    </div>
                    <textarea
                      value={redclawProfileDraft.user}
                      onChange={(event) => handleRedclawProfileDraftChange('user', event.target.value)}
                      placeholder="# user.md"
                      spellCheck={false}
                      className="min-h-[280px] w-full rounded-lg border border-border bg-surface-primary px-4 py-3 font-mono text-sm leading-6 text-text-primary focus:border-accent-primary focus:outline-none"
                    />
                  </div>

                  <div className="rounded-xl border border-border bg-surface-secondary/20 p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-primary">创作档案</h3>
                      <p className="mt-1 text-xs leading-6 text-text-tertiary">
                        对应 `CreatorProfile.md`。适合记录内容定位、受众痛点、视觉风格、运营策略、商业目标和长期边界。
                      </p>
                    </div>
                    <textarea
                      value={redclawProfileDraft.creatorProfile}
                      onChange={(event) => handleRedclawProfileDraftChange('creatorProfile', event.target.value)}
                      placeholder="# CreatorProfile.md"
                      spellCheck={false}
                      className="min-h-[360px] w-full rounded-lg border border-border bg-surface-primary px-4 py-3 font-mono text-sm leading-6 text-text-primary focus:border-accent-primary focus:outline-none"
                    />
                  </div>
                </section>
              </div>
            )}

            {/* Tools Tab */}
            {activeTab === 'tools' && (
              <ToolsSettingsSection
                cliRuntimeTools={cliRuntimeTools}
                cliRuntimeEnvironments={cliRuntimeEnvironments}
                cliRuntimeInstallDraft={cliRuntimeInstallDraft}
                setCliRuntimeInstallDraft={setCliRuntimeInstallDraft}
                cliRuntimeInstallQueue={cliRuntimeInstallQueue}
                cliRuntimeStatusMessage={cliRuntimeStatusMessage}
                isCliRuntimeRefreshing={isCliRuntimeRefreshing}
                cliRuntimeInstalling={cliRuntimeInstalling}
                cliRuntimeInspectingToolId={cliRuntimeInspectingToolId}
                cliRuntimeDiagnosticCommand={cliRuntimeDiagnosticCommand}
                setCliRuntimeDiagnosticCommand={setCliRuntimeDiagnosticCommand}
                cliRuntimeDiscoverQuery={cliRuntimeDiscoverQuery}
                setCliRuntimeDiscoverQuery={setCliRuntimeDiscoverQuery}
                cliRuntimeDiscoverResults={cliRuntimeDiscoverResults}
                cliRuntimeDiscovering={cliRuntimeDiscovering}
                cliRuntimeCreatingEnvironment={cliRuntimeCreatingEnvironment}
                handleRefreshCliRuntime={loadCliRuntimeDashboard}
                handleInspectCliRuntimeTool={handleInspectCliRuntimeTool}
                handleDiagnoseCliRuntimeCommand={handleDiagnoseCliRuntimeCommand}
                handleDiscoverCliRuntimeTools={handleDiscoverCliRuntimeTools}
                handleCreateCliRuntimeEnvironment={handleCreateCliRuntimeEnvironment}
                handleInstallCliRuntimeTool={handleInstallCliRuntimeTool}
                handleOpenCliRuntimeEnvironmentRoot={handleOpenCliRuntimeEnvironmentRoot}
                isSyncingMcp={isSyncingMcp}
                handleDiscoverAndImportMcp={handleDiscoverAndImportMcp}
                handleAddMcpServer={handleAddMcpServer}
                handleSaveMcpServers={handleSaveMcpServers}
                mcpStatusMessage={mcpStatusMessage}
                mcpServers={mcpServers}
                mcpRuntimeItems={mcpRuntimeItems}
                mcpLiveSessions={mcpLiveSessions}
                handleUpdateMcpServer={handleUpdateMcpServer}
                handleDeleteMcpServer={handleDeleteMcpServer}
                handleDisconnectMcpServer={handleDisconnectMcpServer}
                handleDisconnectAllMcpSessions={handleDisconnectAllMcpSessions}
                stringifyEnvRecord={stringifyEnvRecord}
                parseEnvText={parseEnvText}
                mcpOauthState={mcpOauthState}
                handleRefreshMcpOAuth={handleRefreshMcpOAuth}
                handleTestMcpServer={handleTestMcpServer}
                mcpTestingId={mcpTestingId}
                mcpInspectingId={mcpInspectingId}
                ytdlpStatus={ytdlpStatus}
                handleInstallYtdlp={handleInstallYtdlp}
                handleUpdateYtdlp={handleUpdateYtdlp}
                browserPluginStatus={browserPluginStatus}
                isPreparingBrowserPlugin={isPreparingBrowserPlugin}
                handlePrepareBrowserPlugin={handlePrepareBrowserPlugin}
                handleOpenBrowserPluginDir={handleOpenBrowserPluginDir}
                isInstallingTool={isInstallingTool}
                installProgress={installProgress}
                showDeveloperDiagnostics={Boolean(formData.developer_mode_enabled)}
                toolDiagnostics={toolDiagnostics}
                toolDiagnosticResults={toolDiagnosticResults}
                toolDiagnosticRunning={toolDiagnosticRunning}
                handleRunDirectToolDiagnostic={(toolName) => runToolDiagnostic(toolName, 'direct')}
                handleRunAiToolDiagnostic={(toolName) => runToolDiagnostic(toolName, 'ai')}
                handleRefreshToolDiagnostics={loadToolDiagnostics}
                handleRunAllDirectToolDiagnostics={() => runAllToolDiagnostics('direct')}
                handleRunAllAiToolDiagnostics={() => runAllToolDiagnostics('ai')}
                runtimePerfPresets={RUNTIME_PERF_PRESETS}
                runtimePerfMode={runtimePerfMode}
                setRuntimePerfMode={setRuntimePerfMode}
                runtimePerfPresetId={runtimePerfPresetId}
                setRuntimePerfPresetId={setRuntimePerfPresetId}
                runtimePerfMessage={runtimePerfMessage}
                setRuntimePerfMessage={setRuntimePerfMessage}
                runtimePerfIterations={runtimePerfIterations}
                setRuntimePerfIterations={setRuntimePerfIterations}
                runtimePerfResults={runtimePerfResults}
                activeRuntimePerfRunId={activeRuntimePerfRunId}
                isRuntimePerfRunning={isRuntimePerfRunning}
                runtimePerfStatusMessage={runtimePerfStatusMessage}
                handleApplyRuntimePerfPreset={handleApplyRuntimePerfPreset}
                handleRunRuntimePerfBenchmark={handleRunRuntimePerfBenchmark}
                handleClearRuntimePerfResults={handleClearRuntimePerfResults}
                runtimeTasks={runtimeTasks}
                runtimeRoles={runtimeRoles}
                runtimeDiagnosticsSummary={runtimeDiagnosticsSummary}
                runtimeSessions={runtimeSessions}
                backgroundTasks={backgroundTasks}
                backgroundWorkerPool={backgroundWorkerPool}
                selectedRuntimeTaskId={selectedRuntimeTaskId}
                setSelectedRuntimeTaskId={setSelectedRuntimeTaskId}
                selectedRuntimeSessionId={selectedRuntimeSessionId}
                setSelectedRuntimeSessionId={setSelectedRuntimeSessionId}
                selectedBackgroundTaskId={selectedBackgroundTaskId}
                setSelectedBackgroundTaskId={setSelectedBackgroundTaskId}
                selectedBackgroundTask={selectedBackgroundTaskDetail}
                runtimeTaskTraces={runtimeTaskTraces}
                runtimeSessionTranscript={runtimeSessionTranscript}
                runtimeSessionCheckpoints={runtimeSessionCheckpoints}
                runtimeSessionToolResults={runtimeSessionToolResults}
                runtimeHooks={runtimeHooks}
                runtimeDraftInput={runtimeDraftInput}
                setRuntimeDraftInput={setRuntimeDraftInput}
                runtimeDraftMode={runtimeDraftMode}
                setRuntimeDraftMode={setRuntimeDraftMode}
                isRuntimeLoading={isRuntimeLoading}
                isRuntimeTraceLoading={isRuntimeTraceLoading}
                isRuntimeSessionLoading={isRuntimeSessionLoading}
                isBackgroundTasksLoading={isBackgroundTasksLoading}
                isRuntimeCreating={isRuntimeCreating}
                runtimeTaskActionRunning={runtimeTaskActionRunning}
                backgroundTaskActionRunning={backgroundTaskActionRunning}
                handleRefreshRuntimeData={loadRuntimeDeveloperData}
                handleCreateRuntimeTask={handleCreateRuntimeTask}
                handleResumeRuntimeTask={handleResumeRuntimeTask}
                handleCancelRuntimeTask={handleCancelRuntimeTask}
                handleCancelBackgroundTask={handleCancelBackgroundTask}
              />
            )}

            {/* Global Save Actions (Visible on all tabs usually, but maybe better inside the form only if relevant) */}
            {/* Actually, it's safer to keep the save button available for settings that need saving (General, AI). Tools operations are immediate. */}
            <SettingsSaveBar
              activeTab={activeTab}
              status={status}
            />
          </form>
          {isCreateAiSourceModalOpen && (
            <div
              className="fixed inset-0 z-[140] bg-black/45 flex items-center justify-center px-6 py-6"
              onMouseDown={closeCreateAiSourceModal}
            >
              <div
                className="w-full max-w-2xl rounded-2xl border border-border bg-surface-primary shadow-2xl"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-text-primary truncate">新建模型源</h3>
                    <p className="text-xs text-text-tertiary mt-1 truncate">
                      先创建模型源，再在该源下添加常用模型
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeCreateAiSourceModal}
                    className="px-2.5 py-1 text-xs border border-border rounded hover:bg-surface-secondary transition-colors"
                  >
                    关闭
                  </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-medium text-text-secondary">平台预设</label>
                      <AiPresetSelect
                        value={createAiSourceDraft.presetId}
                        groups={groupedAiPresets}
                        onChange={(nextPresetId) => {
                          const previousPreset = findAiPresetById(createAiSourceDraft.presetId);
                          const nextPreset = findAiPresetById(nextPresetId);
                          const shouldSyncBaseURL = !createAiSourceDraft.baseURL
                            || (previousPreset?.baseURL && createAiSourceDraft.baseURL === previousPreset.baseURL);
                          const shouldSyncName = !createAiSourceDraft.name
                            || createAiSourceDraft.name === previousPreset?.label;
                          setCreateAiSourceDraft((prev) => ({
                            ...prev,
                            presetId: nextPresetId,
                            baseURL: shouldSyncBaseURL ? (nextPreset?.baseURL || '') : prev.baseURL,
                            name: shouldSyncName ? (nextPreset?.label || prev.name) : prev.name,
                            protocol: nextPreset?.protocol || prev.protocol || 'openai',
                          }));
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-medium text-text-secondary">来源名称</label>
                      <input
                        type="text"
                        value={createAiSourceDraft.name}
                        onChange={(e) => setCreateAiSourceDraft((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder="例如：DashScope (Qwen)"
                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        autoFocus
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-medium text-text-secondary">协议类型</label>
                      <AiModelSelect
                        value={createAiSourceDraft.protocol}
                        onChange={(value) => setCreateAiSourceDraft((prev) => ({ ...prev, protocol: value as AiProtocol }))}
                        className="w-full"
                        options={[
                          { id: 'openai', label: 'OpenAI Compatible' },
                          { id: 'anthropic', label: 'Anthropic Native' },
                          { id: 'gemini', label: 'Gemini Native' },
                        ]}
                      />
                    </div>
                    <label className="inline-flex items-center gap-2 text-sm text-text-secondary mt-6">
                      <input
                        type="checkbox"
                        checked={createAiSourceDraft.setAsDefault}
                        onChange={(e) => setCreateAiSourceDraft((prev) => ({ ...prev, setAsDefault: e.target.checked }))}
                      />
                      创建后设为默认聊天源
                    </label>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-text-secondary">API Endpoint (Base URL)</label>
                    <input
                      type="text"
                      value={createAiSourceDraft.baseURL}
                      onChange={(e) => setCreateAiSourceDraft((prev) => ({ ...prev, baseURL: e.target.value }))}
                      placeholder="https://api.openai.com/v1"
                      className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-text-secondary">API Key</label>
                    <PasswordInput
                      value={createAiSourceDraft.apiKey}
                      onChange={(e) => setCreateAiSourceDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
                      placeholder="可先留空，后续再补充"
                      className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                    />
                  </div>
                </div>

                <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeCreateAiSourceModal}
                    className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-secondary transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateAiSource}
                    className="px-3 py-1.5 text-xs bg-text-primary text-background rounded hover:opacity-90 transition-opacity"
                  >
                    创建模型源
                  </button>
                </div>
              </div>
            </div>
          )}

          {addModelModalSource && (
            <div
              className="fixed inset-0 z-[140] bg-black/45 flex items-center justify-center px-6 py-6"
              onMouseDown={closeAddModelModal}
            >
              <div
                className="w-full max-w-xl rounded-2xl border border-border bg-surface-primary shadow-2xl"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-text-primary truncate">添加模型</h3>
                    <p className="text-xs text-text-tertiary mt-1 truncate">
                      {addModelModalSource.name || '未命名模型源'} · 候选模型 {addModelModalRemoteModels.length} 个，可手动输入模型 ID
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeAddModelModal}
                    className="px-2.5 py-1 text-xs border border-border rounded hover:bg-surface-secondary transition-colors"
                  >
                    关闭
                  </button>
                </div>

                <div className="px-5 py-4 space-y-3">
                  <div className="text-[12px] text-text-tertiary">
                    候选列表仅用于辅助选择；也可以直接手动输入模型 ID，点击确认后才会加入当前模型源。
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr),160px,auto] gap-2">
                    <input
                      type="text"
                      list={`ai-source-model-options-${addModelModalSource.id}`}
                      value={addModelModalDraft}
                      onChange={(e) => setSourceModelDrafts((prev) => ({ ...prev, [addModelModalSource.id]: e.target.value }))}
                      placeholder="输入或选择模型ID"
                      className="flex-1 bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                      autoFocus
                    />
                    <datalist id={`ai-source-model-options-${addModelModalSource.id}`}>
                      {addModelModalRemoteModels.map((item) => (
                        <option key={item.id} value={item.id} />
                      ))}
                    </datalist>
                    <select
                      value={addModelModalCapability}
                      onChange={(e) => setSourceModelCapabilityDrafts((prev) => ({
                        ...prev,
                        [addModelModalSource.id]: e.target.value as ModelCapability,
                      }))}
                      className="bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                    >
                      <option value="chat">语言模型</option>
                      <option value="transcription">转录模型</option>
                      <option value="audio">音频生成</option>
                      <option value="image">图片生成</option>
                      <option value="video">视频生成</option>
                      <option value="embedding">向量模型</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveAiSourceId(addModelModalSource.id);
                        void fetchModelsForSource(addModelModalSource, { manual: true });
                      }}
                      disabled={Boolean(fetchingModelsBySourceId[addModelModalSource.id])}
                      className="px-3 py-2 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                    >
                      {fetchingModelsBySourceId[addModelModalSource.id] ? '拉取中...' : '刷新候选'}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-auto rounded border border-border bg-surface-secondary/20 p-2">
                    {addModelModalRemoteModels.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {addModelModalRemoteModels.slice(0, 80).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setSourceModelDrafts((prev) => ({ ...prev, [addModelModalSource.id]: item.id }));
                              setSourceModelCapabilityDrafts((prev) => ({
                                ...prev,
                                [addModelModalSource.id]: item.capabilities[0] || 'chat',
                              }));
                            }}
                            className="px-2 py-1 text-[11px] rounded border border-border hover:bg-surface-secondary transition-colors flex items-center gap-1.5"
                          >
                            <span>{item.id}</span>
                            {buildModelCapabilityBadges(item.capabilities).map((badge) => (
                              <span
                                key={`${item.id}-${badge.text}`}
                                className={clsx(
                                  'px-1 py-0.5 rounded text-[10px] leading-none whitespace-nowrap font-medium',
                                  badge.className || 'text-text-tertiary'
                                )}
                              >
                                {badge.text}
                              </span>
                            ))}
                            <span className="ml-0.5 flex items-center gap-1">
                              {buildModelInputIcons(item.inputCapabilities).map((icon) => {
                                const Icon = icon.icon;
                                return (
                                  <span
                                    key={`${item.id}-${icon.key}`}
                                    title={icon.label}
                                    className={clsx('inline-flex h-4.5 w-4.5 items-center justify-center rounded-full', icon.className)}
                                  >
                                    <Icon className="h-3 w-3" strokeWidth={2.1} />
                                  </span>
                                );
                              })}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-text-tertiary">
                        暂无候选模型，可直接手动输入模型 ID，或点击“刷新候选”拉取。
                      </div>
                    )}
                  </div>
                </div>

                <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeAddModelModal}
                    className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-secondary transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAddSourceModel(addModelModalSource.id)}
                    disabled={!addModelModalDraftTrimmed}
                    className="px-3 py-1.5 text-xs bg-text-primary text-background rounded hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    确认添加
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
