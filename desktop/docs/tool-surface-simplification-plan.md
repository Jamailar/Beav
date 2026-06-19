---
doc_type: plan
execution_status: in_progress
last_updated: 2026-06-19
---

# Tool Surface Simplification Plan

## Goal

Reduce model-visible tool noise without removing product capability.

Baseline high-noise groups before the 2026-06-19 compression:

| Group | Current actions | Model visible | Compat only | Target default-visible |
|---|---:|---:|---:|---:|
| Plugins / Skills / MCP | 30 | 30 | 0 | 7-9 |
| Memory / RedClaw profile / task / runner | 23 | 19 | 4 | 6-8 |

Current catalog count after the 2026-06-19 consolidated-action and Codex-gap slice: 166 action descriptors total, 82 model-visible and 84 compatibility-only.

Current model-visible action counts after the 2026-06-19 consolidated-action slice:

| Group | Model visible | Compat only | Main compression result |
|---|---:|---:|---|
| Plugins / Skills / MCP | 8 | 29 | `plugins.discover(source=installed|marketplace|codex|local)`, `skills.inspect(operation=list|read)`, and `mcp.inspect(operation=list|sessions|get|tools|resources|resourceTemplates)` replaced separate read/discovery actions; `mcp.manage` and `skills.manage` replaced management actions |
| Team / Workboard | 6 | 12 | `team.control` replaced 12 model-visible coordination actions |
| Memory / RedClaw profile / task / runner | 8 | 24 | `memory.search(mode=list|search|recall)`, `memory.manage(operation=update|archive|rebuildIndex|diagnostics)`, `profile.manage`, `task.read(operation=preview|list|stats)`, `task.manage`, and `runner.manage` replaced duplicate memory/profile/task/runner actions |
| Media / Image / Video / Voice | 13 | 1 | Product breadth remains; generation/edit/read actions can be folded later |
| Runtime / CLI | 13 | 9 | Added `cli_runtime.execution.writeStdin` to close the Codex stdin-continuation gap; diagnostics-only model catalog remains broad |
| Assets / Subjects | 5 | 6 | `assets.manage` replaced low-frequency asset CRUD/category-create actions |
| Other | 29 | 3 | `workspace.patch` covers edit/create/delete/move, `workspace.inspectImage` covers local image metadata, and `taskBrief.goal` / `taskBrief.context` add Codex-style goal/context lifecycle state without adding a top-level tool |

The target is not fewer backend actions. The target is fewer actions in the default model-facing schema. Low-frequency management and diagnostic actions should remain callable through explicit runtime modes, direct metadata allowlists, or `tool_search`.

## What To Learn From Codex

Codex keeps the generic runtime surface small:

| Codex pattern | Implementation point | RedConvert application |
|---|---|---|
| Tool planning is per turn, not static | `build_tool_specs_and_registry` builds visible specs, registry, deferred tools | Keep `ToolRegistryPlan`, but make default direct lists stricter |
| MCP tools are runtime tools, not MCP management actions | MCP server schemas become namespaced tool specs | Default AI flow should call discovered MCP tools, not manage server config |
| Large MCP inventories are deferred | `DIRECT_MCP_TOOL_EXPOSURE_THRESHOLD` and `tool_search` | Defer MCP management and long-tail MCP tools unless requested |
| Plugin install is a narrow two-step flow | list install candidates, then request install | Collapse marketplace/discover/request/install noise behind one install flow |
| Skills are context access, not a management console | `skills.list`, `skills.read` | Keep list/read or list/invoke, hide install/uninstall by default |
| Memory is small and CRUD-like | add/list/read/search | Collapse recall/list/search and hide diagnostics/rebuild by default |
| Goal state is a tiny state machine | get/create/update | RedClaw task state should be a small state machine, not seven default actions |

## Current Exposure Problem

The code already has deferred discovery, but the default direct list is too broad.

Key behavior in `desktop/src-tauri/src/tools/plan.rs`:

- `DEFAULT_SAFE_DIRECT_APP_CLI_ACTIONS` includes `memory.diagnostics`, multiple RedClaw task actions, asset mutations, plugin/skill actions, and broad team actions.
- When no explicit metadata namespace list is provided, `select_direct_app_cli_actions` expands `max_direct_actions` to at least the full safe list length, so the default cap does not meaningfully reduce this surface.
- Pinned runtime/task intent actions add even more direct tools for team, knowledge, RedClaw, and CLI intent.

This means `tool_search` exists, but too many low-frequency actions are already direct.

## Proposed Tool Surface

### Plugins / Skills / MCP

Default-visible target: 8 actions.

