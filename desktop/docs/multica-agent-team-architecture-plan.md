---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-01
owner: codex
scope:
  - desktop/src-tauri/src/agent_hub
  - desktop/src-tauri/src/runtime
  - desktop/src-tauri/src/subagents
  - desktop/src-tauri/src/commands/runtime_collab.rs
  - desktop/src-tauri/src/commands/chatrooms.rs
  - desktop/src-tauri/src/mcp/team_server.rs
  - desktop/src/pages/Team.tsx
  - desktop/src/pages/Workboard.tsx
  - desktop/src/pages/workboard/CollaborationBoard.tsx
reference_implementations:
  - https://github.com/multica-ai/multica
  - /tmp/multica-study
  - /tmp/multica-study/server/pkg/db/queries/agent.sql
  - /tmp/multica-study/server/internal/handler/chat.go
  - /tmp/multica-study/server/internal/daemon/daemon.go
  - /tmp/multica-study/packages/views/chat/components/chat-window.tsx
  - /tmp/multica-study/packages/views/issues/components/board-view.tsx
success_metrics:
  - collab_task_state_has_single_canonical_record = 100 percent
  - team_message_recovery_after_restart = true
  - active_agent_task_resume_pointer_coverage = 100 percent
  - task_panel_refresh_preserves_last_successful_snapshot = true
  - long_running_media_task_ui_polling = 0
  - agent_loop_duplicate_claim_rate = 0
---

# Multica-Inspired Agent Team Architecture Plan

## 1. Research Conclusion

Multica can solve the shape of our multi-agent collaboration, group chat, team and task panel problem, but its value is not in copying the full repository. Its strongest transferable idea is:

```text
Agent / Member / Chat / Issue / Task are product records.
Runtime execution is a queue state machine.
Chat and task panel are projections over the same task queue.
Daemon/runtime only claims executable work and streams state transitions.
```

RedConvert should absorb this model into the existing Tauri local runtime instead of importing Multica's Go server, PostgreSQL, Next.js app, or cloud/daemon topology wholesale.

Recommended route:

```text
Use Multica as architecture reference.
Self-build the RedConvert implementation on AppStore + runtime_events + teamRuntime IPC.
Reuse proven libraries only for UI primitives, drag/drop, query cache, video/audio processing and embeddings.
Do not vendor Multica source directly except for small Apache-2.0-compatible patterns that are rewritten in Rust/TS style.
```

Important simplification:

```text
Do not build a heavy team simulator.
Modern AI does not need excessive role scaffolding, forced speaker loops or rigid leader/member protocols.
Build the smallest durable substrate: agent identity, task queue, messages, artifacts, review dockets and events.
Let the AI reason over that substrate.
```

## 2. What Multica Gets Right

### 2.1 Unified Task Queue

Multica's `agent_task_queue` is the core. Issue assignment, chat replies, quick-create and autopilot all enqueue the same task record. Status transitions are explicit:

```text
queued -> dispatched -> running -> completed
queued -> dispatched -> running -> failed
queued/dispatched/running -> cancelled
```

Important implementation details:

- `ClaimAgentTask` uses `FOR UPDATE SKIP LOCKED` and serializes per agent + issue or per agent + chat session.
- `attempt`, `max_attempts`, `parent_task_id`, `failure_reason`, `last_heartbeat_at` support retry and recovery.
- `session_id` and `work_dir` are pinned early so a crashed daemon can resume a task.
- Chat tasks are not special runtime code; they are task queue rows with `chat_session_id`.

RedConvert equivalent:

- Keep the existing `CollabTaskRecord`, `runtime task`, scheduler and event stream.
- Add a single canonical `TeamTaskExecution` state machine, not separate ad hoc flows for group chat, RedClaw and Workboard.
- Every agent/worker execution must have a persisted task before a runtime is spawned.

### 2.2 Agent As Team Member

Multica models agents as workspace-scoped records with:

- identity: name, avatar, owner, visibility
- runtime binding: provider, runtime id, model, custom env/args/MCP config
- activity: status, run counts, task snapshots
- skills: agent-skill junction

RedConvert equivalent:

- Expand `agent_hub::AgentBackendDescriptor` into a real agent directory.
- One logical member should map to `MemberProfile + AgentRuntimeBinding + CapabilitySet`.
- Keep human-facing advisors from `Team.tsx`, but let each advisor optionally bind to an executable runtime.

