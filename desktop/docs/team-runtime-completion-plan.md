---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-09
owner: ai-runtime
scope:
  - desktop/src-tauri/src/runtime/collab_runtime.rs
  - desktop/src-tauri/src/subagents
  - desktop/src-tauri/src/mcp/team_server.rs
  - desktop/src-tauri/src/tools/app_cli.rs
  - desktop/src-tauri/src/tools/catalog.rs
  - desktop/src-tauri/src/commands/runtime_collab.rs
  - desktop/src-tauri/src/interactive_runtime_shared.rs
  - desktop/prompts/library/runtime
  - desktop/src/pages/RedClaw.tsx
  - desktop/src/pages/workboard/CollaborationBoard.tsx
  - desktop/src/bridge/ipcRenderer.ts
related_docs:
  - desktop/docs/collaboration-runtime.md
  - desktop/docs/acp-team-workboard-collaboration-plan.md
  - desktop/docs/team-groupchat-runtime-plan.md
  - desktop/docs/redclaw-team-split-architecture-plan.md
success_metrics:
  - mailbox_message_delivery_is_durable_before_wake = true
  - member_wake_after_unread_message = true
  - member_runtime_stream_events_update_member_status = true
  - settled_non_leader_members_wake_leader_once = true
  - task_completion_requires_structured_report_or_artifact = true
  - redclaw_team_split_uses_live_member_sessions = true
  - stale_member_timeout_creates_blocker_report = true
  - team_mcp_tools_cover_member_mailbox_task_report_lifecycle = true
---

# Team Runtime Completion Plan

## 1. Conclusion

RedConvert already has a real collaboration baseline: durable collaboration sessions, members, tasks, mailbox messages, progress reports, Workboard UI, `team-runtime:*` IPC, `app_cli` team actions, and a `redbox-team` MCP contract.

The missing piece is not another board or a horizontal split UI. The missing piece is a host-owned `TeammateManager` equivalent:

```text
Mailbox write
-> durable task/message state
-> wake the target member runtime
-> track member runtime stream lifecycle
-> update member status and heartbeat
-> submit structured report/artifact/blocker
-> wake leader only when non-leader members are settled
```

Until this exists, RedClaw can render multiple lanes, but the lanes will mostly be a view over records. After this exists, each lane can represent a real teammate with an owned runtime, mailbox, task state, reporting contract, and failure boundary.

## 2. Current Baseline

### Implemented

- `desktop/src-tauri/src/subagents/mailbox.rs` wraps durable mailbox send, read, history, report request, and cleanup.
- `desktop/src-tauri/src/subagents/team_task_board.rs` wraps task create, update, list, and move.
- `desktop/src-tauri/src/runtime/collab_runtime.rs` stores collaboration sessions, members, tasks, reports, artifacts, blockers, dependency links, capacity checks, and member task-plan metadata.
- `desktop/src-tauri/src/subagents/wake_runtime.rs` can request reports on a tick, create stale blocker reports, and detect whether non-leader members are settled.
- `desktop/src-tauri/src/subagents/spawner.rs` can link spawned child runtime sessions back to collaboration members with `conversationId`, `runtimeId`, and `collabMemberId` metadata.
- `desktop/src-tauri/src/subagents/team_tools.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, and `desktop/src-tauri/src/tools/catalog.rs` expose model-visible team actions.
- `desktop/src-tauri/src/mcp/team_server.rs` exposes structured team MCP tools for members, messages, tasks, reports, artifacts, and blockers.
- `desktop/src-tauri/src/commands/runtime_collab.rs` exposes `team-runtime:*` IPC and emits `runtime:collab-*` events.
- `desktop/src/bridge/ipcRenderer.ts` exposes `window.ipcRenderer.teamRuntime`.
- `desktop/src/pages/workboard/CollaborationBoard.tsx` renders the current board-shaped collaboration UI.

### Not Complete

- No long-lived `TeamSessionService` that owns active team sessions after app startup and repairs missing runtime links.
- No `TeammateManager` that owns member wake locks, running member turns, owned stream subscriptions, idle/failure transitions, and leader wake decisions.
- No mailbox-to-runtime dispatch path. A durable message can be written, but the target member is not automatically woken as a live teammate.
- No dedicated teammate prompts separating leader, speaker persona, and executor behavior.
- No Team MCP mailbox read tool for member runtimes in the MCP contract. Host actions can read mailbox, but the MCP surface does not yet cover the full teammate loop.
- No RedClaw-bound team session lifecycle. RedClaw can later show lanes, but the current runtime does not guarantee that those lanes map to live member conversations.
- No full completion gate that requires evidence, artifact refs, or verifier acceptance before a member or leader can mark work complete.

## 3. Target Product Architecture

```text
RedClaw / Workboard UI
  -> teamRuntime bridge
  -> runtime_collab IPC
  -> TeamSessionService
      -> TeamSessionController
          -> Mailbox
          -> TaskManager
          -> TeammateManager
          -> TeamMcpServer
          -> TeamVerifier
          -> TeamEventIndex
  -> existing internal runtime / child runtime / tools / approvals
