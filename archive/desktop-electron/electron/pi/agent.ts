/**
 * PiAgent - 基于 pi-agent-core 的统一 AI 服务
 *
 * 这是一个基础版本，用于替换 LangChain
 */

import { Agent, type AgentTool, type AgentEvent } from '@mariozechner/pi-agent-core';
import { Type, getModel, type Model } from '@mariozechner/pi-ai';
import { getSettings } from '../db';
import { resolveChatMaxTokens } from '../core/chatTokenConfig';
import { normalizeApiBaseUrl } from '../core/urlUtils';

// ========== 类型定义 ==========

/**
 * 流事件类型
 */
export type StreamEventType =
  | 'agent_start'
  | 'agent_end'
  | 'turn_start'
  | 'turn_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'
  | 'thinking'
  | 'content';

/**
 * 流事件
 */
export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  message?: string;
  reasoning?: string;
}

/**
 * PiAgent 配置
 */
export interface PiAgentConfig {
  /** 模型名称 */
  model?: string;
  /** API Key */
  apiKey?: string;
  /** API Base URL */
  baseURL?: string;
  /** 最大轮次 */
  maxTurns?: number;
  /** 最大执行时间（分钟） */
  maxTimeMinutes?: number;
  /** 温度参数 */
  temperature?: number;
  /** 是否启用流式输出 */
  streaming?: boolean;
  /** 系统提示 */
  systemPrompt?: string;
}

/**
 * 工具适配器
 */
export interface ToolAdapter {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    content: { type: 'text'; text: string }[];
    details: unknown;
  }>;
}

// ========== 工具注册表 ==========

const toolRegistry = new Map<string, ToolAdapter>();

/**
 * 注册工具
 */
export function registerTool(tool: ToolAdapter): void {
  toolRegistry.set(tool.name, tool);
}

/**
 * 获取所有已注册的工具
 */
export function getTools(): ToolAdapter[] {
  return Array.from(toolRegistry.values());
}

/**
 * 根据名称获取工具
 */
export function getTool(name: string): ToolAdapter | undefined {
  return toolRegistry.get(name);
}

/**
 * 清除所有工具
 */
export function clearTools(): void {
  toolRegistry.clear();
}

// ========== Agent 管理器 ==========

interface AgentSession {
  agent: Agent;
  config: PiAgentConfig;
}

class AgentManager {
  private agents = new Map<string, AgentSession>();

  /**
   * 获取或创建 Agent 实例
   */
  getOrCreate(sessionId: string, config: PiAgentConfig = {}): Agent {
    let session = this.agents.get(sessionId);

    if (!session) {
      const agent = this.createAgent(config);
      session = { agent, config };
      this.agents.set(sessionId, session);
    }

    return session.agent;
  }

  /**
   * 创建新的 Agent 实例
   */
  private createAgent(config: PiAgentConfig): Agent {
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = config.apiKey || (settings.api_key as string) || (settings.openaiApiKey as string) || process.env.OPENAI_API_KEY || '';
    const baseURL = normalizeApiBaseUrl(
      config.baseURL || (settings.api_endpoint as string) || (settings.openaiApiBase as string) || 'https://api.openai.com/v1',
      'https://api.openai.com/v1',
    );
    const modelName = config.model || (settings.model_name as string) || (settings.openaiModel as string) || 'gpt-4o';
    const systemPrompt = config.systemPrompt || `你是一个智能助手，擅长分析和解决问题。
你可以使用各种工具来帮助用户完成任务。
请始终用中文回复，除非用户要求用其他语言。`;

    const tools = this.getPiAgentTools();

    const agent = new Agent({
      initialState: {
        model: this.createModelWithBaseUrl(modelName, baseURL, settings),
        thinkingLevel: 'low',
      },
      convertToLlm: (messages) => this.convertMessages(messages),
      transformContext: async (messages) => messages,
      getApiKey: async () => apiKey,
    });

    agent.setSystemPrompt(systemPrompt);

    if (tools.length > 0) {
      agent.setTools(tools);
    }

    return agent;
  }

