import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { Search, Trash2, Image, Heart, MessageCircle, X, ChevronLeft, ChevronRight, Play, FileText, ExternalLink, Download, RefreshCw, Sparkles, Star, BookmarkPlus, FolderPlus, FolderOpen, Plus, Loader2, Users, ArrowDownUp, CheckSquare2, Square, Info, Copy, Check } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import type { PendingChatMessage } from '../features/app-shell/types';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';
import { SAFE_REMARK_PLUGINS } from '../utils/markdownRemarkPlugins';
import { buildRedClawAuthoringMessage } from '../utils/redclawAuthoring';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { formatTimestampDateTime } from '../utils/time';
import { SelectMenu } from '../components/ui/SelectMenu';
import { CaptureJobsBar } from '../features/capture/CaptureJobsBar';
import { APP_BRAND } from '../config/brand';
import {
    Note,
    YouTubeVideo,
    KnowledgeTypeFilter,
    KnowledgeBackendKind,
    KnowledgeSortOrder,
    DocumentKnowledgeSource,
    VisualSemanticBlock,
    KnowledgeCatalogSummary,
    KnowledgeListPageResponse,
    KnowledgeIndexStatus,
    KnowledgeCardItem,
    XhsCommentItem,
    resolveNoteCardKind,
    KnowledgeAuthorView,
    SHOW_WECHAT_KNOWLEDGE_ACTIONS,
    INLINE_TAG_LIMIT,
    KNOWLEDGE_SEARCH_DEBOUNCE_MS,
    KNOWLEDGE_RENDER_BATCH_SIZE,
    isVisualIndexFilePath,
    isNativeFilePickerCanceled,
    resolveKnowledgeBackendKind,
    projectCatalogPage,
    extractKeywords,
    calculateChangeRate,
    orderImages,
    getNoteCoverImage,
    hashContent,
} from '../features/knowledge/knowledgeModel';


const GLOBAL_KNOWLEDGE_SEARCH_EVENT = 'redbox:global-knowledge-search';
const GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY = 'redbox:global-knowledge-search-query';
const KNOWLEDGE_SORT_OPTIONS = [
    { value: 'updated-desc', label: '最新采集' },
    { value: 'created-desc', label: '笔记时间' },
    { value: 'title-asc', label: '标题 A-Z' },
];

interface KnowledgeProps {
    isEmbedded?: boolean;
    isActive?: boolean;
    onNavigateToRedClaw?: (message: PendingChatMessage) => void;
    onTitleBarContentChange?: (content: ReactNode | null) => void;
    referenceContent?: string; // 用于相似度排序的参考内容
}

interface SettingsShape {
    image_model?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    active_space_id?: string;
    visual_index_enabled?: boolean;
}

const BROWSER_PLUGIN_DOWNLOAD_URL = APP_BRAND.downloadUrl || 'https://redbox.ziz.hk/download';

const copyTextWithClipboard = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch {
            return false;
        }
    }
};

function stripVisualProjectionKeywords(text: string): string {
    return text.replace(/\n关键词:[\s\S]*$/u, '').trim();
}

function isVisibleTextEvidence(evidence: NonNullable<VisualSemanticBlock['visualEvidence']>[number]): boolean {
    const kind = String(evidence.kind || '').trim().toLowerCase();
    const id = String(evidence.id || '').trim().toLowerCase();
    const title = String(evidence.title || '').trim().toLowerCase();
    return kind === 'visible_text'
        || id.includes('visible_text')
        || title.includes('visible_text')
        || title.includes('可见文字')
        || title.includes('ocr');
}

function buildVisibleTextBlocksText(blocks?: VisualSemanticBlock[]): string {
    if (!Array.isArray(blocks) || blocks.length === 0) return '';
    const seen = new Set<string>();
    const chunks: string[] = [];
    for (const block of blocks) {
        const evidenceText = (block.visualEvidence || [])
            .filter(isVisibleTextEvidence)
            .map((evidence) => String(evidence.text || '').trim())
            .filter(Boolean)
            .join('\n');
        const fallbackText = block.blockType === 'image.visible_text'
            ? stripVisualProjectionKeywords(String(block.text || '').trim())
            : '';
        const text = (evidenceText || fallbackText).trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const prefix = typeof block.page === 'number' ? `P${block.page} ` : '';
        chunks.push(`${prefix}${text}`);
    }
    return chunks.join('\n\n');
}

function ObsidianIcon({ className }: { className?: string }) {
    return (
        <svg
            role="img"
            aria-label="Obsidian"
            viewBox="0 0 24 24"
            className={className}
            fill="currentColor"
        >
            <path d="M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z" />
        </svg>
    );
}



