import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { getWorkspacePaths } from '../db';
import { getPackageKindFromFileName, isManuscriptPackageName } from '../../shared/manuscriptFiles';

export type MediaAssetSource = 'generated' | 'planned' | 'imported';

export interface MediaAsset {
  id: string;
  source: MediaAssetSource;
  projectId?: string;
  title?: string;
  prompt?: string;
  provider?: string;
  providerTemplate?: string;
  model?: string;
  aspectRatio?: string;
  size?: string;
  quality?: string;
  mimeType?: string;
  relativePath?: string;
  boundManuscriptPath?: string;
  createdAt: string;
  updatedAt: string;
}

interface MediaCatalog {
  version: 1;
  assets: MediaAsset[];
}

const DEFAULT_CATALOG: MediaCatalog = {
  version: 1,
  assets: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

function normalizePathForStore(input: string): string {
  return input.replace(/\\/g, '/');
}

function getMediaRootDir(): string {
  const paths = getWorkspacePaths() as ReturnType<typeof getWorkspacePaths> & { media?: string };
  return paths.media || path.join(paths.base, 'media');
}

function getCatalogPath(): string {
  return path.join(getMediaRootDir(), 'catalog.json');
}

function getGeneratedDir(): string {
  return path.join(getMediaRootDir(), 'generated');
}

function getImportedDir(): string {
  return path.join(getMediaRootDir(), 'imported');
}

async function ensureMediaDirs(): Promise<void> {
  await fs.mkdir(getMediaRootDir(), { recursive: true });
  await fs.mkdir(getGeneratedDir(), { recursive: true });
  await fs.mkdir(getImportedDir(), { recursive: true });
}

async function readCatalog(): Promise<MediaCatalog> {
  await ensureMediaDirs();
  try {
    const raw = await fs.readFile(getCatalogPath(), 'utf-8');
    const parsed = JSON.parse(raw) as MediaCatalog;
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

async function writeCatalog(catalog: MediaCatalog): Promise<void> {
  await ensureMediaDirs();
  await fs.writeFile(getCatalogPath(), JSON.stringify(catalog, null, 2), 'utf-8');
}

function extByMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('quicktime') || lower.includes('mov')) return 'mov';
  return 'png';
}

function guessMimeTypeByExtension(inputPath: string): string {
  const ext = path.extname(inputPath).toLowerCase();
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.opus') return 'audio/opus';
  return 'application/octet-stream';
}

function sanitizeImportedFileBaseName(fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const normalizedBase = base
    .normalize('NFKD')
    .replace(/[^\w\-.一-龥]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
  return normalizedBase || `asset_${Date.now()}`;
}

function parseDataUrl(value: string): { mimeType: string; buffer: Buffer } | null {
  const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mimeType: String(match[1] || 'application/octet-stream').toLowerCase(),
    buffer: Buffer.from(String(match[2] || ''), 'base64'),
  };
}

function inferFileNameBase(input: { title?: string; source?: string }, fallbackPrefix = 'asset'): string {
  const title = String(input.title || '').trim();
  if (title) {
    return sanitizeImportedFileBaseName(title);
  }

  const source = String(input.source || '').trim();
  if (source) {
    try {
      const url = new URL(source);
      const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '').trim();
      if (lastSegment) {
        return sanitizeImportedFileBaseName(path.basename(lastSegment, path.extname(lastSegment)));
      }
    } catch {
      // ignore invalid URL parsing
    }
  }

  return `${fallbackPrefix}_${Date.now()}`;
}

async function updateManuscriptBinding(
  manuscriptPath: string,
  asset: MediaAsset,
  role: 'cover' | 'image' | 'asset' = 'asset'
): Promise<void> {
  const manuscriptsRoot = getWorkspacePaths().manuscripts;
  const normalized = normalizePathForStore(manuscriptPath);
  const absolutePath = path.join(manuscriptsRoot, normalized);
  const stats = await fs.stat(absolutePath);
  if (stats.isDirectory() && isManuscriptPackageName(path.basename(absolutePath))) {
    await updateManuscriptPackageBinding(normalized, asset, role);
    return;
  }
  const raw = await fs.readFile(absolutePath, 'utf-8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const current = Array.isArray(data.boundMedia) ? data.boundMedia : [];
  const filtered = current.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const id = (item as Record<string, unknown>).assetId;
    return id !== asset.id;
  });
  filtered.push({
    assetId: asset.id,
    mediaPath: asset.relativePath || '',
    source: asset.source,
    boundAt: nowIso(),
  });
  data.boundMedia = filtered;
  data.updatedAt = Date.now();
  const next = matter.stringify(parsed.content, data);
  await fs.writeFile(absolutePath, next, 'utf-8');
}

