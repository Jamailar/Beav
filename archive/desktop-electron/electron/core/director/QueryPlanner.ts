/**
 * QueryPlanner - 智能查询规划器
 *
 * 使用 AI 思考生成更精准的检索词，而不是简单的关键词提取
 * 不再依赖 LangChain，使用 OpenAI 直接 API
 *
 * 流程：
 * 1. 分析用户问题，理解真实意图
 * 2. 基于角色专业背景，生成多维度检索词
 * 3. 考虑上下文对话，扩展相关概念
 * 4. 返回结构化的检索计划
 */

// ========== Types ==========

export interface QueryPlannerConfig {
    apiKey: string;
    baseURL: string;
    model: string;
    temperature?: number;
}

export interface AdvisorContext {
    name: string;
    personality: string;
    expertise: string[];
}

export interface ConversationContext {
    userQuery: string;
    history: { role: string; content: string; advisorName?: string }[];
    discussionGoal?: string;
}

export interface QueryPlan {
    /** 原始问题 */
    originalQuery: string;
    /** AI 分析的问题本质 */
    queryIntent: string;
    /** 生成的检索词列表（按优先级排序） */
    searchQueries: SearchQuery[];
    /** 思考过程 */
    reasoning: string;
}

export interface SearchQuery {
    /** 检索词 */
    query: string;
    /** 检索目的 */
    purpose: 'primary' | 'background' | 'contrast' | 'example';
    /** 期望找到的内容类型 */
    expectedContent: string;
    /** 权重 (0-1) */
    weight: number;
}

const QUERY_PLANNER_SYSTEM_PROMPT_TEMPLATE = loadPrompt(
    'runtime/director/query_planner.txt',
    '你是一个智能检索规划器，专门为「{{advisor_name}}」设计检索策略。'
);

// ========== QueryPlanner Class ==========

export class QueryPlanner {
    private config: QueryPlannerConfig;

    constructor(config: QueryPlannerConfig) {
        this.config = config;
    }

    /**
     * 为智囊团成员生成智能检索计划
     */
    async planQueries(
        advisor: AdvisorContext,
        conversation: ConversationContext
    ): Promise<QueryPlan> {
        const systemPrompt = this.buildPlannerPrompt(advisor);
        const userPrompt = this.buildQueryRequest(conversation);

        try {
            const baseURL = normalizeApiBaseUrl(this.config.baseURL || 'https://api.openai.com/v1', 'https://api.openai.com/v1');
            const model = this.config.model || 'gpt-4o';
            const temperature = this.config.temperature ?? 0.3;

            const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    model,
                    temperature,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                })
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json() as { choices?: { message: { content: string } }[] };
            const content = data.choices?.[0]?.message?.content || '';

            return this.parseQueryPlan(content, conversation.userQuery);
        } catch (error) {
            console.error('[QueryPlanner] Failed to generate query plan:', error);
            // 降级：返回基础检索计划
            return this.createFallbackPlan(conversation.userQuery);
        }
    }

    /**
     * 构建查询规划器的系统提示词
     */
    private buildPlannerPrompt(advisor: AdvisorContext): string {
        return renderPrompt(QUERY_PLANNER_SYSTEM_PROMPT_TEMPLATE, {
            advisor_name: advisor.name,
            advisor_personality: advisor.personality,
            advisor_expertise: advisor.expertise.join('、'),
        });
    }

    /**
     * 构建查询请求
     */
    private buildQueryRequest(conversation: ConversationContext): string {
        const parts: string[] = [];

        parts.push(`## 用户问题\n${conversation.userQuery}`);

        if (conversation.discussionGoal) {
            parts.push(`## 讨论目标\n${conversation.discussionGoal}`);
        }

        if (conversation.history.length > 0) {
            const recentHistory = conversation.history.slice(-5);
            const historyText = recentHistory
                .map(h => `${h.advisorName || h.role}: ${h.content.slice(0, 200)}...`)
                .join('\n');
            parts.push(`## 对话上下文\n${historyText}`);
        }

        parts.push('\n请基于以上信息，生成检索计划（JSON格式）：');

        return parts.join('\n\n');
    }

    /**
     * 解析 AI 返回的检索计划
     */
    private parseQueryPlan(content: string, originalQuery: string): QueryPlan {
        try {
            // 尝试提取 JSON
            const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ||
                              content.match(/\{[\s\S]*\}/);

            if (!jsonMatch) {
                throw new Error('No JSON found in response');
            }

            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);

            // 验证并规范化
            const searchQueries: SearchQuery[] = (parsed.searchQueries || [])
                .slice(0, 8) // 最多8个 (增加上限 5->8)
                .map((q: any, idx: number) => ({
                    query: String(q.query || ''),
                    purpose: ['primary', 'background', 'contrast', 'example'].includes(q.purpose)
                        ? q.purpose
                        : 'primary',
                    expectedContent: String(q.expectedContent || ''),
                    weight: typeof q.weight === 'number' ? Math.min(1, Math.max(0, q.weight)) : (1 - idx * 0.15),
                }))
                .filter((q: SearchQuery) => q.query.length > 0);

            // 确保至少有一个检索词
            if (searchQueries.length === 0) {
                searchQueries.push({
                    query: originalQuery,
                    purpose: 'primary',
                    expectedContent: '直接相关内容',
                    weight: 1.0,
                });
            }

            return {
                originalQuery,
                queryIntent: String(parsed.queryIntent || originalQuery),
                searchQueries,
                reasoning: String(parsed.reasoning || ''),
            };
        } catch (error) {
            console.error('[QueryPlanner] Failed to parse response:', error);
            return this.createFallbackPlan(originalQuery);
        }
    }

    /**
     * 创建降级检索计划
     */
    private createFallbackPlan(query: string): QueryPlan {
        // 简单的关键词提取
        const keywords = this.extractKeywords(query);

        const searchQueries: SearchQuery[] = [
            {
                query: query,
                purpose: 'primary',
                expectedContent: '直接相关内容',
                weight: 1.0,
            },
        ];

        // 如果有额外关键词，添加更多检索词
        if (keywords.length > 0) {
            searchQueries.push({
                query: keywords.join(' '),
                purpose: 'background',
                expectedContent: '背景知识',
                weight: 0.7,
            });
        }

        return {
            originalQuery: query,
            queryIntent: query,
            searchQueries,
            reasoning: '使用降级策略：直接检索原始问题',
        };
    }

    /**
     * 简单的关键词提取
     */
    private extractKeywords(text: string): string[] {
        // 移除常见停用词
        const stopWords = new Set([
            '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '个',
            '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
            '这', '那', '什么', '怎么', '为什么', '如何', '请', '帮', '能', '可以', '吗',
        ]);

        const words = text
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 2 && !stopWords.has(w));

        return [...new Set(words)].slice(0, 5);
    }
}

/**
 * 创建查询规划器实例
 */
export function createQueryPlanner(config: QueryPlannerConfig): QueryPlanner {
    return new QueryPlanner(config);
}
import { normalizeApiBaseUrl, safeUrlJoin } from '../urlUtils';
import { loadPrompt, renderPrompt } from '../../prompts/runtime';
