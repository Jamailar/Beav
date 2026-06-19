---
doc_type: reference
execution_status: completed
last_updated: 2026-06-19
---

# Codex vs RedConvert AI Tool Surface Comparison

Scope: code inspection of `/Users/Jam/LocalDev/GitHub/codex` and `/Users/Jam/LocalDev/GitHub/RedConvert`, refreshed after the 2026-06-19 RedConvert tool-surface compression. This document lists tools the model can use directly or conditionally through runtime planning, including deferred MCP/dynamic tools.

## Architecture Comparison

| Area | Codex | RedConvert / RedBox | Judgment |
|---|---|---|---|
| Tool architecture | `ToolRouter` builds per-turn visible specs and dispatches through a typed `ToolRegistry`; handlers implement `CoreToolRuntime`. | `tools/plan.rs` builds a per-session `ToolRegistryPlan`; visible tools are compact names like `Read`, `Search`, `Operate`, plus many action descriptors under `Operate`. | Codex is stronger in typed dispatch and lifecycle hooks; RedConvert is stronger in product-specific action breadth. |
| Exposure model | Direct, hidden, deferred, hosted, extension, dynamic, MCP. | Direct visible tools, hidden/compat aliases, deferred app actions, direct/deferred MCP tools, action whitelists by runtime mode. | RedConvert already mirrors the right pattern, but `Operate` is still a broad capability surface. |
| Shell/files | Strong sandboxed command execution, stdin continuation, patch tool, image file inspection. | `shell`, `bash`, and structured workspace/knowledge actions. | RedConvert should prefer structured file/actions for product work; keep shell mostly diagnostic. |
| Web | Hosted Responses web search or standalone `web.run`; MCP can add more. | `web.fetch` and `web.search` actions under `Operate`. | RedConvert has the right user-facing split: fetch URL vs search web. |
| MCP | MCP tools become namespaced model tools; resource tools are separate. | MCP management is product action based; `mcp.manage` now folds server config/session management; direct MCP tools can be exposed from inventory. | Codex MCP runtime is cleaner for arbitrary tools; RedConvert adds better in-app configuration management with a smaller model-visible management surface. |
| Skills/plugins | Extension contributors expose tool executors; plugin discovery and install request are first-class. | Plugins and skills are managed through `Operate` actions, including Codex-compatible plugin install. | RedConvert has product-friendly management; Codex has cleaner extension injection. |
| Multi-agent | Dedicated V1/V2 agent tools, optional namespace, wait/message lifecycle. | Team/Workboard read actions plus `team.control` under `Operate`; low-level mutations remain compatibility-only. | Codex is better as an agent runtime; RedConvert is better as a persistent product workboard. |
| Media/product actions | Mostly generic image/web/file/runtime tools. | Native image, video, voice, asset, manuscript, media edit/transcribe, RedClaw task/profile tools. | RedConvert has much deeper product capability surface. |
| Performance controls | Bounded specs, deferred tools, code mode wrapping, output truncation, sandbox retry orchestration. | Direct action cap, deferred action namespaces, output budgets, runtime-mode packs, stale action aliases. | RedConvert should continue reducing direct action count and move more large surfaces behind search/deferred exposure. |

## RedConvert Compression Snapshot

Current grouped `Operate` action count after the 2026-06-19 consolidation:

| Group | Model-visible catalog | Compat-only catalog | Current judgment |
|---|---:|---:|---|
| Plugins / Skills / MCP | 8 | 29 | Good; `plugins.discover`, `skills.inspect`, and `mcp.inspect` folded read/discovery actions while `mcp.manage` and `skills.manage` folded management actions |
| Team / Workboard | 6 | 12 | Good; comparable to Codex multi-agent's narrow control surface while preserving Workboard state |
| Memory / RedClaw profile / task / runner | 8 | 24 | Good; `memory.search`, `memory.manage`, `profile.read/manage`, `task.read/manage`, and `runner.manage` keep reads and lifecycle operations compact |
| Media / Image / Video / Voice | 13 | 1 | Product capability breadth is real; next compression should be `media.generate` / `media.inspect` only if UX prompts become noisy |
| Runtime / CLI | 13 | 9 | Added `cli_runtime.execution.writeStdin` for Codex-style stdin continuation; remaining diagnostics/runtime control should stay diagnostics/background-maintenance oriented |
| Assets / Subjects | 5 | 6 | Improved; `assets.manage` folded asset create/update/delete/category-create while keeping search/get/category-list/generate-card direct |
| Other | 29 | 3 | `workspace.patch` covers structured edit/create/delete/move, `workspace.inspectImage` covers local image metadata, and `taskBrief.goal` / `taskBrief.context` cover goal and context lifecycle state without adding a top-level tool |

Implemented Codex lessons:

