import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SetStateAction } from 'react';
import { Save, RefreshCw, AlertCircle, FolderOpen, Wrench, Download, LayoutGrid, Cpu, Database, Trash2, Eye, EyeOff, FlaskConical, Info, Brain, Plus, Star, ChevronDown, Check } from 'lucide-react';
import clsx from 'clsx';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import {
  AI_SOURCE_PRESETS,
  type AiSourcePreset,
  type AiSourceConfig,
  DEFAULT_AI_PRESET_ID,
  findAiPresetById,
  inferPresetIdByEndpoint
} from '../config/aiSources';
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
  type MemoryHistoryEntry,
  type MemoryMaintenanceStatus,
  type MemorySearchResult,
  type McpServerConfig,
  type ToolDiagnosticDescriptor,
  type ToolDiagnosticRunResult,
  type UserMemory,
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
import {
  REDBOX_OFFICIAL_VIDEO_BASE_URL,
  REDBOX_OFFICIAL_VIDEO_MODEL_LIST,
  REDBOX_OFFICIAL_VIDEO_MODELS,
} from '../../shared/redboxVideo';
import { hasOfficialAiPanel, loadOfficialAiPanelModule, type OfficialAiPanelProps } from '../features/official';
import {
  ExperimentalSettingsSection,
  GeneralSettingsSection,
  KnowledgeSettingsSection,
  MemorySettingsSection,
  SettingsSaveBar,
  ToolsSettingsSection,
} from './settings/SettingsSections';

const MIN_CHAT_MAX_TOKENS = 1024;
const DEFAULT_CHAT_MAX_TOKENS = 262144;
const DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK = 131072;
const DEVELOPER_MODE_UNLOCK_TAP_COUNT = 7;
const DEVELOPER_MODE_TTL_MS = 24 * 60 * 60 * 1000;

type AssistantDaemonStatus = Awaited<ReturnType<typeof window.ipcRenderer.assistantDaemon.getStatus>>;

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
  enabled: false,
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

const sanitizeChatMaxTokensInput = (value: string, fallback: number): string => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_CHAT_MAX_TOKENS) {
    return String(fallback);
  }
  return String(Math.floor(parsed));
};

