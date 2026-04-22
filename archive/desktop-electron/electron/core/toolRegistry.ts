/**
 * Tool Registry - 工具注册中心
 *
 * 参考 Gemini CLI 的 DeclarativeTool 模式设计
 * 实现工具的注册、获取、Schema 生成
 */

import { z } from 'zod';

// ========== Tool Types ==========

/**
 * 工具类型分类
 */
export enum ToolKind {
    Read = 'read',       // 读取操作（文件、搜索等）
    Edit = 'edit',       // 编辑操作
    Delete = 'delete',   // 删除操作
    Execute = 'execute', // 执行操作（Shell 命令）
    Search = 'search',   // 搜索操作
    Fetch = 'fetch',     // 网络请求
    Think = 'think',     // 思考工具
    LSP = 'lsp',         // LSP 工具
    Other = 'other',     // 其他
}

/**
 * 需要确认的工具类型
 */
export const MUTATOR_KINDS: ToolKind[] = [
    ToolKind.Edit,
    ToolKind.Delete,
    ToolKind.Execute,
];

/**
 * 工具执行结果
 */
export interface ToolResult {
    /** 是否成功 */
    success: boolean;
    /** 返回给 LLM 的内容 */
    llmContent: string;
    /** 用于 UI 展示的内容（可选，默认使用 llmContent） */
    display?: string;
    /** 供宿主层使用的结构化结果 */
    data?: unknown;
    /** 错误信息 */
    error?: {
        message: string;
        type?: ToolErrorType;
    };
}

/**
 * 工具错误类型
 */
export enum ToolErrorType {
    INVALID_PARAMS = 'INVALID_PARAMS',
    EXECUTION_FAILED = 'EXECUTION_FAILED',
    PERMISSION_DENIED = 'PERMISSION_DENIED',
    FILE_NOT_FOUND = 'FILE_NOT_FOUND',
    TIMEOUT = 'TIMEOUT',
    CANCELLED = 'CANCELLED',
}

/**
 * 工具确认详情
 */
export interface ToolConfirmationDetails {
    /** 确认类型 */
    type: 'edit' | 'exec' | 'info';
    /** 确认标题 */
    title: string;
    /** 详细描述 */
    description: string;
    /** 操作影响说明 */
    impact?: string;
}

/**
 * 工具确认结果
 */
export enum ToolConfirmationOutcome {
    ProceedOnce = 'proceed_once',
    ProceedAlways = 'proceed_always',
    Cancel = 'cancel',
}

// ========== Tool Definition Interface ==========

/**
 * 工具定义接口 - 所有工具必须实现此接口
 */
export interface ToolDefinition<TParams = unknown, TResult extends ToolResult = ToolResult> {
    /** 工具内部名称（用于 API 调用） */
    name: string;
    /** 工具显示名称 */
    displayName: string;
    /** 工具描述 */
    description: string;
    /** 工具类型 */
    kind: ToolKind;
    /** 参数 Schema（Zod） */
    parameterSchema: z.ZodType<TParams, z.ZodTypeDef, TParams>;
    /** 是否需要确认执行 */
    requiresConfirmation: boolean;
    /** 是否支持流式输出 */
    canStreamOutput?: boolean;
    /** 给运行时做并发编排用。默认 false，工具可自行声明只读并发安全。 */
    isConcurrencySafe?(params: TParams): boolean;

    /**
     * 验证参数
     * @param params 原始参数
     * @returns 验证错误信息，null 表示验证通过
     */
    validate(params: unknown): string | null;

    /**
     * 获取操作描述（用于用户确认）
     * @param params 验证后的参数
     */
    getDescription(params: TParams): string;

    /**
     * 获取确认详情（用于敏感操作确认）
     * @param params 验证后的参数
     */
    getConfirmationDetails?(params: TParams): ToolConfirmationDetails | null;

