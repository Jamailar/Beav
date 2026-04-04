import { coerceToRedboxAssetUrl, isLocalAssetSource } from '../../shared/localAsset';

const SAFE_RENDERABLE_PROTOCOL = /^(https?:|data:|blob:|file:)/i;
const IMAGE_FILE_HINT = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i;

export function resolveAssetUrl(value: string | null | undefined): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (SAFE_RENDERABLE_PROTOCOL.test(raw)) return raw;
    if (isLocalAssetSource(raw)) return coerceToRedboxAssetUrl(raw);
    return raw;
}

export function hasRenderableAssetUrl(value: string | null | undefined): boolean {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (/^javascript:/i.test(raw)) return false;
    if (SAFE_RENDERABLE_PROTOCOL.test(raw)) return true;
    if (isLocalAssetSource(raw)) return true;
    return IMAGE_FILE_HINT.test(raw);
}

export function isLocalAssetUrl(value: string | null | undefined): boolean {
    return isLocalAssetSource(String(value || '').trim());
}
