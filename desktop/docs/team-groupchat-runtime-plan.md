---
doc_type: plan
execution_status: not_started
last_updated: 2026-04-26
owner: codex
scope:
  - desktop/src-tauri/src/runtime/collab_runtime.rs
  - desktop/src-tauri/src/subagents
  - desktop/src-tauri/src/tools
  - desktop/src-tauri/src/commands/runtime_collab.rs
  - desktop/src-tauri/src/commands/runtime_orchestration.rs
  - desktop/src-tauri/src/interactive_runtime_shared.rs
  - desktop/prompts/library/runtime
  - desktop/src/pages
reference_implementations:
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/handlers/multi_agents
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/handlers/multi_agents_common.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/session
  - https://github.com/Yeachan-Heo/oh-my-codex
  - https://github.com/Yeachan-Heo/oh-my-codex/blob/main/skills/team/SKILL.md
success_metrics:
  - active_team_resume_after_app_restart = true
  - team_agent_false_completion_block_rate >= 95 percent
  - team_wait_polling_loop_incidents = 0
  - team_member_progress_report_timeout_detected = true
  - team_task_state_has_canonical_record_before_worker_spawn = 100 percent
  - team_group_chat_message_trace_coverage = 100 percent
---

# Team Group Chat Runtime Plan

## 1. Product Direction

RedBox 的团队协作不应照搬 CLI / tmux 型项目。我们的系统已经有自己的 Tauri/Rust runtime、session store、runtime task、event stream、tool router、child runtime 和持久化消息能力，所以协作的产品核心应该是：

```text
持久化群聊 = 协作项目容器
Leader Agent = 项目负责人
Member Agents = 群成员 / 执行者 / 审核者
Runtime Scheduler = 后台调度器
App Store + session bundles = 持久化状态
```

用户发起复杂任务时，App 自动创建一个 AI 项目群聊。群聊里有 leader 和多个成员。Leader 负责拆任务、发任务、读汇报、调度下一步、请求审核和最终汇总。成员只在群聊里接任务、汇报进度、提交产物和反馈阻塞。用户可以随时查看群聊，也可以删除不需要的群聊。

这个设计的重点不是“多开 agent”，而是让协作过程成为一个可恢复、可审计、可删除的产品对象。

## 2. Why Not tmux

oh-my-codex 需要 tmux，是因为它的 worker 是多个 CLI agent 进程。tmux 承担了以下职责：

- 承载多个 CLI 进程。
- 为每个 worker 保留 pane。
- 让进程在主命令退出后继续存在。
- 保存可观察输出。
- 关闭或清理 worker。

RedBox 不需要 tmux，因为这些能力应由我们的 runtime 内建：

| OMX / tmux concept | RedBox equivalent |
| --- | --- |
| tmux session | TeamGroupChat / CollabSession |
| tmux pane | childRuntimeId + childSessionId |
| pane output | session transcript + team messages + runtime traces |
| `.omx/state/team/*` | AppStore + session-bundles + runtime_tasks |
| `omx team await` | `team.message.await` / `team.event.await` |
| pane shutdown | `team.agent.close` / runtime cancel |

结论：

```text
不要引入 tmux
不要依赖 CLI agent 进程
不要把外部 shell session 当作协作状态
```

RedBox 的运行容器就是自己的 runtime。无论同时有多少个 agent，都应该由 runtime scheduler 接住，并由并发控制器限制实际并发。

## 3. Target Architecture

```text
TeamGroupChat Runtime
├─ TeamGroupChatStore
│  ├─ group chat / session
│  ├─ members
│  ├─ messages
│  ├─ tasks
│  ├─ reports
│  └─ events
├─ TeamLeaderRuntime
│  ├─ leader prompt overlay
│  ├─ planning policy
│  ├─ delegation policy
│  ├─ review policy
│  └─ final synthesis policy
├─ TeamMemberRuntime
│  ├─ speaker persona
│  ├─ executor thread pool
│  ├─ member task plan JSON
│  ├─ speech policy
│  └─ persona consistency guard
├─ TeamAgentControl
│  ├─ spawn
│  ├─ await
│  ├─ resume
│  ├─ close
│  └─ cancel
├─ TeamScheduler
│  ├─ lease management
│  ├─ heartbeat detection
│  ├─ retry / backoff
│  ├─ leader wakeup
│  ├─ app restart recovery
│  └─ completion detection
├─ TeamWorkerProtocol
│  ├─ claim task
│  ├─ read group messages
│  ├─ submit progress
│  ├─ submit blocker
│  ├─ submit artifact evidence
│  └─ handoff packet
├─ TeamVerifier
│  ├─ schema validation
│  ├─ evidence validation
│  ├─ artifact existence validation
│  ├─ unauthorized tool detection
│  └─ false-success gate
└─ TeamCleanup
   ├─ archive group chat
   ├─ delete group chat
   ├─ close active runtimes
   └─ remove transient scheduler state
```

## 3.1 Member Runtime Split

The biggest conflict in the current group chat model is that "speaking" and "working" are treated as the same loop. That makes every member optimize for taking turns in the chat instead of executing work.

Team mode should split one logical member into two runtime faces:

```text
TeamMember
├─ Speaker Persona
│  ├─ speaks in group chat
│  ├─ summarizes execution status
│  ├─ responds when mentioned
│  ├─ asks for clarification
│  ├─ reports blockers
│  └─ preserves member personality / voice
└─ Executor Threads
   ├─ do actual work in background
   ├─ use tools
   ├─ update task plan JSON
   ├─ submit evidence
   ├─ emit progress events
   └─ remain mostly silent in group chat
```

The speaker and executor share one member identity, but they do not have the same responsibilities.

| Part | Owns | Does not own |
| --- | --- | --- |
| Speaker Persona | group communication, status summary, questions, role-level decisions | long-running tool execution, raw artifact loops |
| Executor Thread | task execution, tool calls, evidence, task plan updates | group-level decisions, project completion, uncontrolled chat replies |

This makes the group chat a place for reporting progress and discussing plans, while real work happens in the member's background runtime.

## 3.2 Speech Policy

Team group chats must use event-driven speech, not forced turn order.

```text
discussion_mode -> round_robin speaker policy
team_mode       -> event_driven speaker policy
```

In `team_mode`, a member speaks only when:

- Leader assigns or changes its task.
- The member is explicitly mentioned.
- The executor starts a task and should acknowledge claim.
- The executor reaches a meaningful progress milestone.
- The executor hits a blocker.
- The executor needs clarification.
- The executor submits artifact evidence.
- The reviewer accepts or rejects output.
- The scheduler requests a progress report.
- The leader asks for status.

The member should not speak just because it is "its turn".

Speech event types:

```text
claim
progress
blocker
question
answer
artifact
review
decision
handoff
status_summary
```

The scheduler wakes the speaker persona to write a group message only after one of these events occurs.

## 4. Canonical Product Flow

