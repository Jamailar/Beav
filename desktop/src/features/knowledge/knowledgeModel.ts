export interface XhsCommentItem {
    id?: string;
    platformCommentId?: string;
    noteId?: string;
    parentCommentId?: string | null;
    rootCommentId?: string | null;
    level?: number;
    author?: {
        userId?: string | null;
        nickname?: string | null;
        profileUrl?: string | null;
        avatarUrl?: string | null;
        isNoteAuthor?: boolean;
    };
    content?: {
        text?: string;
        segments?: Array<Record<string, unknown>>;
        emojiUrls?: string[];
    };
    metrics?: {
        likes?: number;
        replies?: number;
    };
    time?: {
        display?: string | null;
        normalizedAt?: string | null;
    };
    location?: string | null;
    capturedAt?: string;
}

export interface XhsCommentsSnapshot {
    schemaVersion?: number;
    platform?: string;
    noteId?: string;
    entryId?: string;
    sourceLink?: string;
    total?: number;
    visibleCount?: number;
    hasMore?: boolean;
    capturedAt?: string;
    comments?: XhsCommentItem[];
}

export interface Note { type?: string; sourceUrl?: string;
    id: string;
    knowledgeKind?: string;
    title: string;
    author: string;
    authorId?: string;
    authorUrl?: string;
    authorAvatarUrl?: string;
    authorDescription?: string;
    content: string;
    excerpt?: string;
    siteName?: string;
    captureKind?: string;
    metadata?: Record<string, unknown>;
    xhsComments?: XhsCommentsSnapshot;
    htmlFile?: string;
    htmlFileUrl?: string;
    images: string[];
    tags?: string[];
    cover?: string;
    video?: string;
    videoUrl?: string;
    transcript?: string;
    transcriptionStatus?: 'processing' | 'completed' | 'failed';
    stats: {
        likes: number;
        collects?: number;
        comments?: number;
    };
    createdAt: string;
    updatedAt?: string;
    folderPath?: string;
    visualSearchSummary?: string;
    visualSearchPath?: string;
    visualSearchPage?: number;
    visualSearchThumbnailPath?: string;
    visualBlocks?: VisualSemanticBlock[];
}

export interface YouTubeVideo {
    id: string;
    videoId: string;
    videoUrl: string;
    title: string;
    originalTitle?: string;
    description: string;
    summary?: string;
    thumbnailUrl: string;
    hasSubtitle: boolean;
    subtitleContent?: string;
    subtitleError?: string;
    status?: 'processing' | 'completed' | 'failed';
    createdAt: string;
    updatedAt?: string;
    folderPath?: string;
    visualSearchSummary?: string;
    visualSearchPath?: string;
    visualSearchPage?: number;
    visualSearchThumbnailPath?: string;
}

export type KnowledgeTypeFilter =
    | 'all'
    | 'xhs-image'
    | 'xhs-video'
    | 'xhs-blogger'
    | 'xhs-comments'
    | 'douyin-video'
    | 'bilibili'
    | 'kuaishou'
    | 'tiktok'
    | 'reddit'
    | 'x'
    | 'instagram'
    | 'link-article'
    | 'wechat-article'
    | 'zhihu-answer'
    | 'zhihu-article'
    | 'youtube'
    | 'docs';
export type KnowledgeBackendKind = 'redbook-note' | 'link-article' | 'wechat-article' | 'zhihu-answer' | 'zhihu-article' | 'youtube-video' | 'document-source';

export type KnowledgeSortOrder = 'updated-desc' | 'created-desc' | 'title-asc';

export interface DocumentKnowledgeSource {
    id: string;
    kind: 'copied-file' | 'tracked-folder' | 'obsidian-vault';
    name: string;
    rootPath: string;
    locked: boolean;
    indexing: boolean;
    indexError?: string;
    fileCount: number;
    sampleFiles: string[];
    createdAt: string;
    updatedAt: string;
    visualSearchSummary?: string;
    visualSearchPath?: string;
    visualSearchPage?: number;
    visualSearchUnitId?: string;
    visualSearchEvidenceRefs?: string[];
    visualSearchThumbnailPath?: string;
    visualBlocks?: VisualSemanticBlock[];
}

export interface VisualSemanticBlock {
    blockId: string;
    path: string;
    absolutePath?: string;
    page?: number;
    blockType: string;
    text: string;
    visualUnitId?: string;
    evidenceRefs?: string[];
    visualEvidence?: Array<{
        id?: string;
        kind?: string;
        title?: string;
        text?: string;
        bbox?: { x?: number; y?: number; width?: number; height?: number } | null;
    }>;
    unitKind?: string;
    summary?: string;
}

