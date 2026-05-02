import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { Trash2, Plus, MessageSquare, X, PanelLeftClose, PanelLeft, Sparkles, Edit } from 'lucide-react';
import { clsx } from 'clsx';
import { supportsAttachmentKindDirectInput } from '../../shared/modelCapabilities';
import {
  CliEscalationDialog,
  type CliEscalationRequestModel,
  type CliEscalationScope,
} from '../components/CliEscalationDialog';
import { ToolConfirmDialog } from '../components/ToolConfirmDialog';
import {
  buildChatModelOptions,
  ChatComposer,
  type ChatComposerHandle,
  type ChatKnowledgeMentionOption,
  type ChatMemberMentionOption,
  type ChatModelOption,
  type ChatSettingsSnapshot,
  type UploadedFileAttachment,
} from '../components/ChatComposer';
import {
  MessageItem,
  Message,
  ToolEvent,
  SkillEvent,
  type ChatMessageMemberActor,
  type ChatMessageLinkRenderMode,
  type ChatMessageLinkTarget,
} from '../components/MessageItem';
import type { ProcessItem, ProcessItemType } from '../components/ProcessTimeline';
import type { PendingChatMessage } from '../App';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { type AudioRecordingClip } from '../features/audio-input/audioInput';
import { resolveUsableTranscript } from '../features/audio-input/transcriptionResult';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { loadAttachmentDraft, saveAttachmentDraft } from '../features/chat/attachmentDraftStore';
import { subscribeRuntimeEventStream, type ToolConfirmRequestPayload } from '../runtime/runtimeEventStream';
import { REDBOX_NAVIGATE_EVENT } from '../notifications/types';
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

interface AdvisorMentionRecord {
  id: string;
  name?: string;
  avatar?: string;
  personality?: string;
}

interface KnowledgeMentionCatalogRecord {
  itemId?: string;
  id?: string;
  kind?: string;
  noteType?: string;
  captureKind?: string;
  title?: string;
  sourceUrl?: string;
  folderPath?: string;
  rootPath?: string;
  coverUrl?: string;
  thumbnailUrl?: string;
  previewText?: string;
  updatedAt?: string;
  tags?: string[];
  fileCount?: number;
  hasTranscript?: boolean;
}

interface KnowledgeMentionListPageResponse {
  items?: KnowledgeMentionCatalogRecord[];
  nextCursor?: string | null;
  total?: number;
}

function memberActorFromMessageMetadata(metadata: unknown): ChatMessageMemberActor | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const object = metadata as Record<string, unknown>;
  const actor = object.replyActor && typeof object.replyActor === 'object'
    ? object.replyActor as Record<string, unknown>
    : object.activeSpeaker && typeof object.activeSpeaker === 'object'
      ? object.activeSpeaker as Record<string, unknown>
      : null;
  if (!actor) return undefined;
  if (String(actor.type || '').trim() && String(actor.type || '').trim() !== 'member') return undefined;
  const memberId = String(actor.memberId || actor.speakerId || '').trim();
  const displayName = String(actor.displayName || '').trim();
  if (!memberId || !displayName) return undefined;
  return {
    type: 'member',
    memberId,
    displayName,
    avatar: String(actor.avatar || '').trim() || undefined,
    memberSkillRef: String(actor.memberSkillRef || '').trim() || undefined,
  };
}

function normalizeKnowledgeMentionRecord(item: KnowledgeMentionCatalogRecord): ChatKnowledgeMentionOption | null {
  const id = String(item.itemId || item.id || '').trim();
  if (!id) return null;
  const sourceKind = String(item.kind || item.captureKind || item.noteType || '').trim();
  return {
    id,
    title: String(item.title || '未命名内容').trim(),
    sourceKind,
    summary: String(item.previewText || '').trim() || undefined,
    cover: String(item.coverUrl || item.thumbnailUrl || '').trim() || undefined,
    sourceUrl: String(item.sourceUrl || '').trim() || undefined,
    folderPath: String(item.folderPath || '').trim() || undefined,
    rootPath: String(item.rootPath || '').trim() || undefined,
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
    updatedAt: String(item.updatedAt || '').trim() || undefined,
    fileCount: typeof item.fileCount === 'number' ? item.fileCount : undefined,
    hasTranscript: Boolean(item.hasTranscript),
  };
}

function knowledgeReferencesFromMessageMetadata(metadata: unknown): ChatKnowledgeMentionOption[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const object = metadata as Record<string, unknown>;
  const rawReferences = Array.isArray(object.explicitKnowledgeRefs)
    ? object.explicitKnowledgeRefs
    : Array.isArray(object.references)
      ? object.references.filter((item) => (
        item
        && typeof item === 'object'
        && String((item as Record<string, unknown>).type || '').trim() === 'knowledge'
      ))
      : [];
  return rawReferences
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const id = String(item.knowledgeId || item.id || '').trim();
      if (!id) return null;
      const reference: ChatKnowledgeMentionOption = {
        id,
        title: String(item.title || '未命名内容').trim(),
        sourceKind: String(item.sourceKind || '').trim() || undefined,
        summary: String(item.summary || '').trim() || undefined,
        cover: String(item.cover || '').trim() || undefined,
        sourceUrl: String(item.sourceUrl || '').trim() || undefined,
        folderPath: String(item.folderPath || '').trim() || undefined,
        rootPath: String(item.rootPath || '').trim() || undefined,
        tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
        updatedAt: String(item.updatedAt || '').trim() || undefined,
        fileCount: typeof item.fileCount === 'number' ? item.fileCount : undefined,
        hasTranscript: Boolean(item.hasTranscript),
      };
      return reference;
    })
    .filter((item): item is ChatKnowledgeMentionOption => Boolean(item));
}

function knowledgeReferencePrimaryPath(item: ChatKnowledgeMentionOption): string {
  return String(item.rootPath || item.folderPath || '').trim();
}

function buildKnowledgeReferenceRuntimeContext(items: ChatKnowledgeMentionOption[]): string {
  const references = items.filter((item) => item.id);
  if (references.length === 0) return '';
  const lines = [
    '本轮用户明确附带了以下知识库内容。回答时必须优先基于这些附件，不要沿用上一轮引用的知识库内容。',
    '如果需要核对事实，先读取 primaryPath 指向的目录；笔记/视频类内容优先列目录、读取 meta.json，再读取 transcript/content/description 等文本文件。',
  ];
  references.slice(0, 12).forEach((item, index) => {
    const primaryPath = knowledgeReferencePrimaryPath(item);
    lines.push(`${index + 1}. title: ${item.title || '未命名内容'}; id: ${item.id}; kind: ${item.sourceKind || 'knowledge'}`);
    if (primaryPath) {
      lines.push(`   primaryPath: ${primaryPath}`);
    }
    if (item.folderPath || item.rootPath) {
      lines.push(`   folderPath: ${item.folderPath || ''}; rootPath: ${item.rootPath || ''}`);
    }
    if (item.sourceUrl) {
      lines.push(`   sourceUrl: ${item.sourceUrl}`);
    }
    if (item.summary) {
      lines.push(`   summary: ${item.summary.slice(0, 700)}`);
    }
  });
  return lines.join('\n');
}

export interface ChatShortcut {
  label: string;
  text: string;
  action?: 'send' | 'inject';
}

export interface ChatShortcutContext {
  input: string;
  hasInput: boolean;
  attachment: UploadedFileAttachment | null;
  selectedMemberMention: ChatMemberMentionOption | null;
  selectedKnowledgeMentions: ChatKnowledgeMentionOption[];
}

export type ChatShortcutProvider = ChatShortcut[] | ((context: ChatShortcutContext) => ChatShortcut[]);

interface ChatDispatchOverridePayload {
  sessionId?: string;
  message: string;
  displayContent: string;
  attachment?: Message['attachment'];
  knowledgeReferences?: ChatKnowledgeMentionOption[];
  taskHints?: unknown;
}

interface ChatDispatchOverrideResult {
  handled: boolean;
  assistantContent?: string;
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
  navigationAction?: { action: 'new'; nonce: number } | null;
  onNavigationActionConsumed?: () => void;
  fixedSessionId?: string | null;
  fixedSessionDraft?: boolean;
  onEnsureSessionForSend?: () => Promise<string | null>;
  showClearButton?: boolean;
  fixedSessionBannerText?: string;
  shortcuts?: ChatShortcutProvider;
  welcomeShortcuts?: ChatShortcutProvider;
  showWelcomeShortcuts?: boolean;
  showComposerShortcuts?: boolean;
  fixedSessionContextIndicatorMode?: 'top' | 'corner-ring' | 'none';
  welcomeTitle?: string;
  welcomeSubtitle?: string;
  welcomeIconSrc?: string;
  welcomeAvatarText?: string;
  welcomeIconVariant?: 'default' | 'avatar';
  welcomeIconAccessory?: React.ReactNode;
  welcomeActions?: Array<{ label: string; text?: string; url?: string; onClick?: () => void; icon?: React.ReactNode; color?: string }>;
  contentLayout?: 'default' | 'center-2-3' | 'wide';
  contentWidthPreset?: 'default' | 'narrow';
  allowFileUpload?: boolean;
  attachmentPreviewMode?: 'default' | 'compact-status';
  messageWorkflowPlacement?: 'top' | 'bottom';
  messageWorkflowVariant?: 'default' | 'compact';
  messageWorkflowEmphasis?: 'default' | 'thoughts-first';
  messageWorkflowDisplayMode?: 'all' | 'thoughts-only';
  messageWorkflowAutoHideWhenComplete?: boolean;
  messageWorkflowFailureTone?: 'danger' | 'neutral';
  embeddedTheme?: 'default' | 'dark' | 'auto';
  showWelcomeHeader?: boolean;
  emptyStateComposerPlacement?: 'inline' | 'bottom';
  emptyStateVerticalAlign?: 'center' | 'lower';
  showComposer?: boolean;
  showMessageAttachments?: boolean;
  collapseEmptyFixedSession?: boolean;
  fixedSessionTaskHints?: unknown;
  messageLinkRenderMode?: ChatMessageLinkRenderMode;
  onMessageLinkPreview?: (target: ChatMessageLinkTarget) => void;
  activePreviewHref?: string | null;
  inlineSidePanel?: React.ReactNode;
  keepComposerInputActive?: boolean;
  messageListHeader?: React.ReactNode;
  placeholder?: string;
  fixedMemberMention?: ChatMemberMentionOption | null;
  onDispatchOverride?: (payload: ChatDispatchOverridePayload) => Promise<ChatDispatchOverrideResult | boolean>;
  onSessionActivity?: (sessionId: string, updatedAt: string) => void;
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
  title?: string;
  raw?: string;
  detail?: string;
  hint?: string;
  statusCode?: number;
  httpStatus?: number;
  errorCode?: string;
  category?: string;
  layer?: string;
  retryable?: boolean;
  transportMode?: string;
  modelName?: string;
}

