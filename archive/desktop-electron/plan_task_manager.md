# 任务管理器升级计划 (Task Manager Visualization)

## 目标
升级索引管理系统，从单一的"排队数"展示，进化为可感知并发、可预览队列、可干预的"任务管理器"。

## 1. 后端增强 (`IndexManager.ts`)

为了区分 "Active" (正在执行) 和 "Queued" (等待执行)，需要在 `IndexManager` 内部维护一个 `activeItems` 集合。

**状态定义升级**:
```typescript
export interface IndexingStatus {
  isIndexing: boolean;
  totalStats: { vectors: number; documents: number };

  // 新增字段
  activeItems: { id: string; title: string; startTime: number }[]; // 正在并发执行的任务
  queuedItems: { id: string; title: string }[]; // 等待执行的任务预览 (前 5 个)
  totalQueueLength: number; // 总排队数
}
```

**逻辑修改**:
- 新增 `activeTasks: Map<string, { title: string, startTime: number }>`
- 在提交给 `limiter` 之前，任务仍在 `queue` 中。
- 在 `limiter.run` 的回调函数开始时，将任务移入 `activeTasks`。
- 在 `finally` 中，将任务移出 `activeTasks`。
- 新增 `cancelItem(id)` 和 `clearQueue()` 方法。

## 2. 前端组件升级 (`IndexingStatus.tsx`)

完全重构悬浮面板 UI。

**UI 结构**:
- **头部**: 总体进度 (已完成/总数)，停止按钮。
- **进行中 (Active)**: 列表展示 1-3 个正在并发处理的任务 (带独立 Loading 动画)。
- **排队中 (Queue)**: 列表展示前 5 个等待中的任务，支持 hover 显示 "移除" 按钮。
- **底部**: 统计信息 (向量数/文档数)。

## 3. 设置页增强 (`Settings.tsx`)

虽然侧边栏悬浮窗已经够用，但设置页可以增加 "清空队列" 的全局操作按钮。

## 执行步骤

1.  **修改 `IndexManager.ts`**:
    - 实现 `activeTasks` 追踪。
    - 更新 `getStatus()` 返回丰富数据。
    - 实现 `removeItem(id)` 和 `clearQueue()`。

2.  **更新 IPC (`main.ts`)**:
    - 暴露 `indexing:remove-item` 和 `indexing:clear-queue`。

3.  **重构 `IndexingStatus.tsx`**:
    - 使用新数据结构渲染列表。
    - 增加交互按钮 (取消单个、清空全部)。

## 验证
- 连续触发多个大文件保存。
- 观察悬浮窗是否显示 3 个 "进行中"，其余在 "排队中"。
- 点击 "移除"，验证排队任务是否消失。
