import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Components, UrlTransform } from 'react-markdown';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Music,
  UserRound,
  Video,
} from 'lucide-react';
import { ProcessTimeline, ProcessItem } from './ProcessTimeline';
import { SkillActivatedBadge, ThinkingIndicator } from './ThinkingBubble';
import { TodoList, PlanStep } from './TodoList';
import { resolveAssetUrl, isLocalAssetUrl } from '../utils/pathManager';
import { extractLocalAssetPathCandidate, isLocalAssetSource } from '../../shared/localAsset';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel, LiquidGlassMenuSeparator } from '@/components/ui/liquid-glass-menu';
import { StreamingMarkdown } from './chat/StreamingMarkdown';
import './chat-message.css';

const copyTextWithClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
};

const extractNodeText = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractNodeText).join('');
  if (React.isValidElement(value)) {
    return extractNodeText((value.props as { children?: React.ReactNode }).children);
  }
  return '';
};

const isVideoAssetUrl = (value: string): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['.mp4', '.webm', '.mov', '.m4v'].some((ext) => normalized.includes(ext));
};

const IMAGE_ATTACHMENT_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i;
const CHAT_VIDEO_MAX_HEIGHT = 512;
const DEFAULT_CHAT_VIDEO_ASPECT_RATIO = 16 / 9;

function ChatVideoPlayer({
  src,
  poster,
  className,
  title,
  onContextMenu,
}: {
  src: string;
  poster?: string;
  className?: string;
  title?: string;
  onContextMenu?: React.MouseEventHandler<HTMLVideoElement>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const posterSeekRef = useRef(false);
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_CHAT_VIDEO_ASPECT_RATIO);
  const [capturedPoster, setCapturedPoster] = useState('');
  const resolvedPoster = poster || capturedPoster || undefined;
  const shouldCapturePoster = !poster;

  useEffect(() => {
    setAspectRatio(DEFAULT_CHAT_VIDEO_ASPECT_RATIO);
    setCapturedPoster('');
    posterSeekRef.current = false;
  }, [src, poster]);

  const updateAspectRatio = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    const nextRatio = video.videoWidth / video.videoHeight;
    if (Number.isFinite(nextRatio) && nextRatio > 0) {
      setAspectRatio(nextRatio);
    }
  }, []);

  const capturePosterFrame = useCallback(() => {
    updateAspectRatio();
    if (!shouldCapturePoster || capturedPoster) return;
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setCapturedPoster(canvas.toDataURL('image/jpeg', 0.82));
    } catch {
      // Local/remote media may be unavailable to canvas; the player still renders normally.
    }
  }, [capturedPoster, shouldCapturePoster, updateAspectRatio]);

  const preparePosterFrame = useCallback(() => {
    updateAspectRatio();
    if (!shouldCapturePoster) return;
    const video = videoRef.current;
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 1;
    const targetTime = Math.min(0.5, Math.max(0, duration - 0.05));
    if (Math.abs(video.currentTime - targetTime) > 0.05) {
      try {
        posterSeekRef.current = true;
        video.currentTime = targetTime;
      } catch {
        capturePosterFrame();
      }
    } else {
      capturePosterFrame();
    }
  }, [capturePosterFrame, shouldCapturePoster, updateAspectRatio]);

  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0
    ? aspectRatio
    : DEFAULT_CHAT_VIDEO_ASPECT_RATIO;
  const maxWidth = `${Math.max(180, Math.round(CHAT_VIDEO_MAX_HEIGHT * safeAspectRatio))}px`;

  return (
    <div
      className={clsx('my-3 w-full overflow-hidden rounded-xl border border-border bg-black shadow-sm', className)}
      style={{ aspectRatio: safeAspectRatio, maxWidth }}
    >
      <video
        ref={videoRef}
        src={src}
        poster={resolvedPoster}
        controls
        preload="metadata"
        playsInline
        className="h-full w-full bg-black object-contain"
        onLoadedMetadata={updateAspectRatio}
        onLoadedData={preparePosterFrame}
        onSeeked={capturePosterFrame}
        onPlay={() => {
          const video = videoRef.current;
          if (posterSeekRef.current && video) {
            posterSeekRef.current = false;
            video.currentTime = 0;
          }
        }}
        onContextMenu={onContextMenu}
        title={title}
      />
    </div>
  );
}

// 当新增系统提示词或标签时，需要同步在此添加对应的过滤模式
const INTERNAL_PROTOCOL_BLOCKS = [
  // --- 内部协议 XML 标签（原有）---
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  /<activated_skill\b[\s\S]*?<\/activated_skill>/gi,

  // --- Anthropic 平台系统标签 ---
  /<system-reminder[\s\S]*?<\/system-reminder>/gi,
  /<local-command-caveat[\s\S]*?<\/local-command-caveat>/gi,
  /<task-notification[\s\S]*?<\/task-notification>/gi,

  // --- 配置注入标签（interactive_runtime_shared.rs）---
  /<redclaw_agent_md[\s\S]*?<\/redclaw_agent_md>/gi,
  /<redclaw_soul_md\b[\s\S]*?<\/redclaw_soul_md>/gi,
  /<redclaw_identity_md[\s\S]*?<\/redclaw_identity_md>/gi,
  /<redclaw_user_md[\s\S]*?<\/redclaw_user_md>/gi,
  /<redclaw_creator_profile_md[\s\S]*?<\/redclaw_creator_profile_md>/gi,
  /<redclaw_bootstrap[\s\S]*?<\/redclaw_bootstrap>/gi,

  // --- Bracket 风格协议块（有闭合）---
  /\[GenerationAgentContext\][\s\S]*?\[\/GenerationAgentContext\]/gi,
  /\[KnowledgeReferences\][\s\S]*?\[\/KnowledgeReferences\]/gi,
  /\[AssetReferences\][\s\S]*?\[\/AssetReferences\]/gi,

  // --- Bracket 风格协议块（无闭合，延伸到下一个大写节标题或文本末尾）---
  /\[SystemReminder[^\]]*\][\s\S]*?(?=\n\[[A-Z]|$)/gi,
  /\[Assistant Rules[^\]]*\][\s\S]*?(?=\n\[[A-Z]|$)/gi,
  /\[Available Skills\][\s\S]*?(?=\n\[[A-Z]|$)/gi,
  /\[Skills Location\][\s\S]*?(?=\n\[[A-Z]|$)/gi,
];

const stripInternalProtocolMarkup = (value: string): string => {
  let sanitized = String(value || '');
  for (const pattern of INTERNAL_PROTOCOL_BLOCKS) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized.replace(/\n{3,}/g, '\n\n').trim();
};

const stripTimelineCommentaryFromContent = (content: string, timeline: ProcessItem[]): string => {
  let remaining = String(content || '');
  for (const item of timeline) {
    if (item.type !== 'commentary') continue;
    const commentary = stripInternalProtocolMarkup(String(item.content || ''));
    if (!commentary) continue;
    if (remaining.startsWith(commentary)) {
      remaining = remaining.slice(commentary.length);
      continue;
    }
    const index = remaining.indexOf(commentary);
    if (index !== -1) {
      remaining = `${remaining.slice(0, index)}${remaining.slice(index + commentary.length)}`;
    }
  }
  return remaining.trimStart();
};

function InlineCopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text.trim()) return;
    const ok = await copyTextWithClipboard(text);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface-primary/92 px-1.5 py-0.5 text-[11px] text-text-tertiary shadow-sm transition-colors hover:border-border hover:bg-surface-primary hover:text-text-primary"
      title={label}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? '已复制' : label}</span>
    </button>
  );
}

