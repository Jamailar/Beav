---
doc_type: plan
execution_status: in_progress
last_updated: 2026-06-05
---

# RedBox Stability And Modularization Hardening Plan

## Goal

在不影响现有业务、不新增解释性 UI、不改变用户路径的前提下，把当前 RedBox desktop 的模块雏形收紧成稳定实现边界。目标不是重写，而是降低耦合、减少状态串线、提升 runtime 和媒体任务的可恢复性，让后续功能迭代可以按 atomic commit 小步推进。

核心判断：当前系统已经有模块化基础，风险不在“目录不存在”，而在“协议、状态、事件、页面逻辑还没有完全按模块边界隔离”。

## Non Goals

- 不重做 UI 信息架构。
- 不新增页面入口、说明区块或调试面板。
- 不替换 Tauri、React、Rust host、workspace persistence 等基础架构。
- 不一次性拆分 `AppStore` 持久化格式。
- 不把 AI 路由改成关键词硬编码。
- 不把现有多个 runtime 强行合并成一个超级 scheduler。

## Current Architecture Snapshot

### Product Surfaces

- App shell: `desktop/src/App.tsx`, `desktop/src/components/Layout.tsx`, `desktop/src/features/app-shell/*`
- Chat: `desktop/src/pages/Chat.tsx`, `desktop/src/components/ChatComposer.tsx`, `desktop/src/components/MessageItem.tsx`
- Generation and media: `desktop/src/pages/GenerationStudio.tsx`, `desktop/src/pages/MediaLibrary.tsx`, `desktop/src/features/media-generation/*`, `desktop/src/features/media-jobs/*`
- Knowledge: `desktop/src/pages/Knowledge.tsx`, `desktop/src/features/knowledge/*`
- RedClaw: `desktop/src/pages/RedClaw.tsx`, `desktop/src/pages/redclaw/*`, `desktop/src/features/redclaw/*`
- Subjects and asset library: `desktop/src/pages/Subjects.tsx`
- Manuscripts and editor: `desktop/src/components/manuscripts/*`, `desktop/src/features/manuscripts/*`
- Settings and control plane: `desktop/src/pages/Settings.tsx`, `desktop/src/pages/settings/*`, `desktop/src/features/settings/*`
- Plugin capture: `Plugin/`, `desktop/src-tauri/src/commands/plugin.rs`, `desktop/src-tauri/src/knowledge.rs`

### Host And Runtime

- Host assembly: `desktop/src-tauri/src/main.rs`
- Channel routing: `desktop/src-tauri/src/channel_router.rs`
- Managed state: `desktop/src-tauri/src/app_state.rs`
- Store and persistence: `desktop/src-tauri/src/store/types.rs`, `desktop/src-tauri/src/persistence/mod.rs`, `desktop/src-tauri/src/workspace_loaders.rs`
- AI runtime: `desktop/src-tauri/src/runtime/*`, `desktop/src-tauri/src/agent/*`, `desktop/src-tauri/src/skills/*`, `desktop/src-tauri/src/mcp/*`, `desktop/src-tauri/src/tools/*`
- Media runtime: `desktop/src-tauri/src/media_runtime/*`, `desktop/src-tauri/src/media_generation.rs`, `desktop/src-tauri/src/commands/generation.rs`, `desktop/src-tauri/src/commands/media_jobs.rs`
- Knowledge runtime: `desktop/src-tauri/src/knowledge.rs`, `desktop/src-tauri/src/knowledge_index/*`

### High Risk Coupling Points

1. `desktop/src/bridge/ipcRenderer.ts` still carries multiple domains directly, including runtime, team/collab, subjects, voice, plugins, chat and settings-adjacent APIs.
2. Large pages still combine UI composition, local state, IPC calls, event subscriptions and projection logic.
3. Large host commands still mix channel dispatch, validation, persistence patching and domain logic.
4. `AppStore` is a single large aggregate; direct field access makes unrelated domains easy to couple.
5. Runtime truth is split across `chat_runtime_states`, `runtime_tasks`, media runtime DB/state, RedClaw runtime and active request locks.
6. High-frequency events can still fan out too widely if renderer stores subscribe by whole object instead of id/surface.

## Recommended Strategy

Use boundary hardening, not rewrite.

| Option | What It Means | Pros | Cons | Decision |
| --- | --- | --- | --- | --- |
| Big-bang rewrite | Rebuild store, commands, bridge and pages around new module package layout | Clean final shape | High regression risk; hard to preserve workspace/runtime truth | Reject |
| Full protocol codegen first | Generate TS bridge types from Rust schemas | Strong type safety | Current channel surface still moving; high upfront cost | Defer |
| Boundary hardening | Keep behavior and channel names, move logic behind domain facades/services/selectors | Low risk; atomic; testable; matches current repo direction | Requires discipline across multiple slices | Recommend |
| UI-led simplification | Hide complexity by adding UI states, warnings or loading panels | Fast surface relief | Does not reduce coupling; can hide runtime bugs | Reject |

## Target Architecture

Every product module should have four explicit layers:

