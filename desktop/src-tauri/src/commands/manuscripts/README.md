# `commands/manuscripts/`

Manuscript IPC channel handlers split by product responsibility. The parent `commands/manuscripts.rs` still owns shared helpers, package schema utilities, timeline helpers, and the public `handle_manuscripts_channel` router.

## Channel Modules

- `tree.rs`: list/read/save, write proposal, create/rename/delete/move, package upgrade.
- `package.rs`: package state, video project state, script approval, subtitle transcription, external asset attachment.
- `post.rs`: post bindings and platform variants.
- `richpost.rs`: rich post page plan, render, export archive/image/card preview.
- `editor_project.rs`: editor project state, FFmpeg edit recipe, undo/redo, markers, AI command/motion helpers, runtime state.
- `timeline.rs`: package track and clip mutations.
- `remotion.rs`: Remotion scene save/generate, export path picking, video render.
- `layout.rs`: editor layout persistence.

## Rules

- Channel modules should stay dispatch-only and call shared typed helpers in the parent module.
- Keep package schema stable unless the migration is separately documented and tested.
- Do not perform long-running work while holding `AppStore` locks.
