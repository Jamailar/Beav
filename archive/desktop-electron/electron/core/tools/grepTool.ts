import { z } from 'zod';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { Instance } from '../instance';
import { which } from '../util/which';
import { resolvePathInWorkspace } from './workspaceGuard';

const GrepToolParamsSchema = z.object({
    pattern: z.string().describe("The regex pattern to search for"),
    path: z.string().optional().describe("Directory to search in (default: workspace root)"),
    include: z.string().optional().describe("Glob pattern to include (e.g. '*.ts')"),
});

type GrepToolParams = z.infer<typeof GrepToolParamsSchema>;

export class GrepTool extends DeclarativeTool<typeof GrepToolParamsSchema> {
    readonly name = 'grep';
    readonly displayName = 'Grep Search';
    readonly description = 'Search for patterns in files using ripgrep (rg) if available, or grep fallback. Efficient for code search. The path parameter should be absolute or relative to the workspace root.';
    readonly kind = ToolKind.Read;
    readonly parameterSchema = GrepToolParamsSchema;
    readonly requiresConfirmation = false;

    private rgPath: string | undefined;

    constructor(private readonly workspaceRootOverride?: string) {
        super();
    }

    private getWorkspaceRoot(): string {
        return this.workspaceRootOverride || Instance.directory;
    }

    protected validateValues(params: GrepToolParams): string | null {
        if (!params.pattern || params.pattern.trim() === '') {
            return 'pattern is required. Provide a search keyword like "Dan Koe" or regex pattern.';
        }
        return null;
    }

    getDescription(params: GrepToolParams): string {
        return `Grep "${params.pattern}" in ${params.path || '.'}`;
    }

    isConcurrencySafe(_params: GrepToolParams): boolean {
        return true;
    }

    async execute(params: GrepToolParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            if (!this.rgPath) {
                this.rgPath = await which('rg');
            }

            let searchDir = params.path 
                ? (path.isAbsolute(params.path) ? params.path : path.join(this.getWorkspaceRoot(), params.path))
                : this.getWorkspaceRoot();

            try {
                searchDir = resolvePathInWorkspace(searchDir, this.getWorkspaceRoot());
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return createErrorResult(message, ToolErrorType.PERMISSION_DENIED);
            }

            let cmd = 'grep';
            let args: string[] = [];

            if (this.rgPath) {
                cmd = this.rgPath;
                args = [
                    '--line-number',
                    '--with-filename',
                    '--no-heading',
                    '--color=never',
                    '--hidden',
                    '--smart-case',
                    '-e', params.pattern,
                ];
                if (params.include) {
                    args.push('--glob', params.include);
                }
                args.push(searchDir);
            } else {
                // Fallback to standard grep (recursive)
                // Note: grep arguments differ slightly across OS, assuming standard unix grep here
                args = ['-rnH', params.pattern];
                if (params.include) {
                    args.push('--include', params.include);
                }
                args.push(searchDir);
            }

            return new Promise((resolve) => {
                const child = spawn(cmd, args, { cwd: searchDir });
                
                let stdout = '';
                let stderr = '';

                child.stdout.on('data', d => stdout += d.toString());
                child.stderr.on('data', d => stderr += d.toString());

                child.on('close', (code) => {
                    // rg returns 1 if no matches found, which is not an error for us
                    if (code === 0 || (this.rgPath && code === 1)) {
                         const matches = stdout.trim();
                         if (!matches) {
                             resolve(createSuccessResult("No matches found.", "0 matches"));
                             return;
                         }
                         
                         const lines = matches.split('\n');
                         const limit = 100;
                         const truncated = lines.length > limit;
                         const output = truncated ? lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more matches)` : matches;
                         
                         resolve(createSuccessResult(output, `Found ${lines.length} matches`));
                    } else {
                        resolve(createErrorResult(`Grep failed: ${stderr}`, ToolErrorType.EXECUTION_FAILED));
                    }
                });
                
                child.on('error', (err) => {
                     resolve(createErrorResult(`Failed to spawn grep: ${err.message}`, ToolErrorType.EXECUTION_FAILED));
                });
            });

        } catch (error) {
             const message = error instanceof Error ? error.message : String(error);
             return createErrorResult(`Grep error: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}
