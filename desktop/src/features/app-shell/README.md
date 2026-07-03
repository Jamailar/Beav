# App Shell Feature

Owns shell-only orchestration that should not live in `App.tsx`:

- startup migration gate
- view navigation cache/persistence
- global navigation and RedClaw auto-open intents
- shared app-shell types
- global search, app update notice, subjects modal, and space rename UI

Electron archive notes:

- `AppTitleBar` is mirrored through the Electron-safe `windowControls` bridge and custom BrowserWindow chrome.
- `OfficialLoginGate` is present only as a compatibility surface; the open-source Electron app does not enable formal login or membership gates.
- `ClipboardCapturePrompt` keeps the formal self-owned hook shape, but only enables YouTube local saving through the Electron `youtube:save-note` IPC.

`App.tsx` should remain the route composition surface. Product modules should expose typed callbacks or intents instead of adding provider-specific state here.
