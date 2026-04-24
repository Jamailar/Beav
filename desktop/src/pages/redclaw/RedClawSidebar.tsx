import { Download, Loader2, Sparkles, X } from 'lucide-react';
import { clsx } from 'clsx';

interface RedClawSidebarProps {
    open: boolean;
    chatActionMessage: string;
    skills: SkillDefinition[];
    isSkillsLoading: boolean;
    skillsMessage: string;
    enabledSkillCount: number;
    installSource: string;
    isInstallingSkill: boolean;
    onToggleOpen: () => void;
    onCollapse: () => void;
    onInstallSourceChange: (value: string) => void;
    onInstallSkill: () => void | Promise<void>;
    onToggleSkill: (skill: SkillDefinition) => void | Promise<void>;
}

export function RedClawSidebar({
    open,
    chatActionMessage,
    skills,
    isSkillsLoading,
    skillsMessage,
    enabledSkillCount,
    installSource,
    isInstallingSkill,
    onToggleOpen,
    onCollapse,
    onInstallSourceChange,
    onInstallSkill,
    onToggleSkill,
}: RedClawSidebarProps) {
    return (
        <>
            <div className="absolute top-4 right-5 z-30 flex items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleOpen}
                    className={clsx(
                        'flex items-center gap-2 rounded-xl border px-3.5 py-1.5 text-[12px] font-bold shadow-sm backdrop-blur-xl transition-all active:scale-95',
                        open
                            ? 'border-transparent bg-accent-primary text-white'
                            : 'border-border/80 bg-surface-elevated/92 text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                    )}
                    title="查看技能面板"
                    aria-label="查看技能面板"
                >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>技能</span>
                </button>
            </div>

            {open && (
                <div className="absolute inset-0 z-40">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/25 backdrop-blur-[2px] transition-opacity"
                        aria-label="关闭技能面板抽屉"
                        onClick={onCollapse}
                    />

                    <div className="absolute right-4 top-4 bottom-4 flex w-[360px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface-primary shadow-[0_24px_64px_-16px_rgba(15,23,42,0.16)] animate-slide-in-right">
                        <div className="relative flex h-full flex-col">
                            <div className="px-5 pt-5 pb-2">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-[15px] font-extrabold tracking-tight text-text-primary">技能面板</h2>
                                    <button
                                        type="button"
                                        onClick={onCollapse}
                                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-secondary/80 text-text-tertiary transition-all hover:bg-surface-tertiary hover:text-text-primary"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>

                                {chatActionMessage && (
                                    <div className="mt-3 rounded-lg border border-accent-primary/10 bg-accent-primary/5 px-3 py-2 text-[10px] font-bold text-accent-primary animate-in fade-in slide-in-from-top-1">
                                        {chatActionMessage}
                                    </div>
                                )}
                            </div>

                            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 custom-scrollbar space-y-4">
                                <div className="space-y-2 rounded-xl border border-border/70 bg-surface-elevated/80 p-3 text-text-primary">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">安装新技能</div>
                                    <div className="relative">
                                        <input
                                            type="text"
                                            value={installSource}
                                            onChange={(event) => onInstallSourceChange(event.target.value)}
                                            onKeyDown={(event) => (event.key === 'Enter') && void onInstallSkill()}
                                            placeholder="输入技能标识或链接..."
                                            className="w-full rounded-lg border border-border bg-surface-primary px-3 py-2 text-[11px] font-medium text-text-primary placeholder:text-text-tertiary/60 transition-all focus:outline-none focus:ring-1 focus:ring-accent-primary/30"
                                        />
                                    </div>
                                    <button
                                        onClick={() => void onInstallSkill()}
                                        disabled={isInstallingSkill || !installSource.trim()}
                                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-primary px-3 py-2 text-[11px] font-bold text-white transition-all hover:bg-accent-hover active:scale-[0.98] disabled:opacity-30"
                                    >
                                        {isInstallingSkill ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                                        <span>{isInstallingSkill ? '正在安装...' : '安装技能'}</span>
                                    </button>
                                </div>

                                <div className="space-y-2 pb-6">
                                    <div className="flex items-center justify-between px-1">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                                            已启用的技能 ({enabledSkillCount})
                                        </div>
                                        {isSkillsLoading && <Loader2 className="h-3 w-3 animate-spin text-accent-primary" />}
                                    </div>

                                    {skills.length === 0 && !isSkillsLoading ? (
                                        <div className="rounded-xl border border-dashed border-border/80 p-6 text-center text-[11px] font-medium text-text-tertiary/60">
                                            当前空间尚未安装技能
                                        </div>
                                    ) : (
                                        skills.map((skill) => (
                                            <div
                                                key={skill.location}
                                                className={clsx(
                                                    'rounded-xl border p-3 transition-all duration-200',
                                                    skill.disabled
                                                        ? 'border-border/60 bg-surface-secondary/70 grayscale-[0.2] opacity-90'
                                                        : 'border-border/70 bg-surface-elevated shadow-sm ring-1 ring-border/40'
                                                )}
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-[12px] font-bold leading-tight text-text-primary">
                                                            {skill.name}
                                                        </div>
                                                        <div className="mt-1 line-clamp-2 text-[10px] font-medium leading-relaxed text-text-tertiary">
                                                            {skill.description || '暂无描述信息'}
                                                        </div>
                                                        <div className="mt-2 truncate text-[9px] font-bold uppercase tracking-tighter text-text-tertiary/40">
                                                            {skill.location}
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={() => void onToggleSkill(skill)}
                                                        className={clsx(
                                                            'shrink-0 rounded-md border px-2 py-1 text-[9px] font-bold transition-all active:scale-90',
                                                            skill.disabled
                                                                ? 'border-rose-400/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15'
                                                                : 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15'
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
                                    <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-text-primary px-4 py-2 text-[10px] font-bold text-white shadow-xl animate-in fade-in slide-in-from-bottom-2">
                                        {skillsMessage}
                                    </div>
                                )}
                            </div>

                            <div className="border-t border-border/70 px-5 py-3">
                                <p className="text-center text-[8px] font-bold uppercase tracking-[0.3em] text-text-tertiary/40">
                                    RedBox Skills
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