| New default action | Backing current actions | Purpose |
|---|---|---|
| `plugins.discover` | `plugins.list`, `plugins.marketplace`, `plugins.codexMarketplace`, `plugins.discoverLocal` | Read installed plugins or discover candidates from marketplace/cache/local source |
| `plugins.install` | `plugins.requestInstall`, `plugins.install`, `plugins.installCodex` | One explicit install flow with request/approval inside |
| `skills.inspect` | `skills.list`, `skills.read` | List visible skills or read one skill without activation |
| `skills.invoke` | `skills.invoke` | Activate/use one skill |
| `skills.manage` | `skills.installFromRepo`, `skills.uninstall` | One explicit skill install/uninstall operation |
| `mcp.inspect` | `mcp.list`, `mcp.sessions`, `mcp.get`, `mcp.listTools`, `mcp.listResources`, `mcp.listResourceTemplates` | Read saved MCP records, sessions, tools, resources, and resource templates |
| `mcp.manage` | `mcp.add`, `mcp.remove`, `mcp.enable`, `mcp.disable`, `mcp.save`, `mcp.test`, `mcp.disconnect`, `mcp.disconnectAll`, `mcp.discoverLocal`, `mcp.importLocal`, `mcp.oauthStatus` | One explicit MCP configuration/connection management operation |
| `mcp.call` | `mcp.call`, direct MCP tools | Call an MCP tool/resource method |

Default-hidden or deferred:

| Current action | New exposure |
|---|---|
| `mcp.add` | deferred; direct only when user asks to add/configure MCP |
| `mcp.remove` | deferred + approval |
| `mcp.enable` | deferred + approval |
| `mcp.disable` | deferred + approval |
| `mcp.discoverLocal` | folded into `plugins.discover` or deferred under `mcp.manage` |
| `mcp.importLocal` | deferred + approval |
| `mcp.save` | deferred + approval |
| `mcp.test` | diagnostics mode only |
| `mcp.disconnect` | deferred + approval |
| `mcp.disconnectAll` | diagnostics/management mode only |
| `mcp.oauthStatus` | diagnostics/management mode only |
| `plugins.list` | compatibility-only; use `plugins.discover(source=installed)` |
| `skills.list` / `skills.read` | compatibility-only; use `skills.inspect` |
| `skills.installFromRepo` / `skills.uninstall` | compatibility-only; use `skills.manage` |
| `mcp.list` / `mcp.get` / `mcp.sessions` / `mcp.listTools` / `mcp.listResources` / `mcp.listResourceTemplates` | compatibility-only; use `mcp.inspect` |

Implementation note: do not delete these action handlers. Keep them as compatibility execution paths and expose the consolidated action in the model schema.

### Memory / RedClaw

Default-visible target: 6-8 actions.

| New default action | Backing current actions | Purpose |
|---|---|---|
| `memory.search` | `memory.list`, `memory.search`, `memory.recall` | One read path with `mode=list/search/recall`; default direct |
| `memory.note` | `memory.add`, optionally narrow create-only subset | Append or create one memory only when the user explicitly asks to remember/update a durable fact |
| `profile.read` | `redclaw.profile.bundle`, `redclaw.profile.read` | Read AI profile/onboarding/profile docs |
| `task.read` | `redclaw.task.preview`, `redclaw.task.list`, `redclaw.task.stats`, `task.preview`, `task.list` | Preview task drafts, list task definitions, or read counters |
| `runner.manage` | `redclaw.runner.start`, `redclaw.runner.stop`, `redclaw.runner.setConfig`, `redclaw:runner-run-now` | One runner lifecycle/config operation; direct only in diagnostics/maintenance contexts |
| `generation.job.list` | existing | User-visible media job status |
| `generation.job.get` | existing | Read one media job |

Default-hidden or diagnostics-only:

| Current action | New exposure |
|---|---|
| `memory.update` / `memory.archive` / `memory.rebuildIndex` / `memory.diagnostics` | compatibility-only; use `memory.manage` |
| `redclaw.runner.start` / `stop` / `setConfig` | compatibility-only; use `runner.manage` |
| `redclaw.profile.update` | deferred + explicit user confirmation |
| `redclaw.profile.completeStyleDefinition` | onboarding/style setup flow only, not normal default tool surface |
| `redclaw.task.preview` / `redclaw.task.list` / `redclaw.task.stats` | compatibility-only; use `task.read` |
| `redclaw.task.create` | deferred after `task.read(operation=preview)` or explicit schedule/create request |
| `redclaw.task.confirm` | deferred after draft token exists |
| `redclaw.task.update` | deferred + explicit user request |
| `redclaw.task.cancel` | deferred + explicit user request |
| `redclaw.runner.status` | diagnostics/background maintenance only |
| `runner.manage` | diagnostics/background maintenance only + explicit lifecycle/config request |

