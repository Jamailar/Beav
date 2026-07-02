import { lazy, Suspense, useEffect, useMemo } from 'react';
import { FileAudio, FileVideo, Image as ImageIcon, Loader2, Plus, X } from 'lucide-react';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownItPreview } from './MarkdownItPreview';
import { inferAssetKind, type MediaAsset } from '../../features/manuscripts/editorModel';
import { resolveAssetUrl } from '../../utils/pathManager';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type WritingDraftType = 'longform' | 'html' | 'unknown';
type WritingContentFormat = 'markdown' | 'html';
export type EditorBodyViewMode = 'edit' | 'preview';

type AiWorkspaceMode = {
  id: string;
  label: string;
};

export interface WritingDraftWorkbenchProps {
  draftType: WritingDraftType;
  title: string;
  filePath: string;
  editorBody: string;
  bodyViewMode: EditorBodyViewMode;
  contentFormat?: WritingContentFormat;
  fileBaseUrl?: string;
  boundAssets?: MediaAsset[];
  writeProposal?: {
    id?: string;
    baseBody: string;
    isStale?: boolean;
  } | null;
  editorChatSessionId: string | null;
  editorChatReady?: boolean;
  editorSessionMetadata?: Record<string, unknown> | null;
  isActive?: boolean;
  onEditorBodyChange: (value: string) => void;
  onRequestBindImages?: () => void;
  onPreviewAsset?: (asset: MediaAsset) => void;
  onRemoveBoundImage?: (asset: MediaAsset) => void;
  onAiWorkspaceModeChange?: (mode: AiWorkspaceMode) => void;
}

const EDITOR_AI_CONTEXT_MAX_CHARS = 80000;

function buildWritingEditorAiContext({
  title,
  filePath,
  draftType,
  editorBody,
  contentFormat,
}: {
  title: string;
  filePath: string;
  draftType: WritingDraftType;
  editorBody: string;
  contentFormat: WritingContentFormat;
}): string {
  const body = String(editorBody || '');
  const truncated = body.length > EDITOR_AI_CONTEXT_MAX_CHARS;
  const bodyForContext = truncated ? body.slice(0, EDITOR_AI_CONTEXT_MAX_CHARS) : body;
  return [
    '当前对话嵌入在稿件编辑器里，只能围绕当前打开的稿件进行编辑。',
    '不要调用读取、列出、搜索其他稿件或知识库的工具，除非用户明确要求比较外部材料。',
    '如需落盘修改，直接使用当前稿件写入动作生成待审改稿提案。',
    `当前稿件标题：${title || '未命名'}`,
    `当前稿件路径：${filePath}`,
    `当前稿件类型：${draftType}`,
    truncated ? `当前稿件正文超过上下文限制，下面只包含前 ${EDITOR_AI_CONTEXT_MAX_CHARS} 个字符。` : '当前稿件正文如下。',
    `\`\`\`${contentFormat === 'html' ? 'html' : 'markdown'}`,
    bodyForContext,
    '```',
  ].join('\n');
}

function escapeHtmlAttribute(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHtmlPreviewDocument(content: string, baseUrl?: string): string {
  const source = String(content || '').trim();
  const fallback = '<!doctype html><html><body></body></html>';
  const html = source || fallback;
  const base = String(baseUrl || '').trim()
    ? `<base href="${escapeHtmlAttribute(baseUrl || '')}">`
    : '';
  if (!base) return html;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${base}`);
  }
  if (/<html(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${base}</head>`);
  }
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
}

function HtmlPreview({ content, fileBaseUrl }: { content: string; fileBaseUrl?: string }) {
  const srcDoc = useMemo(
    () => buildHtmlPreviewDocument(content, fileBaseUrl),
    [content, fileBaseUrl],
  );
  return (
    <iframe
      title="HTML 预览"
      className="h-full min-h-0 w-full border-0 bg-white"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
    />
  );
}

