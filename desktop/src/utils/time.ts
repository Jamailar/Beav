export function parseTimestampMs(value: unknown): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        const normalized = Math.abs(value) >= 1_000_000_000_000 ? value : value * 1000;
        return normalized > 0 ? normalized : null;
    }

    const trimmed = String(value ?? '').trim();
    if (!trimmed) return null;

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return null;
        const normalized = Math.abs(parsed) >= 1_000_000_000_000 ? parsed : parsed * 1000;
        return normalized > 0 ? normalized : null;
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function formatTimestampDate(value: unknown): string {
    const timestamp = parseTimestampMs(value);
    if (timestamp === null) return '';
    return new Date(timestamp).toLocaleDateString();
}

export function formatTimestampDateTime(value: unknown): string {
    const timestamp = parseTimestampMs(value);
    if (timestamp === null) return '';
    return new Date(timestamp).toLocaleString();
}
