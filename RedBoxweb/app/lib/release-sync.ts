import { Buffer } from 'node:buffer';
import { getSyncEnv } from './env';
import { fetchGithubDirectoryFiles, fetchGithubReleases, fetchLatestGithubRelease } from './github';
import { buildPublicUrl, getManifestKey, readPublicManifest } from './manifest';
import { mirrorRemoteFileToOss, uploadBufferToOss } from './oss';
import type {
    GithubRelease,
    GithubReleaseAsset,
    GithubSourceFile,
    ParsedBrowserPluginAsset,
    ParsedReleaseAsset,
    ReleaseManifest,
    ReleaseNotesEntry,
    ReleaseSyncDependencies,
    SyncResult,
} from './types';

const ALLOWED_EXTENSIONS = new Set(['.dmg', '.zip', '.exe']);
const IGNORED_FILENAMES = new Set(['latest.yml', 'latest-mac.yml']);
const PLUGIN_SOURCE_PATH = 'Plugin';
const PLUGIN_CONTENT_TYPE = 'application/zip';

function getAssetExtension(filename: string) {
    const match = filename.toLowerCase().match(/\.[^.]+$/);
    return match ? match[0] : '';
}

function inferContentType(filename: string, githubContentType: string) {
    const ext = getAssetExtension(filename);
    if (ext === '.dmg') return 'application/x-apple-diskimage';
    if (ext === '.zip') return 'application/zip';
    if (ext === '.exe') return 'application/vnd.microsoft.portable-executable';
    return githubContentType || 'application/octet-stream';
}

function parsePlatform(asset: GithubReleaseAsset) {
    const filename = asset.name.toLowerCase();
    const ext = getAssetExtension(filename);

    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return null;
    }

    if (filename.endsWith('.blockmap') || IGNORED_FILENAMES.has(filename)) {
        return null;
    }

    if (ext === '.exe') {
        return { platform: 'windows' as const, arch: 'x64' as const };
    }

    if (filename.includes('arm64')) {
        return { platform: 'macos' as const, arch: 'arm64' as const };
    }

    if (filename.includes('x64')) {
        return { platform: 'macos' as const, arch: 'x64' as const };
    }

    return null;
}

export function parseReleaseAssets(release: GithubRelease, publicBaseUrl: string): ParsedReleaseAsset[] {
    return release.assets.flatMap((asset) => {
        const parsed = parsePlatform(asset);
        if (!parsed) {
            return [];
        }

        const ossKey = `releases/${release.tag_name}/${asset.name}`;
        return [{
            platform: parsed.platform,
            arch: parsed.arch,
            filename: asset.name,
            size: asset.size,
            contentType: inferContentType(asset.name, asset.content_type),
            ossKey,
            publicUrl: buildPublicUrl(publicBaseUrl, ossKey),
            downloadUrl: asset.browser_download_url,
        }];
    });
}

const crcTable = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

function crc32(body: Buffer) {
    let crc = 0xffffffff;
    for (const byte of body) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function normalizeZipPath(path: string) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').some((part) => part === '..')) {
        throw new Error(`Unsafe plugin file path: ${path}`);
    }
    return normalized;
}

