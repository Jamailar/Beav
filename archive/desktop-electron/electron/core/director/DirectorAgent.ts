/**
 * DirectorAgent - 总监角色Agent
 *
 * 在群聊中担任主持人角色，负责：
 * 1. 分析用户问题并延伸讨论
 * 2. 引导成员发言
 * 3. 对比总结所有观点
 *
 * 不再依赖 LangChain，使用 OpenAI 直接 API
 */

import { EventEmitter } from 'events';
import { loadPrompt, renderPrompt } from '../../prompts/runtime';

// ========== Types ==========

export interface DirectorConfig {
    apiKey: string;
    baseURL: string;
    model: string;
    temperature?: number;
}

export interface DirectorEvent {
    type: 'thinking_start' | 'thinking_chunk' | 'thinking_end' |
          'response_chunk' | 'response_end' | 'error' | 'done';
    advisorId: string;
    advisorName: string;
    advisorAvatar: string;
    content?: string;
}

export interface ConversationMessage {
    role: 'user' | 'assistant' | 'director';
    advisorId?: string;
    advisorName?: string;
    content: string;
}

// ========== Director System Config ==========

export const DIRECTOR_ID = 'director-system';
export const DIRECTOR_NAME = '总监';
export const DIRECTOR_AVATAR = '🎯';

// ========== Prompts ==========

const DIRECTOR_INTRODUCTION_PROMPT_TEMPLATE = loadPrompt(
    'runtime/director/introduction.txt',
    '你是【{{goal}}】这个项目的内容总监。'
);

const DIRECTOR_SUMMARY_PROMPT_TEMPLATE = loadPrompt(
    'runtime/director/summary.txt',
    '你是【{{goal}}】这个项目的内容总监，请给出决策汇报。'
);

const MAX_DIRECTOR_FILE_CONTEXT_CHARS = 6000;
const MAX_DIRECTOR_HISTORY_CHARS = 240;

function truncateDirectorContext(content: string, limit: number): string {
    if (content.length <= limit) {
        return content;
    }

    const head = content.slice(0, Math.floor(limit * 0.7));
    const tail = content.slice(-(Math.floor(limit * 0.2)));
    return `${head}\n\n...[内容过长，已截断]...\n\n${tail}`;
}

// ========== DirectorAgent Class ==========

export class DirectorAgent extends EventEmitter {
    private config: DirectorConfig;
    private abortController: AbortController | null = null;

    constructor(config: DirectorConfig) {
        super();
        this.config = config;
    }

    /**
     * 发起讨论 - 分析用户问题并设定讨论方向
     */
    async introduceDiscussion(
        userMessage: string,
        advisorNames: string[],
        discussionGoal: string = '',
        historyContext: { role: 'user' | 'assistant'; content: string }[] = [],
        fileContext?: { filePath: string; fileContent: string },
        coordinationBrief?: string,
    ): Promise<string> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            this.emitEvent({ type: 'thinking_start', content: '正在分析问题...' });

            // 构建包含群聊目标的提示
            let goalContext = discussionGoal
                ? `\n\n## 🎯 群聊目标\n\n本群的讨论目标是：**${discussionGoal}**\n\n请务必围绕此目标来分析用户的问题，你的开场和引导都应该服务于这个目标。`
                : '';
            if (coordinationBrief) {
                goalContext += `\n\n## 协调规划\n以下是协调代理生成的讨论框架，请在主持时参考：\n${coordinationBrief}`;
            }

            // 构建文件上下文提示
            if (fileContext) {
                const filePreview = truncateDirectorContext(fileContext.fileContent, MAX_DIRECTOR_FILE_CONTEXT_CHARS);
                goalContext += `\n\n## 📄 当前编辑的文件\n\n用户正在编辑文件：\`${fileContext.filePath}\`\n\n文件重点片段如下：\n\`\`\`\n${filePreview}\n\`\`\`\n\n你的分析必须结合当前文件内容。如果用户的意图是修改文件，请在后续的子问题中引导成员关注如何修改。`;
            }

            // 构建历史上下文摘要
            const historySection = historyContext.length > 0
                ? `\n\n## 📜 之前的对话历史\n\n以下是之前的讨论记录，请参考这些上下文来理解当前问题：\n\n${historyContext.slice(-6).map(m => `${m.role === 'user' ? '用户' : '回复'}：${truncateDirectorContext(m.content, MAX_DIRECTOR_HISTORY_CHARS)}`).join('\n\n')}\n\n---\n\n`
                : '';

