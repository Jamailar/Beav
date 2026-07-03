import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  Check,
  File as FileIcon,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  Mic,
  Music2,
  Package,
  Plus,
  Sparkles,
  Square,
  StopCircle,
  X,
  UserRound,
} from 'lucide-react';
import { clsx } from 'clsx';
import { enforceModelCapabilityPolicy, getForcedModelCapabilities, inferModelCapabilities, normalizeModelCapabilities, type ModelCapability } from '../../shared/modelCapabilities';
import { resolveAssetUrl } from '../utils/pathManager';
import { ChatComposerFrame, getChatComposerPalette, type ChatComposerTheme, type ChatComposerVariant } from './ChatComposerFrame';

export interface UploadedFileAttachment {
  attachmentId?: string;
  type: 'uploaded-file';
  name: string;
  ext?: string;
  size?: number;
  thumbnailDataUrl?: string;
  thumbnailUrl?: string;
  inlineDataUrl?: string;
  workspaceRelativePath?: string;
  toolPath?: string;
  absolutePath?: string;
  originalAbsolutePath?: string;
  localUrl?: string;
  kind?: 'text' | 'image' | 'audio' | 'video' | 'document' | 'binary' | string;
  mimeType?: string;
  storageMode?: 'staged' | string;
  directUploadEligible?: boolean;
  processingStrategy?: string;
  deliveryMode?: 'direct-input' | 'tool-read';
  intakeStatus?: 'ready' | 'unsupported' | 'failed' | string;
  attachmentLifecycle?: 'pending' | 'committed' | 'orphaned' | 'deleted' | string;
  capabilities?: {
    directInput?: boolean;
    workspaceRead?: boolean;
    textExtract?: boolean;
    documentExtract?: boolean;
    imageVision?: boolean;
    audioTranscribe?: boolean;
    videoAnalyze?: boolean;
    videoEdit?: boolean;
  };
  deliveryPlan?: {
    mode?: 'direct-input' | 'workspace-tool' | 'media-tool' | 'document-tool' | 'unsupported' | string;
    toolPath?: string;
    toolName?: string;
    requiresTool?: boolean;
    reason?: string;
  };
  summary?: string;
  requiresMultimodal?: boolean;
}

export interface ChatModelOption {
  key: string;
  modelName: string;
  sourceName: string;
  baseURL: string;
  apiKey: string;
  isDefault?: boolean;
}

export interface ChatSettingsSnapshot {
  api_endpoint?: string;
  api_key?: string;
  model_name?: string;
  ai_sources_json?: string;
  default_ai_source_id?: string;
}

export interface ChatComposerHandle {
  focus: () => void;
  blur: () => void;
  syncHeight: () => void;
  resetHeight: () => void;
  getTextarea: () => HTMLTextAreaElement | null;
}

export interface ChatMemberMentionOption {
  id: string;
  name: string;
  avatar?: string;
  personality?: string;
}

export interface ChatKnowledgeMentionOption {
  id: string;
  title: string;
  sourceKind?: string;
  summary?: string;
  cover?: string;
  sourceUrl?: string;
  folderPath?: string;
  rootPath?: string;
  tags?: string[];
  updatedAt?: string;
  fileCount?: number;
  hasTranscript?: boolean;
}

export interface ChatSkillMentionOption {
  name: string;
  description?: string;
  location?: string;
  sourceScope?: string;
  isBuiltin?: boolean;
  aliases?: string[];
}

export interface ChatAssetMentionOption {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  primaryPreviewUrl?: string;
  previewUrls?: string[];
  imagePaths?: string[];
  absoluteImagePaths?: string[];
  voicePath?: string;
  absoluteVoicePath?: string;
}

type ComposerAttachmentVisualKind = 'image' | 'video' | 'audio' | 'text' | 'file';
type ChatComposerAudioState = 'idle' | 'recording' | 'transcribing';
type ChatComposerAttachmentStatus = 'uploading' | 'uploaded';
const RECORDING_WAVE_BARS = [0.3, 0.58, 0.92, 0.42, 0.74, 0.98, 0.5, 0.8, 0.64, 0.9, 0.46, 0.7, 1, 0.62, 0.84, 0.54, 0.95, 0.4, 0.78, 0.34, 0.88, 0.56, 0.72, 0.44];

interface ComposerAttachmentPreviewProps {
  attachment: UploadedFileAttachment;
  darkEmbedded: boolean;
  variant: ChatComposerVariant;
  onRemove: () => void;
  status?: ChatComposerAttachmentStatus | null;
  disabled?: boolean;
  children: ReactNode;
}

export interface ChatComposerProps {
  theme?: ChatComposerTheme;
  variant?: ChatComposerVariant;
  className?: string;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  attachment?: UploadedFileAttachment | null;
  attachments?: UploadedFileAttachment[];
  attachmentStatus?: ChatComposerAttachmentStatus | null;
  attachmentPreviewMode?: 'default' | 'compact-status';
  onPickAttachment?: (() => void | Promise<void>) | null;
  onPasteImageFiles?: ((files: File[]) => void | Promise<void>) | null;
  onClearAttachment?: (() => void) | null;
  onRemoveAttachment?: ((attachment: UploadedFileAttachment) => void) | null;
  modelOptions?: ChatModelOption[];
  selectedModelKey?: string;
  onSelectedModelKeyChange?: (key: string) => void;
  memberMentionOptions?: ChatMemberMentionOption[];
  selectedMemberMention?: ChatMemberMentionOption | null;
  onSelectedMemberMentionChange?: (member: ChatMemberMentionOption | null) => void;
  knowledgeMentionOptions?: ChatKnowledgeMentionOption[];
  selectedKnowledgeMentions?: ChatKnowledgeMentionOption[];
  onSelectedKnowledgeMentionsChange?: (items: ChatKnowledgeMentionOption[]) => void;
  skillMentionOptions?: ChatSkillMentionOption[];
  selectedSkillMentions?: ChatSkillMentionOption[];
  onSelectedSkillMentionsChange?: (items: ChatSkillMentionOption[]) => void;
  assetMentionOptions?: ChatAssetMentionOption[];
  selectedAssetMentions?: ChatAssetMentionOption[];
  onSelectedAssetMentionsChange?: (items: ChatAssetMentionOption[]) => void;
  isBusy?: boolean;
  allowInputWhileBusy?: boolean;
  audioState?: ChatComposerAudioState;
  onAudioAction?: (() => void | Promise<void>) | null;
  onCancel?: (() => void | Promise<void>) | null;
  showCancelWhenBusy?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  trailingContent?: ReactNode;
  onFocus?: () => void;
  suppressed?: boolean;
  suppressedLabel?: string;
  onResumeFromSuppressed?: (() => void) | null;
  textareaMaxHeight?: number;
}

