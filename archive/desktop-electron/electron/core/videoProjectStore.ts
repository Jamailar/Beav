import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkspacePaths } from '../db';
import { getAbsoluteMediaPath, type MediaAsset } from './mediaLibraryStore';

export type VideoProjectMode = 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation' | 'multi-video';
export type VideoProjectStatus = 'draft' | 'ready' | 'generating' | 'completed';
export type VideoProjectAssetKind = 'reference-image' | 'voice-reference' | 'keyframe' | 'clip' | 'output' | 'other';

export interface VideoProjectAssetEntry {
    id: string;
    kind: VideoProjectAssetKind;
    label?: string;
    role?: string;
    relativePath: string;
    absolutePath: string;
    sourcePath?: string;
    sourceAssetId?: string;
    createdAt: string;
}

export interface VideoProjectManifest {
    version: 1;
    id: string;
    title: string;
    brief?: string;
    status: VideoProjectStatus;
    mode?: VideoProjectMode;
    aspectRatio?: string;
    durationSeconds?: number;
    workItemId?: string;
    scriptPath: string;
    briefPath: string;
    projectDir: string;
    references: VideoProjectAssetEntry[];
    keyframes: VideoProjectAssetEntry[];
    clips: VideoProjectAssetEntry[];
    outputs: VideoProjectAssetEntry[];
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

const VIDEO_PROJECT_DIR_NAME = 'video-projects';

function nowIso(): string {
    return new Date().toISOString();
}

function normalizeStorePath(input: string): string {
    return String(input || '').replace(/\\/g, '/');
}

function slugifySegment(input: string): string {
    const normalized = String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || 'video-project';
}

function getMediaRootDir(): string {
    const paths = getWorkspacePaths() as ReturnType<typeof getWorkspacePaths> & { media?: string };
    return paths.media || path.join(paths.base, 'media');
}

function getVideoProjectsRootDir(): string {
    return path.join(getMediaRootDir(), VIDEO_PROJECT_DIR_NAME);
}

function getVideoProjectDir(projectId: string): string {
    return path.join(getVideoProjectsRootDir(), projectId);
}

function getVideoProjectManifestPath(projectId: string): string {
    return path.join(getVideoProjectDir(projectId), 'manifest.json');
}

function getVideoProjectScriptPath(projectId: string): string {
    return path.join(getVideoProjectDir(projectId), 'script.md');
}

function getVideoProjectBriefPath(projectId: string): string {
    return path.join(getVideoProjectDir(projectId), 'brief.md');
}

async function ensureVideoProjectDirs(projectId: string): Promise<void> {
    const root = getVideoProjectDir(projectId);
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(root, 'references'), { recursive: true });
    await fs.mkdir(path.join(root, 'audio'), { recursive: true });
    await fs.mkdir(path.join(root, 'keyframes'), { recursive: true });
    await fs.mkdir(path.join(root, 'clips'), { recursive: true });
    await fs.mkdir(path.join(root, 'output'), { recursive: true });
}

