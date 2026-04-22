/**
 * Agentic Retrieval Module
 *
 * Replaces the old Vector/Embedding RAG with a lightweight, agentic search approach.
 * Uses `grep` (or `ripgrep`) to find relevant files in real-time based on generated queries.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { vectorStore } from './vector/VectorStore';
import { embeddingService } from './vector/EmbeddingService';
import { KnowledgeVector } from '../db';

// 文本块接口
export interface TextChunk {
    id: string;
    content: string;
    source: string;
    score?: number;
    type: 'keyword' | 'vector' | 'hybrid';
}

// 检索结果
export interface RetrievalResult {
    chunks: TextChunk[];
    context: string;
    sources: string[];
    method: 'grep' | 'vector' | 'hybrid';
}

// Simplified config (no embeddings needed)
export type RetrievalConfig = Record<string, never>;

/**
 * Execute grep/ripgrep to find matches
 */
async function executeGrep(query: string, directory: string): Promise<Map<string, number>> {
    return new Promise((resolve) => {
        // Try to use rg (ripgrep) first, fallback to grep
        // We'll prioritize simple grep for compatibility if rg isn't guaranteed,
        // but rg is much better. For now, let's assume 'grep' is available (macOS/Linux).

        // Using -r (recursive), -i (ignore case), -l (files with matches only) first to get file list?
        // Or -c (count) to rank files? -c is good for ranking.

        const cmd = 'grep';
        const args = ['-ric', query, directory]; // recursive, ignore-case, count matches

        const child = spawn(cmd, args);

        let stdout = '';

        child.stdout.on('data', (d) => { stdout += d.toString(); });

        child.on('close', () => {
            const fileScores = new Map<string, number>();
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) continue;
                // Output format: filename:count
                // But on some grep versions with directory it might vary.
                // standard grep -rc output: "dir/file.txt:5"
                const parts = line.split(':');
                if (parts.length >= 2) {
                    const count = parseInt(parts.pop() || '0', 10);
                    const filePath = parts.join(':');
                    if (count > 0 && (filePath.endsWith('.md') || filePath.endsWith('.txt'))) {
                        // Normalize path to be relative to directory or just filename if convenient
                        // But knowledgeDir is absolute, so grep outputs absolute paths usually if input is absolute?
                        // Actually grep output depends on input arg.
                        // Let's store full path.
                        fileScores.set(filePath, count);
                    }
                }
            }
            resolve(fileScores);
        });

        child.on('error', () => {
            resolve(new Map());
        });
    });
}

/**
 * Reciprocal Rank Fusion (RRF)
 * 倒数排名融合算法
 */
function fuseResults(
    keywordResults: Map<string, number>,
    vectorResults: { item: KnowledgeVector; score: number }[],
    k = 60
): Map<string, number> {
    const fusedScores = new Map<string, number>();

    // 1. 处理关键词结果 (Score is hit count)
    // 按命中数排序获取排名
    const sortedKeyword = Array.from(keywordResults.entries()).sort((a, b) => b[1] - a[1]);
    sortedKeyword.forEach(([filePath, count], rank) => {
        // 提取文件名作为 ID (与 vector source_id 对齐)
        // 注意：这里假设 vector source_id 可能是文件名或者是 UUID
        // 如果 vector 存的是 UUID，而 grep 返回的是 filepath，需要映射
        // 暂时假设知识库文件名为 ID
        const id = path.basename(filePath); // 简单处理
        const score = 1 / (k + rank + 1);
        fusedScores.set(id, (fusedScores.get(id) || 0) + score);
    });

    // 2. 处理向量结果 (Score is cosine similarity)
    vectorResults.forEach((res, rank) => {
        // vector.source_id 应该是 archive_sample.id
        // 如果 grep 是对文件系统的，我们需要确保两者 ID 体系一致
        // 目前系统是：archive_samples 存 DB，KnowledgeDir 是文件导出
        // 如果两者不一致，混合检索会分裂。
        // 临时策略：优先信赖 Vector 结果（因为包含了语义），Grep 仅作为文件系统的补充
        const id = res.item.source_id; // 这里通常是 UUID
        const score = 1 / (k + rank + 1);
        fusedScores.set(id, (fusedScores.get(id) || 0) + score);
    });

    return fusedScores;
}

/**
 * Main retrieval function
 *
 * @param query The search query (keyword or phrase)
 * @param knowledgeDir The directory to search
 * @param topK Number of files to retrieve
 * @param scope Optional scope to filter vector search
 */
