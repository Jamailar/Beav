import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Download,
    ExternalLink,
    FileText,
    Loader2,
    MessageCircle,
    PackagePlus,
    PlayCircle,
    RefreshCw,
    Search,
    Settings as SettingsIcon,
    Trash2,
    X,
} from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import xiaohongshuPlatformIcon from '../../../Plugin/src/assets/platforms/xiaohongshu.svg';
import type { PendingChatMessage, SkillsNavigationTarget } from '../features/app-shell/types';
import { type SettingsSkill, formatSettingsSkillSource } from '../features/settings/settingsModel';
import type { SkillMarketCollection, SkillMarketIntroNote, SkillMarketSource, SkillMarketplaceInstallResponse, ThriveSkillMarketplaceItem } from '../types';
import { appConfirm } from '../utils/appDialogs';
import { SAFE_REMARK_PLUGINS } from '../utils/markdownRemarkPlugins';

const normalizeKey = (value: unknown) => String(value || '').trim().toLowerCase();

const marketItemKey = (skill: ThriveSkillMarketplaceItem) => (
    `${skill.marketId || 'market'}:${skill.packageId || skill.id || skill.name}`
);

type MarketplaceCacheEntry = {
    sources: SkillMarketSource[];
    collections: SkillMarketCollection[];
    items: ThriveSkillMarketplaceItem[];
};

type MarketplaceCacheSnapshot = {
    savedAt?: number;
    entries?: Record<string, MarketplaceCacheEntry>;
};

type MarketplaceDetailCacheSnapshot = {
    savedAt?: number;
    entries?: Record<string, MarketplacePackageDetail & { savedAt?: number }>;
};

type MarketplacePackageDetail = {
    item?: ThriveSkillMarketplaceItem;
    manifest?: unknown;
    skillMarkdown?: string;
};

type MarketplacePackageResponse = MarketplacePackageDetail & {
    success?: boolean;
    error?: string;
};

type SkillAuthorProfile = {
    key: string;
    name: string;
    avatarUrl: string;
    homepageUrl: string;
    homepageLabel: string;
    bio: string;
    skills: ThriveSkillMarketplaceItem[];
};

type SkillSubmissionForm = {
    name: string;
    url: string;
    description: string;
    contact: string;
};

const ALL_MARKET_CACHE_KEY = '__all__';
const MARKETPLACE_CACHE_STORAGE_KEY = 'redbox:skill-marketplace-cache:v2';
const MARKETPLACE_DETAIL_CACHE_STORAGE_KEY = 'redbox:skill-marketplace-detail-cache:v1';
const MAX_SKILL_DETAIL_CACHE_ENTRIES = 36;
const MAX_AVATAR_CACHE_CONCURRENCY = 4;
const RETIRED_SKILL_MARKET_SOURCE_IDS = new Set(['thrive-community']);
const RED_SKILL_TAG_LABEL = 'RED skill';
const CATEGORY_SECTION_PREVIEW_ITEMS = 6;
const SKILL_CATEGORY_LABELS = [
    '调研与选题',
    '热点追踪',
    '文案风格',
    '脚本优化',
    '图片制作',
    '视频制作',
] as const;
const SKILL_CATEGORY_KEYS = new Set<string>(SKILL_CATEGORY_LABELS.map(normalizeKey));
const skillMarketCache = new Map<string, MarketplaceCacheEntry>();
const skillDetailCache = new Map<string, MarketplacePackageDetail>();
const skillAvatarDataUrlCache = new Map<string, string>();
const skillAvatarRequestCache = new Map<string, Promise<string>>();
let skillMarketCacheHydrated = false;
let skillDetailCacheHydrated = false;
let activeAvatarCacheRequests = 0;
const queuedAvatarCacheRequests: Array<() => void> = [];

function emptySkillSubmissionForm(): SkillSubmissionForm {
    return {
        name: '',
        url: '',
        description: '',
        contact: '',
    };
}

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

