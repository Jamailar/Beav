# `src/features/manuscripts/`

Renderer-side manuscript feature helpers.

## Boundaries

- `editorModel.ts` owns pure projection helpers and shared editor types for the manuscript tree, draft cards, media assets, generated job artifacts, package state, and export sizing.
- UI state, dialogs, IPC calls, and route composition stay in `components/manuscripts/ManuscriptEditorHost.tsx`.

## Rules

- Keep this folder side-effect free unless a future hook file explicitly documents its IPC/event ownership.
- Do not move package schema mutation here; host package/timeline mutations remain typed Rust commands.
