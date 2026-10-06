# `src-tauri/src/subagents/`

本目录实现子代理的策略、拉起、聚合和类型定义。

## Main Files

- `policy.rs`: 子代理策略
- `spawner.rs`: 子代理拉起
- `aggregation.rs`: 结果聚合
- `types.rs`: 子代理类型
- `team_tools.rs`: 内部 runtime 和 ACP MCP 共用的团队 host action 映射
- `mailbox.rs`: 协作成员消息收发和 report request
- `team_task_board.rs`: 协作任务创建、移动和更新
- `wake_runtime.rs`: report tick、活跃成员唤醒和 stale 状态处理

## Rules

- 子代理策略和执行细节分开，避免在 spawner 内塞满调度判断。
- 父子 runtime/task/session 关联字段必须稳定。
- 聚合逻辑必须考虑失败、超时和部分结果。
- 真实 child runtime 必须投影到协作看板：创建 member、task，并在完成/失败时提交 report。
- 内部成员和外部 ACP 成员必须共享同一套 `team.*` host action，不分叉两套行为。

## Verification

- 至少验证一次子代理启动与完成
- 验证父任务能正确收到聚合结果
- `cargo test subagent_spawn_creates_child_task_and_session_links`
- `cargo test team_tool_`