            const systemPrompt = renderPrompt(DIRECTOR_INTRODUCTION_PROMPT_TEMPLATE, {
                goal: discussionGoal || '当前项目',
            });

            const userContent = `${historySection}用户问题：${userMessage}\n\n可分派成员名单（只能使用这些名字，禁止改写、缩写或新增角色）：\n${advisorNames.map((name, index) => `${index + 1}. ${name}`).join('\n')}\n\n输出要求：任务分派部分必须逐行使用“@顾问名：问题；期望产出：...”`;

            const fullResponse = await this.streamChat(
                [{ role: 'system', content: systemPrompt + goalContext }, { role: 'user', content: userContent }],
                signal
            );

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
     * 总结讨论 - 对比分析所有成员的观点
     */
    async summarizeDiscussion(
        userMessage: string,
        conversationHistory: ConversationMessage[],
        discussionGoal: string = '',
        fileContext?: { filePath: string; fileContent: string },
        coordinationBrief?: string,
    ): Promise<string> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            this.emitEvent({ type: 'thinking_start', content: '正在综合分析各方观点...' });

            // 构建讨论历史文本
            const discussionText = conversationHistory
                .filter(m => m.role === 'assistant' && m.advisorName)
                .map(m => `【${m.advisorName}】\n${m.content}`)
                .join('\n\n---\n\n');

            let systemPrompt = renderPrompt(DIRECTOR_SUMMARY_PROMPT_TEMPLATE, {
                goal: discussionGoal || '当前项目',
            });
            if (coordinationBrief) {
                systemPrompt += `\n\n## 协调规划\n请结合以下规划对团队观点做最终归纳：\n${coordinationBrief}`;
            }
            if (fileContext) {
                systemPrompt += `\n\n## 📄 当前编辑的文件\n用户正在编辑文件：\`${fileContext.filePath}\`\n如果讨论结果包含对文件的具体修改建议，请在总结中明确指出。`;
            }

            const userContent = `原始问题：${userMessage}\n\n团队讨论内容：\n\n${discussionText}`;

            const fullResponse = await this.streamChat(
                [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
                signal
            );

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
     * 流式聊天
     */
    private async streamChat(
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
        signal: AbortSignal
    ): Promise<string> {
        const baseURL = normalizeApiBaseUrl(this.config.baseURL || 'https://api.openai.com/v1', 'https://api.openai.com/v1');
        const model = this.config.model || 'gpt-4o';
        const temperature = this.config.temperature ?? 0.7;

        this.emitEvent({ type: 'thinking_end', content: '分析完成' });

        const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify({
                model,
                temperature,
                stream: true,
                messages
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
        }

        if (!response.body) {
            throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let buffer = '';

        try {
            while (true) {
                if (signal.aborted) break;

                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;

                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') {
                        this.emitEvent({ type: 'response_end', content: fullResponse });
                        this.emitEvent({ type: 'done' });
                        return fullResponse;
                    }

                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content || '';
                        if (content) {
                            fullResponse += content;
                            this.emitEvent({ type: 'response_chunk', content });
                        }
                    } catch {
                        // Ignore parse errors for incomplete chunks
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        this.emitEvent({ type: 'response_end', content: fullResponse });
        this.emitEvent({ type: 'done' });

        return fullResponse;
    }

    /**
     * 取消当前执行
     */
    cancel(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    /**
     * 发送事件
     */
    private emitEvent(partial: Omit<DirectorEvent, 'advisorId' | 'advisorName' | 'advisorAvatar'>): void {
        const event: DirectorEvent = {
            ...partial,
            advisorId: DIRECTOR_ID,
            advisorName: DIRECTOR_NAME,
            advisorAvatar: DIRECTOR_AVATAR,
        };
        this.emit(partial.type, event);
        this.emit('event', event);
    }
}

/**
 * 创建 DirectorAgent 实例
 */
export function createDirectorAgent(config: DirectorConfig): DirectorAgent {
    return new DirectorAgent(config);
}
import { normalizeApiBaseUrl, safeUrlJoin } from '../urlUtils';
