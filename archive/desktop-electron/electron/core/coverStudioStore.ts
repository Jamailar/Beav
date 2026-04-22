import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { getWorkspacePaths } from '../db';

export interface CoverAsset {
    id: string;
    title?: string;
    templateName?: string;
    prompt?: string;
    provider?: string;
    providerTemplate?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
    mimeType?: string;
    relativePath?: string;
    createdAt: string;
    updatedAt: string;
}

interface CoverCatalog {
    version: 1;
    assets: CoverAsset[];
}

const DEFAULT_CATALOG: CoverCatalog = {
    version: 1,
    assets: [],
};

function nowIso(): string {
    return new Date().toISOString();
}

function normalizePathForStore(input: string): string {
    return input.replace(/\\/g, '/');
}

export function getCoverRootDir(): string {
    const paths = getWorkspacePaths() as ReturnType<typeof getWorkspacePaths> & { cover?: string };
    return paths.cover || path.join(paths.base, 'cover');
}

function getCoverCatalogPath(): string {
    return path.join(getCoverRootDir(), 'catalog.json');
}

function getGeneratedDir(): string {
    return path.join(getCoverRootDir(), 'generated');
}

function getTemplatesDir(): string {
    return path.join(getCoverRootDir(), 'templates');
}

async function ensureCoverDirs(): Promise<void> {
    await fs.mkdir(getCoverRootDir(), { recursive: true });
    await fs.mkdir(getGeneratedDir(), { recursive: true });
    await fs.mkdir(getTemplatesDir(), { recursive: true });
}

async function readCatalog(): Promise<CoverCatalog> {
    await ensureCoverDirs();
    try {
        const raw = await fs.readFile(getCoverCatalogPath(), 'utf-8');
        const parsed = JSON.parse(raw) as CoverCatalog;
        if (parsed && Array.isArray(parsed.assets)) {
            return {
                version: 1,
                assets: parsed.assets,
            };
        }
        return DEFAULT_CATALOG;
    } catch {
        return DEFAULT_CATALOG;
    }
}

async function writeCatalog(catalog: CoverCatalog): Promise<void> {
    await ensureCoverDirs();
    await fs.writeFile(getCoverCatalogPath(), JSON.stringify(catalog, null, 2), 'utf-8');
}

function extByMime(mimeType: string): string {
    const lower = mimeType.toLowerCase();
    if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
    if (lower.includes('webp')) return 'webp';
    if (lower.includes('gif')) return 'gif';
    return 'png';
}

function extByHint(hint?: string): string {
    const normalized = String(hint || '').trim().toLowerCase().replace(/^\./, '');
    if (normalized === 'jpg' || normalized === 'jpeg') return 'jpg';
    if (normalized === 'webp') return 'webp';
    if (normalized === 'gif') return 'gif';
    if (normalized === 'bmp') return 'bmp';
    if (normalized === 'png') return 'png';
    return '';
}

export async function listCoverAssets(limit = 200): Promise<CoverAsset[]> {
    const catalog = await readCatalog();
    const sorted = [...catalog.assets].sort((a, b) => {
        const at = new Date(a.updatedAt).getTime();
        const bt = new Date(b.updatedAt).getTime();
        return bt - at;
    });
    return sorted.slice(0, Math.max(1, limit));
}

export async function createGeneratedCoverAsset(input: {
    imageBuffer: Buffer;
    mimeType?: string;
    prompt?: string;
    title?: string;
    templateName?: string;
    provider?: string;
    providerTemplate?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
}): Promise<CoverAsset> {
    await ensureCoverDirs();
    const catalog = await readCatalog();
    const mimeType = (input.mimeType || 'image/png').toLowerCase();
    const ext = extByMime(mimeType);
    const id = `cover_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const fileName = `${id}.${ext}`;
    const relativePath = normalizePathForStore(path.join('generated', fileName));
    const absolutePath = path.join(getCoverRootDir(), relativePath);
    await fs.writeFile(absolutePath, input.imageBuffer);

    const asset: CoverAsset = {
        id,
        title: input.title?.trim() || undefined,
        templateName: input.templateName?.trim() || undefined,
        prompt: String(input.prompt || '').trim() || undefined,
        provider: input.provider?.trim() || undefined,
        providerTemplate: input.providerTemplate?.trim() || undefined,
        model: input.model?.trim() || undefined,
        aspectRatio: input.aspectRatio?.trim() || undefined,
        size: input.size?.trim() || undefined,
        quality: input.quality?.trim() || undefined,
        mimeType,
        relativePath,
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };

    catalog.assets.push(asset);
    await writeCatalog(catalog);
    return asset;
}

export function getAbsoluteCoverAssetPath(relativePath: string): string {
    return path.join(getCoverRootDir(), normalizePathForStore(relativePath));
}

export async function saveCoverTemplateImage(input: {
    imageBuffer: Buffer;
    mimeType?: string;
    extensionHint?: string;
}): Promise<{ relativePath: string; mimeType: string }> {
    await ensureCoverDirs();
    const mimeType = String(input.mimeType || 'image/png').trim().toLowerCase() || 'image/png';
    const hintExt = extByHint(input.extensionHint);
    const ext = hintExt || extByMime(mimeType);
    const id = `cover_tpl_img_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const fileName = `${id}.${ext}`;
    const relativePath = normalizePathForStore(path.join('templates', fileName));
    const absolutePath = path.join(getCoverRootDir(), relativePath);
    await fs.writeFile(absolutePath, input.imageBuffer);
    return { relativePath, mimeType };
}