| Codex lesson | RedConvert implementation |
|---|---|
| Keep extension/plugin/MCP management narrow | Added `plugins.discover`, `plugins.install`, `mcp.manage`; moved old MCP management actions to `CompatOnly` |
| Keep multi-agent control narrow | Added `team.control`; moved low-level Team mutation/report actions to `CompatOnly` |
| Preserve compatibility while shrinking model schema | `app_cli` canonical policy maps old action names to consolidated actions; `compat` emits consolidated payloads with `operation` |
| Use deferred/direct planning instead of deleting capability | Team default keeps reads direct; MCP management is deferred unless management/diagnostics family is explicit |
| Keep memory/task mutations rare and explicit | `profile.manage` and `task.manage` now fold low-frequency RedClaw mutations while `profile.read` and `task.read(operation=preview|list|stats)` stay readable |
| Collapse memory reads into one path | `memory.search(mode=list|search|recall)` now replaces separate model-visible `memory.list` and `memory.recall` |
| Keep runner lifecycle changes narrow | Added `runner.manage`; moved runner start/stop/setConfig aliases to `CompatOnly` while keeping status readable in diagnostics |
| Prefer structured patching to whole-file writes | Added `workspace.patch` for exact UTF-8 file replacements plus create/delete/move under the existing `resource` tool |
| Preserve interactive CLI continuation | Added `cli_runtime.execution.writeStdin` for running `usePty=true` CLI executions |
| Collapse low-frequency asset mutations | Added `assets.manage`; moved asset CRUD/category-create aliases to `CompatOnly` |
| Read skill instructions without activation | Added `skills.inspect(operation=read)`; `skills.invoke` remains the activation path |
| Keep skill install/uninstall narrow | Added `skills.manage`; moved low-frequency install/uninstall aliases to `CompatOnly` |
| Inspect local images without shelling out | Added `workspace.inspectImage` for workspace image dimensions, mime type, hash, byte size, and optional small data URL |
| Keep long-running goal state explicit | Added `taskBrief.goal` for get/create/update style goal lifecycle state inside the existing Task Brief boundary |
| Keep context-budget maintenance explicit | Added `taskBrief.context` for estimated remaining context and manual compaction inside the existing Task Brief boundary |
| Add bounded agent lifecycle controls | Extended `team.control` with `member.resume`, `member.wait`, and `member.interrupt`; `member.shutdown` remains lifecycle/offline control |

## Codex Tool Inventory

