# `host_impl.rs`

## Responsibilities

- Temporary compatibility module created during Phase 3 to remove historical host glue from `main.rs`.
- Holds legacy helper functions and interactive runtime helpers that still need domain-level extraction.

## Rules

- Do not add new business behavior here.
- When touching a function in this file, prefer moving it into the closest domain module first.
- Keep root re-exports stable until callers are migrated to direct domain imports.
