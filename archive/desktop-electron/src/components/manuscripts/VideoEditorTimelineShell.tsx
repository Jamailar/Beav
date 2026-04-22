import type { ReactNode } from 'react';
import clsx from 'clsx';

type VideoEditorTimelineShellProps = {
    children: ReactNode;
    onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
    barClassName?: string;
    sectionClassName?: string;
};

export function VideoEditorTimelineShell({
    children,
    onResizeStart,
    barClassName = 'col-start-1 col-end-4 row-start-2',
    sectionClassName = 'col-start-1 col-end-4 row-start-3',
}: VideoEditorTimelineShellProps) {
    return (
        <>
            <div
                className={clsx(
                    'flex items-center justify-center border-y border-white/10 bg-[#0b0c0f] transition-colors',
                    'hover:border-cyan-300/20 hover:bg-cyan-400/10',
                    barClassName,
                )}
                onPointerDown={onResizeStart}
                data-editor-timeline-resize-bar
            >
                <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1">
                    <div className="h-[3px] w-10 rounded-full bg-white/12" />
                    <div className="h-[3px] w-10 rounded-full bg-white/12" />
                </div>
            </div>
            <section
                className={clsx(
                    'min-h-0 overflow-hidden rounded-[22px] border border-white/10 bg-[#0f1014]',
                    'shadow-[0_16px_44px_rgba(0,0,0,0.28)]',
                    sectionClassName,
                )}
                data-editor-timeline-shell
            >
                {children}
            </section>
        </>
    );
}
