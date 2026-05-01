import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, ChevronDown, ChevronUp, Clock3, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { clsx } from 'clsx';

type RuntimeGraphNode = {
    id?: string;
    title?: string;
    status?: string;
    summary?: string | null;
};

type RuntimeTask = {
    id: string;
    status: string;
    goal?: string | null;
    currentNode?: string | null;
    graph?: RuntimeGraphNode[];
    artifacts?: unknown[];
    checkpoints?: unknown[];
    metadata?: Record<string, unknown> | null;
    updatedAt?: number;
    createdAt?: number;
};

function taskMetadata(task: RuntimeTask): Record<string, unknown> {
    return task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
}

function isRedClawTask(task: RuntimeTask): boolean {
    const metadata = taskMetadata(task);
    return metadata.source === 'redclaw-orchestrator' || metadata.runtimeMode === 'redclaw_orchestration';
}

function shortId(value?: string | null): string {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function statusIcon(status: string) {
    if (status === 'completed') return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (status === 'failed' || status === 'cancelled') return <XCircle className="h-4 w-4 text-brand-red" />;
    if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-brand-red" />;
    return <Clock3 className="h-4 w-4 text-text-tertiary" />;
}

export function RedClawRunTimelinePanel() {
    const [open, setOpen] = useState(false);
    const [tasks, setTasks] = useState<RuntimeTask[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const redclawTasks = useMemo(
        () => tasks.filter(isRedClawTask).slice(0, 5),
        [tasks],
    );

    const loadTasks = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await window.ipcRenderer.tasks.list({ limit: 40 });
            setTasks(Array.isArray(result) ? result as RuntimeTask[] : []);
        } catch (err) {
            console.error('Failed to load RedClaw runtime tasks:', err);
            setError('加载团队运行状态失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        void loadTasks();
    }, [loadTasks, open]);

    useEffect(() => {
        const listener = () => {
            if (open) void loadTasks();
        };
        window.ipcRenderer.on('runtime:checkpoint', listener);
        window.ipcRenderer.on('runtime:task-node-changed', listener);
        window.ipcRenderer.on('runtime:subagent-started', listener);
        window.ipcRenderer.on('runtime:subagent-finished', listener);
        return () => {
            window.ipcRenderer.off('runtime:checkpoint', listener);
            window.ipcRenderer.off('runtime:task-node-changed', listener);
            window.ipcRenderer.off('runtime:subagent-started', listener);
            window.ipcRenderer.off('runtime:subagent-finished', listener);
        };
    }, [loadTasks, open]);

    return (
        <div className="absolute bottom-4 right-4 z-30 w-[min(420px,calc(100%-32px))]">
            <div className="overflow-hidden rounded-[14px] border border-border bg-surface-primary/96 shadow-[0_18px_52px_rgba(15,23,42,0.16)] backdrop-blur-xl">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    className="flex h-11 w-full items-center justify-between gap-3 border-b border-border/70 px-3.5 text-left transition hover:bg-surface-secondary"
                    aria-expanded={open}
                >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
                        <Activity className="h-4 w-4 shrink-0 text-brand-red" />
                        <span className="truncate">RedClaw 团队运行</span>
                    </span>
                    {open ? <ChevronDown className="h-4 w-4 text-text-tertiary" /> : <ChevronUp className="h-4 w-4 text-text-tertiary" />}
                </button>

                {open && (
                    <div className="space-y-3 p-3.5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-xs text-text-tertiary">{redclawTasks.length} 条团队任务</div>
                            <button
                                type="button"
                                onClick={() => void loadTasks()}
                                disabled={loading}
                                className={clsx(
                                    'inline-flex h-8 items-center gap-2 rounded-[9px] border border-border px-2.5 text-xs font-semibold transition',
                                    loading ? 'cursor-not-allowed text-text-tertiary' : 'text-text-secondary hover:bg-surface-secondary'
                                )}
                            >
                                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                刷新
                            </button>
                        </div>

                        {error && (
                            <div className="rounded-[10px] border border-brand-red/20 bg-brand-red/10 px-3 py-2 text-xs text-brand-red">
                                {error}
                            </div>
                        )}

                        {redclawTasks.length === 0 && !loading && (
                            <div className="rounded-[10px] border border-border bg-surface-secondary px-3 py-3 text-sm text-text-tertiary">
                                暂无团队运行记录
                            </div>
                        )}

                        {redclawTasks.map((task) => {
                            const metadata = taskMetadata(task);
                            const currentNode = String(task.currentNode || metadata.currentNode || '').trim();
                            const graph = Array.isArray(task.graph) ? task.graph : [];
                            const activeNode = graph.find((node) => node.id === currentNode) || graph.find((node) => node.status === 'running') || null;
                            return (
                                <div key={task.id} className="rounded-[10px] border border-border bg-surface-secondary p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                {statusIcon(task.status)}
                                                <span className="text-xs font-semibold uppercase text-text-secondary">{task.status}</span>
                                            </div>
                                            <div className="mt-1 line-clamp-2 text-sm font-semibold text-text-primary">
                                                {task.goal || metadata.goal as string || 'RedClaw creative run'}
                                            </div>
                                        </div>
                                        <span className="shrink-0 rounded-full bg-surface-primary px-2 py-1 text-[10px] font-semibold text-text-tertiary">
                                            {shortId(task.id)}
                                        </span>
                                    </div>

                                    <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                                        <div className="rounded-[8px] bg-surface-primary px-2 py-1.5">
                                            <div className="text-xs font-semibold text-text-primary">{currentNode || activeNode?.id || '-'}</div>
                                            <div className="text-[10px] text-text-tertiary">Node</div>
                                        </div>
                                        <div className="rounded-[8px] bg-surface-primary px-2 py-1.5">
                                            <div className="text-xs font-semibold text-text-primary">{task.artifacts?.length || 0}</div>
                                            <div className="text-[10px] text-text-tertiary">Artifacts</div>
                                        </div>
                                        <div className="rounded-[8px] bg-surface-primary px-2 py-1.5">
                                            <div className="text-xs font-semibold text-text-primary">{task.checkpoints?.length || 0}</div>
                                            <div className="text-[10px] text-text-tertiary">Checks</div>
                                        </div>
                                    </div>

                                    {activeNode?.summary && (
                                        <div className="mt-2 line-clamp-2 text-xs text-text-tertiary">
                                            {activeNode.summary}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
