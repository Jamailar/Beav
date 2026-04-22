/**
 * SmartRetrieval - 智能检索服务
 *
 * 结合 QueryPlanner 和混合检索，提供更精准的知识检索
 *
 * 流程：
 * 1. QueryPlanner 生成智能检索词
 * 2. 对每个检索词执行混合检索
 * 3. 评估检索结果的相关性
 * 4. 融合去重，返回最优结果
 */

import { EventEmitter } from 'events';
import { QueryPlanner, createQueryPlanner, type QueryPlan, type SearchQuery, type AdvisorContext, type ConversationContext } from './QueryPlanner';
import { hybridRetrieve } from '../knowledgeRetrieval';

// ========== Types ==========

export interface SmartRetrievalConfig {
    apiKey: string;
    baseURL: string;
    model: string;
}

export interface RetrievalSource {
    id: string;
    content: string;
    source: string;
    relevanceScore: number;
    matchedQuery: string;
    purpose: string;
}

export interface SmartRetrievalResult {
    /** 查询计划 */
    queryPlan: QueryPlan;
    /** 检索到的内容 */
    sources: RetrievalSource[];
    /** 合并后的上下文 */
    combinedContext: string;
    /** 检索方法 */
    method: 'smart-hybrid' | 'fallback';
    /** 检索统计 */
    stats: {
        queriesExecuted: number;
        totalChunksFound: number;
        uniqueSourcesFound: number;
        executionTimeMs: number;
    };
}

export interface RetrievalEvent {
    type: 'planning_start' | 'planning_done' | 'search_start' | 'search_done' | 'merging' | 'complete';
    message: string;
    data?: any;
}

// ========== SmartRetrieval Class ==========

export class SmartRetrieval extends EventEmitter {
    private config: SmartRetrievalConfig;
    private queryPlanner: QueryPlanner;

    constructor(config: SmartRetrievalConfig) {
        super();
        this.config = config;
        this.queryPlanner = createQueryPlanner({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            model: config.model,
            temperature: 0.3,
        });
    }

    /**
     * 执行智能检索
     */
    async retrieve(
        advisor: AdvisorContext,
        conversation: ConversationContext,
        knowledgeDir: string
    ): Promise<SmartRetrievalResult> {
        const startTime = Date.now();

        // Phase 1: 生成查询计划
        this.emitEvent({
            type: 'planning_start',
            message: `正在为 ${advisor.name} 规划检索策略...`,
        });

        const queryPlan = await this.queryPlanner.planQueries(advisor, conversation);

        this.emitEvent({
            type: 'planning_done',
            message: `生成 ${queryPlan.searchQueries.length} 个检索词`,
            data: {
                intent: queryPlan.queryIntent,
                queries: queryPlan.searchQueries.map(q => q.query),
            },
        });

        // Phase 2: 执行多轮检索
        const allSources: RetrievalSource[] = [];
        const seenChunkIds = new Set<string>();

        for (let i = 0; i < queryPlan.searchQueries.length; i++) {
            const searchQuery = queryPlan.searchQueries[i];

            this.emitEvent({
                type: 'search_start',
                message: `检索 (${i + 1}/${queryPlan.searchQueries.length}): ${searchQuery.query}`,
                data: { query: searchQuery.query, purpose: searchQuery.purpose },
            });

            try {
                const result = await hybridRetrieve(
                    searchQuery.query,
                    knowledgeDir,
                    10 // 增加每轮检索数量 (3 -> 10)，确保召回率
                );

                // 处理检索结果
                for (const chunk of result.chunks) {
                    // 去重
                    if (seenChunkIds.has(chunk.id)) continue;
                    seenChunkIds.add(chunk.id);

                    // 计算相关性分数
                    const relevanceScore = this.calculateRelevance(
                        chunk.content,
                        searchQuery,
                        queryPlan.queryIntent
                    );

                    allSources.push({
                        id: chunk.id,
                        content: chunk.content,
                        source: chunk.source,
                        relevanceScore: relevanceScore * searchQuery.weight,
                        matchedQuery: searchQuery.query,
                        purpose: searchQuery.purpose,
                    });
                }

                this.emitEvent({
                    type: 'search_done',
                    message: `找到 ${result.chunks.length} 条相关内容`,
                    data: { sources: result.sources },
                });

            } catch (error) {
                console.error(`[SmartRetrieval] Search failed for query: ${searchQuery.query}`, error);
            }
        }

        // Phase 3: 融合排序
        this.emitEvent({
            type: 'merging',
            message: '正在融合和评估检索结果...',
        });

        // 按相关性排序
        allSources.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // 取 Top 8 (确保至少有 3-5 个有效结果)
        const topSources = allSources.slice(0, 8);

        // 构建合并上下文
        const combinedContext = this.buildCombinedContext(topSources, queryPlan);

        const executionTimeMs = Date.now() - startTime;

        this.emitEvent({
            type: 'complete',
            message: `检索完成，共找到 ${topSources.length} 条高相关内容`,
            data: { executionTimeMs },
        });

        return {
            queryPlan,
            sources: topSources,
            combinedContext,
            method: 'smart-hybrid',
            stats: {
                queriesExecuted: queryPlan.searchQueries.length,
                totalChunksFound: allSources.length,
                uniqueSourcesFound: new Set(topSources.map(s => s.source)).size,
                executionTimeMs,
            },
        };
    }

