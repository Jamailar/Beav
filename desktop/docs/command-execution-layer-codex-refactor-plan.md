---
doc_type: plan
execution_status: completed
last_updated: 2026-06-19
---

# Command Execution Layer Codex Refactor Plan

## 目标

把 RedConvert 现在偏产品化、偏 CLI 管理台的 `cli_runtime`，改造成更接近 Codex 的通用命令执行层：

- 模型默认只看到少量广谱工具，可以直接用用户电脑里的任何命令。
- 宿主层保留进程控制、日志、审批、环境、审计、stdin、终止等能力。
- CLI 探测、安装、诊断、环境管理从默认模型工具面降级为显式诊断/设置能力。
- 媒体、视频、转写等产品工作流继续复用底层执行能力，但不把这些内部能力暴露成一堆模型工具。

结论先行：不要删除命令执行 substrate。需要删除的是模型可见的 CLI runtime 心智负担。执行层应该从 `cli_runtime` 收敛为 `command_execution`，对模型像 Codex 一样提供 `shell` / `write_stdin` 级能力，对应用和 UI 提供 `command.exec` / `command.write` / `command.terminate` / `command.resize` / `command.get` 级控制协议。

本轮改造范围必须收窄到“通用命令能力升级”和“模型工具面压缩”。`ffmpeg` 是 RedConvert 内置视频剪辑、转写和媒体流水线的重要底层能力，不属于要被弱化或替换的对象。`media.edit`、`media.transcribe`、视频生成后的拼接/转码、字幕/音频抽取等产品能力必须作为兼容保护对象：用户可见入口、受控参数构造、输出校验、媒体库注册行为都不能回退。

## Codex 调研结论

### 1. Codex 没有强调 agent 调用具体 CLI

Codex 不为 `npm`、`pnpm`、`python`、`gh`、`ffmpeg`、`brew` 等常见命令单独设计模型工具。它把本机命令视为用户环境的一部分，让 agent 通过通用 shell/exec 工具使用它们。

关键证据：

- `codex-rs/core/src/tools/handlers/shell_spec.rs:88-107` 定义模型工具 `exec_command`，参数核心是 `cmd`、`workdir`、`tty`、`yield_time_ms`、`max_output_tokens`、`shell`、`login`。
- `codex-rs/core/src/tools/handlers/shell_spec.rs:110-151` 定义 `write_stdin`，用于已有会话的 stdin 写入和轮询。
- `codex-rs/core/src/tools/handlers/shell_spec.rs:154-221` 定义 `shell_command`，参数核心是 `command`、`workdir`、`timeout_ms`、`login`。
- `codex-rs/protocol/src/openai_models.rs:265-303` 用 `ConfigShellToolType` 和 `ToolMode` 决定暴露哪种 shell 工具，而不是维护一套 CLI catalog。

学习点：模型需要的是“能运行命令”的广谱能力，不是“列出所有可能 CLI 的工具列表”。

### 2. Codex 区分模型工具和宿主协议

Codex 有两条执行路径：

- 模型路径：`shell_command` / `exec_command` / `write_stdin`，服务于 agent 工具调用。
- 宿主路径：`command/exec` / `command/exec/write` / `command/exec/terminate` / `command/exec/resize`，服务于 App/Server 直接启动、控制、流式输出进程。

关键证据：

- `codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs:21-108` 说明 `command/exec` 是 standalone command execution，使用 argv vector，并支持 PTY、stdin stream、stdout/stderr stream、output cap、cwd/env、sandbox policy。
- `codex-rs/app-server-protocol/src/protocol/common.rs:1025-1047` 注册 `command/exec`、`write`、`terminate`、`resize`。
- `codex-rs/app-server/src/command_exec.rs:87-98` 的 `StartCommandExecParams` 是真正的 runtime 控制面。
- `codex-rs/app-server/src/command_exec.rs:142-305` 负责启动命令、分配 process id、注册连接级 session、选择 PTY/pipe/no-stdin。
- `codex-rs/app-server/src/command_exec.rs:308-372` 提供 write/terminate/resize。
- `codex-rs/app-server/src/command_exec.rs:442-553` 处理进程生命周期、超时、终止和最终响应。
- `codex-rs/app-server/src/command_exec.rs:556-618` 把 stdout/stderr chunk 作为 output delta event 发送。

学习点：进程控制原语应该归宿主协议，不应该变成一堆模型默认工具。

