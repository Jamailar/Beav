import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
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
import { subscribeDataChanged, subscribeSettingsUpdated } from '../bridge/appEvents';
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
  type ChatMessageAssetReference,
  type ChatMessageMemberActor,
  type ChatMessageSkillReference,
  ToolEvent,
  SkillEvent,
  type ChatMessageLinkRenderMode,
  type ChatMessageLinkTarget,
} from '../components/MessageItem';
import type { ProcessItem, ProcessItemType } from '../components/ProcessTimeline';
import { ChatAttachmentActionOverlay } from './chat/ChatAttachmentActionOverlay';
import { ChatDropOverlay } from './chat/ChatDropOverlay';
import type { ChatAttachmentActionKind } from './chat/attachment-actions/types';
import { REDCLAW_ATTACHMENT_ACTIONS_BY_SCENE } from './chat/attachment-actions/redclawAttachmentActions';
import type { PendingChatMessage } from '../features/app-shell/types';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { type AudioRecordingClip } from '../features/audio-input/audioInput';
import { resolveUsableTranscript } from '../features/audio-input/transcriptionResult';
import { useAudioRecording } from '../features/audio-input/useAudioRecording';
import { subscribeRuntimeEventStream, type ToolConfirmRequestPayload } from '../runtime/runtimeEventStream';
import { appConfirm } from '../utils/appDialogs';
import { uiMeasure, uiTraceInteraction } from '../utils/uiDebug';
import { useDocumentThemeMode } from '../hooks/useDocumentThemeMode';
import { resolveAssetUrl } from '../utils/pathManager';
import { useChatAttachments } from './chat/useChatAttachments';

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

function parseMessageMetadataObject(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof metadata === 'object') return metadata as Record<string, unknown>;
  return null;
}

function memberActorFromMessageMetadata(metadata: unknown): ChatMessageMemberActor | undefined {
  const object = parseMessageMetadataObject(metadata);
  if (!object) return undefined;
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

function knowledgeReferencesFromMessageMetadata(metadata: unknown): ChatKnowledgeMentionOption[] {
  const object = parseMessageMetadataObject(metadata);
  if (!object) return [];
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
      return {
        id,
        title: String(item.title || '未命名内容').trim(),
        sourceKind: String(item.sourceKind || '').trim() || undefined,
        summary: String(item.summary || '').trim() || undefined,
        cover: String(item.cover || '').trim() || undefined,
        sourceUrl: String(item.sourceUrl || '').trim() || undefined,
        folderPath: String(item.folderPath || '').trim() || undefined,
        rootPath: String(item.rootPath || '').trim() || undefined,
        tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : undefined,
        updatedAt: String(item.updatedAt || '').trim() || undefined,
        fileCount: typeof item.fileCount === 'number' ? item.fileCount : undefined,
        hasTranscript: typeof item.hasTranscript === 'boolean' ? item.hasTranscript : undefined,
      };
    })
    .filter((item): item is ChatKnowledgeMentionOption => Boolean(item));
}

function assetReferencesFromMessageMetadata(metadata: unknown): ChatMessageAssetReference[] {
  const object = parseMessageMetadataObject(metadata);
  if (!object) return [];
  const rawReferences = Array.isArray(object.explicitAssetRefs)
    ? object.explicitAssetRefs
    : Array.isArray(object.references)
      ? object.references.filter((item) => (
        item
        && typeof item === 'object'
        && String((item as Record<string, unknown>).type || '').trim() === 'asset'
      ))
      : [];
  return rawReferences
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const id = String(item.assetId || item.id || '').trim();
      const name = String(item.name || '').trim();
      if (!id || !name) return null;
      return {
        id,
        name,
        description: String(item.description || '').trim() || undefined,
        primaryPreviewUrl: String(item.primaryPreviewUrl || '').trim() || undefined,
        tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : undefined,
      };
    })
    .filter((item): item is ChatMessageAssetReference => Boolean(item));
}

function skillReferencesFromMessageMetadata(metadata: unknown): ChatMessageSkillReference[] {
  const object = parseMessageMetadataObject(metadata);
  if (!object || !Array.isArray(object.activeSkills)) return [];
  return Array.from(new Set(
    object.activeSkills
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ))
    .slice(0, 12)
    .map((name) => ({ name }));
}

function uploadedAttachmentsFromMessageMetadata(metadata: unknown): UploadedFileAttachment[] {
  const object = parseMessageMetadataObject(metadata);
  if (!object || !Array.isArray(object.uploadedAttachments)) return [];
  return object.uploadedAttachments
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      if (String(item.type || '').trim() !== 'uploaded-file') return null;
      const name = String(item.name || '').trim();
      if (!name) return null;
      return {
        type: 'uploaded-file',
        name,
        attachmentId: String(item.attachmentId || '').trim() || undefined,
        workspaceRelativePath: String(item.workspaceRelativePath || '').trim() || undefined,
        toolPath: String(item.toolPath || '').trim() || undefined,
        absolutePath: String(item.absolutePath || '').trim() || undefined,
        originalAbsolutePath: String(item.originalAbsolutePath || '').trim() || undefined,
        localUrl: String(item.localUrl || '').trim() || undefined,
        inlineDataUrl: String(item.inlineDataUrl || '').trim() || undefined,
        thumbnailDataUrl: String(item.thumbnailDataUrl || '').trim() || undefined,
        thumbnailUrl: String(item.thumbnailUrl || '').trim() || undefined,
        kind: String(item.kind || '').trim() || undefined,
        mimeType: String(item.mimeType || '').trim() || undefined,
        size: typeof item.size === 'number' ? item.size : undefined,
        ext: String(item.ext || '').trim() || undefined,
        storageMode: String(item.storageMode || '').trim() || undefined,
        directUploadEligible: typeof item.directUploadEligible === 'boolean' ? item.directUploadEligible : undefined,
        processingStrategy: String(item.processingStrategy || '').trim() || undefined,
        deliveryMode: String(item.deliveryMode || '').trim() || undefined,
        intakeStatus: String(item.intakeStatus || '').trim() || undefined,
        capabilities: item.capabilities && typeof item.capabilities === 'object' ? item.capabilities as Record<string, boolean | undefined> : undefined,
        deliveryPlan: item.deliveryPlan && typeof item.deliveryPlan === 'object' ? item.deliveryPlan as Record<string, unknown> : undefined,
        summary: String(item.summary || '').trim() || undefined,
        requiresMultimodal: typeof item.requiresMultimodal === 'boolean' ? item.requiresMultimodal : undefined,
        attachmentLifecycle: String(item.attachmentLifecycle || '').trim() || undefined,
      };
    })
    .filter((item): item is UploadedFileAttachment => Boolean(item));
}

