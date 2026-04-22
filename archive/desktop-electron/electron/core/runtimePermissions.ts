import { getBuiltinToolDescriptor } from './tools/catalog';
import { analyzeAppCliCommand, analyzeBashCommand } from './runtimeCommandPolicy';
import {
    MUTATOR_KINDS,
    ToolKind,
    type ToolConfirmationDetails,
    type ToolDefinition,
    type ToolResult,
} from './toolRegistry';

export interface RuntimePermissionContext {
    sessionId: string;
    toolPack: string;
    runtimeMode?: string;
    interactive?: boolean;
    requiresHumanApproval?: boolean;
}

export interface RuntimePermissionDecision {
    outcome: 'allow' | 'confirm' | 'deny';
    reason: string;
    details?: ToolConfirmationDetails | null;
    source: 'descriptor' | 'runtime-policy' | 'tool';
}

const BACKGROUND_MUTATOR_ALLOWLIST = new Set([
    'app_cli',
]);

const DIAGNOSTIC_ONLY_PACKS = new Set(['diagnostics', 'full']);

const isMutatorTool = (tool: ToolDefinition<unknown, ToolResult>): boolean => MUTATOR_KINDS.includes(tool.kind);

const buildGenericConfirmationDetails = (
    tool: ToolDefinition<unknown, ToolResult>,
    params: Record<string, unknown>,
    reason: string,
): ToolConfirmationDetails => ({
    type: tool.kind === ToolKind.Execute ? 'exec' : tool.kind === ToolKind.Edit || tool.kind === ToolKind.Delete ? 'edit' : 'info',
    title: `确认执行 ${tool.displayName}`,
    description: tool.getDescription(params),
    impact: reason,
});

export const evaluateRuntimeToolPermission = (params: {
    tool: ToolDefinition<unknown, ToolResult>;
    toolName: string;
    args: Record<string, unknown>;
    context: RuntimePermissionContext;
}): RuntimePermissionDecision => {
    const { tool, toolName, args, context } = params;
    const descriptor = getBuiltinToolDescriptor(toolName);
    const interactive = context.interactive !== false;
    const runtimeMode = String(context.runtimeMode || '').trim();

    if (toolName === 'workspace') {
        const action = String(args.action || '').trim();
        const reason = action ? `workspace action=${action}` : 'workspace action';

        if (action === 'list' || action === 'read' || action === 'search') {
            return {
                outcome: 'deny',
                reason: `${reason} 已停用；读取/搜索/列目录请改用 bash 或 app_cli。`,
                source: 'runtime-policy',
            };
        }

        if (runtimeMode === 'background-maintenance') {
            return {
                outcome: 'deny',
                reason: `后台维护模式禁止执行 ${reason} 这类工作区写入。`,
                source: 'runtime-policy',
            };
        }

        return {
            outcome: interactive ? 'confirm' : 'deny',
            reason: `${reason} 会修改工作区文件。`,
            details: interactive ? buildGenericConfirmationDetails(tool, args, `${reason} 会修改工作区文件。`) : null,
            source: 'runtime-policy',
        };
    }

    if (toolName === 'app_cli') {
        const analysis = analyzeAppCliCommand(String(args.command || ''), {
            interactive,
            runtimeMode,
        });
        if (analysis.className === 'deny') {
            return {
                outcome: 'deny',
                reason: analysis.reason,
                source: 'runtime-policy',
            };
        }
        if (analysis.className === 'confirm') {
            return {
                outcome: interactive ? 'confirm' : 'deny',
                reason: analysis.reason,
                details: interactive ? buildGenericConfirmationDetails(tool, args, analysis.reason) : null,
                source: 'runtime-policy',
            };
        }
        if (analysis.className === 'read-only' || analysis.className === 'trusted-write') {
            return {
                outcome: 'allow',
                reason: analysis.reason,
                source: 'runtime-policy',
            };
        }
    }

    if (toolName === 'bash') {
        const analysis = analyzeBashCommand(String(args.command || args.cmd || ''), {
            interactive,
            runtimeMode,
        });
        if (analysis.className === 'deny') {
            return {
                outcome: 'deny',
                reason: analysis.reason,
                source: 'runtime-policy',
            };
        }
        if (analysis.className === 'confirm') {
            return {
                outcome: interactive ? 'confirm' : 'deny',
                reason: analysis.reason,
                details: interactive ? buildGenericConfirmationDetails(tool, args, analysis.reason) : null,
                source: 'runtime-policy',
            };
        }
        if (analysis.className === 'read-only') {
            return {
                outcome: 'allow',
                reason: analysis.reason,
                source: 'runtime-policy',
            };
        }
    }

    if (descriptor) {
        if (descriptor.visibility === 'internal') {
            return {
                outcome: 'deny',
                reason: `工具 ${toolName} 为内部工具，当前运行时不可直接调用。`,
                source: 'descriptor',
            };
        }

        if (descriptor.visibility === 'developer' && !DIAGNOSTIC_ONLY_PACKS.has(String(context.toolPack || ''))) {
            return {
                outcome: 'deny',
                reason: `工具 ${toolName} 为开发者专用工具，不属于当前工具包 ${context.toolPack}。`,
                source: 'descriptor',
            };
        }

        if (context.toolPack && context.toolPack !== 'full' && !descriptor.contexts.includes(context.toolPack as any)) {
            return {
                outcome: 'deny',
                reason: `工具 ${toolName} 不在当前工具包 ${context.toolPack} 的可用范围内。`,
                source: 'descriptor',
            };
        }

        if (descriptor.requiresContext) {
            return {
                outcome: 'deny',
                reason: `工具 ${toolName} 需要 ${descriptor.requiresContext} 上下文，当前运行时未附带。`,
                source: 'descriptor',
            };
        }
    }

    if (runtimeMode === 'background-maintenance' && isMutatorTool(tool) && !BACKGROUND_MUTATOR_ALLOWLIST.has(toolName)) {
        return {
            outcome: 'deny',
            reason: `后台维护模式禁止直接执行 ${toolName} 这类变更型工具。`,
            source: 'runtime-policy',
        };
    }

    if (context.requiresHumanApproval && isMutatorTool(tool)) {
        return {
            outcome: interactive ? 'confirm' : 'deny',
            reason: '当前任务被标记为需要人工审批，变更型工具必须人工确认。',
            details: interactive ? buildGenericConfirmationDetails(tool, args, '当前任务需要人工审批。') : null,
            source: 'runtime-policy',
        };
    }

    if (tool.requiresConfirmation) {
        return {
            outcome: interactive ? 'confirm' : 'deny',
            reason: `工具 ${toolName} 自身声明需要人工确认。`,
            details: interactive
                ? tool.getConfirmationDetails?.(args) || buildGenericConfirmationDetails(tool, args, '该工具已声明需要人工确认。')
                : null,
            source: 'tool',
        };
    }

    if (isMutatorTool(tool)) {
        return {
            outcome: interactive ? 'confirm' : 'deny',
            reason: `工具 ${toolName} 属于 ${tool.kind} 类变更操作。`,
            details: interactive ? buildGenericConfirmationDetails(tool, args, '变更型工具默认需要人工确认。') : null,
            source: 'runtime-policy',
        };
    }

    return {
        outcome: 'allow',
        reason: `工具 ${toolName} 为只读或安全工具。`,
        source: descriptor ? 'descriptor' : 'runtime-policy',
    };
};
