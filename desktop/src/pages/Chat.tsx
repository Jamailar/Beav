import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { Sparkles, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { supportsAttachmentKindDirectInput } from '../../shared/modelCapabilities';
import { subscribeSettingsUpdated } from '../bridge/appEvents';
import {
  CliEscalationDialog,
  type CliEscalationRequestModel,
  type CliEscalationScope,
} from '../components/CliEscalationDialog';
import { ToolConfirmDialog } from '../components/ToolConfirmDialog';
import {
  buildChatModelOptions,
  ChatComposer,
  type ChatAssetMentionOption,
  type ChatComposerHandle,
  type ChatKnowledgeMentionOption,
  type ChatMemberMentionOption,
  type ChatModelOption,
  type ChatSettingsSnapshot,
  type ChatSkillMentionOption,
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
import type { PendingChatMessage } from '../features/app-shell/types';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { type AudioRecordingClip } from '../features/audio-input/audioInput';
import { resolveUsableTranscript } from '../features/audio-input/transcriptionResult';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { subscribeRuntimeEventStream, type ToolConfirmRequestPayload } from '../runtime/runtimeEventStream';
import { dispatchAppIntent } from '../features/app-shell/appIntent';
import { uiMeasure, uiTraceInteraction } from '../utils/uiDebug';
import { useDocumentThemeMode } from '../hooks/useDocumentThemeMode';
import { ChatDropOverlay } from './chat/ChatDropOverlay';
import { ChatAttachmentActionOverlay } from './chat/ChatAttachmentActionOverlay';
import { useChatAttachments } from './chat/useChatAttachments';

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

interface SkillMentionCatalogRecord {
  id?: string;
  packageId?: string;
  package_id?: string;
  name?: string;
  description?: string;
  location?: string;
  aliases?: string[];
  sourceScope?: string;
  isBuiltin?: boolean;
  disabled?: boolean;
  avatarUrl?: string;
  avatar_url?: string;
  iconUrl?: string;
  icon_url?: string;
  logoUrl?: string;
  logo_url?: string;
  imageUrl?: string;
  image_url?: string;
  thumbnailUrl?: string;
  thumbnail_url?: string;
  authorAvatarUrl?: string;
  author_avatar_url?: string;
}

interface AssetMentionCatalogRecord {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  imagePaths?: string[];
  absoluteImagePaths?: string[];
  previewUrls?: string[];
  primaryPreviewUrl?: string;
  voicePath?: string;
  absoluteVoicePath?: string;
}

interface KnowledgeMentionListPageResponse {
  items?: KnowledgeMentionCatalogRecord[];
  nextCursor?: string | null;
  total?: number;
}

const SKILL_MARKETPLACE_CACHE_STORAGE_KEY = 'redbox:skill-marketplace-cache:v2';
const skillMentionMarketAvatarCache = new Map<string, Partial<ChatSkillMentionOption>>();
let skillMentionMarketAvatarCacheHydrated = false;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeSkillMentionLookupKey(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function recordString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function avatarFieldsFromMarketRecord(record: Record<string, unknown>): Partial<ChatSkillMentionOption> {
  const fields: Partial<ChatSkillMentionOption> = {
    packageId: recordString(record, ['packageId', 'package_id', 'packageKey', 'package_key']),
    avatarUrl: recordString(record, ['avatarUrl', 'avatar_url']),
    iconUrl: recordString(record, ['iconUrl', 'icon_url']),
    logoUrl: recordString(record, ['logoUrl', 'logo_url']),
    imageUrl: recordString(record, ['imageUrl', 'image_url']),
    thumbnailUrl: recordString(record, ['thumbnailUrl', 'thumbnail_url']),
    authorAvatarUrl: recordString(record, ['authorAvatarUrl', 'author_avatar_url']),
  };
  const publisher = isPlainRecord(record.publisher) ? record.publisher : null;
  if (!fields.authorAvatarUrl && publisher) {
    fields.authorAvatarUrl = recordString(publisher, ['avatarUrl', 'avatar_url', 'imageUrl', 'image_url']);
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => Boolean(value))) as Partial<ChatSkillMentionOption>;
}

function marketRecordLookupKeys(record: Record<string, unknown>) {
  const keys = [
    recordString(record, ['packageId', 'package_id', 'packageKey', 'package_key']),
    recordString(record, ['id']),
    recordString(record, ['name', 'title', 'displayName', 'display_name']),
  ];
  const installedSkillNames = Array.isArray(record.installedSkillNames)
    ? record.installedSkillNames
    : Array.isArray(record.installed_skill_names)
      ? record.installed_skill_names
      : [];
  installedSkillNames.forEach((name) => keys.push(String(name || '').trim()));
  return keys.map(normalizeSkillMentionLookupKey).filter(Boolean);
}

function hydrateSkillMentionMarketAvatarCache(options: { force?: boolean } = {}) {
  if (skillMentionMarketAvatarCacheHydrated && !options.force) return;
  skillMentionMarketAvatarCacheHydrated = true;
  if (options.force) {
    skillMentionMarketAvatarCache.clear();
  }
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(SKILL_MARKETPLACE_CACHE_STORAGE_KEY);
    if (!raw) return;
    const snapshot = JSON.parse(raw) as unknown;
    const entries = isPlainRecord(snapshot) && isPlainRecord(snapshot.entries) ? snapshot.entries : {};
    Object.values(entries).forEach((entry) => {
      if (!isPlainRecord(entry) || !Array.isArray(entry.items)) return;
      entry.items.forEach((item) => {
        if (!isPlainRecord(item)) return;
        const fields = avatarFieldsFromMarketRecord(item);
        if (!fields.avatarUrl && !fields.iconUrl && !fields.logoUrl && !fields.imageUrl && !fields.thumbnailUrl && !fields.authorAvatarUrl) {
          return;
        }
        marketRecordLookupKeys(item).forEach((key) => {
          skillMentionMarketAvatarCache.set(key, fields);
        });
      });
    });
  } catch (error) {
    console.warn('Failed to read cached skill marketplace avatars:', error);
  }
}

function cachedSkillMentionAvatarFields(item: SkillMentionCatalogRecord) {
  hydrateSkillMentionMarketAvatarCache();
  const keys = [
    item.packageId,
    item.package_id,
    item.id,
    item.name,
  ].map(normalizeSkillMentionLookupKey).filter(Boolean);
  for (const key of keys) {
    const fields = skillMentionMarketAvatarCache.get(key);
    if (fields) return fields;
  }
  return {};
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

function normalizeSkillMentionRecord(item: SkillMentionCatalogRecord): ChatSkillMentionOption | null {
  const name = String(item.name || '').trim();
  if (!name || item.disabled) return null;
  const cachedAvatarFields = cachedSkillMentionAvatarFields(item);
  return {
    name,
    description: String(item.description || '').trim() || undefined,
    location: String(item.location || '').trim() || undefined,
    sourceScope: String(item.sourceScope || '').trim() || undefined,
    isBuiltin: Boolean(item.isBuiltin),
    aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias || '').trim()).filter(Boolean) : [],
    packageId: String(item.packageId || item.package_id || cachedAvatarFields.packageId || '').trim() || undefined,
    avatarUrl: String(item.avatarUrl || item.avatar_url || cachedAvatarFields.avatarUrl || '').trim() || undefined,
    iconUrl: String(item.iconUrl || item.icon_url || cachedAvatarFields.iconUrl || '').trim() || undefined,
    logoUrl: String(item.logoUrl || item.logo_url || cachedAvatarFields.logoUrl || '').trim() || undefined,
    imageUrl: String(item.imageUrl || item.image_url || cachedAvatarFields.imageUrl || '').trim() || undefined,
    thumbnailUrl: String(item.thumbnailUrl || item.thumbnail_url || cachedAvatarFields.thumbnailUrl || '').trim() || undefined,
    authorAvatarUrl: String(item.authorAvatarUrl || item.author_avatar_url || cachedAvatarFields.authorAvatarUrl || '').trim() || undefined,
  };
}

function normalizePendingSkillMentions(pendingMessage: PendingChatMessage): ChatSkillMentionOption[] {
  const byName = new Map<string, ChatSkillMentionOption>();
  const add = (item: SkillMentionCatalogRecord | string | null | undefined) => {
    const record = typeof item === 'string' ? { name: item } : item;
    if (!record) return;
    const normalized = normalizeSkillMentionRecord(record);
    if (!normalized) return;
    byName.set(normalized.name, normalized);
  };
  (pendingMessage.skillMentions || []).forEach(add);
  const activeSkills = pendingMessage.taskHints?.activeSkills;
  if (byName.size === 0 && Array.isArray(activeSkills)) {
    activeSkills.forEach(add);
  }
  return [...byName.values()];
}

function normalizeAssetMentionRecord(item: AssetMentionCatalogRecord): ChatAssetMentionOption | null {
  const id = String(item.id || '').trim();
  const name = String(item.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    description: String(item.description || '').trim() || undefined,
    categoryId: String(item.categoryId || '').trim() || undefined,
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
    imagePaths: Array.isArray(item.imagePaths) ? item.imagePaths.map((path) => String(path || '').trim()).filter(Boolean) : [],
    absoluteImagePaths: Array.isArray(item.absoluteImagePaths) ? item.absoluteImagePaths.map((path) => String(path || '').trim()).filter(Boolean) : [],
    previewUrls: Array.isArray(item.previewUrls) ? item.previewUrls.map((url) => String(url || '').trim()).filter(Boolean) : [],
    primaryPreviewUrl: String(item.primaryPreviewUrl || '').trim() || undefined,
    voicePath: String(item.voicePath || '').trim() || undefined,
    absoluteVoicePath: String(item.absoluteVoicePath || '').trim() || undefined,
  };
}

function mergeSkillMentionsIntoTaskHints(
  taskHints: unknown,
  skillMentions: ChatSkillMentionOption[],
): unknown {
  const skillNames = skillMentions
    .map((item) => item.name.trim())
    .filter(Boolean);
  if (skillNames.length === 0) return taskHints;
  const base = taskHints && typeof taskHints === 'object' && !Array.isArray(taskHints)
    ? { ...(taskHints as Record<string, unknown>) }
    : {};
  const existing = Array.isArray(base.activeSkills)
    ? base.activeSkills.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  base.activeSkills = Array.from(new Set([...existing, ...skillNames]));
  return base;
}