function normalizePendingKnowledgeReferences(items: PendingChatMessage['knowledgeReferences'] | undefined): ChatKnowledgeMentionOption[] {
  return (items || [])
    .filter((item) => item && item.id)
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
    if (item.sourceUrl) {
      lines.push(`   sourceUrl: ${item.sourceUrl}`);
    }
    if (item.summary) {
      lines.push(`   summary: ${item.summary.slice(0, 240)}`);
    }
  });
  return lines.join('\n');
}

export interface ChatShortcut {
  label: string;
  text: string;
  displayContent?: string;
  action?: 'send' | 'inject';
  attachment?: UploadedFileAttachment;
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

function resolveChatShortcutProvider(
  provider: ChatShortcutProvider | undefined,
  fallback: ChatShortcut[],
  context: ChatShortcutContext,
): ChatShortcut[] {
  return provider
    ? (typeof provider === 'function' ? provider(context) : provider)
    : fallback;
}

interface AdvisorMentionRecord {
  id: string;
  name?: string;
  avatar?: string;
  personality?: string;
}

interface KnowledgeMentionCatalogRecord {
  id?: string;
  itemId?: string;
  title?: string;
  kind?: string;
  sourceKind?: string;
  previewText?: string;
  summary?: string;
  cover?: string;
  coverUrl?: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
  folderPath?: string;
  rootPath?: string;
  tags?: string[];
  updatedAt?: string;
  fileCount?: number;
  hasTranscript?: boolean;
}

interface KnowledgeMentionListPageResponse {
  items?: KnowledgeMentionCatalogRecord[];
  nextCursor?: string | null;
  total?: number;
}

interface SkillMentionCatalogRecord {
  name?: string;
  description?: string;
  location?: string;
  sourceScope?: string;
  isBuiltin?: boolean;
  aliases?: string[];
}

interface AssetMentionCatalogRecord {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  category_id?: string;
  primaryPreviewUrl?: string;
  previewUrls?: string[];
  imagePaths?: string[];
  image_paths?: string[];
  absoluteImagePaths?: string[];
  absolute_image_paths?: string[];
  voicePath?: string;
  voice_path?: string;
  absoluteVoicePath?: string;
  absolute_voice_path?: string;
}

function normalizeKnowledgeMentionRecord(item: KnowledgeMentionCatalogRecord): ChatKnowledgeMentionOption | null {
  const id = String(item.id || item.itemId || '').trim();
  if (!id) return null;
  const title = String(item.title || item.sourceUrl || id).trim() || '未命名内容';
  return {
    id,
    title,
    sourceKind: String(item.sourceKind || item.kind || '').trim() || undefined,
    summary: String(item.summary || item.previewText || '').trim() || undefined,
    cover: String(item.cover || item.coverUrl || item.thumbnailUrl || '').trim() || undefined,
    sourceUrl: String(item.sourceUrl || '').trim() || undefined,
    folderPath: String(item.folderPath || '').trim() || undefined,
    rootPath: String(item.rootPath || '').trim() || undefined,
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : undefined,
    updatedAt: String(item.updatedAt || '').trim() || undefined,
    fileCount: typeof item.fileCount === 'number' ? item.fileCount : undefined,
    hasTranscript: typeof item.hasTranscript === 'boolean' ? item.hasTranscript : undefined,
  };
}

function normalizeSkillMentionRecord(item: SkillMentionCatalogRecord): ChatSkillMentionOption | null {
  const name = String(item.name || '').trim();
  if (!name) return null;
  return {
    name,
    description: String(item.description || '').trim() || undefined,
    location: String(item.location || '').trim() || undefined,
    sourceScope: String(item.sourceScope || '').trim() || undefined,
    isBuiltin: Boolean(item.isBuiltin),
    aliases: Array.isArray(item.aliases) ? item.aliases.map((value) => String(value || '').trim()).filter(Boolean) : undefined,
  };
}

function normalizeAssetMentionRecord(item: AssetMentionCatalogRecord): ChatAssetMentionOption | null {
  const id = String(item.id || '').trim();
  const name = String(item.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    description: String(item.description || '').trim() || undefined,
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : undefined,
    categoryId: String(item.categoryId || item.category_id || '').trim() || undefined,
    primaryPreviewUrl: String(item.primaryPreviewUrl || '').trim() || undefined,
    previewUrls: Array.isArray(item.previewUrls) ? item.previewUrls.map((url) => String(url || '').trim()).filter(Boolean) : undefined,
    imagePaths: Array.isArray(item.imagePaths || item.image_paths) ? (item.imagePaths || item.image_paths || []).map((path) => String(path || '').trim()).filter(Boolean) : undefined,
    absoluteImagePaths: Array.isArray(item.absoluteImagePaths || item.absolute_image_paths) ? (item.absoluteImagePaths || item.absolute_image_paths || []).map((path) => String(path || '').trim()).filter(Boolean) : undefined,
    voicePath: String(item.voicePath || item.voice_path || '').trim() || undefined,
    absoluteVoicePath: String(item.absoluteVoicePath || item.absolute_voice_path || '').trim() || undefined,
  };
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
  placeholder?: string;
  messageLinkRenderMode?: ChatMessageLinkRenderMode;
  onMessageLinkPreview?: (target: ChatMessageLinkTarget) => void;
  activePreviewHref?: string | null;
  keepComposerInputActive?: boolean;
  messageListHeader?: React.ReactNode;
  fixedMemberMention?: ChatMemberMentionOption | null;
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
}

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

function commitAttachmentsForSend(attachments: UploadedFileAttachment[]): UploadedFileAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    attachmentLifecycle: 'committed',
  }));
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

