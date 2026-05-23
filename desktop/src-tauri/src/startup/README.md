# `startup/`

## Responsibilities

- Prepares store state before the Tauri builder is assembled.
- Runs `.setup(...)` restore work for auth, indexing, RedClaw, media generation, assistant daemon, skills, and runtime warm state.
- Owns startup background housekeeping loops.

## Rules

- Keep startup restore behavior idempotent.
- Log and continue on non-fatal restore failures so the app can still open.
- Do not add IPC channel handlers here.