### Memory Deeper Compression

Codex memory is smaller than the first RedConvert target:

| Codex memory tool | Semantics | Lesson |
|---|---|---|
| `memories.list` | Browse immediate memory files/directories | Use as a navigation operation, not a separate product concept |
| `memories.read` | Read one memory file by path with line limits | Keep exact reads separate from search only when the store is file-like |
| `memories.search` | Search memory files by query/path/cursor/options | Make search the primary retrieval interface |
| `memories.add_ad_hoc_note` | Append one explicit remembered note | Mutating memory is rare and must require explicit user intent |

For RedConvert, the default model surface can be even smaller than Codex because `memory.recall` already shares `memory.search` schema:

| Target RedConvert memory surface | Backing current actions | Default exposure |
|---|---|---|
| `memory.search` | `memory.list`, `memory.search`, `memory.recall` | Direct |
| `memory.note` | `memory.add` | Direct only if memory-writing is allowed for this session; otherwise deferred |
| `memory.manage` | `memory.update`, `memory.archive` | Deferred + explicit user request |
| `memory.diagnostics` | `memory.rebuildIndex`, `memory.diagnostics` | Diagnostics/background only |
| `profile.manage` | `redclaw.profile.update`, `redclaw.profile.completeStyleDefinition` | Deferred or setup-flow direct |
| `task.manage` | `redclaw.task.create`, `redclaw.task.confirm`, `redclaw.task.update`, `redclaw.task.cancel` | Deferred after preview or explicit task-management request |

Recommended default: expose only `memory.search` in normal chat/team/RedClaw turns. Expose `memory.note` only when the user says to remember, update memory, or record a preference. Keep `memory.manage` and diagnostics out of the default direct list.

This moves Memory from 8 current model-visible actions to:

| Mode | Direct Memory actions |
|---|---:|
| Normal default | 1 |
| Explicit remember/update intent | 2 |
| Diagnostics/background-maintenance | 2-4 |

### Team / Workboard Compression

Codex multi-agent tools keep the control surface narrow: spawn, send/follow-up, wait, interrupt, list. RedConvert's Workboard has richer persisted objects, but the model does not need one action per table mutation in the default schema.

Current implemented target:

| Target action | Backing current actions | Default exposure |
|---|---|---|
| `team.guide.create` | confirmed one-shot session/member/task creation | Direct, because it is the safest confirmed team creation path |
| `team.session.list` | session list | Direct read |
| `team.session.get` | session snapshot | Direct read |
| `team.members.list` | member list | Direct read |
| `team.task.list` | task list | Direct read |
| `team.control` | `team.session.create`, `team.member.spawn/match/rename/shutdown/interrupt`, `team.task.create/update`, `team.message.send`, `team.report.request/submit`, `team.artifact.attach`, `team.blocker.raise` | Direct in Team/RedClaw surface; old actions are compatibility-only |

`team.control` is not a workflow black box. It accepts one `operation` and routes to the existing atomic handler. Multi-step orchestration remains the agent's job; the host still enforces confirmation and structured payload checks in the underlying operation.

## Execution Plan

### Step 1: Tighten direct exposure policy

Change only `desktop/src-tauri/src/tools/plan.rs`.

Actions:

- Remove these from `DEFAULT_SAFE_DIRECT_APP_CLI_ACTIONS`: `memory.diagnostics`, RedClaw task mutation actions except preview/list/stats, plugin install/discover variants, MCP mutating management actions, skill install/uninstall.
- Keep low-risk read actions direct: web, task brief, session resources, `memory.search`, profile read, task preview/list/stats, generation job status.
- Do not change action handlers or schemas in this step.

Expected result:

- Existing model can still find long-tail actions through `tool_search`.
- Existing sessions with explicit metadata allowlists still work.
- Default schema gets smaller immediately.

### Step 2: Add action-family presets

Change `families::default_direct_namespaces` or nearby policy.

Actions:

- Introduce a `management` family for plugin/MCP/skill management.
- Introduce a `diagnostics` family for memory diagnostics, runner, MCP probe/disconnect/status.
- Keep `plugins`, `skills`, `mcp`, `memory`, and `redclaw.task` as discoverable deferred namespaces, not default direct namespaces.

Expected result:

- AI can still use these tools when session metadata says `directActionFamilies=["management"]` or runtime mode is diagnostics.
- Ordinary chat/team/redclaw turns get a smaller direct list.

### Step 3: Consolidate schema aliases

Only after Step 1 is validated.

Actions:

- Add consolidated action descriptors:
  - `plugins.discover`
  - `mcp.tools`
  - `memory.note`
  - `memory.manage`
  - `profile.read`
  - `task.list`