| Tool | Type/source | Visible condition | Capability | RedConvert equivalent |
|---|---|---|---|---|
| `exec_command` | Core unified exec | Shell tool + unified exec enabled + environment available | Run command in PTY/plain pipe, sandboxed, supports ongoing process session. | `shell`, `cli_runtime.execute` |
| `write_stdin` | Core unified exec | With `exec_command` | Write stdin to an existing unified exec session. | `cli_runtime.execution.writeStdin` for running `usePty=true` executions. |
| `shell_command` | Core legacy shell | Shell tool enabled when unified exec is not model-visible; hidden dispatch fallback when unified exec is active | Run shell command through older shell tool path. | `shell`, `bash` |
| `request_permissions` | Core shell utility | `RequestPermissionsTool` feature | Ask for extra execution permissions for the turn. | `approval.request`, `cli_runtime.escalation.approve/deny` |
| `apply_patch` | Core freeform patch | Environment available and model supports patch tool | Structured file add/update/delete/move patching. | `workspace.patch` covers schema-first exact replacements plus create/delete/move for workspace UTF-8 files; it intentionally does not expose Codex's freeform patch grammar. |
| `view_image` | Core utility | Environment available | Load local image for visual inspection, optionally original detail. | `workspace.inspectImage` returns local image metadata and optional small data URL; model-vision display is still host-specific. |
| `update_plan` | Core utility | Always added | Update task plan. | `taskBrief.update`; no separate UI plan tool. |
| `request_user_input` | Core utility | Experimental request-user-input enabled; root thread only; allowed collaboration modes | Ask 1-3 structured questions and wait for response. | `approval.request` |
| `new_context` | Core utility | Token budget feature | Start a new context window without summarizing history. | `taskBrief.context(operation=compact)` uses RedConvert's existing session compaction boundary; it is not a fresh provider context window. |
| `get_context_remaining` | Core utility | Token budget feature | Report remaining context tokens. | `taskBrief.context(operation=get)` returns estimated remaining tokens against RedConvert's compact threshold, marked `isEstimate=true`. |
| `tool_search` | Core discovery | Search tool + namespace tools enabled and deferred tools exist | BM25 search over deferred tool metadata and expose loadable tools. | `tool_search` |
| `list_available_plugins_to_install` | Core plugin discovery | Tool suggest + apps + plugins enabled and discoverable tools exist | List installable plugin/connector candidates. | `plugins.discover(source=installed|codex|local)` |
| `request_plugin_install` | Core plugin discovery | Same as above | Request install of discovered plugin/connector. | `plugins.requestInstall`, `plugins.install`, `plugins.installCodex` |
| `list_mcp_resources` | Core MCP resource | MCP tools present | List MCP server resources. | `mcp.listResources` |
| `list_mcp_resource_templates` | Core MCP resource | MCP tools present | List MCP resource templates. | `mcp.listResourceTemplates` |
| `read_mcp_resource` | Core MCP resource | MCP tools present | Read one MCP resource. | `mcp.call` or direct MCP resource exposure |
| `mcp__<server>__<tool>` / namespaced MCP tool | Core MCP runtime | MCP server exposes tools; direct or deferred by exposure policy | Invoke arbitrary MCP tool using server schema. | Direct MCP tools from inventory, or `mcp.call` |
| `spawn_agent` | Multi-agent V2 | Multi-agent V2 enabled | Spawn sub-agent with task name and message. | `team.control(operation=member.spawn)`, `team.guide.create` |
| `send_message` | Multi-agent V2 | Multi-agent V2 enabled | Send message to live agent without new turn. | `team.control(operation=message.send)` |
| `followup_task` | Multi-agent V2 | Multi-agent V2 enabled | Send follow-up task and trigger turn if idle. | `team.control(operation=task.create/message.send)` |
| `wait_agent` | Multi-agent V2 | Multi-agent V2 enabled | Wait for mailbox update or timeout. | `team.control(operation=member.wait)` plus `team.session.get`, `team.task.list` |
| `interrupt_agent` | Multi-agent V2 | Multi-agent V2 enabled | Interrupt agent's current turn. | `team.control(operation=member.interrupt)` requests chat cancellation for the member conversation and kills a registered active child process when present. |
| `list_agents` | Multi-agent V2 | Multi-agent V2 enabled | List live agents in root thread tree. | `team.members.list` |
| `multi_agent_v1.spawn_agent` | Multi-agent V1 namespace | Multi-agent V1 enabled; often deferred when tool search is available | Spawn sub-agent. | `team.member.spawn` |
| `multi_agent_v1.send_input` | Multi-agent V1 namespace | Multi-agent V1 enabled | Send or interrupt message to spawned agent. | `team.message.send` |
| `multi_agent_v1.resume_agent` | Multi-agent V1 namespace | Multi-agent V1 enabled | Resume closed agent. | `team.control(operation=member.resume)` for suspended/offline internal members |
| `multi_agent_v1.wait_agent` | Multi-agent V1 namespace | Multi-agent V1 enabled | Wait for agents to finish. | `team.control(operation=member.wait)` plus `team.session.get`, `team.task.list` |
| `multi_agent_v1.close_agent` | Multi-agent V1 namespace | Multi-agent V1 enabled | Close agent and descendants. | `team.member.shutdown` |
| `spawn_agents_on_csv` | Agent jobs | `SpawnCsv` feature + collaboration enabled | Spawn batch agents from CSV. | No direct equivalent. |
| `report_agent_job_result` | Agent jobs | Agent job worker session | Report worker result. | `team.report.submit` is conceptually close. |
| `web_search` hosted tool | Hosted Responses tool | Provider supports hosted web search; standalone `web.run` unavailable; web search mode not disabled | Provider-hosted cached/live web search. | `web.search` |
| `image_generation` hosted tool | Hosted Responses tool | Image generation feature/runtime enabled and standalone extension unavailable | Hosted image generation. | `image.generate` |
| `web.run` | Extension tool | Standalone web search enabled and extension contributor present | Search/fetch through Codex web extension namespace. | `web.search`, `web.fetch` |
| `image_gen.imagegen` | Extension tool | Image generation runtime enabled and extension contributor present | Generate/edit image with optional reference images. | `image.generate` |
| `memories.add_ad_hoc_note` | Extension tool | Memories extension installed/enabled | Add ad-hoc memory note. | `memory.add` |
| `memories.list` | Extension tool | Memories extension installed/enabled | List memories. | `memory.list` |
| `memories.read` | Extension tool | Memories extension installed/enabled | Read memory file/entry. | `memory.recall` / `memory.search` |
| `memories.search` | Extension tool | Memories extension installed/enabled | Search memories. | `memory.search` |
| `skills.list` | Extension tool | Skills extension installed/enabled | List orchestrator skills. | `skills.inspect(operation=list)` |
| `skills.read` | Extension tool | Skills extension installed/enabled | Read skill instructions/resource. | `skills.inspect(operation=read)` |
| `get_goal` | Goal extension | Goal extension installed/enabled | Read active thread goal and budget state. | `taskBrief.goal(operation=get)` |
| `create_goal` | Goal extension | Goal extension installed/enabled | Create explicit active goal. | `taskBrief.goal(operation=create)` |
| `update_goal` | Goal extension | Goal extension installed/enabled | Mark goal complete/blocked. | `taskBrief.goal(operation=update)` |
| Dynamic tools | Runtime/app-server dynamic | Passed into session as `DynamicToolSpec` | Arbitrary function/namespace tool from app server. | Direct MCP tools and deferred actions cover part of this. |
| Extension tool adapters | Extension contributor | Any installed extension contributes executor | Arbitrary installed extension tools. | Plugins/skills/MCP install actions, but runtime executor model is less generic. |
| `exec` | Code Mode wrapper | Tool mode `CodeMode` or `CodeModeOnly` | Freeform JavaScript execution wrapper over nested tools. | No equivalent. |
| `wait` | Code Mode wrapper | Tool mode `CodeMode` or `CodeModeOnly` | Wait for code-mode delegated tool calls. | No equivalent. |
| `test_sync_tool` | Experimental core tool | Model declares experimental supported tool | Test sync plumbing. | No equivalent; should stay test-only. |

