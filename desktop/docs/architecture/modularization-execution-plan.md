---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-22
---

# RedBox Modularization Execution Plan

Status: Current

## Scope

本文覆盖当前 `desktop/` 主产品，不覆盖 `archive/desktop-electron/`。目标是把现有 app 梳理成可维护的产品模块，明确每个模块的职责、入口、协作方式、业务流程、必须依赖的现成库、自研边界、性能策略和可执行拆分阶段。

本文不是 UI 扩展方案。默认原则是保留现有产品入口和交互，不因为模块化新增解释性 UI、不扩大工具面、不改变用户路径。

## Current Evidence

当前代码已经有模块雏形，但实现边界不均匀，维护风险集中在少数超级文件和散落协议。

| Area | Evidence | Risk |
| --- | --- | --- |
| Host assembly | `src-tauri/src/main.rs` 约 10746 行 | `AppStore`、`AppState`、workspace helper、runtime tool loop、startup restore、channel dispatch 混在入口层 |
| Manuscripts host | `src-tauri/src/commands/manuscripts.rs` 约 9798 行 | 稿件树、package、timeline、Remotion、FFmpeg、editor runtime state 共用一个 command 文件 |
| Settings page | `src/pages/Settings.tsx` 约 8470 行 | AI source、账号计费、技能、插件、MCP、CLI runtime、日志诊断、runtime debug 混成控制台 |
| Generation page | `src/pages/GenerationStudio.tsx` 约 5895 行 | 图片、视频、音频、封面、数字人、Agent session、feed、角色 readiness 混在一个页面 |
| Chat page | `src/pages/Chat.tsx` 约 4429 行 | 消息、附件、工具流、runtime event 合并、错误恢复、快捷动作混在页面层 |
| Bridge | `src/bridge/ipcRenderer.ts` 约 1553 行，约 400 个 `invokeChannel` 调用 | channel contract、fallback、browser host、业务 facade 在同一个文件 |
| Direct IPC usage | `src/` 中仍有约 118 处页面/组件直接 `window.ipcRenderer.invoke(...)` | 页面绕过 typed facade，contract 难以追踪 |
| Host channel surface | `src-tauri/src/commands` 与 `main.rs` 中有大量 channel 字符串 | 协议分散，容易出现 bridge、types、host 不一致 |

结论：当前问题不是“没有模块”，而是“模块边界没有成为实现边界”。目标不是重写，而是把已经存在的业务域从超级页面、超级 bridge、超级 host 入口中拆出来。

## Target Module Map

目标模块按产品域划分，每个模块都有稳定的四层边界：

1. Renderer entry: 页面入口或 feature 入口。
2. Bridge contract: `window.ipcRenderer.<domain>` typed facade。
3. Host command/service: `commands/<domain>` 只做 IPC 分发，复杂逻辑下沉 service/runtime/persistence。
4. Data/event contract: workspace schema、runtime event、domain event、job projection。

### 1. App Shell

**Current entry points**

- `src/App.tsx`
- `src/components/Layout.tsx`
- `src/components/AppDialogsHost.tsx`
- `src/components/StartupMigrationModal.tsx`
- `src/components/AppOnboarding/*`

**Responsibilities**

- 页面注册、懒加载、当前 view 切换。
- 顶层导航、标题栏、全局通知入口。
- 全局 modal host 和全局 dialog host。
- 跨页面 intent 传递，例如从知识库进入 RedClaw、从稿件进入生成器、从通知进入审批。
- 启动迁移 gate、登录 gate、首次引导 gate。

**Should not own**

- YouTube 剪贴板采集业务。
- 官方登录表单内部状态。
- RedClaw session auto-open 规则。
- 媒体生成 pending intent 的业务解释。

**Target implementation**

- 保留 `src/App.tsx` 作为 route composition。
- 新增或迁移到：
  - `src/features/app-shell/viewRegistry.ts`
  - `src/features/app-shell/useViewNavigation.ts`
  - `src/features/app-shell/useStartupMigrationGate.ts`
  - `src/features/app-shell/useGlobalIntentRouter.ts`
  - `src/features/app-shell/OfficialLoginGate.tsx`
  - `src/features/capture/useClipboardCapturePrompt.ts`

**Collaborates with**

- Knowledge module: clipboard/插件采集产生 `knowledge.capture.requested` intent。
- Chat/RedClaw module: navigation intent 变成 pending message 或 open session action。
- Settings/Auth module: login gate 只消费 auth readiness snapshot，不自己实现 auth protocol。

**Performance rules**

- view switch 只更新当前 view 和轻量 intent，不做慢 IPC。
- modal open/close 不触发页面全量重新 hydrate。
- global event listener 必须在 feature hook 中集中注册和清理。

### 2. IPC Bridge And Contract Layer

**Current entry points**

- `src/bridge/ipcRenderer.ts`
- `src/types.d.ts`
- `src/runtime/runtimeEventStream.ts`
- `src-tauri/src/main.rs::ipc_invoke`
- `src-tauri/src/commands/*`

**Responsibilities**

- 前端唯一 host facade。
- channel 到 direct command 的兼容映射。
- timeout、fallback、normalize。
- event subscribe/unsubscribe。
- browser host fallback for local HTTP bridge。

**Should not own**

- 业务默认值和页面专用 fallback 细节。
- 附件、媒体、auth、MCP、plugin 等领域逻辑。
- 复杂 payload 预处理，除非是跨页面通用 contract。

**Target implementation**

Keep one install entry, split domain facades:

- `src/bridge/core.ts`: `invokeChannel`, `sendChannel`, listener management。
- `src/bridge/fallbacks.ts`: stable fallback registry。
- `src/bridge/browserHost.ts`: browser HTTP bridge。
- `src/bridge/domains/chatBridge.ts`
- `src/bridge/domains/knowledgeBridge.ts`
- `src/bridge/domains/mediaBridge.ts`
- `src/bridge/domains/manuscriptsBridge.ts`
- `src/bridge/domains/settingsBridge.ts`
- `src/bridge/domains/runtimeBridge.ts`
- `src/bridge/domains/redclawBridge.ts`
- `src/bridge/domains/systemBridge.ts`

`src/bridge/ipcRenderer.ts` 最终只负责组装：

```ts
export function createIpcRenderer() {
  const core = createBridgeCore();
  return {
    ...createSystemBridge(core),
    chat: createChatBridge(core),
    knowledge: createKnowledgeBridge(core),
    generation: createGenerationBridge(core),
    // ...
  };
}
```

**Collaborates with**

- Host command modules define accepted channel names.
- `docs/ipc-inventory.md` records inventory after changes.
- `src/types.d.ts` should be derived from bridge shape or manually kept in sync until codegen exists.

**Recommended option**

| Option | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| Keep one large bridge | No migration cost | Contract keeps growing, fallback scattered | Not recommended |
| Full codegen client from Rust | Strong typing | Current channel surface still moving, high upfront cost | Later |
| Split bridge by domain manually | Low risk, matches current repo style, enables incremental typing | Needs discipline to avoid duplicate fallbacks | Recommended now |

### 3. Host App State And Composition

**Current entry points**

- `src-tauri/src/main.rs`
- `src-tauri/src/app_shared.rs`
- `src-tauri/src/persistence/mod.rs`

**Responsibilities**

- Tauri builder setup。
- Global state assembly。
- Startup restore order。
- Top-level channel dispatch。
- Store load/persist wiring。

**Should not own**

- Domain record definitions for every product area.
- Workspace path helpers for every area.
- Runtime tool loop internals.
- Media, knowledge, manuscript, auth, RedClaw implementation logic.