### 3. Codex 保留 shell string，也保留 argv vector

Codex 没有把 shell string 和 argv vector 混成一个东西：

- `thread/shell-command` 保留 shell 语法，明确支持 pipe、redirect、quoting，并且是 full-access escape hatch。
- `command/exec` 用 argv vector，避免 shell 解释，适合 App/Server 控制协议。
- 模型工具 `shell_command` 适合自然语言 agent 使用，`exec_command` 适合更结构化的统一执行模式。

关键证据：

- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:910-917` 写明 `ThreadShellCommandParams.command` intentionally preserves shell syntax，区别于 `command/exec`。
- `codex-rs/core/src/tasks/user_shell.rs:127-147` 用用户默认 shell 运行命令，保留 pipes、redirects、`&&` 等 shell 特性。
- `codex-rs/core/src/tasks/user_shell.rs:154-170` 把 parsed command、cwd、source 作为 execution begin event 发出。

学习点：RedConvert 现在的 `cli_runtime.execute` 只收 `argv`，这对宿主很好，对 agent 不够顺手。模型层需要一个 shell string 工具，宿主层需要 argv vector。

### 4. Codex 把权限、sandbox、输出预算作为执行属性

Codex 没有把“安全模式”“环境诊断”“执行验证”拆成很多默认工具，而是放进执行请求、权限 profile、sandbox policy、输出 cap、timeout 和 approval flow。

关键证据：

- `command_exec.rs:57-80` 有 output bytes cap、timeout、initial terminal size。
- `command_exec.rs:81-108` 有 cwd/env/sandbox/permission profile。
- `app-server/src/request_processors/command_exec_processor.rs:127-147` 校验 sandbox、permission、timeout、output cap 等组合。
- `core/src/tools/runtimes/shell.rs:114-145` 把 shell runtime 做成可 sandbox、可审批的 runtime。

学习点：RedConvert 的 `executionMode`、escalation、sandbox、verification 都应该成为 command execution 的 runtime 属性，而不是 `cli_runtime.*` 家族的模型入口。

## RedConvert 当前问题

### 当前可复用资产

RedConvert 已经有不少正确的底层能力，不应该删除：

- `desktop/src-tauri/src/cli_runtime/executor.rs` 已经有执行记录、stdout/stderr log、后台进程 registry、stdin handle、取消和 verification。
- `desktop/src-tauri/src/cli_runtime/policy.rs` 已经有危险命令、敏感路径、网络、全局安装、提权等风险识别。
- `desktop/src-tauri/src/commands/cli_runtime.rs` 已经有 IPC channel：detect、inspect、diagnose、discover、environment、install、execute、get、cancel、write-stdin、verify、approve、deny。
- `desktop/src-tauri/src/commands/media_edit/execution.rs` 通过 `run_managed_cli_command` 调用内置 `ffmpeg`，并用 exit code + output file existence 做验证。
- `desktop/src-tauri/src/commands/media_transcribe.rs` 通过同一执行层调用 `ffmpeg` 抽取 16 kHz mono WAV，再进入 ASR/transcription 流程。
- `desktop/src-tauri/src/tools/catalog.rs` 已经把多数 `cli_runtime.*` 设为 `CompatOnly`，说明上一轮压缩方向是对的。
- `desktop/src-tauri/src/tools/plan.rs` 目前仍把 `cli_runtime.execution.get` 作为默认 pinned action，并把 diagnostics/background-maintenance 的 direct namespace 指到 `cli_runtime.execution`。

### 必须保护的产品能力

这轮改造不能影响以下内置能力：

- `media.edit`：受控 ffmpeg 剪辑入口，覆盖 trim、concat、crop_scale、speed、mute、replace_audio 等操作。
- `media.transcribe`：本地 ffmpeg 音频抽取 + ASR 转写/字幕输出。
- 视频生成后的内部拼接、转码、音频处理和文件落盘。
- 任何通过 `ffmpeg_program(Some(app))` 解析内置 ffmpeg 的路径选择逻辑。
- `CliVerifyRule::ExitCode`、`CliVerifyRule::FileExists` 这类产品工作流验证。
- 输出写入媒体库、工作区输出目录、session/runtime lineage metadata。

保护原则：

- 不把 `media.edit` 改成让模型直接写 `ffmpeg` shell 命令。
- 不把内置 ffmpeg 从 app-controlled binary 改成依赖用户 PATH。
- 不删除 `run_managed_cli_command`，直到 `command_execution::exec_argv` 已经完整承接它的行为。
- 不改变 `media.edit` 和 `media.transcribe` 的 schema、tool 描述和默认选择优先级。
- 迁移后仍由结构化产品工具生成 ffmpeg argv，shell 只作为通用兜底能力。

### 当前主要问题

1. 命名仍然让 agent 以为要先“找 CLI runtime”再执行命令。

`cli_runtime` 这个名字对用户和模型都不直观。Codex 的心智模型是 shell/command execution。RedConvert 应该把模型默认入口改成 `shell` 或 `command.execution`。

2. 管理动作和执行动作混在同一族。

`detect`、`discover`、`inspect`、`diagnose`、`environment.create`、`install`、`execute`、`execution.get`、`writeStdin`、`verify`、`escalation.approve`、`escalation.deny` 都在 `cli_runtime` 下。即使多数是 CompatOnly，deferred discovery 仍会让模型把它当成一个大工具族。

3. 缺少面向 agent 的 shell string 工具。

当前最完整的真实命令执行入口是 `cli_runtime.execute(argv)`。这适合作为内部协议，但 agent 做真实工程时经常需要 pipe、redirect、inline script、heredoc、`&&`、`for`、`xargs`。让 agent 手动拆 argv 会降低通用性。

4. PTY 语义不足。

`desktop/src-tauri/src/cli_runtime/pty.rs` 现在的 `CliTerminalTransport` 只有 `Pipes`，不是完整 PTY。Codex 的 `command/exec` 会区分 PTY、stdin stream、stdout/stderr stream、resize。RedConvert 如果要支持真实交互式 CLI，应该补完整 PTY，而不是继续把 `usePty` 命名留在 pipe transport 上。

5. 安装能力不应默认模型可见。

Codex 的思路是 agent 可以直接用 shell 安装用户请求的工具，权限/审批负责兜底。RedConvert 的 `cli_runtime.install` 不应该是默认工具，它可以保留为设置页、诊断页或 deferred tool，但不应鼓励模型先走托管 installer。

## 目标产品架构

### 分层

```text
AI Model
  -> shell / write_stdin
  -> Operate(command.execution, only when structured control is needed)

