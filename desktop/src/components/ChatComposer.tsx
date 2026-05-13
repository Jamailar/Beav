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
  Plus,
  Search,
  Square,
  StopCircle,
  UserRound,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { getForcedModelCapabilities, inferModelCapabilities, normalizeModelCapabilities, type ModelCapability } from '../../shared/modelCapabilities';
import { OFFICIAL_AUTO_SOURCE_ID } from '../config/aiSources';
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
  sourceId?: string;
  presetId?: string;
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

type ComposerAttachmentVisualKind = 'image' | 'video' | 'audio' | 'text' | 'file';
type ChatComposerAudioState = 'idle' | 'recording' | 'transcribing';
type ChatComposerAttachmentStatus = 'uploading' | 'uploaded';
const RECORDING_WAVE_BARS = [0.3, 0.58, 0.92, 0.42, 0.74, 0.98, 0.5, 0.8, 0.64, 0.9, 0.46, 0.7, 1, 0.62, 0.84, 0.54, 0.95, 0.4, 0.78, 0.34, 0.88, 0.56, 0.72, 0.44];

interface ComposerAttachmentPreviewProps {
  attachment: UploadedFileAttachment;
  darkEmbedded: boolean;
  variant: ChatComposerVariant;
  onRemove: () => void;
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
  onClearAttachment?: (() => void) | null;
  onRemoveAttachment?: ((attachment: UploadedFileAttachment) => void) | null;
  modelOptions?: ChatModelOption[];
  selectedModelKey?: string;
  onSelectedModelKeyChange?: (key: string) => void;
  isBusy?: boolean;
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
  memberMentionOptions?: ChatMemberMentionOption[];
  selectedMemberMention?: ChatMemberMentionOption | null;
  onSelectedMemberMentionChange?: (member: ChatMemberMentionOption | null) => void;
  knowledgeMentionOptions?: ChatKnowledgeMentionOption[];
  selectedKnowledgeMentions?: ChatKnowledgeMentionOption[];
  onSelectedKnowledgeMentionsChange?: (items: ChatKnowledgeMentionOption[]) => void;
  onKnowledgeMentionSearchQueryChange?: (query: string) => void;
}

