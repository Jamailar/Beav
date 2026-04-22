/**
 * EnhancedAdvisorWorkflow - 增强的智囊团成员工作流
 *
 * 为每个智囊团成员提供更深度的思考流程：
 * 1. 多阶段RAG检索（原始查询 + 上下文扩展 + 对比检索）
 * 2. 批判性分析
 * 3. 方案生成
 * 4. 自我验证
 */

import { hybridRetrieve } from '../knowledgeRetrieval';

// ========== Types ==========

export interface WorkflowContext {
    userQuery: string;
    conversationHistory: { role: string; content: string; advisorName?: string }[];
    knowledgeDir: string;
}

export interface RAGResult {
    context: string;
    sources: string[];
    method: 'hybrid' | 'keyword-only' | 'grep' | 'vector';
    stage: 'primary' | 'contextual' | 'contrastive';
}

export interface EnhancedRAGResult {
    combinedContext: string;
    allSources: string[];
    stages: RAGResult[];
}

// ========== Multi-Stage RAG ==========

/**
 * 多阶段RAG检索
 *
 * 第一轮：基于原始问题检索
 * 第二轮：基于上下文扩展检索
 * 第三轮：基于其他成员观点的对比检索
 */
export async function multiStageRAG(
    context: WorkflowContext
): Promise<EnhancedRAGResult> {
    const stages: RAGResult[] = [];
    const allSources = new Set<string>();

    // ========== 第一阶段：原始查询检索 ==========
    try {
        const primaryResult = await hybridRetrieve(
            context.userQuery,
            context.knowledgeDir,
            10 // 增加基础检索数量 (3->10)
        );

        if (primaryResult.context) {
            stages.push({
                context: primaryResult.context,
                sources: primaryResult.sources,
                method: primaryResult.method,
                stage: 'primary',
            });
            primaryResult.sources.forEach(s => allSources.add(s));
        }
    } catch (error) {
        console.error('[MultiStageRAG] Primary stage failed:', error);
    }

    // ========== 第二阶段：上下文扩展检索 ==========
    if (context.conversationHistory.length > 0) {
        try {
            // 从历史对话中提取关键信息扩展查询
            const expandedQuery = buildExpandedQuery(
                context.userQuery,
                context.conversationHistory
            );

            if (expandedQuery !== context.userQuery) {
                const contextualResult = await hybridRetrieve(
                    expandedQuery,
                    context.knowledgeDir,
                    5 // 增加扩展检索数量 (2->5)
                );

                if (contextualResult.context) {
                    stages.push({
                        context: contextualResult.context,
                        sources: contextualResult.sources,
                        method: contextualResult.method,
                        stage: 'contextual',
                    });
                    contextualResult.sources.forEach(s => allSources.add(s));
                }
            }
        } catch (error) {
            console.error('[MultiStageRAG] Contextual stage failed:', error);
        }
    }

    // ========== 第三阶段：对比检索 ==========
    const otherOpinions = context.conversationHistory.filter(
        m => m.role === 'assistant' && m.advisorName
    );

    if (otherOpinions.length > 0) {
        try {
            // 基于其他成员观点构建对比查询
            const contrastQuery = buildContrastQuery(
                context.userQuery,
                otherOpinions
            );

            if (contrastQuery) {
                const contrastResult = await hybridRetrieve(
                    contrastQuery,
                    context.knowledgeDir,
                    5 // 增加对比检索数量 (2->5)
                );

                if (contrastResult.context) {
                    stages.push({
                        context: contrastResult.context,
                        sources: contrastResult.sources,
                        method: contrastResult.method,
                        stage: 'contrastive',
                    });
                    contrastResult.sources.forEach(s => allSources.add(s));
                }
            }
        } catch (error) {
            console.error('[MultiStageRAG] Contrastive stage failed:', error);
        }
    }

    // 合并所有检索结果
    const combinedContext = stages
        .map((stage, idx) => {
            const stageLabel = stage.stage === 'primary' ? '直接相关'
                : stage.stage === 'contextual' ? '上下文扩展'
                : '对比参考';
            return `### ${stageLabel}知识 (${idx + 1})\n${stage.context}`;
        })
        .join('\n\n---\n\n');

    return {
        combinedContext,
        allSources: Array.from(allSources),
        stages,
    };
}

/**
 * 构建扩展查询
 */
function buildExpandedQuery(
    originalQuery: string,
    history: { role: string; content: string }[]
): string {
    // 从总监的开场分析中提取关键词
    const directorIntro = history.find(m => m.content.includes('[总监分析]'));
    if (!directorIntro) return originalQuery;

    // 提取讨论维度关键词
    const dimensionMatch = directorIntro.content.match(/讨论维度[\s\S]*?(?=\*\*|$)/);
    if (dimensionMatch) {
        const dimensions = dimensionMatch[0]
            .split('\n')
            .filter(line => /^\d+\./.test(line.trim()))
            .map(line => line.replace(/^\d+\.\s*/, '').split('-')[0].trim())
            .filter(Boolean);

        if (dimensions.length > 0) {
            return `${originalQuery} ${dimensions.slice(0, 2).join(' ')}`;
        }
    }

    return originalQuery;
}

/**
 * 构建对比查询
 */
