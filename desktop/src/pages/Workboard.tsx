import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bot, Clock3, Link2, ListTodo, Loader2, Play, RefreshCw, X } from 'lucide-react';

type WorkItem = Awaited<ReturnType<typeof window.ipcRenderer.work.list>>[number];

type WorkColumnKey = 'ready' | 'blocked' | 'active' | 'waiting' | 'done';

const COLUMN_ORDER: Array<{ key: WorkColumnKey; label: string; tone: string }> = [
    { key: 'ready', label: '待启动', tone: 'bg-[#dff2ee] text-[#4b7f76]' },
    { key: 'blocked', label: '阻塞中', tone: 'bg-[#f6edcf] text-[#8c7543]' },
    { key: 'active', label: '进行中', tone: 'bg-[#d9e6fb] text-[#5f7499]' },
    { key: 'waiting', label: '等待中', tone: 'bg-[#e8def6] text-[#7d6d9a]' },
    { key: 'done', label: '已完成', tone: 'bg-[#edf0f4] text-[#6f7682]' },
];

const STATUS_ACTIONS = [
    { key: 'pending', label: '回到待启动' },
    { key: 'active', label: '开始执行' },
    { key: 'waiting', label: '标记等待' },
    { key: 'done', label: '标记完成' },
    { key: 'cancelled', label: '取消' },
] as const;

function labelForType(type: string): string {
    switch (type) {
        case 'redclaw-note':
            return '笔记';
        case 'redclaw-project':
            return '项目';
        case 'automation':
            return '自动化';
        case 'research':
            return '调研';
        case 'review':
            return '评审';
        case 'external-message':
            return '外部消息';
        default:
            return type || '任务';
    }
}

