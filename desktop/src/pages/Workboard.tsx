import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Clock3, ListTodo, Loader2, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { appAlert, appConfirm } from '../utils/appDialogs';

type TaskListResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskList>>;
type TaskListItem = NonNullable<TaskListResponse['items']>[number];
type TaskStatsResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskStats>>;

type TaskFilterKey = 'all' | 'scheduled' | 'long_cycle' | 'draft' | 'active' | 'cooldown';
type TaskEditorMode = 'create' | 'edit';
type TaskEditorKind = 'scheduled' | 'long_cycle';

interface TaskEditorState {
    kind: TaskEditorKind;
    name: string;
    cron: string;
    prompt: string;
    objective: string;
    stepPrompt: string;
    actionType: string;
    ownerScope: string;
    timezone: string;
    missedRunPolicy: string;
    totalRounds: string;
    reason: string;
}

const defaultTaskEditorState: TaskEditorState = {
    kind: 'scheduled',
    name: '',
    cron: '0 9 * * *',
    prompt: '',
    objective: '',
    stepPrompt: '',
    actionType: 'redclaw_prompt',
    ownerScope: 'manual:redclaw',
    timezone: 'local',
    missedRunPolicy: 'single',
    totalRounds: '12',
    reason: '',
};

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

function cronFromItem(item: TaskListItem): string {
    if (item.triggerKind === 'interval') {
        return `@every ${Number(item.intervalMinutes || (item.kind === 'long_cycle' ? 720 : 60))} minutes`;
    }
    if (item.triggerKind === 'daily' && item.time) {
        const [hour = '9', minute = '0'] = item.time.split(':');
        return `${Number(minute)} ${Number(hour)} * * *`;
    }
    if (item.triggerKind === 'weekly' && item.time) {
        const [hour = '9', minute = '0'] = item.time.split(':');
        const weekdays = Array.isArray(item.weekdays) && item.weekdays.length > 0 ? item.weekdays.join(',') : '1';
        return `${Number(minute)} ${Number(hour)} * * ${weekdays}`;
    }
    if (item.triggerKind === 'once' && item.runAt) {
        return `@once ${item.runAt}`;
    }
    return item.kind === 'long_cycle' ? '@every 12 hours' : '0 9 * * *';
}

function editorStateFromItem(item: TaskListItem): TaskEditorState {
    return {
        kind: item.kind === 'long_cycle' ? 'long_cycle' : 'scheduled',
        name: item.title || '',
        cron: cronFromItem(item),
        prompt: item.prompt || item.goal || '',
        objective: item.objective || '',
        stepPrompt: item.stepPrompt || '',
        actionType: item.actionType || (item.kind === 'long_cycle' ? 'long_cycle' : 'redclaw_prompt'),
        ownerScope: item.ownerScope || 'manual:redclaw',
        timezone: item.timezone || 'local',
        missedRunPolicy: item.missedRunPolicy || 'single',
        totalRounds: String(item.totalRounds || 12),
        reason: '用户从任务中心更新任务',
    };
}

function taskIntentFromEditor(editor: TaskEditorState): Record<string, unknown> {
    const name = editor.name.trim();
    const cron = editor.cron.trim();
    const actionType = editor.actionType.trim() || (editor.kind === 'long_cycle' ? 'long_cycle' : 'redclaw_prompt');
    const ownerScope = editor.ownerScope.trim() || 'manual:redclaw';
    const timezone = editor.timezone.trim() || 'local';
    const missedRunPolicy = editor.missedRunPolicy.trim() || 'single';

    if (!name) throw new Error('请填写任务名称。');
    if (!cron) throw new Error('请填写调度表达式。');

    const intent: Record<string, unknown> = {
        kind: editor.kind,
        name,
        cron,
        actionType,
        ownerScope,
        timezone,
        missedRunPolicy,
        creatorMode: 'ui-manual',
        createdBy: 'redclaw-task-center',
    };

    if (editor.kind === 'long_cycle') {
        const objective = editor.objective.trim();
        const stepPrompt = editor.stepPrompt.trim();
        const totalRounds = Number(editor.totalRounds || 12);
        if (!objective) throw new Error('长周期任务需要填写目标。');
        if (!stepPrompt) throw new Error('长周期任务需要填写每轮提示词。');
        intent.objective = objective;
        intent.stepPrompt = stepPrompt;
        intent.totalRounds = Number.isFinite(totalRounds) && totalRounds > 0 ? Math.floor(totalRounds) : 12;
    } else {
        const prompt = editor.prompt.trim();
        if (!prompt) throw new Error('定时任务需要填写执行提示词。');
        intent.prompt = prompt;
        intent.goal = prompt;
    }

    return intent;
}