async function removeManuscriptBinding(manuscriptPath: string, assetId: string): Promise<void> {
  const manuscriptsRoot = getWorkspacePaths().manuscripts;
  const normalized = normalizePathForStore(manuscriptPath);
  const absolutePath = path.join(manuscriptsRoot, normalized);
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory() && isManuscriptPackageName(path.basename(absolutePath))) {
      await removeManuscriptPackageBinding(normalized, assetId);
      return;
    }
    const raw = await fs.readFile(absolutePath, 'utf-8');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const current = Array.isArray(data.boundMedia) ? data.boundMedia : [];
    const filtered = current.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const id = (item as Record<string, unknown>).assetId;
      return id !== assetId;
    });
    data.boundMedia = filtered;
    data.updatedAt = Date.now();
    const next = matter.stringify(parsed.content, data);
    await fs.writeFile(absolutePath, next, 'utf-8');
  } catch {
    // Ignore missing manuscript or malformed frontmatter during delete cleanup.
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function getPackageTimelinePath(packagePath: string): string {
  return path.join(packagePath, 'timeline.otio.json');
}

function inferAssetKind(asset: MediaAsset): 'image' | 'video' | 'audio' | 'unknown' {
  const mime = String(asset.mimeType || '').toLowerCase();
  const ref = `${asset.relativePath || ''}`.toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(ref)) return 'image';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(ref)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(ref)) return 'audio';
  return 'unknown';
}

function createDefaultOtioTimeline(title: string) {
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: title,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          children: [],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'A1',
          kind: 'Audio',
          children: [],
        },
      ],
    },
    metadata: {
      owner: 'redbox',
      engine: 'ai-editing',
      version: 1,
      sourceRefs: [],
    },
  };
}

function createTimelineClipId(): string {
  return `clip_${randomUUID().slice(0, 8)}`;
}

async function syncPackageTimelineForAsset(packagePath: string, asset: MediaAsset, action: 'add' | 'remove'): Promise<void> {
  const packageKind = getPackageKindFromFileName(path.basename(packagePath));
  if (packageKind !== 'video' && packageKind !== 'audio') {
    return;
  }

  const timelinePath = getPackageTimelinePath(packagePath);
  const timeline = await readJsonFile<any>(timelinePath, createDefaultOtioTimeline(path.basename(packagePath)));
  const tracks = Array.isArray(timeline?.tracks?.children) ? timeline.tracks.children : [];
  const sourceRefs = Array.isArray(timeline?.metadata?.sourceRefs) ? timeline.metadata.sourceRefs : [];
  const assetKind = inferAssetKind(asset);
  const targetTrackName = assetKind === 'audio' ? 'A1' : 'V1';
  const targetTrack = tracks.find((track: any) => String(track?.name || '') === targetTrackName);
  if (!targetTrack) {
    await writeJsonFile(timelinePath, timeline);
    return;
  }

  const normalizedSourceRefs = sourceRefs.filter((item: any) => String(item?.assetId || '') !== asset.id);
  const nextChildren = Array.isArray(targetTrack.children) ? targetTrack.children.filter((item: any) => String(item?.metadata?.assetId || '') !== asset.id) : [];

  if (action === 'add') {
    const clipOrder = nextChildren.length;
    normalizedSourceRefs.push({
      assetId: asset.id,
      mediaPath: asset.relativePath || '',
      mimeType: asset.mimeType || '',
      track: targetTrackName,
      order: clipOrder,
      assetKind,
      addedAt: nowIso(),
    });
    nextChildren.push({
      OTIO_SCHEMA: 'Clip.2',
      name: asset.title || asset.id,
      source_range: null,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: asset.relativePath || '',
          available_range: null,
          metadata: {
            assetId: asset.id,
            mimeType: asset.mimeType || '',
          },
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      metadata: {
        clipId: createTimelineClipId(),
        assetId: asset.id,
        assetKind,
        source: 'media-library',
        order: clipOrder,
        durationMs: null,
        trimInMs: 0,
        trimOutMs: 0,
        enabled: true,
      },
    });
  }

  const normalizedChildren = nextChildren.map((item: any, index: number) => ({
    ...item,
    metadata: {
      ...(item?.metadata || {}),
      order: index,
      durationMs: item?.metadata?.durationMs ?? null,
      trimInMs: item?.metadata?.trimInMs ?? 0,
      trimOutMs: item?.metadata?.trimOutMs ?? 0,
      enabled: item?.metadata?.enabled ?? true,
    },
  }));
  const normalizedSourceRefsWithOrder = normalizedSourceRefs.map((item: any, index: number) => ({
    ...item,
    order: index,
  }));

  targetTrack.children = normalizedChildren;
  timeline.metadata = {
    ...(timeline.metadata || {}),
    sourceRefs: normalizedSourceRefsWithOrder,
  };

  await writeJsonFile(timelinePath, timeline);
}

