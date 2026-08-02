# App Shell Feature

Owns shell-only orchestration that should not live in `App.tsx`:

- login/readiness gate UI
- startup migration gate
- view navigation cache/persistence
- global navigation and RedClaw auto-open intents
- shared app-shell types

`App.tsx` should remain the route composition surface. Product modules should expose typed callbacks or intents instead of adding provider-specific state here.
