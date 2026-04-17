import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownItPreview } from './MarkdownItPreview';
import { resolveAssetUrl } from '../../utils/pathManager';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type WritingDraftType = 'longform' | 'richpost' | 'unknown';
type WritingWorkbenchTab = 'manuscript' | 'layout' | 'richpost' | 'article-card';

type MediaAssetLike = {
  id: string;
  title?: string;
  relativePath?: string;
  absolutePath?: string;
  previewUrl?: string;
};

export interface WritingDraftWorkbenchProps {
  draftType: WritingDraftType;
  title: string;
  filePath: string;
  editorBody: string;
  editorBodyDirty: boolean;
  isSavingEditorBody: boolean;
  editorChatSessionId: string | null;
  isActive?: boolean;
  previewHtml?: string | null;
  hasGeneratedHtml?: boolean;
  coverAsset?: MediaAssetLike | null;
  imageAssets?: MediaAssetLike[];
  onEditorBodyChange: (value: string) => void;
}

const LONGFORM_SHORTCUTS = [
  { label: '润色结构', text: '请先阅读当前长文内容，重新整理段落结构，并给出更清晰的起承转合。' },
  { label: '压缩篇幅', text: '请在保留核心观点的前提下，把当前长文压缩成更利于阅读的版本。' },
  { label: '扩写重点', text: '请找出当前长文最值得展开的部分，并直接补全为更完整的正文。' },
  { label: '公众号风格', text: '请把当前长文改成更适合公众号阅读和排版的表达方式。' },
];

const RICHPOST_SHORTCUTS = [
  { label: '改小红书风格', text: '请把当前图文稿改成更适合小红书发布的语言节奏和段落形式。' },
  { label: '重写标题', text: '请基于当前图文稿，输出一组更抓人的标题和首屏文案。' },
  { label: '压成卡片段落', text: '请把当前图文内容压缩成更适合卡片式阅读的短段落结构。' },
  { label: '图文配合', text: '请根据当前稿件内容，建议每一段适合配什么图，并直接调整文案节奏。' },
];

function assetUrl(asset?: MediaAssetLike | null): string {
  return resolveAssetUrl(asset?.previewUrl || asset?.relativePath || asset?.absolutePath || '');
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="mx-auto w-full max-w-[880px]">
      <MarkdownItPreview content={content} />
    </div>
  );
}

