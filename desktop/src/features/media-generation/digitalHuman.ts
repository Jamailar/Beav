export type DigitalHumanAudioResult = {
    path: string;
    mimeType: string;
};

function valueRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function firstString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function extractFinalAudio(value: Record<string, unknown>): Record<string, unknown> {
    return valueRecord(value.finalAudio);
}

export function extractDigitalHumanFinalAudioResult(value: unknown): DigitalHumanAudioResult | null {
    const record = valueRecord(value);
    const data = valueRecord(record.data);
    const finalAudio = extractFinalAudio(data);
    const fallbackFinalAudio = Object.keys(finalAudio).length > 0 ? finalAudio : extractFinalAudio(record);
    const asset = valueRecord(fallbackFinalAudio.asset);
    const path = firstString(fallbackFinalAudio.path, asset.absolutePath, fallbackFinalAudio.previewUrl);
    if (!path) return null;
    return {
        path,
        mimeType: firstString(fallbackFinalAudio.mimeType, asset.mimeType) || 'audio/mpeg',
    };
}

export function digitalHumanResultErrorMessage(value: unknown, fallback = '声音生成完成但没有返回最终音频'): string {
    const record = valueRecord(value);
    return firstString(record.error, record.message) || fallback;
}
