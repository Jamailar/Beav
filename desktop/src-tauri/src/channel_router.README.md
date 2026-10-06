# `channel_router.rs`

## Responsibilities

- Dispatches string IPC channels from `ipc_invoke` to domain command modules.
- Preserves channel order and fallback error behavior.

## Rules

- Do not add domain logic here.
- New behavior should live in `commands/<domain>.rs`; this router should only fan out.
