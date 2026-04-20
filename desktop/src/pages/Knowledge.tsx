import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { SyntheticEvent } from 'react';
import { Search, Trash2, Image, Heart, MessageCircle, X, ChevronLeft, ChevronRight, Play, FileText, ExternalLink, RefreshCw, Sparkles, Star, BookmarkPlus, FolderPlus, FolderOpen, Plus, Loader2, Users } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PendingChatMessage } from '../App';
import { KnowledgeChatModal } from '../components/KnowledgeChatModal';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { resolveAssetUrl } from '../utils/pathManager';
import { buildRedClawAuthoringMessage } from '../utils/redclawAuthoring';
import { appAlert, appConfirm } from '../utils/appDialogs';

interface Note { type?: string; sourceUrl?: string;
    id: string;
    title: string;
    author: string;
    content: string;
    excerpt?: string;
    siteName?: string;
    captureKind?: string;
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
    };
    createdAt: string;
    folderPath?: string;
}

interface YouTubeVideo {
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
    folderPath?: string;
}

type KnowledgeTypeFilter = 'all' | 'xhs-image' | 'xhs-video' | 'douyin-video' | 'link-article' | 'wechat-article' | 'youtube' | 'docs';

interface DocumentKnowledgeSource {
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
}

interface KnowledgeCatalogSummary {
    itemId: string;
    kind: 'redbook-note' | 'youtube-video' | 'document-source';
    noteType?: string;
    captureKind?: string;
    title: string;
    author: string;
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
}

interface KnowledgeListPageResponse {
    items: KnowledgeCatalogSummary[];
    nextCursor?: string | null;
    total: number;
    kindCounts?: Record<string, number>;
}

interface KnowledgeIndexStatus {
    indexedCount: number;
    pendingCount: number;
    failedCount: number;
    lastIndexedAt?: string | null;
    isBuilding: boolean;
    lastError?: string | null;
}

interface KnowledgeCardItem {
    id: string;
    kind: Exclude<KnowledgeTypeFilter, 'all'>;
    title: string;
    summary: string;
    createdAt: string;
    searchText: string;
    cover?: string;
    tags: string[];
    note?: Note;
    video?: YouTubeVideo;
    doc?: DocumentKnowledgeSource;
}

interface KnowledgeProps {
    isEmbedded?: boolean;
    isActive?: boolean;
    onNavigateToChat?: (message: PendingChatMessage) => void;
    onNavigateToRedClaw?: (message: PendingChatMessage) => void;
    referenceContent?: string; // 用于相似度排序的参考内容
}

interface SettingsShape {
    image_model?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    active_space_id?: string;
}

const SHOW_WECHAT_KNOWLEDGE_ACTIONS = false;
const INLINE_TAG_LIMIT = 8;

const catalogSummaryToNote = (item: KnowledgeCatalogSummary): Note => ({
    id: item.itemId,
    type: item.noteType,
    sourceUrl: item.sourceUrl,
    title: item.title,
    author: item.author || '原文链接',
    content: '',
    excerpt: item.previewText,
    siteName: item.siteName,
    captureKind: item.captureKind,
    htmlFile: undefined,
    htmlFileUrl: undefined,
    images: [],
    tags: item.tags,
    cover: item.coverUrl,
    video: undefined,
    videoUrl: undefined,
    transcript: item.hasTranscript ? '' : undefined,
    transcriptionStatus: item.status as Note['transcriptionStatus'],
    stats: {
        likes: 0,
        collects: undefined,
    },
    createdAt: item.createdAt,
    folderPath: item.folderPath,
});

const catalogSummaryToVideo = (item: KnowledgeCatalogSummary): YouTubeVideo => ({
    id: item.itemId,
    videoId: item.itemId,
    videoUrl: item.sourceUrl || '',
    title: item.title,
    originalTitle: undefined,
    description: item.previewText,
    summary: item.previewText,
    thumbnailUrl: item.thumbnailUrl || '',
    hasSubtitle: item.hasTranscript,
    subtitleContent: undefined,
    subtitleError: item.status === 'failed' ? item.previewText : undefined,
    status: item.status as YouTubeVideo['status'],
    createdAt: item.createdAt,
    folderPath: item.folderPath,
});

const catalogSummaryToDocSource = (item: KnowledgeCatalogSummary): DocumentKnowledgeSource => ({
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
});