**Target implementation**

Split `main.rs` without changing app behavior:

- `src-tauri/src/app_state.rs`
  - `AppState`
  - global app/store registration
  - state initialization helpers
- `src-tauri/src/store/types.rs`
  - `AppStore`
  - store-owned record structs that are not already domain-owned
- `src-tauri/src/workspace/paths.rs`
  - workspace root, media root, cover root, redclaw root, manuscripts root
- `src-tauri/src/channel_router.rs`
  - `handle_channel(...)`
  - ordered dispatch to command domains
- `src-tauri/src/startup/mod.rs`
  - knowledge index init
  - auth init
  - RedClaw runtime restore
  - media runtime restore
  - assistant daemon restore
  - skill catalog refresh
  - runtime warmup

**Collaborates with**

- Persistence owns loading/hydration.
- Commands own IPC domain dispatch.
- Runtime owns execution state machines.
- Events own frontend event emission.

**Performance rules**

- `with_store` / `with_store_mut` closures stay memory-only.
- Startup restore tasks should avoid blocking first renderer paint.
- Heavy initialization should log structured status and degrade gracefully.

### 4. Workspace And Persistence

**Current entry points**

- `src-tauri/src/persistence/mod.rs`
- `src-tauri/src/workspace_loaders.rs`
- `src-tauri/src/legacy_import.rs`
- `src-tauri/src/startup_migration.rs`
- `docs/contracts/workspace-schema.md`

**Responsibilities**

- App state persistence。
- Workspace hydration。
- Legacy import and startup migration。
- Session artifact split。
- File-system truth for knowledge/media/manuscripts/subjects.

**Should not own**

- User-facing command decisions。
- Page-specific projections。
- Media processing or AI inference.

**Target implementation**

- Keep central persistence entry.
- Move domain hydration helpers closer to domain loaders:
  - `workspace_loaders/knowledge.rs`
  - `workspace_loaders/media.rs`
  - `workspace_loaders/manuscripts.rs`
  - `workspace_loaders/subjects.rs`
  - `workspace_loaders/redclaw.rs`
- Store schema changes must update `docs/contracts/workspace-schema.md`.

**Collaborates with**

- Knowledge module writes canonical knowledge records.
- Media module writes asset records.
- Manuscript module writes package/project records.
- App shell only consumes migration status.

**Performance rules**

- No renderer-side workspace scanning.
- Hydrate summary first, details on demand.
- Preserve stale data on refresh failure.

### 5. Chat And Conversation Runtime UI

**Current entry points**

- `src/pages/Chat.tsx`
- `src/components/ChatComposer.tsx`
- `src/components/MessageItem.tsx`
- `src/pages/chat/*`
- `src-tauri/src/commands/chat.rs`
- `src-tauri/src/commands/chat_sessions_wander.rs`
- `src-tauri/src/commands/chat_state.rs`
- `src-tauri/src/session_manager.rs`

**Responsibilities**

- Conversation session creation, title, archive, delete。
- Message rendering, streaming merge, thought/tool timeline。
- Attachment intake and delivery plan display。
- Runtime state projection for the active session。
- Chat composer and shortcuts.

**Should not own**

- RedClaw-specific prompt templates.
- Media generation business flow.
- Knowledge catalog browsing.
- Tool registry logic.

**Target implementation**

Frontend split:

- `src/features/chat/sessionStore.ts`
- `src/features/chat/useChatRuntimeStream.ts`
- `src/features/chat/attachmentDelivery.ts`
- `src/features/chat/chatShortcuts.ts`
- `src/features/chat/errorNotice.ts`
- `src/pages/Chat.tsx` becomes composition only.

Host split:

- Keep `commands/chat.rs` for send/cancel/confirm tool.
- Move session CRUD and attachment helpers out of `chat_sessions_wander.rs`:
  - `commands/chat_sessions/mod.rs`
  - `commands/chat_attachments.rs`
  - `commands/wander.rs`

**Collaborates with**

- Runtime module emits stream events.
- Tool module supplies tool descriptors and results.
- Knowledge module supplies mention candidates.
- Media module supplies attachment preflight and generated asset references.

**Performance rules**

- Stream chunks are batched; do not call `setMessages` for every token.
- Markdown parse should be limited to changed message blocks.
- Attachment thumbnails use preview URLs, not original media in dense lists.

### 6. AI Runtime, Tools, Skills, MCP

**Current entry points**

- `src-tauri/src/runtime/*`
- `src-tauri/src/agent/*`
- `src-tauri/src/tools/*`
- `src-tauri/src/skills/*`
- `src-tauri/src/mcp/*`
- `src-tauri/src/subagents/*`
- `src-tauri/src/interactive_runtime_shared.rs`
- `desktop/prompts/*`

**Responsibilities**

- Runtime modes and execution contracts。
- LLM transport normalization。
- Tool registry, packs, guardrails, execution。
- Skill catalog, activation, permission and prompt injection。
- MCP server configuration and tool exposure。
- Subagent/team task orchestration.

**Should not own**

- Natural-language product-specific routing based on keywords。
- UI-specific assumptions。
- Business-specific one-off tools when `Operate` can express the action.

**Target implementation**

- Keep model-visible tools constrained to `Read`, `List`, `Search`, `Write`, `Operate`, `bash`, `tool_search`.
- Add capabilities as canonical actions under `resource` / `workflow` / `editor`, not new top-level tools.
- Runtime mode carries explicit typed metadata:
  - `surface`
  - `intent`
  - `activeResource`
  - `allowedActionFamilies`
  - `currentAttachments`
  - `targetProject`

**Collaborates with**

- Chat/RedClaw/Generation/Manuscripts provide typed context.
- Bridge exposes runtime query and task controls.
- Settings controls provider/model/tool configuration.

**Must use existing libraries**

- Provider calls use OpenAI-compatible transport and `reqwest`.
- JSON schema and serde stay the primary structured contract.

**Must be self-developed**

- Runtime event protocol.
- Tool pack and guard policy.
- Skill activation policy.
- Context bundle construction.

**Performance rules**

- Runtime event stream must be narrow by session/task.
- Tool results must be budgeted and summarized.
- Long-running work emits checkpoint events and is resumable.

### 7. RedClaw Creative Automation

**Current entry points**

- `src/pages/RedClaw.tsx`
- `src/pages/redclaw/*`
- `src/pages/Automation.tsx`
- `src-tauri/src/commands/redclaw.rs`
- `src-tauri/src/commands/redclaw_runtime.rs`
- `src-tauri/src/commands/redclaw_task_control.rs`
- `src-tauri/src/runtime/redclaw_orchestration.rs`
- `src-tauri/src/scheduler/*`
- `src-tauri/src/redclaw_profile.rs`

**Responsibilities**

- RedClaw chat surface and history。
- Project/profile bundle。
- Scheduled tasks and long-cycle tasks。
- Creative orchestration runs。
- RedClaw-specific authoring shortcuts and defaults.

**Should not own**

- Generic chat components.
- Generic scheduler primitives.
- Generic media generation job execution.

**Target implementation**

Frontend:

- Keep `RedClaw.tsx` as page composition.
- Move session/history/sidebar orchestration to `src/features/redclaw/*`.
- Keep `pages/redclaw/config.ts` for page-specific prompt shortcuts.

Host:

- `commands/redclaw.rs` only routes project/profile/orchestration actions.
- Task CRUD remains in `commands/redclaw_task_control.rs`, with scheduling logic under `scheduler/`.
- RedClaw runtime restore stays startup-managed, not page-managed.

**Collaborates with**

