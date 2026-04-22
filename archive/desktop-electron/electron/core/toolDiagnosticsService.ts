import fs from 'node:fs/promises';
import path from 'node:path';
import { getSettings } from '../db';
import { Instance } from './instance';
import { createBuiltinTools, getRegisteredBuiltinTools } from './tools';
import { type BuiltinToolDescriptor, toolDescriptorMatchesPack } from './tools/catalog';
import { logDebugEvent } from './debugLogger';
import { ToolExecutor, ToolRegistry, type ToolCallRequest, type ToolCallResponse, type ToolResult } from './toolRegistry';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';

export type ToolDiagnosticAvailabilityStatus =
    | 'available'
    | 'missing_context'
    | 'internal_only'
    | 'not_in_current_pack'
    | 'registration_error';

export interface ToolDiagnosticDescriptor {
    name: string;
    displayName: string;
    description: string;
    kind: string;
    visibility: 'public' | 'developer' | 'internal';
    contexts: string[];
    availabilityStatus: ToolDiagnosticAvailabilityStatus;
    availabilityReason: string;
}

export interface ToolDiagnosticRunResult {
    success: boolean;
    mode: 'direct' | 'ai';
    toolName: string;
    request: unknown;
    response?: unknown;
    error?: string;
    toolCallReturned?: boolean;
    toolNameMatched?: boolean;
    argumentsParsed?: boolean;
    executionSucceeded?: boolean;
}

interface ToolTestScenario {
    directRequest?: ToolCallRequest;
    aiPrompt?: string;
    skipReason?: string;
}

const createRegistryForDiagnostics = () => {
    const registry = new ToolRegistry();
    registry.registerTools(createBuiltinTools({ pack: 'full' }));
    return registry;
};

const ensureSandbox = async (): Promise<{
    sandboxDir: string;
    sampleFilePath: string;
    nestedDirPath: string;
}> => {
    const sandboxRoot = Instance.directory || process.cwd();
    const sandboxDir = path.join(sandboxRoot, '.redbox-dev', 'tool-diagnostics');
    const nestedDirPath = path.join(sandboxDir, 'nested');
    const sampleFilePath = path.join(sandboxDir, 'sample.txt');

    await fs.mkdir(nestedDirPath, { recursive: true });
    await fs.writeFile(sampleFilePath, 'alpha\nbeta\nredclaw diagnostic keyword\ngamma\n', 'utf8');

    return {
        sandboxDir,
        sampleFilePath,
        nestedDirPath,
    };
};

const buildScenario = async (toolName: string): Promise<ToolTestScenario> => {
    const sandbox = await ensureSandbox();

    switch (toolName) {
        case 'workspace':
            return {
                directRequest: {
                    callId: 'diag-workspace-edit',
                    name: toolName,
                    params: { action: 'edit', filePath: sandbox.sampleFilePath, oldString: 'beta', newString: 'beta-edited' },
                },
                aiPrompt: `请使用 workspace 把文件 ${sandbox.sampleFilePath} 里的 beta 改成 beta-edited。`,
            };
        case 'web_search':
            return {
                directRequest: { callId: 'diag-web-search', name: toolName, params: { query: 'OpenAI', maxResults: 3 } },
                aiPrompt: '请用 web_search 搜索 OpenAI，并返回搜索结果。',
            };
        case 'bash':
            return {
                directRequest: { callId: 'diag-bash', name: toolName, params: { command: 'pwd', workdir: sandbox.sandboxDir, timeout: 15000 } },
                aiPrompt: `请在目录 ${sandbox.sandboxDir} 里执行 pwd。`,
            };
        case 'app_cli':
            return {
                directRequest: { callId: 'diag-app-cli', name: toolName, params: { command: 'spaces list' } },
                aiPrompt: '请调用 app_cli 列出当前空间。',
            };
        case 'calculator':
            return {
                directRequest: { callId: 'diag-calculator', name: toolName, params: { expression: '2 + 3 * 4' } },
                aiPrompt: '请用 calculator 计算 2 + 3 * 4。',
            };
        case 'lsp':
            return {
                directRequest: { callId: 'diag-lsp', name: toolName, params: { operation: 'workspaceSymbol', filePath: sandbox.sampleFilePath, query: 'Settings' } },
                aiPrompt: '请使用 lsp 的 workspaceSymbol 查询 “Settings”。',
            };
        case 'plan_mode_enter':
            return {
                directRequest: { callId: 'diag-plan-enter', name: toolName, params: {} },
                aiPrompt: '请进入 plan mode。',
            };
        case 'plan_mode_exit':
            return {
                directRequest: { callId: 'diag-plan-exit', name: toolName, params: {} },
                aiPrompt: '请退出 plan mode。',
            };
        case 'skill_manage':
        case 'skill_install':
            return {
                skipReason: '该工具需要 chatService 上下文，当前开发者诊断未附带该上下文。',
            };
        default:
            return {
                skipReason: '该工具尚未配置开发者诊断场景。',
            };
    }
};

