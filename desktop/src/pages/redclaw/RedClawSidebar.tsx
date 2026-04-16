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
                'relative shrink-0 bg-white/85 backdrop-blur-[40px] overflow-hidden',
                collapsed ? 'border-l-0' : 'border-l border-black/[0.04]',
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
                    
                    {/* 头部 - 精密风格 */}
                    <div className="px-5 pt-5 pb-3">
                        <div className="flex items-center justify-between">
                            <h2 className="text-[15px] font-extrabold tracking-tight text-text-primary">能力面板</h2>
                            <button
                                onClick={onCollapse}
                                className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/[0.04] text-text-tertiary transition-all hover:bg-black/[0.08] hover:text-text-primary active:scale-90"
                                title="关闭"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        
                        {chatActionMessage && (
                            <div className="mt-3 text-[10px] font-bold px-3 py-2 rounded-lg bg-accent-primary/5 text-accent-primary border border-accent-primary/10 animate-in fade-in slide-in-from-top-1">
                                {chatActionMessage}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 custom-scrollbar space-y-4">
                        {/* 快速安装 - 精密卡片 */}
                        <div className="rounded-xl border border-black/[0.04] bg-white/40 p-3 space-y-2 text-text-primary">
                            <div className="text-[10px] text-text-tertiary font-bold uppercase tracking-wider">安装新技能</div>
                            <div className="relative">
                                <input
                                    type="text"
                                    value={installSource}
                                    onChange={(event) => onInstallSourceChange(event.target.value)}
                                    onKeyDown={(event) => (event.key === 'Enter') && void onInstallSkill()}
                                    placeholder="输入技能标识或链接..."
                                    className="w-full pl-3 pr-3 py-2 rounded-lg border border-black/[0.06] bg-white/60 text-[11px] font-medium text-text-primary placeholder:text-text-tertiary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary/30 transition-all"
                                />
                            </div>
                            <button
                                onClick={() => void onInstallSkill()}
                                disabled={isInstallingSkill || !installSource.trim()}
                                className="w-full px-3 py-2 rounded-lg text-[11px] font-bold bg-text-primary text-white hover:bg-text-primary/90 transition-all active:scale-[0.98] disabled:opacity-30 flex items-center justify-center gap-2"
                            >
                                {isInstallingSkill ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                <span>{isInstallingSkill ? '正在安装...' : '安装技能'}</span>
                            </button>
                        </div>

                        {/* 技能列表 */}
                        <div className="space-y-2 pb-10">
                            <div className="flex items-center justify-between px-1">
                                <div className="text-[10px] text-text-tertiary font-bold uppercase tracking-wider">
                                    已启用的技能 ({enabledSkillCount})
                                </div>
                                {isSkillsLoading && <Loader2 className="w-3 h-3 animate-spin text-accent-primary" />}
                            </div>

                            {skills.length === 0 && !isSkillsLoading ? (
                                <div className="text-[11px] text-text-tertiary/60 font-medium border border-dashed border-black/[0.08] rounded-xl p-6 text-center">
                                    当前空间尚未安装技能
                                </div>
                            ) : (
                                skills.map((skill) => (
                                    <div 
                                        key={skill.location} 
                                        className={clsx(
                                            "rounded-xl border p-3 transition-all duration-200",
                                            skill.disabled 
                                                ? "border-black/[0.03] bg-white/30 grayscale-[0.2] opacity-90" 
                                                : "border-black/[0.04] bg-white shadow-sm ring-1 ring-black/[0.01]"
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[12px] text-text-primary font-bold truncate leading-tight">
                                                    {skill.name}
                                                </div>
                                                <div className="text-[10px] text-text-tertiary font-medium mt-1 line-clamp-2 leading-relaxed">
                                                    {skill.description || '暂无描述信息'}
                                                </div>
                                                <div className="text-[9px] text-text-tertiary/40 font-bold mt-2 truncate uppercase tracking-tighter">
                                                    {skill.location}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => void onToggleSkill(skill)}
                                                className={clsx(
                                                    'px-2 py-1 rounded-md text-[9px] font-bold border transition-all shrink-0 active:scale-90',
                                                    skill.disabled
                                                        ? 'bg-rose-50 border-rose-200 text-rose-600 hover:bg-rose-100'
                                                        : 'bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100'
                                                )}
                                            >
                                                {skill.disabled ? '已禁用' : '已启用'}
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>

                        {skillsMessage && (
                            <div className="fixed bottom-4 right-4 z-50 text-[10px] font-bold px-4 py-2 rounded-lg bg-text-primary text-white shadow-xl animate-in fade-in slide-in-from-bottom-2">
                                {skillsMessage}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </aside>
    );
}