function BoundMediaStrip({ assets }: { assets: MediaAsset[] }) {
  const visibleAssets = assets.filter((asset) => inferAssetKind(asset) !== 'image');
  if (visibleAssets.length === 0) return null;
  return (
    <div className="shrink-0 overflow-x-auto border-t border-border bg-surface-primary/92 px-4 py-3">
      <div className="flex gap-2">
        {visibleAssets.slice(0, 12).map((asset) => {
          const kind = inferAssetKind(asset);
          const src = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
          return (
            <div
              key={asset.id}
              className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-secondary text-text-tertiary"
              title={asset.title || asset.id}
            >
              {kind === 'image' && src ? (
                <img src={src} alt={asset.title || asset.id} className="h-full w-full object-cover" loading="lazy" />
              ) : kind === 'video' ? (
                <FileVideo className="h-5 w-5" />
              ) : kind === 'audio' ? (
                <FileAudio className="h-5 w-5" />
              ) : (
                <ImageIcon className="h-5 w-5" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function XhsMediaDeck({
  assets,
  onAddImage,
  onPreviewAsset,
  onRemoveImage,
}: {
  assets: MediaAsset[];
  onAddImage?: () => void;
  onPreviewAsset?: (asset: MediaAsset) => void;
  onRemoveImage?: (asset: MediaAsset) => void;
}) {
  const imageAssets = assets.filter((asset) => inferAssetKind(asset) === 'image');
  if (imageAssets.length === 0) return null;
  return (
    <div className="shrink-0 overflow-x-auto border-b border-border bg-surface-primary px-5 py-3">
      <div className="flex w-max min-w-full items-center gap-3">
        {imageAssets.slice(0, 12).map((asset) => {
          const src = resolveAssetUrl(asset.previewUrl || asset.absolutePath || asset.relativePath || '');
          return (
            <div
              key={asset.id}
              className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-secondary text-left shadow-sm"
              title={asset.title || asset.id}
            >
              <button
                type="button"
                onClick={() => onPreviewAsset?.(asset)}
                className="block h-full w-full"
                aria-label="查看大图"
              >
                {src ? (
                  <img
                    src={src}
                    alt={asset.title || asset.id}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                    <ImageIcon className="h-7 w-7" />
                  </div>
                )}
              </button>
              <button
                type="button"
                className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-primary/92 text-text-tertiary shadow-sm ring-1 ring-border transition hover:bg-[rgb(var(--color-danger-bg))] hover:text-[rgb(var(--color-danger-text))]"
                aria-label="移除配图"
                title="移除配图"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveImage?.(asset);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAddImage}
          className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-surface-secondary/55 text-text-tertiary transition hover:border-accent-primary/40 hover:bg-surface-secondary hover:text-accent-primary"
          aria-label="添加配图"
          title="添加配图"
        >
          <Plus className="h-8 w-8 stroke-[1.5]" />
        </button>
      </div>
    </div>
  );
}

export function WritingDraftWorkbench({
  draftType,
  title,
  filePath,
  editorBody,
  bodyViewMode,
  contentFormat = 'markdown',
  fileBaseUrl,
  boundAssets = [],
  writeProposal = null,
  editorChatSessionId,
  editorChatReady = true,
  editorSessionMetadata = null,
  isActive = false,
  onEditorBodyChange,
  onRequestBindImages,
  onPreviewAsset,
  onRemoveBoundImage,
  onAiWorkspaceModeChange,
}: WritingDraftWorkbenchProps) {
  const aiWorkspaceMode = useMemo<AiWorkspaceMode>(() => (
    { id: 'manuscript-editing', label: '稿件编辑' }
  ), []);

  useEffect(() => {
    onAiWorkspaceModeChange?.(aiWorkspaceMode);
  }, [aiWorkspaceMode, onAiWorkspaceModeChange]);

  const editorChatMessageContext = useMemo(() => buildWritingEditorAiContext({
    title,
    filePath,
    draftType,
    editorBody,
    contentFormat,
  }), [contentFormat, draftType, editorBody, filePath, title]);

  const editorChatTaskHints = useMemo(() => ({
    ...(editorSessionMetadata || {}),
    mode: aiWorkspaceMode.id,
    initialContext: editorChatMessageContext,
  }), [aiWorkspaceMode.id, editorChatMessageContext, editorSessionMetadata]);

  const shouldShowMediaDeck = contentFormat === 'markdown';

  const previewPane = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto p-8">
        {contentFormat === 'html' ? (
          <div className="h-full min-h-[420px] overflow-hidden rounded-lg border border-border bg-white">
            <HtmlPreview content={editorBody} fileBaseUrl={fileBaseUrl} />
          </div>
        ) : (
          <MarkdownItPreview content={editorBody} />
        )}
      </div>
      <BoundMediaStrip assets={boundAssets} />
    </div>
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] bg-surface-primary text-text-primary">
      <section className="relative min-h-0 border-r border-border bg-surface-primary">
        <div className="flex h-full min-h-0 flex-col">
          {shouldShowMediaDeck ? (
            <XhsMediaDeck
              assets={boundAssets}
              onAddImage={onRequestBindImages}
              onPreviewAsset={onPreviewAsset}
              onRemoveImage={onRemoveBoundImage}
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="grid h-full min-h-0 grid-cols-1">
              {bodyViewMode !== 'preview' ? (
                <div className="min-h-0">
                  <CodeMirrorEditor
                    key={`${filePath}:${writeProposal?.id || 'body'}`}
                    value={editorBody}
                    onChange={onEditorBodyChange}
                    diffOriginalValue={writeProposal?.baseBody ?? null}
                    className="manuscript-editor-shell h-full min-h-0 bg-transparent"
                  />
                </div>
              ) : null}
              {bodyViewMode !== 'edit' ? previewPane : null}
            </div>
          </div>
        </div>
      </section>

      <aside className="min-h-0 bg-surface-secondary/55">
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            {editorChatSessionId && editorChatReady ? (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">AI 会话加载中...</div>}>
                <ChatWorkspace
                  isActive={isActive}
                  fixedSessionId={editorChatSessionId}
                  showClearButton={false}
                  showWelcomeShortcuts={false}
                  showComposerShortcuts={false}
                  fixedSessionContextIndicatorMode="none"
                  contentLayout="wide"
                  contentWidthPreset="default"
                  allowFileUpload
                  messageWorkflowPlacement="bottom"
                  messageWorkflowVariant="compact"
                  messageWorkflowEmphasis="default"
                  fixedSessionTaskHints={editorChatTaskHints}
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary/70" />
                  <div className="mt-3 text-sm text-text-secondary">
                    {editorChatSessionId ? '正在同步稿件上下文...' : '正在初始化 AI 会话...'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
