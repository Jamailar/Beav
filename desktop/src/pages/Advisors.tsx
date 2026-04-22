import { useEffect, useState, useCallback, useRef } from 'react';
import { Users, Plus, Pencil, Trash2, Upload, FileText, X, Check, Sparkles, RefreshCw, ChevronDown, ChevronUp, AlertCircle, Download, MoreHorizontal, History, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Chat } from './Chat';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';
import { appAlert, appConfirm } from '../utils/appDialogs';

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

export type AdvisorProfile = Advisor;
export type AdvisorCreateMode = 'manual' | 'template' | 'youtube';

interface AdvisorTemplate {
    id: string;
    name: string;
    avatar?: string;
    description?: string;
    category?: string;
    tags?: string[];
    personality?: string;
    systemPrompt?: string;
    knowledgeLanguage?: string;
}

interface PendingKnowledgeFile {
    path: string;
    name: string;
}

const AVATAR_OPTIONS = ['🧠', '💡', '📊', '🎨', '📝', '🔍', '💼', '🎯', '🌟', '🚀'];
const AVATAR_COLORS = [
    'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-orange-500',
    'bg-green-500', 'bg-teal-500', 'bg-indigo-500', 'bg-rose-500'
];
const ADVISOR_CHAT_CONTEXT_TYPE = 'advisor-discussion';

const isRenderableAvatarUrl = (value: string): boolean => {
    return hasRenderableAssetUrl(value);
};

const buildAdvisorInitialContext = (advisor: Advisor): string => {
    const sections = [
        `当前对话绑定成员：${advisor.name}`,
        advisor.personality ? `成员定位：${advisor.personality}` : null,
        `知识库语言：${advisor.knowledgeLanguage || '中文'}`,
        advisor.knowledgeFiles.length > 0 ? `已接入知识文件：${advisor.knowledgeFiles.length} 个` : '当前暂无知识文件',
        '请始终以该成员身份回答，保持表达风格、专业倾向和角色设定一致。',
        advisor.systemPrompt ? `系统设定：\n${advisor.systemPrompt}` : null,
    ];
    return sections.filter(Boolean).join('\n\n');
};

const getAdvisorWelcomeAvatarText = (advisor: Advisor): string => {
    const avatarText = String(advisor.avatar || '').trim();
    if (avatarText) {
        return avatarText.slice(0, 2);
    }
    return String(advisor.name || '成').trim().slice(0, 2);
};

const sortAdvisorSessionItems = (items: ContextChatSessionListItem[]): ContextChatSessionListItem[] => {
    return [...items].sort((left, right) => {
        const leftUpdatedAt = String(left.chatSession?.updatedAt || '').trim();
        const rightUpdatedAt = String(right.chatSession?.updatedAt || '').trim();
        return rightUpdatedAt.localeCompare(leftUpdatedAt);
    });
};

const formatAdvisorSessionTime = (value?: string): string => {
    const text = String(value || '').trim();
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};

