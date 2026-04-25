import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Components, UrlTransform } from 'react-markdown';
import { Copy, Check } from 'lucide-react';
import { ProcessTimeline, ProcessItem } from './ProcessTimeline';
import { SkillActivatedBadge, ThinkingIndicator } from './ThinkingBubble';
import { TodoList, PlanStep } from './TodoList';
import { resolveAssetUrl, isLocalAssetUrl } from '../utils/pathManager';
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

const INTERNAL_PROTOCOL_BLOCKS = [
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  /<activated_skill\b[\s\S]*?<\/activated_skill>/gi,
];

const stripInternalProtocolMarkup = (value: string): string => {
  let sanitized = String(value || '');
  for (const pattern of INTERNAL_PROTOCOL_BLOCKS) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized.replace(/\n{3,}/g, '\n\n').trim();
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
    type: 'uploaded-file';
    name: string;
    ext?: string;
    size?: number;
    thumbnailDataUrl?: string;
    workspaceRelativePath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    kind?: 'text' | 'image' | 'audio' | 'video' | 'binary' | string;
    mimeType?: string;
    storageMode?: 'staged' | string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: 'direct-input' | 'tool-read';
    summary?: string;
    requiresMultimodal?: boolean;
  };
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
}

interface MessageItemProps {
  msg: Message;
  copiedMessageId: string | null;
  onCopyMessage: (id: string, content: string) => void;
  workflowPlacement?: 'top' | 'bottom';
  workflowVariant?: 'default' | 'compact';
  workflowEmphasis?: 'default' | 'thoughts-first';
  workflowDisplayMode?: 'all' | 'thoughts-only';
  showAttachments?: boolean;
}

