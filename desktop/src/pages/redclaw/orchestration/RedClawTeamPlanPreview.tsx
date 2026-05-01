import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Network, UsersRound } from 'lucide-react';
import { clsx } from 'clsx';

type RedClawPlanNode = {
    id: string;
    title: string;
    agentId: string;
    skillIds: string[];
    requiredArtifacts: string[];
    outputSchema: string;
    status: string;
};

type RedClawPlan = {
    success?: boolean;
    runId?: string;
    graph?: {
        goal?: string;
        platform?: string | null;
        contentFormat?: string | null;
        nodes?: RedClawPlanNode[];
        edges?: Array<{ from: string; to: string; dependencyType: string }>;
    };
    memoryScopes?: string[];
    releasePolicy?: string;
};

const DEFAULT_GOAL = '基于最近收藏的内容，做一条适合小红书的 60 秒口播视频，并给我标题、封面文案和发布正文。';

function labelAgent(agentId: string): string {
    switch (agentId) {
        case 'research_agent':
            return 'Research';
        case 'insight_agent':
            return 'Insight';
        case 'topic_agent':
            return 'Topic';
        case 'note_architect_agent':
            return 'Note Architect';
        case 'script_agent':
            return 'Script';
        case 'copy_agent':
            return 'Copy';
        case 'storyboard_agent':
            return 'Storyboard';
        case 'visual_director_agent':
            return 'Visual Director';
        case 'media_agent':
            return 'Media';
        case 'image_agent':
            return 'Image';
        case 'layout_agent':
            return 'Layout';
        case 'editor_agent':
            return 'Editor';
        case 'publish_agent':
            return 'Publish';
        case 'compliance_agent':
            return 'Compliance';
        case 'review_agent':
            return 'Review';
        default:
            return agentId.replace(/_agent$/i, '').replace(/_/g, ' ');
    }
}