## RedConvert Top-Level Tool Inventory

| Tool | Kind | Visible in runtime packs | Capability | Codex equivalent |
|---|---|---|---|---|
| `Read` | FileSystem | Wander, Team, ImageGeneration, Knowledge, RedClaw, BackgroundMaintenance, Diagnostics | Read local, URL, virtual resources like workspace, knowledge, profiles, manuscripts, editor. | File read via shell/MCP; no generic core `Read`. |
| `List` | FileSystem | Same as `Read` except manuscript editor | List workspace/knowledge/manuscripts/assets/media collections. | Shell, MCP resources. |
| `Search` | FileSystem | Same as `Read` except manuscript editor | Search workspace/knowledge/assets; not public web search. | Shell `rg`, memories search, MCP/search tools. |
| `Write` | Editor | Team, RedClaw, Diagnostics, ManuscriptEditor | Write bound manuscript/editor virtual resources. | `apply_patch`, shell file writes. |
| `Operate` | AppCli | Team, ImageGeneration, Knowledge, RedClaw, BackgroundMaintenance, Diagnostics | Product-level structured actions; action list below. | Many Codex tools mapped individually. |
| `tool_search` | RuntimeControl | When deferred actions/MCP tools exist | Search deferred app actions and MCP tools. | `tool_search` |
| `workflow` | AppCli compat/internal | Internal tool name | Legacy/internal alias for `Operate` style workflow actions. | None. |
| `shell` | Shell | Team, ImageGeneration, Knowledge, RedClaw except Windows, BackgroundMaintenance, Diagnostics | Execute host command in sandboxed environment. | `exec_command` / `shell_command` |
| `bash` | Bash compat/internal | Internal/legacy | Read-only shell inspection in current space root. | `shell_command` subset. |
| `query` | AppQuery compat/internal | Disabled legacy alias | Legacy app query alias. | None. |
| `resource` | FileSystem compat/internal | Internal tool name | Unified structured file access backing `Read/List/Search/Write`. | None. |
| `knowledge_glob` | FileSystem compat/internal | Disabled legacy alias | Legacy knowledge listing. | None. |
| `knowledge_grep` | FileSystem compat/internal | Disabled legacy alias | Legacy knowledge search. | None. |
| `knowledge_read` | FileSystem compat/internal | Disabled legacy alias | Legacy knowledge read. | None. |
| `profile_doc` | ProfileDoc compat/internal | Disabled legacy alias | Legacy profile document operations. | `memories.*` partially. |
| `mcp` | MCP compat/internal | Disabled legacy alias | Legacy MCP management alias. | MCP runtime/tools. |
| `skill` | Skill compat/internal | Disabled legacy alias | Legacy skill runtime alias. | `skills.*` |
| `runtime_control` | RuntimeControl compat/internal | Disabled legacy alias | Legacy runtime/session/task/background control. | `taskBrief.goal`, runtime task actions, and multi-agent tools partially. |
| `editor` | Editor compat/internal | Internal tool name | Bound video/audio manuscript package editor actions. | No Codex equivalent. |

## RedConvert `Operate` Action Inventory Baseline

The following long-form inventory preserves the pre-compression inspection snapshot for traceability. It is not the current catalog truth after the 2026-06-19 compression slices. For current model-visible counts after the latest changes, use the compression snapshot above and `desktop/docs/tool-surface-simplification-plan.md`.

