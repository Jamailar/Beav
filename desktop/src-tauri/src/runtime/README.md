# `src-tauri/src/runtime/`

本目录承载当前 Rust runtime 的拆分实现，是会话、任务、编排和事件运行时的核心区域。

## Main Files

- `types.rs`: runtime 结构定义
- `events.rs`: runtime 事件相关辅助
- `context_fragments.rs`: 可预算、可截断的 runtime context 片段
- `media_ref.rs`: AI / media payload 中引用媒体的结构化抽取与预算校验
- `config_runtime.rs`: 配置解析和运行时配置装配
- `interactive_loop.rs`: 交互式 loop
- `session_runtime.rs`: session 维度运行时逻辑
- `session_runtime/export.rs`: session 导出包与 canonical item 投影
- `task_runtime.rs`: task 维度运行时逻辑
- `orchestration_runtime.rs`: 编排层运行时逻辑
- `agent_engine.rs`: 与 agent 执行引擎协作

## Rules

- 结构定义优先集中，不要在 commands 内散落复制 runtime record。
- 新运行时模式优先落在这里，再由 commands 暴露出去。
- 事件输出与状态持久化边界要清晰分开。
- 结构化运行事件写入 `AppStore.runtime_events`，默认只保留最近 1000 条，payload 会截断；不要写入 API key、完整 provider 响应或大体积媒体内容。
- 诊断查询走 `runtime:get-events` / `runtime get-events`，按 `sessionId`、`category`、`eventType`、`includeChildSessions`、`limit` 过滤。
- 媒体生成类事件统一使用 `category=media_generation`，生命周期事件优先使用 `request.started`、`request.completed`、`request.failed`、`response.empty`、`asset.write_failed`。
- 会话导出走 `runtime:export-session`，入参至少包含 `sessionId`，可选 `includeChildSessions` 与 `writePackage`。默认写出本地 package，包含 `manifest.json`、`sessions.jsonl`、`session-items.jsonl`、`messages.json`、`transcript-records.jsonl`、`transcript-file-entries.jsonl`、`checkpoints.jsonl`、`tool-results.jsonl`、`runtime-events.jsonl`、`bundle-messages.json`。
- `session-items.jsonl` 是导出包内的 canonical replay/proof 投影；每行必须带 `itemId`、`sessionId`、`kind`、`createdAt`、`payload`，能推断时带 `turnId`。不要把大媒体正文或 provider 原始大响应塞进 canonical item，使用 artifact/media refs。
- 会话导入走 `runtime:import-session`，入参为 `packagePath`，可选 `overwrite`。导入保留原 session id；目标已存在时默认拒绝，只有 `overwrite=true` 才替换同 id 会话及其消息、trace、checkpoint、tool result、runtime event。

## Verification

- 验证 session、task、tool、checkpoint 全链路
- 验证恢复、继续执行和任务完成
- 改 runtime event / context / media ref 时至少跑对应定向 Cargo 测试。
- 改 session 导出/导入契约时至少跑 `cargo test runtime::session_runtime::tests::` 和 `cargo check`。
