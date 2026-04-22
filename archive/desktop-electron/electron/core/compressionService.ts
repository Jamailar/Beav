/**
 * Compression Service - 上下文压缩服务
 *
 * 当对话历史过长时，自动压缩上下文以避免超出 Token 限制
 * 不再依赖 LangChain，使用 OpenAI 直接 API
 */

import { getSettings } from '../db';
import { loadPrompt } from '../prompts/runtime';

// ========== Types ==========

export interface CompressionConfig {
    /** API Key */
    apiKey: string;
    /** API Base URL */
    baseURL: string;
    /** 压缩使用的模型 */
    model: string;
    /** Token 阈值，超过此值触发压缩 */
    threshold?: number;
}

export interface CompressionResult {
    /** 压缩后的消息（简单对象数组） */
    compressedMessages: { role: string; content: string }[];
    /** 原始消息数量 */
    originalCount: number;
    /** 是否进行了压缩 */
    wasCompressed: boolean;
    /** 压缩摘要 */
    summary?: string;
}

// ========== Compression Prompt ==========

const COMPRESSION_PROMPT = loadPrompt(
    'runtime/compression/context_snapshot.txt',
    'You are a component that summarizes chat history into a concise, structured snapshot.'
);

// ========== Helper Functions ==========

/**
 * 估算消息的 Token 数量（简化版）
 * 实际项目中应使用 tiktoken 等库
 */
function estimateTokens(messages: { role: string; content: string }[]): number {
    let total = 0;
    for (const msg of messages) {
        const content = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        // 粗略估算：4 字符 ≈ 1 token
        total += Math.ceil(content.length / 4);
    }
    return total;
}

/**
 * 从各种消息格式提取 role 和 content
 */
function extractMessageInfo(msg: any): { role: string; content: string } {
    // 处理 LangChain BaseMessage
    if (msg._getType) {
        const type = msg._getType();
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return { role: type, content };
    }
    // 处理普通对象
    if (msg.role && msg.content) {
        return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
    }
    // 兜底
    return { role: 'unknown', content: JSON.stringify(msg) };
}

/**
 * 压缩服务类
 */
export class CompressionService {
    private config: CompressionConfig;

    constructor(config: CompressionConfig) {
        this.config = config;
    }

    /**
     * 检查是否需要压缩（支持 BaseMessage 或普通对象）
     */
    needsCompression(messages: any[]): boolean {
        const threshold = this.config.threshold || 50000; // 默认 50k tokens
        const simpleMessages = messages.map(extractMessageInfo);
        return estimateTokens(simpleMessages) > threshold;
    }

    /**
     * 压缩消息历史
     */
    async compress(messages: any[]): Promise<CompressionResult> {
        const originalCount = messages.length;

        if (!this.needsCompression(messages)) {
            return {
                compressedMessages: messages.map(extractMessageInfo),
                originalCount,
                wasCompressed: false,
            };
        }

        try {
            // 提取消息内容
            const extractedMessages = messages.map(extractMessageInfo);

            // 构建压缩请求
            const historyText = extractedMessages
                .map((msg, i) => `[${i + 1}] ${msg.role}: ${msg.content}`)
                .join('\n\n');

            // 使用 OpenAI 直接 API
            const baseURL = normalizeApiBaseUrl(this.config.baseURL, 'https://api.openai.com/v1');
            const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    model: this.config.model,
                    temperature: 0,
                    messages: [
                        { role: 'system', content: COMPRESSION_PROMPT },
                        { role: 'user', content: `Please compress the following conversation history:\n\n${historyText}` }
                    ]
                })
            });

            if (!response.ok) {
                throw new Error(`Compression API error: ${response.status}`);
            }

            const data = await response.json() as { choices?: { message: { content: string } }[] };
            const summary = data.choices?.[0]?.message?.content || '';

            // 创建压缩后的消息列表
            // 保留系统消息（如果存在），用压缩摘要替换历史
            const systemMessage = extractedMessages.find(m => m.role === 'system');
            const compressedMessages: { role: string; content: string }[] = [];

            if (systemMessage) {
                compressedMessages.push(systemMessage);
            }

            // 添加压缩摘要作为系统消息
            compressedMessages.push({
                role: 'system',
                content: `# Compressed Conversation History

The following is a compressed summary of the previous conversation:

${summary}

Continue assisting the user based on this context.`
            });

            // 保留最近的几条消息（保持上下文连贯性）
            const recentMessages = extractedMessages.slice(-4).filter(m => m.role !== 'system');
            compressedMessages.push(...recentMessages);

            return {
                compressedMessages,
                originalCount,
                wasCompressed: true,
                summary,
            };
        } catch (error) {
            console.error('Compression failed:', error);
            // 压缩失败时返回原始消息
            return {
                compressedMessages: messages.map(extractMessageInfo),
                originalCount,
                wasCompressed: false,
            };
        }
    }
}

/**
 * 创建压缩服务实例
 */
export function createCompressionService(config: CompressionConfig): CompressionService {
    return new CompressionService(config);
}
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