interface StructuredChatErrorNotice {
  title: string;
  hint?: string;
  detail?: string;
  metaParts?: string[];
  action?: {
    label: string;
    target: 'settings-login';
  };
}

function stripTransientAttachmentPreview(
  attachment?: UploadedFileAttachment,
): UploadedFileAttachment | undefined {
  if (!attachment) return undefined;
  const { thumbnailDataUrl: _thumbnailDataUrl, ...persisted } = attachment;
  return persisted;
}

function applyAttachmentDeliveryMode(
  attachment: UploadedFileAttachment | undefined,
  modelName?: string,
): UploadedFileAttachment | undefined {
  if (!attachment) return undefined;
  const directInput = Boolean(
    modelName
    && supportsAttachmentKindDirectInput(modelName, String(attachment.kind || '').trim().toLowerCase()),
  );
  return {
    ...attachment,
    deliveryMode: directInput ? 'direct-input' : 'tool-read',
  };
}

type FixedSessionWarmSnapshot = {
  messages: Message[];
  contextUsage: ChatContextUsage | null;
  capturedAt: number;
};

const FIXED_SESSION_SNAPSHOT_TTL_MS = 30_000;
const fixedSessionWarmSnapshots = new Map<string, FixedSessionWarmSnapshot>();
const fixedSessionInflightLoads = new Map<string, Promise<[unknown[], ChatRuntimeState | null]>>();

function resolveChatShortcutProvider(
  provider: ChatShortcutProvider | undefined,
  fallback: ChatShortcut[],
  context: ChatShortcutContext,
): ChatShortcut[] {
  return provider ? (typeof provider === 'function' ? provider(context) : provider) : fallback;
}

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
const STREAM_UPDATE_INTERVAL_MS = 72;
const CLI_LOG_PREVIEW_LIMIT = 4000;
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

function appendCliLogPreview(currentPreview: string, incomingChunk: string): string {
  const current = String(currentPreview || '');
  const incoming = String(incomingChunk || '');
  if (!incoming) return current;
  if (!current) {
    return incoming.slice(-CLI_LOG_PREVIEW_LIMIT);
  }
  if (incoming.startsWith(current)) {
    return incoming.slice(-CLI_LOG_PREVIEW_LIMIT);
  }
  if (current.endsWith(incoming)) {
    return current.slice(-CLI_LOG_PREVIEW_LIMIT);
  }
  return `${current}${current.endsWith('\n') ? '' : '\n'}${incoming}`.slice(-CLI_LOG_PREVIEW_LIMIT);
}

function findLatestTimelineItemIndex(
  timeline: ProcessItem[],
  predicate: (item: ProcessItem) => boolean,
): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (predicate(timeline[index])) {
      return index;
    }
  }
  return -1;
}

function normalizeCliProcessStatus(status: string): ProcessItem['status'] {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized || normalized === 'pending' || normalized === 'running' || normalized === 'waiting-approval') {
    return 'running';
  }
  if (
    normalized === 'completed'
    || normalized === 'success'
    || normalized === 'resolved'
    || normalized === 'approved'
  ) {
    return 'done';
  }
  return 'failed';
}

function isThinkingMessage(message: Message | null | undefined): boolean {
  return Boolean(message && message.role === 'ai' && message.messageType === 'thinking');
}

function isAssistantReplyMessage(message: Message | null | undefined): boolean {
  return Boolean(message && message.role === 'ai' && message.messageType !== 'thinking');
}

function findLastAssistantReplyIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isAssistantReplyMessage(messages[index])) {
      return index;
    }
  }
  return -1;
}

function findLastRunningThinkingIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isThinkingMessage(message) && message.isStreaming) {
      return index;
    }
  }
  return -1;
}

function findLastRunningTimelineThoughtIndex(timeline: ProcessItem[]): number {
  return findLatestTimelineItemIndex(
    timeline,
    (item) => item.type === 'thought' && item.status === 'running',
  );
}

