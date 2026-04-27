---
doc_type: plan
execution_status: completed
last_updated: 2026-04-27
owner: codex
target_files:
  - desktop/src-tauri/src/cli_runtime/path_env.rs
  - desktop/src-tauri/src/cli_runtime/detector.rs
  - desktop/src-tauri/src/cli_runtime/executor.rs
  - desktop/src-tauri/src/commands/cli_runtime.rs
  - desktop/src-tauri/src/mcp/transport.rs
  - desktop/src-tauri/src/mcp/manager.rs
  - desktop/src-tauri/src/tools/app_cli.rs
  - desktop/src-tauri/src/interactive_runtime_shared.rs
  - desktop/src/components/ProcessTimeline.tsx
  - desktop/src/pages/Settings.tsx
related_docs:
  - desktop/docs/cli-runtime-discovery-resolve-execute-upgrade-plan.md
  - desktop/docs/cli-runtime-acceptance-regression-baseline.md
  - desktop/docs/mcp-codex-alignment-optimization-plan.md
  - desktop/docs/generic-cli-runtime-control-plane-plan.md
reference_implementations:
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/handlers/shell.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/runtimes/shell.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/exec_env.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/spawn.rs
success_metrics:
  - cli_runtime_inspect_matches_login_shell_resolution
  - cli_runtime_execute_uses_same_effective_env_as_inspect
  - cli_runtime_install_then_inspect_detects_exact_tool_name
  - mcp_stdio_server_spawn_uses_cli_runtime_effective_env
  - agent_no_longer_stops_at_missing_without_install_or_execute_attempt
implementation_evidence:
  - cargo check --manifest-path desktop/src-tauri/Cargo.toml
  - cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::path_env
  - cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::detector
  - cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::sandbox
  - cargo test --manifest-path desktop/src-tauri/Cargo.toml commands::cli_runtime
  - cargo test --manifest-path desktop/src-tauri/Cargo.toml mcp::manager
---

# CLI Runtime Effective Environment Optimization Plan

## 0. Implementation Status

Status: Completed on 2026-04-27.

Completed implementation:

- Added `CliHostShellSnapshot` and `CliEffectiveEnvironment` helpers in `cli_runtime/path_env.rs`.
- Kept `load_host_shell_env()` backward-compatible while exposing structured shell/fallback metadata to new callers.
- Added shell-native command resolution probe in `cli_runtime/detector.rs`.
- Added inspect/discover/diagnose metadata for host shell, effective PATH preview, path scan, and shell resolve probe.
- Aligned `cli_runtime.execute` execution records with the same effective environment metadata.
- Preserved exact `toolName` install post-check behavior and moved post-check detection onto the same effective env helper.
- Changed MCP stdio server spawning to use the same effective environment and expose it in `mcp.test`/diagnostics output.
- Tightened runtime guidance so agent treats `missing` as final only after inspect evidence and install/retry options are exhausted.
- Hardened local tests against machine-specific globally installed CLIs.

No renderer UI changes were required for this pass; existing JSON metadata is now available for compact rendering later.

## 1. Goal

让 RedConvert 的 agent 在调用用户电脑 CLI 和本地 MCP server 时，看到的诊断结果、实际执行环境和安装后复检结果保持一致。

本计划只修一条关键链路：

```text
host shell env snapshot
  -> effective PATH
  -> inspect / discover / diagnose
  -> install post-check
  -> execute
  -> MCP stdio server spawn
```

目标不是重写 CLI runtime，也不是完整复制 Codex 的 shell tool。RedConvert 已经有 `cli_runtime`、sandbox、installer、execution log、verify 和 MCP manager；当前缺口是这些入口没有统一输出足够清晰的“有效环境证据”，导致 agent 容易把 `missing` 当作最终结论。

## 2. Problem Statement

最近暴露的问题是：

- agent 调用 `cli_runtime.inspect` 后看到 `health: "missing"`。
- 输出里有 `resolvedPath: null` 和一组 PATH entries。
- agent 直接告诉用户去安装，而不是继续用 `cli_runtime.install` 或重新用精确命令验证。

