/**
 * ChatService - 通用聊天服务（pi-agent-core 迁移兼容版）
 *
 * 说明：
 * - 旧版依赖 LangChain/LangGraph，现已移除。
 * - 当前主流程已由 PiChatService 承接，此类保留给旧调用方与类型导出。
 */

import { EventEmitter } from 'events';
import {
    addChatMessage,
    createChatSession,
    getChatMessages,
    getChatSession,
    getChatSessionByContext,
} from '../db';
import { buildDefaultSystemPrompt } from './prompts/defaultPromptBuilder';
import { QueryRuntime } from './queryRuntime';
import {
    ToolRegistry,
    ToolExecutor,
    type ToolConfirmationDetails,
    ToolConfirmationOutcome,
} from './toolRegistry';
import { SkillManager } from './skillManager';
import { createBuiltinTools } from './tools';
import { Instance } from './instance';
import type { RuntimeEvent } from './runtimeTypes';

// ========== Types ==========

export interface ChatServiceConfig {
    apiKey: string;
    baseURL: string;
    model: string;
    maxTurns?: number;
    maxTimeMinutes?: number;
    projectRoot?: string;
    temperature?: number;
    streaming?: boolean;
    compressionThreshold?: number;
}

export enum StreamingState {
    Idle = 'idle',
    Responding = 'responding',
    WaitingConfirmation = 'waiting_confirmation',
}

export interface HistoryItem {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    timestamp: number;
    toolCalls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
    }>;
    toolCallId?: string;
}

export interface ChatServiceEvents {
    'state_change': (state: StreamingState) => void;
    'thinking': (content: string) => void;
    'response_chunk': (content: string) => void;
    'response_end': (content: string) => void;
    'tool_start': (data: { callId: string; name: string; params: unknown; description: string }) => void;
    'tool_end': (data: { callId: string; name: string; result: { success: boolean; content: string } }) => void;
    'tool_output': (data: { callId: string; chunk: string }) => void;
    'tool_confirm_request': (data: { callId: string; name: string; details: ToolConfirmationDetails }) => void;
    'skill_activated': (data: { name: string; description: string }) => void;
    'history_updated': (history: HistoryItem[]) => void;
    'error': (error: { message: string; recoverable?: boolean }) => void;
    'done': () => void;
}

// ========== ChatService ==========

export class ChatService extends EventEmitter {
    private config: ChatServiceConfig;
    private toolRegistry: ToolRegistry;
    private toolExecutor: ToolExecutor;
    private skillManager: SkillManager;

    private streamingState: StreamingState = StreamingState.Idle;
    private messageQueue: string[] = [];
    private history: HistoryItem[] = [];
    private abortController: AbortController | null = null;
    private readonly pendingConfirmations = new Map<string, { resolve: (outcome: ToolConfirmationOutcome) => void; timeoutId: NodeJS.Timeout }>();
    private readonly sessionId: string;

