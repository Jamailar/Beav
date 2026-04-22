import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatWechatArticleFromMarkdown } from './wechatFormatter';

export interface WechatOfficialAccountBindingSummary {
    id: string;
    name: string;
    appId: string;
    createdAt: string;
    updatedAt: string;
    verifiedAt?: string;
    isActive: boolean;
}

interface WechatOfficialAccountBindingRecord extends WechatOfficialAccountBindingSummary {
    secret: string;
}

interface WechatOfficialAccountStore {
    bindings: WechatOfficialAccountBindingRecord[];
    activeBindingId?: string;
}

interface AccessTokenCacheEntry {
    token: string;
    expiresAt: number;
}

interface DraftPublishInput {
    bindingId?: string;
    title?: string;
    content: string;
    metadata?: Record<string, unknown>;
    sourcePath?: string;
}

interface ResolvedAsset {
    buffer: Buffer;
    filename: string;
    mimeType: string;
}

const STORE_FILE_NAME = 'wechat-official-accounts.json';
const DEFAULT_AUTHOR = 'RedBox';
const MAX_TITLE_CHARS = 64;
const MAX_AUTHOR_CHARS = 16;
const MAX_DIGEST_CHARS = 120;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

const loadJSDOM = (): typeof import('jsdom').JSDOM => {
    // Keep jsdom as a runtime dependency instead of bundling it into Electron main.
    // This avoids Rollup trying to resolve jsdom's optional canvas peer during build/runtime bundling.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JSDOM } = require('jsdom') as typeof import('jsdom');
    return JSDOM;
};

const ensureString = (value: unknown): string => String(value || '').trim();

const clampText = (value: unknown, limit: number): string => {
    const text = ensureString(value).replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
};

const inferMimeTypeFromFilename = (filename: string): string => {
    const lowered = filename.toLowerCase();
    if (lowered.endsWith('.png')) return 'image/png';
    if (lowered.endsWith('.webp')) return 'image/webp';
    if (lowered.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
};

const buildStorePath = (): string => path.join(app.getPath('userData'), STORE_FILE_NAME);

const sanitizeBinding = (binding: WechatOfficialAccountBindingRecord, activeBindingId?: string): WechatOfficialAccountBindingSummary => ({
    id: binding.id,
    name: binding.name,
    appId: binding.appId,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    verifiedAt: binding.verifiedAt,
    isActive: binding.id === activeBindingId,
});

async function readStore(): Promise<WechatOfficialAccountStore> {
    try {
        const raw = await fs.readFile(buildStorePath(), 'utf-8');
        const parsed = JSON.parse(raw) as WechatOfficialAccountStore;
        const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
        return {
            bindings: bindings.map((item) => ({
                id: ensureString(item.id),
                name: ensureString(item.name),
                appId: ensureString(item.appId),
                secret: ensureString((item as WechatOfficialAccountBindingRecord).secret),
                createdAt: ensureString(item.createdAt),
                updatedAt: ensureString(item.updatedAt),
                verifiedAt: ensureString(item.verifiedAt) || undefined,
                isActive: false,
            })).filter((item) => item.id && item.appId && item.secret),
            activeBindingId: ensureString(parsed.activeBindingId) || undefined,
        };
    } catch {
        return { bindings: [] };
    }
}

async function writeStore(store: WechatOfficialAccountStore): Promise<void> {
    const storePath = buildStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

function buildBindingId(appId: string): string {
    return `oa_${appId.slice(-8) || Date.now()}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
        }
        const errorCode = Number((data as Record<string, unknown>).errcode);
        if (Number.isFinite(errorCode) && errorCode !== 0) {
            throw new Error(String((data as Record<string, unknown>).errmsg || `微信接口错误 ${errorCode}`));
        }
        return data as T;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchAccessToken(binding: WechatOfficialAccountBindingRecord): Promise<string> {
    const cached = accessTokenCache.get(binding.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
        return cached.token;
    }

    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', binding.appId);
    url.searchParams.set('secret', binding.secret);
    const data = await fetchJson<{ access_token?: string; expires_in?: number }>(url.toString());
    const token = ensureString(data.access_token);
    if (!token) {
        throw new Error('未能获取公众号 access_token，请检查 AppID / Secret 是否正确。');
    }
    accessTokenCache.set(binding.id, {
        token,
        expiresAt: Date.now() + Math.max(300, Number(data.expires_in || 7200) - 120) * 1000,
    });
    return token;
}

function extractPreferredCoverSource(markdown: string, metadata?: Record<string, unknown>): string | undefined {
    const fromMetadata = [
        metadata?.coverImageUrl,
        metadata?.coverUrl,
        metadata?.coverImage,
        metadata?.cover,
        metadata?.heroImage,
        metadata?.heroImageUrl,
    ].map((item) => ensureString(item)).find(Boolean);
    if (fromMetadata) return fromMetadata;

    const imageMatch = String(markdown || '').match(/!\[[^\]]*?\]\((.+?)(?:\s+["'][^"']*["'])?\)/);
    return imageMatch ? ensureString(imageMatch[1]) || undefined : undefined;
}

async function resolveAsset(source: string, sourcePath?: string): Promise<ResolvedAsset> {
    const trimmed = ensureString(source);
    if (!trimmed) {
        throw new Error('缺少图片资源。');
    }

    if (/^https?:\/\//i.test(trimmed)) {
        const response = await fetch(trimmed);
        if (!response.ok) {
            throw new Error(`下载图片失败：HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const url = new URL(trimmed);
        const filename = path.basename(url.pathname) || `image-${Date.now()}.jpg`;
        return {
            buffer,
            filename,
            mimeType: response.headers.get('content-type') || inferMimeTypeFromFilename(filename),
        };
    }

    if (/^data:image\//i.test(trimmed)) {
        const [header, data] = trimmed.split(',', 2);
        const mimeType = header.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/i)?.[1] || 'image/png';
        const ext = mimeType.split('/')[1] || 'png';
        return {
            buffer: Buffer.from(data || '', 'base64'),
            filename: `image-${Date.now()}.${ext}`,
            mimeType,
        };
    }

    const resolvedPath = path.isAbsolute(trimmed)
        ? trimmed
        : sourcePath
            ? path.resolve(path.dirname(sourcePath), trimmed)
            : path.resolve(trimmed);
    const buffer = await fs.readFile(resolvedPath);
    return {
        buffer,
        filename: path.basename(resolvedPath) || `image-${Date.now()}.jpg`,
        mimeType: inferMimeTypeFromFilename(resolvedPath),
    };
}

