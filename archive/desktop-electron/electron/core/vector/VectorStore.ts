import { getAllVectors, KnowledgeVector } from '../../db';

export interface SearchResult {
  item: KnowledgeVector;
  score: number; // 0-1, 1 is identical
}

export class VectorStore {
  private vectors: KnowledgeVector[] = [];
  private lastCacheTime: number = 0;
  private readonly CACHE_TTL = 1000 * 60 * 5; // 5 minutes cache

  constructor() {
    // Lazy load on first search
  }

  /**
   * 刷新向量缓存
   */
  public async refreshCache() {
    this.vectors = getAllVectors();
    this.lastCacheTime = Date.now();
  }

  /**
   * 向量相似度搜索
   * @param queryVector 查询向量
   * @param limit 返回数量
   * @param filter 过滤条件 (scope, advisorId, etc.)
   */
  public async similaritySearch(
    queryVector: number[],
    limit: number = 10,
    filter?: { scope?: 'user' | 'advisor'; advisorId?: string }
  ): Promise<SearchResult[]> {
    // Check cache
    if (Date.now() - this.lastCacheTime > this.CACHE_TTL || this.vectors.length === 0) {
      await this.refreshCache();
    }

    if (this.vectors.length === 0) {
      return [];
    }

    // 1. Filter candidates
    const candidates = this.vectors.filter(vector => {
      if (!filter) return true;

      // Filter by scope
      if (filter.scope) {
        if (vector.metadata?.scope !== filter.scope) {
          return false;
        }
      }

      // Filter by advisorId (only if scope is advisor)
      if (filter.scope === 'advisor' && filter.advisorId) {
        if (vector.metadata?.advisorId !== filter.advisorId) {
          return false;
        }
      }

      return true;
    });

    // 2. Compute similarity
    const results: SearchResult[] = candidates.map(vector => {
      // Convert Buffer to number[]/Float32Array
      // Note: better-sqlite3 returns BLOB as Buffer
      const vectorData = new Float32Array(
        vector.embedding.buffer,
        vector.embedding.byteOffset,
        vector.embedding.byteLength / 4
      );

      const score = this.cosineSimilarity(queryVector, vectorData);
      return { item: vector, score };
    });

    // Sort by score descending
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// 单例导出
export const vectorStore = new VectorStore();