| Action | Namespace | Modes | Mutates | Parallel-safe | Visibility | Capability |
|---|---|---|---|---|---|---|
| `web.fetch` | web | all app modes | no | yes | Model | Fetch explicit public URL; does not search. |
| `web.search` | web | all app modes | no | yes | Model | Search public web with source metadata. |
| `taskBrief.get` | taskBrief | all app modes | no | yes | Model | Read current structured task brief. |
| `taskBrief.update` | taskBrief | all app modes | yes | no | Model | Update task brief, context, findings, decisions, validation. |
| `session.resources.list` | session.resources | all app modes | no | yes | Model | List current conversation resources and generated files. |
| `session.resources.get` | session.resources | all app modes | no | yes | Model | Read one session resource by id/reference. |
| `plugins.list` | plugins | all app modes | no | yes | Model | List installed Codex-compatible plugins and contributions. |
| `plugins.connectors` | plugins | all app modes | no | yes | Model | List connector declarations from enabled plugins. |
| `plugins.marketplace` | plugins | all app modes | no | no | Model | List marketplace plugins from registry. |
| `plugins.codexMarketplace` | plugins | all app modes | no | yes | Model | List local Codex plugin cache candidates. |
| `plugins.discoverLocal` | plugins | all app modes | no | yes | Model | Inspect local plugin source/marketplace root. |
| `plugins.install` | plugins | all app modes | yes | no | Model | Install plugin from local path/archive/cache root. |
| `plugins.installCodex` | plugins | all app modes | yes | no | Model | Install Codex plugin from local/remote marketplace. |
| `plugins.requestInstall` | plugins | all app modes | no | no | Model | Return install suggestion metadata. |
| `memory.list` | memory | RedClaw-capable modes | no | yes | Model | List durable workspace memory entries. |
| `memory.search` | memory | RedClaw-capable modes | no | yes | Model | Search durable memory. |
| `memory.recall` | memory | RedClaw-capable modes | no | yes | Model | Recall ranked compact memory context. |
| `memory.add` | memory | RedClaw-capable modes | yes | no | Model | Persist durable memory. |
| `memory.update` | memory | RedClaw-capable modes | yes | no | Model | Update memory with history. |
| `memory.archive` | memory | RedClaw-capable modes | yes | no | Model | Archive memory with history. |
| `memory.rebuildIndex` | memory | RedClaw-capable modes | yes | no | Model | Rebuild local memory BM25 index. |
| `memory.diagnostics` | memory | RedClaw-capable modes | no | yes | Model | Inspect memory index/retrieval diagnostics. |
| `redclaw.profile.bundle` | redclaw.profile | RedClaw-capable modes | no | yes | Model | Read AI profile bundle and onboarding state. |
| `redclaw.profile.read` | redclaw.profile | RedClaw-capable modes | no | yes | Model | Read one durable AI profile document. |
| `redclaw.profile.update` | redclaw.profile | RedClaw-capable modes | yes | no | Model | Update one durable AI profile document. |
| `redclaw.profile.completeStyleDefinition` | redclaw.profile | RedClaw-capable modes | yes | no | Model | Atomically complete style-definition onboarding/profile docs/skill. |
| `redclaw.runner.status` | redclaw.runner | RedClaw-capable modes | no | yes | CompatOnly | Inspect automation runner heartbeat. |
| `redclaw.runner.start` | redclaw.runner | RedClaw-capable modes | yes | no | CompatOnly | Start automation runner. |
| `redclaw.runner.stop` | redclaw.runner | RedClaw-capable modes | yes | no | CompatOnly | Stop automation runner. |
| `redclaw.runner.setConfig` | redclaw.runner | RedClaw-capable modes | yes | no | CompatOnly | Update runner config. |
| `redclaw.task.preview` | redclaw.task | RedClaw-capable modes | no | yes | Model | Preview scheduled/long-cycle user task. |
| `redclaw.task.create` | redclaw.task | RedClaw-capable modes | yes | no | Model | Create pending task draft from preview token. |
| `redclaw.task.confirm` | redclaw.task | RedClaw-capable modes | yes | no | Model | Confirm or discard task draft. |
| `redclaw.task.update` | redclaw.task | RedClaw-capable modes | yes | no | Model | Update task definition. |
| `redclaw.task.cancel` | redclaw.task | RedClaw-capable modes | yes | no | Model | Disable/discard/delete task. |
| `redclaw.task.list` | redclaw.task | RedClaw-capable modes | no | yes | Model | List task definitions and latest state. |
| `redclaw.task.stats` | redclaw.task | RedClaw-capable modes | no | yes | Model | Read task counters. |
| `manuscripts.list` | manuscripts | manuscript authoring modes | no | yes | Model | List manuscript tree items. |
| `manuscripts.createProject` | manuscripts | manuscript authoring modes | yes | no | Model | Create and bind manuscript project package. |
| `manuscripts.writeCurrent` | manuscripts | manuscript authoring modes | yes | no | Model | Write full current manuscript body. |
| `assets.search` | assets | all app modes | no | yes | Model | Search reusable asset library with reference image paths. |
| `assets.get` | assets | all app modes | no | yes | Model | Read one asset entry. |
| `assets.create` | assets | all app modes | yes | no | Model | Create reusable character/product/scene/prop/brand/model/voice/reference asset. |
| `assets.update` | assets | all app modes | yes | no | Model | Update asset by id. |
| `assets.delete` | assets | all app modes | yes | no | Model | Delete asset by id on explicit request. |
| `assets.categories.list` | assets | all app modes | no | yes | Model | List asset categories. |
| `assets.categories.create` | assets | all app modes | yes | no | Model | Create asset category. |
| `assets.generateCharacterCard` | assets | all app modes | yes | no | Model | Generate 16:9 character card and save to asset/media library. |
| `voice.clone` | voice | all app modes | yes | no | Model | Queue voice cloning from audio sample. |
| `voice.bindAsset` | voice | all app modes | yes | no | Model | Bind existing platform voice to asset. |
| `voice.speech` | voice | all app modes | yes | no | Model | Queue TTS / multi-speaker speech synthesis. |
| `voice.list` | voice | all app modes | no | yes | Model | List platform voices. |
| `voice.get` | voice | all app modes | no | yes | Model | Read one platform voice. |
| `voice.delete` | voice | all app modes | yes | no | CompatOnly | Delete platform voice on explicit request. |
| `subjects.search` | subjects | all app modes | no | yes | CompatOnly | Legacy alias for `assets.search`. |
| `subjects.get` | subjects | all app modes | no | yes | CompatOnly | Legacy alias for `assets.get`. |
| `runtime.query` | runtime | diagnostics/background modes | no | yes | Model | Inspect runtime state. |
| `runtime.getCheckpoints` | runtime | diagnostics/background modes | no | yes | Model | Read runtime checkpoints. |
| `runtime.getToolResults` | runtime | diagnostics/background modes | no | yes | Model | Read tool results. |
| `runtime.getEvents` | runtime | diagnostics/background modes | no | yes | Model | Read structured runtime events. |
| `runtime.tasks.create` | runtime.tasks | diagnostics/background modes | yes | no | Model | Create runtime task. |
| `runtime.tasks.list` | runtime.tasks | diagnostics/background modes | no | yes | Model | List runtime tasks. |
| `runtime.tasks.get` | runtime.tasks | diagnostics/background modes | no | yes | Model | Read runtime task. |
| `runtime.tasks.resume` | runtime.tasks | diagnostics/background modes | yes | no | Model | Resume paused runtime task. |
| `runtime.tasks.cancel` | runtime.tasks | diagnostics/background modes | yes | no | Model | Cancel runtime task. |
| `team.guide.create` | team.guide | all app modes | yes | no | Model | Create confirmed internal Workboard and open team room. |
| `team.session.create` | team.session | all app modes | yes | no | Model | Create Workboard collaboration project after explicit confirmation. |
| `team.session.list` | team.session | all app modes | no | yes | Model | List Workboard projects. |
| `team.session.get` | team.session | all app modes | no | yes | Model | Read project snapshot with members/tasks/mailbox/reports. |
| `team.member.spawn` | team.member | all app modes | yes | no | Model | Create internal team member role. |
| `team.member.match` | team.member | all app modes | no | yes | Model | Rank team members for a task. |
| `team.member.rename` | team.member | all app modes | yes | no | Model | Rename/retitle team member. |
| `team.member.shutdown` | team.member | all app modes | yes | no | Model | Mark team member offline/suspended. |
| `team.members.list` | team.member | all app modes | no | yes | Model | List team members. |
| `team.task.create` | team.task | all app modes | yes | no | Model | Create structured team task. |
| `team.task.update` | team.task | all app modes | yes | no | Model | Update task owner/status/progress/result/blockers/artifacts. |
| `team.task.list` | team.task | all app modes | no | yes | Model | List team tasks. |
| `team.message.send` | team.message | all app modes | yes | no | Model | Send durable mailbox message. |
| `team.report.request` | team.report | all app modes | yes | no | Model | Request team member progress report. |
| `team.report.submit` | team.report | all app modes | yes | no | Model | Submit progress/blocker/completion/artifact report. |
| `team.artifact.attach` | team.artifact | all app modes | yes | no | Model | Attach artifact metadata to team task. |
| `team.blocker.raise` | team.blocker | all app modes | yes | no | Model | Raise structured blocker report. |
| `approval.request` | approval | all app modes | yes | no | Model | Ask user for structured approval/choice. |
| `cli_runtime.detect` | cli_runtime | all app modes | no | yes | CompatOnly | Detect CLI tools from PATH/environments. |
| `cli_runtime.discover` | cli_runtime | all app modes | no | yes | CompatOnly | Enumerate CLI commands. |
| `cli_runtime.inspect` | cli_runtime | all app modes | no | yes | CompatOnly | Inspect executable and refresh detection. |
| `cli_runtime.diagnose` | cli_runtime | all app modes | no | yes | CompatOnly | Diagnose command resolution and sandbox profile. |
| `cli_runtime.environment.list` | cli_runtime.environment | all app modes | no | yes | CompatOnly | List managed CLI environments. |
| `cli_runtime.environment.create` | cli_runtime.environment | all app modes | yes | no | CompatOnly | Create/hydrate CLI environment. |
| `cli_runtime.install` | cli_runtime | all app modes | yes | no | CompatOnly | Install CLI tool into managed environment. |
| `cli_runtime.execute` | cli_runtime | all app modes | yes | no | CompatOnly | Execute real host CLI command via managed runtime. |
| `cli_runtime.execution.get` | cli_runtime.execution | all app modes | no | yes | Model | Read CLI execution snapshot. |
| `cli_runtime.verify` | cli_runtime | all app modes | yes | no | CompatOnly | Verify finished CLI execution. |
| `cli_runtime.escalation.approve` | cli_runtime.escalation | all app modes | yes | no | Model | Approve pending CLI escalation. |
| `cli_runtime.escalation.deny` | cli_runtime.escalation | all app modes | yes | no | Model | Deny pending CLI escalation. |
| `mcp.list` | mcp | all app modes | no | yes | Model | List saved MCP records and active sessions. |
| `mcp.add` | mcp | all app modes | yes | no | Model | Add/update MCP server. |
| `mcp.get` | mcp | all app modes | no | yes | Model | Get one MCP server record. |
| `mcp.remove` | mcp | all app modes | yes | no | Model | Remove MCP server and disconnect. |
| `mcp.enable` | mcp | all app modes | yes | no | Model | Enable MCP server. |
| `mcp.disable` | mcp | all app modes | yes | no | Model | Disable MCP server and disconnect. |
| `mcp.sessions` | mcp | all app modes | no | yes | Model | List active MCP transport sessions. |
| `mcp.discoverLocal` | mcp | all app modes | no | yes | Model | Discover local MCP configs. |
| `mcp.importLocal` | mcp | all app modes | yes | no | Model | Import discovered MCP configs. |
| `mcp.save` | mcp | all app modes | yes | no | Model | Save MCP config record(s). |
| `mcp.test` | mcp | all app modes | no | no | Model | Probe MCP connectivity. |
| `mcp.call` | mcp | all app modes | yes | no | Model | Call allowed low-level MCP diagnostic method. |
| `mcp.listTools` | mcp | all app modes | no | yes | Model | List tools from one MCP server. |
| `mcp.listResources` | mcp | all app modes | no | yes | Model | List MCP resources. |
| `mcp.listResourceTemplates` | mcp | all app modes | no | yes | Model | List MCP resource templates. |
| `mcp.disconnect` | mcp | all app modes | yes | no | Model | Disconnect one MCP session. |
| `mcp.disconnectAll` | mcp | all app modes | yes | no | Model | Disconnect all MCP sessions. |
| `mcp.oauthStatus` | mcp | all app modes | no | yes | Model | Read MCP OAuth metadata. |
| `skills.list` | skills | all app modes | no | yes | Model | List visible skills. |
| `skills.invoke` | skills | all app modes | yes | no | Model | Activate one skill in current session. |
| `skills.installFromRepo` | skills | all app modes | yes | no | Model | Install skills from GitHub/git/local repo. |
| `skills.uninstall` | skills | all app modes | yes | no | Model | Uninstall managed skill directory. |
| `generation.job.list` | generation.job | RedClaw-capable modes | no | yes | Model | List media generation jobs/status. |
| `generation.job.get` | generation.job | RedClaw-capable modes | no | yes | Model | Read one media job, progress, events, artifacts. |
| `image.generate` | image | RedClaw-capable modes | yes | yes | Model | Generate/edit images. |
| `video.generate` | video | RedClaw-capable modes | yes | yes | Model | Generate videos, including segmented >15s sequence jobs. |
| `media.videoRetalk` | media | RedClaw-capable modes | yes | yes | Model | Create digital-human lip-sync video. |
| `video.analyze` | video_analysis | RedClaw-capable modes | no | yes | Model | Analyze attached video visual content/scenes/edit strategy. |
| `media.edit` | media | RedClaw-capable modes | yes | no | Model | Controlled ffmpeg video edits and media registration. |
| `media.transcribe` | media | RedClaw-capable modes | yes | no | Model | Extract audio/transcribe/subtitle from video/audio. |

