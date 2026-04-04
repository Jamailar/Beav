export type AuthoringPlatform = 'xiaohongshu' | 'wechat_official_account';
export type AuthoringTaskType = 'direct_write' | 'expand_from_xhs';
export type AuthoringSourceMode = 'manual' | 'knowledge' | 'manuscript';
export type AuthoringFormatTarget = 'markdown' | 'wechat_rich_text';

export interface AuthoringTaskHints {
    intent?: string;
    forceMultiAgent?: boolean;
    forceLongRunningTask?: boolean;
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
        sourceBlocks.length > 0 ? ['\n参考素材：', ...sourceBlocks].join('\n') : '',
    ].filter(Boolean).join('\n\n').trim();

    const displayContent = `${PLATFORM_LABEL[input.platform]} · ${TASK_LABEL[input.taskType]}${sourceTitle ? ` · ${sourceTitle}` : ''}`;

    return {
        content,
        displayContent,
        taskHints: {
            intent: 'manuscript_creation',
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
