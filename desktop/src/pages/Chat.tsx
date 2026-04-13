import React, { startTransition, useEffect, useRef, useState, useCallback } from 'react';
import { Send, Terminal, Loader2, StopCircle, Trash2, Plus, ChevronDown, Mic, ArrowUp, MessageSquare, X, PanelLeftClose, PanelLeft, Sparkles, Edit, Users, Paperclip, FileX, Square } from 'lucide-react';
import { clsx } from 'clsx';
import { ToolConfirmDialog } from '../components/ToolConfirmDialog';
import { MessageItem, Message, ToolEvent, SkillEvent } from '../components/MessageItem';
import type { ProcessItem, ProcessItemType } from '../components/ProcessTimeline';
import type { PendingChatMessage } from '../App';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getForcedModelCapabilities, inferModelCapabilities, normalizeModelCapabilities, type ModelCapability } from '../../shared/modelCapabilities';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import { appConfirm } from '../utils/appDialogs';
import { uiDebug, uiMeasure, uiTraceInteraction } from '../utils/uiDebug';

interface Session {
  id: string;
  title: string;
  updatedAt: string;
}

// 群聊接口
interface ChatRoom {
  id: string;
  name: string;
  advisorIds: string[];
  createdAt: string;
}

// 选中文字菜单状态
interface SelectionMenu {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

interface ChatProps {
  isActive?: boolean;
  defaultCollapsed?: boolean;
  pendingMessage?: PendingChatMessage | null;
  onMessageConsumed?: () => void;
  fixedSessionId?: string | null;
  showClearButton?: boolean;
  fixedSessionBannerText?: string;
  shortcuts?: Array<{ label: string; text: string }>;
  welcomeShortcuts?: Array<{ label: string; text: string }>;
  showWelcomeShortcuts?: boolean;
  showComposerShortcuts?: boolean;
  fixedSessionContextIndicatorMode?: 'top' | 'corner-ring' | 'none';
  welcomeTitle?: string;
  welcomeSubtitle?: string;
  welcomeIconSrc?: string;
  contentLayout?: 'default' | 'center-2-3' | 'wide';
  contentWidthPreset?: 'default' | 'narrow';
  allowFileUpload?: boolean;
  messageWorkflowPlacement?: 'top' | 'bottom';
  messageWorkflowVariant?: 'default' | 'compact';
  messageWorkflowEmphasis?: 'default' | 'thoughts-first';
  embeddedTheme?: 'default' | 'dark';
  showWelcomeHeader?: boolean;
  emptyStateComposerPlacement?: 'inline' | 'bottom';
}

interface UploadedFileAttachment {
  type: 'uploaded-file';
  name: string;
  ext?: string;
  size?: number;
  absolutePath?: string;
  originalAbsolutePath?: string;
  localUrl?: string;
  kind?: 'text' | 'image' | 'audio' | 'video' | 'binary' | string;
  mimeType?: string;
  storageMode?: 'staged' | string;
  directUploadEligible?: boolean;
  processingStrategy?: string;
  summary?: string;
  requiresMultimodal?: boolean;
}

interface ChatContextUsage {
  success: boolean;
  contextType?: string;
  estimatedTotalTokens?: number;
  compactThreshold?: number;
  compactRatio?: number;
  compactRounds?: number;
  compactUpdatedAt?: string | null;
}

interface ChatRuntimeState {
  success: boolean;
  error?: string;
  sessionId?: string;
  isProcessing: boolean;
  partialResponse: string;
  updatedAt: number;
}

interface ChatErrorEventPayload {
  message?: string;
  raw?: string;
  hint?: string;
  statusCode?: number;
  errorCode?: string;
  category?: string;
}

interface ChatModelOption {
  key: string;
  modelName: string;
  sourceName: string;
  baseURL: string;
  apiKey: string;
  isDefault?: boolean;
}

interface ChatSettingsSnapshot {
  api_endpoint?: string;
  api_key?: string;
  model_name?: string;
  ai_sources_json?: string;
  default_ai_source_id?: string;
}

function modelSupportsChat(model: string | { id?: unknown; capability?: unknown; capabilities?: unknown }): boolean {
  if (typeof model === 'string') {
    const forced = getForcedModelCapabilities(model);
    const resolved = forced.length ? forced : inferModelCapabilities(model);
    return resolved.includes('chat');
  }
  const id = String(model?.id || '').trim();
  if (!id) return false;
  const forced = getForcedModelCapabilities(id);
  const explicitCapabilities = [
    ...(
      Array.isArray((model as { capabilities?: unknown[] }).capabilities)
        ? ((model as { capabilities?: Array<ModelCapability | string | null | undefined> }).capabilities || [])
        : []
    ),
    (model as { capability?: ModelCapability | string | null | undefined }).capability,
  ];
  const capabilities = explicitCapabilities.some((value) => String(value || '').trim())
    ? normalizeModelCapabilities(explicitCapabilities)
    : [];
  const resolved = forced.length ? forced : (capabilities.length ? capabilities : inferModelCapabilities(id));
  return resolved.includes('chat');
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
const STREAM_CHUNK_DEDUPE_WINDOW_MS = 120;
const STREAM_UPDATE_INTERVAL_MS = 48;

function isImeComposingEvent(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  const synthetic = event as React.KeyboardEvent<HTMLTextAreaElement> & { isComposing?: boolean };
  const native = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return Boolean(native?.isComposing) || Boolean(synthetic.isComposing) || native?.keyCode === 229;
}

function consumeBufferedChunk(buffer: string, chunk: string): string {
  if (!buffer || !chunk) return buffer;
  if (buffer.startsWith(chunk)) {
    return buffer.slice(chunk.length);
  }

  const index = buffer.indexOf(chunk);
  if (index === -1) {
    return buffer;
  }
  return `${buffer.slice(0, index)}${buffer.slice(index + chunk.length)}`;
}

function mergeAssistantContent(currentContent: string, incomingContent: string): string {
  const current = String(currentContent || '');
  const incoming = String(incomingContent || '');
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current}${incoming}`;
}

function mergeThoughtDelta(currentThought: string, incomingThought: string): string {
  const current = String(currentThought || '');
  const incoming = String(incomingThought || '');
  if (!incoming) return current;
  if (!current) return incoming;
  if (current === incoming) return current;
  if (current.endsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  return `${current}${incoming}`;
}

function deriveChatErrorPresentation(payload: ChatErrorEventPayload | string | null | undefined): { formatted: string; notice: string } {
  const data = typeof payload === 'string' ? { message: payload } : (payload || {});
  const title = String(data.message || 'AI 请求失败').trim();
  const detail = String(data.raw || '').trim();
  const lower = `${title}\n${detail}`.toLowerCase();
  const detectedInsufficientBalance =
    lower.includes('insufficient balance') ||
    lower.includes('insufficient_balance') ||
    lower.includes('insufficient_quota') ||
    /\b1008\b/.test(lower);
  const detectedInvalidKey =
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes('invalid_api_key') ||
    lower.includes('authentication_error') ||
    lower.includes('unauthorized');
  const detectedRateLimit =
    Number(data.statusCode) === 429 ||
    lower.includes('rate limit') ||
    lower.includes('too many requests');

  const category = detectedInsufficientBalance
    ? 'quota'
    : detectedInvalidKey
      ? 'auth'
      : detectedRateLimit
        ? 'rate_limit'
        : String(data.category || '').trim();

  const isValidationError = category === 'validation';
  const isExecutionError = category === 'execution';

  const hint = detectedInsufficientBalance
    ? '账号余额/额度不足。请充值、升级套餐或切换到有余额的 AI 源。'
    : detectedInvalidKey
      ? '请检查 API Key 是否正确、是否过期，以及该模型是否有调用权限。'
      : detectedRateLimit
        ? '请求频率过高。请稍后重试，或降低并发与调用频率。'
        : isValidationError
          ? String(data.hint || '').trim() || '当前结果未通过执行校验，请先修复素材读取、证据链或保存回执问题。'
          : isExecutionError
            ? String(data.hint || '').trim() || '执行阶段发生错误，请检查素材读取、工具调用、文件路径或权限。'
        : String(data.hint || '').trim() || '请检查 AI 源配置后重试。';
  const metaParts = [
    data.statusCode ? `HTTP ${data.statusCode}` : '',
    data.errorCode ? String(data.errorCode) : '',
    category || '',
  ].filter(Boolean);

  const userFacingTitle = detectedInsufficientBalance
    ? 'AI 账号余额不足（供应商返回）'
    : detectedInvalidKey
      ? 'AI API Key 无效或无权限（供应商返回）'
      : detectedRateLimit
        ? 'AI 请求被限流（供应商返回）'
        : isValidationError
          ? '执行校验未通过'
          : isExecutionError
            ? '任务执行失败'
        : title;

  const lines: string[] = [`❌ ${userFacingTitle}`];
  lines.push(
    isValidationError || isExecutionError
      ? '说明：这是任务执行阶段返回的错误，不是 AI 源鉴权或 App 崩溃。'
      : '说明：这是 AI 源接口返回的错误，不是 App 崩溃。'
  );
  if (hint) lines.push(`处理建议：${hint}`);
  if (metaParts.length > 0) lines.push(`标识：${metaParts.join(' · ')}`);
  if (detail) {
    lines.push('');
    lines.push('错误详情（用于反馈）：');
    lines.push('```text');
    lines.push(detail.slice(0, 3000));
    lines.push('```');
  }

  const notice = detectedInsufficientBalance
    ? 'AI 源余额不足，请充值或切换有余额的 AI 源。'
    : detectedInvalidKey
      ? 'AI 源鉴权失败，请检查 API Key。'
      : detectedRateLimit
        ? 'AI 请求被限流，请稍后重试。'
        : isValidationError
          ? '执行校验未通过，请先修复 reviewer 指出的问题。'
          : isExecutionError
            ? '任务执行失败，请检查素材读取、工具调用和文件权限。'
        : `AI 请求失败：${userFacingTitle}`;

  return {
    formatted: lines.join('\n'),
    notice,
  };
}

function decodeBase64DataUrl(dataUrl: string): string {
  const raw = String(dataUrl || '');
  const parts = raw.split(',');
  return parts.length > 1 ? parts[1] : raw;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(decodeBase64DataUrl(String(reader.result || '')));
    reader.onerror = () => reject(reader.error || new Error('音频读取失败'));
    reader.readAsDataURL(blob);
  });
}

