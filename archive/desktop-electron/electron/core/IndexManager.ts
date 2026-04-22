import { embeddingService } from './vector/EmbeddingService';
import { upsertVectors, deleteVectors, KnowledgeVector, getVectorStats, clearAllVectors, getVectorHash, incrementKnowledgeVersion, getActiveSpaceId } from '../db';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { ConcurrencyLimiter } from './utils/concurrency';
import { KnowledgeItem } from './normalization';

export interface IndexingStatus {
  isIndexing: boolean;
  totalQueueLength: number;
  activeItems: { id: string; title: string; startTime: number; metadata?: any }[];
  queuedItems: { id: string; title: string; metadata?: any }[];
  processedCount: number;
  totalStats: {
    vectors: number;
    documents: number;
  };
}

export class IndexManager extends EventEmitter {
  private isProcessing = false;
  private queue: KnowledgeItem[] = [];
  private activeTasks: Map<string, { title: string; startTime: number; metadata?: any }> = new Map();
  private processedSessionCount = 0;
  private limiter: ConcurrencyLimiter;

  constructor() {
    super();
    this.limiter = new ConcurrencyLimiter(3); // Max 3 concurrent tasks
  }

  /**
   * 获取当前状态
   */
  public getStatus(): IndexingStatus {
    const stats = getVectorStats();

    // Prepare active items list
    const activeItems = Array.from(this.activeTasks.entries()).map(([id, info]) => ({
      id,
      title: info.title,
      startTime: info.startTime,
      metadata: info.metadata
    }));

    // Prepare queued items preview (first 5)
    const queuedItems = this.queue.slice(0, 5).map(item => ({
      id: item.id,
      title: item.title || 'Untitled',
      metadata: item.displayData
    }));

    return {
      isIndexing: this.activeTasks.size > 0 || this.queue.length > 0,
      totalQueueLength: this.queue.length,
      activeItems,
      queuedItems,
      processedCount: this.processedSessionCount,
      totalStats: {
        vectors: stats.totalVectors,
        documents: stats.totalDocuments
      }
    };
  }

  private emitStatus() {
    this.emit('status-update', this.getStatus());
  }

  /**
   * 移除指定队列项
   */
  public removeItem(id: string) {
    const originalLength = this.queue.length;
    this.queue = this.queue.filter(i => i.id !== id);
    if (this.queue.length !== originalLength) {
      this.emitStatus();
    }
  }

  /**
   * 清空等待队列
   */
  public clearQueue() {
    this.queue = [];
    this.emitStatus();
  }

  /**
   * 添加到索引队列
   */
  public async addToQueue(item: KnowledgeItem) {
    // 简单的去重，如果已经在队列中则移除旧的
    this.queue = this.queue.filter(i => i.id !== item.id);
    this.queue.push(item);

    this.emitStatus();

    // 触发处理
    this.processQueue();
  }

  /**
   * 清空并重建所有索引
   * (需要外部传入遍历逻辑，这里仅提供接口)
   */
  public async clearAndRebuild() {
    console.log('[IndexManager] Clearing all vectors...');
    clearAllVectors();
    this.queue = [];
    this.processedSessionCount = 0;
    this.emitStatus();
  }

  /**
   * 立即索引单个条目（阻塞式，用于调试或高优先级）
   */
  public async reindexItem(item: KnowledgeItem): Promise<boolean> {
    if (!item.content && !item.title) {
      console.warn(`[IndexManager] Item ${item.id} has no content to index.`);
      return false;
    }

    try {
      console.log(`[IndexManager] Indexing item: ${item.id} (${item.title})`);

      // 1. 清理旧向量
      deleteVectors(item.id);

      // 2. 准备文本：合并标题和内容，增加语义丰富度
      const fullText = `${item.title || ''}\n\n${item.content || ''}`.trim();
      if (!fullText) return false;

      // 3. Content Hashing Check
      const newHash = createHash('md5').update(fullText).digest('hex');
      const oldHash = getVectorHash(item.id);

      if (newHash === oldHash) {
        console.log(`[IndexManager] Content unchanged for ${item.id}, skipping API call.`);
        return true;
      }

      // 4. 文本切片
      const chunks = await embeddingService.createChunks(fullText);

      // 5. 批量生成 Embedding
      const vectors = await embeddingService.embedDocuments(chunks);

      // 6. 构造 DB 数据
      // 将 displayData, scope, advisorId 等统一存入 metadata
      // 这样检索出来的 KnowledgeVector 就包含了完整的展示信息
      const unifiedMetadata = {
        ...item.displayData,
        title: item.title,
        scope: item.scope,
        advisorId: item.advisorId,
        spaceId: getActiveSpaceId()
      };

      const vectorRecords: Omit<KnowledgeVector, 'created_at'>[] = chunks.map((chunk, index) => {
        // Float32Array 转 Buffer
        const vectorFloatArray = new Float32Array(vectors[index]);
        const buffer = Buffer.from(vectorFloatArray.buffer);

        return {
          id: nanoid(),
          source_id: item.id, // 这里存的是 KnowledgeItem 的 UUID
          source_type: item.sourceType,
          chunk_index: index,
          content: chunk,
          embedding: buffer,
          metadata: unifiedMetadata,
          content_hash: newHash
        };
      });

      // 7. 写入 DB
      upsertVectors(vectorRecords);
      this.processedSessionCount++;

      // 8. 更新知识库版本号（触发相似度缓存失效）
      incrementKnowledgeVersion();

      console.log(`[IndexManager] Indexed ${item.id} (${chunks.length} chunks)`);
      return true;

    } catch (error) {
      console.error(`[IndexManager] Failed to index item ${item.id}:`, error);
      return false;
    }
  }

  /**
   * 处理队列
   */
  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.emitStatus();

    const MAX_CONCURRENT = 3;

    try {
      while (this.queue.length > 0 || this.activeTasks.size > 0) {
        // 如果队列为空且没有活动任务，退出循环
        if (this.queue.length === 0 && this.activeTasks.size === 0) break;

        // 如果达到最大并发，等待任意一个任务完成
        // 这里简单使用轮询等待，或者可以通过 Promise.race 优化
        if (this.activeTasks.size >= MAX_CONCURRENT || this.queue.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        // 取出一个任务并立即标记为进行中
        const item = this.queue.shift();
        if (item) {
          this.activeTasks.set(item.id, {
            title: item.title || 'Untitled',
            startTime: Date.now(),
            metadata: { scope: item.scope, advisorId: item.advisorId }
          });
          this.emitStatus();

          // 异步执行任务，不阻塞主循环（但受并发限制）
          this.reindexItem(item)
            .catch(e => console.error(`Task failed: ${item.id}`, e))
            .finally(() => {
              this.activeTasks.delete(item.id);
              this.emitStatus();
            });
        }
      }
    } catch (e) {
      console.error('Queue processing error:', e);
    }

    this.isProcessing = false;
    this.emitStatus();
  }
}

export const indexManager = new IndexManager();
