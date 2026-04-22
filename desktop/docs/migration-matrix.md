# RedBox Migration Matrix

`archive/desktop-electron/` is a read-only reference. `desktop/` is the active Tauri v2 + Rust host target.

## Namespace Status

| Namespace | Status | Notes |
| --- | --- | --- |
| `app:*` | migrated | Version, release page, update check response |
| `db:*` | migrated | RedBox-local settings store |
| `spaces:*` | migrated | Local spaces and active space switching |
| `subjects:*` | migrated | Categories, search, CRUD |
| `manuscripts:*` | migrated | File tree, read/write, rename/delete, layout, WeChat formatting |
| `chat:*` | migrated | Session CRUD, runtime state, attachments, audio transcription endpoint, streaming events |
| `chatrooms:*` | migrated | Creative chat rooms, messages, advisor responses |
| `clipboard:*` | migrated | Text/html clipboard support |
| `debug:*` | migrated | Host status and log directory |
| `work:*` | migrated | Persistent workboard items and status updates |
| `knowledge:*` | migrated | Notes, YouTube records, docs sources, transcription, summary regeneration |
| `media:*` | migrated | Import/list/update/bind/open/delete |
| `cover:*` | migrated | List/open/template save/generate |
| `image-gen:*` | migrated | Endpoint-first image generation with local fallback artifact |
| `video-gen:*` | migrated | Endpoint-first video generation with async task polling and diagnostic fallback |
| `redclaw:*` | migrated | Runner state, scheduled/long-cycle tasks, scheduler, artifacts, work items |
| `assistant:*` | migrated | Local HTTP listener, request handling, model calls, sidecar process lifecycle |
| `mcp:*` | migrated | Local config discovery/import, stdio, streamable-http, SSE call/test paths |
| `sessions:*` | migrated | Session list/get/fork/resume, transcript/checkpoint/tool result access |
| `runtime:*` | migrated | Query/resume/fork/trace/checkpoints/tool results |
| `tasks:*` | migrated | Create/list/get/resume/cancel/trace |
| `tools:*` | migrated | Diagnostics, MCP diagnostics, hooks |
| `youtube:*` | migrated | yt-dlp check/install/update, local YouTube note capture |
| `advisors:*` | migrated | Advisor CRUD, prompt/persona generation, YouTube/yt-dlp integration |
| `archives:*` | migrated | Profiles and samples CRUD |
| `memory:*` | migrated | Memory list/search/history/archive/maintenance |
| `embedding:*` | migrated | Endpoint-first embedding, local vector fallback, manuscript cache |
| `similarity:*` | migrated | Knowledge version and similarity order cache |
| `wander:*` | migrated | Random source selection, brainstorm, history |
| `wechat-official:*` | migrated | Local binding/draft, token check, optional remote draft call |
| `plugin:*` | migrated | Browser extension status/export/open directory |

## Remaining External Dependencies

These are runtime/provider dependencies, not missing IPC routes:

- WeChat official remote draft requires valid account credentials and media upload permission.
- Weixin sidecar behavior depends on the configured external sidecar command and JSON state output.
- Video generation providers may need per-provider polling endpoints beyond common `statusUrl`/`taskId` conventions.
- Model-backed features need configured, reachable provider endpoints.

## Verification Baseline

- IPC channel diff: no missing frontend channels in Rust host.
- `cargo fmt --check && cargo check`
- `pnpm build`
- `pnpm tauri build --debug`
- Short debug-binary smoke startup