### 4.1 Start A Team Task

```text
User asks for team collaboration
-> main runtime decides team mode is needed
-> create TeamGroupChat
-> create Leader member
-> create initial task graph
-> create worker members
-> write leader kickoff message
-> scheduler starts ready tasks
```

The first durable state must be written before any worker starts. This avoids the failure mode where a worker believes it has a task that does not exist in canonical state.

### 4.2 Leader Delegates Work

```text
Leader reads objective and current group state
-> creates or updates tasks
-> sends instruction messages to members
-> waits on task/message events
-> requests reports when needed
-> adjusts plan from progress
```

Leader is not a generic assistant. It is a project coordinator inside one group chat.

### 4.3 Member Executes Work

```text
Member receives assigned task
-> claims task
-> uses only allowed tools
-> posts progress reports
-> posts blocker if stuck
-> submits artifact/evidence
-> marks task ready for review or completed
```

Members must not declare the entire project completed. Only leader can declare group-level completion.

### 4.4 Review And Finalization

```text
Verifier checks member output
-> reviewer agent checks quality when needed
-> failed output creates repair task
-> approved output becomes accepted artifact
-> leader synthesizes final result
-> group chat status becomes completed or archived
```

## 5. Data Model

The current `Collab*Record` types can be kept for compatibility, but runtime semantics should shift from "workboard collaboration" to "persistent group chat".

### 5.1 TeamGroupChat / CollabSessionRecord

Use existing `CollabSessionRecord` as the storage record first. Add metadata fields rather than renaming the table immediately.

```rust
TeamGroupChat {
    id: String,
    owner_session_id: Option<String>,
    leader_member_id: Option<String>,
    title: String,
    objective: String,
    status: "active" | "paused" | "completed" | "failed" | "archived" | "deleted",
    runtime_mode: String,
    source: "team-group-chat" | "user" | "scheduler" | "migration",
    policy: TeamPolicy,
    created_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}
```

`TeamPolicy` should live in `metadata` initially:

```json
{
  "teamKind": "group_chat",
  "maxActiveAgentsPerTeam": 4,
  "maxActiveAgentsGlobal": 8,
  "reportIntervalMs": 900000,
  "heartbeatTimeoutMs": 1200000,
  "taskLeaseMs": 1800000,
  "retryLimit": 2,
  "requiresEvidenceForCompletion": true,
  "autoArchiveOnCompletion": false
}
```

### 5.2 TeamMember / CollabMemberRecord

```rust
TeamMember {
    id: String,
    group_chat_id: String,
    role_id: String,
    display_name: String,
    kind: "leader" | "worker" | "reviewer" | "observer",
    status: "idle" | "queued" | "running" | "waiting" | "blocked" | "completed" | "failed" | "closed",
    child_session_id: Option<String>,
    child_runtime_id: Option<String>,
    current_task_id: Option<String>,
    allowed_tools: Vec<String>,
    runtime_binding: Option<TeamRuntimeBinding>,
    speaker_binding: Option<TeamSpeakerBinding>,
    executor_pool: TeamExecutorPoolState,
    member_plan_ref: Option<String>,
    last_seen_at: Option<i64>,
    last_report_at: Option<i64>,
}
```

`TeamRuntimeBinding`:

```json
{
  "transportKind": "in_app_runtime",
  "childSessionId": "session-...",
  "childRuntimeId": "runtime-...",
  "childTaskId": "task-...",
  "parentRuntimeId": "runtime-...",
  "depth": 1,
  "status": "active"
}
```

No CLI transport is required for MVP. Keep `transportKind` so future process or remote workers do not require a data model rewrite.

`TeamSpeakerBinding`:

```json
{
  "speakerSessionId": "session-...",
  "speakerRuntimeId": "runtime-...",
  "personaPromptHash": "sha256-...",
  "speechPolicy": "event_driven",
  "lastSpokeAt": 1777178200000
}
```

`TeamExecutorPoolState`:

```json
{
  "maxConcurrentExecutors": 5,
  "activeExecutorCount": 2,
  "queuedTaskCount": 3,
  "executors": [
    {
      "executorId": "executor-...",
      "taskId": "collab-task-...",
      "groupChatId": "collab-session-...",
      "childSessionId": "session-...",
      "childRuntimeId": "runtime-...",
      "status": "running",
      "startedAt": 1777178200000,
      "lastHeartbeatAt": 1777178300000
    }
  ]
}
```

One logical member may participate in multiple group chats and tasks. The member may start multiple executor threads, but the default hard cap is:

```text
maxConcurrentExecutorsPerMember = 5
```

The cap applies across all group chats for that member. If one member already has five active executor threads, new tasks assigned to that member enter `queued_for_member` until one executor finishes, fails, or is closed.

### 5.2.1 Member Task Plan JSON

Each member maintains its own task plan panel JSON. This is not a chat transcript. It is the member's structured working memory for active and queued work.

Storage options:

- Start with `CollabMemberRecord.metadata.memberTaskPlan`.
- Later move to a dedicated `TeamMemberPlanRecord` if the JSON becomes large.

Shape:

```json
{
  "memberId": "collab-member-...",
  "updatedAt": 1777178300000,
  "capacity": {
    "maxConcurrentExecutors": 5,
    "activeExecutorCount": 2
  },
  "activeTasks": [
    {
      "groupChatId": "collab-session-...",
      "taskId": "collab-task-...",
      "executorId": "executor-...",
      "goal": "分析竞品选题",
      "status": "running",
      "currentStep": "整理证据",
      "nextSteps": ["提取冲突点", "提交研究摘要"],
      "blockers": [],
      "artifactRefs": [],
      "lastProgressSummary": "已读完 6 条素材，正在归纳冲突模型。"
    }
  ],
  "queuedTasks": [],
  "completedTasks": [],
  "openQuestions": [],
  "speechQueue": [
    {
      "groupChatId": "collab-session-...",
      "taskId": "collab-task-...",
      "reason": "progress_milestone",
      "suggestedMessage": "我已经完成竞品素材初筛，下一步提炼可复用冲突点。",
      "priority": 5
    }
  ]
}
```

Rules:

- Executors update plan JSON as they work.
- Speaker persona reads plan JSON before speaking.
- Leader and scheduler may read plan JSON for status.
- Plan JSON must not replace canonical task state. It is member-local working memory.
- If plan JSON conflicts with canonical task state, canonical task state wins.

### 5.2.2 Executor To Speaker Reporting

Speaker knows executor state through durable structured state, not by reading hidden reasoning. Executors must write progress into three places:

```text
MemberTaskPlan JSON       // current member-local task state
TeamEvent                 // event cursor for scheduler/await
speechQueue               // suggested group-chat speaking moments
```

Progress update shape:

```json
{
  "taskId": "collab-task-...",
  "executorId": "executor-...",
  "status": "running",
  "currentStep": "整理竞品素材",
  "progressPercent": 45,
  "lastProgressSummary": "已完成 12 条素材初筛，发现 3 个高频冲突角度。",
  "nextSteps": ["提炼可复用结构", "整理证据摘要"],
  "blockers": [],
  "artifactRefs": [],
  "updatedAt": 1777178300000
}
```

Speech queue entry:

```json
{
  "reason": "progress_milestone",
  "groupChatId": "collab-session-...",
  "taskId": "collab-task-...",
  "executorId": "executor-...",
  "suggestedMessage": "我已完成素材初筛，发现 3 个可复用冲突角度，下一步整理证据摘要。",
  "priority": 5
}
```

The speaker runtime may rewrite `suggestedMessage` into the member's voice, but it must not invent progress that is not present in plan/event/evidence state.

Completion claim shape:

```json
{
  "taskId": "collab-task-...",
  "executorId": "executor-...",
  "status": "claimed_completed",
  "summary": "完成竞品素材分析，提炼出 3 个冲突角度。",
  "artifactRefs": [
    {
      "type": "document",
      "path": "redclaw/research/topic-conflicts.md"
    }
  ],
  "evidence": [
    {
      "type": "tool_result",
      "tool": "redbox_fs.write",
      "ref": "tool-call-789"
    }
  ],
  "handoff": {
    "acceptedFacts": ["高互动内容普遍使用身份冲突开头"],
    "openQuestions": ["是否需要继续补充近期爆款样本"],
    "requiredActions": ["交给 copywriter 生成标题包"]
  }
}
```

Completion flow:

```text
Executor writes completion claim
-> task status becomes claimed_completed or review
-> TeamVerifier validates schema/evidence/artifacts
-> verifier accepts or rejects
-> accepted result enters artifact refs and handoff packet
-> speechQueue receives artifact/completion event
-> Speaker posts a human-readable group update
-> Leader decides next task or final synthesis
```

Speaker message example:

```text
我这边完成了竞品素材分析，整理出了 3 个高频冲突角度，并把证据摘要提交到了任务产物里。建议下一步交给 Copywriter 基于这些冲突角度生成标题包。
```

Hard rule: group chat messages may only be based on `MemberTaskPlan`, `TeamEvent`, `artifactRefs`, `evidence`, and accepted handoff packets. Hidden executor reasoning must not be surfaced.

### 5.2.3 Persona Consistency

Speaker and executors must feel like one member, not two unrelated agents. Use a shared member profile:

```json
{
  "memberId": "collab-member-...",
  "displayName": "研究员",
  "roleId": "researcher",
  "voice": "简洁、证据优先、遇到不确定会标注",
  "responsibilities": ["检索素材", "整理证据", "提交研究摘要"],
  "toolPolicy": ["read", "search", "team.report.submit"],
  "decisionBoundary": "不能宣布项目完成，不能替 leader 派发任务"
}
```

Both speaker and executor overlays must include this profile. The executor owns doing; the speaker owns saying.

### 5.2.4 Member Profile / Agent Card

Leader cannot assign work reliably from a member name alone. Every member must have a structured profile card created and persisted at member creation time.

The card is the canonical description of:

- who this member is
- what it is good at
- what it should avoid
- how it speaks
- which tool families it can use
- where its decision boundary ends
- how many executor threads it may run

Initial storage:

```text
CollabMemberRecord.metadata.agentCard
```

Shape:

```json
{
  "memberId": "collab-member-...",
  "displayName": "爆款选题研究员",
  "roleId": "researcher",
  "oneLine": "擅长从素材和竞品里提炼可复用冲突、证据和选题角度。",
  "persona": {
    "voice": "简洁、证据优先、会标注不确定性",
    "style": "先给结论，再给依据",
    "collaborationStyle": "适合接收明确研究目标和样本范围"
  },
  "specialties": ["竞品分析", "素材归纳", "小红书/短视频选题", "证据摘要"],
  "goodAt": ["从大量素材里提炼模式", "给写作者提供事实和角度", "发现内容冲突点"],
  "notGoodAt": ["最终成稿润色", "视觉生成", "视频剪辑"],
  "preferredTasks": ["research", "evidence_summary", "topic_angle_analysis"],
  "avoidTasks": ["image_generation", "final_copywriting", "video_rendering"],
  "toolPolicy": {
    "allowedToolFamilies": ["knowledge", "redbox_fs", "team.report"],
    "restrictedToolFamilies": ["image.generate", "video.render"]
  },
  "capacity": {
    "maxConcurrentExecutors": 5,
    "currentActiveExecutors": 0
  },
  "decisionBoundary": "可以提出研究结论和建议，但不能宣布项目完成，也不能替 Leader 派发任务。"
}
```

Rules:

- `team.member.spawn` must create `metadata.agentCard` when it is missing.
- Caller may provide `metadata.agentCard` to override defaults.
- Speaker and executor both receive the same card in their prompt overlay.
- ToolRouter should derive default tool exposure from the card's `toolPolicy`.
- Leader should use member matching instead of picking members by display name alone.

### 5.2.5 Member Selection

Add a member candidate matching action:

```text
team.member.match
```

Input:

```json
{
  "sessionId": "collab-session-...",
  "taskType": "image_generation",
  "objective": "生成小红书封面",
  "requiredCapabilities": ["视觉构图", "封面策略"],
  "requiredToolFamilies": ["image.generate"],
  "limit": 3
}
```

Output:

```json
{
  "candidates": [
    {
      "memberId": "collab-member-image-director",
      "displayName": "图片导演",
      "roleId": "image-director",
      "score": 24,
      "reasons": ["preferred_task:image_generation", "tool:image.generate", "specialty:封面策略"],
      "agentCard": {}
    }
  ]
}
```

Initial scoring can be simple and deterministic:

```text
score =
  specialty_match * 4
+ preferred_task_match * 3
+ required_tool_match * 3
+ availability * 2
- avoid_task_match * 5
- restricted_tool_match * 4
- overloaded_penalty
```

Leader selection flow:

```text
task requirement
-> team.member.match
-> pick highest scoring available member
-> if no candidate is suitable, create a new member with an agent card
-> assign canonical task to selected member
```

This keeps member selection explainable and auditable.

### 5.3 TeamMessage / CollabMailboxMessageRecord

Team messages are not just UI chat bubbles. They are the collaboration evidence log.

```rust
TeamMessage {
    id: String,
    group_chat_id: String,
    from_member_id: Option<String>,
    to_member_ids: Vec<String>,
    task_id: Option<String>,
    message_type:
        "instruction" |
        "progress" |
        "blocker" |
        "question" |
        "answer" |
        "artifact" |
        "review" |
        "decision" |
        "system",
    body: String,
    payload: Option<Value>,
    event_id: Option<String>,
    created_at: i64,
    read_at: Option<i64>,
}
```

Every leader instruction, member progress report, blocker, artifact, review decision, scheduler wakeup, and final summary should create a message.

