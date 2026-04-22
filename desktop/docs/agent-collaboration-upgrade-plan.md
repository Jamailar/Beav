# Agent Collaboration Upgrade Plan

Status: Current

更新时间：2026-04-21

## Scope

这份文档定义 `LexBox` 的下一代 agent 协作系统升级目标。

覆盖范围：

- `src-tauri/src/runtime/*`
- `src-tauri/src/subagents/*`
- `src-tauri/src/tools/*`
- `src-tauri/src/mcp/*`
- `src/runtime/*`
- `src/pages/Chat.tsx`
- `src/pages/RedClaw.tsx`
- `src/pages/Workboard.tsx`
- 视频编辑协作桥接面

不覆盖范围：

- 旧 `archive/desktop-electron/` Electron 产品线
- 现有 `Team.tsx` 的创意群聊/顾问产品语义重构
- 与本升级无关的官网、插件或发布链路

## Goal

把当前 `LexBox` 已具备的：

- real child runtime
- runtime task
- tool pack / capability guard
- MCP runtime
- script runtime
- RedClaw 长任务体系
- 视频编辑与媒体处理能力

收束成一套真正可用的协作系统，而不是停留在“内部有 subagent、外部看不到协作面”的状态。

升级完成后的目标不是“多几个 prompt 角色”，而是以下四件事同时成立：

1. 宿主里有统一的协作控制平面。
2. 内建 child runtime 和外部 ACP agent 走同一套协作协议。
3. renderer 里能看见成员、任务、审批、工件和失败恢复。
4. 协作结果能直接驱动稿件、封面、视频、知识整理等真实产物。

## Why This Upgrade Exists

当前系统已经有不错的内部基础：

- [src-tauri/src/subagents/spawner.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/spawner.rs)
- [src-tauri/src/subagents/policy.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/policy.rs)
- [src-tauri/src/commands/runtime_orchestration.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_orchestration.rs)
- [src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)
- [src-tauri/src/scheduler/job_runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/scheduler/job_runtime.rs)

但它还缺少四个关键层：

1. 没有统一的 agent 注册表与健康面。
2. 没有统一的 mailbox / task board / approval 协作协议。
3. `runtime:subagent-*` 事件没有形成用户可见的协作 UI。
4. 视频/媒体链路还没有和协作调度正式打通。

`AionUi` 值得吸收的部分不是“支持 ACP”本身，而是它把以下能力做成了系统层：

- agent 发现与能力探测
- ACP 会话状态机
- Team MCP 协作工具
- 命令队列
- 权限确认
- 团队交互 UI
- 集成级验证

可参考：

- [/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpConnection.ts](/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpConnection.ts)
- [/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpDetector.ts](/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpDetector.ts)
- [/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/mcp/team/TeamMcpServer.ts](/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/mcp/team/TeamMcpServer.ts)
- [/Users/Jam/LocalDev/GitHub/AionUi/docs/design/agent-team-guide-flow.md](/Users/Jam/LocalDev/GitHub/AionUi/docs/design/agent-team-guide-flow.md)

## Architecture Decision

本升级存在三种路径：

### Option A

继续强化 prompt-based subagent。

优点：

- 改动最小
- 不需要新的宿主层模块

缺点：

- 仍然是“父代理脑内分饰多角”
- 无法支持真正的并行、审批、恢复、工件归档
- 无法支撑视频编辑、媒体导出、长任务协作

### Option B

只强化内部 real child runtime，不接外部 ACP 协作。

优点：

- 宿主控制力强
- 安全边界更简单

缺点：

- 无法利用外部 coding agent / ACP CLI 生态
- 用户对“协作成员”的可感知度弱
- 后续扩展外部 agent 时要再做一遍协作协议

### Option C

以内部 child runtime 作为执行内核，以外部 ACP agent 作为可插拔协作成员，再用统一协作控制平面把两者收口。

优点：

- 内部执行和外部扩展不分裂
- 安全边界、审批、工件、任务板只维护一套
- 能同时服务 `Chat`、`RedClaw`、`Workboard`、视频编辑

缺点：

- 宿主层改动最大
- 要新增较多契约与 UI

### Selected Architecture

选择 `Option C`。

原因：

- `LexBox` 已经具备 real child runtime 和 task/job 基础。
- 产品不只是聊天，还要覆盖稿件、知识、封面、视频。
- 只做 prompt 或只做内部引擎，都会在媒体执行层失去价值。

