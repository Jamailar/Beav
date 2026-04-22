# RedBox Architecture

## Current shape

`RedBox` is no longer a scaffold. It is the active Tauri v2 desktop shell with a Rust host and a React renderer.

Top-level split:

- `desktop/src/`
  - React UI
  - `window.ipcRenderer` compatibility bridge
  - View logic kept close to the original app shell
- `desktop/src-tauri/src/main.rs`
  - Rust host router
  - Local persistent store
  - Tauri command/event bridge
  - Desktop integrations
  - External provider adapters

## Runtime layers

### Renderer layer

- All renderer code stays inside `desktop/src/`.
- Renderer still calls Electron-style APIs through `window.ipcRenderer`.
- The bridge now targets Tauri command/event APIs instead of Electron preload.

### Host layer

- `ipc_invoke(channel, payload)` handles request/response operations.
- `ipc_send(channel, payload)` handles fire-and-forget and streaming-trigger operations.
- Host state is persisted in a RedBox-local JSON store under the user config directory.

### Domain layer in Rust

Implemented Rust-hosted domains now include:

- app / debug / settings / spaces
- subjects / manuscripts
- chat / runtime / sessions / tasks / background
- knowledge / documents / YouTube / wander / embeddings / similarity
- media / cover / image generation / video generation
- advisors / yt-dlp integration
- assistant daemon / Weixin sidecar process lifecycle
- RedClaw runner / scheduled tasks / long-cycle tasks / artifact persistence
- skills / MCP / diagnostics / hooks
- WeChat official binding and draft flow

## Persistence model

RedBox currently uses a Rust-managed local store for migrated desktop state:

- settings
- spaces
- chat sessions/messages
- runtime transcripts/checkpoints/tool results
- knowledge notes / document sources / YouTube entries
- advisor profiles / advisor video records
- RedClaw state
- assistant daemon state
- MCP configs / hooks / skills
- workboard items
- embedding cache / similarity cache / wander history

This store is independent from `archive/desktop-electron/`.

## External dependencies

The remaining complexity is no longer Electron migration. It is external service compatibility:

- model providers for chat / image / video / embedding / transcription
- WeChat official account credentials and media upload permissions
- Weixin sidecar command and its state-file format
- MCP server availability and protocol quirks
- yt-dlp availability

## Verification baseline

Current architecture has been verified with:

- frontend production build
- Rust `cargo fmt --check`
- Rust `cargo check`
- Tauri debug build
- Tauri release bundle generation
- short debug/release smoke startup
