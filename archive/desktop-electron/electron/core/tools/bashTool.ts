import { z } from 'zod';
import * as path from 'path';
import { spawn } from 'child_process';
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
import { isPathInWorkspace, resolvePathInWorkspace } from './workspaceGuard';

const BashToolParamsSchema = z.object({
    command: z.string().describe("The shell command to execute"),
    workdir: z.string().optional().describe("The working directory to run the command in (must be within workspace)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
});

type BashToolParams = z.infer<typeof BashToolParamsSchema>;

// 危险命令模式 - 需要用户确认
const DANGEROUS_PATTERNS = [
    /\brm\b/,                    // rm 命令
    /\brmdir\b/,                 // rmdir 命令
    /\bdel\b/,                   // Windows del
    /\bunlink\b/,                // unlink
    /\btrash\b/,                 // trash
    /\bshred\b/,                 // shred
    />\s*\/dev\/null/,           // 重定向到 /dev/null
    /\bmv\b.*\s+\/dev\/null/,    // 移动到 /dev/null
    /\bkill\b/,                  // kill 进程
    /\bkillall\b/,               // killall
    /\bpkill\b/,                 // pkill
    /\bchmod\b/,                 // 修改权限
    /\bchown\b/,                 // 修改所有者
    /\bsudo\b/,                  // sudo
    /\bsu\b\s/,                  // su
    /\bdrop\s+database\b/i,      // SQL drop database
    /\bdrop\s+table\b/i,         // SQL drop table
    /\btruncate\b/i,             // truncate
    /\bgit\s+push\s+.*--force/,  // force push
    /\bgit\s+reset\s+--hard/,    // hard reset
    /\bgit\s+clean\s+-fd/,       // git clean
];

// 绝对禁止的命令模式
const FORBIDDEN_PATTERNS = [
    /rm\s+(-[rf]+\s+)*\//,       // rm -rf / 或类似
    /rm\s+(-[rf]+\s+)*~\//,      // rm -rf ~/
    /:.*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,  // fork bomb
    /mkfs\./,                    // 格式化磁盘
    /dd\s+.*of=\/dev\//,         // dd 写入设备
    />\s*\/etc\//,               // 写入系统配置
    /curl.*\|\s*sh/,             // curl | sh
    /wget.*\|\s*sh/,             // wget | sh
];

/**
 * 检查路径是否在工作区内
 */
function isPathWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
    return isPathInWorkspace(targetPath, workspaceRoot);
}

/**
 * 检查命令是否包含危险模式
 */
