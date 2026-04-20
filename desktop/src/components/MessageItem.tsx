import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import ReactMarkdown, { Components, UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { ProcessTimeline, ProcessItem } from './ProcessTimeline';
import { SkillActivatedBadge, ThinkingIndicator } from './ThinkingBubble';
import { TodoList, PlanStep } from './TodoList';
import { resolveAssetUrl, isLocalAssetUrl } from '../utils/pathManager';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel, LiquidGlassMenuSeparator } from '@/components/ui/liquid-glass-menu';
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
  status: 'running' | 'done';
}

export interface SkillEvent {
  name: string;
  description: string;
}

export interface Message {
  id: string;
  role: 'user' | 'ai';
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
}

interface MessageItemProps {
  msg: Message;
  copiedMessageId: string | null;
  onCopyMessage: (id: string, content: string) => void;
  workflowPlacement?: 'top' | 'bottom';
  workflowVariant?: 'default' | 'compact';
  workflowEmphasis?: 'default' | 'thoughts-first';
}

interface ImageContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  src: string;
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
}: MessageItemProps) => {
  const isUser = msg.role === 'user';
  const aiContentRef = useRef<HTMLDivElement | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [imageMenu, setImageMenu] = useState<ImageContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    src: '',
  });
  const hasAssistantResponseContent = !isUser && Boolean(String(msg.content || '').trim());
  const showPendingThinkingIndicator = !isUser && Boolean(msg.isStreaming && !hasAssistantResponseContent);
  const showProcessingTimer = !isUser && typeof msg.processingStartedAt === 'number' && Number.isFinite(msg.processingStartedAt);
  const hasRenderableMessageContent = isUser
    ? Boolean(msg.displayContent || msg.content || (msg.isStreaming && !msg.thinking))
    : hasAssistantResponseContent || showPendingThinkingIndicator;
  const showTimeline = !isUser && msg.timeline && msg.timeline.length > 0;
  const showLegacyWorkflow = !isUser && (!msg.timeline || msg.timeline.length === 0) && (msg.thinking || msg.tools.length > 0 || msg.activatedSkill);
  const showWorkflowOnTop = workflowPlacement === 'top';
  const latestTimelineThought = !isUser
    ? [...(msg.timeline || [])]
        .reverse()
        .find((item) => item.type === 'thought' && String(item.content || '').trim())
    : undefined;
  const activeThoughtContent = !isUser
    ? String(latestTimelineThought?.content || msg.thinking || '').trim()
    : '';
  const showStreamingThought = !isUser && Boolean(msg.isStreaming && activeThoughtContent);

  useEffect(() => {
    if (!imageMenu.visible) return;
    const closeMenu = () => setImageMenu((prev) => ({ ...prev, visible: false }));
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, [imageMenu.visible]);

  const handleImageContextMenu = (event: React.MouseEvent<HTMLImageElement>, source: string) => {
    event.preventDefault();
    const normalized = resolveAssetUrl(String(source || '').trim());
    if (!normalized) return;
    setImageMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      src: normalized,
    });
  };

  const handleMediaContextMenu = (event: React.MouseEvent<HTMLElement>, source: string) => {
    event.preventDefault();
    const normalized = resolveAssetUrl(String(source || '').trim());
    if (!normalized) return;
    setImageMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      src: normalized,
    });
  };

  const handleCopyImage = async () => {
    if (!imageMenu.src) return;
    try {
      const result = await window.ipcRenderer.invoke('file:copy-image', { source: imageMenu.src }) as { success?: boolean };
      if (!result?.success && /^https?:\/\//i.test(imageMenu.src) && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(imageMenu.src);
      }
    } catch (error) {
      console.error('Failed to copy image:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleShowInFolder = async () => {
    if (!imageMenu.src) return;
    if (!isLocalAssetUrl(imageMenu.src)) {
      setImageMenu((prev) => ({ ...prev, visible: false }));
      return;
    }
    try {
      await window.ipcRenderer.invoke('file:show-in-folder', { source: imageMenu.src });
    } catch (error) {
      console.error('Failed to show image in folder:', error);
    } finally {
      setImageMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const menuSupportsReveal = isLocalAssetUrl(imageMenu.src);

  const markdownComponents = useMemo<Components>(() => ({
    ...MARKDOWN_COMPONENTS,
    img({ src, alt }: any) {
      const mediaUrl = resolveAssetUrl(String(src || '').trim());
      if (!mediaUrl) return <span className="text-xs text-text-tertiary">资源地址无效</span>;
      if (isVideoAssetUrl(mediaUrl)) {
        return (
          <video
            src={mediaUrl}
            controls
            preload="metadata"
            className="my-3 max-h-[32rem] w-full max-w-full rounded-xl border border-border bg-surface-secondary shadow-sm"
            onContextMenu={(event) => handleMediaContextMenu(event, mediaUrl)}
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
          onContextMenu={(event) => handleImageContextMenu(event, mediaUrl)}
          title="点击预览，右键复制或在文件夹中打开"
        />
      );
    },
  }), []);

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

  const renderUploadedFileCard = (attachment: Extract<NonNullable<Message['attachment']>, { type: 'uploaded-file' }>) => (
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

  const renderThoughtText = (content: string) => (
    <div className="chat-ai-shell">
      <div className="chat-ai-content">
        <div className="chat-markdown-body text-text-secondary">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
            urlTransform={transformMarkdownUrl}
          >
            {content}
          </ReactMarkdown>
        </div>
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
        <ProcessTimeline items={msg.timeline} isStreaming={!!msg.isStreaming} variant={workflowVariant} />
      )}

      {/* AI 工作流可视化 (兼容旧版：思考、工具、技能) - 仅当 timeline 为空时显示 */}
      {showWorkflowOnTop && showLegacyWorkflow && (
        <div className="mb-4 w-full max-w-3xl space-y-3">
          {/* Thinking Bubble */}
          {msg.thinking && (
            renderThoughtText(msg.thinking)
          )}

          {/* Activated Skill */}
          {msg.activatedSkill && (
            <SkillActivatedBadge
              name={msg.activatedSkill.name}
              description={msg.activatedSkill.description}
            />
          )}

          {/* Tool Calls */}
          {msg.tools.length > 0 && (
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
                {msg.attachment?.type === 'youtube-video' && !videoCard && (
                  <div className="mt-2 w-full max-w-[420px]">
                    {renderYoutubeCard(msg.attachment)}
                  </div>
                )}
                {msg.attachment?.type === 'wander-references' && renderWanderReferenceCards(msg.attachment)}
                {msg.attachment?.type === 'uploaded-file' && renderUploadedFileCard(msg.attachment)}
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
              <div className={clsx('chat-markdown-body text-text-primary', showPendingThinkingIndicator && 'chat-markdown-body-pending')}>
                {showPendingThinkingIndicator ? (
                  <ThinkingIndicator />
                ) : msg.isStreaming ? (
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents}
                    urlTransform={transformMarkdownUrl}
                  >
                    {msg.content}
                  </ReactMarkdown>
                )}
                {msg.isStreaming && !showPendingThinkingIndicator && (
                  <span className="ml-1 inline-block h-4 w-2 animate-pulse align-middle bg-accent-primary" />
                )}
              </div>
            </div>
            {/* 复制按钮 */}
            {!msg.isStreaming && msg.content && (
              <div className="chat-ai-actions opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => onCopyMessage(msg.id, msg.content)}
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
        <ProcessTimeline items={msg.timeline} isStreaming={!!msg.isStreaming} variant={workflowVariant} />
      )}

      {!showWorkflowOnTop && showLegacyWorkflow && (
        <div className="mt-3 w-full max-w-3xl space-y-3">
          {msg.thinking && (
            renderThoughtText(msg.thinking)
          )}
          {msg.activatedSkill && (
            <SkillActivatedBadge
              name={msg.activatedSkill.name}
              description={msg.activatedSkill.description}
            />
          )}
          {msg.tools.length > 0 && (
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
    prevProps.msg.isStreaming !== nextProps.msg.isStreaming ||
    prevProps.msg.processingStartedAt !== nextProps.msg.processingStartedAt ||
    prevProps.msg.processingFinishedAt !== nextProps.msg.processingFinishedAt ||
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
    prevProps.workflowEmphasis !== nextProps.workflowEmphasis;

  return !msgChanged && !copyStatusChanged && !workflowStyleChanged;
});
