import type { BrowserPluginAsset, ReleaseArch, ReleaseAsset, ReleaseManifest, ReleasePlatform } from './types';

const REDBOX_WEB_BASE_URL = 'https://redbox.ziz.hk';

export type AppUpdatePlatform = Extract<ReleasePlatform, 'macos' | 'windows'>;
export type AppUpdateArch = Extract<ReleaseArch, 'arm64' | 'x64' | 'x86'>;

export interface UpdateAssetResponse {
    platform: ReleasePlatform;
    arch: ReleaseArch;
    filename: string;
    size: number;
    contentType: string;
    url: string;
}

export interface PluginUpdateAssetResponse {
    filename: string;
    size: number;
    contentType: string;
    url: string;
}

export function normalizeVersion(raw: string | null | undefined) {
    return String(raw || '').trim().replace(/^[vV]/, '');
}

export function compareVersions(left: string, right: string) {
    const parse = (value: string) => normalizeVersion(value)
        .split('-')[0]
        .split('.')
        .slice(0, 4)
        .map((item) => {
            const number = Number.parseInt(item, 10);
            return Number.isFinite(number) ? number : 0;
        });
    const leftParts = parse(left);
    const rightParts = parse(right);
    const length = Math.max(leftParts.length, rightParts.length, 1);
    for (let index = 0; index < length; index += 1) {
        const leftValue = leftParts[index] || 0;
        const rightValue = rightParts[index] || 0;
        if (leftValue > rightValue) return 1;
        if (leftValue < rightValue) return -1;
    }
    return 0;
}

export function isSupportedPlatform(value: string | null): value is AppUpdatePlatform {
    return value === 'windows' || value === 'macos';
}

export function isSupportedArch(value: string | null): value is AppUpdateArch {
    return value === 'x64' || value === 'x86' || value === 'arm64';
}

function releasePageUrl(_origin: string) {
    return `${REDBOX_WEB_BASE_URL}/download`;
}

function releaseBase(manifest: ReleaseManifest, origin: string, currentVersion: string | null | undefined) {
    const version = normalizeVersion(manifest.tag);
    return {
        ready: true,
        updateAvailable: currentVersion ? compareVersions(version, currentVersion) > 0 : true,
        version,
        tag: manifest.tag,
        releaseName: manifest.releaseName,
        releaseUrl: releasePageUrl(origin),
        publishedAt: manifest.publishedAt,
        notes: manifest.notes,
    };
}

export function buildAppUpdateResponse(
    manifest: ReleaseManifest | null,
    origin: string,
    platform: AppUpdatePlatform,
    arch: AppUpdateArch,
    currentVersion?: string | null,
) {
    if (!manifest) {
        return {
            status: 404,
            body: {
                ready: false,
                updateAvailable: false,
                platform,
                arch,
                message: 'Update manifest is not ready',
            },
        };
    }

    const matchingAssets = manifest.assets.filter((item) => item.platform === platform && item.arch === arch);
    const asset = matchingAssets.find((item) => item.filename.endsWith('.dmg'))
        || matchingAssets.find((item) => item.filename.endsWith('.exe'))
        || matchingAssets.find((item) => item.filename.endsWith('.zip'))
        || matchingAssets[0]
        || null;
    const base = releaseBase(manifest, origin, currentVersion);
    if (!asset) {
        return {
            status: 404,
            body: {
                ...base,
                ready: false,
                updateAvailable: false,
                platform,
                arch,
                asset: null,
                message: 'No installer asset for requested platform and arch',
            },
        };
    }

    return {
        status: 200,
        body: {
            ...base,
            asset: toUpdateAsset(asset),
        },
    };
}

export function buildPluginUpdateResponse(
    manifest: ReleaseManifest | null,
    origin: string,
    currentVersion?: string | null,
) {
    if (!manifest) {
        return {
            status: 404,
            body: {
                ready: false,
                updateAvailable: false,
                message: 'Update manifest is not ready',
            },
        };
    }

    const base = releaseBase(manifest, origin, currentVersion);
    if (!manifest.plugin) {
        return {
            status: 404,
            body: {
                ...base,
                ready: false,
                updateAvailable: false,
                plugin: null,
                message: 'Browser plugin asset is not ready',
            },
        };
    }

    return {
        status: 200,
        body: {
            ...base,
            plugin: toPluginAsset(manifest.plugin),
        },
    };
}

function toUpdateAsset(asset: ReleaseAsset): UpdateAssetResponse {
    return {
        platform: asset.platform,
        arch: asset.arch,
        filename: asset.filename,
        size: asset.size,
        contentType: asset.contentType,
        url: asset.publicUrl,
    };
}

function toPluginAsset(plugin: BrowserPluginAsset): PluginUpdateAssetResponse {
    return {
        filename: plugin.filename,
        size: plugin.size,
        contentType: plugin.contentType,
        url: plugin.publicUrl,
    };
}
