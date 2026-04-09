export const MANUSCRIPT_MARKDOWN_EXTENSION = '.md';
export const ARTICLE_DRAFT_EXTENSION = '.redarticle';
export const POST_DRAFT_EXTENSION = '.redpost';
export const VIDEO_DRAFT_EXTENSION = '.redvideo';
export const AUDIO_DRAFT_EXTENSION = '.redaudio';

export const SUPPORTED_MANUSCRIPT_EXTENSIONS = [
    MANUSCRIPT_MARKDOWN_EXTENSION,
    ARTICLE_DRAFT_EXTENSION,
    POST_DRAFT_EXTENSION,
    VIDEO_DRAFT_EXTENSION,
    AUDIO_DRAFT_EXTENSION,
] as const;

export const MANUSCRIPT_PACKAGE_EXTENSIONS = [
    ARTICLE_DRAFT_EXTENSION,
    POST_DRAFT_EXTENSION,
    VIDEO_DRAFT_EXTENSION,
    AUDIO_DRAFT_EXTENSION,
] as const;

export type ManuscriptExtension = typeof SUPPORTED_MANUSCRIPT_EXTENSIONS[number];
export type ManuscriptPackageKind = 'article' | 'post' | 'video' | 'audio';

export function isSupportedManuscriptFile(fileName: string): boolean {
    return SUPPORTED_MANUSCRIPT_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

export function isManuscriptPackageName(fileName: string): boolean {
    return MANUSCRIPT_PACKAGE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

export function getPackageKindFromFileName(fileName: string): ManuscriptPackageKind | null {
    if (fileName.endsWith(ARTICLE_DRAFT_EXTENSION)) return 'article';
    if (fileName.endsWith(POST_DRAFT_EXTENSION)) return 'post';
    if (fileName.endsWith(VIDEO_DRAFT_EXTENSION)) return 'video';
    if (fileName.endsWith(AUDIO_DRAFT_EXTENSION)) return 'audio';
    return null;
}

export function getDraftTypeFromFileName(fileName: string): 'longform' | 'richpost' | 'video' | 'audio' | 'unknown' {
    const packageKind = getPackageKindFromFileName(fileName);
    if (packageKind === 'article') return 'longform';
    if (packageKind === 'post') return 'richpost';
    if (packageKind === 'video') return 'video';
    if (packageKind === 'audio') return 'audio';
    if (fileName.endsWith(MANUSCRIPT_MARKDOWN_EXTENSION)) return 'unknown';
    return 'unknown';
}

export function stripManuscriptExtension(fileName: string): string {
    const matched = SUPPORTED_MANUSCRIPT_EXTENSIONS.find((extension) => fileName.endsWith(extension));
    return matched ? fileName.slice(0, -matched.length) : fileName;
}

export function getManuscriptExtension(fileName: string): ManuscriptExtension | null {
    return SUPPORTED_MANUSCRIPT_EXTENSIONS.find((extension) => fileName.endsWith(extension)) || null;
}

export function ensureManuscriptFileName(name: string, fallbackExtension: ManuscriptExtension = MANUSCRIPT_MARKDOWN_EXTENSION): string {
    return isSupportedManuscriptFile(name) ? name : `${name}${fallbackExtension}`;
}

export function renameManuscriptKeepingExtension(currentName: string, nextStem: string): string {
    const extension = getManuscriptExtension(currentName);
    if (!extension) return nextStem;
    return ensureManuscriptFileName(nextStem, extension);
}
