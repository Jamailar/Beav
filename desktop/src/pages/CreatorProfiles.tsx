import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import {
    BookOpenText,
    Download,
    FileText,
    Image,
    Link2,
    Loader2,
    MessageCircle,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    UserRound,
    X,
} from 'lucide-react';
import { appConfirm } from '../utils/appDialogs';
import { formatTimestampDate } from '../utils/time';
import type { ClipboardCaptureCandidate, ServerCaptureJob } from '../features/capture/captureTypes';
import {
    captureResponseError,
    createServerCaptureJob,
    ingestServerCaptureJobEntries,
    pollServerCaptureJob,
    serverCaptureEntryCount,
} from '../features/capture/serverCaptureClient';
import { importCaptureJobToAccount } from '../features/accounts/accountCaptureImport';
import { resolveAssetUrl } from '../utils/pathManager';

interface AccountSummary {
    id: string;
    platform?: string;
    platformUserId?: string;
    username?: string;
    homepageUrl?: string;
    avatarUrl?: string;
    postCount?: number;
    commentCount?: number;
    mediaCount?: number;
    followerCount?: number;
    totalPostCount?: number;
    totalLikeCount?: number;
    lastImportedAt?: string;
    lastLearnedAt?: string;
    updatedAt?: string;
}

interface AccountPost {
    id: string;
    title?: string;
    content?: string;
    url?: string;
    publishedAt?: string;
    capturedAt?: string;
    updatedAt?: string;
    platform?: string;
    kind?: string;
    stats?: Record<string, unknown>;
    tags?: unknown;
    media?: AccountMedia[];
}

interface AccountMedia {
    id?: string;
    mediaId?: string;
    postId?: string;
    platform?: string;
    kind?: string;
    url?: string;
    localPath?: string;
    index?: number;
    capturedAt?: string;
    updatedAt?: string;
}

interface AccountComment {
    id: string;
    postId?: string;
    author?: string;
    text?: string;
    likes?: number;
    replies?: number;
    createdAt?: string;
    capturedAt?: string;
    updatedAt?: string;
}

interface AccountDetail {
    success?: boolean;
    account?: AccountSummary;
    profile?: Record<string, unknown>;
    posts?: AccountPost[];
    media?: AccountMedia[];
    comments?: AccountComment[];
    learningState?: {
        status?: string;
        pendingVideoTranscriptions?: number;
        failedVideoTranscriptions?: number;
        updatedAt?: string;
    };
    captureRequest?: {
        status?: string;
        requestedPostLimit?: number;
        importedPostCount?: number;
        lastError?: string;
        updatedAt?: string;
    };
}

interface AccountCreateFromHomepageResponse {
    success?: boolean;
    account?: AccountSummary;
    session?: {
        id?: string;
        status?: string;
    };
    homepageUrl?: string;
    platform?: string;
    limit?: number;
    nextAction?: {
        type?: string;
    } | null;
    error?: string;
}

type GalleryMode = 'posts' | 'media' | 'comments';
type AccountCreateFlowStatus = 'idle' | 'creating' | 'capturing' | 'importing' | 'completed' | 'failed';

interface CreatorProfilesPanelProps {
    isActive?: boolean;
    embedded?: boolean;
}

type AccountHomepagePlatformId = 'xiaohongshu' | 'douyin' | 'bilibili' | 'tiktok';

interface AccountHomepagePlatformMatch {
    id: AccountHomepagePlatformId;
    name: string;
    validHomepage: boolean;
    hint: string;
    autoCapture: boolean;
}

const PLATFORM_LABELS: Record<string, string> = {
    xiaohongshu: '小红书',
    douyin: '抖音',
    bilibili: 'Bilibili',
    wechat: '公众号',
    youtube: 'YouTube',
    kuaishou: '快手',
    tiktok: 'TikTok',
    instagram: 'Instagram',
    x: 'X',
};

function platformLabel(platform?: string): string {
    const key = String(platform || '').trim();
    return PLATFORM_LABELS[key] || key || '平台';
}

function numberText(value: unknown): string {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toLocaleString() : '0';
}

function accountTotalPostCount(account?: AccountSummary | null, posts: AccountPost[] = []): unknown {
    return account?.totalPostCount || account?.postCount || posts.length;
}

function accountTotalLikeCount(account?: AccountSummary | null, posts: AccountPost[] = []): unknown {
    return account?.totalLikeCount || posts.reduce((sum, post) => sum + postLikeCount(post), 0);
}

function postLikeCount(post: AccountPost): number {
    const stats = post.stats || {};
    const value = stats.likes ?? stats.likeCount ?? stats.likedCount;
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
}

function excerpt(value?: string, limit = 120): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
}

function titleFromPost(post: AccountPost): string {
    return String(post.title || '').trim() || excerpt(post.content, 32) || '未命名内容';
}

function postCover(post: AccountPost): string {
    const media = Array.isArray(post.media) ? post.media : [];
    const image = media.find((item) => /image|cover/i.test(String(item.kind || '')) && String(item.url || item.localPath || '').trim());
    return String(image?.url || image?.localPath || '').trim();
}

function postMediaSource(item: AccountMedia): string {
    return String(item.url || item.localPath || '').trim();
}

function isImageMedia(item: AccountMedia): boolean {
    const source = postMediaSource(item);
    return /image|cover/i.test(String(item.kind || '')) || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(source);
}

function isVideoMedia(item: AccountMedia): boolean {
    const source = postMediaSource(item);
    return /video/i.test(String(item.kind || '')) || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(source);
}

function postKindLabel(post: AccountPost): string {
    const kind = String(post.kind || '').toLowerCase();
    if (kind.includes('video')) return '小红书视频';
    return platformLabel(post.platform) === '小红书' || kind.includes('xhs') ? '小红书图文' : '内容';
}

function postStatsEntries(post: AccountPost): Array<[string, unknown]> {
    const stats = post.stats && typeof post.stats === 'object' ? post.stats : {};
    const candidates: Array<[string, unknown]> = [
        ['赞', stats.likes ?? stats.likeCount ?? stats.likedCount],
        ['收藏', stats.collects ?? stats.collectCount ?? stats.favoriteCount],
        ['评论', stats.comments ?? stats.commentCount],
        ['分享', stats.shares ?? stats.shareCount],
    ];
    return candidates.filter(([, value]) => value !== undefined && value !== null && value !== '');
}

function learningStatusText(state?: AccountDetail['learningState']): string {
    const status = String(state?.status || '').trim();
    if (status === 'waiting_transcription') {
        return `等待 ${numberText(state?.pendingVideoTranscriptions)} 个视频转录`;
    }
    if (status === 'transcription_failed') {
        return `${numberText(state?.failedVideoTranscriptions)} 个视频转录失败`;
    }
    if (status === 'completed') return '学习完成';
    return '等待导入';
}