Tool Router
  -> model-visible shell adapter
  -> structured command.execution adapter
  -> legacy cli_runtime compatibility adapter

Command Execution Service
  -> start argv process
  -> start shell script process
  -> write stdin
  -> poll/get snapshot
  -> terminate
  -> resize PTY
  -> emit output deltas
  -> persist logs and execution record
  -> run policy and approval

Environment And Policy
  -> cwd and workspace roots
  -> env merge and runtime PATH prepends
  -> sandbox profile
  -> risk classifier
  -> approval grants
  -> process cleanup on session/app close

UI
  -> terminal/output drawer or existing runtime event view
  -> approval prompts
  -> execution history
  -> diagnostics/settings pages for environment/install/discovery

Product Workflows
  -> media.edit, media.transcribe, video/analyze/generate keep product-level entrypoints
  -> product workflows call Command Execution Service internally with controlled argv
  -> built-in ffmpeg stays app-owned and path-resolved by ffmpeg_program(Some(app))
  -> no extra model tools for ffmpeg, yt-dlp, python, npm, etc.
```

### 模型默认工具面

推荐默认只保留：

| Tool | 默认可见 | 用途 | 说明 |
| --- | --- | --- | --- |
| `shell` | 是 | 运行本机 shell command | 面向 agent 的主入口，支持 shell string、cwd、timeout、输出预算、login shell、权限字段。 |
| `write_stdin` 或 `command.execution.write` | 是 | 给正在运行的命令写 stdin / 轮询输出 | 只在 `shell` 返回 session/execution id 后使用。 |
| `command.execution.get` | 可选 | 获取执行快照 | 如果 `write_stdin` 同时支持空写轮询，可以不默认暴露。 |
| `command.execution.terminate` | 可选 | 停止后台命令 | 对长任务有用，但也可先留给 UI/host。 |
| `tool_search` | 是 | 显式发现 deferred 工具 | 不用于发现本机 CLI，只发现 RedConvert 能力。 |

不默认可见：

| 旧入口 | 处理方式 | 原因 |
| --- | --- | --- |
| `cli_runtime.detect` | diagnostics/deferred | agent 可用 `shell` 直接 `command -v` / `--version`。 |
| `cli_runtime.discover` | diagnostics/deferred | PATH 全量枚举噪音高，不能提升通用性。 |
| `cli_runtime.inspect` | diagnostics/deferred | 只在定位环境问题时需要。 |
| `cli_runtime.diagnose` | diagnostics/deferred | 应是排障工具，不是默认执行路径。 |
| `cli_runtime.environment.*` | settings/internal | 环境是宿主状态，不是 agent 默认任务动作。 |
| `cli_runtime.install` | diagnostics/deferred | 默认用 shell 安装，审批兜底；托管安装器保留给 UI。 |
| `cli_runtime.verify` | internal/deferred | 结构化 verification 属于产品工作流和测试，不是通用命令执行。 |
| `cli_runtime.escalation.*` | UI/internal | 审批应该由用户界面或 approval runtime 处理，不该让模型自己批准。 |

### 宿主协议

新增或重命名为 `command_execution`，保留旧 `cli-runtime:*` channel 兼容一个版本：

| Channel | 输入 | 输出 | 用途 |
| --- | --- | --- | --- |
| `command-execution:exec` | `argv`, `cwd`, `env`, `processId`, `tty`, `streamStdin`, `streamStdoutStderr`, `timeoutMs`, `outputBytesCap`, `sandbox`, `permissionProfile` | immediate response or execution id | App/Server 结构化启动进程。 |
| `command-execution:shell` | `command`, `cwd`, `login`, `timeoutMs`, `outputBytesCap`, `sandbox`, `permissionProfile` | output or execution id | 模型 shell adapter 和用户 terminal command 共用。 |
| `command-execution:write` | `executionId`, `delta`, `closeStdin` | ok + snapshot | stdin 控制。 |
| `command-execution:get` | `executionId`, `maxChars` | snapshot | 拉取 stdout/stderr/status。 |
| `command-execution:terminate` | `executionId` | status | 终止后台进程。 |
| `command-execution:resize` | `executionId`, `rows`, `cols` | ok | 真实 PTY resize。 |
| `command-execution:list` | filters | records | UI 历史和诊断用。 |
| `command-execution:policy-preview` | command/argv + cwd/env | risk summary | 审批 UI 和调试用，不默认给模型。 |

## 现成库与自研边界

必须用现成库：

- Shell argv 解析继续用现有 `shell-words`，只用于结构化 fallback 和显示，不要自研 parser。
- PTY 建议引入成熟库，例如 Rust `portable-pty`，不要自研伪终端。
- JSON schema、serde typed payload、现有 Tauri IPC、现有 store/record 继续复用。
- 文件路径规范化、安全检测、命令执行尽量复用 Rust 标准库和现有 `process_utils::background_command`。

需要自研：

- RedConvert 的 `CommandExecutionService` facade，因为它要接入现有 store、事件、审批、workspace root、媒体工作流。
- `shell` -> command execution 的 adapter，包括 login shell、cwd、output budget、timeout、session id 返回策略。
- `cli_runtime.*` 到 `command_execution.*` 的兼容层。
- 风险策略和审批事件的产品化文案与状态机。
- UI 执行历史、输出流、审批交互的最小呈现。

不要自研：

- 不自研 bash/zsh/powershell 语法解析器。
- 不自研 PTY。
- 不为常见 CLI 自研 wrapper 工具。
- 不让 tool 内部再调用 agent 做二次编排。

## 详细改造计划

### Phase 0: 现状固化和回归基线

目标：先锁住当前行为，尤其是内置 `ffmpeg` 视频剪辑/转写行为，避免重命名时误删能力。

文件：

- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/tools/plan.rs`
- `desktop/src-tauri/src/tools/families/mod.rs`
- `desktop/src-tauri/src/tools/app_cli_cli_runtime.rs`
- `desktop/src-tauri/src/commands/cli_runtime.rs`
- `desktop/src-tauri/src/cli_runtime/executor.rs`
- `desktop/src-tauri/src/cli_runtime/pty.rs`
- `desktop/src-tauri/src/commands/media_edit/execution.rs`
- `desktop/src-tauri/src/commands/media_edit/pipeline.rs`
- `desktop/src-tauri/src/commands/media_transcribe.rs`