- Chat module renders conversation.
- Runtime module executes.
- Scheduler module computes next run and leases.
- Media module generates artifacts.
- Knowledge module supplies evidence.
- Manuscript module stores outputs.

**Business flow**

1. User opens RedClaw or an automation task.
2. UI resolves session/project/profile context.
3. RedClaw sends typed runtime metadata to chat/runtime.
4. Runtime selects skills/tools based on catalog and explicit context.
5. Tool actions create or update knowledge, media, manuscripts, or scheduled task records.
6. Events update RedClaw sidebar, automation page, notifications, and final summary.

### 8. Knowledge Capture, Catalog, And Retrieval

**Current entry points**

- `src/pages/Knowledge.tsx`
- `src-tauri/src/knowledge.rs`
- `src-tauri/src/knowledge_index/*`
- `src-tauri/src/document_ingest/*`
- `src-tauri/src/document_parse/*`
- `src-tauri/src/commands/library.rs`
- `Plugin/`

**Responsibilities**

- External capture intake: XHS/link/YouTube/document source.
- Catalog listing and detail loading.
- Document source registration.
- File parsing, visual indexing, OCR metadata.
- Hybrid retrieval and audit.
- Knowledge events.

**Should not own**

- RedClaw prompt decisions.
- Media generation job execution.
- Plugin UI behavior.

**Target implementation**

Frontend:

- Split `Knowledge.tsx` into:
  - `src/features/knowledge/catalog/*`
  - `src/features/knowledge/detail/*`
  - `src/features/knowledge/indexDashboard/*`
  - `src/features/knowledge/importActions/*`
  - `src/features/knowledge/referencePicker/*`

Host:

- Keep `knowledge_index/` as canonical retrieval stack.
- Keep `knowledge.rs` for ingest/workspace-first writing, but split local HTTP routing and source-specific normalization:
  - `knowledge/http_routes.rs`
  - `knowledge/xhs.rs`
  - `knowledge/youtube.rs`
  - `knowledge/documents.rs`

**Collaborates with**

- Plugin sends structured capture payload to local HTTP/IPC.
- Persistence hydrates catalog summaries.
- Runtime reads via `knowledge://` virtual paths and `knowledge.search`.
- App shell may surface capture prompt, but not implement ingest.

**Must use existing libraries**

- Tantivy for full-text indexing.
- rusqlite for canonical block store.
- notify for file watching.
- External visual/OCR providers for image semantics; do not self-build OCR/model inference.

**Must be self-developed**

- Knowledge source schema.
- Visual metadata block schema.
- Retrieval audit and evidence pack.
- Workspace-first import semantics.

**Performance rules**

- Catalog list returns summaries only.
- Detail, transcript, visual blocks load on demand.
- Index rebuild runs in background and preserves stale catalog data.

### 9. Media Assets And Generation Runtime

**Current entry points**

- `src/pages/GenerationStudio.tsx`
- `src/pages/MediaLibrary.tsx`
- `src/pages/CoverStudio.tsx`
- `src/features/media-jobs/*`
- `src-tauri/src/media_generation.rs`
- `src-tauri/src/media_runtime/*`
- `src-tauri/src/commands/generation.rs`
- `src-tauri/src/commands/media_jobs.rs`
- `src-tauri/src/commands/media_edit.rs`
- `src-tauri/src/commands/voice.rs`
- `src-tauri/src/voice_service.rs`

**Responsibilities**

- Image generation.
- Video generation.
- Audio/TTS/voice clone.
- Cover generation.
- Digital-human preparation and VideoRetalk submission.
- Media job queue, logs, artifacts, retry/cancel.
- Media asset registry.

**Should not own**

- Subject catalog UI, except selecting a subject reference.
- Manuscript editor state, except binding generated assets.
- Chat rendering, except using chat session as agent interface.

**Target implementation**

Frontend:

- `src/pages/GenerationStudio.tsx` becomes a thin page shell.
- Move logic to:
  - `src/features/generation/feed/*`
  - `src/features/generation/agentSession/*`
  - `src/features/generation/image/*`
  - `src/features/generation/video/*`
  - `src/features/generation/audio/*`
  - `src/features/generation/cover/*`
  - `src/features/generation/digitalHuman/*`
  - `src/features/generation/shared/referenceItems.ts`
  - `src/features/generation/shared/modelRouting.ts`

Host:

- Keep `media_runtime/` as job runtime.
- Split `media_generation.rs` by provider/request type:
  - `media_generation/image.rs`
  - `media_generation/video.rs`
  - `media_generation/audio.rs`
  - `media_generation/digital_human.rs`
  - `media_generation/assets.rs`
  - `media_generation/provider_templates.rs`

**Collaborates with**

- Subjects supplies role images, voice IDs and reference videos.
- Settings supplies provider/model routes.
- Media jobs store updates GenerationStudio, MediaLibrary, notifications, manuscripts.
- Chat/Agent mode submits typed generation requests.

**Business flow**

Manual mode:

1. User chooses mode: image/video/audio/cover/digital-human.
2. UI builds typed generation request.
3. Bridge calls `generation.submit*`.
4. Host validates model route and media references.
5. Media runtime creates job, emits `generation:job-updated`.
6. Provider returns artifact or task ID.
7. Runtime materializes artifact into workspace media library.
8. UI updates feed and allows save/show/retry/bind.

Agent mode:

1. User enters prompt in generation agent surface.
2. Page creates or resumes context chat session with typed metadata.
3. Runtime uses `Operate(resource="image|media|voice", operation=...)`.
4. Tool result registers artifact and returns structured preview.
5. Chat message embeds generated media preview.
6. Generation feed observes the same job/artifact projection.

Digital-human mode:

1. User selects subject.
2. UI checks readiness: voice mapping + reference video.
3. If audio does not exist, runtime generates TTS/audio first.
4. Host prepares remote-accessible VideoRetalk source URLs.
5. Media runtime submits video retalk job.
6. Artifact is stored as generated video and linked to subject/project if applicable.

**Must use existing libraries**

- FFmpeg for media probing/conversion.
- Provider APIs for image/video/audio generation.
- Browser media APIs only for lightweight preview and poster capture.

**Must be self-developed**

- Generation request schema.
- Job projection and artifact registry.
- Provider template normalization.
- Subject/digital-human readiness policy.

**Performance rules**

- Dense feeds render poster/thumbnail, not full video.
- Job updates are selector-based by job id/source, not whole store fanout.
- Large reference files are preflighted and materialized once.

### 10. Subjects, Roles, And Asset Library

**Current entry points**

- `src/pages/Subjects.tsx`
- `src-tauri/src/commands/subjects.rs`
- `src-tauri/src/voice_service.rs`
- `src-tauri/src/media_runtime/*`

**Responsibilities**

- Subject/role/person/object/brand/scene catalog.
- Subject images, attributes, tags, categories.
- Voice samples, clone model slots, TTS voice mappings.
- Reference video for digital-human flow.
- Subject to media asset binding.

**Should not own**

- General media feed.
- Voice provider account settings.
- Generation job runtime.

**Target implementation**

Frontend:

- Split `Subjects.tsx` into:
  - `src/features/subjects/catalog/*`
  - `src/features/subjects/editor/*`
  - `src/features/subjects/mediaSlots/*`
  - `src/features/subjects/voiceSlots/*`
  - `src/features/subjects/assetPicker/*`

Host:

- Keep `commands/subjects.rs` as IPC.
- Move voice-slot interpretation to a shared `subjects/voice_slots.rs` or `voice_service` helper.
- Keep clone and TTS execution in voice/media services.

**Collaborates with**

