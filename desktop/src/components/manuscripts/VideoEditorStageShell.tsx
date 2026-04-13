import type { ReactNode } from 'react';
import clsx from 'clsx';

type VideoEditorStageShellProps = {
    title: string;
    subtitle: string;
    toolbar: ReactNode;
    children: ReactNode;
    compact?: boolean;
    gridClassName?: string;
    contentClassName?: string;
    contentChrome?: 'default' | 'none';
};

export function VideoEditorStageShell({
    title,
    subtitle,
    toolbar,
    children,
    compact = false,
    gridClassName = 'col-start-3 row-start-1',
    contentClassName,
    contentChrome = 'default',
}: VideoEditorStageShellProps) {
    return (
        <section className={clsx(gridClassName, 'flex h-full min-h-0 flex-col bg-[#111214] px-4 py-4')}>
            {!compact ? (
                <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="text-sm font-medium text-white">{title}</div>
                        <div className="mt-1 text-xs text-white/45">{subtitle}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {toolbar}
                    </div>
                </header>
            ) : (
                <div className="mb-2 flex items-center justify-end gap-2">
                    {toolbar}
                </div>
            )}
            <div className={clsx(
                'min-h-0 flex-1 overflow-hidden',
                contentChrome === 'default' && [
                    'rounded-[22px] border border-white/10 bg-[#101113]',
                    'shadow-[0_14px_40px_rgba(0,0,0,0.24)]',
                ],
                contentClassName
            )}>
                {children}
            </div>
        </section>
    );
}
