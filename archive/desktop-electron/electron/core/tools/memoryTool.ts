import { z } from "zod";
import { addUserMemoryToFile } from "../fileMemoryStore";
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
} from '../toolRegistry';

// 参数 Schema
const MemoryParamsSchema = z.object({
    content: z.string().describe("The content of the memory (e.g., 'User prefers dark mode', 'Project deadline is next Friday'). Keep it concise."),
    type: z.enum(['general', 'preference', 'fact']).optional().describe("Type of memory. Default is 'general'."),
    tags: z.array(z.string()).optional().describe("Optional tags for categorization.")
});

type MemoryParams = z.infer<typeof MemoryParamsSchema>;

/**
 * 保存记忆工具
 */
export class SaveMemoryTool extends DeclarativeTool<typeof MemoryParamsSchema> {
    readonly name = 'save_memory';
    readonly displayName = 'Save Memory';
    readonly description = "Saves a piece of information about the user to their long-term memory. Use this when the user mentions preferences, personal details, project requirements, or important facts that should be remembered for future conversations. DO NOT save trivial conversation details.";
    readonly kind = ToolKind.Other;
    readonly parameterSchema = MemoryParamsSchema;
    readonly requiresConfirmation = false;

    getDescription(params: MemoryParams): string {
        return `Save memory: "${params.content}"`;
    }

    async execute(params: MemoryParams): Promise<ToolResult> {
        try {
            const memory = await addUserMemoryToFile(params.content, params.type || 'general', params.tags || []);
            return createSuccessResult(
                `Memory saved successfully: [${memory.type}] ${memory.content}`,
                `💾 Saved: ${params.content}`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to save memory: ${message}`);
        }
    }
}