- Generation digital-human consumes subject readiness.
- Media library displays subject-bound assets.
- Chat/Runtime can reference subject through structured metadata.

**Performance rules**

- Subject list loads metadata and first preview only.
- Voice/video heavy assets load on modal/detail demand.
- Autosave debounce stays local and only persists compact payload.

### 11. Manuscripts And Video Editor

**Current entry points**

- `src/components/manuscripts/ManuscriptEditorHost.tsx`
- `src/components/manuscripts/EditableTrackTimeline.tsx`
- `src/features/video-editor/store/useVideoEditorStore.ts`
- `src-tauri/src/commands/manuscripts.rs`
- `src-tauri/src/manuscript_package.rs`
- `src-tauri/src/commands/video_editor_v2.rs`
- `src/remotion/*`
- `remotion/render.mjs`

**Responsibilities**

- Draft tree and folder operations.
- Writing draft editing.
- Audio draft editing.
- Video package state, tracks, clips, subtitles, text overlays.
- Timeline UI and editor runtime state.
- Remotion project generation and rendering.
- Asset binding.

**Should not own**

- General media generation forms.
- Knowledge catalog.
- RedClaw task scheduling.

**Target implementation**

Frontend:

- Keep `ManuscriptEditorHost.tsx` as editor shell.
- Move domains:
  - `src/features/manuscripts/tree/*`
  - `src/features/manuscripts/draftEditor/*`
  - `src/features/manuscripts/assetBinding/*`
  - `src/features/video-editor/timeline/*`
  - `src/features/video-editor/remotion/*`
  - `src/features/video-editor/projectState/*`

Host:

- Split `commands/manuscripts.rs`:
  - `commands/manuscripts/mod.rs`: channel dispatch only.
  - `commands/manuscripts/tree.rs`
  - `commands/manuscripts/package.rs`
  - `commands/manuscripts/editor_runtime.rs`
  - `commands/manuscripts/timeline.rs`
  - `commands/manuscripts/render.rs`
  - `commands/manuscripts/assets.rs`

**Collaborates with**

- Media module provides assets and generated job artifacts.
- Generation module can be opened with bind target.
- Runtime/editor tools read/write `editor://current/*`.
- Persistence owns workspace package storage.

**Business flow**

1. User opens manuscript.
2. Editor loads tree summary and selected package/draft.
3. Editor initializes runtime state: active track, playhead, selected clips, preview tab.
4. User edits text/timeline/asset binding.
5. UI sends typed manuscript action through bridge.
6. Host applies package mutation and persists.
7. Timeline preview updates from canonical project state.
8. Export uses Remotion + FFmpeg and emits progress.

**Must use existing libraries**

- CodeMirror for text editing.
- Remotion for video render graph and rendering.
- FFmpeg for media operations.
- Wavesurfer or browser audio APIs for waveform/preview.

**Must be self-developed**

- Manuscript package schema.
- Timeline mutation contract.
- Editor runtime state and undo/redo schema.
- Asset binding semantics.

**Performance rules**

- Timeline uses stable dimensions and avoids reconstructing all clips on mousemove.
- Drag/resize updates local refs/CSS variables, persists on commit.
- Render/export is background job, never blocking UI thread.

### 12. Settings, Accounts, And Control Plane

**Current entry points**

- `src/pages/Settings.tsx`
- `src/pages/settings/*`
- `src/features/official/*`
- `src-tauri/src/commands/official.rs`
- `src-tauri/src/ai_model_manager/*`
- `src-tauri/src/auth.rs`
- `src-tauri/src/commands/plugin.rs`
- `src-tauri/src/commands/cli_runtime.rs`
- `src-tauri/src/commands/mcp_tools.rs`
- `src-tauri/src/commands/skills_ai.rs`
- `src-tauri/src/commands/llm_readiness.rs`

**Responsibilities**

- Account/auth readiness.
- Official billing/products/call records.
- AI source/model routes.
- Visual index/video analysis/transcription/embedding settings.
- Skill management.
- Plugin marketplace and installed plugins.
- MCP server management.
- CLI runtime discovery/install/execute diagnostics.
- Logs/diagnostics/developer mode.
- Runtime debug and task tracing.

**Should not own**

- Product flow UI for knowledge/media/chat/redclaw.
- Runtime execution logic.
- Plugin runtime capability semantics.

**Target implementation**

Frontend split by section:

- `src/features/settings/aiSources/*`
- `src/features/settings/accountBilling/*`
- `src/features/settings/skills/*`
- `src/features/settings/plugins/*`
- `src/features/settings/mcp/*`
- `src/features/settings/cliRuntime/*`
- `src/features/settings/diagnostics/*`
- `src/features/settings/runtimeDebug/*`
- `src/pages/Settings.tsx` becomes section router and save coordinator.

Host split:

- `commands/official.rs` should split into:
  - `commands/official/auth.rs`
  - `commands/official/billing.rs`
  - `commands/official/models.rs`
  - `commands/official/api_keys.rs`
- Keep `ai_model_manager/` as model/provider canonical store.
- Plugin/MCP/CLI already have separate modules; keep them out of settings page internals.

**Collaborates with**

- Every module reads AI source/model routes from `ai_model_manager`.
- LLM readiness gate powers App shell login/setup gate.
- Diagnostics module receives logs from host and renderer.

**Performance rules**

- Settings sections load on demand by active tab.
- Expensive dashboard sections cache last successful snapshot.
- Runtime trace/debug data must be paginated and scoped.

### 13. Plugin And External Capture

**Current entry points**

- `Plugin/`
- `src-tauri/src/assistant_core.rs`
- `src-tauri/src/commands/plugin.rs`
- `src-tauri/src/knowledge.rs`
- `desktop/redbox-market/*`

**Responsibilities**

- Browser extension capture/export.
- Local HTTP/IPC ingestion to desktop.
- Plugin install/enable/uninstall/marketplace.
- Plugin data read surface.
- Capability sync.

**Should not own**

- Heavy AI runtime.
- Media processing.
- Knowledge indexing implementation.

**Target implementation**

- Plugin side stays capture/download/export focused.
- Desktop side owns AI workflow, indexing, media generation and RedClaw.
- Plugin data access routes through `plugins:read-data` with explicit capability checks.

**Collaborates with**

- Knowledge module receives captured content.
- App shell may show capture prompt.
- Settings manages plugin marketplace.

**Performance rules**

- Extension payloads should be structured and minimal.
- Large media files should be saved or streamed by desktop, not shoved through UI state.

### 14. Notifications And Diagnostics

**Current entry points**

- `src/notifications/*`
- `src/components/NotificationCenterDrawer.tsx`
- `src/components/FeedbackReportDialog.tsx`
- `src/logging/client.ts`
- `src-tauri/src/logging/*`
- `src-tauri/src/diagnostics.rs`
- `src-tauri/src/commands/notifications.rs`

**Responsibilities**

- Local notification policy and adapters.
- Remote notification sync.
- Runtime/media/redclaw completion notification.
- Feedback report and recovery report.
- Renderer log upload and host diagnostics bundle.

**Should not own**

- Domain-specific retry logic.
- Runtime state machine decisions.

**Target implementation**

- Keep notification store independent.
- Domain modules emit structured events.
- Notification action router resolves action to module bridge call.

**Collaborates with**

- Media jobs, RedClaw tasks, team runtime and auth all emit events.
- App shell hosts drawer and global toasts.

**Performance rules**

- Notification store selectors must be stable.
- Audio/system notifications should be policy-gated.

### 15. CLI Runtime, MCP, Skills, And Developer Extensions

**Current entry points**