    /**
     * 执行工具
     * @param params 验证后的参数
     * @param signal 取消信号
     * @param onOutput 流式输出回调（可选）
     */
    execute(
        params: TParams,
        signal: AbortSignal,
        onOutput?: (chunk: string) => void
    ): Promise<TResult>;

    /**
     * LangChain invoke 兼容方法
     */
    invoke?(params: TParams): Promise<string>;

    /**
     * LangChain call 兼容方法
     */
    call?(params: TParams): Promise<string>;
}

// ========== Base Tool Class ==========

/**
 * 声明式工具基类
 * 独立的工具基类，提供通用的验证逻辑和确认机制
 * 不再依赖 LangChain StructuredTool
 */
export abstract class DeclarativeTool<TParams extends z.ZodType<any, any>, TResult extends ToolResult = ToolResult>
    implements ToolDefinition<z.infer<TParams>, TResult> {

    abstract readonly name: string;
    abstract readonly displayName: string;
    abstract readonly description: string;
    abstract readonly kind: ToolKind;
    abstract readonly parameterSchema: TParams;

    // Schema accessor for compatibility
    get schema() {
        return this.parameterSchema;
    }

    // Required by some external code that expects LangChain interface
    get lc_namespace() {
        return ['redconvert', 'tools'];
    }

    readonly requiresConfirmation: boolean = false;
    readonly canStreamOutput: boolean = false;

    isConcurrencySafe(_params: z.infer<TParams>): boolean {
        return false;
    }

    /**
     * 验证参数
     */
    validate(params: unknown): string | null {
        const result = this.parameterSchema.safeParse(params);
        if (!result.success) {
            // 优化错误信息，使其对 LLM 更具指导性
            const issues = result.error.issues.map(i => {
                // 针对必填字段缺失的特殊提示
                if (i.code === 'invalid_type' && i.received === 'undefined') {
                    return `MISSING REQUIRED ARGUMENT: '${i.path.join('.')}' is required.`;
                }
                return `${i.path.join('.')}: ${i.message}`;
            }).join('\n');

            // 生成简化的 Schema 提示
            let schemaHint = '';
            try {
                const jsonSchema = zodToJsonSchema(this.parameterSchema);
                // 只保留 properties 和 required，简化显示
                const simplified = {
                    properties: jsonSchema.properties,
                    required: jsonSchema.required
                };
                schemaHint = `\nExpected Schema:\n${JSON.stringify(simplified, null, 2)}`;
            } catch (e) {
                // ignore schema generation error during validation
            }

            return `Invalid tool arguments:\n${issues}\n${schemaHint}\n\n-> Retry the SAME tool with all required arguments filled exactly as the Expected Schema shows.`;
        }
        return this.validateValues(result.data);
    }

    /**
     * 子类可覆盖以添加额外的值验证
     */
    protected validateValues(_params: z.infer<TParams>): string | null {
        return null;
    }

    /**
     * 获取操作描述
     */
    abstract getDescription(params: z.infer<TParams>): string;

    /**
     * 获取确认详情（默认返回 null，表示不需要确认）
     */
    getConfirmationDetails(_params: z.infer<TParams>): ToolConfirmationDetails | null {
        return null;
    }

    /**
     * 执行工具（内部实现）
     */
    abstract execute(
        params: z.infer<TParams>,
        signal: AbortSignal,
        onOutput?: (chunk: string) => void
    ): Promise<TResult>;

    /**
     * LangChain _call 实现
     * 适配器方法：将 LangChain 调用转发给 execute
     */
    async _call(arg: z.infer<TParams>): Promise<string> {
        // 创建临时的 AbortSignal
        const controller = new AbortController();
        const result = await this.execute(arg, controller.signal);
        
        if (!result.success) {
            throw new Error(result.error?.message || 'Tool execution failed');
        }
        
        return result.llmContent;
    }

    /**
     * LangChain invoke 兼容方法
     */
    async invoke(arg: z.infer<TParams>): Promise<string> {
        return this._call(arg);
    }

    /**
     * LangChain call 兼容方法
     */
    async call(arg: z.infer<TParams>): Promise<string> {
        return this._call(arg);
    }

    /**
     * 获取 OpenAI 兼容的 Function Schema
     */
    getFunctionSchema() {
        return {
            type: 'function' as const,
            function: {
                name: this.name,
                description: this.description,
                parameters: zodToJsonSchema(this.parameterSchema),
            },
        };
    }
}