function createAttachmentPayload(attachments: UploadedFileAttachment[]): Message['attachment'] | undefined {
  if (attachments.length === 0) return undefined;
  return attachments[0] as Message['attachment'];
}

function inferAttachmentActionKind(attachment: UploadedFileAttachment | null | undefined): ChatAttachmentActionKind {
  const kind = attachmentKind(attachment || undefined);
  const mimeType = String(attachment?.mimeType || '').trim().toLowerCase();
  const ext = String(attachment?.ext || '').trim().replace(/^\./, '').toLowerCase();
  if (kind === 'image' || mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'].includes(ext)) return 'image';
  if (kind === 'video' || mimeType.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes(ext)) return 'video';
  return 'file';
}

function attachmentActionKey(attachment: UploadedFileAttachment | UploadedFileAttachment[] | null | undefined): string {
  const items = Array.isArray(attachment)
    ? attachment
    : attachment
      ? [attachment]
      : [];
  if (items.length === 0) return '';
  return items.map((item) => [
    item.attachmentId,
    item.name,
    item.workspaceRelativePath,
    item.toolPath,
    item.absolutePath,
    item.originalAbsolutePath,
    item.size,
    item.kind,
    item.mimeType,
  ].map((value) => String(value || '')).join('|')).join('\n');
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

function latestReusableVideoAttachment(messages: Message[]): UploadedFileAttachment | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const attachment = uploadedAttachmentsFromMessage(messages[index])
      .find((item) => inferAttachmentActionKind(item) === 'video');
    if (attachment) {
      return attachment;
    }
  }
  return null;
}

function attachmentActionsFor(kind: ChatAttachmentActionKind): ChatShortcut[] {
  const scene = kind === 'video'
    ? 'uploaded_video'
    : kind === 'image'
      ? 'uploaded_image'
      : 'uploaded_file';
  return REDCLAW_ATTACHMENT_ACTIONS_BY_SCENE[scene];
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
  const title = String(data.title || data.message || '').trim() || '请求失败';
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
  };
}