interface ImageContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  src: string;
  actionSource: string;
}

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
  workflowPlacement = 'top',
  workflowVariant = 'default',
  workflowEmphasis = 'default',
  workflowDisplayMode = 'all',
  showAttachments = true,
}: MessageItemProps) => {
  const isUser = msg.role === 'user';
  const isThinkingMessage = !isUser && msg.messageType === 'thinking';
  const sanitizedAssistantContent = !isUser
    ? stripInternalProtocolMarkup(String(msg.content || ''))
    : String(msg.content || '');
  const aiContentRef = useRef<HTMLDivElement | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
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
  const showWorkflowDetails = workflowDisplayMode !== 'thoughts-only';
  const hasAssistantResponseContent = !isUser && Boolean(sanitizedAssistantContent);
  const showPendingThinkingIndicator = !isUser
    && !isThinkingMessage
    && !msg.suppressPendingIndicator
    && Boolean(msg.isStreaming && !hasAssistantResponseContent);
  const showProcessingTimer = !isUser && !isThinkingMessage && typeof msg.processingStartedAt === 'number' && Number.isFinite(msg.processingStartedAt);
  const hasRenderableMessageContent = isUser
    ? Boolean(msg.displayContent || msg.content || (msg.isStreaming && !msg.thinking))
    : hasAssistantResponseContent || showPendingThinkingIndicator;
  const showTimeline = !isUser && !isThinkingMessage && filteredTimeline.length > 0;
  const showLegacyWorkflow = !isUser
    && !isThinkingMessage
    && filteredTimeline.length === 0
    && (msg.thinking || (showWorkflowDetails && (msg.tools.length > 0 || msg.activatedSkill)));
  const showWorkflowOnTop = workflowPlacement === 'top';
  const latestTimelineThought = !isUser
    ? [...(msg.timeline || [])]
        .reverse()
        .find((item) => item.type === 'thought' && String(item.content || '').trim())
    : undefined;
  const activeThoughtContent = !isUser
    ? stripInternalProtocolMarkup(String(latestTimelineThought?.content || msg.thinking || ''))
    : '';
  const showStreamingThought = !isUser && !isThinkingMessage && Boolean(msg.isStreaming && activeThoughtContent);

  useEffect(() => {
    if (!imageMenu.visible) return;
    const closeMenu = () => setImageMenu((prev) => ({ ...prev, visible: false }));
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, [imageMenu.visible]);

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

  const handleCopyImage = async () => {
    if (!imageMenu.actionSource) return;
    try {
      const result = await window.ipcRenderer.invoke('file:copy-image', { source: imageMenu.actionSource }) as { success?: boolean };
      if (!result?.success && /^https?:\/\//i.test(imageMenu.actionSource) && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(imageMenu.actionSource);
      }
    } catch (error) {
      console.error('Failed to copy image:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleShowInFolder = async () => {
    if (!imageMenu.actionSource) return;
    if (!isLocalAssetUrl(imageMenu.actionSource)) {
      setImageMenu((prev) => ({ ...prev, visible: false }));
      return;
    }
    try {
      await window.ipcRenderer.invoke('file:show-in-folder', { source: imageMenu.actionSource });
    } catch (error) {
      console.error('Failed to show image in folder:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const menuSupportsReveal = isLocalAssetUrl(imageMenu.actionSource);

  const markdownComponents = useMemo<Components>(() => ({
    ...MARKDOWN_COMPONENTS,
    img({ src, alt }: any) {
      const rawSource = String(src || '').trim();
      const mediaUrl = resolveAssetUrl(rawSource);
      if (!mediaUrl) return <span className="text-xs text-text-tertiary">资源地址无效</span>;
      if (isVideoAssetUrl(mediaUrl)) {
        return (
          <video
            src={mediaUrl}
            controls
            preload="metadata"
            className="my-3 max-h-[32rem] w-full max-w-full rounded-xl border border-border bg-surface-secondary shadow-sm"
            onContextMenu={(event) => handleMediaContextMenu(event, mediaUrl, rawSource)}
            title="右键复制或在文件夹中打开"
          />
        );
      }
      return (
        <img
          src={mediaUrl}
          alt={alt || ''}
          className="my-3 max-h-[28rem] w-auto max-w-full cursor-zoom-in rounded-xl border border-border bg-surface-secondary object-contain shadow-sm"
          onClick={() => setPreviewImage({ src: mediaUrl, alt: alt || '' })}
          onContextMenu={(event) => handleImageContextMenu(event, mediaUrl, rawSource)}
          title="点击预览，右键复制或在文件夹中打开"
        />
      );
    },
  }), [handleImageContextMenu, handleMediaContextMenu]);

  const isUploadedImageAttachment = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
    const kind = String(attachment.kind || '').trim().toLowerCase();
    const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
    const source = String(
      attachment.localUrl
        || attachment.absolutePath
        || attachment.originalAbsolutePath
        || attachment.name
        || '',
    ).trim().toLowerCase();

    return kind === 'image' || mimeType.startsWith('image/') || IMAGE_ATTACHMENT_EXT_RE.test(source);
  }, []);

  const resolveUploadedAttachmentSource = useCallback((attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
    const preferred = String(
      attachment.thumbnailDataUrl
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
      attachment.localUrl
        || attachment.absolutePath
        || attachment.originalAbsolutePath
        || '',
    ).trim()
  ), []);

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

  const renderUploadedFileCard = (attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => {
    const imageSrc = isUploadedImageAttachment(attachment) ? resolveUploadedAttachmentSource(attachment) : '';
    const actionSource = resolveUploadedAttachmentActionSource(attachment);
    if (imageSrc) {
      return (
        <div className="mt-2">
          <img
            src={imageSrc}
            alt={attachment.name}
            className="h-24 w-24 cursor-zoom-in rounded-2xl border border-border bg-surface-secondary object-cover shadow-sm"
            onClick={() => setPreviewImage({ src: imageSrc, alt: attachment.name })}
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

  const renderThoughtText = (content: string) => (
    <div className="chat-ai-shell">
      <div className="chat-ai-content">
        <StreamingMarkdown
          content={content}
          isStreaming={msg.isStreaming}
          components={markdownComponents}
          urlTransform={transformMarkdownUrl}
          className="chat-markdown-body text-text-secondary"
        />
      </div>
    </div>
  );

  return (
    <div className={clsx('chat-message-row', isUser ? 'chat-message-row-user' : 'chat-message-row-ai')}>

      {/* Plan Visualization (TodoList) */}
      {!isUser && msg.plan && msg.plan.length > 0 && (
        <TodoList steps={msg.plan} />
      )}

      {showWorkflowOnTop && showTimeline && (
        <ProcessTimeline items={filteredTimeline} isStreaming={!!msg.isStreaming} variant={workflowVariant} />
      )}

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

      {showStreamingThought && (
        <div className={clsx(showWorkflowOnTop ? 'mb-2' : 'mt-2', 'w-full max-w-[740px]')}>
          {renderThoughtText(activeThoughtContent)}
        </div>
      )}

      {/* 消息内容 */}
      {hasRenderableMessageContent && (
        isUser ? (
          /* 用户消息 */
          (() => {
            const videoCardMatch = msg.content.match(/<!--VIDEO_CARD:(.*?)-->/);
            let videoCard: { title: string; thumbnailUrl?: string; videoId?: string } | null = null;
            let displayText = msg.displayContent || msg.content;

            if (videoCardMatch) {
              try {
                videoCard = JSON.parse(videoCardMatch[1]);
                displayText = msg.displayContent || `总结视频「${videoCard?.title}」的内容`;
              } catch (e) {
                console.error('Failed to parse video card:', e);
              }
            }

            return (
              <div className="flex w-full flex-col items-end">
                <div className="chat-user-bubble max-w-full px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm">
                  {videoCard && (
                    <div className="mb-3">
                      {renderYoutubeCard(videoCard)}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap">{displayText}</div>
                </div>
                {showAttachments && msg.attachment?.type === 'youtube-video' && !videoCard && (
                  <div className="mt-2 w-full max-w-[420px]">
                    {renderYoutubeCard(msg.attachment)}
                  </div>
                )}
                {showAttachments && msg.attachment?.type === 'wander-references' && renderWanderReferenceCards(msg.attachment)}
                {showAttachments && msg.attachment?.type === 'uploaded-file' && renderUploadedFileCard(msg.attachment)}
              </div>
            );
          })()
        ) : (
          /* AI 回复 */
          <div className={clsx('chat-ai-shell group', msg.isStreaming && 'chat-ai-shell-streaming')}>
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
                    content={sanitizedAssistantContent}
                    isStreaming={msg.isStreaming}
                    components={markdownComponents}
                    urlTransform={transformMarkdownUrl}
                  />
                )}
                {msg.isStreaming && !showPendingThinkingIndicator && (
                  <span className="chat-streaming-caret" />
                )}
              </div>
            </div>
            {/* 复制按钮 */}
            {!msg.isStreaming && sanitizedAssistantContent && (
              <div className="chat-ai-actions opacity-0 transition-opacity group-hover:opacity-100">
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
      {!showWorkflowOnTop && showTimeline && (
        <ProcessTimeline items={filteredTimeline} isStreaming={!!msg.isStreaming} variant={workflowVariant} />
      )}

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
            复制图片
          </button>
          {menuSupportsReveal && (
            <>
              <LiquidGlassMenuSeparator />
              <button
                type="button"
                className={getLiquidGlassMenuItemClassName()}
                onClick={() => void handleShowInFolder()}
              >
                在文件夹中打开
              </button>
            </>
          )}
        </LiquidGlassMenuPanel>
      )}

      {previewImage && (
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage.src}
            alt={previewImage.alt}
            className="max-h-[90vh] max-w-[90vw] rounded-xl border border-white/15 bg-black/10 object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => handleImageContextMenu(event, previewImage.src)}
          />
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
  const workflowStyleChanged =
    prevProps.workflowPlacement !== nextProps.workflowPlacement ||
    prevProps.workflowVariant !== nextProps.workflowVariant ||
    prevProps.workflowEmphasis !== nextProps.workflowEmphasis ||
    prevProps.workflowDisplayMode !== nextProps.workflowDisplayMode ||
    prevProps.showAttachments !== nextProps.showAttachments;

  return !msgChanged && !copyStatusChanged && !workflowStyleChanged;
});