### 5.4 TeamTask / CollabTaskRecord

```rust
TeamTask {
    id: String,
    group_chat_id: String,
    title: String,
    goal: String,
    assignee_member_id: Option<String>,
    reviewer_member_id: Option<String>,
    status:
        "pending" |
        "ready" |
        "assigned" |
        "running" |
        "waiting" |
        "blocked" |
        "review" |
        "completed" |
        "failed" |
        "cancelled",
    dependencies: Vec<String>,
    progress_percent: u8,
    result_summary: Option<String>,
    artifact_refs: Vec<Value>,
    blockers: Vec<String>,
    lease: Option<TeamTaskLease>,
    attempts: u32,
    idempotency_key: Option<String>,
}
```

`TeamTaskLease`:

```json
{
  "leaseOwner": "member-...",
  "leaseToken": "lease-...",
  "leaseExpiresAt": 1777180000000,
  "acquiredAt": 1777178200000
}
```

Lease is required for long-running reliability. A scheduler tick must not start the same task twice.

### 5.5 TeamEvent

Add an event cursor model. This can be a new record or a normalized view over existing runtime events.

```rust
TeamEvent {
    id: String,
    group_chat_id: String,
    task_id: Option<String>,
    member_id: Option<String>,
    event_type:
        "group_created" |
        "member_added" |
        "task_created" |
        "task_claimed" |
        "task_updated" |
        "message_sent" |
        "report_submitted" |
        "worker_started" |
        "worker_finished" |
        "worker_failed" |
        "leader_wakeup" |
        "verifier_rejected" |
        "group_completed",
    payload: Value,
    created_at: i64,
}
```

This enables `team.event.await` without model-side polling.

### 5.6 Team Runtime State

Long-running team work needs runtime state beyond chat messages. Add a durable state envelope for every active group:

```json
{
  "groupChatId": "collab-session-...",
  "runtimeStatus": "active",
  "scheduler": {
    "lastTickAt": 1777178300000,
    "nextTickAt": 1777178360000,
    "activeLeaseCount": 3,
    "queuedTaskCount": 5
  },
  "leader": {
    "memberId": "collab-member-leader",
    "speakerSessionId": "session-...",
    "status": "waiting"
  },
  "members": [
    {
      "memberId": "collab-member-researcher",
      "activeExecutorCount": 2,
      "queuedTaskCount": 1,
      "lastSeenAt": 1777178300000,
      "lastReportAt": 1777178200000
    }
  ],
  "eventCursor": {
    "latestEventId": "team-event-...",
    "lastLeaderSeenEventId": "team-event-..."
  },
  "recovery": {
    "resumeAfterRestart": true,
    "lastRecoveredAt": null,
    "lastRecoveryError": null
  }
}
```

This can live in session metadata first. If it grows too large, move it into a dedicated `TeamRuntimeStateRecord`.

Hard rule:

```text
canonical task/member/runtime state must be written before any executor starts
```

This is what allows the app to recover after restart, crash, timeout, or partial tool failure.

## 6. Runtime Modules

### 6.1 `TeamGroupChatStore`

Location:

- `desktop/src-tauri/src/runtime/collab_runtime.rs`
- optional split: `desktop/src-tauri/src/runtime/team_group_chat_runtime.rs`

Responsibilities:

- Create, read, archive, delete group chats.
- Add members.
- Create and update tasks.
- Append messages.
- Append events.
- Produce group snapshot.
- Maintain backward compatibility with existing `Collab*Record`.

Implementation detail:

- Keep current IPC names initially: `team-runtime:*`.
- Add model-facing action aliases with `team.chat.*`.
- Do not rename existing records until migration pressure is real.
- All mutations must update `updated_at` and emit a `TeamEvent`.

### 6.2 `TeamAgentControl`

Location:

- `desktop/src-tauri/src/subagents/team_agent_control.rs`
- connect from `desktop/src-tauri/src/subagents/spawner.rs`

Internal actions:

```text
team.agent.spawn
team.agent.await
team.agent.resume
team.agent.close
team.agent.cancel
```

Responsibilities:

- Create child session/runtime/task for a member.
- Write `isSubagentSession`, `roleId`, `groupChatId`, `memberId`, `taskId`, and role overlay metadata.
- Apply runtime mode, model config, allowed tools, and ToolRouter constraints.
- Resume unfinished child runtime after app restart.
- Close child runtime and release task lease.

This is self-developed. It must integrate with RedBox runtime state and cannot be replaced by an off-the-shelf library.

Codex reference:

- `spawn_agent`
- `wait_agent`
- `resume_agent`
- `close_agent`
- `SessionSource::SubAgent(ThreadSpawn)`

RedBox equivalent:

```text
childSessionId + childRuntimeId + runtimeTaskId + groupChatId + memberId
```

### 6.2.1 `TeamMemberRuntime`

Location:

- `desktop/src-tauri/src/subagents/team_member_runtime.rs`

Responsibilities:

- Maintain one logical member identity across speaker and executor runtimes.
- Manage member-level executor pool.
- Enforce `maxConcurrentExecutorsPerMember = 5`.
- Decide whether a new task should reuse an existing executor, spawn a new executor, or queue.
- Update member task plan JSON.
- Route execution events into the speaker speech queue.
- Wake the speaker only when speech policy is triggered.

Executor selection:

```rust
fn assign_member_task(member: &TeamMember, task: &TeamTask) -> MemberAssignmentDecision {
    if has_executor_for_task(member, task.id) {
        return MemberAssignmentDecision::ReuseExecutor;
    }
    if member.executor_pool.active_executor_count < member.executor_pool.max_concurrent_executors {
        return MemberAssignmentDecision::SpawnExecutor;
    }
    MemberAssignmentDecision::QueueForMember
}
```

Executor reuse policy:

- Same task: reuse executor.
- Same group chat and same role with compatible context: may reuse if executor is idle.
- Different group chat or unrelated task: spawn separate executor if capacity allows.
- Long-running generation/render jobs should use separate executor to avoid blocking short progress replies.

Speaker wake policy:

```rust
fn should_wake_speaker(event: &TeamEvent, member: &TeamMember) -> bool {
    matches!(
        event.event_type,
        "member_mentioned"
            | "task_assigned"
            | "progress_milestone"
            | "blocker_created"
            | "clarification_needed"
            | "artifact_submitted"
            | "report_requested"
            | "review_rejected"
    )
}
```

The speaker summarizes executor state. It should not run the task inline.

### 6.3 `TeamScheduler`

Location:

- `desktop/src-tauri/src/subagents/team_scheduler.rs`
- or `desktop/src-tauri/src/scheduler/team_runtime.rs`

Responsibilities:

- Scan active group chats.
- Start ready tasks within team, global, and member-level concurrency limits.
- Acquire and renew task leases.
- Request reports from active members.
- Detect stale heartbeat.
- Mark timeouts as blocked.
- Wake leader when all non-leader members are settled.
- Retry failed tasks within policy.
- Resume active group chats on app startup.

