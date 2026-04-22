/**
 * Built-in Tools - 内置工具导出
 */

// 导出所有内置工具
// 文件操作工具
export { WriteFileTool } from './writeFileTool';
export { EditTool } from './editTool';
export { ReadFileTool } from './readFileTool';
export { GrepTool } from './grepTool';
export { BashTool } from './bashTool';
export { AppCliTool } from './appCliTool';
export { WorkspaceTool } from './workspaceTool';
// 辅助工具
export { CalculatorTool } from './calculatorTool';
export { ListDirTool } from './listDirTool'; // Legacy list
export { ExploreWorkspaceTool } from './exploreWorkspaceTool';
export { SaveMemoryTool } from './memoryTool';
export { RedClawUpdateProfileDocTool, RedClawUpdateCreatorProfileTool } from './creatorProfileTool';
export {
    RedClawCreateProjectTool,
    RedClawSaveCopyPackTool,
    RedClawSaveImagePackTool,
    RedClawSaveRetrospectiveTool,
    RedClawListProjectsTool,
} from './redclawTool';
export { LspTool } from './lspTool';
export { TodoWriteTool, TodoReadTool } from './todoTool';
export { PlanModeEnterTool, PlanModeExitTool } from './planTool';
export { SkillTool, SkillManageTool, SkillInstallTool } from './skillTool';

// 导入工具类型
import { type ToolDefinition, type ToolResult, ToolKind } from '../toolRegistry';

// Legacy / Other tools imports
import { CalculatorTool } from './calculatorTool';
import { LspTool } from './lspTool';
import { PlanModeEnterTool, PlanModeExitTool } from './planTool';
import { SkillTool, SkillManageTool, SkillInstallTool } from './skillTool';
import { BashTool } from './bashTool';
import { AppCliTool } from './appCliTool';
import { WorkspaceTool } from './workspaceTool';
import {
    createBuiltinToolInstances,
    type BuiltinToolPack,
    listBuiltinToolDescriptors,
    registerBuiltinToolDescriptor,
} from './catalog';

let builtinToolsRegistered = false;

