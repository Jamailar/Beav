import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Check, Columns, Loader2, MessageSquare, Sparkles, X } from 'lucide-react';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownItPreview } from './MarkdownItPreview';
import { resolveAssetUrl } from '../../utils/pathManager';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type WritingDraftType = 'longform' | 'unknown';
type WritingWorkbenchTab = 'manuscript' | 'layout' | 'wechat';

type HtmlPreviewSource = {
  filePath?: string | null;
  fileUrl?: string | null;
  exists?: boolean;
  hasContent?: boolean;
  updatedAt?: number | null;
};

type MediaAssetLike = {
  id: string;
  title?: string;
  relativePath?: string;
  absolutePath?: string;
  previewUrl?: string;
};

type LongformLayoutPreset = {
  id?: string;
  label?: string;
  description?: string | null;
  surfaceColor?: string | null;
  textColor?: string | null;
  accentColor?: string | null;
};

type AiWorkspaceMode = {
  id: string;
  label: string;
  activeSkills: string[];
};

type PackageStateLike = Record<string, unknown>;

export interface WritingDraftWorkbenchProps {
  draftType: WritingDraftType;
  title: string;
  filePath: string;
  editorBody: string;
  writeProposal?: {
    baseBody: string;
    isStale?: boolean;
  } | null;
  editorBodyDirty: boolean;
  isSavingEditorBody: boolean;
  isApplyingWriteProposal?: boolean;
  isRejectingWriteProposal?: boolean;
  editorChatSessionId: string | null;
  editorChatReady?: boolean;
  isActive?: boolean;
  previewHtml?: string | null;
  layoutPreview?: HtmlPreviewSource | null;
  wechatPreview?: HtmlPreviewSource | null;
  longformLayoutPresetId?: string | null;
  longformLayoutPresets?: LongformLayoutPreset[];
  isApplyingLongformLayoutPreset?: boolean;
  hasGeneratedHtml?: boolean;
  coverAsset?: MediaAssetLike | null;
  imageAssets?: MediaAssetLike[];
  onEditorBodyChange: (value: string) => void;
  onAcceptWriteProposal?: () => void;
  onRejectWriteProposal?: () => void;
  onAiWorkspaceModeChange?: (mode: AiWorkspaceMode) => void;
  onSelectLongformLayoutPreset?: (presetId: string, target: 'layout' | 'wechat') => void;
  onPackageStateChange?: (state: PackageStateLike) => void;
}

const LONGFORM_SHORTCUTS = [
  { label: '润色结构', text: '请先阅读当前长文内容，重新整理段落结构，并给出更清晰的起承转合。' },
  { label: '压缩篇幅', text: '请在保留核心观点的前提下，把当前长文压缩成更利于阅读的版本。' },
  { label: '扩写重点', text: '请找出当前长文最值得展开的部分，并直接补全为更完整的正文。' },
  { label: '公众号风格', text: '请把当前长文改成更适合公众号阅读和排版的表达方式。' },
];

const EDITOR_AI_CONTEXT_MAX_CHARS = 80000;
const WRITING_EDITOR_ALLOWED_TOOLS = ['app_cli'];
const WRITING_EDITOR_ALLOWED_APP_CLI_ACTIONS = ['manuscripts.writeCurrent'];
const LONGFORM_LAYOUT_SKILL_NAME = 'longform-layout-designer';

function buildWritingEditorAiContext({
  title,
  filePath,
  draftType,
  editorBody,
}: {
  title: string;
  filePath: string;
  draftType: WritingDraftType;
  editorBody: string;
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
    '```markdown',
    bodyForContext,
    '```',
  ].join('\n');
}

function normalizePreviewUrl(source?: HtmlPreviewSource | null): string {
  const value = String(source?.fileUrl || source?.filePath || '').trim();
  return value ? resolveAssetUrl(value) : '';
}