function formatDateTime(value?: string): string {
    if (!value) return '-';
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return value;
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function columnConfigForKey(key: WorkColumnKey) {
    return COLUMN_ORDER.find((column) => column.key === key) || COLUMN_ORDER[1];
}

function formatInlineList(values: string[]): string {
    return values.length > 0 ? values.join('、') : '暂无';
}

function scheduleSummary(item: WorkItem): string {
    const schedule = item.schedule;
    if (!schedule || schedule.mode === 'none') return '';
    if (schedule.mode === 'long-cycle') {
        return `长周期 ${schedule.completedRounds || 0}/${schedule.totalRounds || 0} · 下次 ${formatDateTime(schedule.nextRunAt)}`;
    }
    if (schedule.mode === 'interval') {
        return `每 ${schedule.intervalMinutes || '-'} 分钟 · 下次 ${formatDateTime(schedule.nextRunAt)}`;
    }
    if (schedule.mode === 'daily') {
        return `每天 ${schedule.time || '-'} · 下次 ${formatDateTime(schedule.nextRunAt)}`;
    }
    if (schedule.mode === 'weekly') {
        return `每周 ${Array.isArray(schedule.weekdays) ? schedule.weekdays.join(',') : '-'} ${schedule.time || ''} · 下次 ${formatDateTime(schedule.nextRunAt)}`;
    }
    return `一次性任务 · 计划 ${formatDateTime(schedule.runAt || schedule.nextRunAt)}`;
}

async function triggerWorkItemNow(item: WorkItem): Promise<void> {
    const metadata = (item.metadata || {}) as Record<string, unknown>;
    if (metadata.scheduledTaskId) {
        await window.ipcRenderer.redclawRunner.runScheduledNow({ taskId: String(metadata.scheduledTaskId) });
        return;
    }
    if (metadata.longCycleTaskId) {
        await window.ipcRenderer.redclawRunner.runLongCycleNow({ taskId: String(metadata.longCycleTaskId) });
        return;
    }
    throw new Error('当前工作项没有可立即执行的自动化绑定。');
}

function resolveColumnKey(item: WorkItem): WorkColumnKey {
    const effective = String(item.effectiveStatus || '').trim() as WorkColumnKey;
    if (COLUMN_ORDER.some((column) => column.key === effective)) {
        return effective;
    }
    const fallback = String(item.status || '').trim();
    if (fallback === 'pending') return 'blocked';
    if (fallback === 'active') return 'active';
    if (fallback === 'waiting') return 'waiting';
    if (fallback === 'done') return 'done';
    return 'blocked';
}

export function Workboard() {
    const [items, setItems] = useState<WorkItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastUpdatedAt, setLastUpdatedAt] = useState('');
    const [selectedId, setSelectedId] = useState<string>('');
    const [runningNowId, setRunningNowId] = useState<string>('');
    const [updatingStatusId, setUpdatingStatusId] = useState<string>('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const next = await window.ipcRenderer.work.list({ limit: 300 });
            setItems(next || []);
            setLastUpdatedAt(new Date().toISOString());
            setSelectedId((prev) => prev && next.some((item) => item.id === prev) ? prev : '');
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const grouped = useMemo(() => {
        const map = new Map<WorkColumnKey, WorkItem[]>();
        for (const column of COLUMN_ORDER) {
            map.set(column.key, []);
        }
        for (const item of items) {
            map.get(resolveColumnKey(item))?.push(item);
        }
        return map;
    }, [items]);

    const selectedItem = useMemo(
        () => items.find((item) => item.id === selectedId) || null,
        [items, selectedId],
    );
    const selectedColumn = selectedItem ? columnConfigForKey(resolveColumnKey(selectedItem)) : null;

    const stats = useMemo(() => ({
        total: items.length,
        automation: items.filter((item) => item.type === 'automation').length,
        ready: items.filter((item) => resolveColumnKey(item) === 'ready').length,
    }), [items]);

    const updateStatus = useCallback(async (item: WorkItem, status: 'pending' | 'active' | 'waiting' | 'done' | 'cancelled') => {
        try {
            setUpdatingStatusId(item.id);
            await window.ipcRenderer.work.update({ id: item.id, status });
            await load();
        } catch (updateError) {
            alert(updateError instanceof Error ? updateError.message : String(updateError));
        } finally {
            setUpdatingStatusId('');
        }
    }, [load]);

    return (
        <div className="h-full min-h-0 bg-[#fbfaf7] text-[#191919]">
            <div className="h-full min-h-0 flex flex-col px-8 py-7 gap-5">
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="px-3 py-1.5 rounded-full border border-[#ece5da] bg-white text-xs text-[#7d766a]">
                        全部 {stats.total}
                    </div>
                    <div className="px-3 py-1.5 rounded-full border border-[#ece5da] bg-white text-xs text-[#7d766a]">
                        Ready {stats.ready}
                    </div>
                    <div className="px-3 py-1.5 rounded-full border border-[#ece5da] bg-white text-xs text-[#7d766a]">
                        自动化 {stats.automation}
                    </div>
                    <div className="px-3 py-1.5 rounded-full border border-[#ece5da] bg-white text-xs text-[#7d766a]">
                        更新于 {formatDateTime(lastUpdatedAt)}
                    </div>
                    <button
                        onClick={() => void load()}
                        className="h-[34px] px-4 rounded-full border border-[#e7e0d4] bg-white text-xs inline-flex items-center gap-2 hover:bg-[#f5f1e9] shrink-0 shadow-[0_1px_2px_rgba(24,24,24,0.03)] text-[#7d766a]"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                        刷新
                    </button>
                </div>

                {error && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 inline-flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-2">
                    <div className="h-full min-w-max grid auto-cols-[248px] grid-flow-col gap-3.5">
                        {COLUMN_ORDER.map((column) => {
                            const list = grouped.get(column.key) || [];
                            return (
                                <section key={column.key} className="h-full min-h-0 flex flex-col overflow-hidden">
                                    <div className="px-1 py-1 flex items-center">
                                        <div className="flex items-center gap-3">
                                            <h2 className="text-[18px] font-semibold tracking-[-0.02em]">{column.label}</h2>
                                            <span className="text-[14px] text-[#9a958b]">{list.length}</span>
                                        </div>
                                    </div>
                                    <div className="pt-4 space-y-4 overflow-y-auto pr-2">
                                        {list.length === 0 ? (
                                            <div className="rounded-[24px] border border-dashed border-[#e2d9ca] bg-white px-4 py-8 text-sm text-[#9a958b] text-center">
                                                当前列没有任务
                                            </div>
                                        ) : (
                                            list.map((item) => (
                                                <button
                                                    key={item.id}
                                                    onClick={() => setSelectedId(item.id)}
                                                    className="group w-full text-left rounded-[24px] border border-[#ddd7cd] bg-white px-5 py-5 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(28,28,28,0.07)] transition duration-200 shadow-[0_3px_10px_rgba(30,30,30,0.035)]"
                                                >
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap gap-1.5">
                                                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${column.tone}`}>
                                                                {column.label}
                                                            </span>
                                                            <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium bg-[#f5e7df] text-[#7a7066]">
                                                                {labelForType(item.type)}
                                                            </span>
                                                            <span className="inline-flex items-center rounded-full border border-[#e8dfd3] bg-[#fbf8f2] px-2.5 py-1 text-[12px] font-medium text-[#7a7066]">
                                                                P{item.priority}
                                                            </span>
                                                        </div>

                                                        <div className="mt-4 text-[16px] font-semibold leading-[1.35] tracking-[-0.02em] text-[#1d1b18] line-clamp-2">
                                                            {item.title}
                                                        </div>

                                                        <div className="mt-3 text-[13px] leading-6 text-[#81796e] line-clamp-3">
                                                            {item.summary || item.description || '暂无任务摘要'}
                                                        </div>

                                                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[#8f877b]">
                                                            {item.schedule?.mode && item.schedule.mode !== 'none' ? (
                                                                <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-[#f3ede2] px-2.5 py-1">
                                                                    <Clock3 className="h-3.5 w-3.5 shrink-0" />
                                                                    <span className="line-clamp-1">{scheduleSummary(item)}</span>
                                                                </span>
                                                            ) : (
                                                                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f6f1e8] px-2.5 py-1">
                                                                    <ListTodo className="h-3.5 w-3.5 shrink-0" />
                                                                    手动推进
                                                                </span>
                                                            )}
                                                            {item.blockedBy.length > 0 && (
                                                                <span className="inline-flex items-center rounded-full bg-[#f8efcf] px-2.5 py-1 font-medium text-[#8f7440]">
                                                                    阻塞 {item.blockedBy.length}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                </div>
            </div>

            {selectedItem && (
                <div className="fixed inset-0 z-[70] bg-[#18120a]/45 backdrop-blur-[6px] flex items-center justify-center px-4 py-6">
                    <div className="w-full max-w-[980px] max-h-[88vh] overflow-hidden rounded-[32px] border border-[#ddd7cd] bg-[#fcfbf8] shadow-[0_28px_90px_rgba(20,20,20,0.18)]">
                        <div className="border-b border-[#ebe4d9] bg-[linear-gradient(180deg,#fffdf9_0%,#f7f2e9_100%)] px-6 py-6 md:px-8">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        {selectedColumn && (
                                            <span className={`inline-flex items-center rounded-full px-3 py-1 text-[12px] font-medium ${selectedColumn.tone}`}>
                                                {selectedColumn.label}
                                            </span>
                                        )}
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            {labelForType(selectedItem.type)}
                                        </span>
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            优先级 P{selectedItem.priority}
                                        </span>
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            {selectedItem.id}
                                        </span>
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-2.5">
                                        {selectedItem.type === 'automation' && (
                                            <button
                                                onClick={async () => {
                                                    try {
                                                        setRunningNowId(selectedItem.id);
                                                        await triggerWorkItemNow(selectedItem);
                                                        await load();
                                                    } catch (runError) {
                                                        alert(runError instanceof Error ? runError.message : String(runError));
                                                    } finally {
                                                        setRunningNowId('');
                                                    }
                                                }}
                                                className="h-10 px-4 rounded-full border border-[#d9cfbe] bg-[#191919] text-white text-sm inline-flex items-center gap-2 hover:bg-[#2a241d]"
                                            >
                                                {runningNowId === selectedItem.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                                                立即执行
                                            </button>
                                        )}
                                        {STATUS_ACTIONS.map((action) => (
                                            <button
                                                key={action.key}
                                                onClick={() => void updateStatus(selectedItem, action.key)}
                                                disabled={updatingStatusId === selectedItem.id}
                                                className="h-10 px-4 rounded-full border border-[#e4ddd1] bg-white text-sm inline-flex items-center gap-2 text-[#5f584d] hover:bg-[#f5f1e9] disabled:opacity-60"
                                            >
                                                {updatingStatusId === selectedItem.id ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                                {action.label}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="mt-4 text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-[#1b1813]">
                                        {selectedItem.title}
                                    </div>
                                    <div className="mt-3 max-w-3xl text-[14px] leading-7 text-[#72695d]">
                                        {selectedItem.summary || selectedItem.description || '暂无任务摘要'}
                                    </div>
                                </div>
                                <button
                                    onClick={() => setSelectedId('')}
                                    className="h-11 w-11 shrink-0 rounded-full border border-[#e7dfd4] bg-white inline-flex items-center justify-center text-[#8c8579] hover:bg-[#f5f1e9] hover:text-[#191919]"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-4">
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">当前状态</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedColumn?.label || selectedItem.effectiveStatus}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">调度信息</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">
                                        {selectedItem.schedule?.mode && selectedItem.schedule.mode !== 'none' ? '已配置' : '手动'}
                                    </div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">阻塞数量</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedItem.blockedBy.length}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">最近更新</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{formatDateTime(selectedItem.updatedAt)}</div>
                                </div>
                            </div>
                        </div>

                        <div className="grid max-h-[calc(88vh-300px)] grid-cols-1 gap-5 overflow-y-auto px-6 py-5 md:grid-cols-2 md:px-8">
                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">任务内容</div>
                                <div className="mt-3 text-[14px] leading-7 text-[#564f45]">
                                    {selectedItem.summary || '暂无任务摘要'}
                                </div>
                                {selectedItem.description && selectedItem.description !== selectedItem.summary && (
                                    <div className="mt-4 border-t border-[#efe8dd] pt-4 whitespace-pre-wrap text-[14px] leading-7 text-[#564f45]">
                                        {selectedItem.description}
                                    </div>
                                )}
                            </section>

                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">关联信息</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    <div className="rounded-[18px] bg-[#faf6ef] px-3.5 py-3">
                                        <div className="flex items-center gap-2 text-[#8d816f]"><Link2 className="h-4 w-4" /> 项目</div>
                                        <div className="mt-1 text-[#2c2823]">{formatInlineList(selectedItem.refs.projectIds)}</div>
                                    </div>
                                    <div className="rounded-[18px] bg-[#faf6ef] px-3.5 py-3">
                                        <div className="flex items-center gap-2 text-[#8d816f]"><Bot className="h-4 w-4" /> 会话</div>
                                        <div className="mt-1 text-[#2c2823]">{formatInlineList(selectedItem.refs.sessionIds)}</div>
                                    </div>
                                    <div className="rounded-[18px] bg-[#faf6ef] px-3.5 py-3">
                                        <div className="flex items-center gap-2 text-[#8d816f]"><ListTodo className="h-4 w-4" /> 任务</div>
                                        <div className="mt-1 text-[#2c2823]">{formatInlineList(selectedItem.refs.taskIds)}</div>
                                    </div>
                                </div>
                            </section>

                            {selectedItem.schedule?.mode && selectedItem.schedule.mode !== 'none' && (
                                <section className="rounded-[24px] border border-[#ebe4d9] bg-[#faf6ef] p-5">
                                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[#a09789]">
                                        <Clock3 className="h-3.5 w-3.5" />
                                        调度计划
                                    </div>
                                    <div className="mt-3 text-[14px] leading-7 text-[#564f45]">
                                        {scheduleSummary(selectedItem)}
                                    </div>
                                </section>
                            )}

                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">时间记录</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">创建时间</span>
                                        <span className="text-right text-[#2c2823]">{formatDateTime(selectedItem.createdAt)}</span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">更新时间</span>
                                        <span className="text-right text-[#2c2823]">{formatDateTime(selectedItem.updatedAt)}</span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">完成时间</span>
                                        <span className="text-right text-[#2c2823]">{formatDateTime(selectedItem.completedAt)}</span>
                                    </div>
                                </div>
                            </section>

                            {Array.isArray((selectedItem.metadata as Record<string, unknown> | undefined)?.subagentRoles) && (
                                <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">子角色链路</div>
                                    <div className="mt-3 text-[13px] leading-6 text-[#4f473d]">
                                        {((selectedItem.metadata as Record<string, unknown>).subagentRoles as unknown[]).map((item) => String(item)).join(' -> ') || '暂无'}
                                    </div>
                                </section>
                            )}

                            {selectedItem.blockedBy.length > 0 && (
                                <section className="rounded-[24px] border border-amber-200 bg-amber-50/80 p-5">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-amber-700">阻塞项</div>
                                    <div className="mt-3 text-[13px] leading-6 text-amber-900">
                                        {selectedItem.blockedBy.join('、')}
                                    </div>
                                </section>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default Workboard;