## Entry Points

当前主要入口：

- [src-tauri/src/commands/runtime_query.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_query.rs)
- [src-tauri/src/commands/runtime_orchestration.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_orchestration.rs)
- [src-tauri/src/subagents/spawner.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/spawner.rs)
- [src/pages/Chat.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Chat.tsx)
- [src/pages/RedClaw.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/RedClaw.tsx)
- [src/pages/Workboard.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Workboard.tsx)

升级后的新增入口建议：

- `src-tauri/src/agent_hub/mod.rs`
- `src-tauri/src/runtime/collab_runtime.rs`
- `src-tauri/src/subagents/mailbox.rs`
- `src-tauri/src/subagents/task_board.rs`
- `src-tauri/src/subagents/team_tools.rs`
- `src-tauri/src/commands/runtime_collab.rs`
- `src/pages/workboard/AgentCollaborationPanel.tsx`
- `src/components/chat/CollaborationDrawer.tsx`

## Target Architecture

### Layer 1: Agent Directory And Health Plane

目标：统一发现、登记、刷新、探活全部 agent 来源。

来源分为三类：

- `internal-runtime-agent`
- `external-acp-agent`
- `future-remote-agent`

建议新增：

- `src-tauri/src/agent_hub/registry.rs`
- `src-tauri/src/agent_hub/detector.rs`
- `src-tauri/src/agent_hub/health.rs`
- `src-tauri/src/agent_hub/capabilities.rs`
- `src-tauri/src/agent_hub/types.rs`

核心职责：

- 扫描本地可用 ACP CLI
- 探测 mode / model / tool / MCP 支持情况
- 对 agent 做健康检查
- 为 renderer 返回归一化后的 agent 列表
- 缓存检测结果，避免频繁冷启动探测

推荐数据结构：

```rust
pub struct AgentRegistryRecord {
    pub agent_id: String,
    pub source_kind: String,
    pub backend: String,
    pub display_name: String,
    pub connection_type: String,
    pub cli_path: Option<String>,
    pub supported_modes: Vec<String>,
    pub supported_models: Vec<String>,
    pub supported_transports: Vec<String>,
    pub supported_capabilities: Vec<String>,
    pub health_status: String,
    pub last_health_check_at: Option<i64>,
    pub metadata: Option<Value>,
}
```

实现原则：

- CLI 检测、PATH 增强、握手探活可借鉴 `AionUi` 的 ACP 检测方式。
- `LexBox` 内部的 agent 归一化类型、缓存结构、renderer 接口必须自研。

### Layer 2: Collaboration Control Plane

目标：把“父任务派发子任务、消息流转、审批、结果聚合”从 prompt 逻辑提到宿主层。

建议新增：

- `src-tauri/src/runtime/collab_runtime.rs`
- `src-tauri/src/subagents/mailbox.rs`
- `src-tauri/src/subagents/task_board.rs`
- `src-tauri/src/subagents/approval_runtime.rs`
- `src-tauri/src/subagents/session_links.rs`

核心数据结构：

```rust
pub struct CollabSessionRecord {
    pub id: String,
    pub parent_runtime_id: String,
    pub parent_task_id: String,
    pub owner_session_id: Option<String>,
    pub runtime_mode: String,
    pub status: String,
    pub members: Vec<CollabMemberRecord>,
    pub work_items: Vec<CollabWorkItemRecord>,
    pub approvals: Vec<CollabApprovalRecord>,
    pub artifact_refs: Vec<CollabArtifactRef>,
    pub metadata: Option<Value>,
}
```

```rust
pub struct CollabWorkItemRecord {
    pub id: String,
    pub collab_session_id: String,
    pub title: String,
    pub assigned_member_id: Option<String>,
    pub status: String,
    pub priority: String,
    pub required_capabilities: Vec<String>,
    pub blocker_reason: Option<String>,
    pub artifact_refs: Vec<String>,
    pub metadata: Option<Value>,
}
```

```rust
pub struct MailboxMessageRecord {
    pub id: String,
    pub collab_session_id: String,
    pub from_member_id: String,
    pub to_member_id: Option<String>,
    pub work_item_id: Option<String>,
    pub message_type: String,
    pub content: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}
```

关键规则：

