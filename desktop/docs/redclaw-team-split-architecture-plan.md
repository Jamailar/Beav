---
doc_type: plan
execution_status: not_started
last_updated: 2026-04-28
---

# RedClaw Team Split Architecture Plan

## Goal

Bring an AionUi-style horizontal team collaboration surface into the RedClaw page, not as a decorative multi-column chat, but as a real coordination workspace where:

- the leader coordinates the plan, task assignment, sequencing, and final summary;
- every member has an inspectable lane with messages, status, tasks, reports, blockers, and artifacts;
- users can talk to the leader or a specific member without losing the shared RedClaw context;
- reports are first-class state, not just prose buried inside the main chat;
- the implementation reuses RedBox's existing collaboration runtime, task board, event stream, and RedClaw session model.

## AionUi Reference Findings

The AionUi implementation is split across three layers.

### 1. Team Page UI

Reference files:

- `/Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/TeamPage.tsx`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/components/TeamTabs.tsx`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/components/TeamChatView.tsx`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/components/TeamAgentIdentity.tsx`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/hooks/useTeamSession.ts`

Important UI mechanics:

- The main content is a horizontal scroll container.
- Each agent lane uses `flex: 1 1 400px`, with a readable floor (`minWidth: 400px` when the team is wider than the viewport).
- If there are only one or two lanes, the min width drops to `240px` so the space still feels filled.
- The leader lane gets a distinct visual accent: left border plus a slightly tinted header/background.
- The tab bar is not merely navigation; it mirrors member status, pending permission counts, rename/remove affordances, and drag reorder.
- Fullscreen mode lets one agent fill the workspace without destroying the team layout state.
- Overflow arrows scroll to previous/next lanes and flash the target lane, so a wide team remains navigable.
- Every lane embeds the same underlying chat component family, but without nesting another full page layout.

This is the right interaction model for RedClaw because RedClaw users need to monitor parallel work without turning the page into a dashboard of disconnected cards.

### 2. Team Runtime

Reference files:

- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/TeamSession.ts`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/TeammateManager.ts`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/Mailbox.ts`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/TaskManager.ts`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/mcp/team/TeamMcpServer.ts`

Important runtime mechanics:

- `TeamSession` owns one team and composes mailbox, task manager, teammate manager, and team MCP server.
- User messages are delivered to the leader by default.
- Direct messages to a member go through the same mailbox path, then wake that member.
- Every member has a durable mailbox. Messages are accepted first, then waking the agent is best effort, so delivery is not lost if wake fails.
- Member status is explicit: pending, active, idle, failed, completed.
- The manager listens to owned conversation streams only, which prevents cross-team event contamination.
- When a non-leader member finishes, it sends an idle notification to the leader.
- The leader is only woken when all non-leader members are settled, avoiding repeated leader loops.
- Silent or crashed members are preserved as failed slots and reported to the leader instead of being removed.
- Team tools are injected as MCP tools, which forces coordination through structured actions such as send message, create task, update task, list members, and shutdown agent.

The essential lesson is that the horizontal UI only works because the runtime treats communication, task state, report state, and member lifecycle as durable, typed state.

### 3. Coordination Prompts

Reference files:

- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/prompts/leadPrompt.ts`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/prompts/teammatePrompt.ts`
- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/team/prompts/toolDescriptions.ts`

Important collaboration rules:

- The leader does not implement work directly. It decomposes, assigns, reviews, and synthesizes.
- Staffing is a proposal first unless the user explicitly asks to create specific members immediately.
- Teammates report to the leader through team tools, not by hoping the leader reads raw chat text.
- Waiting means ending the turn. A member must not keep a model request open while waiting for prerequisites.
- Dependent work is sequenced by the leader. Do not dispatch a reviewer or verifier with "wait until implementer finishes".
- Shutdown is a real structured action, not just a text message.