async function uploadWeChatImage(
    accessToken: string,
    asset: ResolvedAsset,
    mode: 'content' | 'material',
): Promise<{ url?: string; mediaId?: string }> {
    const endpoint = mode === 'content'
        ? `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`
        : `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`;
    const form = new FormData();
    form.append('media', new Blob([Uint8Array.from(asset.buffer)], { type: asset.mimeType }), asset.filename);
    const response = await fetch(endpoint, {
        method: 'POST',
        body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`微信图片上传失败：HTTP ${response.status}`);
    }
    const errorCode = Number((data as Record<string, unknown>).errcode);
    if (Number.isFinite(errorCode) && errorCode !== 0) {
        throw new Error(String((data as Record<string, unknown>).errmsg || `微信图片上传失败 ${errorCode}`));
    }
    return {
        url: ensureString((data as Record<string, unknown>).url) || undefined,
        mediaId: ensureString((data as Record<string, unknown>).media_id) || undefined,
    };
}

async function uploadInlineImagesToWeChatHtml(
    accessToken: string,
    html: string,
    sourcePath?: string,
): Promise<string> {
    const JSDOM = loadJSDOM();
    const dom = new JSDOM(html);
    const imageNodes = Array.from(dom.window.document.querySelectorAll('img'));
    const uploadedCache = new Map<string, string>();

    for (const imageNode of imageNodes) {
        const src = ensureString(imageNode.getAttribute('src'));
        if (!src) continue;
        if (uploadedCache.has(src)) {
            imageNode.setAttribute('src', uploadedCache.get(src) || src);
            continue;
        }
        const asset = await resolveAsset(src, sourcePath);
        const uploaded = await uploadWeChatImage(accessToken, asset, 'content');
        if (uploaded.url) {
            uploadedCache.set(src, uploaded.url);
            imageNode.setAttribute('src', uploaded.url);
        }
    }

    return dom.window.document.body.innerHTML;
}