const IMAGE_ATTACHMENT_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i;
const VIDEO_ATTACHMENT_EXT_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(?:[?#].*)?$/i;
const AUDIO_ATTACHMENT_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)(?:[?#].*)?$/i;
const TEXT_ATTACHMENT_EXT_RE = /\.(txt|md|markdown|json|csv|tsv|doc|docx|pdf|rtf|xml|yaml|yml|ts|tsx|js|jsx|py|rs|java|go|c|cpp|h|hpp)(?:[?#].*)?$/i;
const DOCUMENT_ATTACHMENT_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|rtf)(?:[?#].*)?$/i;

function logComposerThumbnailDebug(event: string, fields: Record<string, unknown>) {
  console.info('[chat-thumbnail]', event, fields);
  void window.ipcRenderer?.logs?.appendRenderer?.({
    level: 'debug',
    category: 'chat.attachment.thumbnail',
    event,
    message: event,
    fields,
  }).catch(() => undefined);
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
  if (avatar && /^(https?:|file:|data:|local-file:|asset:)/i.test(avatar)) {
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
        <span className={clsx('h-2 w-2 rounded-full', darkEmbedded ? 'bg-[rgb(var(--color-status-error)/0.9)]' : 'bg-[rgb(var(--color-status-error))]', 'animate-pulse')} />
      </div>
      <div className="flex min-w-0 flex-1 items-center">
        <div className="relative z-[1] flex h-5 min-w-0 flex-1 items-center justify-center gap-[3px] px-1">
          {RECORDING_WAVE_BARS.map((height, index) => (
            <span
              key={`${index}-${height}`}
              className={clsx(
                'recording-wave-bar w-[2px] shrink-0 rounded-full',
                darkEmbedded ? 'bg-white/68' : 'bg-[rgb(var(--color-text-secondary))]',
              )}
              style={{
                height: `${5 + Math.round(height * 9)}px`,
                animationDelay: `${index * 70}ms`,
              }}
            />
          ))}
        </div>
      </div>
      <div className={clsx('shrink-0 text-[11px] font-medium tabular-nums', darkEmbedded ? 'text-white/58' : 'text-[rgb(var(--color-text-tertiary))]')}>
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
  const prefersOfficialDefault = defaultSourceId.toLowerCase() === OFFICIAL_AUTO_SOURCE_ID;
  let hasExplicitDefaultSource = false;

  try {
    const parsed = JSON.parse(String(settings.ai_sources_json || '[]')) as Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const sourceId = String(item.id || '').trim();
        const presetId = String(item.presetId || item.preset_id || '').trim();
        if (sourceId && sourceId === defaultSourceId) {
          hasExplicitDefaultSource = true;
        }
        const sourceName = String(item.name || sourceId || '供应商').trim();
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
            sourceId,
            presetId,
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
      sourceName: '当前默认供应商',
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
  children,
}: ComposerAttachmentPreviewProps) {
  const visualKind = getAttachmentVisualKind(attachment);
  const isImageAttachment = visualKind === 'image';
  const isVideoAttachment = visualKind === 'video';
  const previewSrc = isImageAttachment
    ? getAttachmentSource(attachment)
    : isVideoAttachment
      ? getAttachmentSource(attachment)
      : '';
  if (isVideoAttachment) {
    console.info('[chat-thumbnail] composer.preview', {
      name: attachment.name,
      visualKind,
      previewSrc,
      thumbnailDataUrl: attachment.thumbnailDataUrl,
      thumbnailUrl: attachment.thumbnailUrl,
      localUrl: attachment.localUrl,
      absolutePath: attachment.absolutePath,
      originalAbsolutePath: attachment.originalAbsolutePath,
    });
  }
  const extLabel = getAttachmentExtLabel(attachment);
  const sizeLabel = formatAttachmentSize(attachment.size);
  const typeLabel = getAttachmentKindLabel(visualKind);
  const hasVisualPreview = isImageAttachment || (isVideoAttachment && Boolean(previewSrc));
  const frameClass = hasVisualPreview
    ? variant === 'empty' ? 'h-[88px] w-[88px]' : 'h-[72px] w-[72px]'
    : variant === 'empty' ? 'h-[92px] w-[70px]' : 'h-[78px] w-[58px]';
  const frameRadiusClass = hasVisualPreview
    ? variant === 'empty' ? 'rounded-[18px]' : 'rounded-[16px]'
    : 'rounded-[22px]';
  const metaClass = darkEmbedded ? 'text-white/34' : 'text-text-tertiary/70';
  const titleClass = darkEmbedded ? 'text-white/88' : 'text-text-primary';
  const badgeClass = darkEmbedded
    ? 'border-white/10 bg-white/[0.05] text-white/58'
    : 'border-black/[0.06] bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))]';
  const previewShellClass = darkEmbedded
    ? 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] shadow-[0_12px_34px_rgba(0,0,0,0.35)]'
    : 'border-black/[0.07] bg-[linear-gradient(180deg,rgb(var(--color-surface-secondary)),rgb(var(--color-surface-tertiary)))] shadow-[0_12px_28px_rgba(110,84,44,0.12)]';
  const removeButtonClass = darkEmbedded
    ? 'border-white/12 bg-[rgb(var(--color-surface-secondary))] text-white/62 hover:text-white hover:bg-[rgb(var(--color-surface-primary))]'
    : 'border-white bg-white text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text-primary))] hover:bg-[rgb(var(--color-surface-secondary))]';
  const infoTokens = [typeLabel, extLabel, sizeLabel].filter(Boolean);

  return (
    <div className="flex items-start gap-3">
      <div className="relative shrink-0">
        {previewSrc ? (
          <div className={clsx(
            'overflow-hidden border',
            frameClass,
            frameRadiusClass,
            hasVisualPreview ? 'rotate-0' : (variant === 'empty' ? '-rotate-[4deg]' : '-rotate-[3deg]'),
            previewShellClass,
          )}>
            <img
              src={previewSrc}
              alt={attachment.name}
              className="h-full w-full object-cover"
              onError={() => logComposerThumbnailDebug('composer.preview.img-error', {
                name: attachment.name,
                previewSrc,
                thumbnailDataUrl: attachment.thumbnailDataUrl,
                thumbnailUrl: attachment.thumbnailUrl,
                localUrl: attachment.localUrl,
                absolutePath: attachment.absolutePath,
              })}
            />
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
                darkEmbedded ? 'text-white/68' : 'text-[rgb(var(--color-text-secondary))]',
              ))}
              <span className={clsx(
                'max-w-full truncate text-[10px] font-semibold tracking-[0.18em]',
                darkEmbedded ? 'text-white/42' : 'text-[rgb(var(--color-text-tertiary))]',
              )}>
                {extLabel || typeLabel}
              </span>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onRemove}
          className={clsx(
            'absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border transition-colors',
            removeButtonClass,
          )}
          title="移除文件"
          aria-label={`移除 ${attachment.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <div className={clsx('shrink-0 text-[9px] font-medium tracking-[0.12em]', metaClass)}>已添加文件</div>
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

function ComposerCompactAttachmentTray({
  attachment,
  status,
  darkEmbedded,
  onRemove,
}: {
  attachment?: UploadedFileAttachment | null;
  status?: ChatComposerAttachmentStatus | null;
  darkEmbedded: boolean;
  onRemove: () => void;
}) {
  const uploading = status === 'uploading';
  if (!attachment && !uploading) return null;

  const visualKind = attachment ? getAttachmentVisualKind(attachment) : 'file';
  const previewSrc = attachment && visualKind === 'image' ? getAttachmentSource(attachment) : '';
  const extLabel = attachment ? getAttachmentExtLabel(attachment) : '';
  const sizeLabel = attachment ? formatAttachmentSize(attachment.size) : '';
  const typeLabel = attachment ? getAttachmentKindLabel(visualKind) : '文件';
  const metaLabel = [typeLabel, sizeLabel].filter(Boolean).join(' · ');
  const cardClass = darkEmbedded
    ? 'border-white/10 bg-white/[0.06] text-white shadow-[0_10px_28px_rgba(0,0,0,0.28)]'
    : 'border-black/[0.06] bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-primary))] shadow-[0_8px_22px_rgba(36,32,24,0.07)]';
  const mediaClass = darkEmbedded
    ? 'border-white/10 bg-white/[0.08] text-white/68'
    : 'border-black/[0.06] bg-white text-[rgb(var(--color-text-secondary))]';
  const metaClass = darkEmbedded ? 'text-white/46' : 'text-[rgb(var(--color-text-tertiary))]';
  const statusClass = uploading
    ? darkEmbedded
      ? 'text-[rgb(var(--color-warning-text))]'
      : 'text-[rgb(var(--color-status-warning))]'
    : darkEmbedded
      ? 'text-[rgb(var(--color-success-text))]'
      : 'text-[rgb(var(--color-status-success))]';

  return (
    <div className="flex flex-wrap items-center gap-2 px-3.5 pt-3">
      <div className={clsx(
        'group/attachment relative flex h-[58px] max-w-full items-center gap-3 rounded-2xl border px-3 pr-9 transition-colors',
        'sm:max-w-[260px]',
        cardClass,
      )}>
        <div className={clsx('flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border', mediaClass)}>
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : previewSrc ? (
            <img src={previewSrc} alt={attachment?.name || '附件'} className="h-full w-full object-cover" />
          ) : (
            getAttachmentKindIcon(visualKind, 'h-4 w-4')
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-5" title={attachment?.name || undefined}>
            {attachment?.name || '正在上传文件'}
          </div>
          <div className={clsx('mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4', metaClass)}>
            <span className="truncate">
              {uploading ? '正在准备附件' : metaLabel || extLabel || '文件'}
            </span>
            {!uploading && extLabel ? <span className="shrink-0">{extLabel}</span> : null}
          </div>
        </div>

        <div className={clsx(
          'absolute bottom-2 right-3 flex items-center gap-1 text-[10px] font-medium',
          statusClass,
        )}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', uploading ? 'bg-[rgb(var(--color-status-warning))]' : 'bg-[rgb(var(--color-status-success))]')} />
          {uploading ? '上传中' : '已上传'}
        </div>

        {attachment ? (
          <button
            type="button"
            onClick={onRemove}
            className={clsx(
              'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full opacity-70 transition hover:opacity-100',
              darkEmbedded ? 'text-white/62 hover:bg-white/10' : 'text-[rgb(var(--color-text-secondary))] hover:bg-white',
            )}
            title="移除文件"
            aria-label={`移除 ${attachment.name}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComposerAttachmentPlaceholder({
  darkEmbedded,
  variant,
  disabled,
  onClick,
}: {
  darkEmbedded: boolean;
  variant: ChatComposerVariant;
  disabled: boolean;
  onClick: () => void | Promise<void>;
}) {
  const frameClass = variant === 'empty' ? 'h-[88px] w-[64px]' : 'h-[68px] w-[50px]';
  const iconClass = variant === 'empty' ? 'h-7 w-7' : 'h-5 w-5';
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className={clsx(
        'group/upload relative shrink-0 rotate-[-7deg] rounded-[6px] border border-dashed transition-all duration-200',
        'flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-45',
        frameClass,
        darkEmbedded
          ? 'border-white/12 bg-white/[0.035] text-white/44 hover:border-white/22 hover:bg-white/[0.06] hover:text-white/68'
          : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-tertiary))] hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-primary))] hover:text-[rgb(var(--color-text-secondary))]',
        !disabled && 'hover:rotate-[-5deg]',
      )}
      title="添加文件"
      aria-label="添加文件"
    >
      <Plus className={clsx(iconClass, 'transition-transform duration-200 group-hover/upload:scale-105')} strokeWidth={1.8} />
    </button>
  );
}

