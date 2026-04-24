import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Clock3, ListTodo, Loader2, Play, RefreshCw } from 'lucide-react';
import { appAlert } from '../utils/appDialogs';

type TaskListResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskList>>;
type TaskListItem = NonNullable<TaskListResponse['items']>[number];
type TaskStatsResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskStats>>;

type TaskFilterKey = 'all' | 'scheduled' | 'long_cycle' | 'draft' | 'active' | 'cooldown';

function formatDateTime(value?: string | null): string {
    if (!value) return '-';
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return value;
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function kindLabel(kind: string): string {
    return kind === 'long_cycle' ? '长周期任务' : '定时任务';
}

function lifecycleLabel(item: TaskListItem): string {
    if (item.requiresConfirmation) return '待确认';
    if (item.cooldown?.state === 'active') return '冷却中';
    return item.enabled ? '已启用' : '已停用';
}

function lifecycleTone(item: TaskListItem): string {
    if (item.requiresConfirmation) return 'bg-[#f7ead7] text-[#8c6a3c]';
    if (item.cooldown?.state === 'active') return 'bg-[#f8dfdf] text-[#94545c]';
    return item.enabled ? 'bg-[#dff2ee] text-[#4b7f76]' : 'bg-[#edf0f4] text-[#6f7682]';
}

function policyLabel(value?: string | null): string {
    switch ((value || '').trim()) {
        case 'allow':
            return '允许';
        case 'require_confirm':
            return '需确认';
        case 'reject':
            return '拒绝';
        default:
            return '未标注';
    }
}

function executionStatusLabel(value?: string | null): string {
    switch ((value || '').trim()) {
        case 'queued':
            return '排队中';
        case 'leased':
            return '已领取';
        case 'running':
            return '执行中';
        case 'retrying':
            return '等待重试';
        case 'succeeded':
        case 'completed':
            return '已成功';
        case 'failed':
            return '失败';
        case 'cancelled':
            return '已取消';
        case 'dead_lettered':
            return '死信';
        default:
            return value || '暂无';
    }
}

function triggerLabel(item: TaskListItem): string {
    if (item.kind === 'long_cycle') {
        return item.triggerKind === 'interval' ? '按轮次推进' : item.triggerKind || '多轮推进';
    }
    switch ((item.triggerKind || '').trim()) {
        case 'interval':
            return '按间隔';
        case 'daily':
            return '每天';
        case 'weekly':
            return '每周';
        case 'once':
            return '单次';
        default:
            return item.triggerKind || '未设置';
    }
}

function actionTypeLabel(value?: string | null): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' ');
}

function taskContent(item: TaskListItem): string {
    const values = [item.goal, item.prompt, item.objective, item.stepPrompt]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    return values[0] || '当前任务没有附带说明内容。';
}

function scheduleSummary(item: TaskListItem): string {
    if (item.kind === 'long_cycle') {
        const completed = Number(item.completedRounds || 0);
        const total = Number(item.totalRounds || 0);
        const progress = total > 0 ? `第 ${completed}/${total} 轮` : '多轮推进';
        return `${progress} · 下次 ${formatDateTime(item.nextDueAt)}`;
    }
    switch ((item.triggerKind || '').trim()) {
        case 'interval':
            return `按固定间隔触发 · 下次 ${formatDateTime(item.nextDueAt)}`;
        case 'daily':
            return `每天固定时间 · 下次 ${formatDateTime(item.nextDueAt)}`;
        case 'weekly':
            return `每周固定时间 · 下次 ${formatDateTime(item.nextDueAt)}`;
        case 'once':
            return `单次执行 · 计划 ${formatDateTime(item.nextDueAt)}`;
        default:
            return `下次 ${formatDateTime(item.nextDueAt)}`;
    }
}

function shortFingerprint(value?: string | null): string {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    if (raw.length <= 18) return raw;
    return `${raw.slice(0, 8)}...${raw.slice(-8)}`;
}