这说明 runtime 已经有工具面，但缺少三个硬保证：

1. `inspect` 的结论必须接近用户终端真实可用性。
2. `execute` 必须和 `inspect` 使用同一套 effective env。
3. MCP stdio server 的启动不能另起一套 PATH / env 逻辑。

## 3. Current Baseline

### 3.1 Existing Strengths

RedConvert 已有基础能力，应该保留：

- `desktop/src-tauri/src/cli_runtime/path_env.rs`
  - `load_host_shell_env()` 已经会用宿主 login shell 读取环境。
  - `merge_execution_env()` 已经合并 managed env path、extra bin path 和 host PATH。
- `desktop/src-tauri/src/cli_runtime/detector.rs`
  - `detect_tool_with_managed_paths()` 已经可以按 effective PATH 查找可执行文件。
  - `CliToolRecord` 已经有 `resolved_path`、`resolved_from`、`effective_path_preview`、`searched_path_entries_count`。
- `desktop/src-tauri/src/cli_runtime/executor.rs`
  - `execute_cli_command()` 已经会加载 host shell env、merge env、build sandbox、写 stdout/stderr log。
- `desktop/src-tauri/src/cli_runtime/sandbox.rs`
  - Host-compatible mode 已经会把 tool closure、shebang interpreter 和 Homebrew runtime roots 纳入 sandbox read paths。
- `desktop/src-tauri/src/commands/cli_runtime.rs`
  - `inspect`、`diagnose`、`install`、`execute` 都已经通过 `app_cli(action="cli_runtime.*")` 暴露。
- `desktop/src-tauri/src/mcp/*`
  - MCP 管理、tool inventory、direct tool routing 已经存在。

### 3.2 Actual Gap

缺的不是新的顶层工具，而是一个可复用的 effective environment contract。

当前代码里多处直接调用：

```rust
load_host_shell_env().unwrap_or_else(|_| std::env::vars().collect())
```

这会让调用方只拿到 env map，拿不到：

- host shell 是什么。
- login shell env 是否成功加载。
- 失败时 fallback 的原因。
- PATH 是由哪些层组成的。
- shell-native `command -v` 是否能解析到命令。
- path scan 与 login shell probe 是否冲突。

这些证据缺失后，agent 只看到 `missing`，无法判断下一步应继续安装、换 exact command、还是提示用户配置 shell。

## 4. Design Principles

1. Keep the tool surface small.
   - 继续使用 `app_cli(action="cli_runtime.*")`。
   - 不新增 `lark_cli`、`brew_cli`、`npm_cli`、`mcp_cli` 顶层工具。

2. Keep argv execution as the canonical execution path.
   - `cli_runtime.execute` 继续接收 `argv: Vec<String>`。
   - 不把所有执行改成 shell string。
   - shell-native probe 只用于诊断证据，不作为执行 contract。

3. Share env construction, not process orchestration.
   - 不新建大号 `HostShellRuntime`。
   - 只抽一个小的 effective env helper，复用现有 detector、executor、sandbox。

4. Prefer structured evidence over prompt rules.
   - prompt 可以提醒 agent 使用 `cli_runtime.*`。
   - runtime 必须返回足够证据，让 agent 不靠猜。

5. Make MCP reuse CLI env.
   - MCP stdio command resolution 和 spawn 必须复用同一套 effective env。
   - MCP tool exposure / routing 不因本计划重做。

## 5. Options

### Option A: Add More Default Detect Commands

做法：

- 在默认探测列表里追加 `lark-cli`、`vercel`、`supabase`、`wrangler` 等。

优点：

- 改动小。
- 对单个已知 CLI 见效快。

缺点：

- 长尾 CLI 永远补不完。
- 不能解决 shell PATH 与 app PATH 不一致。
- agent 仍会把未列入默认探测误判为未安装。

结论：不推荐。

### Option B: Let Agent Use Bash For PATH Diagnosis

做法：

- 允许 agent 用 `bash` 执行 `which`、`command -v`、`echo $PATH`。

优点：

- 表面最快。
- 模型熟悉 shell 输出。

缺点：