async function updateManuscriptPackageBinding(
  manuscriptPath: string,
  asset: MediaAsset,
  role: 'cover' | 'image' | 'asset'
): Promise<void> {
  const manuscriptsRoot = getWorkspacePaths().manuscripts;
  const packagePath = path.join(manuscriptsRoot, normalizePathForStore(manuscriptPath));
  const assetsPath = path.join(packagePath, 'assets.json');
  const coverPath = path.join(packagePath, 'cover.json');
  const imagesPath = path.join(packagePath, 'images.json');
  const record = {
    assetId: asset.id,
    mediaPath: asset.relativePath || '',
    source: asset.source,
    boundAt: nowIso(),
    role,
  };

  const assetsJson = await readJsonFile<{ items: Array<Record<string, unknown>> }>(assetsPath, { items: [] });
  assetsJson.items = (assetsJson.items || []).filter((item) => String(item.assetId || '') !== asset.id || String(item.role || '') !== role);
  assetsJson.items.push(record);
  await writeJsonFile(assetsPath, assetsJson);

  if (role === 'cover') {
    await writeJsonFile(coverPath, {
      assetId: asset.id,
      mediaPath: asset.relativePath || '',
      updatedAt: nowIso(),
    });
  }

  if (role === 'image') {
    const imagesJson = await readJsonFile<{ items: Array<Record<string, unknown>> }>(imagesPath, { items: [] });
    imagesJson.items = (imagesJson.items || []).filter((item) => String(item.assetId || '') !== asset.id);
    imagesJson.items.push({
      assetId: asset.id,
      mediaPath: asset.relativePath || '',
      addedAt: nowIso(),
    });
    await writeJsonFile(imagesPath, imagesJson);
  }

  if (role === 'asset') {
    await syncPackageTimelineForAsset(packagePath, asset, 'add');
  }
}

async function removeManuscriptPackageBinding(manuscriptPath: string, assetId: string): Promise<void> {
  const manuscriptsRoot = getWorkspacePaths().manuscripts;
  const packagePath = path.join(manuscriptsRoot, normalizePathForStore(manuscriptPath));
  const assetsPath = path.join(packagePath, 'assets.json');
  const coverPath = path.join(packagePath, 'cover.json');
  const imagesPath = path.join(packagePath, 'images.json');

  const assetsJson = await readJsonFile<{ items: Array<Record<string, unknown>> }>(assetsPath, { items: [] });
  assetsJson.items = (assetsJson.items || []).filter((item) => String(item.assetId || '') !== assetId);
  await writeJsonFile(assetsPath, assetsJson);

  const coverJson = await readJsonFile<Record<string, unknown>>(coverPath, { assetId: null });
  if (String(coverJson.assetId || '') === assetId) {
    await writeJsonFile(coverPath, { assetId: null, updatedAt: nowIso() });
  }

  const imagesJson = await readJsonFile<{ items: Array<Record<string, unknown>> }>(imagesPath, { items: [] });
  imagesJson.items = (imagesJson.items || []).filter((item) => String(item.assetId || '') !== assetId);
  await writeJsonFile(imagesPath, imagesJson);

  await syncPackageTimelineForAsset(packagePath, {
    id: assetId,
    source: 'imported',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }, 'remove');
}

