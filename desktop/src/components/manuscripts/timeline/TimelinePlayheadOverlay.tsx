import { useRef } from 'react';

type TimelinePlayheadOverlayProps = {
    left: number;
    onScrubToClientX?: (clientX: number) => void;
};

export function TimelinePlayheadOverlay({
    left,
    onScrubToClientX,
}: TimelinePlayheadOverlayProps) {
    const activePointerIdRef = useRef<number | null>(null);

    return (
        <div
            className="redbox-editable-timeline__playhead-overlay"
            style={{ left }}
        >
            <div
                className="redbox-editable-timeline__playhead-handle"
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    activePointerIdRef.current = event.pointerId;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    onScrubToClientX?.(event.clientX);
                }}
                onPointerMove={(event) => {
                    if (activePointerIdRef.current !== event.pointerId) return;
                    onScrubToClientX?.(event.clientX);
                }}
                onPointerUp={(event) => {
                    if (activePointerIdRef.current !== event.pointerId) return;
                    activePointerIdRef.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                }}
                onPointerCancel={(event) => {
                    if (activePointerIdRef.current !== event.pointerId) return;
                    activePointerIdRef.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                }}
            >
                <div className="redbox-editable-timeline__playhead-line" />
            </div>
        </div>
    );
}
