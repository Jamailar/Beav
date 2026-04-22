# 向量检索增强计划 (Vector Retrieval Enhancement Plan)

## 目标
解决跨语言检索问题（如：中文 Query 检索非中文素材），通过引入 Embedding 向量检索，实现语义级匹配，提升检索召回率。

## 核心设计原则
1.  **原生轻量**：不引入复杂的向量数据库（如 Chroma/Pinecone），直接利用现有的 `better-sqlite3` 存储向量数据 (BLOB)，保持架构简单。
2.  **混合检索**：保留现有的 `Grep` (关键词) 检索，引入 Vector (语义) 检索，通过 RRF (倒数排名融合) 算法合并结果。
3.  **后台索引**：写入/更新知识库时异步生成 Embedding，不阻塞 UI。

## 1. 数据库层改造 (`desktop/electron/db.ts`)

新增 `knowledge_vectors` 表，用于存储文本切片和向量。

```sql
CREATE TABLE IF NOT EXISTS knowledge_vectors (
  id TEXT PRIMARY KEY,           -- UUID
  source_id TEXT NOT NULL,       -- 关联的知识库 ID (source_url 或 file_path)
  source_type TEXT NOT NULL,     -- 'note' | 'video' | 'file'
  chunk_index INTEGER NOT NULL,  -- 切片序号
  content TEXT NOT NULL,         -- 切片文本内容
  embedding BLOB NOT NULL,       -- 向量数据 (Float32Array buffer)
  metadata TEXT,                 -- 额外元数据 (JSON)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_vectors_source ON knowledge_vectors(source_id);
```

**DB 类新增方法**：
- `upsertVectors(sourceId, chunks: {content, embedding}[])`: 事务写入
- `deleteVectors(sourceId)`: 清理旧向量
- `getAllVectors()`: 获取所有向量（用于暴力搜索，量级 <10w 时性能足够）

## 2. 向量核心服务 (`desktop/electron/core/vector/`)

创建 `desktop/electron/core/vector/` 目录：

### 2.1 `VectorStore.ts`
负责向量的数学运算和存储交互。
- 实现 `cosineSimilarity(vecA, vecB)`。
- 实现 `similaritySearch(queryVector, limit)`：
  - 从 DB 加载所有向量（或缓存）。
  - 计算相似度并排序。
  - 返回 Top K 结果。

### 2.2 `EmbeddingService.ts`
负责调用 AI 接口生成向量。
- 使用 `@langchain/openai` 的 `OpenAIEmbeddings`。
- 模型：`text-embedding-3-small` (性价比高)。
- 实现 `embedDocuments(texts)` 和 `embedQuery(text)`。
- 实现 `chunkText(text)`：使用 `RecursiveCharacterTextSplitter` (size=500, overlap=50)。

## 3. 检索流程升级 (`desktop/electron/core/knowledgeRetrieval.ts`)

改造 `hybridRetrieve` 函数，实现 **混合检索策略**：

1.  **并行执行**：
    - **路 A (Keyword)**: 现有的 `grep` 检索 -> 结果集 K1。
    - **路 B (Semantic)**: `EmbeddingService` 生成 Query 向量 -> `VectorStore` 搜索 -> 结果集 K2。
2.  **结果融合 (RRF)**：
    - 对 K1 和 K2 的结果进行加权融合。
    - 融合公式：`Score = (W_keyword * 1/(rank_k1 + 60)) + (W_vector * 1/(rank_k2 + 60))`。
3.  **统一格式**：返回标准化的 `RetrievalResult`。

## 4. 索引触发机制 (`desktop/electron/core/IndexManager.ts`)

- 监听知识库变更（新增/修改笔记）。
- 触发异步任务：`IndexManager.reindex(item)`。
- 流程：`Load Content` -> `Split` -> `Embed` -> `DB.upsertVectors`。

## 5. UI/配置变更
- 复用现有的 OpenAI 配置（BaseURL/ApiKey）。
- 无需新增复杂 UI，保持静默工作。

## 执行步骤
1.  修改 `desktop/electron/db.ts`：添加表结构和 CRUD。
2.  安装依赖：确认 `@langchain/openai` 是否可用（已存在）。
3.  实现 `EmbeddingService` 和 `VectorStore`。
4.  实现 `IndexManager` 并挂载到 `ChatService` 或 `main.ts` 的保存接口中。
5.  修改 `knowledgeRetrieval.ts` 集成混合检索。
6.  编写脚本或提供入口，对现有数据进行一次全量索引。
