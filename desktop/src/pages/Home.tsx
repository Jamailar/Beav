import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArrowRight, Bell, Clapperboard, FileImage, FileText, Folder, Image, ImagePlus, Lightbulb, Loader2, MessageSquareText, PenLine, RefreshCw, Send, Sparkles, Wand2, X } from 'lucide-react';
import { ApprovalPanel } from './Approval';
import { CreatorProfilesPanel } from './CreatorProfiles';
import { resolveAssetUrl } from '../utils/pathManager';
import { formatTimestampDate, parseTimestampMs } from '../utils/time';

interface HomeProps {
    isActive?: boolean;
    onNavigateToCoverStudio?: () => void;
    onNavigateToGenerationStudio?: (mode: 'image' | 'video') => void;
    onNavigateToManuscript?: (filePath: string) => void;
    onNavigateToRedClaw?: (message: {
        content: string;
        displayContent?: string;
        sessionRouting?: 'current' | 'new';
        deliveryMode?: 'send' | 'draft';
    }) => void;
}

interface KnowledgeCountResponse {
    total?: number;
    items?: unknown[];
}

interface SubjectListResponse {
    success?: boolean;
    subjects?: unknown[];
    error?: string;
}

interface MediaListResponse {
    success?: boolean;
    assets?: unknown[];
    error?: string;
}

interface FileNode {
    name?: string;
    path?: string;
    isDirectory: boolean;
    children?: FileNode[];
    title?: string;
    draftType?: 'longform' | 'richpost' | 'video' | 'audio' | 'unknown';
    updatedAt?: number;
    summary?: string;
    richpostPreviewFileUrl?: string;
    richpostPreviewUpdatedAt?: number;
}

interface ReviewDocketStats {
    pending?: number;
    resolved?: number;
}

interface HomeStats {
    knowledge: number;
    assets: number;
    media: number;
    manuscripts: number;
    pendingApprovals: number;
}

interface RecentManuscript {
    path: string;
    name: string;
    title: string;
    draftType: 'longform' | 'richpost' | 'video' | 'audio' | 'unknown';
    updatedAt: number;
    summary: string;
    previewUrl: string;
}

const EMPTY_STATS: HomeStats = {
    knowledge: 0,
    assets: 0,
    media: 0,
    manuscripts: 0,
    pendingApprovals: 0,
};

function countFiles(nodes: FileNode[]): number {
    return nodes.reduce((total, node) => {
        if (!node?.isDirectory) return total + 1;
        return total + countFiles(Array.isArray(node.children) ? node.children : []);
    }, 0);
}

function collectManuscriptFiles(nodes: FileNode[]): FileNode[] {
    const result: FileNode[] = [];
    const visit = (items: FileNode[]) => {
        for (const item of items) {
            if (item?.isDirectory) {
                visit(Array.isArray(item.children) ? item.children : []);
            } else {
                result.push(item);
            }
        }
    };
    visit(nodes);
    return result;
}

function isInternalPackageFile(filePath: string): boolean {
    const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return false;
    return parts.slice(0, -1).some((part) => (
        part.endsWith('.redpost')
        || part.endsWith('.redarticle')
        || part.endsWith('.redvideo')
        || part.endsWith('.redaudio')
    ));
}

function stripDraftExtension(fileName: string): string {
    return fileName.replace(/\.(redpost|redarticle|redvideo|redaudio|md)$/i, '');
}

function resolveDraftTypeLabel(type: RecentManuscript['draftType']): string {
    if (type === 'richpost') return '图文';
    if (type === 'video') return '视频';
    if (type === 'audio') return '音频';
    if (type === 'longform') return '长文';
    return '稿件';
}

