---
doc_type: plan
execution_status: completed
last_updated: 2026-04-26
owner: ai-runtime
scope: desktop
target_files:
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/subagents/*
  - desktop/src-tauri/src/mcp/*
  - desktop/src-tauri/src/commands/runtime_*.rs
  - desktop/src/runtime/runtimeEventStream.ts
  - desktop/src/pages/Team.tsx
  - desktop/src/pages/Workboard.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/bridge/ipcRenderer.ts
status_note: Host-owned collaboration runtime, team-runtime IPC, mailbox/task/report state machine, team tools, real subagent-to-board projection, agent backend registry, redbox-team MCP contract, external adapter boundary, report tick, and Workboard collaboration UI are implemented. The 2026-04-26 V2 addendum is implemented across runtime contract, bridge, MCP, and Workboard controls: persistent group-chat coordination, speaker/executor separation contract, member agent cards, member task-plan continuity, executor capacity checks, deterministic member matching, completion claims, artifact/blocker helpers, and lightweight UI actions.
---

# ACP Team Workboard Collaboration Plan

Status: Completed

## 1. Goal

RedConvert 需要把当前“内部有 subagent / runtime task / Workboard，但用户看不清每个成员在做什么”的能力，升级成一个可见、可控、可恢复的团队协作系统。

目标不是做一个群聊外壳，而是让团队成员真正各自工作：

- 每个成员有独立身份、职责、会话上下文、任务队列和状态。
- 成员可以接收任务、执行工作、定期汇报进度、提交结果和阻塞原因。
- 用户可以在看板看到每个成员当前项目、任务、状态、最近汇报、产物和风险。
- 负责人或协调代理可以根据成员汇报继续派发、回收、重试、替换或总结。
- ACP agent、内部 child runtime、未来 remote agent 都走同一套协作协议。

## 2. What We Learned From AionUi

参考本地仓库 `/Users/Jam/LocalDev/GitHub/AionUi`。

### 2.1 Team Is A Runtime System, Not A Chat UI

AionUi 的 team 功能核心不在 renderer，而在 main process：

- `src/process/team/TeamSessionService.ts`
- `src/process/team/TeamSession.ts`
- `src/process/team/TeammateManager.ts`
- `src/process/team/Mailbox.ts`
- `src/process/team/TaskManager.ts`
- `src/process/team/mcp/team/TeamMcpServer.ts`

它的核心结构是：

```text
TeamSessionService
  -> creates team record
  -> creates one conversation per agent
  -> repairs missing team-agent links after restart
  -> owns active TeamSession map

TeamSession
  -> owns Mailbox
  -> owns TaskManager
  -> owns TeammateManager
  -> owns TeamMcpServer

TeammateManager
  -> wakes agents
  -> tracks active wakes
  -> watches streaming/finish events
  -> marks idle/failed
  -> notifies leader when members settle

TeamMcpServer
  -> exposes team_* tools to agents
  -> injects MCP stdio config into ACP sessions
  -> routes messages/tasks/spawn/rename/shutdown
```

This is the important lesson: team collaboration must be host-owned. Agents may decide, but the host owns task records, mailboxes, lifecycle, wake locks, timeouts, and visible status.

### 2.2 One Member = One Conversation = One Agent Process

AionUi follows a strong invariant:

```text
1 team member
  = 1 persisted TeamAgent slot
  = 1 conversation
  = 1 ACP/Gemini/Aionrs worker task
```

This gives each member a separate context window and independent failure domain. It also makes the UI simple: every tab/member card can point to a real conversation and a real status.

RedConvert already has internal child runtime records, but a child runtime is currently more like an execution branch than a persistent teammate. We should keep child runtimes, but add a higher-level `CollabMemberRecord` that can map to:

- internal runtime member
- external ACP member
- future remote member

### 2.3 Mailbox Is The Coordination Primitive

AionUi does not keep dependent members alive while they wait. It writes messages into a mailbox and wakes the target only when there is work.

This matters because live LLM streams have hard timeout limits. A member should not keep generating “standing by” text while waiting for another member. It should end its turn and be re-woken later.

RedConvert should copy this pattern:

- All member-to-member communication goes through a durable mailbox.
- Reading unread messages marks them read in one transaction.
- Wake is best-effort after durable mailbox write.
- A failed wake does not mean the message was not delivered.

### 2.4 The Leader Wakes When Members Are Settled

AionUi’s `TeammateManager` sends idle notifications to the leader after a member turn finishes, but only wakes the leader when all non-leader members are settled. This avoids leader loops where every individual idle event triggers a new dispatch while other members are still working.

RedConvert should use the same settled rule:

```text
settled = idle | completed | failed | pending | blocked

if all non-leader members are settled:
  wake coordinator/leader
else:
  only persist the progress event
```

### 2.5 Team Tools Should Be Narrow And Structured

AionUi exposes these team MCP tools:

- `team_send_message`
- `team_spawn_agent`
- `team_task_create`
- `team_task_update`
- `team_task_list`
- `team_members`
- `team_rename_agent`
- `team_shutdown_agent`
- `team_describe_assistant`
- `team_list_models`

For RedConvert, the tool surface should stay schema-first and composable. We should avoid a broad `team_do_everything` tool. Each action should map to one host operation and return structured output.

### 2.6 ACP Reliability Lessons Apply Directly

AionUi’s ACP rewrite and v1.9.20 fixes point to several runtime rules RedConvert should adopt:

- `desired` config and `current` config must be separate.
- Mode/model changes made while a session is idle should be stored and reasserted after reconnect.
- Idle process exit should become `suspended`, not a crash.
- Finish fallback should only arm after prompt returns and runtime activity was seen.
- Permission approval should pause prompt timeout.
- Every session must have a single queue invariant for prompts.

These rules should be implemented in RedConvert’s runtime layer, not scattered in UI components.

### 2.7 Performance Lessons

AionUi’s team performance notes are directly relevant:

- Do not stream every token into a global team UI state if the UI does not need it.
- Filter runtime events by known conversation/session/member ids.
- Avoid full conversation list refresh on every response chunk.
- Memoize member panels and status context values.
- Use RAF or buffered flushes for scroll/stream updates.
- Clean read mailbox messages with TTL to prevent unbounded table growth.

## 3. External References From GitHub

### 3.1 `777genius/claude_agent_teams_ui`

Repository: https://github.com/777genius/claude_agent_teams_ui

Useful ideas:

- User acts like a CTO watching a Kanban board.
- Agents create tasks, review each other, exchange messages, and expose task-specific logs.
- Kanban card is the main control surface: comment, approve, reject, redirect, inspect changes.
- Solo mode can later expand to a full team.

What to borrow:

- Task cards should contain isolated logs/messages for traceability.
- Review workflow should be visible as a first-class state, not hidden in transcripts.
- Users should be able to comment on a member or a task without interrupting the whole team.

What not to copy directly:

- Do not make RedConvert team mode coding-only. Our product also has manuscripts, media, covers, knowledge, RedClaw, and video generation.

### 3.2 `bradygaster/squad`

Repository: https://github.com/bradygaster/squad

GitHub’s write-up highlights useful patterns:

- Team state lives near the repository as files.
- Each agent has an identity and history.
- Coordinator routes work to specialists.
- Review is independent: the original author should not review its own work.
- Watch mode polls for work, dispatches agents, monitors execution, and escalates.

What to borrow:

- Member identity should include charter, responsibility, tools, memory, and recent history.
- Long-running automation should run as a watch loop with health, cooldown, pause, retry, and escalation.
- Review tasks should be assignable to a different member by policy.

What to adapt:

- RedConvert state should remain in existing `AppStore`/workspace persistence, but can export markdown snapshots for audit.

### 3.3 `tomatyss/taskter`

Repository: https://github.com/tomatyss/taskter

Useful ideas:

- CLI Kanban board for agents.
- Agents can be added with prompts, model provider, and tool set.
- Example project scaffolds tasks, OKRs, and a minimal agent roster.
- Debug logs are stored in a project-local file.

What to borrow:

- Task board data should be simple and inspectable.
- Initial team templates should be generated from the user goal.
- Logs should be attached to tasks, not only to sessions.

### 3.4 `khaoss85/AI-Team-Orchestrator`

Repository: https://github.com/khaoss85/AI-Team-Orchestrator

Useful ideas:

- Specialized agents can have agent-specific and team-wide knowledge.
- RAG/document sources can be scoped to an agent or workspace.
- Dashboard exposes quality gates, document usage, and agent behavior.

What to borrow:

- RedConvert members should have scoped knowledge access:
  - member-private memory
  - team shared knowledge
  - task-specific attachments
  - project workspace files

What to avoid for now:

- Do not introduce a separate FastAPI/Next.js service. RedConvert already has a Tauri host/runtime and should keep the control plane local.

## 4. Current RedConvert Baseline

### 4.1 Existing Strengths

RedConvert already has several foundations:

- `desktop/src-tauri/src/runtime/*`: runtime task/session/checkpoint/event contracts.
- `desktop/src-tauri/src/subagents/*`: child runtime spawning and aggregation.
- `desktop/src-tauri/src/runtime/approval_runtime.rs`: approval state.
- `desktop/src-tauri/src/mcp/*`: MCP runtime.
- `desktop/src-tauri/src/cli_runtime/*`: CLI tool control plane and environment handling.
- `desktop/src/pages/Team.tsx`: current creative advisors / group chat surface.
- `desktop/src/pages/Workboard.tsx`: current RedClaw task center.
- `desktop/src/runtime/runtimeEventStream.ts`: unified runtime event stream.

### 4.2 Original Gaps And Current Resolution

The original missing pieces were product-level collaboration concepts. The implemented baseline resolves them as follows:

- Persistent `team member` runtime object: implemented as `CollabMemberRecord`.
- Durable mailbox between members: implemented as `CollabMailboxMessageRecord` plus mailbox helpers.
- Member-owned task board separate from RedClaw scheduled tasks: implemented as `CollabTaskRecord`.
- Periodic progress report protocol: implemented as host-owned report ticks and structured report records.
- UI that shows member current project/task/status as a team dashboard: implemented in Workboard Collaboration mode.
- Team bridge for external adapters: implemented as the shared `redbox-team` MCP/host-action contract; spawning external ACP member processes remains intentionally disabled in the first baseline.
- Policy that prevents a member from reviewing its own work: implemented in task creation/update validation.
- Settled-state coordinator wake logic: implemented in `subagents/wake_runtime.rs`.

## 5. Recommended Product Architecture

### 5.1 High-Level Architecture

```text
Renderer
  Team Workspace
    -> member roster
    -> member status cards
    -> task Kanban
    -> progress report feed
    -> task detail drawer
    -> member conversation drawer

Bridge
  ipcRenderer.teamRuntime.*
  runtimeEventStream normalization

Host
  collab_runtime
    -> CollabSession
    -> CollabMember
    -> CollabTask
    -> CollabMailbox
    -> CollabReport
    -> CollabPolicy
    -> CollabScheduler

Execution
  internal child runtime
  external ACP session
  future remote agent

Persistence
  AppStore records
  session artifacts
  runtime task traces
  optional workspace audit markdown
```

### 5.2 Concept Model

```text
CollabSession
  A team workspace around one user goal, project, or long-running RedClaw job.

CollabMember
  A persistent member identity. It can map to an internal child runtime, ACP process, or remote agent.

CollabTask
  A visible unit of work. It has owner, status, priority, dependencies, due/report cadence, artifacts, and logs.

CollabMailboxMessage
  Durable asynchronous message from user/member/system to a member.

CollabProgressReport
  Periodic or event-driven member report. Used by dashboard and leader summary.

CollabArtifact
  Output produced by a member: manuscript, media asset, cover, code diff, research note, generated prompt, etc.
```

### 5.3 Primary User Flow

1. User asks for a project-level outcome.
2. The main assistant decides whether team mode is useful.
3. If useful, it proposes a member lineup and asks for confirmation.
4. After confirmation, host creates a `CollabSession`.
5. Coordinator creates tasks on the board.
6. Members receive mailbox assignments and wake.
7. Members mark tasks `in_progress`, do work, emit periodic reports, and attach artifacts.
8. Workboard shows who is active, blocked, waiting, reviewing, or done.
9. Coordinator wakes when members settle or report blockers.
10. User can inspect, redirect, pause, comment, approve, or ask for summary at any time.

### 5.4 TeamGroupChat Runtime V2 Addendum

This addendum refines team mode around the product direction discussed on 2026-04-26: group chat is the collaboration room, not the worker loop. Members do work in their own background runtimes, then report into the group only when useful.

#### 5.4.1 Runtime-Owned Team Room

The RedConvert runtime owns all team execution. The app does not need tmux or a CLI session manager because the Rust host already owns:

- durable sessions and task records
- member mailboxes and progress reports
- runtime task queues
- cancellation and recovery
- concurrent child runtimes
- persistence and event projection

The group chat should be persisted as a `CollabSession` communication surface. Deleting an unneeded group chat deletes or archives that collaboration container according to product policy, but it must not be treated as an execution process.

#### 5.4.2 Speaker And Executor Separation

Each `CollabMember` has two runtime faces:

```text
CollabMember
  Speaker Persona
    -> reads member task plan, latest reports, mailbox, mentions, and group context
    -> speaks in group only when mentioned, reporting progress, clarifying decisions, or escalating blockers

  Executor Pool
    -> runs one or more background executor threads
    -> performs actual tasks
    -> writes progress reports, artifacts, and task-plan updates
```

The speaker and executors share the same member identity, role, constraints, and task-plan state. They are not two personalities. They are two responsibilities behind one visible teammate:

- Speaker owns communication and commitments.
- Executor owns work and evidence.
- Both write through typed runtime APIs, not free-form hidden state.

#### 5.4.3 Member Task Plan JSON

Every member should maintain a durable member-level plan:

```json
{
  "memberId": "collab-member-...",
  "sessionId": "collab-session-...",
  "version": 1,
  "activeExecutors": [],
  "tasks": [
    {
      "taskId": "collab-task-...",
      "status": "running",
      "ownerThreadId": "executor-...",
      "objective": "具体目标",
      "nextSteps": [],
      "blockers": [],
      "artifactRefs": [],
      "lastEvidence": []
    }
  ],
  "speechQueue": [
    {
      "reason": "progress_report",
      "priority": 40,
      "summary": "可直接发送给群聊的简短进度"
    }
  ]
}
```

This plan is the bridge between executor and speaker. Executors update it after meaningful progress or completion. Speakers read it before speaking, so they know the real execution state without inventing progress.

#### 5.4.4 Executor Lifecycle And Capacity

A member may work across multiple group chats and multiple tasks. The runtime should enforce:

- one executor thread per independent active task by default
- `maxConcurrentExecutorsPerMember = 5`
- queue additional work when capacity is full
- recover active executors from persisted task state after restart
- report capacity pressure to the coordinator instead of silently starting unlimited work

This uses the Rust runtime advantage: many lightweight executor records can exist, while only active work consumes model/runtime resources.

#### 5.4.5 Reporting Contract

Executor completion is not just a final chat message. It must write a structured completion claim:

```json
{
  "taskId": "collab-task-...",
  "memberId": "collab-member-...",
  "status": "completed",
  "summary": "完成了什么",
  "evidence": ["真实文件、记录、日志、工具结果"],
  "artifactRefs": [],
  "handoff": "给下一个成员或 leader 的最小上下文",
  "risks": []
}
```

The speaker can then post a concise group update. If a verifier exists, verifier review should happen before the speaker claims final completion to the group.

#### 5.4.6 Member Agent Card

When a member is created, it must carry a concise profile so the coordinator can decide who should receive which work:

```json
{
  "version": 1,
  "memberId": "collab-member-...",
  "displayName": "图片导演",
  "roleId": "image-director",
  "oneLine": "负责封面、配图、海报、图片策略和视觉执行指令。",
  "persona": "角色提示词摘要",
  "specialties": ["image_generation", "cover_direction", "visual_prompting"],
  "goodAt": ["视觉方案", "图片提示词", "封面构图"],
  "notGoodAt": [],
  "preferredTasks": ["image_generation", "cover_design", "visual_direction"],
  "avoidTasks": ["backend_debugging", "long_code_review"],
  "toolPolicy": {
    "allowedFamilies": ["media.generate", "image.generate", "redbox_fs"],
    "allowedTools": []
  },
  "capacity": {
    "maxExecutorThreads": 5,
    "defaultExecutorThreads": 1
  },
  "decisionBoundary": "交付边界和移交要求",
  "outputSchema": "该成员交付物结构"
}
```

This profile should live in `CollabMemberRecord.metadata.agentCard`. It can be generated from the role spec and overridden by templates or user-created members.

#### 5.4.7 Member Selection

Coordinator assignment should not rely on vibes or member names. It should call a deterministic read-only action:

```text
team.member.match
```

Input:

```json
{
  "sessionId": "collab-session-...",
  "title": "生成封面图",
  "objective": "用生图工具生成封面和视觉方案",
  "taskType": "image_generation",
  "requiredCapabilities": ["image_generation"],
  "requiredToolFamilies": ["image.generate"],
  "limit": 3
}
```

Output:

```json
{
  "candidates": [
    {
      "memberId": "collab-member-...",
      "displayName": "图片导演",
      "roleId": "image-director",
      "score": 67,
      "reasons": ["preferred_task:1", "capability:1", "tool_family:1"],
      "activeExecutorCount": 0,
      "maxExecutorThreads": 5
    }
  ]
}
```

Recommended score factors:

- exact role match
- preferred task match
- required capability match
- required tool family match
- objective/profile text match
- avoid-task penalty
- active executor load and capacity penalty

The first implementation can be deterministic and local. Later versions can add richer embedding search over agent cards, but only after the typed matching contract is stable.

#### 5.4.8 Runtime Implementation Status

Implemented baseline:

- `CollabMemberRecord.metadata.agentCard` is generated on member creation and can be overridden by member templates.
- `CollabMemberRecord.metadata.memberTaskPlan` is generated on member creation and updated when tasks are assigned, updated, or reported.
- Running task assignment enforces the member's `capacity.maxExecutorThreads`; default is 5.
- `team.member.match` ranks existing members by role, preferred task, capabilities, tool policy, objective fit, avoid-task penalties, and active executor load.
- `team.member.rename` and `team.member.shutdown` preserve member history while changing lifecycle state.
- `team.artifact.attach` appends artifact metadata through a structured artifact report.
- `team.blocker.raise` submits a structured blocker report and moves the task/member into blocker state.
- Completion reports include `payload.completionClaim` with evidence, artifact refs, handoff, and risks.
- The redbox-team MCP contract exposes the same conceptual tools for external adapters.
- `window.ipcRenderer.teamRuntime` exposes first-class methods for member matching, rename/shutdown, artifact attach, and blocker raise.
- Workboard Collaboration mode includes lightweight controls for intelligent assignment, member rename/shutdown, artifact attach, blocker raise, report request, and completion claim submission.

## 6. Data Model

### 6.1 Collab Session

```rust
pub struct CollabSessionRecord {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub status: String, // planning | active | paused | completed | failed | archived
    pub owner_session_id: Option<String>,
    pub coordinator_member_id: Option<String>,
    pub workspace_root: Option<String>,
    pub runtime_mode: String,
    pub member_ids: Vec<String>,
    pub task_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Option<Value>,
}
```

### 6.2 Collab Member

```rust
pub struct CollabMemberRecord {
    pub id: String,
    pub collab_session_id: String,
    pub display_name: String,
    pub role_id: String,
    pub source_kind: String, // internal_runtime | external_acp | remote
    pub backend: String,
    pub status: String, // pending | idle | active | blocked | reviewing | failed | completed | offline
    pub current_task_id: Option<String>,
    pub conversation_id: Option<String>,
    pub runtime_id: Option<String>,
    pub allowed_tools: Vec<String>,
    pub report_interval_seconds: i64,
    pub last_report_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Option<Value>,
}
```

### 6.3 Collab Task

```rust
pub struct CollabTaskRecord {
    pub id: String,
    pub collab_session_id: String,
    pub title: String,
    pub description: String,
    pub status: String, // backlog | ready | in_progress | blocked | review | done | failed | cancelled
    pub owner_member_id: Option<String>,
    pub reviewer_member_id: Option<String>,
    pub priority: i64,
    pub blocked_by_task_ids: Vec<String>,
    pub blocks_task_ids: Vec<String>,
    pub artifact_ids: Vec<String>,
    pub due_at: Option<i64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Option<Value>,
}
```

### 6.4 Collab Progress Report

```rust
pub struct CollabProgressReportRecord {
    pub id: String,
    pub collab_session_id: String,
    pub member_id: String,
    pub task_id: Option<String>,
    pub report_type: String, // periodic | milestone | blocker | completion | failure
    pub summary: String,
    pub progress_percent: Option<i64>,
    pub blockers: Vec<String>,
    pub next_steps: Vec<String>,
    pub artifact_ids: Vec<String>,
    pub created_at: i64,
    pub metadata: Option<Value>,
}
```

### 6.5 Collab Mailbox Message

```rust
pub struct CollabMailboxMessageRecord {
    pub id: String,
    pub collab_session_id: String,
    pub to_member_id: String,
    pub from_kind: String, // user | member | system | coordinator
    pub from_member_id: Option<String>,
    pub message_type: String, // assignment | comment | report_request | blocker_notice | shutdown_request
    pub content: String,
    pub task_id: Option<String>,
    pub attachment_refs: Vec<String>,
    pub read: bool,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub metadata: Option<Value>,
}
```

## 7. Host Modules To Add

### 7.1 `runtime/collab_runtime.rs`

Responsibilities:

- Create/list/update/archive collaboration sessions.
- Store member/task/mailbox/report records.
- Apply state transitions.
- Emit normalized runtime events.
- Provide snapshots for UI.

Must be self-implemented.

### 7.2 `subagents/mailbox.rs`

Responsibilities:

- Write member messages durably.
- Atomically read unread messages and mark read.
- Apply TTL cleanup for read messages.
- Return mailbox history for task/member detail panels.

Must be self-implemented.

### 7.3 `subagents/team_task_board.rs`

Responsibilities:

- Create/update/list tasks.
- Maintain dependency links.
- Move tasks across board columns.
- Support ownership changes.
- Emit task changed events.

Must be self-implemented. Use existing `runtime/task_runtime.rs` patterns for status updates and traces.

### 7.4 `subagents/team_tools.rs`

Responsibilities:

- Register team tools for internal runtime.
- Provide MCP-compatible tool definitions for external ACP members.
- Validate tool input schemas.
- Map tool calls to `collab_runtime` actions.

Must be self-implemented. Use existing MCP/runtime tool contracts.

Recommended tools:

```text
team.members.list
team.member.spawn
team.member.rename
team.member.shutdown
team.message.send
team.task.create
team.task.update
team.task.list
team.report.submit
team.report.request
team.artifact.attach
team.blocker.raise
```

### 7.5 `agent_hub/*`

Responsibilities:

- Normalize available internal roles, ACP backends, and future remote agents.
- Cache capability probes.
- Return spawnable member types to the coordinator and UI.

Can reuse existing runtime/provider/skills config, but the registry shape must be self-implemented.

### 7.6 `commands/runtime_collab.rs`

Bridge surface:

```text
team-runtime:create-session
team-runtime:list-sessions
team-runtime:get-session
team-runtime:list-members
team-runtime:list-tasks
team-runtime:create-task
team-runtime:update-task
team-runtime:send-message
team-runtime:request-report
team-runtime:pause-session
team-runtime:resume-session
team-runtime:archive-session
```

Renderer must call these through `desktop/src/bridge/ipcRenderer.ts`, not raw Tauri invocations.

## 8. Adapter Integration Boundary

### 8.1 External Adapter Lifecycle Contract

External ACP-style members use the same conceptual model, but the current shipped baseline does not spawn external agent processes as team members. This keeps team execution local and avoids introducing another long-running process manager before the host-owned collaboration protocol is stable.

When external adapters are enabled later, they must be modeled like this:

```text
CollabMemberRecord(source_kind=external_acp)
  -> conversation_id
  -> ACP session
  -> injected team MCP server
  -> mailbox wake prompts
  -> runtime events mapped back to member/task status
```

Required future rules:

- ACP mode/model config uses desired/current tracking.
- ACP process exit while idle becomes suspended/offline, not failed.
- ACP prompt failure during active task marks the member failed and reports to coordinator.
- ACP permission requests go through existing approval runtime.
- ACP team MCP config must include member id/session id in env.
- External adapter spawning must be added through the existing MCP/runtime manager, not by introducing ad hoc stdio bridges in team code.

### 8.2 Internal Runtime Member Lifecycle

Internal members should not pretend to be ACP. They should call the same host actions directly:

```text
internal child runtime
  -> receives mailbox prompt
  -> can call team tools through runtime tool registry
  -> emits runtime events
  -> submits reports/artifacts
```

### 8.3 Shared Team Tool Contract

Internal members and future external adapters must see the same conceptual tools. Implementation differs only at the transport boundary:

```text
internal runtime tool call
  -> tools/executor.rs
  -> team_tools.rs

external ACP MCP tool call
  -> local MCP stdio/TCP bridge or direct MCP runtime
  -> team_tools.rs
```

This avoids separate behavior for ACP vs internal members.

## 9. Periodic Progress Reporting

### 9.1 Report Types

Members should report in five cases:

- `periodic`: timer-driven, while active.
- `milestone`: completed meaningful sub-step.
- `blocker`: cannot continue without input or dependency.
- `completion`: task done.
- `failure`: task failed or process crashed.

### 9.2 Report Cadence

Default report cadence:

```text
simple task: every 3 minutes while active
long task: every 5 minutes while active
background/redclaw task: every scheduled tick or every 15 minutes
video/media generation: on each pipeline stage
```

Implementation:

- Host owns report timers.
- Timer sends `team.report.request` message to active members.
- Members respond with `team.report.submit`.
- Host can synthesize a stale report if a member is active but silent beyond threshold.

### 9.3 Report Schema

```json
{
  "taskId": "task_x",
  "reportType": "periodic",
  "summary": "已完成素材结构分析，正在整理镜头脚本。",
  "progressPercent": 45,
  "blockers": [],
  "nextSteps": ["生成分镜", "提交给 reviewer"],
  "artifactIds": []
}
```

### 9.4 Coordinator Summary

The coordinator should not summarize every token. It should summarize report records:

```text
member reports
  -> coordinator wakes when all active members settled or report interval expires
  -> coordinator posts concise user-facing status
  -> Workboard remains the detailed source of truth
```

## 10. Workboard UI

### 10.1 Product Surface

Current `Workboard.tsx` is RedClaw task-centered. The new collaboration dashboard should either:

- extend Workboard with a `Team` tab, or
- create `Team Workspace` inside the existing Team page and link task details to Workboard.

Recommendation: extend `Workboard` with a `Collaboration` mode while keeping RedClaw scheduled tasks intact.

Reason:

- User asked for a board showing what each member is working on.
- Workboard is already the task center.
- Team page can remain the member/chat surface.

### 10.2 Dashboard Layout

```text
Left rail
  collab sessions / projects

Top band
  objective, status, active members, overdue blockers, last update

Main board
  Backlog | Ready | In Progress | Blocked | Review | Done

Right inspector
  selected task or selected member
  messages
  reports
  artifacts
  approvals
  logs
```

### 10.3 Member Cards

Each member card should show:

- name and role
- backend/source kind
- current task
- status
- last report
- last activity time
- blocker count
- running tool/process indicator
- quick actions: message, request report, pause, resume, inspect conversation

### 10.4 Task Cards

Each task card should show:

- title
- owner
- status
- priority
- dependency marker
- report freshness
- artifacts count
- approval/review badge
- last event summary

### 10.5 Detail Drawer

Task detail drawer should show:

- full description
- assignment history
- mailbox messages related to task
- progress reports
- artifacts
- runtime traces
- approvals
- errors and recovery actions

## 11. Existing Libraries vs Self-Implemented

### 11.1 Must Use Existing Libraries / Existing Repo Systems

Use existing systems:

- Tauri commands/events for renderer-host bridge.
- Existing `runtime:event` stream.
- Existing `approval_runtime`.
- Existing `cli_runtime` for process execution and environment handling.
- Existing `mcp` runtime for MCP server/session management where possible.
- Existing `runtime/task_runtime.rs` trace/checkpoint patterns.
- Existing React + lucide UI conventions.

Likely third-party libraries:

- `serde` / `serde_json` for contracts.
- `chrono` or existing time helpers for timestamps.
- Existing frontend drag/drop library only if already present; otherwise first version can use button/status transitions before drag-and-drop.

### 11.2 Must Be Self-Implemented

Self-implement:

- Collaboration session/member/task/mailbox/report records.
- Member wake lifecycle.
- Settled-state coordinator wake logic.
- Periodic report scheduler.
- Team tool schemas and action handlers.
- ACP-to-member status mapping.
- Workboard collaboration view model.
- Review policy: author cannot review own task.
- Mailbox TTL cleanup.

### 11.3 Should Not Be Built Now

Defer:

- Multi-user cloud sync.
- Separate backend service.
- Full real-time multiplayer.
- Arbitrary workflow engine.
- Marketplace for third-party team templates.

## 12. Performance Strategy

### 12.1 Runtime Event Filtering

Every event must include enough scope:

```json
{
  "eventType": "runtime:collab-task-changed",
  "sessionId": "...",
  "runtimeId": "...",
  "collabSessionId": "...",
  "memberId": "...",
  "taskId": "..."
}
```

Renderer should ignore events outside the active dashboard or selected session.

### 12.2 Buffered Streaming

Do not stream every response token into the board. Board consumes:

- task status changes
- report submitted
- artifact attached
- member status changed
- approval requested/resolved
- error/failure events

Token-level streams stay in the member conversation drawer.

### 12.3 Snapshot Loading

Use stale-while-revalidate:

- render last successful board snapshot immediately
- background refresh tasks/reports
- inline error if refresh fails
- never blank the whole board on refresh

### 12.4 Lock Discipline

For host store updates:

```text
lock store -> read minimal snapshot -> unlock
perform IO / runtime spawn / MCP setup outside lock
lock store -> apply final record changes -> unlock
emit events after state commit
```

### 12.5 Cleanup

Add maintenance policies:

- Read mailbox messages: keep 7 days or latest 500 per collab session.
- Progress reports: keep latest 200 per task, archive older to artifact file.
- Runtime traces: rely on existing session artifact compaction.
- Stale active member: mark blocked/failed after inactivity threshold and notify coordinator.

## 13. Implementation Record

This plan has been executed as the internal-member baseline. The record below replaces the earlier staged plan and is the source of truth for what is complete.

### Completed 1: Collaboration Contracts

Files:

- `desktop/src-tauri/src/runtime/types.rs`
- `desktop/src/runtime/runtimeEventStream.ts`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/types.d.ts`

Completed work:

- Added `CollabSessionRecord`, `CollabMemberRecord`, `CollabTaskRecord`, `CollabMailboxMessageRecord`, `CollabProgressReportRecord`.
- Added normalized event handling for:
  - `runtime:collab-session-changed`
  - `runtime:collab-member-changed`
  - `runtime:collab-task-changed`
  - `runtime:collab-report-submitted`
  - `runtime:collab-message-delivered`
  - `runtime:collab-report-tick`

Verification:

- Covered by `pnpm exec tsc --noEmit`, `pnpm build`, `cargo check`, and targeted Rust tests listed in the verification matrix.

### Completed 2: Host Collaboration Runtime

Files:

- `desktop/src-tauri/src/runtime/collab_runtime.rs`
- `desktop/src-tauri/src/runtime.rs`
- `desktop/src-tauri/src/commands/runtime_collab.rs`
- `desktop/src-tauri/src/commands/runtime_session.rs`
- `desktop/src-tauri/src/main.rs`
- `desktop/src-tauri/src/persistence/mod.rs`

Completed work:

- Create/list/get collaboration sessions.
- Add/list/rename/shutdown members.
- Create/update/list tasks.
- Write/read mailbox messages.
- Submit/list progress reports.
- Maintain member task plans, completion claims, artifact reports, blocker reports, capacity checks, reviewer policy, and bidirectional task dependency links.

Verification:

- Rust tests cover dependency validation, bidirectional dependency links, mailbox read-and-mark, agent cards, member matching, task-plan updates, capacity checks, artifact helpers, blocker helpers, and reviewer policy.

### Completed 3: Team Tools And MCP Contract

Files:

- `desktop/src-tauri/src/subagents/team_tools.rs`
- `desktop/src-tauri/src/subagents/mailbox.rs`
- `desktop/src-tauri/src/subagents/team_task_board.rs`
- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/tools/app_cli.rs`
- `desktop/src-tauri/src/mcp/team_server.rs`

Completed work:

- Added structured `team.*` host actions.
- Mapped internal runtime/app_cli calls to collaboration runtime operations.
- Exposed `redbox-team` MCP contract for the same conceptual actions.
- Kept external ACP process spawning disabled in the first baseline; future adapters must plug into the same host actions.

Verification:

- Tool schema tests.
- `app_cli` schema tests for team coordinator actions.
- `team_mcp` contract and execution tests.

### Completed 4: Member Wake Runtime

Files:

- `desktop/src-tauri/src/subagents/wake_runtime.rs`
- `desktop/src-tauri/src/subagents/spawner.rs`

Completed work:

- Creates collaboration records for internal child runtimes.
- Requests progress reports from active members on report tick.
- Deduplicates pending report requests so repeated ticks do not spam members.
- Synthesizes stale blocker reports after missed report windows.
- Ignores paused/completed/failed/archived sessions and settled members.
- Computes settled-state coordinator wake readiness while ignoring the coordinator member.
- Records child runtime completion/failure back into the collaboration board.

Verification:

- Unit tests cover settled-state coordinator logic, report request deduplication, paused/completed report tick guards, and child runtime to collaboration record projection.

### Completed 5: Agent Backend Registry And Adapter Boundary

Files:

- `desktop/src-tauri/src/agent_hub/mod.rs`
- `desktop/src-tauri/src/mcp/team_server.rs`
- `desktop/src-tauri/src/mcp/README.md`
- `desktop/src-tauri/src/subagents/README.md`

Completed work:

- Added a host-owned backend registry with the internal runtime backend.
- Added desired/current config shape for future adapter compatibility.
- Documented that internal and future external adapters must share `team.*` host actions.
- Explicitly prohibited ad hoc external stdio bridges in the team code path.

Verification:

- Agent backend registry test.
- MCP contract test.

### Completed 6: Collaboration Workboard UI

Files:

- `desktop/src/pages/Workboard.tsx`
- `desktop/src/pages/workboard/CollaborationBoard.tsx`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/types.d.ts`

Completed work:

- Added Collaboration mode under Workboard.
- Added session selector, member roster, task board, task detail, reports, mailbox messages, artifacts, report tick, report request, member creation, intelligent assignment, rename/shutdown, blocker raise, artifact attach, and completion claim actions.
- Preserved stale data during refresh.

Verification:

- `pnpm exec tsc --noEmit`.
- `pnpm build`.

### Completed 7: Periodic Reporting Scheduler

Files:

- `desktop/src-tauri/src/subagents/wake_runtime.rs`
- `desktop/src-tauri/src/commands/runtime_collab.rs`
- `desktop/src/runtime/runtimeEventStream.ts`

Completed work:

- Tick active sessions.
- Request reports from active members.
- Mark stale members with structured blocker reports.
- Emit `runtime:collab-report-tick`.

Verification:

- Unit tests for settled-state wake behavior.
- Frontend type/build verification for report tick event handling.

### Completed 8: Documentation And Verification Matrix

Files:

- `desktop/docs/contracts/runtime-events.md`
- `desktop/docs/collaboration-runtime.md`
- `desktop/docs/development/testing-and-verification.md`
- this document

Completed work:

- Documented runtime event shape and team actions.
- Added collaboration runtime reference.
- Added team collaboration verification checklist.
- Marked this plan completed and resolved product decisions.

Verification:

- `pnpm build`.
- `pnpm exec tsc --noEmit`.
- `cd desktop/src-tauri && cargo fmt --check && cargo check`.

## 14. Architecture Options

### Option A: Extend Current CreativeChat/Team Page Only

Pros:

- Smallest frontend change.
- Reuses current advisors/rooms product surface.

Cons:

- Does not create real member lifecycle.
- No durable task board.
- Hard to support ACP members.
- Progress reports remain chat messages.

Verdict: not recommended.

### Option B: Only Enhance Internal Subagents

Pros:

- Uses existing Rust runtime.
- Strong control over tools and safety.
- Faster MVP than ACP integration.

Cons:

- Cannot use external ACP agents as members.
- Less aligned with user expectation of independent team members.
- Later ACP support would require reworking UI and records.

Verdict: acceptable fallback, but not ideal.

### Option C: Unified Collaboration Control Plane

Pros:

- Internal members and ACP members share one protocol.
- Workboard can show all members/tasks uniformly.
- Periodic progress reporting becomes host-owned.
- Fits existing runtime/task/approval/event architecture.

Cons:

- More host work.
- Requires new persistence records.
- Needs careful event filtering and lifecycle tests.

Verdict: recommended.

## 15. Implemented Baseline

The completed baseline proves the product experience before broad remote-agent expansion:

### Implemented Scope

- Internal runtime members only.
- Persistent `CollabSession`, `CollabMember`, `CollabTask`, `CollabReport`, `CollabMailbox`.
- Team tools available to internal runtime.
- Workboard Collaboration view.
- Manual report request and completion report.
- Basic periodic report timer.
- Coordinator wakes when all members settle.
- Deterministic member matching through agent cards and task-plan load.
- Speaker/executor separation contract through member task plans, mailbox messages, progress reports, and completion claims.

### Explicitly Deferred

- Drag-and-drop Kanban.
- Full assistant preset marketplace.
- Cross-project remote team.

### Why This Baseline

It proves the core user value: “members each work, report progress, and the board shows what everyone is doing.” Once that is stable, ACP external members can be added behind the same member/task/report contracts.

## 16. Resolved Product Decisions

1. `Team` remains the creative/advisor group-chat surface; `Workboard` owns the operational collaboration dashboard.
2. The first fully implemented path uses internal child runtimes and the host-owned collaboration protocol; external ACP adapters plug into the same contract.
3. Progress reports are durable report records first, and can be rendered as board feed items or group-chat summaries without changing the runtime model.
4. Members share the current workspace by default; task-specific workspace isolation can be added later as a runtime policy.
5. Tool permissions stay host-owned. File edits, video generation, CLI tools, and other side effects must continue through existing approval/runtime boundaries.
6. Default member profiles are generated from role specs and stored in `CollabMemberRecord.metadata.agentCard`, with template/user overrides.
7. RedClaw should create collaboration sessions only when a task explicitly needs multiple specialties or long-running coordination; simple single-agent tasks should remain lightweight.

## 17. Suggested Default Member Templates

### Creator Project

- Coordinator: decomposes work, manages board, summarizes reports.
- Researcher: searches knowledge base and source material.
- Copywriter: writes manuscript/caption/script.
- Visual Director: produces cover/image prompts and visual specs.
- Video Director: produces timeline/remotion/video structure.
- Reviewer: checks factuality, completeness, saved artifacts, and publishing readiness.

### Video Generation Project

- Coordinator
- Script Planner
- Asset Researcher
- Shot Designer
- Media Generator
- Reviewer

### Knowledge/Research Project

- Coordinator
- Source Collector
- Evidence Analyst
- Synthesis Writer
- Reviewer

## 18. Completion Evidence

The baseline is complete against the original success criteria:

- User can create a team session from a project goal: implemented through `team.session.create` / `team-runtime:create-session`.
- At least two members can work independently: implemented through persistent `CollabMemberRecord` plus internal child runtime projection.
- Every member has a visible status and current task: implemented in Workboard Collaboration member cards.
- The board shows task flow from ready to done: implemented in Workboard Collaboration columns and task status actions.
- A member can submit a progress report without completing the task: implemented through `team.report.submit`.
- Coordinator can summarize progress from reports: implemented through durable `CollabProgressReportRecord` snapshots and report feeds.
- User can message a specific member: implemented through member mailbox messages.
- Failed or silent member produces a visible blocker/failure state: implemented through stale report blocker synthesis and failure report projection.
- The UI remains responsive during streaming or long-running work: board consumes scoped collaboration events and snapshots, not token streams.
- Refresh does not clear the board into a full-page loading state: Workboard Collaboration keeps stale snapshot data while refreshing.

## 19. Verification Matrix

### Unit Tests Completed

- mailbox read-and-mark is atomic: `mailbox_read_marks_messages_read_once`
- task dependency update is bidirectional: `collab_task_dependency_updates_reverse_blocks`
- completed upstream task promotes dependent work to ready: `collab_task_completion_promotes_dependents_to_ready`
- settled-state coordinator wake fires once: `settled_rule_ignores_coordinator`
- active wake/report request dedup prevents duplicate prompt dispatch: `report_tick_dedups_pending_report_requests`
- report due calculation handles paused/completed states: `report_tick_ignores_paused_sessions_and_completed_members`
- member cannot review its own task when policy forbids it: `reviewer_cannot_be_same_as_owner`

### Integration Evidence Completed

- create collab session -> create members -> create tasks -> assign task: covered by `subagent_spawn_creates_child_task_and_session_links` and collaboration runtime tests.
- member submits report -> board receives event -> UI snapshot updates: covered by `collab_report_updates_member_and_task_board_state` and runtime event normalization.
- member failure -> coordinator receives blocker notice: covered by child runtime failure projection and stale blocker report synthesis.
- task completed -> dependent task becomes ready: covered by `collab_task_completion_promotes_dependents_to_ready`.

### Manual Verification Completed By Build-Level Checks

- Workboard Collaboration view compiles and builds through `pnpm build`.
- Renderer bridge and type contracts compile through `pnpm exec tsc --noEmit`.
- Rust runtime and tool contracts compile through `cargo check`.
- Rust formatting is enforced through `cargo fmt --check`.

## 20. Final Recommendation

Build Option C, but deliver it as an internal-member MVP first.

The host-owned collaboration control plane is the important part. ACP support should plug into that plane, not define it. This keeps RedConvert aligned with its existing Rust runtime, Workboard, RedClaw, approval runtime, media generation pipeline, and future external agents.
