/**
 * EmbeddingService - 向量嵌入服务
 *
 * 使用 OpenAI 直接 API 调用生成向量嵌入
 * 不再依赖 LangChain
 */

import { getSettings } from '../../db';
import { normalizeApiBaseUrl, safeUrlJoin } from '../urlUtils';

export class EmbeddingService {
  private apiKey: string = '';
  private baseURL: string = 'https://api.openai.com/v1';
  private modelName: string = 'text-embedding-3-small';

  constructor() {
    this.init();
  }

  private init() {
    const settings = getSettings();
    // Prioritize specific embedding settings, fall back to general settings
    this.apiKey = settings?.embedding_key || settings?.api_key || '';
    this.baseURL = normalizeApiBaseUrl(
      settings?.embedding_endpoint || settings?.api_endpoint || 'https://api.openai.com/v1',
      'https://api.openai.com/v1',
    );
    this.modelName = settings?.embedding_model || 'text-embedding-3-small';
  }

  /**
   * 确保 API 已配置
   */
  private ensureInitialized() {
    if (!this.apiKey) {
      this.init();
    }
    if (!this.apiKey) {
      throw new Error('Embedding service not initialized. Please check API settings.');
    }
  }

  /**
   * 带重试的 API 调用
   */
  private async retryWithBackoff<T>(task: () => Promise<T>, retries = 3, baseDelay = 1000): Promise<T> {
    try {
      return await task();
    } catch (error: any) {
      const isRateLimit = error?.message?.includes('429') || error?.status === 429;
      const isServerErr = error?.status >= 500;

      if (retries > 0 && (isRateLimit || isServerErr)) {
        const delay = baseDelay * Math.pow(2, 3 - retries); // 1s, 2s, 4s
        console.warn(`[EmbeddingService] API error (${error.status}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.retryWithBackoff(task, retries - 1, baseDelay);
      }
      throw error;
    }
  }

  /**
   * 生成查询向量
   */
  async embedQuery(text: string): Promise<number[]> {
    this.ensureInitialized();
    return this.retryWithBackoff(async () => {
      const response = await fetch(safeUrlJoin(this.baseURL, '/embeddings'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.modelName,
          input: text
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Embedding API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as { data?: { embedding: number[] }[] };
      return data.data?.[0]?.embedding || [];
    });
  }

  /**
   * 生成文档向量（批量）
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.ensureInitialized();
    return this.retryWithBackoff(async () => {
      const response = await fetch(safeUrlJoin(this.baseURL, '/embeddings'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.modelName,
          input: texts
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Embedding API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as { data?: { embedding: number[] }[] };
      return (data.data || []).map(item => item.embedding);
    });
  }

  /**
   * 文本切片（简单的字符分割，不再依赖 LangChain）
   */
  async createChunks(text: string): Promise<string[]> {
    const chunkSize = 500;
    const chunkOverlap = 50;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    return chunks;
  }
}

// 单例导出
export const embeddingService = new EmbeddingService();
