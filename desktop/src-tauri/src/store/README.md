# `store/`

## Responsibilities

- Defines `AppStore` and persisted record structs.
- Keeps persisted schema shapes separate from Tauri app composition.

## Rules

- Do not change store fields without a migration note and verification.
- Keep pure record types here unless a domain already owns the full lifecycle.
