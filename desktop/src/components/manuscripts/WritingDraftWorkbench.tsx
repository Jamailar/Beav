import { lazy, Suspense, useEffect, useMemo } from 'react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { CodeMirrorEditor } from './CodeMirrorEditor';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type WritingDraftType = 'longform' | 'unknown';

type AiWorkspaceMode = {
  id: string;
  label: string;
};

export interface WritingDraftWorkbenchProps {
  draftType: WritingDraftType;
  title: string;
  filePath: string;
  editorBody: string;
  writeProposal?: {
    id?: string;
    baseBody: string;
    isStale?: boolean;
  } | null;
  editorBodyDirty: boolean;
  isSavingEditorBody: boolean;
  isApplyingWriteProposal?: boolean;
  isRejectingWriteProposal?: boolean;
  editorChatSessionId: string | null;
  editorChatReady?: boolean;
  editorSessionMetadata?: Record<string, unknown> | null;
  isActive?: boolean;
  onEditorBodyChange: (value: string) => void;
  onAcceptWriteProposal?: () => void;
  onRejectWriteProposal?: () => void;
  onAiWorkspaceModeChange?: (mode: AiWorkspaceMode) => void;
}

const EDITOR_AI_CONTEXT_MAX_CHARS = 80000;

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
  editorSessionMetadata = null,
  isActive = false,
  onEditorBodyChange,
  onAcceptWriteProposal,
  onRejectWriteProposal,
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
  }), [draftType, editorBody, filePath, title]);

  const editorChatTaskHints = useMemo(() => ({
    ...(editorSessionMetadata || {}),
    mode: aiWorkspaceMode.id,
    initialContext: editorChatMessageContext,
  }), [aiWorkspaceMode.id, editorChatMessageContext, editorSessionMetadata]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] bg-surface-primary text-text-primary">
      <section className="relative min-h-0 border-r border-border bg-surface-primary">
        <div className="flex h-full min-h-0 flex-col">
          {(editorBodyDirty || isSavingEditorBody || writeProposal) ? (
            <div className="absolute right-5 top-4 z-20 flex items-center gap-2">
              {editorBodyDirty || isSavingEditorBody ? (
                <div className="rounded-full bg-surface-primary/86 px-2.5 py-1 text-xs font-medium text-text-tertiary shadow-sm ring-1 ring-border/70 backdrop-blur">
                  {isSavingEditorBody ? '保存中' : '未保存'}
                </div>
              ) : null}
              {writeProposal ? (
                <div className="flex items-center gap-2 rounded-full bg-surface-primary/86 p-1 shadow-sm ring-1 ring-border/70 backdrop-blur">
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
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            <CodeMirrorEditor
              key={`${filePath}:${writeProposal?.id || 'body'}`}
              value={editorBody}
              onChange={onEditorBodyChange}
              diffOriginalValue={writeProposal?.baseBody ?? null}
              className="manuscript-editor-shell h-full min-h-0 bg-transparent"
            />
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