- Keep old action descriptors as `CompatOnly` for at least one release.
- Route consolidated actions to existing handlers internally.

Expected result:

- Model-facing names match user intent.
- Old prompts and skills remain compatible.

### Step 4: Move runner and diagnostics out of normal AI surface

Actions:

- Ensure `memory.rebuildIndex`, `memory.diagnostics`, `redclaw.runner.*`, `mcp.test`, `mcp.oauthStatus`, and disconnect actions are direct only in diagnostics/background-maintenance mode or explicit metadata allowlist.
- Keep UI/operator controls for these actions outside the normal model tool schema.

Expected result:

- The model no longer sees operations it should rarely decide to run.
- Operators still have full control.

### Step 5: Consolidate MCP and Team model actions

Actions:

- Add `mcp.manage` as the single model-facing MCP management action.
- Move `mcp.add/remove/enable/disable/discoverLocal/importLocal/save/test/disconnect/disconnectAll/oauthStatus` to `CompatOnly`.
- Add `team.control` as the single model-facing Workboard control action.
- Move low-level Team mutation/report actions to `CompatOnly`, while keeping read actions direct.
- Update `app_cli` canonical policy mapping and `compat` normalization so legacy action names still execute when the consolidated action is direct or allowed.

Expected result:

- Plugins/Skills/MCP full model catalog drops from 23 to 13.
- Team/Workboard full model catalog drops from 17 to 6.
- Existing handler behavior and old transcripts remain compatible.

## Verification Matrix

| Check | Command or method | Pass criteria |
|---|---|---|
| Action inventory | Unit-style snapshot of `tool_plan_snapshot_for_session` | Default direct action count decreases; deferred count increases |
| Team mode | Build plan for `runtimeMode=team` | `team.control` and read actions remain; old low-level team mutations are not direct; MCP management is deferred |
| RedClaw mode | Build plan for `runtimeMode=redclaw` | Memory/task reads stay direct; diagnostics/runner hidden or deferred |
| Diagnostics mode | Build plan for `runtimeMode=diagnostics` | Diagnostics and MCP maintenance actions are direct |
| Explicit allowlist | Metadata `allowedAppCliActions` | Requested actions remain direct |
| Tool search | Query deferred action names | Hidden management actions can be discovered |

## Target Metrics

| Metric | Current | Step 1 target | Final target |
|---|---:|---:|---:|
| Plugins / Skills / MCP model catalog actions | 30 baseline / 13 current | 12-16 | 7-9 |
| Team / Workboard model catalog actions | 17 baseline / 6 current | 6 | 5-6 |
| Memory / RedClaw model catalog actions | 19 baseline / 12 current | 8-10 direct | 6-8 model catalog |
| Memory-only direct model actions | 8 baseline / 1 default current | 1-2 | 1 default, 2 with explicit remember intent |
| Compat-only backend actions removed | 0 | 0 | 0 initially |
| User-visible product capability removed | 0 | 0 | 0 |

## Progress

### 2026-06-18: Memory direct exposure compressed

Implemented the first default-policy slice in `desktop/src-tauri/src/tools/plan.rs` and `desktop/src-tauri/src/tools/families/mod.rs`.

- Normal `redclaw`, `team`, `knowledge`, and `image-generation` turns now keep only `memory.search` direct.
- `memory.list`, `memory.recall`, `memory.add`, `memory.update`, `memory.archive`, `memory.rebuildIndex`, and `memory.diagnostics` remain available as deferred actions.
- Default direct namespaces no longer promote the whole `memory` namespace.

Verification:

```bash
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
```

Result: 18 tests passed at the time of the slice.

### 2026-06-19: Skills, MCP, and RedClaw task exposure compressed

Implemented the second default-policy slice in `desktop/src-tauri/src/tools/plan.rs`, `desktop/src-tauri/src/tools/families/mod.rs`, and `desktop/src-tauri/src/mcp/tool_exposure.rs`.

