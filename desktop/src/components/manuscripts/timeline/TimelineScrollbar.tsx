type TimelineScrollbarProps = {
    scrollLeft: number;
    maxScrollLeft: number;
    onChange: (nextLeft: number) => void;
};

export function TimelineScrollbar({
    scrollLeft,
    maxScrollLeft,
    onChange,
}: TimelineScrollbarProps) {
    return (
        <div className="redbox-editable-timeline__scrollbar">
            <input
                type="range"
                min={0}
                max={Math.max(0, maxScrollLeft)}
                value={Math.min(scrollLeft, maxScrollLeft)}
                onChange={(event) => {
                    onChange(Number(event.target.value || 0));
                }}
                className="redbox-editable-timeline__scrollbar-input"
                disabled={maxScrollLeft <= 0}
            />
        </div>
    );
}
