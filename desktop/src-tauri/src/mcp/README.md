# `src-tauri/src/mcp/`

本目录实现 MCP 管理、会话和传输能力。

## Main Files

- `manager.rs`: MCP 管理器与调用入口
- `session.rs`: MCP 会话状态
- `transport.rs`: 传输与本地配置发现
- `resources.rs`: MCP 资源处理
- `team_server.rs`: `redbox-team` MCP 工具合同和宿主动作映射

## Rules

- MCP 客户端创建与生命周期统一由这里管理，不要在其他模块私起 stdio client。
- 传输层和资源层分开，避免 manager 变成大杂烩。
- 配置发现和调用结果结构应保持稳定，便于 runtime 和 commands 复用。
- 团队成员由内部 runtime 创建和驱动；不要为外部 agent 进程新增 stdio bridge 入口。
- MCP 工具必须映射到 `team_tools.rs` 的单一 host action，避免把多步 orchestration 塞进工具。

## Verification

- 验证本地 MCP 配置发现
- 验证至少一条 MCP 调用或 probe 链路
- `cargo test team_mcp_`