function parseHomepageUrl(value: string): URL | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        return null;
    }
}

function detectHomepagePlatform(value: string): AccountHomepagePlatformMatch | null {
    const parsed = parseHomepageUrl(value);
    if (!parsed) return null;
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (host.includes('xiaohongshu.com') || host.includes('rednote.com')) {
        return {
            id: 'xiaohongshu',
            name: '小红书',
            validHomepage: parts[0] === 'user' && parts[1] === 'profile' && Boolean(parts[2]),
            hint: '小红书主页',
            autoCapture: true,
        };
    }
    if (host.includes('douyin.com')) {
        return {
            id: 'douyin',
            name: '抖音',
            validHomepage: parts[0] === 'user' && Boolean(parts[1]),
            hint: '抖音主页',
            autoCapture: false,
        };
    }
    if (host === 'space.bilibili.com' || host.endsWith('.space.bilibili.com')) {
        return {
            id: 'bilibili',
            name: 'Bilibili',
            validHomepage: Boolean(parts[0]),
            hint: 'Bilibili 主页',
            autoCapture: false,
        };
    }
    if (host.includes('tiktok.com')) {
        return {
            id: 'tiktok',
            name: 'TikTok',
            validHomepage: Boolean(parts[0]?.startsWith('@') && parts[0].length > 1 && parts[1] !== 'video'),
            hint: 'TikTok 主页',
            autoCapture: false,
        };
    }
    return null;
}

function PlatformIcon({ platform }: { platform: AccountHomepagePlatformId }) {
    if (platform === 'xiaohongshu') {
        return <img src="/ecommerce-platform-icons/xiaohongshu-shop.svg" alt="" className="h-5 w-5 object-contain" />;
    }
    if (platform === 'douyin') {
        return <img src="/ecommerce-platform-icons/douyin-shop.png" alt="" className="h-5 w-5 object-contain" />;
    }
    if (platform === 'bilibili') {
        return <span className="text-[11px] font-bold text-[#fb7299]">B</span>;
    }
    if (platform === 'tiktok') {
        return <span className="text-[13px] font-bold text-text-primary">♪</span>;
    }
    return <Link2 className="h-4 w-4" />;
}

function buildAccountCaptureCandidate(homepageUrl: string, detected: AccountHomepagePlatformMatch): ClipboardCaptureCandidate | null {
    const parsed = parseHomepageUrl(homepageUrl);
    if (!parsed || detected.id !== 'xiaohongshu') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const platformUserId = parts[0] === 'user' && parts[1] === 'profile' ? parts[2] || '' : '';
    if (!platformUserId) return null;
    parsed.protocol = 'https:';
    parsed.hash = '';
    parsed.search = '';
    const canonicalUrl = parsed.toString();
    return {
        id: `settings-account:xhs-profile:${platformUserId}`,
        kind: 'xhs-profile',
        platform: 'xiaohongshu',
        rawText: homepageUrl,
        rawUrl: canonicalUrl,
        canonicalUrl,
        externalId: platformUserId,
        confidence: 'exact',
        source: 'paste',
        detectedAt: new Date().toISOString(),
    };
}

