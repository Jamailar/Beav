import { z } from 'zod';
import {
    DeclarativeTool,
    ToolKind,
    type ToolConfirmationDetails,
    type ToolResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { EditTool } from './editTool';
import { WriteFileTool } from './writeFileTool';

const WorkspaceToolParamsSchema = z.object({
    action: z.enum(['list', 'read', 'search', 'write', 'edit']).describe('Workspace action to perform. Only write/edit remain supported; read/list/search should use bash or app_cli instead.'),
    path: z.string().optional().describe('Path for list or search actions'),
    filePath: z.string().optional().describe('Target file path for read, write, or edit actions'),
    offset: z.coerce.number().optional().describe('Read offset (0-based line number)'),
    limit: z.coerce.number().optional().describe('Read limit (line count)'),
    recursive: z.boolean().optional().describe('Whether to scan directories recursively for list action'),
    ignore: z.array(z.string()).optional().describe('Ignore patterns for list action'),
    pattern: z.string().optional().describe('Search pattern for search action'),
    include: z.string().optional().describe('Glob include filter for search action'),
    content: z.string().optional().describe('Content for write action'),
    overwrite: z.boolean().optional().describe('Whether write action may overwrite existing file'),
    createDirectories: z.boolean().optional().describe('Whether write action should create parent directories'),
    oldString: z.string().optional().describe('String to replace for edit action'),
    newString: z.string().optional().describe('Replacement string for edit action'),
    replaceAll: z.boolean().optional().describe('Whether edit action should replace all matches'),
});

type WorkspaceToolParams = z.infer<typeof WorkspaceToolParamsSchema>;

export class WorkspaceTool extends DeclarativeTool<typeof WorkspaceToolParamsSchema> {
    readonly name = 'workspace';
    readonly displayName = 'Workspace';
    readonly description = 'Controlled workspace mutator for writing files and applying precise edits inside the current workspace. Use bash/app_cli for reading, listing, or searching.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = WorkspaceToolParamsSchema;
    readonly requiresConfirmation = false;

    private readonly writeTool: WriteFileTool;
    private readonly editTool: EditTool;

    constructor(workspaceRootOverride?: string) {
        super();
        this.writeTool = new WriteFileTool(workspaceRootOverride);
        this.editTool = new EditTool(workspaceRootOverride);
    }

    protected validateValues(params: WorkspaceToolParams): string | null {
        switch (params.action) {
            case 'list':
                return 'workspace action=list has been removed; use bash (ls/find) or app_cli instead';
            case 'read':
                return 'workspace action=read has been removed; use bash (cat/sed/head) or app_cli instead';
            case 'search':
                return 'workspace action=search has been removed; use bash (rg/grep/find) or app_cli instead';
            case 'write':
                if (!params.filePath) return 'filePath is required for action=write';
                if (params.content === undefined) return 'content is required for action=write';
                return null;
            case 'edit':
                if (!params.filePath) return 'filePath is required for action=edit';
                if (params.oldString === undefined) return 'oldString is required for action=edit';
                if (params.newString === undefined) return 'newString is required for action=edit';
                if (params.oldString === params.newString) return 'oldString and newString must be different';
                return null;
            default:
                return 'unsupported workspace action';
        }
    }

    getDescription(params: WorkspaceToolParams): string {
        switch (params.action) {
            case 'list':
                return `Workspace list (unsupported): ${params.path || '.'}`;
            case 'read':
                return `Workspace read (unsupported): ${params.filePath || '(missing filePath)'}`;
            case 'search':
                return `Workspace search (unsupported): ${params.pattern || '(missing pattern)'} in ${params.path || '.'}`;
            case 'write':
                return `Workspace write: ${params.filePath || '(missing filePath)'}`;
            case 'edit':
                return `Workspace edit: ${params.filePath || '(missing filePath)'}`;
            default:
                return 'Workspace action';
        }
    }

    getConfirmationDetails(params: WorkspaceToolParams): ToolConfirmationDetails | null {
        if (params.action === 'write') {
            return {
                type: 'edit',
                title: '确认写入文件',
                description: `写入文件：${params.filePath || '(unknown file)'}`,
                impact: '此操作会创建或覆盖工作区内文件。',
            };
        }
        if (params.action === 'edit') {
            return {
                type: 'edit',
                title: '确认修改文件',
                description: `修改文件：${params.filePath || '(unknown file)'}`,
                impact: '此操作会对工作区内已有文件做精确替换。',
            };
        }
        return null;
    }

    isConcurrencySafe(params: WorkspaceToolParams): boolean {
        return false;
    }

    async execute(params: WorkspaceToolParams, signal: AbortSignal, _onOutput?: (chunk: string) => void): Promise<ToolResult> {
        switch (params.action) {
            case 'list':
                return createErrorResult(
                    'workspace action=list is no longer supported; use bash (ls/find) or app_cli instead',
                    ToolErrorType.INVALID_PARAMS,
                );
            case 'read':
                return createErrorResult(
                    'workspace action=read is no longer supported; use bash (cat/sed/head) or app_cli instead',
                    ToolErrorType.INVALID_PARAMS,
                );
            case 'search':
                return createErrorResult(
                    'workspace action=search is no longer supported; use bash (rg/grep/find) or app_cli instead',
                    ToolErrorType.INVALID_PARAMS,
                );
            case 'write':
                return this.writeTool.execute(
                    {
                        path: params.filePath || '',
                        content: params.content || '',
                        overwrite: params.overwrite ?? true,
                        createDirectories: params.createDirectories ?? true,
                    },
                    signal,
                );
            case 'edit':
                return this.editTool.execute(
                    {
                        filePath: params.filePath || '',
                        oldString: params.oldString || '',
                        newString: params.newString || '',
                        replaceAll: params.replaceAll,
                    },
                    signal,
                );
            default:
                return createErrorResult('Unsupported workspace action', ToolErrorType.INVALID_PARAMS);
        }
    }
}