- `src-tauri/src/cli_runtime/*`
- `src-tauri/src/mcp/*`
- `src-tauri/src/skills/*`
- `src-tauri/src/tools/action_search.rs`
- `src/pages/Settings.tsx`

**Responsibilities**

- Discover/inspect/install/run local CLI tools.
- Manage MCP servers and sessions.
- Load, install, enable, disable skills.
- Expose deferred tools/action search to AI runtime.

**Should not own**

- Product-specific business workflows.
- UI-specific management state.

**Target implementation**

- Keep host capability modules separate.
- Settings only displays and configures them.
- AI runtime accesses them through canonical tools and guardrails.

**Performance rules**

- CLI detection and discovery must be async/background.
- MCP tool list should be cached and invalidated by server change.

## Cross-Module Contracts

### Intent Contract

Cross-page actions should use typed intent objects instead of ad hoc props or window events.

Recommended shape:

```ts
type AppIntent =
  | { type: 'chat.open'; sessionId?: string; draft?: PendingChatMessage }
  | { type: 'redclaw.open'; action: 'new' | 'open-session'; sessionId?: string }
  | { type: 'generation.open'; mode: 'image' | 'video' | 'audio' | 'cover' | 'digital-human'; source: string; bindTarget?: unknown }
  | { type: 'knowledge.capture'; source: 'clipboard' | 'plugin' | 'manual'; payload: unknown }
  | { type: 'approval.open'; docketId?: string }
  | { type: 'settings.open'; tab: string; subTab?: string };
```

Rules:

- App shell routes intent.
- Domain module interprets only its own intent.
- No domain should parse another domain's internal payload.

### IPC Contract

Rules:

- Renderer pages do not call `window.ipcRenderer.invoke(...)` directly.
- New channel must be exposed through a domain bridge helper.
- Host channel handler returns stable JSON envelope.
- Existing legacy channel can remain, but new code must call canonical helper.

Recommended host result envelope:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

For compatibility, not every existing channel must migrate immediately, but new code should follow the envelope.

### Event Contract

Event classes:

- `runtime:event`: AI/session/task stream.
- `generation:job-updated`: media job projection.
- `knowledge:*`: knowledge catalog/index changes.
- `redclaw:*`: task/scheduler/profile events.
- `settings:updated`: settings snapshot changed.
- `space:changed`: active workspace changed.
- `notifications:*`: notification sync state.

Rules:

- Event payload must include enough scope id to filter: `sessionId`, `taskId`, `jobId`, `sourceId`, `spaceId` as applicable.
- Pages subscribe only to scoped events they need.
- High-frequency events must be buffered or selector-based.

### Workspace Resource Contract

Virtual paths:

- `workspace://...`
- `knowledge://...`
- `manuscripts://...`
- `profiles://...`
- `editor://current/...`

Rules:

- AI tools use virtual paths.
- Host resolves virtual paths to workspace-safe filesystem paths.
- UI should not invent absolute paths.
- External URL/user input that becomes a filename must use safe stem logic.

### Media Reference Contract

Recommended shape:

```ts
type MediaReference = {
  kind: 'image' | 'video' | 'audio' | 'document' | 'file';
  source: 'workspace' | 'inline' | 'remote' | 'generated' | 'subject';
  path?: string;
  localUrl?: string;
  previewUrl?: string;
  mimeType?: string;
  size?: number;
  jobId?: string;
  assetId?: string;
  subjectId?: string;
};
```

Rules:

- Dense UI uses `previewUrl`.
- Runtime/tool uses `path` or registered attachment reference.
- Provider upload logic lives in host/media runtime, not page components.

## Business Flows

### Flow A: External Content Capture To Knowledge

1. User captures content from browser plugin or clipboard.
2. Plugin/App shell creates `knowledge.capture` intent with structured payload.
3. Knowledge bridge calls host ingest route.
4. Host normalizes source-specific payload into canonical knowledge source.
5. Workspace-first writer saves raw content/assets.
6. Knowledge catalog emits `knowledge:changed`.
7. Indexer parses text/visual/document blocks in background.
8. Knowledge UI shows stale catalog immediately and refreshes detail/index status.
9. Runtime can later read/search through `knowledge://`.

Main modules:

- Plugin/capture
- App shell intent router
- Knowledge ingest
- Persistence/workspace
- Knowledge index
- Runtime resource tools

### Flow B: Knowledge To RedClaw Authoring

1. User selects note/document/video in Knowledge.
2. Knowledge page creates `chat.open` or `redclaw.open` intent with knowledge references.
3. App shell routes to RedClaw/Chat.
4. Chat module creates or reuses session.
5. Runtime context bundle includes typed knowledge references.
6. Agent uses `Search`/`Read` over `knowledge://` instead of relying on pasted text only.
7. Tool output writes manuscript/media/task artifacts.
8. RedClaw sidebar/history reflects session state and created assets.

Main modules:

- Knowledge catalog
- App intent router
- Chat/RedClaw UI
- Runtime context bundle
- Tools/resource resolver
- Manuscripts/media modules

### Flow C: Manual Media Generation

1. User opens Generation Studio.
2. User chooses mode and inputs prompt/references.
3. UI builds typed request.
4. Bridge preflights media references.
5. Host resolves provider/model route from settings.
6. Media runtime creates job record and emits updates.
7. Provider returns artifact or remote task result.
8. Host materializes artifact under media workspace and updates media asset registry.
9. Generation feed, Media Library, Notifications and optional Manuscript binding update from the same job projection.

Main modules:

- Generation UI
- Settings/AI model manager
- Media runtime
- Media asset registry
- Notifications
- Manuscripts asset binding

### Flow D: Agent-Led Media Generation

1. User describes outcome in generation agent surface or RedClaw.
2. UI starts context chat session with explicit `generation-agent` or RedClaw metadata.
3. Runtime exposes allowed media actions through canonical tool packs.
4. Agent calls `Operate(resource="image|media|voice", operation=...)`.
5. Tool validates schema, references and provider route.
6. Media runtime creates job.
7. Tool result returns structured artifact reference and preview.
8. Chat message displays generated media and final summary.

Main modules:

- Chat/runtime
- Tool registry/guards
- Generation/media runtime
- Media asset library

### Flow E: Digital Human

1. User selects digital-human mode.
2. UI lists subjects with readiness projection.
3. Subject readiness checks voice slot and reference video.
4. If prompt requires audio, voice service creates TTS/audio job.
5. Host prepares VideoRetalk source with remote-accessible video/audio URLs.
6. Media runtime submits video job.
7. Final video artifact is saved and linked to generated feed/media library.

Main modules:

- Subjects
- Voice service
- Generation digital-human
- Media runtime
- Provider route manager

### Flow F: Manuscript Video Editing And Export

1. User opens manuscript editor.
2. Manuscript module loads tree and active draft/package.
3. Video editor store initializes timeline and editor runtime state.
4. User adds clips/assets/subtitles/text.
5. UI sends manuscript package mutation.
6. Host validates and persists package.
7. Preview updates locally.
8. Export request starts Remotion render.
9. FFmpeg/Remotion output is saved to media or selected path.

Main modules:

- Manuscripts tree/editor
- Video editor store/timeline
- Media asset registry
- Remotion renderer
- FFmpeg runtime

### Flow G: Scheduled RedClaw Task

1. User creates automation task.
2. Automation UI submits typed task definition.
3. Scheduler computes next run and stores job definition.
4. Background runtime leases due jobs.
5. RedClaw runtime starts session/task with project/profile context.
6. Runtime emits checkpoints and tool events.
7. Task result updates job execution history, notifications and artifacts.
8. User can inspect or resume from RedClaw/Automation.