function buildContrastQuery(
    originalQuery: string,
    otherOpinions: { content: string; advisorName?: string }[]
): string | null {
    if (otherOpinions.length === 0) return null;

    // 提取其他成员观点中的关键词
    const keywords = new Set<string>();

    for (const opinion of otherOpinions) {
        // 简单提取：查找被【】或**包围的关键词，或者常见的方案词
        const matches = opinion.content.match(/【(.+?)】|\*\*(.+?)\*\*/g);
        if (matches) {
            matches.forEach(m => {
                const cleaned = m.replace(/[【】\*]/g, '').trim();
                if (cleaned.length >= 2 && cleaned.length <= 10) {
                    keywords.add(cleaned);
                }
            });
        }

        // 提取常见方案词
        const solutionWords = opinion.content.match(/(建议|方案|策略|方法|技巧|要点|关键)/g);
        if (solutionWords) {
            // 提取这些词前后的内容
            solutionWords.forEach(word => {
                const idx = opinion.content.indexOf(word);
                const context = opinion.content.slice(Math.max(0, idx - 10), idx + 20);
                const cleaned = context.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').trim();
                if (cleaned.length >= 4) {
                    keywords.add(cleaned.split(' ')[0]);
                }
            });
        }
    }

    if (keywords.size === 0) return null;

    const keywordList = Array.from(keywords).slice(0, 3);
    return `${originalQuery} 对比 ${keywordList.join(' ')}`;
}

// ========== Enhanced System Prompt Builder ==========

/**
 * 构建增强的系统提示词
 */
export function buildEnhancedSystemPrompt(
    basePrompt: string,
    ragResult: EnhancedRAGResult,
    conversationContext: { role: string; content: string; advisorName?: string }[]
): string {
    const parts: string[] = [];

    // 1. 角色设定 (Identity)
    parts.push(`# 角色设定 (Identity)\n${basePrompt}`);

    // 2. 知识内化 (Knowledge Internalization)
    if (ragResult.combinedContext) {
        parts.push(`# 知识内化 (Knowledge Internalization)
你大脑中拥有以下“过往经验”和“行业认知”（Knowledge Base），这是你专业能力的来源：

${ragResult.combinedContext}

**重要指令**：
1. **不要**复述知识库原文，**不要**说“根据资料”、“知识库提到”。
2. 把这些知识当作你在这个行业摸爬滚打多年的**肌肉记忆**。
3. 必须用**第一人称**（“我觉得”、“我之前做过类似的...”）来表达你的观点。`);
    }

    // 3. 讨论上下文 (Discussion Context)
    const otherOpinions = conversationContext.filter(
        m => m.role === 'assistant' && m.advisorName
    );

    if (otherOpinions.length > 0) {
        parts.push(`# 讨论上下文 (Context)
在你之前，其他团队成员已经发表了观点：

${otherOpinions.map(o => `**${o.advisorName}**: ${summarizeOpinion(o.content)}`).join('\n\n')}

**互动要求**：
- 仔细听听他们在说什么。
- 如果他们的观点太保守或有误，**请直接反驳**。
- 如果你赞同，请给出更深一层的补充。
- 不要自说自话，要有互动的氛围。`);
    }

    // 4. 思考与表达框架 (Thinking & Speaking)
    parts.push(`# 思考与表达 (Thinking & Speaking)
1. **立场鲜明**：你是专家，要有性格。如果你觉得用户的想法太土，就直说（注意用词的艺术）。
2. **代入感**：想象你自己就在运营这个账号。如果是你，你会怎么做？你会怎么想？
3. **口语化**：像在微信群里和合伙人聊天一样，不要写论文，不要用“综上所述”。
4. **行动导向**：最后给出一句最狠的建议。

## 回复字数
保持简洁有力，150-200字左右。`);

    return parts.join('\n\n');
}

/**
 * 简化观点摘要
 */
function summarizeOpinion(content: string): string {
    // 提取前100个字符作为摘要
    const cleaned = content.replace(/\n+/g, ' ').trim();
    if (cleaned.length <= 100) return cleaned;
    return cleaned.slice(0, 100) + '...';
}

// ========== Critical Thinking Module ==========

/**
 * 批判性思考分析提示
 */
export function getCriticalThinkingPrompt(
    userQuery: string,
    ragContext: string,
    otherOpinions: string[]
): string {
    return `
作为一个批判性思考者，请分析以下信息：

**用户问题**: ${userQuery}

**知识库信息**:
${ragContext || '(无相关知识)'}

**其他成员观点**:
${otherOpinions.length > 0 ? otherOpinions.join('\n\n') : '(暂无其他观点)'}

请进行以下分析：
1. 知识库信息的可靠性和相关性如何？
2. 其他成员的观点有哪些优点和盲点？
3. 还有哪些角度没有被覆盖？
4. 最佳的回答策略是什么？

基于以上分析，形成你的独特观点。
`;
}

// ========== Self-Validation Module ==========

/**
 * 自我验证提示
 */
export function getSelfValidationPrompt(
    userQuery: string,
    proposedAnswer: string
): string {
    return `
请验证以下回答的质量：

**用户问题**: ${userQuery}

**拟定回答**: ${proposedAnswer}

验证标准：
1. 是否直接回答了用户的问题？
2. 是否提供了可执行的建议？
3. 是否有专业深度？
4. 是否简洁明了（150-250字）？
5. 是否有独特视角？

如果有问题，请指出并改进。如果没问题，确认通过。
`;
}
