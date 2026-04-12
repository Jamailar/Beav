export type SubtitlePreset = {
    id: string;
    label: string;
    type: 'line' | 'word';
    fontSize: number;
    color: string;
    backgroundColor: string;
    emphasisColor: string;
    align: 'left' | 'center' | 'right';
    position: 'top' | 'center' | 'bottom';
    animation: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
    fontWeight: number;
    textTransform: 'none' | 'uppercase';
    letterSpacing: number;
    borderRadius: number;
    paddingX: number;
    paddingY: number;
};

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
    {
        id: 'classic-bottom',
        label: '经典底栏',
        type: 'line',
        fontSize: 34,
        color: '#ffffff',
        backgroundColor: 'rgba(6, 8, 12, 0.58)',
        emphasisColor: '#facc15',
        align: 'center',
        position: 'bottom',
        animation: 'fade-up',
        fontWeight: 700,
        textTransform: 'none',
        letterSpacing: 0,
        borderRadius: 22,
        paddingX: 20,
        paddingY: 12,
    },
    {
        id: 'cinema-top',
        label: '电影上栏',
        type: 'line',
        fontSize: 30,
        color: '#f8fafc',
        backgroundColor: 'rgba(15, 23, 42, 0.68)',
        emphasisColor: '#93c5fd',
        align: 'left',
        position: 'top',
        animation: 'slide-left',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        borderRadius: 20,
        paddingX: 18,
        paddingY: 10,
    },
    {
        id: 'focus-pop',
        label: '强调弹出',
        type: 'word',
        fontSize: 38,
        color: '#0f172a',
        backgroundColor: 'rgba(251, 191, 36, 0.92)',
        emphasisColor: '#ffffff',
        align: 'center',
        position: 'center',
        animation: 'pop',
        fontWeight: 800,
        textTransform: 'none',
        letterSpacing: 0.2,
        borderRadius: 24,
        paddingX: 22,
        paddingY: 14,
    },
    {
        id: 'minimal-clear',
        label: '透明极简',
        type: 'line',
        fontSize: 32,
        color: '#ffffff',
        backgroundColor: 'rgba(255,255,255,0.08)',
        emphasisColor: '#67e8f9',
        align: 'center',
        position: 'bottom',
        animation: 'fade-in',
        fontWeight: 600,
        textTransform: 'none',
        letterSpacing: 0,
        borderRadius: 18,
        paddingX: 18,
        paddingY: 10,
    },
];

export function resolveSubtitlePreset(presetId?: string | null): SubtitlePreset {
    return SUBTITLE_PRESETS.find((preset) => preset.id === presetId) || SUBTITLE_PRESETS[0];
}
