# Runtime Capability Guardrails

Phase 3 upgrades the unified tool runtime from simple `tool pack + allowedTools` filtering to a full capability policy layer.

## What exists now

- Every interactive tool call resolves a `CapabilitySet` before execution.
- `CapabilitySet` merges:
  - `runtimeMode` default pack
  - session metadata such as `allowedTools`
  - active skill overlays
  - entry kind derived from session/runtime context
- High-risk tools and actions now carry approval levels:
  - `none`
  - `light`
  - `explicit`
  - `always_hold`

## Entry kinds

- `interactive`: normal user-facing chat/editor/redclaw turn
- `background_task`: scheduler or automation runtime
- `subagent`: child runtime spawned from orchestration
- `diagnostics`: developer diagnostics runtime

## Guard behavior

All unified tools now go through `tools::guards::preflight_tool_call(...)`.

Guard checks include:

- tool is present in the resolved `CapabilitySet.allowedTools`
- action is the canonical action exposed by the current runtime schema
- path-like arguments stay relative to `currentSpaceRoot`
- profile doc writes only run in `redclaw` or `diagnostics`
- MCP server calls must target a known enabled server
- MCP actions are filtered by `CapabilitySet.mcpScope`
- automated entries (`background_task`, `subagent`) are blocked when approval reaches `explicit` or `always_hold`

## Current policy rules

- Capability policy is evaluated at `tool + action` granularity, not just top-level tool name.
- Canonical tools stay small; permission and audit detail lives on action contracts.
- `redbox_fs` should be granted and audited through canonical actions such as `workspace.read` and `knowledge.search`, not through free-form `scope + action` conventions in prompt assets.
- Skill and prompt assets should only request canonical tool names and canonical actions. Legacy aliases may still be translated by runtime compatibility, but they should not appear in maintenance docs, prompts, or new skills.

## High-risk actions now covered

- `app_cli(action="redclaw.profile.update")`
- `app_cli(action="mcp.call" | "mcp.disconnect")` plus remaining MCP legacy-compatible management actions
- `app_cli(action="skills.invoke")` is low-risk; legacy skill-management actions remain guarded when routed through compatibility
- runtime/task mutation actions exposed through `app_cli(action="runtime.*")`

## Audit records

Every guarded tool call now writes a `CapabilityAuditRecord` into store state.

Each record includes:

- actor
- runtime mode
- entry kind
- session id
- tool name and action
- compat marker when the call entered through a legacy alias or legacy command path
- approval level
- outcome: `allowed`, `blocked`, or `failed`
- reason
- capability fingerprint
- argument summary
- timestamp

The latest audit rows are surfaced through `debug:get-runtime-summary`.

## Diagnostics surfaces

- `runtime.context_bundle` checkpoints now embed `capabilitySet`
- runtime warm summary now includes per-mode `capabilitySet`
- developer diagnostics now shows:
  - runtime warm capability sets
  - recent capability audits
  - capability scopes inside context bundle checkpoints