- `skills.list` and `skills.invoke` stay direct; `skills.installFromRepo` and `skills.uninstall` are deferred by default.
- `mcp.list` and `mcp.listTools` stay direct; MCP management actions such as add/remove/enable/disable/import/save/test/disconnect/oauth status are deferred by default.
- Runtime MCP server tools are deferred by default even when the inventory is small. They become direct only through explicit `directMcpTools` pinning or explicit `maxDirectMcpTools` metadata.
- `redclaw.task.preview`, `redclaw.task.list`, and `redclaw.task.stats` stay direct; `redclaw.task.create`, `redclaw.task.confirm`, `redclaw.task.update`, and `redclaw.task.cancel` are deferred by default.
- Default direct namespaces no longer promote the whole `skills` namespace or the whole `redclaw.task` namespace in normal task intent.
- Explicit `directActionFamilies` now supports `management` as `plugins/mcp/skills` and `diagnostics` as runtime/CLI/MCP namespaces, without changing the normal default surface.
- Focused regression tests now assert the high-noise default direct groups stay within target: Plugins/Skills/MCP <= 9 and Memory/RedClaw <= 8.

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml mcp::tool_exposure::tests
```

Result: `tools::plan::tests` passed 22 tests; `mcp::tool_exposure::tests` passed 3 tests.

### 2026-06-19: Consolidated model actions and diagnostics-only maintenance

Implemented the alias consolidation and diagnostics maintenance slice in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, and the plan/family policy modules.

- Added model-facing consolidated actions:
  - `plugins.discover`
  - `mcp.tools`
  - `memory.note`
  - `memory.manage`
  - `profile.read`
  - `task.preview`
  - `task.list`
- Folded old read/discovery variants into compatibility-only schema entries where a consolidated action exists:
  - `plugins.connectors`, `plugins.marketplace`, `plugins.codexMarketplace`, `plugins.discoverLocal`, `plugins.installCodex`, `plugins.requestInstall`
  - `memory.add`, `memory.update`, `memory.archive`
  - `mcp.get`, `mcp.sessions`, `mcp.listTools`
  - `redclaw.profile.bundle`, `redclaw.profile.read`, `redclaw.task.preview`, `redclaw.task.list`, `redclaw.task.stats`
- Left MCP mutating management actions model-visible only until the next slice introduced `mcp.manage`; see the following section for the completed consolidation.
- Added canonical policy mapping so old action names can still execute when the corresponding consolidated action is direct/allowed.
- Moved `memory.rebuildIndex`, `memory.diagnostics`, and `redclaw.runner.*` out of normal RedClaw model runtime and into diagnostics/background-maintenance model runtime.

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml mcp::tool_exposure::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
```

Result: `tools::plan::tests` passed 22 tests; `tools::catalog::tests` passed 15 tests; `mcp::tool_exposure::tests` passed 3 tests; the focused app-cli alias mapping test passed.

Known unrelated test failure:

```bash
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::app_cli::tests
```

This broader app-cli test filter currently fails in `build_video_project_relative_path_preserves_parent_but_replaces_file_name`, a video project path timestamp assertion unrelated to the tool-surface changes.

### 2026-06-19: MCP and Team consolidated action slice completed

Implemented the next compression slice in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Added `mcp.manage` with `operation`-based atomic routing for add/remove/enable/disable/save/test/disconnect/discover/import/OAuth status.
- Moved old MCP management actions to `CompatOnly`: `mcp.add`, `mcp.remove`, `mcp.enable`, `mcp.disable`, `mcp.discoverLocal`, `mcp.importLocal`, `mcp.save`, `mcp.test`, `mcp.disconnect`, `mcp.disconnectAll`, `mcp.oauthStatus`.
- Added `team.control` with one-operation routing for Workboard session/member/task/message/report/artifact/blocker mutations.
- Moved old Team mutation/report actions to `CompatOnly`: `team.session.create`, `team.member.spawn`, `team.member.match`, `team.member.rename`, `team.member.shutdown`, `team.task.create`, `team.task.update`, `team.message.send`, `team.report.request`, `team.report.submit`, `team.artifact.attach`, `team.blocker.raise`.
- Kept Team read actions model-visible: `team.session.list`, `team.session.get`, `team.members.list`, `team.task.list`, plus confirmed creation via `team.guide.create`.
- Updated compatibility normalization so legacy `mcp` and `Operate(resource=team.*)` calls produce `mcp.manage` or `team.control` payloads with an explicit `operation`.
- Added canonical policy aliases so old action names still execute when the consolidated action is direct or allowed.

Current grouped action count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 20 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 16 | 14 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 8 | 2 |
| Other | 26 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_mcp_to_app_cli
```

Result: `tools::plan::tests` passed 22 tests; `tools::catalog::tests` passed 15 tests; both focused app-cli/compat tests passed.

### 2026-06-19: Workspace patch action added

Implemented the first missing Codex-style file editing capability in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/host_impl.rs`.

