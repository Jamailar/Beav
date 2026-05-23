# `app_state.rs`

## Responsibilities

- Defines the Tauri managed `AppState`.
- Owns runtime handles, lock containers, startup migration state, and global debug handles.
- Does not perform I/O, channel dispatch, or startup restore work.

## Rules

- Keep fields explicit and owned; do not hide slow work behind state constructors.
- Do not hold `AppState` locks across async, process waits, filesystem scans, or network work.
