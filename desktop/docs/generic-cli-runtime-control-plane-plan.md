---
doc_type: plan
execution_status: in_progress
execution_stage: registry_and_manifest_execution
last_updated: 2026-04-23
owner: codex
target_files:
  - desktop/src-tauri/src/cli_runtime/*
  - desktop/src-tauri/src/commands/cli_runtime.rs
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/tools/*
  - desktop/src-tauri/src/persistence/*
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/runtime/runtimeEventStream.ts
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/components/ProcessTimeline.tsx
success_metrics:
  - cli_detection_success_rate
  - environment_bootstrap_success_rate
  - execution_session_visibility_rate
  - verification_grounded_success_rate
  - sandbox_escalation_precision
---

# RedConvert 通用 CLI Runtime Control Plane 改造蓝图

## 1. Goal

本方案定义 RedConvert 下一代通用 CLI Runtime 底座，目标不是继续扩 `bash` 或把常见 CLI 硬编码成一批 wrapper，而是建立一套统一控制平面，让 AI 在宿主管理下完成：

- 发现本机 CLI
- 自主安装缺失依赖
- 管理运行环境
- 执行外部命令
- 请求按次扩权
- 校验执行结果
- 把过程和结果绑定回当前 session / task / runtime

完成后，RedConvert 内的 AI 不需要预先知道每个 CLI 的领域语义，也不需要把 `lark-cli`、`ffmpeg`、`wrangler`、`supabase`、`gh` 这类工具逐个硬编码进 app。它只需要通过统一的 CLI runtime contract 调用外部能力。

## 2. Problem Statement

当前 RedConvert 存在四个系统级断层：

1. 执行环境断层

- 现有 `bash` 是受限只读检查工具，不是外部执行底座。
- `npm` / `node` / `uv` / `cargo` / `PATH` 没有统一环境模型。
- 用户在系统终端里完成的安装，当前会话不一定感知。

2. 能力建模断层

- `skills` 当前是 prompt / tool policy 资产，不是 CLI 依赖与运行时资产。
- `skills:market-install` 目前更接近占位式技能注册，不是外部工具安装系统。

3. 会话可观测性断层

- 外部 CLI 执行结果没有被统一写成 runtime event。
- 对话 UI 只能看到工具调用摘要，不能看到完整外部执行生命周期。

4. 成功判定断层

- 当前系统容易把“命令退出码为 0”误当成“任务成功”。
- 没有独立的 verification layer 去校验文件产物、结构化输出、业务副作用。

## 3. Architecture Decision

本改造存在三个方案：

### Option A

继续放大现有 `bash` 能力。

优点：

- 开发最少
- 兼容现有 runtime/tool 结构

缺点：

- 环境、安装、权限、回流、验证都仍然没被单独建模
- 用户机器环境仍不可控
- 外部执行仍然偏黑盒

### Option B

为常见工具写固定 wrapper，例如 `lark.docs.write`、`ffmpeg.transcode`、`gh.pr.review`。

优点：

- UX 稳定
- 对头部能力可优化较深

缺点：

- 无法覆盖长尾 CLI
- 每接一个生态都要重写领域协议
- 与用户“机器上已有很多未知工具”的真实情况不匹配

### Option C

新增一套通用 CLI Runtime Control Plane，把 CLI 视为动态可发现、可安装、可执行、可验证的宿主资源。

优点：

- 覆盖长尾 CLI
- 不依赖穷举式 wrapper
- 把安装、环境、执行、扩权、验证全部纳入宿主管理
- 能直接服务 Chat / RedClaw / Workboard / Media / Video

缺点：

- 需要新增较多宿主模块
- 第一版必须把安全和可观测性做扎实

### Selected Architecture

选择 `Option C`。

原因：

- 这是唯一能同时满足“通用性”和“工程可控性”的路线。
- 现有 `runtime`、`events`、`task`、`job runner` 已经具备足够宿主基础，不需要再走 prompt-based workaround。

## 4. Design Principles

### 4.1 CLI 是动态能力，不是固定产品语义

- App 不预设每个 CLI 的方法表。
- App 只定义“如何发现、安装、执行、验证 CLI”的基础协议。

### 4.2 Shell 不是裸露给模型的

- 不开放任意系统 shell 直通。
- 一切 CLI 执行都必须经过 policy + execution record + runtime event。

### 4.3 Skill 不是安装器

- skill 继续负责 prompt、策略、workflow、context patch。
- 外部工具安装和环境管理统一移到 `cli_runtime/*`。

### 4.4 任务成功必须有 verification

- `exit_code == 0` 只是命令成功，不代表任务成功。
- 任务级成功必须经过 verifier。

### 4.5 默认最小权限，按次扩权

- 默认只允许 workspace 内受控执行。
- 当命令需要联网、写外部目录、安装依赖、访问敏感路径时，进入 escalation flow。

## 5. Target Architecture

### 5.1 Layer Map

| Layer | Main Paths | Responsibility | Must Reuse | Must Build |
| --- | --- | --- | --- | --- |
| Renderer UI | `src/pages/*`, `src/components/*` | 工具页、环境页、执行时间线、扩权确认 | React, existing page shell | CLI 管理 UI、execution timeline、escalation UX |
| Bridge | `src/bridge/ipcRenderer.ts`, `src/runtime/runtimeEventStream.ts` | CLI IPC helper、事件归一化 | existing IPC and runtime stream | typed CLI bridge + CLI event parsing |
| Host Commands | `src-tauri/src/commands/cli_runtime.rs` | Renderer 请求入口 | existing command routing | CLI command surface |
| CLI Runtime | `src-tauri/src/cli_runtime/*` | 发现、环境、安装、执行、校验、策略 | runtime/task/event infra | full CLI control plane |
| Persistence | `src-tauri/src/persistence/*` | 持久化 tool/env/execution/manifests | store infra | CLI state persistence |
| Runtime Core | `src-tauri/src/runtime/*`, `src-tauri/src/events/*` | session/task/runtime 绑定、事件广播 | current runtime/task system | CLI execution integration |

### 5.2 New Host Module Tree

建议新增：

```text
desktop/src-tauri/src/cli_runtime/
  mod.rs
  types.rs
  detector.rs
  path_env.rs
  runtime_resolver.rs
  environment_store.rs
  manifest_store.rs
  introspection.rs
  process_store.rs
  executor.rs
  pty.rs
  policy.rs
  sandbox.rs
  verify.rs
  events.rs
  installers/
    mod.rs
    npm.rs
    python.rs
    cargo.rs
    go.rs
    binary.rs
```

建议新增 host command：

- `desktop/src-tauri/src/commands/cli_runtime.rs`

## 6. New Domain Model

以下类型必须成为 canonical store/runtime contract。

### 6.1 `CliToolRecord`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliToolRecord {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub resolved_path: Option<String>,
    pub source: CliToolSource,
    pub install_method: Option<CliInstallMethod>,
    pub install_spec: Option<String>,
    pub version: Option<String>,
    pub health: CliToolHealth,
    pub manifest_id: Option<String>,
    pub last_checked_at: Option<i64>,
    pub metadata: Option<serde_json::Value>,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CliToolSource {
    System,
    AppManaged,
    WorkspaceManaged,
    UserDeclared,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CliToolHealth {
    Unknown,
    Ready,
    Missing,
    Broken,
}
```

### 6.2 `CliEnvironmentRecord`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliEnvironmentRecord {
    pub id: String,
    pub scope: CliEnvironmentScope,
    pub root_path: String,
    pub workspace_root: Option<String>,
    pub path_entries: Vec<String>,
    pub runtimes: CliRuntimeInventory,
    pub installed_tool_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Option<serde_json::Value>,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CliEnvironmentScope {
    AppGlobal,
    WorkspaceLocal,
    TaskEphemeral,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CliRuntimeInventory {
    pub node: Option<String>,
    pub python: Option<String>,
    pub uv: Option<String>,
    pub pnpm: Option<String>,
    pub cargo: Option<String>,
    pub go: Option<String>,
}
```

### 6.3 `CliToolManifestRecord`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliToolManifestRecord {
    pub id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub version: Option<String>,
    pub supports_json_output: bool,
    pub supports_version_flag: bool,
    pub preferred_parser: CliOutputParser,
    pub commands: Vec<CliManifestCommand>,
    pub generated_at: i64,
}
```

### 6.4 `CliExecutionRecord`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliExecutionRecord {
    pub id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub environment_id: String,
    pub tool_id: Option<String>,
    pub command: Vec<String>,
    pub cwd: String,
    pub status: CliExecutionStatus,
    pub exit_code: Option<i32>,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub artifact_paths: Vec<String>,
    pub verification_status: CliVerificationStatus,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub metadata: Option<serde_json::Value>,
}
```

### 6.5 `CliEscalationRequestRecord`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliEscalationRequestRecord {
    pub id: String,
    pub execution_id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub reason: CliEscalationReason,
    pub requested_permissions: CliPermissionGrantSet,
    pub status: CliEscalationStatus,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}
```

### 6.6 `CliVerificationRecord`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliVerificationRecord {
    pub id: String,
    pub execution_id: String,
    pub verifier: CliVerifierKind,
    pub status: CliVerificationStatus,
    pub summary: String,
    pub detail: Option<serde_json::Value>,
    pub created_at: i64,
}
```

## 7. Storage Layout

### 7.1 Host Data Root

建议使用应用数据目录：

```text
<app-data>/cli-runtime/
  tools.json
  environments.json
  manifests.json
  executions.json
  escalations.json
  verify.json
  logs/
    <execution-id>.stdout.log
    <execution-id>.stderr.log
  environments/
    app-global/
    workspace/
      <workspace-hash>/
    ephemeral/
      <task-id>/
```

### 7.2 Persistence Rules

- 元数据索引保存在 store 或 JSON sidecar。
- 大日志不嵌入主 store，单独文件化。
- 环境目录和日志目录必须可清理、可重建。
- 删除 workspace 时必须清理对应 workspace-local env record。

### 7.3 Locking Rules

遵守仓库既有规则：

- 持锁读取最小快照
- 锁外完成目录扫描、依赖安装、`--help` 解析、日志读取
- 回锁只做内存状态更新

## 8. Detailed Module Design

### 8.1 `path_env.rs`

职责：

- 读取当前进程环境
- 加载用户 login shell env
- 合并 PATH
- 扫描常见 bin 目录
- 为 environment 产出最终执行环境变量

实现要求：

- macOS/Linux：执行 `<shell> -l -c env`
- Windows：追加常见工具目录
- app-managed bin 必须排在 PATH 前面

参考：

- `/Users/Jam/LocalDev/GitHub/AionUi/src/process/utils/shellEnv.ts`

输出 API：

```rust
pub fn load_host_shell_env() -> Result<BTreeMap<String, String>, String>;
pub fn merge_execution_env(
    base: &BTreeMap<String, String>,
    environment: &CliEnvironmentRecord,
    custom: Option<&BTreeMap<String, String>>,
) -> BTreeMap<String, String>;
pub fn discover_extra_bin_paths() -> Vec<String>;
```

### 8.2 `detector.rs`

职责：

- 探测命令是否存在
- 获取版本
- 生成 `CliToolRecord`
- 按 TTL 缓存结果

实现要求：

- `which` / `where` / direct path fallback
- 版本检测优先：
  - `--version`
  - `version`
  - `-V`
- 检测失败不能 panic，只能标记 `Missing` / `Broken`

输出 API：

```rust
pub fn detect_tool(command: &str, env: &BTreeMap<String, String>) -> CliToolRecord;
pub fn detect_many(commands: &[String], env: &BTreeMap<String, String>) -> Vec<CliToolRecord>;
pub fn refresh_tool_health(tool_id: &str) -> Result<CliToolRecord, String>;
```

### 8.3 `environment_store.rs`

职责：

- 创建 / 更新 / 删除 environment
- 维护 app-global / workspace-local / task-ephemeral 生命周期

创建规则：

- `app-global`：首次启动时懒创建
- `workspace-local`：在指定工作区首次需要 local env 时创建
- `task-ephemeral`：需要隔离任务时创建，任务完成后可 GC

输出 API：

```rust
pub fn ensure_app_global_environment() -> Result<CliEnvironmentRecord, String>;
pub fn ensure_workspace_environment(workspace_root: &Path) -> Result<CliEnvironmentRecord, String>;
pub fn create_task_ephemeral_environment(task_id: &str) -> Result<CliEnvironmentRecord, String>;
pub fn delete_environment(environment_id: &str) -> Result<(), String>;
```

### 8.4 `runtime_resolver.rs`

职责：

- 决定某次执行应该落到哪个 environment
- 决定某个 installer 应使用哪个 runtime

规则：

- 默认：优先 app-global
- 若任务声明与 workspace 强耦合：workspace-local
- 若命令被标记为高风险或一次性实验：task-ephemeral
- 若 tool 已在某环境中安装，则优先复用该环境

### 8.5 `installers/*`

职责：

- 统一管理依赖自举

installer 粒度：

- `npm.rs`
- `python.rs`
- `cargo.rs`
- `go.rs`
- `binary.rs`

统一接口：

```rust
#[async_trait]
pub trait CliInstaller {
    fn kind(&self) -> CliInstallMethod;
    async fn install(&self, request: CliInstallRequest) -> Result<CliInstallResult, CliInstallError>;
    async fn verify(&self, request: CliInstallVerifyRequest) -> Result<CliInstallVerifyResult, CliInstallError>;
}
```

关键规则：

- 默认禁止系统全局安装
- `brew` / `apt` / `npm -g` / `sudo` 必须进入 escalation
- 安装后必须写回：
  - tool record
  - environment installed tool ids
  - install logs

### 8.6 `introspection.rs`

职责：

- 通过 CLI 自述生成动态 manifest

扫描顺序：

1. `--version`
2. `--help`
3. `help`
4. 可选：首层子命令 `help`

输出：

- `CliToolManifestRecord`
- 子命令摘要
- parser hint

限制：

- 第一版只做一层命令树，不做无限递归
- 长帮助文本做截断和缓存

### 8.7 `executor.rs`

职责：

- 创建 `CliExecutionRecord`
- 启动命令
- 流式记录 stdout/stderr
- 向 runtime 发送事件
- 支持 cancel / retry / background

统一执行入口：

```rust
pub async fn execute(request: CliExecuteRequest) -> Result<CliExecutionRecord, CliExecutionError>;
pub async fn cancel(execution_id: &str) -> Result<(), CliExecutionError>;
pub async fn poll(execution_id: &str) -> Result<CliExecutionSnapshot, CliExecutionError>;
```

### 8.8 `pty.rs`

职责：

- 托管交互式 CLI
- 提供 `stdin write`, `poll`, `kill`

必须使用现成库：

- `portable-pty`

适用场景：

- `codex`
- `claude`
- `gemini`
- 任何 REPL / interactive auth / curses 类 CLI

### 8.9 `policy.rs`

职责：

- 命令预检
- 识别风险
- 判断是否需要 escalation

输入：

- command argv
- cwd
- env target
- installer kind
- requested network / path / env grants

输出：

- `Allowed`
- `Blocked`
- `NeedsEscalation(CliEscalationRequestRecord)`

策略维度：

- workspace 外写权限
- home 目录敏感路径
- 系统目录
- 网络访问
- 全局安装
- `sudo`
- `rm`, `dd`, `mkfs`, `chmod`, `chown`, destructive SQL

### 8.10 `sandbox.rs`

职责：

- 实际创建 sandboxed execution context

第一版策略：

- macOS：先做 path/network/policy gate；seatbelt integration 作为增强项
- Linux：优先支持 bubblewrap 或容器 backend
- Windows：第一版不做完整 OS-level sandbox，靠 policy + env isolation + path restriction

长期目标：

- 支持 backend：
  - `local`
  - `container`
  - `ssh`

### 8.11 `verify.rs`

职责：

- 执行后校验任务结果

verifier 类型：

- `exit_code`
- `file_exists`
- `output_contains`
- `json_schema`
- `artifact_probe`
- `custom_command`

统一接口：

```rust
pub async fn run_verifiers(
    execution: &CliExecutionRecord,
    rules: &[CliVerifyRule],
) -> Result<Vec<CliVerificationRecord>, CliVerifyError>;
```

### 8.12 `events.rs`

职责：

- 将 CLI runtime 生命周期映射到统一 `runtime:event`

新增事件：

- `runtime:cli-tool-detected`
- `runtime:cli-install-started`
- `runtime:cli-install-finished`
- `runtime:cli-execution-started`
- `runtime:cli-execution-log`
- `runtime:cli-execution-status`
- `runtime:cli-escalation-requested`
- `runtime:cli-escalation-resolved`
- `runtime:cli-verification-finished`

## 9. Host Command Surface

新增：

- `desktop/src-tauri/src/commands/cli_runtime.rs`

建议 command 列表：

```rust
#[tauri::command]
async fn cli_runtime_detect(...)
#[tauri::command]
async fn cli_runtime_list_tools(...)
#[tauri::command]
async fn cli_runtime_inspect(...)
#[tauri::command]
async fn cli_runtime_list_environments(...)
#[tauri::command]
async fn cli_runtime_create_environment(...)
#[tauri::command]
async fn cli_runtime_install(...)
#[tauri::command]
async fn cli_runtime_execute(...)
#[tauri::command]
async fn cli_runtime_cancel_execution(...)
#[tauri::command]
async fn cli_runtime_poll_execution(...)
#[tauri::command]
async fn cli_runtime_verify(...)
#[tauri::command]
async fn cli_runtime_approve_escalation(...)
#[tauri::command]
async fn cli_runtime_deny_escalation(...)
```

`main.rs` 只负责注册，不承载实现。

## 10. IPC Contract

### 10.1 Renderer Bridge Additions

在 [ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts) 中新增：

```ts
cliRuntime: {
  detect: (payload?: { commands?: string[] }) => invokeChannel('cli-runtime:detect', payload || {}),
  listTools: () => invokeChannel('cli-runtime:list-tools'),
  inspect: (payload: { toolId: string }) => invokeChannel('cli-runtime:inspect', payload),
  listEnvironments: () => invokeChannel('cli-runtime:list-environments'),
  createEnvironment: (payload: { scope: 'app-global' | 'workspace-local' | 'task-ephemeral'; workspaceRoot?: string; taskId?: string }) =>
    invokeChannel('cli-runtime:create-environment', payload),
  install: (payload: {
    environmentId: string;
    installMethod: string;
    spec: string;
    toolName?: string;
  }) => invokeChannel('cli-runtime:install', payload),
  execute: (payload: {
    environmentId: string;
    toolId?: string;
    argv: string[];
    cwd: string;
    usePty?: boolean;
    verificationRules?: unknown[];
  }) => invokeChannel('cli-runtime:execute', payload),
  cancelExecution: (payload: { executionId: string }) => invokeChannel('cli-runtime:cancel-execution', payload),
  pollExecution: (payload: { executionId: string }) => invokeChannel('cli-runtime:poll-execution', payload),
  verify: (payload: { executionId: string; rules: unknown[] }) => invokeChannel('cli-runtime:verify', payload),
  approveEscalation: (payload: { escalationId: string; scope: 'once' | 'session' | 'always' }) =>
    invokeChannel('cli-runtime:approve-escalation', payload),
  denyEscalation: (payload: { escalationId: string; reason?: string }) =>
    invokeChannel('cli-runtime:deny-escalation', payload),
}
```

### 10.2 Types

同步更新：

- `desktop/src/types.d.ts`

## 11. Runtime Event Stream Integration

在 [runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts) 扩展 handler：

- `onCliInstallStarted`
- `onCliInstallFinished`
- `onCliExecutionStarted`
- `onCliExecutionLog`
- `onCliExecutionStatus`
- `onCliEscalationRequested`
- `onCliEscalationResolved`
- `onCliVerificationFinished`

Renderer 规则：

- 一律按 `sessionId` 过滤
- task 页面再按 `taskId` 过滤
- 日志事件允许分块更新，不覆盖历史块

## 12. AI Runtime Integration

### 12.1 Tool Surface Strategy

不新增大量 top-level tools。

建议方式：

- 保持 top-level tool 收敛
- 新增 `app_cli(action="cli_runtime.*")` 动作族

建议 action：

- `cli_runtime.detect`
- `cli_runtime.inspect`
- `cli_runtime.environment.list`
- `cli_runtime.environment.create`
- `cli_runtime.install`
- `cli_runtime.execute`
- `cli_runtime.verify`
- `cli_runtime.escalation.approve`
- `cli_runtime.escalation.deny`

### 12.2 Runtime State Injection

交互式 runtime 需要能看到以下 typed bundle：

- `available_cli_tools`
- `available_cli_manifests`
- `available_environments`
- `recent_cli_executions`
- `pending_cli_escalations`

### 12.3 Skill Integration

skill 可以：

- 建议安装哪些 CLI
- 提供 command pattern
- 提供 verify rule 模板

skill 不能：

- 直接负责安装
- 绕过 environment / policy
- 直接要求模型拼接全局安装命令

## 13. UI Blueprint

### 13.1 Settings: External Tools

新增 section：

- 工具名
- 路径
- 版本
- 来源
- health
- environment
- 最近检查时间

支持操作：

- refresh detect
- inspect
- install/repair
- open environment root

### 13.2 Settings: Environments

新增 section：

- app-global
- workspace-local
- task-ephemeral

展示：

- runtime inventory
- installed tools
- path entries
- disk usage

### 13.3 Chat / Timeline

在 [ProcessTimeline.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/components/ProcessTimeline.tsx) 新增 item type：

- `cli-install`
- `cli-exec`
- `cli-escalation`
- `cli-verify`

显示信息：

- tool/environment
- concise command
- current status
- verify result
- expandable log preview

### 13.4 Escalation Dialog

扩权弹窗必须展示：

- 这次命令要做什么
- 需要哪些额外权限
- 为什么需要
- 生效范围：
  - only once
  - this session
  - always

### 13.5 Workboard / RedClaw

后台 CLI 任务必须可视化：

- install queue
- running executions
- verification failures
- resume/retry actions

## 14. Security Model

### 14.1 Default Policy

默认：

- 只允许当前 workspace 执行
- 禁止写 workspace 外路径
- 禁止网络
- 禁止系统级安装
- 禁止 `sudo`

### 14.2 Escalation Triggers

以下必须触发 escalation：

- `npm install -g`
- `brew install`
- `apt install`
- `sudo`
- 写 `~/.config`, `~/.ssh`, `/etc`, `/usr/local`
- 访问外部网络
- 修改 app-managed runtime root 之外的系统路径

### 14.3 Escalation Scope

- `once`
- `session`
- `always`

`always` 必须落配置，并允许项目/用户撤销。

### 14.4 Verification Guard

- 若 verify 失败，不得把任务标为成功。
- 若 install 成功但 tool detect 失败，状态必须是 failed，不是 succeeded。

## 15. Performance Strategy

### 15.1 Detection

- tool detect TTL：5 分钟
- shell env preload：启动时异步
- 只在显式 refresh 时清缓存

### 15.2 Manifest

- `--help` 文本缓存
- 只做一层子命令 introspection
- manifest fingerprint 基于：
  - resolved path
  - version
  - mtime

### 15.3 Execution

- 日志写文件，不塞主 store
- UI 默认只拉最近 N KB
- background process 用 poll，不全量推送大日志

### 15.4 Environment

- app-global 可长期复用
- workspace-local 按 workspace hash 复用
- task-ephemeral 提供 GC

## 16. Verification Matrix

### 16.1 Host Unit Tests

- detector path merge
- runtime resolver selection
- installer request validation
- dangerous path / sudo / network escalation detection
- verifier behaviors

### 16.2 Host Integration Tests

- install -> detect -> execute -> verify 全链路
- PTY session create / write / kill
- background execution log polling
- escalation allow / deny
- environment reuse

### 16.3 Renderer Verification

- Settings 页面检测刷新不清空旧数据
- Chat timeline 事件流更新正确
- escalation dialog 不丢状态

### 16.4 Smoke Scenarios

- 缺少 `node` 时自动 bootstrap app-managed node
- 安装 `lark-cli` 到 app-global
- `ffmpeg` 执行导出并 verify 文件存在
- 外部路径写权限触发 escalation

## 17. Implementation Sequence

必须按 atomic commits 执行。

### Commit 1

新增 `cli_runtime/types.rs`、`path_env.rs`、`detector.rs`

### Commit 2

新增 `environment_store.rs`、`runtime_resolver.rs`

### Commit 3

新增 `executor.rs`、`process_store.rs`、基础 `events.rs`

### Commit 4

新增 `commands/cli_runtime.rs`，接 bridge，但先不接 installer

### Commit 5

接 renderer Settings 面：External Tools / Environments

### Commit 6

接 Chat / runtime event timeline

### Commit 7

新增 installers：先实现 npm/pnpm + python/uv

### Commit 8

新增 `policy.rs` / `sandbox.rs` / escalation flow

### Commit 9

新增 `verify.rs`

### Commit 10

把视频导出链路逐步迁移到 `cli_runtime.execute`

### Commit 11

清理旧路径，重新定义 `skills:market-install` 语义

## 18. Files To Update In Existing Code

必须修改的现有文件：

- [desktop/src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts)
- [desktop/src/types.d.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/types.d.ts)
- [desktop/src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)
- [desktop/src/pages/Settings.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Settings.tsx)
- [desktop/src/pages/Chat.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Chat.tsx)
- [desktop/src/components/ProcessTimeline.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/components/ProcessTimeline.tsx)
- [desktop/src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs)
- [desktop/src-tauri/src/runtime/*](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/README.md)
- [desktop/src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs)
- [desktop/src-tauri/src/tools/app_cli.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/app_cli.rs)

建议降级的旧能力：

- [desktop/src-tauri/src/tools/bash.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/bash.rs)

## 19. Explicit Non-Goals For V1

V1 不做：

- 穷举所有第三方 CLI 的领域 wrapper
- Windows 完整 OS-level sandbox
- 全量命令树递归解析
- 跨机器分布式 remote worker
- GUI 自动操作与 CLI runtime 混成一个协议

## 20. Final Recommendation

RedConvert 应把“外部 CLI 能力”正式提升为一等宿主运行时，而不是继续把它塞在 `bash`、`skill` 或系统终端旁路里。

交付完成标准不是“AI 能多跑几个命令”，而是以下五件事同时成立：

1. 工具可发现
2. 依赖可自举
3. 执行可观测
4. 权限可扩张也可审计
5. 结果可验证并绑定到任务

只有做到这五点，RedConvert 才真正拥有“打通 app 与外部 CLI 工具”的产品级底座。