    /**
     * 计算内容与查询的相关性分数
     */
    private calculateRelevance(
        content: string,
        searchQuery: SearchQuery,
        queryIntent: string
    ): number {
        const contentLower = content.toLowerCase();
        const queryWords = searchQuery.query.toLowerCase().split(/\s+/);
        const intentWords = queryIntent.toLowerCase().split(/\s+/);

        let score = 0;
        let matchCount = 0;

        // 查询词匹配
        for (const word of queryWords) {
            if (word.length >= 2 && contentLower.includes(word)) {
                matchCount++;
            }
        }
        score += (matchCount / Math.max(queryWords.length, 1)) * 0.5;

        // 意图词匹配
        let intentMatchCount = 0;
        for (const word of intentWords) {
            if (word.length >= 2 && contentLower.includes(word)) {
                intentMatchCount++;
            }
        }
        score += (intentMatchCount / Math.max(intentWords.length, 1)) * 0.3;

        // 内容长度奖励（较长的内容可能更完整）
        const lengthBonus = Math.min(content.length / 1000, 0.2);
        score += lengthBonus;

        // 根据检索目的调整
        switch (searchQuery.purpose) {
            case 'primary':
                score *= 1.2; // 核心内容加权
                break;
            case 'example':
                // 如果内容包含示例相关词汇，加权
                if (/案例|示例|例如|比如|实践/.test(content)) {
                    score *= 1.1;
                }
                break;
            case 'contrast':
                // 如果内容包含对比相关词汇，加权
                if (/对比|比较|不同|区别|优劣/.test(content)) {
                    score *= 1.1;
                }
                break;
        }

        return Math.min(score, 1.0);
    }

    /**
     * 构建合并的上下文
     */
    private buildCombinedContext(sources: RetrievalSource[], queryPlan: QueryPlan): string {
        if (sources.length === 0) {
            return '';
        }

        const parts: string[] = [];

        // 添加查询意图说明
        parts.push(`**检索意图**: ${queryPlan.queryIntent}\n`);

        // 按目的分组
        const groupedByPurpose: Record<string, RetrievalSource[]> = {};
        for (const source of sources) {
            if (!groupedByPurpose[source.purpose]) {
                groupedByPurpose[source.purpose] = [];
            }
            groupedByPurpose[source.purpose].push(source);
        }

        // 构建分组输出
        const purposeLabels: Record<string, string> = {
            primary: '📌 核心参考',
            background: '📚 背景知识',
            contrast: '⚖️ 对比参考',
            example: '💡 案例示例',
        };

        for (const [purpose, purposeSources] of Object.entries(groupedByPurpose)) {
            const label = purposeLabels[purpose] || '📄 参考内容';
            parts.push(`### ${label}\n`);

            for (const source of purposeSources) {
                parts.push(`**来源**: ${source.source} (相关度: ${(source.relevanceScore * 100).toFixed(0)}%)`);
                parts.push(source.content);
                parts.push('---');
            }
        }

        return parts.join('\n\n');
    }

    /**
     * 发送事件
     */
    private emitEvent(event: RetrievalEvent): void {
        this.emit('event', event);
        this.emit(event.type, event);
    }
}

/**
 * 创建智能检索服务实例
 */
export function createSmartRetrieval(config: SmartRetrievalConfig): SmartRetrieval {
    return new SmartRetrieval(config);
}