// 轻量级关键词提取（用于判断内容变化率）
const extractKeywords = (text: string): Set<string> => {
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
const calculateChangeRate = (oldKeywords: Set<string>, newKeywords: Set<string>): number => {
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

// 计算内容哈希（简单版）
const hashContent = (content: string): string => {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
};

export function Knowledge({ onNavigateToChat, onNavigateToRedClaw, isEmbedded = false, isActive = true, referenceContent }: KnowledgeProps) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [youtubeVideos, setYoutubeVideos] = useState<YouTubeVideo[]>([]);
    const [documentSources, setDocumentSources] = useState<DocumentKnowledgeSource[]>([]);
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);
    const [selectedVideo, setSelectedVideo] = useState<YouTubeVideo | null>(null);
    const [selectedImageIndex, setSelectedImageIndex] = useState(0);
    const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedTypeFilter, setSelectedTypeFilter] = useState<KnowledgeTypeFilter>('all');
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [isAllTagsDrawerOpen, setIsAllTagsDrawerOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [imageAspectMap, setImageAspectMap] = useState<Record<string, 'portrait' | 'landscape'>>({});
    const [showSubtitle, setShowSubtitle] = useState(false);
    const [showTranscript, setShowTranscript] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [isSubtitleLoading, setIsSubtitleLoading] = useState(false);
    const [isRefreshingYoutubeSummaries, setIsRefreshingYoutubeSummaries] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isSelectedNoteVideoPlaying, setIsSelectedNoteVideoPlaying] = useState(false);
    const [embeddedViewportWidth, setEmbeddedViewportWidth] = useState(0);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [kindCounts, setKindCounts] = useState<Record<string, number>>({});
    const [indexStatus, setIndexStatus] = useState<KnowledgeIndexStatus>({
        indexedCount: 0,
        pendingCount: 0,
        failedCount: 0,
        lastIndexedAt: null,
        isBuilding: false,
        lastError: null,
    });
    const wasActiveRef = useRef<boolean>(isActive);
    const embeddedViewportRef = useRef<HTMLDivElement>(null);
    const selectedNoteVideoRef = useRef<HTMLVideoElement>(null);
    const allTagsDrawerRef = useRef<HTMLDivElement>(null);
    const notesRef = useRef<Note[]>([]);
    const youtubeVideosRef = useRef<YouTubeVideo[]>([]);
    const documentSourcesRef = useRef<DocumentKnowledgeSource[]>([]);
    const hasKnowledgeSnapshotRef = useRef(false);
    const loadAllKnowledgeRequestRef = useRef(0);
    const loadDetailRequestRef = useRef(0);

    // 搜索框状态
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        notesRef.current = notes;
    }, [notes]);

    useEffect(() => {
        youtubeVideosRef.current = youtubeVideos;
    }, [youtubeVideos]);

    useEffect(() => {
        documentSourcesRef.current = documentSources;
    }, [documentSources]);

    const hasKnowledgeDataSnapshot = useCallback(() => {
        if (hasKnowledgeSnapshotRef.current) return true;
        return notesRef.current.length > 0 || youtubeVideosRef.current.length > 0 || documentSourcesRef.current.length > 0;
    }, []);

    // 快捷键监听
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'k')) {
                e.preventDefault();
                setIsSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
            }
            if (e.key === 'Escape' && isSearchOpen) {
                e.preventDefault();
                setIsSearchOpen(false);
                setSearchQuery('');
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isSearchOpen]);

    useEffect(() => {
        if (!isEmbedded) return;
        const node = embeddedViewportRef.current;
        if (!node || typeof ResizeObserver === 'undefined') return;

        const updateWidth = () => {
            const nextWidth = Math.round(node.getBoundingClientRect().width);
            setEmbeddedViewportWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };

        updateWidth();
        const observer = new ResizeObserver(() => updateWidth());
        observer.observe(node);
        return () => observer.disconnect();
    }, [isEmbedded]);

    useEffect(() => {
        if (!isAllTagsDrawerOpen) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (!allTagsDrawerRef.current?.contains(event.target as Node)) {
                setIsAllTagsDrawerOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsAllTagsDrawerOpen(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isAllTagsDrawerOpen]);

    const embeddedUsesSingleColumn = isEmbedded && embeddedViewportWidth > 0 && embeddedViewportWidth < 640;
    const embeddedUsesCompactCard = isEmbedded && embeddedViewportWidth > 0 && embeddedViewportWidth < 420;
    const knowledgeColumnsClass = isEmbedded
        ? (embeddedUsesSingleColumn ? 'columns-1' : 'columns-2')
        : 'columns-3 md:columns-4 xl:columns-5 2xl:columns-6';

    // 功能开关
    const vectorRecommendationEnabled = useFeatureFlag('vectorRecommendation');

    // 向量相似度排序状态
    const [similarityOrder, setSimilarityOrder] = useState<Map<string, number>>(new Map());
    const [isSimilarityLoading, setIsSimilarityLoading] = useState(false);
    const lastContentHashRef = useRef<string | null>(null);
    const embeddingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMountedRef = useRef(true);

    // 清理函数
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (embeddingTimeoutRef.current) {
                clearTimeout(embeddingTimeoutRef.current);
            }
        };
    }, []);

    // 相似度排序 - 缓存读取立即执行，计算延迟执行
    useEffect(() => {
        // 检查功能开关
        if (!vectorRecommendationEnabled) {
            // 功能关闭时清空排序
            if (similarityOrder.size > 0) {
                setSimilarityOrder(new Map());
                lastContentHashRef.current = null;
            }
            return;
        }

        if (!isEmbedded || !referenceContent || referenceContent.trim().length < 10) {
            // 内容不足时也清空排序
            if (similarityOrder.size > 0) {
                setSimilarityOrder(new Map());
                lastContentHashRef.current = null;
            }
            return;
        }

        const contentHash = hashContent(referenceContent);
        const manuscriptId = `content_${contentHash}`;

        // 内容未变化时跳过
        if (lastContentHashRef.current === contentHash) {
            return;
        }

        // 内容变化了，立即清空旧排序，显示加载状态
        console.log('[Knowledge] Content changed, clearing old order');
        setSimilarityOrder(new Map());
        setIsSimilarityLoading(true);

        // 清除之前的定时器
        if (embeddingTimeoutRef.current) {
            clearTimeout(embeddingTimeoutRef.current);
            embeddingTimeoutRef.current = null;
        }

        // 立即尝试从缓存读取
        (async () => {
            try {
                const cacheResult = await window.ipcRenderer.similarity.getCache(manuscriptId) as any;

                if (!isMountedRef.current) return;

                if (cacheResult?.success && cacheResult?.cache) {
                    const cache = cacheResult.cache;
                    if (cache.contentHash === contentHash && cache.knowledgeVersion === cacheResult.currentKnowledgeVersion) {
                        console.log('[Knowledge] Cache hit - using cached order');
                        const orderMap = new Map<string, number>();
                        cache.sortedIds.forEach((id: string, index: number) => orderMap.set(id, index));
                        setSimilarityOrder(orderMap);
                        lastContentHashRef.current = contentHash;
                        setIsSimilarityLoading(false);
                        return;
                    }
                }

                // 缓存未命中，延迟计算（切换文件时用较短延迟）
                const DEBOUNCE_MS = 2000; // 2秒防抖

                embeddingTimeoutRef.current = setTimeout(async () => {
                    if (!isMountedRef.current) return;

                    try {
                        const embCacheResult = await window.ipcRenderer.embedding.getManuscriptCache(manuscriptId) as any;
                        if (!isMountedRef.current) return;

                        let embedding: number[] | null = null;
                        const currentVersion = await window.ipcRenderer.similarity.getKnowledgeVersion();

                        if (embCacheResult?.success && embCacheResult?.cached?.contentHash === contentHash) {
                            console.log('[Knowledge] Using cached embedding');
                            embedding = embCacheResult.cached.embedding;
                        } else {
                            console.log('[Knowledge] Computing embedding...');
                            const computeResult = await window.ipcRenderer.embedding.compute(referenceContent) as any;
                            if (!isMountedRef.current) return;

                            if (!computeResult?.success || !computeResult?.embedding) {
                                console.warn('[Knowledge] Embedding failed:', computeResult?.error);
                                setIsSimilarityLoading(false);
                                return;
                            }

                            embedding = computeResult.embedding;

                            window.ipcRenderer.embedding.saveManuscriptCache({
                                filePath: manuscriptId,
                                contentHash,
                                embedding
                            }).catch(console.error);
                        }

                        if (!isMountedRef.current) return;

                        const sortResult = await window.ipcRenderer.embedding.getSortedSources(embedding) as any;
                        if (!isMountedRef.current) return;

                        if (sortResult?.success && sortResult?.sorted) {
                            const sortedIds = sortResult.sorted.map((item: any) => item.sourceId);
                            const orderMap = new Map<string, number>();
                            sortedIds.forEach((id: string, index: number) => orderMap.set(id, index));
                            setSimilarityOrder(orderMap);
                            lastContentHashRef.current = contentHash;
                            window.ipcRenderer.similarity.saveCache({
                                manuscriptId,
                                contentHash,
                                knowledgeVersion: currentVersion,
                                sortedIds
                            }).catch(console.error);
                        }
                    } catch (e) {
                        console.error('[Knowledge] Similarity error:', e);
                    } finally {
                        if (isMountedRef.current) {
                            setIsSimilarityLoading(false);
                        }
                    }
                }, 5000); // 5秒防抖
            } catch (e) {
                console.error('[Knowledge] Cache lookup failed:', e);
            }
        })();

        return () => {
            if (embeddingTimeoutRef.current) {
                clearTimeout(embeddingTimeoutRef.current);
            }
        };
    }, [isEmbedded, referenceContent]);

    // Chat Modal State
    const [chatModalState, setChatModalState] = useState<{
        isOpen: boolean;
        contextId: string;
        contextType: string;
        contextTitle: string;
        contextContent: string;
    }>({
        isOpen: false,
        contextId: '',
        contextType: 'note',
        contextTitle: '',
        contextContent: ''
    });

    const openChat = (id: string, type: string, title: string, content: string) => {
        setChatModalState({
            isOpen: true,
            contextId: id,
            contextType: type,
            contextTitle: title,
            contextContent: content
        });
    };

    const getNoteContextType = useCallback((note: Note): string => {
        if (note.captureKind === 'wechat-article') return 'wechat-article';
        if (note.type === 'link-article') return 'link-article';
        if (note.video) return 'xiaohongshu_video';
        return 'xiaohongshu_note';
    }, []);

    const isExpandableXiaohongshuNote = useCallback((note: Note): boolean => {
        return !note.type && note.captureKind !== 'wechat-article';
    }, []);

    const handleExpandToWechat = useCallback((note: Note) => {
        if (!onNavigateToRedClaw || !isExpandableXiaohongshuNote(note)) return;
        const sourceContent = [
            note.content || '',
            note.transcript ? `视频转录：\n${note.transcript}` : '',
        ].filter(Boolean).join('\n\n');

        onNavigateToRedClaw(buildRedClawAuthoringMessage({
            platform: 'wechat_official_account',
            taskType: 'expand_from_xhs',
            brief: '请把这篇小红书内容扩写成公众号文章，并在保留原观点的前提下补足背景、论证、案例、总结和 CTA。',
            sourceMode: 'knowledge',
            sourcePlatform: 'xiaohongshu',
            sourceNoteId: note.id,
            sourceTitle: note.title,
            sourceContent,
        }));
        setSelectedNote(null);
    }, [isExpandableXiaohongshuNote, onNavigateToRedClaw]);

    const refreshIndexStatus = useCallback(async () => {
        try {
            const status = await window.ipcRenderer.knowledge.getIndexStatus<KnowledgeIndexStatus>();
            setIndexStatus(status);
        } catch (error) {
            console.error('Failed to load knowledge index status:', error);
        }
    }, []);

    const resolveBackendKind = useCallback((typeFilter: KnowledgeTypeFilter): string | undefined => {
        if (typeFilter === 'youtube') return 'youtube-video';
        if (typeFilter === 'docs') return 'document-source';
        if (typeFilter === 'all') return undefined;
        return 'redbook-note';
    }, []);

    const applyCatalogPage = useCallback((items: KnowledgeCatalogSummary[], append: boolean) => {
        const nextNotes = items
            .filter((item) => item.kind === 'redbook-note')
            .map(catalogSummaryToNote);
        const nextVideos = items
            .filter((item) => item.kind === 'youtube-video')
            .map(catalogSummaryToVideo);
        const nextDocs = items
            .filter((item) => item.kind === 'document-source')
            .map(catalogSummaryToDocSource);
        const mergeById = <T extends { id: string }>(current: T[], incoming: T[]) => {
            const merged = new Map<string, T>();
            current.forEach((item) => merged.set(item.id, item));
            incoming.forEach((item) => merged.set(item.id, item));
            return Array.from(merged.values());
        };
        setNotes((prev) => append ? mergeById(prev, nextNotes) : nextNotes);
        setYoutubeVideos((prev) => append ? mergeById(prev, nextVideos) : nextVideos);
        setDocumentSources((prev) => append ? mergeById(prev, nextDocs) : nextDocs);
        hasKnowledgeSnapshotRef.current = hasKnowledgeSnapshotRef.current || items.length > 0;
    }, []);

    const loadCatalogPage = useCallback(async (reset: boolean) => {
        const requestId = loadAllKnowledgeRequestRef.current + 1;
        loadAllKnowledgeRequestRef.current = requestId;
        const hasLocalData = hasKnowledgeDataSnapshot();
        if (reset) {
            if (!hasLocalData) {
                setIsLoading(true);
            }
        } else {
            setIsLoadingMore(true);
        }
        try {
            const response = await window.ipcRenderer.knowledge.listPage<KnowledgeListPageResponse>({
                cursor: reset ? null : nextCursor,
                limit: 200,
                kind: resolveBackendKind(selectedTypeFilter),
                query: searchQuery.trim() || undefined,
                sort: 'updated-desc',
            });
            if (requestId !== loadAllKnowledgeRequestRef.current) return;
            const pageItems = Array.isArray(response?.items) ? response.items : [];
            applyCatalogPage(pageItems, !reset);
            setNextCursor(typeof response?.nextCursor === 'string' ? response.nextCursor : null);
            setKindCounts((response?.kindCounts && typeof response.kindCounts === 'object')
                ? response.kindCounts
                : {});
            if (reset && pageItems.length === 0 && !hasLocalData) {
                setNotes([]);
                setYoutubeVideos([]);
                setDocumentSources([]);
            }
        } catch (error) {
            if (requestId !== loadAllKnowledgeRequestRef.current) return;
            console.error('Failed to load knowledge catalog page:', error);
            if (reset && !hasLocalData) {
                setNotes([]);
                setYoutubeVideos([]);
                setDocumentSources([]);
            }
        } finally {
            if (requestId === loadAllKnowledgeRequestRef.current) {
                setIsLoading(false);
                setIsLoadingMore(false);
            }
        }
    }, [applyCatalogPage, hasKnowledgeDataSnapshot, nextCursor, resolveBackendKind, searchQuery, selectedTypeFilter]);

    const loadAllKnowledge = useCallback(async () => {
        await Promise.all([refreshIndexStatus(), loadCatalogPage(true)]);
    }, [loadCatalogPage, refreshIndexStatus]);

    const loadNotes = useCallback(async () => {
        await loadCatalogPage(true);
    }, [loadCatalogPage]);

    const loadYoutubeVideos = useCallback(async () => {
        await loadCatalogPage(true);
    }, [loadCatalogPage]);

    const loadDocumentSources = useCallback(async () => {
        await loadCatalogPage(true);
    }, [loadCatalogPage]);

    const loadKnowledgeDetail = useCallback(async (itemId: string, kind: 'redbook-note' | 'youtube-video' | 'document-source') => {
        const requestId = loadDetailRequestRef.current + 1;
        loadDetailRequestRef.current = requestId;
        try {
            return await window.ipcRenderer.knowledge.getItemDetail<Record<string, unknown>>({
                itemId,
                kind,
            });
        } catch (error) {
            console.error('Failed to load knowledge detail:', error);
            return null;
        }
    }, []);

    const openNoteDetail = useCallback(async (note: Note) => {
        setSelectedNote(note);
        const detail = await loadKnowledgeDetail(note.id, 'redbook-note');
        if (detail && loadDetailRequestRef.current > 0) {
            setSelectedNote(detail as unknown as Note);
        }
    }, [loadKnowledgeDetail]);

    const openVideoDetail = useCallback(async (video: YouTubeVideo) => {
        setSelectedVideo(video);
        const detail = await loadKnowledgeDetail(video.id, 'youtube-video');
        if (detail && loadDetailRequestRef.current > 0) {
            setSelectedVideo(detail as unknown as YouTubeVideo);
        }
    }, [loadKnowledgeDetail]);

    useEffect(() => {
        void loadAllKnowledge();
    }, [loadAllKnowledge]);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void loadAllKnowledge();
        }, 180);
        return () => window.clearTimeout(timeout);
    }, [searchQuery, selectedTypeFilter, loadAllKnowledge]);

    // 每次从其他页面切回知识库时，强制刷新当前列表，避免页面显示旧缓存。
    useEffect(() => {
        const wasActive = wasActiveRef.current;
        wasActiveRef.current = isActive;
        if (!isActive || wasActive) {
            return;
        }
        void loadAllKnowledge();
    }, [isActive, loadAllKnowledge]);

    const loadMoreKnowledge = useCallback(async () => {
        if (!nextCursor || isLoadingMore) return;
        await loadCatalogPage(false);
    }, [isLoadingMore, loadCatalogPage, nextCursor]);

    // 监听 YouTube 视频更新事件
    useEffect(() => {
        const handleVideoUpdated = (_event: unknown, data: { noteId: string; status: string; hasSubtitle?: boolean; title?: string; summary?: string }) => {
            console.log('[Knowledge] Video updated:', data);
            void Promise.all([refreshIndexStatus(), loadYoutubeVideos()]);
        };

        const handleNewVideo = (_event: unknown, data: { noteId: string; title: string; status?: string }) => {
            console.log('[Knowledge] New video added:', data);
            void Promise.all([refreshIndexStatus(), loadYoutubeVideos()]);
        };

        const handleKnowledgeChanged = () => {
            void Promise.all([refreshIndexStatus(), loadAllKnowledge()]);
        };

        window.ipcRenderer.on('knowledge:youtube-video-updated', handleVideoUpdated);
        window.ipcRenderer.on('knowledge:new-youtube-video', handleNewVideo);
        window.ipcRenderer.on('knowledge:changed', handleKnowledgeChanged);
        window.ipcRenderer.on('knowledge:catalog-updated', handleKnowledgeChanged);

        return () => {
            window.ipcRenderer.off('knowledge:youtube-video-updated', handleVideoUpdated);
            window.ipcRenderer.off('knowledge:new-youtube-video', handleNewVideo);
            window.ipcRenderer.off('knowledge:changed', handleKnowledgeChanged);
            window.ipcRenderer.off('knowledge:catalog-updated', handleKnowledgeChanged);
        };
    }, [loadAllKnowledge, loadYoutubeVideos, refreshIndexStatus]);

    useEffect(() => {
        const handleDocsUpdated = () => {
            void Promise.all([refreshIndexStatus(), loadDocumentSources()]);
        };
        window.ipcRenderer.on('knowledge:docs-updated', handleDocsUpdated);
        return () => {
            window.ipcRenderer.off('knowledge:docs-updated', handleDocsUpdated);
        };
    }, [loadDocumentSources, refreshIndexStatus]);

    // Aggregate tags from notes
    const allTags = useMemo(() => {
        const tagCounts: Record<string, number> = {};
        notes.forEach(note => {
            if (note.tags && Array.isArray(note.tags)) {
                note.tags.forEach(tag => {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                });
            }
        });
        return Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1]) // Sort by count desc
            .map(([tag, count]) => ({ tag, count }));
    }, [notes]);

    useEffect(() => {
        if (!selectedTag) return;
        if (!allTags.some((item) => item.tag === selectedTag)) {
            setSelectedTag(null);
            setIsAllTagsDrawerOpen(false);
        }
    }, [allTags, selectedTag]);

    const inlineTagItems = useMemo(() => {
        const leadingTags = allTags.slice(0, INLINE_TAG_LIMIT);
        if (!selectedTag) {
            return leadingTags;
        }
        if (leadingTags.some((item) => item.tag === selectedTag)) {
            return leadingTags;
        }
        const selectedEntry = allTags.find((item) => item.tag === selectedTag);
        if (!selectedEntry) {
            return leadingTags;
        }
        return [...leadingTags.slice(0, Math.max(0, INLINE_TAG_LIMIT - 1)), selectedEntry];
    }, [allTags, selectedTag]);

    const hasHiddenTags = allTags.length > inlineTagItems.length;

    const orderImages = (images: string[]) => {
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

    const getNoteCoverImage = (note: Note) => {
        const orderedImages = orderImages(note.images || []);
        return note.cover || orderedImages[0] || '';
    };

    const knowledgeItems = useMemo<KnowledgeCardItem[]>(() => {
        const noteItems: KnowledgeCardItem[] = notes.map((note) => {
            const orderedImages = orderImages(note.images || []);
            const kind: KnowledgeCardItem['kind'] = (note.type === 'link-article' || note.type === 'text')
                ? note.captureKind === 'wechat-article'
                    ? 'wechat-article'
                    : 'link-article'
                : note.captureKind === 'douyin-video'
                    ? 'douyin-video'
                    : (note.captureKind === 'xhs-video' || note.video)
                    ? 'xhs-video'
                    : 'xhs-image';

            return {
                id: note.id,
                kind,
                title: note.title || '未命名内容',
                summary: note.excerpt || note.content || note.sourceUrl || '',
                createdAt: note.createdAt,
                searchText: [
                    note.title,
                    note.author,
                    note.siteName,
                    note.excerpt,
                    note.sourceUrl,
                    ...(note.tags || []),
                ].join('\n').toLowerCase(),
                cover: note.cover || orderedImages[0] || note.video || '',
                tags: Array.isArray(note.tags) ? note.tags : [],
                note,
            };
        });

        const videoItems: KnowledgeCardItem[] = youtubeVideos.map((video) => ({
            id: video.id,
            kind: 'youtube',
            title: video.title || '未命名视频',
            summary: video.summary || video.description || '',
            createdAt: video.createdAt,
            searchText: [video.title, video.originalTitle, video.summary, video.description, video.videoUrl].join('\n').toLowerCase(),
            cover: video.thumbnailUrl || '',
            tags: [],
            video,
        }));

        const docItems: KnowledgeCardItem[] = documentSources.map((doc) => ({
            id: doc.id,
            kind: 'docs',
            title: doc.name,
            summary: doc.rootPath,
            createdAt: doc.updatedAt || doc.createdAt,
            searchText: [doc.name, doc.rootPath, ...doc.sampleFiles].join('\n').toLowerCase(),
            tags: [],
            doc,
        }));

        return [...noteItems, ...videoItems, ...docItems];
    }, [notes, youtubeVideos, documentSources]);

    const typeFilters = useMemo(() => {
        const counts: Record<Exclude<KnowledgeTypeFilter, 'all'>, number> = {
            'xhs-image': 0,
            'xhs-video': 0,
            'douyin-video': 0,
            'link-article': 0,
            'wechat-article': 0,
            'youtube': Number(kindCounts['youtube-video'] || 0),
            'docs': Number(kindCounts['document-source'] || 0),
        };
        knowledgeItems.forEach((item) => {
            if (item.kind === 'youtube' || item.kind === 'docs') {
                return;
            }
            counts[item.kind] += 1;
        });
        return [
            { key: 'all' as const, label: '全部', count: Number(kindCounts['redbook-note'] || 0) + counts.youtube + counts.docs },
            { key: 'xhs-image' as const, label: '小红书图文', count: counts['xhs-image'] },
            { key: 'xhs-video' as const, label: '小红书视频', count: counts['xhs-video'] },
            { key: 'douyin-video' as const, label: '抖音视频', count: counts['douyin-video'] },
            { key: 'link-article' as const, label: '链接文章', count: counts['link-article'] },
            ...(SHOW_WECHAT_KNOWLEDGE_ACTIONS ? [{ key: 'wechat-article' as const, label: '公众号文章', count: counts['wechat-article'] }] : []),
            { key: 'youtube' as const, label: 'YouTube', count: counts.youtube },
            { key: 'docs' as const, label: '文档', count: counts.docs },
        ].filter((item) => item.key === 'all' || item.count > 0);
    }, [kindCounts, knowledgeItems]);

    const youtubeSummaryPendingCount = useMemo(() => {
        return youtubeVideos.filter((video) => video.hasSubtitle && !String(video.summary || '').trim()).length;
    }, [youtubeVideos]);

    const filteredKnowledgeItems = useMemo(() => {
        const filtered = knowledgeItems.filter((item) => {
            if (selectedTypeFilter !== 'all' && item.kind !== selectedTypeFilter) {
                return false;
            }
            if (selectedTag && !item.tags.includes(selectedTag)) {
                return false;
            }
            return true;
        });

        if (similarityOrder.size > 0) {
            return [...filtered].sort((a, b) => {
                const orderA = similarityOrder.get(a.id) ?? Infinity;
                const orderB = similarityOrder.get(b.id) ?? Infinity;
                if (orderA !== orderB) return orderA - orderB;
                return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            });
        }

        return [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [knowledgeItems, searchQuery, selectedTypeFilter, selectedTag, similarityOrder]);

    const resolveAspectClass = (key: string) => {
        const aspect = imageAspectMap[key] || 'portrait';
        return aspect === 'landscape' ? 'aspect-[4/3]' : 'aspect-[3/4]';
    };

    const handleAllTagsClick = useCallback(() => {
        if (selectedTag) {
            setSelectedTag(null);
            setIsAllTagsDrawerOpen(false);
            return;
        }
        if (!hasHiddenTags) {
            return;
        }
        setIsAllTagsDrawerOpen((prev) => !prev);
    }, [hasHiddenTags, selectedTag]);

    const handleTagSelection = useCallback((tag: string) => {
        setSelectedTag((prev) => prev === tag ? null : tag);
        setIsAllTagsDrawerOpen(false);
    }, []);

    const handleImageLoad = (key: string, event: SyntheticEvent<HTMLImageElement>) => {
        const img = event.currentTarget;
        const aspect = img.naturalWidth > img.naturalHeight ? 'landscape' : 'portrait';
        setImageAspectMap((prev) => (prev[key] === aspect ? prev : { ...prev, [key]: aspect }));
    };

    useEffect(() => {
        if (selectedNote) {
            setSelectedImageIndex(0);
            setIsImagePreviewOpen(false);
            setShowTranscript(false);
            setIsSelectedNoteVideoPlaying(false);
        }
    }, [selectedNote]);

    useEffect(() => {
        if (!isSelectedNoteVideoPlaying) return;
        selectedNoteVideoRef.current?.play().catch(() => {});
    }, [isSelectedNoteVideoPlaying]);

    useEffect(() => {
        if (selectedVideo) {
            setShowSubtitle(false);
        }
    }, [selectedVideo]);

    useEffect(() => {
        if (!selectedVideo) return;
        const latest = youtubeVideos.find(video => video.id === selectedVideo.id);
        if (!latest) return;
        setSelectedVideo(prev => {
            if (!prev || prev.id !== latest.id) return prev;
            const nextSubtitleContent = prev.subtitleContent || latest.subtitleContent;
            if (
                prev.title === latest.title &&
                prev.description === latest.description &&
                prev.summary === latest.summary &&
                prev.thumbnailUrl === latest.thumbnailUrl &&
                prev.hasSubtitle === latest.hasSubtitle &&
                prev.subtitleError === latest.subtitleError &&
                prev.status === latest.status &&
                prev.createdAt === latest.createdAt &&
                prev.folderPath === latest.folderPath &&
                prev.subtitleContent === nextSubtitleContent
            ) {
                return prev;
            }
            return {
                ...prev,
                ...latest,
                subtitleContent: nextSubtitleContent,
            };
        });
    }, [selectedVideo, youtubeVideos]);

    const loadSelectedVideoSubtitle = useCallback(async (video: YouTubeVideo) => {
        if (!video?.id) return;
        setIsSubtitleLoading(true);
        try {
            const res = await window.ipcRenderer.readYoutubeSubtitle(video.id) as {
                success: boolean;
                subtitleContent?: string;
                hasSubtitle?: boolean;
                error?: string;
            };
            if (res.success && typeof res.subtitleContent === 'string') {
                setSelectedVideo(prev => prev && prev.id === video.id
                    ? { ...prev, subtitleContent: res.subtitleContent, hasSubtitle: res.hasSubtitle ?? prev.hasSubtitle }
                    : prev
                );
            }
        } catch (e) {
            console.error('Failed to read subtitle:', e);
        } finally {
            setIsSubtitleLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!selectedVideo) return;
        if (selectedVideo.hasSubtitle && (!selectedVideo.subtitleContent || !selectedVideo.subtitleContent.trim())) {
            loadSelectedVideoSubtitle(selectedVideo);
        }
    }, [selectedVideo, loadSelectedVideoSubtitle]);

    useEffect(() => {
        const handleNoteUpdated = (_event: unknown, data: { noteId: string; hasTranscript?: boolean; transcriptionStatus?: 'processing' | 'completed' | 'failed' }) => {
            void Promise.all([refreshIndexStatus(), loadNotes()]);
        };
        window.ipcRenderer.on('knowledge:note-updated', handleNoteUpdated);
        return () => {
            window.ipcRenderer.off('knowledge:note-updated', handleNoteUpdated);
        };
    }, [loadNotes, refreshIndexStatus]);

    const handleDeleteNote = async (noteId: string) => {
        if (!(await appConfirm('确定要删除这篇笔记吗？', { title: '删除笔记', confirmLabel: '删除', tone: 'danger' }))) return;

        try {
            await window.ipcRenderer.knowledge.deleteNote(noteId);
            setNotes(notes.filter(n => n.id !== noteId));
            if (selectedNote?.id === noteId) {
                setSelectedNote(null);
            }
        } catch (e) {
            console.error('Failed to delete note:', e);
        }
    };

    const handleTranscribeNote = async (noteId: string) => {
        try {
            setIsTranscribing(true);
            setNotes(prev => prev.map(note => note.id === noteId ? { ...note, transcriptionStatus: 'processing' } : note));
            setSelectedNote(prev => prev && prev.id === noteId ? { ...prev, transcriptionStatus: 'processing' } : prev);
            const res = await window.ipcRenderer.knowledge.transcribe(noteId) as { success: boolean; transcript?: string; error?: string };
            if (res.success) {
                await Promise.all([refreshIndexStatus(), loadNotes()]);
                const refreshed = await loadKnowledgeDetail(noteId, 'redbook-note');
                setSelectedNote((refreshed as unknown as Note) || null);
                setShowTranscript(true);
            } else {
                setNotes(prev => prev.map(note => note.id === noteId ? { ...note, transcriptionStatus: 'failed' } : note));
                setSelectedNote(prev => prev && prev.id === noteId ? { ...prev, transcriptionStatus: 'failed' } : prev);
                void appAlert(res.error || '转录失败');
            }
        } catch (e) {
            console.error('Failed to transcribe note:', e);
            setNotes(prev => prev.map(note => note.id === noteId ? { ...note, transcriptionStatus: 'failed' } : note));
            setSelectedNote(prev => prev && prev.id === noteId ? { ...prev, transcriptionStatus: 'failed' } : prev);
            void appAlert('转录失败');
        } finally {
            setIsTranscribing(false);
        }
    };

    const handleSaveNoteCoverAsTemplate = useCallback(async (note: Note) => {
        try {
            const orderedImages = orderImages(note.images || []);
            const coverImage = orderedImages[selectedImageIndex] || note.cover || orderedImages[0] || '';
            if (!coverImage) {
                void appAlert('这篇笔记没有可用封面图');
                return;
            }

            const settings = await window.ipcRenderer.getSettings() as SettingsShape | undefined;
            const spaceId = String(settings?.active_space_id || 'default').trim() || 'default';

            const now = new Date().toISOString();
            const title = String(note.title || '未命名笔记').trim();
            const plainContent = String(note.content || '').replace(/\s+/g, ' ').trim();
            const summary = plainContent.slice(0, 160);
            const templateName = `知识库封面 · ${title.slice(0, 24) || note.id}`;
            const prompt = [
                `为小红书笔记生成封面图。`,
                `主题：${title}`,
                summary ? `内容摘要：${summary}` : '',
                `要求：标题区域清晰、主体突出、适合信息流封面点击。`,
            ].filter(Boolean).join('\n');

            const styleHint = [
                `来源：知识库笔记 ${note.id}`,
                note.sourceUrl ? `原文：${note.sourceUrl}` : '',
                `已绑定封面参考图，可在生成时直接复用。`,
            ].filter(Boolean).join('\n');
            const result = await window.ipcRenderer.cover.templates.save({
                template: {
                    name: templateName,
                    prompt,
                    styleHint,
                    model: String(settings?.image_model || 'gpt-image-1'),
                    aspectRatio: String(settings?.image_aspect_ratio || '3:4'),
                    size: String(settings?.image_size || ''),
                    quality: String(settings?.image_quality || 'standard'),
                    count: 1,
                    projectId: '',
                    titlePrefix: title.slice(0, 32),
                    templateImage: coverImage,
                    updatedAt: now,
                },
            }) as { success?: boolean; error?: string };
            if (!result?.success) {
                void appAlert(result?.error || '保存封面模板失败');
                return;
            }
            window.dispatchEvent(new CustomEvent('cover:templates-updated', {
                detail: { spaceId },
            }));
            void appAlert('已保存为封面模板，可在「封面」页直接套用。');
        } catch (error) {
            console.error('Failed to save cover template from note:', error);
            void appAlert('保存封面模板失败');
        }
    }, [selectedImageIndex]);

    const handleDeleteVideo = async (videoId: string) => {
        if (!(await appConfirm('确定要删除这个视频吗？', { title: '删除视频', confirmLabel: '删除', tone: 'danger' }))) return;

        try {
            await window.ipcRenderer.knowledge.deleteYoutube(videoId);
            setYoutubeVideos(youtubeVideos.filter(v => v.id !== videoId));
            if (selectedVideo?.id === videoId) {
                setSelectedVideo(null);
            }
        } catch (e) {
            console.error('Failed to delete video:', e);
        }
    };

    const openYouTube = (url: string) => {
        window.open(url, '_blank');
    };

    const handleRetrySubtitle = async (videoId: string) => {
        try {
            // 更新本地状态为处理中
            setYoutubeVideos(prev => prev.map(v =>
                v.id === videoId ? { ...v, status: 'processing' as const, subtitleError: undefined } : v
            ));
            if (selectedVideo?.id === videoId) {
                setSelectedVideo(prev => prev ? { ...prev, status: 'processing', subtitleError: undefined } : null);
            }

            await window.ipcRenderer.knowledge.retryYoutubeSubtitle(videoId);
            // 状态更新会通过 IPC 事件 'knowledge:youtube-video-updated' 自动处理
        } catch (e) {
            console.error('Failed to retry subtitle:', e);
        }
    };

    const handleRefreshYoutubeSummaries = async () => {
        try {
            setIsRefreshingYoutubeSummaries(true);
            const result = await window.ipcRenderer.knowledge.regenerateYoutubeSummaries() as {
                success?: boolean;
                updated?: number;
                skipped?: number;
                failed?: number;
                errors?: Array<{ videoId?: string; error?: string }>;
            };
            await loadYoutubeVideos();
            if (result?.success) {
                void appAlert(`已更新 ${result.updated || 0} 个 YouTube 视频摘要${result?.skipped ? `，跳过 ${result.skipped} 个无字幕视频` : ''}`);
                return;
            }
            const firstError = result?.errors?.[0]?.error || '批量刷新摘要失败';
            void appAlert(firstError);
        } catch (error) {
            console.error('Failed to refresh YouTube summaries:', error);
            void appAlert('批量刷新 YouTube 摘要失败');
        } finally {
            setIsRefreshingYoutubeSummaries(false);
        }
    };

    const handleAddDocumentFiles = async () => {
        const result = await window.ipcRenderer.knowledge.addDocFiles() as { success?: boolean; error?: string };
        if (!result?.success) {
            void appAlert(result?.error || '添加文件失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleAddDocumentFolder = async () => {
        const result = await window.ipcRenderer.knowledge.addDocFolder() as { success?: boolean; error?: string };
        if (!result?.success) {
            void appAlert(result?.error || '添加文件夹失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleAddObsidianVault = async () => {
        const result = await window.ipcRenderer.knowledge.addObsidianVault() as { success?: boolean; error?: string };
        if (!result?.success) {
            void appAlert(result?.error || '添加 Obsidian 仓库失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleDeleteDocumentSource = async (source: DocumentKnowledgeSource) => {
        if (!(await appConfirm(`确定要移除文档源“${source.name}”吗？`, { title: '移除文档源', confirmLabel: '移除', tone: 'danger' }))) return;
        const result = await window.ipcRenderer.knowledge.deleteDocSource(source.id) as { success?: boolean; error?: string };
        if (!result?.success) {
            void appAlert(result?.error || '删除文档源失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleShowInFolder = async (source?: string) => {
        const normalized = String(source || '').trim();
        if (!normalized) return;
        const result = await window.ipcRenderer.files.showInFolder({ source: normalized }) as { success?: boolean; error?: string };
        if (!result?.success) {
            void appAlert(result?.error || '打开文件夹失败');
        }
    };

    const getKnowledgeKindLabel = (kind: KnowledgeCardItem['kind']) => {
        switch (kind) {
            case 'xhs-image':
                return '小红书图文';
            case 'xhs-video':
                return '小红书视频';
            case 'douyin-video':
                return '抖音视频';
            case 'link-article':
                return '链接文章';
            case 'wechat-article':
                return '公众号文章';
            case 'youtube':
                return 'YouTube';
            case 'docs':
                return '文档';
            default:
                return kind;
        }
    };

    const getKnowledgeKindBadgeClass = (kind: KnowledgeCardItem['kind']) => {
        switch (kind) {
            case 'xhs-image':
                return 'bg-rose-500/90 text-white';
            case 'xhs-video':
                return 'bg-red-500/90 text-white';
            case 'douyin-video':
                return 'bg-neutral-900 text-white';
            case 'link-article':
                return 'bg-sky-500/90 text-white';
            case 'wechat-article':
                return 'bg-emerald-500/90 text-white';
            case 'youtube':
                return 'bg-red-600/90 text-white';
            case 'docs':
                return 'bg-emerald-500/90 text-white';
            default:
                return 'bg-surface-tertiary text-text-primary';
        }
    };

    const getKnowledgeTagClass = (tag: string) => {
        switch (tag) {
            case '公众号文章':
                return 'text-emerald-700 bg-emerald-50 border-emerald-200';
            case '网页文章':
                return 'text-sky-700 bg-sky-50 border-sky-200';
            default:
                return 'text-accent-primary bg-accent-primary/5 border-accent-primary/10';
        }
    };

    const renderNoteBody = (note: Note) => {
        const isMarkdownArticle = note.type === 'link-article' && note.captureKind !== 'wechat-article';
        if (isMarkdownArticle) {
            return (
                <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                    <article className="prose prose-sm max-w-none prose-headings:text-text-primary prose-p:text-text-primary prose-li:text-text-primary prose-strong:text-text-primary prose-a:text-sky-700 prose-pre:bg-slate-900 prose-pre:text-slate-100 prose-code:text-rose-700">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {note.content || ''}
                        </ReactMarkdown>
                    </article>
                </div>
            );
        }

        return (
            <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                <pre className="text-sm text-text-primary whitespace-pre-wrap font-sans leading-relaxed">
                    {note.content}
                </pre>
            </div>
        );
    };

    // Embedded View Renders
    if (isEmbedded && selectedNote) {
        return (
            <div className="h-full overflow-y-auto bg-surface-primary p-4">
                <div className="flex items-center justify-between mb-4">
                    <button 
                        onClick={() => setSelectedNote(null)}
                        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        返回列表
                    </button>
                    <div className="flex items-center gap-2">
                        {SHOW_WECHAT_KNOWLEDGE_ACTIONS && isExpandableXiaohongshuNote(selectedNote) && onNavigateToRedClaw && (
                            <button
                                onClick={() => handleExpandToWechat(selectedNote)}
                                className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-white bg-gradient-to-r from-emerald-500 to-teal-500 rounded hover:from-emerald-600 hover:to-teal-600 transition-colors"
                            >
                                <Sparkles className="w-3 h-3" />
                                扩写公众号
                            </button>
                        )}
                        <button
                            onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                            className="inline-flex h-9 items-center gap-2 rounded-xl bg-amber-500 px-3.5 text-[12px] font-bold text-white shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-600 active:scale-95"
                            title="保存封面为模板"
                        >
                            <BookmarkPlus className="w-3.5 h-3.5" />
                            存为封面模板
                        </button>
                        {selectedNote.video && !selectedNote.transcript && (
                            <button
                                onClick={() => handleTranscribeNote(selectedNote.id)}
                                disabled={isTranscribing || selectedNote.transcriptionStatus === 'processing'}
                                className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text-primary bg-surface-secondary border border-border rounded hover:bg-surface-hover disabled:opacity-50 transition-colors"
                                title="提取文字"
                            >
                                {isTranscribing || selectedNote.transcriptionStatus === 'processing' ? (
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                    <FileText className="w-3 h-3" />
                                )}
                                {selectedNote.transcriptionStatus === 'processing' || isTranscribing ? '转录中...' : '提取文字'}
                            </button>
                        )}
                    </div>
                </div>

                <h1 className="text-xl font-bold text-text-primary mb-2">{selectedNote.title}</h1>
                
                {selectedNote.video && (
                    <div className="relative mx-auto w-full mb-4">
                        <div className="flex justify-center">
                        <div className="relative inline-flex max-w-full overflow-hidden rounded-lg border border-border bg-black">
                            {isSelectedNoteVideoPlaying || !getNoteCoverImage(selectedNote) ? (
                                <video
                                    ref={selectedNoteVideoRef}
                                    src={resolveAssetUrl(selectedNote.video)}
                                    className="block max-h-[300px] w-auto max-w-full object-contain"
                                    controls
                                    autoPlay
                                    playsInline
                                    preload="metadata"
                                />
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setIsSelectedNoteVideoPlaying(true)}
                                    className="group relative block h-full w-full"
                                >
                                    <img
                                        src={resolveAssetUrl(getNoteCoverImage(selectedNote))}
                                        alt={selectedNote.title}
                                        className="block max-h-[300px] w-auto max-w-full object-contain"
                                    />
                                    <div className="absolute inset-0 bg-black/20 transition-all group-hover:bg-black/30" />
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/30 bg-white/20 text-white shadow-xl backdrop-blur-md transition-transform group-hover:scale-105">
                                            <Play className="ml-1 h-7 w-7 fill-current" />
                                        </div>
                                    </div>
                                </button>
                            )}
                        </div>
                        </div>
                    </div>
                )}

                {!selectedNote.video && selectedNote.images && selectedNote.images.length > 0 && (() => {
                   const orderedImages = orderImages(selectedNote.images);
                   const currentImage = orderedImages[selectedImageIndex];
                   return (
                       <div className="relative aspect-square bg-black/5 rounded-lg overflow-hidden mb-4">
                           <img src={resolveAssetUrl(currentImage)} className="w-full h-full object-contain" />
                           {orderedImages.length > 1 && (
                               <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-full">
                                   {selectedImageIndex + 1}/{orderedImages.length}
                               </div>
                           )}
                           {orderedImages.length > 1 && (
                               <>
                                   <button 
                                       className="absolute left-2 top-1/2 -translate-y-1/2 p-1 bg-black/30 rounded-full text-white hover:bg-black/50"
                                       onClick={(e) => {
                                           e.stopPropagation();
                                           setSelectedImageIndex(prev => prev === 0 ? orderedImages.length - 1 : prev - 1);
                                       }}
                                   >
                                       <ChevronLeft className="w-4 h-4" />
                                   </button>
                                   <button 
                                       className="absolute right-2 top-1/2 -translate-y-1/2 p-1 bg-black/30 rounded-full text-white hover:bg-black/50"
                                       onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedImageIndex(prev => prev === orderedImages.length - 1 ? 0 : prev + 1);
                                       }}
                                   >
                                       <ChevronRight className="w-4 h-4" />
                                   </button>
                               </>
                           )}
                       </div>
                   );
                })()}

                <div className="whitespace-pre-wrap text-sm text-text-secondary font-sans leading-relaxed mb-4">
                    {selectedNote.content}
                </div>

                {selectedNote.video && selectedNote.transcript && (
                    <div className="bg-surface-secondary/50 rounded-lg border border-border overflow-hidden">
                        <button
                            onClick={() => setShowTranscript(!showTranscript)}
                            className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-text-primary hover:bg-surface-secondary/80 transition-colors"
                        >
                            <span className="flex items-center gap-2">
                                <FileText className="w-3.5 h-3.5" />
                                视频转录
                            </span>
                            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showTranscript ? 'rotate-90' : ''}`} />
                        </button>
                        {showTranscript && (
                            <div className="px-3 pb-3">
                                <pre className="text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-auto">
                                    {selectedNote.transcript}
                                </pre>
                            </div>
                        )}
                    </div>
                )}

                {/* Chat Modal for Embedded View */}
                <KnowledgeChatModal
                    isOpen={chatModalState.isOpen}
                    onClose={() => setChatModalState(prev => ({ ...prev, isOpen: false }))}
                    contextId={chatModalState.contextId}
                    contextType={chatModalState.contextType}
                    contextTitle={chatModalState.contextTitle}
                    contextContent={chatModalState.contextContent}
                />
            </div>
        );
    }
    if (isEmbedded && selectedVideo) {
        return (
            <div className="h-full flex flex-col bg-surface">
                <div className="flex items-center justify-between p-2 border-b border-border">
                    <button
                        onClick={() => setSelectedVideo(null)}
                        className="flex items-center gap-1 text-text-secondary hover:text-text-primary transition-colors text-sm"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        返回列表
                    </button>
                    {onNavigateToChat && selectedVideo.hasSubtitle && selectedVideo.subtitleContent && (
                        <button
                            onClick={() => {
                                const videoMeta = `<!--VIDEO_CARD:${JSON.stringify({
                                    title: selectedVideo.title,
                                    thumbnailUrl: selectedVideo.thumbnailUrl,
                                    videoId: selectedVideo.videoId
                                })}-->`;
                                onNavigateToChat({
                                    content: `${videoMeta}\n请总结这个视频的内容。`
                                });
                            }}
                            className="text-xs px-2 py-1 bg-surface-secondary border border-border rounded hover:bg-surface-hover"
                        >
                            AI 总结
                        </button>
                    )}
                </div>

                <div className="aspect-video bg-black rounded-lg overflow-hidden mb-4 relative group">
                    {selectedVideo.thumbnailUrl ? (
                        <img src={resolveAssetUrl(selectedVideo.thumbnailUrl)} className="w-full h-full object-cover opacity-80" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-text-tertiary bg-surface-secondary">
                            <Play className="w-12 h-12" />
                        </div>
                    )}
                    <button 
                        onClick={() => openYouTube(selectedVideo.videoUrl)}
                        className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/30 transition-colors"
                    >
                        <div className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                            <Play className="w-6 h-6 text-white ml-1" fill="white" />
                        </div>
                    </button>
                </div>

                <h1 className="text-lg font-bold text-text-primary mb-2 leading-snug">{selectedVideo.title}</h1>
                
                {selectedVideo.description && (
                    <div className="bg-surface-secondary/50 rounded p-3 mb-4">
                        <div className="text-xs text-text-tertiary mb-1">视频简介</div>
                        <div className="text-xs text-text-secondary whitespace-pre-wrap line-clamp-3 hover:line-clamp-none cursor-pointer transition-all">
                            {selectedVideo.description}
                        </div>
                    </div>
                )}

                {selectedVideo.hasSubtitle && selectedVideo.subtitleContent ? (
                    <div className="space-y-2">
                         <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold">字幕内容</h3>
                        </div>
                        <div className="text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed bg-surface-secondary/30 p-2 rounded max-h-[400px] overflow-y-auto">
                            {selectedVideo.subtitleContent}
                        </div>
                    </div>
                ) : (
                    <div className="text-xs text-text-tertiary text-center py-4 bg-surface-secondary/20 rounded">
                        {selectedVideo.status === 'processing' ? '字幕生成中...' : '暂无字幕内容'}
                    </div>
                )}

                {/* Chat Modal for Embedded View */}
                <KnowledgeChatModal
                    isOpen={chatModalState.isOpen}
                    onClose={() => setChatModalState(prev => ({ ...prev, isOpen: false }))}
                    contextId={chatModalState.contextId}
                    contextType={chatModalState.contextType}
                    contextTitle={chatModalState.contextTitle}
                    contextContent={chatModalState.contextContent}
                />
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col bg-surface-primary">
            <div
                className={clsx(
                    'z-30 border-b border-border/50 bg-surface-primary/90 backdrop-blur-[32px]',
                    isEmbedded ? 'px-3 py-2' : 'px-6 py-4'
                )}
            >
                <div className={clsx('flex flex-col', isEmbedded ? 'gap-2' : 'gap-3.5')}>
                    <div className="flex items-center gap-3 py-1">
                        <div className="flex-1 flex items-center gap-2 overflow-x-auto no-scrollbar">
                            {typeFilters.map((item) => (
                                <button
                                    key={item.key}
                                    onClick={() => setSelectedTypeFilter(item.key)}
                                    className={clsx(
                                        'shrink-0 px-3.5 py-1.5 text-[12px] font-bold rounded-xl border transition-all flex items-center gap-2 active:scale-95',
                                        selectedTypeFilter === item.key
                                            ? 'border-transparent bg-accent-primary text-white shadow-lg shadow-accent-primary/20'
                                            : 'border-border/70 bg-surface-secondary/70 text-text-secondary hover:bg-surface-tertiary/70 hover:text-text-primary'
                                    )}
                                >
                                    <span>{item.label}</span>
                                    <span className={clsx(
                                        'text-[10px] px-1.5 py-0.5 rounded-lg font-bold',
                                        selectedTypeFilter === item.key
                                            ? 'bg-white/20 text-white'
                                            : 'bg-surface-primary/70 text-text-tertiary'
                                    )}>
                                        {item.count}
                                    </span>
                                </button>
                            ))}
                        </div>

                        {isSearchOpen ? (
                            <div className="flex items-center gap-2 shrink-0 animate-in fade-in slide-in-from-right-4 duration-300">
                                <div className="relative w-[240px] sm:w-[300px]">
                                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="搜索知识库..."
                                        autoFocus
                                        className="w-full rounded-xl border border-border/70 bg-surface-secondary/70 pl-9 pr-8 py-2 text-[13px] font-bold text-text-primary placeholder:text-text-tertiary/70 focus:bg-surface-elevated focus:outline-none focus:ring-2 focus:ring-accent-primary/10 transition-all"
                                    />
                                    {searchQuery && (
                                        <button
                                            onClick={() => setSearchQuery('')}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary transition-colors"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                                <button
                                    onClick={() => {
                                        setIsSearchOpen(false);
                                        setSearchQuery('');
                                    }}
                                    className="rounded-xl px-3.5 py-2 text-[12px] font-bold text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary transition-all"
                                >
                                    取消
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                    onClick={() => setIsSearchOpen(true)}
                                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-secondary/80 hover:text-text-primary transition-all active:scale-90"
                                    title="搜索 (Cmd+F)"
                                >
                                    <Search className="w-4 h-4" />
                                </button>
                                {!isEmbedded && (
                                    <>
                                        <div className="mx-1 h-4 w-[1px] bg-border/80" />
                                        
                                        {(selectedTypeFilter === 'all' || selectedTypeFilter === 'youtube') && youtubeSummaryPendingCount > 0 && (
                                            <button
                                                onClick={() => void handleRefreshYoutubeSummaries()}
                                                disabled={isRefreshingYoutubeSummaries}
                                                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-[12px] font-bold rounded-xl bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-all disabled:opacity-40 active:scale-95"
                                            >
                                                {isRefreshingYoutubeSummaries ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                                补全摘要
                                                <span className="text-[10px] px-1.5 py-0.5 rounded-lg bg-accent-primary/10 font-bold">
                                                    {youtubeSummaryPendingCount}
                                                </span>
                                            </button>
                                        )}

                                        <button
                                            onClick={() => void window.ipcRenderer.knowledge.rebuildCatalog().then(() => refreshIndexStatus())}
                                            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/70 bg-surface-secondary/75 px-3.5 text-[12px] font-bold text-text-primary hover:bg-surface-tertiary/80 transition-all active:scale-95"
                                            title="重建知识索引"
                                        >
                                            <RefreshCw className="w-3.5 h-3.5" />
                                            重建索引
                                        </button>
                                        
                                        <div className="flex items-center gap-1 rounded-xl border border-border/80 bg-surface-elevated p-1 shadow-lg shadow-black/10">
                                            <button
                                                onClick={handleAddDocumentFiles}
                                                className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-text-primary hover:bg-surface-secondary/80 transition-all active:scale-95"
                                            >
                                                <Plus className="w-3.5 h-3.5" />
                                                文件
                                            </button>
                                            <button
                                                onClick={handleAddDocumentFolder}
                                                className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-text-primary hover:bg-surface-secondary/80 transition-all active:scale-95"
                                            >
                                                <FolderPlus className="w-3.5 h-3.5" />
                                                文件夹
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    {!isEmbedded && allTags.length > 0 && (
                        <div ref={allTagsDrawerRef} className="relative py-0.5">
                            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                                <button
                                    onClick={handleAllTagsClick}
                                    className={clsx(
                                        'shrink-0 px-3 py-1 text-[11px] font-bold rounded-lg transition-all border uppercase tracking-wider inline-flex items-center gap-1.5',
                                        !selectedTag
                                            ? 'bg-black/[0.04] text-text-primary border-transparent shadow-sm'
                                            : 'bg-transparent text-text-tertiary border-transparent hover:bg-black/[0.03] hover:text-text-secondary'
                                    )}
                                >
                                    <span>All Tags</span>
                                    <span
                                        className={clsx(
                                            'inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[9px] font-bold',
                                            !selectedTag
                                                ? 'bg-black/5 text-text-tertiary/80'
                                                : 'bg-black/[0.04] text-text-tertiary/70'
                                        )}
                                    >
                                        {allTags.length}
                                    </span>
                                    {hasHiddenTags && (
                                        <ChevronRight
                                            className={clsx(
                                                'w-3 h-3 opacity-60 transition-transform duration-200',
                                                !selectedTag && isAllTagsDrawerOpen && 'rotate-90'
                                            )}
                                        />
                                    )}
                                </button>
                                {inlineTagItems.map(({ tag, count }) => (
                                    <button
                                        key={tag}
                                        onClick={() => handleTagSelection(tag)}
                                        className={clsx(
                                            'shrink-0 px-3 py-1 text-[11px] rounded-lg transition-all flex items-center gap-1.5 border font-bold',
                                            selectedTag === tag
                                                ? 'bg-accent-primary text-white border-transparent shadow-md shadow-accent-primary/20'
                                                : 'bg-black/[0.02] text-text-tertiary border-transparent hover:bg-black/[0.04] hover:text-text-primary'
                                        )}
                                    >
                                        <span className="opacity-40">#</span>
                                        {tag}
                                        <span
                                            className={clsx(
                                                'text-[9px] py-0.5 px-1.5 rounded-md font-bold',
                                                selectedTag === tag
                                                    ? 'bg-white/20 text-white'
                                                    : 'bg-black/5 text-text-tertiary/60'
                                            )}
                                        >
                                            {count}
                                        </span>
                                    </button>
                                ))}
                            </div>

                            {!selectedTag && isAllTagsDrawerOpen && hasHiddenTags && (
                                <div className="absolute left-0 right-0 top-full z-20 mt-3">
                                    <div className="rounded-2xl border border-black/[0.05] bg-white/95 shadow-xl shadow-black/[0.08] backdrop-blur-xl">
                                    <div className="flex items-center justify-between gap-3 border-b border-black/[0.04] px-4 py-3">
                                        <div className="min-w-0">
                                            <div className="text-[12px] font-extrabold text-text-primary tracking-tight">全部标签</div>
                                            <div className="mt-1 text-[10px] font-medium text-text-tertiary/70">
                                                共 {allTags.length} 个标签，点击即可筛选内容
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => setIsAllTagsDrawerOpen(false)}
                                            className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-text-tertiary hover:bg-black/[0.04] hover:text-text-primary transition-all active:scale-90"
                                            title="收起标签抽屉"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                    <div className="max-h-[240px] overflow-y-auto px-4 py-4">
                                        <div className="flex flex-wrap gap-2">
                                            {allTags.map(({ tag, count }) => (
                                                <button
                                                    key={`drawer-${tag}`}
                                                    onClick={() => handleTagSelection(tag)}
                                                    className={clsx(
                                                        'px-3 py-1.5 text-[11px] rounded-xl transition-all flex items-center gap-1.5 border font-bold',
                                                        selectedTag === tag
                                                            ? 'bg-accent-primary text-white border-transparent shadow-md shadow-accent-primary/20'
                                                            : 'bg-black/[0.02] text-text-tertiary border-transparent hover:bg-black/[0.04] hover:text-text-primary'
                                                    )}
                                                >
                                                    <span className="opacity-40">#</span>
                                                    {tag}
                                                    <span
                                                        className={clsx(
                                                            'text-[9px] py-0.5 px-1.5 rounded-md font-bold',
                                                            selectedTag === tag
                                                                ? 'bg-white/20 text-white'
                                                                : 'bg-black/5 text-text-tertiary/60'
                                                        )}
                                                    >
                                                        {count}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                                </div>
                            )}
                        </div>
                    )}

                    {!isEmbedded && (
                        <div className="flex items-center gap-3 text-[11px] font-medium text-text-tertiary/70">
                            <span>已索引 {indexStatus.indexedCount}</span>
                            {indexStatus.isBuilding && (
                                <span className="inline-flex items-center gap-1.5 text-amber-600">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    索引构建中
                                </span>
                            )}
                            {indexStatus.pendingCount > 0 && <span>待处理 {indexStatus.pendingCount}</span>}
                            {indexStatus.failedCount > 0 && <span className="text-red-500">失败 {indexStatus.failedCount}</span>}
                            {indexStatus.lastIndexedAt && <span>最近更新 {new Date(indexStatus.lastIndexedAt).toLocaleString()}</span>}
                            {indexStatus.lastError && <span className="truncate text-red-500 max-w-[360px]">{indexStatus.lastError}</span>}
                        </div>
                    )}
                </div>
            </div>

            <div
                ref={embeddedViewportRef}
                className={clsx('flex-1 overflow-auto', isEmbedded ? 'p-3' : 'p-6')}
            >
                {isLoading && notes.length === 0 && youtubeVideos.length === 0 && documentSources.length === 0 ? (
                    <div className="text-center text-text-tertiary text-xs py-16">加载中...</div>
                ) : (
                    <div className="space-y-4">
                        {filteredKnowledgeItems.length === 0 ? (
                            <div className="text-center text-text-tertiary text-xs py-16">
                                暂无内容，可使用插件保存小红书、YouTube、公众号文章和网页链接，也可添加文档源
                            </div>
                        ) : (
                            <div className={knowledgeColumnsClass} style={{ columnGap: '0.75rem' }}>
                                {filteredKnowledgeItems.map((item) => {
                                    if (item.kind === 'docs' && item.doc) {
                                        const source = item.doc;
                                        return (
                                            <div
                                                key={item.id}
                                                className="mb-3 break-inside-avoid rounded-2xl border border-black/[0.04] bg-white shadow-sm p-4 transition-all"
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <div className="text-[14px] font-extrabold text-text-primary truncate tracking-tight">{source.name}</div>
                                                            <span className={clsx('text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-lg', getKnowledgeKindBadgeClass('docs'))}>
                                                                {getKnowledgeKindLabel('docs')}
                                                            </span>
                                                            {source.locked && (
                                                                <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-lg bg-amber-50 text-amber-600 border border-amber-100">
                                                                    LOCKED
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="mt-1.5 text-[10px] font-bold text-text-tertiary/60 break-all uppercase tracking-tighter">{source.rootPath}</div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleDeleteDocumentSource(source)}
                                                        className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-50 transition-all active:scale-90"
                                                        title="移除此文档源"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                                <div className="mt-3.5 flex flex-wrap gap-1.5 text-[10px] font-bold">
                                                    <span className="inline-flex items-center gap-1 rounded-lg bg-black/[0.03] px-2.5 py-1.5 text-text-secondary border border-black/[0.02]">
                                                        <FileText className="w-3 h-3 opacity-60" />
                                                        {source.fileCount} DOCUMENTS
                                                    </span>
                                                </div>
                                                {source.sampleFiles.length > 0 && (
                                                    <div className="mt-3.5 flex flex-wrap gap-1.5">
                                                        {source.sampleFiles.slice(0, 6).map((file) => (
                                                            <span
                                                                key={`${source.id}-${file}`}
                                                                className="inline-flex max-w-full items-start gap-1 text-[10px] font-medium px-2.5 py-1 rounded-lg bg-black/[0.02] text-text-tertiary border border-black/[0.01]"
                                                            >
                                                                <FileText className="w-3 h-3 shrink-0 mt-0.5 opacity-40" />
                                                                <span className="min-w-0 break-all leading-relaxed line-clamp-1">{file}</span>
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    }

                                    if (item.kind === 'youtube' && item.video) {
                                        const video = item.video;
                                        const isProcessing = video.status === 'processing';
                                        const isFailed = video.status === 'failed';
                                        return (
                                            <button
                                                key={item.id}
                                                onClick={() => void openVideoDetail(video)}
                                                className={clsx(
                                                    'group mb-4 break-inside-avoid w-full text-left bg-white border rounded-[20px] overflow-hidden shadow-sm transition-all duration-300',
                                                    isProcessing ? 'border-yellow-400 animate-pulse' : isFailed ? 'border-red-400' : 'border-black/[0.04]'
                                                )}
                                            >
                                                <div className="relative aspect-[16/10] bg-black/[0.02] overflow-hidden">
                                                    <span className={clsx('absolute top-3 right-3 z-10 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm backdrop-blur-md', getKnowledgeKindBadgeClass('youtube'))}>
                                                        {getKnowledgeKindLabel('youtube')}
                                                    </span>
                                                    {video.thumbnailUrl && !isProcessing ? (
                                                        <img
                                                            src={resolveAssetUrl(video.thumbnailUrl)}
                                                            alt={video.title}
                                                            className="w-full h-full object-cover transition-transform duration-500"

                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center text-text-tertiary">
                                                            {isProcessing ? (
                                                                <div className="flex flex-col items-center gap-2">
                                                                    <Loader2 className="w-8 h-8 animate-spin text-yellow-500" />
                                                                </div>
                                                            ) : (
                                                                <Play className="w-8 h-8 opacity-20" />
                                                            )}
                                                        </div>
                                                    )}
                                                    
                                                    {!isProcessing && !isFailed && (
                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white shadow-xl">
                                                                <Play className="w-5 h-5 fill-current ml-0.5" />
                                                            </div>
                                                        </div>
                                                    )}
                                                    
                                                    {video.summary && !isProcessing && (
                                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                                                            <div className="text-[11px] leading-relaxed text-white/90 line-clamp-3 font-medium">
                                                                {video.summary}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="p-4">
                                                    <div className="text-[14px] font-extrabold text-text-primary line-clamp-2 leading-tight tracking-tight group-hover:text-accent-primary transition-colors">{video.title}</div>
                                                    <div className="mt-2 text-[11px] font-bold text-text-tertiary/70 line-clamp-2 leading-relaxed">
                                                        {isProcessing ? '正在智能解析内容细节...' : (video.summary || video.description || '暂无描述信息')}
                                                    </div>
                                                    <div className="mt-3.5 flex items-center justify-between gap-2 text-[10px] font-bold text-text-tertiary/50 uppercase tracking-tighter border-t border-black/[0.02] pt-3">
                                                        <span>{new Date(video.createdAt).toLocaleDateString()}</span>
                                                        <div className="flex items-center gap-2">
                                                            {video.hasSubtitle && !isProcessing && (
                                                                <span className="flex items-center gap-1 text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-md border border-emerald-100">
                                                                    SUBTITLES
                                                                </span>
                                                            )}
                                                            {isFailed && <span className="text-red-500">FAILED</span>}
                                                        </div>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    }

                                    if (!item.note) {
                                        return null;
                                    }

                                    const note = item.note;
                                    const orderedImages = orderImages(note.images || []);
                                    const coverImage = note.cover || orderedImages[0];
                                    const isTextArticleCard = (item.kind === 'link-article' || item.kind === 'wechat-article') && !coverImage && !note.video;
                                    const notePreviewText = note.excerpt || note.content || note.sourceUrl || '暂无摘要';
                                    const isNoteTranscribing = Boolean(note.video && !note.transcript && note.transcriptionStatus === 'processing');
                                    const canExpandToWechat = SHOW_WECHAT_KNOWLEDGE_ACTIONS && isExpandableXiaohongshuNote(note) && Boolean(onNavigateToRedClaw);

                                    return (
                                        <button
                                            key={item.id}
                                            onClick={() => void openNoteDetail(note)}
                                            className={clsx(
                                                'mb-4 break-inside-avoid w-full text-left bg-white border border-black/[0.04] rounded-[20px] shadow-sm transition-all duration-300',
                                                isTextArticleCard ? 'overflow-visible p-5' : 'overflow-hidden'
                                            )}
                                        >
                                            {isTextArticleCard ? (
                                                <div className={clsx('flex gap-4', embeddedUsesCompactCard ? 'flex-col' : 'items-start')}>
                                                    <div className={clsx(
                                                        'flex shrink-0 items-center justify-center rounded-[14px] bg-sky-500/10 text-sky-600 border border-sky-100',
                                                        embeddedUsesCompactCard ? 'h-9 w-9' : 'h-11 w-11',
                                                    )}>
                                                        <FileText className="w-5 h-5" />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className={clsx(
                                                                'font-extrabold text-text-primary tracking-tight group-hover:text-accent-primary transition-colors',
                                                                embeddedUsesCompactCard ? 'text-[14px] line-clamp-3' : 'text-[15px] line-clamp-2',
                                                            )}>
                                                                {note.title}
                                                            </div>
                                                            <span className={clsx('shrink-0 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm border border-black/[0.02]', getKnowledgeKindBadgeClass(item.kind))}>
                                                                {getKnowledgeKindLabel(item.kind)}
                                                            </span>
                                                        </div>
                                                        <div className={clsx(
                                                            'mt-2.5 text-text-tertiary leading-relaxed font-medium',
                                                            embeddedUsesCompactCard ? 'text-[12px] line-clamp-6' : 'text-[12px] line-clamp-5',
                                                        )}>
                                                            {notePreviewText}
                                                        </div>
                                                        <div className="mt-4 flex items-center gap-2.5 text-[10px] font-bold text-text-tertiary/60 flex-wrap uppercase tracking-tighter">
                                                            <span>{new Date(note.createdAt).toLocaleDateString()}</span>
                                                            {note.sourceUrl && (
                                                                <span className="flex items-center gap-1 max-w-full">
                                                                    <ExternalLink className="w-3 h-3 opacity-40" />
                                                                    <span className="truncate max-w-[140px]">{note.author || 'SOURCE'}</span>
                                                                </span>
                                                            )}
                                                            {note.tags?.slice(0, 2).map((tag) => (
                                                                <span key={tag} className={clsx('px-1.5 py-0.5 rounded-md border border-black/[0.02] bg-black/[0.01]', getKnowledgeTagClass(tag))}>
                                                                    #{tag}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : coverImage ? (
                                                <div
                                                    className={clsx(
                                                        'relative w-full bg-black/[0.02] overflow-hidden',
                                                        (item.kind === 'link-article' || item.kind === 'wechat-article') ? 'aspect-[4/3]' : resolveAspectClass(note.id)
                                                    )}
                                                >
                                                    <span className={clsx('absolute top-3 right-3 z-10 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm backdrop-blur-md border border-white/20', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    <img
                                                        src={resolveAssetUrl(coverImage)}
                                                        alt={note.title}
                                                        className="w-full h-full object-cover transition-transform duration-500"

                                                        onLoad={(event) => handleImageLoad(note.id, event)}
                                                    />
                                                    {isNoteTranscribing && (
                                                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/40 text-white backdrop-blur-sm">
                                                            <Loader2 className="w-6 h-6 animate-spin text-white" />
                                                            <span className="text-[11px] font-bold tracking-widest uppercase">Transcribing</span>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : note.video ? (
                                                <div className="relative w-full aspect-[3/4] bg-black/[0.02] overflow-hidden flex items-center justify-center">
                                                    <span className={clsx('absolute top-3 right-3 z-10 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm backdrop-blur-md border border-white/20', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    <video
                                                        src={resolveAssetUrl(note.video)}
                                                        className="w-full h-full object-contain bg-black"
                                                        muted
                                                        playsInline
                                                        preload="metadata"
                                                    />
                                                    <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white shadow-xl">
                                                            <Play className="w-5 h-5 fill-current ml-0.5" />
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div
                                                    className={clsx(
                                                        'relative bg-black/[0.02] flex items-center justify-center text-text-tertiary',
                                                        (item.kind === 'link-article' || item.kind === 'wechat-article') ? 'aspect-[4/2.6]' : 'aspect-[3/4]'
                                                    )}
                                                >
                                                    <span className={clsx('absolute top-3 right-3 z-10 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm backdrop-blur-md border border-white/20', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    {(item.kind === 'link-article' || item.kind === 'wechat-article') ? <FileText className="w-8 h-8 opacity-20" /> : <Image className="w-8 h-8 opacity-20" />}
                                                </div>
                                            )}
                                            {!isTextArticleCard && (
                                                <div className="p-4">
                                                    <div className="text-[14px] font-extrabold text-text-primary line-clamp-2 leading-tight tracking-tight group-hover:text-accent-primary transition-colors">{note.title}</div>
                                                    <div
                                                        className={clsx(
                                                            'text-[11px] font-medium text-text-tertiary/70 leading-relaxed',
                                                            (item.kind === 'link-article' || item.kind === 'wechat-article') ? 'mt-1.5 line-clamp-4' : 'mt-1.5 line-clamp-2'
                                                        )}
                                                    >
                                                        {notePreviewText}
                                                    </div>
                                                    {!isEmbedded && note.tags && note.tags.length > 0 && (
                                                        <div className="mt-2.5 flex flex-wrap gap-1">
                                                            {note.tags.slice(0, 3).map((tag) => (
                                                                <span key={tag} className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border border-black/[0.02] bg-black/[0.01]', getKnowledgeTagClass(tag))}>
                                                                    #{tag}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <div className="mt-3.5 flex items-center gap-3 text-[9px] font-bold text-text-tertiary/40 flex-wrap uppercase tracking-tighter border-t border-black/[0.02] pt-3">
                                                        <span>{new Date(note.createdAt).toLocaleDateString()}</span>
                                                        
                                                        {item.kind !== 'link-article' && (
                                                            <div className="flex items-center gap-2">
                                                                <span className="flex items-center gap-1">
                                                                    <Heart className="w-3 h-3 opacity-60" />
                                                                    {note.stats?.likes || 0}
                                                                </span>
                                                                {typeof note.stats?.collects === 'number' && (
                                                                    <span className="flex items-center gap-1">
                                                                        <Star className="w-3 h-3 opacity-60" />
                                                                        {note.stats.collects}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        )}
                                                        
                                                        {note.images?.length > 0 && (
                                                            <span className="flex items-center gap-1">
                                                                <Image className="w-3 h-3 opacity-60" />
                                                                {note.images.length}
                                                            </span>
                                                        )}
                                                        
                                                        {(item.kind === 'link-article' || item.kind === 'wechat-article') && note.sourceUrl && (
                                                            <span className="flex items-center gap-1 max-w-full">
                                                                <ExternalLink className="w-3 h-3 opacity-40" />
                                                                <span className="truncate max-w-[120px]">{note.author || 'SOURCE'}</span>
                                                            </span>
                                                        )}
                                                    </div>
                                                    {canExpandToWechat && (
                                                        <div className="mt-3">
                                                            <span
                                                                role="button"
                                                                tabIndex={0}
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    handleExpandToWechat(note);
                                                                }}
                                                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-extrabold text-emerald-700 transition-all hover:bg-emerald-100 active:scale-95 shadow-sm"
                                                            >
                                                                <Sparkles className="w-3.5 h-3.5" />
                                                                扩写为公众号
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {nextCursor && filteredKnowledgeItems.length > 0 && (
                            <div className="flex justify-center pt-2">
                                <button
                                    onClick={() => void loadMoreKnowledge()}
                                    disabled={isLoadingMore}
                                    className="inline-flex items-center gap-2 rounded-xl border border-black/[0.06] bg-white px-4 py-2 text-[12px] font-bold text-text-primary shadow-sm hover:bg-black/[0.02] disabled:opacity-50"
                                >
                                    {isLoadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                    {isLoadingMore ? '加载中...' : '加载更多'}
                                </button>
                            </div>
                        )}

                    </div>
                )}
            </div>

            {/* Xiaohongshu Note Detail Modal */}
            {selectedNote && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[6px] animate-in fade-in duration-300"
                    onClick={() => setSelectedNote(null)}
                >
                    <div
                        className="w-full max-w-[860px] mx-4 bg-white rounded-[28px] border border-white/20 shadow-[0_48px_120px_-20px_rgba(0,0,0,0.3)] overflow-hidden max-h-[90vh] flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        {(() => {
                            const showRichArticle = Boolean(selectedNote.htmlFileUrl && selectedNote.captureKind === 'wechat-article');
                            return (
                        <>
                        <div className="px-8 py-6 border-b border-black/[0.04] flex items-start justify-between bg-white relative z-10">
                            <div className="min-w-0">
                                <h1 className="text-xl font-extrabold text-text-primary tracking-tight line-clamp-2">{selectedNote.title}</h1>
                                <div className="flex flex-wrap items-center gap-4 mt-2 text-[11px] font-bold text-text-tertiary uppercase tracking-wider">
                                    <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 opacity-60" /> {selectedNote.author}</span>
                                    {selectedNote.siteName && (
                                        <span className="flex items-center gap-1.5"><ExternalLink className="w-3.5 h-3.5 opacity-60" /> {selectedNote.siteName}</span>
                                    )}
                                    <span className="flex items-center gap-1.5 text-rose-500 bg-rose-50 px-1.5 py-0.5 rounded-md border border-rose-100">
                                        <Heart className="w-3.5 h-3.5 fill-current" /> {selectedNote.stats?.likes || 0}
                                    </span>
                                    {typeof selectedNote.stats?.collects === 'number' && (
                                        <span className="flex items-center gap-1.5 text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-md border border-amber-100">
                                            <Star className="w-3.5 h-3.5 fill-current" /> {selectedNote.stats.collects}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 ml-4">
                                <button
                                    onClick={() => openChat(
                                        selectedNote.id,
                                        getNoteContextType(selectedNote),
                                        selectedNote.title,
                                        selectedNote.content + (selectedNote.transcript ? `\n\nVideo Transcript:\n${selectedNote.transcript}` : '')
                                    )}
                                    className="inline-flex h-10 px-4 items-center gap-2 rounded-xl bg-accent-primary text-white text-[13px] font-extrabold shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95"
                                >
                                    <MessageCircle className="w-4 h-4" />
                                    对话
                                </button>
                                <button
                                    onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                                    className="inline-flex h-10 px-4 items-center gap-2 rounded-xl bg-amber-500 text-white text-[13px] font-extrabold shadow-lg shadow-amber-500/20 hover:bg-amber-600 transition-all active:scale-95"
                                >
                                    <BookmarkPlus className="w-4 h-4" />
                                    存为封面模板
                                </button>
                                {SHOW_WECHAT_KNOWLEDGE_ACTIONS && isExpandableXiaohongshuNote(selectedNote) && onNavigateToRedClaw && (
                                    <button
                                        onClick={() => handleExpandToWechat(selectedNote)}
                                        className="inline-flex h-10 px-4 items-center gap-2 rounded-xl bg-emerald-500 text-white text-[13px] font-extrabold shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-all active:scale-95"
                                    >
                                        <Sparkles className="w-4 h-4" />
                                        扩写
                                    </button>
                                )}
                                <button
                                    onClick={() => setSelectedNote(null)}
                                    className="flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.04] text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-90"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto px-8 py-8 space-y-8 custom-scrollbar bg-white">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={() => void handleShowInFolder(selectedNote.folderPath)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/[0.03] text-text-secondary text-[11px] font-bold hover:bg-black/[0.06] transition-all"
                                >
                                    <FolderOpen className="w-3.5 h-3.5" /> 在目录中查看
                                </button>
                                {selectedNote.video && !selectedNote.transcript && (
                                    <button
                                        onClick={() => handleTranscribeNote(selectedNote.id)}
                                        disabled={isTranscribing || selectedNote.transcriptionStatus === 'processing'}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-[11px] font-bold hover:bg-blue-600 transition-all disabled:opacity-40"
                                    >
                                        {isTranscribing || selectedNote.transcriptionStatus === 'processing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                        提取文字
                                    </button>
                                )}
                            </div>

                            {selectedNote.video && (
                                <div className="relative mx-auto w-full max-w-[640px]">
                                    <div className="flex justify-center">
                                    <div className="relative inline-flex max-w-full rounded-[24px] overflow-hidden border border-black/[0.04] bg-black shadow-2xl">
                                        {isSelectedNoteVideoPlaying || !getNoteCoverImage(selectedNote) ? (
                                            <video
                                                ref={selectedNoteVideoRef}
                                                src={resolveAssetUrl(selectedNote.video)}
                                                className="block max-h-[60vh] w-auto max-w-full object-contain"
                                                controls
                                                autoPlay
                                                playsInline
                                                preload="metadata"
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => setIsSelectedNoteVideoPlaying(true)}
                                                className="group relative block h-full w-full"
                                            >
                                                <img
                                                    src={resolveAssetUrl(getNoteCoverImage(selectedNote))}
                                                    alt={selectedNote.title}
                                                    className="block max-h-[60vh] w-auto max-w-full object-contain"
                                                />
                                                <div className="absolute inset-0 bg-black/20 transition-all group-hover:bg-black/35" />
                                                <div className="absolute inset-0 flex items-center justify-center">
                                                    <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/30 bg-white/20 text-white shadow-2xl backdrop-blur-md transition-transform duration-300 group-hover:scale-110">
                                                        <Play className="ml-1 h-8 w-8 fill-current" />
                                                    </div>
                                                </div>
                                            </button>
                                        )}
                                    </div>
                                    </div>
                                </div>
                            )}

                            {!showRichArticle && !selectedNote.video && selectedNote.images && selectedNote.images.length > 0 && (() => {
                                const orderedImages = orderImages(selectedNote.images);
                                return (
                                    <div className="relative group">
                                        <div className="aspect-[4/3] rounded-[24px] overflow-hidden border border-black/[0.04] bg-black/[0.02]">
                                            <img
                                                src={resolveAssetUrl(orderedImages[selectedImageIndex])}
                                                alt={`${selectedNote.title} - ${selectedImageIndex + 1}`}
                                                className="w-full h-full object-contain"
                                                onClick={() => setIsImagePreviewOpen(true)}
                                            />
                                        </div>
                                        {orderedImages.length > 1 && (
                                            <>
                                                <button
                                                    onClick={() => setSelectedImageIndex((prev) => (prev === 0 ? orderedImages.length - 1 : prev - 1))}
                                                    className="absolute left-4 top-1/2 -translate-y-1/2 h-11 w-11 rounded-full bg-white/20 backdrop-blur-xl border border-white/30 text-white flex items-center justify-center hover:bg-white/40 shadow-xl transition-all"
                                                >
                                                    <ChevronLeft className="w-5 h-5" />
                                                </button>
                                                <button
                                                    onClick={() => setSelectedImageIndex((prev) => (prev === orderedImages.length - 1 ? 0 : prev + 1))}
                                                    className="absolute right-4 top-1/2 -translate-y-1/2 h-11 w-11 rounded-full bg-white/20 backdrop-blur-xl border border-white/30 text-white flex items-center justify-center hover:bg-white/40 shadow-xl transition-all"
                                                >
                                                    <ChevronRight className="w-5 h-5" />
                                                </button>
                                                <div className="absolute bottom-4 right-4 text-[10px] font-bold text-white bg-black/40 backdrop-blur-md rounded-lg px-2.5 py-1.5 uppercase tracking-widest border border-white/10">
                                                    IMAGE {selectedImageIndex + 1} OF {orderedImages.length}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })()}

                            {showRichArticle ? (
                                <div className="rounded-[20px] border border-black/[0.04] overflow-hidden bg-white shadow-inner">
                                    <iframe
                                        src={resolveAssetUrl(selectedNote.htmlFileUrl)}
                                        title={selectedNote.title}
                                        sandbox="allow-popups allow-popups-to-escape-sandbox"
                                        className="block w-full h-[72vh] bg-white"
                                    />
                                </div>
                            ) : (
                                <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-headings:font-extrabold prose-headings:tracking-tight">
                                    {renderNoteBody(selectedNote)}
                                </div>
                            )}

                            {selectedNote.video && selectedNote.transcript && (
                                <div className="bg-black/[0.02] rounded-2xl border border-black/[0.03] overflow-hidden transition-all hover:bg-black/[0.03]">
                                    <button
                                        onClick={() => setShowTranscript(!showTranscript)}
                                        className="w-full px-6 py-4 flex items-center justify-between text-[14px] font-extrabold text-text-primary transition-colors"
                                    >
                                        <span className="flex items-center gap-2.5">
                                            <FileText className="w-4 h-4 text-accent-primary" />
                                            视频转录文本
                                        </span>
                                        <ChevronRight className={`w-4 h-4 transition-transform duration-300 ${showTranscript ? 'rotate-90 text-accent-primary' : 'text-text-tertiary'}`} />
                                    </button>
                                    {showTranscript && (
                                        <div className="px-6 pb-6 animate-in slide-in-from-top-2 duration-300">
                                            <div className="bg-white rounded-xl p-5 border border-black/[0.02] shadow-inner">
                                                <pre className="text-[13px] text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-[400px] overflow-auto custom-scrollbar">
                                                    {selectedNote.transcript}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="px-8 py-5 border-t border-black/[0.04] flex items-center justify-between bg-black/[0.01]" onClick={(event) => event.stopPropagation()}>
                            <div className="text-[10px] font-bold text-text-tertiary/60 uppercase tracking-widest">SAVED ON {selectedNote.createdAt}</div>
                            <button
                                onClick={() => handleDeleteNote(selectedNote.id)}
                                className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-bold text-rose-500 hover:bg-rose-50 rounded-xl transition-all active:scale-95"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                移除记录
                            </button>
                        </div>
                        </>
                            );
                        })()}
                    </div>
                </div>
            )}

            {/* YouTube Video Detail Modal */}
            {selectedVideo && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[6px] animate-in fade-in duration-300"
                    onClick={() => setSelectedVideo(null)}
                >
                    <div
                        className="w-full max-w-[920px] mx-4 bg-white rounded-[32px] border border-white/20 shadow-[0_48px_120px_-20px_rgba(0,0,0,0.3)] overflow-hidden max-h-[90vh] flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="px-8 py-7 border-b border-black/[0.04] flex items-start justify-between bg-white relative z-10">
                            <div className="min-w-0 flex-1">
                                <h1 className="text-xl font-extrabold text-text-primary tracking-tight line-clamp-2">{selectedVideo.title}</h1>
                                <div className="flex items-center gap-4 mt-2.5 text-[11px] font-bold text-text-tertiary uppercase tracking-wider">
                                    <span className="flex items-center gap-1.5 bg-black/[0.03] px-2 py-0.5 rounded-md">SAVED {new Date(selectedVideo.createdAt).toLocaleDateString()}</span>
                                    {selectedVideo.hasSubtitle && (
                                        <span className="flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">
                                            <FileText className="w-3.5 h-3.5" /> SUBTITLES INCLUDED
                                        </span>
                                    )}
                                </div>
                                {selectedVideo.summary && (
                                    <div className="mt-4 text-[13px] font-medium leading-relaxed text-text-secondary line-clamp-3 bg-black/[0.02] p-4 rounded-2xl border border-black/[0.01]">
                                        {selectedVideo.summary}
                                    </div>
                                )}
                                {selectedVideo.originalTitle && selectedVideo.originalTitle.trim() && selectedVideo.originalTitle !== selectedVideo.title && (
                                    <div className="mt-2 text-[11px] font-bold text-text-tertiary/60 uppercase tracking-tighter">
                                        Original Title: {selectedVideo.originalTitle}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2 ml-6">
                                <button
                                    onClick={() => openChat(
                                        selectedVideo.id,
                                        'youtube_video',
                                        selectedVideo.title,
                                        `Title: ${selectedVideo.title}\nDescription: ${selectedVideo.description || 'None'}\n\nSubtitle:\n${selectedVideo.subtitleContent || '(No subtitle)'}`
                                    )}
                                    className="inline-flex h-11 px-5 items-center gap-2 rounded-xl bg-accent-primary text-white text-[13px] font-extrabold shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95"
                                >
                                    <MessageCircle className="w-4.5 h-4.5" />
                                    AI 分析
                                </button>
                                <button
                                    onClick={() => setSelectedVideo(null)}
                                    className="flex h-11 w-11 items-center justify-center rounded-xl bg-black/[0.04] text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-90"
                                >
                                    <X className="w-5.5 h-5.5" />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto px-8 py-8 space-y-8 custom-scrollbar bg-white">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={() => void handleShowInFolder(selectedVideo.folderPath)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/[0.03] text-text-secondary text-[11px] font-bold hover:bg-black/[0.06] transition-all"
                                >
                                    <FolderOpen className="w-3.5 h-3.5" /> 在目录中查看
                                </button>
                                <button
                                    onClick={() => openYouTube(selectedVideo.videoUrl)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 text-rose-600 text-[11px] font-bold hover:bg-rose-100 border border-rose-100 transition-all"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" /> 在 YouTube 打开
                                </button>
                            </div>

                            <div className="relative mx-auto w-full max-w-[640px]">
                                <div className="relative rounded-[24px] overflow-hidden border border-black/[0.04] bg-black shadow-2xl aspect-video">
                                    {selectedVideo.thumbnailUrl ? (
                                        <img
                                            src={resolveAssetUrl(selectedVideo.thumbnailUrl)}
                                            alt={selectedVideo.title}
                                            className="w-full h-full object-cover opacity-80"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-text-tertiary">
                                            <Play className="w-12 h-12 opacity-20" />
                                        </div>
                                    )}
                                    <button
                                        onClick={() => openYouTube(selectedVideo.videoUrl)}
                                        className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/40 transition-all group"
                                    >
                                        <div className="w-20 h-20 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white shadow-2xl group-hover:scale-110 transition-transform duration-300">
                                            <Play className="w-8 h-8 fill-current ml-1" />
                                        </div>
                                    </button>
                                </div>
                            </div>

                            {selectedVideo.description && (
                                <div className="bg-black/[0.02] rounded-2xl border border-black/[0.01] p-6">
                                    <h3 className="text-[14px] font-extrabold text-text-primary mb-4 uppercase tracking-wider">视频描述</h3>
                                    <pre className="text-[13px] text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
                                        {selectedVideo.description}
                                    </pre>
                                </div>
                            )}

                            {selectedVideo.status === 'failed' && selectedVideo.subtitleError && (
                                <div className="bg-rose-50 border border-rose-100 rounded-2xl p-6 flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="text-[13px] font-bold text-rose-700">字幕处理失败</div>
                                        <pre className="mt-2 text-[12px] text-rose-600 whitespace-pre-wrap font-sans leading-relaxed">
                                            {selectedVideo.subtitleError}
                                        </pre>
                                    </div>
                                    <button
                                        onClick={() => handleRetrySubtitle(selectedVideo.id)}
                                        className="shrink-0 flex items-center gap-2 px-4 py-2 text-[11px] font-bold text-rose-700 bg-white border border-rose-200 rounded-lg hover:bg-rose-50 transition-all active:scale-95"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        重新尝试
                                    </button>
                                </div>
                            )}

                            {selectedVideo.hasSubtitle && (
                                <div className="bg-black/[0.02] rounded-2xl border border-black/[0.03] overflow-hidden">
                                    <button
                                        onClick={() => setShowSubtitle(!showSubtitle)}
                                        className="w-full px-6 py-4 flex items-center justify-between text-[14px] font-extrabold text-text-primary"
                                    >
                                        <span className="flex items-center gap-2.5">
                                            <FileText className="w-4 h-4 text-accent-primary" />
                                            字幕内容
                                        </span>
                                        <ChevronRight className={`w-4 h-4 transition-transform duration-300 ${showSubtitle ? 'rotate-90 text-accent-primary' : 'text-text-tertiary'}`} />
                                    </button>
                                    {(showSubtitle || (selectedVideo.hasSubtitle && !selectedVideo.subtitleContent && isSubtitleLoading)) && (
                                        <div className="px-6 pb-6 animate-in slide-in-from-top-2 duration-300">
                                            {isSubtitleLoading ? (
                                                <div className="flex items-center gap-3 bg-white p-5 rounded-xl border border-black/[0.02]">
                                                    <Loader2 className="w-5 h-5 animate-spin text-accent-primary" />
                                                    <span className="text-[13px] font-bold text-accent-primary uppercase tracking-widest">Loading Subtitles...</span>
                                                </div>
                                            ) : (
                                                <div className="bg-white rounded-xl p-5 border border-black/[0.02] shadow-inner">
                                                    <pre className="text-[13px] text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-[400px] overflow-auto custom-scrollbar">
                                                        {selectedVideo.subtitleContent}
                                                    </pre>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {!selectedVideo.hasSubtitle && selectedVideo.status === 'completed' && (
                                <div className="bg-amber-50 border border-amber-100 rounded-2xl p-6 flex items-center justify-between">
                                    <div className="flex items-center gap-3 text-amber-700">
                                        <FileText className="w-5 h-5 opacity-60" />
                                        <span className="text-[13px] font-bold">该视频暂无可用字幕</span>
                                    </div>
                                    <button
                                        onClick={() => handleRetrySubtitle(selectedVideo.id)}
                                        className="flex items-center gap-2 px-4 py-2 text-[11px] font-bold text-amber-700 bg-white border border-amber-200 rounded-lg hover:bg-amber-50 transition-all active:scale-95"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        重新尝试获取
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="px-8 py-5 border-t border-black/[0.04] flex items-center justify-between bg-black/[0.01]" onClick={(event) => event.stopPropagation()}>
                            <div className="text-[10px] font-bold text-text-tertiary/60 uppercase tracking-widest">YouTube Knowledge Source</div>
                            <button
                                onClick={() => handleDeleteVideo(selectedVideo.id)}
                                className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-bold text-rose-500 hover:bg-rose-50 rounded-xl transition-all active:scale-95"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                移除视频
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Image Preview Modal (for Xiaohongshu) */}
            {selectedNote && isImagePreviewOpen && selectedNote.images && selectedNote.images.length > 0 && (
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80"
                    onClick={() => setIsImagePreviewOpen(false)}
                >
                    {(() => {
                        const orderedImages = orderImages(selectedNote.images);
                        const currentImage = orderedImages[selectedImageIndex];
                        return (
                            <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(event) => event.stopPropagation()}>
                                <img src={resolveAssetUrl(currentImage)} alt="预览图" className="max-h-[90vh] max-w-[90vw] object-contain" />
                                {orderedImages.length > 1 && (
                                    <>
                                        <button
                                            onClick={() => setSelectedImageIndex((prev) => (prev === 0 ? orderedImages.length - 1 : prev - 1))}
                                            className="absolute left-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                                        >
                                            <ChevronLeft className="w-5 h-5" />
                                        </button>
                                        <button
                                            onClick={() => setSelectedImageIndex((prev) => (prev === orderedImages.length - 1 ? 0 : prev + 1))}
                                            className="absolute right-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                                        >
                                            <ChevronRight className="w-5 h-5" />
                                        </button>
                                    </>
                                )}
                                <button
                                    onClick={() => setIsImagePreviewOpen(false)}
                                    className="absolute top-3 right-3 h-8 w-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* Knowledge Chat Modal */}
            <KnowledgeChatModal
                isOpen={chatModalState.isOpen}
                onClose={() => setChatModalState(prev => ({ ...prev, isOpen: false }))}
                contextId={chatModalState.contextId}
                contextType={chatModalState.contextType}
                contextTitle={chatModalState.contextTitle}
                contextContent={chatModalState.contextContent}
            />
        </div>
    );
}