Main modules:

- Automation UI
- Scheduler
- RedClaw runtime
- Runtime/task/checkpoint
- Notifications
- Artifact modules

### Flow H: Settings And Model Route Change

1. User updates AI source/model route in Settings.
2. Settings bridge saves route to host.
3. AI model manager persists canonical config.
4. LLM readiness refreshes.
5. App shell/login gate and generation/chat modules receive updated readiness.
6. Future runtime sessions resolve model through canonical route.

Main modules:

- Settings AI source section
- Official/auth/billing
- AI model manager
- LLM readiness
- Runtime config resolver

## Library Vs Self-Developed Boundary

| Capability | Use existing library/provider | Self-developed |
| --- | --- | --- |
| Desktop shell | Tauri v2 | AppState, startup restore, IPC domain dispatch |
| UI primitives | React, Radix, Lucide, clsx | Product layout, intent routing, page state machines |
| Markdown/editor | CodeMirror, markdown-it, react-markdown | Manuscript schema, proposal apply/reject, editor runtime state |
| Video render | Remotion, FFmpeg | Timeline mutation contract, package schema, render orchestration |
| Audio capture/preview | cpal, hound, wavesurfer/browser media APIs | Voice slot mapping, TTS/clone request contract |
| Full-text search | Tantivy, rusqlite | Knowledge block schema, evidence pack, retrieval audit |
| File watching | notify | Workspace source policy and rebuild scheduling |
| Image/video/audio generation | External model providers | Provider route normalization, job registry, artifact materialization |
| AI transport | OpenAI-compatible provider APIs, reqwest | Runtime modes, tool packs, checkpoint/resume, skill activation |
| Plugin marketplace | GitHub/raw package download primitives | Plugin manifest, capability check, data-source policy |
| CLI execution | Host shell/process primitives | CLI runtime inspect/install/run contract and escalation policy |

## Performance Strategy

### Renderer

- Render shell first, hydrate later.
- Do not block route switch on slow IPC.
- Keep stale data on refresh failure.
- Use lazy page and lazy heavy panels.
- Keep selectors scoped by id/job/session.
- Batch high-frequency stream/log/job progress events.
- Dense media surfaces use thumbnails/posters and lazy decode.
- Drag/resize/mousemove use refs or CSS variables during interaction; persist on commit.

### Bridge

- Add timeout for page-load calls.
- Fallback shape must be stable and minimal.
- Avoid returning huge payloads to first paint.
- Domain helpers should normalize response once, pages should not repeat parsing.

### Host

- Store locks must be memory-only.
- Directory scans, parsing, media probes, provider calls, FFmpeg and index rebuilds run outside store locks.
- Commands return summaries by default; detail commands load specific resource.
- Startup restore should degrade gracefully and emit diagnostic events.

### Runtime

- Runtime events include scope id and are filtered before UI update.
- Tool result budget truncates large results.
- Checkpoints persist at meaningful boundaries.
- Long jobs use job state, not long-held request locks.

### Media

- Preflight and materialize references once.
- Avoid base64 for large video/audio through UI state.
- Generate poster/thumbnail for video list display.
- Media job store updates only interested subscribers.

## Execution Plan

Each item below should be implemented as one or more atomic commits. Do not mix refactor and behavior changes unless the behavior change is the whole commit.

### Phase 0: Baseline Inventory And Guards

Goal: make the current surface measurable before moving code.

Tasks:

- Run `pnpm ipc:inventory` and capture current bridge/host inventory.
- Add or refresh a short module inventory note if `ipc-inventory.md` changes.
- Record current large-file metrics in the implementation PR description.
- Identify direct `window.ipcRenderer.invoke(...)` call sites and group by domain.

Acceptance:

- No product behavior changes.
- Build still passes.
- Inventory can be used to compare later phases.

Suggested atomic commits:

- `docs: add modularization execution plan`
- `docs: refresh ipc inventory baseline` if inventory changes.

### Phase 1: Split Bridge Core And Domain Facades

Goal: stop new code from expanding the single bridge file.

Tasks:

- Extract bridge core helpers:
  - `core.ts`
  - `browserHost.ts`
  - `fallbacks.ts`
  - `listeners.ts`
- Create first domain bridges:
  - `chatBridge.ts`
  - `knowledgeBridge.ts`
  - `generationBridge.ts`
  - `systemBridge.ts`
- Keep public `window.ipcRenderer` shape compatible.
- Migrate direct `invoke()` call sites only when a domain helper already exists.

Acceptance:

- `ipcRenderer.ts` becomes assembly only.
- Existing pages compile without prop/API changes.
- Direct invoke count decreases.
- No channel names removed.

Verification:

- `pnpm build`
- Smoke test: Home, RedClaw, Knowledge, Generation Studio, Settings open.
- Trigger at least one bridge call per migrated domain.

### Phase 2: Thin App Shell

Goal: make `App.tsx` only route and compose.

Tasks:

- Extract startup migration gate.
- Extract official login gate.
- Extract clipboard YouTube/capture prompt into capture feature.
- Extract view navigation and intent routing.
- Keep existing view keys and UI.

Acceptance:

- `App.tsx` no longer contains provider-specific login form internals.
- `App.tsx` no longer contains YouTube clipboard parsing/ingest logic.
- Cross-page navigation still works.

Verification:

- Launch app with logged-out and logged-in states.
- Open Settings from shell.
- Open subject modal.
- Navigate Knowledge -> RedClaw.
- Clipboard capture prompt still saves YouTube note when accepted.

### Phase 3: Host Main And App State Split

Goal: restore `main.rs` to assembly role.

Tasks:

- Move `AppState` to `app_state.rs`.
- Move `AppStore` and pure record structs to `store/types.rs`, or domain-owned type files where already clear.
- Move workspace path helpers to `workspace/paths.rs`.
- Move `handle_channel` dispatch to `channel_router.rs`.
- Move startup restore sequence to `startup/mod.rs`.

Acceptance:

- `main.rs` contains module declarations, builder, command registration and top-level run lifecycle only.
- No channel behavior changes.
- No store schema changes unless separately committed and documented.

Verification:

- `cd desktop/src-tauri && cargo fmt --check && cargo check`
- Start app and verify startup logs.
- Smoke test knowledge index init and RedClaw/media/assistant restore status.

### Phase 4: Generation And Media Module Split

Goal: separate product modes from media job runtime.

Tasks:

- Extract GenerationStudio feed persistence.
- Extract image/video/audio/cover/digital-human request builders.
- Extract generation agent session helpers.
- Extract shared reference item handling.
- Split host `media_generation.rs` by request type.
- Keep `media_runtime/` as canonical job runtime.

Acceptance:

- `GenerationStudio.tsx` becomes a page shell plus mode composition.
- Request schema is shared by manual and agent flows.
- Digital-human flow still uses subject readiness and audio-first chain.
- Media job projections still drive feed and notifications.

Verification:

- Submit image job.
- Submit video job with reference.
- Submit audio/TTS job.
- Submit cover job.
- Submit digital-human job through existing readiness path, or verify readiness-disabled UX if assets missing.
- Retry/cancel/list jobs.

### Phase 5: Manuscripts And Video Editor Split

Goal: make manuscript tree/package/timeline/render independent.

Tasks:

- Split `commands/manuscripts.rs` into domain files.
- Extract manuscript tree UI from `ManuscriptEditorHost.tsx`.
- Extract package editor state and asset binding.
- Move Remotion export controls to video editor feature.
- Keep current package schema stable.

Acceptance:

- Tree/file operations do not depend on timeline code.
- Timeline mutations have typed host functions.
- Remotion export path remains unchanged.
- Existing manuscript packages load unchanged.