const executeToolRequest = async (request: ToolCallRequest): Promise<ToolCallResponse> => {
    const registry = createRegistryForDiagnostics();
    const executor = new ToolExecutor(registry);
    return executor.execute(request, new AbortController().signal);
};

const resolveAiTestConfig = (): { baseURL: string; apiKey: string; model: string } => {
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const baseURL = normalizeApiBaseUrl(String(settings.api_endpoint || ''), 'https://api.openai.com/v1');
    const apiKey = String(settings.api_key || '').trim();
    const model = String(settings.model_name_redclaw || settings.model_name || '').trim();

    if (!baseURL || !model) {
        throw new Error('当前未配置可用的默认 AI 源或模型。');
    }
    if (!apiKey) {
        throw new Error('当前默认 AI 源缺少 API Key。');
    }

    return { baseURL, apiKey, model };
};

const resolveDescriptorAvailability = (descriptor: BuiltinToolDescriptor): {
    status: ToolDiagnosticAvailabilityStatus;
    reason: string;
} => {
    if (descriptor.visibility === 'internal') {
        return {
            status: 'internal_only',
            reason: '该工具为内部工具，不对普通运行上下文暴露。',
        };
    }

    if (descriptor.requiresContext) {
        return {
            status: 'missing_context',
            reason: `该工具需要 ${descriptor.requiresContext} 上下文，当前开发者诊断未附带该上下文。`,
        };
    }

    if (!toolDescriptorMatchesPack(descriptor, 'redclaw')) {
        return {
            status: 'not_in_current_pack',
            reason: '该工具已注册，但默认不注入到 RedClaw 工具包。',
        };
    }

    const instance = descriptor.create({});
    if (!instance) {
        return {
            status: 'registration_error',
            reason: '该工具已注册，但当前上下文下未能实例化。',
        };
    }

    return {
        status: 'available',
        reason: '该工具已注册，且默认注入到 RedClaw 工具包。',
    };
};

export const listToolDiagnostics = (): ToolDiagnosticDescriptor[] => {
    return getRegisteredBuiltinTools().map((descriptor) => {
        const availability = resolveDescriptorAvailability(descriptor);
        return {
            name: descriptor.name,
            displayName: descriptor.displayName,
            description: descriptor.description,
            kind: descriptor.kind,
            visibility: descriptor.visibility,
            contexts: descriptor.contexts,
            availabilityStatus: availability.status,
            availabilityReason: availability.reason,
        };
    });
};

export const runDirectToolDiagnostic = async (toolName: string): Promise<ToolDiagnosticRunResult> => {
    const scenario = await buildScenario(toolName);
    if (!scenario.directRequest) {
        return {
            success: false,
            mode: 'direct',
            toolName,
            request: null,
            error: scenario.skipReason || '未配置直接测试场景。',
            executionSucceeded: false,
        };
    }

    logDebugEvent('tool-diagnostics', 'info', 'run-direct:start', { toolName, request: scenario.directRequest });
    const response = await executeToolRequest(scenario.directRequest);
    logDebugEvent('tool-diagnostics', response.result.success ? 'info' : 'error', 'run-direct:completed', { toolName, response });

    return {
        success: response.result.success !== false,
        mode: 'direct',
        toolName,
        request: scenario.directRequest,
        response,
        error: response.result.success === false ? response.result.error?.message : undefined,
        executionSucceeded: response.result.success !== false,
    };
};

