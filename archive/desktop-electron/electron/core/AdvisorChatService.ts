/**
 * AdvisorChatService - 智囊团聊天服务（统一 QueryRuntime 版本）
 *
 * 专门为智囊团设计的聊天服务，包含：
 * - 思维链展示
 * - 智囊团私有知识库文件检索
 * - 通用系统工具（限定在成员自己的知识库目录）
 */

import { EventEmitter } from 'events';
import {
    ToolRegistry,
    ToolExecutor,
    ToolConfirmationOutcome,
    type ToolDefinition,
    type ToolResult,
} from './toolRegistry';
import {
    addChatMessage,
    type ChatMessage,
    createChatSession,
    getChatMessages,
    getChatSessionByContext,
} from '../db';
import { CalculatorTool } from './tools/calculatorTool';
import { ReadFileTool } from './tools/readFileTool';
import { ListDirTool } from './tools/listDirTool';
import { GrepTool } from './tools/grepTool';
import { BashTool } from './tools/bashTool';
import { QueryRuntime } from './queryRuntime';
import { getAgentRuntime, getLongTaskCoordinator } from './ai';

// ========== Types ==========

/**
 * 智囊团聊天配置
 */
export interface AdvisorChatConfig {
    /** API Key */
    apiKey: string;
    /** API Base URL */
    baseURL: string;
    /** 模型名称 */
    model: string;
    /** 智囊团 ID */
    advisorId: string;
    /** 智囊团名称 */
    advisorName: string;
    /** 智囊团头像 */
    advisorAvatar: string;
    /** 系统提示词 */
    systemPrompt: string;
    /** 知识库目录 */
    knowledgeDir?: string;
    /** 知识库内容语言 */
    knowledgeLanguage?: string;
    /** 最大轮次 */
    maxTurns?: number;
    /** 温度参数 */
    temperature?: number;
}

export interface AdvisorSendOptions {
    ragQuery?: string;
    discussionTask?: string;
}

/**
 * 思维链事件类型
 */
export interface ThinkingEvent {
    type: 'thinking_start' | 'thinking_chunk' | 'thinking_end' |
    'rag_start' | 'rag_result' |
    'tool_start' | 'tool_end' |
    'response_chunk' | 'response_end' |
    'error' | 'done';
    advisorId: string;
    advisorName: string;
    advisorAvatar: string;
    content?: string;
    sources?: string[];
    tool?: {
        name: string;
        params?: unknown;
        result?: { success: boolean; content: string };
    };
}

/**
 * 对话历史消息
 */
interface ChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
}

// ========== AdvisorChatService Class ==========

/**
 * 智囊团聊天服务
 */
export class AdvisorChatService extends EventEmitter {
    private config: AdvisorChatConfig;
    private toolRegistry: ToolRegistry;
    private toolExecutor: ToolExecutor;
    private abortController: AbortController | null = null;
    private readonly sessionId: string;

    constructor(config: AdvisorChatConfig) {
        super();
        this.config = config;
        this.sessionId = this.ensureSession().id;

        // 初始化工具注册表（仅包含安全工具）
        this.toolRegistry = new ToolRegistry();
        const tools: ToolDefinition<unknown, ToolResult>[] = [
            new CalculatorTool(),
        ];

        if (this.config.knowledgeDir) {
            tools.push(
                new ListDirTool(this.config.knowledgeDir),
                new GrepTool(this.config.knowledgeDir),
                new ReadFileTool(this.config.knowledgeDir),
                new BashTool(this.config.knowledgeDir),
            );
        }

        this.toolRegistry.registerTools(tools);

        // 初始化工具执行器（智囊团模式默认允许）
        this.toolExecutor = new ToolExecutor(
            this.toolRegistry,
            async () => ToolConfirmationOutcome.ProceedOnce
        );
    }

    /**
     * 发送消息
     */
    async sendMessage(
        message: string,
        history: ChatHistoryMessage[] = [],
        options: AdvisorSendOptions = {},
    ): Promise<string> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const session = this.ensureSession();
            addChatMessage({
                id: `advisor_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                session_id: session.id,
                role: 'user',
                content: message,
            });

            this.emitEvent({
                type: 'thinking_start',
                content: '正在分析问题...',
            });

            const effectiveHistory = history.length > 0 ? history : this.getStoredHistory();
            const systemPrompt = this.buildSystemPrompt(options);

            this.emitEvent({
                type: 'thinking_chunk',
                content: this.config.knowledgeDir
                    ? '先检查自己的知识库与上下文，再形成观点...'
                    : '基于角色设定和上下文进行深度思考...',
            });

            const fullResponse = await this.runAgentLoop(message, effectiveHistory, systemPrompt, signal);

            addChatMessage({
                id: `advisor_assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                session_id: session.id,
                role: 'assistant',
                content: fullResponse,
            });

