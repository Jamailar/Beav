import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createTwoFilesPatch } from 'diff';
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
import { replace, trimDiff } from '../util/replacer';
import { LSP } from '../lsp';
import { resolvePathInWorkspace } from './workspaceGuard';

const EditToolParamsSchema = z.object({
    filePath: z.string().describe("The absolute path or workspace-relative path to the file to modify"),
    oldString: z.string().describe("The text to replace. Must be unique in the file or sufficiently specific."),
    newString: z.string().describe("The text to replace it with."),
    replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false). Use with caution."),
});

type EditToolParams = z.infer<typeof EditToolParamsSchema>;

export class EditTool extends DeclarativeTool<typeof EditToolParamsSchema> {
    readonly name = 'edit_file';
    readonly displayName = 'Edit File';
    readonly description = 'Edit a file by replacing a specific string with a new string. Handles fuzzy matching for minor whitespace differences.';
    readonly kind = ToolKind.Edit;
    readonly parameterSchema = EditToolParamsSchema;
    readonly requiresConfirmation = false; // Opencode allows edits on certain files, user can override

    constructor(private readonly workspaceRootOverride?: string) {
        super();
    }

    private getWorkspaceRoot(): string {
        return this.workspaceRootOverride || Instance.directory;
    }

    protected validateValues(params: EditToolParams): string | null {
        if (params.oldString === params.newString) {
            return "oldString and newString must be different.";
        }
        return null;
    }

    getDescription(params: EditToolParams): string {
        return `Edit file: ${path.basename(params.filePath)}`;
    }

    async execute(params: EditToolParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            let filePath = params.filePath;
            try {
                filePath = resolvePathInWorkspace(filePath, this.getWorkspaceRoot());
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return createErrorResult(message, ToolErrorType.PERMISSION_DENIED);
            }

            if (!(await Filesystem.exists(filePath))) {
                return createErrorResult(`File not found: ${filePath}`, ToolErrorType.FILE_NOT_FOUND);
            }

            // Read content
            const fileContent = await fs.readFile(filePath, 'utf-8');

            // Apply replacement logic
            let newContent: string;
            try {
                newContent = replace(fileContent, params.oldString, params.newString, params.replaceAll);
            } catch (e: any) {
                return createErrorResult(`Replacement failed: ${e.message}`, ToolErrorType.EXECUTION_FAILED);
            }

            // Generate Diff
            const diff = trimDiff(
                createTwoFilesPatch(
                    filePath,
                    filePath,
                    fileContent,
                    newContent
                )
            );

            // Write back
            await fs.writeFile(filePath, newContent, 'utf-8');

            // Notify LSP (Optional but good for checking errors)
            // We ignore errors here as it's a post-edit check
            try {
                await LSP.touchFile(filePath, true);
            } catch {}

            return createSuccessResult(
                `Successfully edited ${params.filePath}.\n\nDiff:\n${diff}`,
                `✏️ Edited ${path.basename(filePath)}`
            );

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Edit failed: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}