For RedClaw, this maps cleanly onto the existing preference: group chat is a reporting and decision surface, while execution is owned by member runtimes.

## Current RedBox / RedClaw Baseline

Relevant RedBox files:

- `desktop/src/pages/RedClaw.tsx`: current RedClaw page, one main `Chat` plus history drawer and skills sidebar.
- `desktop/src/pages/Workboard.tsx`: has a mode switch between RedClaw task center and collaboration board.
- `desktop/src/pages/workboard/CollaborationBoard.tsx`: current collaboration UI, board-shaped rather than lane-shaped.
- `desktop/src/bridge/ipcRenderer.ts`: exposes `window.ipcRenderer.teamRuntime.*`.
- `desktop/src/types.d.ts`: typed `CollabSessionRecord`, `CollabMemberRecord`, `CollabTaskRecord`, `CollabMailboxMessageRecord`, `CollabProgressReportRecord`, and `CollabSessionSnapshot`.
- `desktop/src-tauri/src/commands/runtime_collab.rs`: IPC command layer for collaboration sessions, members, tasks, mailbox, reports, and events.
- `desktop/src-tauri/src/runtime/collab_runtime.rs`: durable collaboration data model and state transitions.
- `desktop/src-tauri/src/subagents/team_tools.rs`: model-visible team actions.
- `desktop/src-tauri/src/mcp/team_server.rs`: team MCP contract surface.

What already exists:

- Durable collaboration sessions.
- Members with status, role, runtime/conversation identifiers, capabilities, and metadata.
- Task CRUD, assignment, dependency links, artifacts, blockers, mailbox, and reports.
- `runtime:event` updates for session/member/task/report/message changes.
- Workboard controls for creating sessions, adding members, creating tasks, requesting reports, sending task messages, completing tasks, attaching artifacts, and raising blockers.
- AI-facing actions including `team.session.create`, `team.member.spawn`, `team.message.send`, `team.task.create`, `team.task.update`, `team.report.submit`, and `team.report.request`.

What is missing for an AionUi-style RedClaw experience:

- A RedClaw page mode that renders one lane per member.
- A leader lane as the default command and summary surface.
- Per-member lane composer that sends to `teamRuntime.sendMessage` with `toMemberId`.
- A report-first message layout that separates assignment, progress, blockers, artifacts, and completion claims.
- A session binding between RedClaw's active context session and the active collaboration session.
- Member lane status derived from `CollabMemberRecord` and latest runtime events.
- A clear runtime rule that RedClaw collaboration members share the RedClaw space and content pipeline.

## Recommended Architecture

### Product Shape

The RedClaw page should gain a `Team` workspace mode inside the existing page, not a separate top-level app.

Recommended layout:

- Top page remains RedClaw's active space/session shell.
- Main area can toggle between:
  - `Assistant`: current single RedClaw chat.
  - `Team`: horizontal team split.
- The current history drawer remains page-level.
- The current skills sidebar remains page-level.
- Team mode owns its own compact session selector and member lanes.

Why this is best:

- It keeps RedClaw as the creative operating surface.
- It avoids splitting RedClaw task work between `/redclaw` and `/workboard`.
- It reuses current RedClaw session routing, onboarding, skills, and pending-message behavior.
- It lets collaboration become part of the creation chain instead of a separate admin board.

### Renderer Modules

Create:

- `desktop/src/pages/redclaw/team/RedClawTeamSplit.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamTabs.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamLane.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamComposer.tsx`
- `desktop/src/pages/redclaw/team/RedClawTeamReportFeed.tsx`
- `desktop/src/pages/redclaw/team/useRedClawTeamSession.ts`
- `desktop/src/pages/redclaw/team/redClawTeamState.ts`

Keep the implementation RedClaw-scoped. Do not globally alter `Chat` or `MessageItem` just to render team lanes.

#### `RedClawTeamSplit.tsx`

Responsibilities:

