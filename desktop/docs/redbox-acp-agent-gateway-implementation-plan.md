---
doc_type: plan
execution_status: completed
last_updated: 2026-06-24
owner: ai-runtime
scope:
  - desktop/src-tauri/src/assistant_core.rs
  - desktop/src-tauri/src/acp_gateway/*
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/subagents/*
  - desktop/src-tauri/src/commands/runtime_collab.rs
  - desktop/src-tauri/src/store/types.rs
  - desktop/src-tauri/src/persistence/mod.rs
  - desktop/src/runtime/runtimeEventStream.ts
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/workboard/*
related_docs:
  - desktop/docs/collaboration-runtime.md
  - desktop/docs/team-runtime-completion-plan.md
  - desktop/docs/acp-team-workboard-collaboration-plan.md
  - desktop/docs/runtime-context-bundle.md
  - desktop/docs/runtime-agent-job-v1.md
  - desktop/docs/redbox-acp-agent-gateway-usage.md
success_metrics:
  - external_agent_can_discover_redbox_creator_agent
  - external_agent_can_read_how_to_talk_guide
  - external_message_is_durable_before_runtime_wake
  - acp_run_has_recoverable_status_and_event_stream
  - session_routing_supports_auto_create_and_explicit_attach
  - redbox_ui_shows_external_agent_session_without_refresh_blank
  - chat_list_shows_acp_sessions_with_external_agent_badge
  - creator_agent_returns_structured_artifact_refs
  - paid_or_destructive_actions_require_approval
  - acp_gateway_does_not_bypass_existing_runtime_tool_policy
---

# RedBox ACP Agent Gateway Implementation Plan

## 1. Decision

RedBox should first implement an ACP-style Agent Gateway, not a broad MCP tool surface.

The product goal is to let Codex, Hermes, OpenClaw, and similar general-purpose AI systems communicate with the AI inside RedBox as a specialized creator agent. The external agent should be able to create a session, send a task, watch progress, and receive RedBox artifacts. It should not need to know RedBox's internal database, page layout, or media job implementation.

Use ACP here to mean Agent Communication Protocol / A2A-style agent-to-agent communication. This is different from the editor-focused Agent Client Protocol. The implementation should stay transport-compatible with simple local HTTP first, while preserving a future path to A2A/ACP adapters.

MCP remains important, but it is the second layer:

1. ACP Agent Gateway: external agents talk to RedBox Creator Agent.
2. MCP tool surface: external agents directly call RedBox tools when the gateway contract is stable.
3. Deep automation: external agents delegate long-running production workflows to RedBox.

## 2. External References

- Agent Communication Protocol: open agent interoperability, async/sync communication, streaming interactions, stateful/stateless runs, discovery, and long-running tasks.
  - https://agentcommunicationprotocol.dev/introduction/welcome
- Agent Client Protocol: editor/IDE to coding-agent protocol. Useful for terminology, but not the primary product target here.
  - https://agentclientprotocol.com/get-started/introduction
- Codex currently exposes external tools primarily through MCP. Codex-native ACP support should not be assumed; if needed, use a thin adapter that translates Codex-accessible surfaces into the RedBox ACP Gateway.
  - https://developers.openai.com/codex/cli/features

## 3. Current RedBox Baseline

RedBox already has enough internal infrastructure to build this without inventing a parallel runtime:

- `assistant_core.rs` already owns a local HTTP listener on `127.0.0.1:31937`.
- `CollabSessionRecord`, `CollabMemberRecord`, `CollabTaskRecord`, `CollabMailboxMessageRecord`, and `CollabProgressReportRecord` already model durable collaboration state.
- `team-runtime:*` IPC already exposes collaboration sessions, tasks, mailbox, reports, and team events.
- `runtime:collab-*` events already project collaboration changes to the renderer.
- `subagents/mailbox.rs`, `team_task_board.rs`, `wake_runtime.rs`, and `spawner.rs` already cover pieces of durable mail, task board state, report ticks, and child runtime binding.
- `desktop/src-tauri/src/mcp/team_server.rs` already defines a structured team contract, but external process spawning is intentionally not productized yet.

The missing pieces are:

- A public local ACP endpoint family.
- Agent manifest and discovery.
- External client identity, token, capability grants, and audit log.
- ACP session/run records mapped to existing collaboration/runtime state.
- Mailbox-to-runtime dispatch for RedBox Creator Agent.
- Streamable run events and structured artifact references.
- Settings UI for Agent Gateway status and access control.
- A small adapter story for external tools that do not speak ACP directly.

## 4. Product Contract

### 4.1 RedBox Creator Agent

The externally visible agent should be narrow and domain-specific.

Name: `RedBox Creator Agent`

Positioning:

> A local creator asset and production agent for social media workflows. It can use RedBox's local materials, knowledge, manuscripts, media jobs, covers, subjects, and project context to plan and produce creator content.

Initial capabilities:

- `creator_asset_context`: understand RedBox materials and project references.
- `topic_briefing`: create a content brief from local material, comments, or user intent.
- `manuscript_planning`: plan text, short video, audio, and carousel manuscripts.
- `cover_planning`: plan or request cover work without directly exposing all cover tools.
- `media_job_planning`: plan media work and create pending jobs when approved.
- `project_packaging`: create or update a RedBox project/package reference.

P0 output should focus on:

- brief
- task plan
- manuscript outline
- selected local references
- RedBox artifact refs
- approval request if a risky or paid action is needed

P0 should not promise autonomous video production through ACP. Media generation can be represented as a pending task or artifact ref until the media job runtime is wired into the gateway.

### 4.2 User-Facing Flow

Minimum happy path:

1. User enables Agent Gateway in Settings.
2. External agent discovers RedBox Creator Agent through a local manifest.
3. External agent creates an ACP session with a goal.
4. RedBox writes the incoming message to durable mailbox.
5. RedBox wakes Creator Agent runtime.
6. RedBox UI shows the external-agent conversation in the normal conversation list, with a visible external-agent source badge.
7. Creator Agent produces a brief or plan.
8. Gateway streams progress events and returns artifact refs.
9. External agent can continue the same session.

## 5. Non Goals

- Do not build a generic chat proxy over RedBox.
- Do not expose the full internal tool catalog through ACP P0.
- Do not let external agents directly read or write `AppStore`.
- Do not make external agents call Tauri IPC.
- Do not add a second local HTTP port unless the current assistant listener cannot support the required response mode.
- Do not implement full remote public networking in P0.
- Do not assume Codex, Hermes, or OpenClaw all speak the same ACP dialect.
- Do not introduce an external process manager before the host-owned collaboration loop is stable.

## 6. Architecture

```text
External Agent
  -> RedBox ACP Gateway
      -> local HTTP route in assistant_core
      -> auth / capability policy
      -> ACP session store
      -> durable mailbox
      -> Creator Agent runtime bridge
      -> runtime events + artifact registry
  -> External Agent receives status/events/artifacts

RedBox UI
  -> Settings Agent Gateway panel
  -> Chat conversation list with ACP source badges
  -> Chat / RedClaw deep links
```

Host-owned invariant:

```text
external message
  -> validate client and capability
  -> persist ACP session/run/message
  -> persist collab mailbox message
  -> emit delivered event
  -> wake runtime best-effort
```

Wake failure must not roll back message delivery.

## 7. New Module Map

Add a focused host module:

```text
desktop/src-tauri/src/acp_gateway/
  mod.rs
  types.rs
  manifest.rs
  guide.rs
  auth.rs
  http.rs
  sessions.rs
  runs.rs
  messages.rs
  events.rs
  artifacts.rs
  runtime_bridge.rs
  audit.rs
  errors.rs
```

Responsibilities:

| Module | Responsibility | Must Use | Must Build |
| --- | --- | --- | --- |
| `manifest.rs` | Agent card / capability discovery | serde JSON | RedBox Creator Agent manifest |
| `guide.rs` | LLM-readable connection instructions | Markdown string template | Codex/Hermes/OpenClaw/generic guidance |
| `auth.rs` | local client tokens and grants | existing settings store, constant-time token compare if available | client records, capability checks |
| `http.rs` | route matching and response helpers | existing `assistant_core` HTTP parser/response helpers | ACP route dispatch, method validation |
| `sessions.rs` | ACP session lifecycle | existing `CollabSessionRecord` where possible | ACP session mapping and snapshots |
| `messages.rs` | inbound/outbound messages | `CollabMailboxMessageRecord` | ACP message normalization |
| `runs.rs` | run lifecycle | runtime events, collab reports | run status state machine |
| `events.rs` | run event projection | `runtime:event` | bounded event query and optional SSE |
| `artifacts.rs` | artifact refs | session resources, collab artifacts | `redbox://...` ref registry |
| `runtime_bridge.rs` | wake Creator Agent | existing session runtime/subagent bridge | mailbox-to-runtime dispatch |
| `audit.rs` | external call audit | AppStore persistence | append-only audit records |
| `errors.rs` | protocol errors | serde | stable error codes |

Extend existing files:

- `assistant_core.rs`: dispatch `/acp/v1/*` routes before generic assistant webhook routes.
- `store/types.rs`: add ACP settings, client, session, run, message/audit records.
- `persistence/mod.rs`: default ACP records and backward-compatible load.
- `commands/runtime_collab.rs`: add helper actions if Workboard needs ACP session snapshots through `team-runtime:*`.
- `runtime/events.rs`: add ACP event categories or projection helpers.
- `desktop/src/bridge/ipcRenderer.ts`: expose settings/status methods only if UI needs them.
- `Settings.tsx` or settings sections: add low-noise Agent Gateway controls.
- Workboard/Collaboration UI: show external source, run status, and artifact links.

## 8. Protocol Surface

### 8.1 Routes

P0 local HTTP routes:

```text
GET  /acp/v1/manifest
GET  /.well-known/redbox-agent.json
GET  /acp/v1/guide
POST /acp/v1/sessions
GET  /acp/v1/sessions/{session_id}
POST /acp/v1/sessions/{session_id}/messages
POST /acp/v1/runs
GET  /acp/v1/runs/{run_id}
GET  /acp/v1/runs/{run_id}/events
POST /acp/v1/runs/{run_id}/cancel
GET  /acp/v1/artifacts/{artifact_id}
```

P1 routes:

```text
POST /acp/v1/sessions/{session_id}/resume
POST /acp/v1/runs/{run_id}/approval
GET  /acp/v1/sessions/{session_id}/artifacts
GET  /acp/v1/clients/current
```

All P0 routes are local-only by default. Remote binding must remain disabled until explicit user configuration exists.

### 8.2 Manifest

Example:

```json
{
  "schemaVersion": "redbox.acp.v1",
  "agent": {
    "id": "redbox.creator",
    "name": "RedBox Creator Agent",
    "description": "Local creator asset and production agent for social media workflows.",
    "version": "0.1.0"
  },
  "capabilities": [
    "creator_asset_context",
    "topic_briefing",
    "manuscript_planning",
    "cover_planning",
    "media_job_planning",
    "project_packaging"
  ],
  "inputModes": ["text", "url", "file_ref", "asset_ref", "project_ref"],
  "outputModes": ["markdown", "artifact_ref", "project_ref", "job_ref"],
  "howToTalk": {
    "guide": "/acp/v1/guide",
    "createSession": "POST /acp/v1/sessions",
    "sendMessage": "POST /acp/v1/sessions/{session_id}/messages",
    "startRun": "POST /acp/v1/runs",
    "pollEvents": "GET /acp/v1/runs/{run_id}/events",
    "continueSession": "Reuse the same acpSessionId for follow-up messages and runs."
  },
  "conversationRules": [
    "Create a session first unless you already have an acpSessionId.",
    "Use the same acpSessionId to continue a conversation.",
    "Use attachTo.project_ref when working on an existing RedBox project.",
    "Do not send system events as user-visible chat messages.",
    "Expect RedBox artifact references as redbox://... URIs."
  ],
  "supportsStreaming": true,
  "supportsLongRunningTasks": true,
  "requiresApprovalFor": [
    "paid_generation",
    "browser_control",
    "delete_assets",
    "publish_or_export_outside_workspace"
  ],
  "endpoints": {
    "sessions": "/acp/v1/sessions",
    "runs": "/acp/v1/runs"
  }
}
```

### 8.3 Agent Guide

The manifest is machine-readable. The guide is LLM-readable. Both are required in P0 because many external agents will follow short procedural instructions more reliably than a schema-only card.

Route:

```text
GET /acp/v1/guide
```

Response:

```json
{
  "contentType": "text/markdown",
  "body": "# How to work with RedBox Creator Agent\n\n1. Read /acp/v1/manifest.\n2. Create or reuse an ACP session.\n3. Send the user's creator task as a message.\n4. Start a run.\n5. Poll events until completed.\n6. Reuse returned acpSessionId and redbox:// artifact refs.\n\nRules:\n- Never write to normal Chat sessions.\n- Continue with acpSessionId.\n- Use project_ref for existing RedBox projects.\n- Treat paid generation, browser control, deletion, external export, and publish as approval-gated."
}
```

The same guide text should be available from Settings as copyable prompts for Codex, Hermes, OpenClaw, and a generic external agent.

Recommended copied instruction:

```md
You can collaborate with RedBox Creator Agent through its local ACP gateway.

Endpoint: http://127.0.0.1:31937/acp/v1

Steps:
1. Read `/acp/v1/manifest`.
2. Create or reuse an ACP session.
3. Send creator tasks as messages.
4. Start a run and poll events.
5. Reuse returned `acpSessionId` and `redbox://...` artifact refs.

Use RedBox for creator asset context, topic briefs, manuscript planning, cover planning, media planning, and project packaging.
```

### 8.4 Session Routing And Conversation Projection

Session routing is a product contract, not an implementation detail.

Default behavior:

- If the external agent does not specify a target, RedBox creates a new ACP session.
- Every new ACP session creates or binds a `CollabSessionRecord`.
- Every new ACP session also creates a `ChatSessionRecord` projection immediately, before a run starts.
- The conversation list projection must carry ACP metadata so the app can show source badges and update the same row across runs.

Supported P0 routing:

| Request Context | RedBox Behavior |
| --- | --- |
| No target session/project | Create new `AcpSessionRecord` + `CollabSessionRecord` + `ChatSessionRecord` projection |
| `acpSessionId` in message/run route | Continue existing ACP session |
| `attachTo.type = "acp_session"` | Return or resume that ACP session if it belongs to the client |
| `attachTo.type = "collab_session"` | Create an ACP mapping to that collaboration session if policy allows it |
| `attachTo.type = "project_ref"` | Create a new ACP session bound to the RedBox project reference |
| `attachTo.type = "runtime_session"` | P0 rejects write attach; future mode may allow read-only context import |
| Archived ACP session | Return `session_archived` unless request explicitly asks to resume |
| Session belongs to another client | Return `forbidden` |

Do not write external messages into an arbitrary normal Chat session by default. The only Chat integration in P0 is the ACP-owned `ChatSessionRecord` projection, which is labeled as external-agent communication.

Conversation projection metadata:

```json
{
  "source": "acp",
  "sourceLabel": "ACP: Codex",
  "externalClientId": "codex-local",
  "externalClientName": "Codex",
  "acpSessionId": "acp-session-...",
  "collabSessionId": "collab-session-...",
  "projectRef": "redbox://project/project_123"
}
```

Chat transcript rule:

- External-agent inbound messages should be appended to the bound `ChatSessionRecord` transcript as chat-visible messages with `role = "user"` and metadata `senderKind = "external_agent"`.
- RedBox Creator Agent outputs should be appended with `role = "assistant"` and metadata `senderKind = "redbox_creator_agent"`.
- ACP system events should not flood the transcript; store them as run events and show only meaningful state in row badges/status.

### 8.5 Session Create

Request:

```json
{
  "externalClientId": "codex-local",
  "title": "小红书评论选题",
  "goal": "基于最近采集的小红书评论，生成一个短视频选题和脚本计划",
  "attachTo": {
    "type": "project_ref",
    "uri": "redbox://project/project_123"
  },
  "metadata": {
    "sourceAgent": "codex",
    "workspaceHint": "/Users/Jam/LocalDev/GitHub/RedConvert"
  }
}
```

Response:

```json
{
  "sessionId": "acp-session-...",
  "collabSessionId": "collab-session-...",
  "chatSessionId": "session-...",
  "sourceLabel": "ACP: Codex",
  "status": "active",
  "createdAt": 1782297600000,
  "mapping": {
    "createdAcpSession": true,
    "createdCollabSession": true,
    "createdChatProjection": true
  }
}
```

### 8.6 Message

Supported message parts:

```json
{
  "role": "external_agent",
  "parts": [
    { "type": "text", "text": "请基于最近采集的评论整理选题 brief。" },
    { "type": "asset_ref", "uri": "redbox://asset/asset_123" },
    { "type": "project_ref", "uri": "redbox://project/project_456" },
    { "type": "file_ref", "path": "/absolute/path/context.md" }
  ],
  "metadata": {
    "sourceAgent": "codex",
    "turnId": "external-turn-..."
  }
}
```

Storage rule:

- Persist the ACP message.
- Convert it into a `CollabMailboxMessageRecord`.
- Append a chat-visible transcript message to the bound `ChatSessionRecord`.
- Mark sender as external.
- Preserve external IDs in metadata, but do not trust external IDs as RedBox primary keys.

### 8.7 Run

Request:

```json
{
  "sessionId": "acp-session-...",
  "mode": "creator_brief",
  "instructions": "输出 brief、候选标题、引用素材和下一步任务。",
  "stream": true
}
```

Run state:

```text
queued
running
awaiting_approval
completed
failed
cancelled
expired
```

Run response:

```json
{
  "runId": "acp-run-...",
  "sessionId": "acp-session-...",
  "status": "queued",
  "eventsUrl": "/acp/v1/runs/acp-run-.../events"
}
```

### 8.8 Events

Event types:

```text
session.created
message.received
run.queued
run.started
runtime.wake_requested
runtime.event
approval.required
artifact.created
run.completed
run.failed
run.cancelled
```

P0 can implement events as bounded JSON polling:

```text
GET /acp/v1/runs/{run_id}/events?cursor=acp-event-...&limit=100
```

P1 can add SSE if the current raw TCP HTTP implementation can support long-lived chunked responses cleanly. If SSE adds too much risk to `assistant_core.rs`, do not force it into P0.

### 8.9 Artifact Reference

All RedBox outputs returned to external agents must use stable references:

```json
{
  "id": "artifact_...",
  "kind": "brief",
  "title": "短视频选题 brief",
  "uri": "redbox://brief/brief_...",
  "summary": "基于 42 条评论整理的 3 个候选选题。",
  "createdAt": 1782297600000
}
```

Supported P0 artifact kinds:

- `brief`
- `task_plan`
- `manuscript_outline`
- `project_ref`
- `asset_ref`

P1 artifact kinds:

- `manuscript`
- `cover_plan`
- `media_job`
- `export_package`

## 9. Persistence Model

Add records to `AppStore` with `serde(default)`:

```rust
pub(crate) acp_gateway: AcpGatewayStateRecord,
pub(crate) acp_clients: Vec<AcpClientRecord>,
pub(crate) acp_sessions: Vec<AcpSessionRecord>,
pub(crate) acp_runs: Vec<AcpRunRecord>,
pub(crate) acp_messages: Vec<AcpMessageRecord>,
pub(crate) acp_artifacts: Vec<AcpArtifactRecord>,
pub(crate) acp_audit_events: Vec<AcpAuditEventRecord>,
```

### 9.1 Gateway State

```rust
pub struct AcpGatewayStateRecord {
    pub enabled: bool,
    pub local_only: bool,
    pub endpoint_path: String,
    pub allow_remote: bool,
    pub last_error: Option<String>,
}
```

Default:

- `enabled = false` until UI enables it.
- `local_only = true`.
- `endpoint_path = "/acp/v1"`.
- `allow_remote = false`.

### 9.2 Client

```rust
pub struct AcpClientRecord {
    pub id: String,
    pub display_name: String,
    pub client_kind: String,
    pub token_hash: String,
    pub enabled: bool,
    pub capabilities: Vec<String>,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}
```

Initial capability presets:

- `read_context`
- `create_session`
- `send_message`
- `start_run`
- `read_events`
- `read_artifacts`
- `request_approval`

P0 should not grant:

- `delete_assets`
- `paid_generation_auto`
- `browser_control`
- `write_external_files`
- `publish`

### 9.3 Session

```rust
pub struct AcpSessionRecord {
    pub id: String,
    pub client_id: String,
    pub collab_session_id: Option<String>,
    pub chat_session_id: Option<String>,
    pub project_ref: Option<String>,
    pub owner_surface: String,
    pub source_label: String,
    pub title: String,
    pub goal: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: serde_json::Value,
}
```

The collab session remains the internal host-owned coordination root. The chat session is the user-facing conversation-list projection. The ACP session is the external protocol-facing view.

Required invariants:

- `chat_session_id` is created at ACP session creation time for P0.
- `chat_session_id` must not point to an unrelated normal user chat.
- `source_label` is rendered in lists and headers.
- `project_ref` may be empty; do not auto-create a project only because an ACP session exists.
- If `collab_session_id` or `chat_session_id` is missing after a restart, session repair should recreate projection records from ACP session metadata before accepting new runs.

### 9.4 Run

```rust
pub struct AcpRunRecord {
    pub id: String,
    pub session_id: String,
    pub collab_session_id: Option<String>,
    pub runtime_session_id: Option<String>,
    pub status: String,
    pub mode: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub last_event_cursor: i64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub metadata: serde_json::Value,
}
```

### 9.5 Audit

Audit records should be append-only and bounded:

```rust
pub struct AcpAuditEventRecord {
    pub id: String,
    pub client_id: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub event_type: String,
    pub created_at: i64,
    pub summary: String,
    pub metadata: serde_json::Value,
}
```

Keep latest 1000 in AppStore P0. Move to JSONL if event volume becomes high.

## 10. Runtime Bridge

### 10.1 Internal Target

P0 should route every external ACP session to one internal Creator Agent member:

```text
AcpSessionRecord
  -> CollabSessionRecord(ownerSurface = "acp_gateway")
  -> ChatSessionRecord(metadata.source = "acp")
  -> CollabMemberRecord(role = "creator_agent", adapterType = "internal_runtime")
  -> mailbox messages
  -> runtime wake
```

Do not spawn arbitrary external ACP members in P0. The external tool is the caller, not a RedBox teammate.

### 10.2 Wake Semantics

```text
POST /messages
  -> persist ACP message
  -> persist mailbox message
  -> append chat-visible transcript message
  -> emit message.received
  -> optional auto-run if request says autoStartRun

POST /runs
  -> persist run queued
  -> enqueue wake
  -> best-effort wake internal runtime
  -> status running when runtime starts
```

If wake fails:

- Mark run `failed` only if there is no retry path.
- Otherwise mark `queued` with `runtime.wake_failed` event and retry count.
- Keep the message durable.

### 10.3 Prompt Boundary

Creator Agent prompt should include:

- external session goal
- latest unread mailbox messages
- allowed capabilities
- RedBox creator agent role
- explicit output contract
- required artifact ref format
- safety/approval requirements

It should not include raw ACP token, client secret, full settings, or internal store snapshots.

### 10.4 Output Contract

The Creator Agent should end each run with a structured summary payload, persisted as artifacts and progress reports:

```json
{
  "status": "completed",
  "summary": "...",
  "artifacts": [
    {
      "kind": "brief",
      "title": "...",
      "uri": "redbox://brief/..."
    }
  ],
  "nextActions": [
    {
      "label": "继续写视频脚本",
      "requiresApproval": false
    }
  ]
}
```

## 11. UI Plan

### 11.1 Settings

Add a compact Agent Gateway section under Settings, preferably in an existing tools/runtime area rather than adding a new primary nav item.

Controls:

- Enable Agent Gateway toggle.
- Local endpoint display: `http://127.0.0.1:31937/acp/v1/manifest`.
- Client list with enabled/disabled state.
- Create/revoke token.
- Capability preset selector.
- Recent calls count and last error.

Avoid explanatory walls of text. Use concise labels and copy buttons.

### 11.2 Workboard / Collaboration

ACP may create or bind a `CollabSessionRecord` internally so the runtime can reuse mailbox, coordinator, and event infrastructure. This is an implementation detail, not a user-facing team.

Team / Workboard rules:

- Do not show auto-created ACP sessions in the Team sidebar.
- Do not count external ACP clients as team members.
- Do not add `All / Local / External` filters to Team for ACP.
- If a user explicitly attaches ACP to an existing real collaboration session, that existing team session remains visible as a team; the ACP client is still shown as the caller, not a member.
- Any ACP status, source label, run status, or artifact ref should appear in the conversation list/detail, not as a team card.

Use stale-while-revalidate for existing team data. Team refresh must not blank real collaboration sessions.

### 11.3 Chat / RedClaw

P0 does not need a new chat surface, but ACP conversations must still appear in the app conversation list. They should be visually distinct from normal user-created chats.

Conversation list requirements:

- Show ACP sessions in the main conversation list or a visible `External Agent` group.
- Add a source badge on every ACP row: `ACP: Codex`, `ACP: Hermes`, `ACP: OpenClaw`, or custom client name.
- Use an external-agent icon or compact label next to the title.
- Show the latest external message or latest Creator Agent response as the row preview.
- Show run status when active: queued, running, awaiting approval, failed.
- Do not create a new row for every run; continuing the same ACP session updates the same row.
- Allow filtering by `All`, `Local`, and `External Agent`.
- Make the source label visible in the conversation header after opening the session.

Implementation note:

- ACP-created runtime sessions must carry metadata such as `source="acp"`, `externalClientId`, `externalClientName`, `acpSessionId`, and `collabSessionId`.
- Chat list queries should include these sessions by default, but preserve the source badge so users can immediately tell this is communication with an external AI.
- Team list queries should filter out auto-created `source="acp"` collaboration sessions so implementation records do not appear as teams.
- If the existing Chat list cannot safely show ACP sessions in P0, add a visible `External Agent` group in the same list component.

## 12. Security And Approval

P0 security defaults:

- Gateway disabled by default.
- Localhost only.
- Bearer token required for mutating routes.
- Manifest can be public local read only.
- No remote binding.
- No direct database access.
- No direct file writes outside workspace.
- No paid generation without approval.
- No delete operations through ACP.
- No browser control through ACP.

Approval gates:

```text
paid_generation
browser_control
delete_assets
export_outside_workspace
write_external_file
publish
```

Approval result should be represented as:

```json
{
  "status": "awaiting_approval",
  "approval": {
    "id": "approval_...",
    "reason": "需要提交视频生成任务，预计消耗积分。",
    "requestedCapability": "paid_generation"
  }
}
```

## 13. Performance Strategy

- Do not stream every token into ACP events. Buffer runtime text deltas and emit meaningful milestones.
- Cap per-run event query to 200 items by default.
- Keep audit log bounded.
- Store large artifacts as RedBox records/files, not inline JSON blobs.
- Reuse the existing local HTTP listener to avoid another daemon.
- Avoid holding `AppStore` locks while waking runtime, reading files, or calling models.
- For event polling, use cursor-based reads from stored runtime/acp events.
- Add SSE only after polling works and the raw HTTP server can handle long-lived responses safely.

## 14. Existing Libraries Vs Self-Build

Must use existing/local infrastructure:

- Existing `assistant_core.rs` local HTTP listener.
- Existing `AppStore` persistence and `serde(default)` compatibility.
- Existing `runtime:event` stream.
- Existing `Collab*` records and `team-runtime:*` bridge.
- Existing internal runtime/tool/approval boundaries.
- Existing browser/plugin and media generation modules only through approved internal tools.

Should use existing libraries:

- `serde` / `serde_json` for protocol payloads.
- `reqwest` only for test clients or future outbound adapters, not for local route handling.
- Existing Rust test framework.

Should self-build:

- RedBox ACP record schema.
- RedBox Creator Agent manifest.
- RedBox ACP guide and copied external-agent instructions.
- Capability policy.
- ACP route dispatcher.
- ACP-to-mailbox normalization.
- Run/event/artifact projection.
- Settings UI integration.

Should not self-build in P0:

- New full HTTP framework.
- Remote federation.
- Generic public A2A cloud relay.
- Multi-agent external process supervisor.

## 15. Implementation Phases

### Phase 0: Contract And Test Fixtures

Goal: lock protocol shape before runtime changes.

Files:

- `desktop/src-tauri/src/acp_gateway/types.rs`
- `desktop/src-tauri/src/acp_gateway/manifest.rs`
- `desktop/src-tauri/src/acp_gateway/guide.rs`
- `desktop/src-tauri/src/acp_gateway/errors.rs`

Tasks:

- Define request/response structs.
- Define error codes.
- Define manifest payload.
- Define LLM-readable guide payload.
- Add unit tests for manifest shape and JSON compatibility.
- Add unit tests that guide includes required session, message, run, events, and artifact instructions.
- Add sample payloads under tests if the repo has an existing fixture convention.

Exit criteria:

- Manifest serializes deterministically.
- Guide contains no secrets and includes the current local endpoint pattern.
- Invalid payloads return stable errors.

### Phase 1: Store And Settings State

Goal: persist clients/sessions/runs/messages/artifacts/audit.

Files:

- `desktop/src-tauri/src/store/types.rs`
- `desktop/src-tauri/src/persistence/mod.rs`
- `desktop/src-tauri/src/acp_gateway/auth.rs`
- `desktop/src-tauri/src/acp_gateway/audit.rs`

Tasks:

- Add `AcpGatewayStateRecord` and related records.
- Set gateway disabled by default.
- Add bounded audit helpers.
- Add token hash generation/validation helper.
- Add tests for default load and old store compatibility.

Exit criteria:

- Existing store files without ACP fields load.
- New records persist and reload.
- Audit is bounded.

### Phase 2: Local HTTP Routes

Goal: expose discovery and basic session APIs on the existing local daemon.

Files:

- `desktop/src-tauri/src/acp_gateway/http.rs`
- `desktop/src-tauri/src/acp_gateway/sessions.rs`
- `desktop/src-tauri/src/assistant_core.rs`

Tasks:

- Add `is_acp_gateway_path`.
- Dispatch ACP routes before generic assistant webhook matching.
- Implement `GET /acp/v1/manifest`.
- Implement `GET /.well-known/redbox-agent.json`.
- Implement `GET /acp/v1/guide`.
- Implement `POST /acp/v1/sessions`.
- Implement `GET /acp/v1/sessions/{id}`.
- Implement P0 `attachTo` resolution for `acp_session`, `collab_session`, and `project_ref`.
- Create `ChatSessionRecord` projection during ACP session creation.
- Store ACP source metadata on the chat session projection.
- Enforce method checks.
- Enforce local-only access.

Exit criteria:

- HTTP probe can read manifest.
- HTTP probe can read guide.
- Session create returns `acpSessionId`, `collabSessionId`, `chatSessionId`, and mapping flags.
- Session create without target auto-creates all required projections.
- Session create with `project_ref` binds the ACP session to that project without auto-creating a new project.
- Non-local or unauthorized mutating requests fail.

### Phase 3: Message Intake And Mailbox Mapping

Goal: external messages become durable RedBox collaboration messages.

Files:

- `desktop/src-tauri/src/acp_gateway/messages.rs`
- `desktop/src-tauri/src/acp_gateway/sessions.rs`
- `desktop/src-tauri/src/runtime/collab_runtime/*`
- `desktop/src-tauri/src/subagents/mailbox.rs`

Tasks:

- Normalize ACP message parts into mailbox payload.
- Preserve `sourceAgent`, `externalTurnId`, and source client metadata.
- Create or reuse a Creator Agent collab member.
- Write mailbox before any wake attempt.
- Append the external message to the bound chat transcript with `role = "user"` and ACP sender metadata.
- Update the bound chat session preview/update time.
- Emit `message.received` and `runtime:collab-message-delivered`.

Exit criteria:

- A posted ACP message appears in the session mailbox.
- The same message appears in the ACP conversation detail in Chat.
- Message survives without runtime wake.
- UI can read the message through existing session snapshot.

### Phase 4: Run Lifecycle And Runtime Wake

Goal: create a run and wake RedBox Creator Agent.

Files:

- `desktop/src-tauri/src/acp_gateway/runs.rs`
- `desktop/src-tauri/src/acp_gateway/runtime_bridge.rs`
- `desktop/src-tauri/src/subagents/wake_runtime.rs`
- `desktop/src-tauri/src/subagents/spawner.rs`
- `desktop/prompts/library/runtime/*` if a dedicated prompt file is needed

Tasks:

- Implement `POST /acp/v1/runs`.
- Create queued run record.
- Build Creator Agent wake prompt from mailbox + session goal.
- Start or reuse internal runtime session.
- Track runtime session id on the ACP run.
- Link the runtime session back to the ACP chat projection instead of creating duplicate conversation rows.
- Update run status from runtime events.
- Implement cancel route using existing runtime cancellation where possible.

Exit criteria:

- External request can start a RedBox Creator Agent run.
- Run transitions queued -> running -> completed/failed.
- Runtime session id is linked for diagnostics.
- Continuing a run on the same ACP session updates the existing conversation row.

### Phase 5: Events And Artifacts

Goal: external agents can observe progress and receive stable outputs.

Files:

- `desktop/src-tauri/src/acp_gateway/events.rs`
- `desktop/src-tauri/src/acp_gateway/artifacts.rs`
- `desktop/src-tauri/src/runtime/events.rs`
- `desktop/src-tauri/src/runtime/session_runtime.rs`

Tasks:

- Implement `GET /acp/v1/runs/{id}`.
- Implement cursor-based `GET /acp/v1/runs/{id}/events`.
- Project relevant `runtime:event` records into ACP event records.
- Create artifact refs from Creator Agent final payload.
- Store artifact records and collab report artifacts.
- Implement `GET /acp/v1/artifacts/{id}`.

Exit criteria:

- External client can poll events with cursor.
- Run result includes artifact refs.
- Artifact refs are stable and resolvable.

### Phase 6: Settings And Conversation UI

Goal: user can enable, inspect, and control ACP access without a new major UI surface.

Files:

- `desktop/src/pages/Settings.tsx`
- `desktop/src/pages/settings/SettingsSections.tsx`
- `desktop/src/bridge/domains/systemBridge.ts`
- `desktop/src/bridge/domains/teamRuntimeBridge.ts`
- `desktop/src/pages/Team.tsx`
- `desktop/src/pages/Chat.tsx`
- conversation/session list components used by Chat

Tasks:

- Add Agent Gateway settings card.
- Add enable/disable.
- Add endpoint copy.
- Add client token create/revoke.
- Add capability view.
- Add `Copy Codex Instructions`, `Copy Hermes Instructions`, `Copy OpenClaw Instructions`, and `Copy Generic Instructions`.
- Add copy action for manifest URL and guide URL.
- Keep auto-created ACP sessions out of the Team sidebar; they are not teams.
- Add ACP sessions to the conversation list with visible source badges.
- Add `All / Local / External Agent` filtering if the list would otherwise mix sources ambiguously.
- Add ACP source metadata to the opened conversation header.
- Add list-row preview logic for latest external message, latest Creator Agent response, and active run status.

Exit criteria:

- Gateway can be enabled from UI.
- User can copy endpoint/token.
- User can copy agent-specific connection instructions.
- Copied instructions include manifest URL, guide URL, endpoint, session flow, and continuation rule.
- ACP-created session does not appear as a Team / Workboard item.
- ACP-created session appears in the conversation list with a visible external-agent badge.
- Continuing an ACP session updates the existing list row instead of creating a duplicate row.
- Opening an ACP row shows the same transcript that the external agent and RedBox Creator Agent used.

### Phase 7: External Adapters

Goal: make non-native ACP tools usable without changing RedBox core.

Files:

- `desktop/scripts/redbox-acp-client.mjs` or `Plugin/scripts/redbox-acp-client.mjs`
- `desktop/docs/redbox-acp-agent-gateway-usage.md`

Tasks:

- Provide a CLI helper:
  - `redbox-acp manifest`
  - `redbox-acp guide`
  - `redbox-acp session create`
  - `redbox-acp send`
  - `redbox-acp run`
  - `redbox-acp events`
- Provide examples for Codex prompt usage.
- Keep adapters thin. They translate command-line calls to ACP HTTP only.

Exit criteria:

- Codex can call the helper from terminal context.
- The helper can print both machine-readable manifest and markdown guide.
- Hermes/OpenClaw can use the same HTTP endpoint or helper.
- No product logic lives inside adapters.

### Phase 8: P1 Enhancements

Only after P0 is stable:

- SSE event stream.
- Approval response route.
- `redbox://asset/...` and `redbox://project/...` resolver.
- Rich project resolver UI and project picker integration.
- Media job artifact kind.
- External agent identity profiles.
- Remote HTTP/WebSocket mode with explicit user opt-in.
- MCP bridge for direct tool calls.

## 16. Atomic Commit Plan

When implementing, keep commits scoped:

1. `docs: add acp agent gateway implementation plan`
2. `feat(acp): add gateway protocol types manifest and guide`
3. `feat(acp): persist gateway clients sessions and audit`
4. `feat(acp): expose local manifest and session routes`
5. `feat(acp): map external messages to collaboration mailbox`
6. `feat(acp): add creator agent run lifecycle`
7. `feat(acp): project run events and artifacts`
8. `feat(ui): add agent gateway settings controls`
9. `feat(ui): show acp sessions in workboard`
10. `feat(ui): show acp sessions in chat list`
11. `docs(acp): add external agent usage guide`

Do not mix UI, host schema, runtime wake, and adapter scripts in one commit.

## 17. Verification Matrix

### Rust Unit Tests

- Manifest serialization.
- Guide serialization and required instruction coverage.
- Auth token validation.
- Capability denial.
- Session create and lookup.
- Session target routing for auto-create, `acp_session`, `collab_session`, and `project_ref`.
- Chat projection creation and ACP metadata.
- Message normalization.
- Mailbox persistence before wake.
- Chat transcript append for external-agent messages.
- Run state transitions.
- Event cursor pagination.
- Artifact resolution.
- Audit log bounding.

### Host Integration Tests

- Local HTTP manifest route.
- Local HTTP guide route.
- Unauthorized mutating request is rejected.
- Session create through HTTP persists state.
- Session create through HTTP creates a chat-list projection with `source = "acp"`.
- Message post appears in collaboration mailbox.
- Message post appears in the bound chat transcript.
- Run cancel updates run state.

### Runtime Tests

- Creator Agent wake links runtime id to run.
- Runtime failure updates run failure.
- Final structured output creates artifact refs.
- Approval-required event pauses run.

### Renderer Checks

- `pnpm exec tsc --noEmit`.
- Settings card renders with gateway disabled.
- Settings copy-instructions actions include manifest, guide, endpoint, and continuation rule.
- Team keeps stale session data during refresh.
- ACP auto-created sessions are filtered out of Team / Workboard.
- Chat conversation list shows ACP sessions with `ACP: <client>` badges.
- Chat conversation header preserves source metadata after opening an ACP session.

### Manual Smoke

1. Enable gateway.
2. Create a local client token.
3. `curl /acp/v1/manifest`.
4. `curl /acp/v1/guide`.
5. Copy Codex instructions from Settings and confirm they include endpoint, manifest, guide, and `acpSessionId` continuation rule.
6. Create session.
7. Post message.
8. Start run.
9. Poll events.
10. Confirm Team / Workboard does not show the auto-created ACP session.
11. Confirm the conversation list shows the session with `ACP: <client>` badge.
12. Confirm final artifact is resolvable.

## 18. Current Implementation Snapshot

Implemented on 2026-06-24:

- Added `desktop/src-tauri/src/acp_gateway/*` with manifest, guide, auth gate, session routing, message intake, async run lifecycle, event polling, artifact lookup, and audit events.
- Routed `/.well-known/redbox-agent.json` and `/acp/v1/*` through the existing local assistant HTTP listener before generic webhook handling.
- Added durable ACP records to `AppStore`: gateway state, hashed-token clients, sessions, runs, messages, artifacts, and audit events.
- Assistant daemon status/config now exposes `acpGateway`, and Settings can enable the gateway, toggle token/local-only policy, create one-time client tokens, revoke clients, and copy manifest/guide URLs.
- Auto-created ACP sessions now create both a `ChatSessionRecord` projection and a `CollabSessionRecord`; `attachTo.type = "acp_session"`, `collab_session`, and `project_ref` are supported.
- ACP session responses expose `chatSessionId`, `collabSessionId`, `creatorMemberId`, `projectRef`, client metadata, message count, and the chat/collab snapshots needed for external debugging.
- Each ACP session creates or reuses the internal collaboration coordinator as the RedBox Creator Agent recipient.
- External messages are written to Chat as `role=user` with `metadata.senderKind=external_agent`, and to the collaboration mailbox as `messageType=acp.external_message`.
- Collaboration mailbox messages are addressed to the internal Creator Agent/coordinator through `toMemberId`, while the external agent remains the caller, not a RedBox team member.
- ACP runs use the existing `PreparedSessionAgentTurn::session_bridge` path, so RedBox Creator Agent execution goes through the normal AI runtime and tool policy.
- Completed runs create outbound ACP assistant messages and a `text_response` artifact ref.
- Settings exposes ACP manifest/guide URLs and copy prompts for Codex, Hermes, and OpenClaw.
- Run and session event endpoints support cursor/limit polling and return `nextCursor` and `hasMore`.
- Runtime/RedClaw/Advisor session lists can render ACP labels from `metadata.source=acp` and `metadata.sourceLabel`.
- Team/Workboard sidebar filters out auto-created ACP sessions because external-agent conversations are not teams.
- Startup recovery marks persisted `queued`/`running` ACP runs as `expired`, appends an audit event, and clears the active run count so external pollers do not wait forever after app restart.
- Normal runtime milestones are projected into ACP audit events for ACP chat projections: stream start, tool start/end, checkpoints, and done.
- ACP run creation detects approval-gated capabilities such as paid generation, browser control, deletion, publishing, and external export; matching runs enter `awaiting_approval`, expose `run.approval`, write audit events, and register a `RuntimeApprovalRecord` instead of starting execution.
- Completed runs extract structured artifacts from JSON or fenced JSON `artifact` / `artifacts` payloads, while still preserving the full `text_response` artifact.
- Added `desktop/scripts/redbox-acp-client.mjs` as a thin no-dependency CLI helper for manifest, guide, session create, send, run, events, and artifact calls.
- Added `desktop/docs/redbox-acp-agent-gateway-usage.md` with Codex/Hermes/OpenClaw-style usage instructions and token handling guidance.
- Added low-coupling Rust unit tests for manifest/guide shape, token enforcement, `project_ref` attach routing, direct runtime-session attach rejection, event cursor pagination, runtime milestone projection, startup run recovery, approval detection, pending approval response shape, and structured artifact extraction.
- Focused checks pass: `CARGO_TARGET_DIR=/tmp/redconvert-cargo-target cargo test --bin redbox acp_gateway::` with 12 passing tests, `CARGO_TARGET_DIR=/tmp/redconvert-cargo-target cargo check`, `pnpm -C desktop exec tsc --noEmit`, and `node --check desktop/scripts/redbox-acp-client.mjs`.
- Local HTTP smoke passed against this worktree's Tauri dev build on `http://127.0.0.1:31937`: manifest, guide, session create, message post, approval-gated run, normal run completion, event polling, and artifact lookup all returned expected ACP records.
- Smoke-created ACP sessions appear as chat projections and collaboration sessions with `metadata.source=acp` and `sourceLabel=ACP: <client>`.
- The assistant HTTP listener now handles each accepted TCP connection in an isolated request thread, so a slow or partial external request cannot block ACP discovery, polling, or manifest reads.
- Concurrency smoke passed by holding a partial `/api/ipc/invoke` request open while `/.well-known/redbox-agent.json` still returned `200` in 53 ms.

## 19. Failure Handling

| Failure | Expected Behavior |
| --- | --- |
| Invalid token | 401 with stable error code |
| Disabled gateway | 403 with `gateway_disabled` |
| Unknown session | 404 with `session_not_found` |
| Runtime wake failure | message remains durable; run records wake failure |
| App restart during queued run | run is marked `expired` with recovery audit event |
| Runtime crash | run failed with diagnostic event |
| Artifact missing | artifact endpoint returns 404; audit event written |
| Permission required | run goes `awaiting_approval`; no side effect happens |

## 20. Resolved Decisions And Open Questions

Resolved:

- ACP sessions are automatically created when no target is specified.
- External agents discover RedBox through both machine-readable manifest and LLM-readable guide.
- Settings provides copyable instructions for Codex, Hermes, OpenClaw, and generic external agents.
- External agents can continue an existing ACP session by using `acpSessionId`.
- External agents can request attachment to an existing collaboration session or project reference when policy allows it.
- Events use cursor-based JSON polling in P0.
- SSE is not part of P0; add it only after the raw TCP HTTP listener is refactored.
- P0 does not allow write attachment to arbitrary normal Chat sessions.
- Every ACP session creates a user-visible `ChatSessionRecord` projection immediately.
- ACP conversations appear in the conversation list with an external-agent badge, not only in Workboard.
- Continuing the same ACP session updates one conversation row.

Open:

- Should P0 auto-create a RedBox project for every ACP session, or only create a collaboration session first?
  - Recommendation: only create project when Creator Agent decides it needs a project artifact.
- Should manifest be readable without auth?
  - Recommendation: yes. Local-only manifest and guide can be unauthenticated. Mutating routes support token enforcement through `requireToken`; generated client tokens are one-time visible and stored as hashes.
- Should Codex integration be MCP or ACP helper first?
  - Recommendation: helper first. `desktop/scripts/redbox-acp-client.mjs` now covers P0 calls; MCP bridge comes after Gateway contract stabilizes.
- Should external agents be allowed to become Workboard members?
  - Recommendation: not in P0. External agent is caller; RedBox Creator Agent is the internal worker.

## 21. Recommended P0 Scope

P0 is complete when this works:

```text
External agent
  -> discovers RedBox Creator Agent
  -> creates ACP session
  -> sends creator task
  -> starts run
  -> polls events
  -> receives brief/task-plan artifact refs

RedBox user
  -> sees gateway status in Settings
  -> sees external session in Workboard
  -> sees the same session in the conversation list with an external-agent badge
  -> can inspect message, status, and artifacts
  -> can disable/revoke external access
```

This proves the new product direction: RedBox can be a specialized creator agent that other general-purpose agents can collaborate with. Direct asset and media MCP tools should come after this first agent-to-agent loop is stable.