动作：

1. 增加工具面 snapshot test，记录默认 team/redclaw/diagnostics 下模型可见的 command/cli 动作。
2. 增加执行回归 test：
   - 普通 argv 命令返回 stdout/stderr/exit code。
   - 后台命令可 get snapshot。
   - stdin 写入可推进等待输入的进程。
   - cancel/terminate 可结束进程并清 registry。
3. 增加媒体工作流保护测试：
   - `media.edit` pipeline 仍生成受控 ffmpeg argv，不经过 shell string。
   - `run_ffmpeg_args` 仍使用 `ffmpeg_program(Some(app))`，不依赖用户 PATH。
   - `run_ffmpeg_args` 仍传入 `runtime_id: media-edit`、`tool_id: ffmpeg`、`ExitCode` 和 `FileExists` 验证规则。
   - `media.transcribe` 音频抽取仍输出 16 kHz mono WAV，并保留 `media-transcribe` runtime id。
4. 明确现有 dirty worktree，避免把无关文件混进提交。

验收：

- 不改变产品行为。
- 能清楚看到当前默认模型面仍有 `cli_runtime.execution.get`、`writeStdin`、`escalation.approve/deny` 等遗留入口。
- `media.edit`、`media.transcribe` 现有测试和最小真实样例通过。

### Phase 1: 引入 `command_execution` facade