Verification:

- Open manuscript editor.
- Create/rename/delete folder and draft.
- Edit writing draft and save.
- Add media asset to package.
- Move/split/duplicate clip if supported by current UI.
- Render/export video.

### Phase 6: Settings Control Plane Split

Goal: make Settings a section router, not one giant implementation file.

Tasks:

- Extract AI sources/model routes section.
- Extract account/billing official section.
- Extract skills section.
- Extract plugins section.
- Extract MCP section.
- Extract CLI runtime section.
- Extract diagnostics/logs section.
- Extract runtime debug section.
- Split `commands/official.rs` by auth/billing/models/api keys.

Acceptance:

- Settings active tab lazy-loads heavy controls.
- Save behavior remains compatible.
- Account, pricing and model route flows still work.
- Plugin/MCP/CLI controls call their own bridge domains.

Verification:

- Load Settings general/AI/tools/profile/remote/experimental tabs.
- Test AI connection.
- Refresh pricing/products if account available.
- List skills/plugins/MCP/CLI runtime.
- Verify logs/diagnostics dashboard.

### Phase 7: Knowledge UI And Ingest Split

Goal: align Knowledge UI with existing host/index module quality.

Tasks:

- Extract catalog list/detail/index dashboard/import actions.
- Move source-specific ingest normalization from `knowledge.rs` into source files.
- Keep old `/api/knowledge/entries` and current V2 route compatibility.
- Ensure plugin payload remains accepted.

Acceptance:

- Knowledge page becomes composition of subfeatures.
- Catalog summary/detail API stays stable.
- Index status and file index dashboard remain accessible.
- External capture is unchanged.

Verification:

- List knowledge items.
- Open note/video/document detail.
- Delete note/batch.
- Add document files/folder/vault.
- Rebuild catalog/index.
- Capture through plugin or local route if available.

### Phase 8: RedClaw, Automation, And Runtime Cohesion

Goal: remove RedClaw-specific leakage from generic chat/app shell while preserving RedClaw workflow.

Tasks:

- Move RedClaw history/sidebar/session orchestration into `features/redclaw`.
- Keep page-specific prompt/config in `pages/redclaw/config.ts`.
- Normalize automation task actions through redclaw/task bridge.
- Ensure runtime metadata carries explicit RedClaw surface/project/profile context.

Acceptance:

- RedClaw page is a composition surface.
- Automation page uses the same task bridge/domain types.
- Chat remains generic and accepts RedClaw props/hooks only through explicit extension points.

Verification:

- New RedClaw session.
- Open existing RedClaw session.
- Create/enable/disable/run scheduled task.
- Inspect task history and notifications.
- Open manuscript/editor from RedClaw.

### Phase 9: Contracts, Docs, And Regression Harness

Goal: make modularization durable.

Tasks:

- Update `docs/architecture/system-overview.md`.
- Update `docs/architecture/product-module-breakdown.md`.
- Update `docs/ipc-inventory.md`.
- Add README files for any new `features/*` or host subdirectories.
- Add focused tests where available:
  - Rust unit tests for schema/path/channel helpers.
  - TS tests or compile checks for request builders.
  - Runtime probe for AI/tool contract if touched.

Acceptance:

- New module boundaries documented near code.
- No stale direct invoke call sites for migrated domains.
- Verification matrix is repeatable.

Verification:

- `pnpm build`
- `cd src-tauri && cargo fmt --check && cargo check`
- `pnpm ipc:inventory`
- Manual smoke matrix for main pages.

## Atomic Commit Boundaries

Use these boundaries when executing:

- One commit for one module extraction.
- One commit for one bridge domain migration.
- One commit for one host file split.
- One commit for one behavior fix.
- One commit for generated inventory/doc updates if needed.

Do not combine:

- Bridge refactor + page redesign.
- Host split + channel rename.
- Media job behavior change + UI extraction.
- Settings section extraction + account/billing logic change.
- Runtime tool contract change + prompt rewrite.

## Verification Matrix By Module

| Module | Minimum verification |
| --- | --- |
| App Shell | Page switching, subject modal, feedback dialog, startup/login gate |
| Bridge | One call per migrated domain, listener cleanup, browser host fallback if applicable |
| Host State | App startup, clean shutdown, startup restore logs |
| Chat | Send/cancel message, stream flush, attachment send, context usage |
| Runtime/Tools | Real task with tool call, approval/confirmation if required, checkpoint/final summary |
| RedClaw | New/open session, sidebar/history, scheduled task run |
| Knowledge | List/detail/delete/import/rebuild, stale data preserved on failed refresh |
| Generation | Image/video/audio/cover/digital-human path or readiness guard, retry/cancel job |
| Subjects | Create/edit/delete subject, voice clone slot, reference media preview |
| Manuscripts | Tree CRUD, draft edit/save, package timeline mutation, render/export |
| Settings | AI source save/test, account/auth, plugin/MCP/CLI list, diagnostics |
| Plugin | Reload extension, capture popup/background/context-menu path |
| Notifications | Job/task completion notification, drawer action routing |

## Risks And Controls

| Risk | Control |
| --- | --- |
| Refactor accidentally changes channel behavior | Keep channel names and payloads stable until a dedicated migration commit |
| App shell extraction breaks cross-page navigation | Introduce typed intent router and test all current navigation paths |
| Generation split changes request schema | Extract request builders first, keep submit payload identical |
| Manuscript split breaks old package files | Add package fixture tests and avoid schema changes in split commits |
| Settings extraction causes hidden eager load regressions | Lazy load section data by active tab and cache last successful snapshots |
| Runtime/tool behavior drifts into product keywords | Use typed metadata, skill activation hints and tool contracts, not user-message keyword routing |
| Store lock duration grows during split | Enforce memory-only store closures and move I/O outside locks |

## Recommended First Implementation Slice

The safest first slice is:

1. Add bridge core/domain split for `knowledge`, `generation`, `system`.
2. Migrate direct invoke sites in `Knowledge.tsx`, `GenerationStudio.tsx`, `Home.tsx` only where helpers already exist.
3. Extract App shell clipboard capture into `features/capture`.
4. Extract `OfficialLoginGate` out of `App.tsx`.

Reason:

- It reduces new coupling immediately.
- It does not change Rust host behavior.
- It avoids touching media provider logic or runtime internals first.
- It creates a reusable pattern for later domains.

Avoid starting with `commands/manuscripts.rs` or `main.rs` unless the bridge/app-shell slice is complete. Those files are higher blast radius and need a cleaner frontend/contract boundary first.

## Execution Log

### 2026-05-22 Bridge Contract Slice Started

Completed:

- Split `src/bridge/ipcRenderer.ts` into bridge assembly plus `core.ts`, `browserHost.ts`, `fallbacks.ts`, and `types.ts`.
- Added `src/bridge/domains/knowledgeBridge.ts`, `generationBridge.ts`, and `systemBridge.ts`.
- Kept the existing `window.ipcRenderer` public shape stable for migrated domains.
- Migrated `GenerationStudio.tsx` and `CoverStudio.tsx` off direct `cover:*` invokes by adding `window.ipcRenderer.cover` facade methods for list, generate, open root, and open asset.
- Updated `src/bridge/README.md` with the new bridge module layout and extension rules.

Verification:

- `pnpm exec tsc --noEmit`
- `pnpm build`
- `cargo check`
- `git diff --check`
- `pnpm build`
- `pnpm build`

Remaining in this slice:

