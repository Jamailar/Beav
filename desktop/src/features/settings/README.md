# `src/features/settings/`

Renderer-side settings feature helpers.

## Boundaries

- `settingsModel.ts` owns side-effect-light settings models and pure helpers: AI pricing catalog parsing/formatting, runtime perf presets, Settings tab/model-route types, voice model defaults, MCP draft normalization, and visual index prompt normalization.
- `pages/Settings.tsx` owns data loading, save coordination, tab composition, dialogs, and IPC calls.
- `pages/settings/` owns reusable settings UI sections and setting-page local controls.

## Rules

- Keep model helpers deterministic and independent from IPC.
- Do not add settings UI here; put UI in `pages/settings/` or a section component near the page.
- Route defaults must stay compatible with `ai_model_routes_json`.
