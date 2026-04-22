# 去中心化进度展示计划 (Decentralized Progress Plan)

## 目标
将知识库索引的进度展示"下放"到各个业务场景中，而不是仅在全局设置里显示。
- **智囊团页面**: 只展示当前 Advisor 的索引进度。
- **全局状态条**: 依然保留，作为兜底。

## 1. 后端增强 (`IndexManager.ts`)

为了让前端能过滤出"我的任务"，后端必须在 `getStatus` 中透出任务的 Metadata (包含 `advisorId`)。

**修改点**:
- 更新 `IndexingStatus` 接口，让 `activeItems` 和 `queuedItems` 携带 `metadata`。
- 在 `getStatus` 中组装这些数据。

```typescript
export interface IndexingStatus {
  // ...
  activeItems: { id: string; title: string; startTime: number; metadata?: any }[];
  queuedItems: { id: string; title: string; metadata?: any }[];
  // ...
}
```

## 2. 前端增强 (`Advisors.tsx`)

在智囊团详情页，监听全局 `indexing:status` 事件，但通过 `advisorId` 进行过滤。

**过滤逻辑**:
```typescript
const myActiveTasks = status.activeItems.filter(item => item.metadata?.advisorId === currentAdvisor.id);
const myQueuedTasks = status.queuedItems.filter(item => item.metadata?.advisorId === currentAdvisor.id);
const isMyIndexing = myActiveTasks.length > 0 || myQueuedTasks.length > 0;
```

**UI 展示**:
在 "专属知识库" 标题旁增加一个动态指示器。
- **空闲**: 显示 "知识库就绪" (绿色打钩)。
- **忙碌**: 显示 "正在索引... (剩余 3)" (蓝色 Spinner)。

## 3. 设置页调整 (`Settings.tsx`)

设置页保持全局视角，不需要过滤。但可以加一个说明："各成员的详细进度请在智囊团页面查看"。

## 执行步骤

1.  **修改 `IndexManager.ts`**: 暴露 metadata。
2.  **修改 `Advisors.tsx`**:
    - 引入 `IndexingStatus` 类型。
    - 添加 `useEffect` 监听 IPC 事件。
    - 在 UI 中渲染过滤后的状态。

## 验证
- 给 Advisor A 上传文件 -> Advisor A 页面显示进度，Advisor B 页面不显示。
- 给 Advisor B 下载视频 -> Advisor B 页面显示进度。
- 全局侧边栏 -> 显示两者总和。
