# Collaboration Runtime

Collaboration Runtime 是 Team / Workboard 的宿主侧控制面。它保存结构化协作状态，并只通过系统内部 runtime agent 创建和驱动团队成员；成员执行器和 UI 看板都必须通过这里读写协作状态。

## Store Records

- `CollabSessionRecord`: 一次多人协作的根记录，关联可选 `ownerSessionId`，承载目标、状态、runtime mode 和来源。
- `CollabMemberRecord`: 协作成员，记录角色、adapter 类型、能力、期望/当前模型配置、当前任务和进度汇报节奏。
- `CollabTaskRecord`: 看板任务，记录负责人、依赖、状态、优先级、runtime task 引用、产物和结果摘要。
- `CollabMailboxMessageRecord`: 成员之间或宿主到成员的结构化消息。
- `CollabProgressReportRecord`: 成员定期进度汇报；提交报告时会同步更新成员状态和对应任务状态。

这些记录持久化在 `AppStore` 中，依赖 `serde(default)` 保持旧状态文件兼容。

## IPC Channels

所有通道走现有 `ipc_invoke` 和 `runtime_session` 分发，不新增顶层 Tauri command。正式命名空间是 `team-runtime:*`，旧 `collab:*` 保留为兼容别名。

- `team-runtime:list-sessions`: 返回协作会话列表，按 `updatedAt` 倒序。
- `team-runtime:create-session`: 创建协作会话。
- `team-runtime:get-session`: 返回 session snapshot，包括 members、tasks、mailbox、reports。
- `team-runtime:list-members`: 列出成员。
- `team-runtime:add-member`: 增加协作成员；产品入口只创建 `internal_runtime` 成员。
- `team-runtime:execute-tool(action=team.member.match)`: 按 agent card、能力、工具策略和负载匹配成员。
- `team-runtime:execute-tool(action=team.member.rename)`: 修改成员显示名或角色，不删除历史。
- `team-runtime:execute-tool(action=team.member.shutdown)`: 将成员标记为 offline/suspended，不删除历史。
- `team-runtime:list-tasks`: 列出看板任务。
- `team-runtime:create-task`: 创建看板任务，校验负责人、reviewer 和依赖归属。
- `team-runtime:update-task`: 更新任务状态、负责人、reviewer、依赖、产物和摘要。
- `team-runtime:list-messages`: 读取 mailbox 历史。
- `team-runtime:read-mailbox`: 读取 unread mailbox 并可原子标记已读。
- `team-runtime:send-message`: 写入结构化 mailbox 消息。
- `team-runtime:list-reports`: 读取成员/任务进度汇报。
- `team-runtime:request-report`: 写入 `report_request` mailbox 消息。
- `team-runtime:submit-report`: 写入进度汇报，并同步成员与任务状态。
- `team-runtime:execute-tool(action=team.artifact.attach)`: 通过结构化 artifact report 给任务附加产物。
- `team-runtime:execute-tool(action=team.blocker.raise)`: 提交 blocker report 并推动任务进入阻塞态。
- `team-runtime:pause-session`: 暂停协作会话。
- `team-runtime:resume-session`: 恢复协作会话。
- `team-runtime:archive-session`: 归档协作会话。
- `team-runtime:tick-reports`: 执行一次宿主侧汇报调度 tick。
- `team-runtime:list-agent-backends`: 返回可用内部 runtime；不暴露外部 agent CLI。
- `team-runtime:list-tools`: 返回团队工具描述。
- `team-runtime:execute-tool`: 执行 schema-first 团队工具 action。
- `team-runtime:mcp-contract`: 返回 `redbox-team` MCP 工具合同。
- `team-runtime:execute-mcp-tool`: 在宿主内执行一个 `redbox-team` MCP 工具调用。
- `task-panel:list`: 返回后端统一任务投影，将 RedClaw 任务、协作任务和待审批事项聚合为同一个任务流，供 Workboard 默认视图读取。

Renderer 入口是 `window.ipcRenderer.teamRuntime`，兼容入口是 `window.ipcRenderer.collab`。页面不要直接调用 Tauri 原语。

## Event Contract

协作事件复用 `runtime:event`，事件类型使用 `runtime:collab-*`：

- `runtime:collab-session-changed`
- `runtime:collab-member-changed`
- `runtime:collab-task-changed`
- `runtime:collab-report-submitted`
- `runtime:collab-message-delivered`
- `runtime:collab-report-tick`

UI 看板应使用 stale-while-revalidate：先展示最近 snapshot，再监听 `runtime:event` 中的 `runtime:collab-*` 事件触发局部刷新，不要在刷新时清空页面。

## Execution Boundary

当前层是 host-owned state machine + internal runtime orchestration。成员执行器接入时必须遵守：

- 内部成员执行器只能通过 `team-runtime:submit-report` 和 `team-runtime:update-task` 汇报状态。
- Workboard 不创建外部 ACP/CLI 成员，也不提供外部进程运行按钮。
- 真实工具执行仍走现有 Runtime / tools / approval 边界，不允许在 collab runtime 内调用 agent，避免形成嵌套黑盒。

## AI Coordinator Entry

主 AI 不需要模拟点击 UI。正常对话 runtime 会通过 `Operate(resource, operation, input)` 获得模型可见的 team actions：

- `team.session.create`: 创建协作项目。
- `team.member.spawn`: 创建内部 runtime 成员。
- `team.member.match`: 为任务选择最合适的已有成员。
- `team.member.rename`: 修改成员显示名或角色。
- `team.member.shutdown`: 关闭或挂起成员。
- `team.task.create`: 创建看板任务并分配负责人。
- `team.message.send`: 写入成员 mailbox 消息。
- `team.report.request`: 请求成员进度汇报。
- `team.report.submit`: 写入结构化进度汇报。
- `team.artifact.attach`: 给任务附加产物。
- `team.blocker.raise`: 提交任务阻塞点。

当用户要求团队协作、多角色执行、看板追踪或定期汇报时，协调者 AI 应先创建 session，再创建内部成员和任务；不要建议安装或调用外部 ACP/CLI agent。