### 2.3 Chat As Task Source

Multica chat flow:

```text
send user message
-> persist chat_message
-> enqueue chat task
-> optimistic UI seeds pending task
-> runtime emits task messages
-> assistant reply persists as chat_message
-> chat:done clears pending state
```

This is directly useful for RedConvert group chat. Current `CreativeChat` is message-centric; it should become task-aware.

RedConvert equivalent:

- `chatrooms:send` should create a `CollabMailboxMessageRecord` and, when executable, a `CollabTaskRecord`.
- The group chat timeline should render messages plus task events, not separate hidden execution logs.
- The task panel should show the same records the chat created.

### 2.4 Realtime Events As Cache Signals

Multica WebSocket events are scoped and mostly used to invalidate or update query caches:

- workspace events for issue/agent/member/project changes
- task events for queue lifecycle and task messages
- chat events for messages/done/read state
- daemon runtime events for wakeups

RedConvert equivalent:

- Continue using `runtime:*` events.
- Add strict event naming and payloads for canonical task lifecycle:
  - `runtime:team-task-queued`
  - `runtime:team-task-claimed`
  - `runtime:team-task-running`
  - `runtime:team-task-message`
  - `runtime:team-task-completed`
  - `runtime:team-task-failed`
  - `runtime:team-task-cancelled`
- UI should subscribe to events and rehydrate snapshots; never use event payloads as the only source of truth.

## 3. Target RedConvert Product Architecture

```text
Team Workspace
├─ Team Directory
│  ├─ human members
│  ├─ advisor profiles
│  ├─ executable agents
│  └─ runtime health
├─ Group Chat
│  ├─ rooms
│  ├─ messages
│  ├─ mentions
│  ├─ context anchors
│  └─ task-linked assistant replies
├─ Task Board
│  ├─ canonical tasks
│  ├─ owner/member assignment
│  ├─ status lanes
│  ├─ blockers
│  ├─ artifacts
│  └─ execution transcript
├─ Agent Runtime Queue
│  ├─ queued/dispatched/running/terminal states
│  ├─ lease + heartbeat
│  ├─ retry + resume pointers
│  ├─ per-member concurrency limits
│  └─ cancellation
├─ Thin AI Work Protocol
│  ├─ create / claim / update task
│  ├─ send message
│  ├─ attach evidence
│  ├─ request review
│  └─ resume after decision
├─ Media/Video Workflows
│  ├─ script/manuscript tasks
│  ├─ asset ingestion tasks
│  ├─ transcript/segment tasks
│  ├─ auto-edit tasks
│  ├─ render/export tasks
│  └─ artifact registry
└─ Observability
   ├─ runtime events
   ├─ diagnostics checkpoints
   ├─ session bundles
   ├─ transcript replay
   └─ task recovery audit
```

## 4. Module Implementation Details

### 4.0 Simplified Team Principle

The current app should reduce internal team machinery, not add more. The app should own durable facts; AI should own judgment.

Keep:

- Agent profiles and capabilities.
- Group chat messages.
- Canonical tasks.
- Artifacts/evidence.
- Human review dockets.
- Runtime events and diagnostics.
- Basic leases, retries and recovery.

Remove or avoid:

- Forced round-robin speaking.
- Separate `LeaderRuntime`, `SpeakerPersona`, `ExecutorThread` modules as hard product primitives.
- A complex internal hierarchy of roles that the user must manage.
- Multiple task boards for chat, RedClaw, Workboard and media.
- Heavy team policy engines that try to decide everything before the model sees context.

Replacement model:

```text
AI receives:
  - current task
  - available agents/capabilities
  - relevant chat context
  - available tools
  - artifact/evidence refs
  - review constraints

AI decides:
  - whether to split work
  - who should handle each subtask
  - whether to ask the human
  - what evidence proves completion
```

The host only enforces invariants:

- A task must exist before execution.
- A task can only be claimed once at a time.
- Risky actions require a `ReviewDocket`.
- Artifacts must exist before they can be used as completion evidence.
- A task waiting for review cannot resume without a structured decision.
- Long-running work must heartbeat or be recovered.

### 4.1 Agent Directory

Implement in:

- `desktop/src-tauri/src/agent_hub/types.rs`
- `desktop/src-tauri/src/agent_hub/registry.rs`
- `desktop/src-tauri/src/agent_hub/health.rs`
- `desktop/src-tauri/src/agent_hub/capabilities.rs`
- `desktop/src-tauri/src/commands/agent_hub.rs`

Canonical record:

```rust
pub struct AgentRecord {
    pub id: String,
    pub display_name: String,
    pub source_kind: AgentSourceKind, // internal, acp_cli, local_cli, future_remote
    pub backend: String,              // redbox-runtime, codex, claude, gemini, etc.
    pub owner_profile_id: Option<String>,
    pub visibility: AgentVisibility,
    pub status: AgentHealthStatus,
    pub runtime_binding: RuntimeBinding,
    pub capabilities: Vec<CapabilityDescriptor>,
    pub max_concurrent_tasks: u32,
    pub model: Option<String>,
    pub custom_args: Vec<String>,
    pub custom_env: BTreeMap<String, String>,
    pub mcp_config: Option<Value>,
    pub updated_at: i64,
}
```

Must self-build:

- Rust types and AppStore persistence.
- Health cache and renderer IPC.
- Mapping from advisors/team members to executable agents.

Use existing libraries:

- Keep existing CLI runtime detection and ACP/Hermes code paths.
- Use `serde`, `serde_json`, `tokio`, existing event emitter.

Do not copy:

- Multica's Go `agent_runtime` schema or daemon registration code directly.

### 4.2 Canonical Team Task Queue

Implement in:

- `desktop/src-tauri/src/runtime/team_task.rs`
- `desktop/src-tauri/src/runtime/team_queue.rs`
- `desktop/src-tauri/src/runtime/team_scheduler.rs`
- `desktop/src-tauri/src/commands/runtime_collab.rs`

Task record:

```rust
pub struct TeamTaskRecord {
    pub id: String,
    pub session_id: String,
    pub parent_task_id: Option<String>,
    pub source: TeamTaskSource, // chat, user_board, leader_plan, redclaw, media_pipeline
    pub title: String,
    pub description: String,
    pub status: TeamTaskStatus,
    pub priority: i32,
    pub assignee_member_id: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub context: Value,
    pub attempt: u32,
    pub max_attempts: u32,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<i64>,
    pub session_resume_id: Option<String>,
    pub work_dir: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub failure_reason: Option<String>,
}
```

State transition API:

```text
team.task.create
team.task.claim
team.task.start
team.task.pin_session
team.task.append_message
team.task.complete
team.task.fail
team.task.cancel
team.task.retry
```

Must self-build:

- Claim logic over local AppStore.
- Lock discipline: read minimal snapshot under lock, release, run I/O outside lock, reacquire only to commit state.
- Recovery on startup for `dispatched/running` tasks with expired leases.

Use existing libraries:

- Existing scheduler/job runtime concepts.
- Existing `runtimeEventStream.ts`.

### 4.3 Group Chat

Implement by evolving:

- `desktop/src-tauri/src/commands/chatrooms.rs`
- `desktop/src/pages/CreativeChat.tsx`
- `desktop/src/pages/Team.tsx`

Redesign data model:

```text
ChatRoom
├─ id
├─ title
├─ mode: casual | team_task | redclaw_project | media_project
├─ member_ids
├─ linked_collab_session_id
└─ last_read markers

ChatMessage
├─ id
├─ room_id
├─ author_type: user | member | agent | system
├─ author_id
├─ content
├─ linked_task_id
├─ linked_artifact_ids
├─ mention_refs
└─ created_at
```

Execution flow:

```text
User sends message
-> persist ChatMessage
-> classify whether executable
-> if executable, create TeamTaskRecord(source=chat)
-> emit chat message event
-> task worker claims and runs
-> assistant/member reply persists as ChatMessage(linked_task_id)
-> task board updates from same task
```

Must self-build:

- Mention routing and task creation policy.
- Room to collab-session linking.
- Stale-while-revalidate UI loading behavior.

Use existing libraries:

- Keep existing editor/composer components where possible.
- Add TanStack Query only if we commit to a broader renderer data-cache pattern; otherwise keep local hooks but mimic the stale cache behavior.

### 4.4 Task Panel

Implement by evolving:

- `desktop/src/pages/workboard/CollaborationBoard.tsx`
- `desktop/src/pages/Workboard.tsx`