export async function listMediaAssets(limit = 200): Promise<MediaAsset[]> {
  const catalog = await readCatalog();
  const sorted = [...catalog.assets].sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    return bt - at;
  });
  return sorted.slice(0, Math.max(1, limit));
}

export async function createGeneratedMediaAsset(input: {
  prompt: string;
  dataBuffer: Buffer;
  mimeType?: string;
  projectId?: string;
  provider?: string;
  providerTemplate?: string;
  model?: string;
  aspectRatio?: string;
  size?: string;
  quality?: string;
  title?: string;
}): Promise<MediaAsset> {
  await ensureMediaDirs();
  const catalog = await readCatalog();
  const mimeType = (input.mimeType || 'image/png').toLowerCase();
  const ext = extByMime(mimeType);
  const id = `media_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const fileName = `${id}.${ext}`;
  const relativePath = normalizePathForStore(path.join('generated', fileName));
  const absolutePath = path.join(getMediaRootDir(), relativePath);
  await fs.writeFile(absolutePath, input.dataBuffer);

  const asset: MediaAsset = {
    id,
    source: 'generated',
    projectId: input.projectId,
    title: input.title?.trim() || undefined,
    prompt: normalizePrompt(input.prompt),
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

export async function importMediaFiles(filePaths: string[]): Promise<MediaAsset[]> {
  await ensureMediaDirs();
  const catalog = await readCatalog();
  const imported: MediaAsset[] = [];

  for (const rawPath of filePaths) {
    const absoluteSourcePath = path.resolve(path.normalize(rawPath));
    const stat = await fs.stat(absoluteSourcePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }

    const sourceName = path.basename(absoluteSourcePath);
    const ext = path.extname(sourceName).toLowerCase();
    const mimeType = guessMimeTypeByExtension(sourceName);
    const assetId = `media_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const safeBaseName = sanitizeImportedFileBaseName(sourceName);
    const targetFileName = `${assetId}_${safeBaseName}${ext}`;
    const relativePath = normalizePathForStore(path.join('imported', targetFileName));
    const absoluteTargetPath = path.join(getMediaRootDir(), relativePath);
    await fs.copyFile(absoluteSourcePath, absoluteTargetPath);

    const timestamp = nowIso();
    const asset: MediaAsset = {
      id: assetId,
      source: 'imported',
      title: path.basename(sourceName, ext) || safeBaseName,
      mimeType,
      relativePath,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    catalog.assets.push(asset);
    imported.push(asset);
  }

  if (imported.length > 0) {
    await writeCatalog(catalog);
  }

  return imported;
}