- Added `workspace.patch` under the existing `resource` tool; no new top-level tool was added.
- The action patches one existing UTF-8 workspace file with an `edits` array of exact `oldText` / `newText` replacements.
- It now also supports `operation=create|delete|move` with `content` or `toPath` as needed.
- Each edit must match exactly once by default. `replaceAll=true` is required for intentional multi-match replacement.
- The runtime rejects parent-directory traversal, resolves through the existing session workspace policy, refuses directories, and returns before/after SHA-256 hashes.
- This intentionally remains schema-first rather than Codex's freeform patch grammar, but it now covers the same core file operations: edit, add, delete, and move.

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml apply_workspace_patch
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml redbox_fs_schema_uses_explicit_action_variants
```

Result: `apply_workspace_patch` passed 7 tests; `redbox_fs_schema_uses_explicit_action_variants` passed.

### 2026-06-19: CLI stdin continuation added

Implemented the Codex-style stdin continuation gap in `desktop/src-tauri/src/cli_runtime/pty.rs`, `desktop/src-tauri/src/cli_runtime/executor.rs`, `desktop/src-tauri/src/commands/cli_runtime.rs`, `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/app_cli_cli_runtime.rs`, and `desktop/src-tauri/src/tools/compat.rs`.

- Changed background `usePty=true` CLI launches to keep a piped stdin handle.
- Added `cli_runtime.execution.writeStdin` under the existing `workflow/app_cli` action surface; no new top-level tool was added.
- The action writes explicit text to one running CLI execution, can append one newline, and can close stdin after writing.
- The runtime refuses non-running executions, missing interactive process handles, empty no-op writes, and already-closed stdin.
- Added compatibility normalization for `Operate(resource=cli_runtime, operation=write-stdin|input)`.

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml write_cli_execution_stdin_unblocks_background_process
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
```

Result: stdin continuation test passed; `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests.

### 2026-06-19: Assets management slice completed

Implemented the Assets/Subjects compression slice in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Added `assets.manage` with `operation=create|update|delete|category.create`.
- Moved `assets.create`, `assets.update`, `assets.delete`, and `assets.categories.create` to `CompatOnly`.
- Kept `assets.search`, `assets.get`, `assets.categories.list`, and `assets.generateCharacterCard` model-visible.
- Updated default direct actions and compatibility normalization so legacy asset mutation calls route through `assets.manage`.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 20 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 16 | 14 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 26 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_asset_mutation_actions_from_operate
```

Result: `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; asset compatibility normalization test passed.

### 2026-06-19: Skill read action added

Implemented the Codex-style skill instruction read gap in `desktop/src-tauri/src/commands/skills_ai.rs`, `desktop/src-tauri/src/tools/app_cli_domains.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/catalog.rs`, and `desktop/src-tauri/src/tools/compat.rs`.

- Added `skills.read` for reading one skill's full loaded instructions and metadata without activating it.
- Added `skills:read` command channel, `skills read --name <skill>` route, direct `skills.read` action route, and compatibility normalization for `Operate(resource=skills, operation=read|get)`.
- Kept `skills.invoke` behavior unchanged; read does not mutate session skill state.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 14 | 20 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 16 | 14 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 26 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_redbox_skill_read_id_to_name
```

Result: `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; skill-read compatibility normalization test passed.

### 2026-06-19: Workspace image inspection added

Implemented the Codex-style local image inspection gap in `desktop/src-tauri/src/host_impl.rs`, `desktop/src-tauri/src/tools/catalog.rs`, and `desktop/src-tauri/src/tools/compat.rs`.

- Added `workspace.inspectImage` under the existing `resource` tool; no new top-level tool was added.
- The action resolves workspace/session-relative paths through the existing workspace resolver and rejects parent-directory traversal.
- It returns image mime type, dimensions, byte size, SHA-256, and optionally a data URL for small images.
- Compatibility normalization maps `resource`/`redbox_fs` `inspect-image`, `inspectImage`, and `image-info` style calls to `workspace.inspectImage`.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 14 | 20 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 16 | 14 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 27 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml workspace_inspect_image_response
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_redbox_fs_inspect_image_action
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml redbox_fs_schema_uses_explicit_action_variants
```

Result: image inspection helper test, compatibility normalization test, and resource schema test passed.

### 2026-06-19: Profile and RedClaw task mutation slice completed

Implemented the Memory/RedClaw consolidation slice in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Added `profile.manage` with `operation=update|completeStyleDefinition`.
- Moved `redclaw.profile.update` and `redclaw.profile.completeStyleDefinition` to `CompatOnly`.
- Added `task.manage` with `operation=create|confirm|update|cancel`.
- Moved `redclaw.task.create`, `redclaw.task.confirm`, `redclaw.task.update`, and `redclaw.task.cancel` to `CompatOnly`.
- Kept `task.preview`, `task.list`, and `profile.read` model-visible.
- Updated profile/task canonical policy aliases and compatibility normalization.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 20 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 16 | 14 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 26 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_operate_redclaw_profile_complete_style_definition_action
```

Result: `tools::plan::tests` passed 22 tests; `tools::catalog::tests` passed 15 tests; both focused app-cli/compat tests passed.

### 2026-06-19: Runner lifecycle mutation slice completed

Implemented the RedClaw runner lifecycle consolidation slice in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, `desktop/src-tauri/src/tools/families/mod.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Added `runner.manage` with `operation=start|stop|setConfig|runNow`.
- Moved `redclaw.runner.start`, `redclaw.runner.stop`, and `redclaw.runner.setConfig` to `CompatOnly`.
- Kept `redclaw.runner.status` model-visible for diagnostics.
- Updated canonical policy aliases and compatibility normalization so legacy `redclaw runner-start` / `runner-stop` / `runner-set-config` commands and `Operate(resource=redclaw.runner, ...)` calls route through `runner.manage`.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 14 | 20 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 14 | 17 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 27 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_redclaw_runner_mutations_to_runner_manage
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
```

Result: `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; both focused runner/app-cli compatibility tests passed.

