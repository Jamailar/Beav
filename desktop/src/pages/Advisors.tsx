import { useEffect, useState, useCallback, useMemo } from 'react';
import { Users, Plus, Pencil, Trash2, Upload, FileText, X, Check, Sparkles, Database, RefreshCw, ChevronDown, ChevronUp, AlertCircle, Download } from 'lucide-react';
import { clsx } from 'clsx';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';

interface Advisor {
    id: string;
    name: string;
    avatar: string;
    personality: string;
    systemPrompt: string;
    knowledgeLanguage?: string;
    knowledgeFiles: string[];
    createdAt: string;
}

const AVATAR_OPTIONS = ['🧠', '💡', '📊', '🎨', '📝', '🔍', '💼', '🎯', '🌟', '🚀'];
const AVATAR_COLORS = [
    'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-orange-500',
    'bg-green-500', 'bg-teal-500', 'bg-indigo-500', 'bg-rose-500'
];

const isRenderableAvatarUrl = (value: string): boolean => {
    return hasRenderableAssetUrl(value);
};

export function Advisors() {
    const [advisors, setAdvisors] = useState<Advisor[]>([]);
    const [selectedAdvisor, setSelectedAdvisor] = useState<Advisor | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const [editingAdvisor, setEditingAdvisor] = useState<Advisor | null>(null);
    const [downloadStatus, setDownloadStatus] = useState<{ advisorId: string; progress: string } | null>(null);
    const [isSystemPromptExpanded, setIsSystemPromptExpanded] = useState(false); // 默认折叠
    const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false); // AI优化状态

    // Indexing status
    const [indexingStatus, setIndexingStatus] = useState<any>(null);

    useEffect(() => {
        const handleIndexingStatus = (_: unknown, status: any) => {
            setIndexingStatus(status);
        };
        window.ipcRenderer.on('indexing:status', handleIndexingStatus);

        // Initial fetch
        window.ipcRenderer.invoke('indexing:get-stats').then(setIndexingStatus);

        return () => {
            window.ipcRenderer.off('indexing:status', handleIndexingStatus);
        };
    }, []);

    const loadAdvisors = useCallback(async () => {
        setIsLoading(true);
        try {
            const list = await window.ipcRenderer.invoke('advisors:list') as Advisor[];
            setAdvisors(list || []);
        } catch (e) {
            console.error('Failed to load advisors:', e);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Listen for download progress
    useEffect(() => {
        const handleDownloadProgress = (_event: unknown, data: { advisorId: string; progress: string }) => {
            setDownloadStatus(data);
            // 检测下载完成（新架构会发送"下载完成！"消息）
            if (data.progress.includes('下载完成') || data.progress.includes('下载失败')) {
                // 刷新 advisor 列表以更新 knowledgeFiles
                setTimeout(() => {
                    loadAdvisors().then(() => {
                        // 如果当前选中的是这个 advisor，更新 selectedAdvisor
                        setAdvisors(prev => {
                            const updated = prev.find(a => a.id === data.advisorId);
                            if (updated && selectedAdvisor?.id === data.advisorId) {
                                setSelectedAdvisor(updated);
                            }
                            return prev;
                        });
                    });
                    // 清除下载状态显示
                    setTimeout(() => setDownloadStatus(null), 3000);
                }, 1000);
            }
        };

        window.ipcRenderer.on('advisors:download-progress', handleDownloadProgress);
        return () => {
            window.ipcRenderer.off('advisors:download-progress', handleDownloadProgress);
        };
    }, [selectedAdvisor, loadAdvisors]);

    useEffect(() => {
        loadAdvisors();
    }, [loadAdvisors]);

    const handleCreate = () => {
        setEditingAdvisor(null);
        setIsModalOpen(true);
    };

    const handleEdit = (advisor: Advisor) => {
        setEditingAdvisor(advisor);
        setIsModalOpen(true);
    };

    const handleDelete = async (advisorId: string) => {
        if (!confirm('确定要删除这个智囊团成员吗？')) return;
        try {
            await window.ipcRenderer.invoke('advisors:delete', advisorId);
            await loadAdvisors();
            if (selectedAdvisor?.id === advisorId) {
                setSelectedAdvisor(null);
            }
        } catch (e) {
            console.error('Failed to delete advisor:', e);
        }
    };

    const handleSaveAdvisor = async (
        data: Omit<Advisor, 'id' | 'createdAt' | 'knowledgeFiles'>,
        youtubeParams?: { url: string; count: number; channelId?: string }
    ) => {
        try {
            let newId: string | undefined;
            if (editingAdvisor) {
                await window.ipcRenderer.invoke('advisors:update', { ...editingAdvisor, ...data });
                newId = editingAdvisor.id;
            } else {
                // Include youtubeChannel in create call if from YouTube import
                const createData: Record<string, unknown> = { ...data };
                if (youtubeParams?.url) {
                    createData.youtubeChannel = {
                        url: youtubeParams.url,
                        channelId: youtubeParams.channelId || ''
                    };
                }
                const res = await window.ipcRenderer.invoke('advisors:create', createData) as { success: boolean; id?: string };
                if (res.success) newId = res.id;
            }

            if (newId && youtubeParams && youtubeParams.count > 0) {
                // Trigger background download
                window.ipcRenderer.downloadYoutubeSubtitles({
                    channelUrl: youtubeParams.url,
                    videoCount: youtubeParams.count,
                    advisorId: newId
                });
            }

            setIsModalOpen(false);
            await loadAdvisors();
        } catch (e) {
            console.error('Failed to save advisor:', e);
        }
    };

    const handleUploadKnowledge = async (advisorId: string) => {
        try {
            const result = await window.ipcRenderer.invoke('advisors:upload-knowledge', advisorId);
            if (result) {
                await loadAdvisors();
                // Refresh selected advisor
                // Note: state update is async, we need to be careful. Better to re-fetch list and find.
                const list = await window.ipcRenderer.invoke('advisors:list') as Advisor[];
                const updated = list.find(a => a.id === advisorId);
                if (updated) setSelectedAdvisor(updated);
            }
        } catch (e) {
            console.error('Failed to upload knowledge:', e);
        }
    };

    const handleDeleteKnowledge = async (advisorId: string, fileName: string) => {
        if (!confirm(`确定要删除知识库文件 "${fileName}" 吗？`)) return;
        try {
            await window.ipcRenderer.invoke('advisors:delete-knowledge', { advisorId, fileName });
            await loadAdvisors();
        } catch (e) {
            console.error('Failed to delete knowledge file:', e);
        }
    };

    const handleRebuildAdvisorIndex = async (advisorId: string) => {
        if (!confirm('确定要重建该成员的知识库索引吗？\n\n这可能需要几分钟时间，具体取决于知识库文件的大小。在此期间，您可以继续使用其他功能。')) return;
        try {
            await window.ipcRenderer.invoke('indexing:rebuild-advisor', advisorId);
        } catch (e) {
            console.error('Failed to rebuild advisor index:', e);
            alert('重建触发失败');
        }
    };

    return (
        <div className="flex h-full">
            {/* Advisor List */}
            <div className="w-80 border-r border-border bg-surface-secondary/30 flex flex-col">
                <div className="p-4 border-b border-border flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-text-primary">智囊团</h2>
                    <button
                        onClick={handleCreate}
                        className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                        title="创建新成员"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-auto p-2 space-y-2">
                    {isLoading ? (
                        <div className="text-center text-text-tertiary text-xs py-8">加载中...</div>
                    ) : advisors.length === 0 ? (
                        <div className="text-center text-text-tertiary text-xs py-8">
                            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                            <p>暂无智囊团成员</p>
                            <button onClick={handleCreate} className="mt-2 text-accent-primary hover:underline">
                                创建第一个成员
                            </button>
                        </div>
                    ) : (
                        advisors.map((advisor) => (
                            <button
                                key={advisor.id}
                                onClick={() => setSelectedAdvisor(advisor)}
                                className={clsx(
                                    "w-full text-left p-3 rounded-xl transition-all",
                                    selectedAdvisor?.id === advisor.id
                                        ? "bg-accent-primary/10 border border-accent-primary/30 shadow-sm"
                                        : "hover:bg-surface-primary border border-transparent"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={clsx(
                                        "w-10 h-10 rounded-full flex items-center justify-center text-lg overflow-hidden shrink-0",
                                        isRenderableAvatarUrl(advisor.avatar)
                                            ? "bg-transparent border border-border/50"
                                            : AVATAR_COLORS[parseInt(advisor.id.slice(-1), 16) % AVATAR_COLORS.length]
                                    )}>
                                        {isRenderableAvatarUrl(advisor.avatar) ? (
                                            <img src={resolveAssetUrl(advisor.avatar)} alt={advisor.name} className="w-full h-full object-cover" />
                                        ) : (
                                            advisor.avatar
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium text-text-primary truncate">{advisor.name}</div>
                                        <div className="text-xs text-text-tertiary truncate">{advisor.personality}</div>
                                        <div className="text-[11px] text-text-tertiary truncate">知识库语言：{advisor.knowledgeLanguage || '中文'}</div>
                                    </div>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>

            {/* Advisor Detail */}
            <div className="flex-1 flex flex-col min-w-0">
                {selectedAdvisor ? (
                    <>
                        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className={clsx(
                                    "w-14 h-14 rounded-full flex items-center justify-center text-2xl overflow-hidden shrink-0",
                                    isRenderableAvatarUrl(selectedAdvisor.avatar)
                                        ? "bg-transparent border border-border"
                                        : AVATAR_COLORS[parseInt(selectedAdvisor.id.slice(-1), 16) % AVATAR_COLORS.length]
                                )}>
                                    {isRenderableAvatarUrl(selectedAdvisor.avatar) ? (
                                        <img src={resolveAssetUrl(selectedAdvisor.avatar)} alt={selectedAdvisor.name} className="w-full h-full object-cover" />
                                    ) : (
                                        selectedAdvisor.avatar
                                    )}
                                </div>
                                <div>
                                    <h1 className="text-lg font-semibold text-text-primary">{selectedAdvisor.name}</h1>
                                    <p className="text-xs text-text-tertiary">{selectedAdvisor.personality}</p>
                                    <p className="text-[11px] text-text-tertiary mt-1">知识库语言：{selectedAdvisor.knowledgeLanguage || '中文'}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => handleEdit(selectedAdvisor)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-accent-primary border border-border rounded-md"
                                >
                                    <Pencil className="w-3 h-3" /> 编辑
                                </button>
                                <button
                                    onClick={() => handleDelete(selectedAdvisor.id)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 border border-border rounded-md hover:bg-red-50"
                                >
                                    <Trash2 className="w-3 h-3" /> 删除
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto p-6 space-y-6">
                            {/* System Prompt - 可折叠 */}
                            <section>
                                <div className="flex items-center justify-between mb-2">
                                    <button
                                        onClick={() => setIsSystemPromptExpanded(!isSystemPromptExpanded)}
                                        className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-accent-primary transition-colors"
                                    >
                                        <Sparkles className="w-4 h-4 text-accent-primary" />
                                        角色设定
                                        {isSystemPromptExpanded ? (
                                            <ChevronUp className="w-4 h-4 text-text-tertiary" />
                                        ) : (
                                            <ChevronDown className="w-4 h-4 text-text-tertiary" />
                                        )}
                                    </button>
                                    <button
                                        onClick={async () => {
                                            if (!selectedAdvisor) return;
                                            setIsOptimizingPrompt(true);
                                            try {
                                                const result = await window.ipcRenderer.invoke('advisors:optimize-prompt-deep', {
                                                    advisorId: selectedAdvisor.id,
                                                    name: selectedAdvisor.name,
                                                    personality: selectedAdvisor.personality,
                                                    currentPrompt: selectedAdvisor.systemPrompt,
                                                }) as { success: boolean; prompt?: string; error?: string };

                                                if (result.success && result.prompt) {
                                                    // 更新本地状态
                                                    await window.ipcRenderer.invoke('advisors:update', {
                                                        ...selectedAdvisor,
                                                        systemPrompt: result.prompt,
                                                    });
                                                    // 刷新列表
                                                    await loadAdvisors();
                                                    // 更新选中的 advisor
                                                    setSelectedAdvisor(prev => prev ? { ...prev, systemPrompt: result.prompt! } : null);
                                                } else {
                                                    alert('优化失败: ' + (result.error || '未知错误'));
                                                }
                                            } catch (e) {
                                                console.error('Deep optimization error:', e);
                                                alert('优化失败，请检查 API 设置');
                                            } finally {
                                                setIsOptimizingPrompt(false);
                                            }
                                        }}
                                        disabled={isOptimizingPrompt}
                                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-accent-primary border border-accent-primary/30 rounded-md hover:bg-accent-primary/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <Sparkles className={clsx("w-3 h-3", isOptimizingPrompt && "animate-pulse")} />
                                        {isOptimizingPrompt ? '优化中...' : 'AI优化设定'}
                                    </button>
                                </div>

                                {/* 折叠状态：显示预览 */}
                                {!isSystemPromptExpanded ? (
                                    <div
                                        onClick={() => setIsSystemPromptExpanded(true)}
                                        className="bg-surface-secondary/50 rounded-lg border border-border p-3 cursor-pointer hover:border-accent-primary/30 transition-colors"
                                    >
                                        <p className="text-sm text-text-secondary line-clamp-2">
                                            {selectedAdvisor.systemPrompt || '未设置角色提示词，点击展开或使用 AI 优化'}
                                        </p>
                                        {selectedAdvisor.systemPrompt && selectedAdvisor.systemPrompt.length > 100 && (
                                            <span className="text-xs text-text-tertiary mt-1 inline-block">点击展开查看全部</span>
                                        )}
                                    </div>
                                ) : (
                                    <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                                        <pre className="text-sm text-text-primary whitespace-pre-wrap font-sans">
                                            {selectedAdvisor.systemPrompt || '未设置角色提示词'}
                                        </pre>
                                    </div>
                                )}
                            </section>

                            {/* Knowledge Base */}
                            <section>
                                <div className="flex items-center justify-between mb-4">
                                    <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                                        <FileText className="w-4 h-4 text-accent-primary" /> 专属知识库

                                        {/* Local Indexing Status Indicator */}
                                        {(() => {
                                            if (!indexingStatus) return null;

                                            // Filter tasks for this advisor
                                            const activeTasks = indexingStatus.activeItems?.filter((i: any) => i.metadata?.advisorId === selectedAdvisor.id) || [];
                                            const queuedTasks = indexingStatus.queuedItems?.filter((i: any) => i.metadata?.advisorId === selectedAdvisor.id) || [];
                                            const isIndexing = activeTasks.length > 0 || queuedTasks.length > 0;

                                            if (isIndexing) {
                                                return (
                                                    <span className="flex items-center gap-1.5 text-[10px] bg-accent-primary/10 text-accent-primary px-2 py-0.5 rounded-full font-medium">
                                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                                        处理中... ({activeTasks.length + queuedTasks.length})
                                                    </span>
                                                );
                                            } else {
                                                // Always show status + rebuild button
                                                return (
                                                    <div className="flex items-center gap-2">
                                                        {selectedAdvisor.knowledgeFiles.length > 0 && (
                                                            <span className="flex items-center gap-1.5 text-[10px] bg-green-500/10 text-green-600 px-2 py-0.5 rounded-full font-medium">
                                                                <Check className="w-3 h-3" />
                                                                索引已完成
                                                            </span>
                                                        )}
                                                        <button
                                                            onClick={() => handleRebuildAdvisorIndex(selectedAdvisor.id)}
                                                            className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-tertiary border border-border rounded hover:bg-surface-secondary hover:text-accent-primary transition-colors"
                                                            title="重新扫描并索引所有文件"
                                                        >
                                                            <RefreshCw className="w-3 h-3" />
                                                            重建索引
                                                        </button>
                                                    </div>
                                                );
                                            }
                                        })()}
                                    </h3>
                                    <button
                                        onClick={() => handleUploadKnowledge(selectedAdvisor.id)}
                                        className="flex items-center gap-1.5 px-2 py-1 text-xs text-accent-primary border border-accent-primary/30 rounded hover:bg-accent-primary/10"
                                    >
                                        <Upload className="w-3 h-3" /> 上传文件
                                    </button>
                                </div>

                                {/* Detailed Download Progress */}
                                {downloadStatus && downloadStatus.advisorId === selectedAdvisor.id && (
                                    <div className="mb-4 bg-surface-secondary/30 rounded-lg border border-border p-3">
                                        <div className="flex items-center gap-2 mb-1">
                                            <Upload className="w-3.5 h-3.5 text-accent-primary animate-bounce" />
                                            <span className="text-xs font-medium text-text-primary">正在下载字幕...</span>
                                        </div>
                                        <div className="text-[10px] text-text-tertiary font-mono truncate">
                                            {downloadStatus.progress}
                                        </div>
                                    </div>
                                )}

                                {selectedAdvisor.knowledgeFiles.length === 0 ? (
                                    <div className="bg-surface-secondary/30 rounded-lg border border-dashed border-border p-6 text-center">
                                        <FileText className="w-8 h-8 mx-auto mb-2 text-text-tertiary opacity-50" />
                                        <p className="text-xs text-text-tertiary">暂无知识库文件</p>
                                        <p className="text-[10px] text-text-tertiary mt-1">支持 .txt 和 .md 格式（YouTube 字幕会自动保存为 视频ID.txt）</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2 max-h-48 overflow-auto">
                                        {selectedAdvisor.knowledgeFiles.map((file) => {
                                            // Try to extract video ID and show human-readable name
                                            const videoId = file.replace('.txt', '').replace('.srt', '').replace('.vtt', '');
                                            const isVideoSubtitle = videoId.length === 11; // YouTube video IDs are 11 chars

                                            return (
                                                <div key={file} className="flex items-center justify-between bg-surface-secondary/50 rounded-lg border border-border px-4 py-2">
                                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                                        <FileText className="w-4 h-4 text-text-tertiary shrink-0" />
                                                        <div className="min-w-0 flex-1">
                                                            <span className="text-sm text-text-primary block truncate">{file}</span>
                                                            {isVideoSubtitle && (
                                                                <span className="text-[10px] text-text-tertiary">📺 YouTube 字幕</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={() => handleDeleteKnowledge(selectedAdvisor.id, file)}
                                                        className="text-text-tertiary hover:text-red-500"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </section>

                            {/* Video Management Section - Only for YouTube-imported advisors */}
                            <VideoManagement advisorId={selectedAdvisor.id} />
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-text-tertiary">
                        <div className="text-center">
                            <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="text-sm">选择一个智囊团成员查看详情</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Create/Edit Modal */}
            {isModalOpen && (
                <AdvisorModal
                    advisor={editingAdvisor}
                    onSave={handleSaveAdvisor}
                    onClose={() => setIsModalOpen(false)}
                />
            )}
        </div>
    );
}

// VideoEntry type (matches backend)
interface LocalVideoEntry {
    id: string;
    title: string;
    publishedAt: string;
    status: 'pending' | 'downloading' | 'success' | 'failed';
    retryCount: number;
    errorMessage?: string;
    subtitleFile?: string;
}

interface YoutubeChannelState {
    url: string;
    channelId?: string;
    lastRefreshed?: string;
    backgroundEnabled?: boolean;
    refreshIntervalMinutes?: number;
    subtitleDownloadIntervalSeconds?: number;
    maxVideosPerRefresh?: number;
    maxDownloadsPerRun?: number;
    lastBackgroundRunAt?: string;
    lastBackgroundError?: string;
}

interface YoutubeRunnerStatus {
    enabled: boolean;
    isTicking: boolean;
    tickIntervalMinutes: number;
    lastTickAt: string | null;
    nextTickAt: string | null;
    lastError: string | null;
}

// Video Management Component
function VideoManagement({ advisorId }: { advisorId: string }) {
    const [videos, setVideos] = useState<LocalVideoEntry[]>([]);
    const [youtubeChannel, setYoutubeChannel] = useState<YoutubeChannelState | null>(null);
    const [runnerStatus, setRunnerStatus] = useState<YoutubeRunnerStatus | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);
    const [isRunningNow, setIsRunningNow] = useState(false);
    const [filter, setFilter] = useState<'all' | 'downloading' | 'pending' | 'success' | 'failed'>('all');

    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);

    const [fetchCount, setFetchCount] = useState(50);
    const [showFetchSettings, setShowFetchSettings] = useState(false);

    const loadRunnerStatus = useCallback(async () => {
        try {
            const res = await window.ipcRenderer.getAdvisorYoutubeRunnerStatus();
            if (res.success) {
                setRunnerStatus(res.status || null);
            }
        } catch (e) {
            console.error(e);
        }
    }, []);

    const loadVideos = useCallback(async () => {
        setIsLoading(true);
        try {
            const res = await window.ipcRenderer.getVideos(advisorId);
            if (res.success) {
                setVideos(res.videos || []);
                setYoutubeChannel(res.youtubeChannel || null);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    }, [advisorId]);

    useEffect(() => {
        loadVideos();
        loadRunnerStatus();
    }, [loadVideos, loadRunnerStatus]);

    useEffect(() => {
        setCurrentPage(1);
    }, [filter]);

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            const res = await window.ipcRenderer.refreshVideos(advisorId, fetchCount);
            if (res.success) {
                setVideos(res.videos || []);
                setCurrentPage(1);
                await loadVideos();
            } else {
                alert('刷新失败: ' + res.error);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsRefreshing(false);
            setShowFetchSettings(false);
        }
    };

    const handleDownload = async (videoId: string) => {
        setVideos(vs => vs.map(v => v.id === videoId ? { ...v, status: 'downloading' as const } : v));
        const res = await window.ipcRenderer.downloadVideo(advisorId, videoId);
        if (res.success) {
            setVideos(vs => vs.map(v => v.id === videoId ? { ...v, status: 'success' as const, subtitleFile: res.subtitleFile } : v));
        } else {
            setVideos(vs => vs.map(v => v.id === videoId ? { ...v, status: 'failed' as const, errorMessage: res.error } : v));
        }
    };

    const handleRetryAll = async () => {
        try {
            const res = await window.ipcRenderer.retryFailedVideos(advisorId);
            if (!res.success) {
                alert('重试失败: ' + (res.error || '未知错误'));
            }
        } catch (e) {
            console.error(e);
        } finally {
            await loadVideos();
        }
    };

    const handleDownloadAll = async () => {
        const pendingVideos = videos.filter(v => v.status === 'pending');
        for (let i = 0; i < pendingVideos.length; i++) {
            await handleDownload(pendingVideos[i].id);
        }
        await loadVideos();
    };

    const updateYoutubeSetting = (key: keyof YoutubeChannelState, value: string | number | boolean) => {
        setYoutubeChannel((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                [key]: value,
            };
        });
    };

    const handleSaveYoutubeSettings = async () => {
        if (!youtubeChannel) return;
        setIsSavingSettings(true);
        try {
            const res = await window.ipcRenderer.updateAdvisorYoutubeSettings(advisorId, {
                backgroundEnabled: youtubeChannel.backgroundEnabled !== false,
                refreshIntervalMinutes: Number(youtubeChannel.refreshIntervalMinutes) || 180,
                subtitleDownloadIntervalSeconds: Number(youtubeChannel.subtitleDownloadIntervalSeconds) || 8,
                maxVideosPerRefresh: Number(youtubeChannel.maxVideosPerRefresh) || 20,
                maxDownloadsPerRun: Number(youtubeChannel.maxDownloadsPerRun) || 3,
            });
            if (!res.success) {
                alert('保存失败: ' + (res.error || '未知错误'));
                return;
            }
            await loadVideos();
            await loadRunnerStatus();
        } catch (e) {
            console.error(e);
            alert('保存失败，请稍后重试');
        } finally {
            setIsSavingSettings(false);
        }
    };

    const handleRunBackgroundNow = async () => {
        setIsRunningNow(true);
        try {
            const res = await window.ipcRenderer.runAdvisorYoutubeNow(advisorId);
            if (!res.success) {
                alert('后台同步失败: ' + (res.error || '未知错误'));
            }
            await loadVideos();
            await loadRunnerStatus();
        } catch (e) {
            console.error(e);
            alert('后台同步失败，请稍后重试');
        } finally {
            setIsRunningNow(false);
        }
    };

    if (!youtubeChannel) return null;

    const filteredVideos = videos.filter(v => filter === 'all' || v.status === filter);
    const stats = {
        success: videos.filter(v => v.status === 'success').length,
        failed: videos.filter(v => v.status === 'failed').length,
        pending: videos.filter(v => v.status === 'pending').length,
        downloading: videos.filter(v => v.status === 'downloading').length,
    };
    const isDownloading = stats.downloading > 0;

    return (
        <section className="mt-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                    📺 视频管理
                    <span className="text-[10px] text-text-tertiary font-normal">({videos.length} 个视频)</span>
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleRefresh}
                        disabled={isRefreshing || isDownloading}
                        className="flex items-center gap-1.5 px-2 py-1 text-xs border border-border rounded hover:bg-surface-secondary disabled:opacity-50"
                    >
                        <RefreshCw className={clsx('w-3 h-3', isRefreshing && 'animate-spin')} />
                        刷新列表
                    </button>
                    {stats.pending > 0 && !isDownloading && (
                        <button
                            onClick={handleDownloadAll}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs bg-accent-primary text-white rounded hover:opacity-90"
                        >
                            ⬇️ 下载全部 ({stats.pending})
                        </button>
                    )}
                    {stats.failed > 0 && !isDownloading && (
                        <button
                            onClick={handleRetryAll}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs bg-orange-500 text-white rounded hover:opacity-90"
                        >
                            🔄 重试失败 ({stats.failed})
                        </button>
                    )}
                </div>
            </div>

            {isDownloading && (
                <div className="mb-3 bg-surface-secondary/50 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-text-primary font-medium">⏬ 正在下载...</span>
                        <span className="text-[10px] text-text-tertiary">
                            {stats.success} / {stats.success + stats.downloading + stats.pending} 已完成
                        </span>
                    </div>
                    <div className="h-1.5 bg-border rounded-full overflow-hidden">
                        <div
                            className="h-full bg-accent-primary transition-all duration-300"
                            style={{ width: `${(stats.success / (stats.success + stats.downloading + stats.pending + stats.failed)) * 100}%` }}
                        />
                    </div>
                </div>
            )}

            <div className="mb-4 rounded-xl border border-border bg-surface-secondary/40 p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h4 className="text-sm font-medium text-text-primary">后台同步</h4>
                        <p className="text-xs text-text-tertiary mt-1">
                            轮询器会按设定间隔抓新视频并下载字幕，避免手动盯着执行。
                        </p>
                    </div>
                    <button
                        onClick={handleRunBackgroundNow}
                        disabled={isRunningNow}
                        className="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-accent-primary disabled:opacity-50"
                    >
                        {isRunningNow ? '同步中...' : '立即后台同步'}
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                        <div>
                            <div className="text-xs font-medium text-text-primary">启用后台轮询</div>
                            <div className="text-[10px] text-text-tertiary">关闭后仅保留手动刷新</div>
                        </div>
                        <input
                            type="checkbox"
                            checked={youtubeChannel.backgroundEnabled !== false}
                            onChange={(e) => updateYoutubeSetting('backgroundEnabled', e.target.checked)}
                            className="w-4 h-4 accent-accent-primary"
                        />
                    </label>

                    <label className="rounded-lg border border-border px-3 py-2">
                        <div className="text-xs font-medium text-text-primary">刷新间隔（分钟）</div>
                        <input
                            type="number"
                            min={15}
                            value={youtubeChannel.refreshIntervalMinutes || 180}
                            onChange={(e) => updateYoutubeSetting('refreshIntervalMinutes', Number(e.target.value))}
                            className="mt-2 w-full rounded-md border border-border bg-surface-primary px-2 py-1 text-xs"
                        />
                    </label>

                    <label className="rounded-lg border border-border px-3 py-2">
                        <div className="text-xs font-medium text-text-primary">字幕下载间隔（秒）</div>
                        <input
                            type="number"
                            min={3}
                            value={youtubeChannel.subtitleDownloadIntervalSeconds || 8}
                            onChange={(e) => updateYoutubeSetting('subtitleDownloadIntervalSeconds', Number(e.target.value))}
                            className="mt-2 w-full rounded-md border border-border bg-surface-primary px-2 py-1 text-xs"
                        />
                    </label>

                    <label className="rounded-lg border border-border px-3 py-2">
                        <div className="text-xs font-medium text-text-primary">每次刷新拉取视频数</div>
                        <input
                            type="number"
                            min={1}
                            value={youtubeChannel.maxVideosPerRefresh || 20}
                            onChange={(e) => updateYoutubeSetting('maxVideosPerRefresh', Number(e.target.value))}
                            className="mt-2 w-full rounded-md border border-border bg-surface-primary px-2 py-1 text-xs"
                        />
                    </label>

                    <label className="rounded-lg border border-border px-3 py-2">
                        <div className="text-xs font-medium text-text-primary">单次后台最多下载</div>
                        <input
                            type="number"
                            min={1}
                            value={youtubeChannel.maxDownloadsPerRun || 3}
                            onChange={(e) => updateYoutubeSetting('maxDownloadsPerRun', Number(e.target.value))}
                            className="mt-2 w-full rounded-md border border-border bg-surface-primary px-2 py-1 text-xs"
                        />
                    </label>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="text-[10px] text-text-tertiary space-y-1">
                        <p>全局轮询器: {runnerStatus?.enabled ? '已启动' : '未启动'}{runnerStatus?.isTicking ? '，执行中' : ''}</p>
                        {runnerStatus?.nextTickAt && <p>下次轮询: {new Date(runnerStatus.nextTickAt).toLocaleString()}</p>}
                        {youtubeChannel.lastBackgroundRunAt && <p>最近后台执行: {new Date(youtubeChannel.lastBackgroundRunAt).toLocaleString()}</p>}
                        {youtubeChannel.lastBackgroundError && (
                            <p className="text-red-500 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" />
                                最近错误: {youtubeChannel.lastBackgroundError}
                            </p>
                        )}
                    </div>
                    <button
                        onClick={handleSaveYoutubeSettings}
                        disabled={isSavingSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-accent-primary text-white hover:opacity-90 disabled:opacity-50"
                    >
                        {isSavingSettings ? '保存中...' : '保存设置'}
                    </button>
                </div>
            </div>

            <div className="flex items-center gap-3 mb-3 text-[10px]">
                <span className="text-text-tertiary">筛选:</span>
                {(['all', 'downloading', 'pending', 'success', 'failed'] as const).map(f => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={clsx(
                            'px-2 py-0.5 rounded transition-colors',
                            filter === f ? 'bg-accent-primary/10 text-accent-primary' : 'text-text-tertiary hover:text-text-secondary'
                        )}
                    >
                        {f === 'all' ? '全部' : f === 'downloading' ? '下载中' : f === 'pending' ? '待下载' : f === 'success' ? '已下载' : '失败'}
                        {f !== 'all' && ` (${stats[f]})`}
                    </button>
                ))}
            </div>

            {isLoading ? (
                <div className="text-center text-text-tertiary text-xs py-4">加载中...</div>
            ) : filteredVideos.length === 0 ? (
                <div className="text-center text-text-tertiary text-xs py-4">无匹配视频</div>
            ) : (
                <div className="border border-border rounded-lg overflow-hidden max-h-80 overflow-auto">
                    <table className="w-full text-xs">
                        <thead className="bg-surface-secondary/50 sticky top-0">
                            <tr>
                                <th className="text-left px-3 py-2 font-medium text-text-secondary">标题</th>
                                <th className="text-center px-2 py-2 font-medium text-text-secondary w-20">状态</th>
                                <th className="text-center px-2 py-2 font-medium text-text-secondary w-20">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredVideos.map((video) => (
                                <tr key={video.id} className="border-t border-border hover:bg-surface-secondary/30">
                                    <td className="px-3 py-2 truncate max-w-xs" title={video.title}>{video.title}</td>
                                    <td className="px-2 py-2 text-center">
                                        {video.status === 'success' && <span className="text-green-500">✅</span>}
                                        {video.status === 'failed' && <span className="text-red-500" title={video.errorMessage}>❌ ({video.retryCount})</span>}
                                        {video.status === 'pending' && <span className="text-yellow-500">⏳</span>}
                                        {video.status === 'downloading' && <span className="text-blue-500 animate-pulse">⏬</span>}
                                    </td>
                                    <td className="px-2 py-2 text-center">
                                        {video.status === 'pending' && (
                                            <button onClick={() => handleDownload(video.id)} className="text-accent-primary hover:underline">下载</button>
                                        )}
                                        {video.status === 'failed' && video.retryCount < 5 && (
                                            <button onClick={() => handleDownload(video.id)} className="text-orange-500 hover:underline">重试</button>
                                        )}
                                        {video.status === 'failed' && video.retryCount >= 5 && (
                                            <span className="text-text-tertiary">已达上限</span>
                                        )}
                                        {video.status === 'success' && (
                                            <span className="text-text-tertiary">{video.subtitleFile ? '📄' : '-'}</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {youtubeChannel.lastRefreshed && (
                <p className="text-[10px] text-text-tertiary mt-2">
                    最后刷新: {new Date(youtubeChannel.lastRefreshed).toLocaleString()}
                </p>
            )}
        </section>
    );
}

// Modal Component
function AdvisorModal({
    advisor,
    onSave,
    onClose
}: {
    advisor: Advisor | null;
    onSave: (data: Omit<Advisor, 'id' | 'createdAt' | 'knowledgeFiles'>, youtubeParams?: { url: string; count: number; channelId?: string }) => void;
    onClose: () => void;
}) {
    const [mode, setMode] = useState<'manual' | 'youtube'>(advisor ? 'manual' : 'manual');
    const [name, setName] = useState(advisor?.name || '');
    const [avatar, setAvatar] = useState(advisor?.avatar || AVATAR_OPTIONS[0]);
    const [personality, setPersonality] = useState(advisor?.personality || '');
    const [systemPrompt, setSystemPrompt] = useState(advisor?.systemPrompt || '');
    const [knowledgeLanguage, setKnowledgeLanguage] = useState(advisor?.knowledgeLanguage || '中文');

    // yt-dlp 状态检查
    const [ytdlpStatus, setYtdlpStatus] = useState<{ installed: boolean; version?: string } | null>(null);
    const [isCheckingYtdlp, setIsCheckingYtdlp] = useState(false);
    const [isInstallingYtdlp, setIsInstallingYtdlp] = useState(false);

    // YouTube specific
    const [youtubeUrl, setYoutubeUrl] = useState('');
    const [subtitleCount, setSubtitleCount] = useState(10);
    const [isLoadingInfo, setIsLoadingInfo] = useState(false);
    const [fetchMsg, setFetchMsg] = useState('');
    const [youtubeInfo, setYoutubeInfo] = useState<{ channelId: string; channelName: string; channelDescription: string; avatarUrl: string; recentVideos?: Array<{ id: string; title: string }> } | null>(null);

    const [isOptimizing, setIsOptimizing] = useState(false);

    // 切换到 YouTube 模式时检查 yt-dlp
    useEffect(() => {
        if (mode === 'youtube' && ytdlpStatus === null) {
            checkYtdlpStatus();
        }
    }, [mode]);

    const checkYtdlpStatus = async () => {
        setIsCheckingYtdlp(true);
        try {
            const status = await window.ipcRenderer.checkYtdlp();
            setYtdlpStatus(status);
        } catch (e) {
            console.error('Failed to check yt-dlp:', e);
            setYtdlpStatus({ installed: false });
        } finally {
            setIsCheckingYtdlp(false);
        }
    };

    const handleInstallYtdlp = async () => {
        setIsInstallingYtdlp(true);
        try {
            const result = await window.ipcRenderer.installYtdlp();
            if (result.success) {
                await checkYtdlpStatus();
            } else {
                alert('安装失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            alert('安装出错，请稍后重试');
        } finally {
            setIsInstallingYtdlp(false);
        }
    };

    useEffect(() => {
        const handleProgress = (_: unknown, msg: string) => setFetchMsg(msg);
        window.ipcRenderer.on('youtube:fetch-info-progress', handleProgress);
        return () => window.ipcRenderer.off('youtube:fetch-info-progress', handleProgress);
    }, []);

    const handleFetchYoutube = async () => {
        if (!youtubeUrl) return;
        setIsLoadingInfo(true);
        setFetchMsg('解析中...');
        try {
            const result = await window.ipcRenderer.fetchYoutubeInfo(youtubeUrl);
            if (result.success && result.data) {
                const info = result.data;
                setYoutubeInfo(info);
                setName(info.channelName);
                if (info.avatarUrl) setAvatar(info.avatarUrl);
                // Auto-generate personality/prompt from description
                if (info.channelDescription) {
                    setPersonality(info.channelDescription.slice(0, 50) + '...');
                    setSystemPrompt(`角色背景：\n${info.channelDescription}\n\n请模仿这个频道的风格进行对话。`);
                }
            } else {
                alert('获取失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            console.error(e);
            alert('获取失败，请检查 ytdlp 是否安装以及网络连接');
        } finally {
            setIsLoadingInfo(false);
        }
    };

    const handleSubmit = () => {
        if (!name.trim()) return;

        let ytParams = undefined;
        if (mode === 'youtube' && youtubeUrl) {
            ytParams = {
                url: youtubeUrl,
                count: subtitleCount,
                channelId: youtubeInfo?.channelId || ''
            };
        }

        onSave({ name, avatar, personality, systemPrompt, knowledgeLanguage }, ytParams);
    };

    const handleOptimize = async () => {
        if (!name && !personality && !systemPrompt) return;

        setIsOptimizing(true);
        const info = `角色名称: ${name}\n一句话描述: ${personality}\n当前设定: ${systemPrompt || '(未填写)'}`;

        try {
            const result = await window.ipcRenderer.invoke('advisors:optimize-prompt', { info }) as { success: boolean; prompt?: string; error?: string };
            if (result.success && result.prompt) {
                setSystemPrompt(result.prompt);
            } else {
                alert('优化失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            console.error('Optimization error:', e);
            alert('优化失败，请检查 API 设置');
        } finally {
            setIsOptimizing(false);
        }
    };

    // AI Persona Generation for YouTube mode
    const handleGeneratePersona = async () => {
        if (!youtubeInfo) {
            alert('请先获取频道信息');
            return;
        }

        setIsOptimizing(true);
        try {
            const result = await window.ipcRenderer.invoke('advisors:generate-persona', {
                advisorId: advisor?.id,
                channelName: youtubeInfo.channelName,
                channelDescription: youtubeInfo.channelDescription || '',
                videoTitles: youtubeInfo.recentVideos?.map((v: { title: string }) => v.title) || [],
                knowledgeLanguage,
            }) as { success: boolean; prompt?: string; personality?: string; error?: string };

            if (result.success && result.prompt) {
                setSystemPrompt(result.prompt);
                if (result.personality) {
                    setPersonality(result.personality);
                } else {
                    const firstSentence = result.prompt.split(/[。\n]/)[0];
                    if (firstSentence && firstSentence.length < 100) {
                        setPersonality(firstSentence);
                    }
                }
            } else {
                alert('生成失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            console.error('Persona generation error:', e);
            alert('生成失败，请检查 API 设置');
        } finally {
            setIsOptimizing(false);
        }
    };

    const handleSelectAvatar = async () => {
        try {
            const filePath = await window.ipcRenderer.invoke('advisors:select-avatar');
            if (filePath) {
                const previewUrl = resolveAssetUrl(String(filePath));
                setAvatar(previewUrl);
            }
        } catch (e) {
            console.error('Failed to select avatar:', e);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-lg mx-4 bg-surface-primary rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
                    <h3 className="text-base font-semibold text-text-primary">
                        {advisor ? '编辑智囊团成员' : '创建智囊团成员'}
                    </h3>
                    <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {!advisor && (
                    <div className="px-6 pt-4 shrink-0">
                        <div className="flex p-1 bg-surface-secondary rounded-lg">
                            <button
                                onClick={() => setMode('manual')}
                                className={clsx(
                                    "flex-1 text-xs font-medium py-1.5 rounded-md transition-all",
                                    mode === 'manual' ? "bg-surface-primary shadow-sm text-text-primary" : "text-text-tertiary hover:text-text-secondary"
                                )}
                            >
                                手动创建
                            </button>
                            <button
                                onClick={() => setMode('youtube')}
                                className={clsx(
                                    "flex-1 text-xs font-medium py-1.5 rounded-md transition-all",
                                    mode === 'youtube' ? "bg-surface-primary shadow-sm text-text-primary" : "text-text-tertiary hover:text-text-secondary"
                                )}
                            >
                                从 YouTube 导入
                            </button>
                        </div>
                    </div>
                )}

                <div className="px-6 py-4 space-y-4 overflow-auto flex-1">
                    {mode === 'youtube' && (
                        <div className="bg-surface-secondary/30 p-4 rounded-lg border border-border space-y-3">
                            {/* yt-dlp 状态检查 */}
                            {isCheckingYtdlp ? (
                                <div className="flex items-center gap-2 text-xs text-text-tertiary p-3 bg-surface-primary rounded-lg border border-border">
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    检查 yt-dlp 安装状态...
                                </div>
                            ) : ytdlpStatus && !ytdlpStatus.installed ? (
                                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                                    <div className="flex items-start gap-3">
                                        <div className="p-2 bg-amber-100 rounded-full shrink-0">
                                            <AlertCircle className="w-5 h-5 text-amber-600" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-medium text-amber-800">需要安装 yt-dlp</h4>
                                            <p className="text-xs text-amber-700 mt-1">
                                                从 YouTube 导入智囊团需要 yt-dlp 工具来获取频道信息和下载字幕。
                                            </p>
                                            <button
                                                onClick={handleInstallYtdlp}
                                                disabled={isInstallingYtdlp}
                                                className="mt-3 flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50"
                                            >
                                                {isInstallingYtdlp ? (
                                                    <>
                                                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                                        安装中...
                                                    </>
                                                ) : (
                                                    <>
                                                        <Download className="w-3.5 h-3.5" />
                                                        一键安装 yt-dlp
                                                    </>
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : ytdlpStatus?.installed ? (
                                /* yt-dlp 已安装，显示正常的 YouTube 导入界面 */
                                <>
                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1.5">YouTube 频道链接</label>
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={youtubeUrl}
                                                onChange={(e) => setYoutubeUrl(e.target.value)}
                                                placeholder="https://www.youtube.com/@channel"
                                                className="flex-1 bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                            />
                                            <button
                                                onClick={handleFetchYoutube}
                                                disabled={isLoadingInfo || !youtubeUrl}
                                                className="px-3 py-2 bg-accent-primary/10 text-accent-primary text-xs font-medium rounded-lg hover:bg-accent-primary/20 disabled:opacity-50 min-w-[80px]"
                                            >
                                                {isLoadingInfo ? (
                                                    <div className="flex items-center gap-1">
                                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                                        <span>{fetchMsg || '获取中...'}</span>
                                                    </div>
                                                ) : '获取信息'}
                                            </button>
                                        </div>
                                    </div>

                                    {youtubeInfo && (
                                        <div className="flex items-start gap-3 bg-surface-primary p-3 rounded-lg border border-border">
                                            <img src={resolveAssetUrl(youtubeInfo.avatarUrl)} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium text-text-primary">{youtubeInfo.channelName}</div>
                                                <div className="text-xs text-text-tertiary line-clamp-2">{youtubeInfo.channelDescription}</div>
                                            </div>
                                        </div>
                                    )}

                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                                            下载最近视频字幕作为知识库: <span className="text-accent-primary">{subtitleCount}</span> 个
                                        </label>
                                        <input
                                            type="range"
                                            min="0"
                                            max="50"
                                            value={subtitleCount}
                                            onChange={(e) => setSubtitleCount(parseInt(e.target.value))}
                                            className="w-full h-1 bg-border rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-accent-primary [&::-webkit-slider-thumb]:rounded-full"
                                        />
                                        <p className="text-[10px] text-text-tertiary mt-1">
                                            {subtitleCount === 0 ? '不下载字幕' : `将自动下载最近发布的 ${subtitleCount} 个视频字幕文件 (.vtt -> .txt)`}
                                        </p>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    )}

                    {/* Avatar Selection */}
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-2">选择头像</label>
                        <div className="flex gap-2 flex-wrap items-center">
                            {AVATAR_OPTIONS.map((opt) => (
                                <button
                                    key={opt}
                                    onClick={() => setAvatar(opt)}
                                    className={clsx(
                                        "w-10 h-10 rounded-full flex items-center justify-center text-lg border-2 transition-all",
                                        avatar === opt ? "border-accent-primary bg-accent-primary/10" : "border-border hover:border-accent-primary/50"
                                    )}
                                >
                                    {opt}
                                </button>
                            ))}

                            {/* Upload Button */}
                            <button
                                onClick={handleSelectAvatar}
                                className="w-10 h-10 rounded-full flex items-center justify-center border-2 border-dashed border-border hover:border-accent-primary hover:bg-accent-primary/5 text-text-tertiary hover:text-accent-primary transition-all"
                                title="上传图片"
                            >
                                <Upload className="w-4 h-4" />
                            </button>

                            {/* Preview Custom/URL Avatar */}
                            {isRenderableAvatarUrl(avatar) && (
                                <div className="relative group">
                                    <button
                                        className="w-10 h-10 rounded-full flex items-center justify-center border-2 border-accent-primary overflow-hidden relative"
                                    >
                                        <img src={resolveAssetUrl(avatar)} alt="" className="w-full h-full object-cover" />
                                    </button>
                                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-accent-primary rounded-full border-2 border-white flex items-center justify-center">
                                        <Check className="w-2 h-2 text-white" />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Name */}
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">角色名称</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="例如：运营专家、心理学家..."
                            className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                    </div>

                    {/* Personality */}
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">一句话描述</label>
                        <input
                            type="text"
                            value={personality}
                            onChange={(e) => setPersonality(e.target.value)}
                            placeholder="例如：擅长数据分析和增长策略"
                            className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">知识库内容语言</label>
                        <input
                            type="text"
                            value={knowledgeLanguage}
                            onChange={(e) => setKnowledgeLanguage(e.target.value)}
                            placeholder="例如：中文、英文、日文、意大利语"
                            className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                        <p className="mt-1 text-[11px] text-text-tertiary">
                            这个字段会直接影响成员检索自己知识库时的语言理解方式。
                        </p>
                    </div>

                    {/* System Prompt */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-xs font-medium text-text-secondary">角色设定（系统提示词）</label>
                            {mode === 'youtube' ? (
                                <button
                                    onClick={handleGeneratePersona}
                                    disabled={isOptimizing || !youtubeInfo}
                                    className="flex items-center gap-1.5 px-2 py-1 text-xs text-accent-primary border border-accent-primary/30 rounded hover:bg-accent-primary/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Sparkles className={clsx("w-3 h-3", isOptimizing && "animate-pulse")} />
                                    {isOptimizing ? '生成中...' : '🤖 AI 生成人设'}
                                </button>
                            ) : (
                                <button
                                    onClick={handleOptimize}
                                    disabled={isOptimizing || (!name && !personality)}
                                    className="flex items-center gap-1.5 px-2 py-1 text-xs text-accent-primary border border-accent-primary/30 rounded hover:bg-accent-primary/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Sparkles className={clsx("w-3 h-3", isOptimizing && "animate-pulse")} />
                                    {isOptimizing ? '优化中...' : '✨ AI 智能优化'}
                                </button>
                            )}
                        </div>
                        <textarea
                            value={systemPrompt}
                            onChange={(e) => setSystemPrompt(e.target.value)}
                            placeholder="描述这个角色的背景、专业领域、说话风格等...&#10;&#10;💡 提示：填写名称和描述后，点击「AI 智能优化」自动生成专业提示词"
                            rows={8}
                            className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-accent-primary"
                        />
                    </div>
                </div>

                <div className="px-6 py-4 bg-surface-secondary border-t border-border flex items-center justify-end gap-3 shrink-0">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg">
                        取消
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!name.trim()}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-accent-primary rounded-lg disabled:opacity-50"
                    >
                        <Check className="w-4 h-4" />
                        {advisor ? '保存' : '创建'}
                    </button>
                </div>
            </div>
        </div>
    );
}
