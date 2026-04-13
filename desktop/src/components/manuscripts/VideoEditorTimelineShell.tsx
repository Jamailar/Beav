import type { ReactNode } from 'react';

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
                className={`${barClassName} flex items-center justify-center border-y border-white/10 bg-[#0f1012] transition-colors hover:bg-cyan-400/10`}
                onPointerDown={onResizeStart}
            >
                <div className="h-[3px] w-20 rounded-full bg-white/14" />
            </div>
            <section className={`${sectionClassName} min-h-0 overflow-hidden rounded-[20px] bg-[#121315] px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,0.22)]`}>
                {children}
            </section>
        </>
    );
}