export function Knowledge({ onNavigateToRedClaw, isEmbedded = false, isActive = true, onTitleBarContentChange, referenceContent }: KnowledgeProps) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [youtubeVideos, setYoutubeVideos] = useState<YouTubeVideo[]>([]);
    const [documentSources, setDocumentSources] = useState<DocumentKnowledgeSource[]>([]);
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);
    const [selectedVideo, setSelectedVideo] = useState<YouTubeVideo | null>(null);
    const [selectedDocumentSource, setSelectedDocumentSource] = useState<DocumentKnowledgeSource | null>(null);
    const [selectedAuthor, setSelectedAuthor] = useState<KnowledgeAuthorView | null>(null);
    const [selectedImageIndex, setSelectedImageIndex] = useState(0);
    const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
    const [selectedTypeFilter, setSelectedTypeFilter] = useState<KnowledgeTypeFilter>('all');
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<Set<string>>(() => new Set());
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const [sortOrder, setSortOrder] = useState<KnowledgeSortOrder>('updated-desc');
    const [visibleItemCount, setVisibleItemCount] = useState(KNOWLEDGE_RENDER_BATCH_SIZE);
    const [isAllTagsDrawerOpen, setIsAllTagsDrawerOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isVisualIndexEnabled, setIsVisualIndexEnabled] = useState(false);
    const [isVisualIndexSettingLoading, setIsVisualIndexSettingLoading] = useState(true);
    const [isVisualIndexSettingSaving, setIsVisualIndexSettingSaving] = useState(false);
    const [showSubtitle, setShowSubtitle] = useState(false);
    const [showTranscript, setShowTranscript] = useState(false);
    const [copiedExtractionId, setCopiedExtractionId] = useState<string | null>(null);
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
        visualIndex: {
            totalUnits: 0,
            indexedUnits: 0,
            metadataOnlyUnits: 0,
            failedUnits: 0,
            retryDeferredUnits: 0,
            retryReadyUnits: 0,
            lastAttemptedAt: null,
        },
        pendingCount: 0,
        failedCount: 0,
        rebuildProgress: null,
        lastIndexedAt: null,
        isBuilding: false,
        lastError: null,
        migrationStatus: null,
        pendingRebuildReason: null,
    });
    const wasActiveRef = useRef<boolean>(isActive);
    const embeddedViewportRef = useRef<HTMLDivElement>(null);
    const selectedNoteVideoRef = useRef<HTMLVideoElement>(null);
    const allTagsDrawerRef = useRef<HTMLDivElement>(null);
    const notesRef = useRef<Note[]>([]);
    const youtubeVideosRef = useRef<YouTubeVideo[]>([]);
    const documentSourcesRef = useRef<DocumentKnowledgeSource[]>([]);
    const nextCursorRef = useRef<string | null>(null);
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
    const hasKnowledgeSnapshotRef = useRef(false);
    const loadAllKnowledgeRequestRef = useRef(0);
    const loadDetailRequestRef = useRef(0);

    // 搜索框状态
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const applyGlobalKnowledgeSearch = useCallback((query: string) => {
        setIsSearchOpen(true);
        setSearchQuery(query);
        setDebouncedSearchQuery(query.trim());
        setTimeout(() => searchInputRef.current?.focus(), 50);
    }, []);

    useEffect(() => {
        const handleGlobalSearch = (event: Event) => {
            const query = (event as CustomEvent<{ query?: string }>).detail?.query || '';
            applyGlobalKnowledgeSearch(query);
        };

        window.addEventListener(GLOBAL_KNOWLEDGE_SEARCH_EVENT, handleGlobalSearch);
        if (isActive) {
            const pendingQuery = window.sessionStorage.getItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY);
            if (pendingQuery !== null) {
                window.sessionStorage.removeItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY);
                applyGlobalKnowledgeSearch(pendingQuery);
            }
        }
        return () => window.removeEventListener(GLOBAL_KNOWLEDGE_SEARCH_EVENT, handleGlobalSearch);
    }, [applyGlobalKnowledgeSearch, isActive]);

    useEffect(() => {
        notesRef.current = notes;
    }, [notes]);

    useEffect(() => {
        youtubeVideosRef.current = youtubeVideos;
    }, [youtubeVideos]);

    useEffect(() => {
        documentSourcesRef.current = documentSources;
    }, [documentSources]);

    useEffect(() => {
        nextCursorRef.current = nextCursor;
    }, [nextCursor]);

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
                setDebouncedSearchQuery('');
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

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            setDebouncedSearchQuery(searchQuery.trim());
        }, KNOWLEDGE_SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timeout);
    }, [searchQuery]);

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

        // 内容变化了，保持旧排序，仅显示加载状态，防止渲染闪烁与列表突变
        console.log('[Knowledge] Content changed, recalculating similarity order...');
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

    const buildNoteKnowledgeReference = useCallback((note: Note): NonNullable<PendingChatMessage['knowledgeReferences']>[number] => ({
        id: note.id,
        title: note.title || '未命名笔记',
        sourceKind: 'redbook-note',
        summary: note.excerpt || note.visualSearchSummary || note.content?.slice(0, 180),
        cover: note.cover || note.images?.[0] || note.visualSearchThumbnailPath,
        sourceUrl: note.sourceUrl || note.videoUrl,
        folderPath: note.folderPath,
        tags: note.tags,
        updatedAt: note.updatedAt || note.createdAt,
        hasTranscript: Boolean(note.transcript),
    }), []);

    const buildVideoKnowledgeReference = useCallback((video: YouTubeVideo): NonNullable<PendingChatMessage['knowledgeReferences']>[number] => ({
        id: video.id,
        title: video.title || '未命名视频',
        sourceKind: 'youtube-video',
        summary: video.summary || video.description?.slice(0, 180),
        cover: video.thumbnailUrl || video.visualSearchThumbnailPath,
        sourceUrl: video.videoUrl,
        folderPath: video.folderPath,
        updatedAt: video.updatedAt || video.createdAt,
        hasTranscript: Boolean(video.subtitleContent),
    }), []);

    const navigateToRedClawWithKnowledge = useCallback((message: PendingChatMessage) => {
        if (!onNavigateToRedClaw) {
            void appAlert(`${APP_BRAND.aiDisplayName} 页面暂不可用，请稍后重试。`, { title: `无法打开 ${APP_BRAND.aiDisplayName}` });
            return;
        }
        onNavigateToRedClaw(message);
    }, [onNavigateToRedClaw]);

    const openNoteInRedClaw = useCallback((note: Note) => {
        navigateToRedClawWithKnowledge({
            content: '',
            sessionRouting: 'current',
            deliveryMode: 'draft',
            knowledgeReferences: [buildNoteKnowledgeReference(note)],
        });
    }, [buildNoteKnowledgeReference, navigateToRedClawWithKnowledge]);

    const openVideoInRedClaw = useCallback((video: YouTubeVideo) => {
        navigateToRedClawWithKnowledge({
            content: '',
            sessionRouting: 'current',
            deliveryMode: 'draft',
            knowledgeReferences: [buildVideoKnowledgeReference(video)],
        });
    }, [buildVideoKnowledgeReference, navigateToRedClawWithKnowledge]);

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

    const handleCopyExtractionText = useCallback(async (copyId: string, text: string) => {
        const normalizedText = text.trim();
        if (!normalizedText) return;
        const ok = await copyTextWithClipboard(normalizedText);
        if (!ok) {
            void appAlert('复制失败，请手动选择文本复制。');
            return;
        }
        setCopiedExtractionId(copyId);
        window.setTimeout(() => {
            setCopiedExtractionId((current) => current === copyId ? null : current);
        }, 1400);
    }, []);

    const refreshIndexStatus = useCallback(async () => {
        try {
            const status = await window.ipcRenderer.knowledge.getIndexStatus<KnowledgeIndexStatus>();
            setIndexStatus(status);
        } catch (error) {
            console.error('Failed to load knowledge index status:', error);
        }
    }, []);

    const loadVisualIndexSetting = useCallback(async () => {
        try {
            const settings = await window.ipcRenderer.getSettings() as SettingsShape | undefined;
            setIsVisualIndexEnabled(Boolean(settings?.visual_index_enabled));
        } catch (error) {
            console.error('Failed to load visual index setting:', error);
        } finally {
            setIsVisualIndexSettingLoading(false);
        }
    }, []);

    const handleToggleVisualIndex = useCallback(async () => {
        if (isVisualIndexSettingSaving) return;
        const nextEnabled = !isVisualIndexEnabled;
        setIsVisualIndexEnabled(nextEnabled);
        setIsVisualIndexSettingSaving(true);
        try {
            await window.ipcRenderer.saveSettings({ visual_index_enabled: nextEnabled });
            await refreshIndexStatus();
        } catch (error) {
            console.error('Failed to save visual index setting:', error);
            setIsVisualIndexEnabled(!nextEnabled);
            void appAlert('图像理解索引设置保存失败');
        } finally {
            setIsVisualIndexSettingSaving(false);
            setIsVisualIndexSettingLoading(false);
        }
    }, [isVisualIndexEnabled, isVisualIndexSettingSaving, refreshIndexStatus]);

    const applyCatalogPage = useCallback((items: KnowledgeCatalogSummary[], append: boolean) => {
        const { notes: nextNotes, videos: nextVideos, docs: nextDocs } = projectCatalogPage(items);
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
                cursor: reset ? null : nextCursorRef.current,
                limit: 200,
                kind: resolveKnowledgeBackendKind(selectedTypeFilter),
                typeFilter: selectedTypeFilter === 'all' ? undefined : selectedTypeFilter,
                query: debouncedSearchQuery || undefined,
                sort: sortOrder,
            });
            if (requestId !== loadAllKnowledgeRequestRef.current) return;
            const pageItems = Array.isArray(response?.items) ? response.items : [];
            applyCatalogPage(pageItems, !reset);
            const nextCursorValue = typeof response?.nextCursor === 'string' ? response.nextCursor : null;
            nextCursorRef.current = nextCursorValue;
            setNextCursor(nextCursorValue);
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
    }, [applyCatalogPage, debouncedSearchQuery, hasKnowledgeDataSnapshot, selectedTypeFilter, sortOrder]);

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

    const loadKnowledgeDetail = useCallback(async (itemId: string, kind: string) => {
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
        setShowTranscript(false);
        setSelectedNote(note);
        const detail = await loadKnowledgeDetail(note.id, note.knowledgeKind || note.captureKind || 'redbook-note');
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

    const openDocumentDetail = useCallback(async (source: DocumentKnowledgeSource) => {
        setSelectedDocumentSource(source);
        const detail = await loadKnowledgeDetail(source.id, 'document-source');
        if (detail && loadDetailRequestRef.current > 0) {
            setSelectedDocumentSource({
                ...source,
                ...(detail as unknown as Partial<DocumentKnowledgeSource>),
            });
        }
    }, [loadKnowledgeDetail]);

    const openAuthorProfile = useCallback((note: Note) => {
        const name = (note.author || '').trim();
        if (!name || name === '原文链接' || name === '手动导入' || name === '文本摘录') return;
        setSelectedNote(null);
        setSelectedAuthor({
            id: note.authorId,
            name,
            profileUrl: note.authorUrl,
            avatarUrl: note.authorAvatarUrl,
            description: note.authorDescription,
        });
    }, []);

    useEffect(() => {
        void loadAllKnowledge();
    }, [loadAllKnowledge]);

    useEffect(() => {
        void loadVisualIndexSetting();
        const handleSettingsUpdated = () => {
            void loadVisualIndexSetting();
        };
        window.ipcRenderer.onSettingsUpdated(handleSettingsUpdated);
        return () => {
            window.ipcRenderer.offSettingsUpdated(handleSettingsUpdated);
        };
    }, [loadVisualIndexSetting]);

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

        window.ipcRenderer.knowledge.onYoutubeVideoUpdated(handleVideoUpdated);
        window.ipcRenderer.knowledge.onNewYoutubeVideo(handleNewVideo);
        window.ipcRenderer.knowledge.onChanged(handleKnowledgeChanged);
        window.ipcRenderer.knowledge.onCatalogUpdated(handleKnowledgeChanged);

        return () => {
            window.ipcRenderer.knowledge.offYoutubeVideoUpdated(handleVideoUpdated);
            window.ipcRenderer.knowledge.offNewYoutubeVideo(handleNewVideo);
            window.ipcRenderer.knowledge.offChanged(handleKnowledgeChanged);
            window.ipcRenderer.knowledge.offCatalogUpdated(handleKnowledgeChanged);
        };
    }, [loadAllKnowledge, loadYoutubeVideos, refreshIndexStatus]);

    useEffect(() => {
        const handleDocsUpdated = () => {
            void Promise.all([refreshIndexStatus(), loadDocumentSources()]);
        };
        window.ipcRenderer.knowledge.onDocsUpdated(handleDocsUpdated);
        return () => {
            window.ipcRenderer.knowledge.offDocsUpdated(handleDocsUpdated);
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

    const knowledgeItems = useMemo<KnowledgeCardItem[]>(() => {
        const noteItems: KnowledgeCardItem[] = notes.map((note) => {
            const orderedImages = orderImages(note.images || []);
            const kind = resolveNoteCardKind(note);

            return {
                id: note.id,
                kind,
                title: note.title || '未命名内容',
                summary: note.excerpt || note.content || note.sourceUrl || '',
                createdAt: note.createdAt,
                updatedAt: note.updatedAt || note.createdAt,
                searchText: [
                    note.title,
                    note.author,
                    note.authorUrl,
                    note.siteName,
                    note.excerpt,
                    note.sourceUrl,
                    ...(note.tags || []),
                ].join('\n').toLowerCase(),
                cover: note.cover || orderedImages[0] || note.video || '',
                coverImage: note.cover || orderedImages[0] || '',
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
            updatedAt: video.updatedAt || video.createdAt,
            searchText: [video.title, video.originalTitle, video.summary, video.description, video.videoUrl].join('\n').toLowerCase(),
            cover: video.thumbnailUrl || '',
            coverImage: video.thumbnailUrl || '',
            tags: [],
            video,
        }));

        const docItems: KnowledgeCardItem[] = documentSources.map((doc) => ({
            id: doc.id,
            kind: 'docs',
            title: doc.name,
            summary: doc.rootPath,
            createdAt: doc.updatedAt || doc.createdAt,
            updatedAt: doc.updatedAt || doc.createdAt,
            searchText: [doc.name, doc.rootPath, ...doc.sampleFiles].join('\n').toLowerCase(),
            coverImage: '',
            tags: [],
            doc,
        }));

        return [...noteItems, ...videoItems, ...docItems];
    }, [notes, youtubeVideos, documentSources]);

    const selectedAuthorNotes = useMemo(() => {
        if (!selectedAuthor) return [];
        return notes.filter((note) => {
            if (selectedAuthor.id && note.authorId === selectedAuthor.id) return true;
            return (note.author || '').trim() === selectedAuthor.name;
        });
    }, [notes, selectedAuthor]);

    const typeFilters = useMemo(() => {
        const counts: Record<Exclude<KnowledgeTypeFilter, 'all'>, number> = {
            'xhs-image': Number(kindCounts['xhs-image'] || 0),
            'xhs-video': Number(kindCounts['xhs-video'] || 0),
            'xhs-blogger': Number(kindCounts['xhs-blogger'] || 0),
            'xhs-comments': Number(kindCounts['xhs-comments'] || 0),
            'douyin-video': Number(kindCounts['douyin-video'] || 0),
            'bilibili': Number(kindCounts.bilibili || 0),
            'kuaishou': Number(kindCounts.kuaishou || 0),
            'tiktok': Number(kindCounts.tiktok || 0),
            'reddit': Number(kindCounts.reddit || 0),
            'x': Number(kindCounts.x || 0),
            'instagram': Number(kindCounts.instagram || 0),
            'link-article': Number(kindCounts['link-article'] || 0),
            'wechat-article': Number(kindCounts['wechat-article'] || 0),
            'zhihu-answer': Number(kindCounts['zhihu-answer'] || 0),
            'zhihu-article': Number(kindCounts['zhihu-article'] || 0),
            'youtube': Number(kindCounts.youtube || kindCounts['youtube-video'] || 0),
            'docs': Number(kindCounts.docs || kindCounts['document-source'] || 0),
        };
        const totalCount = Number(kindCounts.all || knowledgeItems.length);
        return [
            { key: 'all' as const, label: '全部', count: totalCount },
            { key: 'xhs-image' as const, label: '小红书图文', count: counts['xhs-image'] },
            { key: 'xhs-video' as const, label: '小红书视频', count: counts['xhs-video'] },
            { key: 'xhs-blogger' as const, label: '小红书博主', count: counts['xhs-blogger'] },
            { key: 'xhs-comments' as const, label: '小红书评论', count: counts['xhs-comments'] },
            { key: 'douyin-video' as const, label: '抖音视频', count: counts['douyin-video'] },
            { key: 'bilibili' as const, label: 'Bilibili', count: counts.bilibili },
            { key: 'kuaishou' as const, label: '快手', count: counts.kuaishou },
            { key: 'tiktok' as const, label: 'TikTok', count: counts.tiktok },
            { key: 'reddit' as const, label: 'Reddit', count: counts.reddit },
            { key: 'x' as const, label: 'X', count: counts.x },
            { key: 'instagram' as const, label: 'Instagram', count: counts.instagram },
            { key: 'link-article' as const, label: '链接文章', count: counts['link-article'] },
            { key: 'zhihu-answer' as const, label: '知乎回答', count: counts['zhihu-answer'] },
            { key: 'zhihu-article' as const, label: '知乎文章', count: counts['zhihu-article'] },
            ...(SHOW_WECHAT_KNOWLEDGE_ACTIONS ? [{ key: 'wechat-article' as const, label: '公众号文章', count: counts['wechat-article'] }] : []),
            { key: 'youtube' as const, label: 'YouTube', count: counts.youtube },
            { key: 'docs' as const, label: '文档', count: counts.docs },
        ].filter((item) => item.key === 'all' || item.count > 0);
    }, [kindCounts, knowledgeItems.length]);

    const youtubeSummaryPendingCount = useMemo(() => {
        return youtubeVideos.filter((video) => video.hasSubtitle && !String(video.summary || '').trim()).length;
    }, [youtubeVideos]);

    const getSortTimestamp = (value: string | undefined) => {
        const timestamp = new Date(value || '').getTime();
        return Number.isFinite(timestamp) ? timestamp : 0;
    };

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
                return getSortTimestamp(b.updatedAt) - getSortTimestamp(a.updatedAt);
            });
        }

        return [...filtered].sort((a, b) => {
            if (sortOrder === 'created-desc') {
                return getSortTimestamp(b.createdAt) - getSortTimestamp(a.createdAt);
            }
            if (sortOrder === 'title-asc') {
                return a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
            }
            return getSortTimestamp(b.updatedAt) - getSortTimestamp(a.updatedAt);
        });
    }, [knowledgeItems, selectedTypeFilter, selectedTag, similarityOrder, sortOrder]);

    const visibleKnowledgeItems = useMemo(() => {
        return filteredKnowledgeItems.slice(0, visibleItemCount);
    }, [filteredKnowledgeItems, visibleItemCount]);
    const selectedKnowledgeItems = useMemo(() => (
        knowledgeItems.filter((item) => selectedKnowledgeIds.has(`${item.kind}:${item.id}`))
    ), [knowledgeItems, selectedKnowledgeIds]);
    const selectedVisibleKnowledgeCount = useMemo(() => (
        visibleKnowledgeItems.filter((item) => selectedKnowledgeIds.has(`${item.kind}:${item.id}`)).length
    ), [selectedKnowledgeIds, visibleKnowledgeItems]);
    const allVisibleKnowledgeSelected = visibleKnowledgeItems.length > 0
        && selectedVisibleKnowledgeCount === visibleKnowledgeItems.length;

    useEffect(() => {
        setVisibleItemCount(KNOWLEDGE_RENDER_BATCH_SIZE);
    }, [debouncedSearchQuery, selectedTypeFilter, selectedTag, sortOrder]);

    const hasMoreRenderedItems = visibleKnowledgeItems.length < filteredKnowledgeItems.length;
    const isKnowledgeLibraryEmpty = knowledgeItems.length === 0;
    const isIndexingInProgress = indexStatus.isBuilding
        || indexStatus.pendingCount > 0
        || (typeof indexStatus.rebuildProgress === 'number' && indexStatus.rebuildProgress < 1)
        || Boolean(indexStatus.migrationStatus)
        || Boolean(indexStatus.pendingRebuildReason);

    useEffect(() => {
        const trigger = loadMoreTriggerRef.current;
        const root = embeddedViewportRef.current;
        if (!trigger || !root || (!hasMoreRenderedItems && !nextCursor) || isLoadingMore) return;
        if (typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            if (hasMoreRenderedItems) {
                setVisibleItemCount((prev) => prev + KNOWLEDGE_RENDER_BATCH_SIZE);
                return;
            }
            void loadMoreKnowledge();
        }, {
            root,
            rootMargin: '720px 0px',
            threshold: 0,
        });

        observer.observe(trigger);
        return () => observer.disconnect();
    }, [hasMoreRenderedItems, isLoadingMore, loadMoreKnowledge, nextCursor, visibleKnowledgeItems.length]);

    const resolveCoverAspectClass = (kind: KnowledgeCardItem['kind']) => {
        if (kind === 'link-article' || kind === 'wechat-article' || kind === 'zhihu-answer' || kind === 'zhihu-article') {
            return 'aspect-[4/3]';
        }
        return 'aspect-[3/4]';
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
        window.ipcRenderer.knowledge.onNoteUpdated(handleNoteUpdated);
        return () => {
            window.ipcRenderer.knowledge.offNoteUpdated(handleNoteUpdated);
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

    const toggleKnowledgeSelection = useCallback((item: KnowledgeCardItem) => {
        const key = `${item.kind}:${item.id}`;
        setSelectedKnowledgeIds((current) => {
            const next = new Set(current);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

    const toggleVisibleKnowledgeSelection = useCallback(() => {
        setSelectedKnowledgeIds((current) => {
            const next = new Set(current);
            if (allVisibleKnowledgeSelected) {
                visibleKnowledgeItems.forEach((item) => next.delete(`${item.kind}:${item.id}`));
            } else {
                visibleKnowledgeItems.forEach((item) => next.add(`${item.kind}:${item.id}`));
            }
            return next;
        });
    }, [allVisibleKnowledgeSelected, visibleKnowledgeItems]);

    const clearKnowledgeSelection = useCallback(() => {
        setSelectedKnowledgeIds(new Set());
    }, []);

    const handleBatchDeleteKnowledge = useCallback(async () => {
        if (selectedKnowledgeItems.length === 0 || isBatchDeleting) return;
        if (!(await appConfirm(`确定要删除已选的 ${selectedKnowledgeItems.length} 条知识吗？`, { title: '批量删除', confirmLabel: '删除', tone: 'danger' }))) return;
        setIsBatchDeleting(true);
        try {
            const deleteItems = selectedKnowledgeItems.map((item) => ({
                id: item.id,
                kind: item.kind === 'youtube'
                    ? 'youtube-video' as const
                    : item.kind === 'docs'
                        ? 'document-source' as const
                        : (item.note?.knowledgeKind || 'redbook-note') as KnowledgeBackendKind,
            }));
            const result = await window.ipcRenderer.knowledge.deleteBatch({ items: deleteItems }) as {
                success?: boolean;
                deleted?: number;
                failed?: number;
                results?: Array<{ id?: string; kind?: string; success?: boolean; error?: string }>;
                error?: string;
            };
            const successKeys = new Set((result.results || [])
                .filter((item) => item.success)
                .map((item) => {
                    if (item.kind === 'youtube-video') return `youtube:${item.id}`;
                    if (item.kind === 'document-source') return `docs:${item.id}`;
                    const selected = selectedKnowledgeItems.find((candidate) => candidate.id === item.id);
                    return selected ? `${selected.kind}:${item.id}` : `xhs-image:${item.id}`;
                }));
            const deletedNoteIds = new Set((result.results || [])
                .filter((item) => item.success && item.kind !== 'youtube-video' && item.kind !== 'document-source')
                .map((item) => item.id)
                .filter(Boolean));
            const deletedYoutubeIds = new Set((result.results || [])
                .filter((item) => item.success && item.kind === 'youtube-video')
                .map((item) => item.id)
                .filter(Boolean));
            const deletedDocSourceIds = new Set((result.results || [])
                .filter((item) => item.success && item.kind === 'document-source')
                .map((item) => item.id)
                .filter(Boolean));
            setNotes((prev) => prev.filter((note) => !deletedNoteIds.has(note.id)));
            setYoutubeVideos((prev) => prev.filter((video) => !deletedYoutubeIds.has(video.id)));
            setDocumentSources((prev) => prev.filter((source) => !deletedDocSourceIds.has(source.id)));
            setSelectedNote((prev) => prev && deletedNoteIds.has(prev.id) ? null : prev);
            setSelectedVideo((prev) => prev && deletedYoutubeIds.has(prev.id) ? null : prev);
            setSelectedDocumentSource((prev) => prev && deletedDocSourceIds.has(prev.id) ? null : prev);
            setSelectedKnowledgeIds((current) => {
                const next = new Set(current);
                successKeys.forEach((key) => next.delete(key));
                selectedKnowledgeItems.forEach((item) => {
                    if (
                        (item.kind === 'youtube' && deletedYoutubeIds.has(item.id))
                        || (item.kind === 'docs' && deletedDocSourceIds.has(item.id))
                        || (item.kind !== 'youtube' && item.kind !== 'docs' && deletedNoteIds.has(item.id))
                    ) {
                        next.delete(`${item.kind}:${item.id}`);
                    }
                });
                return next;
            });
            void refreshIndexStatus();
            if (!result?.success && result?.failed) {
                void appAlert(`已删除 ${result.deleted || 0} 条，${result.failed || 0} 条失败`);
            }
        } catch (error) {
            console.error('Failed to batch delete knowledge:', error);
            void appAlert('批量删除失败');
        } finally {
            setIsBatchDeleting(false);
        }
    }, [isBatchDeleting, refreshIndexStatus, selectedKnowledgeItems]);

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
                    quality: String(
                        settings?.image_quality === 'low' || settings?.image_quality === 'medium' || settings?.image_quality === 'high'
                            ? settings.image_quality
                            : 'medium',
                    ),
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
            if (isNativeFilePickerCanceled(result?.error)) return;
            void appAlert(result?.error || '添加文件失败');
            return;
        }
        await loadAllKnowledge();
    };

    const handleAddDocumentFolder = async () => {
        const result = await window.ipcRenderer.knowledge.addDocFolder() as { success?: boolean; error?: string };
        if (!result?.success) {
            if (isNativeFilePickerCanceled(result?.error)) return;
            void appAlert(result?.error || '添加文件夹失败');
            return;
        }
        await loadDocumentSources();
    };

    const handleAddObsidianVault = async () => {
        const result = await window.ipcRenderer.knowledge.addObsidianVault() as { success?: boolean; error?: string };
        if (!result?.success) {
            if (isNativeFilePickerCanceled(result?.error)) return;
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

    const renderAuthorInline = (note: Note, className: string) => {
        const label = note.author || 'SOURCE';
        const canOpen = Boolean(note.author && !['原文链接', '手动导入', '文本摘录'].includes(note.author));
        if (!canOpen) {
            return <span className={className}>{label}</span>;
        }
        return (
            <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                    event.stopPropagation();
                    openAuthorProfile(note);
                }}
                onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    openAuthorProfile(note);
                }}
                className={clsx(className, 'cursor-pointer hover:text-accent-primary hover:underline underline-offset-2')}
            >
                {label}
            </span>
        );
    };

    const getKnowledgeKindLabel = (kind: KnowledgeCardItem['kind']) => {
        switch (kind) {
            case 'xhs-image':
                return '小红书图文';
            case 'xhs-video':
                return '小红书视频';
            case 'xhs-blogger':
                return '小红书博主';
            case 'xhs-comments':
                return '小红书评论';
            case 'douyin-video':
                return '抖音视频';
            case 'bilibili':
                return 'Bilibili';
            case 'kuaishou':
                return '快手';
            case 'tiktok':
                return 'TikTok';
            case 'reddit':
                return 'Reddit';
            case 'x':
                return 'X';
            case 'instagram':
                return 'Instagram';
            case 'link-article':
                return '链接文章';
            case 'wechat-article':
                return '公众号文章';
            case 'zhihu-answer':
                return '知乎回答';
            case 'zhihu-article':
                return '知乎文章';
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
            case 'xhs-blogger':
                return 'bg-pink-600/90 text-white';
            case 'xhs-comments':
                return 'bg-rose-400/90 text-white';
            case 'douyin-video':
                return 'bg-neutral-900 text-white';
            case 'bilibili':
                return 'bg-sky-500/90 text-white';
            case 'kuaishou':
                return 'bg-orange-500/90 text-white';
            case 'tiktok':
                return 'bg-neutral-900 text-white';
            case 'reddit':
                return 'bg-orange-600/90 text-white';
            case 'x':
                return 'bg-slate-900 text-white';
            case 'instagram':
                return 'bg-fuchsia-600/90 text-white';
            case 'link-article':
                return 'bg-sky-500/90 text-white';
            case 'wechat-article':
                return 'bg-emerald-500/90 text-white';
            case 'zhihu-answer':
                return 'bg-blue-500/90 text-white';
            case 'zhihu-article':
                return 'bg-blue-500/90 text-white';
            case 'youtube':
                return 'bg-red-600/90 text-white';
            case 'docs':
                return 'bg-emerald-500/90 text-white';
            default:
                return 'bg-surface-tertiary text-text-primary';
        }
    };

    const renderNoteBody = (note: Note) => {
        const isMarkdownArticle = (note.type === 'link-article' || note.captureKind === 'zhihu-answer' || note.captureKind === 'zhihu-article') && note.captureKind !== 'wechat-article';
        if (isMarkdownArticle) {
            return (
                <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                    <article className="prose prose-sm max-w-none prose-headings:text-text-primary prose-p:text-text-primary prose-li:text-text-primary prose-strong:text-text-primary prose-a:text-sky-700 prose-pre:bg-slate-900 prose-pre:text-slate-100 prose-code:text-rose-700">
                        <ReactMarkdown remarkPlugins={SAFE_REMARK_PLUGINS}>
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

    const isXiaohongshuNoteDetail = (note: Note) => {
        const kind = `${note.captureKind || ''} ${note.type || ''} ${note.knowledgeKind || ''}`;
        if (note.captureKind === 'xhs-blogger' || note.captureKind === 'xhs-comments') return false;
        return kind.includes('xhs') || (note.siteName || '').includes('xiaohongshu.com');
    };

    const formatCompactCount = (value?: number | null) => {
        const number = Number(value || 0);
        if (!Number.isFinite(number) || number <= 0) return '0';
        if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1).replace(/\.0$/, '')}万`;
        return String(number);
    };

    const getXhsTags = (note: Note) => {
        const fromTags = Array.isArray(note.tags) ? note.tags : [];
        const fromText = Array.from((note.content || '').matchAll(/#[^\s#，,。.！!？?\n]+/g)).map((match) => match[0].replace(/^#/, ''));
        return Array.from(new Set([...fromTags, ...fromText].map((tag) => String(tag || '').trim()).filter(Boolean)))
            .filter((tag) => tag !== '小红书')
            .slice(0, 12);
    };

    const renderXhsCommentContent = (comment: XhsCommentItem) => {
        const segments = Array.isArray(comment.content?.segments) ? comment.content?.segments || [] : [];
        if (segments.length > 0) {
            return (
                <span>
                    {segments.map((segment, index) => {
                        const type = String(segment.type || '');
                        if (type === 'emoji') {
                            const url = String(segment.url || '');
                            if (!url) return null;
                            return (
                                <img
                                    key={`${comment.id || 'comment'}-segment-${index}`}
                                    src={resolveAssetUrl(url)}
                                    alt=""
                                    className="mx-0.5 inline-block h-5 w-5 align-[-4px]"
                                />
                            );
                        }
                        return <span key={`${comment.id || 'comment'}-segment-${index}`}>{String(segment.text || '')}</span>;
                    })}
                </span>
            );
        }
        return <span>{comment.content?.text || ''}</span>;
    };

    const renderXhsComment = (comment: XhsCommentItem, index: number) => {
        const authorName = comment.author?.nickname || '小红书用户';
        const avatarUrl = comment.author?.avatarUrl || '';
        const level = Number(comment.level || 0);
        return (
            <div key={comment.id || comment.platformCommentId || `${authorName}-${index}`} className={clsx('flex gap-3', level > 0 && 'ml-10')}>
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-black/[0.04] ring-1 ring-black/[0.04]">
                    {avatarUrl ? (
                        <img src={resolveAssetUrl(avatarUrl)} alt={authorName} className="h-full w-full object-cover" />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center text-[11px] font-bold text-text-tertiary">
                            {authorName.slice(0, 1)}
                        </div>
                    )}
                </div>
                <div className="min-w-0 flex-1 pb-5">
                    <div className="flex items-center gap-3">
                        <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[14px] font-medium text-text-tertiary">{authorName}</span>
                            {comment.author?.isNoteAuthor && (
                                <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-bold text-text-tertiary">作者</span>
                            )}
                        </div>
                    </div>
                    <div className="mt-1 text-[15px] leading-relaxed text-text-primary">
                        {renderXhsCommentContent(comment)}
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-[12px] font-medium text-text-tertiary">
                        {comment.time?.display && <span>{comment.time.display}</span>}
                        {comment.location && <span>{comment.location}</span>}
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-[12px] font-semibold text-text-secondary">
                        <span className="inline-flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{comment.metrics?.likes ? formatCompactCount(comment.metrics.likes) : '赞'}</span>
                        <span className="inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{comment.metrics?.replies ? formatCompactCount(comment.metrics.replies) : '回复'}</span>
                    </div>
                </div>
            </div>
        );
    };

    const renderKnowledgeExtractionFoldout = (note: Note, compact = false) => {
        const transcript = String(note.transcript || '').trim();
        const ocrText = transcript ? '' : buildVisibleTextBlocksText(note.visualBlocks);
        const contentText = transcript || ocrText;
        if (!contentText && !note.video) return null;
        const isCurrentNoteTranscribing = isTranscribing && selectedNote?.id === note.id;
        const isProcessing = note.transcriptionStatus === 'processing' || isCurrentNoteTranscribing;
        const isFailed = note.transcriptionStatus === 'failed' && !transcript;
        const title = transcript ? '转录内容' : ocrText ? 'OCR内容' : '转录内容';
        const statusLabel = contentText
            ? `${title}已生成`
            : isProcessing ? '转录中' : isFailed ? '转录失败' : '等待转录';
        const Icon = transcript || note.video ? FileText : Image;
        const canTranscribe = Boolean(note.video && !transcript);
        const copyId = `${note.id}:${transcript ? 'transcript' : 'ocr'}`;
        const isCopied = copiedExtractionId === copyId;

        return (
            <div className={clsx(
                'overflow-hidden rounded-2xl border bg-black/[0.02]',
                compact ? 'border-black/[0.06]' : 'border-black/[0.03]',
            )}>
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                    <button
                        type="button"
                        onClick={() => contentText && setShowTranscript(!showTranscript)}
                        disabled={!contentText}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left disabled:cursor-default"
                    >
                        <span className="min-w-0">
                            <span className={clsx(
                                'flex items-center gap-2 font-extrabold text-text-primary',
                                compact ? 'text-[13px]' : 'text-[14px]',
                            )}>
                                <Icon className="h-4 w-4 text-accent-primary" />
                                {title}
                            </span>
                            <span className="mt-1 block text-[12px] font-medium text-text-tertiary">{statusLabel}</span>
                        </span>
                        {contentText && (
                            <ChevronRight className={clsx(
                                'h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-300',
                                showTranscript && 'rotate-90 text-accent-primary',
                            )} />
                        )}
                    </button>
                    {contentText && (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                void handleCopyExtractionText(copyId, contentText);
                            }}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-black/[0.06] bg-white text-text-secondary transition hover:bg-black/[0.03] hover:text-text-primary"
                            title={isCopied ? '已复制' : `复制${title}`}
                            aria-label={isCopied ? '已复制' : `复制${title}`}
                        >
                            {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                    )}
                    {canTranscribe && (
                        <button
                            type="button"
                            onClick={() => handleTranscribeNote(note.id)}
                            disabled={isProcessing}
                            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/[0.06] bg-white px-3 text-[12px] font-bold text-text-secondary transition hover:bg-black/[0.03] hover:text-text-primary disabled:opacity-45"
                        >
                            {isProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            {isFailed ? '重试' : isProcessing ? '处理中' : '开始'}
                        </button>
                    )}
                </div>
                {contentText && showTranscript && (
                    <div className={clsx('px-4 pb-4 animate-in slide-in-from-top-2 duration-300', compact ? 'pt-0' : 'pt-1')}>
                        <pre className={clsx(
                            'overflow-auto whitespace-pre-wrap rounded-xl bg-white font-sans leading-relaxed text-text-secondary ring-1 ring-black/[0.04] custom-scrollbar',
                            compact ? 'max-h-[240px] px-3 py-3 text-[13px]' : 'max-h-[400px] p-5 text-[13px]',
                        )}>
                            {contentText}
                        </pre>
                    </div>
                )}
                {!contentText && isFailed && (
                    <div className="px-4 pb-4 text-[12px] font-medium text-rose-600">转录没有完成，可以重试。</div>
                )}
            </div>
        );
    };

    const renderXhsNoteDetail = (note: Note) => {
        const images = orderImages(note.images || []);
        const currentImage = images[selectedImageIndex] || getNoteCoverImage(note) || note.cover || '';
        const comments = note.xhsComments?.comments || [];
        const totalComments = note.xhsComments?.total || note.stats?.comments || comments.length;
        const tags = getXhsTags(note);
        const hasMedia = Boolean(note.video || currentImage);
        return (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[4px] animate-in fade-in duration-200"
                onClick={() => setSelectedNote(null)}
            >
                <div
                    className="relative mx-4 grid h-[86vh] w-full max-w-[1060px] grid-cols-[minmax(0,1fr)_380px] overflow-hidden rounded-[22px] bg-white shadow-[0_42px_120px_-30px_rgba(0,0,0,0.55)] ring-1 ring-black/10 max-[980px]:h-[90vh] max-[980px]:max-w-[560px] max-[980px]:grid-cols-1"
                    onClick={(event) => event.stopPropagation()}
                >
                    <button
                        onClick={() => setSelectedNote(null)}
                        className="absolute right-4 top-4 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-black/5 text-text-secondary backdrop-blur hover:bg-black/10 hover:text-text-primary transition-all active:scale-95"
                        aria-label="关闭"
                    >
                        <X className="h-5 w-5" />
                    </button>

                    <div className="relative flex min-h-0 items-center justify-center bg-[#f8f8f8] max-[980px]:hidden">
                        {note.video ? (
                            <div className="relative flex h-full w-full items-center justify-center">
                                {isSelectedNoteVideoPlaying || !getNoteCoverImage(note) ? (
                                    <video
                                        ref={selectedNoteVideoRef}
                                        src={resolveAssetUrl(note.video)}
                                        className="max-h-full max-w-full object-contain"
                                        controls
                                        autoPlay
                                        playsInline
                                        preload="metadata"
                                    />
                                ) : (
                                    <button type="button" onClick={() => setIsSelectedNoteVideoPlaying(true)} className="group relative h-full w-full">
                                        <img src={resolveAssetUrl(getNoteCoverImage(note))} alt={note.title} className="h-full w-full object-contain" />
                                        <div className="absolute inset-0 bg-black/10 group-hover:bg-black/25 transition-colors" />
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/25 text-white shadow-2xl ring-1 ring-white/40 backdrop-blur-md">
                                                <Play className="ml-1 h-8 w-8 fill-current" />
                                            </div>
                                        </div>
                                    </button>
                                )}
                            </div>
                        ) : hasMedia ? (
                            <img
                                src={resolveAssetUrl(currentImage)}
                                alt={note.title}
                                className="max-h-full max-w-full cursor-zoom-in object-contain"
                                onClick={() => setIsImagePreviewOpen(true)}
                            />
                        ) : (
                            <div className="text-sm font-semibold text-text-tertiary">No media</div>
                        )}

                        {images.length > 1 && !note.video && (
                            <>
                                <button
                                    onClick={() => setSelectedImageIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1))}
                                    className="absolute left-5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/70 text-text-primary shadow-lg backdrop-blur transition-all hover:bg-white"
                                    aria-label="上一张"
                                >
                                    <ChevronLeft className="h-5 w-5" />
                                </button>
                                <button
                                    onClick={() => setSelectedImageIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1))}
                                    className="absolute right-5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/70 text-text-primary shadow-lg backdrop-blur transition-all hover:bg-white"
                                    aria-label="下一张"
                                >
                                    <ChevronRight className="h-5 w-5" />
                                </button>
                                <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
                                    {images.map((image, index) => (
                                        <button
                                            key={`${image}-${index}`}
                                            onClick={() => setSelectedImageIndex(index)}
                                            className={clsx('h-2 rounded-full transition-all', index === selectedImageIndex ? 'w-5 bg-white shadow' : 'w-2 bg-white/45')}
                                            aria-label={`第 ${index + 1} 张`}
                                        />
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    <div className="flex min-h-0 flex-col border-l border-black/[0.06] bg-white max-[980px]:border-l-0">
                        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-4 pr-14">
                            <button type="button" onClick={() => openAuthorProfile(note)} className="flex min-w-0 items-center gap-3 text-left">
                                <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-black/[0.04] ring-1 ring-black/[0.05]">
                                    {note.authorAvatarUrl ? (
                                        <img src={resolveAssetUrl(note.authorAvatarUrl)} alt={note.author} className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-sm font-bold text-text-tertiary">{(note.author || '小').slice(0, 1)}</div>
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <div className="truncate text-[16px] font-semibold text-text-primary">{note.author || '小红书用户'}</div>
                                </div>
                            </button>
                            {note.folderPath && (
                                <div className="flex shrink-0 items-center gap-1.5">
                                    <button type="button" title="在文件夹中打开" onClick={() => void handleShowInFolder(note.folderPath)} className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-black/[0.05] hover:text-text-primary">
                                        <FolderOpen className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                            <div className="space-y-4 px-5 py-5">
                                <h1 className="text-[19px] font-extrabold leading-snug tracking-tight text-text-primary">{note.title}</h1>
                                <div className="whitespace-pre-wrap text-[15px] leading-[1.72] text-text-primary">{note.content}</div>
                                {tags.length > 0 && (
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {tags.map((tag) => <span key={tag} className="text-[14px] font-semibold text-[#24599a]">#{tag}</span>)}
                                    </div>
                                )}
                                {renderKnowledgeExtractionFoldout(note, true)}
                                <div className="pt-1 text-[12px] font-medium text-text-tertiary">{formatTimestampDateTime(note.createdAt)}</div>
                            </div>

                            <div className="border-t border-black/[0.06] px-5 py-5">
                                <div className="mb-5 text-[16px] font-semibold text-text-tertiary">共 {formatCompactCount(totalComments)} 条评论</div>
                                {comments.length > 0 ? (
                                    <div className="space-y-1">
                                        {comments.map((comment, index) => renderXhsComment(comment, index))}
                                    </div>
                                ) : (
                                    <div className="rounded-2xl bg-black/[0.02] px-4 py-8 text-center text-[13px] font-medium text-text-tertiary">
                                        评论尚未采集
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const handleOpenBrowserPluginDownload = useCallback(async () => {
        try {
            const result = await window.ipcRenderer.openAppReleasePage(BROWSER_PLUGIN_DOWNLOAD_URL);
            if (!result?.success) {
                void appAlert(result?.error || '打开插件下载页面失败');
            }
        } catch (error) {
            console.error('Failed to open browser plugin download page:', error);
            void appAlert('打开插件下载页面失败');
        }
    }, []);

    const typeFilterControls = useMemo(() => (
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto no-scrollbar">
            {typeFilters.map((item) => (
                <button
                    key={item.key}
                    type="button"
                    onClick={() => setSelectedTypeFilter(item.key)}
                    className={clsx(
                        'inline-flex shrink-0 items-center gap-2 rounded-xl border px-3.5 py-1.5 text-[12px] font-bold transition-all active:scale-95',
                        selectedTypeFilter === item.key
                            ? 'border-transparent bg-accent-primary text-white shadow-lg shadow-accent-primary/20'
                            : 'border-border/70 bg-surface-secondary/70 text-text-secondary hover:bg-surface-tertiary/70 hover:text-text-primary'
                    )}
                >
                    <span>{item.label}</span>
                    <span className={clsx(
                        'rounded-lg px-1.5 py-0.5 text-[10px] font-bold',
                        selectedTypeFilter === item.key
                            ? 'bg-white/20 text-white'
                            : 'bg-surface-primary/70 text-text-tertiary'
                    )}>
                        {item.count}
                    </span>
                </button>
            ))}
        </div>
    ), [selectedTypeFilter, typeFilters]);

    const topControls = useMemo(() => (
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2" data-no-window-drag>
            <div className="flex min-w-0 shrink items-center justify-end gap-1.5">
                    <div className="relative w-[148px]">
                        <ArrowDownUp className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                        <SelectMenu
                            value={sortOrder}
                            onChange={(value) => setSortOrder(value as KnowledgeSortOrder)}
                            options={KNOWLEDGE_SORT_OPTIONS}
                            className="w-full [&>button]:h-9 [&>button]:rounded-xl [&>button]:pl-8 [&>button]:text-[12px] [&>button]:font-bold"
                            menuClassName="min-w-[148px]"
                        />
                    </div>

                    {isSearchOpen ? (
                        <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-right-4 duration-300">
                            <div className="relative w-[220px]">
                                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                                <input
                                    ref={searchInputRef}
                                    type="text"
                                    value={searchQuery}
                                    onChange={(event) => setSearchQuery(event.target.value)}
                                    placeholder="搜索知识库..."
                                    autoFocus
                                    className="h-9 w-full rounded-xl border border-border/70 bg-surface-secondary/70 pl-8 pr-8 text-[12px] font-bold text-text-primary outline-none transition-all placeholder:text-text-tertiary/70 focus:bg-surface-elevated focus:ring-2 focus:ring-accent-primary/10"
                                />
                                {searchQuery && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSearchQuery('');
                                            setDebouncedSearchQuery('');
                                        }}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-tertiary transition-colors hover:text-text-primary"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsSearchOpen(false);
                                    setSearchQuery('');
                                    setDebouncedSearchQuery('');
                                }}
                                className="h-9 rounded-xl px-2.5 text-[12px] font-bold text-text-secondary transition-all hover:bg-surface-secondary/80 hover:text-text-primary"
                            >
                                取消
                            </button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setIsSearchOpen(true)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary transition-all hover:bg-surface-secondary/80 hover:text-text-primary active:scale-90"
                            title="搜索 (Cmd+F)"
                        >
                            <Search className="h-4 w-4" />
                        </button>
                    )}

                    {(selectedTypeFilter === 'all' || selectedTypeFilter === 'youtube') && youtubeSummaryPendingCount > 0 && (
                        <button
                            type="button"
                            onClick={() => void handleRefreshYoutubeSummaries()}
                            disabled={isRefreshingYoutubeSummaries}
                            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent-primary/10 px-3 text-[12px] font-bold text-accent-primary transition-all hover:bg-accent-primary/20 active:scale-95 disabled:opacity-40"
                        >
                            {isRefreshingYoutubeSummaries ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            补全摘要
                            <span className="rounded-lg bg-accent-primary/10 px-1.5 py-0.5 text-[10px] font-bold">
                                {youtubeSummaryPendingCount}
                            </span>
                        </button>
                    )}

                    <div className="flex items-center gap-1 rounded-xl border border-border/80 bg-surface-elevated p-1 shadow-lg shadow-black/10">
                        <button
                            type="button"
                            onClick={handleAddDocumentFiles}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-text-primary transition-all hover:bg-surface-secondary/80 active:scale-95"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            文件
                        </button>
                        <button
                            type="button"
                            onClick={handleAddDocumentFolder}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-text-primary transition-all hover:bg-surface-secondary/80 active:scale-95"
                        >
                            <FolderPlus className="h-3.5 w-3.5" />
                            文件夹
                        </button>
                    </div>
            </div>
        </div>
    ), [
        handleAddDocumentFiles,
        handleAddDocumentFolder,
        handleRefreshYoutubeSummaries,
        isRefreshingYoutubeSummaries,
        isSearchOpen,
        searchQuery,
        selectedTypeFilter,
        sortOrder,
        youtubeSummaryPendingCount,
    ]);

    const visualIndexSettingControl = useMemo(() => (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-surface-secondary/45 px-3 py-2">
            <div className="min-w-0 flex flex-1 items-center gap-2">
                <Image className="h-4 w-4 shrink-0 text-text-tertiary" />
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-[12px] font-bold text-text-primary">图像理解索引</span>
                        <span className={clsx(
                            'inline-flex h-5 items-center rounded-full px-2 text-[10px] font-bold',
                            isVisualIndexEnabled
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-surface-tertiary/70 text-text-tertiary'
                        )}>
                            {isVisualIndexEnabled ? '开启 · 会产生额外消耗' : '关闭 · 不调用视觉模型'}
                        </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] font-medium text-text-tertiary">
                        用视觉模型理解知识库图片，让 AI 能搜索和引用图片里的内容。
                    </div>
                </div>
                <div className="group relative shrink-0">
                    <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-tertiary/70 hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/20"
                        aria-label="图像理解索引说明"
                    >
                        <Info className="h-3.5 w-3.5" />
                    </button>
                    <div className="pointer-events-none absolute left-1/2 top-full z-40 mt-2 w-[280px] -translate-x-1/2 rounded-xl border border-border bg-surface-elevated px-3 py-2 text-[11px] font-medium leading-5 text-text-secondary opacity-0 shadow-xl shadow-black/10 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        开启后，知识库会自动分析图片、PDF 页面截图和图文素材，用于后续搜索、引用和 AI 任务检索。这个过程会调用视觉模型，因此会产生额外 AI 消耗。关闭后不会继续自动分析新图片，已生成的索引仍可使用。
                    </div>
                </div>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={isVisualIndexEnabled}
                aria-label="图像理解索引"
                onClick={() => void handleToggleVisualIndex()}
                disabled={isVisualIndexSettingLoading || isVisualIndexSettingSaving}
                className="ui-switch-track shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                data-size="lg"
                data-state={isVisualIndexEnabled ? 'on' : 'off'}
            >
                <span className="ui-switch-thumb" />
            </button>
        </div>
    ), [
        handleToggleVisualIndex,
        isVisualIndexEnabled,
        isVisualIndexSettingLoading,
        isVisualIndexSettingSaving,
    ]);

    const emptyVisualIndexSettingControl = useMemo(() => (
        <div className="mx-auto w-full max-w-[480px] rounded-2xl border border-border/70 bg-surface-secondary/45 px-4 py-3 text-left">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-elevated text-text-tertiary">
                        <Image className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="text-[12px] font-extrabold text-text-primary">图像理解索引</span>
                            <span className={clsx(
                                'inline-flex h-5 items-center rounded-full px-2 text-[9px] font-bold',
                                isVisualIndexEnabled
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-surface-tertiary/70 text-text-tertiary'
                            )}>
                                {isVisualIndexEnabled ? '开启 · 会产生额外消耗' : '关闭 · 默认不消耗'}
                            </span>
                        </div>
                        <p className="mt-1 text-[11px] font-medium leading-5 text-text-tertiary">
                            开启后会调用视觉模型自动分析知识库图片、PDF 页面截图和图文素材，让 AI 能搜索和引用图片里的内容；这会产生额外 AI 消耗。
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={isVisualIndexEnabled}
                    aria-label="图像理解索引"
                    onClick={() => void handleToggleVisualIndex()}
                    disabled={isVisualIndexSettingLoading || isVisualIndexSettingSaving}
                    className="ui-switch-track mt-0.5 shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                    data-size="lg"
                    data-state={isVisualIndexEnabled ? 'on' : 'off'}
                >
                    <span className="ui-switch-thumb" />
                </button>
            </div>
            <div className="mt-2 flex items-start gap-1.5 text-[10px] font-medium leading-5 text-text-tertiary">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>关闭后不会自动分析新图片，已生成的视觉索引仍可继续使用。</span>
            </div>
        </div>
    ), [
        handleToggleVisualIndex,
        isVisualIndexEnabled,
        isVisualIndexSettingLoading,
        isVisualIndexSettingSaving,
    ]);

    useEffect(() => {
        if (!onTitleBarContentChange) return;
        onTitleBarContentChange(null);
        return () => {
            onTitleBarContentChange(null);
        };
    }, [onTitleBarContentChange]);

    // Embedded View Renders
    if (isEmbedded && selectedNote) {
        return (
            <div className="h-full overflow-y-auto p-4">
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
                        <div className="mt-2 flex justify-center">
                            <button
                                onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary transition-colors hover:text-text-primary"
                            >
                                <BookmarkPlus className="w-3 h-3" />
                                存为封面模板
                            </button>
                        </div>
                    </div>
                )}

                {!selectedNote.video && selectedNote.images && selectedNote.images.length > 0 && (() => {
                   const orderedImages = orderImages(selectedNote.images);
                   const currentImage = orderedImages[selectedImageIndex];
                   return (
                       <div className="mb-4">
                           <div className="relative aspect-square bg-black/5 rounded-lg overflow-hidden">
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
                           <div className="mt-2 flex justify-center">
                               <button
                                   onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                                   className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary transition-colors hover:text-text-primary"
                               >
                                   <BookmarkPlus className="w-3 h-3" />
                                   存为封面模板
                               </button>
                           </div>
                       </div>
                   );
                })()}

                <div className="whitespace-pre-wrap text-sm text-text-secondary font-sans leading-relaxed mb-4">
                    {selectedNote.content}
                </div>

                {renderKnowledgeExtractionFoldout(selectedNote)}

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
                    {onNavigateToRedClaw && selectedVideo.hasSubtitle && selectedVideo.subtitleContent && (
                        <button
                            onClick={() => {
                                openVideoInRedClaw(selectedVideo);
                            }}
                            className="text-xs px-2 py-1 bg-surface-secondary border border-border rounded hover:bg-surface-hover"
                        >
                            {APP_BRAND.aiDisplayName} 总结
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

            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div
                className={clsx(
                    'z-30',
                    isEmbedded ? 'border-b border-border/50 px-3 py-2' : 'px-6 py-4'
                )}
            >
                <div className={clsx('flex flex-col', isEmbedded ? 'gap-2' : 'gap-3.5')}>
                    <div className="flex items-center justify-between gap-3 py-1">
                        <div className="min-w-0 flex-1">
                            {typeFilterControls}
                        </div>
                        {!isEmbedded && topControls}
                    </div>

                    {!isEmbedded && <CaptureJobsBar />}

                    {!isEmbedded && (allTags.length > 0 || filteredKnowledgeItems.length > 0) && (
                        <div ref={allTagsDrawerRef} className="relative py-0.5">
                            <div className="flex min-w-0 items-center gap-2">
                                {filteredKnowledgeItems.length > 0 && (
                                    <div className="flex shrink-0 items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={toggleVisibleKnowledgeSelection}
                                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.06] bg-white px-2.5 text-[11px] font-bold text-text-secondary shadow-sm transition-all hover:bg-black/[0.02]"
                                            title={allVisibleKnowledgeSelected ? '取消选择当前可见' : '选择当前可见'}
                                        >
                                            {allVisibleKnowledgeSelected ? <CheckSquare2 className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                                            {selectedKnowledgeItems.length > 0 ? `已选 ${selectedKnowledgeItems.length}` : '多选'}
                                        </button>
                                        {selectedKnowledgeItems.length > 0 && (
                                            <button
                                                type="button"
                                                onClick={clearKnowledgeSelection}
                                                className="inline-flex h-8 items-center justify-center rounded-lg border border-black/[0.06] bg-white px-2.5 text-[11px] font-bold text-text-tertiary shadow-sm transition-all hover:bg-black/[0.02]"
                                                title="清空选择"
                                            >
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                )}
                                {allTags.length > 0 && (
                                    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto no-scrollbar">
                                        <button
                                            onClick={handleAllTagsClick}
                                            className={clsx(
                                                'shrink-0 px-3 py-1 text-[11px] font-bold rounded-lg transition-all border uppercase tracking-wider inline-flex items-center gap-1.5',
                                                !selectedTag
                                                    ? 'bg-surface-secondary/80 text-text-primary border-transparent shadow-sm'
                                                    : 'bg-transparent text-text-tertiary border-transparent hover:bg-surface-secondary/70 hover:text-text-secondary'
                                            )}
                                        >
                                            <span>All Tags</span>
                                            <span
                                                className={clsx(
                                                    'inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[9px] font-bold',
                                                    !selectedTag
                                                        ? 'bg-surface-tertiary/80 text-text-tertiary/80'
                                                        : 'bg-surface-secondary/80 text-text-tertiary/70'
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
                                                        : 'bg-surface-secondary/60 text-text-tertiary border-transparent hover:bg-surface-tertiary/70 hover:text-text-primary'
                                                )}
                                            >
                                                <span className="opacity-40">#</span>
                                                {tag}
                                                <span
                                                    className={clsx(
                                                        'text-[9px] py-0.5 px-1.5 rounded-md font-bold',
                                                        selectedTag === tag
                                                            ? 'bg-white/20 text-white'
                                                            : 'bg-surface-tertiary/70 text-text-tertiary/60'
                                                    )}
                                                >
                                                    {count}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {selectedKnowledgeItems.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => void handleBatchDeleteKnowledge()}
                                        disabled={isBatchDeleting}
                                        className={clsx(
                                            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-red-100 bg-red-50 px-2.5 text-[11px] font-bold text-red-600 shadow-sm transition-all hover:bg-red-100 disabled:opacity-60',
                                        )}
                                        title="批量删除"
                                    >
                                        {isBatchDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                        删除
                                    </button>
                                )}
                            </div>

                            {allTags.length > 0 && !selectedTag && isAllTagsDrawerOpen && hasHiddenTags && (
                                <div className="absolute left-0 right-0 top-full z-20 mt-3">
                                    <div className="rounded-2xl border border-border/80 bg-surface-elevated/95 shadow-xl shadow-black/[0.18] backdrop-blur-xl">
                                    <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                                        <div className="min-w-0">
                                            <div className="text-[12px] font-extrabold text-text-primary tracking-tight">全部标签</div>
                                            <div className="mt-1 text-[10px] font-medium text-text-tertiary/70">
                                                共 {allTags.length} 个标签，点击即可筛选内容
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => setIsAllTagsDrawerOpen(false)}
                                            className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-text-tertiary hover:bg-surface-secondary/80 hover:text-text-primary transition-all active:scale-90"
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
                                                            : 'bg-surface-secondary/60 text-text-tertiary border-transparent hover:bg-surface-tertiary/70 hover:text-text-primary'
                                                    )}
                                                >
                                                    <span className="opacity-40">#</span>
                                                    {tag}
                                                    <span
                                                        className={clsx(
                                                            'text-[9px] py-0.5 px-1.5 rounded-md font-bold',
                                                            selectedTag === tag
                                                                ? 'bg-white/20 text-white'
                                                                : 'bg-surface-tertiary/70 text-text-tertiary/60'
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

                    {!isEmbedded && isIndexingInProgress && (
                        <div className="flex items-center gap-3 text-[11px] font-medium text-text-tertiary/70">
                            <span>已索引 {indexStatus.indexedCount}</span>
                            {indexStatus.isBuilding && (
                                <span className="inline-flex items-center gap-1.5 text-amber-600">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    索引构建中
                                </span>
                            )}
                            {indexStatus.pendingCount > 0 && <span>待处理 {indexStatus.pendingCount}</span>}
                            {typeof indexStatus.rebuildProgress === 'number' && indexStatus.rebuildProgress < 1 && (
                                <span>重建进度 {Math.round(indexStatus.rebuildProgress * 100)}%</span>
                            )}
                            {indexStatus.migrationStatus && (
                                <span>迁移状态 {indexStatus.migrationStatus}</span>
                            )}
                            {indexStatus.pendingRebuildReason && (
                                <span>重建原因 {indexStatus.pendingRebuildReason}</span>
                            )}
                            {indexStatus.failedCount > 0 && <span className="text-red-500">失败 {indexStatus.failedCount}</span>}
                            {indexStatus.lastIndexedAt && <span>最近更新 {formatTimestampDateTime(indexStatus.lastIndexedAt)}</span>}
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
                            isKnowledgeLibraryEmpty && !isEmbedded ? (
                                <div className="mx-auto flex min-h-[360px] max-w-[560px] flex-col items-center justify-center px-4 py-12 text-center">
                                    <div className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-primary/15 bg-accent-primary/10 text-accent-primary">
                                        <BookmarkPlus className="h-7 w-7" />
                                    </div>
                                    <h2 className="text-[18px] font-extrabold tracking-tight text-text-primary">
                                        开始收集第一条知识
                                    </h2>
                                    <p className="mt-2 max-w-[440px] text-[13px] font-medium leading-6 text-text-tertiary">
                                        安装浏览器插件后，可以把小红书、YouTube、网页、图片和选中文字直接保存到这里。
                                    </p>
                                    <div className="mt-5 grid w-full max-w-[480px] grid-cols-3 gap-2 text-left">
                                        {[
                                            ['1', '装插件'],
                                            ['2', '网页上保存'],
                                            ['3', '在知识库搜索引用'],
                                        ].map(([step, label]) => (
                                            <div key={step} className="rounded-xl border border-border/70 bg-surface-secondary/60 px-3 py-2.5">
                                                <div className="text-[10px] font-black uppercase tracking-wider text-accent-primary">{step}</div>
                                                <div className="mt-1 text-[12px] font-bold text-text-primary">{label}</div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
                                        <button
                                            type="button"
                                            onClick={handleAddDocumentFiles}
                                            className="inline-flex h-10 items-center gap-2 rounded-xl border border-border/80 bg-surface-elevated px-4 text-[13px] font-bold text-text-primary transition-all hover:bg-surface-secondary/80 active:scale-95"
                                        >
                                            <Plus className="h-4 w-4" />
                                            添加文件
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleAddDocumentFolder}
                                            className="inline-flex h-10 items-center gap-2 rounded-xl border border-border/80 bg-surface-elevated px-4 text-[13px] font-bold text-text-primary transition-all hover:bg-surface-secondary/80 active:scale-95"
                                        >
                                            <FolderPlus className="h-4 w-4" />
                                            添加文件夹
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleAddObsidianVault}
                                            className="inline-flex h-10 items-center gap-2 rounded-xl border border-border/80 bg-surface-elevated px-4 text-[13px] font-bold text-text-primary transition-all hover:bg-surface-secondary/80 active:scale-95"
                                        >
                                            <ObsidianIcon className="h-4 w-4 text-[#7C3AED]" />
                                            绑定 Obsidian
                                        </button>
                                    </div>
                                    <div className="mt-7 flex items-center justify-center">
                                        <button
                                            type="button"
                                            onClick={() => void handleOpenBrowserPluginDownload()}
                                            className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent-primary px-4 text-[13px] font-bold text-white shadow-lg shadow-accent-primary/20 transition-all hover:bg-accent-hover active:scale-95"
                                        >
                                            <Download className="h-4 w-4" />
                                            下载浏览器插件
                                            <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                                        </button>
                                    </div>
                                    <div className="mt-4 w-full max-w-[480px] rounded-xl border border-border/70 bg-surface-secondary/45 px-4 py-3 text-left">
                                        <div className="text-[11px] font-extrabold uppercase tracking-wider text-text-secondary">
                                            插件安装
                                        </div>
                                        <ol className="mt-2 space-y-1.5 text-[12px] font-medium leading-5 text-text-tertiary">
                                            <li><span className="font-bold text-text-primary">1.</span> 点击“下载浏览器插件”，在下载页获取插件压缩包。</li>
                                            <li><span className="font-bold text-text-primary">2.</span> 解压后打开 Chrome / Edge 的扩展管理页。</li>
                                            <li><span className="font-bold text-text-primary">3.</span> 开启开发者模式，选择“加载已解压的扩展程序”。</li>
                                        </ol>
                                    </div>
                                    <div className="mt-7 w-full">
                                        {emptyVisualIndexSettingControl}
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center text-text-tertiary text-xs py-16">
                                    {isKnowledgeLibraryEmpty
                                        ? '暂无内容，可使用插件保存网页内容，也可添加文档源'
                                        : '没有匹配到内容'}
                                </div>
                            )
                        ) : (
                            <div className={knowledgeColumnsClass} style={{ columnGap: '0.75rem' }}>
                                {visibleKnowledgeItems.map((item) => {
                                    const selectionKey = `${item.kind}:${item.id}`;
                                    const isSelected = selectedKnowledgeIds.has(selectionKey);
                                    const selectionButton = !isEmbedded ? (
                                        <span
                                            role="checkbox"
                                            aria-checked={isSelected}
                                            tabIndex={0}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleKnowledgeSelection(item);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    toggleKnowledgeSelection(item);
                                                }
                                            }}
                                            className={clsx(
                                                'absolute left-3 top-3 z-20 inline-flex h-7 w-7 items-center justify-center rounded-lg border shadow-sm backdrop-blur-md transition-all',
                                                isSelected
                                                    ? 'border-accent-primary bg-accent-primary text-white'
                                                    : 'border-white/70 bg-white/85 text-text-tertiary hover:text-text-primary'
                                            )}
                                            title={isSelected ? '取消选择' : '选择'}
                                        >
                                            {isSelected ? <CheckSquare2 className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                                        </span>
                                    ) : null;
                                    if (item.kind === 'docs' && item.doc) {
                                        const source = item.doc;
                                        const hasVisualIndexSamples = source.sampleFiles.some(isVisualIndexFilePath);
                                        return (
                                            <div
                                                key={item.id}
                                                role="button"
                                                tabIndex={0}
                                                onClick={() => void openDocumentDetail(source)}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault();
                                                        void openDocumentDetail(source);
                                                    }
                                                }}
                                                className={clsx(
                                                    'relative mb-3 break-inside-avoid rounded-lg border bg-white shadow-sm p-4 transition-all',
                                                    isSelected ? 'border-accent-primary ring-2 ring-accent-primary/15' : 'border-black/[0.04]'
                                                )}
                                            >
                                                {selectionButton}
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
                                                            {hasVisualIndexSamples && (
                                                                <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-lg bg-sky-50 text-sky-600 border border-sky-100">
                                                                    <Image className="w-3 h-3" />
                                                                    VISUAL
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            void handleDeleteDocumentSource(source);
                                                        }}
                                                        className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-50 transition-all active:scale-90"
                                                        title="移除此文档源"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
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
                                                    'group relative mb-4 break-inside-avoid w-full text-left bg-white border rounded-lg overflow-hidden shadow-sm transition-all duration-300',
                                                    isSelected ? 'border-accent-primary ring-2 ring-accent-primary/15' : isProcessing ? 'border-yellow-400 animate-pulse' : isFailed ? 'border-red-400' : 'border-black/[0.04]'
                                                )}
                                            >
                                                {selectionButton}
                                                <div className="relative aspect-[16/10] bg-black/[0.02] overflow-hidden">
                                                    <span className={clsx('absolute top-3 right-3 z-10 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm backdrop-blur-md', getKnowledgeKindBadgeClass('youtube'))}>
                                                        {getKnowledgeKindLabel('youtube')}
                                                    </span>
                                                    {video.thumbnailUrl && !isProcessing ? (
                                                        <img
                                                            src={resolveAssetUrl(video.thumbnailUrl)}
                                                            alt={video.title}
                                                            className="w-full h-full object-cover transition-transform duration-500"
                                                            loading="lazy"
                                                            decoding="async"

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
                                                    
                                                </div>
                                                <div className="p-4">
                                                    <div className="text-[14px] font-extrabold text-text-primary line-clamp-2 leading-tight tracking-tight group-hover:text-accent-primary transition-colors">{video.title}</div>
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
                                    const isTextArticleCard = (item.kind === 'link-article' || item.kind === 'wechat-article' || item.kind === 'zhihu-answer' || item.kind === 'zhihu-article') && !coverImage && !note.video;
                                    const isNoteTranscribing = Boolean(note.video && !note.transcript && note.transcriptionStatus === 'processing');

                                    return (
                                        <button
                                            key={item.id}
                                            onClick={() => void openNoteDetail(note)}
                                            className={clsx(
                                                'relative mb-4 break-inside-avoid w-full text-left bg-white border rounded-lg shadow-sm transition-all duration-300',
                                                isSelected ? 'border-accent-primary ring-2 ring-accent-primary/15' : 'border-black/[0.04]',
                                                isTextArticleCard ? 'overflow-visible p-5' : 'overflow-hidden'
                                            )}
                                        >
                                            {selectionButton}
                                            {isTextArticleCard ? (
                                                <div className="min-w-0">
                                                    <div className="mb-2 flex items-center gap-2">
                                                        <span className={clsx('shrink-0 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm border border-black/[0.02]', getKnowledgeKindBadgeClass(item.kind))}>
                                                            {getKnowledgeKindLabel(item.kind)}
                                                        </span>
                                                    </div>
                                                    <div className={clsx(
                                                        'font-extrabold text-text-primary tracking-tight group-hover:text-accent-primary transition-colors',
                                                        embeddedUsesCompactCard ? 'text-[14px] line-clamp-4' : 'text-[15px] line-clamp-3',
                                                    )}>
                                                        {note.title}
                                                    </div>
                                                </div>
                                            ) : coverImage ? (
                                                <div
                                                    className={clsx(
                                                        'relative w-full bg-black/[0.02] overflow-hidden',
                                                        resolveCoverAspectClass(item.kind)
                                                    )}
                                                >
                                                    <span className={clsx('absolute top-3 right-3 z-10 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shadow-sm backdrop-blur-md border border-white/20', getKnowledgeKindBadgeClass(item.kind))}>
                                                        {getKnowledgeKindLabel(item.kind)}
                                                    </span>
                                                    <img
                                                        src={resolveAssetUrl(coverImage)}
                                                        alt={note.title}
                                                        className="w-full h-full object-cover transition-transform duration-500"
                                                        loading="lazy"
                                                        decoding="async"
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
                                                        (item.kind === 'link-article' || item.kind === 'wechat-article' || item.kind === 'zhihu-answer' || item.kind === 'zhihu-article') ? 'aspect-[4/2.6]' : 'aspect-[3/4]'
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
                                                </div>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {(hasMoreRenderedItems || nextCursor) && filteredKnowledgeItems.length > 0 && (
                            <div className="flex justify-center pt-2">
                                <div ref={loadMoreTriggerRef} className="h-px w-px" aria-hidden="true" />
                                <button
                                    onClick={() => {
                                        if (hasMoreRenderedItems) {
                                            setVisibleItemCount((prev) => prev + KNOWLEDGE_RENDER_BATCH_SIZE);
                                            return;
                                        }
                                        void loadMoreKnowledge();
                                    }}
                                    disabled={!hasMoreRenderedItems && isLoadingMore}
                                    className="inline-flex items-center gap-2 rounded-xl border border-black/[0.06] bg-white px-4 py-2 text-[12px] font-bold text-text-primary shadow-sm hover:bg-black/[0.02] disabled:opacity-50"
                                >
                                    {!hasMoreRenderedItems && isLoadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                    {hasMoreRenderedItems ? '显示更多' : isLoadingMore ? '加载中...' : '加载更多'}
                                </button>
                            </div>
                        )}

                        {!isEmbedded && filteredKnowledgeItems.length > 0 && (
                            <div className="mx-auto max-w-[560px] pt-2">
                                {visualIndexSettingControl}
                            </div>
                        )}

                    </div>
                )}
            </div>

            {/* Xiaohongshu Note Detail Modal */}
            {selectedNote && (
                isXiaohongshuNoteDetail(selectedNote) ? renderXhsNoteDetail(selectedNote) : (
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
                                    <button
                                        type="button"
                                        onClick={() => openAuthorProfile(selectedNote)}
                                        className="flex items-center gap-1.5 rounded-md transition-colors hover:text-accent-primary"
                                    >
                                        <Users className="w-3.5 h-3.5 opacity-60" /> {selectedNote.author}
                                    </button>
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
                                    onClick={() => openNoteInRedClaw(selectedNote)}
                                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent-primary text-white shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95"
                                    title={`${APP_BRAND.aiDisplayName} 聊天`}
                                    aria-label={`${APP_BRAND.aiDisplayName} 聊天`}
                                >
                                    <MessageCircle className="w-4 h-4" />
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
                                    <div className="mt-3 flex justify-center">
                                        <button
                                            onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                                            className="inline-flex items-center gap-1.5 text-[11px] font-bold text-text-tertiary transition-colors hover:text-text-primary"
                                        >
                                            <BookmarkPlus className="w-3.5 h-3.5" />
                                            存为封面模板
                                        </button>
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
                                        <div className="mt-3 flex justify-center">
                                            <button
                                                onClick={() => void handleSaveNoteCoverAsTemplate(selectedNote)}
                                                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-text-tertiary transition-colors hover:text-text-primary"
                                            >
                                                <BookmarkPlus className="w-3.5 h-3.5" />
                                                存为封面模板
                                            </button>
                                        </div>
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

                            {renderKnowledgeExtractionFoldout(selectedNote)}
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
                )
            )}

            {selectedAuthor && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[6px] animate-in fade-in duration-300"
                    onClick={() => setSelectedAuthor(null)}
                >
                    <div
                        className="w-full max-w-[720px] mx-4 bg-white rounded-[24px] border border-white/20 shadow-[0_40px_100px_-24px_rgba(0,0,0,0.32)] overflow-hidden max-h-[86vh] flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="px-7 py-6 border-b border-black/[0.04] flex items-start justify-between gap-4">
                            <div className="flex min-w-0 items-center gap-4">
                                {selectedAuthor.avatarUrl ? (
                                    <img
                                        src={resolveAssetUrl(selectedAuthor.avatarUrl)}
                                        alt={selectedAuthor.name}
                                        className="h-14 w-14 rounded-full object-cover border border-black/[0.04]"
                                    />
                                ) : (
                                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
                                        <Users className="h-6 w-6" />
                                    </div>
                                )}
                                <div className="min-w-0">
                                    <h2 className="text-lg font-extrabold text-text-primary tracking-tight truncate">{selectedAuthor.name}</h2>
                                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-bold text-text-tertiary">
                                        <span>{selectedAuthorNotes.length} 篇已采集笔记</span>
                                        {selectedAuthor.profileUrl && (
                                            <button
                                                type="button"
                                                onClick={() => window.open(selectedAuthor.profileUrl, '_blank')}
                                                className="inline-flex items-center gap-1 rounded-md text-accent-primary hover:underline underline-offset-2"
                                            >
                                                <ExternalLink className="h-3 w-3" />
                                                原始主页
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => setSelectedAuthor(null)}
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.03] text-text-tertiary hover:bg-black/[0.06] transition-colors"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        {selectedAuthor.description && (
                            <div className="px-7 py-4 border-b border-black/[0.04] text-[13px] leading-relaxed text-text-secondary">
                                {selectedAuthor.description}
                            </div>
                        )}
                        <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar">
                            <div className="grid grid-cols-1 gap-2">
                                {selectedAuthorNotes.map((note) => (
                                    <button
                                        key={note.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedAuthor(null);
                                            void openNoteDetail(note);
                                        }}
                                        className="group flex items-center gap-3 rounded-xl border border-black/[0.04] bg-white p-3 text-left transition-all hover:bg-black/[0.015] hover:border-accent-primary/20"
                                    >
                                        {getNoteCoverImage(note) ? (
                                            <img
                                                src={resolveAssetUrl(getNoteCoverImage(note))}
                                                alt={note.title}
                                                className="h-14 w-14 rounded-lg object-cover bg-black/[0.03]"
                                            />
                                        ) : (
                                            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-black/[0.03] text-text-tertiary">
                                                <FileText className="h-5 w-5 opacity-50" />
                                            </div>
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <div className="line-clamp-1 text-[13px] font-extrabold text-text-primary group-hover:text-accent-primary">{note.title}</div>
                                            <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-tertiary">{note.excerpt || note.content || note.sourceUrl}</div>
                                        </div>
                                        <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary/50" />
                                    </button>
                                ))}
                                {selectedAuthorNotes.length === 0 && (
                                    <div className="rounded-xl border border-dashed border-black/[0.08] p-8 text-center text-[12px] font-bold text-text-tertiary">
                                        暂时没有匹配到该作者的笔记
                                    </div>
                                )}
                            </div>
                        </div>
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
                                    onClick={() => openVideoInRedClaw(selectedVideo)}
                                    className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent-primary text-white shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95"
                                    title={`${APP_BRAND.aiDisplayName} 聊天`}
                                    aria-label={`${APP_BRAND.aiDisplayName} 聊天`}
                                >
                                    <MessageCircle className="w-4.5 h-4.5" />
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

            {/* Document Source Detail Modal */}
            {selectedDocumentSource && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[6px] animate-in fade-in duration-300"
                    onClick={() => setSelectedDocumentSource(null)}
                >
                    <div
                        className="w-full max-w-[860px] mx-4 bg-white rounded-[28px] border border-white/20 shadow-[0_48px_120px_-20px_rgba(0,0,0,0.3)] overflow-hidden max-h-[90vh] flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="px-7 py-6 border-b border-black/[0.04] flex items-start justify-between gap-5 bg-white">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h1 className="text-xl font-extrabold text-text-primary tracking-tight line-clamp-2">{selectedDocumentSource.name}</h1>
                                    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg bg-sky-50 text-sky-600 border border-sky-100">
                                        <Image className="w-3 h-3" />
                                        Visual Index
                                    </span>
                                </div>
                                <div className="mt-2 text-[11px] font-bold text-text-tertiary/70 break-all">{selectedDocumentSource.rootPath}</div>
                            </div>
                            <button
                                onClick={() => setSelectedDocumentSource(null)}
                                className="flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.04] text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-90"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-7 py-7 space-y-6 custom-scrollbar bg-white">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                                <div className="rounded-xl bg-black/[0.025] border border-black/[0.02] px-3 py-2">
                                    {selectedDocumentSource.fileCount} Documents
                                </div>
                                <div className="rounded-xl bg-black/[0.025] border border-black/[0.02] px-3 py-2">
                                    {selectedDocumentSource.visualBlocks?.length || 0} Semantic Blocks
                                </div>
                                <div className="rounded-xl bg-black/[0.025] border border-black/[0.02] px-3 py-2">
                                    {selectedDocumentSource.indexing ? 'Indexing' : 'Ready'}
                                </div>
                            </div>

                            {selectedDocumentSource.sampleFiles.length > 0 && (
                                <div>
                                    <h3 className="text-[12px] font-extrabold text-text-primary uppercase tracking-wider mb-2.5">Source Files</h3>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedDocumentSource.sampleFiles.slice(0, 12).map((file) => {
                                            const isVisualFile = isVisualIndexFilePath(file);
                                            const FileIcon = isVisualFile ? Image : FileText;
                                            return (
                                                <span
                                                    key={`${selectedDocumentSource.id}-detail-${file}`}
                                                    className={clsx(
                                                        'inline-flex max-w-full items-start gap-1 text-[10px] font-medium px-2.5 py-1 rounded-lg border',
                                                        isVisualFile
                                                            ? 'bg-sky-50 text-sky-700 border-sky-100'
                                                            : 'bg-black/[0.02] text-text-tertiary border-black/[0.01]',
                                                    )}
                                                >
                                                    <FileIcon className="w-3 h-3 shrink-0 mt-0.5 opacity-60" />
                                                    <span className="min-w-0 break-all leading-relaxed line-clamp-1">{file}</span>
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            <div>
                                <h3 className="text-[12px] font-extrabold text-text-primary uppercase tracking-wider mb-2.5">Visual Semantic Blocks</h3>
                                {selectedDocumentSource.visualBlocks && selectedDocumentSource.visualBlocks.length > 0 ? (
                                    <div className="space-y-2.5">
                                        {selectedDocumentSource.visualBlocks.map((block) => {
                                            const evidenceWithBbox = (block.visualEvidence || []).filter((evidence) => evidence.bbox);
                                            const visualPreviewPath = block.absolutePath || block.path;
                                            const showVisualBboxPreview = block.unitKind === 'image_file'
                                                && hasRenderableAssetUrl(visualPreviewPath)
                                                && evidenceWithBbox.length > 0;
                                            return (
                                                <div key={block.blockId} className="rounded-2xl border border-black/[0.04] bg-black/[0.015] p-4">
                                                    <div className="flex flex-wrap items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-text-tertiary">
                                                        <span className="rounded-md bg-white px-1.5 py-0.5 border border-black/[0.03]">{block.blockType}</span>
                                                        {typeof block.page === 'number' && (
                                                            <span className="rounded-md bg-white px-1.5 py-0.5 border border-black/[0.03]">PAGE {block.page}</span>
                                                        )}
                                                        {block.unitKind && (
                                                            <span className="rounded-md bg-sky-50 text-sky-600 px-1.5 py-0.5 border border-sky-100">{block.unitKind}</span>
                                                        )}
                                                    </div>
                                                    <div className="mt-2 text-[13px] font-semibold text-text-primary leading-relaxed">
                                                        {block.summary || block.text}
                                                    </div>
                                                    {block.summary && (
                                                        <div className="mt-1.5 text-[11px] text-text-secondary leading-relaxed line-clamp-3">
                                                            {block.text}
                                                        </div>
                                                    )}
                                                    <div className="mt-2 text-[10px] font-bold text-text-tertiary/70 break-all">
                                                        {block.path}
                                                    </div>
                                                    {showVisualBboxPreview && (
                                                        <div className="mt-3 w-full max-w-sm overflow-hidden rounded-xl border border-black/[0.06] bg-black/[0.03]">
                                                            <div className="relative aspect-video">
                                                                <img
                                                                    src={resolveAssetUrl(visualPreviewPath)}
                                                                    alt=""
                                                                    className="absolute inset-0 h-full w-full object-contain"
                                                                />
                                                                {evidenceWithBbox.slice(0, 6).map((evidence) => {
                                                                    const bbox = evidence.bbox || {};
                                                                    const left = Math.max(0, Math.min(1, Number(bbox.x ?? 0)));
                                                                    const top = Math.max(0, Math.min(1, Number(bbox.y ?? 0)));
                                                                    const width = Math.max(0.02, Math.min(1 - left, Number(bbox.width ?? 0)));
                                                                    const height = Math.max(0.02, Math.min(1 - top, Number(bbox.height ?? 0)));
                                                                    return (
                                                                        <div
                                                                            key={`${block.blockId}-bbox-${evidence.id || evidence.title || evidence.text}`}
                                                                            className="absolute border-2 border-emerald-400 bg-emerald-300/20 shadow-[0_0_0_1px_rgba(6,95,70,0.22)]"
                                                                            style={{
                                                                                left: `${left * 100}%`,
                                                                                top: `${top * 100}%`,
                                                                                width: `${width * 100}%`,
                                                                                height: `${height * 100}%`,
                                                                            }}
                                                                        />
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {evidenceWithBbox.length > 0 && (
                                                        <div className="mt-3 flex flex-wrap gap-1.5">
                                                            {evidenceWithBbox.slice(0, 4).map((evidence) => (
                                                                <span key={evidence.id || evidence.title || evidence.text} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-1 text-[10px] font-bold">
                                                                    BBOX
                                                                    {evidence.title || evidence.kind || evidence.id}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {block.evidenceRefs && block.evidenceRefs.length > 0 && (
                                                        <div className="mt-2 text-[9px] font-bold text-text-tertiary/50 break-all">
                                                            Evidence: {block.evidenceRefs.slice(0, 4).join(', ')}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="rounded-2xl border border-dashed border-black/[0.08] p-8 text-center text-[12px] font-bold text-text-tertiary">
                                        暂无视觉语义块
                                    </div>
                                )}
                            </div>
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

        </div>
    );
}