            this.emitEvent({ type: 'thinking_end', content: '思考完成' });
            this.emitEvent({ type: 'done' });
            return fullResponse;
        } catch (error) {
            if (!signal.aborted) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                this.emitEvent({ type: 'error', content: errorMsg });
            }
            throw error;
        } finally {
            this.abortController = null;
        }
    }

    /**
     * 取消执行
     */
    cancel(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    /**
     * 构建系统提示词
     */
    private buildSystemPrompt(
        options: AdvisorSendOptions = {},
    ): string {
        const parts: string[] = [];

        parts.push(this.config.systemPrompt || `你是 ${this.config.advisorName}，一个专业的智囊团成员。`);

        if (String(this.config.knowledgeLanguage || '').trim()) {
            parts.push(`
## 知识库语言约束

你的知识库内容主要使用 **${String(this.config.knowledgeLanguage || '').trim()}**。

要求：
- 先按这个语言去理解、检索和匹配知识库内容。
- 如果用户问题与知识库语言不一致，也不要假设知识库是中文；先按知识库原语言理解，再决定如何回答。
- 引用或内化知识库信息时，优先忠实保留原语言语义，避免因为误判语言而检索不到内容。`);
        }

        if (this.config.knowledgeDir) {
            parts.push(`
## 你的知识库工作流

你能使用常规系统工具访问文件系统，但这些工具的工作区根目录已经被限制为你自己的知识库目录。

可用工具：
- \`grep\`：搜索相关片段，先找候选文件
- \`read_file\`：打开并精读具体文件
- \`list_dir\`：查看目录结构，适合先摸清有哪些资料
- \`bash\`：做更灵活的文件检索，例如 \`rg\`、\`find\`、\`cat\`、\`sed\`

工作要求：
- 你的知识库**不会**自动注入到上下文里，必须由你自己决定何时搜索、何时打开文件。
- 只要问题依赖事实、案例、原话、经验、数据、历史观点，先搜索再回答。
- 推荐顺序：先 \`grep\` 或 \`bash\` 搜索，再用 \`read_file\` 打开 1-3 个最相关文件，再形成观点。
- 不要假装读过没打开的文件；文件路径必须以工具返回结果为准。
- 如果没有搜到相关资料，要明确承认，不要编造。
- 如果只是寒暄、确认、很短的态度表述，可以直接回答，不必强行检索。`);
        }

        if (options.discussionTask) {
            parts.push(`
## 你的本轮分工

${options.discussionTask}

要求：
- 优先完成这项分工，不要替其他成员作答。
- 先调用你自己的经验和知识库，再输出观点。
- 最终发言必须直接回应这项分工。`);
        }

        if (String(options.ragQuery || '').trim()) {
            parts.push(`
## 当前检索焦点

如果你需要搜索知识库，优先围绕下面这些线索展开：

${String(options.ragQuery || '').trim()}`);
        }

        parts.push(`
## 思考方式 (Thinking Process)

在回答前，请像真人一样思考：
1. **意图洞察**：用户真正想问什么？（别看表面，看痛点）
2. **经验调用**：如果问题需要事实或案例，我应该先搜索哪类知识、打开哪些文件？
3. **观点形成**：基于我的性格，我怎么看这件事？支持还是反对？
4. **语言组织**：用最接地气的话说出来。`);

        parts.push(`
## 辅助能力
如果遇到需要精确计算或改写文件的情况，可以调用工具。但请记住，你的核心价值在于你的**观点**和**判断**。

如果你从知识库中读到了有效材料，请把它内化为你的经验来表达，不要写成"知识库显示"、"根据资料"这种生硬说法。`);

        return parts.join('\n\n');
    }

    private historyToRuntimeMessages(history: ChatHistoryMessage[]) {
        return history.slice(-10).map((msg) => ({
            role: msg.role,
            content: msg.content,
        })) as Array<{ role: 'user' | 'assistant'; content: string }>;
    }

    /**
     * 执行 Agent 循环
     */
    private async runAgentLoop(
        message: string,
        history: ChatHistoryMessage[],
        systemPrompt: string,
        signal: AbortSignal
    ): Promise<string> {
        let fullResponse = '';

        const analysis = getAgentRuntime().analyzeRuntimeContext({
            runtimeContext: {
                sessionId: this.sessionId,
                runtimeMode: 'advisor-discussion',
                userInput: message,
                metadata: {
                    contextType: 'advisor-discussion',
                    contextId: this.config.advisorId,
                },
            },
        });

        if (analysis.shouldUseCoordinator) {
            const prepared = await getAgentRuntime().prepareExecution({
                runtimeContext: {
                    sessionId: this.sessionId,
                    runtimeMode: 'advisor-discussion',
                    userInput: message,
                    metadata: {
                        contextType: 'advisor-discussion',
                        contextId: this.config.advisorId,
                    },
                },
                baseSystemPrompt: systemPrompt,
                llm: {
                    apiKey: this.config.apiKey,
                    baseURL: this.config.baseURL,
                    model: this.config.model,
                    timeoutMs: 45000,
                },
            });

            await getLongTaskCoordinator().maybeRun(prepared.task.id, {
                baseSystemPrompt: systemPrompt,
                onRuntimeEvent: (event) => {
                    switch (event.type) {
                        case 'thinking':
                            this.emitEvent({
                                type: 'thinking_chunk',
                                content: event.content,
                            });
                            break;
                        case 'tool_start':
                            this.emitEvent({
                                type: 'tool_start',
                                tool: { name: event.name, params: event.params },
                            });
                            break;
                        case 'tool_end':
                            this.emitEvent({
                                type: 'tool_end',
                                tool: {
                                    name: event.name,
                                    result: {
                                        success: event.result.success,
                                        content: event.result.display || event.result.llmContent || '',
                                    },
                                },
                            });
                            break;
                        case 'response_chunk':
                            fullResponse = event.content;
                            this.emitEvent({ type: 'response_chunk', content: event.content });
                            break;
                        case 'response_end':
                            fullResponse = event.content;
                            this.emitEvent({ type: 'response_end', content: event.content });
                            break;
                        case 'error':
                            this.emitEvent({ type: 'error', content: event.message });
                            break;
                        case 'done':
                            this.emitEvent({ type: 'done' });
                            break;
                        default:
                            break;
                    }
                },
            });
            return fullResponse;
        }

        const runtime = new QueryRuntime(
            this.toolRegistry,
            this.toolExecutor,
            {
                onEvent: (event) => {
                    switch (event.type) {
                        case 'thinking':
                            this.emitEvent({
                                type: 'thinking_chunk',
                                content: event.content,
                            });
                            break;
                        case 'tool_start':
                            this.emitEvent({
                                type: 'tool_start',
                                tool: { name: event.name, params: event.params },
                            });
                            break;
                        case 'tool_end':
                            this.emitEvent({
                                type: 'tool_end',
                                tool: {
                                    name: event.name,
                                    result: {
                                        success: event.result.success,
                                        content: event.result.display || event.result.llmContent || '',
                                    },
                                },
                            });
                            break;
                        case 'response_chunk':
                            fullResponse = event.content;
                            this.emitEvent({ type: 'response_chunk', content: event.content });
                            break;
                        case 'response_end':
                            fullResponse = event.content;
                            this.emitEvent({ type: 'response_end', content: event.content });
                            break;
                        case 'error':
                            this.emitEvent({ type: 'error', content: event.message });
                            break;
                        case 'done':
                            this.emitEvent({ type: 'done' });
                            break;
                        default:
                            break;
                    }
                },
            },
            {
                sessionId: this.sessionId,
                apiKey: this.config.apiKey,
                baseURL: this.config.baseURL,
                model: this.config.model,
                systemPrompt,
                messages: this.historyToRuntimeMessages(history),
                signal,
                maxTurns: this.config.maxTurns || 8,
                maxTimeMinutes: 6,
                temperature: this.config.temperature ?? 0.7,
                toolPack: 'chatroom',
                runtimeMode: 'advisor-discussion',
                interactive: true,
                requiresHumanApproval: Boolean(analysis.route.requiresHumanApproval),
            },
        );

        const result = await runtime.run(message);
        if (result.error) {
            throw new Error(result.error);
        }
        fullResponse = result.response || fullResponse;
        return fullResponse;
    }

    private ensureSession() {
        const existing = getChatSessionByContext(this.config.advisorId, 'advisor-discussion');
        if (existing) {
            return existing;
        }
        return createChatSession(`advisor_${this.config.advisorId}_${Date.now()}`, `Advisor ${this.config.advisorName}`, {
            contextType: 'advisor-discussion',
            contextId: this.config.advisorId,
        });
    }

    private getStoredHistory(): ChatHistoryMessage[] {
        return getChatMessages(this.sessionId)
            .filter((msg): msg is ChatMessage & { role: 'user' | 'assistant' } => msg.role === 'user' || msg.role === 'assistant')
            .slice(-10)
            .map((msg) => ({
                role: msg.role,
                content: msg.content,
            })) as ChatHistoryMessage[];
    }

    /**
     * 发送事件
     */
    private emitEvent(partial: Omit<ThinkingEvent, 'advisorId' | 'advisorName' | 'advisorAvatar'>): void {
        const event: ThinkingEvent = {
            ...partial,
            advisorId: this.config.advisorId,
            advisorName: this.config.advisorName,
            advisorAvatar: this.config.advisorAvatar,
        };
        this.emit(partial.type, event);
        this.emit('event', event);
    }
}

/**
 * 创建智囊团聊天服务实例
 */
export function createAdvisorChatService(config: AdvisorChatConfig): AdvisorChatService {
    return new AdvisorChatService(config);
}