export async function importMediaSources(items: Array<{ title?: string; source: string }>): Promise<MediaAsset[]> {
  await ensureMediaDirs();
  const catalog = await readCatalog();
  const imported: MediaAsset[] = [];

  for (const item of items) {
    const source = String(item?.source || '').trim();
    if (!source) continue;

    let buffer: Buffer | null = null;
    let mimeType = 'application/octet-stream';

    const dataUrl = parseDataUrl(source);
    if (dataUrl) {
      buffer = dataUrl.buffer;
      mimeType = dataUrl.mimeType;
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, {
        headers: {
          'Accept': '*/*',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch media source: ${response.status} ${response.statusText}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
      mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || guessMimeTypeByExtension(source);
    } else {
      throw new Error(`Unsupported media source: ${source.slice(0, 80)}`);
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('Empty media source payload');
    }

    const assetId = `media_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const ext = extByMime(mimeType || guessMimeTypeByExtension(source));
    const baseName = inferFileNameBase(item, 'imported');
    const targetFileName = `${assetId}_${baseName}.${ext}`;
    const relativePath = normalizePathForStore(path.join('imported', targetFileName));
    const absolutePath = path.join(getMediaRootDir(), relativePath);
    await fs.writeFile(absolutePath, buffer);

    const timestamp = nowIso();
    const asset: MediaAsset = {
      id: assetId,
      source: 'imported',
      title: String(item?.title || '').trim() || baseName,
      mimeType: mimeType || guessMimeTypeByExtension(targetFileName),
      relativePath,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    catalog.assets.push(asset);
    imported.push(asset);
  }

  if (imported.length > 0) {
    await writeCatalog(catalog);
  }

  return imported;
}

export async function ensurePlannedMediaAssetsForProject(input: {
  projectId: string;
  prompts: string[];
  coverPrompt?: string;
  model?: string;
}): Promise<MediaAsset[]> {
  const normalizedPrompts = Array.from(
    new Set(
      [
        ...(input.coverPrompt ? [input.coverPrompt] : []),
        ...input.prompts,
      ]
        .map((item) => normalizePrompt(item))
        .filter(Boolean)
    )
  );

  if (normalizedPrompts.length === 0) {
    return [];
  }

  const catalog = await readCatalog();
  const created: MediaAsset[] = [];

  for (const prompt of normalizedPrompts) {
    const exists = catalog.assets.find((asset) =>
      asset.source === 'planned' &&
      asset.projectId === input.projectId &&
      normalizePrompt(asset.prompt || '') === prompt
    );

    if (exists) {
      continue;
    }

    const asset: MediaAsset = {
      id: `media_plan_${Date.now()}_${randomUUID().slice(0, 8)}`,
      source: 'planned',
      projectId: input.projectId,
      prompt,
      model: input.model?.trim() || undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    catalog.assets.push(asset);
    created.push(asset);
  }

  if (created.length > 0) {
    await writeCatalog(catalog);
  }

  return created;
}

export async function bindMediaAssetToManuscript(input: {
  assetId: string;
  manuscriptPath: string;
  role?: 'cover' | 'image' | 'asset';
}): Promise<MediaAsset> {
  const catalog = await readCatalog();
  const asset = catalog.assets.find((item) => item.id === input.assetId);
  if (!asset) {
    throw new Error('Media asset not found');
  }

  const boundPath = normalizePathForStore(input.manuscriptPath);
  asset.boundManuscriptPath = boundPath;
  asset.updatedAt = nowIso();
  await writeCatalog(catalog);

  await updateManuscriptBinding(boundPath, asset, input.role || 'asset');

  return asset;
}

export async function updateMediaAssetMetadata(input: {
  assetId: string;
  projectId?: string;
  title?: string;
  prompt?: string;
}): Promise<MediaAsset> {
  const catalog = await readCatalog();
  const asset = catalog.assets.find((item) => item.id === input.assetId);
  if (!asset) {
    throw new Error('Media asset not found');
  }

  if (typeof input.projectId === 'string') asset.projectId = input.projectId || undefined;
  if (typeof input.title === 'string') asset.title = input.title.trim() || undefined;
  if (typeof input.prompt === 'string') asset.prompt = normalizePrompt(input.prompt);
  asset.updatedAt = nowIso();
  await writeCatalog(catalog);
  return asset;
}

export async function deleteMediaAsset(assetId: string): Promise<{ id: string; relativePath?: string }> {
  const catalog = await readCatalog();
  const assetIndex = catalog.assets.findIndex((item) => item.id === assetId);
  if (assetIndex === -1) {
    throw new Error('Media asset not found');
  }

  const [asset] = catalog.assets.splice(assetIndex, 1);
  await writeCatalog(catalog);

  if (asset.boundManuscriptPath) {
    await removeManuscriptBinding(asset.boundManuscriptPath, asset.id);
  }

  if (asset.relativePath) {
    const absolutePath = getAbsoluteMediaPath(asset.relativePath);
    try {
      await fs.unlink(absolutePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return {
    id: asset.id,
    relativePath: asset.relativePath,
  };
}

export function getAbsoluteMediaPath(relativePath: string): string {
  return path.join(getMediaRootDir(), normalizePathForStore(relativePath));
}