export function Chat({
  isActive = true,
  onExecutionStateChange,
  pendingMessage,
  onMessageConsumed,
  defaultCollapsed = true,
  fixedSessionId,
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
  placeholder,
  messageLinkRenderMode = 'default',
  onMessageLinkPreview,
  activePreviewHref = null,
  keepComposerInputActive = false,
  messageListHeader,
  fixedMemberMention = null,
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
  const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
  const [memberMentionOptions, setMemberMentionOptions] = useState<ChatMemberMentionOption[]>([]);
  const [selectedMemberMention, setSelectedMemberMention] = useState<ChatMemberMentionOption | null>(null);
  const [knowledgeMentionOptions, setKnowledgeMentionOptions] = useState<ChatKnowledgeMentionOption[]>([]);
  const [selectedKnowledgeMentions, setSelectedKnowledgeMentions] = useState<ChatKnowledgeMentionOption[]>([]);
  const [skillMentionOptions, setSkillMentionOptions] = useState<ChatSkillMentionOption[]>([]);
  const [selectedSkillMentions, setSelectedSkillMentions] = useState<ChatSkillMentionOption[]>([]);
  const [assetMentionOptions, setAssetMentionOptions] = useState<ChatAssetMentionOption[]>([]);
  const [selectedAssetMentions, setSelectedAssetMentions] = useState<ChatAssetMentionOption[]>([]);
  const documentThemeMode = useDocumentThemeMode();
  const attachmentDraftScopeId = fixedSessionId || currentSessionId || '__new__';

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
  const [selectedChatModelKey, setSelectedChatModelKeyState] = useState(() => String(initialChatModelKey || '').trim());
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const [dismissedAttachmentActionKey, setDismissedAttachmentActionKey] = useState('');
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
    isFileDragActive,
    isAttachmentUploading,
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
  
  // Throttle buffer for streaming updates
  const pendingUpdateRef = useRef<{ content: string; messagePhase: string } | null>(null);
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

  const applyChatModelOptions = useCallback((options: ChatModelOption[]) => {
    chatModelOptionsRef.current = options;
    setChatModelOptions(options);
  }, []);

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
    setSelectedKnowledgeMentions([]);
    setSelectedSkillMentions([]);
    setSelectedAssetMentions([]);
  }, [currentSessionId]);

  useEffect(() => {
    setDismissedAttachmentActionKey('');
  }, [pendingAttachment]);

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
      console.error('Failed to load chat member mention options:', error);
    }
  }, [normalizeMemberMentionOptions]);

  const loadKnowledgeMentionOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const response = await window.ipcRenderer.knowledge.listPage<KnowledgeMentionListPageResponse>({
        limit: 300,
        sort: 'updated-desc',
      });
      const records = Array.isArray(response?.items) ? response.items : [];
      setKnowledgeMentionOptions(
        records
          .map(normalizeKnowledgeMentionRecord)
          .filter((item): item is ChatKnowledgeMentionOption => Boolean(item)),
      );
    } catch (error) {
      console.error('Failed to load chat knowledge mention options:', error);
      setKnowledgeMentionOptions([]);
    }
  }, []);

  const loadSkillMentionOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const skills = await window.ipcRenderer.listSkills();
      setSkillMentionOptions(
        (skills || [])
          .map((item) => normalizeSkillMentionRecord(item as SkillMentionCatalogRecord))
          .filter((item): item is ChatSkillMentionOption => Boolean(item)),
      );
    } catch (error) {
      console.error('Failed to load chat skill mention options:', error);
      setSkillMentionOptions([]);
    }
  }, []);

  const loadAssetMentionOptions = useCallback(async () => {
    if (!isActiveRef.current) return;
    try {
      const result = await window.ipcRenderer.subjects.list({ limit: 500 }) as { subjects?: AssetMentionCatalogRecord[]; assets?: AssetMentionCatalogRecord[] };
      const records = Array.isArray(result?.subjects)
        ? result.subjects
        : Array.isArray(result?.assets)
          ? result.assets
          : [];
      setAssetMentionOptions(
        records
          .map((item) => normalizeAssetMentionRecord(item))
          .filter((item): item is ChatAssetMentionOption => Boolean(item)),
      );
    } catch (error) {
      console.error('Failed to load chat asset mention options:', error);
      setAssetMentionOptions([]);
    }
  }, []);

  const ensureChatModelConfig = useCallback(async () => {
    const currentModel = resolveSelectedChatModelFromRefs() || selectedChatModel;
    if (currentModel) {
      return {
        apiKey: currentModel.apiKey,
        baseURL: currentModel.baseURL,
        modelName: currentModel.modelName,
      };
    }
    const settings = await uiMeasure('chat', 'ensure_chat_model_config', async () => (
      window.ipcRenderer.getSettings() as Promise<ChatSettingsSnapshot | undefined>
    ));
    const options = buildChatModelOptions(settings);
    if (options.length === 0) {
      return undefined;
    }
    applyChatModelOptions(options);
    const resolvedKey = options.find((item) => item.isDefault)?.key || options[0]?.key || '';
    if (resolvedKey) {
      setSelectedChatModelKeyState((current) => {
        const preferred = selectedChatModelKeyRef.current || current;
        if (preferred && options.some((item) => item.key === preferred)) {
          selectedChatModelKeyRef.current = preferred;
          return preferred;
        }
        selectedChatModelKeyRef.current = resolvedKey;
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
  }, [applyChatModelOptions, resolveSelectedChatModelFromRefs, selectedChatModel]);

  const loadChatRooms = useCallback(async (options?: { silent?: boolean }) => {
    if (fixedSessionId) return;
    const requestId = ++chatRoomsRequestIdRef.current;
    const silent = Boolean(options?.silent);
    if (!silent) {
      setIsRoomPickerLoading(true);
    }
    try {
      const rooms = await uiMeasure('chat', 'load_chat_rooms', async () => (
        window.ipcRenderer.chatrooms.list<ChatRoom[]>()
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
    void loadMemberMentionOptions();
    void loadKnowledgeMentionOptions();
    void loadSkillMentionOptions();
    void loadAssetMentionOptions();
  }, [isActive, loadAssetMentionOptions, loadChatModelOptions, loadKnowledgeMentionOptions, loadMemberMentionOptions, loadSkillMentionOptions]);

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
    attachments?: UploadedFileAttachment[];
    knowledgeReferences?: ChatKnowledgeMentionOption[];
    assetReferences?: Array<{ id: string; name: string }>;
    memberMention?: {
      type: 'advisor';
      advisorId: string;
      name: string;
      avatar?: string;
    };
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
      attachmentCount: payload.attachments?.length || (payload.attachment ? 1 : 0),
      targetAdvisorId: payload.memberMention?.advisorId || null,
      knowledgeReferenceCount: payload.knowledgeReferences?.length || 0,
      assetReferenceCount: payload.assetReferences?.length || 0,
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

    const pendingKnowledgeReferences = normalizePendingKnowledgeReferences(pendingMessage.knowledgeReferences);
    const pendingMessageAttachments = (
      pendingMessage.attachments && pendingMessage.attachments.length > 0
        ? pendingMessage.attachments
        : pendingMessage.attachment?.type === 'uploaded-file'
          ? [pendingMessage.attachment as UploadedFileAttachment]
          : []
    ).filter((attachment): attachment is UploadedFileAttachment => Boolean(attachment));

    if (pendingMessage.deliveryMode === 'draft') {
      setInput(String(pendingMessage.content || ''));
      setSelectedKnowledgeMentions(pendingKnowledgeReferences);
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
      const resolvedAttachments = applyAttachmentsDeliveryMode(
        pendingMessageAttachments,
        resolvedModelConfig?.modelName || getChatModelConfig()?.modelName,
      );
      const committedAttachments = commitAttachmentsForSend(resolvedAttachments);
      const resolvedAttachment = createAttachmentPayload(committedAttachments)
        || (pendingMessage.attachment?.type !== 'uploaded-file' ? pendingMessage.attachment : undefined);
      const pendingAttachmentBlockReason = attachmentsSendBlockReason(resolvedAttachments);
      if (pendingAttachmentBlockReason) {
        setErrorNotice(pendingAttachmentBlockReason);
        pendingMessageHandledRef.current = false;
        onMessageConsumed?.();
        return;
      }

      const pendingKnowledgeRuntimeContext = buildKnowledgeReferenceRuntimeContext(pendingKnowledgeReferences);
      const pendingRuntimeMessage = [
        pendingMessage.content,
        pendingKnowledgeRuntimeContext ? `\n\n[KnowledgeReferences]\n${pendingKnowledgeRuntimeContext}\n[/KnowledgeReferences]` : '',
      ].filter(Boolean).join('');

      // 构建用户消息 - 注意：attachment 和 displayContent 用于 UI 显示
      const processingStartedAt = Date.now();
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
        attachment: stripTransientMessageAttachmentPreview(resolvedAttachment as Message['attachment']),
        attachments: committedAttachments.map((attachment) => stripTransientAttachmentPreview(attachment) as UploadedFileAttachment),
        knowledgeReferences: pendingKnowledgeReferences,
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
      if (
        normalizedList.length > 0
        && !currentSessionIdRef.current
        && !pendingAttachment
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
      let lastUserMemberActor: ChatMessageMemberActor | undefined;
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
        const assetReferences = assetReferencesFromMessageMetadata(msg.metadata);
        const skillReferences = skillReferencesFromMessageMetadata(msg.metadata);
        const uploadedAttachments = uploadedAttachmentsFromMessageMetadata(msg.metadata);
        const restoredAttachments = uploadedAttachments.length > 0
          ? uploadedAttachments
          : attachment?.type === 'uploaded-file'
            ? [attachment as UploadedFileAttachment]
            : [];
        const assistantMemberActor = role === 'ai' ? (memberActor || lastUserMemberActor) : undefined;

        if (role === 'user') {
          lastUserCreatedAt = createdAt;
          lastUserMemberActor = memberActor;
        }

        return {
          id: msg.id,
          role, // Simplified mapping
          messageType: role === 'ai' ? 'reply' : undefined,
          content: msg.content,
          displayContent: msg.display_content || undefined,
          attachment: attachment,
          attachments: restoredAttachments,
          knowledgeReferences: role === 'user' ? knowledgeReferences : [],
          assetReferences: role === 'user' ? assetReferences : [],
          skillReferences: role === 'user' ? skillReferences : [],
          memberMention: role === 'user' ? memberActor : undefined,
          memberActor: assistantMemberActor,
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
            messageType: 'reply',
            content: restoredContent,
            tools: [],
            timeline: [],
            isStreaming: true,
            processingStartedAt: lastUserCreatedAt ?? Date.now(),
          });
        } else {
          uiMessages[uiMessages.length - 1] = {
            ...lastMsg,
            messageType: 'reply',
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
      setErrorNotice(null);
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

  const flushPendingAssistantChunk = useCallback(() => {
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }

    const pending = pendingUpdateRef.current;
    const chunk = pending?.content || '';
    const messagePhase = pending?.messagePhase || 'final_answer';
    pendingUpdateRef.current = null;
    if (chunk) {
      appendAssistantChunk(chunk, messagePhase);
    }
  }, [appendAssistantChunk]);

  useEffect(() => {
    if (!isActive || fixedSessionId) return;
    const handleSpaceChanged = () => {
      setShowRoomPicker(false);
      setSelectionMenu(prev => ({ ...prev, visible: false }));
      void loadChatRooms({ silent: true });
    };
    window.ipcRenderer.spaces.onChanged(handleSpaceChanged);
    return () => {
      window.ipcRenderer.spaces.offChanged(handleSpaceChanged);
    };
  }, [fixedSessionId, isActive, loadChatRooms]);

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

  useEffect(() => {
    if (!isActive) return;
    const refreshMemberMentions = () => {
      void loadMemberMentionOptions();
    };
    window.ipcRenderer.advisors.onChanged(refreshMemberMentions);
    return () => {
      window.ipcRenderer.advisors.offChanged(refreshMemberMentions);
    };
  }, [isActive, loadMemberMentionOptions]);

  useEffect(() => {
    if (!isActive) return;
    const refreshKnowledgeMentions = () => {
      void loadKnowledgeMentionOptions();
    };
    window.ipcRenderer.knowledge.onChanged(refreshKnowledgeMentions);
    window.ipcRenderer.knowledge.onCatalogUpdated(refreshKnowledgeMentions);
    return () => {
      window.ipcRenderer.knowledge.offChanged(refreshKnowledgeMentions);
      window.ipcRenderer.knowledge.offCatalogUpdated(refreshKnowledgeMentions);
    };
  }, [isActive, loadKnowledgeMentionOptions]);

  useEffect(() => {
    if (!isActive) return;
    const refreshAssetMentions = (_event?: unknown, payload?: { scope?: string }) => {
      if (payload?.scope && payload.scope !== 'subjects') return;
      void loadAssetMentionOptions();
    };
    return subscribeDataChanged(refreshAssetMentions);
  }, [isActive, loadAssetMentionOptions]);

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
        const runningThinkingIndex = findLastRunningThinkingIndex(prev);
        if (runningThinkingIndex !== -1) return prev;

        const lastReplyIndex = findLastAssistantReplyIndex(prev);
        if (lastReplyIndex === -1) return prev;

        const now = Date.now();
        const next = [...prev];
        next[lastReplyIndex] = {
          ...next[lastReplyIndex],
          messageType: 'reply',
          suppressPendingIndicator: true,
        };
        next.splice(lastReplyIndex, 0, {
          id: `thinking_${now}_${Math.random().toString(36).slice(2, 8)}`,
          role: 'ai',
          messageType: 'thinking',
          content: '',
          tools: [],
          timeline: [],
          isStreaming: true,
          processingStartedAt: now,
        });
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
        let runningThinkingIndex = findLastRunningThinkingIndex(prev);
        let next = [...prev];

        if (runningThinkingIndex === -1) {
          const lastReplyIndex = findLastAssistantReplyIndex(next);
          if (lastReplyIndex === -1) return prev;
          const now = Date.now();
          next[lastReplyIndex] = {
            ...next[lastReplyIndex],
            messageType: 'reply',
            suppressPendingIndicator: true,
          };
          next.splice(lastReplyIndex, 0, {
            id: `thinking_${now}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'ai',
            messageType: 'thinking',
            content,
            tools: [],
            timeline: [],
            isStreaming: true,
            processingStartedAt: now,
          });
          return next;
        }

        const thinkingMessage = next[runningThinkingIndex];
        next[runningThinkingIndex] = {
          ...thinkingMessage,
          messageType: 'thinking',
          content: mergeThoughtDelta(thinkingMessage.content || '', content),
          isStreaming: true,
        };
        return next;
      });
    };

    // 4. Thought End
    const handleThoughtEnd = (_: unknown) => {
      if (!isActiveRef.current) return;
      setMessages(prev => {
        const runningThinkingIndex = findLastRunningThinkingIndex(prev);
        if (runningThinkingIndex === -1) return prev;
        const next = [...prev];
        const thinkingMessage = next[runningThinkingIndex];
        const finishedAt = Date.now();
        next[runningThinkingIndex] = {
          ...thinkingMessage,
          messageType: 'thinking',
          isStreaming: false,
          processingFinishedAt: finishedAt,
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

  const getChatModelConfig = useCallback(() => {
    const currentModel = resolveSelectedChatModelFromRefs() || selectedChatModel;
    if (!currentModel) return undefined;
    return {
      apiKey: currentModel.apiKey,
      baseURL: currentModel.baseURL,
      modelName: currentModel.modelName,
    };
  }, [resolveSelectedChatModelFromRefs, selectedChatModel]);

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
    attachmentsInput: UploadedFileAttachment | UploadedFileAttachment[] = [],
    memberMention: ChatMemberMentionOption | null = selectedMemberMention || fixedMemberMention,
    knowledgeMentions: ChatKnowledgeMentionOption[] = selectedKnowledgeMentions,
    skillMentions: ChatSkillMentionOption[] = selectedSkillMentions,
    assetMentions: ChatAssetMentionOption[] = selectedAssetMentions,
    displayOverride?: string,
  ) => {
    const attachments = Array.isArray(attachmentsInput)
      ? attachmentsInput.filter(Boolean)
      : attachmentsInput
        ? [attachmentsInput]
        : [];
    const primaryAttachment = attachments[0];
    const safeKnowledgeMentions = knowledgeMentions.filter((item) => item.id);
    const safeSkillMentions = skillMentions.filter((item) => item.name);
    const safeAssetMentions = assetMentions.filter((item) => item.id);
    uiTraceInteraction('chat', 'send_message', {
      sessionId: currentSessionId || null,
      chars: String(content || '').trim().length,
      hasAttachment: attachments.length > 0,
      attachmentCount: attachments.length,
      targetAdvisorId: memberMention?.id || null,
      knowledgeReferenceCount: safeKnowledgeMentions.length,
      skillReferenceCount: safeSkillMentions.length,
      assetReferenceCount: safeAssetMentions.length,
    });
    suppressComposerFocus('send_message', 5000);
    blurComposer('send_message');
    shouldAutoScrollRef.current = true;
    setErrorNotice(null);
    const normalizedContent = String(content || '').trim();
    const knowledgeLabels = safeKnowledgeMentions.map((item) => `#${item.title || '知识库内容'}`);
    const inlineLabels = [
      ...safeSkillMentions.map((item) => `@${item.name}`),
      ...safeAssetMentions.map((item) => `@${item.name}`),
    ];
    const missingInlineLabels = inlineLabels.filter((label) => !normalizedContent.includes(label));
    const normalizedDisplayOverride = String(displayOverride || '').trim();
    const hasAttachments = attachments.length > 0;
    const attachmentOnlyTitle = hasAttachments
      ? `附件：${attachments.map((item) => item.name).filter(Boolean).join('、') || '未命名附件'}`
      : '';
    const displayBody = normalizedDisplayOverride || normalizedContent || (safeKnowledgeMentions.length > 0 ? '请结合提到的知识库内容回答。' : '');
    const displayText = [...missingInlineLabels, ...knowledgeLabels, displayBody || attachmentOnlyTitle].filter(Boolean).join(' ').trim();
    if (!displayText && !hasAttachments) return;
    const attachmentBlockReason = attachmentsSendBlockReason(attachments);
    if (attachmentBlockReason) {
      setErrorNotice(attachmentBlockReason);
      return;
    }
    const runtimeMessage = normalizedContent || displayBody || displayText || (hasAttachments ? '请分析这些附件。' : '');
    const processingStartedAt = Date.now();
    const memberActor: ChatMessageMemberActor | undefined = memberMention ? {
      type: 'member',
      memberId: memberMention.id,
      displayName: memberMention.name,
      avatar: memberMention.avatar,
    } : undefined;
    const assetReferencesForMessage: ChatMessageAssetReference[] = safeAssetMentions.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      primaryPreviewUrl: item.primaryPreviewUrl,
      tags: item.tags,
    }));
    const skillReferencesForMessage: ChatMessageSkillReference[] = safeSkillMentions.map((item) => ({
      name: item.name,
      description: item.description,
    }));
    const userMsg: Message = {
      id: processingStartedAt.toString(),
      role: 'user',
      content: runtimeMessage,
      displayContent: displayText,
      attachment: primaryAttachment as unknown as Message['attachment'],
      attachments,
      knowledgeReferences: safeKnowledgeMentions,
      assetReferences: assetReferencesForMessage,
      skillReferences: skillReferencesForMessage,
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
    setSelectedKnowledgeMentions([]);
    setSelectedSkillMentions([]);
    setSelectedAssetMentions([]);
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

    dispatchChatSend({
      sessionId: currentSessionId || undefined,
      message: runtimeMessage,
      displayContent: displayText,
      attachment: stripTransientAttachmentPreview(resolvedAttachment),
      attachments: committedAttachments.map((item) => stripTransientAttachmentPreview(item) as UploadedFileAttachment),
      knowledgeReferences: safeKnowledgeMentions,
      assetReferences: assetReferencesForMessage,
      memberMention: memberMention ? {
        type: 'advisor',
        advisorId: memberMention.id,
        name: memberMention.name,
        avatar: memberMention.avatar,
      } : undefined,
      modelConfig: resolvedModelConfig || getChatModelConfig(),
      taskHints: safeSkillMentions.length > 0 ? {
        activeSkills: safeSkillMentions.map((item) => item.name),
      } : undefined,
    });
  };

  const reusableVideoAttachment = useMemo(
    () => pendingAttachments.length > 0 ? null : latestReusableVideoAttachment(messages),
    [messages, pendingAttachments.length],
  );
  const shortcutAttachment = pendingAttachment || reusableVideoAttachment || null;
  const shortcutAttachments = pendingAttachments.length > 0
    ? pendingAttachments
    : shortcutAttachment
      ? [shortcutAttachment]
      : [];
  const shortcutContext: ChatShortcutContext = {
    input,
    hasInput: Boolean(input.trim()),
    attachment: shortcutAttachment,
    attachments: shortcutAttachments,
    selectedMemberMention: selectedMemberMention || fixedMemberMention,
    selectedKnowledgeMentions,
  };
  const fallbackShortcuts = (
    reusableVideoAttachment
      ? attachmentActionsFor('video').map((shortcut) => ({
        ...shortcut,
        attachment: reusableVideoAttachment,
      }))
      : [
        { label: '📝 总结内容', text: '请总结以上内容，提炼核心要点。' },
        { label: '💡 提炼观点', text: '请提炼其中的关键观点和洞察。' },
        { label: '✂️ 润色优化', text: '请润色这段内容，使其更具吸引力。' },
        { label: '❓ 延伸提问', text: '基于以上内容，提出3个值得思考的延伸问题。' },
      ]
  );
  const shortcuts = resolveChatShortcutProvider(shortcutsProp, fallbackShortcuts, shortcutContext);

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
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.syncHeight();
      });
      return;
    }
    const shortcutAttachmentsForSend = shortcut.attachments && shortcut.attachments.length > 0
      ? shortcut.attachments
      : shortcut.attachment
        ? [shortcut.attachment]
        : pendingAttachments;
    void sendMessage(
      shortcut.text,
      shortcutAttachmentsForSend,
      selectedMemberMention || fixedMemberMention,
      selectedKnowledgeMentions,
      selectedSkillMentions,
      selectedAssetMentions,
      shortcut.displayContent || shortcut.label,
    );
  }, [fixedMemberMention, pendingAttachments, selectedAssetMentions, selectedKnowledgeMentions, selectedMemberMention, selectedSkillMentions, sendMessage]);

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
  const showChatDropOverlay = Boolean(showComposer && allowFileUpload && isFileDragActive && !isProcessing);
  const attachmentActionKind = inferAttachmentActionKind(pendingAttachment);
  const currentAttachmentActionKey = attachmentActionKey(pendingAttachments);
  const attachmentActionOverlayVisible = Boolean(
    showComposer
    && allowFileUpload
    && pendingAttachment
    && isEmptySession
    && !isProcessing
    && !isAttachmentUploading
    && !input.trim()
    && currentAttachmentActionKey
    && dismissedAttachmentActionKey !== currentAttachmentActionKey
  );
  const attachmentActionOverlayActions = attachmentActionsFor(attachmentActionKind);
  const dismissAttachmentActionOverlay = useCallback(() => {
    if (currentAttachmentActionKey) {
      setDismissedAttachmentActionKey(currentAttachmentActionKey);
    }
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.syncHeight();
    });
  }, [currentAttachmentActionKey]);
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
  }, [currentAttachmentActionKey, fixedMemberMention, pendingAttachments, selectedAssetMentions, selectedKnowledgeMentions, selectedMemberMention, selectedSkillMentions, sendMessage]);
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
  const shouldCollapseEmptyFixedSession = Boolean(
    collapseEmptyFixedSession &&
    fixedSessionId &&
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
  const fixedMemberAvatar = String(fixedMemberMention?.avatar || '').trim();
  const fixedMemberAvatarRenderable = /^(https?:|file:|data:|local-file:|redbox-asset:)/i.test(fixedMemberAvatar) || fixedMemberAvatar.startsWith('/');
  const fixedMemberMentionChip = fixedMemberMention ? (
    <div className="mb-2 flex justify-start">
      <div className={clsx(
        'inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[12px] font-medium shadow-sm',
        darkEmbedded
          ? 'border-white/10 bg-white/[0.04] text-white/72'
          : 'border-border bg-surface-primary/86 text-text-secondary'
      )}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-surface-secondary text-[11px] font-semibold">
          {fixedMemberAvatarRenderable ? (
            <img src={resolveAssetUrl(fixedMemberAvatar)} alt="" className="h-full w-full object-cover" />
          ) : (
            (fixedMemberAvatar || fixedMemberMention.name || '成').slice(0, 2)
          )}
        </span>
        <span className="truncate">当前成员：{fixedMemberMention.name}</span>
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
      {fixedMemberMentionChip}
      <ChatComposer
        ref={composerRef}
        theme={composerTheme}
        variant={variant}
        className={options?.className}
        value={input}
        onValueChange={setInput}
        onSubmit={() => sendMessage(
          input,
          pendingAttachments,
          selectedMemberMention || fixedMemberMention,
          selectedKnowledgeMentions,
          selectedSkillMentions,
          selectedAssetMentions,
        )}
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
        memberMentionOptions={fixedMemberMention ? [] : memberMentionOptions}
        selectedMemberMention={fixedMemberMention ? null : selectedMemberMention}
        onSelectedMemberMentionChange={fixedMemberMention ? undefined : setSelectedMemberMention}
        knowledgeMentionOptions={knowledgeMentionOptions}
        selectedKnowledgeMentions={selectedKnowledgeMentions}
        onSelectedKnowledgeMentionsChange={setSelectedKnowledgeMentions}
        skillMentionOptions={skillMentionOptions}
        selectedSkillMentions={selectedSkillMentions}
        onSelectedSkillMentionsChange={setSelectedSkillMentions}
        assetMentionOptions={assetMentionOptions}
        selectedAssetMentions={selectedAssetMentions}
        onSelectedAssetMentionsChange={setSelectedAssetMentions}
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
      {welcomeIconAccessory ? (
        <div className="flex justify-center">
          {welcomeIconAccessory}
        </div>
      ) : null}

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
      sendMessage(
        action.text,
        undefined,
        selectedMemberMention || fixedMemberMention,
        selectedKnowledgeMentions,
        selectedSkillMentions,
        selectedAssetMentions,
      );
    }
  }, [fixedMemberMention, selectedAssetMentions, selectedKnowledgeMentions, selectedMemberMention, selectedSkillMentions, sendMessage]);

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
    <div
      className={clsx('flex h-full min-w-0', wideContent && 'chat-layout-wide', narrowContent && 'chat-layout-narrow')}
      onDragEnter={dragHandlers.onDragEnter}
      onDragLeave={dragHandlers.onDragLeave}
      onDragOver={dragHandlers.onDragOver}
      onDrop={dragHandlers.onDrop}
    >
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
        {showChatDropOverlay && (
          <ChatDropOverlay darkEmbedded={darkEmbedded} />
        )}

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

        {attachmentActionOverlayVisible && pendingAttachment && (
          <ChatAttachmentActionOverlay
            attachment={pendingAttachment}
            attachmentCount={Math.max(1, pendingAttachments.length)}
            actions={attachmentActionOverlayActions}
            darkEmbedded={darkEmbedded}
            kind={attachmentActionKind}
            disabled={isProcessing}
            onAction={applyAttachmentAction}
            onDismiss={dismissAttachmentActionOverlay}
          />
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

            {/* Input Area - Bottom Fixed */}
            {showComposer ? (
            <div className={clsx('shrink-0', inputAreaShellClass, contentOuterPaddingClass)}>
              <div className={clsx('mx-auto space-y-3.5', contentMaxWidthClass, contentWidthClass)}>
                {dockedEmptyState ? (
                  emptyComposerForm
                ) : (
                  <>
                {errorNotice && (() => {
                  const structuredNotice = typeof errorNotice === 'string' ? null : errorNotice;
                  const noticeTitle = structuredNotice?.title || '请求失败';
                  const noticeBody = structuredNotice
                    ? structuredNotice.hint || structuredNotice.metaParts?.join(' · ') || ''
                    : errorNotice;
                  const reportContent = structuredNotice
                    ? [structuredNotice.hint, structuredNotice.detail, structuredNotice.metaParts?.join(' · ')]
                      .filter(Boolean)
                      .join('\n\n') || noticeTitle
                    : errorNotice;
                  return (
                    <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-3 text-sm text-red-700 shadow-sm dark:text-red-300">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium">{noticeTitle}</div>
                          {noticeBody && (
                            <div className="mt-1 text-xs leading-5 text-red-700/85 dark:text-red-300/90">
                              {noticeBody}
                            </div>
                          )}
                          {structuredNotice?.detail && (
                            <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-[11px] leading-5 text-red-800/85 dark:text-red-200/90">
                              {structuredNotice.detail}
                            </pre>
                          )}
                        </div>
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
                          className="inline-flex h-7 shrink-0 items-center rounded-md border border-red-500/25 bg-red-500/10 px-2 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/15 dark:text-red-200"
                        >
                          反馈
                        </button>
                      </div>
                    </div>
                  );
                })()}
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
  );
}