目标：先加新名字和新边界，不立刻删除旧 `cli_runtime`。这一阶段只做 facade 和内部适配，不改变 `media.edit` / `media.transcribe` 的调用语义。

新增文件建议：

- `desktop/src-tauri/src/command_execution/mod.rs`
- `desktop/src-tauri/src/command_execution/types.rs`
- `desktop/src-tauri/src/command_execution/service.rs`
- `desktop/src-tauri/src/command_execution/shell.rs`
- `desktop/src-tauri/src/command_execution/events.rs`

实现策略：

1. `command_execution::exec_argv` 内部先调用现有 `execute_cli_command`。
2. `command_execution::shell` 把 shell string 包成用户默认 shell：
   - macOS/Linux: `${SHELL:-/bin/zsh} -lc <command>` 或配置的 shell。
   - Windows: PowerShell profile 关闭策略另行封装。
   - 默认 `cwd` 来自 turn/workspace root。
3. `CommandExecutionRequest` 包含：
   - `kind: "argv" | "shell"`
   - `command: Option<String>`
   - `argv: Vec<String>`
   - `cwd`
   - `env`
   - `timeout_ms`
   - `output_bytes_cap`
   - `tty`
   - `stream_stdin`
   - `stream_stdout_stderr`
   - `execution_mode`
   - `permission_profile`
   - `session_id`
   - `task_id`
4. 旧 `CliExecutionRecord` 暂时继续使用，metadata 增加：
   - `executionLayer: "command_execution"`
   - `commandKind`
   - `rawShellCommand`
   - `argv`
   - `cwd`
   - `policySummary`
5. 增加产品工作流专用 adapter：
   - `command_execution::run_app_managed_argv`
   - 输入必须是已由产品代码构造好的 argv。
   - 默认不走 shell。
   - 默认保留 verification rules。
   - 默认允许传入 `runtime_id` / `tool_id`，供 `media-edit`、`media-transcribe` 等内部链路保留 lineage。
6. `run_managed_cli_command` 在兼容期内保留；可以改为调用 `command_execution::run_app_managed_argv`，但外部函数签名先不变。

验收：

- 新 channel 可执行 `echo hello`。
- 新 channel 可执行 shell pipe：`printf 'a\nb\n' | rg b`。
- 旧 `cli-runtime:execute` 仍可用。
- `run_ffmpeg_args` 不需要改调用点也能继续通过。

### Phase 2: 新模型工具 `shell`

目标：让 agent 像 Codex 一样用广谱 shell，而不是先找 CLI runtime。

文件：

- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/tools/host_impl.rs` 或现有 shell handler 文件
- `desktop/src-tauri/src/tools/compat.rs`
- `desktop/src-tauri/src/tools/packs.rs`
- `desktop/src-tauri/src/tools/plan.rs`

动作：

1. 把现有 `shell` 的描述从“只读 shell inspection”改成真实命令执行入口，或新增 `exec_command` 风格工具并让 `shell` alias 到它。
2. schema 对齐 Codex：
   - `cmd` 或 `command`
   - `workdir`
   - `timeout_ms`
   - `yield_time_ms`
   - `max_output_tokens`
   - `tty`
   - `login`
   - `sandbox_permissions` 或 `executionMode`
   - `justification`
3. 返回结构对齐：
   - 若短命令完成，返回 `exit_code`、`stdout`、`stderr`。
   - 若命令仍运行，返回 `session_id` / `execution_id` 和最近输出。
4. 增加 `write_stdin` 或把 `command.execution.write` 默认暴露：
   - `session_id`
   - `chars`
   - `yield_time_ms`
   - `max_output_tokens`
5. 模型工具描述明确：
   - 用于任何本机命令。
   - 设置 `workdir`，不要用 `cd`。
   - 安装工具时直接运行用户系统对应命令，但需要审批。
   - 不要先调用 `cli_runtime.detect/discover`。

验收：

- 模型默认工具面中，通用命令入口变成 `shell` + stdin 控制。
- team/redclaw 默认不再暴露 `cli_runtime.execution.get` 作为主要心智入口。

### Phase 3: 压缩 `cli_runtime` 默认暴露

目标：把旧 CLI runtime 变成兼容和诊断层。

文件：

- `desktop/src-tauri/src/tools/catalog.rs`
- `desktop/src-tauri/src/tools/plan.rs`
- `desktop/src-tauri/src/tools/families/cli_runtime.rs`
- `desktop/src-tauri/src/tools/families/mod.rs`

动作：

1. 新增 family：
   - `command_execution::FAMILY = "command_execution"`
   - `command_execution::NAMESPACE = "command_execution"`
   - `command_execution::CONTROL_NAMESPACE = "command_execution.control"`
2. 更新 `default_direct_namespaces`：
   - diagnostics/background-maintenance 直出 `command_execution`，不直出 `cli_runtime.execution`。
3. 更新 pinned actions：
   - 移除 `cli_runtime.execution.get`。
   - 如需要，加入 `command.execution.get` 或完全依赖 `write_stdin` 空轮询。
4. 所有 `cli_runtime.*` visibility 改成：
   - `execute/get/writeStdin/cancel` 保留 CompatOnly。
   - `detect/discover/inspect/diagnose/environment/install/verify/escalation` 保留 CompatOnly 或 Internal。
5. `tool_search` 搜索结果里给旧入口加迁移提示：
   - “Use shell for host commands.”
   - “Use command.execution only for process control.”
6. 保持产品工具直出策略：
   - `media.edit` 继续作为视频剪辑默认工具。
   - `media.transcribe` 继续作为字幕/转写默认工具。
   - `video.generate`、`video.analyze`、`media.videoRetalk` 不受 `cli_runtime` 压缩影响。

验收：

- 默认 team/redclaw 模型面不再出现 `cli_runtime.*`。
- deferred discovery 仍能找到旧入口，但不会推荐模型优先使用。
- 视频剪辑类请求仍优先命中 `media.edit`，而不是 `shell`。

### Phase 4: 完整进程控制和 PTY

目标：补齐 Codex 那种真正可控的 long-running command 能力。

文件：

- `desktop/src-tauri/src/cli_runtime/pty.rs`
- `desktop/src-tauri/src/cli_runtime/executor.rs`
- `desktop/src-tauri/src/command_execution/service.rs`

动作：

1. 引入 `portable-pty` 或同级成熟 PTY 库。
2. `CliTerminalTransport` 扩展：
   - `Pipes`
   - `Pty`
3. `spawn_cli_terminal` 根据 `tty` 选择 transport。
4. 增加 resize 支持：
   - service 层记录 PTY handle。
   - channel `command-execution:resize` 调整 terminal size。
5. 输出事件统一：
   - `command_execution:started`
   - `command_execution:output_delta`
   - `command_execution:status`
   - `command_execution:finished`
   - `command_execution:approval_requested`
6. 输出预算：
   - 即时响应默认 4k 到 10k chars。
   - log 文件保存完整输出。
   - model output 按 token/char cap 截断并标记 `truncated`。

验收：

- 交互式命令可获得 session id。
- `write_stdin` 可写入。
- `terminate` 可结束。
- PTY resize 不影响 pipe 模式。

### Phase 5: UI 和产品工作流接入

目标：UI 只承接必要控制，不增加噪音。

UI 原则：

- 不新增大面板。
- 现有运行事件/任务详情里加最小命令执行条目。
- 审批必须由用户显式点确认，模型不能自己 approve。
- 输出默认折叠或显示 tail，避免刷屏。

实现：

1. Runtime event view 显示：
   - command label
   - cwd
   - status
   - elapsed time
   - stdout/stderr tail
   - stop button
2. Approval prompt 显示：
   - command
   - cwd
   - risk reasons
   - one-time / session grant
3. Settings/Diagnostics 才显示：
   - detected tools
   - managed environments
   - install records
   - policy preview

产品工作流：

- `media.edit`、`media.transcribe`、视频处理继续走内部 `command_execution::run_app_managed_argv` 或等价 app-managed argv API。
- ffmpeg/yt-dlp/python/node 不新增模型工具。
- 当 workflow 需要检查依赖时，内部 service 先 `command -v` / `--version` 或复用 diagnostics，不暴露给模型。
- 内置 ffmpeg 不走 `command -v`；继续使用 `ffmpeg_program(Some(app))` 获取 app-controlled binary。
- 产品工作流不得退化成模型自由拼接 shell 命令；shell 只用于通用工程任务和没有结构化产品工具覆盖的场景。

验收：

- 用户能看到和终止正在运行的真实命令。
- agent 不需要知道 RedConvert 有一个 CLI runtime 模块。
- 媒体/视频功能不回退，尤其是 `media.edit` 和 `media.transcribe`。

### Phase 6: 兼容清理

目标：确认无旧调用后删除或彻底隐藏旧名字。

条件：

- 一版以上 telemetry 显示默认模型不再调用 `cli_runtime.*`。
- 内置 skills/prompts 已替换为 `shell` / `command.execution`。
- app_cli 文档和 tests 已迁移。
- `media.edit`、`media.transcribe`、视频拼接/转码链路已全部通过 app-managed argv adapter，且不再直接依赖旧 facade 名字。

动作：

1. `cli_runtime.*` catalog entry 保留 legacy alias，但不出现在模型工具面和 tool_search 默认结果。
2. 删除旧文档里鼓励 agent 使用 `cli_runtime.detect/discover/install` 的说明。
3. 如果后续仍保留托管环境功能，把目录名保留为内部实现细节，不再进入 AI tool naming。
4. 只有当产品工作流全部迁移完成后，才允许删除旧 `run_managed_cli_command` facade；删除前必须先保留同名 wrapper 或完成全仓调用点替换。

## 旧入口到新入口映射

| 旧入口 | 新入口 | 迁移说明 |
| --- | --- | --- |
| `cli_runtime.execute(argv)` | `shell(command)` for agent, `command-execution:exec(argv)` for host | agent 优先 shell，内部协议优先 argv。 |
| `cli_runtime.execution.get` | `write_stdin(session_id, chars=\"\")` 或 `command.execution.get` | 如果 `write_stdin` 支持空轮询，可少暴露一个工具。 |
| `cli_runtime.execution.writeStdin` | `write_stdin` / `command.execution.write` | 改成 Codex 风格命名。 |
| `cli_runtime.verify` | product workflow internal verification | 不默认给模型。 |
| `cli_runtime.detect` | diagnostics only | shell 可直接 `command -v`。 |
| `cli_runtime.discover` | diagnostics only | PATH 全枚举默认噪音大。 |
| `cli_runtime.inspect` | diagnostics only | 排障时通过 tool_search 显式发现。 |
| `cli_runtime.diagnose` | `command-execution:policy-preview` / diagnostics | 变成安全预览和环境诊断。 |
| `cli_runtime.environment.*` | settings/internal | 用户配置面，不是 agent 默认动作。 |
| `cli_runtime.install` | shell install command + approval, managed installer in settings | agent 不需要知道 RedConvert installer。 |
| `cli_runtime.escalation.*` | UI approval runtime | 模型不能自己批准权限。 |
| `run_managed_cli_command` | `command_execution::run_app_managed_argv` | 内部兼容迁移，先保留 wrapper，不能影响 `media.edit` / `media.transcribe`。 |
| app-managed `ffmpeg` argv | 继续 app-managed argv | 不迁移到 shell，继续使用 `ffmpeg_program(Some(app))`。 |

## 性能优化策略

1. 输出流分块。
   - stdout/stderr 用 8 KB 到 64 KB chunk。
   - UI 流式接收 delta。
   - 模型响应只带 tail 和 truncation metadata。

2. 锁外 I/O。
   - store 只写 execution record 快照。
   - 进程等待、日志读写、验证、目录扫描都不在 `with_store_mut` 内执行。

3. 日志增量写。
   - 完整日志落文件。
   - store 保存 path、status、exit code、tail metadata。
   - get snapshot 时读取 tail，不把大输出塞进状态库。

4. 环境缓存。
   - PATH 和 runtime env 快照按 workspace/session 缓存。
   - detect/discover 只在 diagnostics 或显式刷新时做。

5. 进程清理。
   - app close/session close/thread cancel 时终止 connection/session scoped process。
   - background registry 必须有 TTL 和 orphan cleanup。

6. PTY 懒加载。
   - 非交互命令默认 pipes。
   - 只有 `tty=true` 或模型明确需要交互时启用 PTY。

## 推荐方案对比

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 彻底删除 `cli_runtime` 重做 | 命名最干净 | 破坏执行记录、审批、日志、stdin、media 依赖，风险高 | 不推荐 |
| B. 保留 `cli_runtime`，只继续隐藏工具 | 改动小 | 心智模型仍旧，模型和文档仍会被旧名字牵引 | 不够 |
| C. 新增 `command_execution` facade，旧层兼容，默认模型面改为 `shell` | 风险低，Codex 对齐，广谱性最好 | 需要迁移 tests/docs/naming | 推荐 |
| D. 为常见 CLI 做一批 wrapper | 短期看起来好用 | 工具爆炸，维护成本高，和 Codex 方向相反 | 不推荐 |
| E. 把 `media.edit` 改成 shell ffmpeg | 看似统一 | 失去结构化剪辑约束、内置 ffmpeg 路径控制、输出验证和媒体库注册稳定性 | 禁止 |

推荐 C。

## 验证矩阵

Rust/工具面：

- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::catalog`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml tools::plan`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime`
- 新增后运行 `cargo test --manifest-path desktop/src-tauri/Cargo.toml command_execution`

真实任务：

- `shell` 执行 `pwd`，确认 cwd 正确。
- `shell` 执行带 pipe 的命令，确认保留 shell 语义。
- `shell` 启动等待 stdin 的命令，`write_stdin` 推进并拿到输出。
- 长命令 terminate 后状态为 cancelled/terminated。
- 危险命令触发 approval，不允许模型自批。
- `media.transcribe` / `media.edit` 继续通过内部执行层工作。
- `media.edit` trim/concat/speed 至少各跑一个最小样例，输出文件存在且可由 ffprobe/ffmpeg 读取。
- `media.transcribe` 最小样例能抽取 WAV，音频参数仍为 mono 16 kHz。
- 视频剪辑请求的工具选择仍优先 `media.edit`，不是 `shell`。

工具面验收：

- team/redclaw 默认模型面无 `cli_runtime.*`。
- diagnostics 仍可通过 tool_search 找到必要的 command diagnostics。
- `tool_search` 搜索 “run shell command” 优先返回 `shell` 或 `command.execution`。

## Atomic Commit 建议

1. `test(command): capture current cli runtime execution baseline`
2. `feat(command): add command execution facade`
3. `feat(tools): expose broad shell command tool`
4. `refactor(tools): move cli runtime tools behind command execution aliases`
5. `feat(command): add pty resize and streaming controls`
6. `docs(command): document command execution migration`

每个提交只做一件事，避免把测试、重命名、行为改动和文档混在一起。

## 最终判断

我们的 CLI runtime 不是完全没必要，没必要的是把它作为模型默认工具家族暴露出来。它应该降级成宿主命令执行 substrate、审计记录和诊断/设置能力。内置 `ffmpeg` 更不能被当成“普通可删 CLI 能力”：它是视频剪辑、转写、转码、拼接等产品功能的底层执行引擎，必须通过 app-managed argv 保持稳定。Codex 真正值得学的是：

- 一个通用 shell 能力覆盖绝大多数本机工具使用场景。
- argv vector 是宿主协议，不是 agent 的主要心智负担。
- PTY/stdin/output/terminate/resize 是进程控制原语。
- 权限和 sandbox 是每次执行的属性。
- CLI 安装是 shell 能力加审批，不是默认模型工具目录。

按这个方案改完，RedConvert 的这一层会更广谱：agent 想用任何用户电脑上的通用工具，直接 `shell`；App 想精确控制进程，用 `command_execution`；产品工作流想复用内置 `ffmpeg`、python/node 等执行能力，用 app-managed argv 内部 service；诊断和托管环境保留，但不污染默认 AI 工具面。