// ========== Tool Registry ==========

/**
 * OpenAI 兼容的函数定义
 */
export interface FunctionDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/**
 * 工具注册中心
 * 管理所有可用工具的注册、获取和 Schema 生成
 */
export class ToolRegistry {
    private tools: Map<string, ToolDefinition<unknown, ToolResult>> = new Map();
    private toolOrder: string[] = [];

    /**
     * 注册工具
     */
    registerTool<T extends ToolDefinition<unknown, ToolResult>>(tool: T): void {
        if (this.tools.has(tool.name)) {
            console.warn(`Tool "${tool.name}" already registered, will be overwritten.`);
        }
        this.tools.set(tool.name, tool);
        if (!this.toolOrder.includes(tool.name)) {
            this.toolOrder.push(tool.name);
        }
    }

    /**
     * 批量注册工具
     */
    registerTools(tools: ToolDefinition<unknown, ToolResult>[]): void {
        for (const tool of tools) {
            this.registerTool(tool);
        }
    }

    /**
     * 获取工具
     */
    getTool(name: string): ToolDefinition<unknown, ToolResult> | undefined {
        return this.tools.get(name);
    }

    /**
     * 获取所有工具名称
     */
    getAllToolNames(): string[] {
        return this.toolOrder;
    }

    /**
     * 获取所有工具定义
     */
    getAllTools(): ToolDefinition<unknown, ToolResult>[] {
        return this.toolOrder.map(name => this.tools.get(name)!);
    }

    /**
     * 获取 OpenAI 兼容的工具 Schema 列表
     * 返回格式兼容 OpenAI Chat Completion API
     */
    getToolSchemas() {
        return this.getAllTools().map(tool => {
            if (tool instanceof DeclarativeTool) {
                return tool.getFunctionSchema();
            }
            // 对于非 DeclarativeTool 实例，手动构建 schema
            return {
                type: 'function' as const,
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: zodToJsonSchema(tool.parameterSchema),
                },
            };
        });
    }

    /**
     * 按类型获取工具
     */
    getToolsByKind(kind: ToolKind): ToolDefinition<unknown, ToolResult>[] {
        return this.getAllTools().filter(tool => tool.kind === kind);
    }

    /**
     * 获取需要确认的工具列表
     */
    getToolsRequiringConfirmation(): ToolDefinition<unknown, ToolResult>[] {
        return this.getAllTools().filter(tool => tool.requiresConfirmation);
    }

    /**
     * 清空所有工具
     */
    clear(): void {
        this.tools.clear();
        this.toolOrder = [];
    }
}

// ========== Helper Functions ==========

/**
 * 将 Zod Schema 转换为 JSON Schema (增强版手动实现)
 *
 * 修复了原版缺少 ZodLiteral, ZodUnion, ZodRecord 等支持的问题
 */
