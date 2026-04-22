export type TextPreset = {
    id: string;
    label: string;
    fontSize: number;
    color: string;
    backgroundColor: string;
    align: 'left' | 'center' | 'right';
    fontWeight: number;
    animation: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
};

export const TEXT_PRESETS: TextPreset[] = [
    {
        id: 'headline-hero',
        label: '主标题',
        fontSize: 54,
        color: '#ffffff',
        backgroundColor: 'rgba(15, 23, 42, 0.48)',
        align: 'center',
        fontWeight: 800,
        animation: 'fade-up',
    },
    {
        id: 'label-chip',
        label: '标签条',
        fontSize: 28,
        color: '#0f172a',
        backgroundColor: 'rgba(251, 191, 36, 0.92)',
        align: 'center',
        fontWeight: 700,
        animation: 'pop',
    },
    {
        id: 'note-panel',
        label: '说明框',
        fontSize: 30,
        color: '#e2e8f0',
        backgroundColor: 'rgba(30, 41, 59, 0.72)',
        align: 'left',
        fontWeight: 600,
        animation: 'slide-left',
    },
    {
        id: 'minimal-text',
        label: '极简文本',
        fontSize: 36,
        color: '#ffffff',
        backgroundColor: 'rgba(255,255,255,0.08)',
        align: 'center',
        fontWeight: 600,
        animation: 'fade-in',
    },
];

export function resolveTextPreset(presetId?: string | null): TextPreset {
    return TEXT_PRESETS.find((preset) => preset.id === presetId) || TEXT_PRESETS[0];
}