UI should be sparse:

- Left: session/project list.
- Center: compact kanban/list switch.
- Right: selected task inspector.
- Bottom or drawer: execution transcript only on demand.

No large explanatory copy. Use icons, status pills, avatars, progress rings, and concise tooltips.

Must self-build:

- Task board projection from `TeamTaskRecord`.
- Inline blockers/artifacts/reports.
- Recovery indicators for stale/failed/rerun tasks.

Use existing libraries:

- `@dnd-kit/core` and `@dnd-kit/sortable` if drag/drop is needed.
- Existing lucide icons.
- Existing design tokens and CSS.

### 4.5 Thin AI Work Protocol

Implement in:

- `desktop/src-tauri/src/subagents/team_protocol.rs`
- `desktop/src-tauri/src/subagents/team_tools.rs`
- `desktop/src-tauri/src/mcp/team_server.rs`
- `desktop/prompts/library/runtime/team/*.md`

Do not build a heavyweight orchestrator with fixed leader/member/reviewer loops. Build a small protocol that any capable AI can use.

Minimal tool contract:

```text
team.context.get
team.agent.list
team.task.create
team.task.update
team.task.claim
team.task.complete
team.task.fail
team.message.send
team.artifact.attach
review.request
review.await_decision
```

Prompt contract:

```text
You are working inside a RedConvert team workspace.
Use tasks for durable work, messages for communication, artifacts for evidence,
and review dockets when a human decision is required.

Do not simulate a committee.
Create subtasks only when parallel work or review makes the result better.
Prefer one capable agent doing the work over many agents talking about it.
Ask for human review only at meaningful decision boundaries.
```

Optional role hints can live on agent profiles:

```text
research
writing
editing
video
cover
review
publishing
```

These are hints, not hard-coded routing rules. The model can decide that one agent should do several roles when that is simpler.

Must self-build:

- Tool schemas and state transitions.
- Prompt overlays that teach the protocol.
- Minimal evidence validation.
- Completion gates specific to RedConvert artifacts.

Use existing libraries:

- Existing LLM transport.
- Existing MCP manager/team server.
- Existing skills/tool exposure system.

Avoid:

- Autonomous manager loops that run forever.
- Agent-to-agent chatter as progress.
- A separate speaker runtime.
- Hard-coded text keyword routing.
- Creating a subtask for every thought.

### 4.6 Video And Media Pipeline

The team system must not be code-task-only. RedConvert needs media-aware task types:

```text
media.ingest
media.transcribe
script.outline
script.draft
script.rewrite
cover.generate
video.segment_select
video.auto_edit
video.timeline_apply
video.render
publish.package
```

Implementation:

- A leader creates a media project group when the user asks for video/content production.
- A script agent owns manuscript tasks.
- A media agent owns asset/transcript/segment tasks.
- A video editor agent owns timeline and render tasks.
- A reviewer agent checks duration, missing assets, copyright/source constraints and export existence.

Use existing libraries:

- FFmpeg/ffprobe for video/audio probing, transcoding, waveform and thumbnails.
- Remotion for React-based render previews and exports already present in the repo.
- Existing Freecut timeline bridge where it is already vendored.
- Existing embedding/vector/BM25 retrieval for knowledge and source grounding.

Must self-build:

- Media task schema.
- Artifact registry linking outputs to tasks.
- Timeline mutation safety checks.
- Render queue integration with the task state machine.

Do not self-build:

- Video decoding/encoding.
- waveform extraction.
- browser-grade drag/drop primitives.
- markdown/editor parsing if existing editor already covers it.

### 4.7 Review Docket: Human Approval Desk

Multica's inbox is useful because it treats AI output as work that may require human attention. RedConvert should not copy a traditional inbox list. The product metaphor should be:

```text
AI 自主工作，人类批奏折。
```

The user should review one decision page at a time. Internally call it `ReviewDocket`; UI can call it `御批台`, `审批台` or `Review Desk`. Recommended product placement:

```text
Workboard
├─ 御批台 / Review Docket
├─ 协作任务 / Collaboration Board
└─ RedClaw 任务
```

It may also have a global navigation badge such as `待批`, but the real surface belongs in Workboard because it is a work decision queue, not a notification drawer.

Core product rule:

```text
Every docket must ask for one clear human decision.
No docket should be a passive FYI message.
```

