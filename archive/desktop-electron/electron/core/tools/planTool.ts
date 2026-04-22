import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
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

const PlanEnterParamsSchema = z.object({});
type PlanEnterParams = z.infer<typeof PlanEnterParamsSchema>;

const PlanExitParamsSchema = z.object({});
type PlanExitParams = z.infer<typeof PlanExitParamsSchema>;

async function getPlanPath(): Promise<string> {
    const dir = path.join(Instance.directory, '.opencode');
    if (!(await Filesystem.exists(dir))) {
        await fs.mkdir(dir, { recursive: true });
    }
    return path.join(dir, 'PLAN.md');
}

export class PlanModeEnterTool extends DeclarativeTool<typeof PlanEnterParamsSchema> {
    readonly name = 'plan_mode_enter';
    readonly displayName = 'Enter Plan Mode';
    readonly description = 'Switch to Plan Mode. Use this when you need to research, design, or create a complex plan before implementation. This will create or update the .opencode/PLAN.md file.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = PlanEnterParamsSchema;
    readonly requiresConfirmation = true;

    getDescription(params: PlanEnterParams): string {
        return 'Enter Plan Mode';
    }

    async execute(params: PlanEnterParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            const planPath = await getPlanPath();
            
            // Create empty plan if not exists
            if (!(await Filesystem.exists(planPath))) {
                await fs.writeFile(planPath, '# Plan\n\nStatus: Planning\n\n## Objectives\n\n- [ ] Define objectives\n', 'utf-8');
            }

            // The actual state switch happens in ChatService by listening to tool_end event
            return createSuccessResult(
                `Switched to Plan Mode.\n\nI have initialized the plan file at ${planPath}.\n\nPlease researching the codebase, understanding requirements, and updating the plan file using 'edit_file' or 'write_file'.\n\nWhen the plan is ready, call 'plan_mode_exit' to start implementation.`,
                'Entered Plan Mode'
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to enter plan mode: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}

export class PlanModeExitTool extends DeclarativeTool<typeof PlanExitParamsSchema> {
    readonly name = 'plan_mode_exit';
    readonly displayName = 'Exit Plan Mode';
    readonly description = 'Exit Plan Mode and switch to Implementation Mode. Use this when the plan is finalized and you are ready to write code.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = PlanExitParamsSchema;
    readonly requiresConfirmation = true;

    getDescription(params: PlanExitParams): string {
        return 'Exit Plan Mode';
    }

    async execute(params: PlanExitParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            const planPath = await getPlanPath();
            let planContent = '';

            if (await Filesystem.exists(planPath)) {
                planContent = await fs.readFile(planPath, 'utf-8');
            } else {
                planContent = '(No plan file found)';
            }

            return createSuccessResult(
                `Exited Plan Mode.\n\nFinal Plan:\n${planContent}\n\nPlease proceed with implementation based on this plan.`,
                'Exited Plan Mode'
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to exit plan mode: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}
