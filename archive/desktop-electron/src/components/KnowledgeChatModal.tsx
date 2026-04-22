import { useEffect, useState } from 'react';
import { X, MessageCircle } from 'lucide-react';
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

    useEffect(() => {
        if (isOpen && contextId) {
            const initSession = async () => {
                setIsLoading(true);
                try {
                    const session = await window.ipcRenderer.chat.getOrCreateContextSession({
                        contextId,
                        contextType,
                        title: `Chat: ${contextTitle}`,
                        initialContext: contextContent
                    });
                    setSessionId(session.id);
                } catch (e) {
                    console.error('Failed to init chat session:', e);
                } finally {
                    setIsLoading(false);
                }
            };
            initSession();
        } else {
            setSessionId(null);
        }
    }, [isOpen, contextId, contextType, contextTitle, contextContent]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-4xl h-[85vh] bg-surface-primary rounded-2xl border border-border shadow-2xl overflow-hidden flex flex-col mx-4">
                {/* Header */}
                <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-surface-secondary/30 shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-accent-primary/10 rounded-lg">
                            <MessageCircle className="w-5 h-5 text-accent-primary" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-text-primary">知识库助手</h2>
                            <p className="text-xs text-text-tertiary truncate max-w-md">
                                正在讨论: {contextTitle}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Chat Content */}
                <div className="flex-1 overflow-hidden relative bg-surface-primary">
                    {isLoading ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex flex-col items-center gap-3 text-text-tertiary">
                                <div className="w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
                                <span className="text-xs">正在连接会话...</span>
                            </div>
                        </div>
                    ) : sessionId ? (
                        <Chat
                            fixedSessionId={sessionId}
                            defaultCollapsed={true}
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-text-tertiary">
                            会话初始化失败
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