Canonical record:

```rust
pub struct ReviewDocketRecord {
    pub id: String,
    pub source_kind: ReviewSourceKind, // redclaw, team, chat, media, knowledge, scheduler
    pub source_id: Option<String>,
    pub task_id: Option<String>,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub decision_type: ReviewDecisionType, // approve, choose, edit, confirm_risk, resolve_conflict
    pub priority: ReviewPriority,
    pub status: ReviewDocketStatus, // pending, approved, rejected, changes_requested, skipped, expired
    pub risk_level: ReviewRiskLevel,
    pub proposed_action: Value,
    pub evidence_refs: Vec<ReviewEvidenceRef>,
    pub artifact_refs: Vec<String>,
    pub options: Vec<ReviewOption>,
    pub created_by_agent_id: Option<String>,
    pub assigned_to_user_id: Option<String>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct ReviewDecisionRecord {
    pub id: String,
    pub docket_id: String,
    pub decision: ReviewDecision,
    pub comment: Option<String>,
    pub selected_option_id: Option<String>,
    pub patch: Option<Value>,
    pub decided_at: i64,
}
```

Required commands:

```text
review:dockets:list
review:dockets:get
review:dockets:create
review:dockets:decide
review:dockets:skip
review:dockets:archive
review:dockets:stats
```

Required agent tools:

```text
review.request
review.attach_evidence
review.update
review.cancel
review.await_decision
```

Runtime behavior:

```text
Agent reaches a human-decision boundary
-> creates ReviewDocket
-> linked task moves to waiting_for_review
-> Workboard 御批台 shows one docket page
-> user approves / rejects / requests changes / edits parameters
-> ReviewDecision is persisted
-> linked task resumes, retries or closes
```

Good first docket sources:

- RedClaw completion claim: AI says a task is done and submits evidence.
- Media timeline mutation: AI wants to apply a video edit plan.
- Cover selection: AI presents candidate covers and asks user to choose.
- Scheduler policy: AI wants to create or modify an automated task.
- Knowledge operation: AI wants to merge, delete or rewrite knowledge records.

UI shape:

```text
Top:    pending progress, source, risk, linked task
Body:   summary, proposed action, evidence, artifact preview/diff
Bottom: approve, reject, request changes, skip
Side:   minimal queue rail, no full inbox clutter
```

Use existing components:

- Workboard shell.
- Artifact preview overlays where available.
- Runtime event stream.
- Existing notification badge only as a pointer into Workboard.

Must self-build:

- `ReviewDocketRecord` persistence.
- Decision state machine.
- Task pause/resume integration.
- Evidence schema for media, RedClaw, knowledge and team tasks.
- One-page review UI.

Do not implement as:

- A generic notification list.
- A chat message type only.
- A passive activity feed.
- A second task system separate from `TeamTaskRecord`.

## 5. Options And Recommendation

| Option | Description | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| A | Copy Multica server/web/daemon into RedConvert | Fast to inspect, complete reference | Architecture mismatch, Go/Postgres/Next dependency, duplicates existing Tauri runtime | Reject |
| B | Keep current RedConvert collab and only polish UI | Smallest change | Does not solve canonical task state, recovery, group chat/task split | Reject |
| C | Port Multica model into RedConvert AppStore/runtime | Fits local desktop, reuses current runtime and UI | Requires disciplined Rust/TS implementation | Choose |
| D | Hybrid local + remote Multica-compatible server later | Enables team sync/cloud | Too large for current local-first product | Later |

Recommendation: choose Option C now, design Option D compatibility through typed task/event schemas.

## 6. Performance Strategy

### 6.1 Backend/Tauri

- Never hold `AppStore` locks while running LLM calls, FFmpeg, filesystem scans, embeddings or render operations.
- Use append-only event records for high-frequency task messages; compact snapshots lazily.
- Keep task claim indexes in memory:
  - queued by priority/time
  - active by assignee
  - active by chat/session
- Lease every running task and heartbeat at fixed intervals.
- Recover expired `dispatched/running` tasks on app startup.
- Cap concurrent executor threads per member and globally.
- Store large transcripts/artifacts in files; keep AppStore rows as metadata pointers.

### 6.2 Renderer