- 父任务不再直接“拼接 prior outputs”作为唯一协作机制。
- 每个 child runtime 或外部 ACP agent 都是 `collab member`。
- 成员间通信走 mailbox，不共享大 transcript。
- 工作分配走 task board，不靠自然语言暗示。
- 审批请求必须进入 approval queue，不埋在 message text 里。

### Layer 3: Unified Team Tool Surface

目标：内部 child runtime 和外部 ACP agent 使用同一套协作动作。

禁止事项：

- 新增大量顶层工具
- 把“团队能力”拆成另一套独立工具面

正确方式：

- 内部 agent 使用 `app_cli`
- 外部 ACP agent 注入 `redbox-team` MCP server
- 两者底层都落到同一组宿主动作

`app_cli` 建议新增命名空间：

- `team list-members`
- `team list-work-items`
- `team create-work-item`
- `team claim-work-item`
- `team update-work-item`
- `team send-message`
- `team list-mailbox`
- `team request-approval`
- `team save-artifact`

相关文件：

- [src-tauri/src/tools/app_cli.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/app_cli.rs)
- [src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs)
- [src-tauri/src/tools/guards.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/guards.rs)

外部 ACP 接入建议新增：

- `src-tauri/src/mcp/team_server.rs`
- `src-tauri/src/mcp/team_stdio_bridge.rs`

暴露工具：

- `team_send_message`
- `team_list_members`
- `team_list_work_items`
- `team_claim_work_item`
- `team_update_work_item`
- `team_request_approval`
- `team_save_artifact`

### Layer 4: Typed Result Contract

当前 `SubAgentOutput` 已有基础，但还偏轻。

目标合同应覆盖：

- `summary`
- `artifact`
- `artifactRefs`
- `findings`
- `risks`
- `issues`
- `handoff`
- `claim`
- `blockedBy`
- `approvalsRequested`
- `approved`
- `status`

建议扩展：

- [src-tauri/src/subagents/types.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/types.rs)
- [src-tauri/src/subagents/aggregation.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/aggregation.rs)

重点不是“返回更多字段”，而是让这些字段成为：

- renderer 展示面
- reviewer 判断面
- repair 流程输入
- artifact 保存索引
- runtime task 恢复依据

### Layer 5: Approval And Capability Plane

目标：把审批从单次 tool confirm 升级为协作会话级策略。

策略层级：

- `manual`
- `auto-safe`
- `yolo`
- `blocked`

策略维度：

- 成员身份
- 来源类型
- runtime mode
- capability set
- 工作项类型

高风险动作：

- 写文件
- 覆盖稿件
- 发布
- 远程调用
- MCP 写操作
- 脚本执行
- 媒体导出

建议新增：

- `src-tauri/src/runtime/approval_runtime.rs`

并接入：

- [src-tauri/src/tools/guards.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/guards.rs)
- [src-tauri/src/commands/runtime_orchestration.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_orchestration.rs)
- [src-tauri/src/runtime/task_runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/task_runtime.rs)

硬规则：

- 不按用户文案关键词判断权限。
- 权限必须绑定到 typed capability 和 typed action。
- 后台任务和 subagent 默认比交互式会话更严格。

### Layer 6: Product UI Surfaces

目标：把内部协作能力变成可见、可管理、可恢复的用户界面。

不建议做法：

- 直接把 [src/pages/Team.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Team.tsx) 改成运行时协作页

原因：

- `Team` 当前产品语义是群聊/顾问
- 直接改会让现有功能和 AI runtime 协作混在一起

推荐 UI 方案：

#### Chat Collaboration Drawer

在 [src/pages/Chat.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Chat.tsx) 新增右侧抽屉：

- 当前协作成员
- 当前 work items
- mailbox 摘要
- approval queue
- artifacts

#### RedClaw Collaboration Drawer

在 [src/pages/RedClaw.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/RedClaw.tsx) 提供针对长任务的协作面：

- 长任务状态
- 子任务执行波次
- 失败修复入口
- artifact lineage

#### Workboard Agent Collaboration Panel

在 [src/pages/Workboard.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Workboard.tsx) 新增正式的协作控制板：

- collab session 列表
- task board
- member health
- retry / cancel / reassign
- diagnostics

renderer 事件面建议新增：

- `runtime:mailbox-updated`
- `runtime:work-item-updated`
- `runtime:approval-updated`
- `runtime:artifact-linked`