export function CreatorProfilesPanel({ isActive = true, embedded = false }: CreatorProfilesPanelProps) {
    const [accounts, setAccounts] = useState<AccountSummary[]>([]);
    const [selectedAccountId, setSelectedAccountId] = useState('');
    const [detail, setDetail] = useState<AccountDetail | null>(null);
    const [detailModalOpen, setDetailModalOpen] = useState(false);
    const [selectedPost, setSelectedPost] = useState<AccountPost | null>(null);
    const [query, setQuery] = useState('');
    const [galleryMode, setGalleryMode] = useState<GalleryMode>('posts');
    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [createHomepageUrl, setCreateHomepageUrl] = useState('');
    const [creatingAccount, setCreatingAccount] = useState(false);
    const [createFlowStatus, setCreateFlowStatus] = useState<AccountCreateFlowStatus>('idle');
    const [createFlowCaptureStatus, setCreateFlowCaptureStatus] = useState('');
    const [createFlowStats, setCreateFlowStats] = useState({ posts: 0, media: 0, comments: 0, requested: 20 });
    const [deletingAccountId, setDeletingAccountId] = useState('');
    const [error, setError] = useState('');
    const loadAccountsRequestRef = useRef(0);
    const loadDetailRequestRef = useRef(0);
    const hasLoadedAccountsRef = useRef(false);

    const selectedAccount = useMemo(
        () => accounts.find((account) => account.id === selectedAccountId) || null,
        [accounts, selectedAccountId],
    );

    const loadAccounts = useCallback(async () => {
        const requestId = loadAccountsRequestRef.current + 1;
        loadAccountsRequestRef.current = requestId;
        if (!hasLoadedAccountsRef.current) {
            setLoadingAccounts(true);
        }
        setError('');
        try {
            const result = await window.ipcRenderer.accounts.list() as { accounts?: AccountSummary[] };
            if (requestId !== loadAccountsRequestRef.current) return;
            const list = Array.isArray(result?.accounts) ? result.accounts : [];
            setAccounts(list);
            hasLoadedAccountsRef.current = true;
            setSelectedAccountId((current) => {
                if (current && list.some((account) => account.id === current)) return current;
                return embedded ? '' : list[0]?.id || '';
            });
        } catch (loadError) {
            if (requestId !== loadAccountsRequestRef.current) return;
            console.error('Failed to load creator profiles:', loadError);
            setError(loadError instanceof Error ? loadError.message : '加载账号档案失败');
        } finally {
            if (requestId === loadAccountsRequestRef.current) {
                setLoadingAccounts(false);
            }
        }
    }, [embedded]);

    const loadDetail = useCallback(async (accountId: string) => {
        if (!accountId) {
            setDetail(null);
            return;
        }
        const requestId = loadDetailRequestRef.current + 1;
        loadDetailRequestRef.current = requestId;
        setLoadingDetail(true);
        setError('');
        try {
            const result = await window.ipcRenderer.accounts.get({ accountId }) as AccountDetail;
            if (requestId !== loadDetailRequestRef.current) return;
            setDetail(result || null);
        } catch (loadError) {
            if (requestId !== loadDetailRequestRef.current) return;
            console.error('Failed to load account detail:', loadError);
            setError(loadError instanceof Error ? loadError.message : '加载账号内容失败');
            setDetail(null);
        } finally {
            if (requestId === loadDetailRequestRef.current) {
                setLoadingDetail(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void loadAccounts();
    }, [isActive, loadAccounts]);

    useEffect(() => {
        if (!isActive) return;
        void loadDetail(selectedAccountId);
    }, [isActive, loadDetail, selectedAccountId]);

    useEffect(() => {
        setSelectedPost(null);
    }, [selectedAccountId]);

    const posts = detail?.posts || [];
    const media = detail?.media || [];
    const comments = detail?.comments || [];
    const compact = embedded;
    const detectedHomepagePlatform = useMemo(
        () => detectHomepagePlatform(createHomepageUrl),
        [createHomepageUrl],
    );

    const openCreateDialog = useCallback(() => {
        setCreateHomepageUrl('');
        setCreateFlowStatus('idle');
        setCreateFlowCaptureStatus('');
        setCreateFlowStats({ posts: 0, media: 0, comments: 0, requested: 20 });
        setError('');
        setCreateDialogOpen(true);
    }, []);

    const closeCreateDialog = useCallback(() => {
        setCreateDialogOpen(false);
        setCreateHomepageUrl('');
        setCreateFlowStatus('idle');
        setCreateFlowCaptureStatus('');
        setCreateFlowStats({ posts: 0, media: 0, comments: 0, requested: 20 });
        setError('');
    }, []);

    const handleCreateAccount = useCallback(async () => {
        const homepageUrl = createHomepageUrl.trim();
        if (!homepageUrl || creatingAccount) return;
        if (!detectedHomepagePlatform?.validHomepage) {
            setError(detectedHomepagePlatform ? `请输入${detectedHomepagePlatform.hint}` : '暂不支持这个平台主页');
            return;
        }
        setCreatingAccount(true);
        setCreateFlowStatus('creating');
        setCreateFlowCaptureStatus('创建账号档案');
        setCreateFlowStats({ posts: 0, media: 0, comments: 0, requested: 20 });
        setError('');
        let createdSessionId = '';
        try {
            let pendingJobs: Array<{ id: string; initialJob: ServerCaptureJob | null }> = [];
            if (detectedHomepagePlatform.autoCapture) {
                const candidate = buildAccountCaptureCandidate(homepageUrl, detectedHomepagePlatform);
                if (!candidate) {
                    throw new Error('无法识别小红书主页 ID');
                }
                setCreateFlowStatus('capturing');
                setCreateFlowCaptureStatus('创建小红书采集任务');
                const captureResponses = await Promise.all([
                    createServerCaptureJob(candidate, {
                        includeComments: true,
                        limit: 20,
                        maxItems: 20,
                        collectionMode: 'recent',
                        clientRequestIdSuffix: 'settings-account-recent-20',
                    }),
                    createServerCaptureJob(candidate, {
                        includeComments: true,
                        limit: 5,
                        maxItems: 5,
                        collectionMode: 'top_liked',
                        sortBy: 'likes',
                        clientRequestIdSuffix: 'settings-account-top-liked-5',
                    }),
                ]);
                pendingJobs = captureResponses
                    .filter((response) => response.success && (response.job?.id || response.jobId))
                    .map((response) => ({
                        id: String(response.job?.id || response.jobId || ''),
                        initialJob: response.job || null,
                    }))
                    .filter((item) => item.id);
                const failedCaptureResponse = captureResponses.find((response) => !response.success);
                if (pendingJobs.length === 0 && failedCaptureResponse) {
                    throw captureResponseError(failedCaptureResponse, '小红书采集任务创建失败');
                }
                setCreateFlowCaptureStatus(pendingJobs[0]?.initialJob?.progress?.message || '小红书采集任务已创建');
            }
            setCreateFlowStatus('creating');
            setCreateFlowCaptureStatus('创建账号档案');
            const result = await window.ipcRenderer.accounts.createFromHomepage<AccountCreateFromHomepageResponse>({
                homepageUrl,
                limit: 20,
            });
            if (result?.success === false) {
                throw new Error(result.error || '创建账号档案失败');
            }
            const targetUrl = String(result?.homepageUrl || homepageUrl).trim();
            const platform = String(result?.platform || detectedHomepagePlatform.id).trim();
            createdSessionId = String(result?.session?.id || '').trim();
            await loadAccounts();
            const nextAccountId = String(result?.account?.id || '').trim();
            if (nextAccountId) {
                setSelectedAccountId(nextAccountId);
                void loadDetail(nextAccountId);
            }
            if (targetUrl && detectedHomepagePlatform.autoCapture && nextAccountId && pendingJobs.length > 0) {
                setCreateFlowStatus('capturing');
                setCreateFlowCaptureStatus(pendingJobs[0]?.initialJob?.progress?.message || '小红书采集任务处理中');
                const knowledgeImportedEntryKeys = new Set<string>();
                const accountImportedEntryKeys = new Set<string>();
                const importedStats = { posts: 0, media: 0, comments: 0 };
                let importQueue = Promise.resolve();
                const importAvailableEntries = async (nextJob: ServerCaptureJob) => {
                    const capturedEntries = serverCaptureEntryCount(nextJob);
                    if (capturedEntries <= 0) return;
                    await ingestServerCaptureJobEntries(nextJob, {
                        seenEntryKeys: knowledgeImportedEntryKeys,
                    });
                    const imported = await importCaptureJobToAccount({
                        accountId: nextAccountId,
                        sessionId: createdSessionId,
                        platform,
                        job: nextJob,
                        seenEntryKeys: accountImportedEntryKeys,
                        completeSession: false,
                    });
                    importedStats.posts += imported.posts.length;
                    importedStats.media += imported.media.length;
                    importedStats.comments += imported.comments.length;
                    setCreateFlowStats({
                        posts: Math.max(importedStats.posts, capturedEntries),
                        media: importedStats.media,
                        comments: importedStats.comments,
                        requested: Math.max(Number(result?.limit || 20), capturedEntries),
                    });
                };
                const enqueueImport = (job: ServerCaptureJob) => {
                    importQueue = importQueue.then(() => importAvailableEntries(job));
                    return importQueue;
                };
                const jobs = await Promise.all(pendingJobs.map(async ({ id, initialJob }) => {
                    if (initialJob) await enqueueImport(initialJob);
                    const completedJob = await pollServerCaptureJob(id, async (nextJob) => {
                        setCreateFlowCaptureStatus(nextJob.progress?.message || '小红书采集任务处理中');
                        await enqueueImport(nextJob);
                    });
                    await enqueueImport(completedJob);
                    return completedJob;
                }));
                setCreateFlowStatus('importing');
                setCreateFlowCaptureStatus('同步最终采集结果');
                const capturedEntries = jobs.reduce((sum, job) => sum + serverCaptureEntryCount(job), 0);
                if (createdSessionId) {
                    await window.ipcRenderer.accounts.completeImportSession({
                        sessionId: createdSessionId,
                        status: 'completed',
                        importedPostCount: importedStats.posts,
                        failedPostCount: 0,
                    });
                }
                setCreateFlowStats({
                    posts: Math.max(importedStats.posts, accountImportedEntryKeys.size),
                    media: importedStats.media,
                    comments: importedStats.comments,
                    requested: Math.max(Number(result?.limit || 20), capturedEntries),
                });
                await loadAccounts();
                await loadDetail(nextAccountId);
                setCreateFlowStatus('completed');
                setCreateFlowCaptureStatus('完成');
            } else {
                setCreateDialogOpen(false);
                setCreateHomepageUrl('');
                setCreateFlowStatus('idle');
            }
        } catch (createError) {
            console.error('Failed to create account profile:', createError);
            if (createdSessionId) {
                await window.ipcRenderer.accounts.completeImportSession({
                    sessionId: createdSessionId,
                    status: 'failed',
                    failedPostCount: 1,
                    lastError: createError instanceof Error ? createError.message : '创建账号档案失败',
                }).catch((completeError) => {
                    console.error('Failed to mark account import failed:', completeError);
                });
            }
            setCreateFlowStatus('failed');
            setError(createError instanceof Error ? createError.message : '创建账号档案失败');
        } finally {
            setCreatingAccount(false);
        }
    }, [createHomepageUrl, creatingAccount, detectedHomepagePlatform, loadAccounts, loadDetail]);

    const createFlowBusy = creatingAccount || createFlowStatus === 'creating' || createFlowStatus === 'capturing' || createFlowStatus === 'importing';
    const createFlowFinished = createFlowStatus === 'completed' || createFlowStatus === 'failed';
    const createFlowProgress = Math.min(100, Math.round((createFlowStats.posts / Math.max(1, createFlowStats.requested)) * 100));

    const handleDeleteAccount = useCallback(async (account: AccountSummary | null) => {
        if (!account?.id || deletingAccountId) return;
        const confirmed = await appConfirm(`确定删除账号档案 "${account.username || account.id}" 吗？\n\n账号信息、已导入内容、评论和学习结果都会从当前空间移除。`, {
            title: '删除账号档案',
            confirmLabel: '删除',
            tone: 'danger',
        });
        if (!confirmed) return;
        setDeletingAccountId(account.id);
        setError('');
        try {
            await window.ipcRenderer.accounts.delete({ accountId: account.id });
            setDetail(null);
            setDetailModalOpen(false);
            setSelectedAccountId((current) => (current === account.id ? '' : current));
            await loadAccounts();
        } catch (deleteError) {
            console.error('Failed to delete account profile:', deleteError);
            setError(deleteError instanceof Error ? deleteError.message : '删除账号档案失败');
        } finally {
            setDeletingAccountId('');
        }
    }, [deletingAccountId, loadAccounts]);

    const createDialog = createDialogOpen ? createPortal((
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 py-5">
            <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
                <div className="flex h-14 items-center justify-between border-b border-border px-5">
                    <div className="text-sm font-semibold text-text-primary">
                        {createFlowStatus === 'capturing' || createFlowStatus === 'importing' || createFlowStatus === 'completed' ? '采集账号档案' : '创建账号档案'}
                    </div>
                    <button
                        type="button"
                        onClick={closeCreateDialog}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                        title="关闭"
                        aria-label="关闭"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="space-y-4 p-5">
                    <label className="block">
                        <span className="mb-2 block text-xs font-medium text-text-secondary">主页 URL</span>
                        <input
                            value={createHomepageUrl}
                            onChange={(event) => {
                                setCreateHomepageUrl(event.target.value);
                                if (error) setError('');
                            }}
                            onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                event.preventDefault();
                                if (!createFlowBusy && detectedHomepagePlatform?.validHomepage) {
                                    void handleCreateAccount();
                                }
                            }}
                            autoFocus
                            placeholder="https://www.xiaohongshu.com/user/profile/..."
                            className="h-10 w-full rounded-lg border border-border bg-surface-primary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                            disabled={creatingAccount}
                        />
                    </label>
                    {detectedHomepagePlatform ? (
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-secondary/45 px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-primary">
                                    <PlatformIcon platform={detectedHomepagePlatform.id} />
                                </span>
                                <div className="min-w-0">
                                    <div className="truncate text-xs font-medium text-text-primary">{detectedHomepagePlatform.name}</div>
                                    <div className="truncate text-[11px] text-text-tertiary">
                                        {detectedHomepagePlatform.validHomepage && detectedHomepagePlatform.autoCapture
                                            ? '将采集最近 20 条内容'
                                            : detectedHomepagePlatform.hint}
                                    </div>
                                </div>
                            </div>
                            <span className={clsx(
                                'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                                detectedHomepagePlatform.validHomepage
                                    ? 'bg-emerald-500/10 text-emerald-600'
                                    : 'bg-amber-500/10 text-amber-600',
                            )}>
                                {detectedHomepagePlatform.validHomepage
                                    ? detectedHomepagePlatform.autoCapture ? '可采集' : '已识别'
                                    : '需要主页'}
                            </span>
                        </div>
                    ) : createHomepageUrl.trim() ? (
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-secondary/45 px-3 py-2 text-xs text-text-tertiary">
                            <Link2 className="h-3.5 w-3.5" />
                            暂未识别支持的平台主页
                        </div>
                    ) : null}
                    {error ? (
                        <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-600">{error}</div>
                    ) : null}
                    {createFlowStatus !== 'idle' ? (
                        <div className="rounded-lg border border-border bg-surface-secondary/45 px-3 py-3">
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    {createFlowStatus === 'completed' ? (
                                        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                                    ) : createFlowStatus === 'failed' ? (
                                        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                                    ) : (
                                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-primary" />
                                    )}
                                    <div className="truncate text-xs font-medium text-text-primary">
                                        {createFlowStatus === 'creating'
                                            ? '正在创建账号档案'
                                            : createFlowStatus === 'capturing'
                                                ? createFlowCaptureStatus || '正在调用小红书采集 API'
                                                : createFlowStatus === 'importing'
                                                    ? createFlowCaptureStatus || '正在写入账号档案'
                                                : createFlowStatus === 'completed'
                                                    ? '采集完成'
                                                    : '采集失败'}
                                    </div>
                                </div>
                                <span className="shrink-0 text-[11px] text-text-tertiary">
                                    {createFlowStats.posts}/{createFlowStats.requested} 内容
                                </span>
                            </div>
                            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-primary">
                                <div
                                    className={clsx(
                                        'h-full rounded-full transition-all',
                                        createFlowStatus === 'failed' ? 'bg-red-500' : 'bg-accent-primary',
                                    )}
                                    style={{ width: `${createFlowStatus === 'completed' ? 100 : createFlowProgress}%` }}
                                />
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px] text-text-secondary">
                                <div className="rounded-md bg-surface-primary px-2 py-1.5">
                                    <div className="font-semibold text-text-primary">{numberText(createFlowStats.posts)}</div>
                                    <div>内容</div>
                                </div>
                                <div className="rounded-md bg-surface-primary px-2 py-1.5">
                                    <div className="font-semibold text-text-primary">{numberText(createFlowStats.media)}</div>
                                    <div>媒体</div>
                                </div>
                                <div className="rounded-md bg-surface-primary px-2 py-1.5">
                                    <div className="font-semibold text-text-primary">{numberText(createFlowStats.comments)}</div>
                                    <div>评论</div>
                                </div>
                            </div>
                            {createFlowStatus === 'capturing' || createFlowStatus === 'importing' ? (
                                <div className="mt-3 text-[11px] leading-5 text-text-tertiary">
                                    {createFlowStatus === 'capturing'
                                        ? '正在通过小红书采集 API 下载账号信息、最近内容和评论。'
                                        : '采集结果正在写入知识库和当前空间的账号档案。'}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
                    <button
                        type="button"
                        onClick={closeCreateDialog}
                        className="rounded-lg border border-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-surface-secondary"
                    >
                        {createFlowFinished ? '关闭' : '取消'}
                    </button>
                    <button
                        type="button"
                        onClick={createFlowFinished ? closeCreateDialog : () => void handleCreateAccount()}
                        disabled={createFlowBusy || (!createFlowFinished && !detectedHomepagePlatform?.validHomepage)}
                        className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {createFlowBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : !createFlowFinished ? (
                            <Download className="h-3.5 w-3.5" />
                        ) : null}
                        {createFlowFinished
                            ? createFlowStatus === 'completed' ? '完成' : '关闭'
                            : createFlowStatus === 'capturing'
                                ? '采集中'
                                : createFlowStatus === 'importing'
                                    ? '入库中'
                                    : creatingAccount
                            ? detectedHomepagePlatform?.autoCapture ? '创建任务' : '创建中'
                            : detectedHomepagePlatform?.autoCapture ? '开始采集' : '创建档案'}
                    </button>
                </div>
            </div>
        </div>
    ), document.body) : null;

    const filteredPosts = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (!term) return posts;
        return posts.filter((post) => [
            post.title,
            post.content,
            post.url,
            Array.isArray(post.tags) ? post.tags.join(' ') : '',
        ].some((value) => String(value || '').toLowerCase().includes(term)));
    }, [posts, query]);

    const filteredMedia = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (!term) return media;
        return media.filter((item) => [item.kind, item.url, item.postId].some((value) => String(value || '').toLowerCase().includes(term)));
    }, [media, query]);

    const filteredComments = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (!term) return comments;
        return comments.filter((comment) => [comment.author, comment.text, comment.postId].some((value) => String(value || '').toLowerCase().includes(term)));
    }, [comments, query]);

    const selectedPostComments = useMemo(() => {
        if (!selectedPost?.id) return [];
        return comments.filter((comment) => String(comment.postId || '') === selectedPost.id);
    }, [comments, selectedPost]);

    const postDetailDialog = selectedPost ? createPortal((
        <AccountPostDetailModal
            post={selectedPost}
            comments={selectedPostComments}
            onClose={() => setSelectedPost(null)}
        />
    ), document.body) : null;

    if (compact) {
        const openAccountDetail = (accountId: string) => {
            setDetail(null);
            setSelectedAccountId(accountId);
            setDetailModalOpen(true);
        };

        return (
            <>
            <div className="min-h-0">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
                        <BookOpenText className="h-4 w-4" />
                        账号档案
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={openCreateDialog}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            title="创建账号档案"
                            aria-label="创建账号档案"
                        >
                            <Plus className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => void loadAccounts()}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            title="刷新"
                            aria-label="刷新"
                        >
                            <RefreshCw className={clsx('h-4 w-4', loadingAccounts && 'animate-spin')} />
                        </button>
                    </div>
                </div>

                <div className="min-h-0">
                    {error ? (
                        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600">{error}</div>
                    ) : null}

                    {loadingAccounts && accounts.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border bg-surface-secondary/30 p-8 text-center text-sm text-text-tertiary">
                            加载账号中...
                        </div>
                    ) : accounts.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border bg-surface-secondary/30 p-8 text-center text-sm text-text-tertiary">
                            暂无账号档案
                        </div>
                    ) : (
                        <div className="flex gap-3 overflow-x-auto pb-2">
                            {accounts.map((account) => (
                                <CreatorAccountCard
                                    key={account.id}
                                    account={account}
                                    onClick={() => openAccountDetail(account.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>

                {detailModalOpen && selectedAccount ? (
                    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 px-4 py-5">
                        <div className="flex h-full max-h-[820px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
                            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
                                <div className="flex min-w-0 items-center gap-3">
                                    <AccountAvatar account={selectedAccount} sizeClassName="h-9 w-9" />
                                    <div className="min-w-0">
                                        <div className="truncate text-[15px] font-semibold text-text-primary">{selectedAccount.username || '未命名账号'}</div>
                                        <div className="truncate text-xs text-text-tertiary">{platformLabel(selectedAccount.platform)} · {selectedAccount.platformUserId || selectedAccount.id}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => void handleDeleteAccount(selectedAccount)}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                                        title="删除账号档案"
                                        aria-label="删除账号档案"
                                        disabled={deletingAccountId === selectedAccount.id}
                                    >
                                        {deletingAccountId === selectedAccount.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setDetailModalOpen(false)}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                        title="关闭"
                                        aria-label="关闭"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>

                            <div className="min-h-0 flex-1 overflow-y-auto p-5">
                                {loadingDetail ? (
                                    <div className="rounded-lg border border-border bg-surface-secondary/40 p-6 text-sm text-text-tertiary">加载账号档案...</div>
                                ) : (
                                    <div className="space-y-5">
                                        <div className="grid gap-2 sm:grid-cols-3">
                                            <Metric label="粉丝" value={selectedAccount.followerCount} compact />
                                            <Metric label="作品" value={accountTotalPostCount(selectedAccount, posts)} compact />
                                            <Metric label="点赞" value={accountTotalLikeCount(selectedAccount, posts)} compact />
                                        </div>

                                        <section>
                                            <div className="mb-3 text-sm font-medium text-text-primary">内容</div>
                                            <PostGallery posts={posts} compact onOpenPost={setSelectedPost} />
                                        </section>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>
            {createDialog}
            {postDetailDialog}
            </>
        );
    }

    return (
        <>
        <div className="flex h-full min-h-0">
            <aside className={clsx(
                'border-r border-border bg-surface-secondary/30 flex flex-col min-h-0',
                compact ? 'w-64' : 'w-80',
            )}>
                <div className={clsx('border-b border-border', compact ? 'p-3' : 'p-4')}>
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2 text-text-primary font-semibold">
                                <BookOpenText className="w-4 h-4" />
                                账号档案
                            </div>
                            {!compact && <div className="mt-1 text-xs text-text-tertiary">当前空间绑定账号</div>}
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={openCreateDialog}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-colors"
                                title="创建账号档案"
                                aria-label="创建账号档案"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => void loadAccounts()}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-colors"
                                title="刷新"
                                aria-label="刷新"
                            >
                                <RefreshCw className={clsx('w-4 h-4', loadingAccounts && 'animate-spin')} />
                            </button>
                        </div>
                    </div>
                </div>
                <div className={clsx('flex-1 min-h-0 overflow-y-auto space-y-2', compact ? 'p-2' : 'p-3')}>
                    {loadingAccounts && accounts.length === 0 ? (
                        <div className="px-2 py-3 text-sm text-text-tertiary">加载账号中...</div>
                    ) : accounts.length === 0 ? (
                        <div className={clsx('rounded-lg border border-dashed border-border bg-surface-primary text-sm text-text-secondary', compact ? 'p-3' : 'p-4')}>
                            {compact ? '暂无账号档案' : '当前空间还没有账号档案。'}
                        </div>
                    ) : accounts.map((account) => (
                        <button
                            key={account.id}
                            type="button"
                            onClick={() => setSelectedAccountId(account.id)}
                            className={clsx(
                                'w-full rounded-lg border text-left transition-colors',
                                compact ? 'p-2' : 'p-3',
                                selectedAccountId === account.id
                                    ? 'border-accent-primary/40 bg-surface-primary shadow-sm'
                                    : 'border-transparent hover:border-border hover:bg-surface-primary',
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <div className={clsx('rounded-lg bg-accent-primary/10 text-accent-primary inline-flex items-center justify-center overflow-hidden shrink-0', compact ? 'h-8 w-8' : 'h-10 w-10')}>
                                    {account.avatarUrl ? (
                                        <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <UserRound className="w-5 h-5" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-text-primary truncate">{account.username || '未命名账号'}</div>
                                    <div className="mt-0.5 text-xs text-text-tertiary truncate">{platformLabel(account.platform)} · {account.platformUserId || account.id}</div>
                                    <div className={clsx('grid grid-cols-3 gap-1 text-[11px] text-text-secondary', compact ? 'mt-1' : 'mt-2')}>
                                        <span>{numberText(account.followerCount)} 粉丝</span>
                                        <span>{numberText(accountTotalPostCount(account))} 作品</span>
                                        <span>{numberText(accountTotalLikeCount(account))} 点赞</span>
                                    </div>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </aside>

            <main className="flex-1 min-w-0 flex flex-col">
                <header className={clsx('border-b border-border bg-surface-primary', compact ? 'px-4 py-3' : 'px-6 py-4')}>
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h1 className={clsx('font-semibold text-text-primary truncate', compact ? 'text-base' : 'text-xl')}>{selectedAccount?.username || '账号画廊'}</h1>
                                {selectedAccount?.platform ? (
                                    <span className="px-2 py-0.5 rounded border border-border text-xs text-text-secondary bg-surface-secondary">
                                        {platformLabel(selectedAccount.platform)}
                                    </span>
                                ) : null}
                            </div>
                            <div className={clsx('mt-1 text-text-tertiary truncate', compact ? 'text-xs' : 'text-sm')}>
                                {selectedAccount
                                    ? compact
                                        ? `${learningStatusText(detail?.learningState)} · ${formatTimestampDate(selectedAccount.lastLearnedAt) || '未学习'}`
                                        : `${learningStatusText(detail?.learningState)} · 最近学习 ${formatTimestampDate(selectedAccount.lastLearnedAt) || '未学习'} · 最近导入 ${formatTimestampDate(selectedAccount.lastImportedAt) || '暂无记录'}`
                                    : '选择一个账号查看内容画廊和学习结果'}
                            </div>
                        </div>
                        <div className="flex shrink-0 items-start gap-2">
                            <div className={clsx('grid grid-cols-3', compact ? 'gap-1.5' : 'gap-2')}>
                                <Metric label="粉丝" value={selectedAccount?.followerCount} compact={compact} />
                                <Metric label="作品" value={accountTotalPostCount(selectedAccount, posts)} compact={compact} />
                                <Metric label="点赞" value={accountTotalLikeCount(selectedAccount, posts)} compact={compact} />
                            </div>
                            {selectedAccount ? (
                                <button
                                    type="button"
                                    onClick={() => void handleDeleteAccount(selectedAccount)}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-tertiary transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                                    title="删除账号档案"
                                    aria-label="删除账号档案"
                                    disabled={deletingAccountId === selectedAccount.id}
                                >
                                    {deletingAccountId === selectedAccount.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                </button>
                            ) : null}
                        </div>
                    </div>
                </header>

                <div className="flex-1 min-h-0 overflow-y-auto">
                    {!selectedAccount ? (
                        <div className="h-full min-h-[360px] flex items-center justify-center text-sm text-text-tertiary">
                            还没有账号档案可展示
                        </div>
                    ) : (
                        <div className={clsx(compact ? 'p-4 space-y-4' : 'p-6 space-y-6')}>
                            {error ? (
                                <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">{error}</div>
                            ) : null}

                            <section>
                                <div className="min-w-0 space-y-4">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="inline-flex rounded-lg border border-border bg-surface-secondary p-1 w-fit">
                                            <ModeButton active={galleryMode === 'posts'} onClick={() => setGalleryMode('posts')} icon={<FileText className="w-3.5 h-3.5" />} label="内容" />
                                            <ModeButton active={galleryMode === 'media'} onClick={() => setGalleryMode('media')} icon={<Image className="w-3.5 h-3.5" />} label="媒体" />
                                            <ModeButton active={galleryMode === 'comments'} onClick={() => setGalleryMode('comments')} icon={<MessageCircle className="w-3.5 h-3.5" />} label="评论" />
                                        </div>
                                        <div className="relative w-full sm:w-72">
                                            <Search className="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
                                            <input
                                                value={query}
                                                onChange={(event) => setQuery(event.target.value)}
                                                className="w-full h-9 bg-surface-primary border border-border rounded-lg pl-9 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                                placeholder="搜索当前账号内容"
                                            />
                                        </div>
                                    </div>

                                    {loadingDetail ? (
                                        <div className="rounded-lg border border-border bg-surface-secondary/40 p-6 text-sm text-text-tertiary">加载账号内容...</div>
                                    ) : galleryMode === 'posts' ? (
                                        <PostGallery posts={filteredPosts} compact={compact} onOpenPost={setSelectedPost} />
                                    ) : galleryMode === 'media' ? (
                                        <MediaGallery media={filteredMedia} compact={compact} />
                                    ) : (
                                        <CommentGallery comments={filteredComments} compact={compact} />
                                    )}
                                </div>

                            </section>
                        </div>
                    )}
                </div>
            </main>
        </div>
        {createDialog}
        {postDetailDialog}
        </>
    );
}

export function CreatorProfiles({ isActive = true }: { isActive?: boolean }) {
    return <CreatorProfilesPanel isActive={isActive} />;
}

function AccountAvatar({ account, sizeClassName = 'h-10 w-10' }: { account: AccountSummary; sizeClassName?: string }) {
    return (
        <div className={clsx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent-primary/10 text-accent-primary', sizeClassName)}>
            {account.avatarUrl ? (
                <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
                <UserRound className="h-5 w-5" />
            )}
        </div>
    );
}

function CreatorAccountCard({ account, onClick }: { account: AccountSummary; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group min-h-[118px] w-[220px] shrink-0 rounded-xl border border-border bg-surface-primary/72 p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent-primary/30 hover:bg-surface-primary hover:shadow-md"
        >
            <div className="flex items-start gap-3">
                <AccountAvatar account={account} sizeClassName="h-9 w-9" />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-text-primary">{account.username || '未命名账号'}</div>
                    <div className="mt-1 truncate text-xs text-text-tertiary">{platformLabel(account.platform)} · {account.platformUserId || account.id}</div>
                </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div>
                    <div className="text-sm font-semibold tabular-nums text-text-primary">{numberText(account.followerCount)}</div>
                    <div className="mt-0.5 text-[11px] text-text-tertiary">粉丝</div>
                </div>
                <div>
                    <div className="text-sm font-semibold tabular-nums text-text-primary">{numberText(accountTotalPostCount(account))}</div>
                    <div className="mt-0.5 text-[11px] text-text-tertiary">作品</div>
                </div>
                <div>
                    <div className="text-sm font-semibold tabular-nums text-text-primary">{numberText(accountTotalLikeCount(account))}</div>
                    <div className="mt-0.5 text-[11px] text-text-tertiary">点赞</div>
                </div>
            </div>
            <div className="mt-4 truncate text-[11px] text-text-tertiary">
                最近学习 {formatTimestampDate(account.lastLearnedAt) || '未学习'}
            </div>
        </button>
    );
}

function Metric({ label, value, compact = false }: { label: string; value: unknown; compact?: boolean }) {
    return (
        <div className={clsx('rounded-lg border border-border bg-surface-secondary/50 text-right', compact ? 'min-w-16 px-2 py-1.5' : 'min-w-20 px-3 py-2')}>
            <div className={clsx('font-semibold text-text-primary', compact ? 'text-sm' : 'text-base')}>{numberText(value)}</div>
            <div className="text-[11px] text-text-tertiary">{label}</div>
        </div>
    );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={clsx(
                'h-8 px-3 rounded-md text-xs inline-flex items-center gap-1.5 transition-colors',
                active ? 'bg-surface-primary text-accent-primary shadow-sm' : 'text-text-secondary hover:text-text-primary',
            )}
        >
            {icon}
            {label}
        </button>
    );
}

function PostGallery({
    posts,
    compact = false,
    onOpenPost,
}: {
    posts: AccountPost[];
    compact?: boolean;
    onOpenPost?: (post: AccountPost) => void;
}) {
    if (posts.length === 0) {
        return <EmptyGallery text="没有匹配的内容" />;
    }
    return (
        <div className={clsx(
            'grid grid-cols-2',
            compact ? 'gap-2 sm:grid-cols-3 lg:grid-cols-4' : 'gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
        )}>
            {posts.map((post) => {
                const cover = postCover(post);
                const mediaCount = Array.isArray(post.media) ? post.media.length : 0;
                const statsEntries = postStatsEntries(post);
                return (
                    <button
                        key={post.id}
                        type="button"
                        onClick={() => onOpenPost?.(post)}
                        className="group relative w-full overflow-hidden rounded-lg border border-black/[0.04] bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent-primary/30 hover:shadow-md"
                    >
                        <div className="relative aspect-[3/4] w-full overflow-hidden bg-black/[0.02]">
                            <span className={clsx(
                                'absolute right-2 top-2 z-10 rounded-md border border-white/20 px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm backdrop-blur-md',
                                String(post.kind || '').toLowerCase().includes('video') ? 'bg-red-500/90' : 'bg-rose-500/90',
                            )}>
                                {postKindLabel(post)}
                            </span>
                            {cover ? (
                                <img
                                    src={resolveAssetUrl(cover)}
                                    alt=""
                                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                                    loading="lazy"
                                    decoding="async"
                                />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                                    <FileText className="h-7 w-7 opacity-30" />
                                </div>
                            )}
                        </div>
                        <div className={clsx(compact ? 'p-2.5' : 'p-3')}>
                            <div className={clsx(
                                'font-extrabold leading-snug tracking-normal text-text-primary transition-colors group-hover:text-accent-primary',
                                compact ? 'line-clamp-2 text-[13px]' : 'line-clamp-2 text-[14px]',
                            )}>
                                {titleFromPost(post)}
                            </div>
                            {!compact && (
                                <div className="mt-1.5 line-clamp-2 text-[12px] leading-5 text-text-secondary">
                                    {excerpt(post.content, 88) || '无正文摘要'}
                                </div>
                            )}
                            <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
                                <span>{formatTimestampDate(post.publishedAt || post.capturedAt || post.updatedAt) || '未知日期'}</span>
                                <span className="shrink-0">{mediaCount} 媒体</span>
                            </div>
                            {statsEntries.length > 0 ? (
                                <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-text-tertiary">
                                    {statsEntries.slice(0, compact ? 2 : 4).map(([label, value]) => (
                                        <span key={label}>{numberText(value)} {label}</span>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

function AccountPostDetailModal({
    post,
    comments,
    onClose,
}: {
    post: AccountPost;
    comments: AccountComment[];
    onClose: () => void;
}) {
    const media = Array.isArray(post.media) ? post.media : [];
    const primaryMedia = media.find(isImageMedia) || media.find(isVideoMedia) || media[0];
    const primarySource = primaryMedia ? postMediaSource(primaryMedia) : postCover(post);
    const resolvedPrimarySource = primarySource ? resolveAssetUrl(primarySource) : '';
    const statsEntries = postStatsEntries(post);
    return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 px-4 py-5">
            <div className="flex h-full max-h-[860px] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
                <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-text-primary">{titleFromPost(post)}</div>
                        <div className="mt-0.5 truncate text-xs text-text-tertiary">
                            {postKindLabel(post)} · {formatTimestampDate(post.publishedAt || post.capturedAt || post.updatedAt) || '未知日期'}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {post.url ? (
                            <a
                                href={post.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                title="打开原文"
                                aria-label="打开原文"
                            >
                                <Link2 className="h-4 w-4" />
                            </a>
                        ) : null}
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            title="关闭"
                            aria-label="关闭"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
                    <div className="min-h-[280px] border-b border-border bg-black/[0.03] lg:min-h-0 lg:border-b-0 lg:border-r">
                        {resolvedPrimarySource && primaryMedia && isVideoMedia(primaryMedia) ? (
                            <video src={resolvedPrimarySource} className="h-full max-h-[70vh] w-full bg-black object-contain lg:max-h-none" controls playsInline />
                        ) : resolvedPrimarySource ? (
                            <img src={resolvedPrimarySource} alt="" className="h-full max-h-[70vh] w-full object-contain lg:max-h-none" />
                        ) : (
                            <div className="flex h-full min-h-[280px] items-center justify-center text-text-tertiary">
                                <FileText className="h-9 w-9 opacity-25" />
                            </div>
                        )}
                    </div>
                    <div className="min-h-0 overflow-y-auto p-5">
                        <div className="space-y-5">
                            <section>
                                <div className="text-base font-semibold leading-7 text-text-primary">{titleFromPost(post)}</div>
                                {post.content ? (
                                    <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-secondary">{post.content}</div>
                                ) : null}
                            </section>
                            {statsEntries.length > 0 ? (
                                <section className="grid grid-cols-4 gap-2">
                                    {statsEntries.slice(0, 4).map(([label, value]) => (
                                        <Metric key={label} label={label} value={value} compact />
                                    ))}
                                </section>
                            ) : null}
                            {media.length > 1 ? (
                                <section>
                                    <div className="mb-2 text-xs font-medium text-text-secondary">媒体</div>
                                    <div className="grid grid-cols-4 gap-2">
                                        {media.map((item, index) => {
                                            const source = postMediaSource(item);
                                            const resolved = source ? resolveAssetUrl(source) : '';
                                            return (
                                                <div key={`${item.id || item.mediaId || source}-${index}`} className="aspect-square overflow-hidden rounded-lg border border-border bg-surface-secondary">
                                                    {resolved && isImageMedia(item) ? (
                                                        <img src={resolved} alt="" className="h-full w-full object-cover" loading="lazy" />
                                                    ) : (
                                                        <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                                                            {isVideoMedia(item) ? <Download className="h-4 w-4 opacity-40" /> : <Image className="h-4 w-4 opacity-40" />}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </section>
                            ) : null}
                            {comments.length > 0 ? (
                                <section>
                                    <div className="mb-2 text-xs font-medium text-text-secondary">评论</div>
                                    <div className="space-y-2">
                                        {comments.map((comment) => (
                                            <div key={comment.id} className="rounded-lg border border-border bg-surface-secondary/35 px-3 py-2">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div className="truncate text-xs font-medium text-text-primary">{comment.author || '匿名用户'}</div>
                                                    <div className="shrink-0 text-[11px] text-text-tertiary">{formatTimestampDate(comment.createdAt || comment.capturedAt || comment.updatedAt)}</div>
                                                </div>
                                                <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-text-secondary">{comment.text || '无评论内容'}</div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MediaGallery({ media, compact = false }: { media: AccountMedia[]; compact?: boolean }) {
    if (media.length === 0) {
        return <EmptyGallery text="没有匹配的媒体" />;
    }
    return (
        <div className={clsx('grid grid-cols-2 md:grid-cols-3 gap-3', compact ? '2xl:grid-cols-4' : '2xl:grid-cols-5')}>
            {media.map((item, index) => {
                const url = String(item.url || item.localPath || '').trim();
                const isImage = /image|cover/i.test(String(item.kind || '')) || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url);
                return (
                    <div key={`${item.id || item.mediaId || url}-${index}`} className="rounded-lg border border-border bg-surface-secondary/30 overflow-hidden">
                        <div className="aspect-square bg-surface-secondary flex items-center justify-center">
                            {isImage && url ? (
                                <img src={url} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <Image className="w-7 h-7 text-text-tertiary" />
                            )}
                        </div>
                        <div className="px-3 py-2">
                            <div className="text-xs text-text-primary truncate">{item.kind || 'media'}</div>
                            <div className="mt-0.5 text-[11px] text-text-tertiary truncate">{item.postId || item.id || '未关联内容'}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function CommentGallery({ comments, compact = false }: { comments: AccountComment[]; compact?: boolean }) {
    if (comments.length === 0) {
        return <EmptyGallery text="没有匹配的评论" />;
    }
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {comments.map((comment) => (
                <article key={comment.id} className={clsx('rounded-lg border border-border bg-surface-secondary/30', compact ? 'p-3' : 'p-4')}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-text-primary truncate">{comment.author || '匿名用户'}</div>
                        <div className="text-[11px] text-text-tertiary shrink-0">{formatTimestampDate(comment.createdAt || comment.capturedAt || comment.updatedAt)}</div>
                    </div>
                    <div className={clsx('mt-2 text-sm text-text-secondary whitespace-pre-wrap', compact ? 'line-clamp-2' : 'line-clamp-4')}>{comment.text || '无评论内容'}</div>
                    <div className="mt-3 flex items-center gap-3 text-[11px] text-text-tertiary">
                        <span>{numberText(comment.likes)} 赞</span>
                        <span>{numberText(comment.replies)} 回复</span>
                        {comment.postId ? <span className="truncate">内容 {comment.postId}</span> : null}
                    </div>
                </article>
            ))}
        </div>
    );
}

function EmptyGallery({ text }: { text: string }) {
    return (
        <div className="rounded-lg border border-dashed border-border bg-surface-secondary/30 p-8 text-center text-sm text-text-tertiary">
            {text}
        </div>
    );
}
