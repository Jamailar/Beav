import { History, Loader2, Plus, Trash2, Users, X } from 'lucide-react';
import { clsx } from 'clsx';
import { formatDateTime } from './helpers';

interface RedClawTeamRoom {
    id: string;
    name: string;
    advisorIds?: string[];
    isSystem?: boolean;
}

export type RedClawHistorySurface = 'redclaw' | 'advisor' | 'room';

export interface RedClawHistoryListItem extends ContextChatSessionListItem {
    surface: RedClawHistorySurface;
    speakerLabel: string;
    advisorId?: string;
    roomId?: string;
}

interface RedClawHistoryDrawerProps {
    open: boolean;
    activeSpaceName: string;
    historyLoading: boolean;
    sessionList: RedClawHistoryListItem[];
    activeSessionId: string | null;
    teamRooms?: RedClawTeamRoom[];
    activeRoomId?: string | null;
    activeSurface?: 'redclaw' | 'advisor' | 'room';
    onToggleOpen: () => void;
    onClose: () => void;
    onCreateSession: () => void | Promise<void>;
    onCreateRoom?: () => void;
    onSwitchRoom?: (roomId: string) => void;
    onSwitchSession: (session: RedClawHistoryListItem) => void;
    onDeleteSession: (session: RedClawHistoryListItem) => void | Promise<void>;
}

export function RedClawHistoryDrawer({
    open,
    activeSpaceName,
    historyLoading,
    sessionList,
    activeSessionId,
    teamRooms = [],
    activeRoomId,
    activeSurface = 'redclaw',
    onToggleOpen,
    onClose,
    onCreateSession,
    onCreateRoom,
    onSwitchRoom,
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

                            <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
                                <div className="mb-3 border-b border-border/70 pb-3">
                                    <div className="mb-1.5 flex items-center justify-between px-3">
                                        <span className="text-[11px] font-bold text-text-tertiary">团队</span>
                                        {onCreateRoom && (
                                            <button
                                                type="button"
                                                onClick={() => void onCreateRoom()}
                                                className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                                title="创建群聊"
                                                aria-label="创建群聊"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </div>
                                    {teamRooms.length === 0 ? (
                                        <div className="mx-3 rounded-lg border border-dashed border-border/80 px-3 py-3 text-center text-[11px] text-text-tertiary">
                                            暂无群聊
                                        </div>
                                    ) : (
                                        <div className="space-y-0.5">
                                            {teamRooms.map((room) => {
                                                const isActiveRoom = activeSurface === 'room' && room.id === activeRoomId;
                                                const memberCount = Array.isArray(room.advisorIds) ? room.advisorIds.length : 0;
                                                return (
                                                    <button
                                                        key={room.id}
                                                        type="button"
                                                        onClick={() => onSwitchRoom?.(room.id)}
                                                        className={clsx(
                                                            'group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all active:scale-[0.98]',
                                                            isActiveRoom
                                                                ? 'bg-surface-elevated shadow-sm ring-1 ring-accent-primary/20'
                                                                : 'hover:bg-surface-secondary/70'
                                                        )}
                                                    >
                                                        {isActiveRoom && (
                                                            <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent-primary" />
                                                        )}
                                                        <Users className={clsx('h-4 w-4 shrink-0', isActiveRoom ? 'text-accent-primary' : 'text-text-tertiary')} />
                                                        <div className="min-w-0 flex-1">
                                                            <div className={clsx(
                                                                'truncate text-[13px] font-bold leading-tight',
                                                                isActiveRoom ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
                                                            )}>
                                                                {room.name || '未命名群聊'}
                                                            </div>
                                                            <div className="mt-0.5 text-[9px] font-bold uppercase tracking-tighter text-text-tertiary/60">
                                                                {room.isSystem ? '系统群聊' : `${memberCount} 位成员`}
                                                            </div>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                <div className="mb-1.5 px-3 text-[11px] font-bold text-text-tertiary">最近</div>
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
                                            const speakerLabel = session.speakerLabel || 'RedClaw';
                                            
                                            return (
                                                <div
                                                    key={session.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => onSwitchSession(session)}
                                                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSwitchSession(session)}
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
                                                                <span>{speakerLabel}</span>
                                                                {time && <span>{time}</span>}
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
                                                                void onDeleteSession(session);
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