在保留现有：

- `runtime:subagent-started`
- `runtime:subagent-finished`
- `runtime:task-node-changed`
- `runtime:checkpoint`

### Layer 7: Artifact And Delivery Plane

目标：协作结果必须能进入真实产物，而不是停留在 chat summary。

产物类型：

- manuscript
- cover
- video project
- media package
- knowledge artifact

宿主职责：

- 工件保存
- 工件索引
- 工件引用回写到 collab session
- 工件与 runtime task / work item 建立 lineage

建议新增：

- `src-tauri/src/runtime/artifact_registry.rs`
- `src-tauri/src/runtime/artifact_links.rs`

现有复用点：

- [src-tauri/src/commands/runtime_orchestration.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_orchestration.rs)
- [src-tauri/src/runtime/task_runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/task_runtime.rs)

## Video And Media Collaboration Design

这是本升级必须单独设计的部分。

原因：

- `LexBox` 不是通用聊天产品。
- 视频、音频、封面、字幕、时间线、导出是核心价值链。
- 如果协作系统不能驱动这些产物，它就只有演示价值，没有产品价值。

### Video Roles

建议的标准角色：

- `storyboard_designer`
- `animation_director`
- `timeline_editor`
- `subtitle_editor`
- `reviewer`

角色职责：

- `storyboard_designer` 负责镜头结构、场景顺序、节奏提案。
- `animation_director` 负责 Remotion scene 结构与动画参数。
- `timeline_editor` 负责真正的 clip/track 调整。
- `subtitle_editor` 负责字幕文本、分段和时间轴对齐。
- `reviewer` 负责核验导出条件、素材缺失、时间线一致性。

### Source Of Truth

视频协作不能让 agent 直接操作 React 状态。

真实真相必须仍然在宿主和工程文件：

- timeline truth
- remotion truth
- export job truth
- artifact truth

可参考：

- [src/features/video-editor/store/useVideoEditorStore.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/features/video-editor/store/useVideoEditorStore.ts)
- [prompts/library/runtime/agents/video_editor/README.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/prompts/library/runtime/agents/video_editor/README.md)
- [prompts/library/runtime/pi/video_editor.txt](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/prompts/library/runtime/pi/video_editor.txt)

### Execution Contract

针对视频编辑，agent 不直接操作 UI，只能做以下动作：

- `timeline_read`
- `timeline_patch`
- `remotion_read`
- `remotion_patch`
- `subtitle_read`
- `subtitle_patch`
- `export_request`
- `export_status`

这些动作必须经由 `app_cli` 的结构化命令暴露，而不是让 agent 直接拼文件路径和 JSON。

建议新增：

- `app_cli(command="video timeline read ...")`
- `app_cli(command="video timeline patch ...")`
- `app_cli(command="video remotion read ...")`
- `app_cli(command="video remotion patch ...")`
- `app_cli(command="video export request ...")`

### Rendering Stack

视频渲染层建议明确分工：

- `FreeCut timeline UI` 负责交互编辑体验
- `Remotion` 负责动画表达
- `FFmpeg` 负责转码、拼接、音视频处理
- `job_runtime` 负责长任务队列、重试、状态同步

这四层不要混在一个 agent prompt 里表达。

## Library Versus In-House Boundary

### Must Reuse Existing Libraries

- ACP CLI / ACP bridge 生态
- MCP transport
- Remotion
- FFmpeg
- 现有 FreeCut timeline UI

### Can Borrow Design But Must Rebuild In Repo

- agent detector 设计
- ACP 会话状态机思想
- Team MCP server 形态
- command queue 体验

### Must Be Built In-House

- collaboration control plane
- mailbox / task board
- approval runtime policy
- typed artifact lineage
- runtime-to-video command bridge
- renderer collaboration UI
- unified registry between internal and external agents

## Performance Strategy

### Context And Prompt Cost

- child runtime 默认只继承摘要上下文
- mailbox 消息默认摘要化，不传播全量 transcript
- orchestration 事件只传 `id / role / status / summary / refs`
- work item 读取默认分页

### Host Performance

- agent detection 和 health check 必须缓存
- 冷启动探测必须后台刷新
- 高开销 CLI 探活不能阻塞页面切换
- 协作存储更新采用窄锁和最终写回模式

### Renderer Performance

