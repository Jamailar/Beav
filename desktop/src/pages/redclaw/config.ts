import type { ChatShortcut, ChatShortcutContext } from '../Chat';
import { APP_BRAND } from '../../config/brand';
import type { LongDraft, LongTemplate, ScheduleDraft, ScheduleTemplate } from './types';

export const REDCLAW_CONTEXT_ID = 'redclaw-singleton';
export const REDCLAW_CONTEXT_TYPE = 'redclaw';
export const REDCLAW_DISPLAY_NAME = APP_BRAND.redClawDisplayName;
export const REDCLAW_CONTEXT = [
    `${REDCLAW_DISPLAY_NAME} 是一个面向自媒体内容生产与运营的 AI 工作台。`,
    '工作目标：基于用户目标推进选题、内容、配图、发布与复盘，并给出可执行的工作流建议。',
    '默认输出结构：目标拆解、内容策略、执行步骤、风险提示。',
    '当产出、保存或更新可交付文件时，必须用 Markdown 链接报告路径，优先使用 workspace://、media://、manuscripts://、knowledge://、cover:// 或 redclaw:// 这类 app 内虚拟路径。',
].join('\n');

export interface RedClawComposerShortcutInput {
    label: string;
    text: string;
    action?: ChatShortcut['action'];
}

export type RedClawComposerShortcutScene =
    | 'uploaded_file'
    | 'uploaded_image'
    | 'empty_new_chat'
    | 'member_mention'
    | 'knowledge_context';

export const REDCLAW_DEFAULT_COMPOSER_SHORTCUT_INPUTS: RedClawComposerShortcutInput[] = [
    { label: '电商套图', text: '请围绕一个商品或服务，设计一套可用于电商详情页/社媒投放的套图方案。请先明确目标用户、核心卖点、视觉风格和转化目标，再输出每张图的主题、画面构图、主标题、副文案、素材需求和生成提示词。' },
    { label: '文章卡片', text: '请围绕一个内容主题，设计一组适合社媒发布的文章卡片。请先梳理核心观点和读者收益，再输出卡片数量、每张卡片的标题、正文要点、视觉建议、版式结构和最终发布文案。' },
    { label: '图解卡片', text: '请把一个复杂概念、流程或观点拆解成一组图解卡片。请先提炼逻辑主线，再输出每张卡片的信息层级、图解方式、标题、关键文案、配图建议和适合直接生成视觉稿的提示词。' },
    { label: '演示卡片', text: '请把一个产品、方法或案例做成小红书/短图文风格的演示卡片。请先设计演示路径，再输出封面、步骤页、对比页、总结页的内容结构、页面文案、视觉风格和生成提示词。' },
];