## RedConvert Resource And Editor Action Inventory

| Action | Surface | Modes | Mutates | Parallel-safe | Visibility | Capability |
|---|---|---|---|---|---|---|
| `workspace.list` | resource | file-system modes | no | yes | Model | List workspace-relative directory. |
| `workspace.read` | resource | file-system modes | no | yes | Model | Read workspace-relative file. |
| `workspace.createDirectory` | resource | file-system modes | yes | no | Model | Create workspace directory with parents. |
| `workspace.write` | resource | file-system modes | yes | no | Model | Write UTF-8 workspace file. |
| `workspace.search` | resource | file-system modes | no | yes | Model | Search workspace files. |
| `knowledge.list` | resource | file-system modes | no | yes | Model | List advisor/shared/document source entries. |
| `knowledge.read` | resource | file-system modes | no | yes | Model | Read knowledge file or indexed block. |
| `knowledge.attach` | resource | file-system modes | no | yes | Model | Attach knowledge media to next model turn. |
| `knowledge.search` | resource | file-system modes | no | yes | Model | Search knowledge/document source, including visual projections. |
| `script_read` | editor | editor modes | no | yes | Model | Read bound script state. |
| `script_update` | editor | editor modes | yes | no | Model | Replace script draft. |
| `script_confirm` | editor | editor modes | yes | no | Model | Confirm script for downstream editing. |
| `project_read` | editor | editor modes | no | yes | Model | Read bound editor project state. |
| `ffmpeg_edit` | editor | editor modes | yes | no | Model | Apply controlled ffmpeg operations. |
| `export` | editor | editor modes | yes | no | Model | Export current editor project output. |
| `timeline_read` | editor | editor modes | no | yes | CompatOnly | Legacy timeline inspection. |
| `clip_add` | editor | editor modes | yes | no | CompatOnly | Legacy timeline mutation. |
| `undo` | editor | editor modes | yes | no | CompatOnly | Legacy undo. |

