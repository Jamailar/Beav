import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Loader2, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

type RedClawProject = {
    id: string;
    goal: string;
    platform?: string | null;
    status: string;
    runtimeTaskId?: string | null;
    collabSessionId?: string | null;
    contentFormat?: string | null;
    artifactPath?: string | null;
    artifacts?: Array<Record<string, unknown>>;
    learningCandidates?: Array<Record<string, unknown>>;
    skillRuns?: Array<Record<string, unknown>>;
    updatedAt: string;
};

function shortId(value?: string | null): string {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > 22 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
}

function textValue(value: unknown, fallback = ''): string {
    return String(value || fallback).trim();
}

export function RedClawProjectWorkspacePanel() {
    const [open, setOpen] = useState(false);
    const [projects, setProjects] = useState<RedClawProject[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const activeProject = useMemo(() => projects[0] || null, [projects]);

    const loadProjects = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await window.ipcRenderer.redclawProjects.list();
            if (result?.success === false) {
                setError('加载创作项目失败');
                return;
            }
            setProjects(Array.isArray(result?.items) ? result.items as RedClawProject[] : []);
        } catch (err) {
            console.error('Failed to load RedClaw projects:', err);
            setError('加载创作项目失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        void loadProjects();
    }, [loadProjects, open]);

    useEffect(() => {
        const listener = () => {
            if (open) void loadProjects();
        };
        window.ipcRenderer.on('runtime:checkpoint', listener);
        window.ipcRenderer.on('runtime:task-node-changed', listener);
        return () => {
            window.ipcRenderer.off('runtime:checkpoint', listener);
            window.ipcRenderer.off('runtime:task-node-changed', listener);
        };
    }, [loadProjects, open]);

    return (
        <div className="absolute bottom-4 left-4 z-30 w-[min(420px,calc(100%-32px))]">
            <div className="overflow-hidden rounded-[14px] border border-border bg-surface-primary/96 shadow-[0_18px_52px_rgba(15,23,42,0.16)] backdrop-blur-xl">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    className="flex h-11 w-full items-center justify-between gap-3 border-b border-border/70 px-3.5 text-left transition hover:bg-surface-secondary"
                    aria-expanded={open}
                >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
                        <FileText className="h-4 w-4 shrink-0 text-brand-red" />
                        <span className="truncate">RedClaw 创作项目</span>
                    </span>
                    {open ? <ChevronDown className="h-4 w-4 text-text-tertiary" /> : <ChevronUp className="h-4 w-4 text-text-tertiary" />}
                </button>

                {open && (
                    <div className="space-y-3 p-3.5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-xs text-text-tertiary">{projects.length} 个项目</div>
                            <button
                                type="button"
                                onClick={() => void loadProjects()}
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

                        {!activeProject && !loading && (
                            <div className="rounded-[10px] border border-border bg-surface-secondary px-3 py-3 text-sm text-text-tertiary">
                                暂无 RedClaw 创作项目
                            </div>
                        )}

                        {activeProject && (
                            <div className="space-y-3">
                                <div className="rounded-[10px] border border-border bg-surface-secondary p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="line-clamp-2 text-sm font-semibold text-text-primary">{activeProject.goal}</div>
                                            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-text-tertiary">
                                                <span>{activeProject.status}</span>
                                                {activeProject.platform && <span>{activeProject.platform}</span>}
                                                {activeProject.contentFormat && <span>{activeProject.contentFormat}</span>}
                                            </div>
                                        </div>
                                        <span className="shrink-0 rounded-full bg-surface-primary px-2 py-1 text-[10px] font-semibold text-text-tertiary">
                                            {shortId(activeProject.id)}
                                        </span>
                                    </div>
                                    {activeProject.artifactPath && (
                                        <div className="mt-2 truncate rounded-[8px] bg-surface-primary px-2 py-1.5 text-[11px] text-text-tertiary">
                                            {activeProject.artifactPath}
                                        </div>
                                    )}
                                </div>

                                <div className="grid grid-cols-3 gap-2 text-center">
                                    <div className="rounded-[10px] border border-border bg-surface-secondary px-2 py-2">
                                        <div className="text-sm font-semibold text-text-primary">{activeProject.artifacts?.length || 0}</div>
                                        <div className="text-[11px] text-text-tertiary">Artifacts</div>
                                    </div>
                                    <div className="rounded-[10px] border border-border bg-surface-secondary px-2 py-2">
                                        <div className="text-sm font-semibold text-text-primary">{activeProject.learningCandidates?.length || 0}</div>
                                        <div className="text-[11px] text-text-tertiary">Learnings</div>
                                    </div>
                                    <div className="rounded-[10px] border border-border bg-surface-secondary px-2 py-2">
                                        <div className="text-sm font-semibold text-text-primary">{activeProject.skillRuns?.length || 0}</div>
                                        <div className="text-[11px] text-text-tertiary">Skills</div>
                                    </div>
                                </div>

                                {(activeProject.learningCandidates || []).slice(0, 3).map((candidate, index) => (
                                    <div key={`${activeProject.id}:learning:${index}`} className="rounded-[10px] border border-border bg-surface-secondary px-3 py-2">
                                        <div className="text-xs font-semibold text-text-primary">
                                            {textValue(candidate.statement, 'Learning candidate')}
                                        </div>
                                        <div className="mt-1 text-[11px] text-text-tertiary">
                                            {textValue(candidate.scope, 'project')} · {textValue(candidate.status, 'pending')}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
