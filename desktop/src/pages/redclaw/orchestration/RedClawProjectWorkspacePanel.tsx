import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Clipboard, FileText, Loader2, RefreshCw, Save } from 'lucide-react';
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
    metadata?: Record<string, unknown> | null;
    updatedAt: string;
};

type SectionDefinition = {
    id: 'brief' | 'script' | 'storyboard' | 'media' | 'publish' | 'review';
    label: string;
    roles: string[];
    fallback: string;
};

const SECTION_DEFINITIONS: SectionDefinition[] = [
    { id: 'brief', label: 'Brief', roles: ['research_agent', 'insight_agent'], fallback: '暂无 brief。' },
    { id: 'script', label: 'Script', roles: ['script_agent'], fallback: '暂无脚本。' },
    { id: 'storyboard', label: 'Storyboard', roles: ['storyboard_agent'], fallback: '暂无分镜。' },
    { id: 'media', label: 'Media', roles: ['media_agent'], fallback: '暂无媒体计划。' },
    { id: 'publish', label: 'Publish', roles: ['publish_agent'], fallback: '暂无发布包。' },
    { id: 'review', label: 'Review', roles: ['editor_agent', 'review_agent', 'reviewer'], fallback: '暂无质检结果。' },
];

function shortId(value?: string | null): string {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > 22 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
}

function textValue(value: unknown, fallback = ''): string {
    return String(value || fallback).trim();
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
}

function projectOutputs(project: RedClawProject | null): Array<Record<string, unknown>> {
    if (!project) return [];
    const metadata = objectValue(project.metadata);
    const fromMetadata = arrayValue(metadata.orchestrationOutputs);
    if (fromMetadata.length > 0) return fromMetadata;
    return (project.artifacts || [])
        .flatMap((artifact) => {
            const payload = objectValue(artifact.payload);
            return arrayValue(payload.outputs);
        });
}

function sectionDraftsFromProject(project: RedClawProject | null): Record<string, string> {
    const metadata = objectValue(project?.metadata);
    const drafts = objectValue(metadata.sectionDrafts);
    return Object.fromEntries(
        Object.entries(drafts).map(([key, value]) => [
            key,
            textValue(objectValue(value).content),
        ])
    );
}

function sectionGeneratedContent(project: RedClawProject | null, section: SectionDefinition): string {
    const outputs = projectOutputs(project).filter((output) => section.roles.includes(textValue(output.roleId)));
    const blocks = outputs.map((output) => {
        const role = textValue(output.roleId, 'agent');
        const artifact = textValue(output.artifact);
        const summary = textValue(output.summary);
        const issues = arrayValue(output.issues);
        const learningCandidates = arrayValue(output.learningCandidates);
        const lines = [`## ${role}`];
        if (artifact) {
            lines.push('', artifact);
        } else if (summary) {
            lines.push('', summary);
        }
        if (issues.length > 0) {
            lines.push('', 'Issues:', JSON.stringify(issues, null, 2));
        }
        if (learningCandidates.length > 0) {
            lines.push('', 'Learning candidates:', JSON.stringify(learningCandidates, null, 2));
        }
        return lines.join('\n');
    });
    return blocks.join('\n\n').trim() || section.fallback;
}