function formatRecentDate(updatedAt: number): string {
    const timestamp = parseTimestampMs(updatedAt);
    if (!timestamp) return '最近更新';
    const deltaMs = Date.now() - timestamp;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (deltaMs >= 0 && deltaMs < hour) return `${Math.max(1, Math.floor(deltaMs / minute))} 分钟前`;
    if (deltaMs >= 0 && deltaMs < day) return `${Math.floor(deltaMs / hour)} 小时前`;
    if (deltaMs >= 0 && deltaMs < 7 * day) return `${Math.floor(deltaMs / day)} 天前`;
    return formatTimestampDate(timestamp) || '最近更新';
}

function buildRecentManuscripts(nodes: FileNode[]): RecentManuscript[] {
    return collectManuscriptFiles(nodes)
        .filter((item) => {
            const path = String(item.path || '').trim();
            return path && !isInternalPackageFile(path);
        })
        .map((item) => {
            const path = String(item.path || '').trim();
            const name = String(item.name || path.split('/').pop() || '').trim();
            const draftType = item.draftType || 'unknown';
            return {
                path,
                name,
                title: String(item.title || '').trim() || stripDraftExtension(name) || '未命名稿件',
                draftType,
                updatedAt: Number(item.updatedAt || 0) || 0,
                summary: String(item.summary || '').trim(),
                previewUrl: item.richpostPreviewFileUrl
                    ? `${item.richpostPreviewFileUrl}${item.richpostPreviewFileUrl.includes('?') ? '&' : '?'}v=${item.richpostPreviewUpdatedAt || item.updatedAt || 0}`
                    : '',
            };
        })
        .sort((left, right) => {
            if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
            return right.path.localeCompare(left.path, 'zh-Hans-CN');
        })
        .slice(0, 4);
}

function InlineStat({
    label,
    value,
    icon: Icon,
}: {
    label: string;
    value: number;
    icon: typeof Archive;
}) {
    return (
        <div className="inline-flex items-center gap-1.5 text-[12px] text-text-tertiary">
            <Icon className="h-3.5 w-3.5" strokeWidth={1.7} />
            <span>{label}</span>
            <span className="font-semibold tabular-nums text-text-secondary">{value.toLocaleString('zh-CN')}</span>
        </div>
    );
}