function CopyableCodeBlock({
  children,
  codeProps,
}: {
  children: React.ReactNode;
  codeProps: Record<string, unknown>;
}) {
  const text = extractNodeText(children).replace(/\n$/, '');

  return (
    <div className="group relative my-3 w-full max-w-full overflow-hidden rounded-lg border border-border/70 bg-surface-secondary/45">
      <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <InlineCopyButton text={text} label="复制" />
      </div>
      <pre className="w-full max-w-full overflow-x-auto px-3 py-2.5 pr-14">
        <code className="font-mono text-sm" {...codeProps}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function CopyableBlockquote({ children }: { children: React.ReactNode }) {
  const text = extractNodeText(children).trim();

  return (
    <div className="group my-3 rounded-xl border border-border/80 bg-surface-secondary/40 p-3">
      <div className="mb-2 flex items-center justify-end">
        <InlineCopyButton text={text} label="复制引用" />
      </div>
      <blockquote className="border-l-2 border-accent-primary/45 pl-4 text-text-secondary">
        {children}
      </blockquote>
    </div>
  );
}

// Legacy types for compatibility (will be migrated)
export interface ToolEvent {
  id: string;
  callId: string;
  name: string;
  input: unknown;
  output?: { success: boolean; content: string };
  description?: string;
  status: 'running' | 'done' | 'failed';
}

export interface SkillEvent {
  name: string;
  description: string;
}

export interface ChatMessageMemberActor {
  type?: 'member';
  memberId: string;
  displayName: string;
  avatar?: string;
  memberSkillRef?: string;
}

export interface ChatKnowledgeReference {
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

export interface Message {
  id: string;
  role: 'user' | 'ai';
  messageType?: 'reply' | 'thinking';
  content: string;
  displayContent?: string;
  attachment?: {
    type: 'youtube-video';
    title: string;
    thumbnailUrl?: string;
    videoId?: string;
  } | {
    type: 'wander-references';
    title?: string;
    items: Array<{
      title: string;
      itemType: 'note' | 'video';
      tag?: string;
      folderPath?: string;
      summary?: string;
      cover?: string;
    }>;
  } | {
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
    intakeStatus?: string;
    capabilities?: Record<string, boolean | undefined>;
    deliveryPlan?: {
      mode?: string;
      toolPath?: string;
      toolName?: string;
      requiresTool?: boolean;
      reason?: string;
    };
    summary?: string;
    requiresMultimodal?: boolean;
  };
  attachments?: Array<{
    type: 'uploaded-file';
    name: string;
    attachmentId?: string;
    workspaceRelativePath?: string;
    toolPath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    inlineDataUrl?: string;
    thumbnailDataUrl?: string;
    thumbnailUrl?: string;
    kind?: string;
    mimeType?: string;
    size?: number;
    ext?: string;
    storageMode?: string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: string;
    intakeStatus?: string;
    capabilities?: Record<string, boolean | undefined>;
    deliveryPlan?: Record<string, unknown>;
    summary?: string;
    requiresMultimodal?: boolean;
    attachmentLifecycle?: string;
  }>;
  // New unified timeline
  timeline: ProcessItem[];
  // Plan steps
  plan?: PlanStep[];

  // Legacy fields (kept for compatibility during migration, but UI will prefer timeline)
  thinking?: string;
  tools: ToolEvent[];
  activatedSkill?: SkillEvent;

  isStreaming?: boolean;
  processingStartedAt?: number;
  processingFinishedAt?: number;
  suppressPendingIndicator?: boolean;
  memberActor?: ChatMessageMemberActor;
  memberMention?: ChatMessageMemberActor;
  knowledgeReferences?: ChatKnowledgeReference[];
}

export type ChatMessageLinkKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'manuscript'
  | 'document'
  | 'pdf'
  | 'html'
  | 'text'
  | 'archive'
  | 'web'
  | 'unknown';

export interface ChatMessageLinkTarget {
  href: string;
  label: string;
  kind: ChatMessageLinkKind;
  resolvedUrl: string;
  isLocal: boolean;
  localPathCandidate?: string;
  extension?: string;
  exists?: boolean;
  isDirectory?: boolean;
  mimeType?: string;
  sizeBytes?: number;
  previewText?: string;
  error?: string;
  sourceMessageId: string;
}

export type ChatMessageLinkRenderMode = 'default' | 'preview-card';

interface MessageItemProps {
  msg: Message;
  copiedMessageId: string | null;
  onCopyMessage: (id: string, content: string) => void;
  savingKnowledgeMessageId?: string | null;
  savedKnowledgeMessageId?: string | null;
  onSaveToKnowledge?: (message: Message, content: string) => void;
  workflowPlacement?: 'top' | 'bottom';
  workflowVariant?: 'default' | 'compact';
  workflowEmphasis?: 'default' | 'thoughts-first';
  workflowDisplayMode?: 'all' | 'thoughts-only';
  workflowAutoHideWhenComplete?: boolean;
  workflowFailureTone?: 'danger' | 'neutral';
  showAttachments?: boolean;
  linkRenderMode?: ChatMessageLinkRenderMode;
  onPreviewLink?: (target: ChatMessageLinkTarget) => void;
  activePreviewHref?: string | null;
}

interface ImageContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  src: string;
  actionSource: string;
}

interface PreviewImageItem {
  src: string;
  alt: string;
  actionSource: string;
}

interface PreviewImageState extends PreviewImageItem {
  items: PreviewImageItem[];
  index: number;
}

const CHAT_PREVIEW_IMAGE_SELECTOR = 'img[data-chat-preview-image="true"]';

const normalizePreviewImageItem = (item: PreviewImageItem): PreviewImageItem | null => {
  const src = String(item.src || '').trim();
  const actionSource = String(item.actionSource || item.src || '').trim();
  if (!src || !actionSource) return null;
  return {
    src,
    alt: String(item.alt || ''),
    actionSource,
  };
};

const previewImageItemFromElement = (element: HTMLImageElement): PreviewImageItem | null => (
  normalizePreviewImageItem({
    src: element.dataset.previewSrc || element.currentSrc || element.src || '',
    alt: element.dataset.previewAlt || element.alt || '',
    actionSource: element.dataset.previewActionSource || element.dataset.previewSrc || element.currentSrc || element.src || '',
  })
);

function formatProcessingElapsed(totalMs: number): string {
  const safeMs = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function ProcessingTimerBadge({
  startedAt,
  finishedAt,
  isStreaming,
}: {
  startedAt: number;
  finishedAt?: number;
  isStreaming?: boolean;
}) {
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isStreaming) return;
    setLiveNow(Date.now());
    const timer = window.setInterval(() => {
      setLiveNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming, startedAt]);

  const endAt = isStreaming ? liveNow : (finishedAt ?? liveNow);
  const elapsedLabel = formatProcessingElapsed(endAt - startedAt);

  return (
    <div className="chat-processing-timer" aria-live="off">
      <span className="chat-processing-timer__label">已处理</span>
      <span className="chat-processing-timer__value">{elapsedLabel}</span>
    </div>
  );
}

const transformMarkdownUrl: UrlTransform = (url) => {
  const value = String(url || '').trim();
  if (!value) return '';

  if (isLocalAssetUrl(value)) {
    return resolveAssetUrl(value);
  }

  // Keep relative URLs and common safe protocols.
  if (/^\.{0,2}\//.test(value) || /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(value)) {
    return value;
  }
  if (/^(https?:|mailto:|tel:|data:)/i.test(value)) {
    return value;
  }

  return '';
};

const transformMarkdownUrlForPreviewCards: UrlTransform = (url, key, node) => {
  const value = String(url || '').trim();
  if (!value) return '';
  if (isLocalAssetUrl(value)) return value;
  if (isPreviewVirtualPath(value) || isPreviewRelativePath(value)) return value;
  return transformMarkdownUrl(value, key, node);
};

const IMAGE_LINK_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff']);
const VIDEO_LINK_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv']);
const AUDIO_LINK_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'oga', 'opus']);
const DOCUMENT_LINK_EXTENSIONS = new Set<string>();
const TEXT_LINK_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'srt',
  'vtt',
  'diff',
  'patch',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'config',
  'env',
  'xml',
  'log',
  'sql',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'rs',
  'py',
  'go',
  'java',
  'c',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'hh',
  'hxx',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'scala',
  'r',
  'lua',
  'pl',
  'pm',
  'dart',
  'dockerfile',
  'lock',
]);
const ARCHIVE_LINK_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);
const PREVIEW_VIRTUAL_PATH_RE = /^(workspace|knowledge|manuscripts|media|cover|redclaw):\/\/.+/i;
const PREVIEW_PATH_LINKIFY_EXT_PATTERN = '(?:png|jpe?g|webp|gif|bmp|svg|avif|ico|tiff?|mp4|webm|mov|m4v|mkv|avi|ogv|mp3|wav|m4a|flac|aac|ogg|oga|opus|pdf|html?|md|markdown|thrive|txt|srt|vtt|diff|patch|json|csv|tsv|ya?ml|toml|ini|conf|config|env|xml|log|sql|sh|bash|zsh|fish|ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|cpp|cc|cxx|h|hpp|hh|hxx|css|scss|sass|less|vue|svelte|astro|rb|php|swift|kt|kts|scala|r|lua|pl|pm|dart|dockerfile|lock|zip|rar|7z|tar|gz|tgz)';
const PREVIEW_PATH_LINKIFY_RE = new RegExp(
  String.raw`(^|[\s([{])((?:(?:workspace|knowledge|manuscripts|media|cover|redclaw):\/\/|file:\/\/|local-file:\/\/|redbox-asset:\/\/asset\/|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[A-Za-z0-9._@ -]+[\\/])[^<>"'\n\r]*?\.${PREVIEW_PATH_LINKIFY_EXT_PATTERN})(?=$|[\s)\]},.!?;:'">])`,
  'gi',
);

