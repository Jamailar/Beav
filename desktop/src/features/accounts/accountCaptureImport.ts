import type { ServerCaptureJob } from '../capture/captureTypes';
import { normalizeServerCaptureEntry, serverCaptureEntryKey } from '../capture/serverCaptureClient';

type CaptureObject = Record<string, unknown>;
const ACCOUNT_IMPORT_BATCH_LIMIT = 64;

export interface AccountCaptureImportPayload {
    profile?: CaptureObject;
    posts: CaptureObject[];
    media: CaptureObject[];
    comments: CaptureObject[];
    importedEntryKeys: string[];
}

export async function importCaptureJobToAccount(params: {
    accountId: string;
    sessionId?: string;
    platform: string;
    job: ServerCaptureJob;
    seenEntryKeys?: Set<string>;
    completeSession?: boolean;
}): Promise<AccountCaptureImportPayload> {
    const payload = buildAccountCaptureImportPayload(params.job, params.seenEntryKeys);
    for (const posts of chunkArray(payload.posts, ACCOUNT_IMPORT_BATCH_LIMIT)) {
        await window.ipcRenderer.accounts.postsBatch({
            accountId: params.accountId,
            sessionId: params.sessionId,
            platform: params.platform,
            profile: payload.profile,
            posts,
        });
    }
    for (const comments of chunkArray(payload.comments, ACCOUNT_IMPORT_BATCH_LIMIT)) {
        await window.ipcRenderer.accounts.commentsBatch({
            accountId: params.accountId,
            sessionId: params.sessionId,
            platform: params.platform,
            comments,
        });
    }
    for (const media of chunkArray(payload.media, ACCOUNT_IMPORT_BATCH_LIMIT)) {
        await window.ipcRenderer.accounts.mediaBatch({
            accountId: params.accountId,
            sessionId: params.sessionId,
            platform: params.platform,
            media,
        });
    }
    payload.importedEntryKeys.forEach((key) => params.seenEntryKeys?.add(key));
    if (params.sessionId && params.completeSession !== false) {
        await window.ipcRenderer.accounts.completeImportSession({
            sessionId: params.sessionId,
            status: 'completed',
            importedPostCount: payload.posts.length,
            failedPostCount: 0,
        });
    }
    return payload;
}

function buildAccountCaptureImportPayload(job: ServerCaptureJob, seenEntryKeys?: Set<string>): AccountCaptureImportPayload {
    const profile = normalizeAccountCaptureProfile(job);
    const posts: CaptureObject[] = [];
    const media: CaptureObject[] = [];
    const comments: CaptureObject[] = [];
    const importedEntryKeys: string[] = [];
    const entries = Array.isArray(job.result?.entries) ? job.result.entries : [];
    for (const [index, rawEntry] of entries.entries()) {
        const entryKey = serverCaptureEntryKey(job, rawEntry, index);
        if (seenEntryKeys?.has(entryKey)) continue;
        const entry = normalizeServerCaptureEntry(rawEntry);
        if (!isCaptureObject(entry)) continue;
        const source = isCaptureObject(entry.source) ? entry.source : {};
        const content = isCaptureObject(entry.content) ? entry.content : {};
        const assets = isCaptureObject(entry.assets) ? entry.assets : {};
        const metadata = isCaptureObject(content.metadata) ? content.metadata : {};
        const postId = firstCaptureString([
            source.externalId,
            content.platformPostId,
            content.noteId,
            content.id,
            source.sourceLink,
            source.sourceUrl,
            job.externalId,
        ]);
        if (!postId) continue;
        const sourceUrl = firstCaptureString([source.sourceLink, source.sourceUrl, content.url, job.canonicalUrl, job.url]);
        const imageUrls = captureStringArray(assets.imageUrls);
        const videoUrl = firstCaptureString([assets.videoUrl, content.videoUrl]);
        const postMedia = [
            ...imageUrls.map((url, index) => ({
                id: `${postId}:image:${index}`,
                mediaId: `${postId}:image:${index}`,
                postId,
                kind: index === 0 ? 'cover-image' : 'image',
                url,
                index,
                source: 'server-capture',
            })),
            ...(videoUrl ? [{
                id: `${postId}:video:0`,
                mediaId: `${postId}:video:0`,
                postId,
                kind: 'video',
                url: videoUrl,
                index: imageUrls.length,
                source: 'server-capture',
            }] : []),
        ];
        posts.push({
            id: postId,
            platformPostId: postId,
            noteId: postId,
            kind: firstCaptureString([entry.kind]) || 'profile-content',
            title: firstCaptureString([content.title]) || `内容 ${postId}`,
            content: firstCaptureString([content.text, content.description, content.excerpt]),
            description: firstCaptureString([content.description, content.text, content.excerpt]),
            url: sourceUrl,
            sourceUrl,
            author: firstCaptureString([content.author]),
            authorId: firstCaptureString([content.authorId]),
            authorAvatarUrl: firstCaptureString([content.authorAvatarUrl]),
            stats: isCaptureObject(content.stats) ? content.stats : {},
            tags: Array.isArray(content.tags) ? content.tags : [],
            media: postMedia,
            imageUrls,
            videoUrl,
            raw: entry,
            capturedAt: new Date().toISOString(),
        });
        media.push(...postMedia);
        const xhsComments = isCaptureObject(metadata.xhsComments) ? metadata.xhsComments : null;
        const entryComments = Array.isArray(xhsComments?.comments) ? xhsComments.comments : [];
        for (const comment of entryComments) {
            if (!isCaptureObject(comment)) continue;
            comments.push({
                ...comment,
                postId,
                noteId: postId,
                platformCommentId: firstCaptureString([comment.platformCommentId, comment.id]),
            });
        }
        importedEntryKeys.push(entryKey);
    }
    return { profile, posts, media, comments, importedEntryKeys };
}

