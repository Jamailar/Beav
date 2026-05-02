import { History, Loader2, Plus, Trash2, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { REDCLAW_DISPLAY_NAME } from './config';
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

function displaySessionTitle(title: string, surface: RedClawHistorySurface): string {
    if (surface !== 'redclaw') return title;
    return title.replace(/^RedClaw(\s*·\s*)/, `${REDCLAW_DISPLAY_NAME}$1`);
}

interface RedClawHistorySidebarSectionProps {
    historyLoading: boolean;
    sessionList: RedClawHistoryListItem[];
    activeSessionId: string | null;
    teamRooms?: RedClawTeamRoom[];
    activeRoomId?: string | null;
    activeSurface?: 'redclaw' | 'advisor' | 'room';
    onCreateSession: () => void | Promise<void>;
    onCreateRoom?: () => void;
    onSwitchRoom?: (roomId: string) => void;
    onSwitchSession: (session: RedClawHistoryListItem) => void;
    onDeleteSession: (session: RedClawHistoryListItem) => void | Promise<void>;
}

export function RedClawHistorySidebarSection({
    historyLoading,
    sessionList,
    activeSessionId,
    teamRooms = [],
    activeRoomId,
    activeSurface = 'redclaw',
    onCreateSession,
    onCreateRoom,
    onSwitchRoom,
    onSwitchSession,
    onDeleteSession,
}: RedClawHistorySidebarSectionProps) {
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border/70 pt-3">
            <div className="mb-3 flex items-center justify-between px-3">
                <h2 className="text-[12px] font-bold text-text-secondary">对话</h2>
                <button
                    type="button"
                    onClick={() => void onCreateSession()}
                    disabled={historyLoading}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-40"
                    title="新会话"
                    aria-label="新会话"
                >
                    <Plus className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 custom-scrollbar">
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
                            const title = displaySessionTitle(session.chatSession?.title?.trim() || '未命名会话', session.surface);
                            const time = formatDateTime(session.chatSession?.updatedAt || session.chatSession?.createdAt || null);
                            const summary = session.summary?.trim();
                            const speakerLabel = session.speakerLabel || REDCLAW_DISPLAY_NAME;

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
        </div>
    );
}