function previewTokenFromResult(result: unknown): string {
    const token = (result as { previewToken?: unknown })?.previewToken;
    return typeof token === 'string' ? token : '';
}

function draftIdFromResult(result: unknown): string {
    const value = result as { draftId?: unknown; definition?: { draftId?: unknown; id?: unknown } };
    if (typeof value?.draftId === 'string') return value.draftId;
    if (typeof value?.definition?.draftId === 'string') return value.definition.draftId;
    if (typeof value?.definition?.id === 'string') return value.definition.id;
    return '';
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
}: {
    label: string;
    value: number;
}) {
    return (
        <div className="inline-flex min-w-fit items-center gap-2.5 rounded-full border border-[#ece4d8] bg-white px-3.5 py-2">
            <div className="whitespace-nowrap text-[10px] uppercase tracking-[0.16em] text-[#a09789]">{label}</div>
            <div className="text-[18px] font-semibold leading-none text-[#1d1b18]">{value}</div>
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
        <div className="rounded-[18px] border border-[#eee7dc] bg-[#fcfbf9] px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">{label}</div>
            <div className="mt-1 text-[13px] leading-5 text-[#201d1a] break-words">{value}</div>
        </div>
    );
}

function TaskEditorPanel({
    mode,
    value,
    busy,
    error,
    onChange,
    onSubmit,
    onCancel,
}: {
    mode: TaskEditorMode;
    value: TaskEditorState;
    busy: boolean;
    error: string;
    onChange: (value: TaskEditorState) => void;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    const update = (patch: Partial<TaskEditorState>) => onChange({ ...value, ...patch });
    const inputClass = 'mt-1.5 w-full rounded-[14px] border border-[#e7ded1] bg-white px-3 py-2 text-[13px] text-[#201d1a] outline-none transition focus:border-[#c8a66f] focus:ring-2 focus:ring-[#ead8b8]';
    const labelClass = 'text-[10px] uppercase tracking-[0.16em] text-[#9c9284]';

    return (
        <section className="rounded-[22px] border border-[#e8dccb] bg-[#fffaf2] px-4 py-4 shadow-[0_16px_40px_rgba(107,78,38,0.06)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="text-[13px] font-semibold text-[#1d1b18]">
                        {mode === 'create' ? '创建任务' : '编辑任务'}
                    </div>
                    <div className="mt-1 text-[11px] leading-5 text-[#7e7568]">
                        通过统一任务协议写入 RedClaw 调度任务，保存前会先执行策略预览。
                    </div>
                </div>
                <button
                    onClick={onCancel}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#e5dacb] bg-white text-[#766d61] hover:bg-[#f7f1e8]"
                    aria-label="关闭任务编辑器"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {error && (
                <div className="mt-3 rounded-[14px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
                    {error}
                </div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
                <label>
                    <div className={labelClass}>任务类型</div>
                    <select
                        value={value.kind}
                        disabled={mode === 'edit'}
                        onChange={(event) => update({
                            kind: event.target.value === 'long_cycle' ? 'long_cycle' : 'scheduled',
                            actionType: event.target.value === 'long_cycle' ? 'long_cycle' : 'redclaw_prompt',
                            cron: event.target.value === 'long_cycle' ? '@every 12 hours' : '0 9 * * *',
                        })}
                        className={inputClass}
                    >
                        <option value="scheduled">定时任务</option>
                        <option value="long_cycle">长周期任务</option>
                    </select>
                </label>
                <label>
                    <div className={labelClass}>任务名称</div>
                    <input value={value.name} onChange={(event) => update({ name: event.target.value })} className={inputClass} />
                </label>
                <label>
                    <div className={labelClass}>调度表达式</div>
                    <input
                        value={value.cron}
                        onChange={(event) => update({ cron: event.target.value })}
                        placeholder="例如 45 21 * * * 或 @every 12 hours"
                        className={inputClass}
                    />
                </label>
                <label>
                    <div className={labelClass}>动作分类</div>
                    <input value={value.actionType} onChange={(event) => update({ actionType: event.target.value })} className={inputClass} />
                </label>
                <label>
                    <div className={labelClass}>Owner Scope</div>
                    <input value={value.ownerScope} onChange={(event) => update({ ownerScope: event.target.value })} className={inputClass} />
                </label>
                <label>
                    <div className={labelClass}>时区</div>
                    <input value={value.timezone} onChange={(event) => update({ timezone: event.target.value })} className={inputClass} />
                </label>
                <label>
                    <div className={labelClass}>错过策略</div>
                    <select value={value.missedRunPolicy} onChange={(event) => update({ missedRunPolicy: event.target.value })} className={inputClass}>
                        <option value="single">single</option>
                        <option value="drop">drop</option>
                        <option value="catchup">catchup</option>
                    </select>
                </label>
                {value.kind === 'long_cycle' && (
                    <label>
                        <div className={labelClass}>总轮次</div>
                        <input value={value.totalRounds} onChange={(event) => update({ totalRounds: event.target.value })} className={inputClass} />
                    </label>
                )}
            </div>

            {value.kind === 'long_cycle' ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label>
                        <div className={labelClass}>目标</div>
                        <textarea value={value.objective} onChange={(event) => update({ objective: event.target.value })} className={`${inputClass} min-h-[98px] resize-y`} />
                    </label>
                    <label>
                        <div className={labelClass}>每轮提示词</div>
                        <textarea value={value.stepPrompt} onChange={(event) => update({ stepPrompt: event.target.value })} className={`${inputClass} min-h-[98px] resize-y`} />
                    </label>
                </div>
            ) : (
                <label className="mt-3 block">
                    <div className={labelClass}>执行提示词</div>
                    <textarea value={value.prompt} onChange={(event) => update({ prompt: event.target.value })} className={`${inputClass} min-h-[112px] resize-y`} />
                </label>
            )}

            {mode === 'edit' && (
                <label className="mt-3 block">
                    <div className={labelClass}>更新原因</div>
                    <input value={value.reason} onChange={(event) => update({ reason: event.target.value })} className={inputClass} />
                </label>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                <button
                    onClick={onCancel}
                    className="rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec]"
                >
                    取消
                </button>
                <button
                    onClick={onSubmit}
                    disabled={busy}
                    className="inline-flex items-center rounded-full border border-[#d2b690] bg-[#efe1ca] px-3.5 py-1.5 text-[12px] text-[#5e4730] hover:bg-[#e7d5b9] disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    {busy ? '保存中...' : mode === 'create' ? '创建并启用' : '保存修改'}
                </button>
            </div>
        </section>
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
    const [editorMode, setEditorMode] = useState<TaskEditorMode | null>(null);
    const [editorDraft, setEditorDraft] = useState<TaskEditorState>(defaultTaskEditorState);
    const [editorBusy, setEditorBusy] = useState(false);
    const [editorError, setEditorError] = useState('');
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

    const openCreateEditor = useCallback(() => {
        setEditorMode('create');
        setEditorDraft(defaultTaskEditorState);
        setEditorError('');
    }, []);

    const openEditEditor = useCallback((item: TaskListItem) => {
        setEditorMode('edit');
        setEditorDraft(editorStateFromItem(item));
        setEditorError('');
    }, []);

    const closeEditor = useCallback(() => {
        if (editorBusy) return;
        setEditorMode(null);
        setEditorError('');
    }, [editorBusy]);

    const submitEditor = useCallback(async () => {
        try {
            setEditorBusy(true);
            setEditorError('');
            const intent = taskIntentFromEditor(editorDraft);
            if (editorMode === 'create') {
                const preview = await window.ipcRenderer.redclawRunner.taskPreview({ intent });
                const previewToken = previewTokenFromResult(preview);
                if (!previewToken) throw new Error('任务预览未返回 previewToken。');
                const created = await window.ipcRenderer.redclawRunner.taskCreate({ intent, previewToken });
                const draftId = draftIdFromResult(created);
                if (!draftId) throw new Error('任务创建未返回 draftId。');
                await window.ipcRenderer.redclawRunner.taskConfirm({ draftId, confirm: true });
            } else if (editorMode === 'edit') {
                if (!selectedItem) throw new Error('请选择要编辑的任务。');
                await window.ipcRenderer.redclawRunner.taskUpdate({
                    jobDefinitionId: selectedItem.definitionId,
                    patch: intent,
                    reason: editorDraft.reason.trim() || '用户从任务中心更新任务',
                });
            }
            setEditorMode(null);
            await load();
        } catch (submitError) {
            setEditorError(submitError instanceof Error ? submitError.message : String(submitError));
        } finally {
            setEditorBusy(false);
        }
    }, [editorDraft, editorMode, load, selectedItem]);

    const deleteTask = useCallback(async (item: TaskListItem) => {
        const confirmed = await appConfirm(`确认删除任务“${item.title}”？删除后会移除源任务并取消关联执行。`, {
            title: '删除任务',
            confirmLabel: '删除',
            tone: 'danger',
        });
        if (!confirmed) return;
        await executeAction(item, 'delete', async () => {
            await window.ipcRenderer.redclawRunner.taskCancel({
                jobDefinitionId: item.definitionId,
                reason: '用户从任务中心删除任务',
                deleteSource: true,
            });
        });
    }, [executeAction]);

    return (
        <div className="h-full min-h-0 bg-[#fbfaf7] text-[#191919]">
            <div className="flex h-full min-h-0 flex-col gap-4 px-6 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="inline-flex items-center gap-1.5 rounded-full border border-[#ece3d5] bg-white px-2.5 py-1 text-[11px] text-[#7c7468]">
                            <ListTodo className="h-3 w-3" />
                            RedClaw 任务中心
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="rounded-full border border-[#ece5da] bg-white px-2.5 py-1 text-[11px] text-[#7d766a]">
                            更新于 {formatDateTime(lastUpdatedAt)}
                        </div>
                        <button
                            onClick={openCreateEditor}
                            className="inline-flex h-[32px] items-center gap-1.5 rounded-full border border-[#d2b690] bg-[#efe1ca] px-3 text-[11px] text-[#5e4730] shadow-[0_1px_2px_rgba(24,24,24,0.03)] hover:bg-[#e7d5b9]"
                        >
                            <Plus className="h-3 w-3" />
                            新建任务
                        </button>
                        <button
                            onClick={() => void load()}
                            className="inline-flex h-[32px] items-center gap-1.5 rounded-full border border-[#e7e0d4] bg-white px-3 text-[11px] text-[#7d766a] shadow-[0_1px_2px_rgba(24,24,24,0.03)] hover:bg-[#f5f1e9]"
                        >
                            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                            刷新
                        </button>
                    </div>
                </div>

                <div className="overflow-x-auto pb-1">
                    <div className="flex min-w-max items-center gap-2.5">
                        <StatCard label="任务总数" value={topStats.totalDefinitions} />
                        <StatCard label="定时任务" value={topStats.scheduled} />
                        <StatCard label="长周期" value={topStats.longCycle} />
                        <StatCard label="已启用" value={topStats.active} />
                        <StatCard label="执行中" value={topStats.runningExecutions} />
                        <StatCard label="失败执行" value={topStats.failedExecutions} />
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    {filterOptions.map((option) => (
                        <button
                            key={option.key}
                            onClick={() => setFilter(option.key)}
                            className={`rounded-full border px-3 py-1.5 text-[12px] transition ${
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
                    <div className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-700">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {error}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-hidden">
                    <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
                        <div className="min-h-0 overflow-hidden rounded-[24px] border border-[#ece4d8] bg-white">
                            <div className="flex items-center justify-between border-b border-[#f0e9de] px-4 py-3">
                                <div>
                                    <div className="text-[13px] font-medium text-[#1d1b18]">任务列表</div>
                                    <div className="mt-0.5 text-[11px] text-[#8b8378]">按当前筛选展示统一任务定义</div>
                                </div>
                                <div className="text-[11px] text-[#9a9184]">{filteredItems.length} 项</div>
                            </div>

                            <div className="h-[calc(100%-61px)] overflow-y-auto px-2.5 py-2.5">
                                {loading && items.length === 0 ? (
                                    <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[#7b7469]">
                                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                        正在加载任务列表
                                    </div>
                                ) : filteredItems.length === 0 ? (
                                    <div className="flex h-full min-h-[240px] items-center justify-center px-5 text-center text-[13px] leading-6 text-[#7b7469]">
                                        当前筛选下没有任务。你可以切换筛选查看其他任务状态。
                                    </div>
                                ) : (
                                    <div className="space-y-2.5">
                                        {filteredItems.map((item) => {
                                            const active = selectedItem?.definitionId === item.definitionId;
                                            const actionType = actionTypeLabel(item.actionType);
                                            return (
                                                <button
                                                    key={item.definitionId}
                                                    onClick={() => setSelectedId(item.definitionId)}
                                                    className={`w-full rounded-[18px] border px-3 py-2.5 text-left transition ${
                                                        active
                                                            ? 'border-[#d5b68b] bg-[#fbf2e6] shadow-[0_10px_24px_rgba(95,70,35,0.06)]'
                                                            : 'border-[#eee7dc] bg-[#fdfcf9] hover:border-[#e1d4c2] hover:bg-white'
                                                    }`}
                                                >
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        <span className="rounded-full bg-[#efe5d6] px-2 py-0.5 text-[10px] font-medium text-[#6d553a]">
                                                            {kindLabel(item.kind)}
                                                        </span>
                                                        {actionType && (
                                                            <span className="rounded-full bg-[#eef1f5] px-2 py-0.5 text-[10px] font-medium text-[#687180]">
                                                                {actionType}
                                                            </span>
                                                        )}
                                                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${lifecycleTone(item)}`}>
                                                            {lifecycleLabel(item)}
                                                        </span>
                                                    </div>

                                                    <div className="mt-2 truncate text-[13px] font-semibold text-[#1d1b18]">
                                                        {item.title}
                                                    </div>

                                                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[#877f73]">
                                                        <span className="inline-flex items-center gap-1.5">
                                                            <Clock3 className="h-3 w-3" />
                                                            {triggerLabel(item)}
                                                        </span>
                                                        <span>下次 {formatDateTime(item.nextDueAt)}</span>
                                                        <span>策略 {policyLabel(item.policyDecision)}</span>
                                                        {item.latestExecution && (
                                                            <span>执行 {executionStatusLabel(item.latestExecution.status)}</span>
                                                        )}
                                                    </div>

                                                    {item.cooldown?.state === 'active' && (
                                                        <div className="mt-1.5 rounded-[14px] border border-[#f0d5d8] bg-[#fff4f5] px-2.5 py-1.5 text-[10px] leading-4 text-[#9a525c]">
                                                            冷却中：连续失败 {Number(item.cooldown.consecutiveFailures || 0)} 次。
                                                        </div>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="min-h-0 overflow-y-auto rounded-[24px] border border-[#ece4d8] bg-white px-5 py-5">
                            {editorMode === 'create' ? (
                                <TaskEditorPanel
                                    mode="create"
                                    value={editorDraft}
                                    busy={editorBusy}
                                    error={editorError}
                                    onChange={setEditorDraft}
                                    onSubmit={() => void submitEditor()}
                                    onCancel={closeEditor}
                                />
                            ) : !selectedItem ? (
                                <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-[13px] leading-6 text-[#7b7469]">
                                    选择左侧任务后，这里会显示调度规则、策略信息和最近执行状态。也可以直接新建任务。
                                </div>
                            ) : (
                                <div className="space-y-5">
                                    {editorMode === 'edit' && (
                                        <TaskEditorPanel
                                            mode="edit"
                                            value={editorDraft}
                                            busy={editorBusy}
                                            error={editorError}
                                            onChange={setEditorDraft}
                                            onSubmit={() => void submitEditor()}
                                            onCancel={closeEditor}
                                        />
                                    )}
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="rounded-full bg-[#efe5d6] px-2.5 py-0.5 text-[11px] font-medium text-[#6d553a]">
                                                    {kindLabel(selectedItem.kind)}
                                                </span>
                                                {selectedItem.actionType && (
                                                    <span className="rounded-full bg-[#eef1f5] px-2.5 py-0.5 text-[11px] font-medium text-[#687180]">
                                                        {actionTypeLabel(selectedItem.actionType)}
                                                    </span>
                                                )}
                                                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${lifecycleTone(selectedItem)}`}>
                                                    {lifecycleLabel(selectedItem)}
                                                </span>
                                            </div>
                                            <h2 className="mt-2.5 text-[21px] font-semibold tracking-[-0.03em] text-[#1d1b18]">
                                                {selectedItem.title}
                                            </h2>
                                            <p className="mt-1.5 max-w-[680px] text-[13px] leading-6 text-[#70695d]">
                                                {taskContent(selectedItem)}
                                            </p>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {selectedItem.requiresConfirmation && selectedItem.draftId && (
                                                <>
                                                    <button
                                                        onClick={() => void executeAction(selectedItem, 'confirm', async () => {
                                                            await window.ipcRenderer.redclawRunner.taskConfirm({
                                                                draftId: selectedItem.draftId as string,
                                                                confirm: true,
                                                            });
                                                        })}
                                                        className="rounded-full border border-[#d2b690] bg-[#efe1ca] px-3.5 py-1.5 text-[12px] text-[#5e4730] hover:bg-[#e7d5b9]"
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
                                                        className="rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec]"
                                                    >
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'discard'
                                                            ? '处理中...'
                                                            : '丢弃草稿'}
                                                    </button>
                                                </>
                                            )}

                                            {!selectedItem.requiresConfirmation && (
                                                <>
                                                    <button
                                                        onClick={() => openEditEditor(selectedItem)}
                                                        className="inline-flex items-center rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec]"
                                                    >
                                                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                                        编辑任务
                                                    </button>
                                                    <button
                                                        onClick={() => void executeAction(selectedItem, 'run-now', () => runTaskNow(selectedItem))}
                                                        className="inline-flex items-center rounded-full border border-[#d2b690] bg-[#efe1ca] px-3.5 py-1.5 text-[12px] text-[#5e4730] hover:bg-[#e7d5b9]"
                                                    >
                                                        <Play className="mr-1.5 h-3.5 w-3.5" />
                                                        {actionState?.id === selectedItem.definitionId && actionState.action === 'run-now'
                                                            ? '执行中...'
                                                            : '立即执行'}
                                                    </button>
                                                </>
                                            )}

                                            {!selectedItem.requiresConfirmation && selectedItem.enabled && (
                                                <button
                                                    onClick={() => void executeAction(selectedItem, 'pause', () => setTaskEnabled(selectedItem, false))}
                                                    className="rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec]"
                                                >
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'pause'
                                                        ? '处理中...'
                                                        : '停用任务'}
                                                </button>
                                            )}

                                            {!selectedItem.requiresConfirmation && !selectedItem.enabled && (
                                                <button
                                                    onClick={() => void executeAction(selectedItem, 'resume', () => setTaskEnabled(selectedItem, true))}
                                                    className="rounded-full border border-[#eadfce] bg-white px-3.5 py-1.5 text-[12px] text-[#776f63] hover:bg-[#f7f3ec]"
                                                >
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'resume'
                                                        ? '处理中...'
                                                        : '恢复任务'}
                                                </button>
                                            )}

                                            {!selectedItem.requiresConfirmation && (
                                                <button
                                                    onClick={() => void deleteTask(selectedItem)}
                                                    className="inline-flex items-center rounded-full border border-[#efcdcd] bg-[#fff7f7] px-3.5 py-1.5 text-[12px] text-[#9a4f54] hover:bg-[#ffecec]"
                                                >
                                                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                                    {actionState?.id === selectedItem.definitionId && actionState.action === 'delete'
                                                        ? '删除中...'
                                                        : '删除任务'}
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                                        <DetailRow label="任务分类" value={kindLabel(selectedItem.kind)} />
                                        <DetailRow label="调度方式" value={triggerLabel(selectedItem)} />
                                        <DetailRow label="策略判定" value={policyLabel(selectedItem.policyDecision)} />
                                        <DetailRow label="任务时区" value={selectedItem.timezone || 'local'} />
                                        <DetailRow label="错过窗口策略" value={selectedItem.missedRunPolicy || 'single'} />
                                        <DetailRow label="任务指纹" value={shortFingerprint(selectedItem.definitionFingerprint)} />
                                    </div>

                                    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.9fr)]">
                                        <div className="space-y-3">
                                            <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-4">
                                                <div className="text-[13px] font-medium text-[#1d1b18]">任务内容</div>
                                                <div className="mt-3 space-y-2.5 text-[13px] leading-6 text-[#595247]">
                                                    {selectedItem.goal && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Goal</div>
                                                            <div className="mt-1">{selectedItem.goal}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.prompt && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Prompt</div>
                                                            <div className="mt-1">{selectedItem.prompt}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.objective && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Objective</div>
                                                            <div className="mt-1">{selectedItem.objective}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.stepPrompt && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Step Prompt</div>
                                                            <div className="mt-1">{selectedItem.stepPrompt}</div>
                                                        </div>
                                                    )}
                                                    {!selectedItem.goal && !selectedItem.prompt && !selectedItem.objective && !selectedItem.stepPrompt && (
                                                        <div>当前任务没有更多结构化内容。</div>
                                                    )}
                                                </div>
                                            </section>

                                            <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-4">
                                                <div className="text-[13px] font-medium text-[#1d1b18]">策略与风险</div>
                                                <div className="mt-3 space-y-2.5 text-[13px] leading-6 text-[#595247]">
                                                    <div>策略结论：{policyLabel(selectedItem.policyDecision)}</div>
                                                    {Array.isArray(selectedItem.policyWarnings) && selectedItem.policyWarnings.length > 0 && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Warnings</div>
                                                                <div className="mt-1 space-y-1">
                                                                    {selectedItem.policyWarnings.map((warning, index) => (
                                                                        <div key={`${selectedItem.definitionId}-warning-${index}`}>- {warning}</div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                    )}
                                                    {selectedItem.riskRationale && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Risk Rationale</div>
                                                            <div className="mt-1">{selectedItem.riskRationale}</div>
                                                        </div>
                                                    )}
                                                    {selectedItem.lastUpdatedReason && (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-[0.16em] text-[#a39a8e]">Last Updated Reason</div>
                                                            <div className="mt-1">{selectedItem.lastUpdatedReason}</div>
                                                        </div>
                                                    )}
                                                </div>
                                            </section>
                                        </div>

                                        <div className="space-y-3">
                                            <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-4">
                                                <div className="text-[13px] font-medium text-[#1d1b18]">调度信息</div>
                                                <div className="mt-3 space-y-2.5 text-[13px] leading-6 text-[#595247]">
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

                                            <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-4">
                                                <div className="text-[13px] font-medium text-[#1d1b18]">最近执行</div>
                                                <div className="mt-3 space-y-2.5 text-[13px] leading-6 text-[#595247]">
                                                    {selectedItem.latestExecution ? (
                                                        <>
                                                            <div>状态：{executionStatusLabel(selectedItem.latestExecution.status)}</div>
                                                            <div>计划时间：{formatDateTime(selectedItem.latestExecution.scheduledForAt)}</div>
                                                            <div>最近心跳：{formatDateTime(selectedItem.latestExecution.lastHeartbeatAt)}</div>
                                                            <div>尝试次数：{Number(selectedItem.latestExecution.attemptNo || 0)}</div>
                                                            {selectedItem.latestExecution.lastError && (
                                                                <div className="rounded-[16px] border border-[#f0d5d8] bg-[#fff4f5] px-3 py-2 text-[11px] leading-5 text-[#9a525c]">
                                                                    {selectedItem.latestExecution.lastError}
                                                                </div>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <div>当前还没有执行记录。</div>
                                                    )}
                                                </div>
                                            </section>

                                            <section className="rounded-[20px] border border-[#eee7dc] bg-[#fcfbf9] px-4 py-4">
                                                <div className="text-[13px] font-medium text-[#1d1b18]">冷却状态</div>
                                                <div className="mt-3 text-[13px] leading-6 text-[#595247]">
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