function ManuscriptEditor({
  editorBody,
  writeProposal,
  onEditorBodyChange,
  compact = false,
}: {
  editorBody: string;
  writeProposal?: WritingDraftWorkbenchProps['writeProposal'];
  onEditorBodyChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={clsx('h-full min-h-0', compact ? 'p-0' : 'p-5')}>
      <div className="h-full min-h-0 overflow-hidden rounded-2xl border border-border bg-surface-primary">
        <CodeMirrorEditor
          value={editorBody}
          onChange={onEditorBodyChange}
          diffOriginalValue={writeProposal?.baseBody ?? null}
          className="manuscript-editor-shell h-full min-h-0 bg-transparent"
        />
      </div>
    </div>
  );
}

function LongformPreview({
  title,
  editorBody,
  previewHtml,
  previewSource,
  coverAsset,
  hasGeneratedHtml,
  previewLabel = '排版',
  compact = false,
}: {
  title: string;
  editorBody: string;
  previewHtml?: string | null;
  previewSource?: HtmlPreviewSource | null;
  coverAsset?: MediaAssetLike | null;
  hasGeneratedHtml?: boolean;
  previewLabel?: string;
  compact?: boolean;
}) {
  const previewUrl = normalizePreviewUrl(previewSource);
  const coverUrl = coverAsset ? resolveAssetUrl(coverAsset.previewUrl || coverAsset.absolutePath || coverAsset.relativePath || '') : '';
  const canUseHtmlPreview = Boolean(previewSource?.exists || previewSource?.hasContent || previewUrl || previewHtml);

  return (
    <div className={clsx('h-full min-h-0 overflow-auto bg-background', compact ? 'p-3' : 'p-6')}>
      {canUseHtmlPreview && previewUrl ? (
        <iframe
          title={`${previewLabel}预览`}
          src={previewUrl}
          className="h-full min-h-[520px] w-full rounded-2xl border border-border bg-white"
          sandbox="allow-scripts allow-same-origin"
        />
      ) : canUseHtmlPreview && previewHtml ? (
        <iframe
          title={`${previewLabel}预览`}
          srcDoc={previewHtml}
          className="h-full min-h-[520px] w-full rounded-2xl border border-border bg-white"
          sandbox="allow-scripts allow-same-origin"
        />
      ) : (
        <article className="mx-auto max-w-[760px] rounded-2xl border border-border bg-surface-primary px-8 py-8 shadow-sm">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="mb-6 max-h-[320px] w-full rounded-xl object-cover" />
          ) : null}
          <h1 className="mb-5 text-3xl font-semibold tracking-tight text-text-primary">{title || '未命名'}</h1>
          <MarkdownItPreview content={editorBody || (hasGeneratedHtml ? '' : '暂无内容')} />
        </article>
      )}
    </div>
  );
}