export function RedClawProjectWorkspacePanel() {
    const [open, setOpen] = useState(false);
    const [projects, setProjects] = useState<RedClawProject[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [activeSectionId, setActiveSectionId] = useState<SectionDefinition['id']>('brief');
    const [sectionDrafts, setSectionDrafts] = useState<Record<string, string>>({});
    const [savingSectionId, setSavingSectionId] = useState('');
    const [copiedSectionId, setCopiedSectionId] = useState('');

    const activeProject = useMemo(() => projects[0] || null, [projects]);
    const activeSection = useMemo(
        () => SECTION_DEFINITIONS.find((section) => section.id === activeSectionId) || SECTION_DEFINITIONS[0],
        [activeSectionId],
    );
    const generatedSectionContent = useMemo(
        () => sectionGeneratedContent(activeProject, activeSection),
        [activeProject, activeSection],
    );
    const activeSectionContent = sectionDrafts[activeSection.id] ?? generatedSectionContent;

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

    const updateLearningCandidate = useCallback(async (
        candidateId: string,
        status: 'accepted' | 'rejected',
    ) => {
        if (!activeProject || !candidateId) return;
        setError('');
        try {
            const result = await window.ipcRenderer.redclawProjects.updateLearningCandidate({
                projectId: activeProject.id,
                candidateId,
                status,
            });
            if (!result?.success) {
                setError(result?.error || '学习候选更新失败');
                return;
            }
            await loadProjects();
        } catch (err) {
            console.error('Failed to update RedClaw learning candidate:', err);
            setError('学习候选更新失败');
        }
    }, [activeProject, loadProjects]);

    const saveSectionDraft = useCallback(async () => {
        if (!activeProject) return;
        const content = sectionDrafts[activeSection.id] ?? generatedSectionContent;
        setSavingSectionId(activeSection.id);
        setError('');
        try {
            const result = await window.ipcRenderer.redclawProjects.updateSection({
                projectId: activeProject.id,
                sectionId: activeSection.id,
                content,
            });
            if (!result?.success) {
                setError(result?.error || '保存分区草稿失败');
                return;
            }
            await loadProjects();
        } catch (err) {
            console.error('Failed to save RedClaw section draft:', err);
            setError('保存分区草稿失败');
        } finally {
            setSavingSectionId('');
        }
    }, [activeProject, activeSection.id, generatedSectionContent, loadProjects, sectionDrafts]);

    const copySectionDraft = useCallback(async () => {
        const content = sectionDrafts[activeSection.id] ?? generatedSectionContent;
        if (!content) return;
        await navigator.clipboard.writeText(content);
        setCopiedSectionId(activeSection.id);
        window.setTimeout(() => setCopiedSectionId(''), 1200);
    }, [activeSection.id, generatedSectionContent, sectionDrafts]);

    useEffect(() => {
        setSectionDrafts(sectionDraftsFromProject(activeProject));
    }, [activeProject?.id, activeProject?.updatedAt]);

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
        <div className="absolute bottom-4 left-4 z-30 w-[min(520px,calc(100%-32px))]">
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

                                <div className="space-y-2">
                                    <div className="flex gap-1 overflow-x-auto pb-1">
                                        {SECTION_DEFINITIONS.map((section) => (
                                            <button
                                                key={section.id}
                                                type="button"
                                                onClick={() => setActiveSectionId(section.id)}
                                                className={clsx(
                                                    'h-8 shrink-0 rounded-[9px] border px-2.5 text-xs font-semibold transition',
                                                    section.id === activeSection.id
                                                        ? 'border-brand-red/30 bg-brand-red/10 text-brand-red'
                                                        : 'border-border bg-surface-secondary text-text-tertiary hover:text-text-secondary'
                                                )}
                                            >
                                                {section.label}
                                            </button>
                                        ))}
                                    </div>
                                    <textarea
                                        value={activeSectionContent}
                                        onChange={(event) => setSectionDrafts((current) => ({
                                            ...current,
                                            [activeSection.id]: event.target.value,
                                        }))}
                                        className="min-h-[220px] w-full resize-y rounded-[10px] border border-border bg-surface-secondary px-3 py-2 font-mono text-xs leading-5 text-text-primary outline-none transition focus:border-brand-red/60 focus:ring-2 focus:ring-brand-red/10"
                                    />
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="truncate text-[11px] text-text-tertiary">
                                            {activeSection.label} · 可编辑草稿
                                        </div>
                                        <div className="flex gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => void copySectionDraft()}
                                                className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-border bg-surface-primary px-2.5 text-xs font-semibold text-text-secondary transition hover:bg-surface-secondary"
                                            >
                                                {copiedSectionId === activeSection.id ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                                                复制
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void saveSectionDraft()}
                                                disabled={savingSectionId === activeSection.id}
                                                className={clsx(
                                                    'inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-xs font-semibold transition',
                                                    savingSectionId === activeSection.id
                                                        ? 'cursor-not-allowed bg-surface-secondary text-text-tertiary'
                                                        : 'bg-brand-red text-white hover:bg-brand-red/90'
                                                )}
                                            >
                                                {savingSectionId === activeSection.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                                保存
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {(activeProject.learningCandidates || []).slice(0, 3).map((candidate, index) => (
                                    <div key={`${activeProject.id}:learning:${index}`} className="rounded-[10px] border border-border bg-surface-secondary px-3 py-2">
                                        <div className="text-xs font-semibold text-text-primary">
                                            {textValue(candidate.statement, 'Learning candidate')}
                                        </div>
                                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
                                            <span>{textValue(candidate.scope, 'project')} · {textValue(candidate.status, 'pending')}</span>
                                            {textValue(candidate.status, 'pending') === 'pending' && (
                                                <span className="inline-flex gap-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => void updateLearningCandidate(textValue(candidate.id), 'accepted')}
                                                        className="rounded-full bg-surface-primary px-2 py-0.5 font-semibold text-text-secondary transition hover:text-brand-red"
                                                    >
                                                        接受
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => void updateLearningCandidate(textValue(candidate.id), 'rejected')}
                                                        className="rounded-full bg-surface-primary px-2 py-0.5 font-semibold text-text-tertiary transition hover:text-text-secondary"
                                                    >
                                                        忽略
                                                    </button>
                                                </span>
                                            )}
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
