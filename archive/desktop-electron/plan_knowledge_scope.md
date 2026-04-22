# 知识库作用域隔离计划 (Knowledge Scope Isolation)

## 目标
解决用户知识库与智囊团成员知识库混淆的问题，实现精准的 **"分库检索"**。

## 1. 索引层：打标 (Metadata Tagging)

在 `main.ts` 或 `IndexManager` 的调用方，必须明确区分来源，并在 `metadata` 中注入 `scope` 字段。

**Metadata 结构规范**:
```typescript
interface VectorMetadata {
  scope: 'user' | 'advisor';
  advisorId?: string; // 如果是智囊团成员
  userId?: string;    // 如果是用户 (目前暂为 'currentUser')
  // ...其他原有字段
}
```

**修改点 (`desktop/electron/main.ts`)**:
- **用户知识库 (Redbook/YouTube)**: 索引时注入 `scope: 'user'`。
- **智囊团知识库 (Advisor Knowledge)**:
  - 智囊团目前上传的知识库是存储在 `advisors/{id}/knowledge/` 目录下。
  - 需要在 `advisors:upload-knowledge` 或相关逻辑中，触发索引时注入 `scope: 'advisor', advisorId: id`。

## 2. 存储层：过滤支持 (`VectorStore.ts`)

修改 `VectorStore.ts`，支持基于 Metadata 的前置/后置过滤。由于 SQLite 不支持高效的 JSON 索引，我们采用 **内存过滤** (Post-filtering) 或 **SQL JSON 过滤**。鉴于数据量级 (<10w)，SQL JSON 过滤是可行的。

**新增方法**:
```typescript
public async similaritySearch(
  queryVector: number[],
  limit: number = 10,
  filter?: { scope?: string; advisorId?: string } // 过滤条件
): Promise<SearchResult[]>
```

## 3. 检索层：路由分发 (`knowledgeRetrieval.ts`)

修改 `hybridRetrieve` 函数，接受 `scope` 参数，并分别处理：

1.  **Vector 检索**: 将 `scope` 转换为 `VectorStore` 的过滤条件。
2.  **Grep 检索**:
    - 如果 `scope === 'user'`: 仅搜索 `knowledge/` 目录。
    - 如果 `scope === 'advisor'`: 仅搜索 `advisors/{id}/knowledge/` 目录。

## 4. 业务层：调用改造 (`SmartRetrieval.ts` / `EnhancedAdvisorWorkflow.ts`)

- **群聊场景**:
  - 当某个 Advisor 发言检索时，应优先检索 **自己的知识库** (`scope: 'advisor', advisorId: self.id`)。
  - 同时也可能需要检索 **用户共享知识库** (`scope: 'user'`)。
  - 策略：可以发起两次检索，或者一次混合检索。

- **用户聊天场景**:
  - 仅检索用户知识库 (`scope: 'user'`)。

## 执行步骤

1.  **修改 `VectorStore.ts`**: 支持 `filter` 参数。
2.  **修改 `knowledgeRetrieval.ts`**: 升级 `hybridRetrieve` 签名。
3.  **修改 `main.ts`**: 在索引逻辑中注入 `scope` 和 `advisorId`。
4.  **修改调用方**: 确保 ChatService 传递正确的 Scope。

## 验证
- 给 Advisor A 上传一个独特文件 "SecretA.txt"。
- 给 Advisor B 上传一个独特文件 "SecretB.txt"。
- 提问 Advisor A，确认它能搜到 SecretA 但搜不到 SecretB。
