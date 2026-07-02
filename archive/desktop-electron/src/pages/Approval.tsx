import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2, MessageSquare, ShieldCheck, X } from 'lucide-react';
import type { SessionBridgePermissionRequest } from '../types';
import { appAlert } from '../utils/appDialogs';

interface ApprovalProps {
  isActive?: boolean;
  targetRequestId?: string | null;
  onOpenRedClawSession?: (sessionId: string) => void;
}

function formatDateTime(value?: number | string | null): string {
  if (!value) return '-';
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return String(value);
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function shortId(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  if (raw.length <= 18) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-8)}`;
}

function permissionTone(type?: string): string {
  switch (String(type || '').trim()) {
    case 'exec':
      return 'bg-status-warning/10 text-status-warning';
    case 'edit':
      return 'bg-accent-primary/10 text-accent-primary';
    default:
      return 'bg-surface-secondary text-text-tertiary';
  }
}

function permissionTypeLabel(type?: string): string {
  switch (String(type || '').trim()) {
    case 'exec':
      return '执行';
    case 'edit':
      return '编辑';
    case 'info':
      return '读取';
    default:
      return '权限';
  }
}

function previewParams(params: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(params, null, 2);
    return text.length > 1600 ? `${text.slice(0, 1600)}\n...` : text;
  } catch {
    return '';
  }
}

export function Approval({ isActive = true, targetRequestId = '', onOpenRedClawSession }: ApprovalProps) {
  const [requests, setRequests] = useState<SessionBridgePermissionRequest[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const requestsRef = useRef<SessionBridgePermissionRequest[]>([]);

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  const loadRequests = useCallback(async () => {
    if (requestsRef.current.length === 0) {
      setLoading(true);
    }
    setError('');
    try {
      const next = await window.ipcRenderer.sessionBridge.listPermissions();
      const pending = (Array.isArray(next) ? next : [])
        .filter((item) => item.status === 'pending')
        .sort((left, right) => left.createdAt - right.createdAt);
      const targetId = String(targetRequestId || '').trim();
      setRequests(pending);
      setSelectedId((current) => (
        targetId && pending.some((item) => item.id === targetId)
          ? targetId
          : current && pending.some((item) => item.id === current)
            ? current
            : pending[0]?.id || ''
      ));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [targetRequestId]);

  useEffect(() => {
    const targetId = String(targetRequestId || '').trim();
    if (targetId) setSelectedId(targetId);
  }, [targetRequestId]);

  useEffect(() => {
    if (!isActive) return;
    void loadRequests();
    const timer = window.setInterval(() => {
      void loadRequests();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [isActive, loadRequests]);

  const selectedRequest = useMemo(
    () => requests.find((item) => item.id === selectedId) || requests[0] || null,
    [requests, selectedId],
  );
  const selectedIndex = selectedRequest
    ? Math.max(0, requests.findIndex((item) => item.id === selectedRequest.id))
    : -1;

  const resolve = useCallback(async (outcome: 'proceed_once' | 'proceed_always' | 'cancel') => {
    if (!selectedRequest || busyAction) return;
    setBusyAction(outcome);
    try {
      const result = await window.ipcRenderer.sessionBridge.resolvePermission({
        requestId: selectedRequest.id,
        outcome,
      });
      if (!result?.success) {
        throw new Error(result?.error || '处理审批失败');
      }
      const nextRequestId = requests.find((item) => item.id !== selectedRequest.id)?.id || '';
      await loadRequests();
      if (nextRequestId) setSelectedId(nextRequestId);
    } catch (resolveError) {
      void appAlert(resolveError instanceof Error ? resolveError.message : String(resolveError));
    } finally {
      setBusyAction('');
    }
  }, [busyAction, loadRequests, requests, selectedRequest]);

  return (
    <div className="h-full min-h-0 text-text-primary">
      <div className="mx-auto flex h-full min-h-0 max-w-[820px] flex-col gap-4 px-5 py-5">
        {error && (
          <button
            type="button"
            onClick={() => void loadRequests()}
            className="inline-flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2.5 text-left text-[13px] text-status-error"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </button>
        )}

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface-primary">
          {loading && requests.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center text-[13px] text-text-tertiary">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              正在加载
            </div>
          ) : !selectedRequest ? (
            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-[13px] leading-6 text-text-tertiary">
              当前没有需要处理的审批。
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-border px-5 py-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${permissionTone(selectedRequest.details.type)}`}>
                    {permissionTypeLabel(selectedRequest.details.type)}
                  </span>
                  <span className="rounded-full bg-accent-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-accent-primary">
                    {selectedIndex + 1}/{requests.length}
                  </span>
                  <span className="rounded-full bg-surface-secondary px-2.5 py-0.5 text-[11px] font-medium text-text-tertiary">
                    {selectedRequest.toolName}
                  </span>
                </div>
                <h2 className="mt-3 text-[21px] font-semibold tracking-[0] text-text-primary">
                  {selectedRequest.details.title || '需要确认操作'}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
                  <span>{shortId(selectedRequest.sessionId)}</span>
                  <span>{shortId(selectedRequest.callId)}</span>
                  <span>{formatDateTime(selectedRequest.createdAt)}</span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <section>
                  <div className="text-[11px] font-medium text-text-tertiary">说明</div>
                  <div className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-text-primary">
                    {selectedRequest.details.description || '-'}
                  </div>
                </section>

                {selectedRequest.details.impact && (
                  <section className="mt-4 border-t border-border pt-4">
                    <div className="text-[11px] font-medium text-text-tertiary">影响</div>
                    <div className="mt-2 whitespace-pre-wrap text-[13px] leading-7 text-text-secondary">
                      {selectedRequest.details.impact}
                    </div>
                  </section>
                )}

                <section className="mt-4 border-t border-border pt-4">
                  <div className="text-[11px] font-medium text-text-tertiary">参数</div>
                  <pre className="mt-2 max-h-[260px] overflow-auto rounded-lg border border-border bg-surface-secondary p-3 text-[11px] leading-5 text-text-secondary">
                    {previewParams(selectedRequest.params) || '{}'}
                  </pre>
                </section>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-secondary px-5 py-4">
                <div>
                  {selectedRequest.sessionId && onOpenRedClawSession && (
                    <button
                      type="button"
                      onClick={() => onOpenRedClawSession(selectedRequest.sessionId)}
                      className="inline-flex items-center rounded-md border border-border bg-surface-primary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-tertiary"
                    >
                      <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                      打开会话
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void resolve('cancel')}
                    disabled={Boolean(busyAction)}
                    className="inline-flex items-center rounded-md border border-status-error/20 bg-status-error/10 px-3 py-1.5 text-[12px] text-status-error hover:bg-status-error/15 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'cancel' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
                    {busyAction === 'cancel' ? '处理中...' : '拒绝'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolve('proceed_once')}
                    disabled={Boolean(busyAction)}
                    className="inline-flex items-center rounded-md border border-border bg-surface-primary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'proceed_once' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                    {busyAction === 'proceed_once' ? '处理中...' : '允许一次'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolve('proceed_always')}
                    disabled={Boolean(busyAction)}
                    className="inline-flex items-center rounded-md bg-accent-primary px-3 py-1.5 text-[12px] text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyAction === 'proceed_always' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}
                    {busyAction === 'proceed_always' ? '处理中...' : '始终允许'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
