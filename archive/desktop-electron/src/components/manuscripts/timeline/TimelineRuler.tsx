import { useRef, type WheelEvent as ReactWheelEvent } from 'react';

type TimelineRulerProps = {
    viewportWidth: number;
    contentWidth: number;
    scrollLeft: number;
    scaleWidth: number;
    startLeft: number;
    cursorTime: number;
    onSeekTime: (timeInSeconds: number) => void;
    onScrollLeftChange?: (nextScrollLeft: number) => void;
    onWheel?: (event: ReactWheelEvent<HTMLDivElement>) => void;
};

function formatSecondsLabel(seconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safeSeconds / 60);
    const remainSeconds = safeSeconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, '0')}`;
}

export function TimelineRuler({
    viewportWidth,
    contentWidth,
    scrollLeft,
    scaleWidth,
    startLeft,
    cursorTime,
    onSeekTime,
    onScrollLeftChange,
    onWheel,
}: TimelineRulerProps) {
    const activePointerIdRef = useRef<number | null>(null);
    const pointerDownXRef = useRef(0);
    const pointerDownScrollLeftRef = useRef(scrollLeft);
    const hasDraggedRef = useRef(false);
    const visibleStartSecond = Math.max(0, Math.floor(scrollLeft / scaleWidth) - 1);
    const visibleEndSecond = Math.max(
        visibleStartSecond + 2,
        Math.ceil((scrollLeft + viewportWidth) / scaleWidth) + 1
    );
    const majorTicks = Array.from(
        { length: visibleEndSecond - visibleStartSecond + 1 },
        (_, index) => visibleStartSecond + index
    );
    const playheadLeft = Math.round(startLeft + cursorTime * scaleWidth - scrollLeft);

    const seekFromClientX = (clientX: number, bounds: DOMRect) => {
        const relativeX = Math.max(0, clientX - bounds.left - startLeft);
        const nextTime = Math.max(0, (relativeX + scrollLeft) / scaleWidth);
        onSeekTime(nextTime);
    };

    return (
        <div
            className="redbox-editable-timeline__ruler"
            onWheel={onWheel}
            onClick={(event) => {
                if (activePointerIdRef.current !== null || hasDraggedRef.current) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                seekFromClientX(event.clientX, bounds);
            }}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                activePointerIdRef.current = event.pointerId;
                pointerDownXRef.current = event.clientX;
                pointerDownScrollLeftRef.current = scrollLeft;
                hasDraggedRef.current = false;
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                if (activePointerIdRef.current !== event.pointerId) return;
                const deltaX = event.clientX - pointerDownXRef.current;
                if (Math.abs(deltaX) <= 4) return;
                hasDraggedRef.current = true;
                const nextScrollLeft = Math.max(0, pointerDownScrollLeftRef.current - deltaX);
                onScrollLeftChange?.(nextScrollLeft);
            }}
            onPointerUp={(event) => {
                if (activePointerIdRef.current !== event.pointerId) return;
                if (!hasDraggedRef.current) {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    seekFromClientX(event.clientX, bounds);
                }
                activePointerIdRef.current = null;
                hasDraggedRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }
            }}
            onPointerCancel={(event) => {
                if (activePointerIdRef.current !== event.pointerId) return;
                activePointerIdRef.current = null;
                hasDraggedRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }
            }}
        >
            <div
                className="redbox-editable-timeline__ruler-content"
                style={{ width: Math.max(contentWidth, viewportWidth) }}
            >
                {majorTicks.map((second) => {
                    const left = startLeft + second * scaleWidth - scrollLeft;
                    if (left < -scaleWidth || left > viewportWidth + scaleWidth) {
                        return null;
                    }
                    return (
                        <div
                            key={`major-${second}`}
                            className="redbox-editable-timeline__ruler-tick"
                            style={{ left }}
                        >
                            <div className="redbox-editable-timeline__ruler-label">{formatSecondsLabel(second)}</div>
                            <div className="redbox-editable-timeline__ruler-line" />
                            <div className="redbox-editable-timeline__ruler-half-line" />
                            <div className="redbox-editable-timeline__ruler-quarter-line" />
                            <div className="redbox-editable-timeline__ruler-quarter-line redbox-editable-timeline__ruler-quarter-line--last" />
                        </div>
                    );
                })}
                <div
                    className="redbox-editable-timeline__ruler-playhead"
                    style={{ left: Math.min(Math.max(startLeft, playheadLeft), Math.max(startLeft, viewportWidth - 2)) }}
                />
            </div>
        </div>
    );
}