function hasCommittedAssistantReply(messages: Message[]): boolean {
  const lastReplyIndex = findLastAssistantReplyIndex(messages);
  if (lastReplyIndex === -1) return false;
  const message = messages[lastReplyIndex];
  return Boolean(
    message
    && message.role === 'ai'
    && !message.isStreaming
    && String(message.content || '').trim().length > 0
  );
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

function normalizeChatErrorNotice(payload: ChatErrorEventPayload | string | null | undefined): StructuredChatErrorNotice {
  const embedded = parseEmbeddedHttpError(typeof payload === 'string'
    ? payload
    : `${String(payload?.message || '').trim()}\n${String(payload?.raw || '').trim()}`);
  const data = typeof payload === 'string' ? embedded : { ...embedded, ...(payload || {}) };
  const title = String(data.title || data.message || '').trim() || '请求失败';
  const normalizedTitle = title.replace(/\s+/g, '');
  const detail = String(data.detail || data.raw || '').trim();
  const hint = String(data.hint || '').trim();
  const layer = String(data.layer || data.category || '').trim();
  const metaParts = [
    (data.httpStatus || data.statusCode) ? `HTTP ${data.httpStatus || data.statusCode}` : '',
    data.errorCode ? String(data.errorCode) : '',
    layer || '',
    data.transportMode ? `transport:${String(data.transportMode)}` : '',
    data.retryable ? '可重试' : '',
  ].filter(Boolean);
  return {
    title,
    hint: hint || undefined,
    detail: detail || undefined,
    metaParts: metaParts.length > 0 ? metaParts : undefined,
    action: normalizedTitle.includes('余额不足')
      || normalizedTitle.includes('登陆失效')
      || normalizedTitle.includes('登录失效')
      ? { label: '去登录页', target: 'settings-login' }
      : undefined,
  };
}

function truncateErrorDetail(value: string, maxLength = 900): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function buildChatErrorTimelineItem(
  payload: ChatErrorEventPayload | string,
  notice: StructuredChatErrorNotice,
): ProcessItem {
  const rawDetail = typeof payload === 'string'
    ? payload
    : String(payload.detail || payload.raw || payload.message || '').trim();
  const detailParts = [
    notice.metaParts?.join(' · ') || '',
    notice.hint || '',
    rawDetail,
  ].filter(Boolean);
  const now = Date.now();
  return {
    id: `chat-error_${now}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'error',
    title: notice.title || 'AI 请求失败',
    content: truncateErrorDetail(detailParts.join(' · ')),
    status: 'failed',
    timestamp: now,
  };
}

function buildRuntimeResumeTimelineItem(sessionId: string): ProcessItem {
  const now = Date.now();
  return {
    id: `runtime_resume_${sessionId}_${now}`,
    type: 'tool-call',
    title: '断点恢复',
    content: '正在继续这个会话上次未完成的回复，不是当前新消息单独触发的工具链。',
    status: 'running',
    timestamp: now,
    toolData: {
      callId: `runtime-resume:${sessionId}`,
      name: 'runtime',
      input: {
        action: 'runtime.resume',
        sessionId,
      },
    },
  };
}

export function Chat({
  isActive = true,
  onExecutionStateChange,
  pendingMessage,
  onMessageConsumed,
  navigationAction,
  onNavigationActionConsumed,
  defaultCollapsed = true,
  fixedSessionId,
  fixedSessionDraft = false,
  onEnsureSessionForSend,
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
  welcomeIconAccessory,
  welcomeActions = [],
  contentLayout = 'default',
  contentWidthPreset = 'default',
  allowFileUpload = true,
  attachmentPreviewMode = 'default',
  messageWorkflowPlacement = 'bottom',
  messageWorkflowVariant = 'compact',
  messageWorkflowEmphasis = 'default',
  messageWorkflowDisplayMode = 'all',
  messageWorkflowAutoHideWhenComplete = false,
  messageWorkflowFailureTone = 'danger',
  embeddedTheme = 'default',
  showWelcomeHeader = true,
  emptyStateComposerPlacement = 'inline',
  emptyStateVerticalAlign = 'center',
  showComposer = true,
  showMessageAttachments = true,
  collapseEmptyFixedSession = false,
  fixedSessionTaskHints,
  messageLinkRenderMode = 'default',
  onMessageLinkPreview,
  activePreviewHref = null,
  inlineSidePanel,
  keepComposerInputActive = false,
  messageListHeader,
  placeholder,
  fixedMemberMention = null,
  onDispatchOverride,
  onSessionActivity,
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
  const [cliEscalationRequest, setCliEscalationRequest] = useState<CliEscalationRequestModel | null>(null);
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
  const [errorNotice, setErrorNotice] = useState<string | StructuredChatErrorNotice | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<UploadedFileAttachment | null>(null);
  const [isAttachmentUploading, setIsAttachmentUploading] = useState(false);
  const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
  const [memberMentionOptions, setMemberMentionOptions] = useState<ChatMemberMentionOption[]>([]);
  const [selectedMemberMention, setSelectedMemberMention] = useState<ChatMemberMentionOption | null>(null);
  const [knowledgeMentionOptions, setKnowledgeMentionOptions] = useState<ChatKnowledgeMentionOption[]>([]);
  const [selectedKnowledgeMentions, setSelectedKnowledgeMentions] = useState<ChatKnowledgeMentionOption[]>([]);
  const documentThemeMode = useDocumentThemeMode();
  const fixedSessionMode = Boolean(fixedSessionId) || fixedSessionDraft;
  const attachmentDraftScopeId = fixedSessionId || currentSessionId || (fixedSessionDraft ? '__fixed_draft__' : '__new__');

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
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const currentSessionIdRef = useRef<string | null>(fixedSessionId ?? null);
  const chatInstanceIdRef = useRef(
    `chat-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`
  );
  const composerRef = useRef<ChatComposerHandle>(null);
  
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
  const knowledgeMentionSearchSeqRef = useRef(0);
  const knowledgeMentionSearchTimerRef = useRef<number | null>(null);
  const knowledgeMentionSearchQueryRef = useRef('');
  const pendingResponseFinalizeRef = useRef<{
    ticket: number;
    source: string;
    contentChars: number;
  } | null>(null);
  const suppressComposerFocusUntilRef = useRef(0);
  const [composerSuppressed, setComposerSuppressed] = useState(false);

  useLayoutEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useLayoutEffect(() => {
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
      hasCliEscalationRequest: Boolean(cliEscalationRequest),
      visibleBusy: Boolean(
        isProcessing
          || lastMessage?.isStreaming
          || runningTimelineCount > 0
          || confirmRequest
          || cliEscalationRequest
      ),
    });
  }, [cliEscalationRequest, confirmRequest, debugUi, isProcessing, messages]);
  const blurComposer = useCallback((reason: string) => {
    const element = composerRef.current?.getTextarea();
    if (!element) return;
    if (document.activeElement === element) {
      debugUi('input_blur', { reason });
      element.blur();
    }
  }, [debugUi]);
  const suppressComposerFocus = useCallback((reason: string, ms: number) => {
    if (keepComposerInputActive) {
      suppressComposerFocusUntilRef.current = 0;
      debugUi('skip_suppress_composer_focus', { reason, ms });
      return;
    }
    suppressComposerFocusUntilRef.current = performance.now() + ms;
    debugUi('suppress_composer_focus', { reason, ms });
    setComposerSuppressed(true);
  }, [debugUi, keepComposerInputActive]);
  const resumeComposerFocus = useCallback((source: 'empty' | 'composer') => {
    suppressComposerFocusUntilRef.current = 0;
    setComposerSuppressed(false);
    debugUi('resume_composer_focus', { source });
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.syncHeight();
    });
  }, [debugUi]);
  const activateComposerInput = useCallback((source: 'empty' | 'composer' = 'composer') => {
    suppressComposerFocusUntilRef.current = 0;
    setComposerSuppressed(false);
    debugUi('activate_composer_input', { source });
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
  const hasInlineSidePanel = Boolean(inlineSidePanel);
  const contentWidthClass = 'w-full';
  const contentMaxWidthClass = narrowContent
    ? wideContent
      ? 'max-w-[760px]'
      : 'max-w-[700px]'
    : wideContent
      ? 'max-w-[920px]'
      : 'max-w-[780px]';
  const splitContentMaxWidthClass = wideContent ? 'max-w-[1360px]' : 'max-w-[1240px]';
  const contentOuterPaddingClass = wideContent ? 'px-2 md:px-3 lg:px-4 xl:px-5' : 'px-2 md:px-3 lg:px-4 xl:px-5';
  const splitOuterPaddingClass = hasInlineSidePanel
    ? 'px-6 md:px-8 lg:px-12 xl:px-16 2xl:px-20'
    : contentOuterPaddingClass;
  const paneOuterPaddingClass = hasInlineSidePanel ? 'px-0' : contentOuterPaddingClass;
  const messageContentMaxWidthClass = hasInlineSidePanel ? 'max-w-none' : contentMaxWidthClass;
  const composerMaxWidthClass = hasInlineSidePanel ? splitContentMaxWidthClass : contentMaxWidthClass;
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
    setIsAttachmentUploading(false);
    setPendingAttachment(null);
    requestAnimationFrame(() => {
      composerRef.current?.syncHeight();
      composerRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    setPendingAttachment(loadAttachmentDraft('chat', attachmentDraftScopeId));
  }, [attachmentDraftScopeId]);

  useEffect(() => {
    saveAttachmentDraft('chat', attachmentDraftScopeId, pendingAttachment);
  }, [attachmentDraftScopeId, pendingAttachment]);

  useEffect(() => {
    setSelectedMemberMention(null);
    setSelectedKnowledgeMentions([]);
  }, [currentSessionId]);

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

  const normalizeMemberMentionOptions = useCallback((records: AdvisorMentionRecord[] | null | undefined): ChatMemberMentionOption[] => (
    (records || [])
      .filter((record): record is AdvisorMentionRecord => Boolean(record && typeof record.id === 'string' && record.id.trim()))
      .map((record) => ({
        id: record.id.trim(),
        name: String(record.name || '未命名成员').trim() || '未命名成员',
        avatar: String(record.avatar || '').trim(),
        personality: String(record.personality || '').trim(),
      }))
  ), []);

  const loadMemberMentionOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const advisors = await window.ipcRenderer.advisors.list<AdvisorMentionRecord>();
      setMemberMentionOptions(normalizeMemberMentionOptions(advisors));
    } catch (error) {
      console.error('Failed to load member mention options:', error);
      setMemberMentionOptions([]);
    }
  }, [normalizeMemberMentionOptions]);

  useEffect(() => {
    if (!isActive) return;
    void loadMemberMentionOptions();
    const handleAdvisorsChanged = () => {
      void loadMemberMentionOptions();
    };
    window.ipcRenderer.on('advisors:changed', handleAdvisorsChanged);
    return () => {
      window.ipcRenderer.off('advisors:changed', handleAdvisorsChanged);
    };
  }, [isActive, loadMemberMentionOptions]);

  const loadKnowledgeMentionOptions = useCallback(async (query = '') => {
    if (!isActiveRef.current) return;
    const requestId = ++knowledgeMentionSearchSeqRef.current;
    const normalizedQuery = query.trim();
    try {
      const records: KnowledgeMentionCatalogRecord[] = [];
      let cursor: string | null | undefined = null;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < 250; pageIndex += 1) {
        const response = await window.ipcRenderer.knowledge.listPage<KnowledgeMentionListPageResponse>({
          cursor,
          limit: 200,
          query: normalizedQuery || undefined,
          sort: 'updated-desc',
        });
        if (!isActiveRef.current || requestId !== knowledgeMentionSearchSeqRef.current) return;
        records.push(...(Array.isArray(response?.items) ? response.items : []));
        const nextCursor = typeof response?.nextCursor === 'string' && response.nextCursor.trim()
          ? response.nextCursor.trim()
          : null;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (requestId !== knowledgeMentionSearchSeqRef.current) return;
      setKnowledgeMentionOptions(
        records
          .map(normalizeKnowledgeMentionRecord)
          .filter((item): item is ChatKnowledgeMentionOption => Boolean(item)),
      );
    } catch (error) {
      console.error('Failed to load knowledge mention options:', error);
      setKnowledgeMentionOptions([]);
    }
  }, []);

  const handleKnowledgeMentionSearchQueryChange = useCallback((query: string) => {
    const normalizedQuery = query.trim();
    if (knowledgeMentionSearchQueryRef.current === normalizedQuery) return;
    knowledgeMentionSearchQueryRef.current = normalizedQuery;
    if (knowledgeMentionSearchTimerRef.current) {
      window.clearTimeout(knowledgeMentionSearchTimerRef.current);
      knowledgeMentionSearchTimerRef.current = null;
    }
    knowledgeMentionSearchTimerRef.current = window.setTimeout(() => {
      void loadKnowledgeMentionOptions(normalizedQuery);
    }, 160);
  }, [loadKnowledgeMentionOptions]);

  useEffect(() => {
    if (!isActive) return;
    void loadKnowledgeMentionOptions(knowledgeMentionSearchQueryRef.current);
    const handleKnowledgeChanged = () => {
      void loadKnowledgeMentionOptions(knowledgeMentionSearchQueryRef.current);
    };
    window.ipcRenderer.on('knowledge:changed', handleKnowledgeChanged);
    window.ipcRenderer.on('knowledge:catalog-updated', handleKnowledgeChanged);
    return () => {
      window.ipcRenderer.off('knowledge:changed', handleKnowledgeChanged);
      window.ipcRenderer.off('knowledge:catalog-updated', handleKnowledgeChanged);
      if (knowledgeMentionSearchTimerRef.current) {
        window.clearTimeout(knowledgeMentionSearchTimerRef.current);
        knowledgeMentionSearchTimerRef.current = null;
      }
    };
  }, [isActive, loadKnowledgeMentionOptions]);

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

  const loadChatRooms = useCallback(async (options?: { silent?: boolean }) => {
    if (fixedSessionMode) return;
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
  }, [fixedSessionMode]);

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

  const handleOpenSettingsLogin = useCallback(() => {
    window.dispatchEvent(new CustomEvent(REDBOX_NAVIGATE_EVENT, {
      detail: { view: 'settings', settingsTab: 'ai', aiModelSubTab: 'login' },
    }));
  }, []);

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
    if (!fixedSessionMode) {
      void loadChatRooms({ silent: true });
    }

    // Handle fixed session (File-Bound Mode)
    if (fixedSessionId) {
       setSidebarCollapsed(true);
       selectSession(fixedSessionId);
       return;
    }

    if (fixedSessionMode) {
      setSidebarCollapsed(true);
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
  }, [fixedSessionId, fixedSessionMode, isActive, loadChatRooms]); // Add fixedSessionId dependency

  const dispatchChatSend = useCallback((payload: {
    sessionId?: string;
    message: string;
    displayContent: string;
    attachment?: Message['attachment'];
    memberMention?: {
      type: 'advisor';
      advisorId: string;
      name: string;
      avatar?: string;
    };
    knowledgeReferences?: ChatKnowledgeMentionOption[];
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
      targetAdvisorId: payload.memberMention?.advisorId || null,
      knowledgeReferenceCount: payload.knowledgeReferences?.length || 0,
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

  const notifySessionActivity = useCallback((sessionId: string | null | undefined, updatedAt = new Date().toISOString()) => {
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId) return;
    onSessionActivity?.(safeSessionId, updatedAt);
  }, [onSessionActivity]);

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

    if (pendingMessage.deliveryMode === 'draft') {
      const draftKnowledgeReferences = (pendingMessage.knowledgeReferences || [])
        .filter((item) => item.id)
        .map((item) => ({
          id: item.id,
          title: item.title || '未命名内容',
          sourceKind: item.sourceKind,
          summary: item.summary,
          cover: item.cover,
          sourceUrl: item.sourceUrl,
          folderPath: item.folderPath,
          rootPath: item.rootPath,
          tags: item.tags,
          updatedAt: item.updatedAt,
          fileCount: item.fileCount,
          hasTranscript: item.hasTranscript,
        }));
      setInput(String(pendingMessage.content || ''));
      setSelectedKnowledgeMentions(draftKnowledgeReferences);
      if (pendingMessage.attachment?.type === 'uploaded-file') {
        setPendingAttachment(pendingMessage.attachment);
      }
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.syncHeight();
      });
      onMessageConsumed?.();
      return;
    }

    const sendPendingMessage = async () => {
      let sessionId: string;
      const shouldAppendToCurrentSession = Boolean(fixedSessionId);

      if (fixedSessionId) {
        sessionId = fixedSessionId;
      } else {
        try {
          // 使用视频标题作为会话标题
          const attachmentTitle = pendingMessage.attachment
            ? ('title' in pendingMessage.attachment
              ? String(pendingMessage.attachment.title || '').trim()
              : ('name' in pendingMessage.attachment
                ? String(pendingMessage.attachment.name || '').trim()
                : ''))
            : '';
          const sessionTitle = attachmentTitle
            ? `AI 脑爆: ${attachmentTitle.substring(0, 30)}${attachmentTitle.length > 30 ? '...' : ''}`
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
      const resolvedAttachment = applyAttachmentDeliveryMode(
        pendingMessage.attachment as UploadedFileAttachment | undefined,
        resolvedModelConfig?.modelName || getChatModelConfig()?.modelName,
      );
      const pendingKnowledgeReferences = (pendingMessage.knowledgeReferences || [])
        .filter((item) => item.id)
        .map((item) => ({
          id: item.id,
          title: item.title || '未命名内容',
          sourceKind: item.sourceKind,
          summary: item.summary,
          cover: item.cover,
          sourceUrl: item.sourceUrl,
          folderPath: item.folderPath,
          rootPath: item.rootPath,
          tags: item.tags,
          updatedAt: item.updatedAt,
          fileCount: item.fileCount,
          hasTranscript: item.hasTranscript,
        }));
      const pendingKnowledgeRuntimeContext = buildKnowledgeReferenceRuntimeContext(pendingKnowledgeReferences);
      const pendingRuntimeMessage = [
        pendingMessage.content,
        pendingKnowledgeRuntimeContext ? `\n\n[KnowledgeReferences]\n${pendingKnowledgeRuntimeContext}\n[/KnowledgeReferences]` : '',
      ].filter(Boolean).join('');

      // 构建用户消息 - 注意：attachment 和 displayContent 用于 UI 显示
      const processingStartedAt = Date.now();
      notifySessionActivity(sessionId, new Date(processingStartedAt).toISOString());
      const userMsg: Message = {
        id: processingStartedAt.toString(),
        role: 'user',
        content: pendingRuntimeMessage,
        displayContent: pendingMessage.displayContent,
        attachment: resolvedAttachment as Message['attachment'],
        knowledgeReferences: pendingKnowledgeReferences,
        tools: [],
        timeline: []
      };

      const aiPlaceholder: Message = {
        id: (processingStartedAt + 1).toString(),
        role: 'ai',
        messageType: 'reply',
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
        message: pendingRuntimeMessage,
        displayContent: pendingMessage.displayContent,
        attachment: stripTransientAttachmentPreview(resolvedAttachment),
        knowledgeReferences: pendingKnowledgeReferences,
        modelConfig: resolvedModelConfig,
        taskHints: pendingMessage.taskHints,
      });

      // 标记消息已消费
      onMessageConsumed?.();
    };

    sendPendingMessage();
  }, [isActive, pendingMessage, isProcessing, onMessageConsumed, fixedSessionId, currentSessionId, buildPendingAssistantTimeline, dispatchChatSend, ensureChatModelConfig, notifySessionActivity, setPendingAttachment]);

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
      if (
        normalizedList.length > 0
        && !currentSessionIdRef.current
        && !loadAttachmentDraft('chat', '__new__')
      ) {
        void selectSession(normalizedList[0].id);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const selectSession = async (sessionId: string) => {
    if (!isActiveRef.current) return;
    setErrorNotice(null);
    currentSessionIdRef.current = sessionId;
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
        const memberActor = memberActorFromMessageMetadata(msg.metadata);
        const knowledgeReferences = knowledgeReferencesFromMessageMetadata(msg.metadata);

        if (role === 'user') {
          lastUserCreatedAt = createdAt;
        }

        return {
          id: msg.id,
          role, // Simplified mapping
          messageType: role === 'ai' ? 'reply' : undefined,
          content: msg.content,
          displayContent: msg.display_content || undefined,
          attachment: attachment,
          knowledgeReferences: role === 'user' ? knowledgeReferences : [],
          memberMention: role === 'user' ? memberActor : undefined,
          memberActor: role === 'ai' ? memberActor : undefined,
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
        const recoveryItem = buildRuntimeResumeTimelineItem(sessionId);
        const restoredContent = `${runtimePartial}${missedChunksRef.current || ''}`;
        missedChunksRef.current = '';
        const lastMsg = uiMessages[uiMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') {
          uiMessages.push({
            id: `streaming_${Date.now()}`,
            role: 'ai',
            messageType: 'reply',
            content: restoredContent,
            tools: [],
            timeline: [recoveryItem],
            isStreaming: true,
            processingStartedAt: lastUserCreatedAt ?? Date.now(),
          });
        } else {
          uiMessages[uiMessages.length - 1] = {
            ...lastMsg,
            messageType: 'reply',
            content: restoredContent || lastMsg.content || '',
            isStreaming: true,
            timeline: [
              recoveryItem,
              ...(lastMsg.timeline || []),
            ],
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

  const createNewSession = useCallback(async () => {
    try {
      const session = await window.ipcRenderer.chat.createSession('New Chat');
      setSessions(prev => [session, ...prev]);
      setCurrentSessionId(session.id);
      setErrorNotice(null);
      setMessages([]);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  }, []);

  const handledNavigationActionNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive || navigationAction?.action !== 'new') return;
    if (handledNavigationActionNonceRef.current === navigationAction.nonce) return;
    handledNavigationActionNonceRef.current = navigationAction.nonce;
    void createNewSession().finally(() => {
      onNavigationActionConsumed?.();
    });
  }, [createNewSession, isActive, navigationAction, onNavigationActionConsumed]);

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
      setCliEscalationRequest(null);
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

  const handleApproveCliEscalation = useCallback(async (
    escalationId: string,
    scope: CliEscalationScope,
  ) => {
    try {
      await window.ipcRenderer.cliRuntime.approveEscalation({ escalationId, scope });
      setCliEscalationRequest((current) => (
        current?.escalationId === escalationId ? null : current
      ));
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleDenyCliEscalation = useCallback(async (escalationId: string) => {
    try {
      await window.ipcRenderer.cliRuntime.denyEscalation({ escalationId });
      setCliEscalationRequest((current) => (
        current?.escalationId === escalationId ? null : current
      ));
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error));
    }
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

      const lastReplyIndex = findLastAssistantReplyIndex(prev);
      if (lastReplyIndex === -1) {
        return prev;
      }
      const lastMsg = prev[lastReplyIndex];

      missedChunksRef.current = consumeBufferedChunk(missedChunksRef.current, chunk);
      const next = [...prev];
      next[lastReplyIndex] = {
        ...lastMsg,
        content: lastMsg.content + chunk,
        isStreaming: true,
        messageType: 'reply',
      };
      return next;
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
    if (!isActive || fixedSessionMode) return;
    const handleSpaceChanged = () => {
      setShowRoomPicker(false);
      setSelectionMenu(prev => ({ ...prev, visible: false }));
      void loadChatRooms({ silent: true });
    };
    window.ipcRenderer.on('space:changed', handleSpaceChanged);
    return () => {
      window.ipcRenderer.off('space:changed', handleSpaceChanged);
    };
  }, [fixedSessionMode, isActive, loadChatRooms]);

  useEffect(() => {
    if (!isActive) return;
    const refreshChatModels = () => {
      void loadChatModelOptions();
    };
    window.ipcRenderer.on('settings:updated', refreshChatModels);
    window.ipcRenderer.on('auth:data-changed', refreshChatModels);
    return () => {
      window.ipcRenderer.off('settings:updated', refreshChatModels);
      window.ipcRenderer.off('auth:data-changed', refreshChatModels);
    };
  }, [isActive, loadChatModelOptions]);

  const handleCancel = useCallback(() => {
    if (currentSessionId) {
      window.ipcRenderer.chat.cancel({ sessionId: currentSessionId });
    } else {
      window.ipcRenderer.chat.cancel();
    }
    setIsProcessing(false);
    setCliEscalationRequest(null);
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
        setErrorNotice(null);
      }
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const lastMsg = prev[lastReplyIndex];

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

        const next = [...prev];
        next[lastReplyIndex] = { ...lastMsg, timeline: newTimeline, messageType: 'reply' };
        return next;
      });
    };

    // 2. Thought Start
    const handleThoughtStart = (_: unknown) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;

        const now = Date.now();
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        if (findLastRunningTimelineThoughtIndex(timeline) !== -1) return prev;
        timeline.push({
          id: `thought_${now}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'thought',
          content: '',
          status: 'running',
          timestamp: now,
        });
        next[lastReplyIndex] = {
          ...lastMsg,
          messageType: 'reply',
          suppressPendingIndicator: true,
          timeline,
        };
        return next;
      });
    };

    // 3. Thought Delta
    const handleThoughtDelta = (_: unknown, data?: { content: string }) => {
      if (!isActiveRef.current) return;
      const content = data?.content;
      if (!content) return;
      if (responseCompletedRef.current) {
        debugUi('thought_delta:ignored_after_response_end', {
          sessionId: currentSessionIdRef.current,
          chunkChars: content.length,
        });
        return;
      }
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const now = Date.now();
        const timeline = [...lastMsg.timeline];
        const thoughtIndex = findLastRunningTimelineThoughtIndex(timeline);

        if (thoughtIndex === -1) {
          timeline.push({
            id: `thought_${now}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'thought',
            content,
            status: 'running',
            timestamp: now,
          });
        } else {
          const thoughtItem = timeline[thoughtIndex];
          timeline[thoughtIndex] = {
            ...thoughtItem,
            content: mergeThoughtDelta(thoughtItem.content || '', content),
          };
        }

        next[lastReplyIndex] = {
          ...lastMsg,
          messageType: 'reply',
          suppressPendingIndicator: true,
          timeline,
        };
        return next;
      });
    };

    // 4. Thought End
    const handleThoughtEnd = (_: unknown) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const thoughtIndex = findLastRunningTimelineThoughtIndex(timeline);
        if (thoughtIndex === -1) return prev;
        const finishedAt = Date.now();
        const thoughtItem = timeline[thoughtIndex];
        timeline[thoughtIndex] = {
          ...thoughtItem,
          status: 'done',
          duration: finishedAt - thoughtItem.timestamp,
        };
        next[lastReplyIndex] = {
          ...lastMsg,
          messageType: 'reply',
          timeline,
        };
        return next;
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
      if (responseCompletedRef.current) {
        debugUi('response_chunk:ignored_after_response_end', {
          sessionId: currentSessionIdRef.current,
          chunkChars: content.length,
        });
        return;
      }
      setMessages(prev => {
        const runningThinkingIndex = findLastRunningThinkingIndex(prev);
        if (runningThinkingIndex === -1) return prev;
        const next = [...prev];
        next[runningThinkingIndex] = {
          ...next[runningThinkingIndex],
          messageType: 'thinking',
          isStreaming: false,
          processingFinishedAt: Date.now(),
        };
        return next;
      });

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
        const runningThinkingIndex = findLastRunningThinkingIndex(prev);
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        if (runningThinkingIndex !== -1) {
          next[runningThinkingIndex] = {
            ...next[runningThinkingIndex],
            messageType: 'thinking',
            isStreaming: false,
            processingFinishedAt: Date.now(),
          };
        }
        const lastMsg = next[lastReplyIndex];

        const newTimeline = [...lastMsg.timeline];
        const runningThoughtIndex = findLastRunningTimelineThoughtIndex(newTimeline);
        if (runningThoughtIndex !== -1) {
          const thoughtItem = newTimeline[runningThoughtIndex];
          newTimeline[runningThoughtIndex] = {
            ...thoughtItem,
            status: 'done',
            duration: Date.now() - thoughtItem.timestamp,
          };
        }

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

        next[lastReplyIndex] = { 
            ...lastMsg,
            messageType: 'reply',
            timeline: newTimeline,
            tools: [...lastMsg.tools, newTool] 
        };
        return next;
      });
    };

    const handleToolEnd = (_: unknown, toolData: { callId: string; name: string; output: { success: boolean; content: string } }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const lastMsg = prev[lastReplyIndex];

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
          t.callId === toolData.callId
            ? {
                ...t,
                status: toolData.output?.success ? 'done' : 'failed',
                output: toolData.output,
              } as ToolEvent
            : t
        );

        const next = [...prev];
        next[lastReplyIndex] = { 
            ...lastMsg,
            messageType: 'reply',
            timeline: newTimeline,
            tools: updatedTools 
        };
        return next;
      });
    };

    const handleToolUpdate = (_: unknown, toolData: { callId: string; name: string; partial: string }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const lastMsg = prev[lastReplyIndex];
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

        const next = [...prev];
        next[lastReplyIndex] = {
          ...lastMsg,
          messageType: 'reply',
          timeline: newTimeline,
        };
        return next;
      });
    };

    const handleCliInstallStarted = (_: unknown, cliData: {
      installId?: string;
      toolId?: string;
      toolName: string;
      environmentId?: string;
      installMethod?: string;
      spec?: string;
    }) => {
      if (!isActiveRef.current) return;
      const installId = cliData.installId || cliData.toolId || cliData.toolName || `install_${Date.now()}`;
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-install' && item.cliData?.installId === installId,
        );
        const nextItem: ProcessItem = {
          id: existingIndex >= 0 ? timeline[existingIndex].id : `cli-install_${installId}`,
          type: 'cli-install',
          title: cliData.toolName || 'CLI 安装',
          content: cliData.spec || cliData.installMethod || '安装外部工具',
          status: 'running',
          timestamp: existingIndex >= 0 ? timeline[existingIndex].timestamp : Date.now(),
          cliData: {
            ...timeline[existingIndex]?.cliData,
            installId,
            toolName: cliData.toolName,
            environmentId: cliData.environmentId,
            installMethod: cliData.installMethod,
            spec: cliData.spec,
          },
        };
        if (existingIndex >= 0) {
          timeline[existingIndex] = nextItem;
        } else {
          timeline.push(nextItem);
        }
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliInstallFinished = (_: unknown, cliData: {
      installId?: string;
      toolId?: string;
      toolName: string;
      environmentId?: string;
      status: string;
      summary: string;
    }) => {
      if (!isActiveRef.current) return;
      const installId = cliData.installId || cliData.toolId || cliData.toolName || '';
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-install' && (
            item.cliData?.installId === installId
            || item.cliData?.toolName === cliData.toolName
          ),
        );
        if (existingIndex === -1) return prev;
        const target = timeline[existingIndex];
        timeline[existingIndex] = {
          ...target,
          content: cliData.summary || target.content,
          status: normalizeCliProcessStatus(cliData.status),
          duration: Date.now() - target.timestamp,
          cliData: {
            ...target.cliData,
            environmentId: cliData.environmentId || target.cliData?.environmentId,
            logPreview: appendCliLogPreview(target.cliData?.logPreview || '', cliData.summary || ''),
          },
        };
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliExecutionStarted = (_: unknown, cliData: {
      executionId: string;
      environmentId?: string;
      toolId?: string;
      toolName: string;
      argv: string[];
      cwd?: string;
    }) => {
      if (!isActiveRef.current) return;
      setMessages((prev) => {
        const runningThinkingIndex = findLastRunningThinkingIndex(prev);
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        if (runningThinkingIndex !== -1) {
          next[runningThinkingIndex] = {
            ...next[runningThinkingIndex],
            messageType: 'thinking',
            isStreaming: false,
            processingFinishedAt: Date.now(),
          };
        }
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-exec' && item.cliData?.executionId === cliData.executionId,
        );
        const nextItem: ProcessItem = {
          id: existingIndex >= 0 ? timeline[existingIndex].id : `cli-exec_${cliData.executionId}`,
          type: 'cli-exec',
          title: cliData.toolName || 'CLI 执行',
          content: cliData.argv.join(' '),
          status: 'running',
          timestamp: existingIndex >= 0 ? timeline[existingIndex].timestamp : Date.now(),
          cliData: {
            ...timeline[existingIndex]?.cliData,
            executionId: cliData.executionId,
            toolName: cliData.toolName,
            environmentId: cliData.environmentId,
            argv: cliData.argv,
            cwd: cliData.cwd,
            commandPreview: cliData.argv.join(' '),
          },
        };
        if (existingIndex >= 0) {
          timeline[existingIndex] = nextItem;
        } else {
          timeline.push(nextItem);
        }
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliExecutionLog = (_: unknown, cliData: {
      executionId: string;
      chunk: string;
    }) => {
      if (!isActiveRef.current || !cliData.chunk) return;
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-exec' && item.cliData?.executionId === cliData.executionId,
        );
        if (existingIndex === -1) return prev;
        const target = timeline[existingIndex];
        timeline[existingIndex] = {
          ...target,
          cliData: {
            ...target.cliData,
            logPreview: appendCliLogPreview(target.cliData?.logPreview || '', cliData.chunk),
          },
        };
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliExecutionStatus = (_: unknown, cliData: {
      executionId: string;
      status: string;
      summary: string;
      exitCode?: number;
    }) => {
      if (!isActiveRef.current) return;
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-exec' && item.cliData?.executionId === cliData.executionId,
        );
        if (existingIndex === -1) return prev;
        const target = timeline[existingIndex];
        const summaryText = cliData.exitCode == null
          ? cliData.summary
          : `${cliData.summary || ''}${cliData.summary ? '\n' : ''}exitCode=${cliData.exitCode}`;
        timeline[existingIndex] = {
          ...target,
          content: cliData.summary || target.content,
          status: normalizeCliProcessStatus(cliData.status),
          duration: Date.now() - target.timestamp,
          cliData: {
            ...target.cliData,
            logPreview: appendCliLogPreview(target.cliData?.logPreview || '', summaryText),
          },
        };
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliEscalationRequested = (_: unknown, cliData: CliEscalationRequestModel) => {
      if (!isActiveRef.current) return;
      setCliEscalationRequest(cliData);
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-escalation' && item.cliData?.escalationId === cliData.escalationId,
        );
        const nextItem: ProcessItem = {
          id: existingIndex >= 0 ? timeline[existingIndex].id : `cli-escalation_${cliData.escalationId}`,
          type: 'cli-escalation',
          title: cliData.title || '权限确认',
          content: cliData.reason || cliData.description || 'CLI 请求额外权限',
          status: 'running',
          timestamp: existingIndex >= 0 ? timeline[existingIndex].timestamp : Date.now(),
          cliData: {
            ...timeline[existingIndex]?.cliData,
            escalationId: cliData.escalationId,
            executionId: cliData.executionId,
            commandPreview: cliData.commandPreview,
            permissions: cliData.permissionSummary,
          },
        };
        if (existingIndex >= 0) {
          timeline[existingIndex] = nextItem;
        } else {
          timeline.push(nextItem);
        }
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliEscalationResolved = (_: unknown, cliData: {
      escalationId: string;
      executionId?: string;
      status: string;
      scope?: string;
      summary: string;
    }) => {
      if (!isActiveRef.current) return;
      setCliEscalationRequest((current) => (
        current?.escalationId === cliData.escalationId ? null : current
      ));
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-escalation' && item.cliData?.escalationId === cliData.escalationId,
        );
        if (existingIndex === -1) return prev;
        const target = timeline[existingIndex];
        timeline[existingIndex] = {
          ...target,
          content: cliData.summary || target.content,
          status: normalizeCliProcessStatus(cliData.status),
          duration: Date.now() - target.timestamp,
          cliData: {
            ...target.cliData,
            executionId: cliData.executionId || target.cliData?.executionId,
            resolutionScope: cliData.scope,
          },
        };
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleCliVerificationFinished = (_: unknown, cliData: {
      executionId: string;
      status: string;
      summary: string;
    }) => {
      if (!isActiveRef.current) return;
      setMessages((prev) => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const next = [...prev];
        const lastMsg = next[lastReplyIndex];
        const timeline = [...lastMsg.timeline];
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-verify' && item.cliData?.executionId === cliData.executionId,
        );
        const nextItem: ProcessItem = {
          id: existingIndex >= 0 ? timeline[existingIndex].id : `cli-verify_${cliData.executionId}`,
          type: 'cli-verify',
          title: '结果校验',
          content: cliData.summary || 'CLI 执行完成，等待校验',
          status: normalizeCliProcessStatus(cliData.status),
          timestamp: existingIndex >= 0 ? timeline[existingIndex].timestamp : Date.now(),
          duration: existingIndex >= 0 ? Date.now() - timeline[existingIndex].timestamp : undefined,
          cliData: {
            ...timeline[existingIndex]?.cliData,
            executionId: cliData.executionId,
            verificationSummary: cliData.summary,
          },
        };
        if (existingIndex >= 0) {
          timeline[existingIndex] = nextItem;
        } else {
          timeline.push(nextItem);
        }
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
        return next;
      });
    };

    const handleSkillActivated = (_: unknown, skillData: { name: string; description: string }) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const lastMsg = prev[lastReplyIndex];
        
        // Add to Timeline
        const newTimeline = [...lastMsg.timeline, {
            id: Math.random().toString(36),
            type: 'skill' as any,
            content: skillData.description,
            status: 'done' as const,
            timestamp: Date.now(),
            skillData: skillData
        }];

        const next = [...prev];
        next[lastReplyIndex] = { 
            ...lastMsg,
            messageType: 'reply',
            timeline: newTimeline,
            activatedSkill: skillData 
        };
        return next;
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
        setCliEscalationRequest(null);
        setErrorNotice(null);
        debugUi('response_end:state_calls_issued', {
          chatInstanceId: chatInstanceIdRef.current,
          sessionId: currentSessionIdRef.current,
          ticket: finalizeTicket,
          source,
        });
        setMessages(prev => {
          const lastReplyIndex = findLastAssistantReplyIndex(prev);
          const lastMsg = lastReplyIndex >= 0 ? prev[lastReplyIndex] : null;
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
            const next = [...prev];
            next[lastReplyIndex] = {
              ...lastMsg,
              messageType: 'reply',
              content: mergedContent,
              timeline,
              isStreaming: false,
              suppressPendingIndicator: false,
              processingFinishedAt: now,
            };
            return next;
          }
          if (finalContent) {
            const now = Date.now();
            return [
              ...prev,
              {
                id: now.toString(),
                role: 'ai',
                messageType: 'reply',
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
        setCliEscalationRequest(null);
        setErrorNotice(null);
        setMessages(prev => {
          const lastReplyIndex = findLastAssistantReplyIndex(prev);
          const lastMsg = lastReplyIndex >= 0 ? prev[lastReplyIndex] : null;
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
          const next = [...prev];
          next[lastReplyIndex] = {
            ...lastMsg,
            messageType: 'reply',
            timeline,
            isStreaming: false,
            suppressPendingIndicator: false,
            processingFinishedAt: now,
          };
          const runningThinkingIndex = findLastRunningThinkingIndex(next);
          if (runningThinkingIndex !== -1) {
            next[runningThinkingIndex] = {
              ...next[runningThinkingIndex],
              messageType: 'thinking',
              isStreaming: false,
              processingFinishedAt: now,
            };
          }
          return next;
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
        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;
        const lastMsg = prev[lastReplyIndex];
        const next = [...prev];
        next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', plan: steps };
        return next;
      });
    };

    const handleError = (_: unknown, error: ChatErrorEventPayload | string) => {
      if (!isActiveRef.current) return;
      if (responseCompletedRef.current) {
        debugUi('response_error:ignored_after_response_end', {
          sessionId: currentSessionIdRef.current,
          error: typeof error === 'string' ? error : error?.message || 'unknown',
        });
        setMessages((prev) => {
          if (!hasCommittedAssistantReply(prev)) return prev;
          return prev;
        });
        return;
      }
      suppressComposerFocus('error', 3000);
      blurComposer('error');
      const notice = normalizeChatErrorNotice(error);
      const errorTimelineItem = buildChatErrorTimelineItem(error, notice);
      debugUi('response_error', {
        sessionId: currentSessionIdRef.current,
        error: typeof error === 'string' ? error : error?.message || 'unknown',
      });
      streamStatsRef.current = null;
      flushSync(() => {
        setIsProcessing(false);
        setConfirmRequest(null);
        setCliEscalationRequest(null);
        setErrorNotice(notice);
        setMessages(prev => {
          const lastReplyIndex = findLastAssistantReplyIndex(prev);
          const lastMsg = lastReplyIndex >= 0 ? prev[lastReplyIndex] : null;
          if (lastMsg && lastMsg.role === 'ai' && lastMsg.isStreaming) {
            const now = Date.now();
            const timeline: ProcessItem[] = (lastMsg.timeline || []).map((item) => {
              if (item.status !== 'running') return item;
              return {
                ...item,
                status: (
                  item.type === 'tool-call'
                  || item.type === 'cli-install'
                  || item.type === 'cli-exec'
                  || item.type === 'cli-escalation'
                  || item.type === 'cli-verify'
                ) ? 'failed' : 'done',
                duration: now - item.timestamp,
              } as ProcessItem;
            });
            timeline.push(errorTimelineItem);
            const next = [...prev];
            next[lastReplyIndex] = {
              ...lastMsg,
              messageType: 'reply',
              timeline,
              isStreaming: false,
              suppressPendingIndicator: false,
              processingFinishedAt: now,
            };
            const runningThinkingIndex = findLastRunningThinkingIndex(next);
            if (runningThinkingIndex !== -1) {
              next[runningThinkingIndex] = {
                ...next[runningThinkingIndex],
                messageType: 'thinking',
                isStreaming: false,
                processingFinishedAt: now,
              };
            }
            return next;
          }
          return prev;
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
        handleConfirmRequest(null, request as ToolConfirmRequestPayload);
      },
      onCliInstallStarted: ({ installId, toolId, toolName, environmentId, installMethod, spec }) => {
        handleCliInstallStarted(null, { installId, toolId, toolName, environmentId, installMethod, spec });
      },
      onCliInstallFinished: ({ installId, toolId, toolName, environmentId, status, summary }) => {
        handleCliInstallFinished(null, { installId, toolId, toolName, environmentId, status, summary });
      },
      onCliExecutionStarted: ({ executionId, environmentId, toolId, toolName, argv, cwd }) => {
        handleCliExecutionStarted(null, { executionId, environmentId, toolId, toolName, argv, cwd });
      },
      onCliExecutionLog: ({ executionId, chunk }) => {
        handleCliExecutionLog(null, { executionId, chunk });
      },
      onCliExecutionStatus: ({ executionId, status, summary, exitCode }) => {
        handleCliExecutionStatus(null, { executionId, status, summary, exitCode });
      },
      onCliEscalationRequested: ({
        escalationId,
        executionId,
        title,
        description,
        reason,
        commandPreview,
        permissionSummary,
        scopeOptions,
      }) => {
        handleCliEscalationRequested(null, {
          escalationId,
          executionId,
          title,
          description,
          reason,
          commandPreview,
          permissionSummary,
          scopeOptions,
        });
      },
      onCliEscalationResolved: ({ escalationId, executionId, status, scope, summary }) => {
        handleCliEscalationResolved(null, { escalationId, executionId, status, scope, summary });
      },
      onCliVerificationFinished: ({ executionId, status, summary }) => {
        handleCliVerificationFinished(null, { executionId, status, summary });
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
    setIsAttachmentUploading(true);
    setErrorNotice(null);
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
    } finally {
      setIsAttachmentUploading(false);
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

  const transcribeAudioClip = useCallback(async (clip: AudioRecordingClip) => {
    setIsTranscribingAudio(true);
    setErrorNotice(null);
    try {
      const result = await window.ipcRenderer.chat.transcribeAudio({
        audioBase64: clip.audioBase64,
        mimeType: clip.mimeType || 'audio/wav',
        fileName: clip.fileName || `chat_audio_${Date.now()}.wav`,
      });
      const resolved = resolveUsableTranscript(result);
      if (resolved.error) {
        throw new Error(resolved.error || '语音转文字失败');
      }
      if (!resolved.text) {
        return;
      }
      setInput((prev) => {
        const current = String(prev || '').trim();
        const next = resolved.text || '';
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

  const audioRecording = useAudioRecording({
    onCaptured: transcribeAudioClip,
  });

  useEffect(() => {
    if (!audioRecording.error) return;
    setErrorNotice(audioRecording.error);
  }, [audioRecording.error]);

  const startAudioRecording = useCallback(async () => {
    if (isProcessing || isTranscribingAudio || audioRecording.isWorking) return;
    setErrorNotice(null);
    await audioRecording.startRecording();
  }, [audioRecording, isProcessing, isTranscribingAudio]);

  const stopAudioRecording = useCallback(() => {
    if (audioRecording.isWorking) return;
    void audioRecording.stopRecording();
  }, [audioRecording]);

  const handleAudioInput = useCallback(() => {
    if (audioRecording.isRecording) {
      stopAudioRecording();
      return;
    }
    void startAudioRecording();
  }, [audioRecording.isRecording, startAudioRecording, stopAudioRecording]);

  const sendMessage = async (
    content: string,
    attachment?: UploadedFileAttachment,
    memberMention: ChatMemberMentionOption | null = selectedMemberMention || fixedMemberMention,
    knowledgeMentions: ChatKnowledgeMentionOption[] = selectedKnowledgeMentions,
  ) => {
    const safeKnowledgeMentions = knowledgeMentions.filter((item) => item.id);
    uiTraceInteraction('chat', 'send_message', {
      sessionId: currentSessionId || null,
      chars: String(content || '').trim().length,
      hasAttachment: Boolean(attachment),
      targetAdvisorId: memberMention?.id || null,
      knowledgeReferenceCount: safeKnowledgeMentions.length,
    });
    suppressComposerFocus('send_message', 5000);
    blurComposer('send_message');
    shouldAutoScrollRef.current = true;
    setErrorNotice(null);
    const normalizedContent = String(content || '').trim();
    const mentionLabel = memberMention ? `@${memberMention.name}` : '';
    const knowledgeLabels = safeKnowledgeMentions.map((item) => `#${item.title || '知识库内容'}`);
    const displayBody = normalizedContent || (attachment ? `请分析这个附件：${attachment.name}` : safeKnowledgeMentions.length > 0 ? '请结合提到的知识库内容回答。' : '');
    const displayText = [mentionLabel, ...knowledgeLabels, displayBody].filter(Boolean).join(' ').trim();
    if (!displayText) return;
    const baseRuntimeMessage = normalizedContent || displayBody || displayText;
    const knowledgeRuntimeContext = buildKnowledgeReferenceRuntimeContext(safeKnowledgeMentions);
    const runtimeMessage = [
      baseRuntimeMessage,
      knowledgeRuntimeContext ? `\n\n[KnowledgeReferences]\n${knowledgeRuntimeContext}\n[/KnowledgeReferences]` : '',
    ].filter(Boolean).join('');
    let targetSessionId = currentSessionIdRef.current || currentSessionId || null;
    if (!targetSessionId && onEnsureSessionForSend) {
      try {
        targetSessionId = await onEnsureSessionForSend();
      } catch (error) {
        console.error('Failed to create chat session before send:', error);
        targetSessionId = null;
      }
      if (!targetSessionId) {
        setErrorNotice('创建对话失败，请稍后重试');
        return;
      }
      currentSessionIdRef.current = targetSessionId;
      setCurrentSessionId(targetSessionId);
    }
    const processingStartedAt = Date.now();
    notifySessionActivity(targetSessionId, new Date(processingStartedAt).toISOString());
    const memberActor: ChatMessageMemberActor | undefined = memberMention ? {
      type: 'member',
      memberId: memberMention.id,
      displayName: memberMention.name,
      avatar: memberMention.avatar,
    } : undefined;
    const userMsg: Message = {
      id: processingStartedAt.toString(),
      role: 'user',
      content: runtimeMessage,
      displayContent: displayText,
      attachment: attachment as unknown as Message['attachment'],
      knowledgeReferences: safeKnowledgeMentions,
      memberMention: memberActor,
      tools: [],
      timeline: []
    };

    const aiPlaceholder: Message = {
      id: (processingStartedAt + 1).toString(),
      role: 'ai',
      messageType: 'reply',
      content: '',
      tools: [],
      timeline: [],
      isStreaming: true,
      processingStartedAt,
      memberActor,
    };

    localMessageMutationRef.current += 1;
    setMessages(prev => [...prev, userMsg, aiPlaceholder]);
    setInput('');
    setSelectedMemberMention(null);
    setSelectedKnowledgeMentions([]);
    setPendingAttachment(null);
    setIsAttachmentUploading(false);
    setIsProcessing(true);

    if (onDispatchOverride) {
      try {
        const overrideResult = await onDispatchOverride({
          sessionId: targetSessionId || undefined,
          message: runtimeMessage,
          displayContent: displayText,
          attachment: attachment as Message['attachment'],
          knowledgeReferences: safeKnowledgeMentions,
          taskHints: fixedSessionTaskHints,
        });
        const handled = typeof overrideResult === 'boolean' ? overrideResult : Boolean(overrideResult?.handled);
        if (handled) {
          const assistantContent = typeof overrideResult === 'boolean'
            ? ''
            : String(overrideResult.assistantContent || '').trim();
          const now = Date.now();
          setIsProcessing(false);
          setMessages((prev) => prev.map((message) => (
            message.id === aiPlaceholder.id
              ? {
                ...message,
                content: assistantContent || '任务已交给 RedClaw 自动团队执行。',
                isStreaming: false,
                processingFinishedAt: now,
              }
              : message
          )));
          return;
        }
      } catch (error) {
        console.error('Chat dispatch override failed:', error);
        const detail = error instanceof Error ? error.message : String(error || '执行失败');
        const now = Date.now();
        setIsProcessing(false);
        setErrorNotice(detail);
        setMessages((prev) => prev.map((message) => (
          message.id === aiPlaceholder.id
            ? {
              ...message,
              content: `RedClaw 自动执行失败：${detail}`,
              isStreaming: false,
              processingFinishedAt: now,
            }
            : message
        )));
        return;
      }
    }

    let resolvedModelConfig;
    try {
      resolvedModelConfig = await ensureChatModelConfig();
    } catch (error) {
      console.error('Failed to resolve chat model config:', error);
      resolvedModelConfig = undefined;
    }
    const resolvedAttachment = applyAttachmentDeliveryMode(
      attachment,
      resolvedModelConfig?.modelName || getChatModelConfig()?.modelName,
    );

    dispatchChatSend({
      sessionId: targetSessionId || undefined,
      message: runtimeMessage,
      displayContent: displayText,
      attachment: stripTransientAttachmentPreview(resolvedAttachment),
      memberMention: memberMention ? {
        type: 'advisor',
        advisorId: memberMention.id,
        name: memberMention.name,
        avatar: memberMention.avatar,
      } : undefined,
      knowledgeReferences: safeKnowledgeMentions,
      modelConfig: resolvedModelConfig || getChatModelConfig(),
      taskHints: fixedSessionTaskHints,
    });
  };

  const shortcutContext: ChatShortcutContext = {
    input,
    hasInput: Boolean(input.trim()),
    attachment: pendingAttachment,
    selectedMemberMention,
    selectedKnowledgeMentions,
  };

  const shortcuts = resolveChatShortcutProvider(shortcutsProp, [
    { label: '📝 总结内容', text: '请总结以上内容，提炼核心要点。' },
    { label: '💡 提炼观点', text: '请提炼其中的关键观点和洞察。' },
    { label: '✂️ 润色优化', text: '请润色这段内容，使其更具吸引力。' },
    { label: '❓ 延伸提问', text: '基于以上内容，提出3个值得思考的延伸问题。' },
  ], shortcutContext);

  const welcomeShortcuts = resolveChatShortcutProvider(welcomeShortcutsProp, [
    { label: '📄 阅读稿件', text: '请帮我阅读并理解当前的稿件内容。' },
    { label: '✏️ 编辑稿件', text: '我想对当前稿件进行编辑优化，请提供建议。' },
    { label: '🔍 内容分析', text: '请深度分析当前内容，提炼核心观点。' },
    { label: '💡 创作建议', text: '请基于当前内容提供一些创作方向的建议。' }
  ], shortcutContext);

  const applyShortcut = useCallback((shortcut: ChatShortcut) => {
    const action = shortcut.action || 'send';
    if (action === 'inject') {
      setErrorNotice(null);
      setInput(shortcut.text);
      activateComposerInput('composer');
      return;
    }
    void sendMessage(shortcut.text);
  }, [activateComposerInput, sendMessage]);

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
    : 'bg-transparent pb-4 pt-2 md:pb-5';
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
  const shouldCollapseEmptyFixedSession = Boolean(
    collapseEmptyFixedSession &&
    fixedSessionMode &&
    isEmptySession &&
    !showComposer &&
    !showWelcomeHeader &&
    !showWelcomeShortcuts &&
    welcomeActions.length === 0
  );
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
      <CliEscalationDialog
        request={cliEscalationRequest}
        onApprove={handleApproveCliEscalation}
        onDeny={handleDenyCliEscalation}
      />
      <ToolConfirmDialog request={confirmRequest} onConfirm={handleConfirmTool} onCancel={handleCancelTool} />
      <ChatComposer
        ref={composerRef}
        theme={composerTheme}
        variant={variant}
        className={options?.className}
        value={input}
        onValueChange={setInput}
        onSubmit={() => sendMessage(input, pendingAttachment || undefined, selectedMemberMention, selectedKnowledgeMentions)}
        placeholder={placeholder}
        attachment={pendingAttachment}
        attachmentStatus={isAttachmentUploading ? 'uploading' : pendingAttachment ? 'uploaded' : null}
        attachmentPreviewMode={attachmentPreviewMode}
        onPickAttachment={allowFileUpload ? pickAttachment : undefined}
        onClearAttachment={clearPendingAttachment}
        modelOptions={chatModelOptions}
        selectedModelKey={selectedChatModelKey}
        onSelectedModelKeyChange={setSelectedChatModelKey}
        isBusy={isProcessing}
        audioState={isTranscribingAudio ? 'transcribing' : audioRecording.isRecording ? 'recording' : 'idle'}
        onAudioAction={handleAudioInput}
        onCancel={handleCancel}
        showCancelWhenBusy={options?.showCancelWhenBusy}
        trailingContent={options?.showContextUsage ? composerContextUsageIndicator : null}
        onFocus={() => handleComposerFocus(source)}
        suppressed={composerSuppressed}
        onResumeFromSuppressed={() => resumeComposerFocus(source)}
        memberMentionOptions={memberMentionOptions}
        selectedMemberMention={selectedMemberMention}
        onSelectedMemberMentionChange={setSelectedMemberMention}
        knowledgeMentionOptions={knowledgeMentionOptions}
        selectedKnowledgeMentions={selectedKnowledgeMentions}
        onSelectedKnowledgeMentionsChange={setSelectedKnowledgeMentions}
        onKnowledgeMentionSearchQueryChange={handleKnowledgeMentionSearchQueryChange}
      />
    </>
  );

  const welcomeHeaderBlock = showWelcomeHeader ? (
    <>
      <div className="flex flex-col items-center gap-4">
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
        {welcomeIconAccessory ? (
          <div className="flex justify-center">
            {welcomeIconAccessory}
          </div>
        ) : null}
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
          onClick={() => applyShortcut(shortcut)}
          className={darkEmbedded
            ? 'px-3 py-1.5 border border-white/10 rounded-full text-white/62 hover:text-white hover:border-white/20 transition-all cursor-pointer'
            : 'px-3 py-1.5 bg-surface-secondary hover:bg-surface-tertiary border border-transparent hover:border-border rounded-full text-text-secondary hover:text-accent-primary transition-all cursor-pointer'}
        >
          {shortcut.label}
        </button>
      ))}
    </div>
  ) : null;

  const handleWelcomeAction = useCallback(async (action: { label: string; text?: string; url?: string; onClick?: () => void }) => {
    if (action.onClick) {
      action.onClick();
      return;
    }
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
    placeholder || '问我任何问题，使用 @ 引用文件，/ 执行指令...',
    { showContextUsage: true, showCancelWhenBusy: false },
  );

  if (shouldCollapseEmptyFixedSession) {
    return null;
  }

  return (
    <div className={clsx('flex h-full min-w-0', wideContent && 'chat-layout-wide', narrowContent && 'chat-layout-narrow')}>
      {/* Sidebar - Session List (可折叠) - Only show if not fixed session */}
      {!fixedSessionMode && (
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
        {!fixedSessionMode && (
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

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                          onClick={() => applyShortcut(shortcut)}
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
                  {showComposer ? renderComposer('empty', 'empty', placeholder || '问我任何问题，使用 @ 引用文件，/ 执行指令...', {
                    className: 'mt-10',
                    showCancelWhenBusy: false,
                  }) : null}
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
                <div className={clsx('flex min-h-0 flex-1 overflow-hidden', hasInlineSidePanel && splitOuterPaddingClass)}>
                  <div className={clsx(
                    hasInlineSidePanel
                      ? 'mx-auto grid min-h-0 w-full grid-cols-2 gap-4'
                      : 'flex min-h-0 flex-1 overflow-hidden',
                    hasInlineSidePanel && splitContentMaxWidthClass,
                  )}>
                    {/* Messages */}
                    <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className={clsx(hasInlineSidePanel ? 'min-w-0' : 'flex-1', 'overflow-y-auto py-4 md:py-5', paneOuterPaddingClass)}>
                      <div className={clsx('mx-auto min-w-0', messageContentMaxWidthClass, contentWidthClass, dockedEmptyState ? 'flex min-h-full flex-col justify-center' : 'space-y-4 md:space-y-5')}>
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
                                  workflowDisplayMode={messageWorkflowDisplayMode}
                                  workflowAutoHideWhenComplete={messageWorkflowAutoHideWhenComplete}
                                  workflowFailureTone={messageWorkflowFailureTone}
                                  showAttachments={showMessageAttachments}
                                  linkRenderMode={messageLinkRenderMode}
                                  onPreviewLink={onMessageLinkPreview}
                                  activePreviewHref={activePreviewHref}
                                />
                              </ErrorBoundary>
                            ))}
                            {messageListHeader}
                            <div ref={messagesEndRef} />
                          </>
                        )}
                      </div>
                    </div>
                    {inlineSidePanel ? (
                      <div className="min-h-0 min-w-0 py-4 md:py-5">
                        {inlineSidePanel}
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Input Area - Bottom Fixed */}
                {showComposer ? (
                <div className={clsx('shrink-0', inputAreaShellClass, splitOuterPaddingClass)}>
                  <div className={clsx('mx-auto space-y-3.5', composerMaxWidthClass, contentWidthClass)}>
                    {dockedEmptyState ? (
                      emptyComposerForm
                    ) : (
                      <>
                    {errorNotice && (
                      <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-3 text-sm text-red-700 shadow-sm dark:text-red-300">
                        {typeof errorNotice === 'string' ? (
                          <>
                            <div className="font-medium">请求失败</div>
                            <div className="mt-1 text-xs leading-5 text-red-700/85 dark:text-red-300/90">{errorNotice}</div>
                          </>
                        ) : (
                          <>
                            <div className="font-medium">{errorNotice.title}</div>
                            {errorNotice.hint && (
                              <div className="mt-1 text-xs leading-5 text-red-700/85 dark:text-red-300/90">{errorNotice.hint}</div>
                            )}
                            {errorNotice.metaParts && errorNotice.metaParts.length > 0 && (
                              <div className="mt-2 text-[11px] leading-5 text-red-700/70 dark:text-red-300/75">
                                {errorNotice.metaParts.join(' · ')}
                              </div>
                            )}
                            {errorNotice.detail && (
                              <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-[11px] leading-5 text-red-800/85 dark:text-red-200/90">
                                {errorNotice.detail}
                              </pre>
                            )}
                            {errorNotice.action?.target === 'settings-login' && (
                              <button
                                type="button"
                                onClick={handleOpenSettingsLogin}
                                className="mt-3 inline-flex items-center rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-500/15 dark:text-red-200"
                              >
                                {errorNotice.action.label}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {showComposerShortcuts && shortcuts.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto py-1 no-scrollbar">
                        {shortcuts.map((shortcut) => (
                          <button key={shortcut.label} onClick={() => applyShortcut(shortcut)} disabled={isProcessing} className={shortcutChipClass}>
                            {shortcut.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {renderComposer('composer', 'main', placeholder || '发送消息...', {
                      showContextUsage: true,
                      showCancelWhenBusy: true,
                    })}
                      </>
                    )}
                  </div>
                </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