function QuickAppButton({
    label,
    description,
    icon: Icon,
    tintClassName,
    onClick,
}: {
    label: string;
    description: string;
    icon: typeof Archive;
    tintClassName: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex min-h-[132px] min-w-0 flex-col justify-between rounded-xl border border-border bg-surface-primary p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent-primary/30 hover:shadow-md"
        >
            <span className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${tintClassName}`}>
                <Icon className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <span className="block">
                <span className="block text-[15px] font-semibold text-text-primary">{label}</span>
                <span className="mt-1 block text-[12px] leading-5 text-text-tertiary">{description}</span>
            </span>
            <ArrowRight className="ml-auto h-4 w-4 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-text-secondary" strokeWidth={1.8} />
        </button>
    );
}

function RecentManuscriptCard({
    manuscript,
    onOpen,
}: {
    manuscript: RecentManuscript;
    onOpen?: (filePath: string) => void;
}) {
    const Icon = manuscript.draftType === 'video'
        ? Clapperboard
        : manuscript.draftType === 'richpost'
            ? FileImage
            : FileText;
    const previewSrc = manuscript.previewUrl ? resolveAssetUrl(manuscript.previewUrl) : '';

    return (
        <button
            type="button"
            onClick={() => onOpen?.(manuscript.path)}
            className="group overflow-hidden rounded-xl border border-border bg-surface-primary text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent-primary/30 hover:shadow-md"
        >
            <div className="relative aspect-[16/7] overflow-hidden bg-surface-secondary">
                {previewSrc ? (
                    <img src={previewSrc} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                ) : (
                    <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,rgb(var(--color-accent-muted))_0%,rgb(var(--color-surface-secondary))_48%,rgb(var(--color-surface-primary))_100%)]">
                        <Icon className="h-8 w-8 text-accent-primary/65" strokeWidth={1.6} />
                    </div>
                )}
                <span className="absolute left-3 top-3 rounded-full border border-white/50 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-text-secondary shadow-sm backdrop-blur">
                    {resolveDraftTypeLabel(manuscript.draftType)}
                </span>
            </div>
            <div className="p-3">
                <div className="truncate text-[13px] font-semibold text-text-primary">{manuscript.title}</div>
                <div className="mt-1 truncate text-[11px] leading-4 text-text-tertiary">
                    {formatRecentDate(manuscript.updatedAt)}
                </div>
            </div>
        </button>
    );
}

export function Home({ isActive = true, onNavigateToCoverStudio, onNavigateToGenerationStudio, onNavigateToManuscript, onNavigateToRedClaw }: HomeProps) {
    const [stats, setStats] = useState<HomeStats>(EMPTY_STATS);
    const [recentManuscripts, setRecentManuscripts] = useState<RecentManuscript[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [approvalOpen, setApprovalOpen] = useState(false);
    const requestIdRef = useRef(0);
    const hasSnapshotRef = useRef(false);

    const loadStats = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        if (!hasSnapshotRef.current) setLoading(true);
        setError('');
        try {
            const [knowledgeResult, subjectsResult, mediaResult, manuscriptTree, approvalStats] = await Promise.all([
                window.ipcRenderer.knowledge.listPage<KnowledgeCountResponse>({ limit: 1 }),
                window.ipcRenderer.subjects.list({ limit: 500 }) as Promise<SubjectListResponse>,
                window.ipcRenderer.invoke('media:list', { limit: 500 }) as Promise<MediaListResponse>,
                window.ipcRenderer.invoke('manuscripts:list') as Promise<FileNode[]>,
                window.ipcRenderer.teamRuntime.reviewDocketStats() as Promise<ReviewDocketStats>,
            ]);
            if (requestId !== requestIdRef.current) return;
            if (subjectsResult?.success === false) throw new Error(subjectsResult.error || '资产统计失败');
            if (mediaResult?.success === false) throw new Error(mediaResult.error || '媒体统计失败');
            setStats({
                knowledge: Number.isFinite(knowledgeResult?.total)
                    ? Number(knowledgeResult.total)
                    : Array.isArray(knowledgeResult?.items) ? knowledgeResult.items.length : 0,
                assets: Array.isArray(subjectsResult?.subjects) ? subjectsResult.subjects.length : 0,
                media: Array.isArray(mediaResult?.assets) ? mediaResult.assets.length : 0,
                manuscripts: countFiles(Array.isArray(manuscriptTree) ? manuscriptTree : []),
                pendingApprovals: Number(approvalStats?.pending || 0),
            });
            setRecentManuscripts(buildRecentManuscripts(Array.isArray(manuscriptTree) ? manuscriptTree : []));
            hasSnapshotRef.current = true;
        } catch (loadError) {
            if (requestId !== requestIdRef.current) return;
            console.error('Failed to load home stats:', loadError);
            setError(loadError instanceof Error ? loadError.message : '统计加载失败');
            if (!hasSnapshotRef.current) setStats(EMPTY_STATS);
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void loadStats();
    }, [isActive, loadStats]);

    useEffect(() => {
        if (!isActive) return;
        const handleRuntimeEvent = (_event: unknown, envelope?: unknown) => {
            const eventRecord = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
            if (String(eventRecord.eventType || '') === 'runtime:review-docket-changed') {
                void loadStats();
            }
        };
        const handleDataChanged = () => void loadStats();
        window.ipcRenderer.teamRuntime.onEvent(handleRuntimeEvent);
        window.ipcRenderer.on('data:changed', handleDataChanged);
        return () => {
            window.ipcRenderer.teamRuntime.offEvent(handleRuntimeEvent);
            window.ipcRenderer.off('data:changed', handleDataChanged);
        };
    }, [isActive, loadStats]);

    const tiles = useMemo(() => [
        { key: 'knowledge', label: '知识库', value: stats.knowledge, icon: Archive },
        { key: 'assets', label: '资产', value: stats.assets, icon: Folder },
        { key: 'media', label: '媒体', value: stats.media, icon: Image },
        { key: 'manuscripts', label: '稿件', value: stats.manuscripts, icon: FileText },
    ], [stats]);

    const aiSuggestions = useMemo(() => [
        {
            label: '整理今天的选题',
            icon: Lightbulb,
            prompt: '帮我整理今天适合推进的内容选题，结合现有稿件给出优先级和下一步。',
        },
        {
            label: '续写最近稿件',
            icon: PenLine,
            prompt: recentManuscripts[0]
                ? `帮我检查并续写最近稿件《${recentManuscripts[0].title}》，先给出可执行修改建议。`
                : '帮我创建一篇新的内容稿，先从选题、结构和开头草稿开始。',
        },
        {
            label: '改成短视频脚本',
            icon: Clapperboard,
            prompt: recentManuscripts[0]
                ? `把最近稿件《${recentManuscripts[0].title}》改成一版短视频脚本，保留核心观点。`
                : '帮我把一个图文主题设计成短视频脚本结构。',
        },
        {
            label: '生成封面方向',
            icon: ImagePlus,
            prompt: '根据我的近期内容，给出 3 个封面方向，包括标题、画面元素和风格关键词。',
        },
    ], [recentManuscripts]);

    const sendAiSuggestion = useCallback((prompt: string, label?: string) => {
        onNavigateToRedClaw?.({
            content: prompt,
            displayContent: label || prompt,
            sessionRouting: 'current',
            deliveryMode: 'draft',
        });
    }, [onNavigateToRedClaw]);

    return (
        <main className="h-full min-h-0 overflow-y-auto bg-background px-6 py-5" aria-label="主页">
            <div className="mx-auto grid min-h-full w-full max-w-7xl gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-text-primary">早上好</h1>
                            <p className="mt-1 text-[13px] text-text-tertiary">你的内容工作台已就绪。</p>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 pt-1">
                            {tiles.map((tile) => (
                                <InlineStat key={tile.key} label={tile.label} value={tile.value} icon={tile.icon} />
                            ))}
                            <button
                                type="button"
                                onClick={() => setApprovalOpen(true)}
                                className="relative inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-primary px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            >
                                <Bell className="h-4 w-4" strokeWidth={1.75} />
                                审批
                                {stats.pendingApprovals > 0 && (
                                    <span className="absolute -right-2 -top-2 min-w-[20px] rounded-full bg-[#c75d43] px-1.5 py-0.5 text-center text-[10px] font-semibold leading-4 text-white">
                                        {stats.pendingApprovals > 99 ? '99+' : stats.pendingApprovals}
                                    </span>
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => void loadStats()}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                title="刷新"
                                aria-label="刷新"
                            >
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                            <AlertCircle className="h-4 w-4" />
                            {error}
                        </div>
                    )}

                    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <QuickAppButton
                            label="制作封面"
                            description="生成适合发布的视觉封面"
                            icon={ImagePlus}
                            tintClassName="bg-emerald-500/10 text-emerald-700"
                            onClick={() => onNavigateToCoverStudio?.()}
                        />
                        <QuickAppButton
                            label="生图"
                            description="用提示词生成素材图片"
                            icon={Sparkles}
                            tintClassName="bg-sky-500/10 text-sky-700"
                            onClick={() => onNavigateToGenerationStudio?.('image')}
                        />
                        <QuickAppButton
                            label="生视频"
                            description="把想法推进成视频片段"
                            icon={Clapperboard}
                            tintClassName="bg-violet-500/10 text-violet-700"
                            onClick={() => onNavigateToGenerationStudio?.('video')}
                        />
                        <QuickAppButton
                            label="找灵感"
                            description="让 AI 先给出内容方向"
                            icon={Wand2}
                            tintClassName="bg-amber-500/10 text-amber-700"
                            onClick={() => sendAiSuggestion('帮我基于当前内容资产，生成 10 个适合今天推进的选题。', '找灵感')}
                        />
                    </section>

                    <section className="flex min-h-[310px] flex-col gap-3">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-[15px] font-semibold text-text-primary">最近稿件</h2>
                            <button
                                type="button"
                                onClick={() => recentManuscripts[0]?.path && onNavigateToManuscript?.(recentManuscripts[0].path)}
                                disabled={!recentManuscripts[0]}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
                            >
                                打开最近
                                <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                            </button>
                        </div>
                        {recentManuscripts.length > 0 ? (
                            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                {recentManuscripts.map((manuscript) => (
                                    <RecentManuscriptCard
                                        key={manuscript.path}
                                        manuscript={manuscript}
                                        onOpen={onNavigateToManuscript}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-border bg-surface-primary px-4 text-center text-[13px] text-text-tertiary">
                                暂无稿件
                            </div>
                        )}
                    </section>

                    <section className="min-h-[150px]">
                        <CreatorProfilesPanel isActive={isActive} embedded />
                    </section>
                </div>

                <aside className="min-h-[520px] rounded-2xl border border-border bg-surface-primary p-5 shadow-sm xl:sticky xl:top-5 xl:self-start" aria-label="AI 建议">
                    <div className="flex items-center justify-between gap-3">
                        <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
                            <Sparkles className="h-4 w-4 text-emerald-600" strokeWidth={1.8} />
                            AI 建议
                        </div>
                        <button
                            type="button"
                            onClick={() => sendAiSuggestion('看一下我当前的内容工作台，建议今天最值得推进的 3 件事。', '今天做什么')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            title="询问 AI"
                            aria-label="询问 AI"
                        >
                            <Send className="h-4 w-4" strokeWidth={1.8} />
                        </button>
                    </div>
                    <div className="mt-7 rounded-2xl bg-[linear-gradient(135deg,rgb(var(--color-accent-muted))_0%,rgb(var(--color-surface-secondary))_100%)] p-5">
                        <h2 className="text-[17px] font-semibold leading-6 tracking-[-0.02em] text-text-primary">今天先推进哪件事？</h2>
                        <p className="mt-3 text-[13px] leading-6 text-text-secondary">从最近稿件开始，整理结构、改写脚本或生成封面方向。</p>
                    </div>
                    <div className="mt-5 divide-y divide-divider overflow-hidden rounded-xl border border-border bg-surface-primary">
                        {aiSuggestions.map((suggestion) => {
                            const Icon = suggestion.icon;
                            return (
                                <button
                                    key={suggestion.label}
                                    type="button"
                                    onClick={() => sendAiSuggestion(suggestion.prompt, suggestion.label)}
                                    className="group flex w-full items-center gap-3 px-3 py-3 text-left text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                >
                                    <Icon className="h-4 w-4 shrink-0 text-text-tertiary group-hover:text-accent-primary" strokeWidth={1.8} />
                                    <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                                    <ArrowRight className="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5" strokeWidth={1.8} />
                                </button>
                            );
                        })}
                    </div>
                    <button
                        type="button"
                        onClick={() => sendAiSuggestion('我想继续推进内容创作，请先问我 3 个必要问题，然后给出下一步。', 'Ask anything')}
                        className="mt-5 flex h-11 w-full items-center justify-between rounded-xl bg-surface-secondary px-4 text-left text-[13px] font-medium text-text-tertiary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
                    >
                        <span>Ask anything...</span>
                        <MessageSquareText className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                </aside>
            </div>

            {approvalOpen && (
                <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 px-4 py-5">
                    <div className="flex h-full max-h-[860px] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
                        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
                            <div className="text-[14px] font-semibold text-text-primary">审批</div>
                            <button
                                type="button"
                                onClick={() => {
                                    setApprovalOpen(false);
                                    void loadStats();
                                }}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                title="关闭"
                                aria-label="关闭"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1">
                            <ApprovalPanel isActive={approvalOpen} />
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}