export function Settings() {
  const [activeTab, setActiveTab] = useState<'general' | 'ai' | 'knowledge' | 'tools' | 'memory' | 'experimental'>('ai');
  const { flags, updateFlag } = useFeatureFlags();
  const [formData, setFormData] = useState({
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
    image_quality: 'standard',
    model_name_wander: '',
    model_name_chatroom: '',
    model_name_knowledge: '',
    model_name_redclaw: '',
    search_provider: 'duckduckgo',
    search_endpoint: '',
    search_api_key: '',
    proxy_enabled: false,
    proxy_url: '',
    proxy_bypass: 'localhost,127.0.0.1,::1',
    redclaw_compact_target_tokens: '256000',
    chat_max_tokens_default: String(DEFAULT_CHAT_MAX_TOKENS),
    chat_max_tokens_deepseek: String(DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK),
    wander_deep_think_enabled: false,
    debug_log_enabled: false,
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
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [imageAvailableModels, setImageAvailableModels] = useState<Array<{ id: string; source: 'remote' | 'suggested' }>>([]);
  const [isFetchingImageModels, setIsFetchingImageModels] = useState(false);
  const [imageModelStatus, setImageModelStatus] = useState('');
  const [recentDebugLogs, setRecentDebugLogs] = useState<string[]>([]);
  const [isDebugLogsLoading, setIsDebugLogsLoading] = useState(false);
  const [toolDiagnostics, setToolDiagnostics] = useState<ToolDiagnosticDescriptor[]>([]);
  const [toolDiagnosticResults, setToolDiagnosticResults] = useState<Record<string, ToolDiagnosticRunResult | undefined>>({});
  const [toolDiagnosticRunning, setToolDiagnosticRunning] = useState<Record<string, 'direct' | 'ai' | undefined>>({});
  const [runtimeTasks, setRuntimeTasks] = useState<AgentTaskSnapshot[]>([]);
  const [runtimeRoles, setRuntimeRoles] = useState<RoleSpec[]>([]);
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
  const [runtimeDraftInput, setRuntimeDraftInput] = useState('');
  const [runtimeDraftMode, setRuntimeDraftMode] = useState<'redclaw' | 'knowledge' | 'chatroom' | 'advisor-discussion' | 'background-maintenance'>('redclaw');
  const [isRuntimeLoading, setIsRuntimeLoading] = useState(false);
  const [isRuntimeTraceLoading, setIsRuntimeTraceLoading] = useState(false);
  const [isRuntimeSessionLoading, setIsRuntimeSessionLoading] = useState(false);
  const [isBackgroundTasksLoading, setIsBackgroundTasksLoading] = useState(false);
  const [isRuntimeCreating, setIsRuntimeCreating] = useState(false);
  const [runtimeTaskActionRunning, setRuntimeTaskActionRunning] = useState<Record<string, 'resume' | 'cancel' | undefined>>({});
  const [backgroundTaskActionRunning, setBackgroundTaskActionRunning] = useState<Record<string, 'cancel' | undefined>>({});
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [assistantDaemonStatus, setAssistantDaemonStatus] = useState<AssistantDaemonStatus | null>(null);
  const [assistantDaemonDraft, setAssistantDaemonDraftState] = useState<AssistantDaemonDraft>(() => createDefaultAssistantDaemonDraft());
  const [assistantDaemonLogs, setAssistantDaemonLogs] = useState<string[]>([]);
  const [assistantDaemonBusy, setAssistantDaemonBusy] = useState(false);
  const [assistantDaemonDraftDirty, setAssistantDaemonDraftDirty] = useState(false);
  const [assistantDaemonWeixinLoginBusy, setAssistantDaemonWeixinLoginBusy] = useState(false);
  const [assistantDaemonWeixinLogin, setAssistantDaemonWeixinLogin] = useState<AssistantDaemonWeixinLoginState | null>(null);
  const [showScopedModelOverrides, setShowScopedModelOverrides] = useState(false);
  const [developerVersionTapCount, setDeveloperVersionTapCount] = useState(0);

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
  const fetchModelsRequestRef = useRef(0);
  const fetchImageModelsRequestRef = useRef(0);
  const assistantDaemonLogBufferRef = useRef<string[]>([]);
  const assistantDaemonLogFlushTimerRef = useRef<number | null>(null);

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
    if (presetId.includes('ark') || presetId.includes('jimeng')) {
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

  const defaultSourceModels = useMemo(() => {
    if (!defaultAiSource) return [];
    return filterAiModelsByCapability(getSourceModelList(defaultAiSource), 'chat');
  }, [defaultAiSource, getSourceModelList]);

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
    exported: boolean;
    bundledPath?: string;
    error?: string;
  } | null>(null);
  const [isPreparingBrowserPlugin, setIsPreparingBrowserPlugin] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpStatusMessage, setMcpStatusMessage] = useState('');
  const [isSyncingMcp, setIsSyncingMcp] = useState(false);
  const [mcpTestingId, setMcpTestingId] = useState('');
  const [mcpOauthState, setMcpOauthState] = useState<Record<string, { connected: boolean; tokenPath?: string }>>({});

  // Knowledge State
  const [vectorStats, setVectorStats] = useState<{ vectors: number; documents: number } | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  // Update State
  const [appVersion, setAppVersion] = useState('');

  // Memory State
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [archivedMemories, setArchivedMemories] = useState<UserMemory[]>([]);
  const [memoryHistory, setMemoryHistory] = useState<MemoryHistoryEntry[]>([]);
  const [memoryMaintenanceStatus, setMemoryMaintenanceStatus] = useState<MemoryMaintenanceStatus | null>(null);
  const [memorySearchQuery, setMemorySearchQuery] = useState('');
  const [includeArchivedInSearch, setIncludeArchivedInSearch] = useState(false);
  const [memorySearchResults, setMemorySearchResults] = useState<MemorySearchResult[]>([]);
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [newMemoryType, setNewMemoryType] = useState<'general' | 'preference' | 'fact'>('general');
  const [isMemoryLoading, setIsMemoryLoading] = useState(false);
  const [isMemorySearching, setIsMemorySearching] = useState(false);
  const [aiModelSubTab, setAiModelSubTab] = useState<'custom' | 'login'>('custom');
  const [officialAiPanelEnabled, setOfficialAiPanelEnabled] = useState(false);
  const [OfficialAiPanelComponent, setOfficialAiPanelComponent] = useState<ComponentType<OfficialAiPanelProps> | null>(null);

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
    let canceled = false;
    void loadOfficialAiPanelModule().then((module) => {
      if (canceled) return;
      const nextComponent = module?.default || null;
      setOfficialAiPanelEnabled(Boolean(nextComponent));
      setOfficialAiPanelComponent(() => nextComponent);
      if (!nextComponent) {
        setAiModelSubTab('custom');
      }
    });
    return () => {
      canceled = true;
    };
  }, []);

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
    loadSettings();
    checkTools();
    loadBrowserPluginStatus();
    loadAssistantDaemonStatus();
    loadVectorStats();
    loadAppVersion();

    const handleProgress = (_: unknown, progress: number) => {
      setInstallProgress(progress);
    };
    window.ipcRenderer.on('youtube:install-progress', handleProgress);
    return () => {
      window.ipcRenderer.off('youtube:install-progress', handleProgress);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'general') {
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
  }, [activeTab, assistantDaemonBusy, assistantDaemonDraftDirty]);

  useEffect(() => {
    let memoryPollTimer: number | null = null;
    let runtimePollTimer: number | null = null;
    let backgroundTaskPollTimer: number | null = null;
    if (activeTab === 'memory') {
      void loadMemories();
      memoryPollTimer = window.setInterval(() => {
        void loadMemories();
      }, 15000);
    }
    if (activeTab === 'general') {
      void loadRecentDebugLogs();
    }
    if (activeTab === 'tools' && formData.developer_mode_enabled) {
      void loadToolDiagnostics();
      void loadRuntimeDeveloperData();
      runtimePollTimer = window.setInterval(() => {
        void loadRuntimeTasks();
        void loadRuntimeSessions();
      }, 8000);
      backgroundTaskPollTimer = window.setInterval(() => {
        void loadBackgroundTasks();
      }, 5000);
    }

    return () => {
      if (memoryPollTimer) {
        window.clearInterval(memoryPollTimer);
      }
      if (runtimePollTimer) {
        window.clearInterval(runtimePollTimer);
      }
      if (backgroundTaskPollTimer) {
        window.clearInterval(backgroundTaskPollTimer);
      }
    };
  }, [activeTab, formData.developer_mode_enabled]);

  useEffect(() => {
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
    };
    window.ipcRenderer.on('background:task-updated', onBackgroundTaskUpdated);
    return () => {
      window.ipcRenderer.off('background:task-updated', onBackgroundTaskUpdated);
    };
  }, [activeTab, formData.developer_mode_enabled]);

  useEffect(() => {
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    void loadRuntimeTaskTraces(selectedRuntimeTaskId);
  }, [activeTab, formData.developer_mode_enabled, selectedRuntimeTaskId]);

  useEffect(() => {
    if (activeTab !== 'tools' || !formData.developer_mode_enabled) return;
    void loadRuntimeSessionDetails(selectedRuntimeSessionId);
  }, [activeTab, formData.developer_mode_enabled, selectedRuntimeSessionId]);

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
    if (activeTab !== 'tools') return;
    for (const server of mcpServers) {
      void handleRefreshMcpOAuth(server);
    }
  }, [activeTab, mcpServers]);

  useEffect(() => {
    if (!activeAiSource) return;
    let cancelled = false;
    const detect = async () => {
      try {
        const result = await window.ipcRenderer.detectAiProtocol({
          baseURL: activeAiSource.baseURL,
          presetId: activeAiSource.presetId,
          protocol: activeAiSource.protocol,
        });
        if (cancelled || !result?.success || !result.protocol) return;
        setDetectedAiProtocol(result.protocol);
        if (activeAiSource.protocol !== result.protocol) {
          updateAiSource(activeAiSource.id, (source) => ({ ...source, protocol: result.protocol }));
        }
      } catch {
        // ignore detect failures for live typing
      }
    };
    void detect();
    return () => {
      cancelled = true;
    };
  }, [activeAiSource?.id, activeAiSource?.baseURL, activeAiSource?.presetId]);

  useEffect(() => {
    return undefined;
  }, []);

  const updateAiSource = useCallback((sourceId: string, updater: (source: AiSourceConfig) => AiSourceConfig) => {
    setAiSources((prev) => prev.map((source) => (source.id === sourceId ? updater(source) : source)));
  }, []);

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
    if (!(modelsBySource[source.id] || []).length) {
      void fetchModelsForSource(source, { manual: true });
    }
  };

  const fetchModelsForSource = useCallback(async (
    source: AiSourceConfig,
    options?: { manual?: boolean }
  ) => {
    const baseURL = source.baseURL.trim();
    const apiKey = source.apiKey.trim();
    const allowEmptyKey = isLocalAiSource(source);
    if (!baseURL || (!apiKey && !allowEmptyKey)) {
      setModelsBySource((prev) => ({ ...prev, [source.id]: [] }));
      if (options?.manual) {
        setTestStatus('error');
        setTestMsg(allowEmptyKey ? '请先填写 Endpoint' : '请先填写 Endpoint 与 API Key');
      } else {
        setTestStatus('idle');
        setTestMsg('');
      }
      return;
    }

    const requestId = ++fetchModelsRequestRef.current;
    setIsTesting(true);
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
      if (requestId !== fetchModelsRequestRef.current) return;

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
      if (requestId !== fetchModelsRequestRef.current) return;

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
      if (requestId !== fetchModelsRequestRef.current) return;
      setModelsBySource((prev) => ({ ...prev, [source.id]: [] }));
      setTestStatus('error');
      const message = e instanceof Error ? e.message : '拉取模型列表失败';
      setTestMsg(message);
    } finally {
      if (requestId === fetchModelsRequestRef.current) {
        setIsTesting(false);
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
      return;
    }

    const timer = window.setTimeout(() => {
      void fetchModelsForSource(activeAiSource, { manual: false });
    }, 650);

    return () => window.clearTimeout(timer);
  }, [
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
  }, [isDashscopeImageTemplate]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchImageModels({ manual: false });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    formData.api_endpoint,
    formData.api_key,
    formData.image_api_key,
    formData.image_endpoint,
    formData.image_provider,
    formData.image_provider_template,
    fetchImageModels,
  ]);

  useEffect(() => {
    const nextSourceId = resolveLinkedSourceId({
      endpoint: formData.transcription_endpoint || formData.api_endpoint,
      apiKey: formData.transcription_key || formData.api_key,
      model: formData.transcription_model,
      fallbackId: defaultAiSourceId,
    });
    setTranscriptionSourceId((prev) => prev === nextSourceId ? prev : nextSourceId);
  }, [
    aiSources,
    defaultAiSourceId,
    formData.api_endpoint,
    formData.api_key,
    formData.transcription_endpoint,
    formData.transcription_key,
    formData.transcription_model,
    resolveLinkedSourceId,
  ]);

  useEffect(() => {
    const nextSourceId = resolveLinkedSourceId({
      endpoint: formData.embedding_endpoint || formData.api_endpoint,
      apiKey: formData.embedding_key || formData.api_key,
      model: formData.embedding_model,
      fallbackId: defaultAiSourceId,
    });
    setEmbeddingSourceId((prev) => prev === nextSourceId ? prev : nextSourceId);
  }, [
    aiSources,
    defaultAiSourceId,
    formData.api_endpoint,
    formData.api_key,
    formData.embedding_endpoint,
    formData.embedding_key,
    formData.embedding_model,
    resolveLinkedSourceId,
  ]);

  useEffect(() => {
    const nextSourceId = resolveLinkedSourceId({
      endpoint: formData.image_endpoint || formData.api_endpoint,
      apiKey: formData.image_api_key || formData.api_key,
      model: formData.image_model,
      fallbackId: defaultAiSourceId,
    });
    setImageSourceId((prev) => prev === nextSourceId ? prev : nextSourceId);
  }, [
    aiSources,
    defaultAiSourceId,
    formData.api_endpoint,
    formData.api_key,
    formData.image_endpoint,
    formData.image_api_key,
    formData.image_model,
    resolveLinkedSourceId,
  ]);

  const persistMcpServers = async (nextServers: McpServerConfig[], tip?: string) => {
    setIsSyncingMcp(true);
    try {
      const result = await window.ipcRenderer.mcp.save(nextServers);
      if (!result?.success) {
        setMcpStatusMessage(result?.error || 'MCP 配置保存失败');
        return false;
      }
      setMcpServers((result.servers || nextServers) as McpServerConfig[]);
      if (tip) setMcpStatusMessage(tip);
      return true;
    } catch (error) {
      console.error('Failed to persist MCP servers:', error);
      setMcpStatusMessage('MCP 配置保存失败');
      return false;
    } finally {
      setIsSyncingMcp(false);
    }
  };

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

  const handleDiscoverAndImportMcp = async () => {
    setIsSyncingMcp(true);
    try {
      const result = await window.ipcRenderer.mcp.importLocal();
      if (!result?.success) {
        setMcpStatusMessage(result?.error || '导入本机 MCP 配置失败');
        return;
      }
      setMcpServers((result.servers || []) as McpServerConfig[]);
      setMcpStatusMessage(`已导入 ${result.imported || 0} 个 MCP Server（共 ${result.total || 0} 个）`);
    } catch (error) {
      console.error('Failed to import local MCP configs:', error);
      setMcpStatusMessage('导入本机 MCP 配置失败');
    } finally {
      setIsSyncingMcp(false);
    }
  };

  const handleTestMcpServer = async (server: McpServerConfig) => {
    setMcpTestingId(server.id);
    try {
      const result = await window.ipcRenderer.mcp.test(server);
      setMcpStatusMessage(`${server.name}：${result.message}`);
    } catch (error) {
      console.error('Failed to test MCP server:', error);
      setMcpStatusMessage(`${server.name}：测试失败`);
    } finally {
      setMcpTestingId('');
    }
  };

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

  const loadMemories = async () => {
    setIsMemoryLoading(true);
    try {
      const [data, archived, history, maintenanceStatus] = await Promise.all([
        window.ipcRenderer.invoke('memory:list') as Promise<UserMemory[]>,
        window.ipcRenderer.invoke('memory:archived') as Promise<UserMemory[]>,
        window.ipcRenderer.invoke('memory:history') as Promise<MemoryHistoryEntry[]>,
        window.ipcRenderer.invoke('memory:maintenance-status') as Promise<MemoryMaintenanceStatus>,
      ]);
      setMemories(data);
      setArchivedMemories(archived);
      setMemoryHistory(history);
      setMemoryMaintenanceStatus(maintenanceStatus);
    } catch (e) {
      console.error("Failed to load memories", e);
    } finally {
      setIsMemoryLoading(false);
    }
  };

  const handleRunMemoryMaintenance = async () => {
    try {
      const status = await window.ipcRenderer.invoke('memory:maintenance-run') as MemoryMaintenanceStatus;
      setMemoryMaintenanceStatus(status);
      await loadMemories();
    } catch (e) {
      console.error('Failed to run memory maintenance', e);
    }
  };

  const handleSearchMemories = async () => {
    const query = memorySearchQuery.trim();
    if (!query) {
      setMemorySearchResults([]);
      return;
    }
    setIsMemorySearching(true);
    try {
      const results = await window.ipcRenderer.invoke('memory:search', {
        query,
        includeArchived: includeArchivedInSearch,
        limit: 20,
      }) as MemorySearchResult[];
      setMemorySearchResults(results);
    } catch (e) {
      console.error('Failed to search memories', e);
    } finally {
      setIsMemorySearching(false);
    }
  };

  const handleAddMemory = async () => {
    if (!newMemoryContent.trim()) return;

    try {
      await window.ipcRenderer.invoke('memory:add', {
        content: newMemoryContent,
        type: newMemoryType,
        tags: []
      });
      setNewMemoryContent('');
      loadMemories();
    } catch (e) {
      console.error("Failed to add memory", e);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    if (!confirm('确定要删除这条记忆吗？')) return;
    try {
      await window.ipcRenderer.invoke('memory:delete', id);
      loadMemories();
    } catch (e) {
      console.error("Failed to delete memory", e);
    }
  };

  const loadAppVersion = async () => {
    try {
      const version = await window.ipcRenderer.getAppVersion();
      setAppVersion(version || '');
    } catch (e) {
      console.error('Failed to load app version:', e);
    }
  };

  const loadRecentDebugLogs = async () => {
    setIsDebugLogsLoading(true);
    try {
      const result = await window.ipcRenderer.debug.getRecent(120);
      setRecentDebugLogs(Array.isArray(result?.lines) ? result.lines : []);
    } catch (e) {
      console.error('Failed to load debug logs', e);
      setRecentDebugLogs([]);
    } finally {
      setIsDebugLogsLoading(false);
    }
  };

  const openDebugLogDirectory = async () => {
    const result = await window.ipcRenderer.debug.openLogDir();
    if (!result?.success && result?.error) {
      alert(`打开日志目录失败：${result.error}`);
    }
  };

  const loadToolDiagnostics = async () => {
    try {
      const result = await window.ipcRenderer.toolDiagnostics.list();
      setToolDiagnostics(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error('Failed to load tool diagnostics', e);
      setToolDiagnostics([]);
    }
  };

  const loadRuntimeRoles = async () => {
    try {
      const result = await window.ipcRenderer.aiRoles.list();
      setRuntimeRoles(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error('Failed to load runtime roles', e);
      setRuntimeRoles([]);
    }
  };

  const loadRuntimeTasks = async (preserveSelection = true) => {
    setIsRuntimeLoading(true);
    try {
      const result = await window.ipcRenderer.tasks.list({ limit: 40 });
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
      setRuntimeTasks([]);
      if (!preserveSelection) {
        setSelectedRuntimeTaskId('');
      }
    } finally {
      setIsRuntimeLoading(false);
    }
  };

  const loadRuntimeSessions = async (preserveSelection = true) => {
    try {
      const result = await window.ipcRenderer.sessions.list();
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
      setRuntimeSessions([]);
      if (!preserveSelection) {
        setSelectedRuntimeSessionId('');
      }
    }
  };

  const loadRuntimeTaskTraces = async (taskId: string) => {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      setRuntimeTaskTraces([]);
      return;
    }
    setIsRuntimeTraceLoading(true);
    try {
      const result = await window.ipcRenderer.tasks.trace({ taskId: normalizedTaskId, limit: 120 });
      setRuntimeTaskTraces(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error('Failed to load runtime task traces', e);
      setRuntimeTaskTraces([]);
    } finally {
      setIsRuntimeTraceLoading(false);
    }
  };

  const loadRuntimeSessionDetails = async (sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      setRuntimeSessionTranscript([]);
      setRuntimeSessionCheckpoints([]);
      setRuntimeSessionToolResults([]);
      return;
    }
    setIsRuntimeSessionLoading(true);
    try {
      const [transcript, checkpoints, toolResults] = await Promise.all([
        window.ipcRenderer.sessions.getTranscript(normalizedSessionId, 120),
        window.ipcRenderer.runtime.getCheckpoints({ sessionId: normalizedSessionId, limit: 80 }),
        window.ipcRenderer.runtime.getToolResults({ sessionId: normalizedSessionId, limit: 120 }),
      ]);
      setRuntimeSessionTranscript(Array.isArray(transcript) ? transcript as RuntimeSessionTranscriptItem[] : []);
      setRuntimeSessionCheckpoints(Array.isArray(checkpoints) ? checkpoints as RuntimeSessionCheckpointItem[] : []);
      setRuntimeSessionToolResults(Array.isArray(toolResults) ? toolResults as RuntimeSessionToolResultItem[] : []);
    } catch (e) {
      console.error('Failed to load runtime session details', e);
      setRuntimeSessionTranscript([]);
      setRuntimeSessionCheckpoints([]);
      setRuntimeSessionToolResults([]);
    } finally {
      setIsRuntimeSessionLoading(false);
    }
  };

  const loadRuntimeHooks = async () => {
    try {
      const result = await window.ipcRenderer.toolHooks.list();
      setRuntimeHooks(Array.isArray(result) ? result as RuntimeHookDefinition[] : []);
    } catch (e) {
      console.error('Failed to load runtime hooks', e);
      setRuntimeHooks([]);
    }
  };

  const loadBackgroundTasks = async (preserveSelection = true) => {
    setIsBackgroundTasksLoading(true);
    try {
      const result = await window.ipcRenderer.backgroundTasks.list();
      const taskList = Array.isArray(result) ? result as BackgroundTaskItem[] : [];
      setBackgroundTasks(taskList);
      setSelectedBackgroundTaskId((prev) => {
        if (preserveSelection && prev && taskList.some((task) => task.id === prev)) {
          return prev;
        }
        return taskList[0]?.id || '';
      });
    } catch (e) {
      console.error('Failed to load background tasks', e);
      setBackgroundTasks([]);
      if (!preserveSelection) {
        setSelectedBackgroundTaskId('');
      }
    } finally {
      setIsBackgroundTasksLoading(false);
    }
  };

  const loadBackgroundWorkerPool = async () => {
    try {
      const result = await window.ipcRenderer.backgroundWorkers.getPoolState();
      setBackgroundWorkerPool({
        json: Array.isArray(result?.json) ? result.json : [],
        runtime: Array.isArray(result?.runtime) ? result.runtime : [],
      });
    } catch (e) {
      console.error('Failed to load background worker pool', e);
      setBackgroundWorkerPool({ json: [], runtime: [] });
    }
  };

  const loadRuntimeDeveloperData = async () => {
    await Promise.all([
      loadRuntimeRoles(),
      loadRuntimeTasks(),
      loadRuntimeSessions(),
      loadRuntimeHooks(),
      loadBackgroundTasks(),
      loadBackgroundWorkerPool(),
    ]);
  };

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
      window.alert('开发者模式已开启（24 小时内有效）');
      return 0;
    });
  }, [activeTab, persistDeveloperModeState]);

  const loadSettings = async () => {
    try {
      const settings = await window.ipcRenderer.getSettings();
      if (settings) {
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
        const unlockedAt = String(settings.developer_mode_unlocked_at || '').trim();
        const unlockedAtMs = unlockedAt ? Date.parse(unlockedAt) : NaN;
        const developerModeEnabled = Boolean(settings.developer_mode_enabled)
          && Number.isFinite(unlockedAtMs)
          && (Date.now() - unlockedAtMs) < DEVELOPER_MODE_TTL_MS;

        setAiSources(sourceList);
        setDefaultAiSourceId(normalizedDefaultId);
        setActiveAiSourceId(normalizedDefaultId);
        setModelsBySource({});
        setDetectedAiProtocol((resolvedDefaultSource?.protocol || findAiPresetById(resolvedDefaultSource?.presetId || '')?.protocol || 'openai') as AiProtocol);
        setMcpServers(parseMcpServers(settings.mcp_servers_json));

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
          image_quality: settings.image_quality || 'standard',
          model_name_wander: settings.model_name_wander || '',
          model_name_chatroom: settings.model_name_chatroom || '',
          model_name_knowledge: settings.model_name_knowledge || '',
          model_name_redclaw: settings.model_name_redclaw || '',
          search_provider: settings.search_provider || 'duckduckgo',
          search_endpoint: settings.search_endpoint || '',
          search_api_key: settings.search_api_key || '',
          proxy_enabled: Boolean(settings.proxy_enabled),
          proxy_url: settings.proxy_url || '',
          proxy_bypass: settings.proxy_bypass || 'localhost,127.0.0.1,::1',
          redclaw_compact_target_tokens: String(settings.redclaw_compact_target_tokens || 256000),
          chat_max_tokens_default: sanitizeChatMaxTokensInput(String(settings.chat_max_tokens_default || DEFAULT_CHAT_MAX_TOKENS), DEFAULT_CHAT_MAX_TOKENS),
          chat_max_tokens_deepseek: sanitizeChatMaxTokensInput(String(settings.chat_max_tokens_deepseek || DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK), DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK),
          wander_deep_think_enabled: Boolean(settings.wander_deep_think_enabled),
          debug_log_enabled: Boolean(settings.debug_log_enabled),
          developer_mode_enabled: developerModeEnabled,
          developer_mode_unlocked_at: developerModeEnabled ? unlockedAt : '',
        });

        if (Boolean(settings.developer_mode_enabled) && !developerModeEnabled) {
          void persistDeveloperModeState(false, null);
        }
      } else {
        setAiSources([]);
        setDefaultAiSourceId('redbox_official_auto');
        setActiveAiSourceId('redbox_official_auto');
        setModelsBySource({});
        setDetectedAiProtocol('openai');
        setMcpServers([]);
      }
    } catch (e) {
      console.error("Failed to load settings", e);
    }
  };

  const reloadCustomAiSettings = useCallback(async () => {
    await loadSettings();
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

  const checkTools = async () => {
    try {
      const status = await window.ipcRenderer.checkYtdlp();
      setYtdlpStatus(status);
    } catch (e) {
      console.error(e);
    }
  };

  const loadBrowserPluginStatus = async () => {
    try {
      const status = await window.ipcRenderer.browserPlugin.getStatus();
      setBrowserPluginStatus(status);
    } catch (error) {
      console.error('Failed to load browser plugin status', error);
      setBrowserPluginStatus({
        success: false,
        bundled: false,
        exportPath: '',
        exported: false,
        bundledPath: '',
        error: String(error),
      });
    }
  };

  const loadAssistantDaemonStatus = useCallback(async () => {
    try {
      const status = await window.ipcRenderer.assistantDaemon.getStatus();
      setAssistantDaemonStatus(status);
      replaceAssistantDaemonDraft(assistantDaemonStatusToDraft(status));
    } catch (error) {
      console.error('Failed to load assistant daemon status', error);
    }
  }, [replaceAssistantDaemonDraft]);

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
      window.alert(`保存后台通信配置失败：${String(error)}`);
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
      window.alert(`启动后台值守失败：${String(error)}`);
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
      window.alert(`停止后台值守失败：${String(error)}`);
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
        window.alert(result.message || '启动微信扫码失败。');
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
      window.alert(`启动微信扫码失败：${String(error)}`);
    } finally {
      setAssistantDaemonWeixinLoginBusy(false);
    }
  }, [assistantDaemonDraft.weixin.accountId, buildWeixinQrImageUrl]);

  const handleCheckAssistantDaemonWeixinLogin = useCallback(async () => {
    const sessionKey = String(assistantDaemonWeixinLogin?.sessionKey || '').trim();
    if (!sessionKey) {
      window.alert('请先点击“开始扫码”，生成微信二维码。');
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
      window.alert(`检查微信登录状态失败：${String(error)}`);
    } finally {
      setAssistantDaemonWeixinLoginBusy(false);
    }
  }, [assistantDaemonWeixinLogin?.sessionKey, loadAssistantDaemonStatus, setAssistantDaemonDraft]);

  const handleClearAssistantDaemonWeixinLogin = useCallback(() => {
    setAssistantDaemonWeixinLogin(null);
  }, []);

  const loadVectorStats = async () => {
    try {
      const stats = await window.ipcRenderer.invoke('indexing:get-stats') as { totalStats: { vectors: number; documents: number } } | null;
      if (stats && stats.totalStats) {
        setVectorStats(stats.totalStats);
      }
    } catch (e) {
      console.error("Failed to load vector stats", e);
    }
  };

  const handleRebuildIndex = async () => {
    if (!confirm('确定要重建所有索引吗？这可能需要一些时间，且会暂时清空现有向量数据。')) return;

    setIsRebuilding(true);
    try {
      await window.ipcRenderer.invoke('indexing:rebuild-all');
      alert('已触发后台索引重建任务。您可以在侧边栏查看进度。');
      loadVectorStats();
    } catch (e) {
      alert('重建失败: ' + String(e));
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleInstallYtdlp = async () => {
    setIsInstallingTool(true);
    setInstallProgress(0);
    try {
      const res = await window.ipcRenderer.installYtdlp();
      if (res.success) {
        await checkTools();
        alert('安装成功！');
      } else {
        alert('安装失败: ' + res.error);
      }
    } catch (e) {
      alert('安装出错');
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
        alert('更新成功！');
      } else {
        alert('更新失败: ' + res.error);
      }
    } catch (e) {
      alert('更新出错');
    } finally {
      setIsInstallingTool(false);
    }
  };

  const handlePrepareBrowserPlugin = async () => {
    setIsPreparingBrowserPlugin(true);
    try {
      const result = await window.ipcRenderer.browserPlugin.prepare();
      if (!result.success) {
        window.alert(`插件准备失败：${result.error || '未知错误'}`);
        return;
      }
      await loadBrowserPluginStatus();
      window.alert(`插件已准备完成。\n\n目录：${result.path}\n\n下一步请打开 Chrome / Edge 扩展管理页，开启开发者模式后，选择“加载已解压的扩展程序”，并指向该目录。`);
    } catch (error) {
      console.error('Failed to prepare browser plugin', error);
      window.alert(`插件准备失败：${String(error)}`);
    } finally {
      setIsPreparingBrowserPlugin(false);
    }
  };

  const handleOpenBrowserPluginDir = async () => {
    try {
      const result = await window.ipcRenderer.browserPlugin.openDir();
      if (!result.success) {
        window.alert(`打开插件目录失败：${result.error || '未知错误'}`);
        return;
      }
      await loadBrowserPluginStatus();
    } catch (error) {
      console.error('Failed to open browser plugin dir', error);
      window.alert(`打开插件目录失败：${String(error)}`);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('saving');
    try {
      let sanitizedSources: AiSourceConfig[] = aiSources.map((source) => ({
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
      })).map((source) => ({
        ...source,
        model: source.model || source.models?.[0] || '',
        models: normalizeSourceModels([...(source.models || []), source.model]),
        modelsMeta: normalizeAiModelDescriptors([
          ...(source.modelsMeta || []),
          ...(source.models || []).map((id) => ({ id })),
          source.model ? { id: source.model } : null,
        ]),
      })).filter((source) => !isDeprecatedEmptyOpenAiSource(source));

      const resolvedDefaultSourceId = defaultAiSourceId;
      const defaultSource = sanitizedSources.find((source) => source.id === resolvedDefaultSourceId) || sanitizedSources[0];
      if (defaultSource?.baseURL && (defaultSource?.apiKey || isLocalAiSource(defaultSource))) {
        const normalizedModel = (defaultSource.model || '').trim();
        if (!normalizedModel) {
          throw new Error('请为默认 AI 源填写模型名称（可手动填写，或从模型列表选择）');
        }
      }
      const resolvedApiEndpoint = defaultSource?.baseURL || '';
      const resolvedApiKey = String(defaultSource?.apiKey || '').trim();
      const resolvedModelName = String(defaultSource?.model || '').trim();
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
        developer_mode_enabled: Boolean(formData.developer_mode_enabled),
        developer_mode_unlocked_at: formData.developer_mode_enabled
          ? (formData.developer_mode_unlocked_at || new Date().toISOString())
          : null,
        chat_max_tokens_default: chatMaxTokensDefault,
        chat_max_tokens_deepseek: chatMaxTokensDeepseek,
      });
      if (formData.debug_log_enabled) {
        await loadRecentDebugLogs();
      }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      console.error(e);
      if (e instanceof Error && e.message) {
        setTestStatus('error');
        setTestMsg(e.message);
      }
      setStatus('error');
    }
  };

  const tabs = [
    { id: 'ai', label: 'AI 模型', icon: Cpu },
    { id: 'general', label: '常规设置', icon: LayoutGrid },
    { id: 'memory', label: '用户记忆', icon: Brain },
    { id: 'knowledge', label: '知识库索引', icon: Database },
    { id: 'tools', label: '工具管理', icon: Wrench },
    { id: 'experimental', label: '实验性功能', icon: FlaskConical },
  ] as const;

  return (
    <div className="flex h-full bg-background text-text-primary">
      {/* Sidebar */}
      <div className="w-48 border-r border-border pt-6 pb-4 flex flex-col gap-1 px-3 bg-surface-secondary/20">
        <h1 className="px-3 mb-4 text-xs font-bold text-text-tertiary uppercase tracking-wider">设置</h1>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
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
                recentDebugLogs={recentDebugLogs}
                isDebugLogsLoading={isDebugLogsLoading}
                handleRefreshDebugLogs={loadRecentDebugLogs}
                handleOpenDebugLogDir={openDebugLogDirectory}
                handleVersionTap={handleVersionTap}
                assistantDaemonStatus={assistantDaemonStatus}
                assistantDaemonDraft={assistantDaemonDraft}
                setAssistantDaemonDraft={setAssistantDaemonDraft}
                assistantDaemonLogs={assistantDaemonLogs}
                assistantDaemonBusy={assistantDaemonBusy}
                assistantDaemonWeixinLogin={assistantDaemonWeixinLogin}
                assistantDaemonWeixinLoginBusy={assistantDaemonWeixinLoginBusy}
                handleReloadAssistantDaemonStatus={loadAssistantDaemonStatus}
                handleSaveAssistantDaemonConfig={handleSaveAssistantDaemonConfig}
                handleStartAssistantDaemon={handleStartAssistantDaemon}
                handleStopAssistantDaemon={handleStopAssistantDaemon}
                handleStartAssistantDaemonWeixinLogin={handleStartAssistantDaemonWeixinLogin}
                handleCheckAssistantDaemonWeixinLogin={handleCheckAssistantDaemonWeixinLogin}
                handleClearAssistantDaemonWeixinLogin={handleClearAssistantDaemonWeixinLogin}
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

                      <p className="text-[11px] text-text-tertiary">
                        当前生效：{defaultAiSource?.name || '未设置'} / {defaultAiSource?.model || '未设置'}
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
                                  {isDefaultSource && !isOfficialPlaceholder && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600">
                                      <Star className="w-2.5 h-2.5" />
                                      默认源
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] text-text-tertiary mt-0.5 truncate">
                                  {isOfficialPlaceholder
                                    ? '官方托管模型源 · 当前未登录，登录后自动同步官方模型与凭据'
                                    : isOfficialSource
                                    ? `已托管登录态 · 默认模型：${source.model || '(未设置)'} · 已添加 ${sourceModels.length} 个模型`
                                    : `${preset?.label || 'Custom'} · 默认模型：${source.model || '(未设置)'} · 已添加 ${sourceModels.length} 个模型`}
                                </p>
                              </div>
                              {isOfficialPlaceholder ? (
                                <button
                                  type="button"
                                  onClick={() => setAiModelSubTab('login')}
                                  className="px-2 py-1 text-[11px] border rounded transition-colors border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
                                >
                                  去登录
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
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
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteAiSource(source.id)}
                                    className="p-1.5 text-text-tertiary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                    title="删除模型源"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>

                            {isExpanded && (
                              <div className="p-3 space-y-3">
                                {isOfficialPlaceholder ? (
                                  <div className="rounded border border-border bg-surface-secondary/30 px-3 py-3 text-[11px] text-text-secondary space-y-2">
                                    <div className="font-medium text-text-primary">RedBox 官方托管模型源</div>
                                    <p>
                                      即使当前未登录，这个官方源也会固定显示在这里。登录后会自动同步官方聊天模型、图片模型、视频能力与托管凭据。
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => setAiModelSubTab('login')}
                                      className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                    >
                                      前往登录
                                    </button>
                                  </div>
                                ) : isOfficialSource ? (
                                  <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-text-secondary">
                                    <div className="font-medium text-emerald-600">已登陆</div>
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
                                        disabled={isTesting}
                                        className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                      >
                                        <RefreshCw className={clsx('w-3 h-3', isTesting && activeAiSourceId === source.id && 'animate-spin')} />
                                        拉取候选
                                      </button>
                                    </div>
                                  </div>

                                  {isModelListExpanded && (
                                    sourceModels.length ? (
                                      <div className="space-y-1">
                                        {sourceModels.map((model) => {
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
                          className="ui-switch-track w-11 h-6 shrink-0 mt-0.5"
                          data-state={formData.wander_deep_think_enabled ? 'on' : 'off'}
                        >
                          <div
                            className={clsx(
                              'ui-switch-thumb top-1 w-4 h-4',
                              formData.wander_deep_think_enabled ? 'translate-x-6' : 'translate-x-1'
                            )}
                          />
                        </button>
                      </div>
                    </div>
                  </div>
                  </>
                  )}
                  {aiModelSubTab === 'login' && officialAiPanelEnabled && (
                    <div className="space-y-4">
                      {OfficialAiPanelComponent ? (
                        <OfficialAiPanelComponent onReloadSettings={reloadCustomAiSettings} />
                      ) : (
                        <div className="rounded-xl border border-border bg-surface-secondary/20 p-4 text-sm text-text-tertiary">
                          正在加载登录面板...
                        </div>
                      )}
                    </div>
                  )}

                </section>
              </div>
            )}

            {/* Memory Tab */}
            {activeTab === 'memory' && (
              <MemorySettingsSection
                newMemoryType={newMemoryType}
                setNewMemoryType={setNewMemoryType}
                newMemoryContent={newMemoryContent}
                setNewMemoryContent={setNewMemoryContent}
                handleAddMemory={handleAddMemory}
                isMemoryLoading={isMemoryLoading}
                memories={memories}
                archivedMemories={archivedMemories}
                memoryHistory={memoryHistory}
                maintenanceStatus={memoryMaintenanceStatus}
                onRunMaintenance={handleRunMemoryMaintenance}
                memorySearchQuery={memorySearchQuery}
                setMemorySearchQuery={setMemorySearchQuery}
                includeArchivedInSearch={includeArchivedInSearch}
                setIncludeArchivedInSearch={setIncludeArchivedInSearch}
                memorySearchResults={memorySearchResults}
                isMemorySearching={isMemorySearching}
                onSearchMemories={handleSearchMemories}
                handleDeleteMemory={handleDeleteMemory}
              />
            )}

            {/* Knowledge Tab */}
            {activeTab === 'knowledge' && (
              <KnowledgeSettingsSection
                vectorStats={vectorStats}
                handleRebuildIndex={handleRebuildIndex}
                isRebuilding={isRebuilding}
              />
            )}

            {/* Tools Tab */}
            {activeTab === 'tools' && (
              <ToolsSettingsSection
                isSyncingMcp={isSyncingMcp}
                handleDiscoverAndImportMcp={handleDiscoverAndImportMcp}
                handleAddMcpServer={handleAddMcpServer}
                handleSaveMcpServers={handleSaveMcpServers}
                mcpStatusMessage={mcpStatusMessage}
                mcpServers={mcpServers}
                handleUpdateMcpServer={handleUpdateMcpServer}
                handleDeleteMcpServer={handleDeleteMcpServer}
                stringifyEnvRecord={stringifyEnvRecord}
                parseEnvText={parseEnvText}
                mcpOauthState={mcpOauthState}
                handleRefreshMcpOAuth={handleRefreshMcpOAuth}
                handleTestMcpServer={handleTestMcpServer}
                mcpTestingId={mcpTestingId}
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
                runtimeTasks={runtimeTasks}
                runtimeRoles={runtimeRoles}
                runtimeSessions={runtimeSessions}
                backgroundTasks={backgroundTasks}
                backgroundWorkerPool={backgroundWorkerPool}
                selectedRuntimeTaskId={selectedRuntimeTaskId}
                setSelectedRuntimeTaskId={setSelectedRuntimeTaskId}
                selectedRuntimeSessionId={selectedRuntimeSessionId}
                setSelectedRuntimeSessionId={setSelectedRuntimeSessionId}
                selectedBackgroundTaskId={selectedBackgroundTaskId}
                setSelectedBackgroundTaskId={setSelectedBackgroundTaskId}
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

            {/* Experimental Tab */}
            {activeTab === 'experimental' && (
              <ExperimentalSettingsSection
                flags={flags}
                updateFlag={updateFlag}
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
                      {addModelModalSource.name || '未命名模型源'} · 候选模型 {addModelModalRemoteModels.length} 个
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
                    仅展示候选，不会自动加入常用列表；点击确认后才会加入当前模型源。
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
                      disabled={isTesting}
                      className="px-3 py-2 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                    >
                      {isTesting && activeAiSourceId === addModelModalSource.id ? '拉取中...' : '刷新候选'}
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
                      <div className="text-xs text-text-tertiary">暂无候选模型，可点击“刷新候选”拉取。</div>
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
