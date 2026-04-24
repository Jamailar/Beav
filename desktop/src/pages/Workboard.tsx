import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Clock3, ListTodo, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { appAlert } from '../utils/appDialogs';

type TaskListResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskList>>;
type TaskListItem = NonNullable<TaskListResponse['items']>[number];
type TaskStatsResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskStats>>;
type BackgroundTaskListResponse = Awaited<ReturnType<typeof window.ipcRenderer.backgroundTasks.list>>;
type BackgroundTaskItem = BackgroundTaskListResponse[number];

type TaskColumnKey = 'draft' | 'active' | 'cooldown' | 'inactive';

const COLUMN_ORDER: Array<{ key: TaskColumnKey; label: string; tone: string }> = [
    { key: 'draft', label: '待确认', tone: 'bg-[#f7ead7] text-[#8c6a3c]' },
    { key: 'active', label: '已启用', tone: 'bg-[#dff2ee] text-[#4b7f76]' },
    { key: 'cooldown', label: '冷却中', tone: 'bg-[#f8dfdf] text-[#94545c]' },
    { key: 'inactive', label: '已停用', tone: 'bg-[#edf0f4] text-[#6f7682]' },
];

function formatDateTime(value?: string | null): string {
    if (!value) return '-';
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return value;
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function kindLabel(kind: string): string {
    return kind === 'long_cycle' ? '长周期任务' : '定时任务';
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

function backgroundTaskStatusLabel(value?: string | null): string {
    switch ((value || '').trim()) {
        case 'running':
            return '运行中';
        case 'completed':
            return '已完成';
        case 'failed':
            return '失败';
        case 'cancelled':
            return '已取消';
        default:
            return value || '未知';
    }
}

function backgroundTaskPhaseLabel(value?: string | null): string {
    switch ((value || '').trim()) {
        case 'queued':
            return '排队中';
        case 'starting':
            return '启动中';
        case 'thinking':
            return '处理中';
        case 'tooling':
            return '执行中';
        case 'responding':
            return '回传中';
        case 'updating':
            return '更新中';
        case 'completed':
            return '已完成';
        case 'failed':
            return '失败';
        case 'cancelled':
            return '已取消';
        default:
            return value || '进行中';
    }
}

function backgroundTaskKindLabel(kind?: string | null): string {
    switch ((kind || '').trim()) {
        case 'headless-runtime':
            return '后台执行';
        case 'scheduled-task':
            return '定时任务';
        case 'long-cycle':
            return '长周期';
        case 'heartbeat':
            return '心跳任务';
        default:
            return kind || '后台任务';
    }
}

function backgroundTaskSummary(item: BackgroundTaskItem): string {
    return String(item.latestText || item.summary || item.error || '任务正在后台执行。').trim();
}

function backgroundTaskCanCancel(item: BackgroundTaskItem): boolean {
    return ['queued', 'leased', 'running', 'retrying'].includes(String(item.workerState || '').trim());
}

function triggerLabel(item: TaskListItem): string {
    if (item.kind === 'long_cycle') {
        return `长周期 / ${item.triggerKind || 'interval'}`;
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

function taskContent(item: TaskListItem): string {
    const values = [
        item.goal,
        item.prompt,
        item.objective,
        item.stepPrompt,
    ]
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

function resolveColumnKey(item: TaskListItem): TaskColumnKey {
    if (item.requiresConfirmation) return 'draft';
    if (item.cooldown?.state === 'active') return 'cooldown';
    if (item.enabled) return 'active';
    return 'inactive';
}

function columnConfigForKey(key: TaskColumnKey) {
    return COLUMN_ORDER.find((column) => column.key === key) || COLUMN_ORDER[0];
}

function emptyMessageForColumn(key: TaskColumnKey): string {
    switch (key) {
        case 'draft':
            return '当前没有待确认任务草稿';
        case 'active':
            return '当前没有正在生效的任务定义';
        case 'cooldown':
            return '当前没有进入冷却的任务';
        default:
            return '当前没有停用或已完成的任务';
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

async function resumeTask(item: TaskListItem): Promise<void> {
    if (!item.sourceTaskId || !item.sourceKind) {
        throw new Error('当前任务没有可恢复的源任务。');
    }
    if (item.sourceKind === 'scheduled') {
        await window.ipcRenderer.redclawRunner.setScheduledEnabled({
            taskId: item.sourceTaskId,
            enabled: true,
        });
        return;
    }
    if (item.sourceKind === 'long_cycle') {
        await window.ipcRenderer.redclawRunner.setLongCycleEnabled({
            taskId: item.sourceTaskId,
            enabled: true,
        });
        return;
    }
    throw new Error('当前任务类型暂不支持恢复。');
}

export function Workboard({ isActive = true }: { isActive?: boolean }) {
    const [items, setItems] = useState<TaskListItem[]>([]);
    const [stats, setStats] = useState<TaskStatsResponse | null>(null);
    const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastUpdatedAt, setLastUpdatedAt] = useState('');
    const [selectedId, setSelectedId] = useState('');
    const [selectedBackgroundTaskId, setSelectedBackgroundTaskId] = useState('');
    const [actionState, setActionState] = useState<{ id: string; action: string } | null>(null);
    const itemsRef = useRef<TaskListItem[]>([]);
    const backgroundTasksRef = useRef<BackgroundTaskItem[]>([]);
    const loadRequestRef = useRef(0);

    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    useEffect(() => {
        backgroundTasksRef.current = backgroundTasks;
    }, [backgroundTasks]);

    const load = useCallback(async () => {
        const requestId = loadRequestRef.current + 1;
        loadRequestRef.current = requestId;
        const hasLocalData = itemsRef.current.length > 0 || backgroundTasksRef.current.length > 0;
        if (!hasLocalData) {
            setLoading(true);
        }
        setError('');
        try {
            const [taskListResult, taskStatsResult, backgroundTaskResult] = await Promise.all([
                window.ipcRenderer.redclawRunner.taskList({ includeDrafts: true }),
                window.ipcRenderer.redclawRunner.taskStats(),
                window.ipcRenderer.backgroundTasks.list(),
            ]);
            if (requestId !== loadRequestRef.current) return;
            const nextItems = Array.isArray(taskListResult?.items) ? taskListResult.items : [];
            const nextBackgroundTasks = Array.isArray(backgroundTaskResult) ? backgroundTaskResult as BackgroundTaskItem[] : [];
            setItems(nextItems);
            setStats(taskStatsResult || null);
            setBackgroundTasks(nextBackgroundTasks);
            setLastUpdatedAt(new Date().toISOString());
            setSelectedId((prev) => (prev && nextItems.some((item) => item.definitionId === prev) ? prev : ''));
            setSelectedBackgroundTaskId((prev) => (
                prev && nextBackgroundTasks.some((task) => task.id === prev) ? prev : ''
            ));
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

    useEffect(() => {
        if (!isActive) return;
        const onBackgroundTaskUpdated = (event: Event) => {
            const detail = (event as CustomEvent<BackgroundTaskItem>).detail;
            const task = detail && typeof detail === 'object' ? detail : null;
            if (!task) return;
            setBackgroundTasks((current) => {
                const next = [...current];
                const index = next.findIndex((item) => item.id === task.id);
                if (index >= 0) {
                    next[index] = task;
                } else {
                    next.unshift(task);
                }
                return next
                    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
                    .slice(0, 100);
            });
            setLastUpdatedAt(new Date().toISOString());
        };
        window.ipcRenderer.on('background:task-updated', onBackgroundTaskUpdated);
        return () => {
            window.ipcRenderer.off('background:task-updated', onBackgroundTaskUpdated);
        };
    }, [isActive]);

    const grouped = useMemo(() => {
        const map = new Map<TaskColumnKey, TaskListItem[]>();
        for (const column of COLUMN_ORDER) {
            map.set(column.key, []);
        }
        for (const item of items) {
            map.get(resolveColumnKey(item))?.push(item);
        }
        for (const column of COLUMN_ORDER) {
            map.get(column.key)?.sort((left, right) => {
                const leftDueAt = Date.parse(left.nextDueAt || '') || Number.MAX_SAFE_INTEGER;
                const rightDueAt = Date.parse(right.nextDueAt || '') || Number.MAX_SAFE_INTEGER;
                return leftDueAt - rightDueAt;
            });
        }
        return map;
    }, [items]);

    const selectedItem = useMemo(
        () => items.find((item) => item.definitionId === selectedId) || null,
        [items, selectedId],
    );
    const selectedBackgroundTask = useMemo(
        () => backgroundTasks.find((item) => item.id === selectedBackgroundTaskId) || null,
        [backgroundTasks, selectedBackgroundTaskId],
    );

    const selectedColumn = selectedItem ? columnConfigForKey(resolveColumnKey(selectedItem)) : null;

    const topStats = useMemo(() => ({
        totalDefinitions: stats?.definitions?.total ?? items.length,
        drafts: stats?.definitions?.drafts ?? (grouped.get('draft')?.length || 0),
        active: stats?.definitions?.active ?? (grouped.get('active')?.length || 0),
        runningExecutions: stats?.executions?.running ?? 0,
        failedExecutions: stats?.executions?.failed ?? 0,
        backgroundRunning: backgroundTasks.filter((task) => task.status === 'running').length,
    }), [backgroundTasks, grouped, items.length, stats]);

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

    const recentExecutions = useMemo(
        () => Array.isArray(stats?.executions?.recent) ? stats.executions.recent : [],
        [stats],
    );
    const recentBackgroundTasks = useMemo(
        () => backgroundTasks.slice(0, 6),
        [backgroundTasks],
    );

    return (
        <div className="h-full min-h-0 bg-[#fbfaf7] text-[#191919]">
            <div className="h-full min-h-0 flex flex-col px-8 py-7 gap-5">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                    <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">任务定义</div>
                        <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{topStats.totalDefinitions}</div>
                    </div>
                    <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">待确认</div>
                        <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{topStats.drafts}</div>
                    </div>
                    <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">生效中</div>
                        <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{topStats.active}</div>
                    </div>
                    <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">执行中</div>
                        <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{topStats.runningExecutions}</div>
                    </div>
                    <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">失败执行</div>
                        <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{topStats.failedExecutions}</div>
                    </div>
                    <div className="rounded-[22px] border border-[#ece4d8] bg-white px-4 py-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">后台任务</div>
                        <div className="mt-2 text-[24px] font-semibold text-[#1d1b18]">{topStats.backgroundRunning}</div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[13px] leading-6 text-[#7b7469]">
                        当前界面已切换到新的任务定义模型，展示草稿确认、策略决策、冷却状态、时区和最近执行链路。
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
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
                </div>

                {error && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 inline-flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-2">
                    <div className="h-full min-w-max grid auto-cols-[288px] grid-flow-col gap-4">
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
                                                {emptyMessageForColumn(column.key)}
                                            </div>
                                        ) : (
                                            list.map((item) => (
                                                <button
                                                    key={item.definitionId}
                                                    onClick={() => {
                                                        setSelectedBackgroundTaskId('');
                                                        setSelectedId(item.definitionId);
                                                    }}
                                                    className="group w-full text-left rounded-[24px] border border-[#ddd7cd] bg-white px-5 py-5 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(28,28,28,0.07)] transition duration-200 shadow-[0_3px_10px_rgba(30,30,30,0.035)]"
                                                >
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap gap-1.5">
                                                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${column.tone}`}>
                                                                {column.label}
                                                            </span>
                                                            <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium bg-[#f5e7df] text-[#7a7066]">
                                                                {kindLabel(item.kind)}
                                                            </span>
                                                            <span className="inline-flex items-center rounded-full border border-[#e8dfd3] bg-[#fbf8f2] px-2.5 py-1 text-[12px] font-medium text-[#7a7066]">
                                                                {policyLabel(item.policyDecision)}
                                                            </span>
                                                        </div>

                                                        <div className="mt-4 text-[16px] font-semibold leading-[1.35] tracking-[-0.02em] text-[#1d1b18] line-clamp-2">
                                                            {item.title}
                                                        </div>

                                                        <div className="mt-3 text-[13px] leading-6 text-[#81796e] line-clamp-3">
                                                            {taskContent(item)}
                                                        </div>

                                                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[#8f877b]">
                                                            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-[#f3ede2] px-2.5 py-1">
                                                                <Clock3 className="h-3.5 w-3.5 shrink-0" />
                                                                <span className="line-clamp-1">{scheduleSummary(item)}</span>
                                                            </span>
                                                            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f6f1e8] px-2.5 py-1">
                                                                <ListTodo className="h-3.5 w-3.5 shrink-0" />
                                                                {triggerLabel(item)}
                                                            </span>
                                                            {item.latestExecution?.status ? (
                                                                <span className="inline-flex items-center rounded-full bg-[#eef2f6] px-2.5 py-1 font-medium text-[#677284]">
                                                                    执行 {executionStatusLabel(item.latestExecution.status)}
                                                                </span>
                                                            ) : null}
                                                        </div>

                                                        {item.cooldown?.state === 'active' && (
                                                            <div className="mt-3 rounded-[18px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] leading-5 text-rose-800">
                                                                冷却中：连续失败 {Number(item.cooldown.consecutiveFailures || 0)} 次
                                                            </div>
                                                        )}
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

                <section className="rounded-[26px] border border-[#e6ddd0] bg-white px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">后台任务</div>
                            <div className="mt-1 text-[14px] text-[#736b5f]">展示运行时临时任务，包括多图生成的后台跟进和回传任务。</div>
                        </div>
                    </div>
                    <div className="mt-4 space-y-2">
                        {recentBackgroundTasks.length === 0 ? (
                            <div className="rounded-[18px] bg-[#faf6ef] px-4 py-4 text-sm text-[#968f82]">
                                暂无后台任务
                            </div>
                        ) : (
                            recentBackgroundTasks.map((task) => (
                                <button
                                    key={task.id}
                                    onClick={() => {
                                        setSelectedId('');
                                        setSelectedBackgroundTaskId(task.id);
                                    }}
                                    className="w-full text-left rounded-[18px] border border-[#ece4d8] bg-[#fcfbf8] px-4 py-3 hover:bg-white"
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center rounded-full bg-[#edf0f4] px-2.5 py-1 text-[12px] text-[#68707a]">
                                            {backgroundTaskKindLabel(task.kind)}
                                        </span>
                                        <span className="inline-flex items-center rounded-full bg-[#f4efe6] px-2.5 py-1 text-[12px] text-[#6d6558]">
                                            {backgroundTaskStatusLabel(task.status)}
                                        </span>
                                        <span className="text-[12px] text-[#8f877b]">{backgroundTaskPhaseLabel(task.phase)}</span>
                                    </div>
                                    <div className="mt-2 text-[14px] font-medium text-[#1d1b18]">
                                        {task.title}
                                    </div>
                                    <div className="mt-1 text-[13px] text-[#5b5449]">
                                        {backgroundTaskSummary(task)}
                                    </div>
                                    <div className="mt-2 text-[12px] text-[#8f877b]">
                                        更新时间 {formatDateTime(task.updatedAt)}
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </section>

                <section className="rounded-[26px] border border-[#e6ddd0] bg-white px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">最近执行</div>
                            <div className="mt-1 text-[14px] text-[#736b5f]">用于追踪最新的排队、重试、失败和成功记录。</div>
                        </div>
                    </div>
                    <div className="mt-4 space-y-2">
                        {recentExecutions.length === 0 ? (
                            <div className="rounded-[18px] bg-[#faf6ef] px-4 py-4 text-sm text-[#968f82]">
                                暂无最近执行记录
                            </div>
                        ) : (
                            recentExecutions.slice(0, 5).map((execution) => (
                                <div key={execution.executionId} className="rounded-[18px] border border-[#ece4d8] bg-[#fcfbf8] px-4 py-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center rounded-full bg-[#edf0f4] px-2.5 py-1 text-[12px] text-[#68707a]">
                                            {executionStatusLabel(execution.status)}
                                        </span>
                                        <span className="text-[12px] text-[#7a7267]">{execution.definitionId}</span>
                                        {execution.retryBucket ? (
                                            <span className="text-[12px] text-[#9b9488]">bucket: {execution.retryBucket}</span>
                                        ) : null}
                                    </div>
                                    <div className="mt-2 text-[13px] text-[#5b5449]">
                                        计划时间 {formatDateTime(execution.scheduledForAt)}{execution.lastError ? ` · ${execution.lastError}` : ''}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>

            {selectedItem && (
                <div className="fixed inset-0 z-[70] bg-[#18120a]/45 backdrop-blur-[6px] flex items-center justify-center px-4 py-6">
                    <div className="w-full max-w-[1040px] max-h-[88vh] overflow-hidden rounded-[32px] border border-[#ddd7cd] bg-[#fcfbf8] shadow-[0_28px_90px_rgba(20,20,20,0.18)]">
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
                                            {kindLabel(selectedItem.kind)}
                                        </span>
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            {triggerLabel(selectedItem)}
                                        </span>
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            策略 {policyLabel(selectedItem.policyDecision)}
                                        </span>
                                    </div>

                                    <div className="mt-4 flex flex-wrap gap-2.5">
                                        {selectedItem.requiresConfirmation && selectedItem.draftId ? (
                                            <>
                                                <button
                                                    onClick={() => void executeAction(
                                                        selectedItem,
                                                        'confirm',
                                                        async () => {
                                                            await window.ipcRenderer.redclawRunner.taskConfirm({
                                                                draftId: selectedItem.draftId!,
                                                                confirm: true,
                                                            });
                                                        },
                                                    )}
                                                    className="h-10 px-4 rounded-full border border-[#d9cfbe] bg-[#191919] text-white text-sm inline-flex items-center gap-2 hover:bg-[#2a241d]"
                                                >
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'confirm'
                                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : <Play className="w-4 h-4" />}
                                                    确认启用
                                                </button>
                                                <button
                                                    onClick={() => void executeAction(
                                                        selectedItem,
                                                        'discard',
                                                        async () => {
                                                            await window.ipcRenderer.redclawRunner.taskConfirm({
                                                                draftId: selectedItem.draftId!,
                                                                confirm: false,
                                                            });
                                                        },
                                                    )}
                                                    className="h-10 px-4 rounded-full border border-[#e4ddd1] bg-white text-sm inline-flex items-center gap-2 text-[#5f584d] hover:bg-[#f5f1e9]"
                                                >
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'discard'
                                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : null}
                                                    丢弃草稿
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                {selectedItem.sourceTaskId && selectedItem.sourceKind && (
                                                    <button
                                                        onClick={() => void executeAction(
                                                            selectedItem,
                                                            'run-now',
                                                            () => runTaskNow(selectedItem),
                                                        )}
                                                        className="h-10 px-4 rounded-full border border-[#d9cfbe] bg-[#191919] text-white text-sm inline-flex items-center gap-2 hover:bg-[#2a241d]"
                                                    >
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'run-now'
                                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                                            : <Play className="w-4 h-4" />}
                                                        立即执行
                                                    </button>
                                                )}
                                                {!selectedItem.enabled && selectedItem.sourceTaskId && selectedItem.sourceKind && (
                                                    <button
                                                        onClick={() => void executeAction(
                                                            selectedItem,
                                                            'resume',
                                                            () => resumeTask(selectedItem),
                                                        )}
                                                        className="h-10 px-4 rounded-full border border-[#e4ddd1] bg-white text-sm inline-flex items-center gap-2 text-[#5f584d] hover:bg-[#f5f1e9]"
                                                    >
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'resume'
                                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                                            : null}
                                                        恢复启用
                                                    </button>
                                                )}
                                                {selectedItem.enabled && (
                                                    <button
                                                        onClick={() => void executeAction(
                                                            selectedItem,
                                                            'cancel',
                                                            async () => {
                                                                await window.ipcRenderer.redclawRunner.taskCancel({
                                                                    jobDefinitionId: selectedItem.definitionId,
                                                                    reason: 'Cancelled from Workboard',
                                                                });
                                                            },
                                                        )}
                                                        className="h-10 px-4 rounded-full border border-[#e4ddd1] bg-white text-sm inline-flex items-center gap-2 text-[#5f584d] hover:bg-[#f5f1e9]"
                                                    >
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'cancel'
                                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                                            : null}
                                                        停用任务
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>

                                    <div className="mt-4 text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-[#1b1813]">
                                        {selectedItem.title}
                                    </div>
                                    <div className="mt-3 max-w-3xl text-[14px] leading-7 text-[#72695d]">
                                        {taskContent(selectedItem)}
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
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedColumn?.label || '-'}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">下一次触发</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{formatDateTime(selectedItem.nextDueAt)}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">时区</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedItem.timezone || 'local'}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">Missed Window</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedItem.missedRunPolicy || 'single'}</div>
                                </div>
                            </div>
                        </div>

                        <div className="grid max-h-[calc(88vh-320px)] grid-cols-1 gap-5 overflow-y-auto px-6 py-5 md:grid-cols-2 md:px-8">
                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">任务内容</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    {selectedItem.goal ? (
                                        <div>
                                            <div className="font-medium text-[#2c2823]">目标</div>
                                            <div className="mt-1 whitespace-pre-wrap">{selectedItem.goal}</div>
                                        </div>
                                    ) : null}
                                    {selectedItem.prompt ? (
                                        <div>
                                            <div className="font-medium text-[#2c2823]">执行指令</div>
                                            <div className="mt-1 whitespace-pre-wrap">{selectedItem.prompt}</div>
                                        </div>
                                    ) : null}
                                    {selectedItem.objective ? (
                                        <div>
                                            <div className="font-medium text-[#2c2823]">长期目标</div>
                                            <div className="mt-1 whitespace-pre-wrap">{selectedItem.objective}</div>
                                        </div>
                                    ) : null}
                                    {selectedItem.stepPrompt ? (
                                        <div>
                                            <div className="font-medium text-[#2c2823]">每轮指令</div>
                                            <div className="mt-1 whitespace-pre-wrap">{selectedItem.stepPrompt}</div>
                                        </div>
                                    ) : null}
                                </div>
                            </section>

                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">策略与治理</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">ownerScope</span>
                                        <span className="text-right text-[#2c2823]">{selectedItem.ownerScope || '-'}</span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">actionType</span>
                                        <span className="text-right text-[#2c2823]">{selectedItem.actionType || '-'}</span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">创建来源</span>
                                        <span className="text-right text-[#2c2823]">
                                            {selectedItem.createdBy || '-'} / {selectedItem.creatorMode || '-'}
                                        </span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">定义指纹</span>
                                        <span className="text-right text-[#2c2823]">{shortFingerprint(selectedItem.definitionFingerprint)}</span>
                                    </div>
                                    {selectedItem.riskRationale ? (
                                        <div className="rounded-[18px] bg-[#faf6ef] px-3.5 py-3">
                                            <div className="font-medium text-[#2c2823]">风险说明</div>
                                            <div className="mt-1">{selectedItem.riskRationale}</div>
                                        </div>
                                    ) : null}
                                    {Array.isArray(selectedItem.policyWarnings) && selectedItem.policyWarnings.length > 0 ? (
                                        <div className="rounded-[18px] border border-amber-200 bg-amber-50/80 px-3.5 py-3">
                                            <div className="font-medium text-amber-900">策略提示</div>
                                            <div className="mt-1 text-amber-900 whitespace-pre-wrap">
                                                {selectedItem.policyWarnings.join('\n')}
                                            </div>
                                        </div>
                                    ) : null}
                                    {selectedItem.cooldown?.state === 'active' ? (
                                        <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-3.5 py-3">
                                            <div className="font-medium text-rose-900">冷却状态</div>
                                            <div className="mt-1 text-rose-900">
                                                连续失败 {Number(selectedItem.cooldown.consecutiveFailures || 0)} 次 ·
                                                激活于 {formatDateTime(selectedItem.cooldown.activatedAt)} ·
                                                {selectedItem.cooldown.reason || '连续失败进入冷却'}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            </section>

                            <section className="rounded-[24px] border border-[#ebe4d9] bg-[#faf6ef] p-5">
                                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[#a09789]">
                                    <Clock3 className="h-3.5 w-3.5" />
                                    调度计划
                                </div>
                                <div className="mt-3 text-[14px] leading-7 text-[#564f45]">
                                    {scheduleSummary(selectedItem)}
                                </div>
                                {selectedItem.kind === 'long_cycle' ? (
                                    <div className="mt-3 text-[13px] text-[#746c60]">
                                        当前轮次 {Number(selectedItem.completedRounds || 0)} / {Number(selectedItem.totalRounds || 0)}
                                    </div>
                                ) : null}
                            </section>

                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">最近执行</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">执行状态</span>
                                        <span className="text-right text-[#2c2823]">
                                            {executionStatusLabel(selectedItem.latestExecution?.status)}
                                        </span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">计划时间</span>
                                        <span className="text-right text-[#2c2823]">
                                            {formatDateTime(selectedItem.latestExecution?.scheduledForAt)}
                                        </span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">尝试次数</span>
                                        <span className="text-right text-[#2c2823]">
                                            {selectedItem.latestExecution?.attemptNo ?? '-'}
                                        </span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">最近心跳</span>
                                        <span className="text-right text-[#2c2823]">
                                            {formatDateTime(selectedItem.latestExecution?.lastHeartbeatAt)}
                                        </span>
                                    </div>
                                    <div className="flex items-start justify-between gap-4">
                                        <span className="text-[#918777]">更新时间</span>
                                        <span className="text-right text-[#2c2823]">
                                            {formatDateTime(selectedItem.latestExecution?.updatedAt || selectedItem.updatedAt)}
                                        </span>
                                    </div>
                                    {selectedItem.latestExecution?.lastError ? (
                                        <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-3.5 py-3 text-rose-900">
                                            {selectedItem.latestExecution.lastError}
                                        </div>
                                    ) : null}
                                </div>
                            </section>
                        </div>
                    </div>
                </div>
            )}

            {selectedBackgroundTask && (
                <div className="fixed inset-0 z-[70] bg-[#18120a]/45 backdrop-blur-[6px] flex items-center justify-center px-4 py-6">
                    <div className="w-full max-w-[920px] max-h-[88vh] overflow-hidden rounded-[32px] border border-[#ddd7cd] bg-[#fcfbf8] shadow-[0_28px_90px_rgba(20,20,20,0.18)]">
                        <div className="border-b border-[#ebe4d9] bg-[linear-gradient(180deg,#fffdf9_0%,#f7f2e9_100%)] px-6 py-6 md:px-8">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            {backgroundTaskKindLabel(selectedBackgroundTask.kind)}
                                        </span>
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            {backgroundTaskStatusLabel(selectedBackgroundTask.status)}
                                        </span>
                                        <span className="inline-flex items-center rounded-full border border-[#e6ddd0] bg-white px-3 py-1 text-[12px] text-[#7c7569]">
                                            {backgroundTaskPhaseLabel(selectedBackgroundTask.phase)}
                                        </span>
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-2.5">
                                        {backgroundTaskCanCancel(selectedBackgroundTask) && (
                                            <button
                                                onClick={() => void executeAction(
                                                    { definitionId: selectedBackgroundTask.id } as TaskListItem,
                                                    'cancel-background',
                                                    async () => {
                                                        await window.ipcRenderer.backgroundTasks.cancel(selectedBackgroundTask.id);
                                                    },
                                                )}
                                                className="h-10 px-4 rounded-full border border-[#e4ddd1] bg-white text-sm inline-flex items-center gap-2 text-[#5f584d] hover:bg-[#f5f1e9]"
                                            >
                                                {actionState?.id === selectedBackgroundTask.id && actionState.action === 'cancel-background'
                                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                                    : null}
                                                停止任务
                                            </button>
                                        )}
                                    </div>
                                    <div className="mt-4 text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-[#1b1813]">
                                        {selectedBackgroundTask.title}
                                    </div>
                                    <div className="mt-3 max-w-3xl text-[14px] leading-7 text-[#72695d]">
                                        {backgroundTaskSummary(selectedBackgroundTask)}
                                    </div>
                                </div>
                                <button
                                    onClick={() => setSelectedBackgroundTaskId('')}
                                    className="h-11 w-11 shrink-0 rounded-full border border-[#e7dfd4] bg-white inline-flex items-center justify-center text-[#8c8579] hover:bg-[#f5f1e9] hover:text-[#191919]"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-4">
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">Worker State</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedBackgroundTask.workerState || '-'}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">Session</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{selectedBackgroundTask.sessionId || '-'}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">创建时间</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{formatDateTime(selectedBackgroundTask.createdAt)}</div>
                                </div>
                                <div className="rounded-[20px] border border-[#ece4d8] bg-white px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">更新时间</div>
                                    <div className="mt-2 text-[15px] font-semibold text-[#1d1b18]">{formatDateTime(selectedBackgroundTask.updatedAt)}</div>
                                </div>
                            </div>
                        </div>

                        <div className="grid max-h-[calc(88vh-320px)] grid-cols-1 gap-5 overflow-y-auto px-6 py-5 md:grid-cols-2 md:px-8">
                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">任务摘要</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    <div>
                                        <div className="font-medium text-[#2c2823]">摘要</div>
                                        <div className="mt-1 whitespace-pre-wrap">{selectedBackgroundTask.summary || '-'}</div>
                                    </div>
                                    <div>
                                        <div className="font-medium text-[#2c2823]">最新状态</div>
                                        <div className="mt-1 whitespace-pre-wrap">{selectedBackgroundTask.latestText || '-'}</div>
                                    </div>
                                    {selectedBackgroundTask.error ? (
                                        <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-3.5 py-3 text-rose-900">
                                            {selectedBackgroundTask.error}
                                        </div>
                                    ) : null}
                                </div>
                            </section>

                            <section className="rounded-[24px] border border-[#ebe4d9] bg-white p-5">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-[#a09789]">事件流</div>
                                <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#5c5448]">
                                    {selectedBackgroundTask.turns.length === 0 ? (
                                        <div className="rounded-[18px] bg-[#faf6ef] px-4 py-4 text-sm text-[#968f82]">
                                            暂无事件记录
                                        </div>
                                    ) : (
                                        selectedBackgroundTask.turns.map((turn) => (
                                            <div key={turn.id} className="rounded-[18px] border border-[#ece4d8] bg-[#fcfbf8] px-4 py-3">
                                                <div className="text-[12px] text-[#8f877b]">{formatDateTime(turn.at)}</div>
                                                <div className="mt-1 text-[13px] text-[#2c2823]">{turn.text}</div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </section>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default Workboard;