function defaultScriptTemplate(input: {
    title: string;
    durationSeconds?: number;
    aspectRatio?: string;
    mode?: VideoProjectMode;
}): string {
    const durationLabel = input.durationSeconds ? `${input.durationSeconds} 秒` : '待定';
    const ratioLabel = input.aspectRatio || '待定';
    const modeLabel = input.mode || '待定';
    return [
        `# ${input.title}`,
        '',
        `- 视频时长：${durationLabel}`,
        `- 视频比例：${ratioLabel}`,
        `- 视频模式：${modeLabel}`,
        '',
        '| 时间 | 画面 | 声音 | 景别 |',
        '| --- | --- | --- | --- |',
        '| 0-2s | 待补充 | 待补充 | 待补充 |',
    ].join('\n');
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

async function writeManifest(manifest: VideoProjectManifest): Promise<void> {
    await ensureVideoProjectDirs(manifest.id);
    await fs.writeFile(getVideoProjectManifestPath(manifest.id), JSON.stringify(manifest, null, 2), 'utf-8');
}

function enrichEntry(projectId: string, entry: VideoProjectAssetEntry): VideoProjectAssetEntry {
    return {
        ...entry,
        relativePath: normalizeStorePath(entry.relativePath),
        absolutePath: path.join(getVideoProjectDir(projectId), normalizeStorePath(entry.relativePath)),
    };
}

function dedupeEntries(entries: VideoProjectAssetEntry[]): VideoProjectAssetEntry[] {
    const seen = new Set<string>();
    const result: VideoProjectAssetEntry[] = [];
    for (const entry of entries) {
        const key = [entry.kind, entry.relativePath, entry.label || '', entry.role || '', entry.sourceAssetId || ''].join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(entry);
    }
    return result;
}

export async function createVideoProjectPack(input: {
    title: string;
    brief?: string;
    script?: string;
    mode?: VideoProjectMode;
    aspectRatio?: string;
    durationSeconds?: number;
    workItemId?: string;
    metadata?: Record<string, unknown>;
}): Promise<VideoProjectManifest> {
    const id = `video_project_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await ensureVideoProjectDirs(id);
    const createdAt = nowIso();
    const briefPath = getVideoProjectBriefPath(id);
    const scriptPath = getVideoProjectScriptPath(id);
    const brief = String(input.brief || '').trim();
    const script = String(input.script || '').trim() || defaultScriptTemplate({
        title: input.title,
        durationSeconds: input.durationSeconds,
        aspectRatio: input.aspectRatio,
        mode: input.mode,
    });
    await fs.writeFile(briefPath, brief ? `${brief}\n` : '', 'utf-8');
    await fs.writeFile(scriptPath, `${script}\n`, 'utf-8');

    const manifest: VideoProjectManifest = {
        version: 1,
        id,
        title: String(input.title || '').trim() || '未命名视频项目',
        brief: brief || undefined,
        status: 'draft',
        mode: input.mode,
        aspectRatio: input.aspectRatio?.trim() || undefined,
        durationSeconds: Number.isFinite(Number(input.durationSeconds)) ? Number(input.durationSeconds) : undefined,
        workItemId: input.workItemId?.trim() || undefined,
        scriptPath: normalizeStorePath(path.relative(getVideoProjectDir(id), scriptPath)),
        briefPath: normalizeStorePath(path.relative(getVideoProjectDir(id), briefPath)),
        projectDir: getVideoProjectDir(id),
        references: [],
        keyframes: [],
        clips: [],
        outputs: [],
        metadata: input.metadata,
        createdAt,
        updatedAt: createdAt,
    };
    await writeManifest(manifest);
    return manifest;
}

export async function getVideoProjectPack(projectId: string): Promise<VideoProjectManifest | null> {
    const manifest = await readJsonIfExists<VideoProjectManifest>(getVideoProjectManifestPath(projectId));
    if (!manifest || manifest.version !== 1) {
        return null;
    }
    return {
        ...manifest,
        references: (manifest.references || []).map((entry) => enrichEntry(projectId, entry)),
        keyframes: (manifest.keyframes || []).map((entry) => enrichEntry(projectId, entry)),
        clips: (manifest.clips || []).map((entry) => enrichEntry(projectId, entry)),
        outputs: (manifest.outputs || []).map((entry) => enrichEntry(projectId, entry)),
        projectDir: getVideoProjectDir(projectId),
    };
}

export async function listVideoProjectPacks(limit = 100): Promise<VideoProjectManifest[]> {
    await fs.mkdir(getVideoProjectsRootDir(), { recursive: true });
    const dirs = await fs.readdir(getVideoProjectsRootDir(), { withFileTypes: true });
    const manifests: VideoProjectManifest[] = [];
    for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        const manifest = await getVideoProjectPack(entry.name);
        if (manifest) manifests.push(manifest);
    }
    return manifests
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, Math.max(1, limit));
}

export async function updateVideoProjectScript(input: {
    projectId: string;
    script: string;
    status?: VideoProjectStatus;
}): Promise<VideoProjectManifest> {
    const manifest = await getVideoProjectPack(input.projectId);
    if (!manifest) {
        throw new Error('Video project not found');
    }
    await fs.writeFile(getVideoProjectScriptPath(input.projectId), `${String(input.script || '').trim()}\n`, 'utf-8');
    manifest.status = input.status || manifest.status;
    manifest.updatedAt = nowIso();
    await writeManifest(manifest);
    return manifest;
}

export async function updateVideoProjectBrief(input: {
    projectId: string;
    brief: string;
}): Promise<VideoProjectManifest> {
    const manifest = await getVideoProjectPack(input.projectId);
    if (!manifest) {
        throw new Error('Video project not found');
    }
    const brief = String(input.brief || '').trim();
    await fs.writeFile(getVideoProjectBriefPath(input.projectId), brief ? `${brief}\n` : '', 'utf-8');
    manifest.brief = brief || undefined;
    manifest.updatedAt = nowIso();
    await writeManifest(manifest);
    return manifest;
}

async function copyIntoProject(projectId: string, targetDirName: string, sourcePath: string, label?: string): Promise<{ relativePath: string; absolutePath: string }> {
    const safeLabel = slugifySegment(label || path.basename(sourcePath, path.extname(sourcePath)));
    const ext = path.extname(sourcePath) || '';
    const fileName = `${Date.now()}-${safeLabel}${ext}`;
    const absoluteTarget = path.join(getVideoProjectDir(projectId), targetDirName, fileName);
    await fs.copyFile(sourcePath, absoluteTarget);
    return {
        relativePath: normalizeStorePath(path.relative(getVideoProjectDir(projectId), absoluteTarget)),
        absolutePath: absoluteTarget,
    };
}

function pickAssetBucket(kind: VideoProjectAssetKind): keyof Pick<VideoProjectManifest, 'references' | 'keyframes' | 'clips' | 'outputs'> {
    if (kind === 'keyframe') return 'keyframes';
    if (kind === 'clip') return 'clips';
    if (kind === 'output') return 'outputs';
    return 'references';
}

function pickAssetDir(kind: VideoProjectAssetKind): string {
    if (kind === 'keyframe') return 'keyframes';
    if (kind === 'clip') return 'clips';
    if (kind === 'output') return 'output';
    if (kind === 'voice-reference') return 'audio';
    return 'references';
}

export async function addAssetToVideoProjectPack(input: {
    projectId: string;
    sourcePath: string;
    kind: VideoProjectAssetKind;
    label?: string;
    role?: string;
    sourceAssetId?: string;
}): Promise<VideoProjectManifest> {
    const manifest = await getVideoProjectPack(input.projectId);
    if (!manifest) {
        throw new Error('Video project not found');
    }
    const sourcePath = String(input.sourcePath || '').trim();
    if (!sourcePath) {
        throw new Error('sourcePath is required');
    }
    const copied = await copyIntoProject(input.projectId, pickAssetDir(input.kind), sourcePath, input.label);
    const entry: VideoProjectAssetEntry = {
        id: `video_asset_${Date.now()}_${randomUUID().slice(0, 6)}`,
        kind: input.kind,
        label: input.label?.trim() || undefined,
        role: input.role?.trim() || undefined,
        relativePath: copied.relativePath,
        absolutePath: copied.absolutePath,
        sourcePath,
        sourceAssetId: input.sourceAssetId?.trim() || undefined,
        createdAt: nowIso(),
    };
    const bucket = pickAssetBucket(input.kind);
    manifest[bucket] = dedupeEntries([...(manifest[bucket] || []), entry]);
    manifest.updatedAt = nowIso();
    await writeManifest(manifest);
    return manifest;
}

export async function addGeneratedAssetToVideoProjectPack(input: {
    projectId: string;
    asset: MediaAsset;
    kind: Extract<VideoProjectAssetKind, 'keyframe' | 'clip' | 'output'>;
    label?: string;
    role?: string;
}): Promise<VideoProjectManifest> {
    if (!input.asset.relativePath) {
        throw new Error('Generated media asset has no relative path');
    }
    return addAssetToVideoProjectPack({
        projectId: input.projectId,
        sourcePath: getAbsoluteMediaPath(input.asset.relativePath),
        kind: input.kind,
        label: input.label || input.asset.title || input.asset.id,
        role: input.role,
        sourceAssetId: input.asset.id,
    });
}