function isDangerousCommand(command: string): boolean {
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * 检查命令是否被禁止
 */
function isForbiddenCommand(command: string): boolean {
    return FORBIDDEN_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * 检查命令中是否有尝试访问工作区外的路径
 */
function hasPathOutsideWorkspace(command: string, workspaceRoot: string): boolean {
    // 检查绝对路径
    const absolutePathPattern = /(?:^|\s)(\/[^\s]+)/g;
    let match;
    while ((match = absolutePathPattern.exec(command)) !== null) {
        const foundPath = match[1];
        // 允许常见的系统命令路径
        const allowedPrefixes = ['/usr/bin/', '/usr/local/bin/', '/bin/', '/opt/homebrew/bin/'];
        if (allowedPrefixes.some(prefix => foundPath.startsWith(prefix))) {
            continue;
        }
        // 检查是否在工作区内
        if (!isPathWithinWorkspace(foundPath, workspaceRoot)) {
            return true;
        }
    }

    // 检查 cd 命令后的路径
    const cdPattern = /cd\s+([^\s;&|]+)/g;
    while ((match = cdPattern.exec(command)) !== null) {
        const cdPath = match[1];
        if (cdPath.startsWith('/') && !isPathWithinWorkspace(cdPath, workspaceRoot)) {
            return true;
        }
        if (cdPath === '~' || cdPath.startsWith('~/') || cdPath === '..') {
            // 需要进一步检查
            const resolvedCd = cdPath === '~' ? process.env.HOME || '/' :
                              cdPath.startsWith('~/') ? path.join(process.env.HOME || '/', cdPath.slice(2)) :
                              path.resolve(workspaceRoot, cdPath);
            if (!isPathWithinWorkspace(resolvedCd, workspaceRoot)) {
                return true;
            }
        }
    }

    // 检查相对路径越界（例如 ../foo、../../bar、~/x）
    const shellPathTokenPattern = /(?:^|[\s;|&()])((?:\.\.?\/|~\/)[^\s;|&()]*)/g;
    while ((match = shellPathTokenPattern.exec(command)) !== null) {
        const token = match[1];
        const resolvedToken = token.startsWith('~/')
            ? path.join(workspaceRoot, token.slice(2))
            : path.resolve(workspaceRoot, token);
        if (!isPathWithinWorkspace(resolvedToken, workspaceRoot)) {
            return true;
        }
    }

    return false;
}

export class BashTool extends DeclarativeTool<typeof BashToolParamsSchema> {
    readonly name = 'bash';
    readonly displayName = 'Bash Shell';
    readonly description = 'Execute shell commands within the workspace directory only. Dangerous commands (rm, chmod, etc.) require user confirmation. The working directory is limited to the workspace.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = BashToolParamsSchema;
    readonly requiresConfirmation = false; // 动态决定是否需要确认

    constructor(private readonly workspaceRootOverride?: string) {
        super();
    }

    private getWorkspaceRoot(): string {
        return this.workspaceRootOverride || Instance.directory;
    }

    protected validateValues(params: BashToolParams): string | null {
        const workspaceRoot = this.getWorkspaceRoot();

        // 1. 检查绝对禁止的命令
        if (isForbiddenCommand(params.command)) {
            return "❌ 此命令包含危险操作，已被禁止执行。";
        }

        // 2. 检查 workdir 是否在工作区内
        if (params.workdir) {
            try {
                resolvePathInWorkspace(params.workdir, workspaceRoot);
            } catch {
                return `❌ 工作目录必须在工作区内。工作区: ${workspaceRoot}`;
            }
        }

        // 3. 检查命令中是否有访问工作区外路径的尝试
        if (hasPathOutsideWorkspace(params.command, workspaceRoot)) {
            return `❌ 命令中包含工作区外的路径。只能在工作区内操作: ${workspaceRoot}`;
        }

        return null;
    }

    /**
     * 动态判断是否需要确认
     */
    needsConfirmation(params: BashToolParams): boolean {
        return isDangerousCommand(params.command);
    }

    /**
     * 获取确认详情
     */
    getConfirmationDetails(params: BashToolParams): ToolConfirmationDetails | null {
        if (!isDangerousCommand(params.command)) {
            return null;
        }

        return {
            type: 'exec',
            title: '危险命令确认',
            description: `此命令可能包含危险操作：\n\n\`${params.command}\``,
            impact: '此命令可能会删除文件或修改系统设置',
        };
    }

    getDescription(params: BashToolParams): string {
        const isDangerous = isDangerousCommand(params.command);
        const prefix = isDangerous ? '⚠️ [需确认] ' : '';
        return `${prefix}Run command: ${params.command}`;
    }

    async execute(params: BashToolParams, signal: AbortSignal): Promise<ToolResult> {
        const workspaceRoot = this.getWorkspaceRoot();

        // 再次验证（防御性编程）
        const validationError = this.validateValues(params);
        if (validationError) {
            return createErrorResult(validationError, ToolErrorType.INVALID_PARAMS);
        }

        return new Promise((resolve) => {
            // 强制 cwd 在工作区内
            let cwd: string;
            if (params.workdir) {
                try {
                    cwd = resolvePathInWorkspace(params.workdir, workspaceRoot);
                } catch {
                    resolve(createErrorResult(`工作目录必须在工作区内: ${workspaceRoot}`, ToolErrorType.PERMISSION_DENIED));
                    return;
                }
            } else {
                cwd = workspaceRoot;
            }

            // 确保 cwd 在工作区内
            if (!isPathWithinWorkspace(cwd, workspaceRoot)) {
                resolve(createErrorResult(`工作目录必须在工作区内: ${workspaceRoot}`, ToolErrorType.PERMISSION_DENIED));
                return;
            }

            const timeout = params.timeout ?? 120000;
            const shellHome = workspaceRoot;
            const shellEnv: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: shellHome,
            };

            if (process.platform === 'win32') {
                shellEnv.USERPROFILE = shellHome;
                const parsedRoot = path.parse(shellHome);
                if (parsedRoot.root) {
                    shellEnv.HOMEDRIVE = parsedRoot.root.replace(/[\\/]+$/, '');
                    shellEnv.HOMEPATH = shellHome.slice(parsedRoot.root.length) || '\\';
                }
            }

            const child = spawn(params.command, {
                cwd,
                shell: true,
                timeout,
                env: shellEnv,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (err) => {
                resolve(createErrorResult(`Execution failed: ${err.message}`, ToolErrorType.EXECUTION_FAILED));
            });

            child.on('close', (code) => {
                if (code === 0) {
                    const output = stdout + (stderr ? `\nStderr:\n${stderr}` : '');
                    // Truncate output if too long
                    const MAX_OUTPUT = 30000;
                    const truncated = output.length > MAX_OUTPUT ? output.substring(0, MAX_OUTPUT) + "\n... (truncated)" : output;
                    resolve(createSuccessResult(truncated, `> ${params.command}`));
                } else {
                    resolve(createErrorResult(`Command failed with exit code ${code}\nStderr: ${stderr}\nStdout: ${stdout}`, ToolErrorType.EXECUTION_FAILED));
                }
            });

            signal.addEventListener('abort', () => {
                child.kill();
                resolve(createErrorResult('Command aborted', ToolErrorType.CANCELLED));
            });
        });
    }
}