1. Renderer shell: page or feature component that owns layout and user interaction only.
2. Bridge contract: `window.ipcRenderer.<domain>` typed facade; no page-level raw channel construction.
3. Host command/service: `commands/<domain>` dispatches IPC; service/runtime/persistence modules own domain behavior.
4. Data and event contract: typed store snapshots, workspace schema, runtime events and job projections.

The dependency direction should be:

```text
Page/UI -> feature model/hooks -> bridge domain facade -> host command -> service/runtime/persistence -> store/workspace/provider
```

Reverse dependencies are not allowed. Host modules should emit events or return typed snapshots instead of importing UI assumptions.

## Module Plans

## Execution Log

### 2026-06-05

- Completed the bridge contract layer hardening for the current renderer assembly path.
- Reduced `desktop/src/bridge/ipcRenderer.ts` to a compatibility installer and domain assembly file.
- Moved runtime, team runtime, CLI runtime, audio voice, plugins, tools, auth, MCP, chat, subjects, brand workspace, cover, video editor, advisors, spaces, AI config, assistant control and legacy skills alias facades into `desktop/src/bridge/domains/*`.
- Routed the generated official AI panel through `window.ipcRenderer.officialAuth.*` instead of local raw `window.ipcRenderer.invoke(channel, payload)` calls.
- Verified each atomic bridge slice with `pnpm --dir desktop exec tsc --noEmit` and `pnpm --dir desktop build`.
- Added an App Shell `AppIntent` contract plus legacy navigation detail normalization in `features/app-shell`.
- Centralized renderer navigation event dispatch through `dispatchAppIntent` / `dispatchAppNavigateDetail`, while preserving existing legacy notification payloads.
- Extracted pure YouTube clipboard parsing into `features/capture/youtubeClipboard.ts`, leaving clipboard polling and save orchestration in the capture hook.
- Moved RedClaw and Advisors context-session guarded calls to domain bridge methods instead of page-level raw channel construction.
- Routed Wander brainstorm dispatch through the Wander bridge domain, leaving no page-level raw `window.ipcRenderer.send/invoke` calls in `desktop/src`.
- Routed Wander progress/result event subscriptions through the Wander bridge domain, reducing page-level raw event channel coupling.
- Routed Automation RedClaw runner status subscriptions through the RedClaw runner bridge facade.
- Routed Layout space change and app update subscriptions through spaces/system bridge facades.
- Routed shared page refresh and LLM readiness settings/data subscriptions through bridge event facades.
- Routed notification settings and RedClaw task event subscriptions through system/RedClaw bridge facades.
- Routed the shared runtime event stream subscription through the runtime bridge facade.
- Routed startup migration status subscriptions through the startup migration bridge facade.
- Routed CoverStudio, Wander and Home refresh event subscriptions through spaces/system/plugins bridge facades.
- Routed archive sample-created subscriptions through the archives bridge facade.
- Routed RedClaw page space, runner status and chat session title subscriptions through bridge facades.
- Routed Advisors download and YouTube fetch progress subscriptions through the advisors bridge facade.
- Routed ManuscriptEditorHost data, render progress and write proposal subscriptions through bridge facades.
- Routed Chat page advisors, knowledge, space, settings and auth refresh subscriptions through bridge facades.
- Routed renderer diagnostics report-pending subscription through the logs bridge facade.
- Added Knowledge, assistant daemon and background task event facades for remaining dirty-page migrations.
- Routed the remaining GenerationStudio, Knowledge and Settings page event subscriptions through bridge facades; strict raw page IPC event scan is now clean.
- Added `pnpm --dir desktop check:ipc-boundaries` to prevent new renderer raw IPC channel calls from bypassing bridge domain facades.
- Extracted feedback report dialog state and global open/submitted events into an App Shell hook, keeping `App.tsx` closer to composition-only.
- Extracted official auth notice lifecycle and stale auth snapshot cleanup into an App Shell hook.
- Extracted Subjects asset-library modal state and Escape handling into an App Shell hook.
- Added `store::subjects` owned snapshot helpers and routed subject list/get/search/category reads through them as the first store domain helper slice.
- Moved RedClaw media plan export file writes outside the `with_store_mut` lock; the lock now only snapshots and applies metadata updates.
- Added `pnpm --dir desktop check:store-locks` to prevent obvious slow file/process/network work inside `with_store` / `with_store_mut` closures.
- Added `pnpm --dir desktop check:architecture` as the combined renderer IPC and store lock boundary guard.
- Added `store::redclaw` owned snapshot helpers and routed RedClaw status/project/task/job read channels through them.
- Extracted App Shell execution persistence handlers into `useExecutionPersistence`.
- Added `store::settings` snapshot helper and routed LLM readiness settings reads through it.
- Moved `embedding:get-sorted-sources` embedding computation outside the store lock; the lock now only snapshots settings and source texts.
- Extended `check:store-locks` to reject embedding computation inside store lock closures.
- Routed media upload/transcription command settings reads through `store::settings`.
- Routed runtime task creation, runtime query and task resume settings reads through `store::settings`; runtime query now snapshots settings and mode in one store read.
- Routed remote notification command settings reads through `store::settings`.
- Routed space delete/switch workspace-root cache settings reads through `store::settings`.
- Routed image/video generation command settings reads through `store::settings`.
- Routed manuscript transcription and Remotion generation settings reads through `store::settings`.

