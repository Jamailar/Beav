# RedBox Video Editor Parity Checklist

Updated: 2026-04-11

## Shell

- [x] Top editor navbar with mode switch, export entry, RedClaw drawer trigger
- [x] Left `tool rail + context panel`
- [x] Center stage keeps `Preview / Script / Remotion` as first-level tabs
- [x] Bottom timeline spans the full editor width
- [x] RedClaw no longer occupies permanent layout width

## Timeline

- [x] Header / ruler / playhead / scrollbar structure kept as explicit modules
- [x] Timeline selection drives inspector
- [x] Active track now drives inspector when no clip is selected
- [x] Timeline playhead drives preview current time
- [x] Asset drag preview remains available for insert flow
- [x] Track UI state is now unified in editor store (`locked` / `hidden` / `collapsed`)
- [ ] Zoom state is persisted but not yet fully bi-directionally driven by UI controls

## Stage

- [x] Preview upgraded from plain media box to stage-like surface
- [x] Safe area and guide overlays
- [x] Selectable stage items for asset and Remotion text layers
- [x] Scene selection feeds inspector
- [ ] Freeform drag / resize for stage items is still pending

## RedBox Specific

- [x] Script stays first-level
- [x] Remotion stays first-level
- [x] RedClaw becomes drawer
- [x] Existing `redbox_editor` actions remain compatible
- [x] Runtime state persists preview tab, panel, drawer, zoom, and viewport basics

## Backend Extensions

- [x] `panel_open`
- [x] `timeline_zoom_read` / `timeline_zoom_set`
- [x] `timeline_scroll_read` / `timeline_scroll_set`
- [x] `focus_item`
- [x] `clip_move`
- [x] `clip_toggle_enabled`
- [x] `track_reorder`
- [x] `track_delete`
- [ ] `clip_duplicate`
- [ ] `clip_replace_asset`
- [ ] `scene_item_read`
- [ ] `scene_item_update`
- [ ] `undo` / `redo`