const IMAGE_ATTACHMENT_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i;
const VIDEO_ATTACHMENT_EXT_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(?:[?#].*)?$/i;
const AUDIO_ATTACHMENT_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)(?:[?#].*)?$/i;
const TEXT_ATTACHMENT_EXT_RE = /\.(txt|md|markdown|json|csv|tsv|doc|docx|pdf|rtf|xml|yaml|yml|ts|tsx|js|jsx|py|rs|java|go|c|cpp|h|hpp)(?:[?#].*)?$/i;
const DOCUMENT_ATTACHMENT_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|rtf)(?:[?#].*)?$/i;

function modelSupportsChat(model: string | { id?: unknown; capability?: unknown; capabilities?: unknown }): boolean {
  if (typeof model === 'string') {
    const forced = getForcedModelCapabilities(model);
    const resolved = enforceModelCapabilityPolicy(model, forced.length ? forced : inferModelCapabilities(model));
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
  const resolved = enforceModelCapabilityPolicy(id, forced.length ? forced : (capabilities.length ? capabilities : inferModelCapabilities(id)));
  return resolved.includes('chat');
}

function getAttachmentSource(attachment: UploadedFileAttachment): string {
  const preferred = String(
    attachment.thumbnailDataUrl
      || attachment.thumbnailUrl
      || attachment.inlineDataUrl
      || attachment.localUrl
      || attachment.absolutePath
      || attachment.originalAbsolutePath
      || '',
  ).trim();
  if (!preferred) return '';
  if (preferred.startsWith('data:')) {
    return preferred;
  }
  return resolveAssetUrl(preferred);
}

function getAttachmentExtLabel(attachment: UploadedFileAttachment): string {
  const explicit = String(attachment.ext || '').trim().replace(/^\./, '');
  if (explicit) return explicit.toUpperCase();
  const matched = String(attachment.name || '').trim().match(/\.([a-zA-Z0-9]+)$/);
  return matched?.[1]?.toUpperCase() || '';
}

function getAttachmentVisualKind(attachment: UploadedFileAttachment): ComposerAttachmentVisualKind {
  const kind = String(attachment.kind || '').trim().toLowerCase();
  const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
  const source = String(
    attachment.inlineDataUrl
      || attachment.localUrl
      || attachment.absolutePath
      || attachment.originalAbsolutePath
      || attachment.name
      || '',
  ).trim().toLowerCase();

  if (kind === 'image' || mimeType.startsWith('image/') || IMAGE_ATTACHMENT_EXT_RE.test(source)) return 'image';
  if (kind === 'video' || mimeType.startsWith('video/') || VIDEO_ATTACHMENT_EXT_RE.test(source)) return 'video';
  if (kind === 'audio' || mimeType.startsWith('audio/') || AUDIO_ATTACHMENT_EXT_RE.test(source)) return 'audio';
  if (kind === 'document' || DOCUMENT_ATTACHMENT_EXT_RE.test(source)) return 'text';
  if (kind === 'text' || mimeType.startsWith('text/') || TEXT_ATTACHMENT_EXT_RE.test(source)) return 'text';
  return 'file';
}

function getClipboardImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const bySignature = new Map<string, File>();
  const addFile = (file: File | null | undefined) => {
    if (!file || !file.type.toLowerCase().startsWith('image/')) return;
    const key = `${file.name || 'clipboard-image'}:${file.type}:${file.size}:${file.lastModified}`;
    bySignature.set(key, file);
  };

  Array.from(dataTransfer.items || []).forEach((item) => {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) return;
    addFile(item.getAsFile());
  });
  Array.from(dataTransfer.files || []).forEach(addFile);
  return Array.from(bySignature.values());
}

function formatAttachmentSize(size?: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return '';
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.round(size)} B`;
}

function formatRecordingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getAttachmentKindLabel(kind: ComposerAttachmentVisualKind): string {
  switch (kind) {
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'audio':
      return '音频';
    case 'text':
      return '文档';
    default:
      return '文件';
  }
}

function getAttachmentKindIcon(kind: ComposerAttachmentVisualKind, className: string) {
  switch (kind) {
    case 'image':
      return <ImageIcon className={className} />;
    case 'video':
      return <Film className={className} />;
    case 'audio':
      return <Music2 className={className} />;
    case 'text':
      return <FileText className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

function getActiveMemberMentionTrigger(value: string, caretIndex: number): { start: number; end: number; query: string } | null {
  const safeCaretIndex = Math.max(0, Math.min(value.length, caretIndex));
  const beforeCaret = value.slice(0, safeCaretIndex);
  const match = beforeCaret.match(/(^|\s)@([^\s@#]{0,32})$/);
  if (!match || match.index == null) return null;
  const boundary = match[1] || '';
  const triggerStart = match.index + boundary.length;
  return {
    start: triggerStart,
    end: safeCaretIndex,
    query: match[2] || '',
  };
}

function getActiveKnowledgeMentionTrigger(value: string, caretIndex: number): { start: number; end: number; query: string } | null {
  const safeCaretIndex = Math.max(0, Math.min(value.length, caretIndex));
  const beforeCaret = value.slice(0, safeCaretIndex);
  const match = beforeCaret.match(/(^|\s)#([^\s@#]{0,48})$/);
  if (!match || match.index == null) return null;
  const boundary = match[1] || '';
  const triggerStart = match.index + boundary.length;
  return {
    start: triggerStart,
    end: safeCaretIndex,
    query: match[2] || '',
  };
}

function memberMentionMatches(member: ChatMemberMentionOption, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    member.name,
    member.id,
    member.personality,
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function skillMentionMatches(skill: ChatSkillMentionOption, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    skill.name,
    skill.description,
    skill.location,
    skill.sourceScope,
    ...(skill.aliases || []),
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function assetMentionMatches(asset: ChatAssetMentionOption, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    asset.name,
    asset.description,
    asset.categoryId,
    ...(asset.tags || []),
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function knowledgeMentionMatches(item: ChatKnowledgeMentionOption, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    item.title,
    item.summary,
    item.sourceKind,
    item.sourceUrl,
    item.folderPath,
    item.rootPath,
    ...(item.tags || []),
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function getKnowledgeKindLabel(item: ChatKnowledgeMentionOption): string {
  const sourceKind = String(item.sourceKind || '').trim();
  if (sourceKind === 'youtube-video' || sourceKind === 'youtube' || sourceKind === 'video') return '视频';
  if (sourceKind === 'document-source' || sourceKind === 'document') return '文档';
  if (sourceKind === 'redbook-note' || sourceKind === 'note') return '笔记';
  return sourceKind || '知识';
}

function renderKnowledgeMentionIcon(item: ChatKnowledgeMentionOption, className: string) {
  const sourceKind = String(item.sourceKind || '').trim();
  if (sourceKind === 'youtube-video' || sourceKind === 'youtube' || sourceKind === 'video') {
    return <Film className={className} />;
  }
  if (sourceKind === 'document-source' || sourceKind === 'document') {
    return <FileText className={className} />;
  }
  return <BookOpen className={className} />;
}

function renderMemberMentionAvatar(member: ChatMemberMentionOption, darkEmbedded: boolean) {
  const avatar = String(member.avatar || '').trim();
  const avatarClass = clsx(
    'flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[13px] font-semibold',
    darkEmbedded ? 'bg-white/10 text-white/80' : 'bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))]',
  );
  if (avatar && /^(https?:|file:|data:|local-file:|redbox-asset:|asset:)/i.test(avatar)) {
    return <img src={resolveAssetUrl(avatar)} alt="" className={clsx(avatarClass, 'object-cover')} />;
  }
  return (
    <span className={avatarClass}>
      {avatar || member.name.trim().slice(0, 1).toUpperCase() || <UserRound className="h-3.5 w-3.5" />}
    </span>
  );
}

function ComposerRecordingStatus({
  darkEmbedded,
  elapsedMs,
}: {
  darkEmbedded: boolean;
  elapsedMs: number;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-1" aria-live="polite">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={clsx('h-2 w-2 rounded-full', darkEmbedded ? 'bg-red-400/90' : 'bg-[#dd6b5b]', 'animate-pulse')} />
      </div>
      <div className="flex min-w-0 flex-1 items-center">
        <div className="relative z-[1] flex h-5 min-w-0 flex-1 items-center justify-center gap-[3px] px-1">
          {RECORDING_WAVE_BARS.map((height, index) => (
            <span
              key={`${index}-${height}`}
              className={clsx(
                'recording-wave-bar w-[2px] shrink-0 rounded-full',
                darkEmbedded ? 'bg-white/68' : 'bg-[#697885]',
              )}
              style={{
                height: `${5 + Math.round(height * 9)}px`,
                animationDelay: `${index * 70}ms`,
              }}
            />
          ))}
        </div>
      </div>
      <div className={clsx('shrink-0 text-[11px] font-medium tabular-nums', darkEmbedded ? 'text-white/58' : 'text-[#8a94a0]')}>
        {formatRecordingDuration(elapsedMs)}
      </div>
    </div>
  );
}

function isImeComposingEvent(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  const synthetic = event as React.KeyboardEvent<HTMLTextAreaElement> & { isComposing?: boolean };
  const native = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return Boolean(native?.isComposing) || Boolean(synthetic.isComposing) || native?.keyCode === 229;
}

function decodeBase64DataUrl(dataUrl: string): string {
  const raw = String(dataUrl || '');
  const parts = raw.split(',');
  return parts.length > 1 ? parts[1] : raw;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(decodeBase64DataUrl(String(reader.result || '')));
    reader.onerror = () => reject(reader.error || new Error('音频读取失败'));
    reader.readAsDataURL(blob);
  });
}

export function buildChatModelOptions(settings?: ChatSettingsSnapshot | null): ChatModelOption[] {
  if (!settings) return [];

  const options: ChatModelOption[] = [];
  const defaultSourceId = String(settings.default_ai_source_id || '').trim();
  const prefersOfficialDefault = defaultSourceId.toLowerCase() === 'redbox_official_auto';
  let hasExplicitDefaultSource = false;

  try {
    const parsed = JSON.parse(String(settings.ai_sources_json || '[]')) as Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const sourceId = String(item.id || '').trim();
        if (sourceId && sourceId === defaultSourceId) {
          hasExplicitDefaultSource = true;
        }
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
  if (
    !prefersOfficialDefault
    && !hasExplicitDefaultSource
    && fallbackModel
    && modelSupportsChat(fallbackModel)
  ) {
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
    deduped.set(option.key, option);
  }

  return Array.from(deduped.values());
}

function ComposerAttachmentPreview({
  attachment,
  darkEmbedded,
  variant,
  onRemove,
  status = 'uploaded',
  disabled = false,
  children,
}: ComposerAttachmentPreviewProps) {
  const visualKind = getAttachmentVisualKind(attachment);
  const isImageAttachment = visualKind === 'image';
  const previewSrc = visualKind === 'image' ? getAttachmentSource(attachment) : '';
  const extLabel = getAttachmentExtLabel(attachment);
  const sizeLabel = formatAttachmentSize(attachment.size);
  const typeLabel = getAttachmentKindLabel(visualKind);
  const frameClass = isImageAttachment
    ? variant === 'empty' ? 'h-[88px] w-[88px]' : 'h-[72px] w-[72px]'
    : variant === 'empty' ? 'h-[92px] w-[70px]' : 'h-[78px] w-[58px]';
  const frameRadiusClass = isImageAttachment
    ? variant === 'empty' ? 'rounded-[18px]' : 'rounded-[16px]'
    : 'rounded-[22px]';
  const metaClass = darkEmbedded ? 'text-white/34' : 'text-text-tertiary/70';
  const titleClass = darkEmbedded ? 'text-white/88' : 'text-text-primary';
  const badgeClass = darkEmbedded
    ? 'border-white/10 bg-white/[0.05] text-white/58'
    : 'border-black/[0.06] bg-[#f7f2e7] text-[#7f715f]';
  const previewShellClass = darkEmbedded
    ? 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] shadow-[0_12px_34px_rgba(0,0,0,0.35)]'
    : 'border-black/[0.07] bg-[linear-gradient(180deg,#fbf6ec,#f2eadb)] shadow-[0_12px_28px_rgba(110,84,44,0.12)]';
  const removeButtonClass = darkEmbedded
    ? 'border-white/12 bg-[#1b2026] text-white/62 hover:text-white hover:bg-[#222831]'
    : 'border-white bg-white text-[#786d5f] hover:text-[#2d2822] hover:bg-[#f8f4ea]';
  const infoTokens = [typeLabel, extLabel, sizeLabel].filter(Boolean);
  const uploading = status === 'uploading';

  return (
    <div className="flex items-start gap-3">
      <div className="relative shrink-0">
        {previewSrc ? (
          <div className={clsx(
            'overflow-hidden border',
            frameClass,
            frameRadiusClass,
            isImageAttachment ? 'rotate-0' : (variant === 'empty' ? '-rotate-[4deg]' : '-rotate-[3deg]'),
            previewShellClass,
          )}>
            <img src={previewSrc} alt={attachment.name} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className={clsx(
            'flex items-center justify-center border',
            frameClass,
            frameRadiusClass,
            previewShellClass,
          )}>
            <div className="flex flex-col items-center gap-1.5 px-2 text-center">
              {getAttachmentKindIcon(visualKind, clsx(
                variant === 'empty' ? 'h-5 w-5' : 'h-[18px] w-[18px]',
                darkEmbedded ? 'text-white/68' : 'text-[#7f715f]',
              ))}
              <span className={clsx(
                'max-w-full truncate text-[10px] font-semibold tracking-[0.18em]',
                darkEmbedded ? 'text-white/42' : 'text-[#9d8f7b]',
              )}>
                {extLabel || typeLabel}
              </span>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className={clsx(
            'absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border transition-colors',
            removeButtonClass,
            disabled && 'cursor-not-allowed opacity-55',
          )}
          title={uploading ? '上传中' : '移除文件'}
          aria-label={`移除 ${attachment.name}`}
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <div className={clsx('inline-flex shrink-0 items-center gap-1 text-[9px] font-medium tracking-[0.12em]', metaClass)}>
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            <span>{uploading ? '上传中' : '已添加文件'}</span>
          </div>
          <div className={clsx(
            'min-w-0 truncate font-medium opacity-78',
            variant === 'empty' ? 'text-[11px]' : 'text-[10px]',
            titleClass,
          )} title={attachment.name}>
            {attachment.name}
          </div>
        </div>
        <div className={clsx(
          'mt-2',
          children ? '' : 'mb-0.5',
        )}>
          {infoTokens.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {infoTokens.map((token) => (
                <span
                  key={token}
                  className={clsx('rounded-full border px-2 py-0.5 text-[10px] font-medium', badgeClass)}
                >
                  {token}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function ComposerCompactAttachmentPreview({
  attachment,
  darkEmbedded,
  onRemove,
  status = 'uploaded',
  disabled = false,
}: {
  attachment: UploadedFileAttachment;
  darkEmbedded: boolean;
  onRemove: () => void;
  status?: ChatComposerAttachmentStatus | null;
  disabled?: boolean;
}) {
  const visualKind = getAttachmentVisualKind(attachment);
  const extLabel = getAttachmentExtLabel(attachment);
  const sizeLabel = formatAttachmentSize(attachment.size);
  const typeLabel = getAttachmentKindLabel(visualKind);
  const infoTokens = [typeLabel, extLabel, sizeLabel].filter(Boolean);
  const uploading = status === 'uploading';
  return (
    <div className={clsx(
      'mb-2 flex min-h-[38px] items-center gap-2 rounded-2xl border px-2.5 py-2',
      darkEmbedded
        ? 'border-white/10 bg-white/[0.055] text-white'
        : 'border-black/[0.06] bg-[#fbf7ee] text-text-primary',
    )}>
      <div className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
        darkEmbedded ? 'bg-white/10 text-white/70' : 'bg-white text-accent-primary shadow-sm',
      )}>
        {getAttachmentKindIcon(visualKind, 'h-4 w-4')}
      </div>
      <div className="min-w-0 flex-1">
        <div className={clsx('truncate text-[12px] font-semibold', darkEmbedded ? 'text-white/86' : 'text-text-primary')} title={attachment.name}>
          {attachment.name}
        </div>
        <div className={clsx('mt-0.5 flex items-center gap-1 truncate text-[10px] font-medium', darkEmbedded ? 'text-white/38' : 'text-text-tertiary')}>
          {uploading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : null}
          <span className="truncate">{[uploading ? '上传中' : '已添加', ...infoTokens].join(' · ')}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className={clsx(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
          darkEmbedded ? 'text-white/52 hover:bg-white/10 hover:text-white' : 'text-text-tertiary hover:bg-surface-secondary hover:text-text-primary',
          disabled && 'cursor-not-allowed opacity-55',
        )}
        title={uploading ? '上传中' : '移除文件'}
        aria-label={`移除 ${attachment.name}`}
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function ComposerAttachmentUploadingStatus({ darkEmbedded }: { darkEmbedded: boolean }) {
  return (
    <div className={clsx(
      'mb-2 flex min-h-[38px] items-center gap-2 rounded-2xl border px-2.5 py-2 text-[12px] font-medium',
      darkEmbedded
        ? 'border-white/10 bg-white/[0.055] text-white/72'
        : 'border-black/[0.06] bg-[#fbf7ee] text-text-secondary',
    )}>
      <span className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
        darkEmbedded ? 'bg-white/10 text-white/70' : 'bg-white text-accent-primary shadow-sm',
      )}>
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
      <span className="min-w-0 flex-1 truncate">正在添加附件</span>
    </div>
  );
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({
  theme = 'default',
  variant = 'main',
  className,
  value,
  onValueChange,
  onSubmit,
  placeholder,
  attachment,
  attachments,
  attachmentStatus = null,
  attachmentPreviewMode = 'default',
  onPickAttachment,
  onPasteImageFiles,
  onClearAttachment,
  onRemoveAttachment,
  modelOptions = [],
  selectedModelKey = '',
  onSelectedModelKeyChange,
  memberMentionOptions = [],
  selectedMemberMention = null,
  onSelectedMemberMentionChange,
  knowledgeMentionOptions = [],
  selectedKnowledgeMentions = [],
  onSelectedKnowledgeMentionsChange,
  skillMentionOptions = [],
  selectedSkillMentions = [],
  onSelectedSkillMentionsChange,
  assetMentionOptions = [],
  selectedAssetMentions = [],
  onSelectedAssetMentionsChange,
  isBusy = false,
  allowInputWhileBusy = false,
  audioState = 'idle',
  onAudioAction,
  onCancel,
  showCancelWhenBusy = Boolean(onCancel),
  disabled = false,
  readOnly = false,
  trailingContent,
  onFocus,
  suppressed = false,
  suppressedLabel = '对话已完成，点击后继续输入...',
  onResumeFromSuppressed,
  textareaMaxHeight = 300,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const memberPickerRef = useRef<HTMLDivElement>(null);
  const knowledgePickerRef = useRef<HTMLDivElement>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [memberMentionTrigger, setMemberMentionTrigger] = useState<{ start: number; end: number; query: string } | null>(null);
  const [memberMentionActiveIndex, setMemberMentionActiveIndex] = useState(0);
  const [knowledgeMentionTrigger, setKnowledgeMentionTrigger] = useState<{ start: number; end: number; query: string } | null>(null);
  const [knowledgeMentionActiveIndex, setKnowledgeMentionActiveIndex] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const darkEmbedded = theme === 'dark';
  const palette = getChatComposerPalette(theme);
  const selectedModel = useMemo(
    () => modelOptions.find((item) => item.key === selectedModelKey) || null,
    [modelOptions, selectedModelKey],
  );
  const hasKnowledgeMentions = selectedKnowledgeMentions.length > 0;
  const hasSkillMentions = selectedSkillMentions.length > 0;
  const hasAssetMentions = selectedAssetMentions.length > 0;
  const attachmentItems = attachments && attachments.length > 0 ? attachments : attachment ? [attachment] : [];
  const primaryAttachment = attachmentItems[0] || null;
  const attachmentBusy = attachmentStatus === 'uploading';
  const resolvedAttachmentStatus = attachmentStatus || (attachmentItems.length > 0 ? 'uploaded' : null);
  const inputLocked = disabled || readOnly || attachmentBusy || (isBusy && !allowInputWhileBusy);
  const submitDisabled = disabled || attachmentBusy || isBusy || (!value.trim() && attachmentItems.length === 0 && !hasKnowledgeMentions && !hasSkillMentions && !hasAssetMentions);
  const showAttachmentButton = Boolean(onPickAttachment);
  const showModelSelector = Boolean(onSelectedModelKeyChange);
  const showAudioButton = Boolean(onAudioAction);
  const showCancelButton = Boolean(onCancel) && showCancelWhenBusy && isBusy;
  const canOpenModelPicker = showModelSelector && modelOptions.length > 0;
  const memberMentionEnabled = Boolean(onSelectedMemberMentionChange);
  const skillMentionEnabled = Boolean(onSelectedSkillMentionsChange);
  const assetMentionEnabled = Boolean(onSelectedAssetMentionsChange);
  const selectedSkillNames = useMemo(() => new Set(selectedSkillMentions.map((item) => item.name)), [selectedSkillMentions]);
  const selectedAssetIds = useMemo(() => new Set(selectedAssetMentions.map((item) => item.id)), [selectedAssetMentions]);
  const filteredAssetMentionOptions = useMemo(() => (
    assetMentionOptions
      .filter((asset) => !selectedAssetIds.has(asset.id))
      .filter((asset) => assetMentionMatches(asset, memberMentionTrigger?.query || ''))
      .slice(0, 8)
  ), [assetMentionOptions, memberMentionTrigger?.query, selectedAssetIds]);
  const filteredMemberMentionOptions = useMemo(() => (
    memberMentionOptions
      .filter((member) => memberMentionMatches(member, memberMentionTrigger?.query || ''))
      .slice(0, 8)
  ), [memberMentionOptions, memberMentionTrigger?.query]);
  const filteredSkillMentionOptions = useMemo(() => (
    skillMentionOptions
      .filter((skill) => !selectedSkillNames.has(skill.name))
      .filter((skill) => skillMentionMatches(skill, memberMentionTrigger?.query || ''))
      .slice(0, 8)
  ), [memberMentionTrigger?.query, selectedSkillNames, skillMentionOptions]);
  const selectedKnowledgeIds = useMemo(() => new Set(selectedKnowledgeMentions.map((item) => item.id)), [selectedKnowledgeMentions]);
  const filteredKnowledgeMentionOptions = useMemo(() => (
    knowledgeMentionOptions
      .filter((item) => knowledgeMentionMatches(item, knowledgeMentionTrigger?.query || ''))
      .slice(0, 12)
  ), [knowledgeMentionOptions, knowledgeMentionTrigger?.query]);
  const showMemberMentionPicker = memberMentionEnabled && Boolean(memberMentionTrigger);
  const knowledgeMentionEnabled = Boolean(onSelectedKnowledgeMentionsChange);
  const showKnowledgeMentionPicker = knowledgeMentionEnabled && Boolean(knowledgeMentionTrigger);
  const modelPickerClass = darkEmbedded
    ? 'absolute left-0 bottom-full mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-white/10 bg-[#181b20] shadow-xl z-[130]'
    : 'absolute left-0 bottom-full mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-border bg-surface-primary shadow-xl z-[130]';
  const memberPickerClass = darkEmbedded
    ? 'absolute left-3 bottom-[calc(100%-0.5rem)] z-[140] w-72 max-h-80 overflow-auto rounded-xl border border-white/10 bg-[#181b20] py-2 shadow-xl'
    : 'absolute left-3 bottom-[calc(100%-0.5rem)] z-[140] w-72 max-h-80 overflow-auto rounded-xl border border-border bg-surface-primary py-2 shadow-xl';
  const knowledgePickerClass = darkEmbedded
    ? 'absolute left-0 right-0 bottom-full z-[145] mb-3 max-h-[360px] overflow-auto rounded-2xl border border-white/10 bg-[#181b20] p-3 shadow-2xl'
    : 'absolute left-0 right-0 bottom-full z-[145] mb-3 max-h-[360px] overflow-auto rounded-2xl border border-border bg-surface-primary p-3 shadow-2xl';
  const subtleButtonClass = palette.subtleButton;
  const sendButtonClass = submitDisabled ? palette.sendButtonIdle : palette.sendButtonActive;

  const syncHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, textareaMaxHeight)}px`;
  }, [textareaMaxHeight]);

  const resetHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
  }, []);

  useEffect(() => {
    syncHeight();
  }, [attachment, syncHeight, suppressed, value, variant]);

  useEffect(() => {
    if (!showModelPicker) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showModelPicker]);

  useEffect(() => {
    if (!showMemberMentionPicker) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !memberPickerRef.current?.contains(target)
        && !textareaRef.current?.contains(target)
      ) {
        setMemberMentionTrigger(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showMemberMentionPicker]);

  useEffect(() => {
    if (!showKnowledgeMentionPicker) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !knowledgePickerRef.current?.contains(target)
        && !textareaRef.current?.contains(target)
      ) {
        setKnowledgeMentionTrigger(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showKnowledgeMentionPicker]);

  useEffect(() => {
    setMemberMentionActiveIndex(0);
  }, [memberMentionTrigger?.query]);

  useEffect(() => {
    setKnowledgeMentionActiveIndex(0);
  }, [knowledgeMentionTrigger?.query]);

  useEffect(() => {
    if (audioState !== 'recording') {
      setRecordingElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setRecordingElapsedMs(0);
    const timer = window.setInterval(() => {
      setRecordingElapsedMs(Date.now() - startedAt);
    }, 120);
    return () => window.clearInterval(timer);
  }, [audioState]);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
    syncHeight,
    resetHeight,
    getTextarea: () => textareaRef.current,
  }), [resetHeight, syncHeight]);

  const handleFormSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) return;
    onSubmit();
  }, [onSubmit, submitDisabled]);

  const replaceMemberTriggerWithLabel = useCallback((label: string) => {
    const textarea = textareaRef.current;
    setMemberMentionTrigger(null);
    if (!textarea || !memberMentionTrigger) {
      textarea?.focus();
      return;
    }
    const mentionLabel = `@${label} `;
    const nextValue = `${value.slice(0, memberMentionTrigger.start)}${mentionLabel}${value.slice(memberMentionTrigger.end)}`;
    const nextCaret = memberMentionTrigger.start + mentionLabel.length;
    onValueChange(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
      syncHeight();
    });
  }, [memberMentionTrigger, onValueChange, syncHeight, value]);

  const selectMemberMention = useCallback((member: ChatMemberMentionOption) => {
    onSelectedMemberMentionChange?.(member);
    replaceMemberTriggerWithLabel(member.name);
  }, [onSelectedMemberMentionChange, replaceMemberTriggerWithLabel]);

  const selectSkillMention = useCallback((skill: ChatSkillMentionOption) => {
    if (!selectedSkillNames.has(skill.name)) {
      onSelectedSkillMentionsChange?.([...selectedSkillMentions, skill]);
    }
    replaceMemberTriggerWithLabel(skill.name);
  }, [onSelectedSkillMentionsChange, replaceMemberTriggerWithLabel, selectedSkillMentions, selectedSkillNames]);

  const selectAssetMention = useCallback((asset: ChatAssetMentionOption) => {
    if (!selectedAssetIds.has(asset.id)) {
      onSelectedAssetMentionsChange?.([...selectedAssetMentions, asset]);
    }
    replaceMemberTriggerWithLabel(asset.name);
  }, [onSelectedAssetMentionsChange, replaceMemberTriggerWithLabel, selectedAssetIds, selectedAssetMentions]);

  const removeKnowledgeTriggerText = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !knowledgeMentionTrigger) return;
    const nextValue = `${value.slice(0, knowledgeMentionTrigger.start)}${value.slice(knowledgeMentionTrigger.end)}`;
    const nextCaret = knowledgeMentionTrigger.start;
    onValueChange(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
      syncHeight();
    });
  }, [knowledgeMentionTrigger, onValueChange, syncHeight, value]);

  const toggleKnowledgeMention = useCallback((item: ChatKnowledgeMentionOption) => {
    const exists = selectedKnowledgeIds.has(item.id);
    const nextItems = exists
      ? selectedKnowledgeMentions.filter((current) => current.id !== item.id)
      : [...selectedKnowledgeMentions, item];
    onSelectedKnowledgeMentionsChange?.(nextItems);
    setKnowledgeMentionTrigger(null);
    removeKnowledgeTriggerText();
  }, [onSelectedKnowledgeMentionsChange, removeKnowledgeTriggerText, selectedKnowledgeIds, selectedKnowledgeMentions]);

  const removeKnowledgeMention = useCallback((itemId: string) => {
    onSelectedKnowledgeMentionsChange?.(
      selectedKnowledgeMentions.filter((item) => item.id !== itemId),
    );
  }, [onSelectedKnowledgeMentionsChange, selectedKnowledgeMentions]);

  const handleTextAreaChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    onValueChange(nextValue);
    const caretIndex = event.target.selectionStart ?? nextValue.length;
    const memberTrigger = (memberMentionEnabled || skillMentionEnabled || assetMentionEnabled) ? getActiveMemberMentionTrigger(nextValue, caretIndex) : null;
    const knowledgeTrigger = knowledgeMentionEnabled ? getActiveKnowledgeMentionTrigger(nextValue, caretIndex) : null;
    const nextTrigger = memberTrigger && knowledgeTrigger
      ? (memberTrigger.start >= knowledgeTrigger.start ? 'member' : 'knowledge')
      : memberTrigger
        ? 'member'
        : knowledgeTrigger
          ? 'knowledge'
          : null;
    if (nextTrigger === 'member') {
      setMemberMentionTrigger(memberTrigger);
      setKnowledgeMentionTrigger(null);
    } else if (nextTrigger === 'knowledge') {
      setKnowledgeMentionTrigger(knowledgeTrigger);
      setMemberMentionTrigger(null);
    } else {
      setMemberMentionTrigger(null);
      setKnowledgeMentionTrigger(null);
    }
    if (
      selectedMemberMention
      && !nextValue.includes(`@${selectedMemberMention.name}`)
    ) {
      onSelectedMemberMentionChange?.(null);
    }
  }, [assetMentionEnabled, knowledgeMentionEnabled, memberMentionEnabled, onSelectedMemberMentionChange, onValueChange, selectedMemberMention, skillMentionEnabled]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showKnowledgeMentionPicker) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = Math.max(1, filteredKnowledgeMentionOptions.length);
        setKnowledgeMentionActiveIndex((current) => (
          event.key === 'ArrowDown'
            ? (current + 1) % count
            : (current - 1 + count) % count
        ));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && filteredKnowledgeMentionOptions.length > 0) {
        event.preventDefault();
        toggleKnowledgeMention(filteredKnowledgeMentionOptions[Math.min(knowledgeMentionActiveIndex, filteredKnowledgeMentionOptions.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setKnowledgeMentionTrigger(null);
        return;
      }
    }
    if (showMemberMentionPicker) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = Math.max(1, filteredAssetMentionOptions.length + filteredMemberMentionOptions.length + filteredSkillMentionOptions.length);
        setMemberMentionActiveIndex((current) => (
          event.key === 'ArrowDown'
            ? (current + 1) % count
            : (current - 1 + count) % count
        ));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (memberMentionActiveIndex < filteredAssetMentionOptions.length) {
          selectAssetMention(filteredAssetMentionOptions[Math.min(memberMentionActiveIndex, filteredAssetMentionOptions.length - 1)]);
          return;
        }
        const memberIndex = memberMentionActiveIndex - filteredAssetMentionOptions.length;
        if (memberIndex < filteredMemberMentionOptions.length) {
          selectMemberMention(filteredMemberMentionOptions[Math.min(memberIndex, filteredMemberMentionOptions.length - 1)]);
          return;
        }
        const skillIndex = memberIndex - filteredMemberMentionOptions.length;
        if (skillIndex < filteredSkillMentionOptions.length) {
          selectSkillMention(filteredSkillMentionOptions[Math.min(skillIndex, filteredSkillMentionOptions.length - 1)]);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMemberMentionTrigger(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !isComposing && !isImeComposingEvent(event)) {
      event.preventDefault();
      if (!submitDisabled) {
        onSubmit();
      }
    }
  }, [filteredAssetMentionOptions, filteredKnowledgeMentionOptions, filteredMemberMentionOptions, filteredSkillMentionOptions, isComposing, knowledgeMentionActiveIndex, memberMentionActiveIndex, onSubmit, selectAssetMention, selectMemberMention, selectSkillMention, showKnowledgeMentionPicker, showMemberMentionPicker, submitDisabled, toggleKnowledgeMention]);

  const wrapperClass = variant === 'empty' ? 'px-4 pt-4' : 'px-3.5 pt-3';
  const compactAttachmentMode = attachmentPreviewMode === 'compact-status';
  const textareaClass = primaryAttachment
    ? variant === 'empty'
      ? compactAttachmentMode
        ? 'w-full bg-transparent px-2 py-1 text-[16px] focus:outline-none resize-none min-h-[72px] max-h-[160px] overflow-y-auto'
        : 'mt-3 w-full bg-transparent pr-1 pb-1 text-[16px] focus:outline-none resize-none min-h-[64px] max-h-[220px] overflow-y-auto'
      : compactAttachmentMode
        ? 'w-full bg-transparent px-2 py-1 text-[14px] focus:outline-none resize-none min-h-[56px] max-h-[140px] overflow-y-auto'
        : 'mt-2.5 w-full bg-transparent pr-1 pb-1 text-[14px] focus:outline-none resize-none min-h-[52px] max-h-[180px] overflow-y-auto'
    : variant === 'empty'
      ? 'w-full bg-transparent px-4 py-3 text-[16px] focus:outline-none resize-none min-h-[100px] overflow-y-auto'
      : 'w-full bg-transparent px-3.5 py-2.5 text-[14px] focus:outline-none resize-none min-h-[72px] max-h-[280px] overflow-y-auto';

  const textarea = suppressed ? (
    <button
      type="button"
      onClick={() => onResumeFromSuppressed?.()}
      className={clsx(
        'w-full rounded-2xl py-6 text-left',
        variant === 'empty' ? 'px-4 text-[16px]' : 'px-3.5 text-[14px]',
        darkEmbedded ? 'text-white/45' : 'text-text-tertiary',
      )}
    >
      {suppressedLabel}
    </button>
  ) : (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={handleTextAreaChange}
      onFocus={onFocus}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      onKeyDown={handleKeyDown}
      onPaste={(event) => {
        const imageFiles = getClipboardImageFiles(event.clipboardData);
        if (imageFiles.length > 0 && onPasteImageFiles && !inputLocked) {
          event.preventDefault();
          void onPasteImageFiles(imageFiles);
        }
      }}
      placeholder={placeholder}
      className={clsx(textareaClass, palette.text)}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      readOnly={inputLocked}
      aria-disabled={inputLocked}
      rows={1}
    />
  );

  const selectedMemberMentionChip = selectedMemberMention ? (
    <div className={clsx('flex px-3 pt-2', variant === 'empty' && 'px-4')}>
      <button
        type="button"
        onClick={() => onSelectedMemberMentionChange?.(null)}
        className={clsx(
          'inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[12px] font-medium shadow-sm transition-colors',
          darkEmbedded
            ? 'border-white/10 bg-white/[0.04] text-white/72 hover:bg-white/[0.07]'
            : 'border-border bg-surface-primary/86 text-text-secondary hover:bg-surface-secondary/70',
        )}
        title="取消成员"
      >
        {renderMemberMentionAvatar(selectedMemberMention, darkEmbedded)}
        <span className="truncate">发给 @{selectedMemberMention.name}</span>
        <X className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
    </div>
  ) : null;

  const selectedContextMentionChips = (selectedAssetMentions.length > 0 || selectedSkillMentions.length > 0) ? (
    <div className={clsx('flex flex-wrap items-center gap-2 px-3 pt-2', variant === 'empty' && 'px-4')}>
      {selectedAssetMentions.map((asset) => {
        const preview = String(asset.primaryPreviewUrl || asset.previewUrls?.[0] || asset.absoluteImagePaths?.[0] || asset.imagePaths?.[0] || '').trim();
        return (
          <button
            key={asset.id}
            type="button"
            onClick={() => onSelectedAssetMentionsChange?.(selectedAssetMentions.filter((item) => item.id !== asset.id))}
            className={clsx(
              'inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[12px] font-medium shadow-sm transition-colors',
              darkEmbedded ? 'border-white/10 bg-white/[0.04] text-white/72 hover:bg-white/[0.07]' : 'border-border bg-surface-primary/86 text-text-secondary hover:bg-surface-secondary/70',
            )}
            title="移除资产"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-surface-secondary">
              {preview ? (
                <img src={resolveAssetUrl(preview)} alt="" className="h-full w-full object-cover" />
              ) : (
                <Package className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="truncate">@{asset.name}</span>
            <X className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        );
      })}
      {selectedSkillMentions.map((skill) => (
        <button
          key={skill.name}
          type="button"
          onClick={() => onSelectedSkillMentionsChange?.(selectedSkillMentions.filter((item) => item.name !== skill.name))}
          className={clsx(
            'inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[12px] font-medium shadow-sm transition-colors',
            darkEmbedded ? 'border-white/10 bg-white/[0.04] text-white/72 hover:bg-white/[0.07]' : 'border-border bg-surface-primary/86 text-text-secondary hover:bg-surface-secondary/70',
          )}
          title="移除 Skill"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-primary" />
          <span className="truncate">@{skill.name}</span>
          <X className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      ))}
    </div>
  ) : null;

  return (
    <form onSubmit={handleFormSubmit} className={clsx('relative w-full', className)}>
      {showMemberMentionPicker ? (
        <div ref={memberPickerRef} className={memberPickerClass}>
          {filteredAssetMentionOptions.length > 0 ? (
            <div className={clsx('px-3 pb-2 text-[11px] font-medium', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
              资产
            </div>
          ) : null}
          {filteredAssetMentionOptions.length > 0 ? filteredAssetMentionOptions.map((asset, index) => {
            const active = index === memberMentionActiveIndex;
            const preview = String(asset.primaryPreviewUrl || asset.previewUrls?.[0] || asset.absoluteImagePaths?.[0] || asset.imagePaths?.[0] || '').trim();
            return (
              <button
                key={asset.id}
                type="button"
                data-mention-option-index={index}
                onMouseEnter={() => setMemberMentionActiveIndex(index)}
                onClick={() => selectAssetMention(asset)}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                  active
                    ? darkEmbedded ? 'bg-white/10' : 'bg-[rgb(var(--color-surface-secondary))]'
                    : darkEmbedded ? 'hover:bg-white/[0.06]' : 'hover:bg-[rgb(var(--color-surface-secondary))]',
                )}
              >
                <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg', darkEmbedded ? 'bg-white/[0.08] text-white/72' : 'bg-[#edf6fb] text-[#4d8fb6]')}>
                  {preview ? (
                    <img src={resolveAssetUrl(preview)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Package className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{asset.name}</span>
                  {asset.description || asset.tags?.length ? (
                    <span className={clsx('block truncate text-[11px]', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
                      {asset.description || asset.tags?.join('、')}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          }) : null}
          {filteredMemberMentionOptions.length > 0 ? (
            <div className={clsx('px-3 py-2 text-[11px] font-medium', filteredAssetMentionOptions.length > 0 ? 'border-t' : '', darkEmbedded ? 'border-white/10 text-white/45' : 'border-border text-text-tertiary')}>
              成员
            </div>
          ) : null}
          {filteredMemberMentionOptions.length > 0 ? filteredMemberMentionOptions.map((member, index) => {
            const optionIndex = filteredAssetMentionOptions.length + index;
            const active = optionIndex === memberMentionActiveIndex;
            return (
              <button
                key={member.id}
                type="button"
                data-mention-option-index={optionIndex}
                onMouseEnter={() => setMemberMentionActiveIndex(optionIndex)}
                onClick={() => selectMemberMention(member)}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                  active
                    ? darkEmbedded ? 'bg-white/10' : 'bg-[rgb(var(--color-surface-secondary))]'
                    : darkEmbedded ? 'hover:bg-white/[0.06]' : 'hover:bg-[rgb(var(--color-surface-secondary))]',
                )}
              >
                {renderMemberMentionAvatar(member, darkEmbedded)}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{member.name}</span>
                  {member.personality ? (
                    <span className={clsx('block truncate text-[11px]', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
                      {member.personality}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          }) : null}
          {filteredSkillMentionOptions.length > 0 ? (
            <div className={clsx('px-3 py-2 text-[11px] font-medium', (filteredAssetMentionOptions.length > 0 || filteredMemberMentionOptions.length > 0) ? 'border-t' : '', darkEmbedded ? 'border-white/10 text-white/45' : 'border-border text-text-tertiary')}>
              Skills
            </div>
          ) : null}
          {filteredSkillMentionOptions.length > 0 ? filteredSkillMentionOptions.map((skill, index) => {
            const optionIndex = filteredAssetMentionOptions.length + filteredMemberMentionOptions.length + index;
            const active = optionIndex === memberMentionActiveIndex;
            return (
              <button
                key={skill.name}
                type="button"
                data-mention-option-index={optionIndex}
                onMouseEnter={() => setMemberMentionActiveIndex(optionIndex)}
                onClick={() => selectSkillMention(skill)}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                  active
                    ? darkEmbedded ? 'bg-white/10' : 'bg-[rgb(var(--color-surface-secondary))]'
                    : darkEmbedded ? 'hover:bg-white/[0.06]' : 'hover:bg-[rgb(var(--color-surface-secondary))]',
                )}
              >
                <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', darkEmbedded ? 'bg-white/[0.08] text-white/72' : 'bg-accent-muted text-accent-primary')}>
                  <Sparkles className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{skill.name}</span>
                  {skill.description ? (
                    <span className={clsx('block truncate text-[11px]', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
                      {skill.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          }) : null}
          {filteredAssetMentionOptions.length === 0 && filteredMemberMentionOptions.length === 0 && filteredSkillMentionOptions.length === 0 ? (
            <div className={clsx('px-3 pb-3 text-sm', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
              没有匹配项
            </div>
          ) : null}
        </div>
      ) : null}
      {showKnowledgeMentionPicker ? (
        <div ref={knowledgePickerRef} className={knowledgePickerClass}>
          <div className={clsx('mb-2 flex items-center justify-between px-1 text-[11px] font-medium', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
            <span>知识库</span>
            <span>{selectedKnowledgeMentions.length > 0 ? `已选 ${selectedKnowledgeMentions.length}` : 'Enter 选择'}</span>
          </div>
          {filteredKnowledgeMentionOptions.length > 0 ? (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {filteredKnowledgeMentionOptions.map((item, index) => {
                const active = index === knowledgeMentionActiveIndex;
                const selected = selectedKnowledgeIds.has(item.id);
                const cover = String(item.cover || '').trim();
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setKnowledgeMentionActiveIndex(index)}
                    onClick={() => toggleKnowledgeMention(item)}
                    className={clsx(
                      'group flex h-[58px] w-full items-center gap-2 overflow-hidden rounded-xl border px-2 py-1.5 text-left transition-colors',
                      selected
                        ? darkEmbedded ? 'border-accent-primary/45 bg-accent-primary/10' : 'border-accent-primary/35 bg-accent-muted'
                        : active
                          ? darkEmbedded ? 'border-white/18 bg-white/[0.08]' : 'border-border bg-surface-secondary'
                          : darkEmbedded ? 'border-white/10 bg-white/[0.04] hover:bg-white/[0.07]' : 'border-border/60 bg-white/75 hover:bg-surface-primary',
                    )}
                  >
                    <span className={clsx('relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border', darkEmbedded ? 'border-white/10 bg-white/[0.06]' : 'border-border bg-surface-secondary')}>
                      {cover ? (
                        <img src={resolveAssetUrl(cover)} alt="" className="h-full w-full object-cover" />
                      ) : (
                        renderKnowledgeMentionIcon(item, clsx('h-4 w-4', darkEmbedded ? 'text-white/58' : 'text-text-tertiary'))
                      )}
                      {selected ? (
                        <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent-primary text-white shadow-sm">
                          <Check className="h-3 w-3" />
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={clsx('block text-[10px] leading-3', darkEmbedded ? 'text-white/42' : 'text-text-tertiary')}>
                        #{getKnowledgeKindLabel(item)}
                      </span>
                      <span className={clsx('block truncate text-sm font-medium', darkEmbedded ? 'text-white/86' : 'text-text-primary')} title={item.title}>
                        {item.title || '未命名内容'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className={clsx('px-3 py-8 text-center text-sm', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
              没有匹配的知识库内容
            </div>
          )}
        </div>
      ) : null}
      <ChatComposerFrame theme={theme} variant={variant}>
        {selectedMemberMentionChip}
        {selectedContextMentionChips}
        {selectedKnowledgeMentions.length > 0 ? (
          <div className={clsx('flex flex-wrap items-center gap-2 px-3 pt-2', variant === 'empty' ? 'pb-1' : 'pb-0.5')}>
            {selectedKnowledgeMentions.map((item) => {
              const cover = String(item.cover || '').trim();
              return (
                <span
                  key={item.id}
                  className={clsx(
                    'inline-flex h-12 max-w-full items-center gap-2 rounded-xl border px-2 pr-1.5 text-xs',
                    darkEmbedded ? 'border-white/10 bg-white/[0.06] text-white/78' : 'border-border bg-surface-secondary text-text-secondary',
                  )}
                >
                  <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border', darkEmbedded ? 'border-white/10 bg-white/[0.06]' : 'border-border bg-white/80')}>
                    {cover ? (
                      <img src={resolveAssetUrl(cover)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      renderKnowledgeMentionIcon(item, clsx('h-4 w-4', darkEmbedded ? 'text-white/58' : 'text-text-tertiary'))
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className={clsx('block text-[10px] leading-3', darkEmbedded ? 'text-white/42' : 'text-text-tertiary')}>
                      #{getKnowledgeKindLabel(item)}
                    </span>
                    <span className="block max-w-[180px] truncate font-medium leading-4" title={item.title}>
                      {item.title || '未命名内容'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeKnowledgeMention(item.id)}
                    className={clsx('ml-0.5 rounded-full p-0.5 transition-colors', darkEmbedded ? 'hover:bg-white/10' : 'hover:bg-black/5')}
                    aria-label={`移除 #${item.title || '知识库内容'}`}
                    title="移除知识库内容"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
        {attachmentItems.length > 1 || (primaryAttachment && compactAttachmentMode) ? (
          <div className={wrapperClass}>
            <div className="space-y-2">
              {attachmentItems.map((item) => (
                <ComposerCompactAttachmentPreview
                  key={item.attachmentId || item.workspaceRelativePath || item.toolPath || item.absolutePath || item.originalAbsolutePath || item.name}
                  attachment={item}
                  darkEmbedded={darkEmbedded}
                  status={resolvedAttachmentStatus}
                  disabled={inputLocked || attachmentBusy}
                  onRemove={() => {
                    if (onRemoveAttachment) {
                      onRemoveAttachment(item);
                    } else {
                      onClearAttachment?.();
                    }
                  }}
                />
              ))}
            </div>
            {textarea}
          </div>
        ) : primaryAttachment ? (
          <div className={wrapperClass}>
            <ComposerAttachmentPreview
              attachment={primaryAttachment}
              darkEmbedded={darkEmbedded}
              variant={variant}
              status={resolvedAttachmentStatus}
              disabled={inputLocked || attachmentBusy}
              onRemove={() => {
                if (onRemoveAttachment) {
                  onRemoveAttachment(primaryAttachment);
                } else {
                  onClearAttachment?.();
                }
              }}
            >
              {textarea}
            </ComposerAttachmentPreview>
          </div>
        ) : attachmentBusy ? (
          <div className={wrapperClass}>
            <ComposerAttachmentUploadingStatus darkEmbedded={darkEmbedded} />
            {textarea}
          </div>
        ) : textarea}

        <div className={clsx('flex items-center gap-2', variant === 'empty' ? 'px-2 pb-1' : 'px-1.5 pb-0.5')}>
          <div className="flex shrink-0 items-center gap-1">
            {showAttachmentButton ? (
              <button
                type="button"
                onClick={() => void onPickAttachment?.()}
                disabled={disabled || readOnly || attachmentBusy}
                className={clsx('p-2 transition-colors', subtleButtonClass, (disabled || readOnly || attachmentBusy) && 'cursor-not-allowed opacity-60')}
                title={attachmentBusy ? '正在添加附件' : '添加文件'}
              >
                <Plus className="h-[18px] w-[18px]" />
              </button>
            ) : null}

            {showModelSelector ? (
              <div ref={modelPickerRef} className="relative flex items-center gap-4 px-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!modelOptions.length) return;
                    setShowModelPicker((current) => !current);
                  }}
                  className={clsx('flex items-center gap-1.5 text-[13px] font-medium transition-colors', subtleButtonClass)}
                >
                  <span className="max-w-[180px] truncate">{selectedModel?.modelName || '默认模型'}</span>
                  <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', showModelPicker && 'rotate-180')} />
                </button>
                {showModelPicker && (
                  <div className={modelPickerClass}>
                    {canOpenModelPicker ? modelOptions.map((option) => {
                      const active = option.key === selectedModelKey;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => {
                            onSelectedModelKeyChange?.(option.key);
                            setShowModelPicker(false);
                          }}
                          className={clsx(
                            'w-full px-3 py-2.5 text-left transition-colors',
                            active ? 'bg-accent-primary/10 text-text-primary' : darkEmbedded ? 'text-white/68 hover:bg-white/6' : 'text-text-secondary hover:bg-surface-secondary/50',
                          )}
                        >
                          <div className="truncate text-sm font-medium">{option.modelName}</div>
                          <div className="truncate text-[11px] text-text-tertiary">{option.sourceName}</div>
                        </button>
                      );
                    }) : (
                      <div className="px-3 py-2 text-sm text-text-tertiary">请先在设置里配置模型源</div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {audioState === 'recording' ? (
            <ComposerRecordingStatus darkEmbedded={darkEmbedded} elapsedMs={recordingElapsedMs} />
          ) : (
            <div className="flex-1" />
          )}

          <div className="flex shrink-0 items-center gap-2">
            {showCancelButton ? (
              <button
                type="button"
                onClick={() => void onCancel?.()}
                className={clsx(
                  'rounded-lg p-2 transition-colors',
                  darkEmbedded ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50',
                )}
                title="停止生成"
              >
                <StopCircle className="h-5 w-5" />
              </button>
            ) : showAudioButton ? (
              <button
                type="button"
                onClick={() => void onAudioAction?.()}
                disabled={audioState === 'transcribing' || disabled}
                className={clsx(
                  'p-2 transition-colors',
                  audioState === 'recording' ? 'text-red-500 hover:text-red-600' : subtleButtonClass,
                  (audioState === 'transcribing' || disabled) && 'cursor-not-allowed opacity-60',
                )}
                title={
                  audioState === 'transcribing'
                    ? '语音转录中'
                    : audioState === 'recording'
                      ? '停止录音并转写'
                      : '语音输入'
                }
              >
                {audioState === 'transcribing' ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : audioState === 'recording' ? (
                  <Square className="h-[18px] w-[18px] fill-current" />
                ) : (
                  <Mic className="h-[18px] w-[18px]" />
                )}
              </button>
            ) : null}

            {trailingContent}

            <button
              type="submit"
              disabled={submitDisabled}
              className={clsx('flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200', sendButtonClass)}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin text-[#b4b2a8]" /> : <ArrowUp className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </ChatComposerFrame>
    </form>
  );
});
