export type AuthoringPlatform = 'xiaohongshu' | 'wechat_official_account';
export type AuthoringTaskType = 'direct_write' | 'expand_from_xhs';
export type AuthoringSourceMode = 'manual' | 'knowledge' | 'manuscript';
export type AuthoringFormatTarget = 'markdown' | 'wechat_rich_text';

export interface AuthoringTaskHints {
    intent?: string;
    taskIntent?: string;
    forceMultiAgent?: boolean;
    forceLongRunningTask?: boolean;
    activeSkills?: string[];
    executionProfile?: 'artifact-authoring';
    artifactType?: 'manuscript';
    writeTarget?: 'manuscripts://current';
    requiredSkill?: string | string[];
    allowedTools?: string[];
    allowedAppCliActions?: string[];
    allowedOperateActions?: string[];
    allowedWriteTargets?: string[];
    requireSourceRead?: boolean;
    requireProfileRead?: boolean;
    requireSave?: boolean;
    requireTaskBrief?: boolean;
    requireSkillInvocations?: string[];
    taskBrief?: TaskBriefSeed;
    forbiddenFinalPhrases?: string[];
    teamAutoCreateConfirmed?: boolean;
    teamObjective?: string;
    deferredDiscovery?: boolean;
    teamEscalation?: 'disabled' | 'allowed';
    saveArtifact?: 'folder' | 'redpost' | 'redarticle';
    saveSubdir?: string;
    platform?: AuthoringPlatform;
    taskType?: AuthoringTaskType;
    formatTarget?: AuthoringFormatTarget;
    sourcePlatform?: AuthoringPlatform;
    sourceNoteId?: string;
    sourceMode?: AuthoringSourceMode;
    sourceTitle?: string;
    sourceManuscriptPath?: string;
}

export interface TaskBriefItem {
    id: string;
    text: string;
    status?: 'todo' | 'doing' | 'done' | 'blocked';
}

export interface TaskBriefContextItem {
    kind: 'constraint' | 'source' | 'finding' | 'decision' | 'risk' | 'validation';
    text: string;
}

export interface TaskBriefArticleStrategy {
    articleStyle: string;
    readerQuestion: string;
    corePromise: string;
    titleDirection: string;
    openingDirection: string;
    structureDirection: string;
    avoidDirection: string[];
}

export interface TaskBriefTitleCandidate {
    title: string;
    style: string;
    score: number;
    reason: string;
}

export interface TaskBriefSeed {
    taskType: string;
    goal: string;
    currentStage: string;
    todo: TaskBriefItem[];
    importantContext: TaskBriefContextItem[];
    articleStrategy?: TaskBriefArticleStrategy;
    titleCandidates?: TaskBriefTitleCandidate[];
    domain?: Record<string, unknown>;
}

interface BuildAuthoringMessageInput {
    platform: AuthoringPlatform;
    taskType: AuthoringTaskType;
    brief?: string;
    sourceMode?: AuthoringSourceMode;
    sourcePlatform?: AuthoringPlatform;
    sourceNoteId?: string;
    sourceTitle?: string;
    sourceManuscriptPath?: string;
    sourceContent?: string;
}

const PLATFORM_LABEL: Record<AuthoringPlatform, string> = {
    xiaohongshu: '小红书',
    wechat_official_account: '公众号',
};

const TASK_LABEL: Record<AuthoringTaskType, string> = {
    direct_write: '直接写稿',
    expand_from_xhs: '小红书扩写公众号',
};

export const AUTHORING_ALLOWED_TOOLS = ['redbox_fs', 'app_cli'];

export const AUTHORING_ALLOWED_APP_CLI_ACTIONS = [
    'image.generate',
    'memory.add',
    'memory.list',
    'memory.search',
    'manuscripts.createProject',
    'manuscripts.list',
    'manuscripts.writeCurrent',
    'redclaw.profile.bundle',
    'redclaw.profile.read',
    'skills.invoke',
    'skills.list',
    'subjects.get',
    'subjects.search',
];

export const AUTHORING_ALLOWED_OPERATE_ACTIONS = [
    'taskBrief.get',
    'taskBrief.update',
    'skills.invoke',
    'manuscripts.createProject',
    'redclaw.profile.read',
    'redclaw.profile.bundle',
];

