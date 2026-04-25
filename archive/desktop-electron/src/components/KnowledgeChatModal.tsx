import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, MessageCircle, RefreshCw, X } from 'lucide-react';
import { Chat } from '../pages/Chat';

interface KnowledgeChatModalProps {
    isOpen: boolean;
    onClose: () => void;
    contextId: string;
    contextType: string;
    contextTitle: string;
    contextContent: string;
}

export function KnowledgeChatModal({
    isOpen,
    onClose,
    contextId,
    contextType,
    contextTitle,
    contextContent
}: KnowledgeChatModalProps) {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [initError, setInitError] = useState<string>('');
    const [reloadToken, setReloadToken] = useState(0);

    const normalizedTitle = useMemo(() => {
        const trimmed = contextTitle.trim();
        return trimmed ? trimmed : '未命名知识';
    }, [contextTitle]);
    const shortcuts = useMemo(() => ([
        { label: '📝 总结内容', text: '请总结这篇知识的核心结论，并按要点输出。' },
        { label: '💡 提炼洞察', text: '请提炼这篇知识里最重要的观点、方法和反常识洞察。' },
        { label: '🔍 深挖问题', text: '请基于这篇知识提出 5 个值得继续追问的问题。' },
        { label: '✍️ 改写输出', text: '请把这篇知识改写成更适合分享的表达。' },
    ]), []);
    const welcomeShortcuts = useMemo(() => ([
        { label: '结构梳理', text: '请先帮我梳理这篇知识的结构、主题和主要论点。' },
        { label: '可执行建议', text: '请把这篇知识整理成可以直接执行的建议清单。' },
        { label: '适用人群', text: '这篇知识更适合谁看？哪些场景最适用？' },
        { label: '反驳与风险', text: '这篇知识有哪些潜在偏差、争议点或适用边界？' },
    ]), []);

    useEffect(() => {
        if (isOpen && contextId) {
            const initSession = async () => {
                setIsLoading(true);
                setInitError('');
                try {
                    const session = await window.ipcRenderer.chat.getOrCreateContextSession({
                        contextId,
                        contextType,
                        title: `知识库 · ${normalizedTitle}`,
                        initialContext: contextContent,
                        metadata: {
                            sourceSurface: 'knowledge-modal',
                            knowledgeTitle: normalizedTitle,
                            knowledgeContextType: contextType,
                        }
                    });
                    setSessionId(session.id);
                } catch (e) {
                    console.error('Failed to init chat session:', e);
                    setSessionId(null);
                    setInitError(e instanceof Error ? e.message : String(e));
                } finally {
                    setIsLoading(false);
                }
            };
            void initSession();
        } else {
            setSessionId(null);
            setInitError('');
        }
    }, [isOpen, contextId, contextType, normalizedTitle, contextContent, reloadToken]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-md">
            <div className="flex h-[88vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-[28px] border border-border/70 bg-surface-primary shadow-[0_32px_120px_rgba(15,23,42,0.24)]">
                <div className="flex shrink-0 items-center justify-between border-b border-border/70 bg-surface-primary/95 px-6 py-4 backdrop-blur-xl">
                    <div className="flex items-center gap-3">
                        <div className="rounded-2xl bg-accent-primary/10 p-2.5">
                            <MessageCircle className="w-5 h-5 text-accent-primary" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-text-primary">知识库助手</h2>
                            <p className="max-w-2xl truncate text-xs text-text-tertiary">
                                围绕当前知识继续对话：{normalizedTitle}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-xl p-2 text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                        aria-label="关闭知识库对话"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="relative min-h-0 flex-1 overflow-hidden bg-surface-primary">
                    {isLoading ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex flex-col items-center gap-3 text-text-tertiary">
                                <Loader2 className="h-8 w-8 animate-spin text-accent-primary" />
                                <span className="text-xs">正在连接知识库会话...</span>
                            </div>
                        </div>
                    ) : sessionId ? (
                        <Chat
                            fixedSessionId={sessionId}
                            defaultCollapsed={true}
                            showClearButton={false}
                            fixedSessionBannerText=""
                            fixedSessionContextIndicatorMode="corner-ring"
                            embeddedTheme="auto"
                            contentWidthPreset="narrow"
                            shortcuts={shortcuts}
                            welcomeShortcuts={welcomeShortcuts}
                            welcomeTitle="围绕当前知识继续聊"
                            welcomeSubtitle="可直接让 AI 总结、追问、改写、抽取结构或对比观点。"
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center p-6">
                            <div className="w-full max-w-lg rounded-3xl border border-red-200 bg-red-50/90 p-5 text-left shadow-sm">
                                <div className="flex items-start gap-3">
                                    <div className="rounded-2xl bg-red-100 p-2 text-red-500">
                                        <AlertCircle className="h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-semibold text-red-700">知识库会话初始化失败</div>
                                        <div className="mt-1 text-xs leading-6 text-red-600">
                                            {initError || '宿主没有返回可用会话，请重试。'}
                                        </div>
                                        <button
                                            onClick={() => setReloadToken((value) => value + 1)}
                                            className="mt-4 inline-flex items-center gap-2 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                            重新连接
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