- 绕开了 CLI runtime 的权限、日志、sandbox、execution record。
- 诊断输出不结构化。
- 又回到“模型自己解释 shell 文本”的不稳定状态。

结论：不推荐。

### Option C: Full Codex Shell Runtime Port

做法：

- 复制 Codex 的 shell tool / exec env / spawn / approval / sandbox 结构。

优点：

- 长期能力强。
- 能覆盖更多交互式 shell case。

缺点：

- RedConvert 已有 CLI runtime、MCP manager、execution log、sandbox、installer。
- 全量迁移会重复现有架构。
- 风险和改动面超过当前问题。

结论：当前不推荐。

### Option D: Effective Environment Contract

做法：

- 抽出一个轻量 `CliEffectiveEnvironment`。
- `inspect`、`diagnose`、`discover`、`execute`、`install post-check`、MCP stdio spawn 共用。
- 增加 shell-native resolve probe 作为 metadata。

优点：

- 改动小。
- 直接解决 inspect/execute 不一致。
- 保留现有 sandbox、installer、log、verify。
- 对 MCP 也能复用。

缺点：

- 不解决完整交互式终端仿真。
- 对 shell alias/function 只能诊断，不能直接作为 argv 执行。

结论：推荐。

## 6. Recommended Architecture

### 6.1 New Effective Environment Helper

在 `desktop/src-tauri/src/cli_runtime/path_env.rs` 增加小型结构，而不是新增大型 runtime：

```rust
pub struct CliHostShellSnapshot {
    pub env: BTreeMap<String, String>,
    pub shell_path: Option<String>,
    pub login_shell_loaded: bool,
    pub fallback_used: bool,
    pub error: Option<String>,
}

pub struct CliEffectiveEnvironment {
    pub env: BTreeMap<String, String>,
    pub environment_id: Option<String>,
    pub shell_path: Option<String>,
    pub login_shell_loaded: bool,
    pub fallback_used: bool,
    pub host_path_entries_count: usize,
    pub effective_path_preview: Vec<String>,
    pub metadata: Value,
}
```

Public helpers:

```rust
pub fn load_host_shell_snapshot() -> CliHostShellSnapshot;

pub fn build_effective_environment(
    host: &CliHostShellSnapshot,
    environment: Option<&CliEnvironmentRecord>,
    custom: Option<&BTreeMap<String, String>>,
) -> CliEffectiveEnvironment;
```

This keeps the current `load_host_shell_env()` API available for compatibility, but new code should use the snapshot helper.

### 6.2 Shell-Native Resolution Probe

在 `desktop/src-tauri/src/cli_runtime/detector.rs` 增加诊断 probe：

```rust
pub struct CliShellResolveProbe {
    pub shell_path: Option<String>,
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub resolved_path: Option<String>,
    pub resolved_kind: CliShellResolvedKind,
}
```

`resolved_kind`:

- `ExecutablePath`
- `ShellBuiltin`
- `ShellFunction`
- `Alias`
- `Unknown`
- `ProbeUnavailable`

Implementation detail:

```bash
<shell> -lc 'type -p -- "$1" || command -v -- "$1"' _ <command>
```

Rules:

- If probe returns an absolute path and path scan missed it, `inspect` may mark the tool as ready.
- If probe returns alias/function/builtin, `inspect` should report it but must not mark it as argv-ready.
- The probe must use a short timeout.
- The probe must never execute the target CLI itself.
- The probe must not run for commands that contain `/`, `\`, empty strings, control characters, or shell metacharacters.

### 6.3 Unified Inspect / Diagnose / Execute Inputs

Replace ad hoc env loading in:

- `detect_tool_across_environments`
- `discover_tools_value`
- `inspect_tool_value`
- `diagnose_tool_value`
- `execute_cli_command`
- `install_value` post-check

with:

```text
host snapshot once per app_cli action
  -> effective env for selected environment
  -> detect/probe/execute
