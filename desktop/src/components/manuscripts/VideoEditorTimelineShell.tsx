import type { ReactNode } from 'react';

type VideoEditorTimelineShellProps = {
    children: ReactNode;
    onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
};

export function VideoEditorTimelineShell({
    children,
    onResizeStart,
}: VideoEditorTimelineShellProps) {
    return (
        <>
            <div
                className="col-start-1 col-end-4 row-start-2 border-y border-white/10 bg-white/[0.03] transition-colors hover:bg-cyan-400/20"
                onPointerDown={onResizeStart}
            />
            <section className="col-start-1 col-end-4 row-start-3 min-h-0 bg-[#131416] px-3 py-3">
                <div className="h-full rounded-[18px] border border-white/8 bg-[#151515] p-2">
                    {children}
                </div>
            </section>
        </>
    );
}