function RichPostPreview({
  title,
  editorBody,
  previewHtml,
  coverAsset,
  imageAssets,
  hasGeneratedHtml,
}: {
  title: string;
  editorBody: string;
  previewHtml?: string | null;
  coverAsset?: MediaAssetLike | null;
  imageAssets: MediaAssetLike[];
  hasGeneratedHtml?: boolean;
}) {
  const galleryAssets = imageAssets.slice(0, 4);
  const coverSrc = assetUrl(coverAsset);
  const iframeHeight = 'min(960px, calc(100vh - 144px))';

  return (
    <div className="h-full overflow-auto px-8 py-8">
      <div className="mx-auto w-full max-w-[520px] space-y-5">
        {previewHtml?.trim() ? (
          <iframe
            title="图文预览"
            srcDoc={previewHtml}
            className="w-full rounded-2xl border border-border bg-white"
            style={{ height: iframeHeight }}
          />
        ) : (
          <div className="space-y-5 rounded-2xl border border-border bg-surface-primary p-6">
            {coverSrc ? (
              <img src={coverSrc} alt={title} className="h-64 w-full rounded-xl object-cover" />
            ) : null}
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-text-primary">{title}</h1>
            <MarkdownPreview content={editorBody} />
            {galleryAssets.length > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                {galleryAssets.map((asset) => (
                  <img
                    key={asset.id}
                    src={assetUrl(asset)}
                    alt={asset.title || asset.id}
                    className="h-36 w-full rounded-xl border border-border object-cover"
                  />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function LongformPreview({
  title,
  editorBody,
  previewHtml,
  coverAsset,
  hasGeneratedHtml,
}: {
  title: string;
  editorBody: string;
  previewHtml?: string | null;
  coverAsset?: MediaAssetLike | null;
  hasGeneratedHtml?: boolean;
}) {
  const coverSrc = assetUrl(coverAsset);
  const iframeHeight = 'min(980px, calc(100vh - 144px))';

  return (
    <div className="h-full overflow-auto px-8 py-8">
      <div className="mx-auto w-full max-w-[1040px]">
        {previewHtml?.trim() ? (
          <iframe
            title="长文排版预览"
            srcDoc={previewHtml}
            className="w-full rounded-2xl border border-border bg-white"
            style={{ height: iframeHeight }}
          />
        ) : (
          <article className="mx-auto max-w-[860px] space-y-8 rounded-2xl border border-border bg-surface-primary px-10 py-10">
            <h1 className="text-[2.75rem] font-semibold leading-[1.08] tracking-tight text-text-primary">{title}</h1>
            {coverSrc ? (
              <img src={coverSrc} alt={title} className="h-72 w-full rounded-xl object-cover" />
            ) : null}
            <MarkdownPreview content={editorBody} />
          </article>
        )}
      </div>
    </div>
  );
}

function ManuscriptEditor({
  editorBody,
  onEditorBodyChange,
}: {
  editorBody: string;
  onEditorBodyChange: (value: string) => void;
}) {
  return (
    <div className="h-full min-h-0 overflow-hidden px-8 py-8">
      <div className="h-full min-h-0 overflow-hidden rounded-2xl border border-border bg-surface-primary">
        <CodeMirrorEditor
          value={editorBody}
          onChange={onEditorBodyChange}
          className="h-full min-h-0 bg-transparent"
        />
      </div>
    </div>
  );
}

export function WritingDraftWorkbench({
  draftType,
  title,
  filePath,
  editorBody,
  editorBodyDirty,
  isSavingEditorBody,
  editorChatSessionId,
  isActive = false,
  previewHtml,
  hasGeneratedHtml = false,
  coverAsset = null,
  imageAssets = [],
  onEditorBodyChange,
}: WritingDraftWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WritingWorkbenchTab>('manuscript');

  useEffect(() => {
    setActiveTab('manuscript');
  }, [draftType, filePath, previewHtml]);

  const isRichPost = draftType === 'richpost';
  const shortcuts = useMemo(
    () => (isRichPost ? RICHPOST_SHORTCUTS : LONGFORM_SHORTCUTS),
    [isRichPost]
  );
  const chatTitle = isRichPost ? '图文创作助手' : '长文写作助手';
  const draftLabel = isRichPost ? '图文稿' : '长文稿';
  const tabs = isRichPost
    ? [
      { id: 'manuscript' as const, label: '稿件' },
      { id: 'richpost' as const, label: '图文' },
      { id: 'article-card' as const, label: '长文卡片' },
    ]
    : [
      { id: 'manuscript' as const, label: '稿件' },
      { id: 'layout' as const, label: '排版' },
    ];
  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label || '稿件';

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] bg-surface-primary text-text-primary">
      <section className="min-h-0 border-r border-border bg-background">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-6 py-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  'rounded-full border px-4 py-1.5 text-sm transition',
                  activeTab === tab.id
                    ? 'border-accent-primary/35 bg-accent-primary/10 text-text-primary'
                    : 'border-transparent bg-transparent text-text-tertiary hover:border-border hover:bg-surface-secondary/50 hover:text-text-primary'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'manuscript' ? (
              <ManuscriptEditor editorBody={editorBody} onEditorBodyChange={onEditorBodyChange} />
            ) : activeTab === 'layout' ? (
              <LongformPreview
                title={title}
                editorBody={editorBody}
                previewHtml={previewHtml}
                coverAsset={coverAsset}
                hasGeneratedHtml={hasGeneratedHtml}
              />
            ) : activeTab === 'richpost' ? (
              <RichPostPreview
                title={title}
                editorBody={editorBody}
                previewHtml={previewHtml}
                coverAsset={coverAsset}
                imageAssets={imageAssets}
                hasGeneratedHtml={hasGeneratedHtml}
              />
            ) : (
              <LongformPreview
                title={title}
                editorBody={editorBody}
                previewHtml={undefined}
                coverAsset={coverAsset}
                hasGeneratedHtml={false}
              />
            )}
          </div>
        </div>
      </section>

      <aside className="min-h-0 bg-surface-secondary/55">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <MessageSquare className="h-4 w-4 text-accent-primary" />
              {chatTitle}
            </div>
            <div className="mt-2 text-xs leading-5 text-text-tertiary">
              右侧 AI 会话常驻，适合持续改标题、润色段落、重组结构和生成发布版本。
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {editorChatSessionId ? (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">AI 会话加载中...</div>}>
                <ChatWorkspace
                  isActive={isActive}
                  fixedSessionId={editorChatSessionId}
                  showClearButton={false}
                  showWelcomeShortcuts={false}
                  showComposerShortcuts
                  fixedSessionContextIndicatorMode="corner-ring"
                  contentLayout="wide"
                  contentWidthPreset="default"
                  allowFileUpload
                  messageWorkflowPlacement="bottom"
                  messageWorkflowVariant="compact"
                  messageWorkflowEmphasis="default"
                  welcomeTitle={chatTitle}
                  welcomeSubtitle={isRichPost ? '围绕当前图文稿继续改标题、压缩段落、强化发布感。' : '围绕当前长文继续改结构、润色正文、生成发布版本。'}
                  shortcuts={shortcuts}
                  welcomeShortcuts={shortcuts}
                  fixedSessionBannerText={chatTitle}
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary/70" />
                  <div className="mt-3 text-sm text-text-secondary">正在初始化 AI 会话...</div>
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border px-5 py-4">
            <div className="grid grid-cols-3 gap-2 text-left text-[11px] text-text-tertiary">
              <div className="rounded-2xl border border-border bg-surface-primary/85 px-3 py-2">
                <div className="flex items-center gap-2 text-text-secondary">
                  {isRichPost ? <ImageIcon className="h-3.5 w-3.5 text-amber-500" /> : <FileText className="h-3.5 w-3.5 text-accent-primary" />}
                  当前类型
                </div>
                <div className="mt-2 text-xs font-medium text-text-primary">{draftLabel}</div>
              </div>
              <div className="rounded-2xl border border-border bg-surface-primary/85 px-3 py-2">
                <div className="flex items-center gap-2 text-text-secondary">
                  <Sparkles className="h-3.5 w-3.5 text-fuchsia-500" />
                  预览模式
                </div>
                <div className="mt-2 text-xs font-medium text-text-primary">{activeTabLabel}</div>
              </div>
              <div className="rounded-2xl border border-border bg-surface-primary/85 px-3 py-2">
                <div className="flex items-center gap-2 text-text-secondary">
                  <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
                  会话状态
                </div>
                <div className="mt-2 text-xs font-medium text-text-primary">{editorChatSessionId ? '已绑定文件' : '初始化中'}</div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
