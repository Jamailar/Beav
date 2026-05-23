# `features/redclaw`

RedClaw feature helpers that are shared by RedClaw-adjacent pages.

## Modules

- `automationTasks.ts`: automation task draft shaping, schedule conversion, list filtering and sorting.

## Rules

- Pages keep view state and rendering hereafter; shared task/domain shaping belongs in this feature folder.
- Host calls must go through `window.ipcRenderer.redclawRunner`, which is exported from the RedClaw bridge domain.
- Runtime sessions should carry explicit RedClaw metadata: `surface`, `runtimeSurface`, `runtimeMode`, and `redclawContext`.
