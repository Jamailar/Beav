/**
 * List Directory Tool - 目录列表工具
 *
 * 参考 OpenCode 的 ls.ts 实现
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { Instance } from '../instance';
import { resolvePathInWorkspace } from './workspaceGuard';

const IGNORE_PATTERNS = [
    'node_modules',
    '__pycache__',
    '.git',
    'dist',
    'build',
    'target',
    'vendor',
    '.idea',
    '.vscode',
    '.DS_Store',
    '.cache',
    'cache',
    'logs',
    '.venv',
    'venv',
    'knowledge', // 忽略知识库文件夹，避免列出大量txt文件
];

const LIMIT = 100;

// 参考 OpenCode: path 是可选的，默认使用工作区根目录
const ListDirParamsSchema = z.object({
    path: z.string().describe('The absolute path to the directory to list (must be absolute, not relative). Omit to use workspace root.').optional(),
    ignore: z.array(z.string()).describe('List of glob patterns to ignore').optional(),
    recursive: z.boolean().describe('Whether to list files recursively. Default is false (only list top-level files/dirs). Set to true for full recursive scan (use carefully on large dirs).').optional(),
});

type ListDirParams = z.infer<typeof ListDirParamsSchema>;

/**
 * 目录列表工具
 */
export class ListDirTool extends DeclarativeTool<typeof ListDirParamsSchema> {
    readonly name = 'list_dir';
    readonly displayName = 'List Directory';
    readonly description = 'Lists files and directories in a given path. Defaults to listing only the top level (non-recursive). Set recursive=true to scan deeply. The path parameter must be absolute; omit it to use the current workspace directory.';
    readonly kind = ToolKind.Read;
    readonly parameterSchema = ListDirParamsSchema;
    readonly requiresConfirmation = false;

    constructor(private readonly workspaceRootOverride?: string) {
        super();
    }

    private getWorkspaceRoot(): string {
        return this.workspaceRootOverride || Instance.directory;
    }

    protected validateValues(params: ListDirParams): string | null {
        // 参考 OpenCode: path 是可选的，不需要验证
        return null;
    }

    getDescription(params: ListDirParams): string {
        return `List directory: ${params.path || this.getWorkspaceRoot()}`;
    }

    isConcurrencySafe(_params: ListDirParams): boolean {
        return true;
    }

    async execute(params: ListDirParams, signal: AbortSignal): Promise<ToolResult> {
        if (signal.aborted) {
            return createErrorResult('List cancelled', ToolErrorType.CANCELLED);
        }

        try {
            const workspaceRoot = this.getWorkspaceRoot();

            // 参考 OpenCode: 解析路径，支持相对路径和绝对路径
            let searchPath = params.path
                ? (path.isAbsolute(params.path) ? params.path : path.resolve(workspaceRoot, params.path))
                : workspaceRoot;

            // 规范化路径
            searchPath = path.normalize(searchPath);
            try {
                searchPath = resolvePathInWorkspace(searchPath, workspaceRoot);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return createErrorResult(message, ToolErrorType.PERMISSION_DENIED);
            }

            // 检查路径是否存在且是目录
            try {
                const stats = await fs.stat(searchPath);
                if (!stats.isDirectory()) {
                    return createErrorResult(
                        `Not a directory: ${searchPath}. Use read_file to read file contents.`,
                        ToolErrorType.INVALID_PARAMS
                    );
                }
            } catch (e) {
                return createErrorResult(`Directory not found: ${searchPath}`, ToolErrorType.FILE_NOT_FOUND);
            }

            // 构建忽略列表
            const ignoreSet = new Set([...IGNORE_PATTERNS, ...(params.ignore || [])]);
            
            // 递归读取目录结构
            const isRecursive = params.recursive === true;
            const { files, dirs } = await this.scanDirectory(searchPath, ignoreSet, LIMIT, isRecursive);

            // 构建树形输出（参考 OpenCode 格式）
            const output = this.buildTreeOutput(searchPath, files, dirs);

            const truncated = files.length >= LIMIT;
            let result = `${searchPath}/\n${output}`;

            if (truncated) {
                result += `\n\n(Results truncated at ${LIMIT} files. Use a more specific path.)`;
            }

            return createSuccessResult(
                result,
                `📁 Listed ${files.length} files in ${path.basename(searchPath) || 'root'}`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to list directory: ${message}`);
        }
    }

    private async scanDirectory(
        dirPath: string,
        ignoreSet: Set<string>,
        limit: number,
        isRecursive: boolean = false
    ): Promise<{ files: string[]; dirs: Set<string> }> {
        const files: string[] = [];
        const dirs = new Set<string>();

        const scan = async (currentPath: string, relativePath: string = '', depth: number = 0) => {
            if (files.length >= limit) return;

            try {
                const items = await fs.readdir(currentPath, { withFileTypes: true });

                for (const item of items) {
                    if (files.length >= limit) break;
                    if (ignoreSet.has(item.name)) continue;

                    const itemRelPath = relativePath ? `${relativePath}/${item.name}` : item.name;
                    const itemFullPath = path.join(currentPath, item.name);

                    if (item.isDirectory()) {
                        dirs.add(itemRelPath);
                        if (isRecursive) {
                            await scan(itemFullPath, itemRelPath, depth + 1);
                        }
                    } else {
                        files.push(itemRelPath);
                    }
                }
            } catch (e) {
                // 忽略无法访问的目录
            }
        };

        await scan(dirPath, '', 0);
        return { files, dirs };
    }

    private buildTreeOutput(basePath: string, files: string[], dirs: Set<string>): string {
        // 按目录分组文件
        const filesByDir = new Map<string, string[]>();

        for (const file of files) {
            const dir = path.dirname(file);
            const dirKey = dir === '.' ? '' : dir;
            if (!filesByDir.has(dirKey)) {
                filesByDir.set(dirKey, []);
            }
            filesByDir.get(dirKey)!.push(path.basename(file));
        }

        // 构建树形结构
        const lines: string[] = [];

        const renderDir = (dirPath: string, depth: number) => {
            const indent = '  '.repeat(depth);

            if (dirPath) {
                lines.push(`${indent}${path.basename(dirPath)}/`);
            }

            // 渲染子目录
            const childDirs = Array.from(dirs)
                .filter(d => {
                    const parent = path.dirname(d);
                    return (parent === '.' ? '' : parent) === dirPath && d !== dirPath;
                })
                .sort();

            for (const childDir of childDirs) {
                renderDir(childDir, depth + 1);
            }

            // 渲染文件
            const dirFiles = filesByDir.get(dirPath) || [];
            for (const file of dirFiles.sort()) {
                lines.push(`${'  '.repeat(depth + 1)}${file}`);
            }
        };

        renderDir('', 0);

        return lines.join('\n');
    }
}
