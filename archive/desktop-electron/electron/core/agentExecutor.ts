import { Instance } from './instance';
import { buildDefaultSystemPrompt } from './prompts/defaultPromptBuilder';
import { QueryRuntime } from './queryRuntime';
import { SkillManager } from './skillManager';
import {
    ToolRegistry,
    ToolExecutor,
    type ToolCallResponse,
    type ToolConfirmationDetails,
    ToolConfirmationOutcome,
} from './toolRegistry';
import { createBuiltinTools } from './tools';
import type { RuntimeEvent } from './runtimeTypes';

export interface AgentConfig {
    apiKey: string;
    baseURL: string;
    model: string;
    maxTurns?: number;
    maxTimeMinutes?: number;
    projectRoot?: string;
    temperature?: number;
}

export type AgentEvent =
    | { type: 'thinking'; content: string }
    | { type: 'thought_chunk'; content: string }
    | { type: 'tool_start'; callId: string; name: string; params: unknown; description: string }
    | { type: 'tool_end'; callId: string; name: string; result: { success: boolean; content: string } }
    | { type: 'tool_output'; callId: string; chunk: string }
    | { type: 'tool_confirm_request'; callId: string; name: string; details: ToolConfirmationDetails }
    | { type: 'response_chunk'; content: string }
    | { type: 'response_end'; content: string }
    | { type: 'skill_activated'; name: string; description: string }
    | { type: 'error'; message: string }
    | { type: 'done'; summary?: string };

interface PendingConfirmation {
    callId: string;
    resolve: (outcome: ToolConfirmationOutcome) => void;
}

