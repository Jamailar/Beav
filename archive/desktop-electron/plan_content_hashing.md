# 内容指纹防抖方案 (Content Hashing Plan)

## 目标
通过引入内容哈希 (Content Hash) 机制，避免对未变更的内容重复生成向量，降低 API 调用成本，提升系统响应速度。

## 1. 数据库变更 (`desktop/electron/db.ts`)

在 `knowledge_vectors` 表中新增 `content_hash` 列。

```sql
ALTER TABLE knowledge_vectors ADD COLUMN content_hash TEXT;
```

**新增辅助查询方法**:
- `getVectorHash(sourceId: string)`: 获取指定条目当前的哈希值。因为同一个 `sourceId` 的所有切片共享相同的内容来源，所以它们的 Hash 应该是一致的，取第一条即可。

```typescript
export const getVectorHash = (sourceId: string): string | null => {
  const stmt = db.prepare('SELECT content_hash FROM knowledge_vectors WHERE source_id = ? LIMIT 1');
  const result = stmt.get() as { content_hash: string } | undefined;
  return result?.content_hash || null;
};
```

## 2. 索引逻辑变更 (`desktop/electron/core/IndexManager.ts`)

修改 `reindexItem` 方法，引入哈希校验流程。

**引入依赖**:
使用 Node.js 原生 `crypto` 模块。
```typescript
import { createHash } from 'crypto';
```

**逻辑流程**:
1.  **准备文本**: `fullText = title + content`
2.  **计算哈希**: `newHash = createHash('md5').update(fullText).digest('hex')`
3.  **查询旧哈希**: `oldHash = getVectorHash(item.id)`
4.  **校验**:
    *   如果 `newHash === oldHash`:
        *   **命中缓存**: 直接返回 `true`。
        *   可选优化：虽然内容没变，但 Metadata 可能变了（如标题修改），可以仅执行 Metadata 更新（轻量 SQL）。鉴于 Metadata 通常随内容一起变，暂时直接跳过即可，或者做一个轻量的 `UPDATE` 操作。
    *   如果 `newHash !== oldHash`:
        *   **未命中**: 执行原有流程（删除旧向量 -> 切片 -> Embedding -> 写入新向量）。
        *   **写入**: 在 `upsertVectors` 时将 `newHash` 写入所有切片记录。

## 3. 执行步骤

1.  **修改 DB (`db.ts`)**:
    - 在 `initDb` 中添加 Migration 脚本（`ALTER TABLE`）。
    - 增加 `getVectorHash` 导出函数。
    - 更新 `KnowledgeVector` 接口定义，增加 `content_hash` 字段。
    - 更新 `upsertVectors` 方法，支持写入 `content_hash`。

2.  **修改 IndexManager (`IndexManager.ts`)**:
    - 引入 `crypto`。
    - 在 `reindexItem` 中实现 Hash 计算和对比逻辑。
    - 增加日志输出：`[IndexManager] Content unchanged for ${item.id}, skipping.`

## 验证
- 连续两次对同一个笔记触发保存。
- 第一次：日志显示 "Indexing item..."
- 第二次：日志显示 "Content unchanged... skipping." (API 调用为 0)
