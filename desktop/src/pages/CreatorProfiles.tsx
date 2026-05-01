import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
    BookOpenText,
    Bot,
    FileText,
    Image,
    MessageCircle,
    RefreshCw,
    Search,
    Sparkles,
    UserRound,
} from 'lucide-react';
import { formatTimestampDate } from '../utils/time';

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
    creatorProfile?: string;
    writingStyleSkill?: string;
    learningSummary?: string;
    memoryCandidates?: {
        candidates?: Array<Record<string, unknown>>;
    };
}

type GalleryMode = 'posts' | 'media' | 'comments';

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
    const image = media.find((item) => /image|cover/i.test(String(item.kind || '')) && String(item.url || '').trim());
    return String(image?.url || '').trim();
}

function candidateText(candidate: Record<string, unknown>): string {
    return String(candidate.text || candidate.content || candidate.summary || '').trim();
}

export function CreatorProfiles({ isActive = true }: { isActive?: boolean }) {
    const [accounts, setAccounts] = useState<AccountSummary[]>([]);
    const [selectedAccountId, setSelectedAccountId] = useState('');
    const [detail, setDetail] = useState<AccountDetail | null>(null);
    const [query, setQuery] = useState('');
    const [galleryMode, setGalleryMode] = useState<GalleryMode>('posts');
    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [loadingDetail, setLoadingDetail] = useState(false);
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
            const result = await window.ipcRenderer.invoke('accounts:list') as { accounts?: AccountSummary[] };
            if (requestId !== loadAccountsRequestRef.current) return;
            const list = Array.isArray(result?.accounts) ? result.accounts : [];
            setAccounts(list);
            hasLoadedAccountsRef.current = true;
            setSelectedAccountId((current) => {
                if (current && list.some((account) => account.id === current)) return current;
                return list[0]?.id || '';
            });
        } catch (loadError) {
            if (requestId !== loadAccountsRequestRef.current) return;
            console.error('Failed to load creator profiles:', loadError);
            setError(loadError instanceof Error ? loadError.message : '加载创作档案失败');
        } finally {
            if (requestId === loadAccountsRequestRef.current) {
                setLoadingAccounts(false);
            }
        }
    }, []);

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
            const result = await window.ipcRenderer.invoke('accounts:get', { accountId }) as AccountDetail;
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

    const posts = detail?.posts || [];
    const media = detail?.media || [];
    const comments = detail?.comments || [];
    const memoryCandidates = detail?.memoryCandidates?.candidates || [];

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

    return (
        <div className="flex h-full min-h-0 bg-surface-primary">
            <aside className="w-80 border-r border-border bg-surface-secondary/30 flex flex-col min-h-0">
                <div className="p-4 border-b border-border">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2 text-text-primary font-semibold">
                                <BookOpenText className="w-4 h-4" />
                                创作档案
                            </div>
                            <div className="mt-1 text-xs text-text-tertiary">当前空间绑定账号</div>
                        </div>
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
                <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                    {loadingAccounts && accounts.length === 0 ? (
                        <div className="px-2 py-3 text-sm text-text-tertiary">加载账号中...</div>
                    ) : accounts.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border bg-surface-primary p-4 text-sm text-text-secondary">
                            当前空间还没有绑定账号。打开插件 sidepanel，在账号主页绑定后，这里会显示账号画廊和学习结果。
                        </div>
                    ) : accounts.map((account) => (
                        <button
                            key={account.id}
                            type="button"
                            onClick={() => setSelectedAccountId(account.id)}
                            className={clsx(
                                'w-full rounded-lg border p-3 text-left transition-colors',
                                selectedAccountId === account.id
                                    ? 'border-accent-primary/40 bg-surface-primary shadow-sm'
                                    : 'border-transparent hover:border-border hover:bg-surface-primary',
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <div className="h-10 w-10 rounded-lg bg-accent-primary/10 text-accent-primary inline-flex items-center justify-center overflow-hidden shrink-0">
                                    {account.avatarUrl ? (
                                        <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <UserRound className="w-5 h-5" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-text-primary truncate">{account.username || '未命名账号'}</div>
                                    <div className="mt-0.5 text-xs text-text-tertiary truncate">{platformLabel(account.platform)} · {account.platformUserId || account.id}</div>
                                    <div className="mt-2 grid grid-cols-3 gap-1 text-[11px] text-text-secondary">
                                        <span>{numberText(account.postCount)} 内容</span>
                                        <span>{numberText(account.mediaCount)} 媒体</span>
                                        <span>{numberText(account.commentCount)} 评论</span>
                                    </div>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </aside>

            <main className="flex-1 min-w-0 flex flex-col">
                <header className="px-6 py-4 border-b border-border bg-surface-primary">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h1 className="text-xl font-semibold text-text-primary truncate">{selectedAccount?.username || '账号画廊'}</h1>
                                {selectedAccount?.platform ? (
                                    <span className="px-2 py-0.5 rounded border border-border text-xs text-text-secondary bg-surface-secondary">
                                        {platformLabel(selectedAccount.platform)}
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-1 text-sm text-text-tertiary">
                                {selectedAccount
                                    ? `最近学习 ${formatTimestampDate(selectedAccount.lastLearnedAt) || '未学习'} · 最近导入 ${formatTimestampDate(selectedAccount.lastImportedAt) || '暂无记录'}`
                                    : '选择一个账号查看内容画廊和学习结果'}
                            </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 shrink-0">
                            <Metric label="内容" value={selectedAccount?.postCount || posts.length} />
                            <Metric label="媒体" value={selectedAccount?.mediaCount || media.length} />
                            <Metric label="评论" value={selectedAccount?.commentCount || comments.length} />
                        </div>
                    </div>
                </header>

                <div className="flex-1 min-h-0 overflow-y-auto">
                    {!selectedAccount ? (
                        <div className="h-full min-h-[360px] flex items-center justify-center text-sm text-text-tertiary">
                            还没有账号档案可展示
                        </div>
                    ) : (
                        <div className="p-6 space-y-6">
                            {error ? (
                                <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">{error}</div>
                            ) : null}

                            <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
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
                                        <PostGallery posts={filteredPosts} />
                                    ) : galleryMode === 'media' ? (
                                        <MediaGallery media={filteredMedia} />
                                    ) : (
                                        <CommentGallery comments={filteredComments} />
                                    )}
                                </div>

                                <aside className="space-y-4">
                                    <InsightPanel
                                        title="创作档案"
                                        icon={<Bot className="w-4 h-4" />}
                                        content={detail?.creatorProfile || detail?.learningSummary || ''}
                                        empty="还没有生成创作档案。导入账号内容后会自动学习。"
                                    />
                                    <InsightPanel
                                        title="写作风格"
                                        icon={<Sparkles className="w-4 h-4" />}
                                        content={detail?.writingStyleSkill || ''}
                                        empty="还没有写作风格技能。"
                                    />
                                    <section className="rounded-lg border border-border bg-surface-secondary/30 p-4">
                                        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                            <MessageCircle className="w-4 h-4" />
                                            记忆候选
                                        </div>
                                        <div className="mt-3 space-y-2">
                                            {memoryCandidates.length === 0 ? (
                                                <div className="text-sm text-text-tertiary">暂无记忆候选</div>
                                            ) : memoryCandidates.slice(0, 5).map((candidate, index) => (
                                                <div key={`${candidateText(candidate)}-${index}`} className="rounded-md bg-surface-primary border border-border px-3 py-2 text-xs text-text-secondary">
                                                    {candidateText(candidate) || '未命名记忆'}
                                                </div>
                                            ))}
                                        </div>
                                    </section>
                                </aside>
                            </section>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: unknown }) {
    return (
        <div className="min-w-20 rounded-lg border border-border bg-surface-secondary/50 px-3 py-2 text-right">
            <div className="text-base font-semibold text-text-primary">{numberText(value)}</div>
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

function PostGallery({ posts }: { posts: AccountPost[] }) {
    if (posts.length === 0) {
        return <EmptyGallery text="没有匹配的内容" />;
    }
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
            {posts.map((post) => {
                const cover = postCover(post);
                return (
                    <article key={post.id} className="rounded-lg border border-border bg-surface-secondary/30 overflow-hidden">
                        <div className="aspect-[4/3] bg-surface-secondary flex items-center justify-center">
                            {cover ? (
                                <img src={cover} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <FileText className="w-8 h-8 text-text-tertiary" />
                            )}
                        </div>
                        <div className="p-4">
                            <div className="text-sm font-medium text-text-primary line-clamp-2">{titleFromPost(post)}</div>
                            <div className="mt-2 text-xs text-text-secondary line-clamp-3">{excerpt(post.content, 150) || '无正文摘要'}</div>
                            <div className="mt-3 flex items-center justify-between text-[11px] text-text-tertiary">
                                <span>{formatTimestampDate(post.publishedAt || post.capturedAt || post.updatedAt) || '未知日期'}</span>
                                <span>{Array.isArray(post.media) ? post.media.length : 0} 媒体</span>
                            </div>
                        </div>
                    </article>
                );
            })}
        </div>
    );
}

function MediaGallery({ media }: { media: AccountMedia[] }) {
    if (media.length === 0) {
        return <EmptyGallery text="没有匹配的媒体" />;
    }
    return (
        <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-5 gap-3">
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

function CommentGallery({ comments }: { comments: AccountComment[] }) {
    if (comments.length === 0) {
        return <EmptyGallery text="没有匹配的评论" />;
    }
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {comments.map((comment) => (
                <article key={comment.id} className="rounded-lg border border-border bg-surface-secondary/30 p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-text-primary truncate">{comment.author || '匿名用户'}</div>
                        <div className="text-[11px] text-text-tertiary shrink-0">{formatTimestampDate(comment.createdAt || comment.capturedAt || comment.updatedAt)}</div>
                    </div>
                    <div className="mt-2 text-sm text-text-secondary whitespace-pre-wrap line-clamp-4">{comment.text || '无评论内容'}</div>
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

function InsightPanel({ title, icon, content, empty }: { title: string; icon: ReactNode; content: string; empty: string }) {
    const text = content.trim();
    return (
        <section className="rounded-lg border border-border bg-surface-secondary/30 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                {icon}
                {title}
            </div>
            <div className="mt-3 max-h-72 overflow-y-auto rounded-md bg-surface-primary border border-border p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                {text ? excerpt(text, 1800) : empty}
            </div>
        </section>
    );
}

function EmptyGallery({ text }: { text: string }) {
    return (
        <div className="rounded-lg border border-dashed border-border bg-surface-secondary/30 p-8 text-center text-sm text-text-tertiary">
            {text}
        </div>
    );
}