- Use stale-while-revalidate snapshots for Team, Workboard and Chat.
- Do not clear full pages to loading on refresh failure.
- Debounce event-driven snapshot reloads per session/task.
- Virtualize long chat transcripts and execution logs.
- Keep execution transcript collapsed by default.
- Optimistically append user messages and queued task status, then reconcile with host state.

### 6.3 AI Runtime

- Retrieve task context by ID instead of stuffing full project history into every prompt.
- Use typed context bundles for media/project assets.
- Pin resume pointers as soon as a backend session is known.
- Classify failures into retryable and terminal categories.
- Guard agent-to-agent loops: agents reply only on explicit event triggers.

### 6.4 Video

- Precompute proxy media, thumbnails and waveforms.
- Run FFmpeg/render work in bounded background jobs.
- Use content hashes for media cache keys.
- Avoid re-rendering unchanged timeline segments.
- Keep render progress as task messages, not chat spam.

## 7. Migration Sequence

This should be implemented in atomic commits, each doing one thing. The migration goal is not to create a grand new team framework. The goal is to collapse scattered collaboration behavior into a few durable primitives.

### Phase 0: Simplification Pass

Goal: explicitly stop expanding the current heavy team implementation.

Actions:

1. Mark the old rigid collaboration concepts as compatibility-only in docs/comments:
   - fixed leader/member runtime split
   - speaker/executor separation
   - manual report tick workflow as the main model
2. Keep existing `teamRuntime` IPC names working for UI compatibility.
3. Route new behavior through canonical task/review records.
4. Avoid adding new visible controls to `Team.tsx`.

Acceptance:

- Existing Team and Workboard screens still open.
- No new runtime execution path is added before canonical task records exist.

### Phase 1: Canonical Work Item

Goal: create the smallest task object that can power chat, Workboard, RedClaw and media.

Atomic commits:

1. Add `TeamTaskRecord` types and AppStore persistence helpers.
2. Add list/get/create/update commands.
3. Add lifecycle transitions:
   - `queued`
   - `claimed`
   - `running`
   - `waiting_for_review`
   - `completed`
   - `failed`
   - `cancelled`
4. Add runtime events for task changed/message appended.
5. Add tests for:
   - invalid transition rejected
   - task update preserves unrelated fields
   - refresh/list returns stale data on read failure where possible

Acceptance:

- A task can be created and moved through lifecycle without running AI.
- `CollaborationBoard` can still load existing sessions.

### Phase 2: Workboard Projection

Goal: make Workboard read the canonical task object before adding more UI.

Atomic commits:

1. Make `CollaborationBoard` consume canonical task snapshots.
2. Keep the current layout but simplify task cards:
   - title
   - owner avatar/name
   - status
   - artifact count
   - review badge
3. Move detailed reports/transcripts into an on-demand inspector.
4. Remove duplicate local derivations that can come from task status.

Acceptance:

- Refreshing Workboard preserves last successful task data.
- Task cards do not require separate report records to display basic progress.

### Phase 3: Review Docket MVP

Goal: build the approval desk before deeper automation.

Atomic commits:

1. Done: Add `ReviewDocketRecord` and `ReviewDecisionRecord` persistence.
2. Done: Add commands:
   - `review:dockets:list`
   - `review:dockets:get`
   - `review:dockets:create`
   - `review:dockets:decide`
   - `review:dockets:skip`
   - `review:dockets:archive`
   - `review:dockets:stats`
3. Done: Add task integration:
   - creating a docket can move linked task to `waiting_for_review`
   - deciding a docket can resume, reject or complete linked task
   - Team Workboard tasks can be sent to `御批台`
4. Done: Add Workboard `御批台` view:
   - one docket page at a time
   - approve / reject / request changes / skip
   - compact queue progress
5. Done: Add a global navigation badge only if there are pending dockets; clicking Workboard with pending approvals opens `御批台`.

Acceptance:

- A task can pause on review and resume only after a structured decision.
- The UI does not look like a notification inbox.

### Phase 4: Thin Agent Hub

Goal: provide enough identity/capability context for AI to choose collaborators.

Atomic commits:

1. Extend `AgentBackendDescriptor` into lightweight `AgentRecord`.
2. Map existing advisors to optional executable agents.
3. Add `agent_hub:list` and `agent_hub:health` commands.
4. Display only minimal member status in Team:
   - idle
   - working
   - waiting for review
   - blocked
   - offline

