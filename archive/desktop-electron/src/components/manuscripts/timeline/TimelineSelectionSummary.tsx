type TimelineSelectionSummaryProps = {
    visible: boolean;
    title: string;
    track: string;
    kind: string;
    startLabel: string;
    endLabel: string;
    durationLabel: string;
    enabled: boolean;
};

export function TimelineSelectionSummary({
    visible,
    title,
    track,
    kind,
    startLabel,
    endLabel,
    durationLabel,
    enabled,
}: TimelineSelectionSummaryProps) {
    if (!visible) return null;

    return (
        <div className="redbox-editable-timeline__selection-summary">
            <div className="redbox-editable-timeline__selection-title">{title}</div>
            <div className="redbox-editable-timeline__selection-meta">
                <span>{track}</span>
                <span>{kind}</span>
                <span>起点 {startLabel}</span>
                <span>终点 {endLabel}</span>
                <span>时长 {durationLabel}</span>
                <span>{enabled ? '启用中' : '已禁用'}</span>
            </div>
        </div>
    );
}
