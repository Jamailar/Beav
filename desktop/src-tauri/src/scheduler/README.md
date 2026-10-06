# `scheduler/` 模块

## 职责

- 任务下一次触发时间计算（scheduled / long-cycle）。
- RedClaw job definition 同步与派生后台任务状态。
- `task_policy.rs` 提供 preview/create/confirm 前的策略治理、冲突检测与 schedule 归一化。

## 关键点

- 仅负责调度计算与状态派生，不承担模型调用执行。
- 执行逻辑在 `run_redclaw_scheduler` 与 runtime 命令链路中完成。
- 调度主链现在会为 `task.enqueued / task.start / task.finish` 发出统一 checkpoint，并在执行记录里持久化 `runId / scheduledForAt / idempotencyKey / retryBucket`。