```

For a single request, host shell env should be loaded once and passed down. Do not add persistent caching until runtime traces prove shell env loading is a performance bottleneck.

### 6.4 Structured Output Contract

`cli_runtime.inspect` output should add metadata while preserving current fields:

```json
{
  "health": "ready",
  "resolvedPath": "/opt/homebrew/bin/lark-cli",
  "resolvedFrom": "host_shell_path",
  "effectivePathPreview": [],
  "searchedPathEntriesCount": 23,
  "metadata": {
    "hostShell": {
      "path": "/bin/zsh",
      "loginShellLoaded": true,
      "fallbackUsed": false,
      "error": null
    },
    "pathScan": {
      "resolvedPath": null,
      "resolvedFrom": null
    },
    "shellResolveProbe": {
      "exitCode": 0,
      "resolvedPath": "/opt/homebrew/bin/lark-cli",
      "resolvedKind": "executable_path"
    }
  }
}
```

`cli_runtime.execute` execution metadata should include:

```json
{
  "effectiveEnvironment": {
    "environmentId": "cli-env-app-global",
    "hostShell": "/bin/zsh",
    "loginShellLoaded": true,
    "fallbackUsed": false,
    "effectivePathPreview": []
  }
}
```

This lets the agent compare inspect and execute evidence without reading log files directly.

### 6.5 Install Post-Check

After `cli_runtime.install`, post-check must preserve the exact intended executable name:

```text
request.toolName if present
  else inferred command from install spec
```

Do not shorten hyphenated names.

Examples:

- `toolName: "lark-cli"` stays `lark-cli`
- `spec: "@modelcontextprotocol/server-filesystem"` may infer `server-filesystem` only if `toolName` is absent
- `spec: "some/package#binary"` should not guess a binary if ambiguous; return a structured `needsToolName` hint

Post-check must use the same effective env helper, including install env overrides.

### 6.6 MCP Reuse

MCP stdio servers should not resolve command paths with a separate environment model.

For local stdio server startup:

```text
MCP server config command/args/env/cwd
  -> CliEffectiveEnvironment
  -> detect command if bare executable
  -> spawn with same env
  -> surface env/probe metadata in mcp.test
