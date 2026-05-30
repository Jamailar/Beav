# Media Generation Feature

This module owns renderer-side media generation model logic that is shared by the generation studio UI and the media job queue projection.

## Current Boundary

- `feedModel.ts` defines the generation feed domain types for image, video, audio, cover, digital human, agent sessions, generated assets, and deleted feed state.
- It builds normalized generation requests from page form state for manual and agent flows.
- `agentContext.ts` builds the structured runtime context passed into media-generation Agent mode.
- `agentSession.ts` owns generation Agent context ids, initial context text, and session metadata.
- `references.ts` owns uploaded attachment classification, preview source resolution, reference contact sheets, and attachment-to-reference conversion.
- `assetDisplay.ts` owns feed display helpers such as request summaries, placeholder aspect ratios, grid classes, asset naming, and relative time labels.
- `audioOptions.ts` owns AI source model option projection, model route override resolution, voice list normalization, and audio language/voice option projection.
- `digitalHuman.ts` normalizes digital-human audio generation results.
- `digitalHumanReadiness.ts` owns subject voice/video readiness extraction for the digital-human flow.
- `validation.ts` validates generation requests and returns stable user-facing error messages.
- `submitPayload.ts` translates generation requests into typed IPC payloads for image, video, audio, cover, and digital human submission.
- `submitter.ts` owns the renderer-side submit orchestration for image, video, audio, cover, and digital human generation.
- Media jobs use `queueMode` to separate foreground free-creation jobs from AI/background generation jobs. `source` still means origin surface, and `priority` still means scheduler priority.
- It normalizes persisted feed records from `localStorage`.
- It projects `MediaJobProjection` records from `features/media-jobs` into generation feed entries.
- It keeps feed sorting, deletion matching, progress estimation, and recent asset summaries outside the page component.
- Queue records are owned by the host media runtime. Renderer deletes archive queue jobs through the unified `generation:delete-job` bridge instead of maintaining a separate page-local queue.

## Should Stay In The Page

- Form state and direct user interactions.
- Layout, preview rendering, context menus, and asset actions.
- Agent chat session mounting and page-level intent consumption.

## Remaining Test Coverage

- Focused unit coverage for validation, submit payloads, feed persistence, and media job projection.
