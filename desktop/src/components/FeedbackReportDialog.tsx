import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquareWarning, X } from 'lucide-react';
import { appAlert } from '../utils/appDialogs';

export const OPEN_FEEDBACK_REPORT_EVENT = 'redbox:open-feedback-report';

export type FeedbackReportContext = {
  title?: string;
  content?: string;
  sourcePage?: string;
  sessionId?: string;
  runtimeId?: string;
  operation?: string;
  errorCode?: string;
  detail?: string;
};

type FeedbackReportDialogProps = {
  open: boolean;
  context?: FeedbackReportContext | null;
  onClose: () => void;
  onSubmitted?: () => void;
};

function contextValue(context: FeedbackReportContext | null | undefined, key: keyof FeedbackReportContext): string {
  const value = context?.[key];
  return typeof value === 'string' ? value : '';
}

export function FeedbackReportDialog({
  open,
  context,
  onClose,
  onSubmitted,
}: FeedbackReportDialogProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [priority, setPriority] = useState<'medium' | 'high'>('medium');
  const [includeAdvancedContext, setIncludeAdvancedContext] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(contextValue(context, 'title'));
    setContent(contextValue(context, 'content') || contextValue(context, 'detail'));
    setContact('');
    setPriority('medium');
    setIncludeAdvancedContext(false);
    setValidationError('');
  }, [context, open]);

  const sourcePage = useMemo(() => contextValue(context, 'sourcePage') || 'desktop', [context]);

  if (!open) return null;

  const submit = async () => {
    if (isSubmitting) return;
    const nextTitle = title.trim();
    const nextContent = content.trim() || nextTitle;
    if (nextContent.length < 2) {
      setValidationError('请填写问题描述');
      return;
    }
    setIsSubmitting(true);
    setValidationError('');
    try {
      const result = await window.ipcRenderer.logs.createFeedbackReport({
        title: nextTitle || nextContent.slice(0, 40),
        content: nextContent,
        contact: contact.trim(),
        category: 'desktop_bug',
        priority,
        source: 'desktop',
        includeAdvancedContext,
        uploadNow: true,
        context: {
          window: sourcePage,
          sessionId: contextValue(context, 'sessionId'),
          runtimeId: contextValue(context, 'runtimeId'),
          operation: contextValue(context, 'operation'),
          errorCode: contextValue(context, 'errorCode'),
        },
      });
      if (!result?.success) {
        throw new Error(result?.error || '提交失败');
      }
      onClose();
      onSubmitted?.();
      if (result.uploaded) {
        await appAlert('问题已提交。');
      } else {
        await appAlert(result.error ? `已保存待发送报告：${result.error}` : '已保存待发送报告。');
      }
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : '提交失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm">
      <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquareWarning className="h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.9} />
            <div className="truncate text-sm font-semibold text-text-primary">反馈问题</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-60"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">标题</label>
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setValidationError('');
              }}
              placeholder="哪里出了问题"
              className="w-full rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">问题描述</label>
            <textarea
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setValidationError('');
              }}
              placeholder="发生了什么，期望结果是什么"
              rows={5}
              className="w-full resize-none rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm leading-5 text-text-primary outline-none transition-colors focus:border-accent-primary"
            />
            {validationError ? (
              <div className="mt-1.5 text-xs text-red-500">{validationError}</div>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">联系方式</label>
              <input
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                placeholder="可选"
                className="w-full rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">优先级</label>
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value === 'high' ? 'high' : 'medium')}
                className="w-full rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
              >
                <option value="medium">普通</option>
                <option value="high">高</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={includeAdvancedContext}
              onChange={(event) => setIncludeAdvancedContext(event.target.checked)}
              className="rounded border-border"
            />
            附带高级诊断数据
          </label>
          <div className="rounded-md border border-border bg-surface-secondary/25 px-3 py-2 text-[11px] leading-5 text-text-tertiary">
            会自动附带最近日志并脱敏。
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={isSubmitting}
            className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