function buildDigest(markdown: string, metadata?: Record<string, unknown>): string {
    const preferred = clampText(
        metadata?.digest
        || metadata?.summary
        || metadata?.description
        || metadata?.introduction,
        MAX_DIGEST_CHARS,
    );
    if (preferred) return preferred;
    const plain = String(markdown || '')
        .replace(/^---[\s\S]*?---/m, ' ')
        .replace(/!\[[^\]]*?\]\(.+?\)/g, ' ')
        .replace(/\[(.*?)\]\(.+?\)/g, '$1')
        .replace(/[`>#*_~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clampText(plain, MAX_DIGEST_CHARS);
}

function buildAuthor(metadata?: Record<string, unknown>): string {
    return clampText(metadata?.author || metadata?.creator || DEFAULT_AUTHOR, MAX_AUTHOR_CHARS) || DEFAULT_AUTHOR;
}

async function resolveBinding(bindingId?: string): Promise<WechatOfficialAccountBindingRecord> {
    const store = await readStore();
    const targetId = ensureString(bindingId) || ensureString(store.activeBindingId);
    const binding = store.bindings.find((item) => item.id === targetId)
        || store.bindings[0];
    if (!binding) {
        throw new Error('当前还没有绑定公众号，请先完成绑定。');
    }
    return binding;
}

export async function getWechatOfficialAccountStatus(): Promise<{
    bindings: WechatOfficialAccountBindingSummary[];
    activeBinding?: WechatOfficialAccountBindingSummary;
}> {
    const store = await readStore();
    const activeBindingId = ensureString(store.activeBindingId) || store.bindings[0]?.id;
    const bindings = store.bindings.map((item) => sanitizeBinding(item, activeBindingId));
    return {
        bindings,
        activeBinding: bindings.find((item) => item.isActive),
    };
}

export async function bindWechatOfficialAccount(input: {
    name?: string;
    appId: string;
    secret: string;
    setActive?: boolean;
}): Promise<WechatOfficialAccountBindingSummary> {
    const appId = ensureString(input.appId);
    const secret = ensureString(input.secret);
    if (!appId || !secret) {
        throw new Error('绑定公众号需要填写 AppID 和 Secret。');
    }

    const store = await readStore();
    const now = new Date().toISOString();
    const existing = store.bindings.find((item) => item.appId === appId);
    const baseRecord: WechatOfficialAccountBindingRecord = existing || {
        id: buildBindingId(appId),
        name: ensureString(input.name) || `公众号 ${appId.slice(-4)}`,
        appId,
        secret,
        createdAt: now,
        updatedAt: now,
        isActive: false,
    };

    const binding: WechatOfficialAccountBindingRecord = {
        ...baseRecord,
        name: ensureString(input.name) || baseRecord.name,
        appId,
        secret,
        updatedAt: now,
        verifiedAt: now,
        isActive: false,
    };

    await fetchAccessToken(binding);

    store.bindings = [
        ...store.bindings.filter((item) => item.id !== binding.id),
        binding,
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (input.setActive !== false || !store.activeBindingId) {
        store.activeBindingId = binding.id;
    }
    await writeStore(store);
    return sanitizeBinding(binding, store.activeBindingId);
}

export async function unbindWechatOfficialAccount(bindingId?: string): Promise<void> {
    const store = await readStore();
    const targetId = ensureString(bindingId) || ensureString(store.activeBindingId);
    if (!targetId) return;
    store.bindings = store.bindings.filter((item) => item.id !== targetId);
    if (store.activeBindingId === targetId) {
        store.activeBindingId = store.bindings[0]?.id;
    }
    accessTokenCache.delete(targetId);
    await writeStore(store);
}

export async function createWechatOfficialDraftFromMarkdown(input: DraftPublishInput): Promise<{
    title: string;
    digest: string;
    mediaId?: string;
}> {
    const binding = await resolveBinding(input.bindingId);
    const accessToken = await fetchAccessToken(binding);
    const metadata = (input.metadata && typeof input.metadata === 'object')
        ? input.metadata as Record<string, unknown>
        : {};
    const formatted = formatWechatArticleFromMarkdown({
        title: input.title,
        content: input.content,
        metadata,
    });
    const title = clampText(formatted.title || input.title || metadata.title || '未命名文章', MAX_TITLE_CHARS) || '未命名文章';
    const digest = buildDigest(input.content, metadata);
    const author = buildAuthor(metadata);

    const coverSource = extractPreferredCoverSource(input.content, metadata);
    if (!coverSource) {
        throw new Error('推送公众号草稿前需要至少一张封面图或正文首图。');
    }

    const [coverAsset, htmlWithUploadedImages] = await Promise.all([
        resolveAsset(coverSource, input.sourcePath),
        uploadInlineImagesToWeChatHtml(accessToken, formatted.html, input.sourcePath),
    ]);
    const coverUpload = await uploadWeChatImage(accessToken, coverAsset, 'material');
    if (!coverUpload.mediaId) {
        throw new Error('封面上传成功但未返回 media_id，无法创建草稿。');
    }

    const payload = {
        articles: [
            {
                title,
                author,
                digest,
                content: htmlWithUploadedImages,
                content_source_url: ensureString(metadata.sourceUrl) || '',
                thumb_media_id: coverUpload.mediaId,
                need_open_comment: 0,
                only_fans_can_comment: 0,
            },
        ],
    };
    const url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`;
    const data = await fetchJson<{ media_id?: string }>(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    return {
        title,
        digest,
        mediaId: ensureString(data.media_id) || undefined,
    };
}