const nextLegacySessionId = () => `legacy_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export class AgentExecutor {
    private readonly toolRegistry: ToolRegistry;
    private readonly toolExecutor: ToolExecutor;
    private readonly skillManager: SkillManager;
    private abortController: AbortController | null = null;
    private pendingConfirmations: Map<string, PendingConfirmation> = new Map();

    constructor(
        private readonly config: AgentConfig,
        private readonly onEvent: (event: AgentEvent) => void,
    ) {
        this.skillManager = new SkillManager();
        this.toolRegistry = new ToolRegistry();
        this.toolRegistry.registerTools(createBuiltinTools({
            pack: 'redclaw',
            skillManager: this.skillManager,
            onSkillActivated: (payload) => {
                this.onEvent({
                    type: 'skill_activated',
                    name: payload.name,
                    description: payload.description,
                });
            },
        }));
        this.toolExecutor = new ToolExecutor(
            this.toolRegistry,
            this.handleConfirmRequest.bind(this),
        );
    }

    async initialize(): Promise<void> {
        if (this.config.projectRoot) {
            Instance.init(this.config.projectRoot);
        }
        await this.skillManager.discoverSkills(this.config.projectRoot);
    }

    async run(message: string): Promise<void> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        const preactivatedSkills = await this.skillManager.preactivateMentionedSkills(message);
        for (const item of preactivatedSkills) {
            this.onEvent({
                type: 'skill_activated',
                name: item.skill.name,
                description: item.skill.description,
            });
        }
        const runtime = new QueryRuntime(
            this.toolRegistry,
            this.toolExecutor,
            {
                onEvent: (event) => this.handleRuntimeEvent(event),
                onToolResult: (toolName, result) => this.handleToolResult(toolName, result),
            },
            {
                sessionId: nextLegacySessionId(),
                apiKey: this.config.apiKey,
                baseURL: this.config.baseURL,
                model: this.config.model,
                systemPrompt: await buildDefaultSystemPrompt({
                    skills: this.skillManager.getSkills(),
                    tools: this.toolRegistry.getAllTools(),
                    activatedSkillContent: this.skillManager.getActiveSkillContents().join('\n\n'),
                    interactive: true,
                }),
                messages: [],
                signal,
                maxTurns: this.config.maxTurns,
                maxTimeMinutes: this.config.maxTimeMinutes,
                temperature: this.config.temperature,
                toolPack: 'redclaw',
                runtimeMode: 'redclaw',
                interactive: true,
                requiresHumanApproval: false,
            },
        );

        try {
            const result = await runtime.run(message);
            if (result.error && !signal.aborted) {
                this.onEvent({ type: 'error', message: result.error });
            }
        } finally {
            this.abortController = null;
        }
    }

    confirmToolCall(callId: string, outcome: ToolConfirmationOutcome): void {
        const pending = this.pendingConfirmations.get(callId);
        if (!pending) {
            return;
        }
        this.pendingConfirmations.delete(callId);
        pending.resolve(outcome);
    }

    cancel(): void {
        this.abortController?.abort();
    }

    getToolRegistry(): ToolRegistry {
        return this.toolRegistry;
    }

    getSkillManager(): SkillManager {
        return this.skillManager;
    }

    private async handleConfirmRequest(
        callId: string,
        tool: { name: string },
        _params: unknown,
        details: ToolConfirmationDetails,
    ): Promise<ToolConfirmationOutcome> {
        return new Promise((resolve) => {
            this.pendingConfirmations.set(callId, { callId, resolve });
            this.onEvent({
                type: 'tool_confirm_request',
                callId,
                name: tool.name,
                details,
            });
            setTimeout(() => {
                const pending = this.pendingConfirmations.get(callId);
                if (!pending) {
                    return;
                }
                this.pendingConfirmations.delete(callId);
                pending.resolve(ToolConfirmationOutcome.Cancel);
            }, 60000);
        });
    }

    private handleRuntimeEvent(event: RuntimeEvent): void {
        switch (event.type) {
            case 'thinking':
                this.onEvent({ type: 'thinking', content: event.content });
                this.onEvent({ type: 'thought_chunk', content: event.content });
                break;
            case 'tool_start':
                this.onEvent({
                    type: 'tool_start',
                    callId: event.callId,
                    name: event.name,
                    params: event.params,
                    description: event.description,
                });
                break;
            case 'tool_output':
                this.onEvent({
                    type: 'tool_output',
                    callId: event.callId,
                    chunk: event.chunk,
                });
                break;
            case 'tool_end':
                this.onEvent({
                    type: 'tool_end',
                    callId: event.callId,
                    name: event.name,
                    result: {
                        success: event.result.success,
                        content: event.result.display || event.result.llmContent,
                    },
                });
                break;
            case 'tool_summary':
                this.onEvent({
                    type: 'tool_output',
                    callId: `summary_${Date.now()}`,
                    chunk: event.content,
                });
                break;
            case 'response_chunk':
                this.onEvent({ type: 'response_chunk', content: event.content });
                break;
            case 'response_end':
                this.onEvent({ type: 'response_end', content: event.content });
                break;
            case 'error':
                this.onEvent({ type: 'error', message: event.message });
                break;
            case 'done':
                this.onEvent({ type: 'done', summary: event.response });
                break;
            case 'compact_start':
                this.onEvent({ type: 'thinking', content: `Compacting context (${event.strategy})...` });
                break;
            case 'compact_end':
                if (event.summary) {
                    this.onEvent({ type: 'thinking', content: event.summary });
                }
                break;
            case 'checkpoint':
                this.onEvent({ type: 'thinking', content: event.summary });
                break;
            case 'query_start':
            case 'hook_start':
            case 'hook_end':
                break;
        }
    }

    private handleToolResult(toolName: string, response: ToolCallResponse['result']): void {
        if (toolName !== 'skill') {
            return;
        }
        const content = response.llmContent || response.display || '';
        this.onEvent({
            type: 'skill_activated',
            name: toolName,
            description: content.slice(0, 240),
        });
    }
}

export async function createAgentExecutor(
    config: AgentConfig,
    onEvent: (event: AgentEvent) => void,
): Promise<AgentExecutor> {
    const executor = new AgentExecutor(config, onEvent);
    await executor.initialize();
    return executor;
}
