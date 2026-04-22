import React, { useEffect, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { Trash2, Plus, MessageSquare, X, PanelLeftClose, PanelLeft, Sparkles, Edit } from 'lucide-react';
import { clsx } from 'clsx';
import { ToolConfirmDialog } from '../components/ToolConfirmDialog';
import {
  blobToBase64,
  buildChatModelOptions,
  ChatComposer,
  type ChatComposerHandle,
  type ChatModelOption,
  type ChatSettingsSnapshot,
  type UploadedFileAttachment,
} from '../components/ChatComposer';
import { MessageItem, Message, ToolEvent, SkillEvent } from '../components/MessageItem';
import type { ProcessItem, ProcessItemType } from '../components/ProcessTimeline';
import type { PendingChatMessage } from '../App';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import { appConfirm } from '../utils/appDialogs';
import { uiMeasure, uiTraceInteraction } from '../utils/uiDebug';
import { useDocumentThemeMode } from '../hooks/useDocumentThemeMode';

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
  onExecutionStateChange?: (active: boolean) => void;
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
  welcomeAvatarText?: string;
  welcomeIconVariant?: 'default' | 'avatar';
  welcomeActions?: Array<{ label: string; text?: string; url?: string; icon?: React.ReactNode; color?: string }>;
  contentLayout?: 'default' | 'center-2-3' | 'wide';
  contentWidthPreset?: 'default' | 'narrow';
  allowFileUpload?: boolean;
  messageWorkflowPlacement?: 'top' | 'bottom';
  messageWorkflowVariant?: 'default' | 'compact';
  messageWorkflowEmphasis?: 'default' | 'thoughts-first';
  embeddedTheme?: 'default' | 'dark' | 'auto';
  showWelcomeHeader?: boolean;
  emptyStateComposerPlacement?: 'inline' | 'bottom';
  emptyStateVerticalAlign?: 'center' | 'lower';
}

interface ChatContextUsage {
  success: boolean;
  contextType?: string;
  estimatedTotalTokens?: number;
  estimatedEffectiveTokens?: number;
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

type FixedSessionWarmSnapshot = {
  messages: Message[];
  contextUsage: ChatContextUsage | null;
  capturedAt: number;
};

const FIXED_SESSION_SNAPSHOT_TTL_MS = 30_000;
const fixedSessionWarmSnapshots = new Map<string, FixedSessionWarmSnapshot>();
const fixedSessionInflightLoads = new Map<string, Promise<[unknown[], ChatRuntimeState | null]>>();

function readFixedSessionWarmSnapshot(sessionId: string | null | undefined): FixedSessionWarmSnapshot | null {
  const key = String(sessionId || '').trim();
  if (!key) return null;
  const snapshot = fixedSessionWarmSnapshots.get(key);
  if (!snapshot) return null;
  if ((Date.now() - snapshot.capturedAt) > FIXED_SESSION_SNAPSHOT_TTL_MS) {
    fixedSessionWarmSnapshots.delete(key);
    return null;
  }
  return snapshot;
}

function writeFixedSessionWarmSnapshot(
  sessionId: string | null | undefined,
  next: Partial<FixedSessionWarmSnapshot>,
): void {
  const key = String(sessionId || '').trim();
  if (!key) return;
  const previous = fixedSessionWarmSnapshots.get(key);
  fixedSessionWarmSnapshots.set(key, {
    messages: next.messages ?? previous?.messages ?? [],
    contextUsage: next.contextUsage ?? previous?.contextUsage ?? null,
    capturedAt: Date.now(),
  });
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
const STREAM_CHUNK_DEDUPE_WINDOW_MS = 120;
const STREAM_UPDATE_INTERVAL_MS = 48;
const COMPACT_TOKEN_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

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

function parseMessageTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  const raw = String(value || '').trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return undefined;
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseEmbeddedHttpError(rawValue: string): Partial<ChatErrorEventPayload> {
  const raw = String(rawValue || '').trim();
  if (!raw) return {};

  const rawMarker = '\nRaw response:';
  const rawIndex = raw.indexOf(rawMarker);
  const summary = (rawIndex >= 0 ? raw.slice(0, rawIndex) : raw).trim();
  const detail = (rawIndex >= 0 ? raw.slice(rawIndex + rawMarker.length) : '').trim();
  const statusMatch = summary.match(/\bHTTP\s+(\d{3})\b/i);
  const errorCodeMatch = summary.match(/\[code=([^\]]+)\]/i);
  const messageMatch = summary.match(/\bHTTP\s+\d{3}(?:\s+\[code=[^\]]+\])?\s+(.+)$/i);
  const cleanedMessage = String(messageMatch?.[1] || summary)
    .replace(/^[^:]+failed:\s*/i, '')
    .trim();

