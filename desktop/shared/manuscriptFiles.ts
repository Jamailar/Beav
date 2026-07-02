export const MANUSCRIPT_MARKDOWN_EXTENSION = '.md';
export const MANUSCRIPT_HTML_EXTENSION = '.html';

export type ManuscriptExtension =
    | typeof MANUSCRIPT_MARKDOWN_EXTENSION
    | typeof MANUSCRIPT_HTML_EXTENSION;
export type ManuscriptFileKind = 'markdown' | 'html';
export type ManuscriptPackageKind = 'post' | 'article' | 'video' | 'audio';

const MANUSCRIPT_EXTENSION_KIND: Record<ManuscriptExtension, ManuscriptFileKind> = {
    [MANUSCRIPT_MARKDOWN_EXTENSION]: 'markdown',
    [MANUSCRIPT_HTML_EXTENSION]: 'html',
};

function normalizedManuscriptExtension(fileName: string): ManuscriptExtension | null {
    const normalized = String(fileName || '').trim().toLowerCase();
    if (normalized.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION)) return MANUSCRIPT_MARKDOWN_EXTENSION;
    if (normalized.endsWith(MANUSCRIPT_HTML_EXTENSION)) return MANUSCRIPT_HTML_EXTENSION;
    return null;
}

export function isSupportedManuscriptFile(fileName: string): boolean {
    return normalizedManuscriptExtension(fileName) !== null;
}

export function isManuscriptPackageName(_fileName: string): boolean {
    return false;
}

export function getPackageKindFromFileName(_fileName: string): ManuscriptPackageKind | null {
    return null;
}

export function getDraftTypeFromFileName(fileName: string): 'longform' | 'html' | 'video' | 'audio' | 'unknown' {
    return getManuscriptFileKind(fileName) === 'html' ? 'html' : 'unknown';
}

export function stripManuscriptExtension(fileName: string): string {
    const extension = normalizedManuscriptExtension(fileName);
    return extension
        ? fileName.slice(0, -extension.length)
        : fileName;
}

export function getManuscriptExtension(fileName: string): ManuscriptExtension | null {
    return normalizedManuscriptExtension(fileName);
}

export function getManuscriptFileKind(fileName: string): ManuscriptFileKind | null {
    const extension = getManuscriptExtension(fileName);
    return extension ? MANUSCRIPT_EXTENSION_KIND[extension] : null;
}

export function ensureManuscriptFileName(
    name: string,
    fallbackExtension: ManuscriptExtension = MANUSCRIPT_MARKDOWN_EXTENSION,
): string {
    return isSupportedManuscriptFile(name) ? name : `${name}${fallbackExtension}`;
}

export function renameManuscriptKeepingExtension(currentName: string, nextStem: string): string {
    const extension = getManuscriptExtension(currentName);
    return extension
        ? ensureManuscriptFileName(nextStem, extension)
        : nextStem;
}