### 2026-06-19: Skills management slice completed

Implemented the Skills management consolidation slice in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Added `skills.manage` with `operation=installFromRepo|uninstall`.
- Moved `skills.installFromRepo` and `skills.uninstall` to `CompatOnly`.
- Kept `skills.list`, `skills.read`, and `skills.invoke` model-visible.
- Updated canonical policy aliases and compatibility normalization so legacy `skills install-from-repo` / `skills uninstall` commands and `Operate(resource=skills, ...)` calls route through `skills.manage`.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 22 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 14 | 17 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 27 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_redbox_skill_management_to_skills_manage
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
```

Result: `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; both focused skills/app-cli compatibility tests passed.

### 2026-06-19: Task Brief goal lifecycle slice completed

Implemented a Codex-style goal lifecycle bridge in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/app_cli_domains.rs`, and `desktop/src-tauri/src/tools/compat.rs`.

- Added `taskBrief.goal` with `operation=get|create|update`.
- Stores bounded goal state under current session metadata at `taskBrief.goal`.
- `create` writes `objective`, `status=active`, timestamps, and optional `tokenBudget`; it refuses to overwrite an unfinished goal.
- `update` can set `status=active|complete|blocked|cancelled`, `reason`, `tokenUsage`, `tokenBudget`, and timestamps such as `completedAt` / `blockedAt`.
- Compatibility normalization maps `Operate(resource=goal, operation=create|update|get)` and `task-brief goal <operation>` style calls to `taskBrief.goal`.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 22 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 14 | 17 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 28 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_goal_resource_to_task_brief_goal
```

Result: `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; focused goal compatibility test passed.

### 2026-06-19: Team member resume/wait/interrupt lifecycle slice completed

Implemented bounded Codex-style member lifecycle controls in `desktop/src-tauri/src/runtime/collab_runtime/member_management.rs`, `desktop/src-tauri/src/commands/runtime_collab/member_values.rs`, `desktop/src-tauri/src/commands/runtime_collab/team_wake.rs`, `desktop/src-tauri/src/commands/runtime_collab.rs`, `desktop/src-tauri/src/commands/runtime_session.rs`, `desktop/src-tauri/src/tools/app_cli_runtime.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/catalog.rs`, and `desktop/src-tauri/src/tools/compat.rs`.

- Extended `team.control` with `operation=member.resume|member.wait|member.interrupt`.
- `member.resume` restores an offline/suspended member to `idle` by default, clears `lastError`, emits the member update, and schedules an existing team-member wake.
- `member.wait` polls the member status and active wake set until the member is settled or `timeoutMs` expires. The timeout is clamped to 30 seconds.
- `member.interrupt` requests cancellation for the member conversation session, kills a registered active child process when present, and marks the member with the requested terminal status, defaulting to `failed`.
- Compatibility normalization maps `Operate(resource=team.member, operation=resume|wake|wait|interrupt|cancel)` to `team.control`.
- `member.shutdown` remains lifecycle/offline control; active turn cancellation should use `member.interrupt`.

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_operate_team_resources_to_structured_actions
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
```

Result: `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; focused Team compatibility and app-cli policy tests passed.

### 2026-06-19: Task Brief context budget slice completed

Implemented a Codex-style context-budget bridge in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/app_cli_domains.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Added `taskBrief.context` with `operation=get|compact`.
- `get` returns existing session context usage from `session_context_usage_value`, plus `estimatedRemainingTokens`, `remainingRatio`, `isEstimate=true`, and the estimation basis.
- `compact` reuses the existing manual session compaction path, writes the compact boundary entry on success, and returns the resulting usage snapshot.
- Compatibility normalization maps `Operate(resource=context, operation=get|compact)` and `task-brief context <operation>` style calls to `taskBrief.context`.
- This is intentionally not a provider-real context-window API. It reports RedConvert's configured compact threshold and session-message estimate, which is the only current accounting available in the runtime.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 22 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 14 | 17 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 29 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_context_resource_to_task_brief_context
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
```

