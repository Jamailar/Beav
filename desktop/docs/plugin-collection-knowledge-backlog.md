---
doc_type: plan
execution_status: completed
last_updated: 2026-05-12
owner: product
scope: desktop
status_note: 插件侧栏任务队列已支持停止当前采集任务；知识库已支持当前可见多选、批量删除和后端逐条结果回传。
priority: P1
target_files:
  - desktop/src-tauri/src/commands/*
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/persistence/*
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/pages/*
  - Plugin/*
---

# 插件采集 + 知识库优化记录

Status: Completed

## 待办 1：插件采集支持停止任务
- 说明：允许用户在任务执行中主动停止插件采集任务，防止无意义持续运行。
- 关键实现要点：
  - 插件侧（Task Producer）：采集任务需支持可取消状态机/事件订阅。
  - 主进程命令层：增加或复用统一 cancel 接口（`runtime:*`/`plugin:*`）接收 `taskId` 与来源。
  - IPC 协议：前端仅传递结构化 payload（`{taskId, source, reason?}`），不要以文本关键词判断。
  - 运行时资源回收：停止任务后回收文件句柄、临时目录与网络请求中的可取消令牌。
  - 状态回写：任务列表和历史记录必须及时更新为“已停止/已中断”。
- 验收：
  - 能在采集进行中点击“停止”并完成取消。
  - 任务状态与计数正确回滚，不会出现重复悬挂。
  - 停止操作有失败码和可追踪错误信息。
- 依赖：
  - 插件本身负责触发终止信号；桌面端负责命令路由和状态收敛。
- 完成记录：
  - `Plugin/sidepanel.html` 在任务队列区增加统一停止控件。
  - `Plugin/sidepanel.js` 复用现有 `xhs:control-active-task` 的 `cancel` 动作，让非博主采集任务也能从队列直接停止。

## 待办 2：知识库支持批量删除
- 说明：知识库条目支持多选，支持一次提交删除多个条目。
- 关键实现要点：
  - 知识库数据层：新增批量删除 mutation，支持事务内批量执行，返回每条删除结果。
  - 权限与边界：校验调用方权限与 ownership 后再批量执行。
  - 前端交互：支持“多选/全选 + 批量删除”，避免冗余解释性文案。
  - 错误分层：失败条目返回独立错误码，不阻塞已成功条目。
  - 回滚策略：大规模批量采用分页分批执行，避免锁持有期间进行重 IO。
- 验收：
  - 批量删 5/50/200 条都能稳定完成。
  - 失败时保留成功记录并给出可读错误聚合。
  - 操作后列表不清空，支持刷新失败时旧数据保留。
- 完成记录：
  - `desktop/src-tauri/src/commands/library.rs` 增加 `knowledge:delete-batch`，按条目类型调用现有删除能力，并返回逐条结果。
  - `desktop/src/bridge/ipcRenderer.ts` 和 `desktop/src/types.d.ts` 增加 `knowledge.deleteBatch`。
  - `desktop/src/pages/Knowledge.tsx` 增加当前可见多选、清空选择和批量删除按钮，删除成功后只移除成功条目。

## 共通约束
- 设计时优先复用现有 IPC channel 分组与 tool contract，禁止新增“万能”能力。
- 优先级：P1。
- 推荐执行序：先完成“插件采集停止”链路打通，再完成“知识库批量删除”完整回归。
