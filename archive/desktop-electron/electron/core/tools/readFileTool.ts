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
import { Filesystem } from '../util/filesystem';
import { LSP } from '../lsp';
import { resolvePathInWorkspace } from './workspaceGuard';

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

const ReadFileParamsSchema = z.object({
    filePath: z.string().describe('The path to the file to read (absolute or relative to workspace)'),
    offset: z.coerce.number().describe('The line number to start reading from (0-based). Default 0.').optional(),
    limit: z.coerce.number().describe('The number of lines to read. Default 2000.').optional(),
});

type ReadFileParams = z.infer<typeof ReadFileParamsSchema>;

export class ReadFileTool extends DeclarativeTool<typeof ReadFileParamsSchema> {
    readonly name = 'read_file';
    readonly displayName = 'Read File';
    readonly description = 'Read the contents of a file. Handles large files by reading in chunks (pagination) and detects binary files. You must provide the file path as absolute or relative to the workspace root.';
    readonly kind = ToolKind.Read;
    readonly parameterSchema = ReadFileParamsSchema;
    readonly requiresConfirmation = false;

    constructor(private readonly workspaceRootOverride?: string) {
        super();
    }

    private getWorkspaceRoot(): string {
        return this.workspaceRootOverride || Instance.directory;
    }

    protected validateValues(params: ReadFileParams): string | null {
        return null;
    }

    getDescription(params: ReadFileParams): string {
        const range = params.offset ? ` (offset ${params.offset})` : '';
        return `Read file: ${params.filePath}${range}`;
    }

    isConcurrencySafe(_params: ReadFileParams): boolean {
        return true;
    }

    async execute(params: ReadFileParams, signal: AbortSignal): Promise<ToolResult> {
        if (signal.aborted) {
            return createErrorResult('Read cancelled', ToolErrorType.CANCELLED);
        }

        try {
            let filepath = params.filePath;
            try {
                filepath = resolvePathInWorkspace(filepath, this.getWorkspaceRoot());
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return createErrorResult(message, ToolErrorType.PERMISSION_DENIED);
            }

            if (!(await Filesystem.exists(filepath))) {
                 return createErrorResult(`File not found: ${filepath}`, ToolErrorType.FILE_NOT_FOUND);
            }
            
            const stats = await fs.stat(filepath);
            if (stats.isDirectory()) {
                return createErrorResult(`Path is a directory: ${filepath}. Use list_dir instead.`, ToolErrorType.INVALID_PARAMS);
            }

            // Binary check
            const isBinary = await this.isBinaryFile(filepath, stats.size);
            if (isBinary) {
                return createErrorResult(`Cannot read binary file: ${filepath}`, ToolErrorType.EXECUTION_FAILED);
            }

            const limit = params.limit ?? DEFAULT_READ_LIMIT;
            const offset = params.offset || 0;
            
            // Note: For very large files, we should use streams or read specific bytes.
            // For simplicity and matching opencode logic which reads full text then splits (which assumes memory is enough for text files):
            // We'll stick to fs.readFile for now but be aware of memory limits.
            // If file is > 10MB, maybe warn?
            if (stats.size > 10 * 1024 * 1024) {
                 return createErrorResult(`File is too large (${(stats.size/1024/1024).toFixed(2)}MB) to read fully in memory. Please use grep or other tools.`, ToolErrorType.EXECUTION_FAILED);
            }

            const content = await fs.readFile(filepath, 'utf-8');
            const lines = content.split('\n');

            const raw: string[] = [];
            let bytes = 0;
            let truncatedByBytes = false;

            for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
                const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i];
                const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0); // +1 for newline
                if (bytes + size > MAX_BYTES) {
                    truncatedByBytes = true;
                    break;
                }
                raw.push(line);
                bytes += size;
            }

            const numberedContent = raw.map((line, index) => {
                return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`;
            });

            let output = "<file>\n";
            output += numberedContent.join("\n");

            const totalLines = lines.length;
            const lastReadLine = offset + raw.length;
            const hasMoreLines = totalLines > lastReadLine;
            
            if (truncatedByBytes) {
                output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`;
            } else if (hasMoreLines) {
                output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`;
            } else {
                output += `\n\n(End of file - total ${totalLines} lines)`;
            }
            output += "\n</file>";
            
            // Warm up LSP
            LSP.touchFile(filepath, false).catch(() => {});

            return createSuccessResult(output, `📄 ${path.basename(filepath)}`);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to read file: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }

    private async isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
        // Extension check
        const ext = path.extname(filepath).toLowerCase();
        const binaryExts = [
            ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
            ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
            ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
            ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp"
        ];
        if (binaryExts.includes(ext)) return true;
        if (fileSize === 0) return false;

        // Content check
        const fd = await fs.open(filepath, 'r');
        const buffer = Buffer.alloc(Math.min(4096, fileSize));
        await fd.read(buffer, 0, buffer.length, 0);
        await fd.close();

        let nonPrintableCount = 0;
        for (let i = 0; i < buffer.length; i++) {
            const byte = buffer[i];
            if (byte === 0) return true;
            if (byte < 9 || (byte > 13 && byte < 32)) {
                nonPrintableCount++;
            }
        }
        return nonPrintableCount / buffer.length > 0.3;
    }
}
