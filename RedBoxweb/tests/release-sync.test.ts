import { describe, expect, it, vi } from 'vitest';
import { buildBrowserPluginAsset, parseReleaseAssets, syncLatestReleaseWithDependencies } from '../app/lib/release-sync';
import type { GithubRelease, ReleaseManifest } from '../app/lib/types';

const release: GithubRelease = {
    tag_name: 'v1.9.0',
    name: 'v1.9.0',
    html_url: 'https://github.com/Jamailar/RedBox/releases/tag/v1.9.0',
    body: '1. 优化整体 UI 视觉',
    published_at: '2026-04-04T08:59:00Z',
    draft: false,
    prerelease: false,
    assets: [
        {
            id: 1,
            name: 'RedBox-1.9.0-arm64.dmg',
            size: 100,
            content_type: 'application/octet-stream',
            browser_download_url: 'https://github.com/arm64.dmg',
        },
        {
            id: 2,
            name: 'RedBox-1.9.0-arm64.zip',
            size: 200,
            content_type: 'application/zip',
            browser_download_url: 'https://github.com/arm64.zip',
        },
        {
            id: 3,
            name: 'RedBox-1.9.0-x64.dmg',
            size: 300,
            content_type: 'application/octet-stream',
            browser_download_url: 'https://github.com/x64.dmg',
        },
        {
            id: 4,
            name: 'RedBox-1.9.0-x64.exe',
            size: 400,
            content_type: 'application/octet-stream',
            browser_download_url: 'https://github.com/x64.exe',
        },
        {
            id: 5,
            name: 'latest.yml',
            size: 20,
            content_type: 'text/yaml',
            browser_download_url: 'https://github.com/latest.yml',
        },
        {
            id: 6,
            name: 'RedBox-1.9.0-x64.exe.blockmap',
            size: 20,
            content_type: 'application/octet-stream',
            browser_download_url: 'https://github.com/blockmap',
        },
    ],
};

const previousRelease: GithubRelease = {
    ...release,
    tag_name: 'v1.8.0',
    name: 'v1.8.0',
    html_url: 'https://github.com/Jamailar/RedBox/releases/tag/v1.8.0',
    body: '1. 修复旧版本问题',
    published_at: '2026-03-28T08:59:00Z',
    assets: [],
};

const releaseNotes = [
    {
        tag: release.tag_name,
        releaseName: release.name,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        notes: release.body || '',
    },
    {
        tag: previousRelease.tag_name,
        releaseName: previousRelease.name,
        releaseUrl: previousRelease.html_url,
        publishedAt: previousRelease.published_at,
        notes: previousRelease.body || '',
    },
];

const pluginFiles = [
    {
        path: 'Plugin/manifest.json',
        body: Buffer.from('{"manifest_version":3}', 'utf8'),
    },
    {
        path: 'Plugin/background.js',
        body: Buffer.from('console.log("redbox")', 'utf8'),
    },
];

const plugin = {
    filename: 'redbox-browser-plugin-v1.9.0.zip',
    size: 240,
    contentType: 'application/zip',
    ossKey: 'plugins/v1.9.0/redbox-browser-plugin-v1.9.0.zip',
    publicUrl: 'https://downloads.example.com/plugins/v1.9.0/redbox-browser-plugin-v1.9.0.zip',
    sourcePath: 'Plugin',
    sourceRef: 'v1.9.0',
};

describe('parseReleaseAssets', () => {
    it('keeps only mirrorable desktop installers', () => {
        const assets = parseReleaseAssets(release, 'https://downloads.example.com');
        expect(assets).toHaveLength(4);
        expect(assets.map((asset) => asset.filename)).toEqual([
            'RedBox-1.9.0-arm64.dmg',
            'RedBox-1.9.0-arm64.zip',
            'RedBox-1.9.0-x64.dmg',
            'RedBox-1.9.0-x64.exe',
        ]);
        expect(assets[0]).toMatchObject({
            platform: 'macos',
            arch: 'arm64',
            publicUrl: 'https://downloads.example.com/releases/v1.9.0/RedBox-1.9.0-arm64.dmg',
        });
        expect(assets[3]).toMatchObject({
            platform: 'windows',
            arch: 'x64',
        });
    });
});

describe('buildBrowserPluginAsset', () => {
    it('packages Plugin files as a versioned zip asset', () => {
        const asset = buildBrowserPluginAsset(release, pluginFiles, 'https://downloads.example.com');

        expect(asset).toMatchObject({
            filename: 'redbox-browser-plugin-v1.9.0.zip',
            contentType: 'application/zip',
            ossKey: 'plugins/v1.9.0/redbox-browser-plugin-v1.9.0.zip',
            publicUrl: 'https://downloads.example.com/plugins/v1.9.0/redbox-browser-plugin-v1.9.0.zip',
            sourcePath: 'Plugin',
            sourceRef: 'v1.9.0',
        });
        expect(asset.body.subarray(0, 4).toString('hex')).toBe('504b0304');
        expect(asset.body.includes(Buffer.from('Plugin/manifest.json'))).toBe(true);
    });
});