- Migrate direct invoke call sites in `Knowledge.tsx`, `GenerationStudio.tsx`, and `Home.tsx` where the new typed facade already exists.
- Add focused bridge contract tests or an IPC inventory check once direct invoke migration starts.

### 2026-05-22 Media Generation Feed Model Slice Started

Completed:

- Added `src/features/media-generation/feedModel.ts` as the renderer-side module boundary for generation requests, generation feed records, generated asset summaries, deleted feed state, and media job projection.
- Moved image, video, audio, cover, digital human request types out of `src/pages/GenerationStudio.tsx`.
- Moved manual and Agent-mode request builders out of `src/pages/GenerationStudio.tsx`.
- Moved feed persistence, sorting, deletion filtering, progress estimation, job-to-feed projection, and recent asset summary helpers out of the page.
- Added `src/features/media-generation/README.md` to document what the module owns and what still belongs to the page.
- Kept `GenerationStudio.tsx` responsible for form state, UI rendering, context menus, and agent chat session mounting.

Verification:

- `pnpm exec tsc --noEmit`
- `pnpm build`

Remaining in this slice:

- Add focused tests for persisted feed normalization and media job projection before moving host-side media runtime code.

### 2026-05-22 Media Generation Submit Contract Slice Started

Completed:

- Added `src/features/media-generation/index.ts` as the public renderer module entry.
- Added `src/features/media-generation/agentContext.ts` for Agent-mode runtime context and sanitized request projection.
- Added `src/features/media-generation/digitalHuman.ts` for digital-human final audio result parsing.
- Added `src/features/media-generation/submitter.ts` for renderer-side submit orchestration and digital-human staged submit flow.
- Added `src/features/media-generation/validation.ts` for stable request validation and user-facing error messages.
- Added `src/features/media-generation/submitPayload.ts` for typed IPC submit payload builders across image, video, audio, cover, and digital human generation.
- Moved submit payload construction out of `src/pages/GenerationStudio.tsx` while keeping async invocation, UI state updates, and error placement in the page.
- Kept queued job replay on the existing persisted `jobRequest` payload to preserve current retry behavior.

Verification:

- `pnpm exec tsc --noEmit`

Remaining in this slice:

- Add focused tests once a renderer test runner exists.
- Move queued job replay after persisted job request compatibility is covered by tests.
- Defer Rust host queue reshaping until unrelated Rust worktree changes are clear or scoped to the same module.

### 2026-05-22 Media Generation Host Command Slice Started

Completed:

- Added `src-tauri/src/media_runtime/config.rs` for queue limits, timeouts, event names, and dispatch timing constants.
- Added `src-tauri/src/media_runtime/types.rs` for runtime slots, job records, attempts, artifacts, loaded jobs, poll states, and the runtime handle.
- Split VideoRetalk reference-video preparation out of `src-tauri/src/commands/media_jobs.rs`.
- Added `src-tauri/src/commands/media_jobs/video_retalk.rs` for local path resolution, ffprobe dimension probing, target-size calculation, and ffmpeg normalization.
- Kept `media_jobs.rs` as the IPC channel router plus official temp-upload command path.
- Left `media_runtime/mod.rs` as the orchestration hub for queue persistence, leasing, retries, polling, artifacts, and worker dispatch; deeper extraction needs behavior-focused slices.

Verification:

- `cargo check`

### 2026-05-22 Media Queue CRUD Completion Slice Started

Completed:

- Added soft archive fields to the unified `media_jobs.sqlite` queue (`archived_at`, `archive_reason`) with startup migration for existing workspaces.
- Added `generation:delete-job` as the unified delete/archive IPC path for every media job kind.
- Kept queue deletion as soft archive instead of physical delete so active provider callbacks and worker diagnostics remain recoverable.
- Updated media job list and summary APIs to exclude archived jobs by default, with `includeArchived` for diagnostics.
- Updated media runtime pressure and dispatch selection to ignore archived jobs.
- Exposed `deleteJob` through the generation bridge and renderer type declarations.
- Made renderer media job kinds extensible beyond the current image/video/audio/voice-clone set.
- Added renderer store removal helpers so archived jobs leave the in-memory queue immediately.
- Wired Generation Studio feed deletion and clear-all to archive the corresponding unified media queue jobs.

Verification:

- `pnpm exec tsc --noEmit`
- `pnpm build`
- `cargo check`
- `git diff --check`

### 2026-05-22 Video Sequence Queue Slice Started

Completed:

- Added `video_sequence` as a unified media queue kind for long video generation.
- Kept `generation:submit-video` as the public entry; requests with `durationSeconds > 15` or multiple `videoSegments` are routed into `video_sequence`.
- Added per-segment generation, polling, download, progress updates, and `video_segment` artifacts inside the media runtime.
- Added ffmpeg concat merge for generated video segments and registers one final `media` artifact for the user.
- Reused the existing media runtime queue, retry, archive, artifact, event, provider routing, and media library registration surfaces.
- Updated tool schema so Agent callers can request long videos or pass explicit `videoSegments`.

Verification:

- `pnpm exec tsc --noEmit`
- `cargo check`

### 2026-05-22 App Shell Capture And Domain Bridge Slice Started

Completed:

- Added `src/features/capture/useClipboardCapturePrompt.ts` as the App Shell module boundary for YouTube clipboard detection, polling, duplicate suppression, save confirmation, and status state.
- Removed clipboard polling and YouTube save orchestration from `src/App.tsx` while keeping the existing capture prompt UI and user flow unchanged.
- Added `window.ipcRenderer.capture.saveYoutubeNote(...)` and moved the capture path off raw `window.ipcRenderer.invoke(...)`.
- Added official auth facade methods used by the login gate: config loading, WeChat URL/status, SMS send, SMS login and SMS registration.
- Added `src/bridge/domains/mediaBridge.ts` and `src/bridge/domains/manuscriptsBridge.ts` for media assets, image/video generation aliases, and manuscript tree/package/editor commands.
- Migrated Home, Media Library, Subjects, ImageGen, RedClaw manuscript drawer, graph layout, manuscript editor, and chat open-path calls to domain bridge helpers where the helper exists.
- Reduced direct renderer `window.ipcRenderer.invoke(...)` call sites from the baseline 118 noted above to 20 current call sites; remaining calls are concentrated in Wander, Archives/accounts, Skills, and the generated official AI panel dynamic invoker.
- Kept public channel names and payloads stable; this slice is a facade/module extraction only.

Verification:

- `pnpm exec tsc --noEmit`
- `pnpm build`
- `cargo check`
- `git diff --check`

Remaining in this slice:

- Add dedicated bridge facades for Wander, Archives/accounts, and Skills before migrating their remaining direct invoke calls.
- Keep `features/official/generatedOfficialAiPanel.tsx` dynamic invoker until that generated surface has a typed channel map.

### 2026-05-22 Wander Archives Skills Bridge Slice Started

Completed:

- Added `accountsBridge`, `archivesBridge`, `wanderBridge`, and `skillsBridge` domain facades.
- Migrated Wander history/guided/random calls, Archives profile/sample CRUD, CreatorProfiles account reads, and Skills save/create/enable/disable calls off raw page-level `window.ipcRenderer.invoke(...)`.
- Reduced direct renderer `window.ipcRenderer.invoke(...)` call sites from 20 to 1. The only remaining call is `features/official/generatedOfficialAiPanel.tsx`, which intentionally dispatches a generated official-control channel map dynamically.
- Kept all channel names and payload shapes stable.

Verification:

- `pnpm exec tsc --noEmit`

Remaining in this slice:

- Replace `features/official/generatedOfficialAiPanel.tsx` dynamic invoker only after the generated official panel has a typed channel map or generated bridge contract.