function isHttpUrl(value?: string | null) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function httpsAssetUrl(value?: string | null) {
    const clean = String(value || '').trim();
    if (!clean) return '';
    return clean.replace(/^http:\/\//i, 'https://');
}

function recordText(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function recordList(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function uniqueAssetUrls(values: string[]) {
    const seen = new Set<string>();
    const output: string[] = [];
    values.forEach((value) => {
        const url = httpsAssetUrl(value);
        if (!isHttpUrl(url) || seen.has(url)) return;
        seen.add(url);
        output.push(url);
    });
    return output;
}

function recordNumber(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const parsed = Number(value.replace(/,/g, '').trim());
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

function selectPlayableIntroVideoUrl(video: unknown) {
    if (!isRecord(video)) return '';
    const direct = recordText(video, [
        'playbackUrl',
        'playback_url',
        'ossUrl',
        'oss_url',
        'fileUrl',
        'file_url',
    ]);
    if (isHttpUrl(direct) || direct.startsWith('/uploads/')) return httpsAssetUrl(direct);

    const candidates: Array<{ url: string; score: number }> = [];
    const pushCandidate = (url: unknown, score = 0) => {
        const clean = String(url || '').trim();
        if (!isHttpUrl(clean) && !clean.startsWith('/uploads/')) return;
        const lower = clean.toLowerCase();
        let nextScore = score;
        if (lower.includes('/259/') || lower.includes('h264') || lower.includes('x264')) nextScore += 40;
        if (lower.includes('/309/') || lower.includes('h265') || lower.includes('x265') || lower.includes('hevc')) nextScore -= 20;
        if (lower.includes('.mp4')) nextScore += 10;
        candidates.push({ url: clean, score: nextScore });
    };

    const streams = Array.isArray(video.streams) ? video.streams : [];
    streams.forEach((rawStream) => {
        if (!isRecord(rawStream)) return;
        const codec = String(rawStream.codec || rawStream.video_codec || rawStream.videoCodec || '').toLowerCase();
        const streamType = String(rawStream.stream_type || rawStream.streamType || '').trim();
        let score = 20;
        if (codec.includes('264') || streamType === '259') score += 40;
        if (codec.includes('265') || codec.includes('hevc') || streamType === '309') score -= 20;
        pushCandidate(rawStream.master_url || rawStream.masterUrl, score);
        recordList(rawStream.backup_urls || rawStream.backupUrls).forEach((url) => pushCandidate(url, score - 5));
    });

    recordList(video.urls).forEach((url) => pushCandidate(url, 0));
    pushCandidate(video.first_url || video.firstUrl, -10);
    pushCandidate(video.source_url || video.sourceUrl, -20);

    const seen = new Set<string>();
    return httpsAssetUrl(candidates
        .filter((item) => {
            if (seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
        })
        .sort((left, right) => right.score - left.score)[0]?.url || '');
}

function formatIntroCount(value: number | null) {
    if (value === null) return '';
    if (value >= 10000) {
        const compact = (value / 10000).toFixed(value >= 100000 ? 0 : 1).replace(/\.0$/, '');
        return `${compact}万`;
    }
    return value.toLocaleString('zh-CN');
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
        skill.authorAvatarUrl,
        githubOwnerAvatarUrl(skill.repo),
    ].map((value) => String(value || '').trim()).find(Boolean) || '';
}

function redSkillKey(value: unknown) {
    return normalizeKey(value).replace(/[\s_-]+/g, '');
}

function isRedSkillTag(value: unknown) {
    return redSkillKey(value) === 'redskill';
}

function isRedSkillText(value: unknown) {
    return redSkillKey(value).includes('redskill');
}

function isRedSkillMarketplaceItem(skill: ThriveSkillMarketplaceItem) {
    return (skill.tags || []).some(isRedSkillTag)
        || isRedSkillText(skill.marketName)
        || isRedSkillText(skill.marketId)
        || isRedSkillText(skill.sourceKind);
}

function skillCategoryLabel(value: unknown) {
    const normalized = normalizeKey(value);
    return SKILL_CATEGORY_LABELS.find((category) => normalizeKey(category) === normalized) || '';
}

function pushUniqueTag(tags: string[], value: unknown) {
    const clean = String(value || '').trim();
    if (!clean) return;
    if (tags.some((tag) => normalizeKey(tag) === normalizeKey(clean))) return;
    tags.push(clean);
}

function prioritizeSkillCategoryTags(tags: string[]) {
    const categories: string[] = [];
    const rest: string[] = [];
    tags.forEach((tag) => {
        const category = skillCategoryLabel(tag);
        if (category) {
            pushUniqueTag(categories, category);
            return;
        }
        pushUniqueTag(rest, tag);
    });
    return [...categories, ...rest];
}

function skillDisplayTags(skill: ThriveSkillMarketplaceItem) {
    const tags: string[] = [];
    (skill.tags || []).forEach((tag) => {
        if (isRedSkillTag(tag)) {
            return;
        }
        pushUniqueTag(tags, tag);
    });
    const orderedTags = prioritizeSkillCategoryTags(tags);
    if (isRedSkillMarketplaceItem(skill)) {
        return [RED_SKILL_TAG_LABEL, ...orderedTags.filter((tag) => !isRedSkillTag(tag))];
    }
    return orderedTags;
}

function skillCategories(skill: ThriveSkillMarketplaceItem) {
    const categories: string[] = [];
    skillDisplayTags(skill).forEach((tag) => {
        const category = skillCategoryLabel(tag);
        if (!category || categories.includes(category)) return;
        categories.push(category);
    });
    return categories;
}

function primarySkillCategory(skill: ThriveSkillMarketplaceItem) {
    return skillCategories(skill)[0] || '';
}

function skillMatchesCategory(skill: ThriveSkillMarketplaceItem, category: string) {
    const selected = skillCategoryLabel(category);
    if (!selected) return true;
    return skillCategories(skill).includes(selected);
}

function skillAuthorName(skill: ThriveSkillMarketplaceItem) {
    return String(skill.author || '').trim();
}

function skillAuthorHref(skill: ThriveSkillMarketplaceItem) {
    const href = String(skill.authorHomepageUrl || '').trim();
    return isHttpUrl(href) ? href : '';
}

function skillIntroNote(skill: ThriveSkillMarketplaceItem) {
    return skill.introNote || skill.intro_note || null;
}

function normalizeInstalledSkills(value: unknown): SettingsSkill[] {
    const normalized = (Array.isArray(value) ? value : [])
        .map((skill): SettingsSkill | null => {
            if (!isRecord(skill)) return null;
            const name = String(skill.name || '').trim();
            if (!name) return null;
            const sourceScope = String(skill.sourceScope || '').trim() || undefined;
            return {
                name,
                description: String(skill.description || '').trim(),
                location: String(skill.location || '').trim(),
                sourceScope,
                isBuiltin: Boolean(skill.isBuiltin || sourceScope === 'builtin'),
                disabled: Boolean(skill.disabled),
            };
        })
        .filter((skill): skill is SettingsSkill => Boolean(skill));
    normalized.sort((left, right) => {
        const leftBuiltIn = left.isBuiltin ? 0 : 1;
        const rightBuiltIn = right.isBuiltin ? 0 : 1;
        return leftBuiltIn - rightBuiltIn || left.name.localeCompare(right.name);
    });
    return normalized;
}

function collectionKey(collection: SkillMarketCollection) {
    return String(collection.collectionKey || collection.collection_key || collection.id || collection.title || '').trim();
}

function collectionPackageKeys(collection: SkillMarketCollection) {
    const values = Array.isArray(collection.packageKeys)
        ? collection.packageKeys
        : Array.isArray(collection.package_keys)
            ? collection.package_keys
            : [];
    return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function isRedSkillMarketplaceCollection(collection: SkillMarketCollection) {
    return [
        collection.collectionKey,
        collection.collection_key,
        collection.id,
        collection.marketId,
        collection.marketName,
        collection.sourceKind,
        collection.title,
        collection.subtitle,
        collection.description,
        collection.author,
    ].some(isRedSkillText);
}

function collectionImageUrl(collection: SkillMarketCollection) {
    const explicitImageUrl = String(collection.avatarUrl || collection.avatar_url || collection.coverUrl || collection.cover_url || '').trim();
    if (explicitImageUrl) return explicitImageUrl;
    return isRedSkillMarketplaceCollection(collection) ? xiaohongshuPlatformIcon : '';
}

function collectionTitle(collection: SkillMarketCollection) {
    return String(collection.title || collection.collectionKey || collection.collection_key || collection.id || '技能合集').trim();
}

type SkillIntroNoteView = {
    title: string;
    contentText: string;
    noteHref: string;
    noteType: string;
    coverUrl: string;
    images: string[];
    playbackUrl: string;
    authorName: string;
    authorAvatarUrl: string;
    tags: string[];
    stats: Array<{ label: string; value: string }>;
};

function normalizeSkillIntroNote(note?: SkillMarketIntroNote | null): SkillIntroNoteView | null {
    if (!isRecord(note)) return null;
    const title = recordText(note, ['title']);
    const contentText = recordText(note, ['contentText', 'content_text']);
    const noteUrl = recordText(note, ['resolvedNoteUrl', 'resolved_note_url', 'noteUrl', 'note_url']);
    const noteHref = isHttpUrl(noteUrl) ? noteUrl : '';
    const noteType = recordText(note, ['noteType', 'note_type']);
    const images = uniqueAssetUrls([
        recordText(note, ['coverUrl', 'cover_url']),
        ...recordList(note.images),
    ]);
    const playbackUrl = selectPlayableIntroVideoUrl(note.video);
    const coverUrl = images[0] || '';
    const authorName = recordText(note, ['authorName', 'author_name']);
    const authorAvatarUrl = httpsAssetUrl(recordText(note, ['authorAvatarUrl', 'author_avatar_url']));
    const tags = recordList(note.tags);
    const statsRecord = isRecord(note.stats) ? note.stats : {};
    const statItems = [
        ['赞', recordNumber(statsRecord, ['likedCount', 'liked_count'])],
        ['收藏', recordNumber(statsRecord, ['collectedCount', 'collected_count'])],
        ['评论', recordNumber(statsRecord, ['commentCount', 'comment_count'])],
        ['分享', recordNumber(statsRecord, ['shareCount', 'share_count'])],
    ] as const;
    const stats = statItems
        .map(([label, value]) => ({ label, value: formatIntroCount(value) }))
        .filter((item) => item.value);
    if (!title && !contentText && !coverUrl && !playbackUrl && !noteHref) return null;
    return {
        title,
        contentText,
        noteHref,
        noteType,
        coverUrl,
        images,
        playbackUrl,
        authorName,
        authorAvatarUrl,
        tags,
        stats,
    };
}

async function openExternalHttpUrl(value: string) {
    const href = String(value || '').trim();
    if (!isHttpUrl(href)) return;
    try {
        const result = await window.ipcRenderer.openExternalUrl(href);
        if (result?.success === false) {
            throw new Error(result.error || 'openExternalUrl failed');
        }
    } catch (error) {
        console.warn('Failed to open external url:', error);
        window.open(href, '_blank', 'noopener,noreferrer');
    }
}

function skillAuthorKey(skill: ThriveSkillMarketplaceItem) {
    const href = skillAuthorHref(skill);
    if (href) return `url:${normalizeKey(href)}`;
    const name = skillAuthorName(skill);
    if (name) return `name:${normalizeKey(name)}`;
    return '';
}

function firstText(values: unknown[]) {
    return values
        .map((value) => String(value || '').trim())
        .find(Boolean) || '';
}

function authorProfileForKey(authorKey: string, items: ThriveSkillMarketplaceItem[]): SkillAuthorProfile | null {
    if (!authorKey) return null;
    const skills = items.filter((item) => skillAuthorKey(item) === authorKey);
    if (skills.length === 0) return null;
    const homepageSkill = skills.find((skill) => skillAuthorHref(skill));
    return {
        key: authorKey,
        name: firstText(skills.map((skill) => skill.author)),
        avatarUrl: firstText(skills.map((skill) => skill.authorAvatarUrl)),
        homepageUrl: homepageSkill ? skillAuthorHref(homepageSkill) : '',
        homepageLabel: homepageSkill && isRedSkillMarketplaceItem(homepageSkill) ? '小红书主页' : '作者主页',
        bio: firstText(skills.map((skill) => skill.authorBio)),
        skills,
    };
}

function knownMarketplaceItems(
    marketItems: ThriveSkillMarketplaceItem[],
    selectedSkill: ThriveSkillMarketplaceItem | null,
    selectedSkillDetail: MarketplacePackageDetail | null,
) {
    const items = new Map<string, ThriveSkillMarketplaceItem>();
    marketItems.forEach((item) => {
        items.set(marketItemKey(item), item);
    });
    const detailItem = selectedSkillDetail?.item || selectedSkill;
    if (detailItem) {
        const key = marketItemKey(detailItem);
        items.set(key, {
            ...(items.get(key) || {}),
            ...detailItem,
        });
    }
    return [...items.values()];
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

function skillNavigationExactCandidates(skill: ThriveSkillMarketplaceItem) {
    return [
        skill.packageId,
        skill.id,
        skill.name,
        ...skillRuntimeNameCandidates(skill),
    ].map(normalizeKey).filter(Boolean);
}

function skillNavigationSearchCandidates(skill: ThriveSkillMarketplaceItem) {
    return [
        skill.name,
        skill.packageId,
        skill.id,
        skill.author,
        skill.description,
        ...skillDisplayTags(skill),
        ...skillRuntimeNameCandidates(skill),
    ].map(normalizeKey).filter(Boolean);
}

function skillMatchesNavigationMarket(skill: ThriveSkillMarketplaceItem, target: SkillsNavigationTarget) {
    const marketId = normalizeKey(target.marketId);
    if (!marketId) return true;
    return [
        skill.marketId,
        skill.marketName,
        skill.sourceKind,
    ].some((value) => normalizeKey(value) === marketId);
}

function skillMatchesNavigationTarget(skill: ThriveSkillMarketplaceItem, target: SkillsNavigationTarget) {
    if (!skillMatchesNavigationMarket(skill, target)) return false;
    const exactCandidates = skillNavigationExactCandidates(skill);
    const packageId = normalizeKey(target.packageId);
    if (packageId) return exactCandidates.includes(packageId);
    const id = normalizeKey(target.id);
    if (id) return exactCandidates.includes(id);
    const query = normalizeKey(target.query);
    if (!query) return false;
    return skillNavigationSearchCandidates(skill).some((value) => value.includes(query));
}

function skillNavigationSearchText(target: SkillsNavigationTarget) {
    return firstText([target.packageId, target.id, target.query]);
}

function hasSkillNavigationLocator(target: SkillsNavigationTarget) {
    return Boolean(skillNavigationSearchText(target));
}

function isRetiredSkillMarketSourceId(value: unknown) {
    return RETIRED_SKILL_MARKET_SOURCE_IDS.has(normalizeKey(value));
}

function isRetiredSkillMarketItem(item: ThriveSkillMarketplaceItem) {
    if (isRetiredSkillMarketSourceId(item.marketId)) return true;
    return normalizeKey(item.sourceKind) === 'legacy-thrive'
        && normalizeKey(item.marketName) === 'thrive community';
}

function sanitizeMarketplaceCacheEntry(entry: MarketplaceCacheEntry): MarketplaceCacheEntry {
    return {
        sources: entry.sources.filter((source) => !isRetiredSkillMarketSourceId(source.id)),
        collections: Array.isArray(entry.collections) ? entry.collections : [],
        items: entry.items.filter((item) => !isRetiredSkillMarketItem(item)),
    };
}

function asMarketplaceCacheEntry(value: unknown): MarketplaceCacheEntry | null {
    if (!isRecord(value)) return null;
    const sources = Array.isArray(value.sources) ? value.sources as SkillMarketSource[] : [];
    const collections = Array.isArray(value.collections) ? value.collections as SkillMarketCollection[] : [];
    const items = Array.isArray(value.items) ? value.items as ThriveSkillMarketplaceItem[] : [];
    const entry = sanitizeMarketplaceCacheEntry({ sources, collections, items });
    if (entry.sources.length === 0 && entry.collections.length === 0 && entry.items.length === 0) return null;
    return entry;
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
            const sanitized = sanitizeMarketplaceCacheEntry(entry);
            if (sanitized.sources.length > 0 || sanitized.collections.length > 0 || sanitized.items.length > 0) {
                entries[key] = sanitized;
            }
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
    skillMarketCache.set(key, sanitizeMarketplaceCacheEntry(entry));
    persistSkillMarketCache();
}

function asMarketplacePackageDetail(value: unknown): MarketplacePackageDetail | null {
    if (!isRecord(value)) return null;
    const item = isRecord(value.item) ? value.item as unknown as ThriveSkillMarketplaceItem : undefined;
    const manifest = Object.prototype.hasOwnProperty.call(value, 'manifest') ? value.manifest : undefined;
    const skillMarkdown = typeof value.skillMarkdown === 'string' ? value.skillMarkdown : '';
    if (!item && typeof manifest === 'undefined' && !skillMarkdown) return null;
    return { item, manifest, skillMarkdown };
}

function hydrateSkillDetailCache() {
    if (skillDetailCacheHydrated) return;
    skillDetailCacheHydrated = true;
    if (typeof window === 'undefined') return;
    try {
        const raw = window.localStorage.getItem(MARKETPLACE_DETAIL_CACHE_STORAGE_KEY);
        if (!raw) return;
        const snapshot = JSON.parse(raw) as MarketplaceDetailCacheSnapshot;
        const entries = isRecord(snapshot?.entries) ? snapshot.entries : {};
        Object.entries(entries)
            .sort(([, left], [, right]) => (
                Number(isRecord(left) ? left.savedAt || 0 : 0)
                - Number(isRecord(right) ? right.savedAt || 0 : 0)
            ))
            .slice(-MAX_SKILL_DETAIL_CACHE_ENTRIES)
            .forEach(([key, value]) => {
                const detail = asMarketplacePackageDetail(value);
                if (detail) skillDetailCache.set(key, detail);
            });
    } catch (error) {
        console.warn('Failed to read cached skill marketplace details:', error);
    }
}

function persistSkillDetailCache() {
    if (typeof window === 'undefined') return;
    const savedAt = Date.now();
    const cachedEntries = Array.from(skillDetailCache.entries()).slice(-MAX_SKILL_DETAIL_CACHE_ENTRIES);
    const writeEntries = (entriesToWrite: Array<[string, MarketplacePackageDetail]>) => {
        const entries: MarketplaceDetailCacheSnapshot['entries'] = {};
        entriesToWrite.forEach(([key, detail]) => {
            entries[key] = {
                item: detail.item,
                manifest: typeof detail.manifest === 'undefined' ? null : detail.manifest,
                skillMarkdown: detail.skillMarkdown || '',
                savedAt,
            };
        });
        window.localStorage.setItem(
            MARKETPLACE_DETAIL_CACHE_STORAGE_KEY,
            JSON.stringify({ savedAt, entries }),
        );
    };
    try {
        writeEntries(cachedEntries);
    } catch (error) {
        try {
            writeEntries(cachedEntries.slice(-Math.ceil(MAX_SKILL_DETAIL_CACHE_ENTRIES / 2)));
        } catch {
            console.warn('Failed to cache skill marketplace details:', error);
        }
    }
}

function cachedSkillDetail(key: string) {
    hydrateSkillDetailCache();
    return skillDetailCache.get(key) || null;
}

function cachedSkillDetailHasContent(detail: MarketplacePackageDetail | null) {
    if (!detail) return false;
    if (String(detail.skillMarkdown || '').trim()) return true;
    return typeof detail.manifest !== 'undefined' && detail.manifest !== null;
}

function canUseCachedSkillDetail(detail: MarketplacePackageDetail | null, skill: ThriveSkillMarketplaceItem) {
    if (!cachedSkillDetailHasContent(detail)) return false;
    const cachedItem = detail?.item;
    if (!cachedItem) return true;
    const cachedPackageKey = normalizeKey(cachedItem.packageId || cachedItem.id || cachedItem.name);
    const currentPackageKey = normalizeKey(skill.packageId || skill.id || skill.name);
    if (cachedPackageKey && currentPackageKey && cachedPackageKey !== currentPackageKey) return false;
    const cachedVersion = normalizeKey(cachedItem.version);
    const currentVersion = normalizeKey(skill.version);
    return !(cachedVersion && currentVersion && cachedVersion !== currentVersion);
}

function mergeCachedSkillDetail(detail: MarketplacePackageDetail | null, skill: ThriveSkillMarketplaceItem) {
    if (!detail) return null;
    return {
        ...detail,
        item: detail.item ? {
            ...detail.item,
            ...skill,
            introNote: detail.item.introNote || detail.item.intro_note || skill.introNote || skill.intro_note,
        } : skill,
    };
}

function setSkillDetailCacheEntry(key: string, detail: MarketplacePackageDetail) {
    hydrateSkillDetailCache();
    const normalized = asMarketplacePackageDetail(detail);
    if (!normalized) return;
    skillDetailCache.delete(key);
    skillDetailCache.set(key, normalized);
    persistSkillDetailCache();
}

function deleteSkillDetailCacheEntry(key: string) {
    hydrateSkillDetailCache();
    if (!skillDetailCache.delete(key)) return;
    persistSkillDetailCache();
}

function cachedMarketplaceEntry(cacheKey: string, marketId: string): MarketplaceCacheEntry | undefined {
    hydrateSkillMarketCache();
    const exact = skillMarketCache.get(cacheKey);
    if (exact) return sanitizeMarketplaceCacheEntry(exact);
    if (!marketId) return undefined;
    const all = skillMarketCache.get(ALL_MARKET_CACHE_KEY);
    if (!all) return undefined;
    return sanitizeMarketplaceCacheEntry({
        sources: all.sources,
        collections: all.collections,
        items: all.items.filter((item) => item.marketId === marketId),
    });
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
    const isRedSkill = typeof children === 'string' && isRedSkillTag(children);
    return (
        <span
            className={clsx(
                'inline-flex h-6 max-w-full items-center rounded-full border px-2.5 text-[11px]',
                isRedSkill ? 'font-bold' : 'font-medium',
                active
                    ? 'border-accent-primary bg-accent-primary text-[rgb(var(--color-primary-text))]'
                    : isRedSkill
                        ? 'border-[#ff2442] bg-[#ff2442] text-white'
                    : 'border-border bg-surface-primary/70 text-text-secondary'
            )}
        >
            <span className="truncate">{children}</span>
        </span>
    );
}

function SkillIntroNotePanel({ note }: { note?: SkillMarketIntroNote | null }) {
    const intro = normalizeSkillIntroNote(note);
    const [selectedImageIndex, setSelectedImageIndex] = useState(0);
    const [failedMediaUrl, setFailedMediaUrl] = useState('');

    useEffect(() => {
        setSelectedImageIndex(0);
        setFailedMediaUrl('');
    }, [intro?.coverUrl, intro?.noteHref]);

    if (!intro) return null;

    const isVideoNote = normalizeKey(intro.noteType) === 'video';
    const noteLabel = isVideoNote ? '小红书视频' : '小红书图文';
    const badgeClassName = isVideoNote ? 'bg-red-500/90 text-white' : 'bg-rose-500/90 text-white';
    const title = intro.title || '小红书笔记';
    const authorInitial = (intro.authorName || '小红书用户').slice(0, 1);
    const imageIndex = intro.images.length > 0 ? Math.min(selectedImageIndex, intro.images.length - 1) : 0;
    const mediaUrl = isVideoNote ? intro.coverUrl : (intro.images[imageIndex] || intro.coverUrl);
    const showMedia = Boolean(mediaUrl && failedMediaUrl !== mediaUrl);
    const previousImage = () => {
        if (intro.images.length <= 1) return;
        setSelectedImageIndex((current) => (current <= 0 ? intro.images.length - 1 : current - 1));
    };
    const nextImage = () => {
        if (intro.images.length <= 1) return;
        setSelectedImageIndex((current) => (current >= intro.images.length - 1 ? 0 : current + 1));
    };

    return (
        <section className="space-y-3">
            <h2 className="text-sm font-semibold text-text-primary">说明书</h2>
            <div className="overflow-hidden rounded-2xl border border-border bg-surface-primary/75">
                <div className="grid min-h-[360px] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                    <div className="relative flex min-h-[320px] flex-col bg-black/[0.03]">
                        <span className={clsx('absolute right-3 top-3 z-10 rounded-lg px-2 py-1 text-[10px] font-bold shadow-sm backdrop-blur-md', badgeClassName)}>
                            {noteLabel}
                        </span>
                        <div className="relative flex min-h-0 flex-1 items-center justify-center">
                            {isVideoNote && intro.playbackUrl ? (
                                <video
                                    src={intro.playbackUrl}
                                    poster={showMedia ? mediaUrl : undefined}
                                    className="max-h-[520px] w-full bg-black object-contain"
                                    controls
                                    playsInline
                                    preload="metadata"
                                />
                            ) : showMedia ? (
                                <img
                                    src={mediaUrl}
                                    alt=""
                                    className="max-h-[520px] w-full object-contain"
                                    loading="lazy"
                                    decoding="async"
                                    onError={() => setFailedMediaUrl(mediaUrl)}
                                />
                            ) : (
                                <div className="flex h-full min-h-[260px] w-full items-center justify-center text-text-tertiary">
                                    {isVideoNote ? <PlayCircle className="h-9 w-9 opacity-35" /> : <FileText className="h-9 w-9 opacity-35" />}
                                </div>
                            )}
                            {!isVideoNote && intro.images.length > 1 ? (
                                <>
                                    <button
                                        type="button"
                                        onClick={previousImage}
                                        className="absolute left-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-text-primary shadow-sm ring-1 ring-black/10 transition-colors hover:bg-white"
                                        aria-label="上一张"
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={nextImage}
                                        className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-text-primary shadow-sm ring-1 ring-black/10 transition-colors hover:bg-white"
                                        aria-label="下一张"
                                    >
                                        <ArrowRight className="h-4 w-4" />
                                    </button>
                                </>
                            ) : null}
                        </div>
                        {!isVideoNote && intro.images.length > 1 ? (
                            <div className="flex gap-2 overflow-x-auto border-t border-border/70 bg-surface-primary/90 p-2.5 custom-scrollbar">
                                {intro.images.map((url, index) => (
                                    <button
                                        key={url}
                                        type="button"
                                        onClick={() => setSelectedImageIndex(index)}
                                        className={clsx(
                                            'relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border transition-colors',
                                            index === imageIndex ? 'border-accent-primary ring-2 ring-accent-primary/20' : 'border-border hover:border-text-tertiary/40'
                                        )}
                                        aria-label={`查看第 ${index + 1} 张图`}
                                    >
                                        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                                        <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1 text-[9px] font-semibold text-white">{index + 1}</span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    <div className="min-w-0 border-l border-border/70 bg-surface-primary max-lg:border-l-0 max-lg:border-t">
                        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-black/[0.04] ring-1 ring-black/[0.05]">
                                    {intro.authorAvatarUrl ? (
                                        <img src={intro.authorAvatarUrl} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-sm font-bold text-text-tertiary">{authorInitial}</div>
                                    )}
                                </div>
                                <div className="truncate text-sm font-semibold text-text-primary">{intro.authorName || '小红书用户'}</div>
                            </div>
                            {intro.noteHref ? (
                                <a
                                    href={intro.noteHref}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-black/[0.04] px-3 text-[12px] font-bold text-text-secondary transition-colors hover:bg-black/[0.08] hover:text-text-primary"
                                >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    原笔记
                                </a>
                            ) : null}
                        </div>
                        <div className="space-y-4 px-4 py-4">
                            <h3 className="text-[18px] font-extrabold leading-snug tracking-tight text-text-primary">{title}</h3>
                            {intro.contentText ? (
                                <div className="max-h-[360px] overflow-y-auto whitespace-pre-wrap pr-1 text-sm leading-7 text-text-secondary custom-scrollbar">
                                    {intro.contentText}
                                </div>
                            ) : null}
                            {intro.tags.length > 0 ? (
                                <div className="flex flex-wrap gap-2 pt-1">
                                    {intro.tags.map((tag) => (
                                        <span key={tag} className="text-[13px] font-semibold text-[#24599a]">#{tag}</span>
                                    ))}
                                </div>
                            ) : null}
                            {intro.stats.length > 0 ? (
                                <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1 text-[12px] font-medium text-text-tertiary">
                                    {intro.stats.map((item) => (
                                        <span key={item.label}>{item.value} {item.label}</span>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

function SkillAuthorPill({ skill, clickable = false }: { skill: ThriveSkillMarketplaceItem; clickable?: boolean }) {
    const authorName = skillAuthorName(skill);
    const href = clickable ? skillAuthorHref(skill) : '';
    const avatarUrl = String(skill.authorAvatarUrl || '').trim();
    const [cachedAvatarUrl, setCachedAvatarUrl] = useState(() => skillAvatarDataUrlCache.get(avatarUrl) || '');
    const [failedUrl, setFailedUrl] = useState('');
    const imageUrl = cachedAvatarUrl;
    const showImage = imageUrl && failedUrl !== imageUrl;
    const title = String(skill.authorBio || authorName).trim() || undefined;
    const className = clsx(
        'inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-2.5 text-[11px] font-medium text-text-secondary',
        href && 'transition-colors hover:bg-surface-primary hover:text-text-primary'
    );

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

    if (!authorName) return null;

    const content = (
        <>
            {showImage ? (
                <img
                    src={imageUrl}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded-full object-cover"
                    loading="lazy"
                    onError={() => setFailedUrl(imageUrl)}
                />
            ) : (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[9px] font-semibold leading-none text-text-tertiary">
                    {skillInitials(authorName)}
                </span>
            )}
            <span className="truncate">{authorName}</span>
            {href ? <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.7} /> : null}
        </>
    );

    if (href) {
        return (
            <a href={href} target="_blank" rel="noreferrer" title={title} className={className}>
                {content}
            </a>
        );
    }

    return (
        <span title={title} className={className}>
            {content}
        </span>
    );
}

function SkillAuthorPanel({ skill, onOpen }: { skill: ThriveSkillMarketplaceItem; onOpen?: () => void }) {
    const authorName = skillAuthorName(skill);
    const avatarUrl = String(skill.authorAvatarUrl || '').trim();
    const authorBio = String(skill.authorBio || '').trim();
    const [cachedAvatarUrl, setCachedAvatarUrl] = useState(() => skillAvatarDataUrlCache.get(avatarUrl) || '');
    const [failedUrl, setFailedUrl] = useState('');
    const imageUrl = cachedAvatarUrl;
    const showImage = imageUrl && failedUrl !== imageUrl;

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

    if (!authorName) return null;

    const body = (
        <div className={clsx(
            'flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-primary/45 px-3 py-3',
            onOpen && 'transition-colors hover:bg-surface-primary'
        )}>
            {showImage ? (
                <img
                    src={imageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-full object-cover"
                    loading="lazy"
                    onError={() => setFailedUrl(imageUrl)}
                />
            ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-sm font-semibold leading-none text-text-tertiary">
                    {skillInitials(authorName)}
                </span>
            )}
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-text-primary">{authorName}</span>
                    {onOpen ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-primary">
                            查看主页
                            <ArrowRight className="h-3 w-3" strokeWidth={1.7} />
                        </span>
                    ) : null}
                </div>
                {authorBio ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-tertiary">{authorBio}</p>
                ) : null}
            </div>
        </div>
    );

    return (
        <section className="space-y-3">
            <h2 className="text-sm font-semibold text-text-primary">作者</h2>
            {onOpen ? (
                <button type="button" onClick={onOpen} className="block w-full text-left">
                    {body}
                </button>
            ) : body}
        </section>
    );
}

function SkillAuthorHomeHeader({ profile }: { profile: SkillAuthorProfile }) {
    const avatarUrl = profile.avatarUrl;
    const [cachedAvatarUrl, setCachedAvatarUrl] = useState(() => skillAvatarDataUrlCache.get(avatarUrl) || '');
    const [failedUrl, setFailedUrl] = useState('');
    const imageUrl = cachedAvatarUrl;
    const showImage = imageUrl && failedUrl !== imageUrl;

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
        <section className="space-y-5 pb-2">
            <div className="flex min-w-0 items-start gap-4">
                {showImage ? (
                    <img
                        src={imageUrl}
                        alt=""
                        className="h-20 w-20 shrink-0 rounded-2xl border border-border object-cover"
                        loading="lazy"
                        onError={() => setFailedUrl(imageUrl)}
                    />
                ) : (
                    <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-primary text-lg font-semibold leading-none text-text-tertiary">
                        {skillInitials(profile.name)}
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-[26px] font-semibold leading-tight text-text-primary">{profile.name}</h1>
                    {profile.bio ? (
                        <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm leading-6 text-text-tertiary">{profile.bio}</p>
                    ) : null}
                    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                        <SkillTag>{`${profile.skills.length} 个技能`}</SkillTag>
                        {profile.homepageUrl ? (
                            <button
                                type="button"
                                onClick={() => void openExternalHttpUrl(profile.homepageUrl)}
                                className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
                            >
                                <span className="truncate">{profile.homepageLabel}</span>
                                <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.7} />
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        </section>
    );
}

function CollectionAvatar({ collection }: { collection: SkillMarketCollection }) {
    const imageUrl = collectionImageUrl(collection);
    const [failedUrl, setFailedUrl] = useState('');
    const title = collectionTitle(collection);
    const showImage = imageUrl && failedUrl !== imageUrl;

    return showImage ? (
        <img
            src={imageUrl}
            alt=""
            className="h-12 w-12 shrink-0 rounded-xl border border-border object-cover"
            loading="lazy"
            onError={() => setFailedUrl(imageUrl)}
        />
    ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-primary text-sm font-semibold leading-none text-text-tertiary">
            {skillInitials(title)}
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

function buildSkillSubmissionContent(form: SkillSubmissionForm) {
    return [
        `技能名称：${form.name || '未填写'}`,
        `链接：${form.url || '未填写'}`,
        form.description ? `说明：${form.description}` : '',
        form.contact ? `联系方式：${form.contact}` : '',
    ].filter(Boolean).join('\n');
}

type SkillSubmissionDialogProps = {
    form: SkillSubmissionForm;
    isSubmitting: boolean;
    error: string;
    message: string;
    onChange: (form: SkillSubmissionForm) => void;
    onClose: () => void;
    onSubmit: () => void;
};

function SkillSubmissionDialog({
    form,
    isSubmitting,
    error,
    message,
    onChange,
    onClose,
    onSubmit,
}: SkillSubmissionDialogProps) {
    const updateField = (field: keyof SkillSubmissionForm, value: string) => {
        onChange({
            ...form,
            [field]: value,
        });
    };

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm">
            <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <PackagePlus className="h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.9} />
                        <div className="truncate text-sm font-semibold text-text-primary">申请收录</div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isSubmitting}
                        className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-60"
                        aria-label="关闭"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="space-y-4 px-5 py-4">
                    <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">技能名称</label>
                        <input
                            value={form.name}
                            onChange={(event) => updateField('name', event.target.value)}
                            placeholder="可选"
                            className="w-full rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">链接</label>
                        <input
                            value={form.url}
                            onChange={(event) => updateField('url', event.target.value)}
                            placeholder="GitHub、RedSkill 或说明页面"
                            className="w-full rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">说明</label>
                        <textarea
                            value={form.description}
                            onChange={(event) => updateField('description', event.target.value)}
                            placeholder="这个 Skill 适合做什么"
                            rows={4}
                            className="w-full resize-none rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm leading-5 text-text-primary outline-none transition-colors focus:border-accent-primary"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">联系方式</label>
                        <input
                            value={form.contact}
                            onChange={(event) => updateField('contact', event.target.value)}
                            placeholder="可选"
                            className="w-full rounded-md border border-border bg-surface-secondary/30 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                        />
                    </div>

                    {error ? (
                        <div className="rounded-md border border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error">{error}</div>
                    ) : null}
                    {message ? (
                        <div className="rounded-md border border-status-success/20 bg-status-success/10 px-3 py-2 text-xs text-status-success">{message}</div>
                    ) : null}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isSubmitting}
                        className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-60"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={isSubmitting}
                        className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:opacity-60"
                    >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        提交
                    </button>
                </div>
            </div>
        </div>
    );
}

type SkillsProps = {
    isActive?: boolean;
    onTrySkillInChat?: (message: PendingChatMessage) => void;
    navigationTarget?: SkillsNavigationTarget | null;
};

export function Skills({ isActive = true, onTrySkillInChat, navigationTarget }: SkillsProps) {
    const initialMarketCache = initialMarketplaceCache();
    const [marketItems, setMarketItems] = useState<ThriveSkillMarketplaceItem[]>(() => initialMarketCache?.items || []);
    const [marketSources, setMarketSources] = useState<SkillMarketSource[]>(() => initialMarketCache?.sources || []);
    const [marketCollections, setMarketCollections] = useState<SkillMarketCollection[]>(() => initialMarketCache?.collections || []);
    const [selectedCategory, setSelectedCategory] = useState('');
    const [selectedCollectionKey, setSelectedCollectionKey] = useState('');
    const [query, setQuery] = useState('');
    const [isMarketLoading, setIsMarketLoading] = useState(() => !initialMarketCache);
    const [busyMarketItemId, setBusyMarketItemId] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [selectedSkill, setSelectedSkill] = useState<ThriveSkillMarketplaceItem | null>(null);
    const [selectedSkillDetail, setSelectedSkillDetail] = useState<MarketplacePackageDetail | null>(null);
    const [selectedAuthorKey, setSelectedAuthorKey] = useState('');
    const [isSkillDetailLoading, setIsSkillDetailLoading] = useState(false);
    const [isManagingSkills, setIsManagingSkills] = useState(false);
    const [installedSkills, setInstalledSkills] = useState<SettingsSkill[]>([]);
    const [isInstalledSkillsLoading, setIsInstalledSkillsLoading] = useState(false);
    const [installedSkillBusyName, setInstalledSkillBusyName] = useState('');
    const [installedSkillStatusMessage, setInstalledSkillStatusMessage] = useState('');
    const [areBuiltinSkillsExpanded, setAreBuiltinSkillsExpanded] = useState(false);
    const [skillSubmissionOpen, setSkillSubmissionOpen] = useState(false);
    const [skillSubmissionForm, setSkillSubmissionForm] = useState<SkillSubmissionForm>(() => emptySkillSubmissionForm());
    const [isSkillSubmissionSubmitting, setIsSkillSubmissionSubmitting] = useState(false);
    const [skillSubmissionError, setSkillSubmissionError] = useState('');
    const [skillSubmissionMessage, setSkillSubmissionMessage] = useState('');
    const marketRequestRef = useRef(0);
    const detailRequestRef = useRef(0);
    const installedSkillsLoadedRef = useRef(false);
    const lastNavigationTargetNonceRef = useRef<number | null>(null);

    const categoryCounts = useMemo(() => {
        const counts = new Map<string, number>(SKILL_CATEGORY_LABELS.map((category) => [category, 0] as [string, number]));
        marketItems.forEach((item) => {
            skillCategories(item).forEach((category) => {
                counts.set(category, (counts.get(category) || 0) + 1);
            });
        });
        return counts;
    }, [marketItems]);

    const selectedCollection = useMemo(
        () => marketCollections.find((collection) => collectionKey(collection) === selectedCollectionKey) || null,
        [marketCollections, selectedCollectionKey],
    );

    const filteredMarketItems = useMemo(() => {
        const normalizedQuery = normalizeKey(query);
        const selectedPackageKeys = new Set(
            selectedCollection
                ? collectionPackageKeys(selectedCollection).map((key) => normalizeKey(key))
                : [],
        );
        return marketItems.filter((item) => {
            if (selectedPackageKeys.size > 0) {
                const itemKey = normalizeKey(item.packageId || item.id || item.name);
                if (!selectedPackageKeys.has(itemKey)) {
                    return false;
                }
            }
            const displayTags = skillDisplayTags(item);
            const categoryMatches = !selectedCategory || skillMatchesCategory(item, selectedCategory);
            const queryMatches = !normalizedQuery || [
                item.name,
                item.author,
                item.authorBio,
                item.authorHomepageUrl,
                item.description,
                item.repo,
                item.packageId,
                item.id,
                ...displayTags,
            ].some((value) => normalizeKey(value).includes(normalizedQuery));
            return categoryMatches && queryMatches;
        });
    }, [marketItems, query, selectedCategory, selectedCollection]);

    const categoryMarketSections = useMemo(() => (
        SKILL_CATEGORY_LABELS
            .map((category) => ({
                title: category,
                items: filteredMarketItems.filter((item) => primarySkillCategory(item) === category),
            }))
            .filter((section) => section.items.length > 0)
    ), [filteredMarketItems]);

    const uncategorizedMarketItems = useMemo(
        () => filteredMarketItems.filter((item) => !primarySkillCategory(item)),
        [filteredMarketItems],
    );

    const allKnownMarketItems = useMemo(
        () => knownMarketplaceItems(marketItems, selectedSkill, selectedSkillDetail),
        [marketItems, selectedSkill, selectedSkillDetail],
    );

    const selectedAuthorProfile = useMemo(
        () => authorProfileForKey(selectedAuthorKey, allKnownMarketItems),
        [selectedAuthorKey, allKnownMarketItems],
    );

    const builtinInstalledSkills = useMemo(
        () => installedSkills.filter((skill) => skill.isBuiltin),
        [installedSkills],
    );

    const editableInstalledSkills = useMemo(
        () => installedSkills.filter((skill) => !skill.isBuiltin),
        [installedSkills],
    );

    const hasFocusedFilters = Boolean(query.trim() || selectedCategory || selectedCollectionKey);
    const primaryMarketItems = hasFocusedFilters ? filteredMarketItems : filteredMarketItems.slice(0, 6);
    const secondaryMarketItems = hasFocusedFilters ? [] : filteredMarketItems.slice(6);
    const primarySectionTitle = hasFocusedFilters
        ? (selectedCollection?.title || selectedCategory || '搜索结果')
        : '精选';
    const showCategorySections = !hasFocusedFilters && categoryMarketSections.length > 0;

    const loadMarketplace = useCallback(async (marketId = '', options: { force?: boolean } = {}) => {
        const requestId = marketRequestRef.current + 1;
        marketRequestRef.current = requestId;
        const cacheKey = marketId || ALL_MARKET_CACHE_KEY;
        const cached = cachedMarketplaceEntry(cacheKey, marketId);
        if (cached) {
            setMarketSources(cached.sources);
            setMarketCollections(cached.collections);
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
            const collections = Array.isArray(result.collections) ? result.collections : [];
            const items = Array.isArray(result.items) ? result.items : Array.isArray(result.skills) ? result.skills : [];
            setSkillMarketCacheEntry(cacheKey, { sources, collections, items });
            setMarketSources(sources);
            setMarketCollections(collections);
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
        await loadMarketplace('', { force });
    }, [loadMarketplace]);

    const loadInstalledSkills = useCallback(async () => {
        setIsInstalledSkillsLoading(true);
        try {
            const list = await window.ipcRenderer.listSkills();
            const normalized = normalizeInstalledSkills(list);
            setInstalledSkills(normalized);
            installedSkillsLoadedRef.current = true;
            return normalized;
        } catch (error) {
            console.error('Failed to load installed skills:', error);
            setInstalledSkillStatusMessage(error instanceof Error ? error.message : '技能列表读取失败');
            return [];
        } finally {
            setIsInstalledSkillsLoading(false);
        }
    }, []);

    const openManageSkills = useCallback(() => {
        setIsManagingSkills(true);
        setSelectedSkill(null);
        setSelectedSkillDetail(null);
        setSelectedAuthorKey('');
        setIsSkillDetailLoading(false);
        setStatusMessage('');
        void loadInstalledSkills();
    }, [loadInstalledSkills]);

    const closeManageSkills = useCallback(() => {
        setIsManagingSkills(false);
        setInstalledSkillStatusMessage('');
    }, []);

    const handleToggleInstalledSkill = useCallback(async (skill: SettingsSkill) => {
        if (skill.isBuiltin) return;
        const nextDisabled = !skill.disabled;
        setInstalledSkillBusyName(skill.name);
        setInstalledSkillStatusMessage('');
        setInstalledSkills((items) => items.map((item) => (
            item.name === skill.name ? { ...item, disabled: nextDisabled } : item
        )));
        try {
            const action = nextDisabled ? window.ipcRenderer.skills.disable : window.ipcRenderer.skills.enable;
            const result = await action({ name: skill.name }) as { success?: boolean; error?: string };
            if (result && result.success === false) {
                throw new Error(result.error || '技能状态保存失败');
            }
            setInstalledSkillStatusMessage(nextDisabled ? `已关闭 ${skill.name}` : `已打开 ${skill.name}`);
            await loadInstalledSkills();
        } catch (error) {
            console.error('Failed to update installed skill state:', error);
            setInstalledSkills((items) => items.map((item) => (
                item.name === skill.name ? { ...item, disabled: skill.disabled } : item
            )));
            setInstalledSkillStatusMessage(error instanceof Error ? error.message : '技能状态保存失败');
        } finally {
            setInstalledSkillBusyName('');
        }
    }, [loadInstalledSkills]);

    const handleUninstallInstalledSkill = useCallback(async (skill: SettingsSkill) => {
        if (skill.isBuiltin) return;
        const confirmed = await appConfirm(`删除技能“${skill.name}”？`, {
            title: '删除技能',
            confirmLabel: '删除',
            tone: 'danger',
        });
        if (!confirmed) return;
        setInstalledSkillBusyName(skill.name);
        setInstalledSkillStatusMessage('');
        try {
            const result = await window.ipcRenderer.skills.uninstall({ name: skill.name }) as { success?: boolean; error?: string };
            if (result && result.success === false) {
                throw new Error(result.error || '技能删除失败');
            }
            setInstalledSkills((items) => items.filter((item) => item.name !== skill.name));
            setInstalledSkillStatusMessage(`已删除 ${skill.name}`);
            await Promise.all([
                loadInstalledSkills(),
                refreshAll(false),
            ]);
        } catch (error) {
            console.error('Failed to uninstall installed skill:', error);
            setInstalledSkillStatusMessage(error instanceof Error ? error.message : '技能删除失败');
        } finally {
            setInstalledSkillBusyName('');
        }
    }, [loadInstalledSkills, refreshAll]);

    useEffect(() => {
        if (!isActive) return;
        void loadMarketplace('');
    }, [isActive, loadMarketplace]);

    const handleOpenSkillHome = useCallback(async (skill: ThriveSkillMarketplaceItem) => {
        const key = marketItemKey(skill);
        const cached = cachedSkillDetail(key);
        const cachedForDisplay = mergeCachedSkillDetail(cached, skill);
        setIsManagingSkills(false);
        setSelectedAuthorKey('');
        setSelectedSkill(skill);
        setSelectedSkillDetail(cachedForDisplay);
        setStatusMessage('');

        if (canUseCachedSkillDetail(cached, skill)) {
            setIsSkillDetailLoading(false);
            return;
        }

        const requestId = detailRequestRef.current + 1;
        detailRequestRef.current = requestId;
        setIsSkillDetailLoading(!cachedSkillDetailHasContent(cachedForDisplay));
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
                skillMarkdown: typeof detail.skillMarkdown === 'string' ? detail.skillMarkdown : '',
            };
            setSkillDetailCacheEntry(key, normalized);
            setSelectedSkillDetail(normalized);
        } catch (error) {
            console.error('Failed to load marketplace skill detail:', error);
            if (requestId === detailRequestRef.current) {
                if (!cachedForDisplay) {
                    setStatusMessage(error instanceof Error ? error.message : '技能主页加载失败');
                    setSelectedSkillDetail({ item: skill, manifest: null });
                }
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
        setSelectedAuthorKey('');
        setIsSkillDetailLoading(false);
        setStatusMessage('');
    }, []);

    const handleOpenAuthorHome = useCallback((skill: ThriveSkillMarketplaceItem) => {
        const authorKey = skillAuthorKey(skill);
        if (!authorKey) return;
        setSelectedAuthorKey(authorKey);
        setStatusMessage('');
    }, []);

    const handleCloseAuthorHome = useCallback(() => {
        setSelectedAuthorKey('');
        setStatusMessage('');
    }, []);

    useEffect(() => {
        if (!isActive || !navigationTarget) return;
        if (lastNavigationTargetNonceRef.current === navigationTarget.nonce) return;

        if (!hasSkillNavigationLocator(navigationTarget)) {
            lastNavigationTargetNonceRef.current = navigationTarget.nonce;
            detailRequestRef.current += 1;
            setIsManagingSkills(false);
            setSelectedAuthorKey('');
            setSelectedSkill(null);
            setSelectedSkillDetail(null);
            setIsSkillDetailLoading(false);
            setSelectedCategory('');
            setSelectedCollectionKey('');
            setQuery('');
            setStatusMessage('');
            return;
        }

        const matchingSkill = marketItems.find((item) => skillMatchesNavigationTarget(item, navigationTarget));
        if (matchingSkill) {
            lastNavigationTargetNonceRef.current = navigationTarget.nonce;
            setSelectedCategory('');
            setSelectedCollectionKey('');
            setQuery('');
            void handleOpenSkillHome(matchingSkill);
            return;
        }

        if (isMarketLoading) return;

        detailRequestRef.current += 1;
        setIsManagingSkills(false);
        setSelectedAuthorKey('');
        setSelectedSkill(null);
        setSelectedSkillDetail(null);
        setIsSkillDetailLoading(false);
        setSelectedCategory('');
        setSelectedCollectionKey('');
        setQuery(skillNavigationSearchText(navigationTarget));
        setStatusMessage('没有找到指定技能');
    }, [handleOpenSkillHome, isActive, isMarketLoading, marketItems, navigationTarget]);

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
            deleteSkillDetailCacheEntry(key);
            setMarketItems((items) => items.map((item) => marketItemKey(item) === key ? installedSkill : item));
            setSelectedSkill((current) => current && marketItemKey(current) === key ? installedSkill : current);
            setSelectedSkillDetail((current) => current ? {
                ...current,
                item: installedSkill,
            } : current);
            setStatusMessage(`已安装 ${installedName}`);
            await Promise.all([
                refreshAll(false),
                installedSkillsLoadedRef.current ? loadInstalledSkills() : Promise.resolve([]),
            ]);
        } catch (error) {
            console.error('Failed to install marketplace skill:', error);
            setStatusMessage(error instanceof Error ? error.message : '技能安装失败');
        } finally {
            setBusyMarketItemId('');
        }
    }, [loadInstalledSkills, refreshAll]);

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
                    packageId: String(skill.packageId || skill.id || '').trim() || undefined,
                    avatarUrl: skill.avatarUrl || skillAvatarUrl(skill) || undefined,
                    iconUrl: skill.iconUrl || undefined,
                    logoUrl: skill.logoUrl || undefined,
                    imageUrl: skill.imageUrl || undefined,
                    thumbnailUrl: skill.thumbnailUrl || undefined,
                    authorAvatarUrl: skill.authorAvatarUrl || undefined,
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

    const openSkillSubmissionDialog = useCallback(() => {
        setSkillSubmissionError('');
        setSkillSubmissionMessage('');
        setSkillSubmissionOpen(true);
    }, []);

    const closeSkillSubmissionDialog = useCallback(() => {
        if (isSkillSubmissionSubmitting) return;
        setSkillSubmissionOpen(false);
        setSkillSubmissionError('');
        setSkillSubmissionMessage('');
    }, [isSkillSubmissionSubmitting]);

    const submitSkillSubmission = useCallback(async () => {
        if (isSkillSubmissionSubmitting) return;
        const form: SkillSubmissionForm = {
            name: skillSubmissionForm.name.trim(),
            url: skillSubmissionForm.url.trim(),
            description: skillSubmissionForm.description.trim(),
            contact: skillSubmissionForm.contact.trim(),
        };
        if (!form.name && !form.url && !form.description) {
            setSkillSubmissionError('请填写技能名称、链接或说明');
            setSkillSubmissionMessage('');
            return;
        }

        setIsSkillSubmissionSubmitting(true);
        setSkillSubmissionError('');
        setSkillSubmissionMessage('');
        try {
            const content = buildSkillSubmissionContent(form);
            const result = await window.ipcRenderer.logs.createFeedbackReport({
                title: `申请收录 Skill：${form.name || form.url || '未命名 Skill'}`,
                content,
                contact: form.contact,
                category: 'skill_submission',
                priority: 'medium',
                source: 'desktop_skill_market',
                includeAdvancedContext: false,
                uploadNow: true,
                context: {
                    requestKind: 'skill_submission',
                    window: 'skills',
                    skillName: form.name,
                    skillUrl: form.url,
                    description: form.description,
                },
            }) as { success?: boolean; uploaded?: boolean; error?: string };
            if (!result?.success) {
                throw new Error(result?.error || '提交失败');
            }
            setSkillSubmissionForm(emptySkillSubmissionForm());
            if (result.uploaded) {
                setSkillSubmissionMessage('已提交');
            } else {
                setSkillSubmissionMessage(result.error ? `已保存待发送：${result.error}` : '已保存待发送');
            }
        } catch (error) {
            setSkillSubmissionError(error instanceof Error ? error.message : '提交失败');
        } finally {
            setIsSkillSubmissionSubmitting(false);
        }
    }, [isSkillSubmissionSubmitting, skillSubmissionForm]);

    const openCategoryPage = (category: string) => {
        setSelectedCategory(category);
        setSelectedCollectionKey('');
        setQuery('');
    };

    const renderInstalledSkillRow = (skill: SettingsSkill) => {
        const isBusy = installedSkillBusyName === skill.name;
        const enabled = skill.isBuiltin || !skill.disabled;
        return (
            <div key={skill.location || skill.name} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">{skill.name}</span>
                        <span className={clsx(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                            skill.isBuiltin
                                ? 'bg-accent-primary/10 text-accent-primary'
                                : 'bg-surface-secondary text-text-tertiary'
                        )}>
                            {formatSettingsSkillSource(skill.sourceScope)}
                        </span>
                        {!enabled ? (
                            <span className="shrink-0 rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] font-medium text-text-tertiary">已关闭</span>
                        ) : null}
                    </div>
                    {skill.description ? (
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-text-tertiary">
                            {skill.description}
                        </div>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void handleToggleInstalledSkill(skill)}
                        disabled={skill.isBuiltin || isBusy}
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? '关闭' : '打开'}技能 ${skill.name}`}
                        title={skill.isBuiltin ? '内置技能不可关闭' : (enabled ? '关闭技能' : '打开技能')}
                        className={clsx(
                            'ui-switch-track disabled:cursor-not-allowed',
                            skill.isBuiltin && 'opacity-70',
                            isBusy && 'opacity-60'
                        )}
                        data-size="sm"
                        data-state={enabled ? 'on' : 'off'}
                    >
                        <span className="ui-switch-thumb" />
                    </button>
                    {!skill.isBuiltin ? (
                        <button
                            type="button"
                            onClick={() => void handleUninstallInstalledSkill(skill)}
                            disabled={isBusy}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-tertiary transition-colors hover:border-brand-red/30 hover:bg-brand-red/10 hover:text-brand-red disabled:opacity-50"
                            aria-label={`删除技能 ${skill.name}`}
                            title="删除技能"
                        >
                            {isBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                            )}
                        </button>
                    ) : null}
                </div>
            </div>
        );
    };

    const renderManageSkills = () => (
        <div className="space-y-7 pb-10">
            <button
                type="button"
                onClick={closeManageSkills}
                className="inline-flex h-8 items-center gap-2 rounded-full px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
            >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
                返回市场
            </button>

            <section className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <h1 className="truncate text-[26px] font-semibold leading-tight text-text-primary">已安装技能</h1>
                        <span className="shrink-0 rounded-full bg-surface-primary px-2.5 py-1 text-xs font-medium text-text-tertiary">
                            {editableInstalledSkills.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            setInstalledSkillStatusMessage('');
                            void loadInstalledSkills();
                        }}
                        disabled={isInstalledSkillsLoading}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary disabled:opacity-50"
                    >
                        <RefreshCw className={clsx('h-3.5 w-3.5', isInstalledSkillsLoading && 'animate-spin')} strokeWidth={1.7} />
                        刷新
                    </button>
                </div>

                {installedSkillStatusMessage ? (
                    <div className="rounded-lg border border-border bg-surface-secondary/30 px-3 py-2 text-xs text-text-secondary">
                        {installedSkillStatusMessage}
                    </div>
                ) : null}
            </section>

            <section className="overflow-hidden rounded-xl border border-border bg-surface-primary">
                {isInstalledSkillsLoading && installedSkills.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-5 text-sm text-text-tertiary">
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        正在读取技能
                    </div>
                ) : installedSkills.length === 0 ? (
                    <div className="px-4 py-5 text-sm text-text-tertiary">暂无技能</div>
                ) : (
                    <div className="divide-y divide-border">
                        {editableInstalledSkills.length > 0 ? (
                            <div className="divide-y divide-border">
                                {editableInstalledSkills.map(renderInstalledSkillRow)}
                            </div>
                        ) : (
                            <div className="px-4 py-5 text-sm text-text-tertiary">暂无已安装技能</div>
                        )}
                        {builtinInstalledSkills.length > 0 ? (
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setAreBuiltinSkillsExpanded((value) => !value)}
                                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-secondary/40"
                                    aria-expanded={areBuiltinSkillsExpanded}
                                >
                                    <div className="flex min-w-0 items-center gap-2">
                                        <ArrowRight className={clsx(
                                            'h-4 w-4 shrink-0 text-text-tertiary transition-transform',
                                            areBuiltinSkillsExpanded && 'rotate-90'
                                        )} />
                                        <span className="text-sm font-medium text-text-primary">内置技能</span>
                                        <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] font-medium text-accent-primary">
                                            {builtinInstalledSkills.length}
                                        </span>
                                    </div>
                                    <span className="shrink-0 text-xs text-text-tertiary">
                                        {areBuiltinSkillsExpanded ? '收起' : '展开'}
                                    </span>
                                </button>
                                {areBuiltinSkillsExpanded ? (
                                    <div className="divide-y divide-border border-t border-border bg-surface-secondary/10">
                                        {builtinInstalledSkills.map(renderInstalledSkillRow)}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                )}
            </section>
        </div>
    );

    const renderMarketItem = (skill: ThriveSkillMarketplaceItem, hiddenCategory = '') => {
        const key = marketItemKey(skill);
        const installed = Boolean(skill.installed);
        const hiddenCategoryLabel = skillCategoryLabel(hiddenCategory);
        const displayTags = skillDisplayTags(skill)
            .filter((tag) => !hiddenCategoryLabel || skillCategoryLabel(tag) !== hiddenCategoryLabel)
            .slice(0, 2);
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
                    {displayTags.length > 0 ? (
                        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                            {displayTags.map((tag) => (
                                <SkillTag key={`${key}:tag:${tag}`}>{tag}</SkillTag>
                            ))}
                        </div>
                    ) : null}
                </div>
            </button>
        );
    };

    const renderMarketSection = (
        title: string,
        items: ThriveSkillMarketplaceItem[],
        countLabel?: string,
        sectionKey?: string,
        options: {
            hiddenCategory?: string;
            previewLimit?: number;
            onViewAll?: () => void;
        } = {},
    ) => {
        if (items.length === 0) return null;
        const visibleItems = options.previewLimit ? items.slice(0, options.previewLimit) : items;
        const canViewAll = Boolean(options.onViewAll && visibleItems.length < items.length);
        return (
            <section key={sectionKey || title} className="space-y-3">
                <div className="flex items-end justify-between gap-3 border-b border-divider pb-3">
                    <h2 className="text-base font-semibold text-text-primary">{title}</h2>
                    <div className="flex items-center gap-3">
                        <span className="text-xs text-text-tertiary">{countLabel || `${items.length} 个技能`}</span>
                        {canViewAll ? (
                            <button
                                type="button"
                                onClick={options.onViewAll}
                                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
                            >
                                查看全部
                                <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                            </button>
                        ) : null}
                    </div>
                </div>
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-2">
                    {visibleItems.map((item) => renderMarketItem(item, options.hiddenCategory))}
                </div>
            </section>
        );
    };

    const renderCollectionSection = () => {
        if (marketCollections.length === 0) return null;
        return (
            <section className="space-y-3">
                <div className="flex items-end justify-between gap-3 border-b border-divider pb-3">
                    <h2 className="text-base font-semibold text-text-primary">精选合集</h2>
                    <span className="text-xs text-text-tertiary">{marketCollections.length} 个合集</span>
                </div>
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-2">
                    {marketCollections.map((collection) => {
                        const key = collectionKey(collection);
                        const title = collectionTitle(collection);
                        const packageKeys = collectionPackageKeys(collection);
                        const description = String(collection.subtitle || collection.description || '').trim();
                        return (
                            <button
                                key={key || title}
                                type="button"
                                onClick={() => {
                                    setSelectedCollectionKey(key);
                                    setSelectedCategory('');
                                    setQuery('');
                                }}
                                className="group flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-primary/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/35"
                            >
                                <CollectionAvatar collection={collection} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <h3 className="truncate text-sm font-semibold text-text-primary">{title}</h3>
                                        {packageKeys.length > 0 ? (
                                            <span className="shrink-0 rounded-full bg-surface-primary px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">{packageKeys.length}</span>
                                        ) : null}
                                    </div>
                                    {description ? (
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-tertiary">{description}</p>
                                    ) : null}
                                </div>
                                <ArrowRight className="h-4 w-4 shrink-0 text-text-tertiary transition-colors group-hover:text-text-primary" strokeWidth={1.7} />
                            </button>
                        );
                    })}
                </div>
            </section>
        );
    };

    const renderAuthorHome = () => (
        <div className="space-y-7 pb-10">
            <button
                type="button"
                onClick={handleCloseAuthorHome}
                className="inline-flex h-8 items-center gap-2 rounded-full px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
            >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
                返回
            </button>

            {selectedAuthorProfile ? (
                <>
                    <SkillAuthorHomeHeader profile={selectedAuthorProfile} />
                    {renderMarketSection('技能', selectedAuthorProfile.skills, `${selectedAuthorProfile.skills.length} 个技能`)}
                </>
            ) : (
                <EmptyPanel title="没有找到作者信息" />
            )}
        </div>
    );

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
        const skillMarkdown = String(selectedSkillDetail?.skillMarkdown || '').trim();
        const manifestModes = manifestList(manifest, ['allowedRuntimeModes', 'runtimeModes', 'modes']);
        const skillPaths = Array.isArray(detailItem.paths) ? detailItem.paths : [];
        const detailKey = marketItemKey(detailItem);
        const detailBusy = busyMarketItemId === detailKey;
        const detailInstalled = Boolean(detailItem.installed);
        const canInstall = detailItem.installable !== false && (!detailInstalled || Boolean(detailItem.updateAvailable));
        const canTryInChat = detailInstalled && !detailItem.updateAvailable && Boolean(onTrySkillInChat);
        const detailTags = skillDisplayTags(detailItem);
        const introNote = skillIntroNote(detailItem);
        const details = [
            ['来源', sourceLabel],
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

                <section className="space-y-5 pb-2">
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
                                {detailTags.map((tag) => (
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

                        <SkillIntroNotePanel note={introNote} />

                        <SkillAuthorPanel skill={detailItem} onOpen={() => handleOpenAuthorHome(detailItem)} />

                        <section className="grid gap-x-10 gap-y-4 sm:grid-cols-2">
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

                        {skillMarkdown ? (
                            <section className="space-y-3">
                                <h2 className="text-sm font-semibold text-text-primary">SKILL.md</h2>
                                <article className="prose prose-sm max-w-3xl text-text-secondary prose-headings:text-text-primary prose-p:leading-7 prose-p:text-text-secondary prose-li:text-text-secondary prose-strong:text-text-primary prose-code:text-text-primary prose-pre:border prose-pre:border-border prose-pre:bg-surface-primary/70 prose-pre:text-text-secondary">
                                    <ReactMarkdown remarkPlugins={SAFE_REMARK_PLUGINS}>
                                        {skillMarkdown}
                                    </ReactMarkdown>
                                </article>
                            </section>
                        ) : null}
                    </div>
                )}
            </div>
        );
    };

    if (isManagingSkills) {
        return (
            <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-text-primary">
                <div className="min-h-0 flex-1 overflow-y-auto px-10 py-10 sm:px-16 lg:px-24 xl:px-32 custom-scrollbar">
                    <div className="mx-auto w-full max-w-[880px]">
                        {renderManageSkills()}
                    </div>
                </div>
            </main>
        );
    }

    if (selectedAuthorKey) {
        return (
            <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-text-primary">
                <div className="min-h-0 flex-1 overflow-y-auto px-10 py-10 sm:px-16 lg:px-24 xl:px-32 custom-scrollbar">
                    <div className="mx-auto w-full max-w-[880px]">
                        {renderAuthorHome()}
                    </div>
                </div>
            </main>
        );
    }

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
                            <button
                                type="button"
                                onClick={openManageSkills}
                                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
                            >
                                <SettingsIcon className="h-3.5 w-3.5" strokeWidth={1.8} />
                                管理
                            </button>
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
                            <button
                                type="button"
                                onClick={openSkillSubmissionDialog}
                                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-surface-primary/70 px-4 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
                            >
                                <PackagePlus className="h-4 w-4" strokeWidth={1.8} />
                                申请收录
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
                                onClick={() => {
                                    setSelectedCategory('');
                                    setSelectedCollectionKey('');
                                }}
                                className={clsx(
                                    'inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors',
                                    !selectedCategory && !selectedCollectionKey
                                        ? 'bg-accent-primary text-[rgb(var(--color-primary-text))]'
                                        : 'text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                                )}
                            >
                                全部分类
                                <span className="opacity-75">{marketItems.length}</span>
                            </button>
                            {SKILL_CATEGORY_LABELS.map((category) => (
                                <button
                                    key={category}
                                    type="button"
                                    onClick={() => openCategoryPage(category)}
                                    className={clsx(
                                        'inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors',
                                        selectedCategory === category
                                            ? 'bg-accent-primary text-[rgb(var(--color-primary-text))]'
                                            : 'text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                                    )}
                                >
                                    {category}
                                    <span className="opacity-75">{categoryCounts.get(category) || 0}</span>
                                </button>
                            ))}
                            {selectedCollection ? (
                                <button
                                    type="button"
                                    onClick={() => setSelectedCollectionKey('')}
                                    className="inline-flex h-8 items-center gap-2 rounded-full bg-accent-primary px-3 text-xs font-medium text-[rgb(var(--color-primary-text))] transition-colors hover:bg-accent-hover"
                                >
                                    {collectionTitle(selectedCollection)}
                                    <span className="opacity-75">{collectionPackageKeys(selectedCollection).length}</span>
                                </button>
                            ) : null}
                        </div>

                    </section>

                    <div className="space-y-10 pb-10">
                        {isMarketLoading && marketItems.length === 0 ? (
                            <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface-primary/45 text-sm text-text-tertiary">
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                正在读取市场
                            </div>
                        ) : filteredMarketItems.length === 0 ? (
                            <>
                                {!hasFocusedFilters ? renderCollectionSection() : null}
                                <EmptyPanel title="没有找到匹配的技能" />
                            </>
                        ) : showCategorySections ? (
                            <>
                                {!hasFocusedFilters ? renderCollectionSection() : null}
                                {categoryMarketSections.map((section) => (
                                    renderMarketSection(section.title, section.items, undefined, `category:${section.title}`, {
                                        hiddenCategory: section.title,
                                        previewLimit: CATEGORY_SECTION_PREVIEW_ITEMS,
                                        onViewAll: () => openCategoryPage(section.title),
                                    })
                                ))}
                                {renderMarketSection('更多技能', uncategorizedMarketItems, undefined, 'uncategorized')}
                            </>
                        ) : (
                            <>
                                {!hasFocusedFilters ? renderCollectionSection() : null}
                                {renderMarketSection(primarySectionTitle, primaryMarketItems, `${filteredMarketItems.length} 个技能`, undefined, {
                                    hiddenCategory: selectedCategory,
                                })}
                                {renderMarketSection('更多技能', secondaryMarketItems)}
                            </>
                        )}
                    </div>
                </div>
            </div>
            {skillSubmissionOpen ? (
                <SkillSubmissionDialog
                    form={skillSubmissionForm}
                    isSubmitting={isSkillSubmissionSubmitting}
                    error={skillSubmissionError}
                    message={skillSubmissionMessage}
                    onChange={(nextForm) => {
                        setSkillSubmissionForm(nextForm);
                        setSkillSubmissionError('');
                        setSkillSubmissionMessage('');
                    }}
                    onClose={closeSkillSubmissionDialog}
                    onSubmit={() => void submitSkillSubmission()}
                />
            ) : null}
        </main>
    );
}
