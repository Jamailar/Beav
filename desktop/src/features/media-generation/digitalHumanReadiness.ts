export function valueRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

export function firstString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

export function isRemoteUrl(value: string): boolean {
    return /^https?:\/\//i.test(value.trim());
}

export function fileUrlToPath(value: string): string {
    if (!value.startsWith('file://')) return value;
    try {
        return decodeURIComponent(new URL(value).pathname);
    } catch {
        return value.replace(/^file:\/\//, '');
    }
}

export function extractSubjectVoiceId(subject: SubjectRecord | null): string {
    if (!subject) return '';
    const voice = valueRecord(subject.voice);
    const attributes = Array.isArray(subject.attributes) ? subject.attributes : [];
    const attributeVoice = attributes.find((item) => {
        const key = String(item?.key || '').trim().toLowerCase();
        return key === 'voice_id' || key === 'voiceid' || key === '声音id';
    });
    return firstString(voice.voiceId, voice.voice_id, voice.id, attributeVoice?.value);
}

export function extractSubjectVideoPath(subject: SubjectRecord | null): string {
    if (!subject) return '';
    return firstString(subject.absoluteVideoPath, subject.videoPath, fileUrlToPath(firstString(subject.videoPreviewUrl)));
}

export function digitalHumanReadiness(subject: SubjectRecord | null): { ok: boolean; voiceId: string; videoPath: string; issue: string } {
    if (!subject) return { ok: false, voiceId: '', videoPath: '', issue: '请选择角色' };
    const voiceId = extractSubjectVoiceId(subject);
    const videoPath = extractSubjectVideoPath(subject);
    const issues: string[] = [];
    if (!videoPath) issues.push('角色缺少参考视频');
    if (!voiceId) {
        issues.push(videoPath ? '音色克隆未完成' : '角色缺少声音 ID');
    }
    return { ok: issues.length === 0, voiceId, videoPath, issue: issues.join('，') };
}
