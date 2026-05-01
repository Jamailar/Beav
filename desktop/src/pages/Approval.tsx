import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Bell, Check, Loader2, RefreshCw } from 'lucide-react';
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
            return 'bg-[#dff2ee] text-[#4b7f76]';
        case 'rejected':
            return 'bg-[#f8dfdf] text-[#94545c]';
        case 'changes_requested':
            return 'bg-[#f7ead7] text-[#8c6a3c]';
        case 'skipped':
        case 'archived':
            return 'bg-[#edf0f4] text-[#6f7682]';
        default:
            return 'bg-[#efe5d6] text-[#6d553a]';
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

function ApprovalMetaPill({ label, value }: { label: string; value: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#ece4d8] bg-white px-2.5 py-1 text-[11px] text-[#7d766a]">
            <span className="text-[#a09789]">{label}</span>
            <span className="font-medium text-[#4c463f]">{value}</span>
        </span>
    );
}

export function Approval({ isActive = true }: { isActive?: boolean }) {
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
            setDockets(normalized);
            setSelectedId((current) => (
                current && normalized.some((item) => item.id === current)
                    ? current
                    : normalized.find((item) => item.status === 'pending')?.id || normalized[0]?.id || ''
            ));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, []);

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
        () => dockets.find((item) => item.id === selectedId) || pendingDockets[0] || dockets[0] || null,
        [dockets, pendingDockets, selectedId],
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

    const decide = useCallback(async (decision: string) => {
        if (!selectedDocket || selectedDocket.status !== 'pending') return;
        try {
            setBusyAction(decision);
            await window.ipcRenderer.teamRuntime.decideReviewDocket({
                docketId: selectedDocket.id,
                decision,
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
        <div className="legacy-theme-panel h-full min-h-0 bg-[#fbfaf7] text-[#191919]">
            <div className="flex h-full min-h-0 flex-col gap-4 px-6 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-[#ece3d5] bg-white px-2.5 py-1 text-[11px] text-[#7c7468]">
                        <Bell className="h-3 w-3" />
                        审批
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <ApprovalMetaPill label="待审" value={String(pendingDockets.length)} />
                        <button
                            onClick={() => void loadDockets()}
                            className="inline-flex h-[32px] items-center gap-1.5 rounded-full border border-[#e7e0d4] bg-white px-3 text-[11px] text-[#7d766a] shadow-[0_1px_2px_rgba(24,24,24,0.03)] hover:bg-[#f5f1e9]"
                        >
                            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                            刷新
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-700">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {error}
                    </div>
                )}

                <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
                    <div className="min-h-0 overflow-hidden rounded-[24px] border border-[#ece4d8] bg-white">
                        <div className="flex items-center justify-between border-b border-[#f0e9de] px-4 py-3">
                            <div className="text-[13px] font-medium text-[#1d1b18]">事项</div>
                            <div className="text-[11px] text-[#9a9184]">{dockets.length} 件</div>
                        </div>
                        <div className="h-[calc(100%-45px)] overflow-y-auto px-2.5 py-2.5">
                            {loading && dockets.length === 0 ? (
                                <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[#7b7469]">
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                    正在加载
                                </div>
                            ) : dockets.length === 0 ? (
                                <div className="flex h-full min-h-[240px] items-center justify-center px-5 text-center text-[13px] leading-6 text-[#7b7469]">
                                    暂无待处理审批。
                                </div>
                            ) : (
                                <div className="space-y-2.5">
                                    {dockets.map((docket) => {
                                        const active = selectedDocket?.id === docket.id;
                                        return (
                                            <button
                                                key={docket.id}
                                                onClick={() => setSelectedId(docket.id)}
                                                className={`w-full rounded-[18px] border px-3 py-2.5 text-left transition ${
                                                    active
                                                        ? 'border-[#d5b68b] bg-[#fbf2e6] shadow-[0_10px_24px_rgba(95,70,35,0.06)]'
                                                        : 'border-[#eee7dc] bg-[#fdfcf9] hover:border-[#e1d4c2] hover:bg-white'
                                                }`}
                                            >
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${approvalStatusTone(docket.status)}`}>
                                                        {approvalStatusLabel(docket.status)}
                                                    </span>
                                                    <span className="rounded-full bg-[#eef1f5] px-2 py-0.5 text-[10px] font-medium text-[#687180]">
                                                        {approvalPriorityLabel(docket.priority)}
                                                    </span>
                                                </div>
                                                <div className="mt-2 line-clamp-2 text-[13px] font-semibold leading-5 text-[#1d1b18]">
                                                    {docket.title || '未命名审批'}
                                                </div>
                                                <div className="mt-1.5 text-[11px] text-[#877f73]">
                                                    {formatDateTime(docket.createdAt)}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="min-h-0 overflow-y-auto rounded-[24px] border border-[#ece4d8] bg-white px-5 py-5">
                        {!selectedDocket ? (
                            <div className="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-[13px] leading-6 text-[#7b7469]">
                                当前没有需要处理的审批。
                            </div>
                        ) : (
                            <div className="mx-auto flex min-h-full max-w-[860px] flex-col">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${approvalStatusTone(selectedDocket.status)}`}>
                                                {approvalStatusLabel(selectedDocket.status)}
                                            </span>
                                            <span className="rounded-full bg-[#eef1f5] px-2.5 py-0.5 text-[11px] font-medium text-[#687180]">
                                                {approvalPriorityLabel(selectedDocket.priority)}
                                            </span>
                                            <span className="rounded-full bg-[#f3efe8] px-2.5 py-0.5 text-[11px] font-medium text-[#746b5f]">
                                                {selectedDocket.decisionType || 'decision'}
                                            </span>
                                        </div>
                                        <h2 className="mt-3 text-[25px] font-semibold tracking-[-0.03em] text-[#1d1b18]">
                                            {selectedDocket.title || '未命名审批'}
                                        </h2>
                                        <div className="mt-2 flex flex-wrap items-center gap-2">
                                            <ApprovalMetaPill label="来源" value={selectedDocket.sourceKind || '-'} />
                                            <ApprovalMetaPill label="任务" value={shortFingerprint(selectedDocket.taskId)} />
                                            <ApprovalMetaPill label="创建" value={formatDateTime(selectedDocket.createdAt)} />
                                            {selectedIndex >= 0 && <ApprovalMetaPill label="序" value={`${selectedIndex + 1}/${pendingDockets.length}`} />}
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-6 space-y-4">
                                    <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-3.5">
                                        <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">摘要</div>
                                        <div className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-[#201d1a]">
                                            {approvalText(selectedDocket.summary)}
                                        </div>
                                    </section>

                                    <section className="rounded-[20px] border border-[#eee7dc] bg-white px-4 py-3.5">
                                        <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">正文</div>
                                        <div className="mt-2 whitespace-pre-wrap text-[13px] leading-7 text-[#302b25]">
                                            {approvalText(selectedDocket.body)}
                                        </div>
                                    </section>

                                    {selectedDocket.artifactRefs.length > 0 && (
                                        <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-3.5">
                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">附件</div>
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {selectedDocket.artifactRefs.map((artifact) => (
                                                    <span key={artifact} className="rounded-full border border-[#e8dfd2] bg-white px-2.5 py-1 text-[11px] text-[#6f675c]">
                                                        {artifact}
                                                    </span>
                                                ))}
                                            </div>
                                        </section>
                                    )}
                                </div>

                                <div className="mt-auto pt-5">
                                    {selectedDocket.status === 'pending' ? (
                                        <div className="rounded-[22px] border border-[#e8dccb] bg-[#fffaf2] px-4 py-4">
                                            <textarea
                                                value={comment}
                                                onChange={(event) => setComment(event.target.value)}
                                                placeholder="审批意见"
                                                className="h-[84px] w-full resize-none rounded-[16px] border border-[#e7ded1] bg-white px-3 py-2 text-[13px] leading-6 text-[#201d1a] outline-none transition focus:border-[#c8a66f] focus:ring-2 focus:ring-[#ead8b8]"
                                            />
                                            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                                                <button
                                                    onClick={() => void skip()}
                                                    disabled={Boolean(busyAction)}
                                                    className="rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec] disabled:cursor-not-allowed disabled:opacity-60"
                                                >
                                                    {busyAction === 'skip' ? '处理中...' : '稍后'}
                                                </button>
                                                <button
                                                    onClick={() => void decide('changes_requested')}
                                                    disabled={Boolean(busyAction)}
                                                    className="rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec] disabled:cursor-not-allowed disabled:opacity-60"
                                                >
                                                    {busyAction === 'changes_requested' ? '处理中...' : '要求修改'}
                                                </button>
                                                <button
                                                    onClick={() => void decide('reject')}
                                                    disabled={Boolean(busyAction)}
                                                    className="rounded-full border border-red-200 bg-red-50 px-3.5 py-1.5 text-[12px] text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                                                >
                                                    {busyAction === 'reject' ? '处理中...' : '驳回'}
                                                </button>
                                                <button
                                                    onClick={() => void decide('approve')}
                                                    disabled={Boolean(busyAction)}
                                                    className="inline-flex items-center rounded-full border border-[#d2b690] bg-[#efe1ca] px-3.5 py-1.5 text-[12px] text-[#5e4730] hover:bg-[#e7d5b9] disabled:cursor-not-allowed disabled:opacity-60"
                                                >
                                                    {busyAction === 'approve' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                                                    {busyAction === 'approve' ? '处理中...' : '批准'}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-3 text-[13px] text-[#6f675c]">
                                            {approvalStatusLabel(selectedDocket.status)} · {formatDateTime(selectedDocket.decidedAt)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
