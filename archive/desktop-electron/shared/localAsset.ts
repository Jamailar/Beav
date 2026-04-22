export const REDBOX_ASSET_PROTOCOL = 'redbox-asset';
export const REDBOX_ASSET_HOST = 'asset';
export const LEGACY_LOCAL_FILE_PROTOCOL = 'local-file';

export function safeDecodeUriComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function isWindowsAbsoluteLocalPath(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(String(value || '').trim());
}

export function isUncLocalPath(value: string): boolean {
    return String(value || '').trim().startsWith('\\\\');
}

export function isLikelyAbsoluteLocalPath(value: string): boolean {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (isWindowsAbsoluteLocalPath(raw) || isUncLocalPath(raw)) return true;
    return raw.startsWith('/');
}

export function isFileUrl(value: string): boolean {
    return /^file:\/\//i.test(String(value || '').trim());
}

export function isLegacyLocalFileUrl(value: string): boolean {
    return /^local-file:\/\//i.test(String(value || '').trim());
}

export function isRedboxAssetUrl(value: string): boolean {
    return new RegExp(`^${REDBOX_ASSET_PROTOCOL}:\\/\\/`, 'i').test(String(value || '').trim());
}

export function isLocalAssetSource(value: string): boolean {
    const raw = String(value || '').trim();
    if (!raw) return false;
    return isRedboxAssetUrl(raw) || isLegacyLocalFileUrl(raw) || isFileUrl(raw) || isLikelyAbsoluteLocalPath(raw);
}

function normalizeAssetPathForUrl(pathValue: string): string {
    const raw = String(pathValue || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    if (raw.startsWith('//')) return raw;
    if (/^\/[a-zA-Z]:\//.test(raw)) return raw.slice(1);
    if (isWindowsAbsoluteLocalPath(raw)) return raw;
    if (raw.startsWith('/')) return raw;
    return `/${raw.replace(/^\/+/, '')}`;
}

function normalizeUriForParsing(raw: string): string {
    return String(raw || '')
        .trim()
        .replace(/^local-file:\/\/localhost\//i, 'local-file:///')
        .replace(/^local-file:\/\/([a-zA-Z]:[\\/])/i, 'local-file:///$1')
        .replace(/^local-file:\/([a-zA-Z]:[\\/])/i, 'local-file:///$1')
        .replace(/^local-file:([a-zA-Z]:[\\/])/i, 'local-file:///$1')
        .replace(/\\/g, '/');
}

export function extractLocalAssetPathCandidate(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (isLikelyAbsoluteLocalPath(raw)) {
        return normalizeAssetPathForUrl(raw);
    }

    if (isRedboxAssetUrl(raw) || isLegacyLocalFileUrl(raw) || isFileUrl(raw)) {
        const parseTarget = isLegacyLocalFileUrl(raw)
            ? normalizeUriForParsing(raw).replace(/^local-file:/i, 'file:')
            : normalizeUriForParsing(raw);
        try {
            const parsed = new URL(parseTarget);
            let pathname = safeDecodeUriComponent(parsed.pathname || '');
            const host = String(parsed.host || '').trim();
            if (/^\/[a-zA-Z]:/.test(pathname)) {
                pathname = pathname.slice(1);
            } else if (host && host !== REDBOX_ASSET_HOST && !/^localhost$/i.test(host)) {
                pathname = `//${host}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
            }
            return normalizeAssetPathForUrl(pathname);
        } catch {
            if (isRedboxAssetUrl(raw)) {
                return normalizeAssetPathForUrl(
                    safeDecodeUriComponent(raw.replace(new RegExp(`^${REDBOX_ASSET_PROTOCOL}:\\/\\/${REDBOX_ASSET_HOST}\\/?`, 'i'), '')),
                );
            }
            if (isLegacyLocalFileUrl(raw)) {
                return normalizeAssetPathForUrl(
                    safeDecodeUriComponent(normalizeUriForParsing(raw).replace(/^local-file:\/+/i, '')),
                );
            }
            return normalizeAssetPathForUrl(
                safeDecodeUriComponent(normalizeUriForParsing(raw).replace(/^file:\/+/i, '')),
            );
        }
    }

    return '';
}

export function toRedboxAssetUrl(absolutePath: string): string {
    const normalized = normalizeAssetPathForUrl(absolutePath);
    if (!normalized) return '';
    return `${REDBOX_ASSET_PROTOCOL}://${REDBOX_ASSET_HOST}/${encodeURI(normalized)}`;
}

export function coerceToRedboxAssetUrl(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (isRedboxAssetUrl(raw)) {
        const pathCandidate = extractLocalAssetPathCandidate(raw);
        return pathCandidate ? toRedboxAssetUrl(pathCandidate) : raw;
    }
    if (isLegacyLocalFileUrl(raw) || isFileUrl(raw) || isLikelyAbsoluteLocalPath(raw)) {
        const pathCandidate = extractLocalAssetPathCandidate(raw);
        return pathCandidate ? toRedboxAssetUrl(pathCandidate) : '';
    }
    return raw;
}