export async function hybridRetrieve(
    query: string,
    knowledgeDir: string,
    topK = 3,
    scope?: { type: 'user' | 'advisor'; id?: string }
): Promise<RetrievalResult> {
    try {
        console.log(`[Retrieval] Hybrid search for: "${query}" (Scope: ${JSON.stringify(scope)})`);

        // 并行执行两路检索
        const grepPromise = (async () => {
             try {
                await fs.access(knowledgeDir);
                return await executeGrep(query, knowledgeDir);
            } catch {
                return new Map<string, number>();
            }
        })();

        const vectorPromise = (async () => {
            try {
                const queryVector = await embeddingService.embedQuery(query);

                // Construct filter for VectorStore
                let vectorFilter: { scope?: 'user' | 'advisor'; advisorId?: string } | undefined;
                if (scope) {
                    vectorFilter = { scope: scope.type };
                    if (scope.type === 'advisor' && scope.id) {
                        vectorFilter.advisorId = scope.id;
                    }
                }

                return await vectorStore.similaritySearch(queryVector, topK * 2, vectorFilter); //以此获取更多候选项
            } catch (e) {
                console.error('[Retrieval] Vector search failed:', e);
                return [];
            }
        })();

        const [fileScores, vectorScores] = await Promise.all([grepPromise, vectorPromise]);

        // 结果合并策略：
        // 由于 Grep 针对的是文件系统 (knowledgeDir)，而 Vector 针对的是 DB (archive_samples)
        // 目前系统可能是双写的（文件是 DB 的导出），或者是两套体系
        // 如果我们确信 Vector 覆盖了所有内容，可以优先 Vector
        // 这里采用 "Vector First, Grep Fallback" 的策略，或者简单的列表合并

        const chunks: TextChunk[] = [];
        const seenIds = new Set<string>();

        // 1. 添加向量结果 (语义匹配优先)
        for (const res of vectorScores) {
            const id = res.item.source_id;
            if (seenIds.has(id)) continue;

            seenIds.add(id);
            chunks.push({
                id: id,
                content: res.item.content,
                source: res.item.metadata?.title || 'Knowledge',
                score: res.score,
                type: 'vector'
            });
        }

        // 2. 添加关键词结果 (字面匹配补充)
        // Grep 返回的是文件路径，我们需要读取内容
        // 如果 Vector 已经包含该内容（通过内容指纹或ID映射），则跳过
        // 由于 ID 映射困难，这里直接作为补充来源
        const sortedFiles = Array.from(fileScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK); // Grep 只取头部

        for (const [filePath, count] of sortedFiles) {
            const fileName = path.basename(filePath);
            // 简单的排重尝试：如果文件名包含在已有的 title 中
            // 这是一个模糊的排重
            const isDuplicate = chunks.some(c => c.source === fileName || (c.content && c.content.length > 50 && (fs as any).readFileSync ? (fs as any).readFileSync(filePath, 'utf-8').includes(c.content.substring(0, 50)) : false));

            if (chunks.length >= topK * 1.5) break; // 防止总数过多

            try {
                const content = await fs.readFile(filePath, 'utf-8');
                chunks.push({
                    id: fileName,
                    content: content.trim(),
                    source: fileName,
                    score: count, // Count is not normalized to 0-1, but strictly > 0
                    type: 'keyword'
                });
            } catch (e) {
                console.error(`Failed to read file ${filePath}`, e);
            }
        }

        // 最终排序和截断
        // 简单的混合排序不好做，因为分数维度不同
        // Vector 分数 0.7-0.9，Grep 分数 1-100+
        // 我们保持 Vector 在前，Grep 在后，或者交替
        // 当前逻辑是 Vector 优先 Push，Grep 补充 Push，已经隐含了优先级

        const finalChunks = chunks.slice(0, topK);

        // 5. Build Context
        const context = finalChunks.map((chunk, i) =>
            `[参考${i + 1} - ${chunk.source} (${chunk.type})]\n${chunk.content}`
        ).join('\n\n---\n\n');

        return {
            chunks: finalChunks,
            context,
            sources: finalChunks.map(c => c.source),
            method: 'hybrid'
        };

    } catch (error) {
        console.error('Hybrid retrieval failed:', error);
        return { chunks: [], context: '', sources: [], method: 'hybrid' };
    }
}

/**
 * Compatible helper for prompts
 */
export async function buildAdvisorPromptWithRAG(
    basePrompt: string,
    userQuery: string,
    knowledgeDir: string
): Promise<{ prompt: string; sources: string[]; method: string }> {
    // Note: This is a fallback single-shot retrieval.
    // SmartRetrieval uses a planner which is better.
    // 增加默认检索数量 (3 -> 8)
    const retrieval = await hybridRetrieve(userQuery, knowledgeDir, 8);

    let prompt = basePrompt;

    if (retrieval.context) {
        prompt += `\n\n## 参考知识库 (实时检索)\n\n以下是与用户问题相关的知识内容，请在回答时参考这些信息：\n\n${retrieval.context}`;
    }

    prompt += `\n\n## 回复要求\n- 你是群聊中的一员，请根据你的角色设定发表观点\n- 保持简洁，200字以内\n- 如果知识库中有相关信息，请自然地融入你的回答`;

    return { prompt, sources: retrieval.sources, method: retrieval.method };
}