Acceptance:

- AI can query available agents and capabilities.
- User does not need to configure a complex org chart.

### Phase 5: Chat Creates Work

Goal: make group chat task-aware without turning it into a task board.

Atomic commits:

1. Link `chatrooms:send` to optional `TeamTaskRecord` creation.
2. Add `linkedTaskId` to chat messages.
3. Render task-linked replies compactly in chat.
4. Keep all real state in task/review records.

Acceptance:

- Chat can start work.
- Workboard can show the same work without copying state.
- Chat remains mostly a communication surface.

### Phase 6: Minimal AI Protocol

Goal: give AI a small, stable protocol and let it reason.

Atomic commits:

1. Add tool descriptors for:
   - `team.context.get`
   - `team.agent.list`
   - `team.task.create/update/complete/fail`
   - `team.artifact.attach`
   - `review.request/await_decision`
2. Add prompt overlay explaining the protocol.
3. Remove prompt language that forces committee behavior.
4. Add loop guard:
   - no task creation without concrete objective
   - no review request without decision type
   - no agent-to-agent acknowledgement loops

Acceptance:

- A single smart agent can run the full workflow.
- Multiple agents are optional, not mandatory.

### Phase 7: RedClaw And Media Adoption

Goal: connect valuable product workflows after the substrate is proven.

Atomic commits:

1. Partially done: RedClaw non-manual task drafts create review dockets.
   - approving the docket confirms the draft through the existing task-control path
   - rejecting the docket cancels the draft
   - completion-claim review still needs scheduler pause/resume semantics before enabling
2. Partially done: Sub-agent completion claims create review dockets.
   - completion reports move linked collaboration tasks to `waiting_for_review`
   - approving the docket completes the linked task
   - RedClaw scheduled-run completion review still needs a scheduler-level pause/resume policy
3. RedClaw planned steps become canonical tasks.
4. Media task schemas are added:
   - `media.ingest`
   - `media.transcribe`
   - `video.auto_edit`
   - `video.timeline_apply`
   - `video.render`
5. Timeline mutations and render/export decisions require review dockets.
6. Artifacts link to tasks and dockets.

Acceptance:

- A RedClaw run can produce work, ask for approval and resume.
- A media edit plan can be reviewed before mutating the timeline.

### Phase 8: Reliability

Goal: add Multica-style durability only after core behavior exists.

Atomic commits:

1. Add leases and heartbeats.
2. Add retry/attempt/parent task tracking.
3. Add resume pointer persistence.
4. Add startup recovery for stale running tasks.
5. Add diagnostics summary for task -> docket -> decision -> resume chains.

Acceptance:

- App restart does not lose pending tasks or pending approvals.
- Stale running tasks recover into failed/retryable states.

## 8. Non-Negotiable Boundaries

- Do not add a separate Go service.
- Do not introduce PostgreSQL just for local collaboration.
- Do not split chat tasks, board tasks and RedClaw tasks into separate state machines.
- Do not route by hard-coded user-message keywords.
- Do not create UI text explaining every concept; make the interaction obvious.
- Do not spawn runtime work before the canonical task record exists.
- Do not let agent-to-agent acknowledgements re-trigger infinite loops.
- Do not implement human approval as a passive inbox or notification feed.
- Do not resume a task waiting for review until a structured `ReviewDecisionRecord` exists.
- Do not build a rigid simulated company inside the app; agent roles are hints, not required runtime classes.
- Do not require multiple agents when one capable AI can complete the work.
- Do not create a subtask unless it improves parallelism, reviewability or recovery.

## 9. Immediate Next Implementation Target

The best first code change is:

```text
Canonical TeamTaskRecord + lifecycle command layer
```

Why:

- It unlocks group chat, task panel and media workflows at once.
- It is smaller than redesigning all UI.
- It gives the rest of the system a stable product object to project from.
- It directly applies the most valuable Multica lesson: one task queue, many surfaces.

The best second code change is:

```text
ReviewDocketRecord + Workboard 御批台 MVP
```

Why:

- It turns autonomous AI work into an approval-first product loop.
- It keeps humans in the highest-leverage role: reviewing, deciding and redirecting.
- It prevents chat from becoming the place where important approvals disappear.
- It gives RedClaw, team tasks and media workflows one shared human decision gate.
