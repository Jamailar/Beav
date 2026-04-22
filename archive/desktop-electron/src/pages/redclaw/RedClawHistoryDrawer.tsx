import { History, Loader2, Plus, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { formatDateTime } from './helpers';

interface RedClawHistoryDrawerProps {
    open: boolean;
    activeSpaceName: string;
    historyLoading: boolean;
    sessionList: ContextChatSessionListItem[];
    activeSessionId: string | null;
    onToggleOpen: () => void;
    onClose: () => void;
    onCreateSession: () => void | Promise<void>;
    onSwitchSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void | Promise<void>;
}

export function RedClawHistoryDrawer({
    open,
    activeSpaceName,
    historyLoading,
    sessionList,
    activeSessionId,
    onToggleOpen,
    onClose,
    onCreateSession,
    onSwitchSession,
    onDeleteSession,
}: RedClawHistoryDrawerProps) {
    return (
        <>
            <div className="absolute top-4 left-5 z-30 flex items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleOpen}
                    className={clsx(
                        'flex items-center gap-2 rounded-xl border px-3.5 py-1.5 text-[12px] font-bold shadow-sm backdrop-blur-xl transition-all active:scale-95',
                        open
                            ? 'border-transparent bg-accent-primary text-white'
                            : 'border-border/80 bg-surface-elevated/92 text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                    )}
                    title="查看历史对话"
                    aria-label="查看历史对话"
                >
                    <History className="w-3.5 h-3.5" />
                    <span>历史</span>
                </button>
            </div>

            {open && (
                <div className="absolute inset-0 z-40">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/25 backdrop-blur-[2px] transition-opacity"
                        aria-label="关闭历史对话抽屉"
                        onClick={onClose}
                    />
                    
                    <div className="absolute left-4 top-4 bottom-4 flex w-[320px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface-primary shadow-[0_24px_64px_-16px_rgba(15,23,42,0.16)] animate-slide-in-left-refined">
                        <div className="relative flex h-full flex-col">
                            {/* Header - 移除空间名，更紧凑 */}
                            <div className="px-5 pt-5 pb-2">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-[15px] font-extrabold tracking-tight text-text-primary">会话历史</h2>
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            onClick={() => void onCreateSession()}
                                            disabled={historyLoading}
                                            className="flex h-7 items-center gap-1 rounded-lg bg-accent-primary px-2.5 text-[11px] font-bold text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-40"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            新会话
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-secondary/80 text-text-tertiary transition-all hover:bg-surface-tertiary hover:text-text-primary"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Content Section - 高密度列表 */}
                            <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
                                {historyLoading && sessionList.length === 0 ? (
                                    <div className="flex h-full items-center justify-center py-10">
                                        <Loader2 className="w-5 h-5 animate-spin text-accent-primary/50" />
                                    </div>
                                ) : sessionList.length === 0 ? (
                                    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                                        <History className="w-8 h-8 text-accent-primary/20 mb-3" />
                                        <h3 className="text-[13px] font-bold text-text-primary">暂无记录</h3>
                                    </div>
                                ) : (
                                    <div className="space-y-0.5 pb-6">
                                        {sessionList.map((session) => {
                                            const isActive = session.id === activeSessionId;
                                            const title = session.chatSession?.title?.trim() || '未命名会话';
                                            const time = formatDateTime(session.chatSession?.updatedAt || null);
                                            const summary = session.summary?.trim();
                                            
                                            return (
                                                <div
                                                    key={session.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => onSwitchSession(session.id)}
                                                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSwitchSession(session.id)}
                                                    className={clsx(
                                                        'group relative w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.98]',
                                                        isActive
                                                            ? 'bg-surface-elevated shadow-sm ring-1 ring-accent-primary/20'
                                                            : 'hover:bg-surface-secondary/70'
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
                                                                void onDeleteSession(session.id);
                                                            }}
                                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-all hover:bg-red-500/12 hover:text-red-400 group-hover:opacity-100"
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
                            
                            {/* Footer hint */}
                            <div className="border-t border-border/70 px-5 py-3">
                                <p className="text-[8px] text-center font-bold text-text-tertiary/40 uppercase tracking-[0.3em]">
                                    RedBox Engine
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