export interface KnowledgeCatalogSummary {
    itemId: string;
    kind: KnowledgeBackendKind;
    noteType?: string;
    captureKind?: string;
    title: string;
    author: string;
    authorId?: string;
    authorUrl?: string;
    siteName?: string;
    sourceUrl?: string;
    folderPath?: string;
    rootPath?: string;
    coverUrl?: string;
    thumbnailUrl?: string;
    previewText: string;
    createdAt: string;
    updatedAt: string;
    language?: string;
    hasVideo: boolean;
    hasTranscript: boolean;
    tags: string[];
    status?: string;
    sampleFiles: string[];
    fileCount: number;
    visualSearchSummary?: string;
    visualSearchPath?: string;
    visualSearchPage?: number;
    visualSearchUnitId?: string;
    visualSearchEvidenceRefs?: string[];
    visualSearchThumbnailPath?: string;
}

export interface KnowledgeListPageResponse {
    items: KnowledgeCatalogSummary[];
    nextCursor?: string | null;
    total: number;
    kindCounts?: Record<string, number>;
}

export interface KnowledgeIndexStatus {
    indexedCount: number;
    visualIndex?: {
        totalUnits: number;
        indexedUnits: number;
        metadataOnlyUnits: number;
        failedUnits: number;
        retryDeferredUnits: number;
        retryReadyUnits: number;
        lastAttemptedAt?: string | null;
    };
    pendingCount: number;
    failedCount: number;
    rebuildProgress?: number | null;
    lastIndexedAt?: string | null;
    isBuilding: boolean;
    lastError?: string | null;
    migrationStatus?: string | null;
    pendingRebuildReason?: string | null;
}

export interface KnowledgeCardItem {
    id: string;
    kind: Exclude<KnowledgeTypeFilter, 'all'>;
    title: string;
    summary: string;
    createdAt: string;
    updatedAt: string;
    searchText: string;
    cover?: string;
    coverImage?: string;
    tags: string[];
    note?: Note;
    video?: YouTubeVideo;
    doc?: DocumentKnowledgeSource;
}

export const resolveNoteCardKind = (note: Note): KnowledgeCardItem['kind'] => {
    const captureKind = note.captureKind || note.type || '';
    if (captureKind === 'link-article') return 'link-article';
    if (captureKind === 'wechat-article') return 'wechat-article';
    if (captureKind.startsWith('bilibili-')) return 'bilibili';
    if (captureKind.startsWith('kuaishou-')) return 'kuaishou';
    if (captureKind.startsWith('tiktok-')) return 'tiktok';
    if (captureKind.startsWith('reddit-')) return 'reddit';
    if (captureKind.startsWith('x-')) return 'x';
    if (captureKind.startsWith('instagram-')) return 'instagram';
    if (captureKind === 'xhs-blogger') return 'xhs-blogger';
    if (captureKind === 'xhs-comments') return 'xhs-comments';
    if (captureKind === 'zhihu-answer') return 'zhihu-answer';
    if (captureKind === 'zhihu-article') return 'zhihu-article';
    if (note.type === 'link-article' || note.type === 'text') {
        return note.captureKind === 'wechat-article' ? 'wechat-article' : 'link-article';
    }
    if (note.captureKind === 'douyin-video') return 'douyin-video';
    if (note.captureKind === 'xhs-video' || note.video) return 'xhs-video';
    return 'xhs-image';
};

export interface KnowledgeAuthorView {
    id?: string;
    name: string;
    profileUrl?: string;
    avatarUrl?: string;
    description?: string;
}


export const SHOW_WECHAT_KNOWLEDGE_ACTIONS = false;
export const INLINE_TAG_LIMIT = 8;
export const KNOWLEDGE_SEARCH_DEBOUNCE_MS = 500;
export const KNOWLEDGE_RENDER_BATCH_SIZE = 60;
export const VISUAL_INDEX_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'heic', 'bmp', 'webp', 'pdf']);
export const NOTE_CATALOG_KINDS = new Set(['redbook-note', 'link-article', 'wechat-article', 'zhihu-answer', 'zhihu-article']);

export const isVisualIndexFilePath = (path: string) => {
    const extension = path.split('.').pop()?.toLowerCase() || '';
    return VISUAL_INDEX_EXTENSIONS.has(extension);
};

export const isNativeFilePickerCanceled = (error?: string) => {
    const message = String(error || '').toLowerCase();
    return message.includes('用户已取消')
        || message.includes('user canceled')
        || message.includes('user cancelled')
        || message.includes('canceled')
        || message.includes('cancelled')
        || message.includes('(-128)');
};


export const catalogSummaryToNote = (item: KnowledgeCatalogSummary): Note => ({
    id: item.itemId,
    knowledgeKind: item.kind,
    type: item.noteType,
    sourceUrl: item.sourceUrl,
    title: item.title,
    author: item.author || '原文链接',
    authorId: item.authorId,
    authorUrl: item.authorUrl,
    content: '',
    excerpt: item.visualSearchSummary || item.previewText,
    siteName: item.siteName,
    captureKind: item.captureKind || item.kind,
    htmlFile: undefined,
    htmlFileUrl: undefined,
    images: [],
    tags: item.tags,
    cover: item.coverUrl || item.visualSearchThumbnailPath,
    video: undefined,
    videoUrl: undefined,
    transcript: item.hasTranscript ? '' : undefined,
    transcriptionStatus: item.status as Note['transcriptionStatus'],
    stats: {
        likes: 0,
        collects: undefined,
    },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    folderPath: item.folderPath,
    visualSearchSummary: item.visualSearchSummary,
    visualSearchPath: item.visualSearchPath,
    visualSearchPage: item.visualSearchPage,
    visualSearchThumbnailPath: item.visualSearchThumbnailPath,
});