function buildChatModelOptions(settings?: ChatSettingsSnapshot | null): ChatModelOption[] {
  if (!settings) return [];

  const options: ChatModelOption[] = [];
  const defaultSourceId = String(settings.default_ai_source_id || '').trim();
  const prefersOfficialDefault = defaultSourceId.toLowerCase() === 'redbox_official_auto';

  try {
    const parsed = JSON.parse(String(settings.ai_sources_json || '[]')) as Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const sourceId = String(item.id || '').trim();
        const sourceName = String(item.name || sourceId || 'AI 源').trim();
        const baseURL = String(item.baseURL || item.baseUrl || '').trim();
        const apiKey = String(item.apiKey || item.key || '').trim();
        const explicitModelsMeta = Array.isArray(item.modelsMeta)
          ? item.modelsMeta.filter((value): value is { id?: unknown; capability?: unknown; capabilities?: unknown } => Boolean(value && typeof value === 'object'))
          : [];
        const chatModelIdsFromMeta = explicitModelsMeta
          .filter((value) => modelSupportsChat(value))
          .map((value) => String(value.id || '').trim())
          .filter(Boolean);
        const fallbackCandidates = [
          ...((Array.isArray(item.models) ? item.models : []).map((value) => String(value || '').trim())),
          String(item.model || item.modelName || '').trim(),
        ]
          .filter(Boolean)
          .filter((value) => modelSupportsChat(value));
        const candidates = Array.from(new Set([
          ...chatModelIdsFromMeta,
          ...fallbackCandidates,
        ]));
        for (const modelName of candidates) {
          options.push({
            key: `${sourceId || baseURL || sourceName}::${modelName}`,
            modelName,
            sourceName,
            baseURL,
            apiKey,
            isDefault: Boolean(sourceId && sourceId === defaultSourceId && modelName === String(item.model || item.modelName || '').trim()),
          });
        }
      }
    }
  } catch {
    // ignore malformed ai_sources_json
  }

  const fallbackModel = String(settings.model_name || '').trim();
  if (!prefersOfficialDefault && fallbackModel && modelSupportsChat(fallbackModel)) {
    options.push({
      key: `fallback::${fallbackModel}`,
      modelName: fallbackModel,
      sourceName: '当前默认源',
      baseURL: String(settings.api_endpoint || '').trim(),
      apiKey: String(settings.api_key || '').trim(),
      isDefault: true,
    });
  }

  const deduped = new Map<string, ChatModelOption>();
  for (const option of options) {
    const uniqueKey = `${option.baseURL}::${option.modelName}`;
    const existing = deduped.get(uniqueKey);
    if (!existing || option.isDefault) {
      deduped.set(uniqueKey, option);
    }
  }

  return Array.from(deduped.values());
}