- `Chat` / `RedClaw` 协作抽屉走 stale-while-revalidate
- 大量 mailbox / trace / artifact 列表必须虚拟化
- 打开协作面板时优先渲染摘要，再异步补详情

### Media Execution Performance

- 导出、转码、缩略图、字幕处理全部进入 job queue
- 渲染与转码必须脱离 UI 临界路径
- 视频项目读取先读 summary，再懒加载完整 timeline

### Parallelism Strategy

- 文本/研究型角色允许 `2-4` 并行
- 视频/媒体型角色默认降到 `1-2` 并行
- reviewer 默认串行在尾波执行
- 审批等待期间暂停该 work item timeout

## Failure Model

系统必须显式支持这些失败态：

- agent detector 发现失败
- ACP 会话启动失败
- member 中途崩溃
- 子任务超时
- approval 长时间未处理
- artifact 保存失败
- 视频导出失败
- parent cancel 递归取消 child
- 恢复后 mailbox / work item / artifact 能重新装载

恢复原则：

- 失败不丢最后一次成功摘要
- work item 保留 `blocked` 和 `failed` 区分
- child crash 必须记录到 collab session
- 允许人工 `retry / reassign / force close`

## Change Rules

实施过程中必须遵守这些规则：

- 不新增一组新的顶层协作工具面，统一收敛到 `app_cli` 和 `redbox-team` MCP server。
- 不让 renderer 直接管理协作真相，真相必须在宿主 store。
- 不让 agent 直接写视频编辑 React 状态。
- 不把审批逻辑埋在 prompt 文案里。
- 不把协作 UI 强行塞到现有 `Team` 群聊产品语义里。
- 不把外部 ACP agent 作为唯一协作实现，内部 child runtime 仍是默认执行内核。

## Verification

### Host Verification

- `cargo check`
- runtime query 真实触发协作
- runtime task resume / cancel / trace 验证
- collab session 持久化与恢复验证
- approval queue 创建、处理、重放验证

### Renderer Verification

- `Chat` 打开协作抽屉时无阻塞
- `RedClaw` 长任务协作状态实时刷新
- `Workboard` 可查看成员、任务、审批、工件
- 快速切换 session 时协作事件不会串台

### Integration Verification

- fake ACP agent 握手 + team MCP 工具调用
- internal child runtime 与 external ACP agent 混合协作
- parent cancel 递归终止 child
- 崩溃后恢复 collab session

### Media Verification

- 视频项目读取 summary 与详情的分层加载
- timeline patch 后预览正确
- remotion patch 后工程可再打开
- export request 可进入 job queue 并回写 artifact

## Atomic Commit Plan

目标架构一次定义完整，但代码实施仍然必须按 atomic commits 切割。

推荐提交边界：

1. `agent_hub` 注册表、探测与健康检查
2. `collab session`、mailbox、task board 数据模型和持久化
3. `app_cli team` 子命令与宿主动作
4. `redbox-team` MCP server 和 ACP 注入桥
5. approval runtime policy 统一
6. renderer 协作抽屉与 workboard 面板
7. 视频协作桥与导出接线
8. 集成测试、文档、回归修补

每个提交只做一件事，不能把数据模型、UI、媒体桥和测试混成一个大提交。

## Related Files

- [src-tauri/src/commands/runtime_query.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_query.rs)
- [src-tauri/src/commands/runtime_orchestration.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_orchestration.rs)
- [src-tauri/src/subagents/spawner.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/spawner.rs)
- [src-tauri/src/subagents/policy.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/policy.rs)
- [src-tauri/src/subagents/aggregation.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/aggregation.rs)
- [src-tauri/src/runtime/task_runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/task_runtime.rs)
- [src-tauri/src/tools/app_cli.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/app_cli.rs)
- [src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)
- [src/pages/Chat.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Chat.tsx)
- [src/pages/RedClaw.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/RedClaw.tsx)
- [src/pages/Workboard.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Workboard.tsx)
- [src/features/video-editor/store/useVideoEditorStore.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/features/video-editor/store/useVideoEditorStore.ts)
- [/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpConnection.ts](/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpConnection.ts)
- [/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpDetector.ts](/Users/Jam/LocalDev/GitHub/AionUi/src/process/agent/acp/AcpDetector.ts)
- [/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/mcp/team/TeamMcpServer.ts](/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/mcp/team/TeamMcpServer.ts)