Pseudo loop:

```rust
fn tick_team_scheduler(store: &mut AppStore, now: i64) -> TeamSchedulerTickOutcome {
    for group in active_group_chats(store) {
        recover_expired_leases(store, group.id, now);
        request_stale_reports(store, group.id, now);
        mark_timeout_workers_blocked(store, group.id, now);
        start_ready_tasks_with_team_and_member_capacity(store, group.id, now);
        drain_member_speech_queues(store, group.id, now);
        wake_leader_if_needed(store, group.id, now);
        complete_group_if_done(store, group.id, now);
    }
}
```

Concurrency policy:

```text
maxActiveAgentsPerTeam
maxActiveAgentsGlobal
perModelConcurrency
perToolConcurrency
imageGenerationConcurrency
videoGenerationConcurrency
maxConcurrentExecutorsPerMember
```

The runtime can accept many agents, but scheduler must throttle actual model/tool pressure.

Member-level scheduling rules:

- One member can belong to multiple group chats.
- One member can own multiple tasks.
- One member can have up to five active executor threads globally.
- A task assigned to an overloaded member becomes `queued_for_member`.
- Leader can reassign queued work if priority is high.
- Speaker persona remains responsive even when all executor slots are busy.

### 6.4 `TeamEventAwait`

Location:

- `desktop/src-tauri/src/runtime/team_event_runtime.rs`
- action exposed through `app_cli` / `Redbox`

Model-facing actions:

```text
team.message.await
team.event.await
```

Input:

```json
{
  "groupChatId": "collab-session-...",
  "afterEventId": "event-...",
  "wakeOn": ["message_sent", "task_updated", "worker_finished", "worker_failed"],
  "timeoutMs": 30000
}
```

Output:

```json
{
  "timedOut": false,
  "events": [
    {
      "eventId": "event-...",
      "eventType": "worker_finished",
      "memberId": "collab-member-...",
      "taskId": "collab-task-...",
      "status": "completed"
    }
  ],
  "latestEventId": "event-..."
}
```

This prevents the bad pattern:

```text
model loops forever asking "is it done yet?"
```

The runtime waits or times out.

### 6.5 `TeamEventBus`

Location:

- `desktop/src-tauri/src/runtime/team_event_runtime.rs`
- `desktop/src-tauri/src/events.rs`

Responsibilities:

- Append durable team events for every canonical state transition.
- Maintain monotonic event IDs per group chat.
- Allow event queries after cursor.
- Notify scheduler, leader, speaker, and UI listeners.
- Bridge runtime task events into team events.
- Avoid duplicate events with idempotency keys.

Event categories:

```text
state_event       // task/member/group state changed
runtime_event     // executor started/heartbeat/finished/failed
message_event     // group message created/read
speech_event      // speaker queued/drained
verification_event
recovery_event
```

This is the backbone of continuity. `team.event.await` is a consumer of the event bus, not the event bus itself.

### 6.6 `TeamVerifier`

Location:

- `desktop/src-tauri/src/subagents/team_verifier.rs`

Responsibilities:

- Validate member output schema.
- Validate artifact references.
- Validate claimed file/image/video existence when possible.
- Detect "claimed completed" without evidence.
- Detect unauthorized tool use from runtime trace.
- Detect internal planning text leaked into user-facing artifacts.
- Return accept/reject with repair instructions.

Completion states:

```text
claimed_completed   // member says done, not yet verified
review              // waiting reviewer/verifier
completed           // verified accepted
failed              // unrecoverable
blocked             // needs leader action
```

No member should move a task directly from running to completed unless verifier accepts it.

### 6.7 `TeamRecovery`

Location:

- `desktop/src-tauri/src/subagents/team_recovery.rs`
- startup hook from app initialization / scheduler startup

Responsibilities:

- Scan active group chats on app startup.
- Rebuild in-memory scheduler queues from canonical records.
- Detect running tasks with missing runtime bindings.
- Resume recoverable child sessions.
- Release expired leases.
- Mark orphaned executors blocked when they cannot be resumed.
- Wake leader with recovery summary.

Recovery startup flow:

```text
App starts
-> load AppStore and session bundles
-> scan group chats where status=active
-> scan tasks where status=running/waiting/review/claimed_completed
-> validate member executor pool state
-> resume active child runtimes if possible
-> release expired leases
-> enqueue leader recovery message when state changed
-> scheduler continues ticking
```

Recovery must never rely on a live model remembering previous state. It must reconstruct state from persisted records.

### 6.8 `TeamRuntimeV2` Required Layers

To guarantee long-running continuity, Team mode requires all of these layers:

```text
TeamGroupChatStore   // durable group/member/task/message state
TeamMemberRuntime    // speaker + executor pool + member plan
TeamAgentControl     // spawn / await / resume / close / cancel
TeamScheduler        // lease / heartbeat / retry / wakeups
TeamEventBus         // event cursor and notifications
TeamVerifier         // completion and evidence gate
TeamRecovery         // app restart and crash recovery
```

Prompt alone is not a reliability mechanism. Group chat messages alone are not a scheduler. The runtime must own continuity.

## 7. AI Prompt Architecture

### 7.1 Shared Base

All team agents inherit:

- App global runtime rules.
- Current runtime mode overlay.
- ToolRouter visible tool policy.
- Active skill instructions.
- Group chat context.
- Subagent role overlay.

This preserves the current direction: subagents know the app rules and tools, while their role is added as a system-level overlay.

### 7.2 Leader Overlay

New prompt file:

```text
desktop/prompts/library/runtime/agents/team_leader/base.txt
```

Responsibilities:

- Act as project leader inside one persistent group chat.
- Break objective into tasks.
- Assign tasks to members.
- Use group messages for instructions and decisions.
- Read reports before changing plan.
- Request verifier/reviewer before final completion.
- Do not do all worker tasks personally unless no worker can do it.
- Do not mark project complete until all required tasks are verified.
- Treat member speech as status communication, not proof of completion.
- Inspect task state, reports, and evidence before making project decisions.

Leader allowed actions:

```text
team.chat.get
team.member.list
team.task.create
team.task.update
team.task.list
team.message.send
team.message.await
team.report.request
team.agent.spawn/resume/close (internal or restricted)
```

### 7.3 Worker Overlay

New prompt file:

```text
desktop/prompts/library/runtime/agents/team_worker/base.txt
```

Responsibilities:

- Read assigned task and relevant group messages.
- Claim task before work.
- Maintain member task plan JSON.
- Report progress periodically.
- Submit blocker when stuck.
- Submit artifact evidence.
- Never declare entire project complete.
- Use only allowed tools.
- Do not speak in group chat unless mentioned, reporting progress, asking a question, reporting a blocker, or submitting evidence.

Worker allowed actions should be role-specific. Example:

```text
researcher:
  redbox_fs read/search/list
  app_cli knowledge/search actions
  team.report.submit
  team.message.send

image-director:
  image.generate
  redbox_fs read/write only for artifacts
  team.report.submit
  team.message.send

reviewer:
  redbox_fs read/search/list
  team.task.update review status
  team.report.submit
```

### 7.4 Reviewer Overlay

New prompt file:

```text
desktop/prompts/library/runtime/agents/team_reviewer/base.txt
```

Responsibilities:

- Review evidence, output schema, artifacts, user requirements, and task goal.
- Reject false success.
- Return concrete repair task when rejected.
- Never rewrite the artifact unless assigned as repair worker.

### 7.5 Prompt Composition

Target order:

```text
system_base.txt
+ runtime mode overlay
+ skill prompt bundle
+ team group chat overlay
+ subagent role overlay
+ member profile
+ member task plan summary
+ current group snapshot
+ current task packet
+ user / scheduler instruction
```

`team group chat overlay` should be generated from metadata:

```json
{
  "teamKind": "group_chat",
  "groupChatId": "...",
  "memberId": "...",
  "memberKind": "leader|worker|reviewer",
  "currentTaskId": "...",
  "leaderMemberId": "...",
  "speakerPolicy": "event_driven",
  "executorId": "executor-..."
}
```

## 8. Tool Design

### 8.1 Model-Facing Tool Families

Keep model-facing team actions simple:

```text
team.chat.create
team.chat.get
team.chat.archive
team.chat.delete
team.member.add
team.member.list
team.task.create
team.task.update
team.task.list
team.message.send
team.message.await
team.report.request
team.report.submit
```

Do not expose scheduler internals to normal users.

### 8.2 Internal Runtime Actions

Internal-only or restricted actions:

```text
team.agent.spawn
team.agent.await
team.agent.resume
team.agent.close
team.agent.cancel
team.scheduler.tick
team.verifier.check
team.cleanup.runtime
team.cleanup.state
```

These actions should be callable by scheduler and trusted coordinator paths, not by every normal runtime turn.

### 8.3 ToolRouter Policy

ToolRouter should expose team tools by role:

```text
leader:
  chat/member/task/message/report/await

worker:
  chat.get/task.update/message.send/report.submit
  team.member.plan.read/update
  role-specific production tools

reviewer:
  chat.get/task.update/message.send/report.submit
  read-only artifact inspection tools

normal user chat:
  chat.create/list/get only when team intent is active
```

This is required for stability. Prompt-only "please do not use this" is insufficient.

### 8.4 Member Plan Tools

Add member-scoped plan actions:

```text
team.member.plan.get
team.member.plan.update
team.member.plan.append_progress
team.member.plan.enqueue_speech
team.member.plan.clear_speech
```

Only the member's speaker/executor runtimes, leader, scheduler, and verifier should access these actions. Normal group members should not freely edit another member's plan.

Plan updates must be patch-like and bounded:

```json
{
  "memberId": "collab-member-...",
  "operation": "append_progress",
  "taskId": "collab-task-...",
  "progress": {
    "currentStep": "整理证据",
    "lastProgressSummary": "已完成素材初筛",
    "nextSteps": ["提炼冲突点"]
  }
}
```

Do not let models replace the whole JSON blob unless the scheduler explicitly enters repair mode.

## 9. UI Plan

The UI should remain simple. No developer diagnostic panel is required.

### 9.1 User-Facing Surface

Normal user sees:

```text
AI 项目群：短视频选题策划
Leader: 规划中
Researcher: 已完成素材分析
Image Director: 正在生成封面方案
Reviewer: 等待审核
```

The group chat shows durable messages:

- Leader instructions.
- Member progress reports.
- Blockers.
- Artifact submissions.
- Review decisions.
- Final summary.

It should not show every executor thought or every low-level tool call. Executor details belong in logs and member task plan state. Group chat is for useful communication.

### 9.2 Workboard Surface

Workboard should show:

- group chat list
- active/completed/archived status
- member list
- task list
- progress
- artifact refs
- delete/archive actions

No tmux pane, CLI output, or raw scheduler internals.

### 9.3 Deletion Semantics

Group chat deletion must be explicit:

```text
archive: hide from active list, keep messages and artifacts
delete: remove group chat and messages after confirmation
close runtimes: stop active member runtimes
cleanup transient state: remove leases, await cursors, temporary scheduler state
```

Deleting a group chat with active runtimes must first close/cancel those runtimes or ask the user for confirmation.

## 10. Media And Video Integration

Team mode must work for content production, image generation, and video workflows.

### 10.1 Image Generation

Image-director member should:

- read task goal and visual constraints
- produce clean image prompts
- avoid internal page/framework labels
- call `image.generate`
- submit artifact refs and evidence
- let verifier/reviewer inspect output

Must use existing image generation runtime and `redbox-image-director` skill. Do not create a separate image pipeline inside team runtime.

### 10.2 Video Editing

Animation/video member should:

- receive script/timeline task
- use existing video editor / Remotion / manuscript package tools
- submit structured animation JSON or video artifact refs
- report render failures as blockers

Must use existing libraries and systems:

- existing Remotion/FreeCut/video editor modules for timeline and rendering
- existing manuscript package model for script-bound assets
- existing media store for artifacts

Do not self-build a video renderer inside team runtime.

### 10.3 Content Writing

Copywriter member should:

- use manuscript tools and knowledge retrieval
- submit draft artifact refs
- avoid claiming saved drafts without tool evidence

Must use existing manuscript persistence APIs. Do not write ad hoc files unless the runtime action explicitly supports it.

## 11. Existing Libraries vs Self-Developed Modules

### 11.1 Must Use Existing Code

- Current Tauri/Rust runtime and AppStore.
- Existing `Collab*Record` for initial storage compatibility.
- Existing runtime task and session bundle persistence.
- Existing ToolRouter / dynamic tool exposure.
- Existing image generation runtime.
- Existing video editor / manuscript package / Remotion pipeline.
- Existing event stream.
- Existing scheduler primitives where practical.
- `serde`, `serde_json`, Rust async runtime already in the app.

### 11.2 Must Self-Develop

- Team group chat semantics.
- TeamAgentControl.
- TeamScheduler.
- TeamEventAwait.
- TeamVerifier.
- Leader/worker/reviewer prompt overlays.
- ToolRouter role policy for team members.
- Canonical handoff packet and evidence protocol.

These are product-specific and should not be delegated to an external queue, tmux, or generic CLI supervisor.

### 11.3 Optional Later

- SQLite-backed job queue if AppStore-based scheduler becomes too large.
- External process worker transport.
- Remote worker transport.
- Rich Workboard UI.

None of these are required for the core architecture.

## 12. Performance And Reliability Strategy

### 12.1 Concurrency Control

Runtime can accept many agents, but active execution must be controlled:

```text
maxActiveAgentsPerTeam = 4
maxActiveAgentsGlobal = 8
maxConcurrentExecutorsPerMember = 5
maxImageJobs = 2
maxVideoJobs = 1
maxSameModelRequests = provider-specific
```

Scheduler should queue ready tasks when team, global, model, tool, or member-level capacity is full.

### 12.2 Lease And Idempotency

Every running task must have:

- lease owner
- lease token
- lease expiry
- attempt count
- idempotency key

If the app restarts, scheduler can decide whether to resume, retry, or mark blocked.

### 12.3 Heartbeat And Reports

Member heartbeat:

```text
lastSeenAt updates when runtime emits progress/tool/report events
lastReportAt updates on team.report.submit
executor.lastHeartbeatAt updates from executor progress/tool events
speaker.lastSpokeAt updates from group messages
```

Timeout rules:

```text
now - lastReportAt > reportIntervalMs => request report
now - lastSeenAt > heartbeatTimeoutMs => mark blocked and wake leader
lease expired => release or retry task
```

### 12.3.1 Speaker Availability

Speaker persona must remain responsive even when the member has five active executors. Speech should be a lightweight runtime turn that reads member plan state and writes a group message. It should not occupy an executor slot.

This prevents the bad case where a member is doing five long-running tasks and cannot answer a leader mention or submit a status summary.

### 12.4 Context Budget

Worker prompts should not inherit entire group chat history. Use:

```text
group summary
current task packet
last N relevant messages
accepted facts
artifact refs
open blockers
```

Long group chats should be compacted into group memory summaries.

### 12.5 Event-Driven Await

Use `team.event.await` instead of model polling.

```text
wait up to 30s for relevant event
return timedOut=true if no event
model decides whether to continue, summarize, or schedule background wait
```

This prevents agent loops that never end.

### 12.6 Failure Recovery

Failure classes:

```text
worker_failed
worker_timeout
tool_unavailable
artifact_missing
schema_invalid
unauthorized_tool
review_rejected
leader_timeout
```

Each failure creates:

- group message
- team event
- task status update
- optional repair task

### 12.7 Continuity Contract

Team Runtime v2 must satisfy this contract:

```text
If the app is running:
  ready work eventually starts when capacity is available
  running work emits heartbeat or times out
  completed claims go through verifier
  relevant events wake speaker or leader

If the app restarts:
  active groups reload from durable state
  recoverable executors resume
  expired leases are released
  orphaned tasks become blocked or retryable
  leader receives a recovery summary

If a model/tool fails:
  failure becomes a task event
  member plan records the blocker
  speaker can report it
  leader can reassign or create repair work
```

The system is allowed to pause or block work when evidence is missing. It is not allowed to silently lose active work.

### 12.8 Executor To Speaker Visibility Boundary

Speaker can read:

```text
MemberTaskPlan JSON
TeamEvent stream
TeamTask canonical state
artifactRefs
evidence records
accepted handoff packets
```

Speaker cannot read by default:

```text
executor hidden reasoning
raw prompt internals
full unrelated tool logs
other members' private scratch state
```

This boundary keeps group chat clean while still making progress visible.

## 13. Implementation Plan

This is a bottom-up implementation. UI can stay minimal until the runtime is stable.

### 13.1 Data And Events

Files:

- `desktop/src-tauri/src/runtime/collab_runtime.rs`
- `desktop/src-tauri/src/runtime/types.rs`
- `desktop/src-tauri/src/commands/runtime_collab.rs`

Tasks:

1. Add group chat metadata policy helpers.
2. Add `TeamEvent` record or event projection.
3. Ensure every team mutation emits a canonical event.
4. Add archive/delete semantics distinct from runtime close.
5. Add snapshot fields for latest event id and active runtime bindings.
6. Add durable team runtime state envelope.
7. Enforce canonical state before executor spawn.

Acceptance:

- Creating a team group chat writes session, leader, kickoff message, and `group_created` event.
- Updating a task writes `task_updated` event.
- Deleting or archiving a group has explicit behavior.
- A worker cannot start unless group, member, task, lease, and runtime binding records exist.

### 13.2 Agent Control

Files:

- `desktop/src-tauri/src/subagents/team_agent_control.rs`
- `desktop/src-tauri/src/subagents/spawner.rs`
- `desktop/src-tauri/src/interactive_runtime_shared.rs`

Tasks:

1. Extract child runtime creation into reusable `TeamAgentControl`.
2. Bind each child runtime to groupChatId/memberId/taskId.
3. Add team group chat overlay to system prompt composition.
4. Add close/cancel path for active member runtime.
5. Add resume path from persisted child session/runtime metadata.
6. Add speaker/executor binding metadata.
7. Enforce one logical member identity across speaker and executor runtimes.

Acceptance:

- A member runtime can be spawned from a canonical task.
- Child system prompt contains app rules, tools, group chat overlay, and role overlay.
- Closing a member releases lease and updates member/task status.
- Speaker persona can summarize executor state without executing the task inline.

### 13.2.1 Member Runtime Split

Files:

- `desktop/src-tauri/src/subagents/team_member_runtime.rs`
- `desktop/src-tauri/src/subagents/team_agent_control.rs`
- `desktop/src-tauri/src/runtime/collab_runtime.rs`

Tasks:

1. Add `TeamSpeakerBinding` metadata.
2. Add `TeamExecutorPoolState` metadata.
3. Add member task plan JSON helpers.
4. Add per-member executor cap with default 5.
5. Add member assignment decision: reuse, spawn, queue.
6. Add speech queue in member task plan.
7. Wake speaker from speech queue events.
8. Add executor progress and completion claim writers.
9. Add speaker summary reader for plan/event/evidence state.

Acceptance:

- One member can run multiple background executors up to cap.
- The same member can participate in multiple group chats.
- Over-cap tasks queue instead of spawning unlimited runtimes.
- Speaker remains available for reports while executors work.
- Speaker and executor use the same member profile.
- Executor completion claim becomes verifier input before group chat completion messaging.

### 13.3 Scheduler

Files:

- `desktop/src-tauri/src/subagents/team_scheduler.rs`
- `desktop/src-tauri/src/scheduler/*`
- `desktop/src-tauri/src/commands/runtime_collab.rs`

Tasks:

1. Implement scheduler tick outcome.
2. Acquire leases for ready tasks.
3. Respect team/global concurrency.
4. Request stale reports.
5. Mark heartbeat timeouts blocked.
6. Wake leader when workers settle or block.
7. Resume active teams on app startup.
8. Respect per-member executor cap.
9. Drain member speech queues into group messages.
10. Keep speaker wakeups separate from executor work.

Acceptance:

- Ready tasks start without model-side polling.
- Expired leases are recovered.
- Stale members receive report requests.
- Coordinator wakes when workers finish or block.
- No member exceeds five active executor threads.
- Group chat messages are event-driven, not round-robin.

### 13.4 Event Await

Files:

- `desktop/src-tauri/src/runtime/team_event_runtime.rs`
- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/tools/app_cli.rs`

Tasks:

1. Add `team.event.await`.
2. Add `team.message.await`.
3. Clamp timeout to safe min/max.
4. Return events after cursor.
5. Avoid tight loops.

Acceptance:

- Await returns immediately when matching event already exists.
- Await times out with `timedOut=true`.
- Await never blocks the UI thread.

### 13.5 Event Bus

Files:

- `desktop/src-tauri/src/runtime/team_event_runtime.rs`
- `desktop/src-tauri/src/events.rs`
- `desktop/src-tauri/src/commands/runtime_collab.rs`

Tasks:

1. Add durable event append helper.
2. Add per-group monotonic event id or sequence.
3. Emit events from group/member/task/message/report mutations.
4. Bridge child runtime state into team events.
5. Add event query after cursor.
6. Add idempotency keys for repeated scheduler ticks.

Acceptance:

- Every canonical mutation has an event.
- `team.event.await` can consume existing and future events.
- Duplicate scheduler ticks do not duplicate semantic events.

### 13.6 Verifier

Files:

- `desktop/src-tauri/src/subagents/team_verifier.rs`
- `desktop/src-tauri/src/runtime/orchestration_runtime.rs`

Tasks:

1. Define member output schema.
2. Validate handoff packet.
3. Validate artifact refs.
4. Validate completion evidence.
5. Reject false success.
6. Create repair task when needed.

Acceptance:

- A task cannot become completed without verifier acceptance.
- Claimed file/image/video artifacts must have tool evidence or artifact refs.
- Rejected output creates group message and task status update.

### 13.7 Recovery

Files:

- `desktop/src-tauri/src/subagents/team_recovery.rs`
- `desktop/src-tauri/src/subagents/team_scheduler.rs`
- app startup wiring

Tasks:

1. Scan active group chats on startup.
2. Rebuild scheduler queues from persisted records.
3. Resume recoverable child runtimes.
4. Release expired leases.
5. Mark orphaned executors blocked or retryable.
6. Wake leader with recovery summary when state changed.

Acceptance:

- Active group resumes after app restart.
- Running task with expired lease does not remain stuck forever.
- Recovery creates durable events and group messages.

### 13.8 Prompt And ToolRouter

Files:

- `desktop/prompts/library/runtime/agents/team_leader/base.txt`
- `desktop/prompts/library/runtime/agents/team_worker/base.txt`
- `desktop/prompts/library/runtime/agents/team_reviewer/base.txt`
- `desktop/src-tauri/src/tools/plan.rs`
- `desktop/src-tauri/src/tools/router.rs`

Tasks:

1. Add team overlays.
2. Add metadata-driven prompt composition.
3. Add role-based tool exposure.
4. Ensure worker tools are hard-filtered.
5. Ensure leader gets team orchestration tools.
6. Add speaker persona overlay and executor overlay.
7. Add member task plan summary to speaker and executor prompts.

Acceptance:

- Worker cannot see unrelated destructive/admin tools.
- Leader can create/update tasks and send/await messages.
- Reviewer gets read/review tools but not production tools unless explicitly assigned.
- Speaker and executor keep one member voice/profile while preserving separate responsibilities.
- Team mode disables forced speaker order and uses event-driven speech.

### 13.9 UI Integration

Files:

- `desktop/src/pages/Workboard.tsx`
- `desktop/src/pages/Chat.tsx`
- `desktop/src/bridge/ipcRenderer.ts`

Tasks:

1. Show group chats as persistent project chats.
2. Show latest member status and task status.
3. Show durable group messages.
4. Add archive/delete controls.
5. Show member task plan panel when useful.
6. Keep UI minimal; do not expose scheduler internals.

Acceptance:

- User can open an active group and see progress.
- User can inspect a member's current plan without reading raw executor logs.
- User can archive/delete unneeded group chats.
- Refresh preserves last successful snapshot.

## 14. Migration Strategy

Do not break existing Workboard/collab records.

Steps:

1. Treat existing `CollabSessionRecord` as group chat when `metadata.teamKind == "group_chat"`.
2. Existing sessions without this metadata remain legacy collaboration sessions.
3. New team tasks always write group chat metadata.
4. Add compatibility aliases:

```text
team.session.* -> existing compatibility
team.chat.* -> new group chat semantics
```

5. Once stable, docs and UI copy can shift from "collab session" to "AI project group".

## 15. Testing Plan

### 15.1 Unit Tests

- Create group chat writes canonical records.
- Task cannot start without canonical task.
- Lease prevents duplicate task execution.
- Event await returns matching events after cursor.
- Verifier rejects completion without evidence.
- Archive/delete semantics are distinct.

### 15.2 Runtime Tests

- Spawn leader and worker in one group.
- Worker receives task from group context.
- Worker submits progress report.
- Leader receives report via event await.
- App restart resumes active group.
- Timeout marks worker blocked and wakes leader.
- One member can run multiple executor threads across groups up to cap.
- Over-cap assigned tasks queue instead of spawning a sixth executor.
- Speaker can answer a mention while executors remain busy.
- Speaker messages summarize plan state and do not execute tool work inline.

### 15.3 Media Tests

- Image worker generates asset and submits artifact ref.
- Verifier rejects fake image path.
- Video worker reports render blocker correctly.
- Copywriter submits manuscript artifact through existing manuscript APIs.

### 15.4 Regression Tests

- No infinite loop when waiting for image/video completion.
- No direct completion without verifier.
- No tool outside allowed worker policy.
- No stale loading wipe in UI.

## 16. Recommended First Implementation Slice

The most valuable first slice is:

```text
TeamEvent + team.event.await
+ canonical group chat metadata
+ durable TeamRuntimeState
+ TeamAgentControl binding groupChatId/memberId/taskId
+ TeamMemberRuntime speaker/executor split
+ member task plan JSON
+ TeamEventBus
+ TeamRecovery startup scan
+ leader/worker prompt overlays
```

This directly addresses the current failure modes:

- model-side polling loops
- workers receiving synthetic task state
- subagents not knowing group context
- lack of durable group progress
- forced speaking order replacing real work
- members losing track of multiple active tasks
- app restart losing active work
- speaker not knowing executor progress

Do not start from a rich UI. The runtime must be solid first.

## 17. Final Target

The final product behavior:

```text
用户提出复杂任务
-> RedBox 自动创建 AI 项目群
-> Leader 拆任务并拉成员
-> 成员后台执行器真正做事
-> 成员发言者在被点名、汇报、阻塞、提交证据时进群发言
-> 每个成员维护自己的任务 plan 面板
-> Scheduler 后台推进、等待、恢复、限流
-> Verifier 阻止伪完成
-> 用户随时查看群聊进展
-> 项目完成后归档，或用户删除群聊
```

This gives RedBox a team collaboration model that fits its own runtime instead of copying a CLI/tmux architecture.