const ensureBuiltinToolDescriptorsRegistered = (): void => {
    if (builtinToolsRegistered) {
        return;
    }
    builtinToolsRegistered = true;

    const publicAllContexts: BuiltinToolPack[] = ['redclaw', 'knowledge', 'chatroom', 'diagnostics'];
    const developerOnlyContexts: BuiltinToolPack[] = ['diagnostics'];
    const register = (descriptor: Parameters<typeof registerBuiltinToolDescriptor>[0]) => {
        registerBuiltinToolDescriptor(descriptor);
    };

    registerBuiltinToolDescriptor({
        name: 'workspace',
        displayName: 'Workspace',
        description: 'Controlled workspace mutator for writing files and applying precise edits inside the current workspace.',
        kind: ToolKind.Other,
        contexts: publicAllContexts,
        visibility: 'public',
        requiresContext: null,
        preconditions: ['all paths must stay inside workspace', 'only write/edit actions are supported', 'write/edit actions may require confirmation'],
        successSignal: 'workspace action completed',
        failureSignal: 'workspace write/edit failed or unsupported action was blocked',
        artifactOutput: ['file'],
        retryPolicy: 'manual',
        create: ({ workspaceRootOverride }) => new WorkspaceTool(workspaceRootOverride),
    });
    register({
        name: 'bash',
        displayName: 'Bash Shell',
        description: 'Execute shell commands within the workspace directory only.',
        kind: ToolKind.Execute,
        contexts: publicAllContexts,
        visibility: 'public',
        requiresContext: null,
        preconditions: ['cwd must be inside workspace', 'dangerous commands may require confirmation'],
        successSignal: 'command completed',
        failureSignal: 'command blocked or failed',
        artifactOutput: ['command-output'],
        retryPolicy: 'manual',
        create: ({ workspaceRootOverride }) => new BashTool(workspaceRootOverride),
    });
    register({
        name: 'app_cli',
        displayName: 'App CLI',
        description: 'CLI-style app control layer for spaces, manuscripts, media, RedClaw and settings.',
        kind: ToolKind.Execute,
        contexts: ['redclaw', 'diagnostics'],
        visibility: 'public',
        requiresContext: null,
        preconditions: ['command must use supported namespace/action'],
        successSignal: 'structured app result returned',
        failureSignal: 'namespace/action invalid or command failed',
        artifactOutput: ['manuscript', 'image', 'project', 'config'],
        retryPolicy: 'manual',
        create: () => new AppCliTool(),
    });
    register({
        name: 'skill',
        displayName: 'Skill',
        description: 'Load a specialized skill into the current run.',
        kind: ToolKind.Other,
        contexts: publicAllContexts,
        visibility: 'public',
        requiresContext: null,
        create: ({ skillManager, onSkillActivated }) => (skillManager ? new SkillTool(skillManager, onSkillActivated) : null),
    });
    register({
        name: 'calculator',
        displayName: 'Calculator',
        description: 'Evaluate mathematical expressions.',
        kind: ToolKind.Other,
        contexts: ['diagnostics'],
        visibility: 'public',
        requiresContext: null,
        create: () => new CalculatorTool(),
    });
    register({
        name: 'lsp',
        displayName: 'LSP',
        description: 'Use language server features like symbol lookup or definitions.',
        kind: ToolKind.LSP,
        contexts: developerOnlyContexts,
        visibility: 'developer',
        requiresContext: null,
        create: () => new LspTool(),
    });
    register({
        name: 'plan_mode_enter',
        displayName: 'Plan Mode Enter',
        description: 'Enter plan mode for structured execution.',
        kind: ToolKind.Other,
        contexts: developerOnlyContexts,
        visibility: 'developer',
        requiresContext: null,
        create: () => new PlanModeEnterTool(),
    });
    register({
        name: 'plan_mode_exit',
        displayName: 'Plan Mode Exit',
        description: 'Exit plan mode and return to default execution.',
        kind: ToolKind.Other,
        contexts: developerOnlyContexts,
        visibility: 'developer',
        requiresContext: null,
        create: () => new PlanModeExitTool(),
    });
    register({
        name: 'skill_manage',
        displayName: 'Skill Manage',
        description: 'Manage installed skills and their lifecycle.',
        kind: ToolKind.Other,
        contexts: developerOnlyContexts,
        visibility: 'developer',
        requiresContext: 'chatService',
        create: ({ chatService }) => (chatService ? new SkillManageTool(chatService) : null),
    });
    register({
        name: 'skill_install',
        displayName: 'Skill Install',
        description: 'Install a skill into the current environment.',
        kind: ToolKind.Other,
        contexts: developerOnlyContexts,
        visibility: 'developer',
        requiresContext: 'chatService',
        create: ({ chatService }) => (chatService ? new SkillInstallTool(chatService) : null),
    });
};

/**
 * 创建所有内置工具实例
 * 注意：核心文件操作工具 (read, write, list 等) 现在由 ChatServiceV2 内部的 Vercel AI SDK 工具处理
 */
export function createBuiltinTools(options: {
    chatService?: any;
    skillManager?: any;
    onSkillActivated?: (payload: { name: string; description: string }) => void;
    workspaceRootOverride?: string;
    pack?: BuiltinToolPack;
} = {}): ToolDefinition<unknown, ToolResult>[] {
    ensureBuiltinToolDescriptorsRegistered();
    return createBuiltinToolInstances(options);
}

export function getRegisteredBuiltinTools() {
    ensureBuiltinToolDescriptorsRegistered();
    return listBuiltinToolDescriptors();
}

/**
 * 内置工具名称列表
 */
export const BUILTIN_TOOL_NAMES = [
    'workspace',
    'bash',
    'app_cli',
    'skill',
    'calculator',
    'lsp',
    'plan_mode_enter',
    'plan_mode_exit',
    'skill_manage',
    'skill_install',
] as const;

export type BuiltinToolName = typeof BUILTIN_TOOL_NAMES[number];