```

The host owns the collaboration state machine. Agents can propose, report, and execute through tools, but they do not own lifecycle correctness.

### Session Boundary

Use existing `CollabSessionRecord` as the durable root. Add missing semantics through `metadata` first, then promote to typed fields only when the shape stabilizes.

Required metadata:

```json
{
  "teamKind": "live_teammates",
  "ownerSurface": "redclaw",
  "ownerSessionId": "session-...",
  "leaderMemberId": "collab-member-...",
  "scheduler": {
    "maxActiveMembers": 4,
    "maxActiveExecutorsGlobal": 8,
    "wakeRetryLimit": 2,
    "reportIntervalMs": 900000,
    "heartbeatTimeoutMs": 1200000,
    "leaderWakeDebounceMs": 1500
  }
}
```

### Member Boundary

One logical member has one visible identity, but two runtime faces:

```text
TeamMember
  -> Speaker persona: talks in team lane and submits reports
  -> Executor runtime: does work with tools and evidence
```

Start with one child runtime per member. Do not create separate communication/execution runtimes; use explicit `turnMode=speak|execute` and shared member state instead. The contract must still distinguish speaking from working so the UI and prompts do not collapse into generic chat.

Member metadata should include:

```json
{
  "agentCard": {
    "role": "researcher",
    "capabilities": ["research", "summarize"],
    "allowedTools": ["app_cli", "redbox_fs", "bash"],
    "capacity": {
      "maxExecutorThreads": 2
    }
  },
  "runtimeBinding": {
    "conversationId": "session-...",
    "runtimeId": "runtime-...",
    "status": "idle",
    "lastWakeAt": 1777178200000,
    "lastSettledAt": 1777178300000
  },
  "memberTaskPlan": {
    "activeExecutors": [],
    "tasks": [],
    "speechQueue": []
  }
}
```

### Communication Rule

All member-to-member and user-to-member messages go through mailbox first:

```text
write mailbox message
-> emit runtime:collab-message-delivered
-> enqueue wake request
-> wake member runtime best-effort
```

Wake failure must not roll back the message. The member can be retried or repaired later because the message is already durable.

## 4. Modules To Implement

### 4.1 `TeamSessionService`

Create `desktop/src-tauri/src/subagents/team_session_service.rs`.

Responsibilities:

- Load active `CollabSessionRecord` entries on app startup.
- Build an in-memory controller map keyed by `collabSessionId`.
- Repair member runtime bindings when `conversationId` or `runtimeId` exists but the active runtime map is missing.
- Expose `ensure_team_controller(session_id)` for IPC, RedClaw, scheduler, and app_cli paths.
- Keep only narrow in-memory locks. Store writes still go through existing `with_store_mut` patterns.

Do not create a new database. Use existing AppStore records first.

### 4.2 `TeamSessionController`

Create `desktop/src-tauri/src/subagents/team_session_controller.rs`.

Responsibilities:

- Own one logical team session.
- Compose mailbox, task manager, teammate manager, verifier, and MCP routing.
- Provide high-level host actions:
  - `deliver_user_message_to_member`
  - `deliver_member_message`
  - `assign_task_and_wake`
  - `submit_member_report`
  - `settle_member_turn`
  - `wake_leader_if_ready`
- Emit `runtime:collab-*` events after every durable state change.

This should be orchestration code only. It must not directly perform AI model calls or tool execution.

### 4.3 `TeammateManager`

Create `desktop/src-tauri/src/subagents/teammate_manager.rs`.

Responsibilities:

- Maintain in-memory wake leases:
  - `sessionId`
  - `memberId`
  - `runtimeId`
  - `wakeReason`
  - `startedAt`
  - `lastEventAt`
  - `status`
- Wake a member when:
  - unread mailbox message arrives;
  - task is assigned or changed;
  - report request arrives;
  - stale recovery retry is due;
  - user directly messages that member.
- Listen only to stream events for owned `runtimeId` / `conversationId`.
- Mark member `active` when a wake starts.
- Mark member `idle`, `blocked`, `failed`, or `completed` when the child runtime finishes or times out.
- Submit an idle notification or blocker report to the leader.
- Wake the leader once all non-leader members are settled.

Settled statuses:

```text
idle | completed | failed | pending | blocked | offline | suspended
```

Non-settled statuses:

```text
queued | active | running | working | reviewing
```

Use existing `wake_runtime.rs` as a helper for report tick logic, but move lifecycle ownership into `TeammateManager`.

### 4.4 Mailbox Completion

Extend existing mailbox behavior instead of replacing it.

Required additions:

- Add a host action `team.message.deliver` that writes a mailbox message and queues a wake in one host-owned path.
- Add `team.message.read` to the `redbox-team` MCP contract so a member runtime can read its unread messages through structured MCP.
- Add message delivery attempts to message metadata:

```json
{
  "delivery": {
    "wakeStatus": "queued | dispatched | failed",
    "attempts": 1,
    "lastAttemptAt": 1777178200000,
    "lastError": null
  }
}
```

Do not use raw chat transcript scanning as the mailbox source of truth.

### 4.5 TaskManager Completion

Keep `team_task_board.rs` as the storage wrapper, but add a policy layer in `team_task_manager.rs`.

Responsibilities:

- Assign tasks only to existing members in the same session.
- Prevent reviewer from being the same member as owner.
- Enforce dependency readiness before wake.
- Convert `claimed_completed` into `review` or `completed` only after verifier acceptance.
- Generate mailbox assignment messages when a task becomes runnable.
- Maintain task-to-member speech queue entries.

Task status model:

```text
todo
queued_for_member
ready
running
blocked
claimed_completed
review
completed
failed
cancelled
```

Existing statuses can be mapped for compatibility, but new runtime logic should use this canonical set internally.

### 4.6 Team Verifier

Create `desktop/src-tauri/src/subagents/team_verifier.rs`.

Responsibilities:

- Validate completion reports contain at least one of:
  - artifact refs;
  - tool result refs;
  - task summary with explicit evidence;
  - verifier-approved note for non-artifact tasks.
- Check local artifact paths exist when the artifact type is file-like.
- Reject completion if the report is only a generic success sentence.
- Reject group-level completion from non-leader members.
- Create repair task or blocker report when verification fails.

This is self-built logic. Do not use an LLM for the first verification gate. LLM review can be a later reviewer task, but schema and artifact existence checks must be deterministic.

### 4.7 Team MCP Tools

Keep tools small, structured, and composable.

Add or complete these MCP tools:

- `team_read_mailbox`
- `team_spawn_agent`
- `team_update_member_status`
- `team_submit_artifact`
- `team_mark_turn_complete`
- `team_get_current_context`

Existing tools to keep:

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

Do not add a broad `team_do_everything` tool. Each tool maps to one host action and returns structured JSON.

### 4.8 Prompts And AI Roles

Create prompt files:

- `desktop/prompts/library/runtime/team/leader.txt`
- `desktop/prompts/library/runtime/team/teammate.txt`
- `desktop/prompts/library/runtime/team/verifier.txt`

Leader rules:

- Decompose work into task records before asking members to execute.
- Use `team_send_message` and task tools, not prose-only delegation.
- Do not do specialist work directly when a member is assigned.
- Wake or request reports only through structured tools.
- Declare project completion only after member outputs pass verification.

Teammate rules:

- Read mailbox at the start of a turn.
- Claim assigned task before execution.
- End the turn while waiting for another member; do not keep a model call open.
- Submit progress, blocker, artifact, and completion reports through tools.
- Do not claim group-level completion.

Verifier rules:

- Check evidence and artifact refs.
- Reject vague completion.
- Produce repair tasks when needed.

### 4.9 RedClaw Integration

RedClaw should use the team system, not fork it.

Add:

- `desktop/src/pages/redclaw/team/useRedClawTeamSession.ts`
- `desktop/src/pages/redclaw/team/RedClawTeamSplit.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamLane.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamComposer.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamReportFeed.tsx`

Rules:

- Bind the team session to the active RedClaw session through `ownerSessionId`.
- Show one horizontal lane per live member.
- User messages to the leader or a member call mailbox delivery, not direct transcript append.
- Lanes show latest task, status, reports, mailbox messages, blockers, and artifacts.
- Use stale-while-revalidate: never blank the full page while refreshing.
- Do not globally change `Chat` or `MessageItem` for this mode.

Recommended library usage:

- Use existing React, Tailwind, Radix primitives, lucide icons, and `react-resizable-panels` if a resizable preview/report area is needed.
- Do not add a virtualized list library for the first pass. Use bounded mailbox/report limits and memoized lane components first.

### 4.10 Workboard Integration

Keep Workboard as the operational board:

- Add wake/status badges from `runtimeBinding`.
- Add "wake member", "request report", "mark suspended", and "open lane in RedClaw" actions.
- Add inline blocker and artifact evidence display.
- Add filtered event feed by member/task.

Workboard remains the dense management surface. RedClaw team split is the live collaboration surface.

### 4.11 Media And Video Task Boundary

Team runtime should not implement video processing itself.

Use existing product paths:

- Manuscript/video planning and Remotion scene generation stay in `manuscripts:*` and the `video-editor` runtime profile.
- Rendering stays on existing Remotion and FFmpeg-backed paths.
- Media library operations stay in `media:*` IPC.
- Team tasks reference video artifacts by structured refs:

```json
{
  "type": "video_project",
  "manuscriptId": "manuscript-...",
  "packageId": "package-...",
  "remotionScenePath": ".../remotion.scene.json",
  "renderOutputPath": ".../output.mp4"
}
```

What must use existing libraries:

- Remotion for composition/render pipeline.
- FFmpeg or existing CLI runtime detection for encode/transcode helpers.
- Existing media library storage and asset binding.

What is self-built:

- Team task assignment.
- Team artifact refs and verification.
- RedClaw team lane UI.
- Runtime wake lifecycle and leader/member policies.

## 5. Execution Plan

This should be delivered as one complete feature batch, but implemented in atomic commits. Each commit should be one coherent slice and leave the app buildable.

### Commit 1: Team Lifecycle Store And Service

Files:

- `desktop/src-tauri/src/subagents/team_session_service.rs`
- `desktop/src-tauri/src/subagents/team_session_controller.rs`
- `desktop/src-tauri/src/subagents/mod.rs`
- `desktop/src-tauri/src/runtime/collab_runtime.rs`
- tests near the new modules

Deliverables:

- Active team session registry.
- Startup repair helper.
- Controller lookup by session id.
- No UI change.

Verification:

- Rust unit tests for loading active sessions and repairing member runtime bindings.

### Commit 2: TeammateManager Wake Lifecycle

Files:

- `desktop/src-tauri/src/subagents/teammate_manager.rs`
- `desktop/src-tauri/src/subagents/wake_runtime.rs`
- `desktop/src-tauri/src/commands/runtime_collab.rs`
- `desktop/src-tauri/src/runtime/events.rs`

Deliverables:

- Wake leases.
- Mailbox/task/report wake reasons.
- Member active/idle/failed transitions.
- Leader wake once when all non-leader members settle.

Verification:

- Unit tests for wake dedupe, timeout, failure report, and leader wake debounce.
- One manual team session with two members where one member completion wakes leader once.

### Commit 3: Mailbox + TaskManager Policy Completion

Files:

- `desktop/src-tauri/src/subagents/mailbox.rs`
- `desktop/src-tauri/src/subagents/team_task_board.rs`
- `desktop/src-tauri/src/subagents/team_task_manager.rs`
- `desktop/src-tauri/src/runtime/collab_runtime.rs`

Deliverables:

- Deliver-and-wake path.
- Task readiness and dependency gate.
- Completion status policy.
- Delivery metadata.

Verification:

- Unit tests for durable mailbox before wake, dependency-held task, and claimed completion.

### Commit 4: Team Verifier

Files:

- `desktop/src-tauri/src/subagents/team_verifier.rs`
- `desktop/src-tauri/src/subagents/team_tools.rs`
- `desktop/src-tauri/src/runtime/collab_runtime.rs`

Deliverables:

- Deterministic completion validation.
- Artifact existence checks for file refs.
- Repair task/blocker on failed verification.

Verification:

- Unit tests for vague success rejection, missing artifact rejection, and valid artifact acceptance.

### Commit 5: MCP/App CLI Tool Surface

Files:

- `desktop/src-tauri/src/mcp/team_server.rs`
- `desktop/src-tauri/src/tools/app_cli.rs`
- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/interactive_runtime_shared.rs`