Result: focused context compatibility test passed; `tools::catalog::tests` passed 15 tests; `tools::plan::tests` passed 22 tests; app-cli policy test passed.

### 2026-06-19: Memory read-mode compression completed

Implemented the Codex-style memory read consolidation in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, and `desktop/src-tauri/src/tools/compat.rs`.

- Extended `memory.search` with `mode=list|search|recall`.
- Moved `memory.list` and `memory.recall` to `CompatOnly`.
- `workflow(action=memory.search, payload={mode})` now routes to the existing list/search/recall memory channels.
- Compatibility normalization maps `List(memory://...)`, `Operate(resource=memory, operation=list|search|recall)`, and `memory list/search/recall` style calls to `memory.search` with an explicit mode.
- Added a catalog regression test to keep full model-visible high-noise groups compressed.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 22 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 12 | 19 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 29 | 3 |

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml normalizes_memory_read_variants_to_memory_search_modes
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
```

Result: focused memory compatibility and app-cli policy tests passed; `tools::catalog::tests` passed 16 tests; `tools::plan::tests` passed 22 tests.

### 2026-06-19: Memory maintenance, runner status, and task read compression completed

Implemented the deeper Memory/RedClaw compression in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Extended `memory.manage` with `operation=rebuildIndex|diagnostics`, then moved `memory.rebuildIndex` and `memory.diagnostics` to `CompatOnly`.
- Extended `runner.manage` with `operation=status`, then moved `redclaw.runner.status` to `CompatOnly`.
- Added `task.read(operation=preview|list|stats)`, then moved `task.preview`, `task.list`, `redclaw.task.preview`, `redclaw.task.list`, and `redclaw.task.stats` to `CompatOnly`.
- Compatibility normalization maps old RedClaw task commands and `Operate(resource=redclaw.task, operation=preview|list|stats)` to `task.read`.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 13 | 22 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 8 | 24 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 29 | 3 |

### 2026-06-19: Plugin, skill, and MCP read/discovery compression completed

Implemented the second high-noise group compression in `desktop/src-tauri/src/tools/catalog.rs`, `desktop/src-tauri/src/tools/app_cli.rs`, `desktop/src-tauri/src/tools/compat.rs`, and `desktop/src-tauri/src/tools/plan.rs`.

- Moved `plugins.list` to `CompatOnly` and made `plugins.discover(source=installed|marketplace|codex|local)` the single plugin read/discovery entrypoint.
- Added `skills.inspect(operation=list|read)`, then moved `skills.list` and `skills.read` to `CompatOnly`.
- Added `mcp.inspect(operation=list|sessions|get|tools|resources|resourceTemplates)`, then moved `mcp.list`, `mcp.sessions`, `mcp.get`, `mcp.tools`, `mcp.listTools`, `mcp.listResources`, and `mcp.listResourceTemplates` to `CompatOnly`.
- Kept `mcp.call`, `mcp.manage`, `skills.invoke`, `skills.manage`, and `plugins.install` separate because they represent different safety and side-effect boundaries.

Current grouped count after this slice:

| Group | Model | CompatOnly |
|---|---:|---:|
| Plugins / Skills / MCP | 8 | 29 |
| Team / Workboard | 6 | 12 |
| Memory / RedClaw profile / task / runner | 8 | 24 |
| Media / Image / Video / Voice | 13 | 1 |
| Runtime / CLI | 13 | 9 |
| Assets / Subjects | 5 | 6 |
| Other | 29 | 3 |

Total catalog count: 166 action descriptors, 82 model-visible and 84 compatibility-only.

Verification:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::compat::tests
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test --manifest-path desktop/src-tauri/Cargo.toml canonical_app_cli_action_for_policy_maps_consolidated_aliases
```

Result: catalog, plan, compat, and canonical app-cli policy tests passed.

## Commit Slicing Notes

Keep commits atomic if this work is committed later:

- One commit for default direct exposure policy.
- One commit per consolidated action family such as `mcp.manage`, `team.control`, `assets.manage`, `profile.manage` / `task.manage`, or `runner.manage`.
- One commit per Codex-gap capability such as `workspace.patch`, `workspace.inspectImage`, `cli_runtime.execution.writeStdin`, or `skills.read`.
- One documentation commit if needed after code slices have passed tests.

## Non-Goals

- Do not delete MCP, plugin, skill, memory, or RedClaw handlers.
- Do not redesign the UI.
- Do not remove compatibility aliases yet.
- Do not force model-visible actions based on natural-language keywords.
- Do not add more top-level tools; use action policy and deferred discovery first.
