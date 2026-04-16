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
            <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleOpen}
                    className={clsx(
                        'flex items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-sm backdrop-blur transition-all',
                        open
                            ? 'border-accent-primary/40 bg-surface-primary/96 text-accent-primary'
                            : 'border-border bg-surface-primary/90 text-text-secondary hover:border-accent-primary/30 hover:text-text-primary'
                    )}
                    title="查看历史对话"
                    aria-label="查看历史对话"
                >
                    <History className="w-4 h-4" />
                    <span className="hidden sm:inline">历史对话</span>
                </button>
            </div>
            {open && (
                <div className="absolute inset-0 z-40">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/8 backdrop-blur-[1px]"
                        aria-label="关闭历史对话抽屉"
                        onClick={onClose}
                    />
                    <div className="absolute right-4 top-4 bottom-4 w-[360px] max-w-[calc(100%-2rem)] rounded-[28px] border border-border bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(246,243,238,0.98))] shadow-[0_24px_80px_rgba(33,24,18,0.18)] backdrop-blur-xl overflow-hidden">
                        <div className="flex h-full flex-col">
                            <div className="border-b border-border/80 px-4 py-4 bg-surface-primary/72">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold text-text-primary">历史对话</div>
                                        <div className="mt-1 text-[11px] text-text-tertiary">仅当前空间 · {activeSpaceName}</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void onCreateSession()}
                                            disabled={historyLoading}
                                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-primary px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:border-accent-primary/40 hover:text-accent-primary disabled:opacity-60"
                                        >
                                            {historyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                            新对话
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="rounded-full border border-transparent p-1.5 text-text-tertiary transition-colors hover:border-border hover:bg-surface-primary hover:text-text-primary"
                                            title="关闭历史对话"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto px-3 py-3">
                                {historyLoading && sessionList.length === 0 ? (
                                    <div className="flex h-full items-center justify-center text-text-tertiary">
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            <span className="text-xs">正在加载历史对话...</span>
                                        </div>
                                    </div>
                                ) : sessionList.length === 0 ? (
                                    <div className="flex h-full flex-col items-center justify-center rounded-[24px] border border-dashed border-border/80 bg-surface-primary/70 px-6 text-center">
                                        <div className="text-sm font-medium text-text-primary">暂无历史对话</div>
                                        <div className="mt-2 text-xs leading-5 text-text-tertiary">
                                            当前空间还没有 RedClaw 会话，点击右上角新对话立即开始。
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {sessionList.map((session) => {
                                            const isActiveSession = session.id === activeSessionId;
                                            const sessionTitle = session.chatSession?.title?.trim() || '新对话';
                                            const sessionUpdatedAt = formatDateTime(session.chatSession?.updatedAt || null);
                                            const sessionSummary = session.summary?.trim() || '还没有摘要，进入会话后开始继续。';
                                            return (
                                                <div
                                                    key={session.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => onSwitchSession(session.id)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter' || event.key === ' ') {
                                                            event.preventDefault();
                                                            onSwitchSession(session.id);
                                                        }
                                                    }}
                                                    className={clsx(
                                                        'group w-full rounded-[22px] border px-4 py-3 text-left transition-all',
                                                        isActiveSession
                                                            ? 'border-accent-primary/40 bg-accent-primary/8 shadow-[0_8px_24px_rgba(166,84,32,0.12)]'
                                                            : 'border-border bg-surface-primary/72 hover:border-text-tertiary/30 hover:bg-surface-primary'
                                                    )}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center gap-2">
                                                                <div className="truncate text-sm font-medium text-text-primary">{sessionTitle}</div>
                                                                {isActiveSession && (
                                                                    <span className="rounded-full bg-accent-primary/12 px-2 py-0.5 text-[10px] font-medium text-accent-primary">
                                                                        当前
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="mt-1 text-[11px] text-text-tertiary">{sessionUpdatedAt}</div>
                                                            <div className="mt-2 line-clamp-2 text-xs leading-5 text-text-secondary">
                                                                {sessionSummary}
                                                            </div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                void onDeleteSession(session.id);
                                                            }}
                                                            className="mt-0.5 rounded-full border border-transparent p-1.5 text-text-tertiary opacity-0 transition-all hover:border-red-500/20 hover:bg-red-500/8 hover:text-red-500 group-hover:opacity-100"
                                                            title="删除对话"
                                                            aria-label={`删除对话 ${sessionTitle}`}
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