export function Chat({
  isActive = true,
  pendingMessage,
  onMessageConsumed,
  defaultCollapsed = true,
  fixedSessionId,
  showClearButton = true,
  fixedSessionBannerText = '当前对话已关联到文档',
  shortcuts: shortcutsProp,
  welcomeShortcuts: welcomeShortcutsProp,
  showWelcomeShortcuts = true,
  showComposerShortcuts = true,
  fixedSessionContextIndicatorMode = 'top',
  welcomeTitle = '有什么可以帮您？',
  welcomeSubtitle = '我可以帮您阅读和编辑稿件、分析内容、提供创作建议',
  welcomeIconSrc,
  contentLayout = 'default',
  contentWidthPreset = 'default',
  allowFileUpload = true,
  messageWorkflowPlacement = 'bottom',
  messageWorkflowVariant = 'compact',
  messageWorkflowEmphasis = 'default',
  embeddedTheme = 'default',
  showWelcomeHeader = true,
  emptyStateComposerPlacement = 'inline',
}: ChatProps) {
  const debugUi = useCallback((event: string, extra?: Record<string, unknown>) => {
    uiDebug('chat', event, extra);
  }, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ToolConfirmRequest | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem("chat:sidebarCollapsed");
    return saved ? JSON.parse(saved) : defaultCollapsed;
  });

  useEffect(() => {
    localStorage.setItem("chat:sidebarCollapsed", JSON.stringify(sidebarCollapsed));
  }, [sidebarCollapsed]);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu>({ visible: false, x: 0, y: 0, text: '' });
  const [chatRooms, setChatRooms] = useState<ChatRoom[]>([]);
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [isRoomPickerLoading, setIsRoomPickerLoading] = useState(false);
  const [contextUsage, setContextUsage] = useState<ChatContextUsage | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<UploadedFileAttachment | null>(null);
  const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
  const [selectedChatModelKey, setSelectedChatModelKey] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  // Throttle buffer for streaming updates
  const pendingUpdateRef = useRef<{ content: string } | null>(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamChunkRef = useRef<{ content: string; at: number }>({ content: '', at: 0 });
  const localMessageMutationRef = useRef(0);
  const chatRoomsRequestIdRef = useRef(0);
  const sessionsRequestIdRef = useRef(0);
  const isActiveRef = useRef(isActive);
  const coldRecoveryPendingRef = useRef(true);
  const streamStatsRef = useRef<{ startedAt: number; chunks: number; chars: number } | null>(null);
  const suppressComposerFocusUntilRef = useRef(0);
  const [composerSuppressed, setComposerSuppressed] = useState(false);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  const blurComposer = useCallback((reason: string) => {
    const element = inputRef.current;
    if (!element) return;
    if (document.activeElement === element) {
      debugUi('input_blur', { reason });
      element.blur();
    }
  }, [debugUi]);
  const suppressComposerFocus = useCallback((reason: string, ms: number) => {
    suppressComposerFocusUntilRef.current = performance.now() + ms;
    debugUi('suppress_composer_focus', { reason, ms });
    setComposerSuppressed(true);
  }, [debugUi]);
  const resumeComposerFocus = useCallback((source: 'empty' | 'composer') => {
    suppressComposerFocusUntilRef.current = 0;
    setComposerSuppressed(false);
    debugUi('resume_composer_focus', { source });
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      inputRef.current.focus();
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 300)}px`;
    });
  }, [debugUi]);
  const handleComposerFocus = useCallback((source: 'empty' | 'composer') => {
    const now = performance.now();
    if (now < suppressComposerFocusUntilRef.current) {
      debugUi('focus_blocked', {
        source,
        remainingMs: Math.round(suppressComposerFocusUntilRef.current - now),
      });
      queueMicrotask(() => blurComposer(`blocked_focus:${source}`));
      return;
    }
    debugUi('composer_focus_allowed', { source });
  }, [blurComposer, debugUi]);
  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) {
      coldRecoveryPendingRef.current = true;
      debugUi('chat:view_activate', { sessionId: currentSessionIdRef.current });
      return;
    }

    debugUi('chat:view_deactivate', { sessionId: currentSessionIdRef.current });
    suppressComposerFocus('view_deactivate', 1500);
    blurComposer('view_deactivate');
    shouldAutoScrollRef.current = false;
    missedChunksRef.current = '';
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }
    pendingUpdateRef.current = null;
    setShowRoomPicker(false);
    setSelectionMenu((prev) => ({ ...prev, visible: false }));
    setShowModelPicker(false);
    setComposerSuppressed(false);
  }, [blurComposer, debugUi, isActive, suppressComposerFocus]);
  const selectSessionRequestRef = useRef(0);
  
  // 缓冲未处理的 chunk，用于解决页面加载期间的数据丢失问题
  const missedChunksRef = useRef<string>('');
  const shouldAutoScrollRef = useRef(true);
  const centeredContent = contentLayout === 'center-2-3';
  const wideContent = contentLayout === 'wide';
  const narrowContent = contentWidthPreset === 'narrow';
  const contentWidthClass = 'w-full';
  const contentMaxWidthClass = narrowContent
    ? wideContent
      ? 'max-w-[760px]'
      : 'max-w-[700px]'
    : wideContent
      ? 'max-w-[920px]'
      : 'max-w-[780px]';
  const contentOuterPaddingClass = wideContent ? 'px-2 md:px-3 lg:px-4 xl:px-5' : 'px-2 md:px-3 lg:px-4 xl:px-5';
  const emptySessionWidthClass = centeredContent
    ? 'w-2/3 mx-auto'
    : wideContent
      ? 'max-w-4xl w-full'
      : 'max-w-2xl w-full';

  const isNearBottom = useCallback((element: HTMLDivElement): boolean => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distance <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    shouldAutoScrollRef.current = isNearBottom(container);
  }, [isNearBottom]);

  const loadContextUsage = useCallback(async (sessionId: string) => {
    if (!sessionId || !isActiveRef.current) return;
    try {
      const usage = await uiMeasure('chat', 'load_context_usage', async () => (
        window.ipcRenderer.chat.getContextUsage(sessionId)
      ), { sessionId });
      if (usage?.success) {
        setContextUsage(usage as ChatContextUsage);
      }
    } catch (error) {
      console.error('Failed to load context usage:', error);
    }
  }, []);

  const selectedChatModel = chatModelOptions.find((item) => item.key === selectedChatModelKey) || null;

  const buildPendingAssistantTimeline = useCallback((label: string): ProcessItem[] => ([
    {
      id: `phase_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'phase',
      title: label,
      content: '',
      status: 'running',
      timestamp: Date.now(),
    },
  ]), []);

  const closeModelPicker = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  const syncInputHeight = useCallback(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 300)}px`;
  }, []);

  const loadChatModelOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const settings = await uiMeasure('chat', 'load_chat_model_options', async () => (
        window.ipcRenderer.getSettings() as Promise<ChatSettingsSnapshot | undefined>
      ));
      const options = buildChatModelOptions(settings);
      setChatModelOptions(options);
      setSelectedChatModelKey((current) => {
        if (current && options.some((item) => item.key === current)) return current;
        return options.find((item) => item.isDefault)?.key || options[0]?.key || '';
      });
    } catch (error) {
      console.error('Failed to load chat model options:', error);
    }
  }, []);

  const cleanupAudioCapture = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;
      mediaRecorderRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    mediaChunksRef.current = [];
  }, []);

  const loadChatRooms = useCallback(async (options?: { silent?: boolean }) => {
    const requestId = ++chatRoomsRequestIdRef.current;
    const silent = Boolean(options?.silent);
    if (!silent) {
      setIsRoomPickerLoading(true);
    }
    try {
      const rooms = await uiMeasure('chat', 'load_chat_rooms', async () => (
        window.ipcRenderer.invoke('chatrooms:list') as Promise<ChatRoom[]>
      ), { silent });
      if (requestId !== chatRoomsRequestIdRef.current) {
        return;
      }
      if (Array.isArray(rooms)) {
        setChatRooms(rooms);
      }
    } catch (error) {
      console.error('Failed to load chat rooms:', error);
    } finally {
      if (requestId === chatRoomsRequestIdRef.current && !silent) {
        setIsRoomPickerLoading(false);
      }
    }
  }, []);

  // 判断是否是空会话（新建或无消息）
  const isEmptySession = messages.length === 0;

  // 标记是否已处理过 pendingMessage，避免重复处理
  const pendingMessageHandledRef = useRef(false);

  // 当 pendingMessage 变为 null 时重置标记
  useEffect(() => {
    if (!pendingMessage) {
      pendingMessageHandledRef.current = false;
    }
  }, [pendingMessage]);

  useEffect(() => {
    if (!isActive) return;
    void loadChatModelOptions();
  }, [isActive, loadChatModelOptions]);

  useEffect(() => {
    if (!isActive || !showModelPicker) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!modelPickerRef.current) return;
      if (!modelPickerRef.current.contains(event.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showModelPicker]);

  useEffect(() => {
    return () => {
      cleanupAudioCapture();
    };
  }, [cleanupAudioCapture]);

  useEffect(() => {
    if (!isActive || messages.length === 0) return;
    requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container && shouldAutoScrollRef.current) {
        container.scrollTop = container.scrollHeight;
      } else if (!container && shouldAutoScrollRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }
    });
  }, [messages, currentSessionId]);

  useEffect(() => {
    if (!isActive) return;
    shouldAutoScrollRef.current = true;
  }, [currentSessionId, isActive]);

  useEffect(() => {
    if (!isActive || !fixedSessionId || !currentSessionId) return;
    void loadContextUsage(currentSessionId);
  }, [fixedSessionId, currentSessionId, isActive, messages.length, isProcessing, loadContextUsage]);

  // Load sessions on mount
  useEffect(() => {
    if (!isActive) return;
    void loadChatRooms({ silent: true });

    // Handle fixed session (File-Bound Mode)
    if (fixedSessionId) {
       setSidebarCollapsed(true);
       selectSession(fixedSessionId);
       return;
    }

    // 只有没有 pendingMessage 时才自动选择会话
    if (!pendingMessage) {
      loadSessions();
    } else {
      // 有 pendingMessage 时只加载列表，不选择
      window.ipcRenderer.chat.getSessions().then((list: Session[]) => {
        debugUi('load_sessions:pending_message_done', { count: Array.isArray(list) ? list.length : 0 });
        setSessions(list);
      }).catch(console.error);
    }
  }, [fixedSessionId, isActive, loadChatRooms]); // Add fixedSessionId dependency

  const dispatchChatSend = useCallback((payload: {
    sessionId?: string;
    message: string;
    displayContent: string;
    attachment?: Message['attachment'];
    modelConfig?: {
      apiKey?: string;
      baseURL?: string;
      modelName?: string;
    };
    taskHints?: unknown;
  }) => {
    uiDebug('chat', 'dispatch_send:queued', {
      sessionId: payload.sessionId || null,
      chars: payload.message.length,
      hasAttachment: Boolean(payload.attachment),
    });
    const schedule = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0);

    schedule(() => {
      uiDebug('chat', 'dispatch_send:flushed', {
        sessionId: payload.sessionId || null,
        chars: payload.message.length,
      });
      window.ipcRenderer.chat.send(payload);
    });
  }, []);

  // 处理从其他页面传来的待发送消息（如知识库的"AI脑爆"）
  useEffect(() => {
    // 已处理过或正在处理中，跳过
    if (!isActive || !pendingMessage || isProcessing || pendingMessageHandledRef.current) {
      return;
    }

    if (fixedSessionId && currentSessionId !== fixedSessionId) {
      return;
    }

    // 标记为已处理
    pendingMessageHandledRef.current = true;

    const sendPendingMessage = async () => {
      let sessionId: string;
      const shouldAppendToCurrentSession = Boolean(fixedSessionId);

      if (fixedSessionId) {
        sessionId = fixedSessionId;
      } else {
        try {
          // 使用视频标题作为会话标题
          const sessionTitle = pendingMessage.attachment?.title
            ? `AI 脑爆: ${pendingMessage.attachment.title.substring(0, 30)}${pendingMessage.attachment.title.length > 30 ? '...' : ''}`
            : 'AI 脑爆';
          const session = await window.ipcRenderer.chat.createSession(sessionTitle);

          // 更新会话列表并选中新会话
          setSessions(prev => [session, ...prev]);
          setCurrentSessionId(session.id);
          sessionId = session.id;

          debugUi('pending_message:create_session_done', { sessionId: session.id, sessionTitle });
        } catch (error) {
          console.error('Failed to create session:', error);
          pendingMessageHandledRef.current = false; // 重置，允许重试
          onMessageConsumed?.();
          return;
        }
      }

      // 构建用户消息 - 注意：attachment 和 displayContent 用于 UI 显示
      const userMsg: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: pendingMessage.content,
        displayContent: pendingMessage.displayContent,
        attachment: pendingMessage.attachment,
        tools: [],
        timeline: []
      };

      const aiPlaceholder: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: '',
        tools: [],
        timeline: (
          pendingMessage.taskHints?.forceMultiAgent
        ) ? buildPendingAssistantTimeline('任务已提交') : [],
        isStreaming: true
      };

      if (shouldAppendToCurrentSession) {
        localMessageMutationRef.current += 1;
        setMessages(prev => [...prev, userMsg, aiPlaceholder]);
      } else {
        // 新会话直接设置消息
        localMessageMutationRef.current += 1;
        setMessages([userMsg, aiPlaceholder]);
      }
      setIsProcessing(true);
      shouldAutoScrollRef.current = true;

      // 发送给后端 - 传递 displayContent 和 attachment 用于持久化
      dispatchChatSend({
        sessionId: sessionId,
        message: pendingMessage.content,
        displayContent: pendingMessage.displayContent,
        attachment: pendingMessage.attachment,
        modelConfig: selectedChatModel ? {
          apiKey: selectedChatModel.apiKey,
          baseURL: selectedChatModel.baseURL,
          modelName: selectedChatModel.modelName,
        } : undefined,
        taskHints: pendingMessage.taskHints,
      });

      // 标记消息已消费
      onMessageConsumed?.();
    };

    sendPendingMessage();
  }, [isActive, pendingMessage, isProcessing, onMessageConsumed, fixedSessionId, currentSessionId, selectedChatModel, buildPendingAssistantTimeline, dispatchChatSend]);

  const loadSessions = async () => {
    if (!isActiveRef.current) return;
    const requestId = ++sessionsRequestIdRef.current;
    try {
      const list = await uiMeasure('chat', 'load_sessions', async () => (
        window.ipcRenderer.chat.getSessions()
      ));
      if (requestId !== sessionsRequestIdRef.current) {
        return;
      }
      const normalizedList = Array.isArray(list) ? list : [];
      setSessions(normalizedList);
      if (normalizedList.length > 0 && !currentSessionIdRef.current) {
        void selectSession(normalizedList[0].id);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const selectSession = async (sessionId: string) => {
    if (!isActiveRef.current) return;
    setCurrentSessionId(sessionId);
    const requestId = ++selectSessionRequestRef.current;
    const mutationVersionAtStart = localMessageMutationRef.current;
    try {
      const shouldRecoverRuntime = coldRecoveryPendingRef.current;
      coldRecoveryPendingRef.current = false;
      debugUi('select_session:start', { sessionId, shouldRecoverRuntime });
      const [history, runtimeStateRaw] = await uiMeasure('chat', 'select_session:load', async () => (
        Promise.all([
          window.ipcRenderer.chat.getMessages(sessionId),
          shouldRecoverRuntime
            ? window.ipcRenderer.chat.getRuntimeState(sessionId)
            : Promise.resolve(null),
        ])
      ), { sessionId, shouldRecoverRuntime });
      if (requestId !== selectSessionRequestRef.current) {
        return;
      }
      if (localMessageMutationRef.current !== mutationVersionAtStart) {
        return;
      }
      const runtimeState = runtimeStateRaw as ChatRuntimeState;

      // Convert DB messages to UI messages
      const uiMessages: Message[] = history.map((msg: any) => {
        // 解析 attachment（数据库中存储为 JSON 字符串）
        let attachment = undefined;
        if (msg.attachment) {
          try {
            attachment = typeof msg.attachment === 'string' ? JSON.parse(msg.attachment) : msg.attachment;
          } catch (e) {
            console.error('Failed to parse attachment:', e);
          }
        }

        return {
          id: msg.id,
          role: msg.role === 'user' ? 'user' : 'ai', // Simplified mapping
          content: msg.content,
          displayContent: msg.display_content || undefined,
          attachment: attachment,
          tools: [], // History tools not fully reconstructed in this simple view yet
          timeline: [], // History timeline not fully reconstructed
          isStreaming: false
        };
      });

      const runtimeProcessing = Boolean(runtimeState?.success && runtimeState?.isProcessing);
      const runtimePartial = runtimeState?.partialResponse || '';
      let shouldSetProcessing = false;

      // 仅在首次挂载冷恢复时允许读取 runtimeState，正常流结束后不做补偿式回放
      if (shouldRecoverRuntime && runtimeProcessing) {
        debugUi('cold_recovery:runtime_processing', {
          sessionId,
          partialChars: runtimePartial.length,
        });
        const restoredContent = `${runtimePartial}${missedChunksRef.current || ''}`;
        missedChunksRef.current = '';
        const lastMsg = uiMessages[uiMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') {
          uiMessages.push({
            id: `streaming_${Date.now()}`,
            role: 'ai',
            content: restoredContent,
            tools: [],
            timeline: [],
            isStreaming: true,
          });
        } else {
          uiMessages[uiMessages.length - 1] = {
            ...lastMsg,
            content: restoredContent || lastMsg.content || '',
            isStreaming: true,
          };
        }
        shouldSetProcessing = true;
      }

      setMessages(uiMessages);
      setIsProcessing(shouldSetProcessing);
      debugUi('select_session:done', {
        sessionId,
        messageCount: uiMessages.length,
        recoveredProcessing: shouldSetProcessing,
      });
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  };

  const createNewSession = async () => {
    try {
      const session = await window.ipcRenderer.chat.createSession('New Chat');
      setSessions(prev => [session, ...prev]);
      setCurrentSessionId(session.id);
      setMessages([]);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const clearSession = async () => {
    if (!currentSessionId) return;
    try {
      if (isProcessing) {
        window.ipcRenderer.chat.cancel({ sessionId: currentSessionId });
      }
      await window.ipcRenderer.chat.clearMessages(currentSessionId);
      missedChunksRef.current = '';
      flushPendingAssistantChunk();
      setIsProcessing(false);
      setConfirmRequest(null);
      setErrorNotice(null);
      setMessages([]);
    } catch (error) {
      console.error('Failed to clear session:', error);
    }
  };

  const deleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 防止触发选择会话
    if (!(await appConfirm('确定要删除这个对话吗？', { title: '删除对话', confirmLabel: '删除', tone: 'danger' }))) return;

    try {
      await window.ipcRenderer.chat.deleteSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));

      // 如果删除的是当前会话，切换到其他会话或清空
      if (currentSessionId === sessionId) {
        const remaining = sessions.filter(s => s.id !== sessionId);
        if (remaining.length > 0) {
          selectSession(remaining[0].id);
        } else {
          setCurrentSessionId(null);
          setMessages([]);
        }
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleConfirmTool = useCallback((callId: string) => {
    window.ipcRenderer.chat.confirmTool(callId, true);
    setConfirmRequest(null);
  }, []);

  const handleCancelTool = useCallback((callId: string) => {
    window.ipcRenderer.chat.confirmTool(callId, false);
    setConfirmRequest(null);
  }, []);

  // 复制消息内容
  const handleCopyMessage = useCallback((messageId: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    });
  }, []);

  const appendAssistantChunk = useCallback((chunk: string) => {
    if (!chunk) return;
    setMessages(prev => {
      if (prev.length === 0) {
        return prev;
      }

      const lastMsg = prev[prev.length - 1];
      if (!lastMsg || lastMsg.role !== 'ai') {
        return prev;
      }

      missedChunksRef.current = consumeBufferedChunk(missedChunksRef.current, chunk);
      return [...prev.slice(0, -1), {
        ...lastMsg,
        content: lastMsg.content + chunk,
        isStreaming: true,
      }];
    });
  }, []);

  const flushPendingAssistantChunk = useCallback(() => {
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }

    const chunk = pendingUpdateRef.current?.content || '';
    pendingUpdateRef.current = null;
    if (chunk) {
      appendAssistantChunk(chunk);
    }
  }, [appendAssistantChunk]);

  useEffect(() => {
    if (!isActive) return;
    const handleSpaceChanged = () => {
      setShowRoomPicker(false);
      setSelectionMenu(prev => ({ ...prev, visible: false }));
      void loadChatRooms({ silent: true });
    };
    window.ipcRenderer.on('space:changed', handleSpaceChanged);
    return () => {
      window.ipcRenderer.off('space:changed', handleSpaceChanged);
    };
  }, [isActive, loadChatRooms]);

  const handleCancel = useCallback(() => {
    if (currentSessionId) {
      window.ipcRenderer.chat.cancel({ sessionId: currentSessionId });
    } else {
      window.ipcRenderer.chat.cancel();
    }
    setIsProcessing(false);
  }, [currentSessionId]);

  useEffect(() => {
    if (!isActive) return;
    debugUi('runtime_subscription:init', { sessionId: currentSessionIdRef.current });
    // --- Event Handlers ---

    // 1. Phase Start (e.g. Planning, Executing)
    const handlePhaseStart = (_: unknown, { name }: { name: string }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        const now = Date.now();
        const newTimeline = [...lastMsg.timeline];
        for (let i = newTimeline.length - 1; i >= 0; i -= 1) {
          const item = newTimeline[i];
          if (item.type === 'phase' && item.status === 'running') {
            newTimeline[i] = {
              ...item,
              status: 'done',
              duration: now - item.timestamp
            };
            break;
          }
        }

        newTimeline.push({
          id: Math.random().toString(36),
          type: 'phase',
          title: name,
          content: '',
          status: 'running',
          timestamp: now
        });

        return [...prev.slice(0, -1), { ...lastMsg, timeline: newTimeline }];
      });
    };

    // 2. Thought Start
    const handleThoughtStart = (_: unknown) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        const newTimeline = [...lastMsg.timeline];
        
        // Check if we already have a running thought (shouldn't happen with correct agent logic, but safe to check)
        const lastItem = newTimeline[newTimeline.length - 1];
        if (lastItem && lastItem.type === 'thought' && lastItem.status === 'running') {
            return prev; // Already thinking
        }

        newTimeline.push({
          id: Math.random().toString(36),
          type: 'thought',
          content: '',
          status: 'running',
          timestamp: Date.now()
        });

        return [...prev.slice(0, -1), { ...lastMsg, timeline: newTimeline }];
      });
    };

    // 3. Thought Delta
    const handleThoughtDelta = (_: unknown, data?: { content: string }) => {
      if (!isActiveRef.current) return;
      const content = data?.content;
      if (!content) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        const newTimeline = [...lastMsg.timeline];
        const lastItemIndex = newTimeline.length - 1;
        const lastItem = newTimeline[lastItemIndex];

        if (lastItem && lastItem.type === 'thought' && lastItem.status === 'running') {
            // Update existing thought
            newTimeline[lastItemIndex] = {
                ...lastItem,
                content: mergeThoughtDelta(String(lastItem.content || ''), content)
            };
        } else {
            // No running thought? Create one (fallback)
            newTimeline.push({
                id: Math.random().toString(36),
                type: 'thought',
                content: content,
                status: 'running',
                timestamp: Date.now()
            });
        }

        return [...prev.slice(0, -1), {
          ...lastMsg,
          timeline: newTimeline,
          thinking: mergeThoughtDelta(lastMsg.thinking || '', content),
        }];
      });
    };

    // 4. Thought End
    const handleThoughtEnd = (_: unknown) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        const newTimeline = [...lastMsg.timeline];
        const lastItemIndex = newTimeline.length - 1;
        const lastItem = newTimeline[lastItemIndex];

        if (lastItem && lastItem.type === 'thought' && lastItem.status === 'running') {
            newTimeline[lastItemIndex] = {
                ...lastItem,
                status: 'done',
                duration: Date.now() - lastItem.timestamp
            };
        }

        return [...prev.slice(0, -1), { ...lastMsg, timeline: newTimeline, thinking: lastMsg.thinking || '' }];
      });
    };

  const handleResponseChunk = (_: unknown, { content }: { content: string }) => {
      if (!isActiveRef.current) {
        if (import.meta.env.DEV) {
          console.warn('[ui][chat] inactive page received response chunk');
        }
        return;
      }
      if (!content) return;

      const now = performance.now();
      const lastChunk = lastStreamChunkRef.current;
      if (
        content === lastChunk.content &&
        (now - lastChunk.at) <= STREAM_CHUNK_DEDUPE_WINDOW_MS
      ) {
        return;
      }
      lastStreamChunkRef.current = { content, at: now };
      if (!streamStatsRef.current) {
        streamStatsRef.current = { startedAt: now, chunks: 0, chars: 0 };
        debugUi('stream:first_chunk', {
          sessionId: currentSessionIdRef.current,
          chunkChars: content.length,
        });
      }
      streamStatsRef.current.chunks += 1;
      streamStatsRef.current.chars += content.length;
      if (streamStatsRef.current.chunks % 25 === 0) {
        debugUi('stream:progress', {
          sessionId: currentSessionIdRef.current,
          chunks: streamStatsRef.current.chunks,
          chars: streamStatsRef.current.chars,
        });
      }

      // 直接更新 Ref 缓冲，防止闭包过时
      missedChunksRef.current += content;

      // 1. Accumulate content
      if (!pendingUpdateRef.current) {
        pendingUpdateRef.current = { content: '' };
      }
      pendingUpdateRef.current.content += content;

      // 2. Start timer if not running
      if (!updateTimerRef.current) {
        updateTimerRef.current = setTimeout(() => {
          updateTimerRef.current = null;
          flushPendingAssistantChunk();
        }, STREAM_UPDATE_INTERVAL_MS);
      }
    };

    const handleToolStart = (_: unknown, toolData: { callId: string; name: string; input: unknown; description?: string }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        const newTimeline = [...lastMsg.timeline];

        // Add Tool Item to Timeline
        newTimeline.push({
            id: Math.random().toString(36),
            type: 'tool-call',
            content: toolData.description || '',
            status: 'running',
            timestamp: Date.now(),
            toolData: {
                callId: toolData.callId,
                name: toolData.name,
                input: toolData.input
            }
        });

        // Also update legacy tools array
        const newTool: ToolEvent = {
          id: Math.random().toString(36),
          callId: toolData.callId,
          name: toolData.name,
          input: toolData.input,
          description: toolData.description,
          status: 'running'
        };

        return [...prev.slice(0, -1), { 
            ...lastMsg, 
            timeline: newTimeline,
            tools: [...lastMsg.tools, newTool] 
        }];
      });
    };

    const handleToolEnd = (_: unknown, toolData: { callId: string; name: string; output: { success: boolean; content: string } }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        // Update Timeline
        const newTimeline = [...lastMsg.timeline];
        let matchedIndex = -1;

        // Prefer exact match with callId
        for (let i = newTimeline.length - 1; i >= 0; i--) {
            if (newTimeline[i].type === 'tool-call' && newTimeline[i].status === 'running') {
                if (newTimeline[i].toolData?.callId === toolData.callId) {
                  matchedIndex = i;
                  break;
                }
            }
        }

        // Fallback by name for backward compatibility
        if (matchedIndex === -1) {
          for (let i = newTimeline.length - 1; i >= 0; i--) {
              if (newTimeline[i].type === 'tool-call' && newTimeline[i].status === 'running') {
                  if (newTimeline[i].toolData?.name === toolData.name) {
                    matchedIndex = i;
                    break;
                  }
              }
          }
        }

        if (matchedIndex !== -1) {
          const targetItem = newTimeline[matchedIndex];
          newTimeline[matchedIndex] = {
              ...targetItem,
              status: toolData.output?.success ? 'done' : 'failed',
              duration: Date.now() - targetItem.timestamp,
              toolData: {
                  ...targetItem.toolData!,
                  output: toolData.output.content
              }
          };
        }

        // Update Legacy Tools
        const updatedTools = lastMsg.tools.map(t =>
          t.callId === toolData.callId ? { ...t, status: 'done', output: toolData.output } as ToolEvent : t
        );

        return [...prev.slice(0, -1), { 
            ...lastMsg, 
            timeline: newTimeline,
            tools: updatedTools 
        }];
      });
    };

    const handleToolUpdate = (_: unknown, toolData: { callId: string; name: string; partial: string }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;
        if (!toolData?.partial) return prev;

        const newTimeline = [...lastMsg.timeline];
        let matchedIndex = -1;

        for (let i = newTimeline.length - 1; i >= 0; i--) {
          if (newTimeline[i].type === 'tool-call' && newTimeline[i].toolData?.callId === toolData.callId) {
            matchedIndex = i;
            break;
          }
        }

        if (matchedIndex === -1) {
          for (let i = newTimeline.length - 1; i >= 0; i--) {
            if (
              newTimeline[i].type === 'tool-call' &&
              newTimeline[i].status === 'running' &&
              newTimeline[i].toolData?.name === toolData.name
            ) {
              matchedIndex = i;
              break;
            }
          }
        }

        if (matchedIndex === -1) return prev;

        const targetItem = newTimeline[matchedIndex];
        const currentOutput = targetItem.toolData?.output || '';
        let mergedOutput = currentOutput;

        if (!currentOutput) {
          mergedOutput = toolData.partial;
        } else if (toolData.partial.startsWith(currentOutput)) {
          mergedOutput = toolData.partial;
        } else if (!currentOutput.endsWith(toolData.partial)) {
          mergedOutput = `${currentOutput}\n${toolData.partial}`;
        }

        newTimeline[matchedIndex] = {
          ...targetItem,
          toolData: {
            ...targetItem.toolData!,
            output: mergedOutput,
          },
        };

        return [...prev.slice(0, -1), {
          ...lastMsg,
          timeline: newTimeline,
        }];
      });
    };

    const handleSkillActivated = (_: unknown, skillData: { name: string; description: string }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;
        
        // Add to Timeline
        const newTimeline = [...lastMsg.timeline, {
            id: Math.random().toString(36),
            type: 'skill' as any,
            content: skillData.description,
            status: 'done' as const,
            timestamp: Date.now(),
            skillData: skillData
        }];

        return [...prev.slice(0, -1), { 
            ...lastMsg, 
            timeline: newTimeline,
            activatedSkill: skillData 
        }];
      });
    };

    const handleConfirmRequest = (_: unknown, request: ToolConfirmRequest) => {
      if (!isActiveRef.current) return;
      setConfirmRequest(request);
    };

    const handleResponseEnd = (_: unknown, payload?: { content?: string }) => {
      if (!isActiveRef.current) {
        if (import.meta.env.DEV) {
          console.warn('[ui][chat] inactive page received response end');
        }
        return;
      }
      suppressComposerFocus('response_end', 5000);
      blurComposer('response_end');
      flushPendingAssistantChunk();
      const finalContent = typeof payload?.content === 'string' ? payload.content : '';
      const streamStats = streamStatsRef.current;
      debugUi('chat:response_end:ui', {
        sessionId: currentSessionIdRef.current,
        chars: finalContent.length,
        chunks: streamStats?.chunks || 0,
        streamedChars: streamStats?.chars || 0,
        streamElapsedMs: streamStats ? Math.round(performance.now() - streamStats.startedAt) : 0,
      });
      streamStatsRef.current = null;
      startTransition(() => {
        setIsProcessing(false);
        setErrorNotice(null);
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === 'ai') {
            const mergedContent = mergeAssistantContent(lastMsg.content || '', finalContent);
            const now = Date.now();
            const timeline: ProcessItem[] = (lastMsg.timeline || []).map((item) => {
              if (item.status !== 'running') return item;
              return {
                ...item,
                status: 'done',
                duration: now - item.timestamp,
              } as ProcessItem;
            });
            return [...prev.slice(0, -1), { ...lastMsg, content: mergedContent, timeline, isStreaming: false }];
          }
          if (finalContent) {
            return [
              ...prev,
              {
                id: Date.now().toString(),
                role: 'ai',
                content: finalContent,
                tools: [],
                timeline: [],
                isStreaming: false,
              }
            ];
          }
          return prev;
        });
      });
    };

    const handleCancelled = () => {
      if (!isActiveRef.current) return;
      suppressComposerFocus('cancelled', 3000);
      blurComposer('cancelled');
      flushPendingAssistantChunk();
      missedChunksRef.current = '';
      debugUi('response_cancelled', {
        sessionId: currentSessionIdRef.current,
        chunks: streamStatsRef.current?.chunks || 0,
        streamedChars: streamStatsRef.current?.chars || 0,
      });
      streamStatsRef.current = null;
      startTransition(() => {
        setIsProcessing(false);
        setConfirmRequest(null);
        setErrorNotice(null);
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (!lastMsg || lastMsg.role !== 'ai' || !lastMsg.isStreaming) return prev;
          const now = Date.now();
          const timeline: ProcessItem[] = (lastMsg.timeline || []).map((item) => {
            if (item.status !== 'running') return item;
            return {
              ...item,
              status: 'done',
              duration: now - item.timestamp,
            } as ProcessItem;
          });
          return [...prev.slice(0, -1), { ...lastMsg, timeline, isStreaming: false }];
        });
      });
    };

    const handleSessionTitleUpdated = (_: unknown, { sessionId, title }: { sessionId: string; title: string }) => {
      if (!isActiveRef.current) return;
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, title } : s
      ));
    };

    const handlePlanUpdated = (_: unknown, { steps }: { steps: any[] }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return prev;

        return [...prev.slice(0, -1), { ...lastMsg, plan: steps }];
      });
    };

    const handleError = (_: unknown, error: ChatErrorEventPayload | string) => {
      if (!isActiveRef.current) return;
      suppressComposerFocus('error', 3000);
      blurComposer('error');
      const { formatted, notice } = deriveChatErrorPresentation(error);
      debugUi('response_error', {
        sessionId: currentSessionIdRef.current,
        error: typeof error === 'string' ? error : error?.message || 'unknown',
      });
      streamStatsRef.current = null;
      startTransition(() => {
        setIsProcessing(false);
        setConfirmRequest(null);
        setErrorNotice(notice);
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === 'ai' && lastMsg.isStreaming) {
            const now = Date.now();
            const timeline: ProcessItem[] = (lastMsg.timeline || []).map((item) => {
              if (item.status !== 'running') return item;
              return {
                ...item,
                status: item.type === 'tool-call' ? 'failed' : 'done',
                duration: now - item.timestamp,
              } as ProcessItem;
            });
            return [...prev.slice(0, -1), { ...lastMsg, content: formatted, timeline, isStreaming: false }];
          }
          return [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'ai',
              content: formatted,
              tools: [],
              timeline: [],
              isStreaming: false,
            }
          ];
        });
      });
    };

    const disposeRuntimeEvents = subscribeRuntimeEventStream({
      getActiveSessionId: () => currentSessionIdRef.current,
      onPhaseStart: ({ phase }) => {
        handlePhaseStart(null, { name: phase });
      },
      onThoughtStart: () => {
        handleThoughtStart(null);
      },
      onThoughtDelta: ({ content }) => {
        handleThoughtDelta(null, { content });
      },
      onResponseDelta: ({ content }) => {
        handleResponseChunk(null, { content });
      },
      onToolRequest: ({ callId, name, input, description }) => {
        handleToolStart(null, { callId, name, input, description });
      },
      onToolResult: ({ callId, name, output }) => {
        const content = String(output.content || '');
        if (Boolean(output.partial)) {
          handleToolUpdate(null, { callId, name, partial: content });
          return;
        }
        handleToolEnd(null, {
          callId,
          name,
          output: {
            success: Boolean(output.success),
            content,
          },
        });
      },
      onTaskNodeChanged: ({ taskId, nodeId, status, summary, error }) => {
        const callId = `task-node:${taskId || 'session'}:${nodeId}`;
        const name = `task_node:${nodeId}`;
        if (status === 'running' || status === 'pending') {
          handleToolStart(null, {
            callId,
            name,
            input: { taskId, nodeId, status },
            description: summary || `任务节点 ${nodeId} 执行中`,
          });
          return;
        }
        const success = status !== 'failed';
        handleToolEnd(null, {
          callId,
          name,
          output: {
            success,
            content: error || summary || `任务节点 ${nodeId} ${success ? '已完成' : '执行失败'}`,
          },
        });
      },
      onSubagentSpawned: ({ taskId, roleId, runtimeMode }) => {
        const callId = `subagent:${taskId || 'session'}:${roleId}:${Date.now()}`;
        handleToolStart(null, {
          callId,
          name: `subagent:${roleId}`,
          input: { taskId, roleId, runtimeMode },
          description: `已启动子 Agent：${roleId}`,
        });
        handleToolEnd(null, {
          callId,
          name: `subagent:${roleId}`,
          output: {
            success: true,
            content: `子 Agent 已启动（role=${roleId}, mode=${runtimeMode}）`,
          },
        });
      },
      onChatPlanUpdated: ({ steps }) => {
        handlePlanUpdated(null, { steps });
      },
      onChatThoughtEnd: () => {
        handleThoughtEnd(null);
      },
      onChatResponseEnd: ({ content }) => {
        handleResponseEnd(null, { content });
      },
      onChatCancelled: () => {
        handleCancelled();
      },
      onChatError: ({ errorPayload }) => {
        handleError(null, errorPayload as ChatErrorEventPayload);
      },
      onChatSessionTitleUpdated: ({ sessionId, title }) => {
        handleSessionTitleUpdated(null, { sessionId, title });
      },
      onChatSkillActivated: ({ name, description }) => {
        handleSkillActivated(null, { name, description });
      },
      onChatToolConfirmRequest: ({ request }) => {
        handleConfirmRequest(null, request as unknown as ToolConfirmRequest);
      },
    });

    return () => {
      debugUi('runtime_subscription:dispose', { sessionId: currentSessionIdRef.current });
      disposeRuntimeEvents();

      // Cleanup timer
      if (updateTimerRef.current) {
          clearTimeout(updateTimerRef.current);
      }
    };
  }, [debugUi, flushPendingAssistantChunk, isActive]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !pendingAttachment) || isProcessing) return;

    sendMessage(input, pendingAttachment || undefined);
  };

  const pickAttachment = useCallback(async () => {
    if (isProcessing) return;
    try {
      const result = await window.ipcRenderer.chat.pickAttachment({
        sessionId: currentSessionId || undefined,
      }) as { success?: boolean; canceled?: boolean; error?: string; attachment?: UploadedFileAttachment };
      if (!result?.success) {
        setErrorNotice(result?.error || '上传文件失败');
        return;
      }
      if (result.canceled) return;
      if (result.attachment) {
        setPendingAttachment(result.attachment);
      }
    } catch (error) {
      setErrorNotice(String(error || '上传文件失败'));
    }
  }, [currentSessionId, isProcessing]);

  const getChatModelConfig = useCallback(() => {
    if (!selectedChatModel) return undefined;
    return {
      apiKey: selectedChatModel.apiKey,
      baseURL: selectedChatModel.baseURL,
      modelName: selectedChatModel.modelName,
    };
  }, [selectedChatModel]);

  const transcribeAudioBlob = useCallback(async (blob: Blob) => {
    setIsTranscribingAudio(true);
    setErrorNotice(null);
    try {
      const audioBase64 = await blobToBase64(blob);
      const result = await window.ipcRenderer.chat.transcribeAudio({
        audioBase64,
        mimeType: blob.type || 'audio/webm',
        fileName: `chat_audio_${Date.now()}.webm`,
      });
      if (!result?.success || !String(result.text || '').trim()) {
        throw new Error(result?.error || '语音转文字失败');
      }
      setInput((prev) => {
        const current = String(prev || '').trim();
        const next = String(result.text || '').trim();
        return current ? `${current}${current.endsWith('\n') ? '' : '\n'}${next}` : next;
      });
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        syncInputHeight();
      });
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranscribingAudio(false);
    }
  }, [syncInputHeight]);

  const stopAudioRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      cleanupAudioCapture();
      setIsRecordingAudio(false);
    }
  }, [cleanupAudioCapture]);

  const startAudioRecording = useCallback(async () => {
    if (isProcessing || isTranscribingAudio) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorNotice('当前环境不支持麦克风录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType } : undefined);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      mediaChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          mediaChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setErrorNotice('录音失败，请检查麦克风权限');
        cleanupAudioCapture();
        setIsRecordingAudio(false);
      };
      recorder.onstop = () => {
        const chunks = [...mediaChunksRef.current];
        cleanupAudioCapture();
        setIsRecordingAudio(false);
        if (!chunks.length) return;
        void transcribeAudioBlob(new Blob(chunks, { type: recorder.mimeType || preferredMimeType || 'audio/webm' }));
      };

      recorder.start();
      setIsRecordingAudio(true);
      setErrorNotice(null);
    } catch (error) {
      cleanupAudioCapture();
      setIsRecordingAudio(false);
      setErrorNotice(error instanceof Error ? error.message : '无法访问麦克风');
    }
  }, [cleanupAudioCapture, isProcessing, isTranscribingAudio, transcribeAudioBlob]);

  const handleAudioInput = useCallback(() => {
    if (isRecordingAudio) {
      stopAudioRecording();
      return;
    }
    void startAudioRecording();
  }, [isRecordingAudio, startAudioRecording, stopAudioRecording]);

  const sendMessage = (content: string, attachment?: UploadedFileAttachment) => {
    uiTraceInteraction('chat', 'send_message', {
      sessionId: currentSessionId || null,
      chars: String(content || '').trim().length,
      hasAttachment: Boolean(attachment),
    });
    suppressComposerFocus('send_message', 5000);
    blurComposer('send_message');
    shouldAutoScrollRef.current = true;
    setErrorNotice(null);
    const normalizedContent = String(content || '').trim();
    const displayText = normalizedContent || (attachment ? `请分析这个附件：${attachment.name}` : '');
    if (!displayText) return;
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: normalizedContent || displayText,
      displayContent: displayText,
      attachment: attachment as unknown as Message['attachment'],
      tools: [],
      timeline: []
    };

    const aiPlaceholder: Message = {
      id: (Date.now() + 1).toString(),
      role: 'ai',
      content: '',
      tools: [],
      timeline: [],
      isStreaming: true
    };

    localMessageMutationRef.current += 1;
    setMessages(prev => [...prev, userMsg, aiPlaceholder]);
    setInput('');
    setPendingAttachment(null);
    setIsProcessing(true);

    dispatchChatSend({
      sessionId: currentSessionId || undefined,
      message: normalizedContent || displayText,
      displayContent: displayText,
      attachment,
      modelConfig: getChatModelConfig(),
      taskHints: undefined,
    });
  };

  const shortcuts = shortcutsProp || [
    { label: '📝 总结内容', text: '请总结以上内容，提炼核心要点。' },
    { label: '💡 提炼观点', text: '请提炼其中的关键观点和洞察。' },
    { label: '✂️ 润色优化', text: '请润色这段内容，使其更具吸引力。' },
    { label: '❓ 延伸提问', text: '基于以上内容，提出3个值得思考的延伸问题。' },
  ];

  const welcomeShortcuts = welcomeShortcutsProp || [
    { label: '📄 阅读稿件', text: '请帮我阅读并理解当前的稿件内容。' },
    { label: '✏️ 编辑稿件', text: '我想对当前稿件进行编辑优化，请提供建议。' },
    { label: '🔍 内容分析', text: '请深度分析当前内容，提炼核心观点。' },
    { label: '💡 创作建议', text: '请基于当前内容提供一些创作方向的建议。' }
  ];

  const formatTokenLabel = (value?: number) => {
    const safe = Math.max(0, Math.round(Number(value || 0)));
    if (safe >= 1000) {
      return `${Math.round(safe / 1000)}k`;
    }
    return `${safe}`;
  };

  const compactRatio = Math.max(0, Number(contextUsage?.compactRatio || 0));
  const contextUsedPercentRaw = Math.max(0, Math.min(100, compactRatio * 100));
  const contextRemainingPercentRaw = Math.max(0, 100 - contextUsedPercentRaw);
  const contextUsedPercentDisplay = contextUsedPercentRaw < 10
    ? contextUsedPercentRaw.toFixed(1)
    : `${Math.round(contextUsedPercentRaw)}`;
  const contextRemainingRounded = Math.round(contextRemainingPercentRaw);
  const contextRemainingPercent = compactRatio > 0 && contextRemainingRounded >= 100
    ? 99
    : Math.max(0, Math.min(100, contextRemainingRounded));
  const contextBadgeClass = contextUsedPercentRaw >= 90
    ? 'text-red-600 border-red-500/40 bg-red-500/10'
    : contextUsedPercentRaw >= 70
      ? 'text-amber-600 border-amber-500/40 bg-amber-500/10'
      : 'text-text-secondary border-border bg-surface-secondary/90';
  const compactThreshold = Math.max(0, Math.round(contextUsage?.compactThreshold || 0));
  const estimatedTotalTokens = Math.max(0, Math.round(contextUsage?.estimatedTotalTokens || 0));
  const contextRemainingRatio = Math.max(0, Math.min(1, 1 - compactRatio));
  const contextRingRadius = 17;
  const contextRingCircumference = 2 * Math.PI * contextRingRadius;
  const contextRingOffset = contextRingCircumference * (1 - contextRemainingRatio);
  const contextRingColorClass = contextRemainingPercentRaw <= 15
    ? 'text-red-500'
    : contextRemainingPercentRaw <= 35
      ? 'text-amber-500'
      : 'text-emerald-500';
  const isCompactWorkflowMode = Boolean(fixedSessionId && fixedSessionContextIndicatorMode === 'corner-ring');
  const darkEmbedded = embeddedTheme === 'dark';
  const composerShellClass = darkEmbedded
    ? 'bg-[#121417] border border-white/10 rounded-[24px] p-1.5'
    : 'bg-[#fdfcf9] border border-[#edebe4] rounded-[24px] p-1.5';
  const composerShellEmptyClass = darkEmbedded
    ? 'bg-[#121417] border border-white/10 rounded-[28px] p-2'
    : 'bg-[#fdfcf9] border border-[#edebe4] rounded-[28px] p-2';
  const composerTextClass = darkEmbedded
    ? 'text-white placeholder:text-white/28'
    : 'text-text-primary placeholder:text-[#b4b2a8]';
  const composerSubtleButtonClass = darkEmbedded
    ? 'text-white/48 hover:text-white/82'
    : 'text-text-tertiary hover:text-text-secondary';
  const composerModelPickerClass = darkEmbedded
    ? 'absolute left-0 bottom-full mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-white/10 bg-[#181b20] shadow-xl z-[130]'
    : 'absolute left-0 bottom-full mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-border bg-surface-primary shadow-xl z-[130]';
  const composerAttachmentClass = darkEmbedded
    ? 'rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/68 flex items-center justify-between'
    : 'rounded-lg border border-border bg-surface-secondary/60 px-3 py-2 text-xs text-text-secondary flex items-center justify-between';
  const composerSendButtonClass = input.trim() || pendingAttachment
    ? 'bg-[#4c82ff] text-white hover:bg-[#5b8eff]'
    : darkEmbedded
      ? 'bg-white/10 text-white/45 opacity-80'
      : 'bg-[#edebe4] text-white opacity-60';
  const inputAreaShellClass = darkEmbedded
    ? 'bg-transparent pb-4 pt-2 md:pb-5'
    : 'bg-surface-primary pb-4 pt-2 md:pb-5';
  const shortcutChipClass = darkEmbedded
    ? 'flex-shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/62 transition-colors hover:border-white/20 hover:text-white disabled:opacity-50'
    : 'flex-shrink-0 rounded-full border border-border bg-surface-primary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent-primary/30 hover:text-accent-primary disabled:opacity-50';
  const dockedEmptyState = isEmptySession && emptyStateComposerPlacement === 'bottom';

  const welcomeHeaderBlock = showWelcomeHeader ? (
    <>
      <div className="flex justify-center">
        {welcomeIconSrc ? (
          <img
            src={welcomeIconSrc}
            alt={welcomeTitle}
            className="w-24 h-24 object-contain"
          />
        ) : (
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-primary to-purple-600 flex items-center justify-center shadow-lg">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h1 className={clsx('text-2xl font-semibold', darkEmbedded ? 'text-white' : 'text-text-primary')}>{welcomeTitle}</h1>
        {welcomeSubtitle ? (
          <p className={clsx('text-sm', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>{welcomeSubtitle}</p>
        ) : null}
      </div>
    </>
  ) : null;

  const welcomeShortcutsBlock = showWelcomeShortcuts && welcomeShortcuts.length > 0 ? (
    <div className="flex flex-wrap justify-center gap-2 text-xs">
      {welcomeShortcuts.map((shortcut) => (
        <button
          key={shortcut.label}
          onClick={() => sendMessage(shortcut.text)}
          className={darkEmbedded
            ? 'px-3 py-1.5 border border-white/10 rounded-full text-white/62 hover:text-white hover:border-white/20 transition-all cursor-pointer'
            : 'px-3 py-1.5 bg-surface-secondary hover:bg-surface-tertiary border border-transparent hover:border-border rounded-full text-text-secondary hover:text-accent-primary transition-all cursor-pointer'}
        >
          {shortcut.label}
        </button>
      ))}
    </div>
  ) : null;

  const emptyComposerForm = (
    <form onSubmit={handleSubmit} className="relative w-full">
      <ToolConfirmDialog request={confirmRequest} onConfirm={handleConfirmTool} onCancel={handleCancelTool} />
      <div className={clsx('group relative flex flex-col w-full transition-all duration-200 focus-within:shadow-lg focus-within:border-accent-primary/20', composerShellEmptyClass)}>
        {composerSuppressed ? (
          <button
            type="button"
            onClick={() => resumeComposerFocus('empty')}
            className={clsx('w-full rounded-2xl px-4 py-6 text-left text-[16px]', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}
          >
            对话已完成，点击后继续输入...
          </button>
        ) : (
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              syncInputHeight();
            }}
            onFocus={() => handleComposerFocus('empty')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isImeComposingEvent(e)) {
                e.preventDefault();
                handleSubmit(e as any);
                if (inputRef.current) inputRef.current.style.height = 'auto';
              }
            }}
            placeholder="问我任何问题，使用 @ 引用文件，/ 执行指令..."
            className={clsx('w-full bg-transparent px-4 py-3 text-[16px] focus:outline-none resize-none min-h-[100px] overflow-y-auto', composerTextClass)}
            data-ime="chat-composer-empty"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            readOnly={isProcessing}
            aria-disabled={isProcessing}
            rows={1}
          />
        )}
        <div className="flex items-center justify-between px-2 pb-1">
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => void pickAttachment()} className={clsx('p-2 transition-colors', composerSubtleButtonClass)} title="添加文件">
              <Plus className="w-[18px] h-[18px]" />
            </button>
            <div ref={modelPickerRef} className="relative flex items-center gap-4 px-2">
              <button
                type="button"
                onClick={() => setShowModelPicker((prev) => !prev)}
                className={clsx('flex items-center gap-1.5 transition-colors text-[13px] font-medium', composerSubtleButtonClass)}
              >
                <span className="max-w-[180px] truncate">{selectedChatModel?.modelName || '默认模型'}</span>
                <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', showModelPicker && 'rotate-180')} />
              </button>
              {showModelPicker && (
                <div className={composerModelPickerClass}>
                  {chatModelOptions.length ? chatModelOptions.map((option) => {
                    const active = option.key === selectedChatModelKey;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => {
                          setSelectedChatModelKey(option.key);
                          closeModelPicker();
                        }}
                        className={clsx(
                          'w-full px-3 py-2.5 text-left transition-colors',
                          active ? 'bg-accent-primary/10 text-text-primary' : darkEmbedded ? 'hover:bg-white/6 text-white/68' : 'hover:bg-surface-secondary/50 text-text-secondary'
                        )}
                      >
                        <div className="text-sm font-medium truncate">{option.modelName}</div>
                        <div className="text-[11px] text-text-tertiary truncate">{option.sourceName}</div>
                      </button>
                    );
                  }) : (
                    <div className="px-3 py-2 text-sm text-text-tertiary">请先在设置里配置模型源</div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAudioInput}
              disabled={isTranscribingAudio}
              className={clsx(
                'p-2 transition-colors',
                isRecordingAudio ? 'text-red-500 hover:text-red-600' : composerSubtleButtonClass,
                isTranscribingAudio && 'opacity-60 cursor-not-allowed'
              )}
              title={isTranscribingAudio ? '语音转录中' : isRecordingAudio ? '停止录音并转写' : '语音输入'}
            >
              {isTranscribingAudio ? (
                <Loader2 className="w-[18px] h-[18px] animate-spin" />
              ) : isRecordingAudio ? (
                <Square className="w-[18px] h-[18px] fill-current" />
              ) : (
                <Mic className="w-[18px] h-[18px]" />
              )}
            </button>
            <button type="submit" disabled={(!input.trim() && !pendingAttachment) || isProcessing} className={clsx("w-9 h-9 flex items-center justify-center rounded-full transition-all duration-200", composerSendButtonClass)}>
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin text-[#b4b2a8]" /> : <ArrowUp className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
      {pendingAttachment && (
        <div className={clsx('mt-3 mx-4', composerAttachmentClass)}>
          <span className="truncate">附件: {pendingAttachment.name}</span>
          <button type="button" onClick={() => setPendingAttachment(null)} className="ml-2 text-text-tertiary hover:text-text-primary">
            <FileX className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </form>
  );

  return (
    <div className={clsx('flex h-full min-w-0', wideContent && 'chat-layout-wide', narrowContent && 'chat-layout-narrow')}>
      {/* Sidebar - Session List (可折叠) - Only show if not fixed session */}
      {!fixedSessionId && (
        <div className={clsx(
          "bg-surface-secondary border-r border-border flex flex-col transition-all duration-300",
          sidebarCollapsed ? "w-0 overflow-hidden" : "w-64"
        )}>
          <div className="p-4 border-b border-border flex items-center gap-2">
            <button
              onClick={createNewSession}
              className="flex-1 flex items-center justify-center gap-2 bg-accent-primary text-white py-2 rounded-lg hover:bg-accent-primary/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新对话
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="p-2 text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary rounded-lg transition-colors"
              title="收起侧边栏"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.map(session => (
              <div
                key={session.id}
                className={clsx(
                  "group w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 cursor-pointer",
                  currentSessionId === session.id
                    ? "bg-surface-tertiary text-text-primary font-medium"
                    : "text-text-secondary hover:bg-surface-tertiary/50"
                )}
                onClick={() => selectSession(session.id)}
              >
                <MessageSquare className="w-4 h-4 shrink-0 opacity-70" />
                <span className="truncate flex-1">{session.title || 'Untitled Chat'}</span>
                <button
                  onClick={(e) => deleteSession(session.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all"
                  title="删除对话"
                >
                  <X className="w-3 h-3 text-red-500" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex-1 min-w-0 flex flex-col h-full relative overflow-hidden">
        {/* Header - Sidebar Controls - Hide if fixed session */}
        {!fixedSessionId && (
          <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="p-2 text-text-tertiary hover:text-text-primary transition-colors bg-surface-primary/80 backdrop-blur rounded-full shadow-sm border border-border"
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            >
              <PanelLeft className="w-4 h-4" />
            </button>

            {sidebarCollapsed && (
              <button
                onClick={createNewSession}
                className="p-2 text-text-tertiary hover:text-text-primary transition-colors bg-surface-primary/80 backdrop-blur rounded-full shadow-sm border border-border"
                title="新对话"
              >
                <Edit className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Linked Session Indicator */}
        {fixedSessionId && currentSessionId && fixedSessionBannerText && fixedSessionContextIndicatorMode === 'top' && (
          <div className="absolute top-0 left-0 right-0 z-10 flex flex-col items-center gap-1 pointer-events-none">
            <div className="bg-surface-secondary/90 backdrop-blur text-xs font-medium text-text-secondary px-3 py-1 rounded-b-lg shadow-sm border-b border-x border-border">
              {fixedSessionBannerText}
            </div>
            {contextUsage?.success && (
              <div className={clsx('text-[11px] px-2.5 py-1 rounded-full border backdrop-blur', contextBadgeClass)}>
                上下文 {contextUsedPercentDisplay}% · {contextUsage.estimatedTotalTokens || 0}/{contextUsage.compactThreshold || 0} tokens · compact {contextUsage.compactRounds || 0} 次
              </div>
            )}
          </div>
        )}

        {/* Corner Ring Compact Indicator (for fixed session, e.g. RedClaw) */}
        {fixedSessionId && currentSessionId && contextUsage?.success && fixedSessionContextIndicatorMode === 'corner-ring' && (
          <div className="absolute right-6 bottom-28 z-20 pointer-events-none">
            <div className="relative group pointer-events-auto">
              <button
                type="button"
                className="relative w-14 h-14 rounded-full border border-border bg-surface-primary/95 backdrop-blur shadow-md flex items-center justify-center"
                title="上下文窗口剩余空间"
                aria-label="上下文窗口剩余空间"
              >
                <svg className="w-11 h-11 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
                  <circle
                    cx="22"
                    cy="22"
                    r={contextRingRadius}
                    fill="transparent"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="text-border"
                  />
                  <circle
                    cx="22"
                    cy="22"
                    r={contextRingRadius}
                    fill="transparent"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    className={contextRingColorClass}
                    strokeDasharray={contextRingCircumference}
                    strokeDashoffset={contextRingOffset}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-text-primary">
                  {contextRemainingPercent}%
                </span>
              </button>

                <div className="absolute right-0 bottom-[68px] w-64 p-3 rounded-2xl border border-border bg-surface-primary/95 backdrop-blur shadow-xl text-xs text-text-secondary opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100">
                <div className="font-semibold text-text-primary mb-1">背景信息窗口</div>
                <div>{contextUsedPercentDisplay}% 已用（剩余 {contextRemainingPercentRaw.toFixed(1)}%）</div>
                <div>已用 {formatTokenLabel(estimatedTotalTokens)} 标记，共 {formatTokenLabel(compactThreshold)}</div>
                <div className="mt-1 text-text-tertiary">RedClaw 自动压缩其背景信息</div>
              </div>
            </div>
          </div>
        )}

        {/* Header Actions - 清除按钮 */}
        {showClearButton && currentSessionId && messages.length > 0 && (
          <div className="absolute top-4 right-4 z-10">
            <button
              onClick={clearSession}
              className="p-2 text-text-tertiary hover:text-red-500 transition-colors bg-surface-primary/80 backdrop-blur rounded-full shadow-sm border border-border"
              title="清除历史"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Content Area */}
        {isEmptySession && !dockedEmptyState ? (
          <div className="flex-1 flex flex-col items-center justify-center px-6 overflow-y-auto">
            <div className={clsx('text-center space-y-6 w-full max-w-2xl mx-auto', emptySessionWidthClass)}>
              {/* Logo/Icon */}
              {showWelcomeHeader ? (
                <>
                  <div className="flex justify-center">
                    {welcomeIconSrc ? (
                      <img
                        src={welcomeIconSrc}
                        alt={welcomeTitle}
                        className="w-24 h-24 object-contain"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-primary to-purple-600 flex items-center justify-center shadow-lg">
                        <Sparkles className="w-8 h-8 text-white" />
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <h1 className={clsx('text-2xl font-semibold', darkEmbedded ? 'text-white' : 'text-text-primary')}>{welcomeTitle}</h1>
                    {welcomeSubtitle ? (
                      <p className={clsx('text-sm', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>{welcomeSubtitle}</p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {showWelcomeShortcuts && welcomeShortcuts.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2 text-xs">
                  {welcomeShortcuts.map((shortcut) => (
                    <button
                      key={shortcut.label}
                      onClick={() => sendMessage(shortcut.text)}
                      className="px-3 py-1.5 bg-surface-secondary hover:bg-surface-tertiary border border-transparent hover:border-border rounded-full text-text-secondary hover:text-accent-primary transition-all cursor-pointer"
                    >
                      {shortcut.label}
                    </button>
                  ))}
                </div>
              )}

              {/* 居中的输入框 (Codex Style) */}
              <form onSubmit={handleSubmit} className="relative w-full mt-10">
                <ToolConfirmDialog request={confirmRequest} onConfirm={handleConfirmTool} onCancel={handleCancelTool} />
                <div className={clsx('group relative flex flex-col w-full transition-all duration-200 focus-within:shadow-lg focus-within:border-accent-primary/20', composerShellEmptyClass)}>
                  {composerSuppressed ? (
                    <button
                      type="button"
                      onClick={() => resumeComposerFocus('empty')}
                      className={clsx('w-full rounded-2xl px-4 py-6 text-left text-[16px]', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}
                    >
                      对话已完成，点击后继续输入...
                    </button>
                  ) : (
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => {
                        setInput(e.target.value);
                        syncInputHeight();
                      }}
                      onFocus={() => handleComposerFocus('empty')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !isImeComposingEvent(e)) {
                          e.preventDefault();
                          handleSubmit(e as any);
                          if (inputRef.current) inputRef.current.style.height = 'auto';
                        }
                      }}
                      placeholder="问我任何问题，使用 @ 引用文件，/ 执行指令..."
                      className={clsx('w-full bg-transparent px-4 py-3 text-[16px] focus:outline-none resize-none min-h-[100px] overflow-y-auto', composerTextClass)}
                      data-ime="chat-composer-empty"
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      readOnly={isProcessing}
                      aria-disabled={isProcessing}
                      rows={1}
                    />
                  )}
                  <div className="flex items-center justify-between px-2 pb-1">
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => void pickAttachment()} className={clsx('p-2 transition-colors', composerSubtleButtonClass)} title="添加文件">
                        <Plus className="w-[18px] h-[18px]" />
                      </button>
                      <div ref={modelPickerRef} className="relative flex items-center gap-4 px-2">
                        <button
                          type="button"
                          onClick={() => setShowModelPicker((prev) => !prev)}
                          className={clsx('flex items-center gap-1.5 transition-colors text-[13px] font-medium', composerSubtleButtonClass)}
                        >
                          <span className="max-w-[180px] truncate">{selectedChatModel?.modelName || '默认模型'}</span>
                          <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', showModelPicker && 'rotate-180')} />
                        </button>
                        {showModelPicker && (
                          <div className={composerModelPickerClass}>
                            {chatModelOptions.length ? chatModelOptions.map((option) => {
                              const active = option.key === selectedChatModelKey;
                              return (
                                <button
                                  key={option.key}
                                  type="button"
                                  onClick={() => {
                                    setSelectedChatModelKey(option.key);
                                    closeModelPicker();
                                  }}
                                  className={clsx(
                                    'w-full px-3 py-2.5 text-left transition-colors',
                                    active ? 'bg-accent-primary/10 text-text-primary' : darkEmbedded ? 'hover:bg-white/6 text-white/68' : 'hover:bg-surface-secondary/50 text-text-secondary'
                                  )}
                                >
                                  <div className="text-sm font-medium truncate">{option.modelName}</div>
                                  <div className="text-[11px] text-text-tertiary truncate">{option.sourceName}</div>
                                </button>
                              );
                            }) : (
                              <div className="px-3 py-2 text-sm text-text-tertiary">请先在设置里配置模型源</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleAudioInput}
                        disabled={isTranscribingAudio}
                        className={clsx(
                          'p-2 transition-colors',
                          isRecordingAudio ? 'text-red-500 hover:text-red-600' : 'text-text-tertiary hover:text-text-secondary',
                          isTranscribingAudio && 'opacity-60 cursor-not-allowed'
                        )}
                        title={isTranscribingAudio ? '语音转录中' : isRecordingAudio ? '停止录音并转写' : '语音输入'}
                      >
                        {isTranscribingAudio ? (
                          <Loader2 className="w-[18px] h-[18px] animate-spin" />
                        ) : isRecordingAudio ? (
                          <Square className="w-[18px] h-[18px] fill-current" />
                        ) : (
                          <Mic className="w-[18px] h-[18px]" />
                        )}
                      </button>
                      <button type="submit" disabled={(!input.trim() && !pendingAttachment) || isProcessing} className={clsx("w-9 h-9 flex items-center justify-center rounded-full transition-all duration-200", composerSendButtonClass)}>
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin text-[#b4b2a8]" /> : <ArrowUp className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                </div>
                {pendingAttachment && (
                  <div className={clsx('mt-3 mx-4', composerAttachmentClass)}>
                    <span className="truncate">附件: {pendingAttachment.name}</span>
                    <button type="button" onClick={() => setPendingAttachment(null)} className="ml-2 text-text-tertiary hover:text-text-primary">
                      <FileX className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </form>
            </div>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className={clsx('flex-1 min-w-0 overflow-y-auto py-4 md:py-5', contentOuterPaddingClass)}>
              <div className={clsx('mx-auto min-w-0', contentMaxWidthClass, contentWidthClass, dockedEmptyState ? 'flex min-h-full flex-col justify-center' : 'space-y-4 md:space-y-5')}>
                {dockedEmptyState ? (
                  <div className="text-center space-y-6 py-10">
                    {welcomeHeaderBlock}
                    {welcomeShortcutsBlock}
                  </div>
                ) : (
                  <>
                    {messages.map((msg) => (
                      <ErrorBoundary key={msg.id} name={`MessageItem-${msg.id}`}>
                        <MessageItem
                          msg={msg}
                          copiedMessageId={copiedMessageId}
                          onCopyMessage={handleCopyMessage}
                          workflowPlacement={messageWorkflowPlacement}
                          workflowVariant={messageWorkflowVariant}
                          workflowEmphasis={messageWorkflowEmphasis}
                        />
                      </ErrorBoundary>
                    ))}
                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>
            </div>

            {/* Input Area - Bottom Fixed */}
            <div className={clsx('shrink-0', inputAreaShellClass, contentOuterPaddingClass)}>
              <div className={clsx('mx-auto space-y-3.5', contentMaxWidthClass, contentWidthClass)}>
                {dockedEmptyState ? (
                  emptyComposerForm
                ) : (
                  <>
                {errorNotice && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{errorNotice}</div>
                )}
                {showComposerShortcuts && shortcuts.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto py-1 no-scrollbar">
                    {shortcuts.map((shortcut) => (
                      <button key={shortcut.label} onClick={() => sendMessage(shortcut.text)} disabled={isProcessing} className={shortcutChipClass}>
                        {shortcut.label}
                      </button>
                    ))}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="relative w-full">
                  <ToolConfirmDialog request={confirmRequest} onConfirm={handleConfirmTool} onCancel={handleCancelTool} />
                  {pendingAttachment && (
                    <div className={clsx('mb-3', composerAttachmentClass)}>
                      <span className="truncate">附件: {pendingAttachment.name}</span>
                      <button type="button" onClick={() => setPendingAttachment(null)} className="ml-2 text-text-tertiary hover:text-text-primary"><FileX className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                  <div className={clsx('group relative flex flex-col w-full transition-all duration-200 focus-within:shadow-lg focus-within:border-accent-primary/20', composerShellClass)}>
                    {composerSuppressed ? (
                      <button
                        type="button"
                        onClick={() => resumeComposerFocus('composer')}
                        className={clsx('w-full rounded-2xl px-3.5 py-6 text-left text-[14px]', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}
                      >
                        对话已完成，点击后继续输入...
                      </button>
                    ) : (
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => {
                          setInput(e.target.value);
                          syncInputHeight();
                        }}
                        onFocus={() => handleComposerFocus('composer')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !isImeComposingEvent(e)) {
                            e.preventDefault();
                            handleSubmit(e as any);
                            if (inputRef.current) inputRef.current.style.height = 'auto';
                          }
                        }}
                        placeholder="发送消息..."
                        className={clsx('w-full bg-transparent px-3.5 py-2.5 text-[14px] focus:outline-none resize-none min-h-[72px] max-h-[280px] overflow-y-auto', composerTextClass)}
                        data-ime="chat-composer-main"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        readOnly={isProcessing}
                        aria-disabled={isProcessing}
                        rows={1}
                      />
                    )}
                    <div className="flex items-center justify-between px-1.5 pb-0.5">
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => void pickAttachment()} className={clsx('p-2 transition-colors', composerSubtleButtonClass)} title="添加文件">
                          <Plus className="w-[18px] h-[18px]" />
                        </button>
                        <div ref={modelPickerRef} className="relative flex items-center gap-4 px-2">
                          <button
                            type="button"
                            onClick={() => setShowModelPicker((prev) => !prev)}
                            className={clsx('flex items-center gap-1.5 transition-colors text-[13px] font-medium', composerSubtleButtonClass)}
                          >
                            <span className="max-w-[180px] truncate">{selectedChatModel?.modelName || '默认模型'}</span>
                            <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', showModelPicker && 'rotate-180')} />
                          </button>
                          {showModelPicker && (
                            <div className={composerModelPickerClass}>
                              {chatModelOptions.length ? chatModelOptions.map((option) => {
                                const active = option.key === selectedChatModelKey;
                                return (
                                  <button
                                    key={option.key}
                                    type="button"
                                    onClick={() => {
                                      setSelectedChatModelKey(option.key);
                                      closeModelPicker();
                                    }}
                                    className={clsx(
                                      'w-full px-3 py-2.5 text-left transition-colors',
                                      active ? 'bg-accent-primary/10 text-text-primary' : darkEmbedded ? 'hover:bg-white/6 text-white/68' : 'hover:bg-surface-secondary/50 text-text-secondary'
                                    )}
                                  >
                                    <div className="text-sm font-medium truncate">{option.modelName}</div>
                                    <div className="text-[11px] text-text-tertiary truncate">{option.sourceName}</div>
                                  </button>
                                );
                              }) : (
                                <div className="px-3 py-2 text-sm text-text-tertiary">请先在设置里配置模型源</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isProcessing ? (
                          <button type="button" onClick={handleCancel} className={clsx('p-2 rounded-lg transition-colors', darkEmbedded ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50')} title="停止生成"><StopCircle className="w-5 h-5" /></button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleAudioInput}
                            disabled={isTranscribingAudio}
                            className={clsx(
                              'p-2 transition-colors',
                              isRecordingAudio ? 'text-red-500 hover:text-red-600' : 'text-text-tertiary hover:text-text-secondary',
                              isTranscribingAudio && 'opacity-60 cursor-not-allowed'
                            )}
                            title={isTranscribingAudio ? '语音转录中' : isRecordingAudio ? '停止录音并转写' : '语音输入'}
                          >
                            {isTranscribingAudio ? (
                              <Loader2 className="w-[18px] h-[18px] animate-spin" />
                            ) : isRecordingAudio ? (
                              <Square className="w-[18px] h-[18px] fill-current" />
                            ) : (
                              <Mic className="w-[18px] h-[18px]" />
                            )}
                          </button>
                        )}
                        <button type="submit" disabled={(!input.trim() && !pendingAttachment) || isProcessing} className={clsx("w-9 h-9 flex items-center justify-center rounded-full transition-all duration-200", composerSendButtonClass)}>
                          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin text-[#b4b2a8]" /> : <ArrowUp className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </form>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
