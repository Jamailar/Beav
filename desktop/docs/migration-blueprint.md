# RedBox Migration Blueprint

## Outcome

The original migration goal has been realized inside `desktop/`:

- Tauri v2 replaces Electron as the desktop shell.
- Rust replaces the Electron main-process host as the primary desktop runtime.
- The React renderer remains reusable behind a compatibility bridge.
- `archive/desktop-electron/` remains read-only reference material.

## What is finished

### 1. Workspace isolation

- `RedBox` builds and runs independently.
- No runtime or build-time dependency on `../desktop`.

### 2. Compatibility bridge

- Renderer still uses a stable `window.ipcRenderer` contract.
- The bridge is now backed by Tauri commands/events.

### 3. Rust host migration

The host router in `src-tauri/src/main.rs` now covers the renderer-facing namespaces used by the app.

### 4. Packaging

- Tauri debug build works.
- Release bundle generation works.
- macOS `.app` bundle is produced.

## What remains

The remaining work is not host migration. It is external integration hardening:

- real provider credentials and endpoint validation
- WeChat official remote draft success under real account constraints
- Weixin sidecar real protocol/state integration
- provider-specific media response edge cases
- MCP server-specific runtime validation
- end-to-end UI smoke with real local data and real services

## Practical next phase

The next phase should be treated as environment-backed validation, not architecture migration:

1. Run real UI smoke against:
   - Settings
   - Chat
   - Knowledge
   - Advisors
   - Manuscripts
   - RedClaw
   - Media / Cover
2. Test real third-party credentials where available.
3. Fix provider-specific issues discovered in those runs.
