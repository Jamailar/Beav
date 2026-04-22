import path from 'node:path';
import fsSync from 'node:fs';
import {
    extractLocalAssetPathCandidate,
    toRedboxAssetUrl,
} from '../../shared/localAsset';

export function normalizePathForComparison(targetPath: string): string {
    let input = String(targetPath || '');
    if (process.platform === 'win32') {
        input = input.replace(/^\/+([a-zA-Z]:[\\/])/, '$1');
        input = input.replace(/^\\([a-zA-Z]:[\\/])/, '$1');
        input = input.replace(/^\\\\([a-zA-Z]:)([\\/])/, '$1$2');
        input = input.replace(/^\\\\\?\\/, '');
    }

    const resolved = path.resolve(input);
    let canonical = resolved;
    try {
        canonical = fsSync.realpathSync.native(resolved);
    } catch {
        canonical = resolved;
    }
    if (process.platform === 'win32') {
        canonical = canonical.replace(/^\/+([a-zA-Z]:[\\/])/, '$1');
        canonical = canonical.replace(/^\\([a-zA-Z]:[\\/])/, '$1');
        canonical = canonical.replace(/^\\\\([a-zA-Z]:)([\\/])/, '$1$2');
        canonical = canonical.replace(/^\\\\\?\\/, '');
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function isPathWithinRoots(targetPath: string, allowedRoots: string[]): boolean {
    const normalizedTarget = normalizePathForComparison(targetPath);
    return allowedRoots.some((rootPath) => {
        const normalizedRoot = normalizePathForComparison(rootPath);
        const relativePath = path.relative(normalizedRoot, normalizedTarget);
        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    });
}

export function resolveAssetSourceToPath(source: string): string {
    const raw = String(source || '').trim();
    if (!raw) {
        throw new Error('Empty asset source');
    }
    const candidate = extractLocalAssetPathCandidate(raw);
    if (!candidate) {
        throw new Error('Unsupported asset source');
    }

    let normalized = path.normalize(candidate);
    if (process.platform === 'win32') {
        normalized = normalized.replace(/^\/+([a-zA-Z]:[\\/])/, '$1');
        normalized = normalized.replace(/^\\([a-zA-Z]:[\\/])/, '$1');
        normalized = normalized.replace(/^\\\\([a-zA-Z]:)([\\/])/, '$1$2');
        normalized = normalized.replace(/^\\\\\?\\/, '');
    }
    return normalized;
}

export function toAppAssetUrl(absolutePath: string): string {
    const normalized = path.resolve(path.normalize(String(absolutePath || '')));
    return toRedboxAssetUrl(normalized);
}