    constructor(config: ChatServiceConfig) {
        super();
        this.config = config;
        this.sessionId = `legacy_chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.skillManager = new SkillManager();

        this.toolRegistry = new ToolRegistry();
        this.toolRegistry.registerTools(createBuiltinTools({
            chatService: this,
            skillManager: this.skillManager,
            onSkillActivated: (payload) => this.emit('skill_activated', payload),
            pack: 'redclaw',
        }));

        this.toolExecutor = new ToolExecutor(
            this.toolRegistry,
            this.handleConfirmRequest.bind(this)
        );
        if (config.projectRoot) {
            Instance.init(config.projectRoot);
        }
    }

    async initialize(): Promise<void> {
        await this.skillManager.discoverSkills(this.config.projectRoot);
        this.ensureSession();
        const stored = getChatMessages(this.sessionId)
            .filter((msg) => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'system')
            .map((msg) => ({
                id: msg.id,
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp,
                toolCallId: msg.tool_call_id,
            })) as HistoryItem[];
        if (stored.length > 0) {
            this.history = stored;
            this.emit('history_updated', this.getHistory());
        }
    }

    async sendMessage(message: string): Promise<void> {
        const trimmed = message.trim();
        if (!trimmed) return;

        if (this.streamingState !== StreamingState.Idle) {
            this.messageQueue.push(trimmed);
            return;
        }

        await this.processMessage(trimmed);
    }

    async restoreHistory(history: HistoryItem[]): Promise<void> {
        this.history = [...history];
        this.emit('history_updated', this.getHistory());
    }

    cancel(): void {
        this.abortController?.abort();
        this.setStreamingState(StreamingState.Idle);
    }

    confirmToolCall(callId: string, outcome: ToolConfirmationOutcome): void {
        const pending = this.pendingConfirmations.get(callId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.pendingConfirmations.delete(callId);
        pending.resolve(outcome);
    }

    getHistory(): HistoryItem[] {
        return [...this.history];
    }

    clearHistory(): void {
        this.history = [];
        this.emit('history_updated', this.getHistory());
    }

    getState(): StreamingState {
        return this.streamingState;
    }

    getToolRegistry(): ToolRegistry {
        return this.toolRegistry;
    }

    getSkillManager(): SkillManager {
        return this.skillManager;
    }

    private async processMessage(message: string): Promise<void> {
        try {
            this.setStreamingState(StreamingState.Responding);
            this.emit('thinking', 'Processing your request...');

            this.addHistoryItem({ role: 'user', content: message });
            const preactivatedSkills = await this.skillManager.preactivateMentionedSkills(message);
            for (const item of preactivatedSkills) {
                this.emit('skill_activated', {
                    name: item.skill.name,
                    description: item.skill.description,
                });
            }
            this.abortController = new AbortController();
            const runtime = new QueryRuntime(
                this.toolRegistry,
                this.toolExecutor,
                {
                    onEvent: (event) => this.handleRuntimeEvent(event),
                    onToolResult: () => undefined,
                },
                {
                    sessionId: this.sessionId,
                    apiKey: this.config.apiKey,
                    baseURL: this.config.baseURL,
                    model: this.config.model,
                    systemPrompt: await buildDefaultSystemPrompt({
                        skills: this.skillManager.getSkills(),
                        tools: this.toolRegistry.getAllTools(),
                        activatedSkillContent: this.skillManager.getActiveSkillContents().join('\n\n'),
                        interactive: true,
                    }),
                    messages: this.historyToRuntimeMessages(),
                    signal: this.abortController.signal,
                maxTurns: this.config.maxTurns,
                maxTimeMinutes: this.config.maxTimeMinutes,
                temperature: this.config.temperature,
                toolPack: 'redclaw',
                runtimeMode: 'redclaw',
                interactive: true,
                requiresHumanApproval: false,
            },
        );

            const result = await runtime.run(message);
            if (result.error && !this.abortController.signal.aborted) {
                this.emit('error', { message: result.error, recoverable: false });
            }
            this.emit('done');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.emit('error', { message: msg, recoverable: false });
        } finally {
            this.abortController = null;
            this.setStreamingState(StreamingState.Idle);
            this.processQueuedMessages();
        }
    }

    private historyToRuntimeMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
        return this.history
            .slice(-12)
            .filter((h): h is HistoryItem & { role: 'user' | 'assistant' } => h.role === 'user' || h.role === 'assistant')
            .map((h) => ({
                role: h.role,
                content: h.content,
            }));
    }

    private handleRuntimeEvent(event: RuntimeEvent): void {
        switch (event.type) {
            case 'thinking':
                this.emit('thinking', event.content);
                break;

            case 'response_chunk':
                this.emit('response_chunk', event.content);
                break;

            case 'response_end':
                this.addHistoryItem({ role: 'assistant', content: event.content });
                this.emit('response_end', event.content);
                break;

            case 'tool_start':
                this.emit('tool_start', {
                    callId: event.callId,
                    name: event.name,
                    params: event.params,
                    description: event.description,
                });
                break;

            case 'tool_output':
                this.emit('tool_output', { callId: event.callId, chunk: event.chunk });
                break;

            case 'tool_end':
                this.addHistoryItem({
                    role: 'tool',
                    content: event.result.display || event.result.llmContent || '',
                    toolCallId: event.callId,
                });
                this.emit('tool_end', {
                    callId: event.callId,
                    name: event.name,
                    result: event.result,
                });
                break;

            case 'error':
                this.emit('error', { message: event.message, recoverable: false });
                break;
            case 'checkpoint':
                this.emit('thinking', event.summary);
                break;
            case 'compact_start':
                this.emit('thinking', `Compacting context (${event.strategy})...`);
                break;
            case 'compact_end':
                if (event.summary) {
                    this.emit('thinking', event.summary);
                }
                break;
            case 'query_start':
            case 'hook_start':
            case 'hook_end':
            case 'tool_summary':
            case 'done':
                break;
        }
    }

    private async handleConfirmRequest(
        callId: string,
        tool: { name: string },
        _params: unknown,
        details: ToolConfirmationDetails
    ): Promise<ToolConfirmationOutcome> {
        this.setStreamingState(StreamingState.WaitingConfirmation);
        this.emit('tool_confirm_request', {
            callId,
            name: tool.name,
            details,
        });
        return await new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                this.pendingConfirmations.delete(callId);
                resolve(ToolConfirmationOutcome.Cancel);
            }, 60000);
            this.pendingConfirmations.set(callId, { resolve, timeoutId });
        });
    }

    private processQueuedMessages(): void {
        if (this.messageQueue.length === 0 || this.streamingState !== StreamingState.Idle) {
            return;
        }
        const next = this.messageQueue.shift();
        if (next) {
            void this.processMessage(next);
        }
    }

    private setStreamingState(state: StreamingState): void {
        if (this.streamingState !== state) {
            this.streamingState = state;
            this.emit('state_change', state);
        }
    }

    private addHistoryItem(item: Omit<HistoryItem, 'id' | 'timestamp'>): void {
        const historyItem: HistoryItem = {
            ...item,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            timestamp: Date.now(),
        };
        this.history.push(historyItem);
        this.ensureSession();
        addChatMessage({
            id: historyItem.id,
            session_id: this.sessionId,
            role: historyItem.role,
            content: historyItem.content,
            tool_call_id: historyItem.toolCallId,
        });
        this.emit('history_updated', this.getHistory());
    }

    private ensureSession(): void {
        if (getChatSession(this.sessionId)) {
            return;
        }
        createChatSession(this.sessionId, 'Legacy Chat', {
            contextType: 'legacy-chat',
            contextId: this.sessionId,
        });
    }
}

// ========== Factory ==========

export async function createChatService(config: ChatServiceConfig): Promise<ChatService> {
    const service = new ChatService(config);
    await service.initialize();
    return service;
}