## Implementation Boundary: Use Library vs Self-Build

| Capability | Use existing library/runtime | Self-build in RedConvert |
|---|---|---|
| Tool registry and dispatch | Use Codex-style typed registry/router pattern. | Build RedConvert adapter from `ToolRegistryPlan` to stronger per-tool runtime handlers; avoid one god `Operate` executor long term. |
| Deferred tool discovery | Use BM25/search index pattern like Codex `tool_search`. | Keep action descriptors curated and product aware; rank by runtime mode, task intent, skill policy. |
| Shell execution | Use OS sandbox/runtime primitives and existing managed CLI runtime. | RedConvert-specific approval UX and CLI environment records. |
| MCP | Use MCP protocol/client libraries and schema translation. | Product MCP manager UI, local discovery/import, saved server records, OAuth status. |
| Patching files | Use a proven patch parser/grammar like Codex `apply_patch` for full diff semantics when freeform patches are required. | `workspace.patch` provides schema-first exact replacements plus create/delete/move inside workspace policy; user-facing diff preview remains future work. |
| Web search/fetch | Use provider-hosted search or dedicated search backend. | Normalize result metadata, source attribution, taskBrief integration. |
| Image generation | Use provider SDK/API. | Media library registration, asset binding, job tracking, retries. |
| Video edit/transcribe | Use `ffmpeg`, Whisper/ASR providers, robust media probing libraries. | Product-level edit operations, media asset bookkeeping, UX progress. |
| Multi-agent | Reuse Codex ideas: mailbox, cancellation, wait, interrupt, bounded events. | Workboard persistence, member profiles, team tasks/reports/artifacts. |