  private createModelWithBaseUrl(modelName: string, baseURL: string, settings?: Record<string, unknown>): Model<any> {
    const requestedModel = (modelName || 'gpt-4o').trim();
    const resolvedBaseUrl = normalizeApiBaseUrl(baseURL || 'https://api.openai.com/v1', 'https://api.openai.com/v1');
    const isOfficialOpenAI = this.isOfficialOpenAIEndpoint(resolvedBaseUrl);

    if (isOfficialOpenAI) {
      const resolved = getModel('openai', requestedModel as any) as (Model<any> & { baseUrl?: string }) | undefined;
      if (resolved) {
        return {
          ...resolved,
          baseUrl: resolvedBaseUrl || resolved.baseUrl,
        };
      }

      const fallback = getModel('openai', 'gpt-4o' as any) as (Model<any> & { baseUrl?: string }) | undefined;
      if (fallback) {
        console.warn(`[PiAgent] Unknown OpenAI model "${requestedModel}", fallback to gpt-4o`);
        return {
          ...fallback,
          baseUrl: resolvedBaseUrl || fallback.baseUrl,
        };
      }
    }

    const lower = `${requestedModel} ${resolvedBaseUrl}`.toLowerCase();
    const isQwenFamily = lower.includes('qwen') || lower.includes('dashscope.aliyuncs.com');
    const isDeepSeekFamily = lower.includes('deepseek');
    const maxTokens = resolveChatMaxTokens(settings, isDeepSeekFamily);
    const compat: Record<string, unknown> = {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: !isQwenFamily,
    };

    if (isQwenFamily) {
      compat.thinkingFormat = 'qwen';
    }

    return {
      id: requestedModel || 'openai-compatible-model',
      name: `OpenAI-Compatible (${requestedModel || 'model'})`,
      api: 'openai-completions',
      provider: 'openai-compatible',
      baseUrl: resolvedBaseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens,
      compat: compat as any,
    } as Model<any>;
  }

  private isOfficialOpenAIEndpoint(baseURL: string): boolean {
    try {
      const url = new URL(baseURL);
      return url.hostname === 'api.openai.com';
    } catch {
      return false;
    }
  }

  /**
   * 获取 pi-agent 格式的工具
   */
  private getPiAgentTools(): AgentTool[] {
    const tools: AgentTool[] = [];

    for (const [name, tool] of toolRegistry) {
      tools.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as any,
        execute: async (toolCallId, params) => {
          const result = await tool.execute(params as Record<string, unknown>);
          return result;
        },
      } as AgentTool);
    }

    return tools;
  }

  /**
   * 转换消息格式
   */
  private convertMessages(messages: any[]): any[] {
    return messages.map(msg => {
      const role = msg.role;
      const content = msg.content;

      if (role === 'user') {
        return { role: 'user', content: this.extractText(content) };
      }
      if (role === 'assistant') {
        return { role: 'assistant', content: this.extractText(content) };
      }
      if (role === 'tool') {
        return { role: 'tool', tool_call_id: msg.toolCallId || msg.tool_call_id, content: this.extractText(content) };
      }
      return msg;
    });
  }

  /**
   * 从消息内容中提取文本
   */
  private extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c: any) => c.text || c.content || '').join('');
    }
    if (content?.text) return content.text;
    return JSON.stringify(content);
  }

  /**
   * 移除 Agent 实例
   */
  remove(sessionId: string): void {
    const session = this.agents.get(sessionId);
    if (session) {
      session.agent.abort();
      session.agent.reset();
    }
    this.agents.delete(sessionId);
  }

  /**
   * 清理所有 Agent
   */
  clear(): void {
    for (const session of this.agents.values()) {
      session.agent.abort();
      session.agent.reset();
    }
    this.agents.clear();
  }
}

// 全局 Agent 管理器
export const agentManager = new AgentManager();

// ========== 便捷函数 ==========

/**
 * 创建 Agent 实例
 */
export function createAgent(config?: PiAgentConfig): Agent {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return agentManager.getOrCreate(sessionId, config || {});
}

/**
 * 发送聊天消息（流式）
 */
export async function streamChat(
  sessionId: string,
  message: string,
  config?: PiAgentConfig,
  onChunk?: (chunk: string) => void
): Promise<string> {
  const agent = agentManager.getOrCreate(sessionId, config || {});

  let buffer = '';
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update') {
      const msg = event.message;
      if (msg?.content) {
        const newContent = Array.isArray(msg.content)
          ? msg.content.map((c: any) => c.text || '').join('')
          : msg.content;
        if (newContent !== buffer && onChunk) {
          onChunk(newContent.slice(buffer.length));
          buffer = newContent;
        }
      }
    }
  });

  try {
    await agent.prompt(message);
    await agent.waitForIdle();
    return buffer;
  } finally {
    unsubscribe();
  }
}

/**
 * 发送聊天消息（非流式）
 */
export async function chat(
  sessionId: string,
  message: string,
  config?: PiAgentConfig
): Promise<string> {
  const agent = agentManager.getOrCreate(sessionId, config || {});

  await agent.prompt(message);
  await agent.waitForIdle();

  const state = agent.state;
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];

  if (lastMessage && 'content' in lastMessage) {
    return Array.isArray(lastMessage.content)
      ? lastMessage.content.map((c: any) => c.text || '').join('')
      : lastMessage.content || '';
  }

  return '';
}

/**
 * 重置会话
 */
export function resetSession(sessionId: string): void {
  agentManager.remove(sessionId);
}
