/**
 * Write File Tool - 文件写入工具
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    type ToolConfirmationDetails,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { Instance } from '../instance';
import { resolvePathInWorkspace } from './workspaceGuard';

// 参数 Schema
const WriteFileParamsSchema = z.object({
    path: z.string().describe('Absolute path to the file to write. For manuscripts, use the manuscripts directory path.'),
    content: z.string().describe('The content to write to the file'),
    overwrite: z.boolean().default(true).describe('Whether to overwrite existing file (default: true)'),
    createDirectories: z.boolean().default(true).describe('Create parent directories if needed (default: true)'),
});

type WriteFileParams = z.output<typeof WriteFileParamsSchema>;

/**
 * 文件写入工具
 */
export class WriteFileTool extends DeclarativeTool<typeof WriteFileParamsSchema> {
    readonly name = 'write_file';
    readonly displayName = 'Write File';
    readonly description = 'Write content to a file. Creates the file if it does not exist. Use this to create new manuscripts/articles or update existing files. For new articles, write to the manuscripts directory.';
    readonly kind = ToolKind.Edit;
    readonly parameterSchema = WriteFileParamsSchema;
    readonly requiresConfirmation = false; // 不需要确认，让AI可以直接创建文件

    constructor(private readonly workspaceRootOverride?: string) {
        super();
    }

    private getWorkspaceRoot(): string {
        return this.workspaceRootOverride || Instance.directory;
    }

    protected validateValues(params: WriteFileParams): string | null {
        // 允许相对路径，会自动解析
        return null;
    }

    getDescription(params: WriteFileParams): string {
        const action = params.overwrite ? 'Write' : 'Create';
        const contentLength = params.content?.length ?? 0;
        return `${action} file: ${params.path || '(no path)'} (${contentLength} characters)`;
    }

    getConfirmationDetails(params: WriteFileParams): ToolConfirmationDetails | null {
        // 不需要确认
        return null;
    }

    async execute(params: WriteFileParams, signal: AbortSignal): Promise<ToolResult> {
        if (signal.aborted) {
            return createErrorResult('Write cancelled', ToolErrorType.CANCELLED);
        }

        // 参数验证
        if (!params.path) {
            return createErrorResult('Missing required parameter: path', ToolErrorType.INVALID_PARAMS);
        }
        if (params.content === undefined || params.content === null) {
            return createErrorResult('Missing required parameter: content', ToolErrorType.INVALID_PARAMS);
        }

        try {
            let filePath = params.path;
            try {
                filePath = resolvePathInWorkspace(filePath, this.getWorkspaceRoot());
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return createErrorResult(message, ToolErrorType.PERMISSION_DENIED);
            }

            // 检查文件是否已存在
            let fileExists = false;
            try {
                await fs.access(filePath);
                fileExists = true;
            } catch {
                fileExists = false;
            }

            // 默认允许覆盖
            const overwrite = params.overwrite !== false;

            if (fileExists && !overwrite) {
                return createErrorResult(
                    `File already exists: ${filePath}. Set overwrite=true to replace it.`,
                    ToolErrorType.INVALID_PARAMS
                );
            }

            // 创建父目录（默认开启）
            const createDirs = params.createDirectories !== false;
            if (createDirs) {
                await fs.mkdir(path.dirname(filePath), { recursive: true });
            }

            // 写入文件
            await fs.writeFile(filePath, params.content, 'utf-8');

            const fileName = path.basename(filePath);
            const action = fileExists ? 'Updated' : 'Created';

            return createSuccessResult(
                `${action} file: ${filePath}\nWritten ${params.content.length} characters.`,
                `✅ ${action} ${fileName}`
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EACCES') {
                return createErrorResult(`Permission denied: ${params.path}`, ToolErrorType.PERMISSION_DENIED);
            }
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to write file: ${message}`);
        }
    }
}