export const REDCLAW_COMPOSER_SHORTCUT_INPUTS_BY_SCENE: Record<RedClawComposerShortcutScene, RedClawComposerShortcutInput[]> = {
    uploaded_file: [
        { label: '总结文档内容', text: '请阅读我上传的文件，先判断文件类型和主要用途，再总结核心内容、关键结论、重要数据、可复用素材和潜在创作角度。最后给出一版适合我快速决策的结构化摘要。' },
        { label: '做成文章卡片', text: '请基于我上传的文件内容，提炼最适合对外传播的主题，并设计一组文章卡片。请输出卡片标题、每张卡片的正文要点、视觉建议、适合平台的发布文案和需要补充的信息。' },
        { label: '做成图解卡片', text: '请把我上传的文件内容整理成图解卡片。请先找出最适合图解表达的流程、结构、对比或方法论，再输出每张卡片的图解形式、标题、关键文案、版式建议和生成提示词。' },
        { label: '改写成文案', text: '请把我上传的文件改写成适合社媒发布的文案。请保留核心信息，压缩冗余表达，强化开头钩子、读者收益、行动号召和平台语气，并给出 3 个标题备选。' },
    ],
    uploaded_image: [
        { label: '做电商套图', text: '请基于我上传的图片，设计一套电商套图。请先分析图片里的主体、卖点、适用人群和视觉风格，再输出主图、卖点图、场景图、对比图、细节图的画面方案、文案和生成提示词。' },
        { label: '做封面图', text: '请基于我上传的图片，设计一张适合社媒或内容封面的封面图。请给出封面定位、标题文案、构图方案、字体和色彩建议、需要保留/弱化的画面元素，以及可直接用于生成封面的提示词。' },
    ],
    empty_new_chat: REDCLAW_DEFAULT_COMPOSER_SHORTCUT_INPUTS,
    member_mention: [
        { label: '请TA提建议', text: '请这位成员以自己的专业视角，针对当前内容、方案或目标提出建议。请重点指出最值得优化的 3-5 个问题、原因、优先级和具体修改方向。' },
        { label: '请TA出方案', text: '请这位成员基于当前目标，给出一套可执行方案。请包含目标判断、核心策略、执行步骤、需要的素材或工具、风险点和验收标准。' },
        { label: '按风格重写', text: '请这位成员按自己的表达风格和专业判断，重写当前内容。请保留原始目标，优化结构、语气、重点和转化表达，并说明主要改动理由。' },
        { label: '请TA复盘', text: '请这位成员复盘当前内容或执行过程。请指出已经做对的地方、主要问题、根因判断、下一步动作，以及最应该立刻调整的一项。' },
    ],
    knowledge_context: [
        { label: '总结内容', text: '请结合我已附带的知识库内容，提炼核心观点、关键事实、可引用素材和适合后续创作的结论。请区分确定信息、推断信息和需要补充验证的信息。' },
        { label: '分析内容', text: '请结合我已附带的知识库内容，分析它的主题价值、目标受众、传播角度、内容结构、可复用素材和潜在风险，并给出下一步创作建议。' },
        { label: '分析封面', text: '请结合我已附带的知识库内容，分析适合它的封面方向。请输出封面主标题、视觉钩子、构图建议、色彩和字体风格、素材需求，以及 3 个封面方案。' },
        { label: '选题延展', text: '请结合我已附带的知识库内容，延展出一组可发布选题。请按选题标题、目标人群、核心卖点、内容角度、适合平台和优先级输出，并标出最推荐先做的 3 个。' },
    ],
};

function isImageShortcutAttachment(context: ChatShortcutContext): boolean {
    const attachment = context.attachment;
    if (!attachment) return false;
    const kind = String(attachment.kind || '').trim().toLowerCase();
    const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
    const name = String(
        attachment.name
        || attachment.localUrl
        || attachment.absolutePath
        || attachment.originalAbsolutePath
        || '',
    ).trim();
    return kind === 'image'
        || mimeType.startsWith('image/')
        || /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i.test(name);
}

export function resolveRedClawComposerShortcutScene(context: ChatShortcutContext): RedClawComposerShortcutScene {
    if (context.attachment) {
        return isImageShortcutAttachment(context) ? 'uploaded_image' : 'uploaded_file';
    }
    if (context.selectedMemberMention) return 'member_mention';
    if (context.selectedKnowledgeMentions.length > 0) return 'knowledge_context';
    return 'empty_new_chat';
}

export function createRedClawComposerShortcuts(
    inputs: RedClawComposerShortcutInput[] = REDCLAW_DEFAULT_COMPOSER_SHORTCUT_INPUTS,
): ChatShortcut[] {
    return inputs
        .map((item) => ({
            label: String(item.label || '').trim(),
            text: String(item.text || '').trim(),
            action: item.action || 'inject' as const,
        }))
        .filter((item) => item.label && item.text);
}

export function createRedClawComposerShortcutsForContext(context: ChatShortcutContext): ChatShortcut[] {
    const scene = resolveRedClawComposerShortcutScene(context);
    return createRedClawComposerShortcuts(REDCLAW_COMPOSER_SHORTCUT_INPUTS_BY_SCENE[scene]);
}

export const REDCLAW_SHORTCUTS = createRedClawComposerShortcuts();

export const REDCLAW_WELCOME_SHORTCUTS = REDCLAW_SHORTCUTS;

export const RUNNER_INTERVAL_OPTIONS = [10, 20, 30, 60];
export const RUNNER_MAX_AUTOMATION_OPTIONS = [1, 2, 3, 5];
export const HEARTBEAT_INTERVAL_OPTIONS = [15, 30, 60, 120];
export const REDCLAW_SIDEBAR_MIN_WIDTH = 300;
export const REDCLAW_SIDEBAR_MAX_WIDTH = 560;
export const REDCLAW_SIDEBAR_DEFAULT_WIDTH = 380;
export const REDCLAW_WELCOME_ICON_SRC = APP_BRAND.logoSrc;

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