```

This affects:

- `desktop/src-tauri/src/mcp/transport.rs`
- `desktop/src-tauri/src/mcp/manager.rs`
- `desktop/src-tauri/src/commands/mcp_tools.rs`

No MCP tool exposure changes are required in this plan.

## 7. AI Runtime Behavior

### 7.1 Prompt Contract

Keep the existing prompt guidance but make it shorter after runtime evidence improves.

Current behavior should remain:

- Known command: call `cli_runtime.inspect`.
- Missing command and known install spec: call `cli_runtime.install`.
- Need to run command: call `cli_runtime.execute`.
- Need more output: call `cli_runtime.execution.get`.
- MCP setup: use `mcp.*` plus `cli_runtime.*`.

After this plan, the prompt can stop over-explaining PATH mechanics because inspect results will include proof.

### 7.2 Agent Recovery Rules

The agent should treat `health: "missing"` as final only when:

- login shell env loaded successfully,
- path scan and shell resolve probe both failed,
- no stored managed environment has the command,
- no install spec or user-provided exact executable path is available.

If any of those are false, the agent should continue with the next structured action instead of stopping with user instructions.

## 8. UI And Diagnostics

This plan does not require a new settings page.

Small UI improvements only:

- Settings CLI runtime diagnostic row may show:
  - host shell path
  - login shell env status
  - resolved from `host_shell_path` / `managed_environment` / `shell_probe`
- ProcessTimeline may display:
  - command
  - environment id
  - resolved path
  - stdout/stderr tail
  - escalation status

Avoid adding a large CLI dashboard. The runtime evidence should be available in the JSON result first; UI can render it opportunistically.

## 9. Video Processing Impact

Video processing should not receive a separate implementation.

Existing `ffmpeg` / `ffprobe` / `remotion` paths that already use `cli_runtime.execute` benefit automatically if:

- execute uses the same effective env helper,
- sandbox host tool closure still resolves shebang/interpreter paths,
- install post-check uses exact tool names.

No changes should be made to video editing semantics in this plan.

## 10. Existing Libraries Versus Custom Code

Use existing libraries and code:

- `std::process::Command` for short shell probes and command execution.
- Existing `configure_background_command`.
- Existing `CliToolRecord`, `CliEnvironmentRecord`, `CliExecutionRecord`.
- Existing sandbox, policy, process store, verification, event emitters.
- Existing MCP manager and transport.

Write custom code only for:

- `CliHostShellSnapshot`.
- `CliEffectiveEnvironment`.
- Shell-native resolve probe parser.
- Metadata merge helpers.
- Unit tests and smoke fixtures.

Do not add new crates for shell parsing, terminal emulation, or PATH resolution in this pass.

## 11. Performance Strategy

1. Load host shell env once per user-facing action.
   - A single inspect/diagnose/execute/install action should call the host env loader once.

2. Keep probe cheap.
   - Shell resolve probe runs only for a specific command.
   - It uses a short timeout.
   - It does not run `--version`.

3. Avoid global cache initially.
   - Shell PATH can change after install.
   - A stale cache would recreate the bug this plan is trying to remove.

4. Add cache only with evidence.
   - If telemetry shows shell env load is expensive, add a short TTL cache later.
   - Cache invalidation must happen after `cli_runtime.install`, settings save, and environment create.

5. Keep discover bounded.
   - Existing `limit` stays capped.
   - `discover` should not run shell probe for every binary in PATH.

## 12. Implementation Tasks

### Task 1: Effective Env Helper

Files:

- `desktop/src-tauri/src/cli_runtime/path_env.rs`
- `desktop/src-tauri/src/cli_runtime/mod.rs`

Work:

- Add `CliHostShellSnapshot`.
- Add `CliEffectiveEnvironment`.
- Add `load_host_shell_snapshot()`.
- Add `build_effective_environment()`.
- Preserve existing `load_host_shell_env()` by delegating to the snapshot helper.
- Include metadata helpers for JSON output.

Acceptance:

- Existing callers still compile.
- New helper reports fallback when login shell env fails.
- Unit tests cover successful shell env, fallback env, and PATH merge order.

### Task 2: Shell Resolve Probe

Files:

- `desktop/src-tauri/src/cli_runtime/detector.rs`

Work:

- Add safe command validator for probe input.
- Add shell-native probe function.
- Parse absolute executable path versus non-argv-ready shell constructs.
- Merge probe evidence into `CliToolRecord.metadata`.

Acceptance:

- `lark-cli` style hyphenated command stays unchanged.
- Absolute probe path can upgrade a `Missing` path-scan result to `Ready`.
- Alias/function output is visible but does not become `resolvedPath`.
- Probe is skipped for explicit paths and unsafe command strings.

### Task 3: Inspect / Diagnose / Discover Refactor

Files:

- `desktop/src-tauri/src/commands/cli_runtime.rs`

Work:

- Replace `load_host_env()` fallback-only helper with snapshot-aware helper.
- Pass one snapshot through detect/discover/inspect/diagnose.
- Include effective env metadata in inspect and diagnose outputs.
- Keep output backward-compatible for existing renderer fields.

Acceptance:

- Current `health`, `resolvedPath`, `effectivePathPreview` fields remain.
- New metadata explains shell env source and probe result.
- `diagnose` summary distinguishes:
  - not found after login shell probe
  - shell env fallback used
  - found in managed environment
  - found by shell probe

### Task 4: Execute Metadata Alignment

Files:

- `desktop/src-tauri/src/cli_runtime/executor.rs`

Work:

- Use the effective env helper in `execute_cli_command`.
- Store effective env metadata in execution record metadata.
- Preserve sandbox metadata exactly as today.

Acceptance:

- `cli_runtime.execute` still returns stdout/stderr tails.
- Execution record contains enough metadata to compare with inspect.
- No changes to stdout/stderr log paths or event names.

### Task 5: Install Post-Check Alignment

Files:

- `desktop/src-tauri/src/commands/cli_runtime.rs`
- `desktop/src-tauri/src/cli_runtime/installers/*`

Work:

- Keep exact `toolName` through install execution and post-check.
- Use effective env helper for install post-check.
- Return structured hint when install spec cannot infer the executable.

Acceptance:

- `toolName: "lark-cli"` post-check inspects `lark-cli`, not `lark`.
- Completed install with missing executable reports which env and PATH were checked.
- Awaiting escalation still returns enough context for retry.

### Task 6: MCP Stdio Environment Reuse

Files:

- `desktop/src-tauri/src/mcp/transport.rs`
- `desktop/src-tauri/src/mcp/manager.rs`
- `desktop/src-tauri/src/commands/mcp_tools.rs`

Work:

- Route MCP stdio command spawn through the effective env helper.
- Include shell/env metadata in `mcp.test` diagnostics.
- Keep direct MCP tool routing unchanged.

Acceptance:

- MCP server using `npx`, `uvx`, `node`, `python`, or a Homebrew binary resolves from the same effective PATH as CLI runtime.
- `mcp.test` failure explains command resolution, cwd, env source, and stderr tail.
- No change to MCP callable tool names or ToolRouter exposure.

### Task 7: Agent Guidance Cleanup

Files:

- `desktop/src-tauri/src/interactive_runtime_shared.rs`
- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/tools/app_cli.rs`

Work:

- Keep exact-command rule.
- Replace verbose PATH warning with shorter evidence-based guidance.
- Add note: `missing` is final only after shell probe and install/retry options are exhausted.

Acceptance:

- Tool descriptions remain schema-first and action-based.
- No new top-level tool names.
- Prompt does not tell agent to read runtime log files directly.

### Task 8: Minimal UI Evidence Rendering

Files:

- `desktop/src/components/ProcessTimeline.tsx`
- `desktop/src/pages/Settings.tsx`

Work:

- Render new metadata only if present.
- Do not add new panels.
- Keep rows compact.

Acceptance:

- Existing CLI runtime UI still works when metadata is absent.
- New metadata appears as concise diagnostics, not a verbose tutorial.

## 13. Test Matrix

### Unit Tests

Run targeted Rust tests:

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::path_env
cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::detector
cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::sandbox
cargo test --manifest-path desktop/src-tauri/Cargo.toml commands::cli_runtime
```

Required coverage:

- PATH merge order.
- login shell env fallback.
- shell probe absolute path.
- shell probe alias/function classification.
- hyphenated command names.
- managed environment path priority.
- install post-check exact tool name.

### Host Smoke Tests

Use real `app_cli` / IPC path when available:

1. Inspect known system CLI:
   - `node`
   - `pnpm`
   - `python3`

2. Inspect missing CLI:
   - `definitely-not-a-redbox-cli`

3. Inspect hyphenated CLI:
   - command name containing `-`
   - must preserve exact command.

4. Execute known CLI:
   - `node --version`
   - returned metadata must match inspect effective env.

5. Install then inspect:
   - use a low-risk package in managed env only.
   - post-check must inspect exact `toolName`.

6. MCP stdio smoke:
   - configure a local stdio fixture command.
   - run `mcp.test`.
   - failure/success must include effective env metadata.

### Renderer Smoke Tests

Run:

```bash
cd desktop && pnpm exec tsc --noEmit
```

Manual checks:

- Settings CLI runtime diagnostics still loads.
- ProcessTimeline renders old and new execution metadata.
- No full-page loading regression.

## 14. Rollout Rules

This should be one implementation commit when executed:

```text
cli runtime effective environment alignment
```

Do not bundle unrelated MCP tool exposure changes, UI redesign, release scripts, video editor changes, or RedClaw authoring changes into that commit.

## 15. Done Definition

The work is done only when:

1. `cli_runtime.inspect` returns shell/env/probe evidence.
2. `cli_runtime.execute` records the same effective env metadata.
3. `cli_runtime.install` post-check preserves exact tool names.
4. `mcp.test` / stdio startup uses the same effective env path.
5. Targeted Rust tests pass.
6. TypeScript check passes if renderer files changed.
7. A real local smoke test proves a known CLI can inspect and execute through the same path.

## 16. Non-Goals

- No new top-level CLI tools.
- No full Codex shell runtime port.
- No global persistent PATH cache in this pass.
- No shell-string canonical execution path.
- No redesign of Settings.
- No change to MCP direct/deferred tool exposure.
- No video processing feature changes.