function chatModelConfigFromOption(option: ChatModelOption | null | undefined) {
  if (!option) return undefined;
  return {
    apiKey: option.apiKey,
    baseURL: option.baseURL,
    modelName: option.modelName,
    sourceId: option.sourceId,
    presetId: option.presetId,
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
  displayContent?: string;
  action?: 'send' | 'inject';
  attachments?: UploadedFileAttachment[];
}

export interface ChatShortcutContext {
  input: string;
  hasInput: boolean;
  attachment: UploadedFileAttachment | null;
  attachments?: UploadedFileAttachment[];
  selectedMemberMention: ChatMemberMentionOption | null;
  selectedKnowledgeMentions: ChatKnowledgeMentionOption[];
}

export type ChatShortcutProvider = ChatShortcut[] | ((context: ChatShortcutContext) => ChatShortcut[]);

interface EnsureSessionForSendOptions {
  onCreated?: (sessionId: string) => void;
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
  pendingMessage?: PendingChatMessage | null;
  onMessageConsumed?: () => void;
  fixedSessionId?: string | null;
  fixedSessionDraft?: boolean;
  onEnsureSessionForSend?: (defaultTitle?: string, options?: EnsureSessionForSendOptions) => Promise<string | null>;
  initialChatModelKey?: string;
  onChatModelKeyChange?: (key: string) => void;
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
  onSessionActivity?: (sessionId: string, updatedAt: string) => void;
  analyticsContext?: {
    surface?: string;
    runtimeMode?: string;
  };
  clearSignal?: number;
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
  tone: 'neutral' | 'warning' | 'danger';
  kind: 'billing' | 'auth' | 'rate-limit' | 'network' | 'model' | 'attachment' | 'critical' | 'generic';
  action?: {
    label: string;
    target: 'settings-login';
  };
}

const CHAT_ERROR_NOTICE_AUTO_DISMISS_MS = 6500;
const CHAT_ERROR_NOTICE_ACTION_AUTO_DISMISS_MS = 15000;

function stripTransientAttachmentPreview(
  attachment?: UploadedFileAttachment,
): UploadedFileAttachment | undefined {
  if (!attachment) return undefined;
  const { thumbnailDataUrl: _thumbnailDataUrl, ...persisted } = attachment;
  return persisted;
}

function stripTransientMessageAttachmentPreview(
  attachment?: Message['attachment'],
): Message['attachment'] | undefined {
  if (!attachment) return undefined;
  if (attachment.type !== 'uploaded-file') return attachment;
  return stripTransientAttachmentPreview(attachment as UploadedFileAttachment) as Message['attachment'];
}

function defaultSessionTitleFromMessage(message: string): string {
  return Array.from(String(message || '').trim()).slice(0, 15).join('');
}

function attachmentKind(attachment: UploadedFileAttachment | undefined): string {
  return String(attachment?.kind || '').trim().toLowerCase() || 'binary';
}

function hasStableToolPath(attachment: UploadedFileAttachment | undefined): boolean {
  return Boolean(String(attachment?.toolPath || attachment?.workspaceRelativePath || '').trim());
}

function attachmentCapability(
  attachment: UploadedFileAttachment | undefined,
  key: keyof NonNullable<UploadedFileAttachment['capabilities']>,
): boolean {
  const value = attachment?.capabilities?.[key];
  if (typeof value === 'boolean') return value;
  const kind = attachmentKind(attachment);
  const hasToolPath = hasStableToolPath(attachment);
  if (key === 'workspaceRead') return hasToolPath;
  if (key === 'textExtract') return hasToolPath && kind === 'text';
  if (key === 'documentExtract') return hasToolPath && kind === 'document';
  if (key === 'imageVision') return kind === 'image';
  if (key === 'audioTranscribe') return hasToolPath && kind === 'audio';
  if (key === 'videoAnalyze' || key === 'videoEdit') return hasToolPath && kind === 'video';
  if (key === 'directInput') return Boolean(attachment?.directUploadEligible) || ['image', 'audio', 'video', 'text', 'document'].includes(kind);
  return false;
}

function toolDeliveryModeForAttachment(attachment: UploadedFileAttachment): string {
  const explicit = String(attachment.deliveryPlan?.mode || '').trim();
  if (explicit && explicit !== 'direct-input') return explicit;
  const kind = attachmentKind(attachment);
  if (!hasStableToolPath(attachment)) return 'unsupported';
  if (kind === 'document') return 'document-tool';
  if (kind === 'image' || kind === 'audio' || kind === 'video') return 'media-tool';
  return 'workspace-tool';
}

function withAttachmentDeliveryPlan(
  attachment: UploadedFileAttachment,
  mode: 'direct-input' | 'tool-read',
): UploadedFileAttachment {
  if (mode === 'direct-input') {
    return {
      ...attachment,
      deliveryMode: 'direct-input',
      deliveryPlan: {
        ...(attachment.deliveryPlan || {}),
        mode: 'direct-input',
        requiresTool: false,
        toolPath: attachment.toolPath || attachment.workspaceRelativePath || attachment.deliveryPlan?.toolPath,
      },
    };
  }
  const toolMode = toolDeliveryModeForAttachment(attachment);
  return {
    ...attachment,
    deliveryMode: 'tool-read',
    deliveryPlan: {
      ...(attachment.deliveryPlan || {}),
      mode: toolMode,
      requiresTool: toolMode !== 'unsupported',
      toolPath: attachment.toolPath || attachment.workspaceRelativePath || attachment.deliveryPlan?.toolPath,
      reason: toolMode === 'unsupported'
        ? (attachment.deliveryPlan?.reason || '文件未进入工作区暂存区，当前工具无法稳定读取。')
        : attachment.deliveryPlan?.reason,
    },
  };
}

function applyAttachmentDeliveryMode(
  attachment: UploadedFileAttachment | undefined,
  modelName?: string,
): UploadedFileAttachment | undefined {
  if (!attachment) return undefined;
  if (attachment.intakeStatus && attachment.intakeStatus !== 'ready') {
    return withAttachmentDeliveryPlan(attachment, 'tool-read');
  }
  const directInput = Boolean(
    modelName
    && attachmentCapability(attachment, 'directInput')
    && supportsAttachmentKindDirectInput(modelName, attachmentKind(attachment)),
  );
  return withAttachmentDeliveryPlan(attachment, directInput ? 'direct-input' : 'tool-read');
}

function applyAttachmentsDeliveryMode(
  attachments: UploadedFileAttachment[],
  modelName?: string,
): UploadedFileAttachment[] {
  return attachments
    .map((attachment) => applyAttachmentDeliveryMode(attachment, modelName))
    .filter((attachment): attachment is UploadedFileAttachment => Boolean(attachment));
}

function commitAttachmentForSend(attachment: UploadedFileAttachment): UploadedFileAttachment {
  return {
    ...attachment,
    attachmentLifecycle: 'committed',
  };
}

function commitAttachmentsForSend(attachments: UploadedFileAttachment[]): UploadedFileAttachment[] {
  return attachments.map(commitAttachmentForSend);
}

function attachmentSendBlockReason(attachment: UploadedFileAttachment | undefined): string {
  if (!attachment) return '';
  if (attachment.intakeStatus && attachment.intakeStatus !== 'ready') {
    return attachment.deliveryPlan?.reason || '这个文件还没有进入可处理状态，暂时不能发送给 AI。';
  }
  if (!hasStableToolPath(attachment) && !attachment.inlineDataUrl && !attachment.directUploadEligible) {
    return '这个文件没有可控的暂存路径，AI 工具无法稳定读取。请重新拖入或选择文件。';
  }
  return '';
}

function attachmentsSendBlockReason(attachments: UploadedFileAttachment[]): string {
  for (const attachment of attachments) {
    const reason = attachmentSendBlockReason(attachment);
    if (reason) return reason;
  }
  return '';
}

function uploadedFileAttachmentsFromMessageAttachment(attachment: Message['attachment'] | undefined): UploadedFileAttachment[] {
  if (!attachment || attachment.type !== 'uploaded-file') return [];
  return [attachment as UploadedFileAttachment];
}

function createAttachmentPayload(attachments: UploadedFileAttachment[]): Message['attachment'] | undefined {
  if (attachments.length === 0) return undefined;
  return attachments[0] as Message['attachment'];
}

function uploadedAttachmentsFromMessage(message: Message): UploadedFileAttachment[] {
  const items = message.attachments && message.attachments.length > 0
    ? message.attachments
    : message.attachment
      ? [message.attachment]
      : [];
  return items.filter((attachment): attachment is UploadedFileAttachment => (
    Boolean(attachment) && attachment.type === 'uploaded-file'
  ));
}

function latestReusableVideoAttachments(messages: Message[]): UploadedFileAttachment[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const videoAttachments = uploadedAttachmentsFromMessage(messages[index])
      .filter((attachment) => attachmentShortcutKind(attachment) === 'video');
    if (videoAttachments.length > 0) {
      return videoAttachments;
    }
  }
  return [];
}

type FixedSessionWarmSnapshot = {
  messages: Message[];
  contextUsage: ChatContextUsage | null;
  capturedAt: number;
};

const FIXED_SESSION_SNAPSHOT_TTL_MS = 30_000;
const fixedSessionWarmSnapshots = new Map<string, FixedSessionWarmSnapshot>();
const fixedSessionInflightLoads = new Map<string, Promise<[unknown[], ChatRuntimeState | null, unknown[]]>>();

function shouldPreserveFixedSessionWarmMessages(
  warm: FixedSessionWarmSnapshot | null,
  history: unknown[],
  options: { runtimeKnownComplete?: boolean } = {},
): warm is FixedSessionWarmSnapshot {
  if (!warm?.messages.length) return false;
  if (options.runtimeKnownComplete && history.length >= warm.messages.length) return false;
  const hasActivePlaceholder = warm.messages.some((message) => message.role === 'ai' && message.isStreaming);
  return hasActivePlaceholder && history.length < warm.messages.length;
}

function resolveChatShortcutProvider(
  provider: ChatShortcutProvider | undefined,
  fallback: ChatShortcut[],
  context: ChatShortcutContext,
): ChatShortcut[] {
  return provider ? (typeof provider === 'function' ? provider(context) : provider) : fallback;
}

function attachmentShortcutKind(attachment: UploadedFileAttachment | null): 'image' | 'video' | 'file' | null {
  if (!attachment) return null;
  const kind = attachmentKind(attachment);
  const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
  const ext = String(attachment.ext || '').trim().toLowerCase();
  if (kind === 'image' || mimeType.startsWith('image/')) return 'image';
  if (kind === 'video' || mimeType.startsWith('video/')) return 'video';
  if (kind === 'audio' || mimeType.startsWith('audio/')) return 'file';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'video';
  return 'file';
}

function attachmentActionIdentity(attachment: UploadedFileAttachment): string {
  return String(
    attachment.attachmentId
    || attachment.workspaceRelativePath
    || attachment.toolPath
    || attachment.absolutePath
    || attachment.originalAbsolutePath
    || attachment.inlineDataUrl
    || attachment.name
  ).trim();
}

function attachmentActionKey(attachments: UploadedFileAttachment[]): string {
  return attachments
    .map((attachment) => attachmentActionIdentity(attachment))
    .filter(Boolean)
    .join('|');
}

function defaultComposerShortcuts(context: ChatShortcutContext): ChatShortcut[] {
  const attachmentKind = attachmentShortcutKind(context.attachment);
  const attachment = context.attachment || undefined;
  if (attachmentKind === 'image' && attachmentCapability(attachment, 'imageVision')) {
    return [
      {
        label: '生成电商套图',
        text: [
          '请基于我上传的图片执行「电商套图生成」工作流。',
          '',
          '工作流要求：',
          '1. 先分析图片主体、可售卖点、适用人群、使用场景、画面风格和潜在转化诉求。',
          '2. 判断这张图最适合做主图、卖点图、场景图、细节图还是对比图，并说明判断依据。',
          '3. 设计一套 5 张左右的电商套图：每张图都要包含画面目标、构图、主标题、副文案、素材需求、视觉风格和注意事项。',
          '4. 为每张图输出可直接用于生成图片的提示词，提示词要包含主体、背景、构图、光线、材质、色彩、比例和风格约束。',
          '5. 最后给出最推荐先生成的 1 张图，并说明原因。',
        ].join('\n'),
      },
      {
        label: '生成封面图',
        text: [
          '请基于我上传的图片执行「封面图生成」工作流。',
          '',
          '工作流要求：',
          '1. 先分析图片里最适合作为封面钩子的主体、情绪、反差、场景和视觉焦点。',
          '2. 给出 3 个封面方向，每个方向包含目标受众、主标题、辅助文案、构图、字体感觉、色彩和视觉重心。',
          '3. 标出原图里必须保留、可以弱化、应该避开的元素。',
          '4. 为最推荐方向输出一条可直接生成封面图的完整提示词。',
          '5. 最终回复用简洁结构输出，不要写成泛泛建议。',
        ].join('\n'),
      },
      {
        label: '生成同款图',
        text: [
          '请基于我上传的图片执行「同款视觉生成」工作流。',
          '',
          '工作流要求：',
          '1. 拆解原图的构图、镜头距离、光线、色彩、材质、主体姿态、背景层次和整体风格。',
          '2. 提炼可复用的视觉 DNA，但不要要求复制原图、商标、人物身份或受版权保护的具体元素。',
          '3. 生成 3 组同款视觉方案，分别偏产品展示、生活方式、社媒封面。',
          '4. 每组都给出完整图片生成提示词和负面约束。',
          '5. 说明哪一组最适合继续商业化使用。',
        ].join('\n'),
      },
      {
        label: '提取卖点文案',
        text: [
          '请基于我上传的图片执行「卖点文案提取」工作流。',
          '',
          '工作流要求：',
          '1. 先识别图片里的产品、场景、用户利益、情绪价值和视觉证据。',
          '2. 提炼可用于转化的卖点，不要编造图片无法支持的参数、功效或事实。',
          '3. 输出 10 条短标题、5 条详情页卖点文案、5 条社媒投放短文案。',
          '4. 每条文案都要标注适用位置：主图、详情页、封面、广告、社媒正文。',
          '5. 最后给出最推荐的一组标题 + 副文案组合。',
        ].join('\n'),
      },
    ];
  }
  if (attachmentKind === 'video' && (attachmentCapability(attachment, 'videoAnalyze') || attachmentCapability(attachment, 'videoEdit'))) {
    return [
      {
        label: '爆款分析',
        text: [
          '请基于我上传的视频执行「爆款分析」工作流。',
          '',
          '工作流要求：',
          '1. 先调用视频分析能力完整读取视频内容，不要只凭文件名或封面判断。',
          '2. 分析前 3 秒钩子、核心主题、情绪曲线、节奏变化、内容结构、视觉记忆点和可复用金句。',
          '3. 标出最可能带来完播、收藏、评论或转发的片段，并说明原因。',
          '4. 判断当前视频的主要问题：开头、节奏、信息密度、表达顺序、画面素材、字幕或结尾行动号召。',
          '5. 输出一版爆款改造方案：新标题、开头重写、结构调整、剪辑节奏、字幕策略和发布建议。',
          '6. 不要声称分析报告已保存；只有在工具成功写入文件并返回路径后，才能输出“已保存”和对应路径。',
        ].join('\n'),
      },
      {
        label: '字幕提取',
        text: [
          '请基于我上传的视频执行「字幕提取」工作流。',
          '',
          '工作流要求：',
          '1. 优先调用可用的字幕/语音识别能力提取视频字幕或语音内容。',
          '2. 尽量保留时间顺序；如果工具能生成 SRT/VTT/TXT 字幕文件，请生成并输出文件路径。',
          '3. 对听不清、多人重叠、疑似错字或需要人工确认的片段单独标注。',
          '4. 输出一版可直接复制使用的清洁字幕文本。',
          '5. 最后总结视频的核心内容，方便我确认字幕是否覆盖完整。',
        ].join('\n'),
      },
      {
        label: '剪辑切片',
        text: [
          '请基于我上传的视频执行「剪辑切片」工作流。',
          '',
          '工作流要求：',
          '1. 先调用视频分析能力完整分析视频，找出最精彩、最适合独立发布的切片片段。',
          '2. 每个候选片段都要给出开始时间、结束时间、片段主题、爆点理由、适合平台和推荐标题。',
          '3. 选择最值得产出的片段，调用可用的视频处理能力把这些片段剪辑成独立视频文件。',
          '4. 每个成片都要尽量保留上下文完整性，不要只剪一句没有前后语义的话。',
          '5. 最终输出切片清单、生成后的文件路径、推荐发布顺序和每个切片的标题建议。',
          '6. 只使用工具返回的真实文件路径，不要编造只有文件名的链接。',
        ].join('\n'),
      },
    ];
  }
  if (attachmentKind === 'file' && (
    attachmentCapability(attachment, 'workspaceRead')
    || attachmentCapability(attachment, 'textExtract')
    || attachmentCapability(attachment, 'documentExtract')
  )) {
    return [
      { label: '变成口播稿', text: '请把这个文件内容改写成一篇自然、有节奏的口播稿。' },
      { label: '变成讲解漫画', text: '请把这个文件内容改编成讲解漫画脚本，包括分镜、画面说明和对白。' },
      { label: '做成AI视频', text: '请把这个文件内容改编成 AI 视频方案，包括脚本、镜头和画面提示词。' },
      { label: '改写成短文', text: '请把这个文件内容改写成一篇适合社交平台发布的短文。' },
    ];
  }
  return [
    { label: '📝 总结内容', text: '请总结以上内容，提炼核心要点。' },
    { label: '💡 提炼观点', text: '请提炼其中的关键观点和洞察。' },
    { label: '✂️ 润色优化', text: '请润色这段内容，使其更具吸引力。' },
    { label: '❓ 延伸提问', text: '基于以上内容，提出3个值得思考的延伸问题。' },
  ];
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

export function clearFixedSessionWarmSnapshot(sessionId: string | null | undefined): void {
  const key = String(sessionId || '').trim();
  if (!key) return;
  fixedSessionWarmSnapshots.delete(key);
  fixedSessionInflightLoads.delete(key);
}

function deriveKnowledgeTitleFromMessage(content: string): string {
  const firstLine = String(content || '')
    .split(/\r?\n/)
    .map((line) => line
      .trim()
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*>\s]+/, '')
      .trim())
    .find(Boolean);
  const collapsed = String(firstLine || content || '对话知识').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 72) return collapsed || '对话知识';
  return `${collapsed.slice(0, 72)}…`;
}