export function buildTaskBriefPromptSection(seed: TaskBriefSeed) {
    return [
        '## 工作 Brief（长步骤任务状态）',
        '本任务必须维护一个结构化 Task Brief。它是后续阶段的唯一工作台，用来承接 todo、关键上下文、工具结果摘要、文章打法定向、标题决策、写作约束和最终校验。',
        '第一步先调用 `Operate(resource="taskBrief", operation="update", input={...})` 初始化 brief；每完成调研、文章打法定向、标题、正文自检等关键阶段后，再调用同一个操作更新 brief。',
        '后续标题和正文不能只依赖前文记忆，必须读取并沿用 brief 里的 `articleStrategy`、`importantContext`、`toolFindings`、`decisions`、`validationRequirements` 和领域字段。',
        '建议的初始 brief：',
        '```json',
        JSON.stringify(seed, null, 2),
        '```',
        '更新时使用这个结构：',
        '```json',
        JSON.stringify({
            stage: '<当前阶段>',
            status: 'in_progress | completed | blocked',
            brief: {
                currentStage: '<当前阶段>',
                todo: [{ id: 'research', text: '完成调研判断', status: 'done' }],
                done: [{ id: 'research', text: '调研判断已完成' }],
                importantContext: [{ kind: 'constraint', text: '正文禁止出现来源痕迹' }],
                toolFindings: [{ source: 'web.search', summary: '搜索得到的可用事实摘要' }],
                articleStrategy: {
                    articleStyle: '<商业解释型 | 反常识型 | 观点型 | 避坑型 | 清单型 | 故事型>',
                    readerQuestion: '<读者看到选题后最直接想问的问题>',
                    corePromise: '<这篇文章承诺帮读者解决什么理解问题>',
                    titleDirection: '<标题打法，如直接疑问 + 反常识>',
                    openingDirection: '<开头怎么兑现这个打法>',
                    structureDirection: '<正文结构怎么推进>',
                    avoidDirection: ['<不要采用的标题或正文打法>'],
                },
                titleCandidates: [
                    { title: '<候选标题>', style: '<直接疑问 | 反常识 | 悬念 | 数据冲击>', score: 0, reason: '<评分理由>' },
                ],
                decisions: [
                    { stage: 'strategy', summary: '为什么选择这个文章打法' },
                    { stage: 'title', summary: '最终标题选择理由' },
                ],
                validationRequirements: [{ id: 'no_source_trace', text: '正文不得出现原文/评论区等来源痕迹' }],
                domain: {
                    selectedTitle: '<最终标题>',
                    selectedTitleReason: '<为什么它比其它候选更贴近 articleStrategy 和 readerQuestion>',
                    mustUseFacts: [],
                },
            },
        }, null, 2),
        '```',
    ].join('\n');
}

const PLATFORM_SAVE_RULE: Record<AuthoringPlatform, string> = {
    xiaohongshu: '如需新建稿件工程，优先用 `app_cli(action="manuscripts.createProject", payload={ "kind": "redpost", "title": "<标题>" })` 获取规范工程路径。创建成功后，直接用 `app_cli(action="manuscripts.writeCurrent", payload={ "content": "<完整正文>" })` 保存，不要把标题直接当文件名，也不要重复传 path。正文只保留正常内容结构，不要插入控制字符、占位分隔线或额外格式标记。',
    wechat_official_account: '如需新建稿件工程，优先用 `app_cli(action="manuscripts.createProject", payload={ "kind": "redarticle", "title": "<标题>" })` 获取规范工程路径。创建成功后，直接用 `app_cli(action="manuscripts.writeCurrent", payload={ "content": "<完整正文>" })` 保存，不要把标题直接当文件名，也不要重复传 path。正文只保留正常内容结构，不要插入控制字符、占位分隔线或额外格式标记。',
};

export function buildRedClawAuthoringMessage(input: BuildAuthoringMessageInput) {
    const brief = String(input.brief || '').trim();
    const sourceTitle = String(input.sourceTitle || '').trim();
    const sourceContent = String(input.sourceContent || '').trim();
    const sourceBlocks: string[] = [];

    if (sourceTitle) {
        sourceBlocks.push(`来源标题：${sourceTitle}`);
    }
    if (input.sourceNoteId) {
        sourceBlocks.push(`来源ID：${input.sourceNoteId}`);
    }
    if (input.sourceManuscriptPath) {
        sourceBlocks.push(`来源稿件：${input.sourceManuscriptPath}`);
    }
    if (sourceContent) {
        sourceBlocks.push('来源内容：');
        sourceBlocks.push(sourceContent);
    }

    const content = [
        brief || `请为${PLATFORM_LABEL[input.platform]}启动一个新的创作任务。`,
        `保存规则：${PLATFORM_SAVE_RULE[input.platform]}`,
        sourceBlocks.length > 0 ? ['\n参考素材：', ...sourceBlocks].join('\n') : '',
    ].filter(Boolean).join('\n\n').trim();

    const displayContent = `${PLATFORM_LABEL[input.platform]} · ${TASK_LABEL[input.taskType]}${sourceTitle ? ` · ${sourceTitle}` : ''}`;

    return {
        content,
        displayContent,
        sessionRouting: 'new' as const,
        taskHints: {
            intent: 'manuscript_creation',
            executionProfile: 'artifact-authoring',
            artifactType: 'manuscript',
            writeTarget: 'manuscripts://current',
            requiredSkill: 'writing-style',
            activeSkills: ['writing-style'],
            allowedTools: AUTHORING_ALLOWED_TOOLS,
            allowedAppCliActions: AUTHORING_ALLOWED_APP_CLI_ACTIONS,
            allowedOperateActions: AUTHORING_ALLOWED_OPERATE_ACTIONS,
            allowedWriteTargets: ['manuscripts://current'],
            requireSourceRead: Boolean(input.sourceMode && input.sourceMode !== 'manual'),
            requireProfileRead: true,
            requireSave: true,
            deferredDiscovery: false,
            teamEscalation: 'disabled',
            saveArtifact: input.platform === 'xiaohongshu' ? 'redpost' : 'redarticle',
            platform: input.platform,
            taskType: input.taskType,
            formatTarget: 'markdown' as const,
            sourceMode: input.sourceMode,
            sourcePlatform: input.sourcePlatform,
            sourceNoteId: input.sourceNoteId,
            sourceTitle: sourceTitle || undefined,
            sourceManuscriptPath: input.sourceManuscriptPath,
        } satisfies AuthoringTaskHints,
    };
}
