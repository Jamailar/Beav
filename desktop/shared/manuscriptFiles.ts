export const MANUSCRIPT_MARKDOWN_EXTENSION = '.md';

export type ManuscriptExtension = typeof MANUSCRIPT_MARKDOWN_EXTENSION;
export type ManuscriptPackageKind = 'post' | 'article' | 'video' | 'audio';

export function isSupportedManuscriptFile(fileName: string): boolean {
    return fileName.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION);
}

export function isManuscriptPackageName(_fileName: string): boolean {
    return false;
}

export function getPackageKindFromFileName(_fileName: string): ManuscriptPackageKind | null {
    return null;
}

export function getDraftTypeFromFileName(fileName: string): 'longform' | 'video' | 'audio' | 'unknown' {
    return fileName.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION) ? 'unknown' : 'unknown';
}

export function stripManuscriptExtension(fileName: string): string {
    return fileName.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION)
        ? fileName.slice(0, -MANUSCRIPT_MARKDOWN_EXTENSION.length)
        : fileName;
}

export function getManuscriptExtension(fileName: string): ManuscriptExtension | null {
    return fileName.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION) ? MANUSCRIPT_MARKDOWN_EXTENSION : null;
}

export function ensureManuscriptFileName(
    name: string,
    fallbackExtension: ManuscriptExtension = MANUSCRIPT_MARKDOWN_EXTENSION,
): string {
    return isSupportedManuscriptFile(name) ? name : `${name}${fallbackExtension}`;
}

export function renameManuscriptKeepingExtension(currentName: string, nextStem: string): string {
    return currentName.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION)
        ? ensureManuscriptFileName(nextStem)
        : nextStem;
}
