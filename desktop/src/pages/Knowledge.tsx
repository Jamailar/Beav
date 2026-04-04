import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { SyntheticEvent } from 'react';
import { Search, Trash2, Image, Heart, MessageCircle, X, ChevronLeft, ChevronRight, Play, FileText, ExternalLink, RefreshCw, Sparkles, Star, BookmarkPlus, FolderPlus, FolderOpen, Plus, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PendingChatMessage } from '../App';
import { KnowledgeChatModal } from '../components/KnowledgeChatModal';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { resolveAssetUrl } from '../utils/pathManager';
import { buildRedClawAuthoringMessage } from '../utils/redclawAuthoring';

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
    status?: 'processing' | 'completed' | 'failed';
    createdAt: string;
    folderPath?: string;
}

type KnowledgeTypeFilter = 'all' | 'xhs-image' | 'xhs-video' | 'link-article' | 'wechat-article' | 'youtube' | 'docs';

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

interface CoverTemplate {
    id: string;
    name: string;
    prompt: string;
    styleHint: string;
    model: string;
    aspectRatio: string;
    size: string;
    quality: string;
    count: number;
    projectId: string;
    titlePrefix: string;
    referenceImages?: string[];
    updatedAt: string;
}

interface SettingsShape {
    image_model?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    active_space_id?: string;
}

