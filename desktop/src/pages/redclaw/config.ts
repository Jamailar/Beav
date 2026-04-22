import type { LongDraft, LongTemplate, ScheduleDraft, ScheduleTemplate } from './types';

export const REDCLAW_CONTEXT_ID = 'redclaw-singleton';
export const REDCLAW_CONTEXT_TYPE = 'redclaw';
export const REDCLAW_CONTEXT = [
    'RedClaw 是一个面向自媒体内容生产与运营的 AI 工作台。',
    '工作目标：基于用户目标推进选题、内容、配图、发布与复盘，并给出可执行的工作流建议。',
    '默认输出结构：目标拆解、内容策略、执行步骤、风险提示。',
].join('\n');

export const REDCLAW_SHORTCUTS = [
    { label: '🎯 开始策划', text: '这是一个新的自媒体内容目标，请先拆解目标、平台和受众，再给出完整执行方案。' },
    { label: '🧠 生成文案包', text: '请围绕当前目标生成完整内容文案包，并在完成后保存成稿件。' },
    { label: '🖼️ 生成配图包', text: '请为当前内容生成封面与配图提示词，并把结果落到可复用的文件。' },
    { label: '📊 复盘本次发布', text: '请基于本次发布结果做复盘，输出有效动作、问题和下一步建议。' },
];

export const REDCLAW_WELCOME_SHORTCUTS = [
    { label: '🚀 开始创作', text: '我想开始一个新的自媒体内容任务，请先明确目标，再推进创作。' },
    { label: '✍️ 继续文案', text: '继续当前内容任务，先回顾已有上下文，再完成文案包。' },
    { label: '🎨 继续配图', text: '继续当前内容任务，完善封面和配图提示词，并保存配图包。' },
    { label: '🔁 做复盘', text: '我已经发布了内容，请引导我输入数据并完成复盘。' },
];

export const RUNNER_INTERVAL_OPTIONS = [10, 20, 30, 60];
export const RUNNER_MAX_AUTOMATION_OPTIONS = [1, 2, 3, 5];
export const HEARTBEAT_INTERVAL_OPTIONS = [15, 30, 60, 120];
export const REDCLAW_SIDEBAR_MIN_WIDTH = 300;
export const REDCLAW_SIDEBAR_MAX_WIDTH = 560;
export const REDCLAW_SIDEBAR_DEFAULT_WIDTH = 380;
export const REDCLAW_WELCOME_ICON_SRC = '/Box.png';

export const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
    {
        id: 'daily-creation',
        label: '每日创作推进',
        description: '每天自动推进当前内容任务的文案与发布计划',
        name: '每日创作推进',
        mode: 'daily',
        time: '09:30',
        prompt: '请推进一次完整创作流程：补齐标题候选、正文、标签和发布计划，并把可交付内容保存成稿件。',
    },
    {
        id: 'daily-image',
        label: '每日配图完善',
        description: '每天补齐封面与配图提示词并保存',
        name: '每日配图完善',
        mode: 'daily',
        time: '14:00',
        prompt: '请检查当前重点内容的配图状态，产出封面和配图提示词并保存配图包；若已有配图包，继续迭代优化。',
    },
    {
        id: 'weekly-retro',
        label: '每周复盘',
        description: '固定每周总结执行结果并给出下一步',
        name: '每周复盘',
        mode: 'weekly',
        time: '21:00',
        weekdays: [1, 4],
        prompt: '请对本周内容执行情况进行复盘，输出有效动作、问题、下周假设和优先级动作。',
    },
    {
        id: 'interval-watch',
        label: '短周期巡检',
        description: '按固定间隔巡检内容卡点与风险',
        name: '内容巡检',
        mode: 'interval',
        intervalMinutes: 60,
        prompt: '请巡检当前进行中的内容任务，识别卡点和阻塞，输出最小下一步行动，并推动至少一个任务前进。',
    },
];

export const LONG_TEMPLATES: LongTemplate[] = [
    {
        id: 'growth-sprint',
        label: '增长冲刺',
        description: '围绕一个目标持续多轮优化',
        name: '30天增长冲刺',
        objective: '在 30 天内建立稳定的自媒体内容产出节奏并提升互动率。',
        stepPrompt: '执行一轮增长冲刺：复盘上一轮结果、调整选题策略、产出新的内容动作并落地到稿件、素材或工作项。',
        intervalMinutes: 720,
        totalRounds: 30,
    },
    {
        id: 'ip-building',
        label: '个人IP构建',
        description: '持续沉淀人设与内容母题',
        name: '个人IP构建计划',
        objective: '建立清晰的人设定位与可复用内容母题，形成稳定输出体系。',
        stepPrompt: '推进一轮 IP 构建：提炼用户画像、选题母题和表达风格，并输出可执行内容任务。',
        intervalMinutes: 1440,
        totalRounds: 21,
    },
    {
        id: 'topic-lab',
        label: '选题实验室',
        description: '持续验证高潜选题',
        name: '选题实验室',
        objective: '持续验证并筛选高潜选题，形成数据驱动的选题库。',
        stepPrompt: '执行一轮选题实验：提出 3 个选题假设，评估优先级，并推进最优选题进入创作。',
        intervalMinutes: 480,
        totalRounds: 20,
    },
];

export const WEEKDAY_OPTIONS = [
    { value: 1, label: '周一' },
    { value: 2, label: '周二' },
    { value: 3, label: '周三' },
    { value: 4, label: '周四' },
    { value: 5, label: '周五' },
    { value: 6, label: '周六' },
    { value: 0, label: '周日' },
];

export function pickScheduleTemplate(templateId: string): ScheduleTemplate {
    return SCHEDULE_TEMPLATES.find((item) => item.id === templateId) || SCHEDULE_TEMPLATES[0];
}

export function pickLongTemplate(templateId: string): LongTemplate {
    return LONG_TEMPLATES.find((item) => item.id === templateId) || LONG_TEMPLATES[0];
}

export function scheduleDraftFromTemplate(template: ScheduleTemplate): ScheduleDraft {
    return {
        templateId: template.id,
        name: template.name,
        mode: template.mode,
        intervalMinutes: template.intervalMinutes || 60,
        time: template.time || '09:00',
        weekdays: template.weekdays || [1],
        runAtLocal: '',
        prompt: template.prompt,
    };
}

export function longDraftFromTemplate(template: LongTemplate): LongDraft {
    return {
        templateId: template.id,
        name: template.name,
        objective: template.objective,
        stepPrompt: template.stepPrompt,
        intervalMinutes: template.intervalMinutes,
        totalRounds: template.totalRounds,
    };
}