function normalizeAccountCaptureProfile(job: ServerCaptureJob): CaptureObject | undefined {
    const profile = isCaptureObject(job.result?.profile) ? job.result.profile : null;
    if (!profile) return undefined;
    const stats = isCaptureObject(profile.stats) ? profile.stats : {};
    return {
        platform: firstCaptureString([profile.platform, (job as { platform?: unknown }).platform, job.kind === 'xhs-profile' ? 'xiaohongshu' : '']),
        platformUserId: firstCaptureString([profile.platformUserId, profile.userId, profile.id, job.externalId]),
        username: firstCaptureString([profile.username, profile.nickname, profile.name]),
        displayName: firstCaptureString([profile.displayName, profile.username, profile.nickname, profile.name]),
        avatarUrl: firstCaptureString([profile.avatarUrl, profile.avatar, profile.image]),
        bio: firstCaptureString([profile.bio, profile.desc, profile.description]),
        homepageUrl: firstCaptureString([profile.homepageUrl, job.canonicalUrl, job.url]),
        stats: {
            ...stats,
            followers: captureNumberValue(stats.followers) ?? captureNumberValue(stats.followerCount) ?? captureNumberValue(stats.fans),
            totalPosts: captureNumberValue(stats.totalPosts) ?? captureNumberValue(stats.postCount) ?? captureNumberValue(stats.noteCount) ?? captureNumberValue(stats.works),
            totalLikes: captureNumberValue(stats.totalLikes) ?? captureNumberValue(stats.likeCount) ?? captureNumberValue(stats.likes) ?? captureNumberValue(stats.likedCount),
        },
        raw: profile,
    };
}

function isCaptureObject(value: unknown): value is CaptureObject {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstCaptureString(values: unknown[]): string {
    for (const value of values) {
        const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
        if (text) return text;
    }
    return '';
}

function captureNumberValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().replace(/,/g, '');
    if (!normalized) return undefined;
    if (normalized.endsWith('万')) {
        const number = Number(normalized.slice(0, -1));
        return Number.isFinite(number) ? Math.round(number * 10000) : undefined;
    }
    const number = Number(normalized);
    return Number.isFinite(number) ? number : undefined;
}

function captureStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const output: string[] = [];
    for (const item of value) {
        const text = firstCaptureString([item]);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        output.push(text);
    }
    return output;
}

function chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}