const SHOW_WECHAT_KNOWLEDGE_ACTIONS = false;
const COVER_TEMPLATE_STORAGE_PREFIX = 'redbox:cover-templates:v1';
const getCoverTemplateStorageKey = (spaceId: string) => `${COVER_TEMPLATE_STORAGE_PREFIX}:${spaceId || 'default'}`;
const createCoverTemplateId = () => `cover_tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizeCoverTemplate = (raw: unknown): CoverTemplate | null => {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const name = String(item.name || '').trim();
    const prompt = String(item.prompt || '').trim();
    if (!name || !prompt) return null;
    const count = Number(item.count || 1);
    return {
        id: String(item.id || createCoverTemplateId()),
        name,
        prompt,
        styleHint: String(item.styleHint || ''),
        model: String(item.model || 'gpt-image-1'),
        aspectRatio: String(item.aspectRatio || '3:4'),
        size: String(item.size || '1024x1024'),
        quality: String(item.quality || 'standard'),
        count: Math.max(1, Math.min(4, Number.isFinite(count) ? Math.floor(count) : 1)),
        projectId: String(item.projectId || ''),
        titlePrefix: String(item.titlePrefix || ''),
        referenceImages: Array.isArray(item.referenceImages)
            ? item.referenceImages.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 4)
            : [],
        updatedAt: String(item.updatedAt || new Date().toISOString()),
    };
};

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
    const [isLoading, setIsLoading] = useState(true);
    const [imageAspectMap, setImageAspectMap] = useState<Record<string, 'portrait' | 'landscape'>>({});
    const [showSubtitle, setShowSubtitle] = useState(false);
    const [showTranscript, setShowTranscript] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [isSubtitleLoading, setIsSubtitleLoading] = useState(false);
    const [isRefreshingYoutubeSummaries, setIsRefreshingYoutubeSummaries] = useState(false);
    const [embeddedViewportWidth, setEmbeddedViewportWidth] = useState(0);
    const wasActiveRef = useRef<boolean>(isActive);
    const embeddedViewportRef = useRef<HTMLDivElement>(null);

    // 搜索框状态
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

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
                const cacheResult = await window.ipcRenderer.invoke('similarity:get-cache', manuscriptId) as any;

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
                        const embCacheResult = await window.ipcRenderer.invoke('embedding:get-manuscript-cache', manuscriptId) as any;
                        if (!isMountedRef.current) return;

                        let embedding: number[] | null = null;
                        const currentVersion = await window.ipcRenderer.invoke('similarity:get-knowledge-version');

                        if (embCacheResult?.success && embCacheResult?.cached?.contentHash === contentHash) {
                            console.log('[Knowledge] Using cached embedding');
                            embedding = embCacheResult.cached.embedding;
                        } else {
                            console.log('[Knowledge] Computing embedding...');
                            const computeResult = await window.ipcRenderer.invoke('embedding:compute', referenceContent) as any;
                            if (!isMountedRef.current) return;

                            if (!computeResult?.success || !computeResult?.embedding) {
                                console.warn('[Knowledge] Embedding failed:', computeResult?.error);
                                setIsSimilarityLoading(false);
                                return;
                            }

                            embedding = computeResult.embedding;

                            window.ipcRenderer.invoke('embedding:save-manuscript-cache', {
                                filePath: manuscriptId,
                                contentHash,
                                embedding
                            }).catch(console.error);
                        }

                        if (!isMountedRef.current) return;

                        const sortResult = await window.ipcRenderer.invoke('embedding:get-sorted-sources', embedding) as any;
                        if (!isMountedRef.current) return;

                        if (sortResult?.success && sortResult?.sorted) {
                            const sortedIds = sortResult.sorted.map((item: any) => item.sourceId);
                            const orderMap = new Map<string, number>();
                            sortedIds.forEach((id: string, index: number) => orderMap.set(id, index));
                            setSimilarityOrder(orderMap);
                            lastContentHashRef.current = contentHash;
                            window.ipcRenderer.invoke('similarity:save-cache', {
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

    const loadNotes = useCallback(async () => {
        setIsLoading(true);
        try {
            const list = await window.ipcRenderer.invoke('knowledge:list') as Note[];
            setNotes(list || []);
        } catch (e) {
            console.error('Failed to load notes:', e);
            setNotes([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const loadYoutubeVideos = useCallback(async () => {
        setIsLoading(true);
        try {
            const list = await window.ipcRenderer.invoke('knowledge:list-youtube') as YouTubeVideo[];
            setYoutubeVideos(list || []);
        } catch (e) {
            console.error('Failed to load YouTube videos:', e);
            setYoutubeVideos([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const loadDocumentSources = useCallback(async () => {
        setIsLoading(true);
        try {
            const list = await window.ipcRenderer.invoke('knowledge:docs:list') as DocumentKnowledgeSource[];
            setDocumentSources(Array.isArray(list) ? list : []);
        } catch (error) {
            console.error('Failed to load document sources:', error);
            setDocumentSources([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const loadAllKnowledge = useCallback(async () => {
        setIsLoading(true);
        try {
            const [noteList, videoList, docList] = await Promise.all([
                window.ipcRenderer.invoke('knowledge:list') as Promise<Note[]>,
                window.ipcRenderer.invoke('knowledge:list-youtube') as Promise<YouTubeVideo[]>,
                window.ipcRenderer.invoke('knowledge:docs:list') as Promise<DocumentKnowledgeSource[]>,
            ]);
            setNotes(Array.isArray(noteList) ? noteList : []);
            setYoutubeVideos(Array.isArray(videoList) ? videoList : []);
            setDocumentSources(Array.isArray(docList) ? docList : []);
        } catch (error) {
            console.error('Failed to load knowledge:', error);
            setNotes([]);
            setYoutubeVideos([]);
            setDocumentSources([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadAllKnowledge();
    }, [loadAllKnowledge]);

    // 每次从其他页面切回知识库时，强制刷新当前列表，避免页面显示旧缓存。
    useEffect(() => {
        const wasActive = wasActiveRef.current;
        wasActiveRef.current = isActive;
        if (!isActive || wasActive) {
            return;
        }
        void loadAllKnowledge();
    }, [isActive, loadAllKnowledge]);

    // 监听 YouTube 视频更新事件
    useEffect(() => {
        const handleVideoUpdated = (_event: unknown, data: { noteId: string; status: string; hasSubtitle?: boolean; title?: string; summary?: string }) => {
            console.log('[Knowledge] Video updated:', data);
            setYoutubeVideos(prev => prev.map(video =>
                video.id === data.noteId
                    ? {
                        ...video,
                        status: data.status as YouTubeVideo['status'],
                        hasSubtitle: data.hasSubtitle ?? video.hasSubtitle,
                        title: typeof data.title === 'string' && data.title.trim() ? data.title : video.title,
                        summary: typeof data.summary === 'string' ? data.summary : video.summary,
                    }
                    : video
            ));
            // 如果当前选中的视频更新了，也更新选中状态
            if (selectedVideo?.id === data.noteId) {
                setSelectedVideo(prev => prev ? {
                    ...prev,
                    status: data.status as YouTubeVideo['status'],
                    hasSubtitle: data.hasSubtitle ?? prev.hasSubtitle,
                    title: typeof data.title === 'string' && data.title.trim() ? data.title : prev.title,
                    summary: typeof data.summary === 'string' ? data.summary : prev.summary,
                } : null);
            }
        };

        const handleNewVideo = (_event: unknown, data: { noteId: string; title: string; status?: string }) => {
            console.log('[Knowledge] New video added:', data);
            void loadYoutubeVideos();
        };

        window.ipcRenderer.on('knowledge:youtube-video-updated', handleVideoUpdated);
        window.ipcRenderer.on('knowledge:new-youtube-video', handleNewVideo);

        return () => {
            window.ipcRenderer.off('knowledge:youtube-video-updated', handleVideoUpdated);
            window.ipcRenderer.off('knowledge:new-youtube-video', handleNewVideo);
        };
    }, [loadYoutubeVideos, selectedVideo?.id]);

    useEffect(() => {
        const handleDocsUpdated = () => {
            void loadDocumentSources();
        };
        window.ipcRenderer.on('knowledge:docs-updated', handleDocsUpdated);
        return () => {
            window.ipcRenderer.off('knowledge:docs-updated', handleDocsUpdated);
        };
    }, [loadDocumentSources]);

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

    const knowledgeItems = useMemo<KnowledgeCardItem[]>(() => {
        const noteItems: KnowledgeCardItem[] = notes.map((note) => {
            const orderedImages = orderImages(note.images || []);
            const kind: KnowledgeCardItem['kind'] = (note.type === 'link-article' || note.type === 'text')
                ? note.captureKind === 'wechat-article'
                    ? 'wechat-article'
                    : 'link-article'
                : note.video
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
                    note.content,
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
            'link-article': 0,
            'wechat-article': 0,
            'youtube': 0,
            'docs': 0,
        };
        knowledgeItems.forEach((item) => {
            counts[item.kind] += 1;
        });
        return [
            { key: 'all' as const, label: '全部', count: knowledgeItems.length },
            { key: 'xhs-image' as const, label: '小红书图文', count: counts['xhs-image'] },
            { key: 'xhs-video' as const, label: '小红书视频', count: counts['xhs-video'] },
            { key: 'link-article' as const, label: '链接文章', count: counts['link-article'] },
            ...(SHOW_WECHAT_KNOWLEDGE_ACTIONS ? [{ key: 'wechat-article' as const, label: '公众号文章', count: counts['wechat-article'] }] : []),
            { key: 'youtube' as const, label: 'YouTube', count: counts.youtube },
            { key: 'docs' as const, label: '文档', count: counts.docs },
        ].filter((item) => item.key === 'all' || item.count > 0);
    }, [knowledgeItems]);

    const youtubeSummaryPendingCount = useMemo(() => {
        return youtubeVideos.filter((video) => video.hasSubtitle && !String(video.summary || '').trim()).length;
    }, [youtubeVideos]);

    const filteredKnowledgeItems = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        const filtered = knowledgeItems.filter((item) => {
            if (selectedTypeFilter !== 'all' && item.kind !== selectedTypeFilter) {
                return false;
            }
            if (selectedTag && !item.tags.includes(selectedTag)) {
                return false;
            }
            if (!query) {
                return true;
            }
            return item.searchText.includes(query);
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
        }
    }, [selectedNote]);

    useEffect(() => {
        if (selectedVideo) {
            setShowSubtitle(false);
        }
    }, [selectedVideo]);

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
            setNotes(prev => prev.map(note => {
                if (note.id !== data.noteId) return note;
                return {
                    ...note,
                    transcript: data.hasTranscript ? note.transcript : note.transcript,
                    transcriptionStatus: data.transcriptionStatus || note.transcriptionStatus,
                };
            }));
            if (selectedNote?.id === data.noteId && data.transcriptionStatus) {
                setSelectedNote(prev => prev && prev.id === data.noteId
                    ? { ...prev, transcriptionStatus: data.transcriptionStatus }
                    : prev
                );
            }
            void loadNotes();
        };
        window.ipcRenderer.on('knowledge:note-updated', handleNoteUpdated);
        return () => {
            window.ipcRenderer.off('knowledge:note-updated', handleNoteUpdated);
        };
    }, [loadNotes, selectedNote]);

    const handleDeleteNote = async (noteId: string) => {
        if (!confirm('确定要删除这篇笔记吗？')) return;

        try {
            await window.ipcRenderer.invoke('knowledge:delete', noteId);
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
            const res = await window.ipcRenderer.invoke('knowledge:transcribe', noteId) as { success: boolean; transcript?: string; error?: string };
            if (res.success) {
                await loadNotes();
                const updated = await window.ipcRenderer.invoke('knowledge:list') as Note[];
                setNotes(updated || []);
                const refreshed = (updated || []).find(n => n.id === noteId) || null;
                setSelectedNote(refreshed);
                setShowTranscript(true);
            } else {
                setNotes(prev => prev.map(note => note.id === noteId ? { ...note, transcriptionStatus: 'failed' } : note));
                setSelectedNote(prev => prev && prev.id === noteId ? { ...prev, transcriptionStatus: 'failed' } : prev);
                alert(res.error || '转录失败');
            }
        } catch (e) {
            console.error('Failed to transcribe note:', e);
            setNotes(prev => prev.map(note => note.id === noteId ? { ...note, transcriptionStatus: 'failed' } : note));
            setSelectedNote(prev => prev && prev.id === noteId ? { ...prev, transcriptionStatus: 'failed' } : prev);
            alert('转录失败');
        } finally {
            setIsTranscribing(false);
        }
    };

    const handleSaveNoteCoverAsTemplate = useCallback(async (note: Note) => {
        try {
            const orderedImages = orderImages(note.images || []);
            const coverImage = orderedImages[selectedImageIndex] || note.cover || orderedImages[0] || '';
            if (!coverImage) {
                alert('这篇笔记没有可用封面图');
                return;
            }

            const settings = await window.ipcRenderer.getSettings() as SettingsShape | undefined;
            const spaceId = String(settings?.active_space_id || 'default').trim() || 'default';
            const storageKey = getCoverTemplateStorageKey(spaceId);

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

            let persistedCoverImage = coverImage;
            try {
                const saved = await window.ipcRenderer.invoke('cover:save-template-image', {
                    imageSource: coverImage,
                }) as { success?: boolean; previewUrl?: string; error?: string };
                if (saved?.success && saved.previewUrl) {
                    persistedCoverImage = saved.previewUrl;
                } else if (saved?.error) {
                    console.warn('cover:save-template-image returned fallback:', saved.error);
                }
            } catch (error) {
                console.warn('Failed to persist cover template image to cover folder, fallback to original url:', error);
            }

            let existing: CoverTemplate[] = [];
            try {
                const raw = window.localStorage.getItem(storageKey);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    existing = Array.isArray(parsed)
                        ? parsed.map(normalizeCoverTemplate).filter((item): item is CoverTemplate => Boolean(item))
                        : [];
                }
            } catch (error) {
                console.error('Failed to parse existing cover templates:', error);
            }

            const created: CoverTemplate = {
                id: createCoverTemplateId(),
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
                referenceImages: [persistedCoverImage],
                updatedAt: now,
            };

            const nextTemplates = [created, ...existing]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 300);
            window.localStorage.setItem(storageKey, JSON.stringify(nextTemplates));
            window.dispatchEvent(new CustomEvent('cover:templates-updated', {
                detail: { spaceId },
            }));
            alert('已保存为封面模板，可在「封面」页直接套用。');
        } catch (error) {
            console.error('Failed to save cover template from note:', error);
            alert('保存封面模板失败');
        }
    }, [selectedImageIndex]);

    const handleDeleteVideo = async (videoId: string) => {
        if (!confirm('确定要删除这个视频吗？')) return;

        try {
            await window.ipcRenderer.invoke('knowledge:delete-youtube', videoId);
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
                v.id === videoId ? { ...v, status: 'processing' as const } : v
            ));
            if (selectedVideo?.id === videoId) {
                setSelectedVideo(prev => prev ? { ...prev, status: 'processing' } : null);
            }

            await window.ipcRenderer.invoke('knowledge:retry-youtube-subtitle', videoId);
            // 状态更新会通过 IPC 事件 'knowledge:youtube-video-updated' 自动处理
        } catch (e) {
            console.error('Failed to retry subtitle:', e);
        }
    };

    const handleRefreshYoutubeSummaries = async () => {
        try {
            setIsRefreshingYoutubeSummaries(true);
            const result = await window.ipcRenderer.invoke('knowledge:youtube-regenerate-summaries') as {
                success?: boolean;
                updated?: number;
                skipped?: number;
                failed?: number;
                errors?: Array<{ videoId?: string; error?: string }>;
            };
            await loadYoutubeVideos();
            if (result?.success) {
                alert(`已更新 ${result.updated || 0} 个 YouTube 视频摘要${result?.skipped ? `，跳过 ${result.skipped} 个无字幕视频` : ''}`);
                return;
            }
            const firstError = result?.errors?.[0]?.error || '批量刷新摘要失败';
            alert(firstError);
        } catch (error) {
            console.error('Failed to refresh YouTube summaries:', error);
            alert('批量刷新 YouTube 摘要失败');
        } finally {
            setIsRefreshingYoutubeSummaries(false);
        }
    };

    const handleAddDocumentFiles = async () => {
        const result = await window.ipcRenderer.invoke('knowledge:docs:add-files') as { success?: boolean; error?: string };
        if (!result?.success) {
            alert(result?.error || '添加文件失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleAddDocumentFolder = async () => {
        const result = await window.ipcRenderer.invoke('knowledge:docs:add-folder') as { success?: boolean; error?: string };
        if (!result?.success) {
            alert(result?.error || '添加文件夹失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleAddObsidianVault = async () => {
        const result = await window.ipcRenderer.invoke('knowledge:docs:add-obsidian-vault') as { success?: boolean; error?: string };
        if (!result?.success) {
            alert(result?.error || '添加 Obsidian 仓库失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleDeleteDocumentSource = async (source: DocumentKnowledgeSource) => {
        if (!confirm(`确定要移除文档源“${source.name}”吗？`)) return;
        const result = await window.ipcRenderer.invoke('knowledge:docs:delete-source', source.id) as { success?: boolean; error?: string };
        if (!result?.success) {
            alert(result?.error || '删除文档源失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleShowInFolder = async (source?: string) => {
        const normalized = String(source || '').trim();
        if (!normalized) return;
        const result = await window.ipcRenderer.invoke('file:show-in-folder', { source: normalized }) as { success?: boolean; error?: string };
        if (!result?.success) {
            alert(result?.error || '打开文件夹失败');
        }
    };

    const getKnowledgeKindLabel = (kind: KnowledgeCardItem['kind']) => {
        switch (kind) {
            case 'xhs-image':
                return '小红书图文';
            case 'xhs-video':
                return '小红书视频';
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
                            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text-primary bg-surface-secondary border border-border rounded hover:bg-surface-hover transition-colors"
                            title="保存封面为模板"
                        >
                            <BookmarkPlus className="w-3 h-3" />
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
                        <div className="relative rounded-lg overflow-hidden border border-border bg-surface-secondary">
                            <video
                                src={resolveAssetUrl(selectedNote.video)}
                                className="block w-full h-auto max-h-[300px] object-contain"
                                controls
                                playsInline
                                preload="metadata"
                            />
                        </div>
                    </div>
                )}

                {selectedNote.images && selectedNote.images.length > 0 && (() => {
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
        <div className="flex h-full flex-col">
            <div
                className={clsx(
                    'border-b border-border bg-surface-primary',
                    isEmbedded ? 'px-3 py-2' : 'px-6 py-4'
                )}
            >
                <div className={clsx('flex flex-col', isEmbedded ? 'gap-2' : 'gap-3')}>
                    <div className="flex items-center gap-2 py-1">
                        <div className="flex-1 flex items-center gap-2 overflow-x-auto no-scrollbar">
                            {typeFilters.map((item) => (
                                <button
                                    key={item.key}
                                    onClick={() => setSelectedTypeFilter(item.key)}
                                    className={clsx(
                                        'shrink-0 px-3.5 py-2 text-xs rounded-xl border transition-all flex items-center gap-2 backdrop-blur-sm',
                                        selectedTypeFilter === item.key
                                            ? 'bg-text-primary text-white border-text-primary shadow-md'
                                            : 'bg-surface-primary text-text-secondary border-border hover:border-text-tertiary/30 hover:bg-surface-secondary hover:text-text-primary'
                                    )}
                                >
                                    <span className="font-medium tracking-[0.01em]">{item.label}</span>
                                    <span className={clsx(
                                        'text-[10px] px-1.5 py-0.5 rounded-lg',
                                        selectedTypeFilter === item.key
                                            ? 'bg-white/15 text-white'
                                            : 'bg-surface-secondary text-text-tertiary'
                                    )}>
                                        {item.count}
                                    </span>
                                </button>
                            ))}
                        </div>

                        {isSearchOpen ? (
                            <div className="flex items-center gap-2 shrink-0">
                                <div className="relative w-[220px] sm:w-[260px]">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="搜索知识库..."
                                        autoFocus
                                        className="w-full bg-surface-secondary border border-border rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    />
                                    {searchQuery && (
                                        <button
                                            onClick={() => setSearchQuery('')}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                                <button
                                    onClick={() => {
                                        setIsSearchOpen(false);
                                        setSearchQuery('');
                                    }}
                                    className="px-3 py-2 text-sm text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
                                >
                                    取消
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 shrink-0">
                                <button
                                    onClick={() => setIsSearchOpen(true)}
                                    className="inline-flex h-9 px-3 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors border border-border/60 items-center justify-center"
                                    title="搜索 (Cmd+F)"
                                >
                                    <Search className="w-4 h-4" />
                                </button>
                                {!isEmbedded && (
                                    <>
                                        {(selectedTypeFilter === 'all' || selectedTypeFilter === 'youtube') && youtubeSummaryPendingCount > 0 && (
                                            <button
                                                onClick={() => void handleRefreshYoutubeSummaries()}
                                                disabled={isRefreshingYoutubeSummaries}
                                                className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium border border-border rounded-lg bg-surface-primary hover:bg-surface-secondary transition-colors disabled:opacity-60"
                                            >
                                                {isRefreshingYoutubeSummaries ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                                补全 YouTube 摘要
                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary text-text-tertiary">
                                                    {youtubeSummaryPendingCount}
                                                </span>
                                            </button>
                                        )}
                                        <button
                                            onClick={handleAddDocumentFiles}
                                            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium border border-border rounded-lg bg-surface-primary hover:bg-surface-secondary transition-colors"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            文件
                                        </button>
                                        <button
                                            onClick={handleAddDocumentFolder}
                                            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium border border-border rounded-lg bg-surface-primary hover:bg-surface-secondary transition-colors"
                                        >
                                            <FolderPlus className="w-3.5 h-3.5" />
                                            文件夹
                                        </button>
                                        <button
                                            onClick={handleAddObsidianVault}
                                            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium border border-border rounded-lg bg-surface-primary hover:bg-surface-secondary transition-colors"
                                        >
                                            <FolderOpen className="w-3.5 h-3.5" />
                                            Obsidian
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    {!isEmbedded && allTags.length > 0 && (
                        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                            <button
                                onClick={() => setSelectedTag(null)}
                                className={clsx(
                                    'shrink-0 px-3 py-1 text-xs font-medium rounded-full transition-all border',
                                    !selectedTag
                                        ? 'bg-surface-primary text-text-primary border-border shadow-sm ring-1 ring-border/50'
                                        : 'bg-transparent text-text-tertiary border-transparent hover:bg-surface-secondary hover:text-text-secondary'
                                )}
                            >
                                全部标签
                            </button>
                            {allTags.map(({ tag, count }) => (
                                <button
                                    key={tag}
                                    onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                                    className={clsx(
                                        'shrink-0 px-3 py-1 text-xs rounded-full transition-all flex items-center gap-1.5 border',
                                        selectedTag === tag
                                            ? tag === '公众号文章'
                                                ? 'bg-emerald-600 text-white border-emerald-600 shadow-md shadow-emerald-600/20'
                                                : tag === '网页文章'
                                                    ? 'bg-sky-600 text-white border-sky-600 shadow-md shadow-sky-600/20'
                                                    : 'bg-accent-primary text-white border-accent-primary shadow-md shadow-accent-primary/20'
                                            : clsx('bg-surface-secondary/50 border-transparent hover:bg-surface-secondary hover:text-text-primary', getKnowledgeTagClass(tag))
                                    )}
                                >
                                    <span className="opacity-70">#</span>
                                    {tag}
                                    <span
                                        className={clsx(
                                            'text-[10px] py-0.5 px-1.5 rounded-full',
                                            selectedTag === tag
                                                ? 'bg-white/20 text-white'
                                                : tag === '公众号文章'
                                                    ? 'bg-emerald-100 text-emerald-700'
                                                    : tag === '网页文章'
                                                        ? 'bg-sky-100 text-sky-700'
                                                        : 'bg-surface-tertiary text-text-tertiary'
                                        )}
                                    >
                                        {count}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div
                ref={embeddedViewportRef}
                className={clsx('flex-1 overflow-auto', isEmbedded ? 'p-3' : 'p-6')}
            >
                {isLoading ? (
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
                                                className="mb-3 break-inside-avoid rounded-xl border border-border bg-surface-primary p-3 shadow-sm"
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <div className="text-sm font-semibold text-text-primary truncate">{source.name}</div>
                                                            <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full', getKnowledgeKindBadgeClass('docs'))}>
                                                                {getKnowledgeKindLabel('docs')}
                                                            </span>
                                                            {source.locked && (
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                                                    锁定目录
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="mt-1 text-[11px] text-text-tertiary break-all">{source.rootPath}</div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleDeleteDocumentSource(source)}
                                                        className="p-1.5 rounded-md text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                                        title="移除此文档源"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                                <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] text-text-secondary">
                                                    <span className="inline-flex items-center gap-1 rounded-md bg-surface-secondary px-2 py-1">
                                                        <FileText className="w-3 h-3" />
                                                        {source.fileCount} 个文档
                                                    </span>
                                                    {source.indexing && (
                                                        <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-700 px-2 py-1">
                                                            <Loader2 className="w-3 h-3 animate-spin" />
                                                            建立索引中
                                                        </span>
                                                    )}
                                                    {!source.indexing && source.indexError && (
                                                        <span className="inline-flex items-center gap-1 rounded-md bg-red-100 text-red-700 px-2 py-1">
                                                            索引失败
                                                        </span>
                                                    )}
                                                </div>
                                                {source.sampleFiles.length > 0 && (
                                                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                                                        {source.sampleFiles.slice(0, 6).map((file) => (
                                                            <span
                                                                key={`${source.id}-${file}`}
                                                                className="inline-flex max-w-full items-start gap-1 text-[11px] px-2 py-1 rounded-md bg-surface-secondary text-text-secondary"
                                                            >
                                                                <FileText className="w-3 h-3 shrink-0 mt-0.5" />
                                                                <span className="min-w-0 break-all leading-relaxed">{file}</span>
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
                                                onClick={() => setSelectedVideo(video)}
                                                className={clsx(
                                                    'group mb-3 break-inside-avoid w-full text-left bg-surface-primary border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow',
                                                    isProcessing ? 'border-yellow-400 animate-pulse' : isFailed ? 'border-red-400' : 'border-border'
                                                )}
                                            >
                                                <div className="relative aspect-[16/10] bg-surface-secondary overflow-hidden">
                                                    <span className={clsx('absolute top-2 right-2 z-10 text-[10px] px-2 py-1 rounded-full shadow-sm', getKnowledgeKindBadgeClass('youtube'))}>
                                                        {getKnowledgeKindLabel('youtube')}
                                                    </span>
                                                    {video.thumbnailUrl && !isProcessing ? (
                                                        <img
                                                            src={resolveAssetUrl(video.thumbnailUrl)}
                                                            alt={video.title}
                                                            className="w-full h-full object-cover"
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center text-text-tertiary">
                                                            {isProcessing ? (
                                                                <div className="flex flex-col items-center gap-2">
                                                                    <div className="w-8 h-8 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                                                                    <span className="text-xs text-yellow-600">处理中...</span>
                                                                </div>
                                                            ) : (
                                                                <Play className="w-8 h-8" />
                                                            )}
                                                        </div>
                                                    )}
                                                    {isProcessing && video.thumbnailUrl && (
                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                                                            <div className="flex flex-col items-center gap-2">
                                                                <div className="w-10 h-10 border-3 border-white border-t-transparent rounded-full animate-spin" />
                                                                <span className="text-xs text-white font-medium">下载字幕中...</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {!isProcessing && !isFailed && (
                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 hover:opacity-100 transition-opacity">
                                                            <div className="w-12 h-12 rounded-full bg-red-600 flex items-center justify-center">
                                                                <Play className="w-6 h-6 text-white ml-1" fill="white" />
                                                            </div>
                                                        </div>
                                                    )}
                                                    {video.summary && !isProcessing && (
                                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                                            {video.originalTitle && video.originalTitle.trim() && video.originalTitle !== video.title && (
                                                                <div className="mb-1 text-[10px] text-white/70 line-clamp-2">
                                                                    原始标题：{video.originalTitle}
                                                                </div>
                                                            )}
                                                            <div className="text-[11px] leading-relaxed text-white line-clamp-4">
                                                                {video.summary}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="p-2.5">
                                                    <div className="text-xs font-semibold text-text-primary line-clamp-2">{video.title}</div>
                                                    <div className="mt-1 text-[11px] text-text-tertiary line-clamp-2">
                                                        {isProcessing ? '正在下载字幕和封面...' : (video.summary || video.description || '暂无描述')}
                                                    </div>
                                                    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-text-tertiary">
                                                        <span>{new Date(video.createdAt).toLocaleDateString()}</span>
                                                        {video.hasSubtitle && !isProcessing && <span>已提取字幕</span>}
                                                        {isFailed && <span className="text-red-500">处理失败</span>}
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
                                            onClick={() => setSelectedNote(note)}
                                            className={clsx(
                                                'mb-3 break-inside-avoid w-full text-left bg-surface-primary border border-border rounded-lg shadow-sm hover:shadow-md transition-shadow',
                                                isTextArticleCard ? 'overflow-visible p-3' : 'overflow-hidden'
                                            )}
                                        >
                                            {isTextArticleCard ? (
                                                <div className={clsx('flex gap-3', embeddedUsesCompactCard ? 'flex-col' : 'items-start')}>
                                                    <div className={clsx(
                                                        'flex shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600',
                                                        embeddedUsesCompactCard ? 'h-9 w-9' : 'h-10 w-10',
                                                    )}>
                                                        <FileText className="w-5 h-5" />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-start justify-between gap-2">
                                                            <div className={clsx(
                                                                'font-semibold text-text-primary',
                                                                embeddedUsesCompactCard ? 'text-[13px] line-clamp-3' : 'text-xs line-clamp-2',
                                                            )}>
                                                                {note.title}
                                                            </div>
                                                            <span className={clsx('shrink-0 text-[10px] px-2 py-1 rounded-full shadow-sm', getKnowledgeKindBadgeClass(item.kind))}>
                                                                {getKnowledgeKindLabel(item.kind)}
                                                            </span>
                                                        </div>
                                                        <div className={clsx(
                                                            'mt-2 text-text-tertiary leading-relaxed',
                                                            embeddedUsesCompactCard ? 'text-[12px] line-clamp-7' : 'text-[11px] line-clamp-6',
                                                        )}>
                                                            {notePreviewText}
                                                        </div>
                                                        <div className="mt-3 flex items-center gap-2 text-[10px] text-text-tertiary flex-wrap">
                                                            <span>{new Date(note.createdAt).toLocaleDateString()}</span>
                                                            {note.sourceUrl && (
                                                                <span className="flex items-center gap-1 max-w-full">
                                                                    <ExternalLink className="w-3 h-3" />
                                                                    <span className="truncate max-w-[140px]">{note.author || '原文链接'}</span>
                                                                </span>
                                                            )}
                                                            {note.tags?.slice(0, 2).map((tag) => (
                                                                <span key={tag} className={clsx('text-[10px] px-1.5 py-0.5 rounded border', getKnowledgeTagClass(tag))}>
                                                                    #{tag}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : coverImage ? (
                                                <div
                                                    className={clsx(
                                                        'relative w-full bg-surface-secondary overflow-hidden',
                                                        (item.kind === 'link-article' || item.kind === 'wechat-article') ? 'aspect-[4/3]' : resolveAspectClass(note.id)
                                                    )}
                                                >
                                                    <span className={clsx('absolute top-2 right-2 z-10 text-[10px] px-2 py-1 rounded-full shadow-sm', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    <img
                                                        src={resolveAssetUrl(coverImage)}
                                                        alt={note.title}
                                                        className="w-full h-full object-cover"
                                                        onLoad={(event) => handleImageLoad(note.id, event)}
                                                    />
                                                    {isNoteTranscribing && (
                                                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/45 text-white">
                                                            <Loader2 className="w-5 h-5 animate-spin" />
                                                            <span className="text-[11px] font-medium">转录中...</span>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : note.video ? (
                                                <div className="relative w-full aspect-[3/4] bg-surface-secondary overflow-hidden flex items-center justify-center">
                                                    <span className={clsx('absolute top-2 right-2 z-10 text-[10px] px-2 py-1 rounded-full shadow-sm', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    <video
                                                        src={resolveAssetUrl(note.video)}
                                                        className="w-full h-full object-contain"
                                                        muted
                                                        playsInline
                                                        preload="metadata"
                                                    />
                                                    <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                                                        <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
                                                            <Play className="w-5 h-5 text-white ml-0.5" fill="white" />
                                                        </div>
                                                    </div>
                                                    {isNoteTranscribing && (
                                                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/45 text-white">
                                                            <Loader2 className="w-5 h-5 animate-spin" />
                                                            <span className="text-[11px] font-medium">转录中...</span>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <div
                                                    className={clsx(
                                                        'relative bg-surface-secondary flex items-center justify-center text-text-tertiary',
                                                        (item.kind === 'link-article' || item.kind === 'wechat-article') ? 'aspect-[4/2.6]' : 'aspect-[3/4]'
                                                    )}
                                                >
                                                    <span className={clsx('absolute top-2 right-2 z-10 text-[10px] px-2 py-1 rounded-full shadow-sm', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    {(item.kind === 'link-article' || item.kind === 'wechat-article') ? <FileText className="w-6 h-6" /> : <Image className="w-6 h-6" />}
                                                </div>
                                            )}
                                            <div className="p-2.5">
                                                <div className="text-xs font-semibold text-text-primary line-clamp-2">{note.title}</div>
                                                <div
                                                    className={clsx(
                                                        'text-[11px] text-text-tertiary',
                                                        (item.kind === 'link-article' || item.kind === 'wechat-article') ? 'mt-1 line-clamp-5' : 'mt-1 line-clamp-3'
                                                    )}
                                                >
                                                    {notePreviewText}
                                                </div>
                                                {!isEmbedded && note.tags && note.tags.length > 0 && (
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {note.tags.slice(0, 3).map((tag) => (
                                                            <span key={tag} className={clsx('text-[10px] px-1.5 py-0.5 rounded border', getKnowledgeTagClass(tag))}>
                                                                #{tag}
                                                            </span>
                                                        ))}
                                                        {note.tags.length > 3 && (
                                                            <span className="text-[10px] text-text-tertiary px-1">+{note.tags.length - 3}</span>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="mt-2 flex items-center gap-2 text-[10px] text-text-tertiary flex-wrap">
                                                    <span>{new Date(note.createdAt).toLocaleDateString()}</span>
                                                    {isNoteTranscribing && (
                                                        <span className="flex items-center gap-1 text-blue-600">
                                                            <Loader2 className="w-3 h-3 animate-spin" />
                                                            转录中
                                                        </span>
                                                    )}
                                                    {item.kind !== 'link-article' && (
                                                        <span className="flex items-center gap-1">
                                                            <Heart className="w-3 h-3" />
                                                            {note.stats?.likes || 0}
                                                        </span>
                                                    )}
                                                    {typeof note.stats?.collects === 'number' && item.kind !== 'link-article' && (
                                                        <span className="flex items-center gap-1">
                                                            <Star className="w-3 h-3" />
                                                            {note.stats.collects}
                                                        </span>
                                                    )}
                                                    {note.images?.length > 0 && (
                                                        <span className="flex items-center gap-1">
                                                            <Image className="w-3 h-3" />
                                                            {note.images.length}
                                                        </span>
                                                    )}
                                                    {note.video && (
                                                        <span className="flex items-center gap-1">
                                                            <Play className="w-3 h-3" />
                                                            视频
                                                        </span>
                                                    )}
                                                    {(item.kind === 'link-article' || item.kind === 'wechat-article') && note.sourceUrl && (
                                                        <span className="flex items-center gap-1 max-w-full">
                                                            <ExternalLink className="w-3 h-3" />
                                                            <span className="truncate max-w-[120px]">{note.author || '原文链接'}</span>
                                                        </span>
                                                    )}
                                                </div>
                                                {canExpandToWechat && (
                                                    <div className="mt-2">
                                                        <span
                                                            role="button"
                                                            tabIndex={0}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                handleExpandToWechat(note);
                                                            }}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter' || event.key === ' ') {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    handleExpandToWechat(note);
                                                                }
                                                            }}
                                                            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
                                                        >
                                                            <Sparkles className="w-3 h-3" />
                                                            扩写为公众号
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                    </div>
                )}
            </div>

            {/* Xiaohongshu Note Detail Modal */}
            {selectedNote && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
                    onClick={() => setSelectedNote(null)}
                >
                    <div
                        className="w-full max-w-3xl mx-4 bg-surface-primary rounded-2xl border border-border shadow-2xl overflow-hidden max-h-[85vh] flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        {(() => {
                            const showRichArticle = Boolean(selectedNote.htmlFileUrl && selectedNote.captureKind === 'wechat-article');
                            return (
                        <>
                        <div className="px-6 py-4 border-b border-border flex items-start justify-between">
                            <div className="min-w-0">
                                <h1 className="text-lg font-semibold text-text-primary line-clamp-2">{selectedNote.title}</h1>
                                <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary">
                                    <span>作者: {selectedNote.author}</span>
                                    {selectedNote.siteName && (
                                        <span>{selectedNote.siteName}</span>
                                    )}
                                    <span className="flex items-center gap-1">
                                        <Heart className="w-3 h-3" /> {selectedNote.stats?.likes || 0}
                                    </span>
                                    {typeof selectedNote.stats?.collects === 'number' && (
                                        <span className="flex items-center gap-1">
                                            <Star className="w-3 h-3" /> {selectedNote.stats.collects}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => openChat(
                                        selectedNote.id,
                                        getNoteContextType(selectedNote),
                                        selectedNote.title,
                                        selectedNote.content + (selectedNote.transcript ? `\n\nVideo Transcript:\n${selectedNote.transcript}` : '')
                                    )}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-secondary border border-border rounded-lg hover:bg-surface-hover transition-all"
                                >
                                    <MessageCircle className="w-3.5 h-3.5" />
                                    AI 助手
                                </button>
                                {SHOW_WECHAT_KNOWLEDGE_ACTIONS && isExpandableXiaohongshuNote(selectedNote) && onNavigateToRedClaw && (
                                    <button
                                        onClick={() => handleExpandToWechat(selectedNote)}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-gradient-to-r from-emerald-500 to-teal-500 rounded-lg hover:from-emerald-600 hover:to-teal-600 transition-all shadow-sm"
                                    >
                                        <Sparkles className="w-3.5 h-3.5" />
                                        扩写为公众号稿件
                                    </button>
                                )}
                                <button
                                    onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-secondary border border-border rounded-lg hover:bg-surface-hover transition-all"
                                    title="保存封面为模板"
                                >
                                    <BookmarkPlus className="w-3.5 h-3.5" />
                                    存为封面模板
                                </button>
                                <button
                                    onClick={() => void handleShowInFolder(selectedNote.folderPath)}
                                    className="p-2 text-text-tertiary hover:text-text-primary transition-colors"
                                    title="在文件夹中打开"
                                >
                                    <FolderOpen className="w-4 h-4" />
                                </button>
                                {selectedNote.video && !selectedNote.transcript && (
                                    <button
                                        onClick={() => handleTranscribeNote(selectedNote.id)}
                                        disabled={isTranscribing || selectedNote.transcriptionStatus === 'processing'}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-gradient-to-r from-blue-500 to-cyan-500 rounded-lg hover:from-blue-600 hover:to-cyan-600 transition-all shadow-sm disabled:opacity-60"
                                        title="提取文字"
                                    >
                                        {isTranscribing || selectedNote.transcriptionStatus === 'processing' ? (
                                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                            <FileText className="w-3.5 h-3.5" />
                                        )}
                                        {selectedNote.transcriptionStatus === 'processing' || isTranscribing ? '转录中...' : '提取文字'}
                                    </button>
                                )}
                                <button
                                    onClick={() => setSelectedNote(null)}
                                    className="p-2 text-text-tertiary hover:text-text-primary transition-colors"
                                    title="关闭"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto p-6 space-y-6" onClick={(event) => event.stopPropagation()}>
                            {selectedNote.video && (
                                <div className="relative mx-auto w-full max-w-[480px]">
                                    <div className="relative rounded-xl overflow-hidden border border-border bg-surface-secondary">
                                        <video
                                            src={resolveAssetUrl(selectedNote.video)}
                                            className="block w-full h-auto max-h-[60vh] object-contain"
                                            controls
                                            playsInline
                                            preload="metadata"
                                        />
                                    </div>
                                </div>
                            )}

                            {!showRichArticle && selectedNote.images && selectedNote.images.length > 0 && (() => {
                                const orderedImages = orderImages(selectedNote.images);
                                const currentImage = orderedImages[selectedImageIndex];
                                const aspectClass = resolveAspectClass(currentImage);
                                return (
                                    <div className="relative mx-auto w-full max-w-[360px]">
                                        <div className={`relative rounded-xl overflow-hidden border border-border bg-surface-secondary ${aspectClass}`}>
                                            <img
                                                src={resolveAssetUrl(currentImage)}
                                                alt={`图片 ${selectedImageIndex + 1}`}
                                                className="w-full h-full object-cover"
                                                onLoad={(event) => handleImageLoad(currentImage, event)}
                                                onClick={() => setIsImagePreviewOpen(true)}
                                            />
                                        </div>
                                        {orderedImages.length > 1 && (
                                            <>
                                                <button
                                                    onClick={() => setSelectedImageIndex((prev) => (prev === 0 ? orderedImages.length - 1 : prev - 1))}
                                                    className="absolute left-3 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/60"
                                                >
                                                    <ChevronLeft className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => setSelectedImageIndex((prev) => (prev === orderedImages.length - 1 ? 0 : prev + 1))}
                                                    className="absolute right-3 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/60"
                                                >
                                                    <ChevronRight className="w-4 h-4" />
                                                </button>
                                                <div className="absolute bottom-3 right-3 text-[11px] text-white bg-black/50 rounded-full px-2 py-0.5">
                                                    {selectedImageIndex + 1}/{orderedImages.length}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })()}

                            {showRichArticle ? (
                                <div className="rounded-xl border border-border overflow-hidden bg-white">
                                    <iframe
                                        src={resolveAssetUrl(selectedNote.htmlFileUrl)}
                                        title={selectedNote.title}
                                        sandbox="allow-popups allow-popups-to-escape-sandbox"
                                        className="block w-full h-[72vh] bg-white"
                                    />
                                </div>
                            ) : renderNoteBody(selectedNote)}

                            {selectedNote.video && selectedNote.transcript && (
                                <div className="bg-surface-secondary/50 rounded-lg border border-border overflow-hidden">
                                    <button
                                        onClick={() => setShowTranscript(!showTranscript)}
                                        className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-text-primary hover:bg-surface-secondary/80 transition-colors"
                                    >
                                        <span className="flex items-center gap-2">
                                            <FileText className="w-4 h-4" />
                                            视频转录
                                        </span>
                                        <ChevronRight className={`w-4 h-4 transition-transform ${showTranscript ? 'rotate-90' : ''}`} />
                                    </button>
                                    {showTranscript && (
                                        <div className="px-4 pb-4">
                                            <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-auto">
                                                {selectedNote.transcript}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="px-6 py-4 border-t border-border flex items-center justify-between" onClick={(event) => event.stopPropagation()}>
                            <div className="text-xs text-text-tertiary">保存时间 {selectedNote.createdAt}</div>
                            <button
                                onClick={() => handleDeleteNote(selectedNote.id)}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                删除笔记
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
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
                    onClick={() => setSelectedVideo(null)}
                >
                    <div
                        className="w-full max-w-4xl mx-4 bg-surface-primary rounded-2xl border border-border shadow-2xl overflow-hidden max-h-[85vh] flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-border flex items-start justify-between">
                            <div className="min-w-0 flex-1">
                                <h1 className="text-lg font-semibold text-text-primary line-clamp-2">{selectedVideo.title}</h1>
                                <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary">
                                    <span>保存于 {new Date(selectedVideo.createdAt).toLocaleDateString()}</span>
                                    {selectedVideo.hasSubtitle && (
                                        <span className="flex items-center gap-1 text-green-600">
                                            <FileText className="w-3 h-3" /> 有字幕
                                        </span>
                                    )}
                                </div>
                                {selectedVideo.summary && (
                                    <div className="mt-2 text-sm text-text-secondary line-clamp-3">
                                        {selectedVideo.summary}
                                    </div>
                                )}
                                {selectedVideo.originalTitle && selectedVideo.originalTitle.trim() && selectedVideo.originalTitle !== selectedVideo.title && (
                                    <div className="mt-1 text-xs text-text-tertiary line-clamp-2">
                                        原始标题：{selectedVideo.originalTitle}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => openChat(
                                        selectedVideo.id,
                                        'youtube_video',
                                        selectedVideo.title,
                                        `Title: ${selectedVideo.title}\nDescription: ${selectedVideo.description || 'None'}\n\nSubtitle:\n${selectedVideo.subtitleContent || '(No subtitle)'}`
                                    )}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-secondary border border-border rounded-lg hover:bg-surface-hover transition-all"
                                >
                                    <MessageCircle className="w-3.5 h-3.5" />
                                    AI 助手
                                </button>
                                <button
                                    onClick={() => void handleShowInFolder(selectedVideo.folderPath)}
                                    className="p-2 text-text-tertiary hover:text-text-primary transition-colors"
                                    title="在文件夹中打开"
                                >
                                    <FolderOpen className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => setSelectedVideo(null)}
                                    className="p-2 text-text-tertiary hover:text-text-primary transition-colors"
                                    title="关闭"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto p-6 space-y-6" onClick={(event) => event.stopPropagation()}>
                            {/* Thumbnail */}
                            <div className="relative mx-auto w-full max-w-2xl">
                                <div className="relative rounded-xl overflow-hidden border border-border bg-surface-secondary aspect-video">
                                    {selectedVideo.thumbnailUrl ? (
                                        <img
                                            src={resolveAssetUrl(selectedVideo.thumbnailUrl)}
                                            alt={selectedVideo.title}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-text-tertiary">
                                            <Play className="w-12 h-12" />
                                        </div>
                                    )}
                                    {/* Play button overlay */}
                                    <button
                                        onClick={() => openYouTube(selectedVideo.videoUrl)}
                                        className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
                                    >
                                        <div className="w-16 h-16 rounded-full bg-red-600 flex items-center justify-center shadow-lg">
                                            <Play className="w-8 h-8 text-white ml-1" fill="white" />
                                        </div>
                                    </button>
                                </div>
                            </div>

                            {/* Description */}
                            {selectedVideo.description && (
                                <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                                    <h3 className="text-sm font-semibold text-text-primary mb-2">视频描述</h3>
                                    <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
                                        {selectedVideo.description}
                                    </pre>
                                </div>
                            )}

                            {/* Subtitle */}
                            {selectedVideo.hasSubtitle && selectedVideo.subtitleContent && (
                                <div className="bg-surface-secondary/50 rounded-lg border border-border overflow-hidden">
                                    <button
                                        onClick={() => setShowSubtitle(!showSubtitle)}
                                        className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-text-primary hover:bg-surface-secondary/80 transition-colors"
                                    >
                                        <span className="flex items-center gap-2">
                                            <FileText className="w-4 h-4" />
                                            字幕内容
                                        </span>
                                        <ChevronRight className={`w-4 h-4 transition-transform ${showSubtitle ? 'rotate-90' : ''}`} />
                                    </button>
                                    {showSubtitle && (
                                        <div className="px-4 pb-4">
                                            <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-auto">
                                                {selectedVideo.subtitleContent}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            )}
                            {selectedVideo.hasSubtitle && !selectedVideo.subtitleContent && isSubtitleLoading && (
                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
                                    <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-blue-700">正在加载字幕...</span>
                                </div>
                            )}

                            {/* No Subtitle - Retry Button */}
                            {!selectedVideo.hasSubtitle && selectedVideo.status === 'completed' && (
                                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-yellow-700">
                                        <FileText className="w-4 h-4" />
                                        <span className="text-sm">该视频暂无字幕</span>
                                    </div>
                                    <button
                                        onClick={() => handleRetrySubtitle(selectedVideo.id)}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-yellow-700 border border-yellow-400 rounded hover:bg-yellow-100 transition-colors"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        重新获取字幕
                                    </button>
                                </div>
                            )}

                            {/* Processing Status */}
                            {selectedVideo.status === 'processing' && (
                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
                                    <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-blue-700">正在获取字幕...</span>
                                </div>
                            )}
                        </div>

                        <div className="px-6 py-4 border-t border-border flex items-center justify-between" onClick={(event) => event.stopPropagation()}>
                            <button
                                onClick={() => openYouTube(selectedVideo.videoUrl)}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
                            >
                                <ExternalLink className="w-3.5 h-3.5" />
                                在 YouTube 打开
                            </button>
                            <button
                                onClick={() => handleDeleteVideo(selectedVideo.id)}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                删除视频
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