function ComposerMediaAttachmentSlot({
  attachment,
  darkEmbedded,
  variant,
  disabled,
  onRemove,
}: {
  attachment: UploadedFileAttachment;
  darkEmbedded: boolean;
  variant: ChatComposerVariant;
  disabled: boolean;
  onRemove: () => void;
}) {
  const visualKind = getAttachmentVisualKind(attachment);
  const source = getAttachmentSource(attachment);
  const frameClass = variant === 'empty' ? 'h-[88px] w-[64px]' : 'h-[68px] w-[50px]';
  const iconClass = variant === 'empty' ? 'h-6 w-6' : 'h-5 w-5';
  const frameToneClass = darkEmbedded
    ? 'border-white/12 bg-white/[0.045] text-white/58'
    : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-tertiary))]';

  return (
    <div className={clsx(
      'group/media relative shrink-0 rotate-[-7deg] overflow-hidden rounded-[6px] border transition-all duration-200',
      frameClass,
      frameToneClass,
      !disabled && 'hover:rotate-[-5deg]',
    )}>
      {source && (visualKind === 'image' || visualKind === 'video') ? (
        <img
          src={source}
          alt={attachment.name}
          className="h-full w-full object-cover"
          onError={() => logComposerThumbnailDebug('composer.media-slot.img-error', {
            name: attachment.name,
            visualKind,
            source,
            thumbnailDataUrl: attachment.thumbnailDataUrl,
            thumbnailUrl: attachment.thumbnailUrl,
            localUrl: attachment.localUrl,
            absolutePath: attachment.absolutePath,
          })}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          {getAttachmentKindIcon(visualKind, iconClass)}
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className={clsx(
          'absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border text-[11px] opacity-0 shadow-sm transition-opacity group-hover/media:opacity-100 disabled:cursor-not-allowed',
          darkEmbedded
            ? 'border-white/10 bg-[rgb(var(--color-surface-secondary))] text-white/70 hover:text-white'
            : 'border-white bg-white text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text-primary))]',
        )}
        title="移除文件"
        aria-label={`移除 ${attachment.name}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ComposerMediaAttachmentStack({
  attachments,
  darkEmbedded,
  variant,
  disabled,
  onRemove,
}: {
  attachments: UploadedFileAttachment[];
  darkEmbedded: boolean;
  variant: ChatComposerVariant;
  disabled: boolean;
  onRemove: (attachment: UploadedFileAttachment) => void;
}) {
  return (
    <div className="flex max-w-[180px] shrink-0 flex-wrap items-start gap-2">
      {attachments.map((item) => (
        <ComposerMediaAttachmentSlot
          key={item.attachmentId || item.workspaceRelativePath || item.toolPath || item.absolutePath || item.originalAbsolutePath || item.name}
          attachment={item}
          darkEmbedded={darkEmbedded}
          variant={variant}
          disabled={disabled}
          onRemove={() => onRemove(item)}
        />
      ))}
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
  attachmentStatus,
  attachmentPreviewMode = 'default',
  onPickAttachment,
  onClearAttachment,
  onRemoveAttachment,
  modelOptions = [],
  selectedModelKey = '',
  onSelectedModelKeyChange,
  isBusy = false,
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
  memberMentionOptions = [],
  selectedMemberMention = null,
  onSelectedMemberMentionChange,
  knowledgeMentionOptions = [],
  selectedKnowledgeMentions = [],
  onSelectedKnowledgeMentionsChange,
  onKnowledgeMentionSearchQueryChange,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const memberPickerRef = useRef<HTMLDivElement>(null);
  const knowledgePickerRef = useRef<HTMLDivElement>(null);
  const knowledgeSearchInputRef = useRef<HTMLInputElement>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [memberMentionTrigger, setMemberMentionTrigger] = useState<{ start: number; end: number; query: string } | null>(null);
  const [memberMentionActiveIndex, setMemberMentionActiveIndex] = useState(0);
  const [knowledgeMentionTrigger, setKnowledgeMentionTrigger] = useState<{ start: number; end: number; query: string } | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeMentionActiveIndex, setKnowledgeMentionActiveIndex] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const darkEmbedded = theme === 'dark';
  const palette = getChatComposerPalette(theme);
  const selectedModel = useMemo(
    () => modelOptions.find((item) => item.key === selectedModelKey) || null,
    [modelOptions, selectedModelKey],
  );
  const attachmentBusy = attachmentStatus === 'uploading';
  const hasKnowledgeMentions = selectedKnowledgeMentions.length > 0;
  const submitDisabled = disabled || isBusy || attachmentBusy || (!value.trim() && !attachment && !hasKnowledgeMentions);
  const showAttachmentButton = Boolean(onPickAttachment);
  const showModelSelector = Boolean(onSelectedModelKeyChange);
  const showAudioButton = Boolean(onAudioAction);
  const showCancelButton = Boolean(onCancel) && showCancelWhenBusy && isBusy;
  const canOpenModelPicker = showModelSelector && modelOptions.length > 0;
  const memberMentionEnabled = Boolean(onSelectedMemberMentionChange);
  const knowledgeMentionEnabled = Boolean(onSelectedKnowledgeMentionsChange);
  const filteredMemberMentionOptions = useMemo(() => (
    memberMentionOptions
      .filter((member) => memberMentionMatches(member, memberMentionTrigger?.query || ''))
      .slice(0, 8)
  ), [memberMentionOptions, memberMentionTrigger?.query]);
  const selectedKnowledgeIds = useMemo(() => new Set(selectedKnowledgeMentions.map((item) => item.id)), [selectedKnowledgeMentions]);
  const filteredKnowledgeMentionOptions = useMemo(() => (
    (onKnowledgeMentionSearchQueryChange
      ? knowledgeMentionOptions
      : knowledgeMentionOptions.filter((item) => knowledgeMentionMatches(item, knowledgeQuery))
    ).slice(0, 120)
  ), [knowledgeMentionOptions, knowledgeQuery, onKnowledgeMentionSearchQueryChange]);
  const showMemberMentionPicker = memberMentionEnabled && Boolean(memberMentionTrigger);
  const showKnowledgeMentionPicker = knowledgeMentionEnabled && Boolean(knowledgeMentionTrigger);
  const modelPickerClass = darkEmbedded
    ? 'absolute left-0 bottom-full mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-white/10 bg-[rgb(var(--color-background))] shadow-xl z-[130]'
    : 'absolute left-0 bottom-full mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-border bg-surface-primary shadow-xl z-[130]';
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
      if (!memberPickerRef.current?.contains(event.target as Node) && !textareaRef.current?.contains(event.target as Node)) {
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
    if (!showKnowledgeMentionPicker) return;
    window.requestAnimationFrame(() => {
      knowledgeSearchInputRef.current?.focus();
      knowledgeSearchInputRef.current?.select();
    });
  }, [showKnowledgeMentionPicker]);

  useEffect(() => {
    setMemberMentionActiveIndex(0);
  }, [memberMentionTrigger?.query]);

  useEffect(() => {
    setKnowledgeMentionActiveIndex(0);
  }, [knowledgeQuery]);

  useEffect(() => {
    if (!showKnowledgeMentionPicker) return;
    onKnowledgeMentionSearchQueryChange?.(knowledgeQuery);
  }, [knowledgeQuery, onKnowledgeMentionSearchQueryChange, showKnowledgeMentionPicker]);

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

  const updateMentionTrigger = useCallback((nextValue: string, caretIndex: number) => {
    if (readOnly || disabled || isBusy) {
      setMemberMentionTrigger(null);
      setKnowledgeMentionTrigger(null);
      return;
    }
    const memberTrigger = memberMentionEnabled ? getActiveMemberMentionTrigger(nextValue, caretIndex) : null;
    const knowledgeTrigger = knowledgeMentionEnabled ? getActiveKnowledgeMentionTrigger(nextValue, caretIndex) : null;
    const nextTrigger = memberTrigger && knowledgeTrigger
      ? (memberTrigger.start >= knowledgeTrigger.start ? 'member' : 'knowledge')
      : memberTrigger
        ? 'member'
        : knowledgeTrigger
          ? 'knowledge'
          : null;

    if (nextTrigger === 'member' && memberTrigger) {
      setMemberMentionTrigger(memberTrigger);
      setKnowledgeMentionTrigger(null);
      return;
    }
    if (nextTrigger === 'knowledge' && knowledgeTrigger) {
      setKnowledgeMentionTrigger(knowledgeTrigger);
      setKnowledgeQuery(knowledgeTrigger.query);
      setMemberMentionTrigger(null);
      return;
    }
    setMemberMentionTrigger(null);
    setKnowledgeMentionTrigger(null);
  }, [disabled, isBusy, knowledgeMentionEnabled, memberMentionEnabled, readOnly]);

  const selectMemberMention = useCallback((member: ChatMemberMentionOption) => {
    const trigger = memberMentionTrigger;
    onSelectedMemberMentionChange?.(member);
    setMemberMentionTrigger(null);
    if (trigger) {
      const nextValue = `${value.slice(0, trigger.start)}${value.slice(trigger.end)}`;
      onValueChange(nextValue);
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const nextCaret = Math.min(trigger.start, nextValue.length);
        textarea.focus();
        textarea.setSelectionRange(nextCaret, nextCaret);
        syncHeight();
      });
    } else {
      textareaRef.current?.focus();
    }
  }, [memberMentionTrigger, onSelectedMemberMentionChange, onValueChange, syncHeight, value]);

  const removeKnowledgeTriggerText = useCallback((keepPickerOpen = false) => {
    const trigger = knowledgeMentionTrigger;
    if (!trigger) return;
    const nextValue = `${value.slice(0, trigger.start)}${value.slice(trigger.end)}`;
    onValueChange(nextValue);
    setKnowledgeMentionTrigger(keepPickerOpen ? { start: trigger.start, end: trigger.start, query: '' } : null);
    window.requestAnimationFrame(() => {
      const textarea = keepPickerOpen ? null : textareaRef.current;
      if (!textarea) return;
      const nextCaret = Math.min(trigger.start, nextValue.length);
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
    removeKnowledgeTriggerText(true);
    setKnowledgeQuery('');
    window.requestAnimationFrame(() => knowledgeSearchInputRef.current?.focus());
  }, [onSelectedKnowledgeMentionsChange, removeKnowledgeTriggerText, selectedKnowledgeIds, selectedKnowledgeMentions]);

  const removeKnowledgeMention = useCallback((itemId: string) => {
    onSelectedKnowledgeMentionsChange?.(
      selectedKnowledgeMentions.filter((item) => item.id !== itemId),
    );
  }, [onSelectedKnowledgeMentionsChange, selectedKnowledgeMentions]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showKnowledgeMentionPicker) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setKnowledgeMentionTrigger(null);
        return;
      }
    }
    if (showMemberMentionPicker) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMemberMentionActiveIndex((current) => (
          filteredMemberMentionOptions.length > 0 ? (current + 1) % filteredMemberMentionOptions.length : 0
        ));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMemberMentionActiveIndex((current) => (
          filteredMemberMentionOptions.length > 0
            ? (current - 1 + filteredMemberMentionOptions.length) % filteredMemberMentionOptions.length
            : 0
        ));
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMemberMentionTrigger(null);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && filteredMemberMentionOptions.length > 0) {
        event.preventDefault();
        selectMemberMention(filteredMemberMentionOptions[Math.min(memberMentionActiveIndex, filteredMemberMentionOptions.length - 1)]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !isComposing && !isImeComposingEvent(event)) {
      event.preventDefault();
      if (!submitDisabled) {
        onSubmit();
      }
    }
  }, [filteredMemberMentionOptions, isComposing, memberMentionActiveIndex, onSubmit, selectMemberMention, showKnowledgeMentionPicker, showMemberMentionPicker, submitDisabled]);

  const handleKnowledgeSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setKnowledgeMentionActiveIndex((current) => (
        filteredKnowledgeMentionOptions.length > 0 ? (current + 1) % filteredKnowledgeMentionOptions.length : 0
      ));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setKnowledgeMentionActiveIndex((current) => (
        filteredKnowledgeMentionOptions.length > 0
          ? (current - 1 + filteredKnowledgeMentionOptions.length) % filteredKnowledgeMentionOptions.length
          : 0
      ));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setKnowledgeMentionTrigger(null);
      textareaRef.current?.focus();
      return;
    }
    if (event.key === 'Enter' && filteredKnowledgeMentionOptions.length > 0) {
      event.preventDefault();
      toggleKnowledgeMention(filteredKnowledgeMentionOptions[Math.min(knowledgeMentionActiveIndex, filteredKnowledgeMentionOptions.length - 1)]);
      return;
    }
  }, [filteredKnowledgeMentionOptions, knowledgeMentionActiveIndex, toggleKnowledgeMention]);

  const wrapperClass = variant === 'empty' ? 'px-4 pt-4' : 'px-3.5 pt-3';
  const attachmentItems = attachments && attachments.length > 0 ? attachments : attachment ? [attachment] : [];
  const primaryAttachment = attachmentItems[0] || null;
  const compactAttachmentMode = attachmentPreviewMode === 'compact-status';
  const resolvedAttachmentStatus: ChatComposerAttachmentStatus | null = attachmentStatus
    || (attachmentItems.length > 0 ? 'uploaded' : null);
  const mediaSlotAttachments = attachmentItems.filter((item) => {
    const kind = getAttachmentVisualKind(item);
    return kind === 'image' || kind === 'video';
  });
  const showAttachmentInMediaSlot = mediaSlotAttachments.length > 0;
  const showCompactAttachmentTray = compactAttachmentMode
    && !showAttachmentInMediaSlot
    && (attachmentItems.length > 0 || resolvedAttachmentStatus === 'uploading');
  const showInlineAttachmentPlaceholder = showAttachmentButton && attachmentItems.length === 0;
  const inlineAttachmentSlot = showAttachmentInMediaSlot ? (
    <ComposerMediaAttachmentStack
      attachments={mediaSlotAttachments}
      darkEmbedded={darkEmbedded}
      variant={variant}
      disabled={disabled || isBusy || attachmentBusy}
      onRemove={(item) => {
        if (onRemoveAttachment) {
          onRemoveAttachment(item);
        } else {
          onClearAttachment?.();
        }
      }}
    />
  ) : showInlineAttachmentPlaceholder ? (
    <ComposerAttachmentPlaceholder
      darkEmbedded={darkEmbedded}
      variant={variant}
      disabled={disabled || isBusy || attachmentBusy}
      onClick={() => onPickAttachment?.()}
    />
  ) : null;
  const textareaClass = primaryAttachment && !showAttachmentInMediaSlot
    ? variant === 'empty'
      ? 'mt-3 w-full bg-transparent pr-1 pb-1 text-[16px] focus:outline-none resize-none min-h-[64px] max-h-[220px] overflow-y-auto'
      : 'mt-2.5 w-full bg-transparent pr-1 pb-1 text-[14px] focus:outline-none resize-none min-h-[52px] max-h-[180px] overflow-y-auto'
    : showInlineAttachmentPlaceholder || showAttachmentInMediaSlot
      ? variant === 'empty'
        ? 'w-full bg-transparent px-2 py-0.5 text-[16px] focus:outline-none resize-none min-h-[72px] max-h-[96px] overflow-y-auto'
        : 'w-full bg-transparent px-2 py-0.5 text-[14px] focus:outline-none resize-none min-h-[56px] max-h-[160px] overflow-y-auto'
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
      onChange={(event) => {
        onValueChange(event.target.value);
        updateMentionTrigger(event.target.value, event.target.selectionStart || 0);
      }}
      onFocus={onFocus}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      onKeyDown={handleKeyDown}
      onClick={(event) => updateMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart || 0)}
      onSelect={(event) => updateMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart || 0)}
      placeholder={placeholder}
      className={clsx(textareaClass, palette.text)}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      readOnly={readOnly || isBusy}
      aria-disabled={disabled || isBusy}
      rows={1}
    />
  );

  return (
    <form onSubmit={handleFormSubmit} className={clsx('relative w-full', className)}>
      {showMemberMentionPicker ? (
        <div
          ref={memberPickerRef}
          className={clsx(
            'absolute bottom-full left-3 z-[140] mb-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border shadow-xl',
            darkEmbedded ? 'border-white/10 bg-[rgb(var(--color-background))] text-white' : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] text-text-primary',
          )}
        >
          <div className={clsx('px-3 py-2 text-[11px] font-medium', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
            选择成员
          </div>
          {filteredMemberMentionOptions.length > 0 ? filteredMemberMentionOptions.map((member, index) => {
            const active = index === memberMentionActiveIndex;
            return (
              <button
                key={member.id}
                type="button"
                onMouseEnter={() => setMemberMentionActiveIndex(index)}
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
          }) : (
            <div className={clsx('px-3 pb-3 text-sm', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')}>
              没有匹配的成员
            </div>
          )}
        </div>
      ) : null}
      {showKnowledgeMentionPicker ? (
        <div
          ref={knowledgePickerRef}
          className={clsx(
            'absolute bottom-full left-0 right-0 z-[150] mb-3 max-h-[min(70vh,560px)] overflow-hidden rounded-2xl border shadow-2xl',
            darkEmbedded ? 'border-white/10 bg-[rgb(var(--color-background))] text-white' : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-primary))] text-text-primary',
          )}
        >
          <div className={clsx('flex items-center gap-2 border-b px-4 py-3', darkEmbedded ? 'border-white/10' : 'border-[rgb(var(--color-divider))]')}>
            <Search className={clsx('h-4 w-4 shrink-0', darkEmbedded ? 'text-white/45' : 'text-text-tertiary')} />
            <input
              ref={knowledgeSearchInputRef}
              value={knowledgeQuery}
              onChange={(event) => setKnowledgeQuery(event.target.value)}
              onKeyDown={handleKnowledgeSearchKeyDown}
              className={clsx(
                'h-9 min-w-0 flex-1 bg-transparent text-sm outline-none',
                darkEmbedded ? 'text-white placeholder:text-white/30' : 'text-text-primary placeholder:text-text-tertiary',
              )}
              placeholder="搜索知识库内容"
              autoComplete="off"
              spellCheck={false}
            />
            <div className={clsx('shrink-0 text-[11px]', darkEmbedded ? 'text-white/38' : 'text-text-tertiary')}>
              {selectedKnowledgeMentions.length > 0 ? `已选 ${selectedKnowledgeMentions.length}` : 'Enter 选择'}
            </div>
          </div>
          <div className="max-h-[calc(min(70vh,560px)-64px)] overflow-auto p-3">
            {filteredKnowledgeMentionOptions.length > 0 ? (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
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
                          ? darkEmbedded ? 'border-[rgb(var(--color-accent-primary)/0.45)] bg-[rgb(var(--color-accent-primary)/0.10)]' : 'border-[rgb(var(--color-accent-primary)/0.35)] bg-[rgb(var(--color-accent-muted))]'
                          : active
                            ? darkEmbedded ? 'border-white/18 bg-white/[0.08]' : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-secondary))]'
                            : darkEmbedded ? 'border-white/10 bg-white/[0.04] hover:bg-white/[0.07]' : 'border-[rgb(var(--color-divider))] bg-white/75 hover:bg-[rgb(var(--color-surface-primary))]',
                      )}
                    >
                      <div className={clsx('relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border', darkEmbedded ? 'border-white/10 bg-white/[0.06]' : 'border-[rgb(var(--color-divider))] bg-[rgb(var(--color-surface-secondary))]')}>
                        {cover ? (
                          <img src={resolveAssetUrl(cover)} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className={clsx('flex h-full w-full items-center justify-center', darkEmbedded ? 'text-white/58' : 'text-[rgb(var(--color-text-tertiary))]')}>
                            {renderKnowledgeMentionIcon(item, 'h-4 w-4')}
                          </div>
                        )}
                        {selected ? (
                          <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[rgb(var(--color-accent-primary))] text-white shadow-sm">
                            <Check className="h-3 w-3" />
                          </span>
                        ) : null}
                      </div>
                      <span
                        className={clsx(
                          'block min-w-0 flex-1 text-sm font-medium leading-5 line-clamp-2',
                          darkEmbedded ? 'text-white/86' : 'text-[rgb(var(--color-text-primary))]',
                        )}
                        title={item.title}
                      >
                        {item.title || '未命名内容'}
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
        </div>
      ) : null}
      <ChatComposerFrame theme={theme} variant={variant}>
        {selectedMemberMention || selectedKnowledgeMentions.length > 0 ? (
          <div className={clsx('flex flex-wrap items-center gap-2 px-3 pt-2', variant === 'empty' ? 'pb-1' : 'pb-0.5')}>
            {selectedMemberMention ? (
              <span className={clsx(
                'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                darkEmbedded ? 'border-white/10 bg-white/[0.06] text-white/78' : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))]',
              )}>
                {renderMemberMentionAvatar(selectedMemberMention, darkEmbedded)}
                <span className="truncate">@{selectedMemberMention.name}</span>
                <button
                  type="button"
                  onClick={() => onSelectedMemberMentionChange?.(null)}
                  className={clsx('ml-0.5 rounded-full p-0.5 transition-colors', darkEmbedded ? 'hover:bg-white/10' : 'hover:bg-black/5')}
                  aria-label={`移除 @${selectedMemberMention.name}`}
                  title="移除成员"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : null}
            {selectedKnowledgeMentions.map((item) => {
              const cover = String(item.cover || '').trim();
              return (
                <span
                  key={item.id}
                  className={clsx(
                    'group/knowledge inline-flex h-12 max-w-full items-center gap-2 rounded-xl border px-2 pr-1.5 text-xs',
                    darkEmbedded ? 'border-white/10 bg-white/[0.06] text-white/78' : 'border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-secondary))] text-[rgb(var(--color-text-secondary))]',
                  )}
                >
                  <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border', darkEmbedded ? 'border-white/10 bg-white/[0.06]' : 'border-[rgb(var(--color-border))] bg-white/80')}>
                    {cover ? (
                      <img src={resolveAssetUrl(cover)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      renderKnowledgeMentionIcon(item, clsx('h-4 w-4', darkEmbedded ? 'text-white/58' : 'text-[rgb(var(--color-text-tertiary))]'))
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className={clsx('block text-[10px] leading-3', darkEmbedded ? 'text-white/42' : 'text-[rgb(var(--color-text-tertiary))]')}>
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
        {showCompactAttachmentTray ? (
          <>
            <ComposerCompactAttachmentTray
              attachment={primaryAttachment}
              status={resolvedAttachmentStatus}
              darkEmbedded={darkEmbedded}
              onRemove={() => onClearAttachment?.()}
            />
            {textarea}
          </>
        ) : showAttachmentInMediaSlot ? (
          <div className={clsx(
            'flex items-start gap-5',
            variant === 'empty' ? 'px-8 pt-5 pb-0' : 'px-4 pt-3 pb-0',
          )}>
            {inlineAttachmentSlot}
            <div className="min-w-0 flex-1">
              {textarea}
            </div>
          </div>
        ) : primaryAttachment ? (
          <div className={wrapperClass}>
            <ComposerAttachmentPreview
              attachment={primaryAttachment}
              darkEmbedded={darkEmbedded}
              variant={variant}
              onRemove={() => onClearAttachment?.()}
            >
              {textarea}
            </ComposerAttachmentPreview>
          </div>
        ) : showInlineAttachmentPlaceholder ? (
          <div className={clsx(
            'flex items-start gap-5',
            variant === 'empty' ? 'px-8 pt-5 pb-0' : 'px-4 pt-3 pb-0',
          )}>
            {inlineAttachmentSlot}
            <div className="min-w-0 flex-1">
              {textarea}
            </div>
          </div>
        ) : textarea}

        <div className={clsx('flex items-center gap-2', variant === 'empty' ? 'px-2 pb-1' : 'px-1.5 pb-0.5')}>
          <div className="flex shrink-0 items-center gap-1">
            {showAttachmentButton && !showInlineAttachmentPlaceholder ? (
              <button
                type="button"
                onClick={() => void onPickAttachment?.()}
                disabled={disabled || isBusy || attachmentBusy}
                className={clsx('p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-45', subtleButtonClass)}
                title="添加文件"
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
                      <div className="px-3 py-2 text-sm text-text-tertiary">请先在设置里配置供应商</div>
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
                  darkEmbedded ? 'text-[rgb(var(--color-status-error)/0.8)] hover:bg-[rgb(var(--color-status-error)/0.1)]' : 'text-[rgb(var(--color-status-error))] hover:bg-[rgb(var(--color-danger-bg))]',
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
                  audioState === 'recording' ? 'text-[rgb(var(--color-status-error))] hover:opacity-80' : subtleButtonClass,
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
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin text-[rgb(var(--color-text-tertiary))]" /> : <ArrowUp className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </ChatComposerFrame>
    </form>
  );
});