const isPreviewVirtualPath = (value: string): boolean => PREVIEW_VIRTUAL_PATH_RE.test(String(value || '').trim());

const isPreviewRelativePath = (value: string): boolean => {
  const raw = String(value || '').trim();
  if (!raw || /^https?:/i.test(raw)) return false;
  if (raw.includes('..')) return false;
  return /\.(png|jpe?g|webp|gif|bmp|svg|avif|ico|tiff?|mp4|webm|mov|m4v|mkv|avi|ogv|mp3|wav|m4a|flac|aac|ogg|oga|opus|pdf|html?|md|markdown|thrive|txt|srt|vtt|diff|patch|json|csv|tsv|ya?ml|toml|ini|conf|config|env|xml|log|sql|sh|bash|zsh|fish|ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|cpp|cc|cxx|h|hpp|hh|hxx|css|scss|sass|less|vue|svelte|astro|rb|php|swift|kt|kts|scala|r|lua|pl|pm|dart|dockerfile|lock|zip|rar|7z|tar|gz|tgz)(?:[?#].*)?$/i.test(raw);
};

const escapeMarkdownLinkLabel = (value: string): string => (
  getPathFilename(value).replace(/[[\]]/g, '\\$&') || value.replace(/[[\]]/g, '\\$&')
);

const shouldSkipPathLinkifyLine = (line: string): boolean => (
  /]\([^)]+(?:\)|$)/.test(line) || /!\[[^\]]*]\([^)]+(?:\)|$)/.test(line)
);

const linkifyPreviewFilePaths = (content: string): string => {
  if (!content) return content;
  let inFence = false;
  return content.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || shouldSkipPathLinkifyLine(line)) return line;
    return line.replace(PREVIEW_PATH_LINKIFY_RE, (match, prefix: string, pathValue: string) => {
      const trimmedPath = String(pathValue || '').trim();
      if (!trimmedPath || trimmedPath.startsWith('://')) return match;
      return `${prefix}[${escapeMarkdownLinkLabel(trimmedPath)}](<${trimmedPath}>)`;
    });
  }).join('\n');
};

const safeDecodeLabel = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripQueryAndHash = (value: string): string => {
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  const indexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  if (indexes.length === 0) return value;
  return value.slice(0, Math.min(...indexes));
};

const getPathFilename = (value: string): string => {
  const clean = stripQueryAndHash(value).replace(/\\/g, '/').replace(/\/+$/, '');
  const segment = clean.split('/').filter(Boolean).pop() || clean;
  return safeDecodeLabel(segment);
};

const getUrlFilename = (value: string): string => {
  try {
    const parsed = new URL(value);
    return getPathFilename(parsed.pathname) || parsed.hostname;
  } catch {
    return getPathFilename(value);
  }
};

const getExtension = (value: string): string | undefined => {
  const filename = getPathFilename(value);
  const match = /\.([a-zA-Z0-9]{1,12})$/.exec(filename);
  return match?.[1]?.toLowerCase();
};

const inferMessageLinkKind = (href: string, localPathCandidate?: string): ChatMessageLinkKind => {
  const source = localPathCandidate || href;
  const extension = getExtension(source);
  if (!extension) return /^https?:\/\//i.test(href) ? 'web' : 'unknown';
  if (IMAGE_LINK_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_LINK_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_LINK_EXTENSIONS.has(extension)) return 'audio';
  if (extension === 'thrive') return 'manuscript';
  if (extension === 'pdf') return 'pdf';
  if (DOCUMENT_LINK_EXTENSIONS.has(extension)) return 'document';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (TEXT_LINK_EXTENSIONS.has(extension)) return 'text';
  if (ARCHIVE_LINK_EXTENSIONS.has(extension)) return 'archive';
  return /^https?:\/\//i.test(href) ? 'web' : 'unknown';
};

const getMessageLinkKindLabel = (target: ChatMessageLinkTarget): string => {
  const base = (() => {
    switch (target.kind) {
      case 'image':
        return '图片';
      case 'video':
        return '视频';
      case 'audio':
        return '音频';
      case 'manuscript':
        return '稿件';
      case 'document':
        return '文档';
      case 'web':
      case 'html':
        return '网页';
      case 'archive':
        return '压缩包';
      case 'pdf':
      case 'text':
        return '文档';
      default:
        return '文件';
    }
  })();
  return target.extension ? `${base} · ${target.extension.toUpperCase()}` : base;
};

const getMessageLinkIcon = (kind: ChatMessageLinkKind) => {
  switch (kind) {
    case 'image':
      return ImageIcon;
    case 'video':
      return Video;
    case 'audio':
      return Music;
    case 'manuscript':
    case 'document':
      return FileText;
    case 'web':
    case 'html':
      return Globe;
    case 'archive':
      return Archive;
    case 'pdf':
    case 'text':
      return FileText;
    default:
      return File;
  }
};

const isPreviewCardCandidate = (href: string): boolean => {
  const value = String(href || '').trim();
  if (!value) return false;
  if (/^(mailto:|tel:|javascript:|vbscript:)/i.test(value)) return false;
  if (isLocalAssetSource(value)) return true;
  if (isPreviewVirtualPath(value)) return true;
  if (isPreviewRelativePath(value)) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
};

const buildMessageLinkTarget = (
  href: string | undefined,
  children: React.ReactNode,
  sourceMessageId: string,
): ChatMessageLinkTarget | null => {
  const rawHref = String(href || '').trim();
  if (!isPreviewCardCandidate(rawHref)) return null;
  const localPathCandidate = isLocalAssetSource(rawHref)
    ? extractLocalAssetPathCandidate(rawHref)
    : (isPreviewVirtualPath(rawHref) || isPreviewRelativePath(rawHref) ? rawHref : '');
  const resolvedUrl = isLocalAssetSource(rawHref) ? resolveAssetUrl(rawHref) : rawHref;
  const kind = inferMessageLinkKind(rawHref, localPathCandidate || undefined);
  const extension = getExtension(localPathCandidate || rawHref);
  const explicitLabel = extractNodeText(children).trim();
  const fallbackLabel = localPathCandidate ? getPathFilename(localPathCandidate) : getUrlFilename(rawHref);
  const label = explicitLabel && explicitLabel !== rawHref ? explicitLabel : (fallbackLabel || rawHref);
  return {
    href: rawHref,
    label,
    kind,
    resolvedUrl,
    isLocal: Boolean(localPathCandidate),
    localPathCandidate: localPathCandidate || undefined,
    extension,
    sourceMessageId,
  };
};

