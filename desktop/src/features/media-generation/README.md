# Media Generation Feature

This module owns renderer-side media generation model logic that is shared by the generation studio UI and the media job queue projection.

## Current Boundary

- `feedModel.ts` defines the generation feed domain types for image, video, audio, cover, digital human, agent sessions, generated assets, and deleted feed state.
- It builds normalized generation requests from page form state for manual and agent flows.
- It normalizes persisted feed records from `localStorage`.
- It projects `MediaJobProjection` records from `features/media-jobs` into generation feed entries.
- It keeps feed sorting, deletion matching, progress estimation, and recent asset summaries outside the page component.

## Should Stay In The Page

- Form state and direct user interactions.
- Layout, preview rendering, context menus, and asset actions.
- Agent chat session mounting and page-level intent consumption.

## Should Move Here Next

- Agent runtime context construction once it no longer depends on page-local form state.
- Focused unit coverage for feed persistence and media job projection.
