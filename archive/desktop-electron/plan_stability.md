# 向量服务稳定性增强计划 (Vector Service Stability Plan)

## 目标
解决批量导入时的 **API 速率限制 (Rate Limiting)** 和 **网络抖动** 问题，确保索引任务不卡死、不丢数据。

## 1. 引入并发控制 (Concurrency Control)

由于没有 `p-limit` 等第三方库，我们将实现一个轻量级的 `AsyncPool` 或 `TaskQueue`。

**`desktop/electron/core/utils/concurrency.ts` (新建)**
```typescript
/**
 * 简单的并发控制器
 * 限制同时进行的 Promise 数量
 */
export class ConcurrencyLimiter {
  private limit: number;
  private activeCount: number = 0;
  private queue: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.activeCount++;
    try {
      return await task();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next?.();
      }
    }
  }
}
```

## 2. 实现重试与退避机制 (Retry with Exponential Backoff)

在 `EmbeddingService` 中增加重试逻辑，专门处理 OpenAI 的 429 和 5xx 错误。

**逻辑**:
- 捕获异常
- 检查错误类型 (Rate Limit / Timeout)
- `wait(baseDelay * 2^retries)`
- 最大重试次数: 3次

## 3. 增强 IndexManager (`IndexManager.ts`)

- **并发处理**: 目前是串行的 `processQueue`。改为并行处理，但受 `ConcurrencyLimiter` 限制 (例如 limit=3)。
- **批量处理**: 如果队列很长，使用 `Promise.all` 结合 Limiter 来加速。

## 4. 执行步骤

1.  创建 `desktop/electron/core/utils/concurrency.ts`。
2.  修改 `EmbeddingService.ts`:
    - 增加 `retryWithBackoff` 装饰器或包裹函数。
    - 将 `embedDocuments` 调用包裹在重试逻辑中。
3.  修改 `IndexManager.ts`:
    - 引入 `ConcurrencyLimiter`。
    - 修改 `processQueue`，支持并发 (limit=3)。
    - 优化错误处理，失败的任务是否重试？(目前策略：失败仅 Log，防止死循环。建议：失败一次后放回队尾，增加 `retryCount` 字段，超过3次丢弃)。

## 验证
- 模拟 API 报错 (429)。
- 观察控制台是否出现 "Retrying in 2000ms..."。
- 最终是否成功写入。