function sortRank(item: TaskListItem): number {
    if (item.requiresConfirmation) return 0;
    if (item.cooldown?.state === 'active') return 1;
    if (item.enabled) return 2;
    return 3;
}

function matchesFilter(item: TaskListItem, filter: TaskFilterKey): boolean {
    switch (filter) {
        case 'scheduled':
            return item.kind === 'scheduled';
        case 'long_cycle':
            return item.kind === 'long_cycle';
        case 'draft':
            return item.requiresConfirmation;
        case 'active':
            return item.enabled && item.cooldown?.state !== 'active' && !item.requiresConfirmation;
        case 'cooldown':
            return item.cooldown?.state === 'active';
        default:
            return true;
    }
}

async function runTaskNow(item: TaskListItem): Promise<void> {
    if (!item.sourceTaskId || !item.sourceKind) {
        throw new Error('当前任务没有可立即执行的源任务。');
    }
    if (item.sourceKind === 'scheduled') {
        await window.ipcRenderer.redclawRunner.runScheduledNow({ taskId: item.sourceTaskId });
        return;
    }
    if (item.sourceKind === 'long_cycle') {
        await window.ipcRenderer.redclawRunner.runLongCycleNow({ taskId: item.sourceTaskId });
        return;
    }
    throw new Error('当前任务类型暂不支持立即执行。');
}

async function setTaskEnabled(item: TaskListItem, enabled: boolean): Promise<void> {
    if (!item.sourceTaskId || !item.sourceKind) {
        throw new Error(enabled ? '当前任务没有可恢复的源任务。' : '当前任务没有可停用的源任务。');
    }
    if (item.sourceKind === 'scheduled') {
        await window.ipcRenderer.redclawRunner.setScheduledEnabled({ taskId: item.sourceTaskId, enabled });
        return;
    }
    if (item.sourceKind === 'long_cycle') {
        await window.ipcRenderer.redclawRunner.setLongCycleEnabled({ taskId: item.sourceTaskId, enabled });
        return;
    }
    throw new Error('当前任务类型暂不支持启停。');
}

function StatCard({
    label,
    value,
    note,
}: {
    label: string;
    value: number;
    note: string;
}) {
    return (
        <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">{label}</div>
            <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{value}</div>
            <div className="mt-1 text-xs text-[#7d766a]">{note}</div>
        </div>
    );
}

function DetailRow({
    label,
    value,
}: {
    label: string;
    value: string;
}) {
    return (
        <div className="rounded-2xl border border-[#eee7dc] bg-[#fcfbf9] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">{label}</div>
            <div className="mt-1 text-sm text-[#201d1a] break-words">{value}</div>
        </div>
    );
}

