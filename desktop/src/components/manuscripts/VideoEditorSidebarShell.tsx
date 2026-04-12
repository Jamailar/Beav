import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

type SidebarTab = {
    id: string;
    label: string;
    icon: LucideIcon;
};

type VideoEditorSidebarShellProps = {
    title: string;
    subtitle: string;
    tabs: SidebarTab[];
    activeTabId: string;
    trackLabel: string;
    onSelectTab: (id: string) => void;
    children: ReactNode;
};

export function VideoEditorSidebarShell({
    title,
    subtitle,
    tabs,
    activeTabId,
    trackLabel,
    onSelectTab,
    children,
}: VideoEditorSidebarShellProps) {
    return (
        <aside className="col-start-1 row-start-1 flex h-full min-h-0 border-r border-white/10 bg-[#17181c]">
            <nav className="flex w-[60px] shrink-0 flex-col items-center border-r border-white/10 bg-[#121317] px-2 py-3">
                <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-white/30">Tools</div>
                <div className="flex w-full flex-col items-center gap-2">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        const active = activeTabId === tab.id;
                        return (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => onSelectTab(tab.id)}
                                className={clsx(
                                    'flex h-10 w-10 items-center justify-center rounded-2xl border transition',
                                    active
                                        ? 'border-cyan-300/45 bg-cyan-400/14 text-cyan-100'
                                        : 'border-transparent bg-transparent text-white/45 hover:border-white/10 hover:bg-white/[0.04] hover:text-white/80'
                                )}
                                title={tab.label}
                            >
                                <Icon className="h-4.5 w-4.5" />
                            </button>
                        );
                    })}
                </div>
            </nav>

            <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <header className="mb-4 flex items-center justify-between gap-3">
                    <div>
                        <div className="text-sm font-medium text-cyan-300">{title}</div>
                        <div className="mt-1 text-[11px] text-white/45">{subtitle}</div>
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/60">
                        {trackLabel}
                    </div>
                </header>
                {children}
            </section>
        </aside>
    );
}
