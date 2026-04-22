# 向量索引进度可视化与管理计划 (Vector Indexing Visualization Plan)

## 目标
解决当前向量嵌入过程"黑盒"、无进度展示、无法感知排重的问题。
核心需求：
1.  **便于管理**：需要一个位置查看当前索引状态（总数、队列数）。
2.  **排重机制**：确认后台自动嵌入是否包含排重逻辑。
3.  **前端可视**：前端需要实时显示嵌入进度。

## 1. 后端排重与去重机制 (`IndexManager.ts`)

目前代码中 `reindexItem` 已经包含**先删后增**逻辑 (`deleteVectors(item.id)`)，这是基于 Item ID 的覆盖更新，保证了**同一条目不会产生重复向量**。

**需要增强的点：**
- **任务队列去重**：`addToQueue` 中目前已实现了简单的 ID 去重 (`this.queue = this.queue.filter(i => i.id !== item.id)`)，防止短时间内重复提交同一任务。
- **状态感知**：`IndexManager` 需要对外广播状态事件 (`indexing:status`)，包括：
  - `total`: 队列总任务数
  - `current`: 当前处理的是第几个
  - `processingId`: 当前正在处理的 ID
  - `processingTitle`: 当前正在处理的标题

## 2. 前端进度条组件 (`IndexingStatus.tsx`)

创建一个全局悬浮或嵌入式的进度指示器。

**设计方案：**
在 `Layout.tsx` 的左下角（版本号上方）增加一个 **"AI 索引状态"** 指示器。
- **空闲时**：隐藏或显示 "索引就绪"。
- **工作中**：显示 "正在构建索引... (1/5)" + 迷你进度条。
- **点击时**：弹出一个小的详情面板，显示当前正在处理的文件名。

## 3. 设置页增加向量管理面板 (`Settings.tsx`)

在设置页新增 **"知识库索引"** 面板：
- **统计信息**：
  - 已索引条目数 (Count Distinct SourceID)
  - 向量切片总数 (Count Rows)
  - 数据库体积估算
- **操作**：
  - **"重建所有索引"**：强制清空 `knowledge_vectors` 表，并重新扫描所有 `meta.json` 加入队列。
  - **"清理无效索引"**：扫描 DB 中的 source_id，如果在文件系统中不存在则删除向量。

## 4. IPC 通信协议

新增 IPC 通道：
- `indexing:get-stats`: 获取当前索引统计。
- `indexing:rebuild-all`: 触发全量重建。
- `indexing:progress`: (Event) 后端推送实时进度。

## 执行步骤

1.  **后端增强 (`IndexManager.ts`)**:
    - 增加 `EventEmitter` 能力，发送 `progress` 事件。
    - 实现 `getStats()` 方法（查询 DB 统计）。
    - 实现 `rebuildAll()` 方法（遍历所有 Knowledge 目录）。
    - 确保 `main.ts` 将这些事件转发给前端窗口。

2.  **前端组件 (`IndexingStatus.tsx`)**:
    - 创建 React 组件，监听 `indexing:progress`。
    - 样式设计：Tailwind 风格，轻量级。

3.  **集成到 Layout (`Layout.tsx`)**:
    - 将 `IndexingStatus` 放置在侧边栏底部。

4.  **设置页更新 (`Settings.tsx`)**:
    - 增加 "向量索引" Section。

## 验证方式
- 导入一个新的 YouTube 视频，观察左下角是否出现进度条。
- 在设置页点击"重建索引"，验证队列是否正常处理。