export const catalogSummaryToVideo = (item: KnowledgeCatalogSummary): YouTubeVideo => ({
    id: item.itemId,
    videoId: item.itemId,
    videoUrl: item.sourceUrl || '',
    title: item.title,
    originalTitle: undefined,
    description: item.previewText,
    summary: item.visualSearchSummary || item.previewText,
    thumbnailUrl: item.thumbnailUrl || item.visualSearchThumbnailPath || '',
    hasSubtitle: item.hasTranscript,
    subtitleContent: undefined,
    subtitleError: item.status === 'failed' ? item.previewText : undefined,
    status: item.status as YouTubeVideo['status'],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    folderPath: item.folderPath,
    visualSearchSummary: item.visualSearchSummary,
    visualSearchPath: item.visualSearchPath,
    visualSearchPage: item.visualSearchPage,
    visualSearchThumbnailPath: item.visualSearchThumbnailPath,
});

export const catalogSummaryToDocSource = (item: KnowledgeCatalogSummary): DocumentKnowledgeSource => ({
    id: item.itemId,
    kind: 'tracked-folder',
    name: item.title,
    rootPath: item.rootPath || '',
    locked: false,
    indexing: item.status === 'indexing',
    indexError: undefined,
    fileCount: Number(item.fileCount || 0),
    sampleFiles: Array.isArray(item.sampleFiles) ? item.sampleFiles : [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    visualSearchSummary: item.visualSearchSummary,
    visualSearchPath: item.visualSearchPath,
    visualSearchPage: item.visualSearchPage,
    visualSearchUnitId: item.visualSearchUnitId,
    visualSearchEvidenceRefs: item.visualSearchEvidenceRefs,
    visualSearchThumbnailPath: item.visualSearchThumbnailPath,
});

export function resolveKnowledgeBackendKind(typeFilter: KnowledgeTypeFilter): string | undefined {
    if (typeFilter === 'youtube') return 'youtube-video';
    if (typeFilter === 'docs') return 'document-source';
    if (
        typeFilter === 'link-article'
        || typeFilter === 'wechat-article'
        || typeFilter === 'zhihu-answer'
        || typeFilter === 'zhihu-article'
    ) return typeFilter;
    if (typeFilter === 'all') return undefined;
    return 'redbook-note';
}

export function projectCatalogPage(items: KnowledgeCatalogSummary[]) {
    return {
        notes: items
            .filter((item) => NOTE_CATALOG_KINDS.has(item.kind))
            .map(catalogSummaryToNote),
        videos: items
            .filter((item) => item.kind === 'youtube-video')
            .map(catalogSummaryToVideo),
        docs: items
            .filter((item) => item.kind === 'document-source')
            .map(catalogSummaryToDocSource),
    };
}

// 轻量级关键词提取（用于判断内容变化率）
export const extractKeywords = (text: string): Set<string> => {
    if (!text) return new Set();
    const cleaned = text
        .replace(/^#+\s*/gm, '')
        .replace(/[*_`~\[\](){}|\\/<>]/g, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .toLowerCase();
    const chineseWords = cleaned.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    const englishWords = (cleaned.match(/[a-z]{3,}/g) || []).filter(w =>
        !['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'with', 'this', 'that', 'from', 'have', 'was', 'were'].includes(w)
    );
    return new Set([...chineseWords, ...englishWords]);
};

// 计算关键词变化率
export const calculateChangeRate = (oldKeywords: Set<string>, newKeywords: Set<string>): number => {
    if (oldKeywords.size === 0 && newKeywords.size === 0) return 0;
    if (oldKeywords.size === 0 || newKeywords.size === 0) return 1;

    let added = 0, removed = 0;
    for (const kw of newKeywords) {
        if (!oldKeywords.has(kw)) added++;
    }
    for (const kw of oldKeywords) {
        if (!newKeywords.has(kw)) removed++;
    }
    const avgSize = (oldKeywords.size + newKeywords.size) / 2;
    return (added + removed) / avgSize;
};

export const orderImages = (images: string[]) => {
    return [...images].sort((a, b) => {
        const extractIndex = (value: string) => {
            const clean = value.split('?')[0];
            const filename = clean.split('/').pop() || '';
            const match = filename.match(/(\d+)(?=\.[a-zA-Z0-9]+$)/);
            if (!match) return 999998;
            const num = Number(match[1]);
            if (Number.isNaN(num)) return 999998;
            return num === 0 ? 999999 : num;
        };
        return extractIndex(a) - extractIndex(b);
    });
};

export const getNoteCoverImage = (note: Note) => {
    const orderedImages = orderImages(note.images || []);
    return note.cover || orderedImages[0] || '';
};

// 计算内容哈希（简单版）
export const hashContent = (content: string): string => {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
};
