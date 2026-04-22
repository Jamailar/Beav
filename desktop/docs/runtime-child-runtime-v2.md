# Runtime Child Runtime V2

Phase 4 upgrades real subagents from loosely bounded child turns into explicit child runtimes.

## What changed

- real subagents are now gated by `settings.feature_flags.runtimeSubagentRuntimeV2`
- child runtime config is fully typed in `src-tauri/src/subagents/types.rs`
- every child runtime now carries:
  - `childRuntimeType`
  - `contextPolicy`
  - `memoryPolicy`
  - `approvalPolicy`
  - `budget`
  - `resultContract`

## Child runtime types

Current policy buckets:

- `researcher`
- `reviewer`
- `fixer`
- `editor-planner`
- `publisher-safe`

The runtime role id is still preserved separately, so `planner`, `copywriter`, `animation-director`, and other roles can map onto different child runtime types without changing orchestration prompts.

## Default inheritance rules

Child sessions no longer clone arbitrary parent metadata.

The host now only inherits whitelisted parent context:

- workspace-level hints when `contextPolicy.inheritWorkspaceContext` is enabled
- editor binding fields when `contextPolicy.inheritEditorBinding` is enabled
- profile doc roots only when explicitly enabled

By default child runtimes do **not** inherit:

- large parent transcript history
- memory write permissions
- profile doc mutation ability
- high-risk MCP write actions

## Result contract

Child runtime output is normalized to this contract:

- `summary`
- `artifact`
- `artifactRefs`
- `findings`
- `risks`
- `issues`
- `handoff`
- `approvalsRequested`
- `approved`
- `status`

Parent orchestration only consumes the structured output bundle. Child intermediate tool traces stay on the child session/task side.

## Events

`runtime:subagent-started` and `runtime:subagent-finished` now include:

- `parentRuntimeId`
- `childRuntimeId`
- `childRuntimeType`
- `phase`
- `status`
- `resultSummary`

## Cancellation

Cancelling a parent runtime task now recursively cancels child tasks and forwards runtime cancellation to child sessions, including killing any active child model process owned by that child session.