export function Advisors({
    isActive = true,
    hideAdvisorList = false,
    selectedAdvisorId,
    onSelectedAdvisorIdChange,
    onAdvisorsChange,
    createRequestKey,
    createRequestMode = 'manual',
}: {
    isActive?: boolean;
    hideAdvisorList?: boolean;
    selectedAdvisorId?: string | null;
    onSelectedAdvisorIdChange?: (advisorId: string | null) => void;
    onAdvisorsChange?: (advisors: Advisor[]) => void;
    createRequestKey?: number;
    createRequestMode?: AdvisorCreateMode;
}) {
    const [advisors, setAdvisors] = useState<Advisor[]>([]);
    const [selectedAdvisor, setSelectedAdvisor] = useState<Advisor | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [pendingCreateMode, setPendingCreateMode] = useState<AdvisorCreateMode>('manual');

    const [editingAdvisor, setEditingAdvisor] = useState<Advisor | null>(null);
    const [downloadStatus, setDownloadStatus] = useState<{ advisorId: string; progress: string } | null>(null);
    const [isSystemPromptExpanded, setIsSystemPromptExpanded] = useState(false); // 默认折叠
    const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false); // AI优化状态
    const [advisorSessionId, setAdvisorSessionId] = useState<string | null>(null);
    const [isAdvisorSessionLoading, setIsAdvisorSessionLoading] = useState(false);
    const [isSettingsDrawerOpen, setIsSettingsDrawerOpen] = useState(false);
    const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
    const [advisorSessions, setAdvisorSessions] = useState<ContextChatSessionListItem[]>([]);
    const [isHistoryLoading, setIsHistoryLoading] = useState(false);

    const hasLoadedSnapshotRef = useRef(false);
    const loadAdvisorsRequestRef = useRef(0);
    const createRequestKeyRef = useRef<number | undefined>(createRequestKey);
    const advisorSessionRequestRef = useRef(0);
    const hasAdvisorSessionSnapshotRef = useRef(false);
    const advisorSessionIdRef = useRef<string | null>(null);
    const activeAdvisorIdRef = useRef<string | null>(null);

    const loadAdvisors = useCallback(async (): Promise<Advisor[]> => {
        const requestId = loadAdvisorsRequestRef.current + 1;
        loadAdvisorsRequestRef.current = requestId;
        if (!hasLoadedSnapshotRef.current) {
            setIsLoading(true);
        }
        try {
            const list = await window.ipcRenderer.advisors.list<Advisor>();
            if (requestId !== loadAdvisorsRequestRef.current) return [];
            if (list == null) {
                return hasLoadedSnapshotRef.current ? advisors : [];
            }
            const normalizedList = Array.isArray(list) ? list : [];
            setAdvisors(normalizedList);
            setSelectedAdvisor((prev) => {
                if (!prev) return prev;
                return normalizedList.find((item) => item.id === prev.id) || null;
            });
            hasLoadedSnapshotRef.current = true;
            return normalizedList;
        } catch (e) {
            if (requestId !== loadAdvisorsRequestRef.current) return [];
            console.error('Failed to load advisors:', e);
            return [];
        } finally {
            if (requestId === loadAdvisorsRequestRef.current) {
                setIsLoading(false);
            }
        }
    }, [advisors]);

    // Listen for download progress
    useEffect(() => {
        if (!isActive) return;
        const handleDownloadProgress = (_event: unknown, data: { advisorId: string; progress: string }) => {
            setDownloadStatus(data);
            // 检测下载完成（新架构会发送"下载完成！"消息）
            if (data.progress.includes('下载完成') || data.progress.includes('下载失败')) {
                // 刷新 advisor 列表以更新 knowledgeFiles
                setTimeout(() => {
                    void loadAdvisors();
                    // 清除下载状态显示
                    setTimeout(() => setDownloadStatus(null), 3000);
                }, 1000);
            }
        };

        window.ipcRenderer.on('advisors:download-progress', handleDownloadProgress);
        return () => {
            window.ipcRenderer.off('advisors:download-progress', handleDownloadProgress);
        };
    }, [isActive, loadAdvisors]);

    useEffect(() => {
        if (!isActive) return;
        void loadAdvisors();
    }, [isActive, loadAdvisors]);

    useEffect(() => {
        onAdvisorsChange?.(advisors);
    }, [advisors, onAdvisorsChange]);

    useEffect(() => {
        if (createRequestKey === undefined) return;
        if (createRequestKeyRef.current === createRequestKey) return;
        createRequestKeyRef.current = createRequestKey;
        setEditingAdvisor(null);
        setPendingCreateMode(createRequestMode);
        setIsModalOpen(true);
    }, [createRequestKey, createRequestMode]);

    useEffect(() => {
        if (selectedAdvisorId === undefined) return;
        if (!selectedAdvisorId) {
            setSelectedAdvisor(null);
            return;
        }
        if (selectedAdvisor?.id === selectedAdvisorId) return;
        const matchedAdvisor = advisors.find((advisor) => advisor.id === selectedAdvisorId) || null;
        if (matchedAdvisor) {
            setSelectedAdvisor(matchedAdvisor);
        }
    }, [advisors, selectedAdvisor, selectedAdvisorId]);

    useEffect(() => {
        setIsSystemPromptExpanded(false);
    }, [selectedAdvisor?.id]);

    useEffect(() => {
        advisorSessionIdRef.current = advisorSessionId;
    }, [advisorSessionId]);

    useEffect(() => {
        if (!isSettingsDrawerOpen && !isHistoryDrawerOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsSettingsDrawerOpen(false);
                setIsHistoryDrawerOpen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isHistoryDrawerOpen, isSettingsDrawerOpen]);

    const loadAdvisorSessions = useCallback(async (
        advisor: Advisor,
        options?: {
            preferredSessionId?: string | null;
            createIfEmpty?: boolean;
            silent?: boolean;
        },
    ) => {
        const requestId = advisorSessionRequestRef.current + 1;
        advisorSessionRequestRef.current = requestId;
        const shouldCreateIfEmpty = options?.createIfEmpty !== false;

        if (!hasAdvisorSessionSnapshotRef.current && !options?.silent) {
            setIsAdvisorSessionLoading(true);
        }
        if (!options?.silent) {
            setIsHistoryLoading(true);
        }

        try {
            const list = await window.ipcRenderer.invokeGuarded<ContextChatSessionListItem[] | null>('chat:list-context-sessions', {
                contextId: advisor.id,
                contextType: ADVISOR_CHAT_CONTEXT_TYPE,
            }, {
                timeoutMs: 3200,
                fallback: null,
                normalize: (value) => Array.isArray(value) ? value as ContextChatSessionListItem[] : [],
            });
            if (requestId !== advisorSessionRequestRef.current) return;
            if (list == null) {
                if (!hasAdvisorSessionSnapshotRef.current) {
                    setAdvisorSessions([]);
                    setAdvisorSessionId(null);
                }
                return;
            }

            let items = sortAdvisorSessionItems(Array.isArray(list) ? list : []);

            let nextSessionId =
                options?.preferredSessionId && items.some((item) => item.id === options.preferredSessionId)
                    ? options.preferredSessionId
                    : advisorSessionIdRef.current && items.some((item) => item.id === advisorSessionIdRef.current)
                        ? advisorSessionIdRef.current
                        : items[0]?.id || null;

            if (items.length === 0 && shouldCreateIfEmpty) {
                const created = await window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                    contextId: advisor.id,
                    contextType: ADVISOR_CHAT_CONTEXT_TYPE,
                    title: `与 ${advisor.name} 聊聊`,
                    initialContext: buildAdvisorInitialContext(advisor),
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                });
                if (!created) {
                    if (!hasAdvisorSessionSnapshotRef.current) {
                        setAdvisorSessions([]);
                        setAdvisorSessionId(null);
                    }
                    return;
                }
                items = [{
                    id: created.id,
                    messageCount: 0,
                    summary: '',
                    transcriptCount: 0,
                    checkpointCount: 0,
                    chatSession: {
                        id: created.id,
                        title: created.title,
                        updatedAt: created.updatedAt,
                    },
                }];
                nextSessionId = created.id;
            }

            if (requestId !== advisorSessionRequestRef.current) return;
            hasAdvisorSessionSnapshotRef.current = true;
            setAdvisorSessions(items);
            setAdvisorSessionId(nextSessionId);
        } catch (error) {
            if (requestId !== advisorSessionRequestRef.current) return;
            console.error('Failed to load advisor sessions:', error);
            if (!hasAdvisorSessionSnapshotRef.current) {
                setAdvisorSessions([]);
                setAdvisorSessionId(null);
            }
        } finally {
            if (requestId === advisorSessionRequestRef.current) {
                setIsAdvisorSessionLoading(false);
                setIsHistoryLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        const nextAdvisorId = selectedAdvisor?.id || null;
        if (!isActive || !selectedAdvisor || !nextAdvisorId) {
            activeAdvisorIdRef.current = null;
            setAdvisorSessionId(null);
            setAdvisorSessions([]);
            setIsAdvisorSessionLoading(false);
            hasAdvisorSessionSnapshotRef.current = false;
            if (!selectedAdvisor) {
                setIsSettingsDrawerOpen(false);
                setIsHistoryDrawerOpen(false);
            }
            return;
        }

        if (activeAdvisorIdRef.current === nextAdvisorId) {
            return;
        }

        activeAdvisorIdRef.current = nextAdvisorId;
        hasAdvisorSessionSnapshotRef.current = false;
        setAdvisorSessions([]);
        setAdvisorSessionId(null);
        void loadAdvisorSessions(selectedAdvisor);
    }, [isActive, selectedAdvisor?.id, loadAdvisorSessions, selectedAdvisor]);

    const handleCreate = (mode: AdvisorCreateMode = 'manual') => {
        setEditingAdvisor(null);
        setPendingCreateMode(mode);
        setIsModalOpen(true);
    };

    const handleEdit = (advisor: Advisor) => {
        setEditingAdvisor(advisor);
        setPendingCreateMode('manual');
        setIsModalOpen(true);
    };

    const handleOptimizePrompt = useCallback(async (advisor: Advisor) => {
        setIsOptimizingPrompt(true);
        try {
            const result = await window.ipcRenderer.advisors.optimizePromptDeep({
                advisorId: advisor.id,
                name: advisor.name,
                personality: advisor.personality,
                currentPrompt: advisor.systemPrompt,
            }) as { success: boolean; prompt?: string; error?: string };

            if (result.success && result.prompt) {
                await window.ipcRenderer.advisors.update({
                    ...advisor,
                    systemPrompt: result.prompt,
                });
                await loadAdvisors();
                setSelectedAdvisor((prev) => prev ? { ...prev, systemPrompt: result.prompt! } : null);
                return;
            }
            void appAlert('优化失败: ' + (result.error || '未知错误'));
        } catch (e) {
            console.error('Deep optimization error:', e);
            void appAlert('优化失败，请检查 API 设置');
        } finally {
            setIsOptimizingPrompt(false);
        }
    }, [loadAdvisors]);

    const handleCreateAdvisorSession = useCallback(async () => {
        if (!selectedAdvisor) return;
        setIsHistoryLoading(true);
        try {
            const created = await window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                contextId: selectedAdvisor.id,
                contextType: ADVISOR_CHAT_CONTEXT_TYPE,
                title: `与 ${selectedAdvisor.name} 聊聊`,
                initialContext: buildAdvisorInitialContext(selectedAdvisor),
            }, {
                timeoutMs: 3200,
                fallback: null,
            });
            if (!created) {
                throw new Error('create advisor session timed out');
            }
            setAdvisorSessionId(created.id);
            await loadAdvisorSessions(selectedAdvisor, {
                preferredSessionId: created.id,
                silent: true,
            });
            setIsHistoryDrawerOpen(false);
        } catch (error) {
            console.error('Failed to create advisor session:', error);
        } finally {
            setIsHistoryLoading(false);
        }
    }, [loadAdvisorSessions, selectedAdvisor]);

    const handleDeleteAdvisorSession = useCallback(async (sessionId: string) => {
        if (!selectedAdvisor) return;
        if (!(await appConfirm('确定要删除这条对话记录吗？', { title: '删除对话', confirmLabel: '删除', tone: 'danger' }))) return;
        try {
            await window.ipcRenderer.chat.deleteSession(sessionId);
            const nextPreferredSessionId = advisorSessionId === sessionId ? null : advisorSessionId;
            await loadAdvisorSessions(selectedAdvisor, {
                preferredSessionId: nextPreferredSessionId,
            });
        } catch (error) {
            console.error('Failed to delete advisor session:', error);
        }
    }, [advisorSessionId, loadAdvisorSessions, selectedAdvisor]);

    const handleDelete = async (advisorId: string) => {
        if (!(await appConfirm('确定要删除这个智囊团成员吗？', { title: '删除成员', confirmLabel: '删除', tone: 'danger' }))) return;
        try {
            await window.ipcRenderer.advisors.delete(advisorId);
            await loadAdvisors();
            if (selectedAdvisor?.id === advisorId) {
                setSelectedAdvisor(null);
                onSelectedAdvisorIdChange?.(null);
            }
        } catch (e) {
            console.error('Failed to delete advisor:', e);
        }
    };

    const handleSaveAdvisor = async (
        data: Omit<Advisor, 'id' | 'createdAt' | 'knowledgeFiles'>,
        youtubeParams?: { url: string; count: number; channelId?: string },
        knowledgeFilePaths?: string[],
    ) => {
        try {
            let newId: string | undefined;
            if (editingAdvisor) {
                await window.ipcRenderer.advisors.update({ ...editingAdvisor, ...data });
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
                const res = await window.ipcRenderer.advisors.create(createData) as { success: boolean; id?: string };
                if (res.success) newId = res.id;
            }

            if (newId && !editingAdvisor && Array.isArray(knowledgeFilePaths) && knowledgeFilePaths.length > 0) {
                await window.ipcRenderer.advisors.uploadKnowledge({
                    advisorId: newId,
                    filePaths: knowledgeFilePaths,
                });
            }

            if (newId && !editingAdvisor && !youtubeParams && Array.isArray(knowledgeFilePaths) && knowledgeFilePaths.length > 0) {
                const personaResult = await window.ipcRenderer.advisors.generatePersona({
                    advisorId: newId,
                    channelName: data.name,
                    channelDescription: data.personality || '',
                    videoTitles: [],
                    knowledgeLanguage: data.knowledgeLanguage || '中文',
                }) as { success: boolean; systemPrompt?: string; personality?: string; error?: string };
                if (!personaResult.success || !personaResult.systemPrompt) {
                    throw new Error(personaResult.error || '角色创建失败');
                }
                await window.ipcRenderer.advisors.update({
                    id: newId,
                    systemPrompt: personaResult.systemPrompt,
                    personality: personaResult.personality || data.personality,
                });
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
            const list = await loadAdvisors();
            if (newId) {
                const nextSelectedAdvisor = list.find((advisor) => advisor.id === newId) || null;
                setSelectedAdvisor(nextSelectedAdvisor);
                onSelectedAdvisorIdChange?.(nextSelectedAdvisor?.id || null);
                if (!editingAdvisor) {
                    void appAlert('角色创建成功');
                }
            }
        } catch (e) {
            console.error('Failed to save advisor:', e);
            void appAlert(`创建成员失败：${e instanceof Error ? e.message : '未知错误'}`);
        }
    };

    const handleUploadKnowledge = async (advisorId: string) => {
        try {
            const result = await window.ipcRenderer.advisors.uploadKnowledge(advisorId);
            if (result) {
                const list = await loadAdvisors();
                const updated = list.find(a => a.id === advisorId);
                if (updated) setSelectedAdvisor(updated);
            }
        } catch (e) {
            console.error('Failed to upload knowledge:', e);
        }
    };

    const handleDeleteKnowledge = async (advisorId: string, fileName: string) => {
        if (!(await appConfirm(`确定要删除知识库文件 "${fileName}" 吗？`, { title: '删除知识文件', confirmLabel: '删除', tone: 'danger' }))) return;
        try {
            await window.ipcRenderer.advisors.deleteKnowledge({ advisorId, fileName });
            await loadAdvisors();
        } catch (e) {
            console.error('Failed to delete knowledge file:', e);
        }
    };

    return (
        <div className="flex h-full min-h-0">
            {!hideAdvisorList && (
                <div className="w-80 border-r border-border bg-surface-secondary/30 flex flex-col">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-text-primary">智囊团</h2>
                        <button
                            onClick={() => handleCreate()}
                            className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                            title="创建新成员"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-auto p-2 space-y-2">
                        {isLoading && advisors.length === 0 ? (
                            <div className="text-center text-text-tertiary text-xs py-8">加载中...</div>
                        ) : advisors.length === 0 ? (
                            <div className="text-center text-text-tertiary text-xs py-8">
                                <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                <p>暂无智囊团成员</p>
                                <button onClick={() => handleCreate()} className="mt-2 text-accent-primary hover:underline">
                                    创建第一个成员
                                </button>
                            </div>
                        ) : (
                            advisors.map((advisor) => (
                                <button
                                    key={advisor.id}
                                    onClick={() => {
                                        setSelectedAdvisor(advisor);
                                        onSelectedAdvisorIdChange?.(advisor.id);
                                    }}
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
            )}

            {/* Advisor Detail */}
            <div className="relative flex h-full min-h-0 flex-1 min-w-0 flex-col">
                {selectedAdvisor ? (
                    <>
                        <div className="relative h-20 border-b border-border bg-surface-primary/90 backdrop-blur-sm">
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="flex flex-col items-center justify-center">
                                    <div className={clsx(
                                    "w-10 h-10 rounded-full flex items-center justify-center text-lg overflow-hidden shrink-0",
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
                                    <h1 className="mt-2 text-sm font-semibold leading-none text-text-primary">{selectedAdvisor.name}</h1>
                                </div>
                            </div>
                            <div className="absolute left-5 top-1/2 -translate-y-1/2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsSettingsDrawerOpen(false);
                                        setIsHistoryDrawerOpen((prev) => !prev);
                                        if (!isHistoryDrawerOpen && selectedAdvisor) {
                                            void loadAdvisorSessions(selectedAdvisor, { silent: true });
                                        }
                                    }}
                                    className={clsx(
                                        'flex items-center gap-2 rounded-xl border border-white/40 px-3.5 py-1.5 text-[12px] font-bold shadow-sm backdrop-blur-xl transition-all active:scale-95',
                                        isHistoryDrawerOpen
                                            ? 'bg-accent-primary text-white border-transparent'
                                            : 'bg-white/70 text-text-secondary hover:bg-white/90 hover:text-text-primary'
                                    )}
                                    title="对话历史"
                                    aria-label="对话历史"
                                >
                                    <History className="w-4 h-4" />
                                    <span>历史</span>
                                </button>
                            </div>
                            <div className="absolute right-6 top-1/2 flex -translate-y-1/2 items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsHistoryDrawerOpen(false);
                                        setIsSettingsDrawerOpen(true);
                                    }}
                                    className="h-9 w-9 rounded-full border border-border bg-surface-primary text-text-tertiary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center"
                                    title="成员设置"
                                    aria-label="成员设置"
                                >
                                    <MoreHorizontal className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <div className="relative flex-1 min-h-0 bg-background">
                            {isAdvisorSessionLoading && !advisorSessionId ? (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="flex flex-col items-center gap-3 text-text-tertiary">
                                        <div className="w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
                                        <span className="text-xs">正在连接会话...</span>
                                    </div>
                                </div>
                            ) : advisorSessionId ? (
                                <Chat
                                    key={advisorSessionId}
                                    isActive={isActive}
                                    fixedSessionId={advisorSessionId}
                                    defaultCollapsed={true}
                                    fixedSessionBannerText=""
                                    fixedSessionContextIndicatorMode="none"
                                    welcomeTitle={`和 ${selectedAdvisor.name} 聊聊`}
                                    welcomeSubtitle={selectedAdvisor.personality || '直接提问，成员会按自己的设定回复'}
                                    welcomeIconSrc={isRenderableAvatarUrl(selectedAdvisor.avatar) ? resolveAssetUrl(selectedAdvisor.avatar) : undefined}
                                    welcomeAvatarText={isRenderableAvatarUrl(selectedAdvisor.avatar) ? undefined : getAdvisorWelcomeAvatarText(selectedAdvisor)}
                                    welcomeIconVariant="avatar"
                                    emptyStateVerticalAlign="lower"
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-text-tertiary">
                                    会话初始化失败
                                </div>
                            )}

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

                {selectedAdvisor && isHistoryDrawerOpen && (
                    <AdvisorHistoryPanel
                        advisor={selectedAdvisor}
                        sessions={advisorSessions}
                        activeSessionId={advisorSessionId}
                        isLoading={isHistoryLoading}
                        onSelectSession={(sessionId) => {
                            setAdvisorSessionId(sessionId);
                            setIsHistoryDrawerOpen(false);
                        }}
                        onCreateSession={() => void handleCreateAdvisorSession()}
                        onDeleteSession={(sessionId) => void handleDeleteAdvisorSession(sessionId)}
                        onClose={() => setIsHistoryDrawerOpen(false)}
                    />
                )}

                {selectedAdvisor && isSettingsDrawerOpen && (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-30 bg-black/20 backdrop-blur-[2px] transition-opacity"
                            onClick={() => setIsSettingsDrawerOpen(false)}
                            aria-label="关闭成员设置"
                        />
                        <aside className="absolute right-4 top-4 bottom-4 z-40 w-[30rem] max-w-[min(46vw,30rem)] overflow-hidden rounded-2xl border border-white/60 bg-white/85 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.16)] backdrop-blur-[40px] animate-slide-in-right">
                            <AdvisorSettingsPanel
                                advisor={selectedAdvisor}
                                isActive={isActive}
                                downloadStatus={downloadStatus}
                                isSystemPromptExpanded={isSystemPromptExpanded}
                                setIsSystemPromptExpanded={setIsSystemPromptExpanded}
                                isOptimizingPrompt={isOptimizingPrompt}
                                onOptimizePrompt={() => void handleOptimizePrompt(selectedAdvisor)}
                                onUploadKnowledge={() => void handleUploadKnowledge(selectedAdvisor.id)}
                                onDeleteKnowledge={(fileName) => void handleDeleteKnowledge(selectedAdvisor.id, fileName)}
                                onEdit={() => handleEdit(selectedAdvisor)}
                                onDelete={() => void handleDelete(selectedAdvisor.id)}
                                onClose={() => setIsSettingsDrawerOpen(false)}
                            />
                        </aside>
                    </>
                )}
            </div>

            {/* Create/Edit Modal */}
            {isModalOpen && (
                <AdvisorModal
                    advisor={editingAdvisor}
                    defaultMode={pendingCreateMode}
                    onSave={handleSaveAdvisor}
                    onClose={() => setIsModalOpen(false)}
                />
            )}
        </div>
    );
}

function AdvisorHistoryPanel({
    advisor,
    sessions,
    activeSessionId,
    isLoading,
    onSelectSession,
    onCreateSession,
    onDeleteSession,
    onClose,
}: {
    advisor: Advisor;
    sessions: ContextChatSessionListItem[];
    activeSessionId: string | null;
    isLoading: boolean;
    onSelectSession: (sessionId: string) => void;
    onCreateSession: () => void;
    onDeleteSession: (sessionId: string) => void;
    onClose: () => void;
}) {
    return (
        <div className="absolute inset-0 z-40">
            <button
                type="button"
                className="absolute inset-0 bg-black/[0.02] backdrop-blur-[2px] transition-opacity"
                aria-label="关闭历史对话抽屉"
                onClick={onClose}
            />

            <div className="absolute left-4 top-4 bottom-4 w-[320px] max-w-[calc(100%-2rem)] rounded-2xl border border-white/60 bg-white/85 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.12)] backdrop-blur-[40px] overflow-hidden flex flex-col animate-slide-in-left-refined">
                <div className="relative flex h-full flex-col">
                    <div className="px-5 pt-5 pb-2">
                        <div className="flex items-center justify-between">
                            <h2 className="text-[15px] font-extrabold tracking-tight text-text-primary">会话历史</h2>
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => void onCreateSession()}
                                    disabled={isLoading}
                                    className="flex h-7 items-center gap-1 rounded-lg bg-text-primary px-2.5 text-[11px] font-bold text-white transition-all hover:bg-text-primary/90 active:scale-95 disabled:opacity-40"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    新会话
                                </button>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/[0.04] text-text-tertiary transition-all hover:bg-black/[0.08] hover:text-text-primary"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
                        {isLoading && sessions.length === 0 ? (
                            <div className="flex h-full items-center justify-center py-10">
                                <Loader2 className="w-5 h-5 animate-spin text-accent-primary/50" />
                            </div>
                        ) : sessions.length === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                                <History className="w-8 h-8 text-accent-primary/20 mb-3" />
                                <h3 className="text-[13px] font-bold text-text-primary">暂无记录</h3>
                            </div>
                        ) : (
                            <div className="space-y-0.5 pb-6">
                                {sessions.map((session) => {
                                    const isActive = session.id === activeSessionId;
                                    const title = session.chatSession?.title?.trim() || '未命名会话';
                                    const time = formatAdvisorSessionTime(session.chatSession?.updatedAt);
                                    const summary = session.summary?.trim();

                                    return (
                                        <div
                                            key={session.id}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => onSelectSession(session.id)}
                                            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectSession(session.id)}
                                            className={clsx(
                                                'group relative w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.98]',
                                                isActive
                                                    ? 'bg-white shadow-sm ring-1 ring-black/[0.03]'
                                                    : 'hover:bg-white/40'
                                            )}
                                        >
                                            {isActive && (
                                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-accent-primary rounded-r-full" />
                                            )}

                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <h4 className={clsx(
                                                        'truncate text-[13px] font-bold leading-tight transition-colors',
                                                        isActive ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
                                                    )}>
                                                        {title}
                                                    </h4>

                                                    <div className="mt-0.5 flex items-center gap-1.5 text-[9px] font-bold text-text-tertiary/60 uppercase tracking-tighter">
                                                        <span>{time}</span>
                                                        {isActive && (
                                                            <span className="text-accent-primary uppercase tracking-normal">● Online</span>
                                                        )}
                                                    </div>

                                                    {summary && (
                                                        <p className="mt-1.5 line-clamp-1 text-[11px] leading-normal text-text-secondary/70 font-medium">
                                                            {summary}
                                                        </p>
                                                    )}
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDeleteSession(session.id);
                                                    }}
                                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                                                    title="移除"
                                                >
                                                    <Trash2 className="w-3 h-3" />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div className="px-5 py-3 border-t border-black/[0.02]">
                        <p className="text-[8px] text-center font-bold text-text-tertiary/40 uppercase tracking-[0.3em]">
                            RedBox Engine
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

function AdvisorSettingsPanel({
    advisor,
    isActive,
    downloadStatus,
    isSystemPromptExpanded,
    setIsSystemPromptExpanded,
    isOptimizingPrompt,
    onOptimizePrompt,
    onUploadKnowledge,
    onDeleteKnowledge,
    onEdit,
    onDelete,
    onClose,
}: {
    advisor: Advisor;
    isActive?: boolean;
    downloadStatus: { advisorId: string; progress: string } | null;
    isSystemPromptExpanded: boolean;
    setIsSystemPromptExpanded: (next: boolean) => void;
    isOptimizingPrompt: boolean;
    onOptimizePrompt: () => void;
    onUploadKnowledge: () => void;
    onDeleteKnowledge: (fileName: string) => void;
    onEdit: () => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    return (
        <div className="flex h-full flex-col">
            <div className="border-b border-black/[0.04] px-5 pt-5 pb-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="text-[15px] font-extrabold tracking-tight text-text-primary">成员设置</div>
                        <div className="mt-1 text-xs text-text-tertiary truncate">{advisor.name}</div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/[0.04] text-text-tertiary transition-all hover:bg-black/[0.08] hover:text-text-primary"
                        aria-label="关闭成员设置"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
                <div className="mt-4 flex items-center gap-2">
                    <button
                        onClick={onEdit}
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-black/10 bg-white/70 px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-white hover:text-accent-primary"
                    >
                        <Pencil className="w-3 h-3" /> 编辑
                    </button>
                    <button
                        onClick={onDelete}
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-red-200/80 bg-white/70 px-3 text-xs font-medium text-red-500 transition-colors hover:bg-red-50"
                    >
                        <Trash2 className="w-3 h-3" /> 删除
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar">
                <section className="rounded-2xl border border-black/[0.04] bg-white/55 p-4 shadow-[0_10px_30px_-22px_rgba(0,0,0,0.25)]">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <button
                            onClick={() => setIsSystemPromptExpanded(!isSystemPromptExpanded)}
                            className="flex items-center gap-2 text-sm font-medium text-text-primary transition-colors hover:text-accent-primary"
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
                            onClick={onOptimizePrompt}
                            disabled={isOptimizingPrompt}
                            className="flex items-center gap-1.5 rounded-full border border-accent-primary/20 bg-white/70 px-2.5 py-1 text-xs text-accent-primary transition-colors hover:bg-accent-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Sparkles className={clsx('w-3 h-3', isOptimizingPrompt && 'animate-pulse')} />
                            {isOptimizingPrompt ? '优化中...' : 'AI优化设定'}
                        </button>
                    </div>

                    {!isSystemPromptExpanded ? (
                        <div
                            onClick={() => setIsSystemPromptExpanded(true)}
                            className="cursor-pointer rounded-2xl border border-black/[0.06] bg-white/70 p-3 transition-colors hover:border-accent-primary/30"
                        >
                            <p className="line-clamp-2 text-sm text-text-secondary">
                                {advisor.systemPrompt || '未设置角色提示词，点击展开或使用 AI 优化'}
                            </p>
                            {advisor.systemPrompt && advisor.systemPrompt.length > 100 && (
                                <span className="mt-1 inline-block text-xs text-text-tertiary">点击展开查看全部</span>
                            )}
                        </div>
                    ) : (
                        <div className="rounded-2xl border border-black/[0.06] bg-white/70 p-4">
                            <pre className="whitespace-pre-wrap font-sans text-sm text-text-primary">
                                {advisor.systemPrompt || '未设置角色提示词'}
                            </pre>
                        </div>
                    )}
                </section>

                <section className="rounded-2xl border border-black/[0.04] bg-white/55 p-4 shadow-[0_10px_30px_-22px_rgba(0,0,0,0.25)]">
                    <div className="mb-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                <FileText className="w-4 h-4 text-accent-primary" /> 专属知识库
                            </h3>
                            <p className="mt-2 text-xs text-text-tertiary">
                                上传的资料会保留在当前成员名下，供后续对话和整理使用。
                            </p>
                        </div>
                        <button
                            onClick={onUploadKnowledge}
                            className="flex shrink-0 items-center gap-1.5 rounded-full border border-accent-primary/20 bg-white/70 px-3 py-1.5 text-xs text-accent-primary transition-colors hover:bg-accent-primary/10"
                        >
                            <Upload className="w-3 h-3" /> 上传文件
                        </button>
                    </div>

                    {downloadStatus && downloadStatus.advisorId === advisor.id && (
                        <div className="mb-4 rounded-2xl border border-black/[0.06] bg-white/70 p-3">
                            <div className="mb-1 flex items-center gap-2">
                                <Upload className="w-3.5 h-3.5 animate-bounce text-accent-primary" />
                                <span className="text-xs font-medium text-text-primary">正在下载字幕...</span>
                            </div>
                            <div className="truncate font-mono text-[10px] text-text-tertiary">
                                {downloadStatus.progress}
                            </div>
                        </div>
                    )}

                    {advisor.knowledgeFiles.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-black/[0.08] bg-white/55 p-6 text-center">
                            <FileText className="mx-auto mb-2 h-8 w-8 text-text-tertiary opacity-50" />
                            <p className="text-xs text-text-tertiary">暂无知识库文件</p>
                            <p className="mt-1 text-[10px] text-text-tertiary">支持 .txt 和 .md 格式（YouTube 字幕会自动保存为 视频ID.txt）</p>
                        </div>
                    ) : (
                        <div className="max-h-52 space-y-2 overflow-auto">
                            {advisor.knowledgeFiles.map((file) => {
                                const videoId = file.replace('.txt', '').replace('.srt', '').replace('.vtt', '');
                                const isVideoSubtitle = videoId.length === 11;
                                return (
                                    <div key={file} className="flex items-center justify-between rounded-2xl border border-black/[0.06] bg-white/70 px-4 py-2">
                                        <div className="flex min-w-0 flex-1 items-center gap-2">
                                            <FileText className="h-4 w-4 shrink-0 text-text-tertiary" />
                                            <div className="min-w-0 flex-1">
                                                <span className="block truncate text-sm text-text-primary">{file}</span>
                                                {isVideoSubtitle && (
                                                    <span className="text-[10px] text-text-tertiary">📺 YouTube 字幕</span>
                                                )}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => onDeleteKnowledge(file)}
                                            className="text-text-tertiary transition-colors hover:text-red-500"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>

                <VideoManagement advisorId={advisor.id} isActive={isActive} />
            </div>

            <div className="border-t border-black/[0.02] px-5 py-3">
                <p className="text-[8px] text-center font-bold text-text-tertiary/40 uppercase tracking-[0.3em]">
                    RedBox Engine
                </p>
            </div>
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
function VideoManagement({ advisorId, isActive = true }: { advisorId: string; isActive?: boolean }) {
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
    const hasLoadedVideosSnapshotRef = useRef(false);
    const loadVideosRequestRef = useRef(0);
    const loadRunnerStatusRequestRef = useRef(0);

    const loadRunnerStatus = useCallback(async () => {
        const requestId = loadRunnerStatusRequestRef.current + 1;
        loadRunnerStatusRequestRef.current = requestId;
        try {
            const res = await window.ipcRenderer.getAdvisorYoutubeRunnerStatus();
            if (requestId !== loadRunnerStatusRequestRef.current) return;
            if (res.success) {
                setRunnerStatus(res.status || null);
            }
        } catch (e) {
            if (requestId !== loadRunnerStatusRequestRef.current) return;
            console.error(e);
        }
    }, []);

    const loadVideos = useCallback(async () => {
        const requestId = loadVideosRequestRef.current + 1;
        loadVideosRequestRef.current = requestId;
        if (!hasLoadedVideosSnapshotRef.current) {
            setIsLoading(true);
        }
        try {
            const res = await window.ipcRenderer.getVideos(advisorId);
            if (requestId !== loadVideosRequestRef.current) return;
            if (res.success) {
                setVideos(res.videos || []);
                setYoutubeChannel(res.youtubeChannel || null);
                hasLoadedVideosSnapshotRef.current = true;
            }
        } catch (e) {
            if (requestId !== loadVideosRequestRef.current) return;
            console.error(e);
        } finally {
            if (requestId === loadVideosRequestRef.current) {
                setIsLoading(false);
            }
        }
    }, [advisorId]);

    useEffect(() => {
        if (!isActive) return;
        void loadVideos();
        void loadRunnerStatus();
    }, [isActive, loadVideos, loadRunnerStatus]);

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
                void appAlert('刷新失败: ' + res.error);
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
                void appAlert('重试失败: ' + (res.error || '未知错误'));
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
                void appAlert('保存失败: ' + (res.error || '未知错误'));
                return;
            }
            await loadVideos();
            await loadRunnerStatus();
        } catch (e) {
            console.error(e);
            void appAlert('保存失败，请稍后重试');
        } finally {
            setIsSavingSettings(false);
        }
    };

    const handleRunBackgroundNow = async () => {
        setIsRunningNow(true);
        try {
            const res = await window.ipcRenderer.runAdvisorYoutubeNow(advisorId);
            if (!res.success) {
                void appAlert('后台同步失败: ' + (res.error || '未知错误'));
            }
            await loadVideos();
            await loadRunnerStatus();
        } catch (e) {
            console.error(e);
            void appAlert('后台同步失败，请稍后重试');
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
    defaultMode,
    onSave,
    onClose
}: {
    advisor: Advisor | null;
    defaultMode?: AdvisorCreateMode;
    onSave: (
        data: Omit<Advisor, 'id' | 'createdAt' | 'knowledgeFiles'>,
        youtubeParams?: { url: string; count: number; channelId?: string },
        knowledgeFilePaths?: string[],
    ) => Promise<void>;
    onClose: () => void;
}) {
    const [mode, setMode] = useState<AdvisorCreateMode>(advisor ? 'manual' : (defaultMode || 'manual'));
    const [name, setName] = useState(advisor?.name || '');
    const [avatar, setAvatar] = useState(advisor?.avatar || AVATAR_OPTIONS[0]);
    const [personality, setPersonality] = useState(advisor?.personality || '');
    const [systemPrompt, setSystemPrompt] = useState(advisor?.systemPrompt || '');
    const [knowledgeLanguage, setKnowledgeLanguage] = useState(advisor?.knowledgeLanguage || '中文');
    const [templates, setTemplates] = useState<AdvisorTemplate[]>([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
    const [templateLoadError, setTemplateLoadError] = useState('');
    const [pendingKnowledgeFiles, setPendingKnowledgeFiles] = useState<PendingKnowledgeFile[]>([]);

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
    const [isSubmitting, setIsSubmitting] = useState(false);
    const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) || null;

    const applyTemplate = useCallback((template: AdvisorTemplate) => {
        setSelectedTemplateId(template.id);
        setName(template.name || '');
        setAvatar(template.avatar || AVATAR_OPTIONS[0]);
        setPersonality(template.personality || '');
        setSystemPrompt(template.systemPrompt || '');
        setKnowledgeLanguage(template.knowledgeLanguage || '中文');
    }, []);

    const loadTemplates = useCallback(async () => {
        setIsLoadingTemplates(true);
        setTemplateLoadError('');
        try {
            const result = await window.ipcRenderer.advisors.listTemplates<AdvisorTemplate>();
            setTemplates(Array.isArray(result) ? result : []);
        } catch (error) {
            console.error('Failed to load advisor templates:', error);
            setTemplateLoadError('模板读取失败，请检查模板文件格式。');
        } finally {
            setIsLoadingTemplates(false);
        }
    }, []);

    // 切换到 YouTube 模式时检查 yt-dlp
    useEffect(() => {
        if (mode === 'youtube' && ytdlpStatus === null) {
            checkYtdlpStatus();
        }
    }, [mode]);

    useEffect(() => {
        if (mode !== 'template') return;
        if (templates.length > 0 || isLoadingTemplates) return;
        void loadTemplates();
    }, [mode, templates.length, isLoadingTemplates, loadTemplates]);

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
                void appAlert('安装失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            void appAlert('安装出错，请稍后重试');
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
                void appAlert('获取失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            console.error(e);
            void appAlert('获取失败，请检查 ytdlp 是否安装以及网络连接');
        } finally {
            setIsLoadingInfo(false);
        }
    };

    const handleSubmit = async () => {
        if (isSubmitting) return;
        if (mode === 'template') {
            if (!selectedTemplate) return;
            setIsSubmitting(true);
            try {
                await onSave({
                name: selectedTemplate.name || '',
                avatar: selectedTemplate.avatar || AVATAR_OPTIONS[0],
                personality: selectedTemplate.personality || '',
                systemPrompt: selectedTemplate.systemPrompt || '',
                knowledgeLanguage: selectedTemplate.knowledgeLanguage || '中文',
                }, undefined, pendingKnowledgeFiles.map((file) => file.path));
            } finally {
                setIsSubmitting(false);
            }
            return;
        }

        if (!name.trim()) return;
        if (mode === 'manual' && pendingKnowledgeFiles.length === 0) {
            void appAlert('手动创建成员时必须导入至少一个知识库文件');
            return;
        }

        let ytParams = undefined;
        if (mode === 'youtube' && youtubeUrl) {
            ytParams = {
                url: youtubeUrl,
                count: subtitleCount,
                channelId: youtubeInfo?.channelId || ''
            };
        }

        setIsSubmitting(true);
        try {
            await onSave(
                { name, avatar, personality, systemPrompt, knowledgeLanguage },
                ytParams,
                pendingKnowledgeFiles.map((file) => file.path),
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleOptimize = async () => {
        if (!name && !personality && !systemPrompt) return;

        setIsOptimizing(true);
        const info = `角色名称: ${name}\n一句话描述: ${personality}\n当前设定: ${systemPrompt || '(未填写)'}`;

        try {
            const result = await window.ipcRenderer.advisors.optimizePrompt({ info }) as { success: boolean; prompt?: string; error?: string };
            if (result.success && result.prompt) {
                setSystemPrompt(result.prompt);
            } else {
                void appAlert('优化失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            console.error('Optimization error:', e);
            void appAlert('优化失败，请检查 API 设置');
        } finally {
            setIsOptimizing(false);
        }
    };

    // AI Persona Generation for YouTube mode
    const handleGeneratePersona = async () => {
        if (!youtubeInfo) {
            void appAlert('请先获取频道信息');
            return;
        }

        setIsOptimizing(true);
        try {
            const result = await window.ipcRenderer.advisors.generatePersona({
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
                void appAlert('生成失败: ' + (result.error || '未知错误'));
            }
        } catch (e) {
            console.error('Persona generation error:', e);
            void appAlert('生成失败，请检查 API 设置');
        } finally {
            setIsOptimizing(false);
        }
    };

    const handleSelectAvatar = async () => {
        try {
            const filePath = await window.ipcRenderer.advisors.selectAvatar();
            if (filePath) {
                const previewUrl = resolveAssetUrl(String(filePath));
                setAvatar(previewUrl);
            }
        } catch (e) {
            console.error('Failed to select avatar:', e);
        }
    };

    const handlePickKnowledgeFiles = async () => {
        try {
            const result = await window.ipcRenderer.advisors.pickKnowledgeFiles<{
                success?: boolean;
                files?: Array<{ path?: string; name?: string }>;
            }>();
            const nextFiles = Array.isArray(result?.files)
                ? result.files
                    .map((file) => ({
                        path: String(file?.path || '').trim(),
                        name: String(file?.name || '').trim() || String(file?.path || '').split('/').pop() || '未命名文件',
                    }))
                    .filter((file) => file.path)
                : [];
            if (nextFiles.length === 0) return;
            setPendingKnowledgeFiles((prev) => {
                const merged = [...prev];
                nextFiles.forEach((file) => {
                    if (!merged.some((item) => item.path === file.path)) {
                        merged.push(file);
                    }
                });
                return merged;
            });
        } catch (error) {
            console.error('Failed to pick knowledge files:', error);
            void appAlert('选择知识库文件失败，请稍后重试');
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
                                从资料蒸馏
                            </button>
                            <button
                                onClick={() => setMode('template')}
                                className={clsx(
                                    "flex-1 text-xs font-medium py-1.5 rounded-md transition-all",
                                    mode === 'template' ? "bg-surface-primary shadow-sm text-text-primary" : "text-text-tertiary hover:text-text-secondary"
                                )}
                            >
                                从模板创建
                            </button>
                            <button
                                onClick={() => setMode('youtube')}
                                className={clsx(
                                    "flex-1 text-xs font-medium py-1.5 rounded-md transition-all",
                                    mode === 'youtube' ? "bg-surface-primary shadow-sm text-text-primary" : "text-text-tertiary hover:text-text-secondary"
                                )}
                            >
                                从YouTube导入
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

                    {mode === 'template' && (
                        <div className="bg-surface-secondary/30 p-4 rounded-lg border border-border space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-medium text-text-primary">成员模板</div>
                                    <div className="text-xs text-text-tertiary">选择模板后即可直接创建成员，不需要再单独配置头像、名称和提示词。</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void loadTemplates()}
                                    disabled={isLoadingTemplates}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-accent-primary border border-accent-primary/25 rounded-lg hover:bg-accent-primary/10 disabled:opacity-50"
                                >
                                    <RefreshCw className={clsx("w-3.5 h-3.5", isLoadingTemplates && "animate-spin")} />
                                    刷新模板
                                </button>
                            </div>

                            {templateLoadError && (
                                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                                    {templateLoadError}
                                </div>
                            )}

                            {isLoadingTemplates ? (
                                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-primary px-3 py-3 text-xs text-text-tertiary">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    正在加载模板...
                                </div>
                            ) : templates.length === 0 ? (
                                <div className="rounded-lg border border-dashed border-border bg-surface-primary px-4 py-4 text-sm text-text-tertiary">
                                    还没有可用模板。你可以先补充模板文件，稍后回来直接选用。
                                </div>
                            ) : (
                                <div className="space-y-2 max-h-64 overflow-auto pr-1">
                                    {templates.map((template) => {
                                        const isSelected = template.id === selectedTemplateId;
                                        const avatarLabel = String(template.avatar || template.name || '?').trim().slice(0, 2);
                                        return (
                                            <button
                                                key={template.id}
                                                type="button"
                                                onClick={() => applyTemplate(template)}
                                                className={clsx(
                                                    'w-full rounded-xl border px-3 py-3 text-left transition-colors',
                                                    isSelected
                                                        ? 'border-accent-primary bg-accent-primary/10'
                                                        : 'border-border bg-surface-primary hover:border-accent-primary/40 hover:bg-surface-primary/80'
                                                )}
                                            >
                                                <div className="flex items-start gap-3">
                                                    <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-secondary text-base">
                                                        {template.avatar && isRenderableAvatarUrl(template.avatar) ? (
                                                            <img
                                                                src={resolveAssetUrl(template.avatar)}
                                                                alt=""
                                                                className="h-full w-full object-cover"
                                                            />
                                                        ) : (
                                                            <span>{avatarLabel}</span>
                                                        )}
                                                    </div>
                                                    <div className="min-w-0 flex-1 space-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <div className="truncate text-sm font-medium text-text-primary">{template.name}</div>
                                                            {template.category && (
                                                                <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] text-text-tertiary">
                                                                    {template.category}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {template.description && (
                                                            <div className="text-xs text-text-secondary line-clamp-2">{template.description}</div>
                                                        )}
                                                        {template.tags && template.tags.length > 0 && (
                                                            <div className="flex flex-wrap gap-1">
                                                                {template.tags.slice(0, 4).map((tag) => (
                                                                    <span
                                                                        key={tag}
                                                                        className="rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] text-text-tertiary"
                                                                    >
                                                                        {tag}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {mode !== 'template' && (
                        <>
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

                            {!advisor && (
                                <div className="rounded-lg border border-border bg-surface-secondary/30 p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <label className="block text-xs font-medium text-text-secondary">知识库文件</label>
                                            <p className="mt-1 text-[11px] text-text-tertiary">
                                                创建成员时可直接导入资料，创建完成后会自动写入该成员的专属知识库。
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => void handlePickKnowledgeFiles()}
                                            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-accent-primary/30 px-3 py-1.5 text-xs text-accent-primary hover:bg-accent-primary/10"
                                        >
                                            <Upload className="w-3 h-3" />
                                            选择文件
                                        </button>
                                    </div>

                                    {pendingKnowledgeFiles.length === 0 ? (
                                        <div className="mt-3 rounded-lg border border-dashed border-border bg-surface-primary px-3 py-4 text-center text-xs text-text-tertiary">
                                            暂未选择知识库文件
                                        </div>
                                    ) : (
                                        <div className="mt-3 max-h-36 space-y-2 overflow-auto">
                                            {pendingKnowledgeFiles.map((file) => (
                                                <div key={file.path} className="flex items-center justify-between rounded-lg border border-border bg-surface-primary px-3 py-2">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-sm text-text-primary">{file.name}</div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => setPendingKnowledgeFiles((prev) => prev.filter((item) => item.path !== file.path))}
                                                        className="ml-3 text-text-tertiary transition-colors hover:text-red-500"
                                                        aria-label={`移除 ${file.name}`}
                                                    >
                                                        <X className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {mode === 'manual' ? (
                                <div className="rounded-lg border border-accent-primary/20 bg-accent-primary/5 p-4">
                                    <div className="flex items-start gap-2">
                                        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent-primary" />
                                        <div>
                                            <div className="text-sm font-medium text-text-primary">系统会自动生成角色设定</div>
                                            <p className="mt-1 text-[11px] text-text-tertiary">
                                                你只需要填写名称、描述并导入知识库文件。点击创建后，后台会调用角色创建技能自动产出系统提示词。
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ) : (
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
                            )}
                        </>
                    )}
                </div>

                <div className="px-6 py-4 bg-surface-secondary border-t border-border flex items-center justify-end gap-3 shrink-0">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg">
                        取消
                    </button>
                    <button
                        onClick={() => void handleSubmit()}
                        disabled={isSubmitting || (mode === 'template' ? !selectedTemplate : !name.trim() || (mode === 'manual' && pendingKnowledgeFiles.length === 0))}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-accent-primary rounded-lg disabled:opacity-50"
                    >
                        {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        {isSubmitting ? '创建中...' : advisor ? '保存' : mode === 'template' ? '按模板创建' : '创建'}
                    </button>
                </div>
            </div>
            {isSubmitting && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-sm">
                    <div className="mx-6 w-full max-w-sm rounded-2xl border border-white/10 bg-surface-primary px-6 py-6 text-center shadow-2xl">
                        <Loader2 className="mx-auto h-7 w-7 animate-spin text-accent-primary" />
                        <div className="mt-4 text-base font-semibold text-text-primary">角色正在创建中</div>
                        <p className="mt-2 text-sm text-text-tertiary">
                            系统正在导入知识库并调用角色创建技能生成系统提示词，请稍后。
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