function knowledgeSourceRoleForMessage(message: Message): string {
  return message.role === 'ai' ? 'assistant' : 'user';
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

function normalizeTimelineCommentarySegment(content: string): string {
  return String(content || '').replace(/\n{3,}/g, '\n\n').trim();
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

function findLastRunningTimelineCommentaryIndex(timeline: ProcessItem[]): number {
  return findLatestTimelineItemIndex(
    timeline,
    (item) => item.type === 'commentary' && item.status === 'running',
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
  const sourceTitle = String(data.title || data.message || '').trim();
  const detail = String(data.detail || data.raw || '').trim();
  const hint = String(data.hint || '').trim();
  const layer = String(data.layer || data.category || '').trim();
  const statusCode = data.httpStatus || data.statusCode;
  const errorCode = String(data.errorCode || '').trim();
  const searchable = [
    sourceTitle,
    detail,
    hint,
    layer,
    errorCode,
  ].join(' ').replace(/\s+/g, ' ').trim();
  const normalizedSearchable = searchable.replace(/\s+/g, '').toLowerCase();
  const includesAny = (patterns: Array<string | RegExp>) => patterns.some((pattern) => (
    typeof pattern === 'string'
      ? normalizedSearchable.includes(pattern.toLowerCase())
      : pattern.test(searchable)
  ));
  const isBilling = includesAny([
    '余额不足',
    '积分不足',
    '额度不足',
    'insufficientbalance',
    'insufficientcredit',
    'insufficientquota',
    'notenoughpoints',
    'pointsnotenough',
  ]);
  const isAuth = includesAny(['登陆失效', '登录失效', '未登录', '请先登录', 'unauthorized', 'invalidtoken', 'tokenexpired']);
  const isRateLimit = statusCode === 429 || includesAny(['ratelimit', 'toomanyrequests', '请求过于频繁', '限流']);
  const isNetwork = [408, 500, 502, 503, 504].includes(Number(statusCode || 0))
    || includesAny(['timeout', 'timedout', 'fetchfailed', 'badgateway', 'gatewaytimeout', 'serviceunavailable', 'operationwasaborted', '网络']);
  const isModel = includesAny(['modelnotfound', 'unsupportedmodel', '模型不可用', '模型不支持', 'modelunavailable']);
  const isAttachment = includesAny(['attachment', 'filetoolarge', 'unsupportedfile', '不支持该文件', '附件']);
  const isCritical = !isBilling && !isAuth && !isRateLimit && !isNetwork && !isModel && !isAttachment
    && includesAny(['permissiondenied', 'forbidden', '安全策略', '数据损坏', 'fatal', 'panic']);
  const kind: StructuredChatErrorNotice['kind'] = isBilling
    ? 'billing'
    : isAuth
      ? 'auth'
      : isRateLimit
        ? 'rate-limit'
        : isNetwork
          ? 'network'
          : isModel
            ? 'model'
            : isAttachment
              ? 'attachment'
              : isCritical
                ? 'critical'
                : 'generic';
  const tone: StructuredChatErrorNotice['tone'] = kind === 'critical' ? 'danger' : kind === 'billing' || kind === 'rate-limit' ? 'warning' : 'neutral';
  const title = (() => {
    if (kind === 'billing') return '余额不足';
    if (kind === 'auth') return '账号需要确认';
    if (kind === 'rate-limit') return '请求太频繁';
    if (kind === 'network') return '服务暂时不可用';
    if (kind === 'model') return '当前模型不可用';
    if (kind === 'attachment') return '附件暂时无法处理';
    return sourceTitle || '请求没有完成';
  })();
  const friendlyHint = (() => {
    if (hint) return hint;
    if (kind === 'billing') return '积分不够，本次请求没有继续执行。';
    if (kind === 'auth') return '登录状态可能已过期，确认账号后可以继续。';
    if (kind === 'rate-limit') return '稍等一下再试即可。';
    if (kind === 'network') return '上游服务短暂不可用，可以稍后重试。';
    if (kind === 'model') return '换一个可用模型后再发送。';
    if (kind === 'attachment') return '可以换一个模型或移除这个附件后重试。';
    return '';
  })();
  const metaParts = [
    statusCode ? `HTTP ${statusCode}` : '',
    errorCode,
    layer || '',
    data.transportMode ? `transport:${String(data.transportMode)}` : '',
    data.retryable ? '可重试' : '',
  ].filter(Boolean);
  return {
    title,
    hint: friendlyHint || undefined,
    detail: detail || undefined,
    tone,
    kind,
    metaParts: metaParts.length > 0 ? metaParts : undefined,
    action: kind === 'billing'
      ? { label: '去充值', target: 'settings-login' }
      : kind === 'auth'
      ? { label: '查看账号', target: 'settings-login' }
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

type PersistedRuntimeEvent = {
  id?: string;
  eventType?: string;
  event_type?: string;
  payload?: unknown;
  createdAt?: number | string;
  created_at?: number | string;
  toolCallId?: string | null;
  tool_call_id?: string | null;
};

function runtimeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function runtimeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function runtimeEventType(event: PersistedRuntimeEvent): string {
  return runtimeText(event.eventType || event.event_type);
}

function runtimeEventCreatedAt(event: PersistedRuntimeEvent): number {
  const raw = event.createdAt ?? event.created_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function runtimeEventId(event: PersistedRuntimeEvent, fallback: string): string {
  return runtimeText(event.id) || fallback;
}

function checkpointTypeFromSummary(value: string): string {
  const match = value.match(/"checkpointType"\s*:\s*"([^"]+)"/);
  return match?.[1] || '';
}

function parseRuntimeJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizePersistedCheckpointPayload(payload: Record<string, unknown>): {
  checkpointType: string;
  checkpointPayload: Record<string, unknown>;
  summary: string;
} {
  let checkpointType = runtimeText(payload.checkpointType || payload.checkpoint_type);
  let checkpointPayload = runtimeObject(payload.payload);
  let summary = runtimeText(payload.summary);

  if ((!checkpointType || Object.keys(checkpointPayload).length === 0) && summary) {
    const parsed = parseRuntimeJsonObject(summary);
    if (parsed) {
      checkpointType = checkpointType || runtimeText(parsed.checkpointType || parsed.checkpoint_type);
      checkpointPayload = Object.keys(checkpointPayload).length > 0
        ? checkpointPayload
        : runtimeObject(parsed.payload);
      summary = runtimeText(parsed.summary) || summary;
    } else {
      checkpointType = checkpointType || checkpointTypeFromSummary(summary);
    }
  }

  if (!checkpointType && summary) {
    checkpointType = checkpointTypeFromSummary(summary);
  }

  if (checkpointType === 'chat.error' && Object.keys(checkpointPayload).length === 0 && summary) {
    checkpointPayload = {
      detail: summary,
      message: '执行异常',
      raw: summary,
    };
  }

  return { checkpointType, checkpointPayload, summary };
}

function shouldFailRunningTimelineItem(item: ProcessItem): boolean {
  return (
    item.type === 'tool-call'
    || item.type === 'cli-install'
    || item.type === 'cli-exec'
    || item.type === 'cli-escalation'
    || item.type === 'cli-verify'
  );
}

function finalizeRunningTimelineItems(
  timeline: ProcessItem[],
  timestamp: number,
  failed: boolean,
): ProcessItem[] {
  return timeline.map((item) => {
    if (item.status !== 'running') return item;
    return {
      ...item,
      status: failed && shouldFailRunningTimelineItem(item) ? 'failed' : 'done',
      duration: Math.max(0, timestamp - item.timestamp),
    } as ProcessItem;
  });
}

function latestWarmStreamingStartedAt(warm: FixedSessionWarmSnapshot | null): number | null {
  if (!warm?.messages.length) return null;
  let latest: number | null = null;
  warm.messages.forEach((message) => {
    if (message.role !== 'ai' || !message.isStreaming) return;
    const startedAt = typeof message.processingStartedAt === 'number'
      ? message.processingStartedAt
      : parseMessageTimestampMs(message.id);
    if (typeof startedAt !== 'number') return;
    latest = latest === null ? startedAt : Math.max(latest, startedAt);
  });
  return latest;
}

function hasTerminalRuntimeEventAfterWarmSnapshot(
  warm: FixedSessionWarmSnapshot | null,
  eventsRaw: unknown,
): boolean {
  const startedAt = latestWarmStreamingStartedAt(warm);
  const events = Array.isArray(eventsRaw) ? eventsRaw as PersistedRuntimeEvent[] : [];
  if (startedAt === null || events.length === 0) return false;

  return events.some((event) => {
    const eventCreatedAt = runtimeEventCreatedAt(event);
    if (eventCreatedAt < startedAt) return false;
    const eventType = runtimeEventType(event);
    if (eventType === 'runtime:done') return true;
    if (eventType !== 'runtime:checkpoint' && eventType !== 'task_checkpoint_saved') return false;
    const payload = runtimeObject(event.payload);
    const { checkpointType } = normalizePersistedCheckpointPayload(payload);
    return (
      checkpointType === 'chat.error'
      || checkpointType === 'chat.cancelled'
      || checkpointType === 'chat.response_end'
    );
  });
}

function stringifyRuntimePreview(value: unknown, maxLength = 420): string {
  if (typeof value === 'string') return value.slice(0, maxLength);
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength - 1)}...` : serialized;
  } catch {
    return '';
  }
}

const RUNTIME_EVENT_MESSAGE_TIME_TOLERANCE_MS = 1_500;
const INTERNAL_RUNTIME_STATUS_PREFIXES = [
  '系统状态更新：',
  '你正在处理一个图片生成后台进度回传。',
  '你正在处理一个图片生成后台回传任务。',
  '你正在处理一个视频生成后台进度回传。',
  '你正在处理一个视频生成后台回传任务。',
  '你正在处理一个音频生成后台进度回传。',
  '你正在处理一个音频生成后台回传任务。',
];

function isInternalRuntimeStatusText(value: unknown): boolean {
  const content = String(value || '').trim();
  if (
    (content.startsWith('<skill>') && content.includes('</skill>'))
    || (content.startsWith('<skills_instructions>') && content.includes('</skills_instructions>'))
  ) {
    return true;
  }
  return INTERNAL_RUNTIME_STATUS_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function isInternalRuntimeStatusMessage(message: Pick<Message, 'role' | 'content' | 'displayContent'>): boolean {
  if (message.role !== 'user') return false;
  return isInternalRuntimeStatusText(message.displayContent || message.content);
}

function latestUserMessageIndexBeforeRuntimeEvent(
  messages: Message[],
  messageTimes: Array<number | undefined>,
  eventCreatedAt: number,
): number {
  let latestUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role !== 'user') continue;
    const messageTime = messageTimes[index];
    if (
      typeof messageTime !== 'number'
      || messageTime <= eventCreatedAt + RUNTIME_EVENT_MESSAGE_TIME_TOLERANCE_MS
    ) {
      latestUserIndex = index;
    }
  }
  return latestUserIndex;
}

function persistedRuntimeTargetAssistantIndex(
  messages: Message[],
  messageTimes: Array<number | undefined>,
  eventCreatedAt: number,
): number {
  const latestUserIndex = latestUserMessageIndexBeforeRuntimeEvent(messages, messageTimes, eventCreatedAt);
  let fallback = -1;
  for (let index = Math.max(0, latestUserIndex + 1); index < messages.length; index += 1) {
    if (messages[index].role === 'user') break;
    if (messages[index].role !== 'ai') continue;
    fallback = index;
    const messageTime = messageTimes[index];
    if (
      typeof messageTime !== 'number'
      || eventCreatedAt <= messageTime + RUNTIME_EVENT_MESSAGE_TIME_TOLERANCE_MS
    ) {
      return index;
    }
  }
  return fallback;
}

function ensureRuntimeReplayAssistantMessage(
  messages: Message[],
  messageTimes: Array<number | undefined>,
  eventCreatedAt: number,
): number {
  const latestUserIndex = latestUserMessageIndexBeforeRuntimeEvent(messages, messageTimes, eventCreatedAt);
  if (latestUserIndex === -1) return -1;

  const insertAt = latestUserIndex + 1;
  const userCreatedAt = messageTimes[latestUserIndex];
  const timestamp = Number.isFinite(eventCreatedAt) ? eventCreatedAt : Date.now();
  const id = `runtime_replay_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
  messages.splice(insertAt, 0, {
    id,
    role: 'ai',
    messageType: 'reply',
    content: '',
    tools: [],
    timeline: [],
    isStreaming: true,
    processingStartedAt: typeof userCreatedAt === 'number' ? userCreatedAt : timestamp,
  });
  messageTimes.splice(insertAt, 0, timestamp);
  return insertAt;
}

function shouldCreateRuntimeReplayAssistantMessage(
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  if (eventType === 'runtime:text-delta' || eventType === 'text_delta') {
    const content = runtimeText(payload.content);
    const stream = runtimeText(payload.stream || 'response');
    const messagePhase = runtimeText(payload.messagePhase || (stream === 'thought' ? 'thought' : 'final_answer'));
    return Boolean(content && (messagePhase === 'commentary' || messagePhase === 'thought' || stream === 'thought'));
  }
  if (
    eventType === 'runtime:tool-start'
    || eventType === 'runtime:tool-update'
    || eventType === 'runtime:tool-end'
    || eventType === 'tool_request'
    || eventType === 'tool_result'
  ) {
    return true;
  }
  if (eventType === 'runtime:checkpoint' || eventType === 'task_checkpoint_saved') {
    const { checkpointType, checkpointPayload } = normalizePersistedCheckpointPayload(payload);
    return Boolean(
      checkpointType === 'chat.error'
      || checkpointType === 'chat.skill_activated'
      || runtimeText(checkpointPayload.detail || checkpointPayload.message || checkpointPayload.raw)
    );
  }
  return false;
}

function pushOrMergeNarrationItem(
  timeline: ProcessItem[],
  type: 'commentary' | 'thought',
  content: string,
  timestamp: number,
  id: string,
) {
  const normalized = normalizeTimelineCommentarySegment(content);
  if (!normalized) return;
  const last = timeline[timeline.length - 1];
  if (last?.type === type && last.status === 'done') {
    last.content = type === 'thought'
      ? mergeThoughtDelta(last.content || '', normalized)
      : mergeAssistantContent(last.content || '', normalized);
    return;
  }
  timeline.push({
    id,
    type,
    content: normalized,
    status: 'done',
    timestamp,
    duration: 0,
  });
}

function upsertPersistedToolItem(
  timeline: ProcessItem[],
  eventType: string,
  payload: Record<string, unknown>,
  timestamp: number,
  eventId: string,
  recordToolCallId?: string | null,
) {
  const output = runtimeObject(payload.output);
  const callId = runtimeText(payload.callId || payload.toolCallId || payload.tool_call_id || recordToolCallId || eventId);
  const name = runtimeText(payload.name || payload.toolName || payload.tool_name) || 'tool_call';
  const isTerminal = eventType === 'runtime:tool-end' || eventType === 'tool_result';
  const partial = output.partial === true || payload.partial === true;
  const failed = output.success === false || runtimeText(output.status) === 'error' || runtimeText(payload.status) === 'error';
  const status: ProcessItem['status'] = failed ? 'failed' : isTerminal && !partial ? 'done' : 'running';
  const outputText = runtimeText(output.content)
    || runtimeText(output.summary)
    || runtimeText(output.summaryText)
    || runtimeText(output.resultText)
    || stringifyRuntimePreview(output);
  const existingIndex = timeline.findIndex((item) => item.type === 'tool-call' && item.toolData?.callId === callId);
  const nextItem: ProcessItem = {
    id: existingIndex === -1 ? `tool_${callId || eventId}` : timeline[existingIndex].id,
    type: 'tool-call',
    title: name,
    content: runtimeText(payload.description) || outputText,
    status,
    timestamp: existingIndex === -1 ? timestamp : timeline[existingIndex].timestamp,
    duration: existingIndex === -1 ? undefined : Math.max(0, timestamp - timeline[existingIndex].timestamp),
    toolData: {
      callId,
      name,
      input: payload.input ?? {},
      output: outputText,
    },
  };
  if (existingIndex === -1) {
    timeline.push(nextItem);
  } else {
    timeline[existingIndex] = {
      ...timeline[existingIndex],
      ...nextItem,
      toolData: {
        ...timeline[existingIndex].toolData,
        ...nextItem.toolData,
      },
    };
  }
}

function applyPersistedRuntimeEventsToMessages(
  messages: Message[],
  messageTimes: Array<number | undefined>,
  eventsRaw: unknown,
): Message[] {
  const events = Array.isArray(eventsRaw)
    ? (eventsRaw as PersistedRuntimeEvent[])
        .filter((event) => runtimeEventType(event))
        .sort((left, right) => runtimeEventCreatedAt(left) - runtimeEventCreatedAt(right))
    : [];
  if (events.length === 0) return messages;

  const next = messages.map((message) => ({
    ...message,
    timeline: [...(message.timeline || [])],
  }));
  const nextMessageTimes = [...messageTimes];

  events.forEach((event, index) => {
    const eventType = runtimeEventType(event);
    const timestamp = runtimeEventCreatedAt(event);
    const payload = runtimeObject(event.payload);
    let targetIndex = persistedRuntimeTargetAssistantIndex(next, nextMessageTimes, timestamp);
    if (targetIndex === -1 && shouldCreateRuntimeReplayAssistantMessage(eventType, payload)) {
      targetIndex = ensureRuntimeReplayAssistantMessage(next, nextMessageTimes, timestamp);
    }
    if (targetIndex === -1) return;

    const timeline = next[targetIndex].timeline;
    const eventId = runtimeEventId(event, `runtime_event_${timestamp}_${index}`);

    if (eventType === 'runtime:text-delta' || eventType === 'text_delta') {
      const content = runtimeText(payload.content);
      const stream = runtimeText(payload.stream || 'response');
      const messagePhase = runtimeText(payload.messagePhase || (stream === 'thought' ? 'thought' : 'final_answer'));
      if (messagePhase === 'commentary') {
        pushOrMergeNarrationItem(timeline, 'commentary', content, timestamp, `commentary_${eventId}`);
      } else if (messagePhase === 'thought' || stream === 'thought') {
        pushOrMergeNarrationItem(timeline, 'thought', content, timestamp, `thought_${eventId}`);
      }
      return;
    }

    if (
      eventType === 'runtime:tool-start'
      || eventType === 'runtime:tool-update'
      || eventType === 'runtime:tool-end'
      || eventType === 'tool_request'
      || eventType === 'tool_result'
    ) {
      upsertPersistedToolItem(timeline, eventType, payload, timestamp, eventId, event.toolCallId || event.tool_call_id);
      return;
    }

    if (eventType === 'runtime:checkpoint' || eventType === 'task_checkpoint_saved') {
      const { checkpointType, checkpointPayload } = normalizePersistedCheckpointPayload(payload);
      if (checkpointType === 'chat.error') {
        const detail = runtimeText(checkpointPayload.detail || checkpointPayload.message || checkpointPayload.raw)
          || stringifyRuntimePreview(checkpointPayload);
        next[targetIndex].timeline = finalizeRunningTimelineItems(timeline, timestamp, true);
        if (detail) {
          next[targetIndex].timeline.push({
            id: `error_${eventId}`,
            type: 'error',
            title: '处理失败',
            content: truncateErrorDetail(detail),
            status: 'failed',
            timestamp,
          });
        }
        next[targetIndex].isStreaming = false;
        next[targetIndex].suppressPendingIndicator = false;
        next[targetIndex].processingFinishedAt = timestamp;
      } else if (checkpointType === 'chat.cancelled') {
        next[targetIndex].timeline = finalizeRunningTimelineItems(timeline, timestamp, false);
        next[targetIndex].isStreaming = false;
        next[targetIndex].suppressPendingIndicator = false;
        next[targetIndex].processingFinishedAt = timestamp;
      } else if (checkpointType === 'chat.response_end') {
        next[targetIndex].timeline = finalizeRunningTimelineItems(timeline, timestamp, false);
        next[targetIndex].isStreaming = false;
        next[targetIndex].suppressPendingIndicator = false;
        next[targetIndex].processingFinishedAt = timestamp;
      } else if (checkpointType === 'chat.skill_activated') {
        const name = runtimeText(checkpointPayload.name);
        if (name) {
          timeline.push({
            id: `skill_${eventId}`,
            type: 'skill',
            content: runtimeText(checkpointPayload.description),
            status: 'done',
            timestamp,
            skillData: {
              name,
              description: runtimeText(checkpointPayload.description),
            },
          });
        }
      }
      return;
    }

    if (eventType === 'runtime:done') {
      const failed = runtimeText(payload.status) === 'error' || runtimeText(payload.reason) === 'error';
      next[targetIndex].timeline = finalizeRunningTimelineItems(timeline, timestamp, failed);
      next[targetIndex].isStreaming = false;
      next[targetIndex].suppressPendingIndicator = false;
      next[targetIndex].processingFinishedAt = timestamp;
    }
  });

  return next;
}

export function Chat({
  isActive = true,
  onExecutionStateChange,
  pendingMessage,
  onMessageConsumed,
  fixedSessionId,
  fixedSessionDraft = false,
  onEnsureSessionForSend,
  initialChatModelKey = '',
  onChatModelKeyChange,
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
  onSessionActivity,
  analyticsContext,
  clearSignal = 0,
}: ChatProps) {
  const debugUi = useCallback((_event: string, _extra?: Record<string, unknown>) => {}, []);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => fixedSessionId ?? null);
  const [messages, setMessages] = useState<Message[]>(() => (
    readFixedSessionWarmSnapshot(fixedSessionId)?.messages || []
  ));
  const visibleMessages = useMemo(
    () => messages.filter((message) => !isInternalRuntimeStatusMessage(message)),
    [messages],
  );
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ToolConfirmRequest | null>(null);
  const [cliEscalationRequest, setCliEscalationRequest] = useState<CliEscalationRequestModel | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [savingKnowledgeMessageId, setSavingKnowledgeMessageId] = useState<string | null>(null);
  const [savedKnowledgeMessageId, setSavedKnowledgeMessageId] = useState<string | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu>({ visible: false, x: 0, y: 0, text: '' });
  const [contextUsage, setContextUsage] = useState<ChatContextUsage | null>(() => (
    readFixedSessionWarmSnapshot(fixedSessionId)?.contextUsage || null
  ));
  const [errorNotice, setErrorNotice] = useState<string | StructuredChatErrorNotice | null>(null);
  const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
  const [memberMentionOptions, setMemberMentionOptions] = useState<ChatMemberMentionOption[]>([]);
  const [selectedMemberMention, setSelectedMemberMention] = useState<ChatMemberMentionOption | null>(null);
  const [skillMentionOptions, setSkillMentionOptions] = useState<ChatSkillMentionOption[]>([]);
  const [selectedSkillMentions, setSelectedSkillMentions] = useState<ChatSkillMentionOption[]>([]);
  const [assetMentionOptions, setAssetMentionOptions] = useState<ChatAssetMentionOption[]>([]);
  const [selectedAssetMentions, setSelectedAssetMentions] = useState<ChatAssetMentionOption[]>([]);
  const [knowledgeMentionOptions, setKnowledgeMentionOptions] = useState<ChatKnowledgeMentionOption[]>([]);
  const [selectedKnowledgeMentions, setSelectedKnowledgeMentions] = useState<ChatKnowledgeMentionOption[]>([]);
  const [dismissedAttachmentActionKey, setDismissedAttachmentActionKey] = useState('');
  const documentThemeMode = useDocumentThemeMode();
  const fixedSessionMode = Boolean(fixedSessionId) || fixedSessionDraft;
  const attachmentDraftScopeId = fixedSessionId || currentSessionId || (fixedSessionDraft ? '__fixed_draft__' : '__new__');

  useEffect(() => {
    onExecutionStateChange?.(isProcessing);
  }, [isProcessing, onExecutionStateChange]);

  useEffect(() => {
    if (!clearSignal || !fixedSessionId) return;
    clearFixedSessionWarmSnapshot(fixedSessionId);
    localMessageMutationRef.current += 1;
    missedChunksRef.current = '';
    flushPendingStreamingUpdates();
    setIsProcessing(false);
    setConfirmRequest(null);
    setCliEscalationRequest(null);
    setErrorNotice(null);
    setMessages([]);
    setContextUsage(null);
  }, [clearSignal, fixedSessionId]);

  useEffect(() => {
    if (!errorNotice) return undefined;
    const structuredNotice = typeof errorNotice === 'string' ? null : errorNotice;
    const dismissAfter = structuredNotice?.action
      ? CHAT_ERROR_NOTICE_ACTION_AUTO_DISMISS_MS
      : CHAT_ERROR_NOTICE_AUTO_DISMISS_MS;
    const timer = window.setTimeout(() => {
      setErrorNotice(null);
    }, dismissAfter);
    return () => window.clearTimeout(timer);
  }, [errorNotice]);

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
  const [selectedChatModelKey, setSelectedChatModelKeyState] = useState(() => String(initialChatModelKey || '').trim());
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const currentSessionIdRef = useRef<string | null>(fixedSessionId ?? null);
  const chatModelOptionsRef = useRef<ChatModelOption[]>([]);
  const selectedChatModelKeyRef = useRef(String(initialChatModelKey || '').trim());
  const hasManualChatModelSelectionRef = useRef(Boolean(String(initialChatModelKey || '').trim()));
  const chatInstanceIdRef = useRef(
    `chat-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`
  );
  const composerRef = useRef<ChatComposerHandle>(null);
  const {
    attachFiles,
    clearPendingAttachment,
    dragHandlers,
    isAttachmentUploading,
    isFileDragActive,
    pendingAttachment,
    pendingAttachments,
    pickAttachment,
    removePendingAttachment,
    resetPendingAttachment,
    setPendingAttachment,
    setPendingAttachments,
  } = useChatAttachments({
    allowFileUpload,
    attachmentDraftScopeId,
    composerRef,
    currentSessionId,
    isActive,
    isProcessing,
    setErrorNotice,
  });

  useEffect(() => {
    if (pendingAttachments.length > 0) return;
    setDismissedAttachmentActionKey('');
  }, [pendingAttachments.length]);
  
  // Throttle buffer for streaming updates
  const pendingUpdateRef = useRef<{ content: string; messagePhase: string } | null>(null);
  const openResponseSegmentRef = useRef('');
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingThoughtUpdateRef = useRef<{ content: string } | null>(null);
  const thoughtUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCliLogUpdatesRef = useRef<Record<string, string>>({});
  const cliLogUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamChunkRef = useRef<{ content: string; at: number }>({ content: '', at: 0 });
  const localMessageMutationRef = useRef(0);
  const skipNextFixedSessionLoadRef = useRef<string | null>(null);
  const handledFixedSessionIdRef = useRef<string | null>(fixedSessionId ?? null);
  const lastFixedSessionIdRef = useRef<string | null>(fixedSessionId ?? null);
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
    if (lastFixedSessionIdRef.current !== fixedSessionId) {
      lastFixedSessionIdRef.current = fixedSessionId;
      const warm = readFixedSessionWarmSnapshot(fixedSessionId);
      localMessageMutationRef.current += 1;
      setMessages(warm?.messages || []);
      setContextUsage(warm?.contextUsage || null);
      setErrorNotice(null);
    }
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
    openResponseSegmentRef.current = '';
    if (thoughtUpdateTimerRef.current) {
      clearTimeout(thoughtUpdateTimerRef.current);
      thoughtUpdateTimerRef.current = null;
    }
    pendingThoughtUpdateRef.current = null;
    if (cliLogUpdateTimerRef.current) {
      clearTimeout(cliLogUpdateTimerRef.current);
      cliLogUpdateTimerRef.current = null;
    }
    pendingCliLogUpdatesRef.current = {};
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

  useEffect(() => {
    const next = String(initialChatModelKey || '').trim();
    hasManualChatModelSelectionRef.current = Boolean(next);
    if (!next) {
      if (!selectedChatModelKeyRef.current) return;
      selectedChatModelKeyRef.current = '';
      setSelectedChatModelKeyState('');
      return;
    }
    if (next === selectedChatModelKeyRef.current) return;
    selectedChatModelKeyRef.current = next;
    setSelectedChatModelKeyState(next);
  }, [initialChatModelKey]);

  const applyChatModelOptions = useCallback((options: ChatModelOption[]) => {
    chatModelOptionsRef.current = options;
    setChatModelOptions(options);
  }, []);

  const handleSelectedChatModelKeyChange = useCallback((key: string) => {
    const next = String(key || '').trim();
    hasManualChatModelSelectionRef.current = Boolean(next);
    selectedChatModelKeyRef.current = next;
    setSelectedChatModelKeyState(next);
    onChatModelKeyChange?.(next);
  }, [onChatModelKeyChange]);

  const resolveSelectedChatModelFromRefs = useCallback(() => {
    const options = chatModelOptionsRef.current.length > 0 ? chatModelOptionsRef.current : chatModelOptions;
    const key = selectedChatModelKeyRef.current || selectedChatModelKey;
    return options.find((item) => item.key === key) || null;
  }, [chatModelOptions, selectedChatModelKey]);

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

  useEffect(() => {
    setSelectedMemberMention(null);
    setSelectedSkillMentions([]);
    setSelectedAssetMentions([]);
    setSelectedKnowledgeMentions([]);
  }, [currentSessionId]);

  const loadChatModelOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const settings = await uiMeasure('chat', 'load_chat_model_options', async () => (
        window.ipcRenderer.getSettings() as Promise<ChatSettingsSnapshot | undefined>
      ));
      const options = buildChatModelOptions(settings);
      applyChatModelOptions(options);
      setSelectedChatModelKeyState((current) => {
        const preferred = hasManualChatModelSelectionRef.current
          ? selectedChatModelKeyRef.current || current
          : '';
        if (preferred && options.some((item) => item.key === preferred)) {
          selectedChatModelKeyRef.current = preferred;
          return preferred;
        }
        const next = options.find((item) => item.isDefault)?.key || options[0]?.key || '';
        selectedChatModelKeyRef.current = next;
        return next;
      });
    } catch (error) {
      console.error('Failed to load chat model options:', error);
    }
  }, [applyChatModelOptions]);

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

  const loadSkillMentionOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      hydrateSkillMentionMarketAvatarCache({ force: true });
      const skills = await window.ipcRenderer.listSkills();
      setSkillMentionOptions(
        (skills || [])
          .map((item) => normalizeSkillMentionRecord(item as SkillMentionCatalogRecord))
          .filter((item): item is ChatSkillMentionOption => Boolean(item)),
      );
    } catch (error) {
      console.error('Failed to load skill mention options:', error);
      setSkillMentionOptions([]);
    }
  }, []);

  const loadAssetMentionOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const result = await window.ipcRenderer.subjects.list({ limit: 500 });
      const records = Array.isArray(result?.subjects)
        ? result.subjects
        : Array.isArray(result?.assets)
          ? result.assets
          : [];
      setAssetMentionOptions(
        records
          .map((item) => normalizeAssetMentionRecord(item as AssetMentionCatalogRecord))
          .filter((item): item is ChatAssetMentionOption => Boolean(item)),
      );
    } catch (error) {
      console.error('Failed to load asset mention options:', error);
      setAssetMentionOptions([]);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void loadMemberMentionOptions();
    void loadSkillMentionOptions();
    void loadAssetMentionOptions();
    const handleAdvisorsChanged = () => {
      void loadMemberMentionOptions();
    };
    window.ipcRenderer.advisors.onChanged(handleAdvisorsChanged);
    return () => {
      window.ipcRenderer.advisors.offChanged(handleAdvisorsChanged);
    };
  }, [isActive, loadAssetMentionOptions, loadMemberMentionOptions, loadSkillMentionOptions]);

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
    window.ipcRenderer.knowledge.onChanged(handleKnowledgeChanged);
    window.ipcRenderer.knowledge.onCatalogUpdated(handleKnowledgeChanged);
    return () => {
      window.ipcRenderer.knowledge.offChanged(handleKnowledgeChanged);
      window.ipcRenderer.knowledge.offCatalogUpdated(handleKnowledgeChanged);
      if (knowledgeMentionSearchTimerRef.current) {
        window.clearTimeout(knowledgeMentionSearchTimerRef.current);
        knowledgeMentionSearchTimerRef.current = null;
      }
    };
  }, [isActive, loadKnowledgeMentionOptions]);

  const ensureChatModelConfig = useCallback(async () => {
    const selected = resolveSelectedChatModelFromRefs();
    if (selected) {
      return chatModelConfigFromOption(selected);
    }
    const settings = await uiMeasure('chat', 'ensure_chat_model_config', async () => (
      window.ipcRenderer.getSettings() as Promise<ChatSettingsSnapshot | undefined>
    ));
    const options = buildChatModelOptions(settings);
    if (options.length === 0) {
      return undefined;
    }
    applyChatModelOptions(options);
    const preferredKey = selectedChatModelKeyRef.current;
    const resolvedKey = preferredKey && options.some((item) => item.key === preferredKey)
      ? preferredKey
      : options.find((item) => item.isDefault)?.key || options[0]?.key || '';
    if (resolvedKey) {
      selectedChatModelKeyRef.current = resolvedKey;
      setSelectedChatModelKeyState((current) => current === resolvedKey ? current : resolvedKey);
    }
    const resolved = options.find((item) => item.key === resolvedKey) || options[0];
    return chatModelConfigFromOption(resolved);
  }, [applyChatModelOptions, resolveSelectedChatModelFromRefs]);

  // 判断是否是空会话（新建或无消息）
  const isEmptySession = visibleMessages.length === 0;

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
    dispatchAppIntent({
      type: 'settings.open',
      tab: 'ai',
      aiModelSubTab: 'login',
    });
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

  useEffect(() => {
    if (!isActive) return;

    if (fixedSessionId) {
      selectSession(fixedSessionId);
    }
  }, [fixedSessionId, isActive]);

  const dispatchChatSend = useCallback((payload: {
    sessionId?: string;
    message: string;
    displayContent: string;
    attachment?: Message['attachment'];
    attachments?: UploadedFileAttachment[];
    memberMention?: {
      type: 'advisor';
      advisorId: string;
      name: string;
      avatar?: string;
    };
    knowledgeReferences?: ChatKnowledgeMentionOption[];
    assetReferences?: ChatAssetMentionOption[];
    modelConfig?: {
      apiKey?: string;
      baseURL?: string;
      modelName?: string;
      sourceId?: string;
      presetId?: string;
    };
    taskHints?: unknown;
  }) => {
    debugUi('dispatch_send:queued', {
      sessionId: payload.sessionId || null,
      chars: payload.message.length,
      hasAttachment: Boolean(payload.attachment) || Boolean(payload.attachments?.length),
      attachmentCount: payload.attachments?.length || (payload.attachment ? 1 : 0),
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
    const pendingMessagePrimaryAttachment = pendingMessage.attachment as Message['attachment'] | undefined;
    const pendingMessageAttachments = [
      ...((pendingMessage.attachments || []) as UploadedFileAttachment[]),
      ...uploadedFileAttachmentsFromMessageAttachment(pendingMessagePrimaryAttachment),
    ];

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
      const draftSkillMentions = normalizePendingSkillMentions(pendingMessage);
      setInput(String(pendingMessage.content || ''));
      setSelectedKnowledgeMentions(draftKnowledgeReferences);
      setSelectedSkillMentions(draftSkillMentions);
      if (pendingMessageAttachments.length > 0) {
        setPendingAttachments(pendingMessageAttachments);
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
      const shouldReplaceLocalMessages = pendingMessage.sessionRouting === 'new';
      const shouldAppendToCurrentSession = Boolean(fixedSessionId) && !shouldReplaceLocalMessages;

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

          currentSessionIdRef.current = session.id;
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
      const resolvedAttachments = applyAttachmentsDeliveryMode(
        pendingMessageAttachments,
        resolvedModelConfig?.modelName || getChatModelConfig()?.modelName,
      );
      const committedAttachments = commitAttachmentsForSend(resolvedAttachments);
      const resolvedAttachment = createAttachmentPayload(committedAttachments)
        || (pendingMessagePrimaryAttachment?.type !== 'uploaded-file' ? pendingMessagePrimaryAttachment : undefined);
      const pendingAttachmentBlockReason = attachmentsSendBlockReason(resolvedAttachments);
      if (pendingAttachmentBlockReason) {
        setErrorNotice(pendingAttachmentBlockReason);
        pendingMessageHandledRef.current = false;
        onMessageConsumed?.();
        return;
      }
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
        attachments: committedAttachments,
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
        timeline: pendingMessage.taskHints?.forceMultiAgent
          ? buildPendingAssistantTimeline('任务已提交')
          : [],
        isStreaming: true,
        processingStartedAt,
      };

      if (shouldAppendToCurrentSession) {
        localMessageMutationRef.current += 1;
        setMessages(prev => {
          const nextMessages = [...prev, userMsg, aiPlaceholder];
          writeFixedSessionWarmSnapshot(sessionId, { messages: nextMessages });
          return nextMessages;
        });
      } else {
        if (fixedSessionId) {
          skipNextFixedSessionLoadRef.current = fixedSessionId;
          writeFixedSessionWarmSnapshot(sessionId, { messages: [userMsg, aiPlaceholder] });
        }
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
        attachment: stripTransientMessageAttachmentPreview(resolvedAttachment),
        attachments: committedAttachments.map((attachment) => stripTransientAttachmentPreview(attachment) as UploadedFileAttachment),
        knowledgeReferences: pendingKnowledgeReferences,
        modelConfig: resolvedModelConfig,
        taskHints: pendingMessage.taskHints,
      });

      // 标记消息已消费
      onMessageConsumed?.();
    };

    sendPendingMessage();
  }, [isActive, pendingMessage, isProcessing, onMessageConsumed, fixedSessionId, currentSessionId, buildPendingAssistantTimeline, dispatchChatSend, ensureChatModelConfig, notifySessionActivity, setPendingAttachment]);

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
      const [history, runtimeStateRaw, runtimeEventsRaw] = await uiMeasure('chat', 'select_session:load', async () => {
        if (fixedSessionId && sessionId === fixedSessionId) {
          let inflight = fixedSessionInflightLoads.get(sessionId);
          if (!inflight) {
            inflight = Promise.all([
              window.ipcRenderer.chat.getMessages(sessionId),
              shouldRecoverRuntime
                ? window.ipcRenderer.chat.getRuntimeState(sessionId)
                : Promise.resolve(null),
              window.ipcRenderer.runtime.getEvents({
                sessionId,
                limit: 500,
                includeChildSessions: false,
              }).catch(() => []),
            ]) as Promise<[unknown[], ChatRuntimeState | null, unknown[]]>;
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
          window.ipcRenderer.runtime.getEvents({
            sessionId,
            limit: 500,
            includeChildSessions: false,
          }).catch(() => []),
        ]) as Promise<[unknown[], ChatRuntimeState | null, unknown[]]>;
      }, { sessionId, shouldRecoverRuntime });
      if (requestId !== selectSessionRequestRef.current) {
        return;
      }
      if (localMessageMutationRef.current !== mutationVersionAtStart) {
        return;
      }
      const runtimeState = runtimeStateRaw as ChatRuntimeState | null;
      const runtimeProcessing = Boolean(runtimeState?.success && runtimeState?.isProcessing);
      const runtimeKnownComplete = Boolean(
        shouldRecoverRuntime
        && runtimeState?.success
        && !runtimeProcessing
      );
      if (fixedSessionId && sessionId === fixedSessionId) {
        const warm = readFixedSessionWarmSnapshot(sessionId);
        const runtimeTerminalAfterWarm = hasTerminalRuntimeEventAfterWarmSnapshot(warm, runtimeEventsRaw);
        if (shouldPreserveFixedSessionWarmMessages(warm, history, {
          runtimeKnownComplete: runtimeKnownComplete || runtimeTerminalAfterWarm,
        })) {
          setMessages(warm.messages);
          setIsProcessing(true);
          debugUi('select_session:preserve_warm_messages', {
            sessionId,
            warmMessageCount: warm.messages.length,
            historyMessageCount: history.length,
            runtimeKnownComplete,
            runtimeTerminalAfterWarm,
          });
          return;
        }
      }

      // Convert DB messages to UI messages
      let lastUserCreatedAt: number | undefined;
      const messageTimes: Array<number | undefined> = [];
      let uiMessages: Message[] = history
        .filter((msg: any) => !(
          msg.role === 'user'
          && isInternalRuntimeStatusText(msg.displayContent || msg.display_content || msg.content)
        ))
        .map((msg: any) => {
          // 解析 attachment（数据库中存储为 JSON 字符串）
          let attachment = undefined;
          let attachments: UploadedFileAttachment[] = [];
          if (msg.attachment) {
            try {
              const parsed = typeof msg.attachment === 'string' ? JSON.parse(msg.attachment) : msg.attachment;
              if (Array.isArray(parsed)) {
                attachments = parsed.filter((item) => item?.type === 'uploaded-file') as UploadedFileAttachment[];
                attachment = attachments[0];
              } else {
                attachment = parsed;
                attachments = uploadedFileAttachmentsFromMessageAttachment(parsed as Message['attachment'] | undefined);
              }
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
          messageTimes.push(createdAt);

          return {
            id: msg.id,
            role, // Simplified mapping
            messageType: role === 'ai' ? 'reply' : undefined,
            content: msg.content,
            displayContent: msg.displayContent || msg.display_content || undefined,
            attachment: attachment,
            attachments,
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
      uiMessages = applyPersistedRuntimeEventsToMessages(uiMessages, messageTimes, runtimeEventsRaw);

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

  useEffect(() => {
    if (!isActive || !fixedSessionId) return;
    if (handledFixedSessionIdRef.current === fixedSessionId) return;
    handledFixedSessionIdRef.current = fixedSessionId;
    if (skipNextFixedSessionLoadRef.current === fixedSessionId) {
      skipNextFixedSessionLoadRef.current = null;
      debugUi('fixed_session:skip_initial_load_after_send', { sessionId: fixedSessionId });
      return;
    }
    void selectSession(fixedSessionId);
  }, [debugUi, fixedSessionId, isActive]);

  const clearSession = async () => {
    if (!currentSessionId) return;
    try {
      if (isProcessing) {
        window.ipcRenderer.chat.cancel({ sessionId: currentSessionId });
      }
      await window.ipcRenderer.chat.clearMessages(currentSessionId);
      missedChunksRef.current = '';
      flushPendingStreamingUpdates();
      setIsProcessing(false);
      setConfirmRequest(null);
      setCliEscalationRequest(null);
      setErrorNotice(null);
      setMessages([]);
    } catch (error) {
      console.error('Failed to clear session:', error);
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

  const handleSaveMessageToKnowledge = useCallback(async (message: Message, content: string) => {
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) return;
    const sessionId = currentSessionIdRef.current || currentSessionId || fixedSessionId || null;
    setSavingKnowledgeMessageId(message.id);
    try {
      await window.ipcRenderer.knowledge.createFromChat({
        title: deriveKnowledgeTitleFromMessage(normalizedContent),
        content: normalizedContent,
        tags: ['chat'],
        source: {
          type: 'chat',
          sessionId,
          messageIds: [message.id],
          role: knowledgeSourceRoleForMessage(message),
        },
        metadata: {
          messageRole: message.role,
          messageType: message.messageType || 'reply',
        },
        allowUpdate: false,
      });
      setSavedKnowledgeMessageId(message.id);
      setTimeout(() => {
        setSavedKnowledgeMessageId((current) => current === message.id ? null : current);
      }, 2200);
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKnowledgeMessageId((current) => current === message.id ? null : current);
    }
  }, [currentSessionId, fixedSessionId]);

  const appendAssistantChunk = useCallback((chunk: string, messagePhase = 'final_answer') => {
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
      let timeline = lastMsg.timeline;
      let suppressPendingIndicator = lastMsg.suppressPendingIndicator;
      if (messagePhase === 'commentary') {
        const now = Date.now();
        timeline = [...lastMsg.timeline];
        const commentaryIndex = findLastRunningTimelineCommentaryIndex(timeline);
        if (commentaryIndex === -1) {
          timeline.push({
            id: `commentary_${now}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'commentary',
            content: chunk,
            status: 'running',
            timestamp: now,
          });
        } else {
          const commentaryItem = timeline[commentaryIndex];
          timeline[commentaryIndex] = {
            ...commentaryItem,
            content: mergeAssistantContent(commentaryItem.content || '', chunk),
          };
        }
        suppressPendingIndicator = true;
      }
      next[lastReplyIndex] = {
        ...lastMsg,
        content: lastMsg.content + chunk,
        isStreaming: true,
        messageType: 'reply',
        suppressPendingIndicator,
        timeline,
      };
      return next;
    });
  }, []);

  const appendThoughtChunk = useCallback((chunk: string) => {
    if (!chunk) return;
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
          content: chunk,
          status: 'running',
          timestamp: now,
        });
      } else {
        const thoughtItem = timeline[thoughtIndex];
        timeline[thoughtIndex] = {
          ...thoughtItem,
          content: mergeThoughtDelta(thoughtItem.content || '', chunk),
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
  }, []);

  const appendCliLogChunks = useCallback((chunksByExecutionId: Record<string, string>) => {
    const entries = Object.entries(chunksByExecutionId)
      .filter(([executionId, chunk]) => Boolean(executionId && chunk));
    if (entries.length === 0) return;

    setMessages((prev) => {
      const lastReplyIndex = findLastAssistantReplyIndex(prev);
      if (lastReplyIndex === -1) return prev;
      const next = [...prev];
      const lastMsg = next[lastReplyIndex];
      const timeline = [...lastMsg.timeline];
      let changed = false;

      for (const [executionId, chunk] of entries) {
        const existingIndex = findLatestTimelineItemIndex(
          timeline,
          (item) => item.type === 'cli-exec' && item.cliData?.executionId === executionId,
        );
        if (existingIndex === -1) continue;
        const target = timeline[existingIndex];
        timeline[existingIndex] = {
          ...target,
          cliData: {
            ...target.cliData,
            logPreview: appendCliLogPreview(target.cliData?.logPreview || '', chunk),
          },
        };
        changed = true;
      }

      if (!changed) return prev;
      next[lastReplyIndex] = { ...lastMsg, messageType: 'reply', timeline };
      return next;
    });
  }, []);

  const flushPendingAssistantChunk = useCallback(() => {
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }

    const chunk = pendingUpdateRef.current?.content || '';
    const messagePhase = pendingUpdateRef.current?.messagePhase || 'final_answer';
    pendingUpdateRef.current = null;
    if (chunk) {
      appendAssistantChunk(chunk, messagePhase);
    }
  }, [appendAssistantChunk]);

  const flushPendingThoughtChunk = useCallback(() => {
    if (thoughtUpdateTimerRef.current) {
      clearTimeout(thoughtUpdateTimerRef.current);
      thoughtUpdateTimerRef.current = null;
    }

    const chunk = pendingThoughtUpdateRef.current?.content || '';
    pendingThoughtUpdateRef.current = null;
    if (chunk) {
      appendThoughtChunk(chunk);
    }
  }, [appendThoughtChunk]);

  const flushPendingCliLogChunks = useCallback(() => {
    if (cliLogUpdateTimerRef.current) {
      clearTimeout(cliLogUpdateTimerRef.current);
      cliLogUpdateTimerRef.current = null;
    }

    const chunksByExecutionId = pendingCliLogUpdatesRef.current;
    pendingCliLogUpdatesRef.current = {};
    appendCliLogChunks(chunksByExecutionId);
  }, [appendCliLogChunks]);

  const flushPendingStreamingUpdates = useCallback(() => {
    flushPendingThoughtChunk();
    flushPendingCliLogChunks();
    flushPendingAssistantChunk();
  }, [flushPendingAssistantChunk, flushPendingCliLogChunks, flushPendingThoughtChunk]);

  useEffect(() => {
    if (!isActive || fixedSessionMode) return;
    const handleSpaceChanged = () => {
      setSelectionMenu(prev => ({ ...prev, visible: false }));
    };
    window.ipcRenderer.spaces.onChanged(handleSpaceChanged);
    return () => {
      window.ipcRenderer.spaces.offChanged(handleSpaceChanged);
    };
  }, [fixedSessionMode, isActive]);

  useEffect(() => {
    if (!isActive) return;
    const refreshChatModels = () => {
      void loadChatModelOptions();
    };
    const unsubscribeSettingsUpdated = subscribeSettingsUpdated(refreshChatModels);
    window.ipcRenderer.auth.onDataChanged(refreshChatModels);
    return () => {
      unsubscribeSettingsUpdated();
      window.ipcRenderer.auth.offDataChanged(refreshChatModels);
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
      if (!pendingThoughtUpdateRef.current) {
        pendingThoughtUpdateRef.current = { content: '' };
      }
      pendingThoughtUpdateRef.current.content = mergeThoughtDelta(
        pendingThoughtUpdateRef.current.content,
        content,
      );
      if (!thoughtUpdateTimerRef.current) {
        thoughtUpdateTimerRef.current = setTimeout(() => {
          thoughtUpdateTimerRef.current = null;
          flushPendingThoughtChunk();
        }, STREAM_UPDATE_INTERVAL_MS);
      }
    };

    // 4. Thought End
    const handleThoughtEnd = (_: unknown) => {
      if (!isActiveRef.current) return;
      flushPendingThoughtChunk();
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

    const handleResponseChunk = (_: unknown, { content, messagePhase }: { content: string; messagePhase?: string }) => {
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
      flushPendingThoughtChunk();
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

      const normalizedMessagePhase = String(messagePhase || 'final_answer').trim() || 'final_answer';
      if (pendingUpdateRef.current && pendingUpdateRef.current.messagePhase !== normalizedMessagePhase) {
        flushPendingAssistantChunk();
      }
      if (normalizedMessagePhase === 'final_answer') {
        openResponseSegmentRef.current += content;
      } else if (normalizedMessagePhase === 'commentary') {
        openResponseSegmentRef.current = '';
      }

      // 1. Accumulate content
      if (!pendingUpdateRef.current) {
        pendingUpdateRef.current = { content: '', messagePhase: normalizedMessagePhase };
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
      flushPendingAssistantChunk();
      const commentarySegment = openResponseSegmentRef.current;
      openResponseSegmentRef.current = '';
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
        const now = Date.now();
        const normalizedCommentarySegment = normalizeTimelineCommentarySegment(commentarySegment);
        if (normalizedCommentarySegment) {
          newTimeline.push({
            id: `commentary_${now}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'commentary',
            content: normalizedCommentarySegment,
            status: 'done',
            timestamp: now,
            duration: 0,
          });
        }
        const runningThoughtIndex = findLastRunningTimelineThoughtIndex(newTimeline);
        if (runningThoughtIndex !== -1) {
          const thoughtItem = newTimeline[runningThoughtIndex];
          newTimeline[runningThoughtIndex] = {
            ...thoughtItem,
            status: 'done',
            duration: now - thoughtItem.timestamp,
          };
        }
        const runningCommentaryIndex = findLastRunningTimelineCommentaryIndex(newTimeline);
        if (runningCommentaryIndex !== -1) {
          const commentaryItem = newTimeline[runningCommentaryIndex];
          newTimeline[runningCommentaryIndex] = {
            ...commentaryItem,
            status: 'done',
            duration: now - commentaryItem.timestamp,
          };
        }

        // Add Tool Item to Timeline
        newTimeline.push({
            id: Math.random().toString(36),
            type: 'tool-call',
            content: toolData.description || '',
            status: 'running',
            timestamp: now,
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
      pendingCliLogUpdatesRef.current[cliData.executionId] = appendCliLogPreview(
        pendingCliLogUpdatesRef.current[cliData.executionId] || '',
        cliData.chunk,
      );
      if (!cliLogUpdateTimerRef.current) {
        cliLogUpdateTimerRef.current = setTimeout(() => {
          cliLogUpdateTimerRef.current = null;
          flushPendingCliLogChunks();
        }, STREAM_UPDATE_INTERVAL_MS);
      }
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
      flushPendingStreamingUpdates();
      const finalContent = typeof payload?.content === 'string' ? payload.content : '';
      openResponseSegmentRef.current = '';
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
      flushPendingStreamingUpdates();
      missedChunksRef.current = '';
      openResponseSegmentRef.current = '';
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
      debugUi('session_title_updated:ignored_in_embedded_chat', { sessionId, title });
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
      flushPendingStreamingUpdates();
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
          const hasRunningTimeline = Array.isArray(lastMsg?.timeline)
            && lastMsg.timeline.some((item) => item.status === 'running');
          if (lastMsg && lastMsg.role === 'ai' && (lastMsg.isStreaming || hasRunningTimeline)) {
            const now = Date.now();
            const timeline = finalizeRunningTimelineItems(lastMsg.timeline || [], now, true);
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
      onResponseDelta: ({ content, messagePhase }) => {
        handleResponseChunk(null, { content, messagePhase });
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
      onAcpConversationChanged: ({ eventType }) => {
        const sessionId = currentSessionIdRef.current;
        if (!isActiveRef.current || !sessionId) return;
        debugUi('acp_conversation_changed:reload_messages', { sessionId, eventType });
        void selectSession(sessionId);
      },
    });

    return () => {
      debugUi('runtime_subscription:dispose', { sessionId: currentSessionIdRef.current });
      disposeRuntimeEvents();

      // Cleanup timer
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
        updateTimerRef.current = null;
      }
      pendingUpdateRef.current = null;
      openResponseSegmentRef.current = '';
      if (thoughtUpdateTimerRef.current) {
        clearTimeout(thoughtUpdateTimerRef.current);
        thoughtUpdateTimerRef.current = null;
      }
      pendingThoughtUpdateRef.current = null;
      if (cliLogUpdateTimerRef.current) {
        clearTimeout(cliLogUpdateTimerRef.current);
        cliLogUpdateTimerRef.current = null;
      }
      pendingCliLogUpdatesRef.current = {};
    };
  }, [
    debugUi,
    flushPendingAssistantChunk,
    flushPendingCliLogChunks,
    flushPendingStreamingUpdates,
    flushPendingThoughtChunk,
    isActive,
  ]);

  const getChatModelConfig = useCallback(() => {
    return chatModelConfigFromOption(resolveSelectedChatModelFromRefs());
  }, [resolveSelectedChatModelFromRefs]);

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
      const next = resolved.text || '';
      const composer = composerRef.current;
      if (composer) {
        composer.insertTextAtEnd(next, { separator: '\n' });
      } else {
        setInput((prev) => {
          const current = String(prev || '').trim();
          return current ? `${current}${current.endsWith('\n') ? '' : '\n'}${next}` : next;
        });
      }
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
    attachments: UploadedFileAttachment[] = [],
    memberMention: ChatMemberMentionOption | null = selectedMemberMention || fixedMemberMention,
    knowledgeMentions: ChatKnowledgeMentionOption[] = selectedKnowledgeMentions,
    skillMentions: ChatSkillMentionOption[] = selectedSkillMentions,
    assetMentions: ChatAssetMentionOption[] = selectedAssetMentions,
    displayContentOverride?: string,
  ) => {
    const primaryAttachment = attachments[0];
    const safeKnowledgeMentions = knowledgeMentions.filter((item) => item.id);
    uiTraceInteraction('chat', 'send_message', {
      sessionId: currentSessionId || null,
      chars: String(content || '').trim().length,
      hasAttachment: attachments.length > 0,
      attachmentCount: attachments.length,
      targetAdvisorId: memberMention?.id || null,
      knowledgeReferenceCount: safeKnowledgeMentions.length,
      assetReferenceCount: assetMentions.length,
    });
    suppressComposerFocus('send_message', 5000);
    blurComposer('send_message');
    shouldAutoScrollRef.current = true;
    setErrorNotice(null);
    const normalizedContent = String(content || '').trim();
    const mentionLabel = memberMention ? `@${memberMention.name}` : '';
    const inlineLabels = [
      mentionLabel,
      ...skillMentions.map((item) => `@${item.name}`),
      ...assetMentions.map((item) => `@${item.name}`),
    ].filter(Boolean);
    const missingInlineLabels = inlineLabels.filter((label) => !normalizedContent.includes(label));
    const knowledgeLabels = safeKnowledgeMentions.map((item) => `#${item.title || '知识库内容'}`);
    const normalizedDisplayOverride = String(displayContentOverride || '').trim();
    const hasAttachments = attachments.length > 0;
    const attachmentOnlyTitle = hasAttachments
      ? `附件：${attachments.map((item) => item.name).filter(Boolean).join('、') || '未命名附件'}`
      : '';
    const displayBody = normalizedDisplayOverride || normalizedContent || (safeKnowledgeMentions.length > 0 ? '请结合提到的知识库内容回答。' : '');
    const displayText = [...missingInlineLabels, ...knowledgeLabels, displayBody].filter(Boolean).join(' ').trim();
    if (!displayText && !hasAttachments) return;
    const attachmentBlockReason = attachmentsSendBlockReason(attachments);
    if (attachmentBlockReason) {
      setErrorNotice(attachmentBlockReason);
      return;
    }
    const runtimeMessage = normalizedContent || displayBody || displayText || (hasAttachments ? '请分析这些附件。' : '');
    const assetReferencesForSend = assetMentions.map((item) => ({
      id: item.id,
      name: item.name,
    }));
    const processingStartedAt = Date.now();
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
      attachment: primaryAttachment as unknown as Message['attachment'],
      attachments,
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
    const optimisticMessages = [userMsg, aiPlaceholder];
    let targetSessionId = currentSessionIdRef.current || currentSessionId || null;
    let seededOptimisticMessages = false;
    if (!targetSessionId && onEnsureSessionForSend) {
      try {
        targetSessionId = await onEnsureSessionForSend(defaultSessionTitleFromMessage(displayBody || displayText || attachmentOnlyTitle), {
          onCreated: (sessionId) => {
            currentSessionIdRef.current = sessionId;
            skipNextFixedSessionLoadRef.current = sessionId;
            fixedSessionInflightLoads.delete(sessionId);
            writeFixedSessionWarmSnapshot(sessionId, { messages: optimisticMessages });
            localMessageMutationRef.current += 1;
            setMessages(optimisticMessages);
            setCurrentSessionId(sessionId);
            setIsProcessing(true);
            seededOptimisticMessages = true;
          },
        });
      } catch (error) {
        console.error('Failed to create chat session before send:', error);
        targetSessionId = null;
      }
      if (!targetSessionId) {
        setErrorNotice('创建对话失败，请稍后重试');
        return;
      }
      currentSessionIdRef.current = targetSessionId;
      skipNextFixedSessionLoadRef.current = targetSessionId;
      setCurrentSessionId(targetSessionId);
    }
    notifySessionActivity(targetSessionId, new Date(processingStartedAt).toISOString());

    fixedSessionInflightLoads.delete(targetSessionId);
    if (!seededOptimisticMessages) {
      localMessageMutationRef.current += 1;
      setMessages(prev => [...prev, userMsg, aiPlaceholder]);
    }
    setInput('');
    setSelectedMemberMention(null);
    setSelectedSkillMentions([]);
    setSelectedAssetMentions([]);
    setSelectedKnowledgeMentions([]);
    resetPendingAttachment();
    setIsProcessing(true);

    let resolvedModelConfig;
    try {
      resolvedModelConfig = await ensureChatModelConfig();
    } catch (error) {
      console.error('Failed to resolve chat model config:', error);
      resolvedModelConfig = undefined;
    }
    const resolvedAttachments = applyAttachmentsDeliveryMode(
      attachments,
      resolvedModelConfig?.modelName || getChatModelConfig()?.modelName,
    );
    const committedAttachments = commitAttachmentsForSend(resolvedAttachments);
    const resolvedAttachment = createAttachmentPayload(committedAttachments);
    if (analyticsContext?.surface === 'redclaw') {
      void window.ipcRenderer.analytics.track('redclaw_task_submitted', {
        surface: 'redclaw',
        origin: 'chat',
        properties: {
          runtimeMode: analyticsContext.runtimeMode || 'redclaw',
          inputKind: committedAttachments.length > 0 ? (runtimeMessage.trim() ? 'mixed' : 'attachment') : 'text',
          hasAttachment: committedAttachments.length > 0,
          attachmentCount: committedAttachments.length,
          knowledgeReferenceCount: safeKnowledgeMentions.length,
          assetReferenceCount: assetReferencesForSend.length,
          hasMemberMention: Boolean(memberMention),
        },
      });
    }

    dispatchChatSend({
      sessionId: targetSessionId || undefined,
      message: runtimeMessage,
      displayContent: displayText,
      attachment: stripTransientAttachmentPreview(resolvedAttachment as UploadedFileAttachment | undefined),
      attachments: committedAttachments.map((attachment) => stripTransientAttachmentPreview(attachment) as UploadedFileAttachment),
      memberMention: memberMention ? {
        type: 'advisor',
        advisorId: memberMention.id,
        name: memberMention.name,
        avatar: memberMention.avatar,
      } : undefined,
      knowledgeReferences: safeKnowledgeMentions,
      assetReferences: assetReferencesForSend,
      modelConfig: resolvedModelConfig || getChatModelConfig(),
      taskHints: mergeSkillMentionsIntoTaskHints(fixedSessionTaskHints, skillMentions),
    });
  };

  const reusableVideoAttachments = useMemo(
    () => pendingAttachments.length > 0 ? [] : latestReusableVideoAttachments(messages),
    [messages, pendingAttachments.length],
  );
  const shortcutAttachment = pendingAttachment || reusableVideoAttachments[0] || null;
  const shortcutAttachments = pendingAttachments.length > 0 ? pendingAttachments : reusableVideoAttachments;
  const shortcutContext: ChatShortcutContext = {
    input,
    hasInput: Boolean(input.trim()),
    attachment: shortcutAttachment,
    attachments: shortcutAttachments,
    selectedMemberMention,
    selectedKnowledgeMentions,
  };

  const shortcuts = resolveChatShortcutProvider(
    shortcutsProp,
    defaultComposerShortcuts(shortcutContext),
    shortcutContext,
  ).map((shortcut) => (
    !pendingAttachment && shortcutAttachments.length > 0 && shortcut.action === 'send'
      ? { ...shortcut, attachments: shortcutAttachments }
      : shortcut
  ));

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
      const text = String(shortcut.text || '');
      const composer = composerRef.current;
      if (composer) {
        composer.insertTextAtEnd(text, { separator: '\n' });
      } else {
        setInput((prev) => {
          const current = String(prev || '');
          return current.trim() ? `${current}${current.endsWith('\n') ? '' : '\n'}${text}` : text;
        });
        activateComposerInput('composer');
      }
      return;
    }
    if (shortcut.attachments && shortcut.attachments.length > 0) {
      void sendMessage(
        shortcut.text,
        shortcut.attachments,
        selectedMemberMention || fixedMemberMention,
        selectedKnowledgeMentions,
        selectedSkillMentions,
        selectedAssetMentions,
        shortcut.displayContent || shortcut.label,
      );
      return;
    }
    void sendMessage(shortcut.text);
  }, [
    activateComposerInput,
    fixedMemberMention,
    selectedAssetMentions,
    selectedKnowledgeMentions,
    selectedMemberMention,
    selectedSkillMentions,
    sendMessage,
  ]);

  const currentAttachmentActionKey = attachmentActionKey(pendingAttachments);
  const attachmentActionKindValue = attachmentShortcutKind(pendingAttachment);
  const isNewAttachmentActionSession = isEmptySession && messages.length === 0;
  const showAttachmentActionOverlay = Boolean(
    showComposerShortcuts &&
    showComposer &&
    allowFileUpload &&
    isNewAttachmentActionSession &&
    pendingAttachment &&
    attachmentActionKindValue &&
    currentAttachmentActionKey &&
    dismissedAttachmentActionKey !== currentAttachmentActionKey &&
    !isAttachmentUploading &&
    shortcuts.length > 0
  );
  const dismissAttachmentActionOverlay = useCallback(() => {
    if (!currentAttachmentActionKey) return;
    setDismissedAttachmentActionKey(currentAttachmentActionKey);
    activateComposerInput('composer');
  }, [activateComposerInput, currentAttachmentActionKey]);
  const applyAttachmentAction = useCallback((shortcut: ChatShortcut) => {
    if (currentAttachmentActionKey) {
      setDismissedAttachmentActionKey(currentAttachmentActionKey);
    }
    void sendMessage(
      shortcut.text,
      pendingAttachments,
      selectedMemberMention || fixedMemberMention,
      selectedKnowledgeMentions,
      selectedSkillMentions,
      selectedAssetMentions,
      shortcut.displayContent || shortcut.label,
    );
  }, [
    currentAttachmentActionKey,
    fixedMemberMention,
    pendingAttachments,
    selectedAssetMentions,
    selectedKnowledgeMentions,
    selectedMemberMention,
    selectedSkillMentions,
    sendMessage,
  ]);
  const showInlineShortcutChips = Boolean(
    showComposerShortcuts &&
    shortcuts.length > 0 &&
    !pendingAttachment
  );

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
  const showChatDropOverlay = Boolean(
    allowFileUpload &&
    isFileDragActive &&
    showComposer
  );
  const shouldCollapseEmptyFixedSession = Boolean(
    collapseEmptyFixedSession &&
    fixedSessionMode &&
    isEmptySession &&
    !pendingMessage &&
    !isProcessing &&
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
        onSubmit={() => sendMessage(input, pendingAttachments, selectedMemberMention, selectedKnowledgeMentions, selectedSkillMentions, selectedAssetMentions)}
        placeholder={placeholder}
        attachment={pendingAttachment}
        attachments={pendingAttachments}
        attachmentStatus={isAttachmentUploading ? 'uploading' : pendingAttachment ? 'uploaded' : null}
        attachmentPreviewMode={attachmentPreviewMode}
        onPickAttachment={allowFileUpload ? pickAttachment : undefined}
        onPasteImageFiles={allowFileUpload ? attachFiles : undefined}
        onClearAttachment={clearPendingAttachment}
        onRemoveAttachment={removePendingAttachment}
        modelOptions={chatModelOptions}
        selectedModelKey={selectedChatModelKey}
        onSelectedModelKeyChange={handleSelectedChatModelKeyChange}
        isBusy={isProcessing}
        allowInputWhileBusy={keepComposerInputActive}
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
        skillMentionOptions={skillMentionOptions}
        selectedSkillMentions={selectedSkillMentions}
        onSelectedSkillMentionsChange={setSelectedSkillMentions}
        assetMentionOptions={assetMentionOptions}
        selectedAssetMentions={selectedAssetMentions}
        onSelectedAssetMentionsChange={setSelectedAssetMentions}
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
        await window.ipcRenderer.openPath(action.url);
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
  const attachmentActionOverlay = showAttachmentActionOverlay && pendingAttachment && attachmentActionKindValue ? (
    <ChatAttachmentActionOverlay
      attachment={pendingAttachment}
      attachmentCount={pendingAttachments.length}
      actions={shortcuts}
      darkEmbedded={darkEmbedded}
      kind={attachmentActionKindValue}
      disabled={isProcessing}
      onAction={applyAttachmentAction}
      onDismiss={dismissAttachmentActionOverlay}
    />
  ) : null;

  if (shouldCollapseEmptyFixedSession) {
    return null;
  }

  return (
    <div
      className={clsx('flex h-full min-w-0', wideContent && 'chat-layout-wide', narrowContent && 'chat-layout-narrow')}
      {...dragHandlers}
    >
      {/* Main Chat Area */}
      <div className="flex-1 min-w-0 flex flex-col h-full relative overflow-hidden">
        {showChatDropOverlay ? (
          <ChatDropOverlay darkEmbedded={darkEmbedded} />
        ) : null}
        {attachmentActionOverlay}
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
                  {showComposer ? (
                    renderComposer('empty', 'empty', placeholder || '问我任何问题，使用 @ 引用文件，/ 执行指令...', {
                      className: 'mt-10',
                      showCancelWhenBusy: false,
                    })
                  ) : null}
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
                            {visibleMessages.map((msg) => (
                              <ErrorBoundary key={msg.id} name={`MessageItem-${msg.id}`}>
                                <MessageItem
                                  msg={msg}
                                  copiedMessageId={copiedMessageId}
                                  onCopyMessage={handleCopyMessage}
                                  savingKnowledgeMessageId={savingKnowledgeMessageId}
                                  savedKnowledgeMessageId={savedKnowledgeMessageId}
                                  onSaveToKnowledge={handleSaveMessageToKnowledge}
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
                    {errorNotice && (() => {
                      const structuredNotice = typeof errorNotice === 'string' ? null : errorNotice;
                      const noticeTitle = structuredNotice?.title || '请求失败';
                      const noticeBody = String(structuredNotice
                        ? structuredNotice.hint
                          || ''
                        : errorNotice);
                      const reportContent = structuredNotice
                        ? [structuredNotice.hint, structuredNotice.detail, structuredNotice.metaParts?.join(' · ')]
                          .filter(Boolean)
                          .join('\n\n') || noticeTitle
                        : errorNotice;
                      const noticeTone = structuredNotice?.tone || 'danger';
                      const noticeClass = noticeTone === 'danger'
                        ? 'border-red-500/25 bg-red-500/[0.07] text-red-700 dark:text-red-300'
                        : noticeTone === 'warning'
                          ? 'border-amber-500/25 bg-amber-500/[0.08] text-amber-800 dark:text-amber-200'
                          : 'border-border/80 bg-surface-secondary/70 text-text-secondary';
                      const detailClass = noticeTone === 'danger'
                        ? 'text-red-700/75 dark:text-red-300/80'
                        : noticeTone === 'warning'
                          ? 'text-amber-800/75 dark:text-amber-200/80'
                          : 'text-text-tertiary';
                      const actionClass = noticeTone === 'danger'
                        ? 'border-red-500/25 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-200'
                        : noticeTone === 'warning'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:text-amber-100'
                          : 'border-border bg-surface-primary/80 text-text-secondary hover:border-accent-primary/30 hover:text-text-primary';
                      const closeClass = noticeTone === 'danger'
                        ? 'text-red-700/65 hover:bg-red-500/10 hover:text-red-800 dark:text-red-200/75 dark:hover:text-red-100'
                        : noticeTone === 'warning'
                          ? 'text-amber-800/65 hover:bg-amber-500/10 hover:text-amber-900 dark:text-amber-100/80 dark:hover:text-amber-50'
                          : 'text-text-tertiary hover:bg-surface-primary hover:text-text-primary';
                      return (
                        <div className={clsx('flex min-h-9 items-center gap-2 overflow-hidden rounded-lg border px-2.5 py-1.5 text-[12px] shadow-sm', noticeClass)}>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium leading-5">{noticeTitle}</div>
                            {noticeBody && (
                              <div className={clsx('truncate text-[11px] leading-4', detailClass)}>
                                {truncateErrorDetail(noticeBody, 110)}
                              </div>
                            )}
                          </div>
                          {structuredNotice?.action?.target === 'settings-login' && (
                            <button
                              type="button"
                              onClick={handleOpenSettingsLogin}
                              className={clsx('inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-[11px] font-medium transition-colors', actionClass)}
                            >
                              {structuredNotice.action.label}
                            </button>
                          )}
                          {structuredNotice?.tone === 'danger' && (
                            <button
                              type="button"
                              onClick={() => window.dispatchEvent(new CustomEvent('redbox:open-feedback-report', {
                                detail: {
                                  title: noticeTitle,
                                  content: reportContent,
                                  sourcePage: 'chat',
                                  sessionId: currentSessionIdRef.current || currentSessionId || undefined,
                                  operation: 'chat_request',
                                },
                              }))}
                              className={clsx('inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-[11px] font-medium transition-colors', actionClass)}
                            >
                              反馈
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setErrorNotice(null)}
                            className={clsx('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors', closeClass)}
                            aria-label="关闭错误提示"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })()}
                    {showInlineShortcutChips && (
                      <div className="flex gap-2 overflow-x-auto py-1 no-scrollbar">
                        {shortcuts.map((shortcut) => (
                          <button key={shortcut.label} type="button" onClick={() => applyShortcut(shortcut)} disabled={isProcessing} className={shortcutChipClass}>
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
