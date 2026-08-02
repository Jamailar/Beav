import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import type { ReviewDocketRecord } from '../types';
import { appAlert } from '../utils/appDialogs';

function formatDateTime(value?: string | number | null): string {
  if (!value) return '-';
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return String(value);
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function shortFingerprint(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  if (raw.length <= 18) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-8)}`;
}

function approvalStatusLabel(value?: string | null): string {
  switch (String(value || '').trim()) {
    case 'pending':
      return '待审';
    case 'approved':
      return '已批准';
    case 'rejected':
      return '已驳回';
    case 'changes_requested':
      return '需修改';
    case 'skipped':
      return '已跳过';
    case 'archived':
      return '已归档';
    default:
      return value || '未知';
  }
}

function approvalStatusTone(value?: string | null): string {
  switch (String(value || '').trim()) {
    case 'approved':
      return 'bg-status-success/10 text-status-success';
    case 'rejected':
      return 'bg-status-error/10 text-status-error';
    case 'changes_requested':
      return 'bg-status-warning/10 text-status-warning';
    case 'skipped':
    case 'archived':
      return 'bg-surface-secondary text-text-tertiary';
    default:
      return 'bg-accent-primary/10 text-accent-primary';
  }
}

function approvalPriorityLabel(value?: string | null): string {
  switch (String(value || '').trim()) {
    case 'urgent':
      return '紧急';
    case 'high':
      return '高';
    case 'low':
      return '低';
    default:
      return '普通';
  }
}

function approvalText(value?: string | null): string {
  const text = String(value || '').trim();
  return text || '-';
}

function optionText(option: unknown, key: 'id' | 'label' | 'description'): string {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return '';
  const value = (option as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function ApprovalPanel({
  isActive = true,
  targetDocketId = '',
}: {
  isActive?: boolean;
  targetDocketId?: string | null;
}) {
  const [dockets, setDockets] = useState<ReviewDocketRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [comment, setComment] = useState('');
  const docketsRef = useRef<ReviewDocketRecord[]>([]);

  useEffect(() => {
    docketsRef.current = dockets;
  }, [dockets]);

  const loadDockets = useCallback(async () => {
    if (docketsRef.current.length === 0) setLoading(true);
    setError('');
    try {
      const nextDockets = await window.ipcRenderer.teamRuntime.listReviewDockets({ limit: 80 });
      const normalized = Array.isArray(nextDockets) ? nextDockets : [];
      const targetId = String(targetDocketId || '').trim();
      setDockets(normalized);
      setSelectedId((current) => (
        targetId && normalized.some((item) => item.id === targetId && item.status === 'pending')
          ? targetId
          : current && normalized.some((item) => item.id === current && item.status === 'pending')
            ? current
            : normalized.find((item) => item.status === 'pending')?.id || normalized[0]?.id || ''
      ));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [targetDocketId]);

  useEffect(() => {
    const targetId = String(targetDocketId || '').trim();
    if (targetId) setSelectedId(targetId);
  }, [targetDocketId]);

  useEffect(() => {
    if (!isActive) return;
    void loadDockets();
  }, [isActive, loadDockets]);

  useEffect(() => {
    if (!isActive) return;
    const listener = (_event: unknown, envelope?: unknown) => {
      const eventRecord = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
      if (String(eventRecord.eventType || '') !== 'runtime:review-docket-changed') return;
      void loadDockets();
    };
    window.ipcRenderer.teamRuntime.onEvent(listener);
    return () => window.ipcRenderer.teamRuntime.offEvent(listener);
  }, [isActive, loadDockets]);

  const pendingDockets = useMemo(
    () => dockets.filter((item) => item.status === 'pending'),
    [dockets],
  );
  const selectedDocket = useMemo(
    () => pendingDockets.find((item) => item.id === selectedId) || pendingDockets[0] || null,
    [pendingDockets, selectedId],
  );
  const approvalOptions = useMemo(
    () => (selectedDocket?.options || [])
      .map((option) => ({
        id: optionText(option, 'id'),
        label: optionText(option, 'label') || optionText(option, 'id'),
        description: optionText(option, 'description'),
      }))
      .filter((option) => option.id && option.label),
    [selectedDocket?.options],
  );

  useEffect(() => {
    setComment('');
  }, [selectedDocket?.id]);

  const selectedIndex = selectedDocket
    ? Math.max(0, pendingDockets.findIndex((item) => item.id === selectedDocket.id))
    : -1;
  const nextPendingDocket = selectedDocket
    ? pendingDockets.find((item) => item.id !== selectedDocket.id) || null
    : null;
  const hasPendingDockets = pendingDockets.length > 0;

  const decide = useCallback(async (decision: string, selectedOptionId?: string) => {
    if (!selectedDocket || selectedDocket.status !== 'pending') return;
    try {
      setBusyAction(selectedOptionId || decision);
      await window.ipcRenderer.teamRuntime.decideReviewDocket({
        docketId: selectedDocket.id,
        decision,
        selectedOptionId,
        comment: comment.trim() || undefined,
      });
      const nextDocketId = nextPendingDocket?.id || '';
      await loadDockets();
      if (nextDocketId) setSelectedId(nextDocketId);
    } catch (decisionError) {
      void appAlert(decisionError instanceof Error ? decisionError.message : String(decisionError));
    } finally {
      setBusyAction('');
    }
  }, [comment, loadDockets, nextPendingDocket?.id, selectedDocket]);

  const skip = useCallback(async () => {
    if (!selectedDocket || selectedDocket.status !== 'pending') return;
    try {
      setBusyAction('skip');
      await window.ipcRenderer.teamRuntime.skipReviewDocket({ docketId: selectedDocket.id });
      const nextDocketId = nextPendingDocket?.id || '';
      await loadDockets();
      if (nextDocketId) setSelectedId(nextDocketId);
    } catch (skipError) {
      void appAlert(skipError instanceof Error ? skipError.message : String(skipError));
    } finally {
      setBusyAction('');
    }
  }, [loadDockets, nextPendingDocket?.id, selectedDocket]);

  return (
    <div className="h-full min-h-0 text-text-primary">
      <div className="mx-auto flex h-full min-h-0 max-w-[760px] flex-col gap-4 px-5 py-5">
        {error && (
          <div className="inline-flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2.5 text-[13px] text-status-error">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface-primary">
          {loading && !hasPendingDockets ? (
            <div className="flex h-full min-h-[320px] items-center justify-center text-[13px] text-text-tertiary">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              正在加载
            </div>
          ) : !selectedDocket ? (
            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-[13px] leading-6 text-text-tertiary">
              当前没有需要处理的审批。
            </div>
          ) : (
            <div className="flex min-h-full flex-col">
              <div className="border-b border-border px-5 py-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${approvalStatusTone(selectedDocket.status)}`}>
                    {approvalStatusLabel(selectedDocket.status)}
                  </span>
                  <span className="rounded-full bg-surface-secondary px-2.5 py-0.5 text-[11px] font-medium text-text-tertiary">
                    {approvalPriorityLabel(selectedDocket.priority)}
                  </span>
                  {selectedIndex >= 0 && (
                    <span className="rounded-full bg-accent-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-accent-primary">
                      {selectedIndex + 1}/{pendingDockets.length}
                    </span>
                  )}
                </div>
                <h2 className="mt-3 text-[21px] font-semibold tracking-[0] text-text-primary">
                  {selectedDocket.title || '未命名审批'}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
                  <span>{selectedDocket.sourceKind || '-'}</span>
                  <span>{shortFingerprint(selectedDocket.taskId || selectedDocket.sourceId)}</span>
                  <span>{formatDateTime(selectedDocket.createdAt)}</span>
                </div>
              </div>

              <div className="flex-1 space-y-4 px-5 py-4">
                <section>
                  <div className="text-[11px] font-medium text-text-tertiary">摘要</div>
                  <div className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-text-primary">
                    {approvalText(selectedDocket.summary)}
                  </div>
                </section>

                <section className="border-t border-border pt-4">
                  <div className="text-[11px] font-medium text-text-tertiary">正文</div>
                  <div className="mt-2 whitespace-pre-wrap text-[13px] leading-7 text-text-secondary">
                    {approvalText(selectedDocket.body)}
                  </div>
                </section>

                {selectedDocket.artifactRefs.length > 0 && (
                  <section className="border-t border-border pt-4">
                    <div className="text-[11px] font-medium text-text-tertiary">附件</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedDocket.artifactRefs.map((artifact) => (
                        <span key={artifact} className="rounded-md border border-border bg-surface-secondary px-2 py-1 text-[11px] text-text-secondary">
                          {artifact}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              <div className="border-t border-border bg-surface-secondary px-5 py-4">
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="审批意见"
                  className="h-[76px] w-full resize-none rounded-lg border border-border bg-surface-primary px-3 py-2 text-[13px] leading-6 text-text-primary outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15"
                />
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  <button
                    onClick={() => void skip()}
                    disabled={Boolean(busyAction)}
                    className="rounded-md border border-border bg-surface-primary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'skip' ? '处理中...' : '稍后'}
                  </button>
                  <button
                    onClick={() => void decide('changes_requested')}
                    disabled={Boolean(busyAction)}
                    className="rounded-md border border-border bg-surface-primary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'changes_requested' ? '处理中...' : '要求修改'}
                  </button>
                  <button
                    onClick={() => void decide('reject')}
                    disabled={Boolean(busyAction)}
                    className="rounded-md border border-status-error/20 bg-status-error/10 px-3 py-1.5 text-[12px] text-status-error hover:bg-status-error/15 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'reject' ? '处理中...' : '驳回'}
                  </button>
                  {approvalOptions.length > 0 ? (
                    approvalOptions.map((option) => (
                      <button
                        key={option.id}
                        onClick={() => void decide('approve', option.id)}
                        disabled={Boolean(busyAction)}
                        title={option.description || option.label}
                        className="inline-flex items-center rounded-md bg-accent-primary px-3 py-1.5 text-[12px] text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busyAction === option.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                        {busyAction === option.id ? '处理中...' : option.label}
                      </button>
                    ))
                  ) : (
                    <button
                      onClick={() => void decide('approve')}
                      disabled={Boolean(busyAction)}
                      className="inline-flex items-center rounded-md bg-accent-primary px-3 py-1.5 text-[12px] text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busyAction === 'approve' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                      {busyAction === 'approve' ? '处理中...' : '批准'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Approval(props: { isActive?: boolean; targetDocketId?: string | null }) {
  return <ApprovalPanel {...props} />;
}