export function Workboard({ isActive = true }: { isActive?: boolean }) {
    const [items, setItems] = useState<TaskListItem[]>([]);
    const [stats, setStats] = useState<TaskStatsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastUpdatedAt, setLastUpdatedAt] = useState('');
    const [selectedId, setSelectedId] = useState('');
    const [filter, setFilter] = useState<TaskFilterKey>('all');
    const [actionState, setActionState] = useState<{ id: string; action: string } | null>(null);
    const itemsRef = useRef<TaskListItem[]>([]);
    const loadRequestRef = useRef(0);

    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    const load = useCallback(async () => {
        const requestId = loadRequestRef.current + 1;
        loadRequestRef.current = requestId;
        if (itemsRef.current.length === 0) {
            setLoading(true);
        }
        setError('');
        try {
            const [taskListResult, taskStatsResult] = await Promise.all([
                window.ipcRenderer.redclawRunner.taskList({ includeDrafts: true }),
                window.ipcRenderer.redclawRunner.taskStats(),
            ]);
            if (requestId !== loadRequestRef.current) return;
            const nextItems = Array.isArray(taskListResult?.items) ? [...taskListResult.items] : [];
            nextItems.sort((left, right) => {
                const rankDelta = sortRank(left) - sortRank(right);
                if (rankDelta !== 0) return rankDelta;
                const leftDueAt = Date.parse(left.nextDueAt || '') || Number.MAX_SAFE_INTEGER;
                const rightDueAt = Date.parse(right.nextDueAt || '') || Number.MAX_SAFE_INTEGER;
                if (leftDueAt !== rightDueAt) return leftDueAt - rightDueAt;
                return Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '');
            });
            setItems(nextItems);
            setStats(taskStatsResult || null);
            setLastUpdatedAt(new Date().toISOString());
            setSelectedId((prev) => (prev && nextItems.some((item) => item.definitionId === prev) ? prev : nextItems[0]?.definitionId || ''));
        } catch (loadError) {
            if (requestId !== loadRequestRef.current) return;
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            if (requestId === loadRequestRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void load();
    }, [isActive, load]);

    const filteredItems = useMemo(
        () => items.filter((item) => matchesFilter(item, filter)),
        [filter, items],
    );

    useEffect(() => {
        if (!filteredItems.length) {
            setSelectedId('');
            return;
        }
        if (!selectedId || !filteredItems.some((item) => item.definitionId === selectedId)) {
            setSelectedId(filteredItems[0].definitionId);
        }
    }, [filteredItems, selectedId]);

    const selectedItem = useMemo(
        () => filteredItems.find((item) => item.definitionId === selectedId) || filteredItems[0] || null,
        [filteredItems, selectedId],
    );

    const filterOptions = useMemo(() => ([
        { key: 'all' as const, label: '全部任务', count: items.length },
        { key: 'scheduled' as const, label: '定时任务', count: items.filter((item) => item.kind === 'scheduled').length },
        { key: 'long_cycle' as const, label: '长周期', count: items.filter((item) => item.kind === 'long_cycle').length },
        { key: 'draft' as const, label: '待确认', count: items.filter((item) => item.requiresConfirmation).length },
        { key: 'cooldown' as const, label: '冷却中', count: items.filter((item) => item.cooldown?.state === 'active').length },
    ]), [items]);

    const topStats = useMemo(() => ({
        totalDefinitions: stats?.definitions?.total ?? items.length,
        scheduled: items.filter((item) => item.kind === 'scheduled').length,
        longCycle: items.filter((item) => item.kind === 'long_cycle').length,
        active: stats?.definitions?.active ?? items.filter((item) => item.enabled).length,
        runningExecutions: stats?.executions?.running ?? 0,
        failedExecutions: stats?.executions?.failed ?? 0,
    }), [items, stats]);

    const executeAction = useCallback(async (
        item: TaskListItem,
        action: string,
        fn: () => Promise<void>,
    ) => {
        try {
            setActionState({ id: item.definitionId, action });
            await fn();
            await load();
        } catch (actionError) {
            void appAlert(actionError instanceof Error ? actionError.message : String(actionError));
        } finally {
            setActionState((current) => (
                current?.id === item.definitionId && current.action === action
                    ? null
                    : current
            ));
        }
    }, [load]);

    return (
        <div className="h-full min-h-0 bg-[#fbfaf7] text-[#191919]">
            <div className="h-full min-h-0 flex flex-col gap-5 px-8 py-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <div className="inline-flex items-center gap-2 rounded-full border border-[#ece3d5] bg-white px-3 py-1 text-xs text-[#7c7468]">
                            <ListTodo className="h-3.5 w-3.5" />
                            RedClaw 任务中心
                        </div>
                        <h1 className="mt-3 text-[28px] font-semibold tracking-[-0.03em] text-[#1d1b18]">统一任务列表</h1>
                        <p className="mt-2 max-w-[760px] text-sm leading-6 text-[#7b7469]">
                            所有定时任务和长周期任务都在这里统一展示。任务卡片只保留分类、调度、策略和执行状态，不再拆出媒体任务等单独面板。
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="rounded-full border border-[#ece5da] bg-white px-3 py-1.5 text-xs text-[#7d766a]">
                            更新于 {formatDateTime(lastUpdatedAt)}
                        </div>
                        <button
                            onClick={() => void load()}
                            className="inline-flex h-[36px] items-center gap-2 rounded-full border border-[#e7e0d4] bg-white px-4 text-xs text-[#7d766a] shadow-[0_1px_2px_rgba(24,24,24,0.03)] hover:bg-[#f5f1e9]"
                        >
                            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                            刷新
                        </button>
                    </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                    <StatCard label="任务总数" value={topStats.totalDefinitions} note="当前可管理的任务定义" />
                    <StatCard label="定时任务" value={topStats.scheduled} note="interval / daily / weekly / once" />
                    <StatCard label="长周期" value={topStats.longCycle} note="多轮推进任务" />
                    <StatCard label="已启用" value={topStats.active} note="已进入调度系统" />
                    <StatCard label="执行中" value={topStats.runningExecutions} note="当前活跃 execution" />
                    <StatCard label="失败执行" value={topStats.failedExecutions} note="需要关注的失败记录" />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {filterOptions.map((option) => (
                        <button
                            key={option.key}
                            onClick={() => setFilter(option.key)}
                            className={`rounded-full border px-4 py-2 text-sm transition ${
                                filter === option.key
                                    ? 'border-[#c8b08b] bg-[#efe3d0] text-[#5c4630]'
                                    : 'border-[#e8dfd2] bg-white text-[#736b60] hover:bg-[#f6f2ea]'
                            }`}
                        >
                            {option.label}
                            <span className="ml-2 text-xs opacity-70">{option.count}</span>
                        </button>
                    ))}
                </div>

                {error && (
                    <div className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                        <AlertCircle className="h-4 w-4" />
                        {error}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-hidden">
                    <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[minmax(360px,460px)_minmax(0,1fr)]">
                        <div className="min-h-0 overflow-hidden rounded-[28px] border border-[#ece4d8] bg-white">
                            <div className="flex items-center justify-between border-b border-[#f0e9de] px-5 py-4">
                                <div>
                                    <div className="text-sm font-medium text-[#1d1b18]">任务列表</div>
                                    <div className="mt-1 text-xs text-[#8b8378]">按当前筛选展示统一任务定义</div>
                                </div>
                                <div className="text-xs text-[#9a9184]">{filteredItems.length} 项</div>
                            </div>

                            <div className="h-[calc(100%-73px)] overflow-y-auto px-3 py-3">
                                {loading && items.length === 0 ? (
                                    <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-[#7b7469]">
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        正在加载任务列表
                                    </div>
                                ) : filteredItems.length === 0 ? (
                                    <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center text-sm leading-6 text-[#7b7469]">
                                        当前筛选下没有任务。你可以切换筛选查看其他任务状态。
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {filteredItems.map((item) => {
                                            const active = selectedItem?.definitionId === item.definitionId;
                                            const actionType = actionTypeLabel(item.actionType);
                                            return (
                                                <button
                                                    key={item.definitionId}
                                                    onClick={() => setSelectedId(item.definitionId)}
                                                    className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                                                        active
                                                            ? 'border-[#d5b68b] bg-[#fbf2e6] shadow-[0_12px_30px_rgba(95,70,35,0.08)]'
                                                            : 'border-[#eee7dc] bg-[#fdfcf9] hover:border-[#e1d4c2] hover:bg-white'
                                                    }`}
                                                >
                                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <span className="rounded-full bg-[#efe5d6] px-2.5 py-1 text-[11px] font-medium text-[#6d553a]">
                                                                    {kindLabel(item.kind)}
                                                                </span>
                                                                {actionType && (
                                                                    <span className="rounded-full bg-[#eef1f5] px-2.5 py-1 text-[11px] font-medium text-[#687180]">
                                                                        {actionType}
                                                                    </span>
                                                                )}
                                                                <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${lifecycleTone(item)}`}>
                                                                    {lifecycleLabel(item)}
                                                                </span>
                                                            </div>
                                                            <div className="mt-3 truncate text-[16px] font-semibold text-[#1d1b18]">
                                                                {item.title}
                                                            </div>
                                                            <div className="mt-2 line-clamp-2 text-sm leading-6 text-[#70695d]">
                                                                {taskContent(item)}
                                                            </div>
                                                        </div>
                                                        <div className="shrink-0 rounded-2xl bg-white/80 px-3 py-2 text-right">
                                                            <div className="text-[11px] uppercase tracking-[0.16em] text-[#a3998a]">下次执行</div>
                                                            <div className="mt-1 text-sm font-medium text-[#2a2723]">
                                                                {formatDateTime(item.nextDueAt)}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#877f73]">
                                                        <span className="inline-flex items-center gap-1.5">
                                                            <Clock3 className="h-3.5 w-3.5" />
                                                            {triggerLabel(item)}
                                                        </span>
                                                        <span>策略 {policyLabel(item.policyDecision)}</span>
                                                        <span>
                                                            {item.latestExecution
                                                                ? `最近执行 ${executionStatusLabel(item.latestExecution.status)}`
                                                                : '暂无执行记录'}
                                                        </span>
                                                    </div>

                                                    {item.cooldown?.state === 'active' && (
                                                        <div className="mt-3 rounded-2xl border border-[#f0d5d8] bg-[#fff4f5] px-3 py-2 text-xs text-[#9a525c]">
                                                            冷却中：连续失败 {Number(item.cooldown.consecutiveFailures || 0)} 次，原因为 {item.cooldown.reason || '连续失败进入冷却'}。
                                                        </div>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="min-h-0 overflow-y-auto rounded-[28px] border border-[#ece4d8] bg-white px-6 py-6">
                            {!selectedItem ? (
                                <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm leading-6 text-[#7b7469]">
                                    选择左侧任务后，这里会显示调度规则、策略信息和最近执行状态。
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="rounded-full bg-[#efe5d6] px-3 py-1 text-xs font-medium text-[#6d553a]">
                                                    {kindLabel(selectedItem.kind)}
                                                </span>
                                                {selectedItem.actionType && (
                                                    <span className="rounded-full bg-[#eef1f5] px-3 py-1 text-xs font-medium text-[#687180]">
                                                        {actionTypeLabel(selectedItem.actionType)}
                                                    </span>
                                                )}
                                                <span className={`rounded-full px-3 py-1 text-xs font-medium ${lifecycleTone(selectedItem)}`}>
                                                    {lifecycleLabel(selectedItem)}
                                                </span>
                                            </div>
                                            <h2 className="mt-3 text-[26px] font-semibold tracking-[-0.03em] text-[#1d1b18]">
                                                {selectedItem.title}
                                            </h2>
                                            <p className="mt-2 max-w-[720px] text-sm leading-6 text-[#70695d]">
                                                {taskContent(selectedItem)}
                                            </p>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-2">
                                            {selectedItem.requiresConfirmation && selectedItem.draftId && (
                                                <>
                                                    <button
                                                        onClick={() => void executeAction(selectedItem, 'confirm', async () => {
                                                            await window.ipcRenderer.redclawRunner.taskConfirm({
                                                                draftId: selectedItem.draftId as string,
                                                                confirm: true,
                                                            });
                                                        })}
                                                        className="rounded-full border border-[#d2b690] bg-[#efe1ca] px-4 py-2 text-sm text-[#5e4730] hover:bg-[#e7d5b9]"
                                                    >
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'confirm'
                                                            ? '确认中...'
                                                            : '确认任务'}
                                                    </button>
                                                    <button
                                                        onClick={() => void executeAction(selectedItem, 'discard', async () => {
                                                            await window.ipcRenderer.redclawRunner.taskConfirm({
                                                                draftId: selectedItem.draftId as string,
                                                                confirm: false,
                                                            });
                                                        })}
                                                        className="rounded-full border border-[#eadfce] bg-white px-4 py-2 text-sm text-[#776f63] hover:bg-[#f7f3ec]"
                                                    >
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'discard'
                                                            ? '处理中...'
                                                            : '丢弃草稿'}
                                                    </button>
                                                </>
                                            )}

                                            {!selectedItem.requiresConfirmation && (
                                                <button
                                                    onClick={() => void executeAction(selectedItem, 'run-now', () => runTaskNow(selectedItem))}
                                                    className="inline-flex rounded-full border border-[#d2b690] bg-[#efe1ca] px-4 py-2 text-sm text-[#5e4730] hover:bg-[#e7d5b9]"
                                                >
                                                    <Play className="mr-2 h-4 w-4" />
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'run-now'
                                                        ? '执行中...'
                                                        : '立即执行'}
                                                </button>
                                            )}

                                            {!selectedItem.requiresConfirmation && selectedItem.enabled && (
                                                <button
                                                    onClick={() => void executeAction(selectedItem, 'pause', () => setTaskEnabled(selectedItem, false))}
                                                    className="rounded-full border border-[#eadfce] bg-white px-4 py-2 text-sm text-[#776f63] hover:bg-[#f7f3ec]"
                                                >
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'pause'
                                                        ? '处理中...'
                                                        : '停用任务'}
                                                </button>
                                            )}

                                            {!selectedItem.requiresConfirmation && !selectedItem.enabled && (
                                                <button
                                                    onClick={() => void executeAction(selectedItem, 'resume', () => setTaskEnabled(selectedItem, true))}
                                                    className="rounded-full border border-[#eadfce] bg-white px-4 py-2 text-sm text-[#776f63] hover:bg-[#f7f3ec]"
                                                >
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'resume'
                                                        ? '处理中...'
                                                        : '恢复任务'}
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                        <DetailRow label="任务分类" value={kindLabel(selectedItem.kind)} />
                                        <DetailRow label="调度方式" value={triggerLabel(selectedItem)} />
                                        <DetailRow label="策略判定" value={policyLabel(selectedItem.policyDecision)} />
                                        <DetailRow label="任务时区" value={selectedItem.timezone || 'local'} />
                                        <DetailRow label="错过窗口策略" value={selectedItem.missedRunPolicy || 'single'} />
                                        <DetailRow label="任务指纹" value={shortFingerprint(selectedItem.definitionFingerprint)} />
                                    </div>

                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.9fr)]">
                                        <div className="space-y-4">
                                            <section className="rounded-[24px] border border-[#eee7dc] bg-[#fcfbf9] px-5 py-5">
                                                <div className="text-sm font-medium text-[#1d1b18]">任务内容</div>
                                                <div className="mt-4 space-y-3 text-sm leading-6 text-[#595247]">
                                                    {selectedItem.goal && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Goal</div>
                                                            <div className="mt-1">{selectedItem.goal}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.prompt && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Prompt</div>
                                                            <div className="mt-1">{selectedItem.prompt}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.objective && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Objective</div>
                                                            <div className="mt-1">{selectedItem.objective}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.stepPrompt && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Step Prompt</div>
                                                            <div className="mt-1">{selectedItem.stepPrompt}</div>
                                                        </div>
                                                    )}
                                                    {!selectedItem.goal && !selectedItem.prompt && !selectedItem.objective && !selectedItem.stepPrompt && (
                                                        <div>当前任务没有更多结构化内容。</div>
                                                    )}
                                                </div>
                                            </section>

                                            <section className="rounded-[24px] border border-[#eee7dc] bg-[#fcfbf9] px-5 py-5">
                                                <div className="text-sm font-medium text-[#1d1b18]">策略与风险</div>
                                                <div className="mt-4 space-y-3 text-sm leading-6 text-[#595247]">
                                                    <div>策略结论：{policyLabel(selectedItem.policyDecision)}</div>
                                                    {Array.isArray(selectedItem.policyWarnings) && selectedItem.policyWarnings.length > 0 && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Warnings</div>
                                                                <div className="mt-1 space-y-1">
                                                                    {selectedItem.policyWarnings.map((warning, index) => (
                                                                        <div key={`${selectedItem.definitionId}-warning-${index}`}>- {warning}</div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                    )}
                                                    {selectedItem.riskRationale && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Risk Rationale</div>
                                                            <div className="mt-1">{selectedItem.riskRationale}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.lastUpdatedReason && (
                                                        <div>
                                                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a39a8e]">Last Updated Reason</div>
                                                            <div className="mt-1">{selectedItem.lastUpdatedReason}</div>
                                                        </div>
                                                    )}
                                                </div>
                                            </section>
                                        </div>

                                        <div className="space-y-4">
                                            <section className="rounded-[24px] border border-[#eee7dc] bg-[#fcfbf9] px-5 py-5">
                                                <div className="text-sm font-medium text-[#1d1b18]">调度信息</div>
                                                <div className="mt-4 space-y-3 text-sm leading-6 text-[#595247]">
                                                    <div>{scheduleSummary(selectedItem)}</div>
                                                    <div>创建于 {formatDateTime(selectedItem.createdAt)}</div>
                                                    <div>更新于 {formatDateTime(selectedItem.updatedAt)}</div>
                                                    {selectedItem.kind === 'long_cycle' && (
                                                        <div>
                                                            轮次进度 {Number(selectedItem.completedRounds || 0)} / {Number(selectedItem.totalRounds || 0)}
                                                        </div>
                                                    )}
                                                </div>
                                            </section>

                                            <section className="rounded-[24px] border border-[#eee7dc] bg-[#fcfbf9] px-5 py-5">
                                                <div className="text-sm font-medium text-[#1d1b18]">最近执行</div>
                                                <div className="mt-4 space-y-3 text-sm leading-6 text-[#595247]">
                                                    {selectedItem.latestExecution ? (
                                                        <>
                                                            <div>状态：{executionStatusLabel(selectedItem.latestExecution.status)}</div>
                                                            <div>计划时间：{formatDateTime(selectedItem.latestExecution.scheduledForAt)}</div>
                                                            <div>最近心跳：{formatDateTime(selectedItem.latestExecution.lastHeartbeatAt)}</div>
                                                            <div>尝试次数：{Number(selectedItem.latestExecution.attemptNo || 0)}</div>
                                                            {selectedItem.latestExecution.lastError && (
                                                                <div className="rounded-2xl border border-[#f0d5d8] bg-[#fff4f5] px-3 py-2 text-xs text-[#9a525c]">
                                                                    {selectedItem.latestExecution.lastError}
                                                                </div>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <div>当前还没有执行记录。</div>
                                                    )}
                                                </div>
                                            </section>

                                            <section className="rounded-[24px] border border-[#eee7dc] bg-[#fcfbf9] px-5 py-5">
                                                <div className="text-sm font-medium text-[#1d1b18]">冷却状态</div>
                                                <div className="mt-4 text-sm leading-6 text-[#595247]">
                                                    {selectedItem.cooldown?.state === 'active' ? (
                                                        <div>
                                                            连续失败 {Number(selectedItem.cooldown.consecutiveFailures || 0)} 次，
                                                            激活于 {formatDateTime(selectedItem.cooldown.activatedAt)}，
                                                            原因为 {selectedItem.cooldown.reason || '连续失败进入冷却'}。
                                                        </div>
                                                    ) : (
                                                        <div>当前没有进入冷却。</div>
                                                    )}
                                                </div>
                                            </section>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
