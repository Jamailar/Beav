# Runtime Events Contract

Status: Current

## Scope

覆盖统一 `runtime:event` 包络和 renderer 兼容消费层，不覆盖所有历史 `chat:*` 事件的完整细节。

## Source Of Truth

- [src-tauri/src/events/README.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/events/README.md)
- [src-tauri/src/runtime/contracts.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/contracts.rs)
- [src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)

## Envelope Shape

统一事件至少包含：

- `eventType`
- `sessionId`
- `taskId`
- `runtimeId`
- `parentRuntimeId`
- `payload`
- `timestamp`

## Main Event Types

- `runtime:stream-start`
- `runtime:text-delta`
- `runtime:done`
- `runtime:tool-start`
- `runtime:tool-update`
- `runtime:tool-end`
- `runtime:task-node-changed`
- `runtime:subagent-started`
- `runtime:subagent-finished`
- `runtime:checkpoint`
- `runtime:collab-session-changed`
- `runtime:collab-member-changed`
- `runtime:collab-task-changed`
- `runtime:collab-report-submitted`
- `runtime:collab-message-delivered`
- `runtime:collab-report-tick`

## Collaboration Payloads

协作事件由宿主 store 负责发出，renderer 只消费快照，不持有事实源。

- `runtime:collab-session-changed`: `payload.collabSessionId` 和 `payload.session`
- `runtime:collab-member-changed`: `payload.collabSessionId` 和 `payload.member`
- `runtime:collab-task-changed`: `payload.collabSessionId` 和 `payload.task`
- `runtime:collab-report-submitted`: `payload.collabSessionId` 和 `payload.report`
- `runtime:collab-message-delivered`: `payload.collabSessionId` 和 `payload.message`
- `runtime:collab-report-tick`: `payload.collabSessionId` 和 `payload.outcome`

真实 child runtime 会自动投影为协作成员和任务：

- parent runtime task 创建或复用一个 `CollabSessionRecord`
- 每个 child runtime 创建一个 `CollabMemberRecord`
- 每个 child runtime task 创建一个 `CollabTaskRecord`
- child 完成或失败时写入 `CollabProgressReportRecord` 并更新 task 状态

## Consumption Rules

- renderer 必须按 `sessionId` 过滤非当前会话事件
- task 相关 UI 再按 `taskId` 细分
- 事件 payload 可能部分缺失，消费端必须容错
- 新能力优先挂在统一 `runtime:event`，历史 `chat:*` 仅做兼容
- 协作 UI 必须按 `payload.collabSessionId` 过滤事件，避免快速切换看板时串台
- 协作 UI 刷新失败时保留最后一次成功快照，并显示 inline error

## Team MCP Contract

`redbox-team` MCP 合同由宿主内的 `src-tauri/src/mcp/team_server.rs` 定义。外部 ACP agent 应通过 bridge config 注入这些工具，内部 child runtime 直接调用同一组 host action。

- `team_list_members`
- `team_match_member`
- `team_rename_agent`
- `team_shutdown_agent`
- `team_list_work_items`
- `team_send_message`
- `team_claim_work_item`
- `team_update_work_item`
- `team_request_report`
- `team_submit_report`
- `team_save_artifact`
- `team_raise_blocker`

对应宿主动作仍保持 schema-first、single-action：

- `team.members.list`
- `team.member.match`
- `team.member.rename`
- `team.member.shutdown`
- `team.task.list`
- `team.message.send`
- `team.task.update`
- `team.report.request`
- `team.report.submit`
- `team.artifact.attach`
- `team.blocker.raise`

## Verification

- 发起一次真实 runtime 会话
- 确认 `thinking`、文本流、工具调用、完成事件都可达
- 快速切换 session 时，旧事件不会污染当前页面
- 运行 `cargo test collab_`
- 运行 `cargo test team_tool_`
- 运行 `cargo test team_mcp_`
- 运行 `cargo test subagent_spawn_creates_child_task_and_session_links`