export function WritingDraftWorkbench({
  draftType,
  title,
  filePath,
  editorBody,
  writeProposal = null,
  editorBodyDirty,
  isSavingEditorBody,
  isApplyingWriteProposal = false,
  isRejectingWriteProposal = false,
  editorChatSessionId,
  editorChatReady = true,
  isActive = false,
  previewHtml,
  layoutPreview = null,
  wechatPreview = null,
  longformLayoutPresetId = null,
  longformLayoutPresets = [],
  isApplyingLongformLayoutPreset = false,
  hasGeneratedHtml = false,
  coverAsset = null,
  onEditorBodyChange,
  onAcceptWriteProposal,
  onRejectWriteProposal,
  onAiWorkspaceModeChange,
  onSelectLongformLayoutPreset,
}: WritingDraftWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WritingWorkbenchTab>('manuscript');
  const [isSplitCompareEnabled, setIsSplitCompareEnabled] = useState(false);
  const [splitPreviewTab, setSplitPreviewTab] = useState<WritingWorkbenchTab>('layout');
  const [isLongformLayoutDrawerOpen, setIsLongformLayoutDrawerOpen] = useState(false);

  const isLongform = draftType === 'longform';
  const canSplitCompare = isLongform;
  const tabs = useMemo(() => {
    const nextTabs: Array<{ id: WritingWorkbenchTab; label: string }> = [
      { id: 'manuscript', label: '稿件' },
      { id: 'layout', label: '排版' },
    ];
    if (wechatPreview?.exists || wechatPreview?.hasContent || wechatPreview?.fileUrl) {
      nextTabs.push({ id: 'wechat', label: '公众号' });
    }
    return nextTabs;
  }, [wechatPreview?.exists, wechatPreview?.fileUrl, wechatPreview?.hasContent]);

  useEffect(() => {
    setActiveTab('manuscript');
    setIsSplitCompareEnabled(false);
    setIsLongformLayoutDrawerOpen(false);
  }, [draftType, filePath]);

  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTab)) return;
    setActiveTab('manuscript');
  }, [activeTab, tabs]);

  const splitPreviewOptions = useMemo(() => [{ id: 'layout' as const, label: '长文排版' }], []);

  useEffect(() => {
    if (!splitPreviewOptions.some((item) => item.id === splitPreviewTab)) {
      setSplitPreviewTab('layout');
    }
  }, [splitPreviewOptions, splitPreviewTab]);

  const aiWorkspaceMode = useMemo<AiWorkspaceMode>(() => {
    const inLayoutMode = isLongform && (
      activeTab === 'layout'
      || activeTab === 'wechat'
      || (activeTab === 'manuscript' && isSplitCompareEnabled)
    );
    if (inLayoutMode) {
      return { id: 'article-layout', label: '长文排版', activeSkills: [LONGFORM_LAYOUT_SKILL_NAME] };
    }
    return { id: 'manuscript-editing', label: '稿件编辑', activeSkills: [] };
  }, [activeTab, isLongform, isSplitCompareEnabled]);

  useEffect(() => {
    onAiWorkspaceModeChange?.(aiWorkspaceMode);
  }, [aiWorkspaceMode, onAiWorkspaceModeChange]);

  const editorChatMessageContext = useMemo(() => buildWritingEditorAiContext({
    title,
    filePath,
    draftType,
    editorBody,
  }), [draftType, editorBody, filePath, title]);

  const editorChatTaskHints = useMemo(() => ({
    intent: 'manuscript_editing',
    sourceManuscriptPath: filePath,
    sourceManuscriptTitle: title,
    sourceManuscriptDraftType: draftType,
    currentAuthoringProjectPath: filePath,
    currentAuthoringContentPath: filePath,
    writeTarget: 'manuscripts://current',
    allowedWriteTargets: ['manuscripts://current'],
    allowedTools: WRITING_EDITOR_ALLOWED_TOOLS,
    allowedAppCliActions: WRITING_EDITOR_ALLOWED_APP_CLI_ACTIONS,
    mode: aiWorkspaceMode.id,
    activeSkills: aiWorkspaceMode.activeSkills,
    initialContext: editorChatMessageContext,
  }), [aiWorkspaceMode, draftType, editorChatMessageContext, filePath, title]);

  const normalizedLongformLayoutPresets = useMemo(() => (
    longformLayoutPresets
      .filter((preset) => typeof preset.id === 'string' && preset.id.trim())
      .map((preset) => ({
        ...preset,
        id: String(preset.id || '').trim(),
        label: String(preset.label || preset.id || '').trim(),
      }))
  ), [longformLayoutPresets]);

  const renderPreviewContent = (tab: WritingWorkbenchTab, compact = false) => {
    if (tab === 'layout') {
      return (
        <LongformPreview
          title={title}
          editorBody={editorBody}
          previewHtml={previewHtml}
          previewSource={layoutPreview}
          coverAsset={coverAsset}
          hasGeneratedHtml={hasGeneratedHtml}
          previewLabel="排版"
          compact={compact}
        />
      );
    }
    if (tab === 'wechat') {
      return (
        <LongformPreview
          title={title}
          editorBody={editorBody}
          previewSource={wechatPreview}
          coverAsset={coverAsset}
          hasGeneratedHtml={hasGeneratedHtml}
          previewLabel="公众号"
          compact={compact}
        />
      );
    }
    return (
      <LongformPreview
        title={title}
        editorBody={editorBody}
        coverAsset={coverAsset}
        hasGeneratedHtml={false}
        compact={compact}
      />
    );
  };

  const renderPreviewSurface = (tab: WritingWorkbenchTab, compact = false) => {
    const longformPresetTarget = tab === 'wechat' ? 'wechat' : 'layout';
    const shouldShowLongformLayoutDrawer = isLongform && (tab === 'layout' || tab === 'wechat');
    return (
      <div className="relative h-full min-h-0">
        {renderPreviewContent(tab, compact)}
        {shouldShowLongformLayoutDrawer ? (
          <>
            <button
              type="button"
              onClick={() => setIsLongformLayoutDrawerOpen((current) => !current)}
              className={clsx(
                compact
                  ? 'absolute right-2 top-2 z-20 rounded-full border border-border bg-surface-primary/92 p-2 text-text-tertiary shadow-sm backdrop-blur transition hover:text-text-primary'
                  : 'absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-surface-primary/92 p-2 text-text-tertiary shadow-sm backdrop-blur transition hover:text-text-primary',
                isLongformLayoutDrawerOpen && 'pointer-events-none opacity-0'
              )}
              aria-label="打开长文母版抽屉"
              title="长文母版"
            >
              <Sparkles className="h-4 w-4" />
            </button>
            <div
              className={clsx(
                'absolute inset-0 z-20 bg-black/10 transition-opacity',
                isLongformLayoutDrawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
              onClick={() => setIsLongformLayoutDrawerOpen(false)}
            />
            <aside
              className={clsx(
                'absolute inset-y-0 right-0 z-30 flex w-[320px] max-w-[78vw] flex-col border-l border-border bg-surface-primary shadow-2xl transition-transform duration-200',
                isLongformLayoutDrawerOpen ? 'translate-x-0' : 'translate-x-full'
              )}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-text-primary">长文母版</div>
                  <div className="mt-1 text-xs text-text-tertiary">只改母版和 HTML 样式，不改正文内容。</div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsLongformLayoutDrawerOpen(false)}
                  className="rounded-full border border-border p-1.5 text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary"
                  aria-label="关闭长文母版抽屉"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="border-b border-border px-4 py-2 text-[11px] text-text-tertiary">
                当前目标：{longformPresetTarget === 'wechat' ? '公众号' : '长文排版'}
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
                <div className="space-y-3">
                  {normalizedLongformLayoutPresets.map((preset) => {
                    const presetId = String(preset.id || '');
                    const active = presetId === longformLayoutPresetId;
                    return (
                      <button
                        key={presetId}
                        type="button"
                        onClick={() => {
                          onSelectLongformLayoutPreset?.(presetId, longformPresetTarget);
                          setIsLongformLayoutDrawerOpen(false);
                        }}
                        disabled={isApplyingLongformLayoutPreset}
                        className={clsx(
                          'w-full rounded-2xl border px-4 py-4 text-left transition',
                          active
                            ? 'border-accent-primary/40 bg-accent-primary/10'
                            : 'border-border bg-surface-secondary/45 hover:border-accent-primary/20 hover:bg-surface-secondary/70',
                          isApplyingLongformLayoutPreset && 'opacity-70'
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="truncate text-sm font-semibold text-text-primary">{preset.label || presetId}</div>
                          <div className={clsx('text-[11px] font-medium', active ? 'text-accent-primary' : 'text-text-tertiary')}>
                            {active ? '当前' : '应用'}
                          </div>
                        </div>
                        {preset.description ? (
                          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{preset.description}</div>
                        ) : null}
                        <div className="mt-3 flex items-center gap-2">
                          <span className="h-6 w-6 rounded-full border border-border/70" style={{ background: preset.surfaceColor || '#ffffff' }} />
                          <span className="h-6 w-6 rounded-full border border-border/70" style={{ background: preset.accentColor || '#111111' }} />
                          <span className="h-6 w-6 rounded-full border border-border/70" style={{ background: preset.textColor || '#111111' }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] bg-surface-primary text-text-primary">
      <section className="relative min-h-0 border-r border-border bg-background">
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
            {activeTab === 'manuscript' && canSplitCompare ? (
              <button
                type="button"
                onClick={() => setIsSplitCompareEnabled((current) => !current)}
                className={clsx(
                  'ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition',
                  isSplitCompareEnabled
                    ? 'border-accent-primary/35 bg-accent-primary/10 text-text-primary'
                    : 'border-border bg-transparent text-text-tertiary hover:bg-surface-secondary/50 hover:text-text-primary'
                )}
                aria-label={isSplitCompareEnabled ? '关闭分栏对比' : '打开分栏对比'}
                title={isSplitCompareEnabled ? '关闭分栏对比' : '打开分栏对比'}
              >
                <Columns className="h-4 w-4" />
                <span>分栏</span>
              </button>
            ) : null}
            {activeTab === 'manuscript' && writeProposal ? (
              <div className={clsx('flex items-center gap-2', !canSplitCompare && 'ml-auto')}>
                {writeProposal.isStale ? (
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full text-amber-700" title="稿件在提案生成后发生过变化" aria-label="稿件在提案生成后发生过变化">
                    <AlertTriangle className="h-4 w-4" />
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRejectWriteProposal?.()}
                  disabled={isApplyingWriteProposal || isRejectingWriteProposal}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary disabled:opacity-35"
                  aria-label="拒绝 AI 修改"
                  title="拒绝 AI 修改"
                >
                  {isRejectingWriteProposal ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => onAcceptWriteProposal?.()}
                  disabled={isApplyingWriteProposal || isRejectingWriteProposal}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-primary text-white transition hover:bg-accent-primary/92 disabled:opacity-35"
                  aria-label="接受 AI 修改"
                  title="接受 AI 修改"
                >
                  {isApplyingWriteProposal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                </button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'manuscript' && isSplitCompareEnabled ? (
              <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section className="flex min-h-0 min-w-0 flex-col border-r border-border">
                  <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <div className="text-sm font-semibold text-text-primary">原稿</div>
                    {editorBodyDirty || isSavingEditorBody ? (
                      <div className="text-xs text-text-tertiary">
                        {isSavingEditorBody ? '保存中' : '未保存'}
                      </div>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ManuscriptEditor
                      editorBody={editorBody}
                      writeProposal={writeProposal}
                      onEditorBodyChange={onEditorBodyChange}
                      compact
                    />
                  </div>
                </section>
                <section className="flex min-h-0 min-w-0 flex-col">
                  <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <div className="text-sm font-semibold text-text-primary">排版</div>
                    <div className="flex items-center gap-2">
                      {splitPreviewOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setSplitPreviewTab(option.id)}
                          className={clsx(
                            'rounded-full border px-3 py-1 text-xs transition',
                            splitPreviewTab === option.id
                              ? 'border-accent-primary/35 bg-accent-primary/10 text-text-primary'
                              : 'border-transparent bg-transparent text-text-tertiary hover:border-border hover:bg-surface-secondary/50 hover:text-text-primary'
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {renderPreviewSurface(splitPreviewTab, true)}
                  </div>
                </section>
              </div>
            ) : activeTab === 'manuscript' ? (
              <ManuscriptEditor
                editorBody={editorBody}
                writeProposal={writeProposal}
                onEditorBodyChange={onEditorBodyChange}
              />
            ) : (
              renderPreviewSurface(activeTab)
            )}
          </div>
        </div>
      </section>

      <aside className="min-h-0 bg-surface-secondary/55">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border px-5 py-3">
            <div className="text-[11px] font-medium tracking-wide text-text-tertiary">当前页面</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <MessageSquare className="h-4 w-4 text-accent-primary" />
              {aiWorkspaceMode.label}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {editorChatSessionId && editorChatReady ? (
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
                  welcomeTitle={aiWorkspaceMode.label}
                  welcomeSubtitle="围绕当前长文继续改结构、润色正文、生成发布版本。"
                  shortcuts={LONGFORM_SHORTCUTS}
                  welcomeShortcuts={LONGFORM_SHORTCUTS}
                  fixedSessionTaskHints={editorChatTaskHints}
                  fixedSessionBannerText={aiWorkspaceMode.label}
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary/70" />
                  <div className="mt-3 text-sm text-text-secondary">
                    {editorChatSessionId ? '正在同步当前页面上下文...' : '正在初始化 AI 会话...'}
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