export const runAiToolDiagnostic = async (toolName: string): Promise<ToolDiagnosticRunResult> => {
    const scenario = await buildScenario(toolName);
    if (!scenario.aiPrompt) {
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: null,
            error: scenario.skipReason || '未配置 AI 调用测试场景。',
            toolCallReturned: false,
            toolNameMatched: false,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    const registry = createRegistryForDiagnostics();
    const tool = registry.getTool(toolName);
    if (!tool) {
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: null,
            error: '工具未注册到当前诊断上下文。',
            toolCallReturned: false,
            toolNameMatched: false,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    const { baseURL, apiKey, model } = resolveAiTestConfig();
    const [schema] = registry.getToolSchemas().filter((item) => item.function.name === toolName);
    if (!schema) {
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: null,
            error: '未能生成工具 schema。',
            toolCallReturned: false,
            toolNameMatched: false,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    const requestBody = {
        model,
        temperature: 0,
        messages: [
            {
                role: 'system',
                content: 'You are a developer tool diagnostics agent. You must call the provided tool exactly once with valid arguments matching the user request. Do not answer without using the tool.',
            },
            {
                role: 'user',
                content: scenario.aiPrompt,
            },
        ],
        tools: [schema],
        tool_choice: {
            type: 'function',
            function: { name: toolName },
        },
    };

    logDebugEvent('tool-diagnostics', 'info', 'run-ai:start', { toolName, requestBody: { ...requestBody, apiKey: '[redacted]' }, baseURL });
    const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
    });

    const rawText = await response.text();
    let parsed: any = null;
    try {
        parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
        parsed = null;
    }

    if (!response.ok) {
        logDebugEvent('tool-diagnostics', 'error', 'run-ai:http-error', { toolName, status: response.status, rawText });
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: requestBody,
            response: { status: response.status, body: rawText },
            error: `AI 调用测试失败 (${response.status}): ${rawText || response.statusText}`,
            toolCallReturned: false,
            toolNameMatched: false,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    const toolCall = parsed?.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.name) {
        logDebugEvent('tool-diagnostics', 'error', 'run-ai:no-tool-call', { toolName, parsed });
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: requestBody,
            response: parsed || rawText,
            error: '模型没有返回任何 tool_call。',
            toolCallReturned: false,
            toolNameMatched: false,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    const toolNameMatched = String(toolCall.function.name || '') === toolName;
    if (!toolNameMatched) {
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: requestBody,
            response: parsed || rawText,
            error: `模型调用了错误的工具：${toolCall.function.name}`,
            toolCallReturned: true,
            toolNameMatched: false,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    let args: Record<string, unknown> = {};
    try {
        args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch (error) {
        return {
            success: false,
            mode: 'ai',
            toolName,
            request: requestBody,
            response: parsed || rawText,
            error: `tool_call arguments 解析失败: ${error instanceof Error ? error.message : String(error)}`,
            toolCallReturned: true,
            toolNameMatched: true,
            argumentsParsed: false,
            executionSucceeded: false,
        };
    }

    const executed = await executeToolRequest({
        callId: String(toolCall.id || `diag-ai-${toolName}`),
        name: toolCall.function.name,
        params: args,
    });
    logDebugEvent('tool-diagnostics', executed.result.success ? 'info' : 'error', 'run-ai:completed', {
        toolName,
        toolCall,
        executed,
    });

    return {
        success: executed.result.success !== false,
        mode: 'ai',
        toolName,
        request: requestBody,
        response: {
            toolCall,
            executed,
            rawModelResponse: parsed || rawText,
        },
        error: executed.result.success === false ? executed.result.error?.message : undefined,
        toolCallReturned: true,
        toolNameMatched: true,
        argumentsParsed: true,
        executionSucceeded: executed.result.success !== false,
    };
};
