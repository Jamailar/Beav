const TERMINAL_API_SUFFIXES = [
    '/chat/completions',
    '/responses',
    '/completions',
    '/embeddings',
    '/audio/transcriptions',
    '/images/generations',
];

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

export const normalizeApiBaseUrl = (value: string, fallback = ''): string => {
    const raw = String(value || '').trim() || String(fallback || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const url = new URL(raw);
        const normalizedPath = trimTrailingSlashes(url.pathname || '');
        const matchedSuffix = TERMINAL_API_SUFFIXES.find((suffix) => normalizedPath.endsWith(suffix));
        if (matchedSuffix) {
            const stripped = normalizedPath.slice(0, normalizedPath.length - matchedSuffix.length);
            url.pathname = stripped || '/';
            url.search = '';
            url.hash = '';
        }
        return trimTrailingSlashes(url.toString());
    } catch {
        return trimTrailingSlashes(raw);
    }
};

export const safeUrlJoin = (baseURL: string, nextPath: string): string => {
    const normalized = normalizeApiBaseUrl(baseURL);
    if (!normalized) {
        return nextPath;
    }
    if (normalized.endsWith(nextPath)) {
        return normalized;
    }
    return `${normalized}${nextPath.startsWith('/') ? '' : '/'}${nextPath}`;
};

export const normalizeRemoteAssetUrl = (value: string): string => {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }
    if (raw.startsWith('//')) {
        return `https:${raw}`;
    }
    return raw;
};
