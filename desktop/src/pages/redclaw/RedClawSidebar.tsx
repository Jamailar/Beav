import type { MouseEvent as ReactMouseEvent } from 'react';
import { Download, Loader2, Minimize2, Sparkles, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { SidebarTab } from './types';

interface RedClawSidebarProps {
    collapsed: boolean;
    sidebarWidth: number;
    isSidebarResizing: boolean;
    activeSpaceName: string;
    sidebarTab: SidebarTab;
    chatActionLoading: 'clear' | 'compact' | null;
    chatActionMessage: string;
    skills: SkillDefinition[];
    isSkillsLoading: boolean;
    skillsMessage: string;
    enabledSkillCount: number;
    installSource: string;
    isInstallingSkill: boolean;
    onSidebarResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onCollapse: () => void;
    onSelectTab: (tab: SidebarTab) => void;
    onCompactContext: () => void | Promise<void>;
    onInstallSourceChange: (value: string) => void;
    onInstallSkill: () => void | Promise<void>;
    onToggleSkill: (skill: SkillDefinition) => void | Promise<void>;
}

export function RedClawSidebar({
    collapsed,
    sidebarWidth,
    isSidebarResizing,
    activeSpaceName,
    sidebarTab,
    chatActionLoading,
    chatActionMessage,
    skills,
    isSkillsLoading,
    skillsMessage,
    enabledSkillCount,
    installSource,
    isInstallingSkill,
    onSidebarResizeStart,
    onCollapse,
    onSelectTab,
    onCompactContext,
    onInstallSourceChange,
    onInstallSkill,
    onToggleSkill,
}: RedClawSidebarProps) {
    return (
        <aside
            className={clsx(
                'relative shrink-0 bg-surface-secondary/30 overflow-hidden',
                collapsed ? 'border-l-0' : 'border-l border-border',
                !isSidebarResizing && 'transition-[width] duration-200 ease-out'
            )}
            style={{ width: collapsed ? 0 : sidebarWidth }}
        >
            {!collapsed && (
                <div className="h-full flex flex-col">
                    <div
                        className="absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize"
                        onMouseDown={onSidebarResizeStart}
                        title="拖拽调整侧栏宽度"
                        aria-label="拖拽调整侧栏宽度"
                    />
                    <div className="px-4 py-3 border-b border-border">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-semibold text-text-primary">RedClaw 侧栏</div>
                                <div className="text-[11px] text-text-tertiary">空间：{activeSpaceName}</div>
                            </div>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => void onCompactContext()}
                                    disabled={chatActionLoading !== null}
                                    className="p-1.5 rounded-md text-text-tertiary hover:text-accent-primary hover:bg-surface-secondary disabled:opacity-60"
                                    title="压缩上下文"
                                >
                                    {chatActionLoading === 'compact' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Minimize2 className="w-4 h-4" />}
                                </button>
                                <button
                                    onClick={onCollapse}
                                    className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-secondary"
                                    title="收起 RedClaw 侧栏"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div className="mt-3 p-1 rounded-lg bg-surface-secondary border border-border flex gap-1">
                            <button
                                onClick={() => onSelectTab('skills')}
                                className={clsx(
                                    'flex-1 px-2 py-1.5 rounded-md text-xs transition-colors flex items-center justify-center gap-1',
                                    sidebarTab === 'skills'
                                        ? 'bg-surface-primary text-text-primary border border-border'
                                        : 'text-text-secondary hover:text-text-primary'
                                )}
                            >
                                <Sparkles className="w-3.5 h-3.5" />
                                技能
                            </button>
                        </div>
                        {chatActionMessage && (
                            <div className="mt-3 text-xs px-3 py-2 rounded-lg border border-border bg-surface-primary text-text-secondary shadow-sm">
                                {chatActionMessage}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3">
                        <div className="rounded-xl border border-border bg-surface-primary p-3 space-y-2">
                            <div className="text-xs text-text-secondary font-medium">安装技能</div>
                            <input
                                type="text"
                                value={installSource}
                                onChange={(event) => onInstallSourceChange(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        void onInstallSkill();
                                    }
                                }}
                                placeholder="输入 skill slug 或 ClawHub 链接"
                                className="w-full px-3 py-2 rounded-md border border-border bg-surface-secondary text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                            />
                            <button
                                onClick={() => void onInstallSkill()}
                                disabled={isInstallingSkill || !installSource.trim()}
                                className="w-full px-3 py-2 rounded-md text-xs border border-border bg-surface-secondary text-text-secondary hover:text-accent-primary hover:border-accent-primary/40 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                            >
                                {isInstallingSkill ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                <span>{isInstallingSkill ? '安装中...' : '安装技能'}</span>
                            </button>
                        </div>

                        <div className="text-[11px] text-text-tertiary">已启用 {enabledSkillCount} 个技能</div>

                        {isSkillsLoading ? (
                            <div className="text-xs text-text-tertiary flex items-center gap-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                正在加载技能...
                            </div>
                        ) : skills.length === 0 ? (
                            <div className="text-xs text-text-tertiary border border-dashed border-border rounded-lg p-4">
                                当前空间还没有技能。
                            </div>
                        ) : (
                            skills.map((skill) => (
                                <div key={skill.location} className="rounded-xl border border-border bg-surface-primary p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-sm text-text-primary font-medium truncate">{skill.name}</div>
                                            <div className="text-xs text-text-tertiary mt-1 line-clamp-2">{skill.description || '无描述'}</div>
                                            <div className="text-[11px] text-text-tertiary mt-2 truncate">{skill.location}</div>
                                        </div>
                                        <button
                                            onClick={() => void onToggleSkill(skill)}
                                            className={clsx(
                                                'px-2.5 py-1 rounded text-[11px] border transition-colors shrink-0',
                                                skill.disabled
                                                    ? 'border-border text-text-tertiary hover:text-text-primary hover:border-text-tertiary'
                                                    : 'border-green-500/40 text-green-600 hover:bg-green-500/10'
                                            )}
                                        >
                                            {skill.disabled ? '已禁用' : '已启用'}
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}

                        {skillsMessage && (
                            <div className="text-xs px-3 py-2 rounded-lg border border-border bg-surface-primary text-text-secondary">
                                {skillsMessage}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </aside>
    );
}
