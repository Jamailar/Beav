# `scheduler/` 模块

## 职责

- 任务下一次触发时间计算（scheduled / long-cycle）。
- RedClaw job definition 同步与派生后台任务状态。

## 关键点

- 仅负责调度计算与状态派生，不承担模型调用执行。
- 执行逻辑在 `run_redclaw_scheduler` 与 runtime 命令链路中完成。