export function zodToJsonSchema(schema: z.ZodType<any>): Record<string, unknown> {
    if (!schema) {
        console.error('[zodToJsonSchema] Schema is null/undefined!');
        return { type: 'object', properties: {}, required: [], additionalProperties: false };
    }

    try {
        const def = (schema as any)._def;
        const typeName = def.typeName;

        // 1. 处理 ZodObject
        if (typeName === 'ZodObject') {
            const shape = (schema as any).shape || (def.shape && typeof def.shape === 'function' ? def.shape() : def.shape);
            const properties: Record<string, unknown> = {};
            const required: string[] = [];

            if (shape) {
                for (const [key, value] of Object.entries(shape)) {
                    const propSchema = value as z.ZodType<any>;
                    properties[key] = zodToJsonSchema(propSchema);

                    // 增强的必填检查: 不依赖 isOptional() 方法，而是检查类型定义
                    // ZodOptional 和 ZodDefault 都意味着该字段在 JSON 输入中不是必须的
                    const propDef = (propSchema as any)._def;
                    const isOptional = propDef.typeName === 'ZodOptional' || propDef.typeName === 'ZodDefault' || propSchema.isOptional();

                    if (!isOptional) {
                        required.push(key);
                    }
                }
            }
            return {
                type: 'object',
                properties,
                required,
                description: schema.description,
                additionalProperties: false, // 关键修复：开启 OpenAI 严格模式，禁止多余字段，强约束结构
            };
        }

        // 2. 处理 ZodString
        if (typeName === 'ZodString') {
            return { type: 'string', description: schema.description };
        }

        // 3. 处理 ZodNumber
        if (typeName === 'ZodNumber') {
            return { type: 'number', description: schema.description };
        }

        // 4. 处理 ZodBoolean
        if (typeName === 'ZodBoolean') {
            return { type: 'boolean', description: schema.description };
        }

        // 5. 处理 ZodEnum
        if (typeName === 'ZodEnum') {
            return {
                type: 'string',
                enum: def.values,
                description: schema.description,
            };
        }

        // 6. 处理 ZodLiteral (关键修复: 之前缺失)
        if (typeName === 'ZodLiteral') {
            return {
                type: typeof def.value,
                enum: [def.value],
                description: schema.description,
            };
        }

        // 7. 处理 ZodUnion (关键修复: 之前缺失)
        if (typeName === 'ZodUnion') {
            return {
                anyOf: def.options.map((opt: z.ZodType<any>) => zodToJsonSchema(opt)),
                description: schema.description,
            };
        }

        // 8. 处理 ZodOptional / ZodNullable (递归解包)
        if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
            return zodToJsonSchema(def.innerType);
        }

        // 9. 处理 ZodDefault (递归解包)
        if (typeName === 'ZodDefault') {
             return zodToJsonSchema(def.innerType);
        }

        // 10. 处理 ZodArray
        if (typeName === 'ZodArray') {
            return {
                type: 'array',
                items: zodToJsonSchema(def.type),
                description: schema.description,
            };
        }

        // 11. 处理 ZodRecord (Map/Dictionary)
        if (typeName === 'ZodRecord') {
            return {
                type: 'object',
                additionalProperties: zodToJsonSchema(def.valueType),
                description: schema.description,
            };
        }

        // 12. 处理 ZodEffects (refine, transform)
        if (typeName === 'ZodEffects') {
            return zodToJsonSchema(def.schema);
        }

        // 13. 处理 ZodAny / ZodUnknown
        if (typeName === 'ZodAny' || typeName === 'ZodUnknown') {
            return { description: schema.description };
        }

        console.warn(`[zodToJsonSchema] Unsupported Zod type: ${typeName}, falling back to string`);
        return { type: 'string', description: schema.description };

    } catch (error) {
        console.error('[zodToJsonSchema] Failed to convert schema manually:', error);
        return { type: 'object', properties: {}, required: [], additionalProperties: false };
    }
}

/**
 * 创建成功结果
 */
export function createSuccessResult(content: string, display?: string): ToolResult {
    return {
        success: true,
        llmContent: content,
        display: display ?? content,
    };
}

/**
 * 创建错误结果
 */
export function createErrorResult(message: string, type?: ToolErrorType): ToolResult {
    return {
        success: false,
        llmContent: `Error: ${message}`,
        error: {
            message,
            type: type ?? ToolErrorType.EXECUTION_FAILED,
        },
    };
}

// ========== Tool Executor ==========