- Load or create the RedClaw-bound collaboration session.
- Subscribe to `teamRuntime.onEvent`.
- Keep the latest successful `CollabSessionSnapshot` while refreshing.
- Render horizontal lanes.
- Track active/fullscreen lane.
- Provide lane navigation and overflow arrows.

Core layout:

```tsx
<div className="relative flex h-full min-h-0 overflow-hidden">
  <div className="absolute inset-x-0 top-0 z-20">
    <RedClawTeamTabs ... />
  </div>
  <div ref={scrollRef} className="flex h-full w-full overflow-x-auto overflow-y-hidden pt-10">
    {members.map((member) => (
      <div
        key={member.id}
        className="h-full min-h-0 border-r border-border"
        style={{ flex: '1 1 400px', minWidth: members.length <= 2 ? 280 : 400 }}
      >
        <RedClawTeamLane member={member} ... />
      </div>
    ))}
  </div>
</div>
```

Use `ResizeObserver` to show left/right overflow controls, matching the AionUi pattern.

#### `RedClawTeamTabs.tsx`

Responsibilities:

- Show Leader first, then members.
- Show status dot, role label, pending report/request count, and latest blocker indicator.
- Switch/scroll to lane.
- Rename and shutdown members through `teamRuntime.renameMember` and `teamRuntime.shutdownMember`.

Do not implement drag reorder in the first RedClaw version unless member ordering is persisted in metadata. A non-persistent reorder would be misleading.

#### `RedClawTeamLane.tsx`

Responsibilities:

- Header: member identity, role, status, current task, latest activity.
- Body: report feed, mailbox messages, task card, artifacts.
- Footer: composer with target member.
- Leader lane is special:
  - shows session objective;
  - shows assignment queue and unresolved blockers;
  - sends messages as user-to-leader;
  - highlights "needs decision" reports.

Lane body should be report-first:

1. latest assignment or task card;
2. latest completion/progress report;
3. blockers;
4. artifact refs;
5. recent mailbox messages.

This keeps RedClaw collaboration focused on progress and handoff, not raw chat noise.

#### `RedClawTeamComposer.tsx`

Responsibilities:

- Send message through:

```ts
window.ipcRenderer.teamRuntime.sendMessage({
  sessionId,
  toMemberId: member.id,
  taskId: selectedTask?.id,
  fromKind: 'user',
  messageType: 'comment',
  body,
});
```

- If the lane is the leader, omit `taskId` unless replying to a selected task.
- Support attachments later by passing `attachmentRefs`; do not invent a separate upload path.
- Keep permissions and execution controls out of this composer until the runtime exposes them as typed actions.

#### `useRedClawTeamSession.ts`

Responsibilities:

- Resolve the active RedClaw space and active RedClaw chat session.
- Find a collaboration session whose metadata includes:

```json
{
  "surface": "redclaw",
  "redclawSpaceId": "<space-id>",
  "redclawChatSessionId": "<chat-session-id>"
}
```

- If no session exists, create one only when the user enters Team mode or explicitly clicks "create team".
- Load snapshot with bounded limits:

```ts
teamRuntime.getSession({
  sessionId,
  mailboxLimit: 120,
  reportLimit: 160,
});
```

- On event, refresh only when the event's `collabSessionId` matches the active session.
- Keep stale snapshot on refresh failure and surface inline error.

### Host / Runtime Changes

The existing `teamRuntime` surface is mostly enough for UI mode. To make it a real RedClaw collaboration runtime, add narrow actions rather than a broad "team page" command.

Add canonical actions:

- `team.session.bind_redclaw`
- `team.session.get_bound_redclaw`
- `team.member.ensure_leader`
- `team.lane.snapshot`

Recommended host files:

- `desktop/src-tauri/src/commands/runtime_collab.rs`
- `desktop/src-tauri/src/runtime/collab_runtime.rs`
- `desktop/src-tauri/src/subagents/team_tools.rs`
- `desktop/src-tauri/src/mcp/team_server.rs`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/types.d.ts`

#### `team.session.get_bound_redclaw`

Input:

```json
{
  "redclawSpaceId": "default",
  "redclawChatSessionId": "context-session-id",
  "createIfMissing": false
}
```

Output:

```json
{
  "session": "CollabSessionRecord | null",
  "snapshot": "CollabSessionSnapshot | null"
}
```

Behavior:

- Search `collab_sessions.metadata.surface == "redclaw"`.
- Match by `redclawSpaceId`; prefer exact `redclawChatSessionId`, fall back to latest active session for that space.
- If `createIfMissing` is true, create a session with `runtimeMode: "redclaw"` and `source: "redclaw-team-split"`.

#### `team.member.ensure_leader`

Input:

```json
{
  "sessionId": "collab-session-id",
  "displayName": "Leader",
  "roleId": "leader"
}
```

Behavior:

- Idempotently create or return the coordinator member.
- Set `session.coordinatorMemberId`.
- Store leader metadata:

```json
{
  "agentCard": {
    "roleId": "leader",
    "oneLine": "协调 RedClaw 内容生产团队，拆解任务、请求汇报、验收结果"
  }
}
```

### AI Collaboration Model

RedClaw should adopt this mental model:

- one member identity;
- one role/persona/card;
- two facets:
  - speaker facet: reports, asks questions, summarizes decisions;
  - executor facet: does work through runtime/tool actions;
- shared member task plan and report history.

The group split is therefore not "multiple chats"; it is "multiple accountable work lanes".

Prompt rules to add near RedClaw/team prompts:

- Leader is responsible for decomposition, sequencing, and final synthesis.
- Members must report through `team.report.submit` after meaningful progress.
- Members should attach artifacts through `team.artifact.attach` instead of burying paths in prose.
- Blockers must use `team.blocker.raise`.
- A member waiting for prerequisites must end its turn and wait for a mailbox wake.
- The leader dispatches dependent work only after prerequisite reports arrive.
- User-facing summaries should mention completed work, blockers, next action, and evidence.

### Video / Media Handling

RedClaw's collaboration lanes should not process video inside the UI. They should expose media state and route work to existing media/runtime capabilities.

Use existing capabilities:

- manuscript creation and media generation via existing RedClaw/authoring/runtime actions;
- video editing and Remotion/Freecut services already under `desktop/src/vendor/freecut`, `desktop/src/remotion`, and media runtime;
- local artifact references through `artifactIds`, `artifacts`, and file paths.

Self-build only:

- task-to-media handoff schema;
- lane preview of artifacts;
- report cards for media job status;
- "open artifact" / "show in folder" UI actions.

Use existing libraries:

- React/Tailwind/lucide for UI.
- Existing RedBox `ChatComposer` styling patterns if a lane composer needs richer input.
- Existing media preview utilities and asset protocol for images/video/audio.
- Existing runtime event stream for updates.

Do not build a custom video renderer, custom transcoder, or custom timeline engine for this feature.

### UI Detail

Recommended visual behavior:

- Compact, operational layout. No large marketing hero or explanatory cards.
- Top tabs: member identity + status + pending indicator.
- Lane header height around `40px`.
- Lane min width `400px`; single/two-lane mode `280px`.
- Leader lane gets a narrow accent rail and crown/leader icon.
- Use icon buttons for fullscreen, close/shutdown, report request, and refresh.
- Avoid nested cards. Use lane sections with dividers and small repeated task/report rows.
- The composer stays pinned to the bottom of each lane.
- Text must truncate in headers and wrap in report bodies.
- If there are many members, horizontal scroll is the primary navigation; the tab bar is a jump control.

### Performance Strategy

- Render shell immediately with last snapshot.
- Refresh snapshot in background.
- Keep mailbox/report limits bounded per snapshot.
- Do not hydrate full transcripts for every member on Team mode entry.
- Load per-lane details lazily when the lane becomes visible or active.
- Use `ResizeObserver` for overflow controls, but avoid recalculating on every event payload.
- Batch event-driven reloads with a short debounce, for example 150-250 ms.
- Preserve previous snapshot on refresh failure.
- Avoid host commands that scan workspace/files during initial lane render.
- If lane count grows beyond 8, virtualize offscreen lane bodies while keeping tab metadata visible.

### Options Considered

| Option | Description | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| Embed current `CollaborationBoard` inside RedClaw | Reuse board UI directly | Fastest | Not AionUi-like; no per-member communication lanes; reports stay secondary | Not enough |
| Reuse generic `Chat` per member | Create one chat session per member and render `Chat` in lanes | Closer to AionUi visually | RedClaw member runtime currently is not conversation-first; risks session contamination and heavy hydration | Not first choice |
| Build RedClaw lane UI over `teamRuntime` snapshot | Render member lanes from durable session/members/tasks/mailbox/reports | Matches RedBox data model; keeps reports structured; lower runtime risk | Needs custom lane components | Recommended |
| Port AionUi team runtime wholesale | Copy TeamSession/TeammateManager/MCP server model | Mature behavior | Electron/ACP assumptions do not map directly to Tauri/RedBox runtime | Use as reference only |

## Recommended Implementation Path

Implement as one complete feature slice:

1. Add RedClaw-bound collaboration session actions in host/runtime.
2. Extend `ipcRenderer.teamRuntime` with RedClaw binding helpers.
3. Add `RedClawTeamSplit` and lane components.
4. Add Team/Assistant mode toggle in `RedClaw.tsx`.
5. Add leader/member creation controls inside Team mode.
6. Wire per-lane composer to mailbox messages.
7. Render tasks, reports, blockers, and artifacts per lane.
8. Add event refresh and stale snapshot behavior.
9. Add tests for host binding/actions and renderer helpers.
10. Validate by creating a RedClaw team session, adding members, sending a leader message, sending a member message, requesting/reporting progress, and refreshing the page without losing state.

This should be one feature branch and one atomic commit because the user-visible feature is incomplete if only the UI or only the runtime binding lands.

## Acceptance Criteria

- RedClaw page has a Team mode.
- Entering Team mode does not clear or replace the current RedClaw chat.
- A RedClaw-bound collaboration session can be created and reopened after refresh.
- A leader lane is always present.
- Members render as horizontal lanes with status, current task, latest report, blockers, artifacts, and recent messages.
- User can send a message to the leader or a specific member.
- User can request a report from a member.
- User can create/assign a task from Team mode.
- Runtime events refresh the active Team view without full page reload.
- Refresh failure keeps the last successful snapshot visible.
- No global `Chat`/`MessageItem` behavior changes are required.
- No new top-level LLM tool is introduced; new actions go through `app_cli`/team runtime surfaces.
- Page switching remains responsive with at least 6 members and 100 mailbox/report records.

## Verification Matrix

- Renderer:
  - switch RedClaw Assistant -> Team -> Assistant;
  - create/open Team mode with no existing collaboration session;
  - add 3 members and verify horizontal overflow;
  - fullscreen one lane and return to split;
  - send leader and member messages;
  - refresh RedClaw page and confirm stale data appears immediately.
- Bridge / IPC:
  - call RedClaw binding helper from renderer;
  - call create member, update task, send message, request report through existing `teamRuntime`;
  - verify `runtime:event` refresh only affects matching session.
- Host:
  - unit test RedClaw session lookup by metadata;
  - unit test idempotent leader creation;
  - unit test snapshot limits.
- AI runtime:
  - run one real RedClaw collaboration task;
  - confirm leader creates/assigns tasks through team actions;
  - confirm member reports use structured report/action surface;
  - inspect transcript/events for mailbox, report, task, and artifact records.
