import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    ArrowLeft,
    ChevronDown,
    Download,
    ExternalLink,
    FileText,
    Loader2,
    MessageCircle,
    RefreshCw,
    Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { PendingChatMessage } from '../features/app-shell/types';
import type { SkillMarketSource, SkillMarketplaceInstallResponse, ThriveSkillMarketplaceItem } from '../types';

const normalizeKey = (value: unknown) => String(value || '').trim().toLowerCase();

const marketItemKey = (skill: ThriveSkillMarketplaceItem) => (
    `${skill.marketId || 'market'}:${skill.packageId || skill.id || skill.name}`
);

type MarketplaceCacheEntry = {
    sources: SkillMarketSource[];
    items: ThriveSkillMarketplaceItem[];
};

type MarketplaceCacheSnapshot = {
    savedAt?: number;
    entries?: Record<string, MarketplaceCacheEntry>;
};

type MarketplacePackageDetail = {
    item?: ThriveSkillMarketplaceItem;
    manifest?: unknown;
};

type MarketplacePackageResponse = MarketplacePackageDetail & {
    success?: boolean;
    error?: string;
};

const ALL_MARKET_CACHE_KEY = '__all__';
const MARKETPLACE_CACHE_STORAGE_KEY = 'redbox:skill-marketplace-cache:v1';
const MAX_AVATAR_CACHE_CONCURRENCY = 4;
const skillMarketCache = new Map<string, MarketplaceCacheEntry>();
const skillDetailCache = new Map<string, MarketplacePackageDetail>();
const skillAvatarDataUrlCache = new Map<string, string>();
const skillAvatarRequestCache = new Map<string, Promise<string>>();
let skillMarketCacheHydrated = false;
let activeAvatarCacheRequests = 0;
const queuedAvatarCacheRequests: Array<() => void> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function manifestText(manifest: unknown, keys: string[]) {
    if (!isRecord(manifest)) return '';
    for (const key of keys) {
        const value = manifest[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function manifestList(manifest: unknown, keys: string[]) {
    if (!isRecord(manifest)) return [];
    for (const key of keys) {
        const value = manifest[key];
        if (Array.isArray(value)) {
            return value.map((item) => String(item || '').trim()).filter(Boolean);
        }
    }
    return [];
}

function repoHref(repo?: string | null) {
    const clean = String(repo || '').trim();
    if (!clean) return '';
    if (/^https?:\/\//i.test(clean)) return clean;
    if (/^[\w.-]+\/[\w.-]+$/.test(clean)) return `https://github.com/${clean}`;
    return '';
}

function githubOwnerAvatarUrl(repo?: string | null) {
    const clean = String(repo || '').trim();
    if (!clean) return '';
    const shorthand = clean.match(/^([\w.-]+)\/[\w.-]+$/);
    if (shorthand) return `https://github.com/${shorthand[1]}.png?size=96`;
    const httpsMatch = clean.match(/^https?:\/\/github\.com\/([\w.-]+)\/[\w.-]+/i);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}.png?size=96`;
    const sshMatch = clean.match(/^git@github\.com:([\w.-]+)\/[\w.-]+(?:\.git)?$/i);
    if (sshMatch) return `https://github.com/${sshMatch[1]}.png?size=96`;
    return '';
}

function skillAvatarUrl(skill: ThriveSkillMarketplaceItem) {
    return [
        skill.avatarUrl,
        skill.iconUrl,
        skill.logoUrl,
        skill.imageUrl,
        skill.thumbnailUrl,
        githubOwnerAvatarUrl(skill.repo),
    ].map((value) => String(value || '').trim()).find(Boolean) || '';
}

function pushUniqueSkillName(candidates: string[], value: unknown) {
    const clean = String(value || '').trim();
    if (!clean) return;
    const normalized = normalizeKey(clean);
    if (candidates.some((candidate) => normalizeKey(candidate) === normalized)) return;
    candidates.push(clean);
}

function slugSkillName(value: unknown) {
    const clean = String(value || '').trim();
    if (!clean) return '';
    const lastSegment = clean.split(':').pop() || clean;
    return lastSegment
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

function skillRuntimeNameCandidates(skill: ThriveSkillMarketplaceItem) {
    const candidates: string[] = [];
    (skill.installedSkillNames || []).forEach((name) => pushUniqueSkillName(candidates, name));
    [skill.packageId, skill.name, skill.id].forEach((value) => {
        pushUniqueSkillName(candidates, value);
        const slug = slugSkillName(value);
        pushUniqueSkillName(candidates, slug);
        const withoutSkillSuffix = slug.replace(/[-_]?skill$/i, '');
        if (withoutSkillSuffix && withoutSkillSuffix !== slug) {
            pushUniqueSkillName(candidates, withoutSkillSuffix);
        }
    });
    return candidates;
}

function asMarketplaceCacheEntry(value: unknown): MarketplaceCacheEntry | null {
    if (!isRecord(value)) return null;
    const sources = Array.isArray(value.sources) ? value.sources as SkillMarketSource[] : [];
    const items = Array.isArray(value.items) ? value.items as ThriveSkillMarketplaceItem[] : [];
    if (sources.length === 0 && items.length === 0) return null;
    return { sources, items };
}

function hydrateSkillMarketCache() {
    if (skillMarketCacheHydrated) return;
    skillMarketCacheHydrated = true;
    if (typeof window === 'undefined') return;
    try {
        const raw = window.localStorage.getItem(MARKETPLACE_CACHE_STORAGE_KEY);
        if (!raw) return;
        const snapshot = JSON.parse(raw) as MarketplaceCacheSnapshot;
        const entries = isRecord(snapshot?.entries) ? snapshot.entries : {};
        Object.entries(entries).forEach(([key, value]) => {
            const entry = asMarketplaceCacheEntry(value);
            if (entry) skillMarketCache.set(key, entry);
        });
    } catch (error) {
        console.warn('Failed to read cached skill marketplace:', error);
    }
}

function persistSkillMarketCache() {
    if (typeof window === 'undefined') return;
    try {
        const entries: Record<string, MarketplaceCacheEntry> = {};
        skillMarketCache.forEach((entry, key) => {
            entries[key] = entry;
        });
        window.localStorage.setItem(
            MARKETPLACE_CACHE_STORAGE_KEY,
            JSON.stringify({ savedAt: Date.now(), entries }),
        );
    } catch (error) {
        console.warn('Failed to cache skill marketplace:', error);
    }
}

function setSkillMarketCacheEntry(key: string, entry: MarketplaceCacheEntry) {
    skillMarketCache.set(key, entry);
    persistSkillMarketCache();
}

function cachedMarketplaceEntry(cacheKey: string, marketId: string): MarketplaceCacheEntry | undefined {
    hydrateSkillMarketCache();
    const exact = skillMarketCache.get(cacheKey);
    if (exact) return exact;
    if (!marketId) return undefined;
    const all = skillMarketCache.get(ALL_MARKET_CACHE_KEY);
    if (!all) return undefined;
    return {
        sources: all.sources,
        items: all.items.filter((item) => item.marketId === marketId),
    };
}

function initialMarketplaceCache() {
    hydrateSkillMarketCache();
    return skillMarketCache.get(ALL_MARKET_CACHE_KEY);
}

function updateCachedMarketplaceItem(key: string, nextSkill: ThriveSkillMarketplaceItem) {
    let changed = false;
    skillMarketCache.forEach((entry, cacheKey) => {
        const nextItems = entry.items.map((item) => (
            marketItemKey(item) === key ? { ...item, ...nextSkill } : item
        ));
        if (nextItems.some((item, index) => item !== entry.items[index])) {
            changed = true;
            skillMarketCache.set(cacheKey, { ...entry, items: nextItems });
        }
    });
    if (changed) persistSkillMarketCache();
}

function runNextAvatarCacheRequest() {
    while (activeAvatarCacheRequests < MAX_AVATAR_CACHE_CONCURRENCY && queuedAvatarCacheRequests.length > 0) {
        const next = queuedAvatarCacheRequests.shift();
        if (next) next();
    }
}

function enqueueAvatarCacheRequest(task: () => Promise<string>): Promise<string> {
    return new Promise((resolve) => {
        queuedAvatarCacheRequests.push(() => {
            activeAvatarCacheRequests += 1;
            task()
                .then(resolve)
                .catch(() => resolve(''))
                .finally(() => {
                    activeAvatarCacheRequests = Math.max(0, activeAvatarCacheRequests - 1);
                    runNextAvatarCacheRequest();
                });
        });
        runNextAvatarCacheRequest();
    });
}

async function requestCachedAvatarDataUrl(url: string): Promise<string> {
    if (/^data:image\//i.test(url)) return url;
    if (typeof window === 'undefined') return '';
    const skillsBridge = window.ipcRenderer?.skills;
    if (!skillsBridge?.cacheMarketplaceAvatar) return '';
    const result = await skillsBridge.cacheMarketplaceAvatar<{ success?: boolean; dataUrl?: string; error?: string }>({ url });
    if (result?.success === false) return '';
    return typeof result?.dataUrl === 'string' ? result.dataUrl : '';
}

function loadCachedSkillAvatar(url: string): Promise<string> {
    const clean = String(url || '').trim();
    if (!clean) return Promise.resolve('');
    const cached = skillAvatarDataUrlCache.get(clean);
    if (cached) return Promise.resolve(cached);
    const inflight = skillAvatarRequestCache.get(clean);
    if (inflight) return inflight;
    const request = enqueueAvatarCacheRequest(() => requestCachedAvatarDataUrl(clean))
        .then((dataUrl) => {
            if (dataUrl) skillAvatarDataUrlCache.set(clean, dataUrl);
            return dataUrl;
        })
        .finally(() => {
            skillAvatarRequestCache.delete(clean);
        });
    skillAvatarRequestCache.set(clean, request);
    return request;
}

function skillInitials(name: string) {
    const clean = String(name || '').trim();
    if (!clean) return 'S';
    const words = clean.split(/[\s_-]+/).filter(Boolean);
    if (words.length >= 2) return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
    return clean.slice(0, 2).toUpperCase();
}

function SkillAvatar({ skill, size = 'list' }: { skill: ThriveSkillMarketplaceItem; size?: 'list' | 'detail' }) {
    const avatarUrl = skillAvatarUrl(skill);
    const [cachedAvatarUrl, setCachedAvatarUrl] = useState(() => skillAvatarDataUrlCache.get(avatarUrl) || '');
    const [failedUrl, setFailedUrl] = useState('');
    const imageUrl = cachedAvatarUrl;
    const showImage = imageUrl && failedUrl !== imageUrl;
    const sizeClass = size === 'detail' ? 'h-14 w-14 rounded-xl' : 'h-11 w-11 rounded-xl';
    const textClass = size === 'detail' ? 'text-base' : 'text-sm';

    useEffect(() => {
        let cancelled = false;
        setFailedUrl('');
        const cached = skillAvatarDataUrlCache.get(avatarUrl) || '';
        setCachedAvatarUrl(cached);
        if (!avatarUrl || cached) return;
        void loadCachedSkillAvatar(avatarUrl).then((dataUrl) => {
            if (!cancelled) setCachedAvatarUrl(dataUrl);
        });
        return () => {
            cancelled = true;
        };
    }, [avatarUrl]);

    return (
        <div className={clsx(
            'flex shrink-0 items-center justify-center overflow-hidden border border-border bg-surface-primary text-accent-primary shadow-[0_8px_22px_rgba(30,24,16,0.05)]',
            sizeClass
        )}>
            {showImage ? (
                <img
                    src={imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    onError={() => setFailedUrl(imageUrl)}
                />
            ) : (
                <span className={clsx('font-semibold leading-none', textClass)}>{skillInitials(skill.name)}</span>
            )}
        </div>
    );
}

function SkillTag({ children, active = false }: { children: ReactNode; active?: boolean }) {
    return (
        <span
            className={clsx(
                'inline-flex h-6 max-w-full items-center rounded-full border px-2.5 text-[11px] font-medium',
                active
                    ? 'border-accent-primary bg-accent-primary text-[rgb(var(--color-primary-text))]'
                    : 'border-border bg-surface-primary/70 text-text-secondary'
            )}
        >
            <span className="truncate">{children}</span>
        </span>
    );
}

function EmptyPanel({ title, action }: { title: string; action?: ReactNode }) {
    return (
        <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed border-border bg-surface-primary/45 text-center">
            <div className="space-y-3 px-6">
                <FileText className="mx-auto h-9 w-9 text-text-tertiary" strokeWidth={1.6} />
                <div className="text-sm font-medium text-text-secondary">{title}</div>
                {action}
            </div>
        </div>
    );
}

type SkillsProps = {
    isActive?: boolean;
    onTrySkillInChat?: (message: PendingChatMessage) => void;
};

export function Skills({ isActive = true, onTrySkillInChat }: SkillsProps) {
    const initialMarketCache = initialMarketplaceCache();
    const selectedMarketIdRef = useRef('');
    const [marketItems, setMarketItems] = useState<ThriveSkillMarketplaceItem[]>(() => initialMarketCache?.items || []);
    const [marketSources, setMarketSources] = useState<SkillMarketSource[]>(() => initialMarketCache?.sources || []);
    const [selectedMarketId, setSelectedMarketId] = useState('');
    const [selectedTag, setSelectedTag] = useState('');
    const [query, setQuery] = useState('');
    const [isMarketLoading, setIsMarketLoading] = useState(() => !initialMarketCache);
    const [busyMarketItemId, setBusyMarketItemId] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [sourcesOpen, setSourcesOpen] = useState(false);
    const [selectedSkill, setSelectedSkill] = useState<ThriveSkillMarketplaceItem | null>(null);
    const [selectedSkillDetail, setSelectedSkillDetail] = useState<MarketplacePackageDetail | null>(null);
    const [isSkillDetailLoading, setIsSkillDetailLoading] = useState(false);
    const marketRequestRef = useRef(0);
    const detailRequestRef = useRef(0);

    const marketItemCountBySource = useMemo(() => {
        const counts = new Map<string, number>();
        marketItems.forEach((item) => {
            const sourceId = item.marketId || '';
            if (!sourceId) return;
            counts.set(sourceId, (counts.get(sourceId) || 0) + 1);
        });
        return counts;
    }, [marketItems]);

    const tags = useMemo(() => {
        const counts = new Map<string, number>();
        marketItems.forEach((item) => {
            (item.tags || []).forEach((tag) => {
                const normalized = String(tag || '').trim();
                if (!normalized) return;
                counts.set(normalized, (counts.get(normalized) || 0) + 1);
            });
        });
        return [...counts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 10)
            .map(([tag]) => tag);
    }, [marketItems]);

    const filteredMarketItems = useMemo(() => {
        const normalizedQuery = normalizeKey(query);
        return marketItems.filter((item) => {
            const sourceMatches = !selectedMarketId || item.marketId === selectedMarketId;
            const tagMatches = !selectedTag || (item.tags || []).some((tag) => normalizeKey(tag) === normalizeKey(selectedTag));
            const queryMatches = !normalizedQuery || [
                item.name,
                item.author,
                item.description,
                item.repo,
                item.packageId,
                item.id,
                ...(item.tags || []),
            ].some((value) => normalizeKey(value).includes(normalizedQuery));
            return sourceMatches && tagMatches && queryMatches;
        });
    }, [marketItems, query, selectedMarketId, selectedTag]);

    const selectedSource = useMemo(
        () => marketSources.find((source) => source.id === selectedMarketId) || null,
        [marketSources, selectedMarketId],
    );

    const hasFocusedFilters = Boolean(query.trim() || selectedMarketId || selectedTag);
    const primaryMarketItems = hasFocusedFilters ? filteredMarketItems : filteredMarketItems.slice(0, 6);
    const secondaryMarketItems = hasFocusedFilters ? [] : filteredMarketItems.slice(6);
    const primarySectionTitle = hasFocusedFilters
        ? (selectedTag || selectedSource?.name || '搜索结果')
        : '精选';

    const loadMarketplace = useCallback(async (marketId = '', options: { force?: boolean } = {}) => {
        const requestId = marketRequestRef.current + 1;
        marketRequestRef.current = requestId;
        const cacheKey = marketId || ALL_MARKET_CACHE_KEY;
        const cached = cachedMarketplaceEntry(cacheKey, marketId);
        if (cached) {
            setMarketSources(cached.sources);
            setMarketItems(cached.items);
            setStatusMessage('');
            setIsMarketLoading(false);
        }
        const showLoading = options.force || !cached;
        if (showLoading) setIsMarketLoading(true);
        try {
            const result = await window.ipcRenderer.skills.marketplace({
                marketId: marketId || undefined,
            });
            if (requestId !== marketRequestRef.current) return;
            if (result.success === false) {
                throw new Error(result.error || '技能市场加载失败');
            }
            const sources = Array.isArray(result.sources) ? result.sources : [];
            const items = Array.isArray(result.items) ? result.items : Array.isArray(result.skills) ? result.skills : [];
            setSkillMarketCacheEntry(cacheKey, { sources, items });
            setMarketSources(sources);
            setMarketItems(items);
            setStatusMessage('');
        } catch (error) {
            console.error('Failed to load skill marketplace:', error);
            if (requestId === marketRequestRef.current && showLoading) {
                setStatusMessage(error instanceof Error ? error.message : '技能市场加载失败');
            }
        } finally {
            if (requestId === marketRequestRef.current) {
                setIsMarketLoading(false);
            }
        }
    }, []);

    const refreshAll = useCallback(async (force = false) => {
        await loadMarketplace(selectedMarketId, { force });
    }, [loadMarketplace, selectedMarketId]);

    useEffect(() => {
        selectedMarketIdRef.current = selectedMarketId;
    }, [selectedMarketId]);

    useEffect(() => {
        if (!isActive) return;
        void loadMarketplace(selectedMarketIdRef.current);
    }, [isActive, loadMarketplace]);

    const handleSelectMarketSource = useCallback((marketId: string) => {
        setSelectedMarketId(marketId);
        void loadMarketplace(marketId);
    }, [loadMarketplace]);

    const handleOpenSkillHome = useCallback(async (skill: ThriveSkillMarketplaceItem) => {
        const key = marketItemKey(skill);
        setSelectedSkill(skill);
        setSelectedSkillDetail(skillDetailCache.get(key) || null);
        setStatusMessage('');

        const cached = skillDetailCache.get(key);
        if (cached) return;

        const requestId = detailRequestRef.current + 1;
        detailRequestRef.current = requestId;
        setIsSkillDetailLoading(true);
        try {
            const detail = await window.ipcRenderer.skills.readMarketplacePackage<MarketplacePackageResponse>({
                id: skill.id,
                packageId: skill.packageId,
                marketId: skill.marketId,
            });
            if (requestId !== detailRequestRef.current) return;
            if (detail.success === false) {
                throw new Error(detail.error || '技能主页加载失败');
            }
            const normalized: MarketplacePackageDetail = {
                item: detail.item,
                manifest: detail.manifest,
            };
            skillDetailCache.set(key, normalized);
            setSelectedSkillDetail(normalized);
        } catch (error) {
            console.error('Failed to load marketplace skill detail:', error);
            if (requestId === detailRequestRef.current) {
                setStatusMessage(error instanceof Error ? error.message : '技能主页加载失败');
                setSelectedSkillDetail({ item: skill, manifest: null });
            }
        } finally {
            if (requestId === detailRequestRef.current) {
                setIsSkillDetailLoading(false);
            }
        }
    }, []);

    const handleCloseSkillHome = useCallback(() => {
        detailRequestRef.current += 1;
        setSelectedSkill(null);
        setSelectedSkillDetail(null);
        setIsSkillDetailLoading(false);
        setStatusMessage('');
    }, []);

    const handleInstallMarketplaceSkill = useCallback(async (skill: ThriveSkillMarketplaceItem) => {
        const key = marketItemKey(skill);
        setBusyMarketItemId(key);
        setStatusMessage(`正在安装 ${skill.name}`);
        try {
            const result = await window.ipcRenderer.skills.marketInstall({
                id: skill.id,
                packageId: skill.packageId,
                marketId: skill.marketId,
                repo: skill.repo || undefined,
                refName: skill.refName || undefined,
                paths: skill.paths,
            }) as SkillMarketplaceInstallResponse;
            if (result.success === false) {
                throw new Error(result.error || '技能安装失败');
            }
            if (result.activationReady === false) {
                throw new Error(result.error || '技能已安装但暂未完成激活');
            }
            const readySkill = result.verified?.find((item) => item.activationReady);
            const installedName = readySkill?.name || result.installed?.[0]?.name || skill.name;
            const installedSkillNames = Array.from(new Set([
                ...(result.verified || [])
                    .filter((item) => item.activationReady)
                    .map((item) => item.name),
                ...(result.installed || []).map((item) => item.name || ''),
                ...(skill.installedSkillNames || []),
            ].map((name) => String(name || '').trim()).filter(Boolean)));
            const installedSkill = {
                ...skill,
                installed: true,
                installedSkillNames,
                installedVersion: skill.version || skill.installedVersion,
                updateAvailable: false,
            };
            updateCachedMarketplaceItem(key, installedSkill);
            skillDetailCache.delete(key);
            setMarketItems((items) => items.map((item) => marketItemKey(item) === key ? installedSkill : item));
            setSelectedSkill((current) => current && marketItemKey(current) === key ? installedSkill : current);
            setSelectedSkillDetail((current) => current ? {
                ...current,
                item: installedSkill,
            } : current);
            setStatusMessage(`已安装 ${installedName}`);
            await refreshAll(false);
        } catch (error) {
            console.error('Failed to install marketplace skill:', error);
            setStatusMessage(error instanceof Error ? error.message : '技能安装失败');
        } finally {
            setBusyMarketItemId('');
        }
    }, [refreshAll]);

    const handleTryMarketplaceSkill = useCallback((skill: ThriveSkillMarketplaceItem) => {
        if (!onTrySkillInChat) return;
        const displayName = String(skill.name || skill.packageId || skill.id || '').trim();
        const skillNames = skillRuntimeNameCandidates(skill);
        const primarySkillName = skillNames[0] || displayName;
        if (!displayName || !primarySkillName) return;
        onTrySkillInChat({
            content: '',
            displayContent: `试用「${displayName}」`,
            sessionRouting: 'new',
            deliveryMode: 'draft',
            skillMentions: [
                {
                    name: primarySkillName,
                    description: skill.description || undefined,
                },
            ],
            taskHints: {
                activeSkills: skillNames.length > 0 ? skillNames : [primarySkillName],
                requiredSkill: primarySkillName,
                initialContext: [
                    '用户从技能市场点击“在对话中试用”。',
                    `技能市场名称：${displayName}`,
                    `运行时技能候选：${(skillNames.length > 0 ? skillNames : [primarySkillName]).join(', ')}`,
                    `包 ID：${skill.packageId || skill.id || ''}`,
                ].join('\n'),
            } as PendingChatMessage['taskHints'],
        });
    }, [onTrySkillInChat]);

    const renderMarketItem = (skill: ThriveSkillMarketplaceItem) => {
        const key = marketItemKey(skill);
        const installed = Boolean(skill.installed);
        return (
            <button
                key={key}
                type="button"
                onClick={() => void handleOpenSkillHome(skill)}
                className="group flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-primary/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/35"
            >
                <SkillAvatar skill={skill} />
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-text-primary">{skill.name}</h3>
                        {installed && (
                            <span className="shrink-0 rounded-full bg-status-success/10 px-1.5 py-0.5 text-[10px] font-medium text-status-success">已安装</span>
                        )}
                        {skill.updateAvailable && (
                            <span className="shrink-0 rounded-full bg-accent-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-primary">可更新</span>
                        )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-tertiary">
                        {skill.description || skill.repo || '暂无描述'}
                    </p>
                </div>
            </button>
        );
    };

    const renderMarketSection = (title: string, items: ThriveSkillMarketplaceItem[], countLabel?: string) => {
        if (items.length === 0) return null;
        return (
            <section className="space-y-3">
                <div className="flex items-end justify-between gap-3 border-b border-divider pb-3">
                    <h2 className="text-base font-semibold text-text-primary">{title}</h2>
                    <span className="text-xs text-text-tertiary">{countLabel || `${items.length} 个技能`}</span>
                </div>
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-2">
                    {items.map(renderMarketItem)}
                </div>
            </section>
        );
    };

    const visibleStatusMessage = statusMessage && !statusMessage.startsWith('已') && !statusMessage.startsWith('正在')
        ? statusMessage
        : '';

    const renderSkillHome = () => {
        if (!selectedSkill) return null;
        const detailItem = selectedSkillDetail?.item || selectedSkill;
        const manifest = selectedSkillDetail?.manifest;
        const detailSource = marketSources.find((source) => source.id === detailItem.marketId);
        const sourceLabel = detailItem.marketName || detailSource?.name || detailItem.sourceKind || '市场';
        const homepageHref = manifestText(manifest, ['homepageUrl', 'homepage', 'website', 'url']);
        const href = /^https?:\/\//i.test(homepageHref) ? homepageHref : repoHref(detailItem.repo);
        const detailText = manifestText(manifest, ['summary', 'details', 'readme', 'contextNote', 'promptPrefix']);
        const manifestModes = manifestList(manifest, ['allowedRuntimeModes', 'runtimeModes', 'modes']);
        const skillPaths = Array.isArray(detailItem.paths) ? detailItem.paths : [];
        const detailKey = marketItemKey(detailItem);
        const detailBusy = busyMarketItemId === detailKey;
        const detailInstalled = Boolean(detailItem.installed);
        const canInstall = detailItem.installable !== false && (!detailInstalled || Boolean(detailItem.updateAvailable));
        const canTryInChat = detailInstalled && !detailItem.updateAvailable && Boolean(onTrySkillInChat);
        const details = [
            ['来源', sourceLabel],
            ['作者', detailItem.author],
            ['版本', detailItem.version ? `v${detailItem.version}` : ''],
            ['包 ID', detailItem.packageId || detailItem.id],
            ['类型', detailItem.kind],
            ['运行模式', manifestModes.join(' / ')],
        ].filter(([, value]) => String(value || '').trim());

        return (
            <div className="space-y-7 pb-10">
                <button
                    type="button"
                    onClick={handleCloseSkillHome}
                    className="inline-flex h-8 items-center gap-2 rounded-full px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
                >
                    <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
                    返回
                </button>

                <section className="space-y-5 border-b border-divider pb-6">
                    <div className="flex items-start gap-4">
                        <SkillAvatar skill={detailItem} size="detail" />
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <h1 className="min-w-0 text-[26px] font-semibold leading-tight text-text-primary">{detailItem.name}</h1>
                                {detailItem.installed && (
                                    <span className="rounded-full bg-status-success/10 px-2 py-0.5 text-[11px] font-medium text-status-success">已安装</span>
                                )}
                                {detailItem.updateAvailable && (
                                    <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[11px] font-medium text-accent-primary">可更新</span>
                                )}
                            </div>
                            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-tertiary">
                                {detailItem.description || detailText || '暂无描述'}
                            </p>
                            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
                                <SkillTag>{sourceLabel}</SkillTag>
                                {detailItem.version ? <SkillTag>{`v${detailItem.version}`}</SkillTag> : null}
                                {(detailItem.tags || []).map((tag) => (
                                    <SkillTag key={`${marketItemKey(detailItem)}:${tag}`}>{tag}</SkillTag>
                                ))}
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {href ? (
                                <a
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
                                >
                                    <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.7} />
                                    来源
                                </a>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => {
                                    if (canTryInChat) {
                                        handleTryMarketplaceSkill(detailItem);
                                        return;
                                    }
                                    void handleInstallMarketplaceSkill(detailItem);
                                }}
                                disabled={detailBusy || (!canInstall && !canTryInChat)}
                                className={clsx(
                                    'inline-flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                                    canTryInChat ? 'min-w-[7.25rem]' : 'min-w-[4.25rem]',
                                    detailInstalled && !detailItem.updateAvailable && !canTryInChat
                                        ? 'border-border bg-surface-primary text-text-tertiary'
                                        : 'border-accent-primary bg-accent-primary text-[rgb(var(--color-primary-text))] hover:bg-accent-hover'
                                )}
                            >
                                {detailBusy ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : canTryInChat ? (
                                    <MessageCircle className="h-3.5 w-3.5" />
                                ) : (
                                    <Download className="h-3.5 w-3.5" />
                                )}
                                {detailBusy ? '安装中' : canTryInChat ? '在对话中试用' : detailItem.updateAvailable ? '更新' : detailInstalled ? '已安装' : '安装'}
                            </button>
                        </div>
                    </div>

                    {visibleStatusMessage && (
                        <div className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error">
                            {visibleStatusMessage}
                        </div>
                    )}
                </section>

                {isSkillDetailLoading ? (
                    <div className="flex min-h-[160px] items-center justify-center text-sm text-text-tertiary">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        正在读取技能主页
                    </div>
                ) : (
                    <div className="space-y-7">
                        {detailText && detailText !== detailItem.description ? (
                            <section className="space-y-2">
                                <h2 className="text-sm font-semibold text-text-primary">说明</h2>
                                <p className="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{detailText}</p>
                            </section>
                        ) : null}

                        <section className="grid gap-x-10 gap-y-4 border-t border-divider pt-5 sm:grid-cols-2">
                            {details.map(([label, value]) => (
                                <div key={label} className="min-w-0">
                                    <div className="text-[11px] font-medium text-text-tertiary">{label}</div>
                                    <div className="mt-1 break-words text-sm text-text-primary">{value}</div>
                                </div>
                            ))}
                            {skillPaths.length > 0 ? (
                                <div className="min-w-0 sm:col-span-2">
                                    <div className="text-[11px] font-medium text-text-tertiary">技能路径</div>
                                    <div className="mt-1 space-y-1">
                                        {skillPaths.map((path) => (
                                            <div key={path} className="break-all font-mono text-xs text-text-secondary">{path}</div>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    </div>
                )}
            </div>
        );
    };

    if (selectedSkill) {
        return (
            <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-text-primary">
                <div className="min-h-0 flex-1 overflow-y-auto px-10 py-10 sm:px-16 lg:px-24 xl:px-32 custom-scrollbar">
                    <div className="mx-auto w-full max-w-[880px]">
                        {renderSkillHome()}
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-text-primary">
            <div className="min-h-0 flex-1 overflow-y-auto px-10 py-10 sm:px-16 lg:px-24 xl:px-32 custom-scrollbar">
                <div className="mx-auto w-full max-w-[880px] space-y-9">
                    <header className="space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="relative min-w-0 flex-1">
                                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" strokeWidth={1.7} />
                                <input
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    placeholder="搜索技能"
                                    className="h-11 w-full rounded-full border border-border bg-surface-primary/70 pl-11 pr-4 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-primary focus:ring-4 focus:ring-accent-primary/10"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => void refreshAll(true)}
                                disabled={isMarketLoading}
                                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-surface-primary/70 text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary disabled:opacity-50"
                                aria-label="刷新技能市场"
                                title="刷新"
                            >
                                <RefreshCw className={clsx('h-4 w-4', isMarketLoading && 'animate-spin')} />
                            </button>
                        </div>

                        {visibleStatusMessage && (
                            <div className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error">
                                {visibleStatusMessage}
                            </div>
                        )}
                    </header>

                    <section className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => handleSelectMarketSource('')}
                                className={clsx(
                                    'inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors',
                                    !selectedMarketId
                                        ? 'bg-accent-primary text-[rgb(var(--color-primary-text))]'
                                        : 'text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                                )}
                            >
                                全部来源
                                <span className="opacity-75">{marketItems.length}</span>
                            </button>
                            {marketSources.map((source) => (
                                <button
                                    key={source.id}
                                    type="button"
                                    onClick={() => handleSelectMarketSource(source.id)}
                                    className={clsx(
                                        'inline-flex h-8 max-w-[180px] items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors',
                                        selectedMarketId === source.id
                                            ? 'bg-accent-primary text-[rgb(var(--color-primary-text))]'
                                            : 'text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                                    )}
                                >
                                    <span className="truncate">{source.name}</span>
                                    <span className="shrink-0 opacity-75">{marketItemCountBySource.get(source.id) || 0}</span>
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={() => setSourcesOpen((value) => !value)}
                                className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-primary hover:text-text-primary"
                                aria-label="查看市场来源"
                                title="来源"
                            >
                                <ChevronDown className={clsx('h-4 w-4 transition-transform', !sourcesOpen && '-rotate-90')} />
                            </button>
                        </div>

                        {tags.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setSelectedTag('')}
                                    className={clsx(
                                        'inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors',
                                        !selectedTag
                                            ? 'bg-surface-primary text-text-primary shadow-[inset_0_0_0_1px_rgb(var(--color-border))]'
                                            : 'text-text-tertiary hover:bg-surface-primary hover:text-text-primary'
                                    )}
                                >
                                    全部标签
                                </button>
                                {tags.map((tag) => (
                                    <button
                                        key={tag}
                                        type="button"
                                        onClick={() => setSelectedTag(tag)}
                                        className={clsx(
                                            'inline-flex h-7 max-w-[150px] items-center rounded-full px-2.5 text-[11px] font-medium transition-colors',
                                            selectedTag === tag
                                                ? 'bg-surface-primary text-text-primary shadow-[inset_0_0_0_1px_rgb(var(--color-border))]'
                                                : 'text-text-tertiary hover:bg-surface-primary hover:text-text-primary'
                                        )}
                                    >
                                        <span className="truncate">{tag}</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {sourcesOpen && (
                            <div className="grid gap-2 rounded-xl border border-border bg-surface-primary/35 p-3 sm:grid-cols-2 lg:grid-cols-3">
                                {marketSources.length === 0 ? (
                                    <div className="text-xs text-text-tertiary">暂无市场来源</div>
                                ) : marketSources.map((source) => (
                                    <div key={source.id} className="min-w-0 rounded-lg border border-border bg-surface-primary/65 px-3 py-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className={clsx('h-2 w-2 shrink-0 rounded-full', source.enabled ? 'bg-status-success' : 'bg-text-tertiary')} />
                                            <span className="truncate text-xs font-semibold text-text-primary">{source.name}</span>
                                            <span className="shrink-0 rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                                                {source.trustLevel || source.kind}
                                            </span>
                                        </div>
                                        <div className="mt-1 truncate font-mono text-[10px] text-text-tertiary">
                                            {source.repo || source.source || source.registryUrl || source.id}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    <div className="space-y-10 pb-10">
                        {isMarketLoading && marketItems.length === 0 ? (
                            <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface-primary/45 text-sm text-text-tertiary">
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                正在读取市场
                            </div>
                        ) : filteredMarketItems.length === 0 ? (
                            <EmptyPanel title="没有找到匹配的技能" />
                        ) : (
                            <>
                                {renderMarketSection(primarySectionTitle, primaryMarketItems, `${filteredMarketItems.length} 个技能`)}
                                {renderMarketSection('更多技能', secondaryMarketItems)}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}
