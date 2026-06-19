import { describe, expect, it } from 'vitest';
import { buildAppUpdateResponse, buildPluginUpdateResponse } from '../app/lib/updates';
import type { ReleaseManifest } from '../app/lib/types';

const manifest: ReleaseManifest = {
    tag: 'v1.10.4',
    publishedAt: '2026-04-27T12:24:43Z',
    releaseName: 'RedBox v1.10.4',
    releaseUrl: 'https://example.invalid/source/v1.10.4',
    notes: 'Release notes...',
    releaseNotes: [],
    assets: [
        {
            platform: 'windows',
            arch: 'x64',
            filename: 'RedBox_1.10.4_x64-setup.exe',
            size: 15158146,
            contentType: 'application/vnd.microsoft.portable-executable',
            ossKey: 'releases/v1.10.4/RedBox_1.10.4_x64-setup.exe',
            publicUrl: 'https://downloads.example.com/releases/v1.10.4/RedBox_1.10.4_x64-setup.exe',
        },
    ],
    plugin: {
        filename: 'redbox-browser-plugin-v1.10.4.zip',
        size: 456775,
        contentType: 'application/zip',
        ossKey: 'plugins/v1.10.4/redbox-browser-plugin-v1.10.4.zip',
        publicUrl: 'https://downloads.example.com/plugins/v1.10.4/redbox-browser-plugin-v1.10.4.zip',
        sourcePath: 'Plugin/dist/extension',
        sourceRef: 'v1.10.4',
    },
};

describe('updates api payload builders', () => {
    it('builds app update payload from the OSS manifest asset', () => {
        const result = buildAppUpdateResponse(manifest, 'https://redbox.ziz.hk', 'windows', 'x64', '1.10.3');

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
            ready: true,
            updateAvailable: true,
            version: '1.10.4',
            tag: 'v1.10.4',
            releaseUrl: 'https://redbox.ziz.hk/download',
            asset: {
                platform: 'windows',
                arch: 'x64',
                url: 'https://downloads.example.com/releases/v1.10.4/RedBox_1.10.4_x64-setup.exe',
            },
        });
    });

    it('returns ready false when the requested app asset is missing', () => {
        const result = buildAppUpdateResponse(manifest, 'https://redbox.ziz.hk', 'macos', 'arm64', '1.10.3');

        expect(result.status).toBe(404);
        expect(result.body).toMatchObject({
            ready: false,
            updateAvailable: false,
            version: '1.10.4',
            asset: null,
        });
    });

    it('builds plugin update payload from the OSS manifest plugin asset', () => {
        const result = buildPluginUpdateResponse(manifest, 'https://redbox.ziz.hk', 'v1.10.3');

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
            ready: true,
            updateAvailable: true,
            version: '1.10.4',
            releaseUrl: 'https://redbox.ziz.hk/download',
            plugin: {
                filename: 'redbox-browser-plugin-v1.10.4.zip',
                url: 'https://downloads.example.com/plugins/v1.10.4/redbox-browser-plugin-v1.10.4.zip',
            },
        });
    });
});