describe('syncLatestReleaseWithDependencies', () => {
    it('skips upload when current manifest tag already matches latest release', async () => {
        const uploadObject = vi.fn(async (..._args: unknown[]) => undefined);
        const currentManifest: ReleaseManifest = {
            tag: 'v1.9.0',
            publishedAt: release.published_at,
            releaseName: release.name,
            releaseUrl: release.html_url,
            notes: release.body || '',
            releaseNotes,
            assets: [],
            plugin,
        };

        const result = await syncLatestReleaseWithDependencies({
            fetchLatestRelease: async () => release,
            fetchReleaseNotes: async () => [release, previousRelease],
            fetchPluginFiles: async () => pluginFiles,
            readCurrentManifest: async () => currentManifest,
            uploadRemoteAsset: uploadObject,
            uploadBufferAsset: uploadObject,
            uploadManifest: uploadObject,
            buildPublicUrl: (key) => `https://downloads.example.com/${key}`,
        });

        expect(result.status).toBe('skipped');
        expect(uploadObject).not.toHaveBeenCalled();
    });

    it('uploads assets and writes manifest last', async () => {
        const uploadObject = vi.fn(async (..._args: unknown[]) => undefined);

        const result = await syncLatestReleaseWithDependencies({
            fetchLatestRelease: async () => release,
            fetchReleaseNotes: async () => [release, previousRelease],
            fetchPluginFiles: async () => pluginFiles,
            readCurrentManifest: async () => null,
            uploadRemoteAsset: uploadObject,
            uploadBufferAsset: uploadObject,
            uploadManifest: uploadObject,
            buildPublicUrl: (key) => `https://downloads.example.com/${key}`,
        });

        expect(result.status).toBe('synced');
        expect(result.manifest.releaseNotes).toEqual(releaseNotes);
        expect(result.manifest.plugin).toMatchObject({
            filename: plugin.filename,
            contentType: plugin.contentType,
            ossKey: plugin.ossKey,
            publicUrl: plugin.publicUrl,
            sourcePath: plugin.sourcePath,
            sourceRef: plugin.sourceRef,
        });
        expect(uploadObject).toHaveBeenCalledTimes(6);
        expect(uploadObject.mock.calls.at(-2)?.[0]).toBe('plugins/v1.9.0/redbox-browser-plugin-v1.9.0.zip');
        expect(uploadObject.mock.calls.at(-1)?.[0]).toBe('manifests/latest.json');
    });

    it('updates manifest when release notes change without reuploading same-tag assets', async () => {
        const uploadRemoteAsset = vi.fn(async () => undefined);
        const uploadManifest = vi.fn(async () => undefined);
        const currentManifest: ReleaseManifest = {
            tag: 'v1.9.0',
            publishedAt: release.published_at,
            releaseName: release.name,
            releaseUrl: release.html_url,
            notes: release.body || '',
            releaseNotes: [],
            assets: [],
            plugin,
        };

        const result = await syncLatestReleaseWithDependencies({
            fetchLatestRelease: async () => release,
            fetchReleaseNotes: async () => [release, previousRelease],
            fetchPluginFiles: async () => pluginFiles,
            readCurrentManifest: async () => currentManifest,
            uploadRemoteAsset,
            uploadBufferAsset: vi.fn(async () => undefined),
            uploadManifest,
            buildPublicUrl: (key) => `https://downloads.example.com/${key}`,
        });

        expect(result.status).toBe('synced');
        expect(result.reason).toContain('release notes');
        expect(uploadRemoteAsset).not.toHaveBeenCalled();
        expect(uploadManifest).toHaveBeenCalledTimes(1);
    });

    it('uploads plugin when an existing same-tag manifest has no plugin mirror', async () => {
        const uploadRemoteAsset = vi.fn(async () => undefined);
        const uploadBufferAsset = vi.fn(async () => undefined);
        const uploadManifest = vi.fn(async () => undefined);
        const currentManifest: ReleaseManifest = {
            tag: 'v1.9.0',
            publishedAt: release.published_at,
            releaseName: release.name,
            releaseUrl: release.html_url,
            notes: release.body || '',
            releaseNotes,
            assets: [],
        };

        const result = await syncLatestReleaseWithDependencies({
            fetchLatestRelease: async () => release,
            fetchReleaseNotes: async () => [release, previousRelease],
            fetchPluginFiles: async () => pluginFiles,
            readCurrentManifest: async () => currentManifest,
            uploadRemoteAsset,
            uploadBufferAsset,
            uploadManifest,
            buildPublicUrl: (key) => `https://downloads.example.com/${key}`,
        });

        expect(result.status).toBe('synced');
        expect(result.reason).toContain('browser plugin');
        expect(uploadRemoteAsset).not.toHaveBeenCalled();
        expect(uploadBufferAsset).toHaveBeenCalledTimes(1);
        expect(uploadManifest).toHaveBeenCalledTimes(1);
    });

    it('does not write manifest if an asset upload fails', async () => {
        const uploadRemoteAsset = vi.fn(async (key: string) => {
            if (key.endsWith('.exe')) {
                throw new Error('upload failed');
            }
        });
        const uploadManifest = vi.fn(async () => undefined);

        await expect(syncLatestReleaseWithDependencies({
            fetchLatestRelease: async () => release,
            fetchReleaseNotes: async () => [release, previousRelease],
            fetchPluginFiles: async () => pluginFiles,
            readCurrentManifest: async () => null,
            uploadRemoteAsset,
            uploadBufferAsset: vi.fn(async () => undefined),
            uploadManifest,
            buildPublicUrl: (key) => `https://downloads.example.com/${key}`,
        })).rejects.toThrow('upload failed');

        expect(uploadManifest).not.toHaveBeenCalled();
    });
});
