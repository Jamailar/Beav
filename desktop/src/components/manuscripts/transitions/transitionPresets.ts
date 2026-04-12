export type TransitionKind =
    | 'none'
    | 'fade'
    | 'slide'
    | 'wipe'
    | 'flip'
    | 'clock-wipe'
    | 'star'
    | 'circle'
    | 'rectangle';

export type TransitionDirection = 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
export type TransitionGroup = 'dissolve' | 'motion' | 'mask';

export type TransitionPreset = {
    id: string;
    label: string;
    kind: TransitionKind;
    direction?: TransitionDirection;
    durationMs: number;
    accent: string;
    preview: string;
    group: TransitionGroup;
    description: string;
};

export const TRANSITION_PRESETS: TransitionPreset[] = [
    {
        id: 'none',
        label: '无转场',
        kind: 'none',
        durationMs: 0,
        accent: '#94a3b8',
        preview: 'linear-gradient(135deg, rgba(148,163,184,0.18), rgba(148,163,184,0.02))',
        group: 'dissolve',
        description: '直接切换到下一镜头',
    },
    {
        id: 'fade-500',
        label: '淡入淡出',
        kind: 'fade',
        durationMs: 500,
        accent: '#67e8f9',
        preview: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.24), transparent 45%), linear-gradient(135deg, rgba(103,232,249,0.44), rgba(8,47,73,0.08))',
        group: 'dissolve',
        description: '柔和叠化，适合镜头语气切换',
    },
    {
        id: 'slide-up-500',
        label: '上滑入',
        kind: 'slide',
        direction: 'from-bottom',
        durationMs: 500,
        accent: '#a78bfa',
        preview: 'linear-gradient(180deg, rgba(167,139,250,0.06), rgba(167,139,250,0.42)), linear-gradient(135deg, rgba(15,23,42,0.24), rgba(167,139,250,0.1))',
        group: 'motion',
        description: '新画面从底部推入',
    },
    {
        id: 'slide-down-500',
        label: '下滑入',
        kind: 'slide',
        direction: 'from-top',
        durationMs: 500,
        accent: '#f472b6',
        preview: 'linear-gradient(0deg, rgba(244,114,182,0.08), rgba(244,114,182,0.42)), linear-gradient(135deg, rgba(15,23,42,0.24), rgba(244,114,182,0.1))',
        group: 'motion',
        description: '新画面从顶部压入',
    },
    {
        id: 'slide-left-500',
        label: '左滑入',
        kind: 'slide',
        direction: 'from-right',
        durationMs: 500,
        accent: '#f59e0b',
        preview: 'linear-gradient(90deg, rgba(245,158,11,0.05), rgba(245,158,11,0.48)), linear-gradient(135deg, rgba(15,23,42,0.28), rgba(245,158,11,0.1))',
        group: 'motion',
        description: '新画面从右侧推入',
    },
    {
        id: 'slide-right-500',
        label: '右滑入',
        kind: 'slide',
        direction: 'from-left',
        durationMs: 500,
        accent: '#f97316',
        preview: 'linear-gradient(270deg, rgba(249,115,22,0.05), rgba(249,115,22,0.48)), linear-gradient(135deg, rgba(15,23,42,0.28), rgba(249,115,22,0.1))',
        group: 'motion',
        description: '新画面从左侧推入',
    },
    {
        id: 'wipe-up-500',
        label: '向上擦除',
        kind: 'wipe',
        direction: 'from-bottom',
        durationMs: 500,
        accent: '#22d3ee',
        preview: 'linear-gradient(180deg, rgba(34,211,238,0.03), rgba(34,211,238,0.5) 65%, rgba(255,255,255,0.22) 66%, rgba(8,47,73,0.08) 100%)',
        group: 'mask',
        description: '从底部擦出新画面',
    },
    {
        id: 'wipe-down-500',
        label: '向下擦除',
        kind: 'wipe',
        direction: 'from-top',
        durationMs: 500,
        accent: '#38bdf8',
        preview: 'linear-gradient(0deg, rgba(56,189,248,0.03), rgba(56,189,248,0.5) 65%, rgba(255,255,255,0.22) 66%, rgba(8,47,73,0.08) 100%)',
        group: 'mask',
        description: '从顶部擦出新画面',
    },
    {
        id: 'wipe-left-500',
        label: '向左擦除',
        kind: 'wipe',
        direction: 'from-right',
        durationMs: 500,
        accent: '#2dd4bf',
        preview: 'linear-gradient(90deg, rgba(45,212,191,0.03), rgba(45,212,191,0.5) 65%, rgba(255,255,255,0.22) 66%, rgba(8,47,73,0.08) 100%)',
        group: 'mask',
        description: '从右侧擦出新画面',
    },
    {
        id: 'wipe-right-500',
        label: '向右擦除',
        kind: 'wipe',
        direction: 'from-left',
        durationMs: 500,
        accent: '#14b8a6',
        preview: 'linear-gradient(270deg, rgba(20,184,166,0.03), rgba(20,184,166,0.5) 65%, rgba(255,255,255,0.22) 66%, rgba(8,47,73,0.08) 100%)',
        group: 'mask',
        description: '从左侧擦出新画面',
    },
    {
        id: 'flip-500',
        label: '翻转',
        kind: 'flip',
        durationMs: 500,
        accent: '#fb7185',
        preview: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.22), transparent 40%), linear-gradient(135deg, rgba(251,113,133,0.45), rgba(15,23,42,0.08))',
        group: 'motion',
        description: '像翻牌一样切换镜头',
    },
    {
        id: 'clock-wipe-500',
        label: '时钟擦除',
        kind: 'clock-wipe',
        durationMs: 500,
        accent: '#c084fc',
        preview: 'conic-gradient(from 270deg, rgba(192,132,252,0.55) 0 25%, rgba(192,132,252,0.08) 25% 100%)',
        group: 'mask',
        description: '从中心按角度展开',
    },
    {
        id: 'star-500',
        label: '星形打开',
        kind: 'star',
        durationMs: 500,
        accent: '#facc15',
        preview: 'radial-gradient(circle at center, rgba(250,204,21,0.55), rgba(250,204,21,0.04) 58%), linear-gradient(135deg, rgba(15,23,42,0.28), rgba(250,204,21,0.12))',
        group: 'mask',
        description: '星形遮罩展开新画面',
    },
    {
        id: 'circle-500',
        label: '圆形打开',
        kind: 'circle',
        durationMs: 500,
        accent: '#4ade80',
        preview: 'radial-gradient(circle at center, rgba(74,222,128,0.58), rgba(74,222,128,0.06) 52%), linear-gradient(135deg, rgba(15,23,42,0.24), rgba(74,222,128,0.08))',
        group: 'mask',
        description: '从中心圆形扩展',
    },
    {
        id: 'rectangle-500',
        label: '矩形打开',
        kind: 'rectangle',
        durationMs: 500,
        accent: '#60a5fa',
        preview: 'radial-gradient(circle at center, rgba(96,165,250,0.18), transparent 48%), linear-gradient(135deg, rgba(96,165,250,0.52), rgba(15,23,42,0.1))',
        group: 'mask',
        description: '中心矩形向外扩展',
    },
];

export function resolveTransitionPreset(presetId?: string | null): TransitionPreset {
    return TRANSITION_PRESETS.find((preset) => preset.id === presetId) || TRANSITION_PRESETS[0];
}