/**
 * 工具调用请求
 */
export interface ToolCallRequest {
    callId: string;
    name: string;
    params: unknown;
    forceConfirmation?: boolean;
    confirmationDetails?: ToolConfirmationDetails | null;
}

/**
 * 工具调用响应
 */
export interface ToolCallResponse {
    callId: string;
    name: string;
    result: ToolResult;
    durationMs: number;
}

/**
 * 工具执行器
 * 负责验证、确认和执行工具调用
 */
export class ToolExecutor {
    constructor(
        private registry: ToolRegistry,
        private onConfirmRequest?: (
            callId: string,
            tool: ToolDefinition<unknown>,
            params: unknown,
            details: ToolConfirmationDetails
        ) => Promise<ToolConfirmationOutcome>,
        private autoConfirmTools: Set<string> = new Set()
    ) { }

    /**
     * 执行工具调用
     */
    async execute(
        request: ToolCallRequest,
        signal: AbortSignal,
        onOutput?: (chunk: string) => void
    ): Promise<ToolCallResponse> {
        const startTime = Date.now();
        const { callId, name, params } = request;

        // 获取工具
        const tool = this.registry.getTool(name);
        if (!tool) {
            return {
                callId,
                name,
                result: createErrorResult(`Tool "${name}" not found`),
                durationMs: Date.now() - startTime,
            };
        }

        // 验证参数
        const validationError = tool.validate(params);
        if (validationError) {
            return {
                callId,
                name,
                result: createErrorResult(`Invalid parameters: ${validationError}`, ToolErrorType.INVALID_PARAMS),
                durationMs: Date.now() - startTime,
            };
        }

        // 检查是否需要确认
        const requiresConfirmation = (tool.requiresConfirmation || request.forceConfirmation) && !this.autoConfirmTools.has(name);
        if (requiresConfirmation) {
            const confirmDetails = request.confirmationDetails || tool.getConfirmationDetails?.(params) || null;
            if (!confirmDetails || !this.onConfirmRequest) {
                return {
                    callId,
                    name,
                    result: createErrorResult(
                        `Tool "${name}" requires confirmation but no confirmation handler is available`,
                        ToolErrorType.PERMISSION_DENIED,
                    ),
                    durationMs: Date.now() - startTime,
                };
            }

            const outcome = await this.onConfirmRequest(callId, tool, params, confirmDetails);

            if (outcome === ToolConfirmationOutcome.Cancel) {
                return {
                    callId,
                    name,
                    result: createErrorResult('Tool execution cancelled by user', ToolErrorType.CANCELLED),
                    durationMs: Date.now() - startTime,
                };
            }

            if (outcome === ToolConfirmationOutcome.ProceedAlways) {
                this.autoConfirmTools.add(name);
            }
        }

        // 执行工具
        try {
            const result = await tool.execute(params, signal, onOutput);
            return {
                callId,
                name,
                result,
                durationMs: Date.now() - startTime,
            };
        } catch (error) {
            if (signal.aborted) {
                return {
                    callId,
                    name,
                    result: createErrorResult('Tool execution aborted', ToolErrorType.CANCELLED),
                    durationMs: Date.now() - startTime,
                };
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                callId,
                name,
                result: createErrorResult(errorMessage, ToolErrorType.EXECUTION_FAILED),
                durationMs: Date.now() - startTime,
            };
        }
    }

    /**
     * 批量执行工具调用（并行）
     */
    async executeMany(
        requests: ToolCallRequest[],
        signal: AbortSignal
    ): Promise<ToolCallResponse[]> {
        return Promise.all(
            requests.map(req => this.execute(req, signal))
        );
    }

    /**
     * 设置自动确认的工具
     */
    setAutoConfirmTool(name: string, autoConfirm: boolean): void {
        if (autoConfirm) {
            this.autoConfirmTools.add(name);
        } else {
            this.autoConfirmTools.delete(name);
        }
    }
}