### 1. Bridge Contract Layer

Current files:

- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/bridge/core.ts`
- `desktop/src/bridge/fallbacks.ts`
- `desktop/src/bridge/domains/*`

Target implementation:

- Keep `ipcRenderer.ts` as installer and compatibility assembly only.
- Move direct facade blocks into domain files:
  - `domains/authBridge.ts`
  - `domains/runtimeBridge.ts`
  - `domains/chatBridge.ts`
  - `domains/teamRuntimeBridge.ts`
  - `domains/subjectsBridge.ts`
  - `domains/voiceBridge.ts`
  - `domains/pluginsBridge.ts`
  - `domains/cliRuntimeBridge.ts`
  - `domains/settingsBridge.ts`
- Preserve existing external shape. Example: `window.ipcRenderer.runtime.query(...)` remains identical after migration.
- Merge duplicated `teamRuntime` and `collab` implementation by exporting two aliases backed by one factory.
- Move the generated official panel's local `window.ipcRenderer.invoke(channel, payload)` wrapper into an official/auth bridge method.

Implementation details:

- Each domain bridge receives `BridgeCore`.
- Each method uses typed payload and typed return where known.
- Fallbacks are registered in `fallbacks.ts`, not guessed in pages.
- Long-running calls use `invokeChannelGuarded` or `invokeCommandGuarded` with explicit timeout and normalization.

Must use existing libraries:

- Tauri `invoke` through existing bridge core.
- TypeScript type aliases and existing Vite build tooling.

Must be self-developed:

- Domain facade shapes.
- Fallback normalization.
- IPC inventory discipline.

Performance strategy:

- Page code should call summary methods for first paint.
- Details load lazily by id.
- Bridge should not do heavy projection; projection belongs in feature model modules.

Verification:

- Run `pnpm --dir desktop ipc:inventory`.
- From real pages, verify one success and one failure/fallback path for each migrated domain.

### 2. App Shell

Current files:

- `desktop/src/App.tsx`
- `desktop/src/components/Layout.tsx`
- `desktop/src/features/app-shell/*`
- `desktop/src/features/capture/*`

Target implementation:

- Keep `App.tsx` as route composition and global mount surface.
- Keep `Layout.tsx` focused on navigation, current view and global shell controls.
- Move global intent routing to `features/app-shell/useGlobalIntentRouter.ts`.
- Move clipboard/external capture parsing to `features/capture/*`.
- Define a small `AppIntent` contract for cross-page navigation:

```ts
type AppIntent =
  | { type: 'knowledge.capture.requested'; source: 'clipboard' | 'plugin'; payload: unknown }
  | { type: 'generation.open'; mode?: 'image' | 'video' | 'audio' | 'cover' | 'digitalHuman'; bindTarget?: unknown }
  | { type: 'redclaw.openSession'; sessionId?: string; taskId?: string }
  | { type: 'manuscript.open'; manuscriptPath: string };
```

Implementation details:

- App shell consumes intent and passes typed callbacks to pages.
- Product modules never mutate shell state directly.
- Page switching must render shell first and hydrate page data later.

Must use existing libraries:

- React state/effects.
- Existing app shell hooks.

Must be self-developed:

- `AppIntent` type.
- Intent reducer and dedupe policy.

Performance strategy:

- No slow IPC on view activation path.
- Preserve previous page state while background refresh runs.

Verification:

- Switch among Chat, Knowledge, Generation, Settings and RedClaw.
- Confirm no full-page loading clears prior data on refresh failure.

### 3. Host Command And Service Layer

Current files:

- `desktop/src-tauri/src/channel_router.rs`
- `desktop/src-tauri/src/commands/*.rs`
- Large files: `manuscripts.rs`, `chat_sessions_wander.rs`, `official.rs`, `redclaw.rs`, `library.rs`

Target implementation:

- Keep `channel_router.rs` as ordered fan-out only.
- Each `commands/<domain>.rs` should parse channel, validate payload and call service functions.
- Move domain logic into service modules close to the domain:
  - `commands/manuscripts/mod.rs`
  - `commands/manuscripts/tree.rs`
  - `commands/manuscripts/package.rs`
  - `commands/manuscripts/timeline.rs`
  - `commands/manuscripts/render.rs`
  - `commands/chat_sessions/mod.rs`
  - `commands/chat_attachments.rs`
  - `commands/wander.rs`
  - `commands/official/auth.rs`
  - `commands/official/billing.rs`
  - `commands/official/models.rs`
  - `commands/official/api_keys.rs`
  - `knowledge/http_routes.rs`
  - `knowledge/youtube.rs`
  - `knowledge/xhs.rs`
  - `knowledge/documents.rs`

Implementation details:

- Do not rename channels in the first pass.
- Command dispatch returns `Option<Result<Value, String>>` as current router expects.
- Domain service functions return typed structs where possible; command handler serializes to `Value`.
- Common JSON parsing helpers stay shared; business-specific parsing stays in domain.

Must use existing libraries:

- `serde`, `serde_json`.
- Existing Rust module system.

Must be self-developed:

- Domain command dispatch contracts.
- Payload validators.
- Service boundaries.

Performance strategy:

- Host page-load commands default to async-compatible behavior.
- CPU or file-heavy work uses `spawn_blocking`.
- Do not hold `AppStore` lock across filesystem, provider calls, subprocess waits or indexing.

Verification:

- `cd desktop/src-tauri && cargo fmt --check && cargo check`
- Real renderer call for every migrated command family.

### 4. Store, Persistence And Workspace

Current files:

- `desktop/src-tauri/src/store/types.rs`
- `desktop/src-tauri/src/persistence/mod.rs`
- `desktop/src-tauri/src/workspace_loaders.rs`
- `desktop/docs/contracts/workspace-schema.md`

Target implementation:

- Do not split persisted store format first.
- Add domain repository helpers that return owned snapshots:
  - `store/chat.rs`
  - `store/media.rs`
  - `store/knowledge.rs`
  - `store/subjects.rs`
  - `store/runtime_tasks.rs`
  - `store/redclaw.rs`
- Keep `AppStore` as aggregate during transition.
- Restrict direct `store.<field>` access in new code. New command/service code should go through domain helper functions.
- Move workspace hydration helpers toward:
  - `workspace_loaders/knowledge.rs`
  - `workspace_loaders/media.rs`
  - `workspace_loaders/manuscripts.rs`
  - `workspace_loaders/subjects.rs`
  - `workspace_loaders/redclaw.rs`

Implementation details:

- `with_store` returns compact owned snapshots.
- `with_store_mut` applies memory-only patch and returns patch/result.
- Persistence scheduling remains centralized.
- Store schema changes update `desktop/docs/contracts/workspace-schema.md`.

Must use existing libraries:

- `serde`/`serde_json`.
- Existing filesystem persistence.
- `rusqlite` only where canonical DB already exists, such as knowledge index.

Must be self-developed:

- Domain snapshot APIs.
- Workspace-first semantics.
- Migration and retention behavior.

Performance strategy:

- Summary first, details on demand.
- No renderer-side workspace scan.
- No lock-held file I/O.
- Retention and cleanup should run after releasing store lock when possible.

Verification:

- Load existing workspace.
- Switch spaces.
- Restart app and verify chat sessions, knowledge, media assets, subjects and settings survive.

### 5. AI Runtime, Tools, Skills And MCP

Current files:

- `desktop/src-tauri/src/runtime/*`
- `desktop/src-tauri/src/agent/*`
- `desktop/src-tauri/src/skills/*`
- `desktop/src-tauri/src/mcp/*`
- `desktop/src-tauri/src/tools/*`
- `desktop/prompts/*`

Target implementation:

- Runtime mode carries explicit typed metadata:

```rust
pub(crate) struct RuntimeSurfaceContext {
    pub(crate) surface: String,
    pub(crate) intent: Option<String>,
    pub(crate) active_resource: Option<String>,
    pub(crate) allowed_action_families: Vec<String>,
    pub(crate) current_attachments: Vec<RuntimeAttachmentRef>,
    pub(crate) target_project: Option<String>,
}
```

- Skills and prompts define capability boundaries.
- Runtime/tool layer validates actions and permissions.
- Host must not force skills or roles from natural language keywords.
- Model-visible tools stay small and composable. New business ability should become an action under existing canonical tool surfaces where possible.

Implementation details:

- Keep runtime events structured.
- Add or preserve event fields for `sessionId`, `taskId`, `jobId`, `surface`, `eventType`, `sequence`.
- Tool results must return structured payload plus budgeted summary.
- Long-running tasks write checkpoints and resume metadata.

Must use existing libraries:

- OpenAI-compatible transport and `reqwest`.
- `serde` JSON schemas/contracts.
- MCP manager and current skills loader.

Must be self-developed:

- Runtime event protocol.
- Tool pack and guard policy.
- Skill activation policy.
- Context bundle construction.
- Runtime checkpoint and recovery semantics.

Performance strategy:

- Event stream scoped by session/task.
- Batch token/thought/log deltas.
- Do not replay full transcript for every UI event.
- Tool result payloads are capped and summarized.

Verification:

- Run one normal chat task.
- Run one generation-agent task.
- Run one RedClaw task if changed.
- Inspect `~/Library/Application Support/RedBox/session-transcripts/` and `session-bundles/` for event/tool/result truth.

### 6. Media Generation, Video Processing And Asset Runtime

Current files:

- `desktop/src/pages/GenerationStudio.tsx`
- `desktop/src/features/media-generation/*`
- `desktop/src/features/media-jobs/*`
- `desktop/src-tauri/src/media_runtime/*`
- `desktop/src-tauri/src/media_generation.rs`
- `desktop/src-tauri/src/commands/generation.rs`
- `desktop/src-tauri/src/commands/media_jobs.rs`
- `desktop/src-tauri/src/commands/voice.rs`

Target implementation:

- Keep `media_runtime/` as job runtime.
- Split provider/request logic:
  - `media_generation/image.rs`
  - `media_generation/video.rs`
  - `media_generation/audio.rs`
  - `media_generation/digital_human.rs`
  - `media_generation/assets.rs`
  - `media_generation/provider_templates.rs`
- Move renderer-side mode logic from page into:
  - `features/generation/image/*`
  - `features/generation/video/*`
  - `features/generation/audio/*`
  - `features/generation/cover/*`
  - `features/generation/digitalHuman/*`
  - `features/generation/shared/*`

Implementation details:

- Manual mode builds typed generation request.
- Agent mode uses typed runtime context and `Operate` action.
- Media runtime owns queue, retries, provider task IDs, artifact materialization and cancel/retry state.
- UI consumes job projections, not provider internals.
- Digital human flow remains staged:
  1. Check subject voice/video readiness.
  2. Generate or select audio.
  3. Submit VideoRetalk.
  4. Download and bind artifact.
  5. Register media asset.

Must use existing libraries:

- FFmpeg for probing/conversion/composition.
- Provider APIs for generation.
- Browser media APIs for preview/poster only.
- Existing `reqwest` client for network transfer.

Must be self-developed:

- Generation request schema.
- Job projection and artifact registry.
- Provider template normalization.
- Subject and digital-human readiness policy.
- Queue recovery and artifact binding logic.

Performance strategy:

- Dense feeds render poster/thumbnail, not full `<video>`.
- Job store selectors subscribe by `jobId`, `ownerSessionId`, `source` or visible surface.
- Large reference files are preflighted/materialized once.
- Downloads use durable file write with temp path then rename.
- Provider poll and download stages use separate concurrency slots.

Verification:

- Submit image job.
- Submit video job or poll existing video job.
- Submit audio/TTS job.
- Restart app and verify queue/job projection recovers.
- Verify generated artifact appears in media library and can be opened.

### 7. Knowledge Capture, Catalog And Retrieval

Current files:

- `desktop/src/pages/Knowledge.tsx`
- `desktop/src/features/knowledge/*`
- `desktop/src-tauri/src/knowledge.rs`
- `desktop/src-tauri/src/knowledge_index/*`
- `desktop/src-tauri/src/document_ingest/*`
- `desktop/src-tauri/src/document_parse/*`
- `desktop/src-tauri/src/commands/library.rs`
- `Plugin/`

Target implementation:

- Keep `knowledge_index/` as canonical retrieval stack.
- Split source-specific ingest from `knowledge.rs`:
  - `knowledge/http_routes.rs`
  - `knowledge/xhs.rs`
  - `knowledge/youtube.rs`
  - `knowledge/documents.rs`
  - `knowledge/source_normalizers.rs`
- Renderer split:
  - `features/knowledge/catalog/*`
  - `features/knowledge/detail/*`
  - `features/knowledge/importActions/*`
  - `features/knowledge/indexDashboard/*`
  - `features/knowledge/referencePicker/*`

Implementation details:

- Plugin sends structured capture payload only.
- Desktop owns ingestion, indexing and workspace writes.
- Catalog list returns summaries.
- Detail/transcript/visual blocks load by id.
- Retrieval audit returns evidence pack with stable source anchors.

Must use existing libraries:

- Tantivy for full-text search.
- rusqlite for canonical block store.
- notify for watchers.
- External visual/OCR providers for image semantics.

Must be self-developed:

- Knowledge source schema.
- Visual metadata block schema.
- Retrieval audit and evidence pack.
- Workspace-first import semantics.
- Source normalizers.

Performance strategy:

- Index rebuild runs in background.
- Stale catalog stays visible during rebuild.
- Do not run document parsing on page activation.

Verification:

- Import or inspect existing captured item.
- List catalog.
- Open detail.
- Run search/retrieval.
- Restart and verify catalog/index state.

### 8. Chat And Conversation UI

Current files:

- `desktop/src/pages/Chat.tsx`
- `desktop/src/components/ChatComposer.tsx`
- `desktop/src/components/MessageItem.tsx`
- `desktop/src/features/chat/*`
- `desktop/src-tauri/src/commands/chat.rs`
- `desktop/src-tauri/src/commands/chat_sessions_wander.rs`
- `desktop/src-tauri/src/runtime/session_runtime.rs`

Target implementation:

- Page becomes composition surface.
- Move renderer logic to:
  - `features/chat/sessionStore.ts`
  - `features/chat/useChatRuntimeStream.ts`
  - `features/chat/attachmentDelivery.ts`
  - `features/chat/chatShortcuts.ts`
  - `features/chat/errorNotice.ts`
- Host split:
  - `commands/chat.rs` for send/cancel/confirm.
  - `commands/chat_sessions/*` for session CRUD.
  - `commands/chat_attachments.rs` for attachment materialization.
  - `commands/wander.rs` for wander-specific session behavior.

Implementation details:

- Runtime stream merge is id-scoped.
- Attachment drafts are materialized once.
- Message rendering receives normalized message view models.
- Tool timeline and approval events are separate projections.

Must use existing libraries:

- React and current markdown renderer.
- Existing runtime/session persistence.

Must be self-developed:

- Chat message view model.
- Stream batching and flush policy.
- Attachment delivery contract.

Performance strategy:

- Batch streaming deltas.
- Flush pending chunks on response end, cancel, error, clear and unmount.
- Limit markdown reparse to changed message blocks.

Verification:

- Send normal chat.
- Send attachment.
- Cancel active response.
- Confirm/deny a tool call.
- Switch away and back without losing pending streamed content.

### 9. RedClaw Automation

Current files:

- `desktop/src/pages/RedClaw.tsx`
- `desktop/src/pages/redclaw/*`
- `desktop/src/features/redclaw/*`
- `desktop/src-tauri/src/commands/redclaw.rs`
- `desktop/src-tauri/src/commands/redclaw_runtime.rs`
- `desktop/src-tauri/src/commands/redclaw_task_control.rs`
- `desktop/src-tauri/src/runtime/redclaw_orchestration.rs`
- `desktop/src-tauri/src/scheduler/*`

Target implementation:

- Keep RedClaw page as composition.
- Move session/sidebar/history/domain shaping into `features/redclaw/*`.
- Keep scheduler primitives outside RedClaw page.
- RedClaw runtime sessions carry explicit metadata:
  - `surface`
  - `runtimeSurface`
  - `runtimeMode`
  - `redclawContext`
  - `taskId`
  - `projectId`

Implementation details:

- `commands/redclaw.rs` routes project/profile/orchestration actions only.
- Task CRUD remains in `redclaw_task_control.rs`.
- Scheduler computes leases and next run.
- Runtime writes checkpoints and task execution records.

Must use existing libraries:

- Existing scheduler/runtime stack.
- serde contracts.

Must be self-developed:

- RedClaw context schema.
- Task execution state transitions.
- Project/profile bundle semantics.

Performance strategy:

- Runner restore happens in startup, not page mount.
- Page observes task/session projections only.
- Do not refresh full RedClaw state after every log event.

Verification:

- Open RedClaw.
- List scheduled tasks.
- Run or resume one task where available.
- Inspect runtime event and task execution record.

### 10. Subjects, Roles And Asset Library

Current files:

- `desktop/src/pages/Subjects.tsx`
- `desktop/src-tauri/src/commands/subjects.rs`
- `desktop/src-tauri/src/voice_service.rs`
- `desktop/src-tauri/src/media_runtime/*`

Target implementation:

- Split renderer:
  - `features/subjects/catalog/*`
  - `features/subjects/editor/*`
  - `features/subjects/mediaSlots/*`
  - `features/subjects/voiceSlots/*`
  - `features/subjects/assetPicker/*`
- Keep `commands/subjects.rs` as IPC entry.
- Move voice-slot interpretation into `subjects/voice_slots.rs` or shared `voice_service` helper.

Implementation details:

- Subject list returns metadata and first preview.
- Detail modal loads voice/video/media slots on demand.
- Digital human readiness derives from subject snapshot and media/voice refs.

Must use existing libraries:

- Existing media runtime and voice provider APIs.

Must be self-developed:

- Subject readiness policy.
- Asset slot binding semantics.
- Subject projection helpers.

Performance strategy:

- Heavy voice/video assets load only in detail.
- Autosave persists compact payload after debounce.

Verification:

- List subjects.
- Open detail.
- Update a subject.
- Validate digital-human readiness projection.

### 11. Manuscripts And Video Editor

Current files:

- `desktop/src/components/manuscripts/*`
- `desktop/src/features/manuscripts/*`
- `desktop/src-tauri/src/commands/manuscripts.rs`
- `desktop/src-tauri/src/manuscript_package.rs`
- `desktop/remotion/*`

Target implementation:

- Keep editor host as shell.
- Split renderer:
  - `features/manuscripts/tree/*`
  - `features/manuscripts/draftEditor/*`
  - `features/manuscripts/assetBinding/*`
  - `features/video-editor/timeline/*`
  - `features/video-editor/remotion/*`
  - `features/video-editor/projectState/*`
- Split host:
  - `commands/manuscripts/mod.rs`
  - `commands/manuscripts/tree.rs`
  - `commands/manuscripts/package.rs`
  - `commands/manuscripts/timeline.rs`
  - `commands/manuscripts/render.rs`
  - `commands/manuscripts/assets.rs`

Implementation details:

- Package mutation is typed and host-owned.
- Editor UI sends actions; host applies canonical mutation.
- Undo/redo schema stays explicit.
- Render/export is background job.

Must use existing libraries:

- CodeMirror for text editing.
- Remotion for video render graph and rendering.
- FFmpeg for media operations.
- Wavesurfer/browser audio APIs for waveform and preview.

Must be self-developed:

- Manuscript package schema.
- Timeline mutation contract.
- Editor runtime state and undo/redo schema.
- Asset binding semantics.

Performance strategy:

- Timeline drag/resize uses refs/CSS during movement and commits state at end.
- No synchronous localStorage, IPC or scans during mousemove.
- Preview loads selected package/clip details only.

Verification:

- Open manuscript tree.
- Edit draft.
- Bind generated asset.
- Preview timeline if available.
- Export/render smoke test for changed render path.

### 12. Settings, Accounts And Control Plane

Current files:

- `desktop/src/pages/Settings.tsx`
- `desktop/src/pages/settings/*`
- `desktop/src/features/settings/*`
- `desktop/src/features/official/*`
- `desktop/src-tauri/src/commands/official.rs`
- `desktop/src-tauri/src/ai_model_manager/*`
- `desktop/src-tauri/src/commands/plugin.rs`
- `desktop/src-tauri/src/commands/cli_runtime.rs`
- `desktop/src-tauri/src/commands/mcp_tools.rs`
- `desktop/src-tauri/src/commands/skills_ai.rs`

Target implementation:

- Settings page becomes section router and save coordinator.
- Split renderer:
  - `features/settings/aiSources/*`
  - `features/settings/accountBilling/*`
  - `features/settings/skills/*`
  - `features/settings/plugins/*`
  - `features/settings/mcp/*`
  - `features/settings/cliRuntime/*`
  - `features/settings/diagnostics/*`
  - `features/settings/runtimeDebug/*`
- Split official host:
  - `commands/official/auth.rs`
  - `commands/official/billing.rs`
  - `commands/official/models.rs`
  - `commands/official/api_keys.rs`

Implementation details:

- Active settings tab loads on demand.
- Expensive diagnostics/runtime sections cache last successful snapshot.
- Model route data stays canonical in `ai_model_manager`.

Must use existing libraries:

- Existing official/auth APIs.
- Existing MCP, skill and CLI runtime modules.

Must be self-developed:

- Settings section data contracts.
- Save coordinator.
- Readiness projection.

Performance strategy:

- Do not hydrate all settings sections on page open.
- Keep stale data visible during refresh.
- Paginate runtime trace/debug data.

Verification:

- Open Settings.
- Switch tabs.
- Save one AI/model setting.
- Refresh official account snapshot.
- Verify failure preserves last successful display.

### 13. Plugin And External Capture

Current files:

- `Plugin/`
- `desktop/src-tauri/src/commands/plugin.rs`
- `desktop/src-tauri/src/knowledge.rs`
- `desktop/redbox-market/*`

Target implementation:

- Browser plugin remains capture/export focused.
- Desktop owns ingestion, indexing, AI workflows and media processing.
- Plugin data access routes through explicit capability-checked commands.

Implementation details:

- Capture payload is structured and minimal.
- Large media files are streamed or saved by desktop.
- Plugin never owns heavy runtime decisions.

Must use existing libraries:

- Browser extension APIs.
- Existing local HTTP/IPC bridge.

Must be self-developed:

- Capture payload schema.
- Plugin capability checks.
- Desktop ingest mapping.

Performance strategy:

- Avoid pushing large blobs through renderer state.
- Keep plugin ingestion idempotent.

Verification:

- Reload plugin.
- Capture one item.
- Verify desktop knowledge record appears.

### 14. Notifications And Diagnostics

Current files:

- `desktop/src/notifications/*`
- `desktop/src/components/NotificationCenterDrawer.tsx`
- `desktop/src/components/FeedbackReportDialog.tsx`
- `desktop/src/logging/client.ts`
- `desktop/src-tauri/src/logging/*`
- `desktop/src-tauri/src/diagnostics.rs`
- `desktop/src-tauri/src/commands/notifications.rs`

Target implementation:

- Notification store remains independent.
- Domain modules emit structured events.
- Notification action router resolves actions to bridge domain calls.
- Diagnostics bundle uses host and renderer logs plus runtime/session truth.

Implementation details:

- No domain-specific retry logic in notification module.
- Runtime/media/RedClaw completion events become notification inputs.
- Feedback reports include current surface, recent events and redacted logs.

Must use existing libraries:

- Existing notification plugin and logging stack.

Must be self-developed:

- Notification action routing.
- Diagnostics redaction and report composition.

Performance strategy:

- Stable selectors for notification store.
- Policy-gate audio/system notifications.

Verification:

- Trigger local notification.
- Open drawer.
- Run feedback report flow.
- Confirm redaction.

## Atomic Execution Plan

Each item below should be one atomic commit unless the actual diff is too large, in which case split by domain but keep one behavior per commit.

### Commit 1: Bridge Domain Migration Baseline

Scope:

- Move `runtime`, `taskPanel`, `backgroundTasks`, `backgroundWorkers`, `work` facade blocks from `ipcRenderer.ts` to `domains/runtimeBridge.ts`.
- Preserve `window.ipcRenderer.runtime` external shape.

Verification:

- `pnpm --dir desktop build`
- Real page/runtime query smoke if app is running.
- `pnpm --dir desktop ipc:inventory`

### Commit 2: Team/Collab Bridge Deduplication

Scope:

- Move `teamRuntime` and `collab` into `domains/teamRuntimeBridge.ts`.
- Back both names with one implementation factory.
- Do not reintroduce team UI surfaces.

Verification:

- TypeScript build.
- Existing pages importing `window.ipcRenderer.collab` or `teamRuntime` still compile.

### Commit 3: Chat Bridge And Attachment Facade

Scope:

- Move `chat`, `sessions`, `sessionBridge` into `domains/chatBridge.ts`.
- Keep attachment preflight in a shared helper.

Verification:

- Send message.
- Pick/create attachment.
- Cancel active response.

### Commit 4: Control Plane Bridge Split

Scope:

- Move `officialAuth`, `auth`, `llmReadiness`, `mcp`, `cliRuntime`, `plugins`, `toolDiagnostics`, `toolHooks`, `audio`, `voice` into domain bridge files.
- Remove generated panel raw invoke wrapper by using official/auth bridge.

Verification:

- Open Settings.
- Refresh auth/readiness.
- List plugins/MCP/CLI runtime.

### Commit 5: Generation Page Logic Extraction

Scope:

- Move mode-specific form normalization and submit orchestration out of `GenerationStudio.tsx`.
- Keep UI layout unchanged.

Verification:

- Manual image submit.
- Manual video/audio payload build.
- Existing feed persistence remains compatible.

### Commit 6: Media Job Store Selector Hardening

Scope:

- Ensure media job subscriptions update by job id/source/owner instead of broad store fanout.
- Preserve queue truth and job projection shape.

Verification:

- Active media job progress updates visible surface only.
- Media library and generation feed remain in sync.

### Commit 7: Chat Runtime Stream Hook

Scope:

- Move stream merge and flush behavior into `features/chat/useChatRuntimeStream.ts`.
- Protect response end/cancel/error/unmount flush boundaries.

Verification:

- Streaming response completes without dropped tail.
- Cancel does not leave phantom pending message.

### Commit 8: Knowledge Feature Split

Scope:

- Move catalog/detail/import/index dashboard logic into feature hooks/models.
- Page keeps UI composition and dialogs.

Verification:

- Catalog list.
- Detail open.
- Search/rebuild status.
- Delete/import path if touched.

### Commit 9: Store Domain Snapshot Helpers

Scope:

- Add store helper modules for one domain first, recommended `store/media.rs` or `store/chat.rs`.
- Replace new/nearby direct store access in that domain only.

Verification:

- Cargo check.
- Restart persistence smoke for touched domain.

### Commit 10: Host Command Split For One Large Domain

Scope:

- Split `commands/manuscripts.rs` or `commands/chat_sessions_wander.rs` by dispatcher plus service modules.
- Do not rename channels.

Verification:

- Cargo fmt/check.
- Real renderer calls for affected channel family.

### Commit 11: Knowledge Host Source Split

Scope:

- Move source-specific normalization and write helpers from `knowledge.rs` into `knowledge/*`.
- Keep ingest behavior and workspace paths unchanged.

Verification:

- Capture/import smoke.
- Catalog detail smoke.
- Knowledge index status.

### Commit 12: Runtime Context Contract Tightening

Scope:

- Introduce or normalize typed runtime surface context.
- Ensure RedClaw, Generation Agent and Manuscript editor pass explicit metadata.
- Do not add keyword-based activation.

Verification:

- One chat task.
- One RedClaw or Generation Agent task.
- Inspect session transcript and bundle.

## Cross Cutting Performance Rules

- Use stale-while-revalidate everywhere user-visible data exists.
- Render shell first, hydrate later.
- First IPC payload returns summary, id, path, count and preview only.
- Heavy details load by id.
- High-frequency events are batched.
- Store selectors must be stable and scoped.
- Dense media surfaces use thumbnail/poster.
- No full page refresh after every runtime/media/log event.
- No lock-held file I/O or network work.
- No renderer-side workspace scanning.

## Stability Rules

- Every runtime task should have a durable task id.
- Every provider job should record provider, request payload hash, provider task id if available, status, retry count and artifact refs.
- Every long-running task should emit checkpoint/progress/error/completion events.
- Every renderer subscription should unsubscribe on unmount.
- Every page refresh failure should preserve last successful data.
- Every command that mutates store should validate payload before mutation.
- Every workspace write should use safe path normalization.
- Every generated artifact write should use temp file plus final rename.

## Verification Matrix

| Change Type | Minimum Verification |
| --- | --- |
| Bridge/domain facade | TypeScript build, real page call, fallback path |
| Renderer page extraction | Page switch, existing data preserved, refresh failure keeps stale data |
| Host command split | `cargo fmt --check`, `cargo check`, real renderer call |
| Runtime/tool/prompt | One real task, event stream, tool calls, final summary, transcript/bundle check |
| Media runtime | Submit/poll/download path, artifact materialized, restart recovery |
| Knowledge | Catalog, detail, import/capture, index status, restart |
| Store/persistence | Restart app, verify touched records survive |
| Plugin | Reload extension, capture path, desktop ingest |

## Success Metrics

- `ipcRenderer.ts` becomes assembly-only and stays under 200 lines.
- No new raw `window.ipcRenderer.invoke(...)` in pages/features.
- Large pages trend downward by moving pure logic and subscriptions into feature modules.
- Large host command files become dispatchers or are split by action family.
- Media job updates do not cause unrelated pages to rerender.
- Runtime events can be traced by `sessionId`, `taskId` or `jobId`.
- App restart preserves active/recent runtime, media and workspace state.
- New work can be committed as one behavior per atomic commit.

## Recommended First Slice

Start with bridge domain migration, because it has the lowest business risk and creates the contract shape needed by later page and host splits.

First slice details:

1. Create `desktop/src/bridge/domains/runtimeBridge.ts`.
2. Move `runtime`, `taskPanel`, `backgroundTasks`, `backgroundWorkers`, `tasks`, `work` blocks from `ipcRenderer.ts`.
3. Export `createRuntimeBridge(core)`.
4. Spread it from `ipcRenderer.ts`.
5. Keep all method names, payloads and channel strings unchanged.
6. Run `pnpm --dir desktop build`.
7. Run `pnpm --dir desktop ipc:inventory`.
8. Commit only that migration.

This creates a safe template for the remaining bridge slices.
