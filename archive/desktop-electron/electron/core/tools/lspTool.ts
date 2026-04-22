import { z } from 'zod';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { LSP } from '../lsp';
import { Instance } from '../instance';
import { Filesystem } from '../util/filesystem';
import { resolvePathInWorkspace } from './workspaceGuard';

const operations = [
    "goToDefinition",
    "findReferences",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
    "goToImplementation",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
] as const;

const LspParamsSchema = z.object({
    operation: z.enum(operations).describe("The LSP operation to perform"),
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).optional().describe("The line number (1-based, as shown in editors). Required for operations that need a position."),
    character: z.number().int().min(1).optional().describe("The character offset (1-based, as shown in editors). Required for operations that need a position."),
    query: z.string().optional().describe("The query string for workspaceSymbol operation."),
});

type LspParams = z.infer<typeof LspParamsSchema>;

export class LspTool extends DeclarativeTool<typeof LspParamsSchema> {
    readonly name = 'lsp';
    readonly displayName = 'LSP Tool';
    readonly description = 'Perform Language Server Protocol operations like Go to Definition, Find References, Hover, etc. Useful for code navigation and understanding.';
    readonly kind = ToolKind.LSP;
    readonly parameterSchema = LspParamsSchema;
    readonly requiresConfirmation = false;

    protected validateValues(params: LspParams): string | null {
        if (['goToDefinition', 'findReferences', 'hover', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls'].includes(params.operation)) {
            if (params.line === undefined || params.character === undefined) {
                return `Operation ${params.operation} requires 'line' and 'character' parameters.`;
            }
        }
        if (params.operation === 'workspaceSymbol' && !params.query) {
            return `Operation workspaceSymbol requires 'query' parameter.`;
        }
        return null;
    }

    getDescription(params: LspParams): string {
        const file = params.filePath ? path.basename(params.filePath) : 'workspace';
        const pos = params.line ? `:${params.line}:${params.character}` : '';
        return `LSP ${params.operation} on ${file}${pos}`;
    }

    async execute(params: LspParams, signal: AbortSignal): Promise<ToolResult> {
        if (signal.aborted) {
            return createErrorResult('LSP operation cancelled', ToolErrorType.CANCELLED);
        }

        try {
            let file: string;
            try {
                file = resolvePathInWorkspace(params.filePath, Instance.directory);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return createErrorResult(message, ToolErrorType.PERMISSION_DENIED);
            }
            
            // For workspaceSymbol, file path might be irrelevant but we still need a valid project context.
            // We use Instance.directory for workspace operations if filePath is just "." or empty.
            
            if (params.operation !== 'workspaceSymbol') {
                 if (!(await Filesystem.exists(file))) {
                    return createErrorResult(`File not found: ${file}`, ToolErrorType.FILE_NOT_FOUND);
                }
                const available = await LSP.hasClients(file);
                if (!available) {
                     // Try to initialize?
                     // await LSP.touchFile(file);
                     // Check again
                     // if (!(await LSP.hasClients(file)))
                     return createErrorResult(`No LSP server available for this file type: ${path.extname(file)}`, ToolErrorType.EXECUTION_FAILED);
                }
                await LSP.touchFile(file, true);
            }

            // Normalize position (1-based to 0-based)
            const position = {
                file,
                line: (params.line || 1) - 1,
                character: (params.character || 1) - 1,
            };

            const uri = pathToFileURL(file).href;

            let result: unknown;

            switch (params.operation) {
                case "goToDefinition":
                    result = await LSP.definition(position);
                    break;
                case "findReferences":
                    result = await LSP.references(position);
                    break;
                case "hover":
                    result = await LSP.hover(position);
                    break;
                case "documentSymbol":
                    result = await LSP.documentSymbol(uri);
                    break;
                case "workspaceSymbol":
                    result = await LSP.workspaceSymbol(params.query || "");
                    break;
                case "goToImplementation":
                    result = await LSP.implementation(position);
                    break;
                case "prepareCallHierarchy":
                    result = await LSP.prepareCallHierarchy(position);
                    break;
                case "incomingCalls":
                    result = await LSP.incomingCalls(position);
                    break;
                case "outgoingCalls":
                    result = await LSP.outgoingCalls(position);
                    break;
                default:
                    return createErrorResult(`Unknown operation: ${params.operation}`, ToolErrorType.INVALID_PARAMS);
            }

            if (!result || (Array.isArray(result) && result.length === 0)) {
                return createSuccessResult("No results found.");
            }

            return createSuccessResult(JSON.stringify(result, null, 2));

        } catch (error) {
             const message = error instanceof Error ? error.message : String(error);
             return createErrorResult(`LSP Error: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}