function createStoredZip(files: GithubSourceFile[]) {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;
    const dosTime = 0;
    const dosDate = 0x0021;

    for (const file of files) {
        const name = Buffer.from(normalizeZipPath(file.path), 'utf8');
        const body = file.body;
        const checksum = crc32(body);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(body.length, 18);
        localHeader.writeUInt32LE(body.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);

        localParts.push(localHeader, name, body);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(body.length, 20);
        centralHeader.writeUInt32LE(body.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralParts.push(centralHeader, name);

        offset += localHeader.length + name.length + body.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(files.length, 8);
    endRecord.writeUInt16LE(files.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(offset, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function getPluginFilename(tag: string) {
    const safeTag = tag.replace(/[^a-zA-Z0-9._-]+/g, '-');
    return `redbox-browser-plugin-${safeTag}.zip`;
}

export function buildBrowserPluginAsset(
    release: GithubRelease,
    files: GithubSourceFile[],
    publicBaseUrl: string,
): ParsedBrowserPluginAsset {
    if (files.length === 0) {
        throw new Error(`No plugin files found for ${release.tag_name}`);
    }

    const zipBody = createStoredZip(files);
    const filename = getPluginFilename(release.tag_name);
    const ossKey = `plugins/${release.tag_name}/${filename}`;

    return {
        filename,
        size: zipBody.length,
        contentType: PLUGIN_CONTENT_TYPE,
        ossKey,
        publicUrl: buildPublicUrl(publicBaseUrl, ossKey),
        sourcePath: PLUGIN_SOURCE_PATH,
        sourceRef: release.tag_name,
        body: zipBody,
    };
}

function buildReleaseNotes(releases: GithubRelease[], latestRelease: GithubRelease): ReleaseNotesEntry[] {
    const byTag = new Map<string, ReleaseNotesEntry>();

    for (const release of [latestRelease, ...releases]) {
        if (release.draft || release.prerelease || byTag.has(release.tag_name)) {
            continue;
        }

        byTag.set(release.tag_name, {
            tag: release.tag_name,
            releaseName: release.name || release.tag_name,
            releaseUrl: release.html_url,
            publishedAt: release.published_at,
            notes: String(release.body || '').trim(),
        });
    }

    return Array.from(byTag.values()).sort((left, right) => {
        const leftTime = new Date(left.publishedAt).getTime();
        const rightTime = new Date(right.publishedAt).getTime();
        return rightTime - leftTime;
    });
}

function releaseNotesChanged(currentManifest: ReleaseManifest | null, nextReleaseNotes: ReleaseNotesEntry[]) {
    return JSON.stringify(currentManifest?.releaseNotes || []) !== JSON.stringify(nextReleaseNotes);
}

function buildManifest(
    release: GithubRelease,
    assets: ParsedReleaseAsset[],
    releaseNotes: ReleaseNotesEntry[],
    plugin: ParsedBrowserPluginAsset | ReleaseManifest['plugin'],
): ReleaseManifest {
    return {
        tag: release.tag_name,
        publishedAt: release.published_at,
        releaseName: release.name || release.tag_name,
        releaseUrl: release.html_url,
        notes: String(release.body || '').trim(),
        releaseNotes,
        assets: assets.map(({ downloadUrl: _downloadUrl, ...asset }) => asset),
        plugin: plugin ? {
            filename: plugin.filename,
            size: plugin.size,
            contentType: plugin.contentType,
            ossKey: plugin.ossKey,
            publicUrl: plugin.publicUrl,
            sourcePath: plugin.sourcePath,
            sourceRef: plugin.sourceRef,
        } : null,
    };
}

export async function syncLatestReleaseWithDependencies(deps: ReleaseSyncDependencies): Promise<SyncResult> {
    const release = await deps.fetchLatestRelease();
    const releases = await deps.fetchReleaseNotes();
    const parsedAssets = parseReleaseAssets(release, deps.buildPublicUrl(''));
    if (parsedAssets.length === 0) {
        throw new Error(`No downloadable assets matched release ${release.tag_name}`);
    }

    const currentManifest = await deps.readCurrentManifest();
    const releaseNotes = buildReleaseNotes(releases, release);
    const latestTagChanged = currentManifest?.tag !== release.tag_name;
    const notesChanged = releaseNotesChanged(currentManifest, releaseNotes);
    const pluginMissing = !currentManifest?.plugin;

    if (!latestTagChanged && !notesChanged && !pluginMissing) {
        return {
            status: 'skipped',
            reason: `Latest manifest already points to ${release.tag_name}, release notes are current, and plugin mirror is ready`,
            manifest: currentManifest,
        };
    }

    if (latestTagChanged) {
        for (const asset of parsedAssets) {
            await deps.uploadRemoteAsset(asset.ossKey, asset.downloadUrl, asset.contentType);
        }
    }

    let plugin = latestTagChanged ? null : currentManifest?.plugin || null;
    if (latestTagChanged || pluginMissing) {
        const pluginFiles = await deps.fetchPluginFiles(release.tag_name);
        const packagedPlugin = buildBrowserPluginAsset(release, pluginFiles, deps.buildPublicUrl(''));
        await deps.uploadBufferAsset(packagedPlugin.ossKey, packagedPlugin.body, packagedPlugin.contentType);
        plugin = packagedPlugin;
    }

    const nextManifest = buildManifest(release, parsedAssets, releaseNotes, plugin);
    const manifestBody = Buffer.from(JSON.stringify(nextManifest, null, 2), 'utf8');
    await deps.uploadManifest(getManifestKey(), manifestBody, 'application/json; charset=utf-8');

    return {
        status: 'synced',
        reason: latestTagChanged
            ? `Mirrored ${nextManifest.tag} installers and plugin to OSS`
            : pluginMissing
                ? `Mirrored browser plugin for ${nextManifest.tag}`
                : `Synced release notes for ${nextManifest.tag}`,
        manifest: nextManifest,
    };
}

export async function syncLatestReleaseToOss(): Promise<SyncResult> {
    const env = getSyncEnv();

    return syncLatestReleaseWithDependencies({
        fetchLatestRelease: () => fetchLatestGithubRelease(env.GITHUB_OWNER, env.GITHUB_REPO, env.GITHUB_TOKEN),
        fetchReleaseNotes: () => fetchGithubReleases(env.GITHUB_OWNER, env.GITHUB_REPO, env.GITHUB_TOKEN),
        fetchPluginFiles: (ref) => fetchGithubDirectoryFiles(env.GITHUB_OWNER, env.GITHUB_REPO, ref, PLUGIN_SOURCE_PATH, env.GITHUB_TOKEN),
        readCurrentManifest: () => readPublicManifest(env.OSS_PUBLIC_BASE_URL),
        uploadRemoteAsset: (key, downloadUrl, contentType) => mirrorRemoteFileToOss(key, downloadUrl, contentType),
        uploadBufferAsset: (key, body, contentType) => uploadBufferToOss(key, body, contentType),
        uploadManifest: (key, body, contentType) => uploadBufferToOss(key, body, contentType),
        buildPublicUrl: (key) => buildPublicUrl(env.OSS_PUBLIC_BASE_URL, key),
    });
}