function MessageLinkPreviewCard({
  target,
  isActive,
  onOpen,
}: {
  target: ChatMessageLinkTarget;
  isActive: boolean;
  onOpen: (target: ChatMessageLinkTarget) => void;
}) {
  const Icon = getMessageLinkIcon(target.kind);
  const meta = getMessageLinkKindLabel(target);

  const handleOpen = () => {
    onOpen(target);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleOpen();
  };

  if (target.kind === 'audio') {
    return (
      <span className="my-2 block w-full max-w-[760px] rounded-2xl border border-border/80 bg-surface-primary/85 px-4 py-3 shadow-sm">
        <span className="mb-2 flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-secondary/80 text-text-tertiary">
            <Music className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold leading-5 text-text-primary">
              {target.label}
            </span>
            <span className="mt-0.5 block truncate text-xs font-medium text-text-tertiary">
              {meta}
            </span>
          </span>
          <button
            type="button"
            onClick={handleOpen}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-surface-primary/90 text-text-secondary transition-colors hover:text-accent-primary"
            aria-label="打开音频文件"
            title="打开音频文件"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        </span>
        <audio controls src={target.resolvedUrl} className="w-full" preload="metadata" />
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
      title={target.localPathCandidate || target.href}
      className={clsx(
        'my-2 flex w-full max-w-[760px] cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-left shadow-sm transition-colors',
        'border-border/80 bg-surface-primary/85 hover:border-accent-primary/30 hover:bg-surface-primary',
        isActive && 'border-accent-primary/45 bg-accent-primary/5',
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary/80 text-text-tertiary">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold leading-5 text-text-primary">
          {target.label}
        </span>
        <span className="mt-1 block truncate text-xs font-medium text-text-tertiary">
          {meta}
        </span>
      </span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/70 bg-surface-primary/90 px-3 py-2 text-sm font-semibold text-text-secondary">
        <ExternalLink className="h-4 w-4" />
        <span>打开</span>
        <ChevronDown className="h-4 w-4 text-text-tertiary" />
      </span>
    </span>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  code({ node, inline, className, children, ...props }: any) {
    return inline ? (
      <code className="bg-surface-secondary px-1.5 py-0.5 rounded text-accent-primary font-mono text-sm" {...props}>
        {children}
      </code>
    ) : (
      <CopyableCodeBlock codeProps={props}>{children}</CopyableCodeBlock>
    );
  },
  blockquote({ children }: any) {
    return <CopyableBlockquote>{children}</CopyableBlockquote>;
  },
  table({ children }: any) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="min-w-full border-collapse border border-border text-sm">
          {children}
        </table>
      </div>
    );
  },
  th({ children }: any) {
    return <th className="border border-border bg-surface-secondary px-4 py-2 text-left font-medium">{children}</th>;
  },
  td({ children }: any) {
    return <td className="border border-border px-4 py-2">{children}</td>;
  },
  a({ children, href }: any) {
    return <a href={href} className="text-accent-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  ul({ children }: any) {
    return <ul className="list-disc list-outside ml-5 my-2 space-y-1">{children}</ul>;
  },
  ol({ children }: any) {
    return <ol className="list-decimal list-outside ml-5 my-2 space-y-1">{children}</ol>;
  },
  p({ children }: any) {
    return <p className="my-2 break-words whitespace-pre-wrap">{children}</p>;
  },
};

export const MessageItem = memo(({
  msg,
  copiedMessageId,
  onCopyMessage,
  savingKnowledgeMessageId = null,
  savedKnowledgeMessageId = null,
  onSaveToKnowledge,
  workflowPlacement = 'bottom',
  workflowVariant = 'default',
  workflowEmphasis = 'default',
  workflowDisplayMode = 'all',
  workflowAutoHideWhenComplete = false,
  workflowFailureTone = 'danger',
  showAttachments = true,
  linkRenderMode = 'default',
  onPreviewLink,
  activePreviewHref = null,
}: MessageItemProps) => {
  const isUser = msg.role === 'user';
  const isThinkingMessage = !isUser && msg.messageType === 'thinking';
  const sanitizedAssistantContent = !isUser
    ? stripInternalProtocolMarkup(String(msg.content || ''))
    : String(msg.content || '');
  const userCopyContent = useMemo(() => {
    if (!isUser) return '';
    const display = String(msg.displayContent || '').trim();
    if (display) return display;
    const content = stripInternalProtocolMarkup(String(msg.content || '')).trim();
    if (content) return content;
    const attachmentNames = (msg.attachments || [])
      .map((attachment) => String(attachment.name || '').trim())
      .filter(Boolean);
    if (attachmentNames.length > 0) return attachmentNames.join('\n');
    if (msg.attachment?.type === 'uploaded-file') {
      return String(msg.attachment.name || '').trim();
    }
    return '';
  }, [isUser, msg.attachment, msg.attachments, msg.content, msg.displayContent]);
  const aiContentRef = useRef<HTMLDivElement | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImageState | null>(null);
  const [imageMenu, setImageMenu] = useState<ImageContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    src: '',
    actionSource: '',
  });
  const filteredTimeline = useMemo(
    () => workflowDisplayMode === 'thoughts-only'
      ? (msg.timeline || []).filter((item) => item.type === 'thought')
      : (msg.timeline || []),
    [msg.timeline, workflowDisplayMode],
  );
  const timelineHasThought = useMemo(
    () => filteredTimeline.some((item) => item.type === 'thought' && String(item.content || '').trim()),
    [filteredTimeline],
  );
  const hasTimelineNarration = useMemo(
    () => filteredTimeline.some(
      (item) => (item.type === 'thought' || item.type === 'commentary') && String(item.content || '').trim(),
    ),
    [filteredTimeline],
  );
  const visibleAssistantContent = useMemo(
    () => (!isUser ? stripTimelineCommentaryFromContent(sanitizedAssistantContent, filteredTimeline) : sanitizedAssistantContent),
    [filteredTimeline, isUser, sanitizedAssistantContent],
  );
  const showWorkflowDetails = workflowDisplayMode !== 'thoughts-only';
  const hasAssistantResponseContent = !isUser && Boolean(visibleAssistantContent);
  const showPendingThinkingIndicator = !isUser
    && !isThinkingMessage
    && !msg.suppressPendingIndicator
    && !hasTimelineNarration
    && Boolean(msg.isStreaming && !hasAssistantResponseContent);
  const showProcessingTimer = !isUser && !isThinkingMessage && typeof msg.processingStartedAt === 'number' && Number.isFinite(msg.processingStartedAt);
  const hasMessageAttachments = Boolean(
    (msg.attachments && msg.attachments.length > 0)
      || msg.attachment?.type === 'uploaded-file'
      || msg.attachment?.type === 'youtube-video'
      || msg.attachment?.type === 'wander-references'
      || (msg.knowledgeReferences && msg.knowledgeReferences.length > 0),
  );
  const hasRenderableMessageContent = isUser
    ? Boolean(msg.displayContent || msg.content || hasMessageAttachments || (msg.isStreaming && !msg.thinking))
    : hasAssistantResponseContent || showPendingThinkingIndicator;
  const shouldAutoHideWorkflow = workflowAutoHideWhenComplete && !msg.isStreaming && hasAssistantResponseContent;
  const showWorkflowOnTop = workflowPlacement === 'top';
  const latestTimelineThought = !isUser
    ? [...(msg.timeline || [])]
        .reverse()
        .find((item) => item.type === 'thought' && String(item.content || '').trim())
    : undefined;
  const activeThoughtContent = !isUser
    ? stripInternalProtocolMarkup(String(latestTimelineThought?.content || msg.thinking || ''))
    : '';
  const displayTimeline = useMemo<ProcessItem[]>(() => {
    if (!activeThoughtContent || timelineHasThought) return filteredTimeline;
    return [{
      id: `${msg.id}-fallback-thought`,
      type: 'thought',
      content: activeThoughtContent,
      status: msg.isStreaming ? 'running' : 'done',
      timestamp: msg.processingStartedAt || 0,
    }, ...filteredTimeline];
  }, [activeThoughtContent, filteredTimeline, msg.id, msg.isStreaming, msg.processingStartedAt, timelineHasThought]);
  const showTimeline = !shouldAutoHideWorkflow && !isUser && !isThinkingMessage && displayTimeline.length > 0;
  const showLegacyWorkflow = !isUser
    && !isThinkingMessage
    && !shouldAutoHideWorkflow
    && displayTimeline.length === 0
    && (msg.thinking || (showWorkflowDetails && (msg.tools.length > 0 || msg.activatedSkill)));
  const assistantMemberActor = !isUser ? msg.memberActor : undefined;

  useEffect(() => {
    if (!imageMenu.visible) return;
    const closeMenu = () => setImageMenu((prev) => ({ ...prev, visible: false }));
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, [imageMenu.visible]);

  const showPreviewImageAt = useCallback((index: number) => {
    setPreviewImage((current) => {
      if (!current || current.items.length === 0) return current;
      const count = current.items.length;
      const nextIndex = ((index % count) + count) % count;
      const next = current.items[nextIndex];
      return {
        ...next,
        items: current.items,
        index: nextIndex,
      };
    });
  }, []);

  useEffect(() => {
    if (!previewImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPreviewImage(null);
        return;
      }
      if (previewImage.items.length <= 1) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPreviewImageAt(previewImage.index - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        showPreviewImageAt(previewImage.index + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewImage, showPreviewImageAt]);

  const openImageMenu = useCallback((x: number, y: number, source: string, actionSource?: string) => {
    const normalized = resolveAssetUrl(String(source || '').trim());
    const rawActionSource = String(actionSource || source || '').trim();
    if (!normalized || !rawActionSource) return;
    setImageMenu({
      visible: true,
      x,
      y,
      src: normalized,
      actionSource: rawActionSource,
    });
  }, []);

  const openPreviewImage = useCallback((
    event: React.MouseEvent<HTMLImageElement>,
    item: PreviewImageItem,
  ) => {
    const fallback = normalizePreviewImageItem(item);
    if (!fallback) return;
    const nodes = Array.from(document.querySelectorAll<HTMLImageElement>(CHAT_PREVIEW_IMAGE_SELECTOR));
    const items = nodes
      .map(previewImageItemFromElement)
      .filter((candidate): candidate is PreviewImageItem => Boolean(candidate));
    let index = nodes.indexOf(event.currentTarget);
    if (index < 0 || !items[index]) {
      index = items.findIndex((candidate) => (
        candidate.src === fallback.src && candidate.actionSource === fallback.actionSource
      ));
    }
    const nextItems = items.length > 0 ? items : [fallback];
    if (index < 0 || !nextItems[index]) {
      nextItems.push(fallback);
      index = nextItems.length - 1;
    }
    setPreviewImage({
      ...nextItems[index],
      items: nextItems,
      index,
    });
  }, []);

  const handleImageContextMenu = useCallback((
    event: React.MouseEvent<HTMLImageElement>,
    source: string,
    actionSource?: string,
  ) => {
    event.preventDefault();
    openImageMenu(event.clientX, event.clientY, source, actionSource);
  }, [openImageMenu]);

  const handleMediaContextMenu = useCallback((
    event: React.MouseEvent<HTMLElement>,
    source: string,
    actionSource?: string,
  ) => {
    event.preventDefault();
    openImageMenu(event.clientX, event.clientY, source, actionSource);
  }, [openImageMenu]);

  const handleSaveAs = async () => {
    if (!imageMenu.actionSource) return;
    try {
      const defaultName = getUrlFilename(imageMenu.actionSource) || getUrlFilename(imageMenu.src) || `generated-media-${Date.now()}`;
      const result = await window.ipcRenderer.files.saveAs({
        source: imageMenu.actionSource,
        defaultName,
      }) as { success?: boolean; error?: string; canceled?: boolean };
      if (!result?.success && !result?.canceled) {
        throw new Error(result?.error || '保存失败');
      }
    } catch (error) {
      console.error('Failed to save media:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleShowInFolder = async () => {
    if (!imageMenu.actionSource) return;
    try {
      const result = await window.ipcRenderer.files.showInFolder({ source: imageMenu.actionSource }) as {
        success?: boolean;
        error?: string;
      };
      if (!result?.success) {
        throw new Error(result?.error || '打开文件夹失败');
      }
    } catch (error) {
      console.error('Failed to show media in folder:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleCopyImage = async () => {
    if (!imageMenu.actionSource) return;
    try {
      const result = await window.ipcRenderer.files.copyImage({ source: imageMenu.actionSource }) as {
        success?: boolean;
        error?: string;
      };
      if (!result?.success) {
        throw new Error(result?.error || '复制图片失败');
      }
    } catch (error) {
      console.error('Failed to copy media image:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleDownloadImage = async (item: PreviewImageItem) => {
    const source = String(item.actionSource || item.src || '').trim();
    if (!source) return;
    try {
      const defaultName = getUrlFilename(source) || getUrlFilename(item.src) || `generated-media-${Date.now()}`;
      const result = await window.ipcRenderer.files.downloadToDownloads({
        source,
        defaultName,
      });
      if (!result?.success) {
        throw new Error(result?.error || '下载失败');
      }
    } catch (error) {
      console.error('Failed to download media image:', error);
    }
  };

  const markdownComponents = useMemo<Components>(() => ({
    ...MARKDOWN_COMPONENTS,
    a({ children, href }: any) {
      const target = linkRenderMode === 'preview-card' && !isUser && onPreviewLink
        ? buildMessageLinkTarget(href, children, msg.id)
        : null;
      if (target) {
        const isActive = activePreviewHref === target.href
          || activePreviewHref === target.resolvedUrl
          || (!!target.localPathCandidate && activePreviewHref === target.localPathCandidate);
        return (
          <MessageLinkPreviewCard
            target={target}
            isActive={isActive}
            onOpen={onPreviewLink}
          />
        );
      }
      return <a href={href} className="text-accent-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    img({ src, alt }: any) {
      const rawSource = String(src || '').trim();
      const mediaUrl = resolveAssetUrl(rawSource);
      if (!mediaUrl) return <span className="text-xs text-text-tertiary">资源地址无效</span>;
      if (isVideoAssetUrl(mediaUrl)) {
        return (
          <ChatVideoPlayer
            src={mediaUrl}
            onContextMenu={(event) => handleMediaContextMenu(event, mediaUrl, rawSource)}
            title="右键复制或在文件夹中打开"
          />
        );
      }
      return (
        <img
          src={mediaUrl}
          alt={alt || ''}
          data-chat-preview-image="true"
          data-preview-src={mediaUrl}
          data-preview-alt={alt || ''}
          data-preview-action-source={rawSource || mediaUrl}
          className="my-3 max-h-[28rem] w-auto max-w-full cursor-zoom-in rounded-xl border border-border bg-surface-secondary object-contain shadow-sm"
          onClick={(event) => openPreviewImage(event, { src: mediaUrl, alt: alt || '', actionSource: rawSource || mediaUrl })}
          onContextMenu={(event) => handleImageContextMenu(event, mediaUrl, rawSource)}
          title="点击预览，右键复制或在文件夹中打开"
        />
      );
    },
  }), [activePreviewHref, handleImageContextMenu, handleMediaContextMenu, isUser, linkRenderMode, msg.id, onPreviewLink, openPreviewImage]);
  const markdownUrlTransform = linkRenderMode === 'preview-card'
    ? transformMarkdownUrlForPreviewCards
    : transformMarkdownUrl;
  const renderedAssistantContent = useMemo(() => (
    linkRenderMode === 'preview-card' && !isUser
      ? linkifyPreviewFilePaths(visibleAssistantContent)
      : visibleAssistantContent
  ), [isUser, linkRenderMode, visibleAssistantContent]);

  const renderPreviewAwareMarkdownContent = useCallback((content: string) => (
    linkRenderMode === 'preview-card' && !isUser
      ? linkifyPreviewFilePaths(content)
      : content
  ), [isUser, linkRenderMode]);

  const isUploadedImageAttachment = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
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

    return kind === 'image' || mimeType.startsWith('image/') || IMAGE_ATTACHMENT_EXT_RE.test(source);
  }, []);

  const isUploadedVideoAttachment = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
    const kind = String(attachment.kind || '').trim().toLowerCase();
    const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
    const ext = String(attachment.ext || '').trim().replace(/^\./, '').toLowerCase();
    return kind === 'video' || mimeType.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes(ext);
  }, []);

  const resolveUploadedAttachmentSource = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
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
    return preferred.startsWith('data:') ? preferred : resolveAssetUrl(preferred);
  }, []);

  const resolveUploadedAttachmentActionSource = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => (
    String(
      attachment.inlineDataUrl
        || attachment.localUrl
        || attachment.absolutePath
        || attachment.originalAbsolutePath
        || '',
    ).trim()
  ), []);

  const resolveUploadedAttachmentPoster = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
    const preferred = String(
      attachment.thumbnailDataUrl
        || attachment.thumbnailUrl
        || '',
    ).trim();
    if (!preferred) return '';
    return preferred.startsWith('data:') ? preferred : resolveAssetUrl(preferred);
  }, []);

  const renderYoutubeCard = (card: { title: string; thumbnailUrl?: string }) => (
    <div className="bg-white/10 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 p-2.5">
        {card.thumbnailUrl ? (
          <img
            src={resolveAssetUrl(card.thumbnailUrl)}
            alt={card.title}
            className="w-20 h-12 object-cover rounded"
          />
        ) : (
          <div className="w-20 h-12 bg-red-600 rounded flex items-center justify-center">
            <span className="text-white text-xl">▶</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs opacity-70">YouTube 视频</div>
          <div className="text-sm font-medium truncate" title={card.title}>
            {card.title.length > 18 ? `${card.title.substring(0, 18)}...` : card.title}
          </div>
        </div>
      </div>
    </div>
  );

  const renderWanderReferenceCards = (attachment: Extract<NonNullable<Message['attachment']>, { type: 'wander-references' }>) => (
    <div className="mt-2 w-full max-w-[540px] rounded-2xl border border-border bg-surface-primary/95 p-2 shadow-sm">
      <div className="px-1 pb-2 text-[11px] font-medium text-text-tertiary">
        {attachment.title || '参考素材'}
      </div>
      <div className="space-y-2">
        {attachment.items.slice(0, 3).map((item, index) => (
          <div
            key={`${item.folderPath || item.title}-${index}`}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface-secondary/60 p-2.5"
          >
            {item.cover ? (
              <img
                src={resolveAssetUrl(item.cover)}
                alt={item.title}
                className="h-14 w-14 rounded-lg object-cover shrink-0"
              />
            ) : (
              <div className="h-14 w-14 rounded-lg bg-surface-secondary border border-border flex items-center justify-center text-lg shrink-0">
                {item.itemType === 'video' ? '▶' : '📝'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                <span>{item.itemType === 'video' ? '视频笔记' : '图文笔记'}</span>
                {item.tag && <span className="rounded-full bg-accent-primary/10 px-1.5 py-0.5 text-accent-primary">{item.tag}</span>}
              </div>
              <div className="mt-1 truncate text-sm font-medium text-text-primary" title={item.title}>
                {item.title}
              </div>
              {item.summary && (
                <div className="mt-1 line-clamp-2 text-xs text-text-secondary">
                  {item.summary}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const knowledgeKindLabel = (item: ChatKnowledgeReference): string => {
    const sourceKind = String(item.sourceKind || '').trim();
    if (sourceKind === 'youtube-video' || sourceKind === 'youtube' || sourceKind === 'video') return '视频';
    if (sourceKind === 'document-source' || sourceKind === 'document') return '文档';
    if (sourceKind === 'redbook-note' || sourceKind === 'note') return '笔记';
    return sourceKind || '知识';
  };

  const renderKnowledgeIcon = (item: ChatKnowledgeReference) => {
    const sourceKind = String(item.sourceKind || '').trim();
    if (sourceKind === 'youtube-video' || sourceKind === 'youtube' || sourceKind === 'video') {
      return <Video className="h-4 w-4" />;
    }
    if (sourceKind === 'document-source' || sourceKind === 'document') {
      return <FileText className="h-4 w-4" />;
    }
    return <Archive className="h-4 w-4" />;
  };

  const renderKnowledgeReferenceCards = (items?: ChatKnowledgeReference[]) => {
    const references = (items || []).filter((item) => item.id || item.title);
    if (references.length === 0) return null;
    return (
      <div className="mt-2 flex w-full flex-wrap justify-end gap-2">
        {references.slice(0, 6).map((item) => {
          const cover = String(item.cover || '').trim();
          return (
            <div
              key={item.id || item.title}
              className="inline-flex h-14 max-w-[min(100%,320px)] items-center gap-2 rounded-xl border border-border bg-surface-primary/95 px-2 py-1.5 shadow-sm"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-secondary text-text-tertiary">
                {cover ? (
                  <img src={resolveAssetUrl(cover)} alt="" className="h-full w-full object-cover" />
                ) : (
                  renderKnowledgeIcon(item)
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-text-tertiary">
                  <span className="truncate">{knowledgeKindLabel(item)}</span>
                  {item.hasTranscript ? <span className="shrink-0">有转录</span> : null}
                </div>
                <div className="mt-0.5 truncate text-sm font-medium leading-5 text-text-primary" title={item.title}>
                  {item.title || '未命名内容'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderUploadedFileCard = (attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
    if (isUploadedVideoAttachment(attachment)) {
      const actionSource = resolveUploadedAttachmentActionSource(attachment);
      const videoSource = actionSource ? resolveAssetUrl(actionSource) : '';
      const posterSource = resolveUploadedAttachmentPoster(attachment);
      if (videoSource) {
        return (
          <ChatVideoPlayer
            src={videoSource}
            poster={posterSource || undefined}
            onContextMenu={(event) => handleMediaContextMenu(event, videoSource, actionSource)}
            title={attachment.name}
          />
        );
      }
    }
    const imageSrc = isUploadedImageAttachment(attachment)
      ? resolveUploadedAttachmentSource(attachment)
      : '';
    const actionSource = resolveUploadedAttachmentActionSource(attachment);
    if (imageSrc) {
      return (
        <div className="mt-2">
          <img
            src={imageSrc}
            alt={attachment.name}
            data-chat-preview-image="true"
            data-preview-src={imageSrc}
            data-preview-alt={attachment.name}
            data-preview-action-source={actionSource || imageSrc}
            className="h-24 w-24 cursor-zoom-in rounded-2xl border border-border bg-surface-secondary object-cover shadow-sm"
            onClick={(event) => openPreviewImage(event, { src: imageSrc, alt: attachment.name, actionSource: actionSource || imageSrc })}
            onContextMenu={(event) => handleImageContextMenu(event, imageSrc, actionSource)}
            title={attachment.name}
          />
        </div>
      );
    }

    return (
      <div className="mt-2 w-full max-w-[520px] rounded-xl border border-border bg-surface-primary/90 p-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-surface-secondary border border-border flex items-center justify-center text-sm">
            📎
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-text-tertiary">上传文件</div>
            <div className="mt-0.5 truncate text-sm font-medium text-text-primary" title={attachment.name}>
              {attachment.name}
            </div>
            <div className="mt-1 text-[11px] text-text-tertiary flex flex-wrap gap-x-2 gap-y-1">
              {attachment.kind && <span>类型: {attachment.kind}</span>}
              {typeof attachment.size === 'number' && <span>大小: {Math.max(0, Math.round(attachment.size / 1024))} KB</span>}
              {attachment.ext && <span>.{String(attachment.ext).replace(/^\./, '')}</span>}
              {attachment.storageMode === 'staged' && <span>已暂存</span>}
              {attachment.directUploadEligible && <span>可直传</span>}
            </div>
            {attachment.summary && (
              <div className="mt-1.5 line-clamp-2 text-xs text-text-secondary">
                {attachment.summary}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderMemberActorAvatar = (actor: ChatMessageMemberActor) => {
    const avatar = String(actor.avatar || '').trim();
    const name = String(actor.displayName || '').trim();
    if (avatar && /^(https?:|file:|data:|local-file:|asset:)/i.test(avatar)) {
      return (
        <img
          src={resolveAssetUrl(avatar)}
          alt=""
          className="h-7 w-7 shrink-0 rounded-full border border-border bg-surface-secondary object-cover"
        />
      );
    }
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-secondary text-[12px] font-semibold text-text-secondary">
        {name.slice(0, 1).toUpperCase() || <UserRound className="h-3.5 w-3.5" />}
      </span>
    );
  };

  const renderTimelineWorkflow = (timeline: ProcessItem[]) => {
    const nodes: React.ReactNode[] = [];
    let statusGroup: ProcessItem[] = [];

    const flushStatusGroup = () => {
      if (statusGroup.length === 0) return;
      const group = statusGroup;
      statusGroup = [];
      nodes.push(
        <ProcessTimeline
          key={`status-${nodes.length}-${group[0]?.id || 'group'}`}
          items={group}
          isStreaming={!!msg.isStreaming}
          variant={workflowVariant}
          failureTone={workflowFailureTone}
        />,
      );
    };

    timeline.forEach((item) => {
      if (item.type !== 'thought' && item.type !== 'commentary') {
        statusGroup.push(item);
        return;
      }
      flushStatusGroup();
      const thoughtContent = stripInternalProtocolMarkup(String(item.content || ''));
      if (!thoughtContent) return;
      nodes.push(
        <div key={item.id} className="w-full max-w-[740px]">
          {renderThoughtText(thoughtContent)}
        </div>,
      );
    });

    flushStatusGroup();
    if (nodes.length === 0) return null;

    return (
      <div className={clsx('w-full max-w-3xl space-y-3', showWorkflowOnTop ? 'mb-3' : 'mt-3')}>
        {nodes}
      </div>
    );
  };

  const renderThoughtText = (content: string) => (
    <div className="chat-ai-shell">
      <div className="chat-ai-content">
        <StreamingMarkdown
          content={renderPreviewAwareMarkdownContent(content)}
          isStreaming={msg.isStreaming}
          components={markdownComponents}
          urlTransform={markdownUrlTransform}
          className="chat-markdown-body text-text-secondary"
        />
      </div>
    </div>
  );

  if (workflowAutoHideWhenComplete && isThinkingMessage && !msg.isStreaming) {
    return null;
  }

  return (
    <div className={clsx('chat-message-row', isUser ? 'chat-message-row-user' : 'chat-message-row-ai')}>

      {/* Plan Visualization (TodoList) */}
      {!isUser && msg.plan && msg.plan.length > 0 && (
        <TodoList steps={msg.plan} />
      )}

      {showWorkflowOnTop && showTimeline && renderTimelineWorkflow(displayTimeline)}

      {/* AI 工作流可视化 (兼容旧版：思考、工具、技能) - 仅当 timeline 为空时显示 */}
      {showWorkflowOnTop && showLegacyWorkflow && (
        <div className="mb-4 w-full max-w-3xl space-y-3">
          {/* Thinking Bubble */}
          {msg.thinking && (
            renderThoughtText(stripInternalProtocolMarkup(msg.thinking))
          )}

          {/* Activated Skill */}
          {showWorkflowDetails && msg.activatedSkill && (
            <SkillActivatedBadge
              name={msg.activatedSkill.name}
              description={msg.activatedSkill.description}
            />
          )}

          {/* Tool Calls */}
          {showWorkflowDetails && msg.tools.length > 0 && (
            <div className="rounded-lg border border-border/70 bg-surface-primary/60 px-3 py-2 text-xs text-text-tertiary">
              查看工具调用 ({msg.tools.length})
            </div>
          )}
        </div>
      )}

      {/* 消息内容 */}
      {hasRenderableMessageContent && (
        isUser ? (
          /* 用户消息 */
          (() => {
            const videoCardMatch = msg.content.match(/<!--VIDEO_CARD:(.*?)-->/);
            let videoCard: { title: string; thumbnailUrl?: string; videoId?: string } | null = null;
            const hasExplicitDisplayContent = typeof msg.displayContent === 'string';
            let displayText = hasExplicitDisplayContent ? msg.displayContent || '' : stripInternalProtocolMarkup(msg.content);

            if (videoCardMatch) {
              try {
                videoCard = JSON.parse(videoCardMatch[1]);
                displayText = hasExplicitDisplayContent ? msg.displayContent || '' : `总结视频「${videoCard?.title}」的内容`;
              } catch (e) {
                console.error('Failed to parse video card:', e);
              }
            }

            return (
              <div className="group/user flex w-full flex-col items-end">
                {(videoCard || displayText) && (
                  <div className="chat-user-bubble max-w-full px-4 py-2.5 text-[15px] leading-relaxed shadow-sm">
                    {videoCard && (
                      <div className={displayText ? 'mb-3' : ''}>
                        {renderYoutubeCard(videoCard)}
                      </div>
                    )}
                    {displayText && <div className="whitespace-pre-wrap">{displayText}</div>}
                  </div>
                )}
                {showAttachments && msg.attachment?.type === 'youtube-video' && !videoCard && (
                  <div className="mt-2 w-full max-w-[420px]">
                    {renderYoutubeCard(msg.attachment)}
                  </div>
                )}
                {showAttachments && msg.attachment?.type !== 'wander-references' && renderKnowledgeReferenceCards(msg.knowledgeReferences)}
                {showAttachments && msg.attachment?.type === 'wander-references' && renderWanderReferenceCards(msg.attachment)}
                {showAttachments && msg.attachments && msg.attachments.length > 0 ? (
                  <div className="mt-2 flex w-full max-w-[520px] flex-col items-end gap-2">
                    {msg.attachments.map((attachment, index) => (
                      <div
                        key={String(attachment.attachmentId || attachment.workspaceRelativePath || attachment.name || index)}
                        className="max-w-full self-end"
                      >
                        {renderUploadedFileCard(attachment as Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>)}
                      </div>
                    ))}
                  </div>
                ) : null}
                {showAttachments && (!msg.attachments || msg.attachments.length === 0) && msg.attachment?.type === 'uploaded-file' && renderUploadedFileCard(msg.attachment)}
                {userCopyContent && (
                  <div className="mt-1.5 flex justify-end gap-1 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100">
                    {onSaveToKnowledge && (
                      <button
                        type="button"
                        onClick={() => onSaveToKnowledge(msg, userCopyContent)}
                        disabled={savingKnowledgeMessageId === msg.id}
                        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:cursor-default disabled:opacity-60"
                        title="存入知识库"
                      >
                        {savedKnowledgeMessageId === msg.id ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-green-500" />
                            <span className="text-green-500">已入库</span>
                          </>
                        ) : (
                          <>
                            <Archive className="h-3.5 w-3.5" />
                            <span>{savingKnowledgeMessageId === msg.id ? '入库中' : '入库'}</span>
                          </>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onCopyMessage(msg.id, userCopyContent)}
                      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                      title="复制内容"
                    >
                      {copiedMessageId === msg.id ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-green-500" />
                          <span className="text-green-500">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span>复制</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })()
        ) : (
          /* AI 回复 */
          <div className={clsx('chat-ai-shell group', msg.isStreaming && 'chat-ai-shell-streaming')}>
            {assistantMemberActor ? (
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
                {renderMemberActorAvatar(assistantMemberActor)}
                <span className="truncate">{assistantMemberActor.displayName}</span>
              </div>
            ) : null}
            {showProcessingTimer && (
              <ProcessingTimerBadge
                startedAt={msg.processingStartedAt as number}
                finishedAt={msg.processingFinishedAt}
                isStreaming={msg.isStreaming}
              />
            )}
            <div ref={aiContentRef} className={clsx('chat-ai-content', msg.isStreaming && 'chat-ai-content-streaming')}>
              <div className={clsx(
                'chat-markdown-body',
                isThinkingMessage ? 'text-text-secondary' : 'text-text-primary',
                showPendingThinkingIndicator && 'chat-markdown-body-pending',
              )}>
                {showPendingThinkingIndicator ? (
                  <ThinkingIndicator />
                ) : (
                  <StreamingMarkdown
                    content={renderedAssistantContent}
                    isStreaming={msg.isStreaming}
                    components={markdownComponents}
                    urlTransform={markdownUrlTransform}
                  />
                )}
                {msg.isStreaming && !showPendingThinkingIndicator && (
                  <span className="chat-streaming-caret" />
                )}
              </div>
            </div>
            {/* 复制按钮 */}
            {!msg.isStreaming && sanitizedAssistantContent && (
              <div className="chat-ai-actions gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {onSaveToKnowledge && (
                  <button
                    onClick={() => onSaveToKnowledge(msg, sanitizedAssistantContent)}
                    disabled={savingKnowledgeMessageId === msg.id}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:cursor-default disabled:opacity-60"
                    title="存入知识库"
                  >
                    {savedKnowledgeMessageId === msg.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-green-500" />
                        <span className="text-green-500">已入库</span>
                      </>
                    ) : (
                      <>
                        <Archive className="w-3.5 h-3.5" />
                        <span>{savingKnowledgeMessageId === msg.id ? '入库中' : '入库'}</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  onClick={() => onCopyMessage(msg.id, sanitizedAssistantContent)}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                  title="复制内容"
                >
                  {copiedMessageId === msg.id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-green-500">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )
      )}

      {/* AI 工作流可视化 (底部渲染) */}
      {!showWorkflowOnTop && showTimeline && renderTimelineWorkflow(displayTimeline)}

      {!showWorkflowOnTop && showLegacyWorkflow && (
        <div className="mt-3 w-full max-w-3xl space-y-3">
          {msg.thinking && (
            renderThoughtText(stripInternalProtocolMarkup(msg.thinking))
          )}
          {showWorkflowDetails && msg.activatedSkill && (
            <SkillActivatedBadge
              name={msg.activatedSkill.name}
              description={msg.activatedSkill.description}
            />
          )}
          {showWorkflowDetails && msg.tools.length > 0 && (
            <div className="rounded-lg border border-border/70 bg-surface-primary/60 px-3 py-2 text-xs text-text-tertiary">
              查看工具调用 ({msg.tools.length})
            </div>
          )}
        </div>
      )}

      {imageMenu.visible && (
        <LiquidGlassMenuPanel
          className="fixed z-[9999] min-w-[170px]"
          style={{ left: imageMenu.x, top: imageMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={getLiquidGlassMenuItemClassName()}
            onClick={() => void handleCopyImage()}
          >
            <Copy className="h-3.5 w-3.5" />
            复制图片
          </button>
          <LiquidGlassMenuSeparator />
          <button
            type="button"
            className={getLiquidGlassMenuItemClassName()}
            onClick={() => void handleShowInFolder()}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            在文件夹中打开
          </button>
          <LiquidGlassMenuSeparator />
          <button
            type="button"
            className={getLiquidGlassMenuItemClassName()}
            onClick={() => void handleSaveAs()}
          >
            <Download className="h-3.5 w-3.5" />
            另存为
          </button>
        </LiquidGlassMenuPanel>
      )}

      {previewImage && (
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreviewImage(null)}
        >
          {previewImage.items.length > 1 && (
            <>
              <button
                type="button"
                className="fixed left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white shadow-lg backdrop-blur transition hover:bg-black/55"
                onClick={(event) => {
                  event.stopPropagation();
                  showPreviewImageAt(previewImage.index - 1);
                }}
                aria-label="上一张"
                title="上一张"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                className="fixed right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white shadow-lg backdrop-blur transition hover:bg-black/55"
                onClick={(event) => {
                  event.stopPropagation();
                  showPreviewImageAt(previewImage.index + 1);
                }}
                aria-label="下一张"
                title="下一张"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}
          <div
            className="flex max-h-[90vh] max-w-[94vw] items-start gap-3"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={previewImage.src}
              alt={previewImage.alt}
              className="max-h-[90vh] max-w-[calc(94vw-3.25rem)] rounded-xl border border-white/15 bg-black/10 object-contain shadow-2xl"
              onContextMenu={(event) => handleImageContextMenu(event, previewImage.src, previewImage.actionSource)}
            />
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white shadow-lg backdrop-blur transition hover:bg-black/55"
              onClick={() => void handleDownloadImage(previewImage)}
              aria-label="下载"
              title="下载"
            >
              <Download className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // 自定义比对函数：只有内容、状态、思考过程真正变化时才渲染
  // 忽略父组件其他无关 State 变化导致的重绘
  const msgChanged = 
    prevProps.msg.content !== nextProps.msg.content ||
    prevProps.msg.messageType !== nextProps.msg.messageType ||
    prevProps.msg.isStreaming !== nextProps.msg.isStreaming ||
    prevProps.msg.processingStartedAt !== nextProps.msg.processingStartedAt ||
    prevProps.msg.processingFinishedAt !== nextProps.msg.processingFinishedAt ||
    prevProps.msg.suppressPendingIndicator !== nextProps.msg.suppressPendingIndicator ||
    prevProps.msg.memberActor !== nextProps.msg.memberActor ||
    prevProps.msg.memberMention !== nextProps.msg.memberMention ||
    prevProps.msg.knowledgeReferences !== nextProps.msg.knowledgeReferences ||
    prevProps.msg.thinking !== nextProps.msg.thinking ||
    prevProps.msg.tools !== nextProps.msg.tools ||
    prevProps.msg.plan !== nextProps.msg.plan || // Check plan changes
    prevProps.msg.activatedSkill !== nextProps.msg.activatedSkill ||
    // Deep check for timeline changes (length or last item status/content)
    (prevProps.msg.timeline?.length !== nextProps.msg.timeline?.length) ||
    (prevProps.msg.timeline?.length > 0 && 
      (prevProps.msg.timeline[prevProps.msg.timeline.length - 1].content !== nextProps.msg.timeline[nextProps.msg.timeline.length - 1].content ||
       prevProps.msg.timeline[prevProps.msg.timeline.length - 1].status !== nextProps.msg.timeline[nextProps.msg.timeline.length - 1].status)
    );

  const copyStatusChanged = 
    (prevProps.copiedMessageId === prevProps.msg.id) !== (nextProps.copiedMessageId === nextProps.msg.id);
  const knowledgeSaveStatusChanged =
    (prevProps.savingKnowledgeMessageId === prevProps.msg.id) !== (nextProps.savingKnowledgeMessageId === nextProps.msg.id) ||
    (prevProps.savedKnowledgeMessageId === prevProps.msg.id) !== (nextProps.savedKnowledgeMessageId === nextProps.msg.id);
  const workflowStyleChanged =
    prevProps.workflowPlacement !== nextProps.workflowPlacement ||
    prevProps.workflowVariant !== nextProps.workflowVariant ||
    prevProps.workflowEmphasis !== nextProps.workflowEmphasis ||
    prevProps.workflowDisplayMode !== nextProps.workflowDisplayMode ||
    prevProps.workflowAutoHideWhenComplete !== nextProps.workflowAutoHideWhenComplete ||
    prevProps.workflowFailureTone !== nextProps.workflowFailureTone ||
    prevProps.showAttachments !== nextProps.showAttachments ||
    prevProps.linkRenderMode !== nextProps.linkRenderMode ||
    prevProps.onSaveToKnowledge !== nextProps.onSaveToKnowledge ||
    prevProps.onPreviewLink !== nextProps.onPreviewLink ||
    prevProps.activePreviewHref !== nextProps.activePreviewHref;

  return !msgChanged && !copyStatusChanged && !knowledgeSaveStatusChanged && !workflowStyleChanged;
});