Deliverables:

- `team_read_mailbox`
- `team_spawn_agent`
- `team_update_member_status`
- `team_mark_turn_complete`
- `team_get_current_context`
- Updated coordinator prompt so models use the full loop.

Verification:

- Contract snapshot test for MCP tools.
- `app_cli` execution smoke for message -> read -> report -> turn complete.

### Commit 6: Team Prompts

Files:

- `desktop/prompts/library/runtime/team/leader.txt`
- `desktop/prompts/library/runtime/team/teammate.txt`
- `desktop/prompts/library/runtime/team/verifier.txt`
- prompt loader wiring

Deliverables:

- Separate leader, teammate, and verifier behavior.
- Speaker/executor communication rules.
- Completion and waiting rules.

Verification:

- Prompt loader unit test.
- One real runtime smoke where teammate reads mailbox and submits structured report.

### Commit 7: RedClaw Live Team Split

Files:

- `desktop/src/pages/RedClaw.tsx`
- `desktop/src/pages/redclaw/team/*`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/types.d.ts`

Deliverables:

- Horizontal member lanes.
- Leader lane.
- Member composer via mailbox delivery.
- Status/report/task/artifact feed.
- Stale-while-revalidate refresh.

Verification:

- Renderer build.
- Manual RedClaw session with at least leader + two members.
- Confirm messages wake members and status changes appear in lanes.

### Commit 8: Workboard Operational Controls

Files:

- `desktop/src/pages/workboard/CollaborationBoard.tsx`
- supporting workboard components if split out

Deliverables:

- Wake/status badges.
- Open in RedClaw lane.
- Member suspend/wake/report controls.
- Task evidence and blocker display.

Verification:

- Renderer build.
- Manual board refresh retains last successful snapshot.

### Commit 9: End-To-End Runtime Smoke

Files:

- smoke script or test harness under existing test location
- minimal docs update if needed

Deliverables:

- Create team session.
- Spawn leader and two members.
- Assign dependent tasks.
- Send member messages.
- Wake member.
- Submit progress and artifact.
- Complete one task.
- Wake leader once after members settle.

Verification:

- Rust tests.
- Frontend typecheck/build.
- One real renderer IPC flow.
- Runtime transcript and `~/Library/Application Support/RedBox/` evidence checked.

## 6. Alternatives

### Option A: UI-First Horizontal Split

Build RedClaw lanes on top of current `teamRuntime` records.

Pros:

- Fastest visible result.
- Low backend risk.

Cons:

- Lanes are mostly passive.
- Messages do not reliably wake members.
- No true member lifecycle.
- Easy to mistake UI for working collaboration.

Verdict: not recommended.

### Option B: External Agent/ACP First

Copy AionUi's external process model more directly.

Pros:

- Strong isolation if using external worker processes.
- Similar to AionUi mental model.

Cons:

- RedConvert already has internal runtime, tools, approvals, and session persistence.
- External process management adds packaging, permission, and crash complexity.
- It violates the current product rule that Workboard creates internal runtime members first.

Verdict: not recommended for this phase.

### Option C: Host-Owned Internal TeammateManager

Complete the missing host lifecycle layer and bind UI to it.

Pros:

- Reuses existing AppStore, child runtimes, event stream, app_cli, MCP tools, and Workboard.
- Makes RedClaw lanes real, not decorative.
- Keeps team state durable and inspectable.
- Avoids introducing external process orchestration before it is needed.

Cons:

- Requires careful runtime event ownership and wake dedupe.
- More backend work before the UI payoff.

Verdict: recommended.

## 7. Performance Strategy

Runtime:

- Store durable state first, wake after commit.
- Keep in-memory wake leases small and keyed by `sessionId/memberId/runtimeId`.
- Filter runtime stream events by owned runtime ids before touching team state.
- Debounce leader wake after member settlement.
- Cap active members per team and active executor threads per member.
- Never hold global store locks while waiting for model/runtime/tool execution.

Persistence:

- Keep mailbox and report retention already present.
- Add bounded event indexes by team session.
- Keep large transcripts in session bundles, not in collab records.
- Store artifact refs, not artifact payloads, in task/report records.

Renderer:

- Use stale-while-revalidate snapshots.
- Limit mailbox/report fetches per lane.
- Memoize lane components by member id and updated timestamp.
- Buffer high-frequency stream updates; RedClaw lanes should render status/report deltas, not every token.
- Use horizontal overflow controls and stable lane widths. Do not let content resize lanes.

AI:

- Require structured tools for task, mailbox, report, artifact, and completion.
- Avoid prompt-only coordination.
- Treat waiting as turn end.
- Use deterministic verifier gates before optional LLM review.

## 8. Acceptance Criteria

The feature is complete only when all of these are true:

- Creating a team session creates or repairs a leader member.
- Sending a mailbox message to a member wakes that member runtime or records a retryable wake failure.
- The member reads unread mailbox messages through a structured tool.
- The member can claim a task, submit progress, submit blocker, submit artifact, and mark turn complete.
- Member stream lifecycle updates `CollabMemberRecord.status`.
- A failed or silent member becomes a visible blocker/failure, not a disappeared lane.
- The leader wakes once when all non-leader members are settled.
- RedClaw team split shows live member lanes backed by real member records and runtime bindings.
- Workboard can inspect the same session, tasks, reports, artifacts, and blockers.
- Completion claims without evidence are rejected or turned into repair tasks.
- Tests cover mailbox delivery, wake lifecycle, task dependency readiness, verifier acceptance/rejection, and MCP contract shape.

## 9. Risks

- Event contamination: fixed by strict runtime id filtering in `TeammateManager`.
- Leader loops: fixed by settled-member rule plus debounce.
- False success: fixed by deterministic verifier before completion.
- UI over-refresh: fixed by bounded snapshots and event-triggered stale-while-revalidate.
- Store lock contention: fixed by snapshot-then-release runtime work; only final state application holds the store lock.
- Tool confusion: fixed by small MCP/app_cli tools and explicit prompts.

## 10. Recommended Next Action

Implement Option C as one complete feature batch, with the atomic commits listed above. Do backend lifecycle first, then RedClaw lanes. The horizontal UI should be the proof that the runtime is live, not the thing pretending the runtime is live.
