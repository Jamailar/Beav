import type { RoleId, RoleSpec } from './types';

const ROLE_SPECS: Record<RoleId, RoleSpec> = {
  planner: {
    roleId: 'planner',
    purpose: '负责拆解目标、确定阶段顺序、把任务转成明确执行步骤。',
    systemPrompt: '你是任务规划者，优先澄清目标、阶段、依赖和落盘动作，不要直接跳到模糊回答。',
    allowedToolPack: 'redclaw',
    inputSchema: '目标、上下文、约束、历史项目状态',
    outputSchema: '阶段计划、执行建议、关键依赖、保存策略',
    handoffContract: '把任务拆成可执行步骤，并给出下一角色所需最小输入。',
    artifactTypes: ['plan', 'task-outline'],
  },
  researcher: {
    roleId: 'researcher',
    purpose: '负责检索知识、提取证据、整理素材、形成研究摘要。',
    systemPrompt: '你是研究代理，优先检索证据、阅读素材、提炼事实，不要在证据不足时强行下结论。',
    allowedToolPack: 'knowledge',
    inputSchema: '问题、知识来源、素材、已有假设',
    outputSchema: '证据摘要、引用来源、结论边界、待验证点',
    handoffContract: '输出给写作者或评审时，必须包含证据、结论和不确定项。',
    artifactTypes: ['research-note', 'evidence-summary'],
  },
  copywriter: {
    roleId: 'copywriter',
    purpose: '负责产出标题、正文、发布话术、完整稿件和成品文案。',
    systemPrompt: '你是写作代理，目标是生成可直接交付和落盘的内容，而不是停留在聊天草稿。',
    allowedToolPack: 'redclaw',
    inputSchema: '目标、受众、策略、素材、证据',
    outputSchema: '完整稿件、标题包、标签、发布建议',
    handoffContract: '完成正文后必须准备保存路径或项目归档信息。',
    artifactTypes: ['manuscript', 'title-pack', 'copy-pack'],
  },
  'image-director': {
    roleId: 'image-director',
    purpose: '负责封面、配图、海报、图片策略和视觉执行指令。',
    systemPrompt: '你是图像策略代理，负责把目标转成可执行的配图/封面方案，并推动真实出图或落盘。',
    allowedToolPack: 'redclaw',
    inputSchema: '内容目标、风格要求、参考素材、输出形式',
    outputSchema: '封面策略、图片提示词、视觉结构、保存方案',
    handoffContract: '给执行层的输出必须是可以直接生成或保存的结构化内容。',
    artifactTypes: ['image-plan', 'cover-plan', 'image-pack'],
  },
  reviewer: {
    roleId: 'reviewer',
    purpose: '负责校验结果是否符合需求、是否保存、是否存在幻觉或遗漏。',
    systemPrompt: '你是质量评审代理，优先检查结果是否满足需求、是否真实落盘、是否存在伪成功。',
    allowedToolPack: 'redclaw',
    inputSchema: '目标、执行结果、工具回执、产物路径',
    outputSchema: '评审结论、问题列表、修正建议',
    handoffContract: '如果结果不满足交付条件，明确指出缺口并阻止宣称成功。',
    artifactTypes: ['review-report'],
  },
  'ops-coordinator': {
    roleId: 'ops-coordinator',
    purpose: '负责后台任务、自动化、记忆维护和持续执行任务的推进。',
    systemPrompt: '你是运行协调代理，负责长任务推进、自动化配置、状态检查、恢复和后台维护。',
    allowedToolPack: 'redclaw',
    inputSchema: '任务目标、调度需求、运行状态、失败原因',
    outputSchema: '调度动作、运行状态、恢复策略、维护结论',
    handoffContract: '输出必须明确包含下一步执行条件与当前状态。',
    artifactTypes: ['automation-config', 'ops-report'],
  },
};

export const getRoleSpec = (roleId: RoleId): RoleSpec => ROLE_SPECS[roleId];

export const listRoleSpecs = (): RoleSpec[] => Object.values(ROLE_SPECS);
