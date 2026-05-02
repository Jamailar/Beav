import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, Bell, FileText, Folder, Image, Loader2, RefreshCw, X } from 'lucide-react';
import { ApprovalPanel } from './Approval';

interface HomeProps {
    isActive?: boolean;
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
    isDirectory: boolean;
    children?: FileNode[];
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

function StatTile({
    label,
    value,
    icon: Icon,
}: {
    label: string;
    value: number;
    icon: typeof Archive;
}) {
    return (
        <div className="rounded-lg border border-border bg-surface-primary px-4 py-4">
            <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] font-medium text-text-tertiary">{label}</div>
                <Icon className="h-4 w-4 text-text-tertiary" strokeWidth={1.7} />
            </div>
            <div className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-text-primary">
                {value.toLocaleString('zh-CN')}
            </div>
        </div>
    );
}

export function Home({ isActive = true }: HomeProps) {
    const [stats, setStats] = useState<HomeStats>(EMPTY_STATS);
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

    return (
        <main className="h-full min-h-0 overflow-y-auto bg-background px-6 py-5" aria-label="主页">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-[24px] font-semibold tracking-[-0.03em] text-text-primary">主页</h1>
                    </div>
                    <div className="flex items-center gap-2">
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

                <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {tiles.map((tile) => (
                        <StatTile key={tile.key} label={tile.label} value={tile.value} icon={tile.icon} />
                    ))}
                </section>
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
