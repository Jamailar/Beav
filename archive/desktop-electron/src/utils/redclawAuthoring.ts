export type AuthoringPlatform = 'xiaohongshu' | 'wechat_official_account';
export type AuthoringTaskType = 'direct_write' | 'expand_from_xhs';
export type AuthoringSourceMode = 'manual' | 'knowledge' | 'manuscript';
export type AuthoringFormatTarget = 'markdown' | 'wechat_rich_text';

export interface AuthoringTaskHints {
    intent?: string;
    forceMultiAgent?: boolean;
    forceLongRunningTask?: boolean;
    activeSkills?: string[];
    allowedTools?: string[];
    allowedAppCliActions?: string[];
    requireSourceRead?: boolean;
    requireProfileRead?: boolean;
    requireSave?: boolean;
    saveArtifact?: 'redpost' | 'redarticle';
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
        taskHints: {
            intent: 'manuscript_creation',
            allowedTools: AUTHORING_ALLOWED_TOOLS,
            allowedAppCliActions: AUTHORING_ALLOWED_APP_CLI_ACTIONS,
            requireSave: true,
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