  return {
    message: cleanedMessage || 'AI 请求失败',
    raw: detail || raw,
    statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
    errorCode: errorCodeMatch?.[1]?.trim() || undefined,
  };
}

function deriveChatErrorPresentation(payload: ChatErrorEventPayload | string | null | undefined): { formatted: string; notice: string } {
  const embedded = parseEmbeddedHttpError(typeof payload === 'string'
    ? payload
    : `${String(payload?.message || '').trim()}\n${String(payload?.raw || '').trim()}`);
  const data = typeof payload === 'string' ? embedded : { ...embedded, ...(payload || {}) };
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
    ? `AI 源余额不足${data.statusCode ? `（HTTP ${data.statusCode}）` : ''}，请充值或切换有余额的 AI 源。`
    : detectedInvalidKey
      ? `AI 源鉴权失败${data.statusCode ? `（HTTP ${data.statusCode}）` : ''}，请检查 API Key。`
      : detectedRateLimit
        ? `AI 请求被限流${data.statusCode ? `（HTTP ${data.statusCode}）` : ''}，请稍后重试。`
        : isValidationError
          ? '执行校验未通过，请先修复 reviewer 指出的问题。'
          : isExecutionError
            ? '任务执行失败，请检查素材读取、工具调用和文件权限。'
        : `AI 请求失败：${userFacingTitle}${metaParts.length > 0 ? `（${metaParts.join(' / ')}）` : ''}`;

  return {
    formatted: lines.join('\n'),
    notice,
  };
}