## Performance And Safety Recommendations

| Priority | Recommendation | Reason |
|---|---|---|
| P0 | Add a first-class patch tool instead of relying on `workspace.write` for code/file edits. | Atomic diffs are safer, easier to review, and map better to model behavior. |
| P0 | Split `Operate` execution into typed action handlers internally, even if the model still sees one compact schema. | Keeps the UI surface small while improving validation, telemetry, concurrency, and testability. |
| P1 | Keep direct `Operate` actions capped; push long-tail actions behind `tool_search`. | Codex gets lower prompt cost by exposing only direct + deferred tools per turn. |
| P1 | Keep team member interrupt semantics bounded and observable. | `member.interrupt` cancels the member conversation session and registered child process; it should continue to report when no active conversation exists. |
| P1 | Add output truncation budgets per action family, not just per top-level tool. | `Operate` can return very different payload sizes; family budgets reduce context bloat. |
| P1 | Prefer structured product actions over shell for media/files/web. | Product actions can preserve state, register artifacts, and enforce permissions. |
| P2 | Keep `taskBrief.context` estimate honest; add provider-real context accounting only if the runtime starts storing model context-window limits and token usage. | The current implementation reports compact-threshold estimates, not true provider remaining window. |
| P2 | Keep compat-only aliases hidden and removable. | They preserve old flows but should not expand the model-facing surface. |

## Bottom Line

Codex is a stronger generic agent runtime: typed tool registry, sandbox orchestration, patching, MCP injection, extension tools, dynamic tools, code-mode wrapping, and precise multi-agent lifecycle controls. RedConvert is a stronger product agent app: it exposes native web, memory, RedClaw, manuscripts, assets, voice, video, media editing, skills, plugin management, MCP management, and Workboard operations.

The best architecture for RedConvert is not to copy Codex's exact tool list. The highest-value transfer is Codex's runtime discipline: typed dispatch, direct/deferred exposure, patch-grade file mutation, cancellation, bounded outputs, and per-tool lifecycle telemetry. RedConvert should keep its product-specific actions, but make the internals more Codex-like.