export function RedClawTeamPlanPreview({
    sessionId,
}: {
    sessionId?: string | null;
}) {
    const [open, setOpen] = useState(false);
    const [goal, setGoal] = useState(DEFAULT_GOAL);
    const [plan, setPlan] = useState<RedClawPlan | null>(null);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState('');
    const [createdSessionId, setCreatedSessionId] = useState('');
    const [runtimeTaskId, setRuntimeTaskId] = useState('');

    const nodes = useMemo(() => plan?.graph?.nodes || [], [plan]);
    const memoryScopes = useMemo(() => plan?.memoryScopes || [], [plan]);

    const loadPlan = useCallback(async () => {
        const trimmed = goal.trim();
        if (!trimmed || loading) return;
        setLoading(true);
        setError('');
        setCreatedSessionId('');
        setRuntimeTaskId('');
        try {
            const result = await window.ipcRenderer.redclawOrchestration.plan({ goal: trimmed });
            if (!result?.success) {
                setError('组队预览生成失败');
                return;
            }
            setPlan(result);
        } catch (err) {
            console.error('Failed to plan RedClaw orchestration:', err);
            setError('组队预览生成失败');
        } finally {
            setLoading(false);
        }
    }, [goal, loading]);

    const createTeam = useCallback(async () => {
        const trimmed = goal.trim();
        if (!trimmed || creating) return;
        setCreating(true);
        setError('');
        try {
            const result = await window.ipcRenderer.redclawOrchestration.createTeam({ goal: trimmed });
            if (!result?.success || !result.sessionId) {
                setError('临时团队创建失败');
                return;
            }
            setCreatedSessionId(result.sessionId);
            if (result.graph) {
                setPlan((current) => ({
                    ...(current || {}),
                    success: true,
                    runId: result.runId,
                    graph: result.graph,
                }));
            }
        } catch (err) {
            console.error('Failed to create RedClaw orchestration team:', err);
            setError('临时团队创建失败');
        } finally {
            setCreating(false);
        }
    }, [creating, goal]);

    const startRun = useCallback(async () => {
        const trimmed = goal.trim();
        if (!trimmed || starting) return;
        setStarting(true);
        setError('');
        try {
            const result = await window.ipcRenderer.redclawOrchestration.createRun({
                goal: trimmed,
                sessionId: sessionId || undefined,
            });
            if (!result?.success || !result.runtimeTaskId) {
                setError('执行任务创建失败');
                return;
            }
            setCreatedSessionId(result.sessionId || '');
            setRuntimeTaskId(result.runtimeTaskId);
            if (result.graph) {
                setPlan((current) => ({
                    ...(current || {}),
                    success: true,
                    runId: result.runId,
                    graph: result.graph,
                }));
            }
            const resumeResult = await window.ipcRenderer.tasks.resume({ taskId: result.runtimeTaskId }) as {
                success?: boolean;
                error?: string;
            };
            if (resumeResult && resumeResult.success === false) {
                setError(resumeResult.error || '执行任务启动失败');
            }
        } catch (err) {
            console.error('Failed to start RedClaw orchestration run:', err);
            setError('执行任务启动失败');
        } finally {
            setStarting(false);
        }
    }, [goal, sessionId, starting]);

    return (
        <div className="absolute right-4 top-4 z-30 w-[min(360px,calc(100%-32px))]">
            <div className="overflow-hidden rounded-[14px] border border-border bg-surface-primary/96 shadow-[0_18px_52px_rgba(15,23,42,0.16)] backdrop-blur-xl">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    className="flex h-11 w-full items-center justify-between gap-3 border-b border-border/70 px-3.5 text-left transition hover:bg-surface-secondary"
                    aria-expanded={open}
                >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
                        <UsersRound className="h-4 w-4 shrink-0 text-brand-red" />
                        <span className="truncate">RedClaw 临时团队</span>
                    </span>
                    {open ? (
                        <ChevronUp className="h-4 w-4 shrink-0 text-text-tertiary" />
                    ) : (
                        <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
                    )}
                </button>

                {open && (
                    <div className="space-y-3 p-3.5">
                        <label className="block space-y-1.5">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">任务目标</span>
                            <textarea
                                value={goal}
                                onChange={(event) => setGoal(event.target.value)}
                                rows={3}
                                className="max-h-28 min-h-[76px] w-full resize-none rounded-[10px] border border-border bg-surface-secondary px-3 py-2 text-sm leading-5 text-text-primary outline-none transition focus:border-brand-red/60 focus:ring-2 focus:ring-brand-red/10"
                            />
                        </label>

                        <button
                            type="button"
                            onClick={() => void loadPlan()}
                            disabled={loading || !goal.trim()}
                            className={clsx(
                                'inline-flex h-9 w-full items-center justify-center gap-2 rounded-[10px] px-3 text-sm font-semibold transition',
                                loading || !goal.trim()
                                    ? 'cursor-not-allowed bg-surface-secondary text-text-tertiary'
                                    : 'bg-brand-red text-white hover:bg-brand-red/90'
                            )}
                        >
                            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />}
                            生成团队预览
                        </button>

                        {nodes.length > 0 && (
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => void createTeam()}
                                    disabled={creating || starting}
                                    className={clsx(
                                        'inline-flex h-9 items-center justify-center gap-2 rounded-[10px] border px-3 text-sm font-semibold transition',
                                        creating || starting
                                            ? 'cursor-not-allowed border-border bg-surface-secondary text-text-tertiary'
                                            : 'border-border bg-surface-primary text-text-primary hover:bg-surface-secondary'
                                    )}
                                >
                                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UsersRound className="h-4 w-4" />}
                                    建队
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void startRun()}
                                    disabled={starting || creating}
                                    className={clsx(
                                        'inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-3 text-sm font-semibold transition',
                                        starting || creating
                                            ? 'cursor-not-allowed bg-surface-secondary text-text-tertiary'
                                            : 'bg-text-primary text-surface-primary hover:bg-text-secondary'
                                    )}
                                >
                                    {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />}
                                    启动
                                </button>
                            </div>
                        )}

                        {error && (
                            <div className="rounded-[10px] border border-brand-red/20 bg-brand-red/10 px-3 py-2 text-xs text-brand-red">
                                {error}
                            </div>
                        )}

                        {createdSessionId && (
                            <div className="rounded-[10px] border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
                                已创建团队：{createdSessionId}{runtimeTaskId ? ` · 任务：${runtimeTaskId}` : ''}
                            </div>
                        )}

                        {nodes.length > 0 && (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-xs text-text-tertiary">
                                    <span>{nodes.length} 个岗位</span>
                                    <span>{plan?.graph?.platform || 'auto'} · {plan?.graph?.contentFormat || 'auto'}</span>
                                </div>
                                <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                                    {nodes.map((node, index) => (
                                        <div
                                            key={node.id}
                                            className="grid grid-cols-[28px_1fr] gap-2 rounded-[10px] border border-border/70 bg-surface-secondary/80 px-2.5 py-2"
                                        >
                                            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-primary text-[11px] font-semibold text-text-secondary">
                                                {index + 1}
                                            </div>
                                            <div className="min-w-0 space-y-1">
                                                <div className="flex min-w-0 items-center justify-between gap-2">
                                                    <span className="truncate text-sm font-semibold text-text-primary">{node.title}</span>
                                                    <span className="shrink-0 rounded-full bg-surface-primary px-2 py-0.5 text-[10px] font-semibold text-text-tertiary">
                                                        {labelAgent(node.agentId)}
                                                    </span>
                                                </div>
                                                <div className="truncate text-xs text-text-tertiary">
                                                    {node.skillIds.join(' · ')}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {memoryScopes.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {memoryScopes.map((scope) => (
                                    <span key={scope} className="rounded-full border border-border bg-surface-secondary px-2 py-1 text-[11px] text-text-tertiary">
                                        {scope}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
