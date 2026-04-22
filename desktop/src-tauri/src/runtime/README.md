# `src-tauri/src/runtime/`

本目录承载当前 Rust runtime 的拆分实现，是会话、任务、编排和事件运行时的核心区域。

## Main Files

- `types.rs`: runtime 结构定义
- `events.rs`: runtime 事件相关辅助
- `config_runtime.rs`: 配置解析和运行时配置装配
- `interactive_loop.rs`: 交互式 loop
- `session_runtime.rs`: session 维度运行时逻辑
- `task_runtime.rs`: task 维度运行时逻辑
- `orchestration_runtime.rs`: 编排层运行时逻辑
- `agent_engine.rs`: 与 agent 执行引擎协作

## Rules

- 结构定义优先集中，不要在 commands 内散落复制 runtime record。
- 新运行时模式优先落在这里，再由 commands 暴露出去。
- 事件输出与状态持久化边界要清晰分开。

## Verification

- 验证 session、task、tool、checkpoint 全链路
- 验证恢复、继续执行和任务完成