export function Chat({
  isActive = true,
  onExecutionStateChange,
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
  welcomeAvatarText,
  welcomeIconVariant = 'default',
  welcomeActions = [],
  contentLayout = 'default',
  contentWidthPreset = 'default',
  allowFileUpload = true,
  messageWorkflowPlacement = 'bottom',
  messageWorkflowVariant = 'compact',
  messageWorkflowEmphasis = 'default',
  embeddedTheme = 'default',
  showWelcomeHeader = true,
  emptyStateComposerPlacement = 'inline',
  emptyStateVerticalAlign = 'center',
}: ChatProps) {
  const debugUi = useCallback((_event: string, _extra?: Record<string, unknown>) => {}, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => fixedSessionId ?? null);
  const [messages, setMessages] = useState<Message[]>(() => (
    readFixedSessionWarmSnapshot(fixedSessionId)?.messages || []
  ));
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
  const [contextUsage, setContextUsage] = useState<ChatContextUsage | null>(() => (
    readFixedSessionWarmSnapshot(fixedSessionId)?.contextUsage || null
  ));
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<UploadedFileAttachment | null>(null);
  const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
  const documentThemeMode = useDocumentThemeMode();

  useEffect(() => {
    onExecutionStateChange?.(isProcessing);
  }, [isProcessing, onExecutionStateChange]);

  useEffect(() => {
    debugUi('processing_state', {
      sessionId: currentSessionIdRef.current,
      isProcessing,
      responseCompleted: responseCompletedRef.current,
    });
  }, [debugUi, isProcessing]);

  useEffect(() => {
    return () => {
      onExecutionStateChange?.(false);
    };
  }, [onExecutionStateChange]);
  const [selectedChatModelKey, setSelectedChatModelKey] = useState('');
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const currentSessionIdRef = useRef<string | null>(fixedSessionId ?? null);
  const chatInstanceIdRef = useRef(
    `chat-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`
  );
  const composerRef = useRef<ChatComposerHandle>(null);
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
  const responseCompletedRef = useRef(false);
  const responseFinalizeSeqRef = useRef(0);
  const pendingResponseFinalizeRef = useRef<{
    ticket: number;
    source: string;
    contentChars: number;
  } | null>(null);
  const suppressComposerFocusUntilRef = useRef(0);
  const [composerSuppressed, setComposerSuppressed] = useState(false);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    if (!fixedSessionId) return;
    if (currentSessionIdRef.current === fixedSessionId) return;
    currentSessionIdRef.current = fixedSessionId;
    setCurrentSessionId(fixedSessionId);
    debugUi('fixed_session:sync', { sessionId: fixedSessionId });
  }, [debugUi, fixedSessionId]);

  useEffect(() => {
    debugUi('instance_mount', {
      chatInstanceId: chatInstanceIdRef.current,
      fixedSessionId: fixedSessionId || null,
      isActive,
    });
    return () => {
      debugUi('instance_unmount', {
        chatInstanceId: chatInstanceIdRef.current,
        fixedSessionId: fixedSessionId || null,
      });
    };
  }, [debugUi, fixedSessionId, isActive]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const runningTimelineCount = Array.isArray(lastMessage?.timeline)
      ? lastMessage.timeline.filter((item) => item.status === 'running').length
      : 0;
    if (pendingResponseFinalizeRef.current) {
      const pending = pendingResponseFinalizeRef.current;
      debugUi('response_end:commit_observed', {
        chatInstanceId: chatInstanceIdRef.current,
        ticket: pending.ticket,
        source: pending.source,
        contentChars: pending.contentChars,
        isProcessing,
        lastIsStreaming: Boolean(lastMessage?.isStreaming),
        lastTimelineRunning: runningTimelineCount,
        messageCount: messages.length,
      });
      pendingResponseFinalizeRef.current = null;
    }
    debugUi('render_state', {
      chatInstanceId: chatInstanceIdRef.current,
      sessionId: currentSessionIdRef.current,
      isActive: isActiveRef.current,
      isProcessing,
      responseCompleted: responseCompletedRef.current,
      messageCount: messages.length,
      lastRole: lastMessage?.role || 'none',
      lastIsStreaming: Boolean(lastMessage?.isStreaming),
      lastTimelineRunning: runningTimelineCount,
      lastContentChars: String(lastMessage?.content || '').length,
      hasConfirmRequest: Boolean(confirmRequest),
      visibleBusy: Boolean(
        isProcessing
          || lastMessage?.isStreaming
          || runningTimelineCount > 0
          || confirmRequest
      ),
    });
  }, [confirmRequest, debugUi, isProcessing, messages]);
  const blurComposer = useCallback((reason: string) => {
    const element = composerRef.current?.getTextarea();
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
      composerRef.current?.focus();
      composerRef.current?.syncHeight();
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
        if (fixedSessionId && sessionId === fixedSessionId) {
          writeFixedSessionWarmSnapshot(sessionId, { contextUsage: usage as ChatContextUsage });
        }
      }
    } catch (error) {
      console.error('Failed to load context usage:', error);
    }
  }, [fixedSessionId]);

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

  const clearPendingAttachment = useCallback(() => {
    setPendingAttachment(null);
    requestAnimationFrame(() => {
      composerRef.current?.syncHeight();
      composerRef.current?.focus();
    });
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

  const ensureChatModelConfig = useCallback(async () => {
    if (selectedChatModel) {
      return {
        apiKey: selectedChatModel.apiKey,
        baseURL: selectedChatModel.baseURL,
        modelName: selectedChatModel.modelName,
      };
    }
    const settings = await uiMeasure('chat', 'ensure_chat_model_config', async () => (
      window.ipcRenderer.getSettings() as Promise<ChatSettingsSnapshot | undefined>
    ));
    const options = buildChatModelOptions(settings);
    if (options.length === 0) {
      return undefined;
    }
    setChatModelOptions(options);
    const resolvedKey = options.find((item) => item.isDefault)?.key || options[0]?.key || '';
    if (resolvedKey) {
      setSelectedChatModelKey((current) => {
        if (current && options.some((item) => item.key === current)) return current;
        return resolvedKey;
      });
    }
    const resolved = options.find((item) => item.key === resolvedKey) || options[0];
    if (!resolved) {
      return undefined;
    }
    return {
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      modelName: resolved.modelName,
    };
  }, [selectedChatModel]);

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
    if (fixedSessionId) return;
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
  }, [fixedSessionId]);

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
    if (!fixedSessionId) {
      void loadChatRooms({ silent: true });
    }

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
    debugUi('dispatch_send:queued', {
      sessionId: payload.sessionId || null,
      chars: payload.message.length,
      hasAttachment: Boolean(payload.attachment),
    });
    const schedule = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0);

    schedule(() => {
      debugUi('dispatch_send:flushed', {
        sessionId: payload.sessionId || null,
        chars: payload.message.length,
      });
      window.ipcRenderer.chat.send(payload);
    });
  }, [debugUi]);

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
      let resolvedModelConfig;
      try {
        resolvedModelConfig = await ensureChatModelConfig();
      } catch (error) {
        console.error('Failed to resolve pending chat model config:', error);
        resolvedModelConfig = undefined;
      }

      // 构建用户消息 - 注意：attachment 和 displayContent 用于 UI 显示
      const processingStartedAt = Date.now();
      const userMsg: Message = {
        id: processingStartedAt.toString(),
        role: 'user',
        content: pendingMessage.content,
        displayContent: pendingMessage.displayContent,
        attachment: pendingMessage.attachment,
        tools: [],
        timeline: []
      };

      const aiPlaceholder: Message = {
        id: (processingStartedAt + 1).toString(),
        role: 'ai',
        content: '',
        tools: [],
        timeline: (
          pendingMessage.taskHints?.forceMultiAgent
        ) ? buildPendingAssistantTimeline('任务已提交') : [],
        isStreaming: true,
        processingStartedAt,
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
        modelConfig: resolvedModelConfig,
        taskHints: pendingMessage.taskHints,
      });

      // 标记消息已消费
      onMessageConsumed?.();
    };

    sendPendingMessage();
  }, [isActive, pendingMessage, isProcessing, onMessageConsumed, fixedSessionId, currentSessionId, buildPendingAssistantTimeline, dispatchChatSend, ensureChatModelConfig]);

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
    if (fixedSessionId && sessionId === fixedSessionId) {
      const warm = readFixedSessionWarmSnapshot(sessionId);
      if (warm) {
        setMessages(warm.messages);
        if (warm.contextUsage) {
          setContextUsage(warm.contextUsage);
        }
        debugUi('fixed_session:warm_restore', {
          sessionId,
          messageCount: warm.messages.length,
        });
      }
    }
    const requestId = ++selectSessionRequestRef.current;
    const mutationVersionAtStart = localMessageMutationRef.current;
    try {
      const shouldRecoverRuntime = coldRecoveryPendingRef.current;
      coldRecoveryPendingRef.current = false;
      debugUi('select_session:start', { sessionId, shouldRecoverRuntime });
      const [history, runtimeStateRaw] = await uiMeasure('chat', 'select_session:load', async () => {
        if (fixedSessionId && sessionId === fixedSessionId) {
          let inflight = fixedSessionInflightLoads.get(sessionId);
          if (!inflight) {
            inflight = Promise.all([
              window.ipcRenderer.chat.getMessages(sessionId),
              shouldRecoverRuntime
                ? window.ipcRenderer.chat.getRuntimeState(sessionId)
                : Promise.resolve(null),
            ]) as Promise<[unknown[], ChatRuntimeState | null]>;
            fixedSessionInflightLoads.set(sessionId, inflight);
            void inflight.finally(() => {
              if (fixedSessionInflightLoads.get(sessionId) === inflight) {
                fixedSessionInflightLoads.delete(sessionId);
              }
            });
          }
          return inflight;
        }
        return Promise.all([
          window.ipcRenderer.chat.getMessages(sessionId),
          shouldRecoverRuntime
            ? window.ipcRenderer.chat.getRuntimeState(sessionId)
            : Promise.resolve(null),
        ]) as Promise<[unknown[], ChatRuntimeState | null]>;
      }, { sessionId, shouldRecoverRuntime });
      if (requestId !== selectSessionRequestRef.current) {
        return;
      }
      if (localMessageMutationRef.current !== mutationVersionAtStart) {
        return;
      }
      const runtimeState = runtimeStateRaw as ChatRuntimeState;

      // Convert DB messages to UI messages
      let lastUserCreatedAt: number | undefined;
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

        const role = msg.role === 'user' ? 'user' : 'ai';
        const createdAt = parseMessageTimestampMs(msg.createdAt ?? msg.created_at ?? msg.timestamp);
        const processingStartedAt = role === 'ai' ? (lastUserCreatedAt ?? createdAt) : undefined;
        const processingFinishedAt = role === 'ai' ? createdAt : undefined;

        if (role === 'user') {
          lastUserCreatedAt = createdAt;
        }

        return {
          id: msg.id,
          role, // Simplified mapping
          content: msg.content,
          displayContent: msg.display_content || undefined,
          attachment: attachment,
          tools: [], // History tools not fully reconstructed in this simple view yet
          timeline: [], // History timeline not fully reconstructed
          isStreaming: false,
          processingStartedAt,
          processingFinishedAt,
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
            processingStartedAt: lastUserCreatedAt ?? Date.now(),
          });
        } else {
          uiMessages[uiMessages.length - 1] = {
            ...lastMsg,
            content: restoredContent || lastMsg.content || '',
            isStreaming: true,
            processingStartedAt: lastMsg.processingStartedAt ?? lastUserCreatedAt ?? Date.now(),
            processingFinishedAt: undefined,
          };
        }
        shouldSetProcessing = true;
      }

      setMessages(uiMessages);
      if (fixedSessionId && sessionId === fixedSessionId) {
        writeFixedSessionWarmSnapshot(sessionId, { messages: uiMessages });
      }
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
    if (!isActive || fixedSessionId) return;
    const handleSpaceChanged = () => {
      setShowRoomPicker(false);
      setSelectionMenu(prev => ({ ...prev, visible: false }));
      void loadChatRooms({ silent: true });
    };
    window.ipcRenderer.on('space:changed', handleSpaceChanged);
    return () => {
      window.ipcRenderer.off('space:changed', handleSpaceChanged);
    };
  }, [fixedSessionId, isActive, loadChatRooms]);

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
      if (name === 'thinking') {
        responseCompletedRef.current = false;
      }
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

    const handleResponseEnd = (
      _: unknown,
      payload?: { content?: string },
      source: 'checkpoint' | 'runtime_done' | 'unknown' = 'unknown',
    ) => {
      if (!isActiveRef.current) {
        if (import.meta.env.DEV) {
          console.warn('[ui][chat] inactive page received response end');
        }
        return;
      }
      responseCompletedRef.current = true;
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
      const finalizeTicket = ++responseFinalizeSeqRef.current;
      pendingResponseFinalizeRef.current = {
        ticket: finalizeTicket,
        source,
        contentChars: finalContent.length,
      };
      debugUi('response_end:transition_scheduled', {
        chatInstanceId: chatInstanceIdRef.current,
        sessionId: currentSessionIdRef.current,
        ticket: finalizeTicket,
        source,
        contentChars: finalContent.length,
      });
      flushSync(() => {
        debugUi('response_end:transition_run', {
          chatInstanceId: chatInstanceIdRef.current,
          sessionId: currentSessionIdRef.current,
          ticket: finalizeTicket,
          source,
        });
        setIsProcessing(false);
        setErrorNotice(null);
        debugUi('response_end:state_calls_issued', {
          chatInstanceId: chatInstanceIdRef.current,
          sessionId: currentSessionIdRef.current,
          ticket: finalizeTicket,
          source,
        });
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          debugUi('response_end:set_messages', {
            chatInstanceId: chatInstanceIdRef.current,
            sessionId: currentSessionIdRef.current,
            ticket: finalizeTicket,
            source,
            prevCount: prev.length,
            lastRole: lastMsg?.role || 'none',
            lastIsStreaming: Boolean(lastMsg?.isStreaming),
            lastTimelineRunning: Array.isArray(lastMsg?.timeline)
              ? lastMsg.timeline.filter((item) => item.status === 'running').length
              : 0,
            finalContentChars: finalContent.length,
          });
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
            return [...prev.slice(0, -1), {
              ...lastMsg,
              content: mergedContent,
              timeline,
              isStreaming: false,
              processingFinishedAt: now,
            }];
          }
          if (finalContent) {
            const now = Date.now();
            return [
              ...prev,
              {
                id: now.toString(),
                role: 'ai',
                content: finalContent,
                tools: [],
                timeline: [],
                isStreaming: false,
                processingStartedAt: now,
                processingFinishedAt: now,
              }
            ];
          }
          return prev;
        });
        queueMicrotask(() => {
          debugUi('response_end:microtask_after_transition', {
            chatInstanceId: chatInstanceIdRef.current,
            sessionId: currentSessionIdRef.current,
            ticket: finalizeTicket,
            source,
            responseCompleted: responseCompletedRef.current,
          });
        });
        requestAnimationFrame(() => {
          debugUi('response_end:raf_after_transition', {
            chatInstanceId: chatInstanceIdRef.current,
            sessionId: currentSessionIdRef.current,
            ticket: finalizeTicket,
            source,
            responseCompleted: responseCompletedRef.current,
          });
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
      flushSync(() => {
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
          return [...prev.slice(0, -1), { ...lastMsg, timeline, isStreaming: false, processingFinishedAt: now }];
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
      flushSync(() => {
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
            return [...prev.slice(0, -1), {
              ...lastMsg,
              content: formatted,
              timeline,
              isStreaming: false,
              processingFinishedAt: now,
            }];
          }
          const now = Date.now();
          return [
            ...prev,
            {
              id: now.toString(),
              role: 'ai',
              content: formatted,
              tools: [],
              timeline: [],
              isStreaming: false,
              processingStartedAt: now,
              processingFinishedAt: now,
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
      onChatDone: ({ status, content, reason }) => {
        debugUi('runtime_done:received', {
          sessionId: currentSessionIdRef.current,
          status,
          reason,
          contentChars: content.length,
          responseCompleted: responseCompletedRef.current,
        });
        if (status === 'completed' && !responseCompletedRef.current) {
          handleResponseEnd(null, { content }, 'runtime_done');
        }
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
        debugUi('checkpoint_response_end:received', {
          sessionId: currentSessionIdRef.current,
          contentChars: content.length,
          responseCompleted: responseCompletedRef.current,
        });
        handleResponseEnd(null, { content }, 'checkpoint');
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
        setErrorNotice(null);
        setPendingAttachment(result.attachment);
        requestAnimationFrame(() => {
          composerRef.current?.syncHeight();
          composerRef.current?.focus();
        });
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
        composerRef.current?.focus();
        composerRef.current?.syncHeight();
      });
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranscribingAudio(false);
    }
  }, []);

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

  const sendMessage = async (content: string, attachment?: UploadedFileAttachment) => {
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
    const processingStartedAt = Date.now();
    const userMsg: Message = {
      id: processingStartedAt.toString(),
      role: 'user',
      content: normalizedContent || displayText,
      displayContent: displayText,
      attachment: attachment as unknown as Message['attachment'],
      tools: [],
      timeline: []
    };

    const aiPlaceholder: Message = {
      id: (processingStartedAt + 1).toString(),
      role: 'ai',
      content: '',
      tools: [],
      timeline: [],
      isStreaming: true,
      processingStartedAt,
    };

    localMessageMutationRef.current += 1;
    setMessages(prev => [...prev, userMsg, aiPlaceholder]);
    setInput('');
    setPendingAttachment(null);
    setIsProcessing(true);

    let resolvedModelConfig;
    try {
      resolvedModelConfig = await ensureChatModelConfig();
    } catch (error) {
      console.error('Failed to resolve chat model config:', error);
      resolvedModelConfig = undefined;
    }

    dispatchChatSend({
      sessionId: currentSessionId || undefined,
      message: normalizedContent || displayText,
      displayContent: displayText,
      attachment,
      modelConfig: resolvedModelConfig || getChatModelConfig(),
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
      return COMPACT_TOKEN_FORMATTER.format(safe);
    }
    return `${safe}`;
  };

  const compactRatio = Math.max(0, Number(contextUsage?.compactRatio || 0));
  const contextUsedPercentRaw = Math.max(0, Math.min(100, compactRatio * 100));
  const contextUsedPercentDisplay = contextUsedPercentRaw < 10
    ? contextUsedPercentRaw.toFixed(1)
    : `${Math.round(contextUsedPercentRaw)}`;
  const contextBadgeClass = contextUsedPercentRaw >= 90
    ? 'text-red-600 border-red-500/40 bg-red-500/10'
    : contextUsedPercentRaw >= 70
      ? 'text-amber-600 border-amber-500/40 bg-amber-500/10'
      : 'text-text-secondary border-border bg-surface-secondary/90';
  const compactThreshold = Math.max(0, Math.round(contextUsage?.compactThreshold || 0));
  const estimatedEffectiveTokens = Math.max(
    0,
    Math.round(contextUsage?.estimatedEffectiveTokens ?? contextUsage?.estimatedTotalTokens ?? 0),
  );
  const estimatedTotalTokens = Math.max(0, Math.round(contextUsage?.estimatedTotalTokens || 0));
  const contextRingRadius = 17;
  const contextRingCircumference = 2 * Math.PI * contextRingRadius;
  const contextUsageRingOffset = contextRingCircumference * (1 - Math.max(0, Math.min(1, compactRatio)));
  const resolvedEmbeddedTheme = embeddedTheme === 'auto'
    ? (documentThemeMode === 'dark' ? 'dark' : 'default')
    : embeddedTheme;
  const darkEmbedded = resolvedEmbeddedTheme === 'dark';
  const composerTheme = darkEmbedded ? 'dark' : 'default';
  const inputAreaShellClass = darkEmbedded
    ? 'bg-transparent pb-4 pt-2 md:pb-5'
    : 'bg-surface-primary pb-4 pt-2 md:pb-5';
  const shortcutChipClass = darkEmbedded
    ? 'flex-shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/62 transition-colors hover:border-white/20 hover:text-white disabled:opacity-50'
    : 'flex-shrink-0 rounded-full border border-border bg-surface-primary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent-primary/30 hover:text-accent-primary disabled:opacity-50';
  const composerContextUsageButtonClass = darkEmbedded
    ? 'peer relative flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-white/70 transition-opacity duration-200 hover:text-white/92 focus:outline-none'
    : 'peer relative flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-[#65707d] transition-opacity duration-200 hover:text-[#4c5662] focus:outline-none';
  const composerContextUsageTrackClass = darkEmbedded ? 'text-white/14' : 'text-[#ddd8cf]';
  const composerContextUsageToneClass = contextUsedPercentRaw >= 90
    ? 'text-red-500'
    : contextUsedPercentRaw >= 70
      ? 'text-amber-500'
      : darkEmbedded
        ? 'text-white/78'
        : 'text-[#556170]';
  const composerContextUsageTooltipClass = darkEmbedded
    ? 'rounded-[24px] border border-white/10 bg-[#161a1f]/96 px-5 py-4 text-[13px] font-medium tracking-[0.01em] text-white/86 shadow-[0_18px_60px_rgba(0,0,0,0.4)] backdrop-blur-xl'
    : 'rounded-[24px] border border-[#ebe7dc] bg-[#fcfbf7]/96 px-5 py-4 text-[13px] font-medium tracking-[0.01em] text-[#2f2b26] shadow-[0_18px_60px_rgba(36,32,24,0.12)] backdrop-blur-xl';
  const composerContextUsageArrowClass = darkEmbedded
    ? 'border-b border-r border-white/10 bg-[#161a1f]/96'
    : 'border-b border-r border-[#ebe7dc] bg-[#fcfbf7]/96';
  const showComposerContextUsageIndicator = Boolean(
    fixedSessionId &&
    currentSessionId &&
    contextUsage?.success &&
    fixedSessionContextIndicatorMode !== 'none'
  );
  const composerContextUsageLabel = `${contextUsedPercentDisplay}% · ${formatTokenLabel(estimatedEffectiveTokens)} / ${formatTokenLabel(compactThreshold)} 上下文已使用`;
  const dockedEmptyState = isEmptySession && emptyStateComposerPlacement === 'bottom';
  const composerContextUsageIndicator = showComposerContextUsageIndicator ? (
    <div className="relative">
      <button
        type="button"
        className={composerContextUsageButtonClass}
        aria-label={composerContextUsageLabel}
      >
        <svg className="h-7 w-7 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
          <circle
            cx="22"
            cy="22"
            r={contextRingRadius}
            fill="transparent"
            stroke="currentColor"
            strokeWidth="3"
            className={composerContextUsageTrackClass}
          />
          <circle
            cx="22"
            cy="22"
            r={contextRingRadius}
            fill="transparent"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            className={composerContextUsageToneClass}
            strokeDasharray={contextRingCircumference}
            strokeDashoffset={contextUsageRingOffset}
          />
        </svg>
      </button>
      <div className={clsx(
        'pointer-events-none absolute bottom-full right-0 z-30 mb-3 w-72 max-w-[calc(100vw-2rem)] translate-y-1 opacity-0 transition-all duration-200 ease-out peer-hover:translate-y-0 peer-hover:opacity-100',
        composerContextUsageTooltipClass
      )}>
        {composerContextUsageLabel}
        <div className={clsx('absolute -bottom-1.5 right-[14px] h-3 w-3 rotate-45', composerContextUsageArrowClass)} />
      </div>
    </div>
  ) : null;

  const renderComposer = (
    source: 'empty' | 'composer',
    variant: 'empty' | 'main',
    placeholder: string,
    options?: {
      className?: string;
      showContextUsage?: boolean;
      showCancelWhenBusy?: boolean;
    },
  ) => (
    <>
      <ToolConfirmDialog request={confirmRequest} onConfirm={handleConfirmTool} onCancel={handleCancelTool} />
      <ChatComposer
        ref={composerRef}
        theme={composerTheme}
        variant={variant}
        className={options?.className}
        value={input}
        onValueChange={setInput}
        onSubmit={() => sendMessage(input, pendingAttachment || undefined)}
        placeholder={placeholder}
        attachment={pendingAttachment}
        onPickAttachment={allowFileUpload ? pickAttachment : undefined}
        onClearAttachment={clearPendingAttachment}
        modelOptions={chatModelOptions}
        selectedModelKey={selectedChatModelKey}
        onSelectedModelKeyChange={setSelectedChatModelKey}
        isBusy={isProcessing}
        audioState={isTranscribingAudio ? 'transcribing' : isRecordingAudio ? 'recording' : 'idle'}
        onAudioAction={handleAudioInput}
        onCancel={handleCancel}
        showCancelWhenBusy={options?.showCancelWhenBusy}
        trailingContent={options?.showContextUsage ? composerContextUsageIndicator : null}
        onFocus={() => handleComposerFocus(source)}
        suppressed={composerSuppressed}
        onResumeFromSuppressed={() => resumeComposerFocus(source)}
      />
    </>
  );

  const welcomeHeaderBlock = showWelcomeHeader ? (
    <>
      <div className="flex justify-center">
        {welcomeIconSrc ? (
          welcomeIconVariant === 'avatar' ? (
            <div className={clsx(
              'flex items-center justify-center overflow-hidden border shadow-lg',
              darkEmbedded ? 'border-white/10 bg-white/5' : 'border-border bg-surface-primary',
              'h-24 w-24 rounded-[28px]',
            )}>
              <img
                src={welcomeIconSrc}
                alt={welcomeTitle}
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <img
              src={welcomeIconSrc}
              alt={welcomeTitle}
              className="w-24 h-24 object-contain"
            />
          )
        ) : welcomeAvatarText ? (
          <div className={clsx(
            'flex h-24 w-24 items-center justify-center overflow-hidden rounded-[28px] border text-[34px] font-semibold shadow-lg',
            darkEmbedded ? 'border-white/10 bg-white/5 text-white' : 'border-border bg-surface-primary text-text-primary',
          )}>
            {welcomeAvatarText}
          </div>
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

  const handleWelcomeAction = useCallback(async (action: { label: string; text?: string; url?: string }) => {
    if (action.url) {
      try {
        await window.ipcRenderer.invoke('app:open-path', { path: action.url });
      } catch (error) {
        console.error('Failed to open welcome action url:', error);
      }
      return;
    }
    if (action.text) {
      sendMessage(action.text);
    }
  }, [sendMessage]);

  const welcomeActionsBlock = welcomeActions && welcomeActions.length > 0 ? (
    <div className="flex items-center justify-center gap-6">
      {welcomeActions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => void handleWelcomeAction(action)}
          className={clsx(
            'group inline-flex items-center justify-center h-[36px] min-w-[36px] max-w-[36px] px-0 rounded-full border border-black/[0.04] bg-white/70 cursor-pointer overflow-hidden whitespace-nowrap transition-[max-width,padding,background-color,border-color,box-shadow] duration-500 ease-in-out hover:max-w-[200px] hover:px-4 hover:justify-start hover:gap-2 hover:bg-white hover:border-accent-primary/20 hover:shadow-md active:scale-95',
            darkEmbedded && 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20'
          )}
          aria-label={action.label}
        >
          <div className={clsx(
            'flex-shrink-0 flex items-center justify-center w-5 h-5 transition-colors duration-300',
            action.color || (darkEmbedded ? 'text-white/60' : 'text-text-tertiary group-hover:text-accent-primary')
          )}>
            {action.icon || <Sparkles className="w-4 h-4" />}
          </div>
          <span className={clsx(
            'opacity-0 max-w-0 overflow-hidden text-[13px] font-bold group-hover:opacity-100 group-hover:max-w-[150px] transition-all duration-500 ease-in-out',
            darkEmbedded ? 'text-white/72' : 'text-text-secondary',
          )}>
            {action.label}
          </span>
        </button>
      ))}
    </div>
  ) : null;

  const emptyComposerForm = renderComposer(
    'empty',
    'empty',
    '问我任何问题，使用 @ 引用文件，/ 执行指令...',
    { showContextUsage: true, showCancelWhenBusy: false },
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
                上下文 {contextUsedPercentDisplay}% · {estimatedEffectiveTokens}/{contextUsage.compactThreshold || 0} tokens · compact {contextUsage.compactRounds || 0} 次
              </div>
            )}
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
          <div className={clsx(
            'flex-1 flex flex-col items-center justify-center px-6 overflow-y-auto relative',
            emptyStateVerticalAlign === 'lower' && 'pt-16'
          )}>
            <div className={clsx('text-center space-y-6 w-full max-w-2xl mx-auto', emptySessionWidthClass)}>
              {/* Logo/Icon */}
              {showWelcomeHeader ? (
                <>
                  {welcomeHeaderBlock}
                </>
              ) : null}
              {showWelcomeShortcuts && welcomeShortcuts.length > 0 && (
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
              )}

              {/* 居中的输入框 (Codex Style) */}
              {renderComposer('empty', 'empty', '问我任何问题，使用 @ 引用文件，/ 执行指令...', {
                className: 'mt-10',
                showCancelWhenBusy: false,
              })}
            </div>
            {/* 放置在最底部的动态按钮区 - 使用绝对定位以不干扰居中布局 */}
            <div className="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none">
              <div className="pointer-events-auto">
                {welcomeActionsBlock}
              </div>
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
                    {welcomeActionsBlock}
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
                  <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-3 text-sm text-red-700 shadow-sm dark:text-red-300">
                    <div className="font-medium">本次 AI 请求失败</div>
                    <div className="mt-1 text-xs leading-5 text-red-700/85 dark:text-red-300/90">{errorNotice}</div>
                  </div>
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

                {renderComposer('composer', 'main', '发送消息...', {
                  showContextUsage: true,
                  showCancelWhenBusy: true,
                })}
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
