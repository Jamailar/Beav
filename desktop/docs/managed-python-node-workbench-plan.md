---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-19
owner: ai-runtime
scope: desktop
target_files:
  - desktop/src-tauri/src/workspace_runtime/*
  - desktop/src-tauri/src/commands/workspace_runtime.rs
  - desktop/src-tauri/src/tools/app_cli.rs
  - desktop/src-tauri/src/tools/catalog.rs
  - desktop/src-tauri/src/tools/guards.rs
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/persistence/*
  - desktop/src-tauri/src/media/*
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/runtime/runtimeEventStream.ts
  - desktop/src/components/ProcessTimeline.tsx
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/pages/Wander.tsx
  - desktop/src/pages/GenerationStudio.tsx
  - desktop/src/pages/redclaw/*
success_metrics:
  - workspace_runtime_bootstrap_success_rate
  - first_script_execution_success_rate
  - workspace_feature_smoke_check_success_rate
  - app_sdk_capability_call_success_rate
  - reusable_feature_enabled_rate
  - dependency_install_reuse_rate
  - user_workspace_pollution_incidents_zero
  - script_run_manifest_coverage_rate
  - artifact_preview_linkage_rate
  - long_running_script_cancel_success_rate
  - media_script_pipeline_success_rate
---

# Workspace Runtime + App SDK Plan

## 1. Goal

把 RedConvert 的工作区升级成一个半开放的受管运行环境。这个环境不仅让 agent 能临时写 Python / Node 脚本，也让 agent 能把用户的长期页面需求、功能需求、自动化需求沉淀成 workspace-scoped 的小应用、工具、页面和可复用能力。

目标不是把用户选择的目录直接初始化成 Python + Node 项目，也不是只提供一个临时脚本沙箱。目标是在宿主侧为每个 workspace 准备一套可复用、可审计、可回滚的 runtime，并提供类似 SDK 的 RedConvert app capability bridge。agent 可以在这个环境里写代码、调用 app 现有能力、创建长期可用的 workspace features，并通过受控方式把它们接入 RedConvert 的页面、任务、媒体、稿件、知识库和产物系统。

最终产品体验：

- 普通用户只看到“处理中”“已生成产物”“可预览/可保存/可重试”。
- 用户可以让 agent 持续完善一个 workspace 专属功能，例如数据看板、批处理工具、素材整理页、稿件质检页、视频工作流助手或自定义导出器。
- agent 可以稳定使用用户电脑里的 Python / Node / pip / npm、Node 生态里的 sharp / Remotion，以及 RedConvert app 内置的 ffmpeg / ffprobe 媒体能力，也可以通过 SDK 调用 RedConvert 已有 app 能力。
- RedConvert 能完整记录每次脚本、长期功能、依赖、输入、输出、日志、权限和产物 lineage。
- 用户 workspace 根目录不被 `package.json`、`requirements.txt`、`.venv`、`node_modules` 或临时脚本污染。

核心定位：

- Python / Node 是基础执行层，不是产品目标本身。
- App SDK 是能力融合层，让自定义功能可以安全调用 RedConvert 现有能力。
- Workspace Feature 是长期沉淀层，让 agent 写出的代码可以从一次性脚本升级为用户可反复使用的功能。

## 2. Baseline

当前仓库已经有四类相关能力：

1. CLI Runtime Control Plane

- 已定义外部 CLI 的发现、安装、执行、扩权、验证和 runtime event 方向。
- 适合管理 `remotion`、`pip`、`npm`、`node` 等真实外部命令；`ffmpeg`/`ffprobe` 属于 app 内置媒体能力。

2. Runtime Script Execution V1

- 已有内置 `redbox_script_v1`，适合把多步宿主工具调用压缩成受限脚本。
- 这个执行器不依赖外部 Python / Node，安全性高，但不适合做数据科学、图片处理、复杂文本解析、Remotion 编排、第三方 SDK 调用等开放式脚本任务。

3. AI Tool Plane

- 顶层工具面要求收敛，新增能力应优先挂在 `app_cli(action + payload)` 或已有 `bash` / `redbox_fs` / `redbox_editor` 下。
- 不应该新增大量业务命名顶层 tool。

4. Plugin System V2

- 已有插件能力包方向，强调 capability registry、权限、sandboxed UI slot、plugin bridge 和 host-owned artifact import。
- 这条线适合 marketplace / 外部插件 / 安装包级扩展。
- Workspace Runtime 不应复制完整插件市场，而应提供更轻的 workspace-local feature 模型；后续可以把成熟 workspace feature 提升为插件。

### 2.1 Codex 0.131 Direction Applied

本计划应吸收 Codex 0.131 已经验证的几个底层方向，但不照搬它的 CLI 产品形态：

- SDK 要 protocol-first：RedConvert SDK 的 Python / Node 包都从同一份 JSON schema / typed protocol 生成类型，公共 API 固定，内部 IPC / Tauri command 可以继续演进。
- SDK 要有 run handle：脚本、feature action、媒体 job 和 SDK 长任务都返回 `RunHandle` / `ActionHandle`，事件流按 `runId` 路由，允许同一 workspace 内多个 run 并发。
- 审批模式要显式：使用 `ApprovalMode` 这类结构化枚举表达 `deny_all`、`on_request`、`auto_review`，不要在 SDK 参数里散落多个布尔值。
- 诊断要产品化：提供 `workspace-runtime:doctor` 和 Settings 里的同源诊断报告，覆盖编程环境、项目 runtime、SDK schema、feature registry、app 内置媒体工具、网络和权限。
- 状态面要数据驱动：Chat / Wander / RedClaw 的过程卡和状态栏只显示 workspace root、runtime ready 状态、审批模式、有效 capability、当前 run 进度，不用解释性 UI 堆满页面。
- app-server 思路要转成 host bridge：内部热路径使用 typed request / event，不在 Rust host、renderer、SDK 之间反复拼自由文本 JSON；JSON 只作为 SDK 外部边界和持久化格式。
- feature 分享要走 registry：workspace feature 先是本地能力，成熟后可以导出为 share package，再进入插件市场或团队共享；不要把所有 feature 默认升级成全局插件。
- 后台生命周期要机器可读：未来若加入 feature daemon / remote runner，启动、停止、启用远程控制、状态查询都必须输出结构化 JSON，并按 runtime root 串行化。

本计划应该补齐的是：一个 workspace-scoped 的真实 Python + Node runtime、workspace feature model 和 RedConvert App SDK bridge，并把它纳入现有 CLI runtime、tool router、runtime events、session transcript、artifact registry、plugin/capability 思路。

## 3. Architecture Decision

本计划采用唯一目标架构：**Shared Runtime Kernel + Workspace Namespace + App SDK + Workspace Feature Registry**。

这不是一个方案矩阵，而是后续实现的收敛方向。

### 3.1 Selected Architecture

核心形态：

- 所有 workspace 共用一套项目级 Python / Node runtime 内核。
- runtime 默认放在 RedConvert 控制的项目工作目录：`<project-working-dir>/.redbox-runtime/`。
- Python `.venv`、Node `node_modules`、SDK、模板、公共脚本和公共 feature library 都属于共享层。
- 每个 workspace 在共享 runtime 内有独立 namespace。
- workspace namespace 保存自己的 manifest、feature、data、runs、artifacts、cache 和 capability grants。
- Workspace feature 是长期能力单位，可以是自定义页面、批处理工具、数据看板、素材面板、稿件质检器、视频 workflow 或导出器。
- Workspace feature 调用 RedConvert 现有能力时必须走 App SDK，不直接访问内部 Tauri command、SQLite、AppStore 或私有文件。
- Agent 是否写脚本、创建 feature、调用 SDK，由 prompt、tool description、template activationHint 和模型判断决定；host 不做自然语言任务硬路由。

这个架构把“运行环境复用”和“workspace 边界隔离”分开处理：依赖和公共代码复用，数据和权限按 workspace 隔离。

### 3.2 Required Properties

必须满足：

- 不污染用户业务 workspace 根目录。
- 不为每个 workspace 默认复制一套 `.venv` / `node_modules`。
- 所有 SDK call、feature action、run、artifact 都必须带 `workspaceId`。
- 一个 workspace namespace 不能直接读另一个 workspace namespace。
- 共享依赖层不能保存 workspace 私有数据、日志、artifact 或 capability grants。
- Feature UI 必须是 sandboxed slot，不能注入完整 app shell。
- Feature capability 必须声明、校验、授权。
- 成熟 workspace feature 可以升级为插件，但 workspace feature 默认不是全局插件。

### 3.3 Why This Is The Best Direction

这个方向同时解决四个问题：

1. 磁盘空间

共享 Python / Node runtime 避免每个 workspace 复制依赖。

2. 功能复用

模板、SDK、公共脚本和成熟 feature library 可以跨 workspace 复用。

3. 长期能力沉淀

用户需求可以从一次性脚本升级为 workspace feature，而不是每次重新让 agent 写代码。

4. App 能力融合

App SDK 让自定义代码能调用 RedConvert 现有能力，同时仍然保留权限、审批、artifact、日志和 runtime event 证据链。

### 3.4 Explicit Non-Goals

以下不是本计划的默认方向：

- 不把用户业务 workspace 根目录初始化成 Python / Node 项目。
- 不默认给每个 workspace 创建独立 `.venv` / `node_modules`。
- 不做没有 workspace namespace 的裸全局 runtime。
- 不让 workspace feature 直接调用内部 store / database / private command。
- 不把 workspace feature 自动变成所有 workspace 的全局插件。
- 不把这个系统做成完整 IDE 或无限制插件平台。

## 4. Product Shape

### 4.1 User-Facing Mental Model

普通用户不需要知道 Python、Node、虚拟环境或包管理器。产品只暴露：

- 当前任务状态。
- 简短执行摘要。
- 可预览产物。
- 可重试、取消、保存、打开所在位置。
- 高级情况下可展开日志。

不要做一个完整 IDE。不要在 Chat 或 RedClaw 里塞大段解释性文案。

### 4.2 Advanced User Surface

高级入口放在 Settings 或诊断页：

- Workspace Runtime 状态。
- Python runtime 是否 ready。
- Node runtime 是否 ready。
- 已安装依赖。
- 最近执行。
- 清理缓存。
- 修复 runtime。
- 打开 runtime 目录。

默认不在主工作流里展示这些细节。

### 4.3 Agent-Facing Mental Model

agent 看到的是结构化能力：

- `workspace_runtime.inspect`
- `workspace_runtime.bootstrap`
- `script.create`
- `script.run`
- `dependency.install`
- `artifact.publish`
- `artifact.preview`
- `feature.create`
- `feature.update`
- `feature.run`
- `feature.list`
- `feature.expose_view`
- `app_sdk.capabilities`
- `app_sdk.invoke`
- `runtime.cleanup`

这些 action 通过现有 `app_cli` 或 CLI runtime control plane 暴露，不增加新的顶层工具族。

### 4.4 Workspace Feature Mental Model

Workspace feature 是 agent 写出来并保存在当前 workspace runtime 内的长期能力。它可以是：

- 一个批处理工具。
- 一个数据看板页面。
- 一个素材管理视图。
- 一个稿件质检或导出器。
- 一个视频处理工作流。
- 一个连接 RedConvert app capability 的轻量内部工具。

Feature 不是 marketplace plugin。它默认只属于当前 workspace，不对所有 workspace 自动启用，也不需要用户理解插件打包格式。

## 5. Directory Model

### 5.1 Preferred Storage

默认 runtime 真源放在项目工作目录下的一套共享环境中。这里的“项目工作目录”指 RedConvert 管理的本地运行空间，不是用户导入内容的业务 workspace 根目录。

```text
<redconvert-runtime-root>/
  runtime.json
  python/
    requirements.txt
    requirements.lock.txt
    .venv/
    packages/
  node/
    package.json
    package-lock.json
    node_modules/
    packages/
  sdk/
    node/
    python/
    schemas/
  templates/
    python/
    node/
    feature/
  shared/
    scripts/
    libraries/
    features/
  workspaces/
    <workspace-id>/
      workspace.json
      features/
        <feature-id>/
          feature.json
          src/
          public/
          data/
          runs/
      runs/
        <run-id>/
          manifest.json
          stdout.log
          stderr.log
          inputs.json
          outputs.json
          tool-events.jsonl
      artifacts/
        images/
        videos/
        data/
        documents/
        previews/
      cache/
        frames/
        thumbnails/
        parsed/
```

The shared root is like a local network segment: every workspace gets a stable address inside it, but traffic and data must still be scoped by workspace id and capability policy.

Recommended default location:

```text
<project-working-dir>/.redbox-runtime/
```

Fallback location when the project working directory is unavailable or read-only:

```text
~/Library/Application Support/RedBox/runtime/
```

This path is controlled by RedConvert, not by arbitrary user content folders.

### 5.2 Workspace Namespace

Every workspace has a namespace under the shared runtime:

```text
workspaces/<workspace-id>/
```

Workspace namespace owns:

- feature manifests.
- feature data.
- runs.
- artifacts.
- local cache.
- capability grants.
- workspace SDK context.

Shared root owns:

- Python project environment files created from the user's machine Python.
- Node project environment files created from the user's machine Node/npm.
- package caches.
- SDK packages.
- templates.
- shared feature libraries.

### 5.3 Workspace-Local Pointer

默认不在用户 workspace 写任何东西。可选写入一个极小指针文件：

```text
.redbox/workspace-runtime.json
```

但第一版建议不写，避免用户误解。

### 5.4 Workspace Id

`workspace-id` 不直接使用路径明文。推荐：

- canonical workspace root。
- app user id 或 local installation id。
- hash 后生成稳定 id。

这样可以避免路径泄露到日志索引，也能处理同名目录。

## 6. Runtime Manifest

`runtime.json` 是宿主判断状态的主文件。

```json
{
  "version": 1,
  "workspaceId": "ws_...",
  "workspaceRoot": "/Users/example/Project",
  "createdAt": "2026-05-16T00:00:00Z",
  "updatedAt": "2026-05-16T00:00:00Z",
  "python": {
    "enabled": true,
    "manager": "venv_pip",
    "pythonVersion": "3.12",
    "venvPath": "python/.venv",
    "requirementsPath": "python/requirements.txt",
    "lockPath": "python/requirements.lock.txt",
    "status": "ready"
  },
  "node": {
    "enabled": true,
    "manager": "npm",
    "nodeRange": ">=22 <23",
    "packagePath": "node/package.json",
    "lockPath": "node/package-lock.json",
    "status": "ready"
  },
  "appTools": {},
  "policy": {
    "network": "ask",
    "writeWorkspace": "ask",
    "maxRunMs": 600000,
    "maxOutputBytes": 10485760,
    "allowDependencyInstall": true
  }
}
```

宿主只把 manifest 当作 cache。真实状态要能通过 `inspect` 重新探测，不依赖文件永远正确。

## 7. Shared Runtime Boundary Model

共享 runtime 的核心原则是：代码和依赖可以复用，数据和权限必须隔离。

### 7.1 Shared Layer

Shared layer can be reused across all workspaces:

- Python `.venv` and package cache.
- Node `node_modules` / npm cache.
- RedConvert SDK packages.
- templates.
- shared utility scripts.
- shared feature libraries.
- common media helpers.

The shared layer should not contain user workspace data, private artifacts, feature state or capability grants.

### 7.2 Workspace Layer

Workspace layer is isolated by `workspace-id`:

- workspace manifest.
- feature manifests and feature-owned data.
- run manifests.
- stdout / stderr logs.
- artifacts.
- cache derived from workspace files.
- capability grants.
- SDK context.

Every SDK call, artifact path, feature action and run must carry `workspaceId`.

### 7.3 Feature Addressing

The shared runtime should treat each workspace like a local network address:

```text
runtime://workspace/<workspace-id>/feature/<feature-id>
runtime://workspace/<workspace-id>/run/<run-id>
runtime://workspace/<workspace-id>/artifact/<artifact-id>
```

Feature ids may be reused in different workspaces because the full identity includes workspace id.

### 7.4 Dependency Boundary

Dependencies are shared, but dependency requests are still recorded per workspace and per feature:

```json
{
  "workspaceId": "ws_...",
  "featureId": "feature_asset_review_board",
  "ecosystem": "node",
  "packages": ["sharp"],
  "reason": "Generate thumbnails for asset review."
}
```

This allows:

- shared installation.
- per-workspace audit.
- cleanup by reachability.
- future dependency pinning when a feature needs stricter reproducibility.

### 7.5 Reproducibility Strategy

Shared runtime trades strict per-workspace isolation for disk efficiency and feature reuse. To keep runs reproducible:

- run manifest records Python, Node, SDK and dependency versions.
- feature manifest records required dependency ranges.
- host can snapshot a feature's effective dependency set.
- high-risk or compatibility-sensitive features may request an isolated environment later.

V1 should optimize for shared runtime and auditability, not perfect hermetic builds.

### 7.6 User Machine Programming Environment

Python and Node are user-machine programming environments. They are not bundled app media tools.

RedConvert should use the user's computer environment as the source of truth:

1. Detect system Python and pip.
2. Detect system Node and npm.
3. If present and compatible, create shared project-level `.venv` and `node_modules` under `<redconvert-runtime-root>/`.
4. If missing, agent uses CLI runtime to install Python / Node on the user's computer with user approval.
5. After installation, RedConvert re-runs detection and bootstrap.
6. If installation fails, code-backed features stay unavailable, while non-code app capabilities continue working.

Programming environment ownership:

```text
User machine:
  python / python3
  pip
  node
  npm

RedConvert project runtime:
  python/.venv/
  python/requirements.txt
  node/node_modules/
  node/package.json
  node/package-lock.json
```

Rules:

- Do not bundle or manage Python / Node as app-internal runtimes by default.
- Do not use `pnpm`; use `npm` because it ships with Node and is more universal.
- Do not silently install Python / Node. Installation is a visible CLI runtime action with user approval.
- Do not permanently mutate shell profiles unless the installer itself does so as part of a standard system install.
- After install, always verify with `python --version`, `pip --version`, `node --version`, and `npm --version`.
- Failed programming environment setup should not break Chat, Read/List/Search/Write, existing product actions or `redbox_script_v1`.

Recommended install strategy:

- macOS: prefer official installers or Homebrew only when Homebrew is already present and user approves.
- Windows: prefer official Python.org / Node.js installers or winget when available and user approves.
- Linux: prefer distro package manager or official NodeSource/Python packages based on distro detection and user approval.

The agent can execute these install flows through CLI runtime, but the installed environment belongs to the user's computer. RedConvert's shared runtime only stores project-level dependencies and feature code.

### 7.7 Built-In App Media Tools

`ffmpeg` and `ffprobe` are not part of the programming environment problem.

They are built-in RedConvert media capabilities:

- shipped inside the app installer when licensing and packaging allow.
- resolved by RedConvert through app-controlled paths.
- exposed to media runtime and verification helpers as product capabilities.
- not installed through user shell package managers in the default flow.

If bundled media tools are unavailable or damaged, RedConvert should repair the app media tool bundle, not ask the user to install a programming environment.

## 8. Script Run Manifest

每次执行必须产生 `runs/<run-id>/manifest.json`。

```json
{
  "version": 1,
  "runId": "run_...",
  "sessionId": "chat_...",
  "taskId": "task_...",
  "workspaceId": "ws_...",
  "createdAt": "2026-05-16T00:00:00Z",
  "startedAt": "2026-05-16T00:00:01Z",
  "finishedAt": "2026-05-16T00:00:07Z",
  "language": "python",
  "entrypoint": "scripts/generated/extract_frames.py",
  "cwd": "workspace",
  "arguments": ["--input", "media/a.mp4"],
  "inputFiles": [
    {
      "path": "/Users/example/Project/media/a.mp4",
      "kind": "video",
      "sha256": "..."
    }
  ],
  "outputFiles": [
    {
      "path": "artifacts/images/frame_0001.jpg",
      "kind": "image",
      "sha256": "...",
      "preview": true
    }
  ],
  "dependencies": [
    {
      "ecosystem": "python",
      "name": "opencv-python-headless",
      "version": "..."
    }
  ],
  "policy": {
    "network": "denied",
    "writeWorkspace": "denied"
  },
  "exitCode": 0,
  "status": "completed",
  "summary": "Extracted 12 frames."
}
```

这个 manifest 是后续复盘、重试、产物预览、agent 自我检查和用户支持的证据链。

## 9. Workspace Feature Model

Workspace feature is the persistent unit that turns agent-written code into a reusable workspace capability.

### 9.1 Feature Manifest

```json
{
  "version": 1,
  "id": "feature_asset_review_board",
  "title": "Asset Review Board",
  "description": "Review imported assets, generate thumbnails, and mark approval state.",
  "createdBy": "agent",
  "createdAt": "2026-05-16T00:00:00Z",
  "updatedAt": "2026-05-16T00:00:00Z",
  "entrypoints": {
    "view": {
      "type": "webview",
      "path": "src/view.tsx",
      "slot": "workspace.tools"
    },
    "actions": [
      {
        "id": "refresh_assets",
        "title": "Refresh Assets",
        "runtime": "node",
        "entrypoint": "src/refresh-assets.ts"
      }
    ]
  },
  "capabilities": [
    "workspace.files.read",
    "assets.read",
    "assets.write.metadata",
    "artifacts.write"
  ],
  "dependencies": {
    "node": ["zod", "sharp"],
    "python": []
  },
  "data": {
    "storage": "feature-data",
    "schema": "data/schema.json"
  },
  "visibility": {
    "defaultPinned": false,
    "userVisible": true
  }
}
```

### 9.2 Feature Types

V1 should support a small set:

- `action`: reusable script or workflow triggered by agent or user.
- `view`: lightweight workspace page rendered in a sandboxed webview slot.
- `job`: long-running feature task with progress and artifacts.
- `data`: feature-owned persistent data under feature data dir.

Do not support unrestricted app mutation. Feature interaction with RedConvert must go through App SDK capabilities.

### 9.3 Feature Lifecycle

Lifecycle:

```text
agent proposes feature
  -> host creates feature folder
  -> agent writes code and manifest
  -> host validates manifest
  -> host installs dependencies under workspace runtime
  -> host runs smoke check
  -> feature is registered as disabled or draft
  -> user enables or pins feature
  -> feature actions/views become available
```

Feature updates:

- keep version history or snapshots.
- record which files changed.
- run smoke checks after update.
- do not auto-enable new capabilities without approval.

### 9.4 Relationship To Plugins

Workspace features are local, lightweight and user/workspace-specific.

Plugins are distributable, installable and marketplace-ready.

Promotion path:

```text
one-off script
  -> saved workspace feature
  -> reusable local feature
  -> exported share package
  -> packaged plugin candidate
```

This avoids forcing every user-specific need into the full plugin system while keeping the architecture compatible with plugin v2 capability concepts.

### 9.5 Feature Share Package

Feature sharing should follow the Codex marketplace direction but stay workspace-first in V1.

Share package structure:

```text
feature-share/
  feature.json
  sdk.schema.json
  package-lock.json or requirements.lock.txt when relevant
  src/
  view/
  templates/
  README.md
  screenshots/
  checksums.json
```

Rules:

- Stable id should be `<feature-name>@<source>`, where source is `workspace`, `team`, `local-marketplace` or future marketplace name.
- Exporting a feature does not automatically install it globally.
- Importing a feature creates a draft in the target workspace and re-runs manifest validation, SDK compatibility checks and smoke checks.
- Shared packages cannot carry workspace-private artifacts, run logs, credentials or capability grants.
- Version metadata should include SDK version, required capabilities, dependency summary and origin workspace id hash.

## 10. App SDK Bridge

The App SDK is the stable bridge between workspace code and RedConvert host capabilities.

### 10.1 SDK Principle

Workspace code must not import internal Tauri modules, mutate SQLite directly, or rely on private store paths. It should use a versioned SDK surface that maps to existing RedConvert commands and tool actions.

The SDK is not a new agent. It is a typed host API for code written by the agent or user.

### 10.2 Protocol And Generated Types

The SDK should follow the Codex-style generated-contract direction:

- A single `redbox-sdk-protocol` schema defines requests, responses, notifications, errors, approval modes and run handles.
- TypeScript and Python SDK packages are generated from the same schema.
- Rust host modules use typed structs on the hot path; JSON serialization is reserved for SDK process boundaries, persisted manifests and diagnostics export.
- SDK method names stay stable even when internal Tauri commands, stores or IPC channels move.
- Schema compatibility is checked at feature enable time and at run start.

Core protocol records:

```ts
export type ApprovalMode = "deny_all" | "on_request" | "auto_review";

export interface SdkContext {
  workspaceId: string;
  featureId?: string;
  runId?: string;
  sdkVersion: string;
  approvalMode: ApprovalMode;
  capabilities: string[];
}

export interface RunHandle {
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stream(): AsyncIterable<RuntimeEvent>;
  cancel(reason?: string): Promise<void>;
  result(): Promise<RunResult>;
}
```

This keeps agent-written code predictable: long-running work is identified by handle, approval is explicit, and stream consumers only receive events for their own `runId`.

### 10.3 SDK Surfaces

Initial SDK namespaces:

```text
redbox.workspace.files
redbox.artifacts
redbox.assets
redbox.manuscripts
redbox.media
redbox.knowledge
redbox.tasks
redbox.notifications
redbox.approvals
redbox.runtime
redbox.featureData
redbox.ui
redbox.settings.read
```

Example TypeScript shape:

```ts
export interface RedboxSdk {
  getContext(): Promise<SdkContext>;
  workspace: {
    files: {
      list(query: FileListQuery): Promise<FileListResult>;
      read(path: string): Promise<FileReadResult>;
    };
  };
  artifacts: {
    write(input: ArtifactWriteInput): Promise<ArtifactRecord>;
    publish(input: ArtifactPublishInput): Promise<ArtifactPublishResult>;
  };
  assets: {
    search(query: AssetSearchQuery): Promise<AssetSearchResult>;
    updateMetadata(input: AssetMetadataPatch): Promise<AssetRecord>;
  };
  manuscripts: {
    list(query: ManuscriptListQuery): Promise<ManuscriptListResult>;
    read(ref: string): Promise<ManuscriptReadResult>;
    writeCurrent(input: ManuscriptWriteInput): Promise<ManuscriptWriteResult>;
  };
  media: {
    probe(input: MediaProbeInput): Promise<MediaProbeResult>;
    submitJob(input: MediaJobInput): Promise<MediaJobRecord>;
  };
  featureData: {
    read(input: FeatureDataReadInput): Promise<FeatureDataReadResult>;
    write(input: FeatureDataWriteInput): Promise<FeatureDataWriteResult>;
  };
  ui: {
    registerView(input: FeatureViewRegistration): Promise<FeatureViewRecord>;
    updateBadge(input: FeatureBadgeUpdate): Promise<void>;
  };
  approvals: {
    request(input: ApprovalRequest): Promise<ApprovalResult>;
  };
  runtime: {
    runScript(input: ScriptRunInput): Promise<RunHandle>;
    getRun(runId: string): Promise<RunResult>;
  };
}
```

### 10.4 SDK Capability Inventory

The SDK must expose a typed capability inventory. Each capability should have:

- stable capability id.
- namespace and methods.
- read/write/mutating classification.
- required scope.
- approval behavior.
- output contract.
- underlying host module or command family.

#### Workspace Files

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `workspace.files.read` | `workspace.files.list`, `workspace.files.read`, `workspace.files.stat` | read | current workspace | no by default | `redbox_fs`, `Read`, `List` |
| `workspace.files.write` | `workspace.files.write`, `workspace.files.mkdir`, `workspace.files.copyFromArtifact` | write | current workspace | ask for overwrite/outside suggested folder | artifact publish / file write guard |
| `workspace.files.delete` | `workspace.files.delete` | destructive | current workspace | always ask | file write guard |

Rules:

- Reads must use virtual or host-issued paths when possible.
- Writes should prefer artifact publish flow.
- Delete is not V1 default; reserve capability id but keep disabled unless explicitly granted.

#### Artifacts

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `artifacts.read` | `artifacts.get`, `artifacts.list` | read | workspace / current run | no | artifact registry |
| `artifacts.write` | `artifacts.write`, `artifacts.attachPreview` | write | current feature/run | no for managed artifact dir | runtime artifacts |
| `artifacts.publish` | `artifacts.publishToWorkspace` | write | current workspace | ask based on destination/overwrite | publish artifact |

Rules:

- Generated files should land as artifacts first.
- Publish is a separate host-mediated step.

#### Assets

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `assets.read` | `assets.search`, `assets.get`, `assets.listCollections` | read | current workspace/user library | no | asset library / visual index |
| `assets.write.metadata` | `assets.updateMetadata`, `assets.tag`, `assets.rate` | metadata write | selected assets | no or ask by policy | asset metadata store |
| `assets.import` | `assets.importArtifact`, `assets.importFile` | write | current workspace library | ask for large import / external path | media/artifact import |
| `assets.delete` | `assets.delete` | destructive | selected assets | always ask | asset store |

Rules:

- V1 should include read + metadata write + import.
- Delete should be reserved, not default.

#### Manuscripts

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `manuscripts.read` | `manuscripts.list`, `manuscripts.read`, `manuscripts.getCurrent` | read | current workspace / current manuscript | no | manuscripts IPC |
| `manuscripts.write.current` | `manuscripts.writeCurrent`, `manuscripts.patchCurrent` | write | currently bound manuscript | ask by editor policy | editor/manuscript write |
| `manuscripts.create` | `manuscripts.create` | write | current workspace | no or ask by policy | manuscript creation |
| `manuscripts.export` | `manuscripts.export` | write artifact | current workspace | ask for filesystem destination | export/artifact publish |

Rules:

- Current manuscript writes should stay scoped to the bound manuscript.
- Feature code should not freely mutate arbitrary manuscripts.

#### Media

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `media.read` | `media.probe`, `media.getMetadata`, `media.listQueue` | read | current workspace/media queue | no | built-in ffprobe/media store |
| `media.jobs.submit` | `media.submitJob`, `media.enqueueGeneration`, `media.enqueueEdit` | mutating job | current workspace | ask by cost/provider policy | media generation/runtime |
| `media.artifacts.import` | `media.importArtifact` | write | current workspace/media queue | ask for external path | media artifact import |
| `media.verify` | `media.verifyVideo`, `media.verifyAudio`, `media.verifyImage` | read/verify | artifact/run | no | built-in ffmpeg/ffprobe/sharp helpers |

Rules:

- `ffmpeg`/`ffprobe` are app-bundled media capabilities, not user environment dependencies.
- Paid or external provider media jobs must go through existing cost/approval policy.

#### Knowledge

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `knowledge.read` | `knowledge.search`, `knowledge.get`, `knowledge.listSources` | read | current workspace/user knowledge | no | knowledge IPC/index |
| `knowledge.ingest` | `knowledge.ingestArtifact`, `knowledge.ingestFile` | write/index | current workspace | ask for large/external sources | knowledge ingestion |
| `knowledge.annotations.write` | `knowledge.annotate`, `knowledge.tag` | metadata write | selected docs | no or ask by policy | knowledge metadata |

Rules:

- Feature code should not bypass knowledge permissions by reading raw index files.

#### Tasks And RedClaw

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `tasks.read` | `tasks.list`, `tasks.get`, `tasks.getCurrent` | read | current workspace/session | no | RedClaw/task store |
| `tasks.write` | `tasks.create`, `tasks.update`, `tasks.appendNote` | write | current workspace/session | no or ask by policy | task control IPC |
| `tasks.run` | `tasks.enqueueRuntime`, `tasks.attachArtifact` | mutating job | current workspace/session | ask for long-running/costly jobs | runtime/task queue |

Rules:

- Feature-created tasks must be clearly attributed to the feature id.

#### Runtime And Scripts

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `runtime.runs.read` | `runtime.listRuns`, `runtime.getRun` | read | current workspace/feature | no | run manifest store |
| `runtime.scripts.run` | `runtime.runScript`, `runtime.runTemplate` | execute | current workspace/feature | policy based | workspace runtime |
| `runtime.dependencies.install` | `runtime.installDependency` | mutating env | shared runtime + feature audit | ask unknown packages | pip/npm install |

Rules:

- Dependency installs are shared but audited per workspace/feature.
- Script execution must record run manifests.

#### Feature Data

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `featureData.read` | `featureData.read`, `featureData.query` | read | current feature | no | feature data dir |
| `featureData.write` | `featureData.write`, `featureData.patch` | write | current feature | no | feature data dir |
| `featureData.export` | `featureData.exportArtifact` | write artifact | current feature/workspace | ask for publish | artifact registry |

Rules:

- Feature data is not shared across workspaces unless exported/imported through host mediation.

#### UI Slots

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `ui.view.register` | `ui.registerView` | UI extension | declared slot | ask/enable feature | sandboxed view registry |
| `ui.badge.update` | `ui.updateBadge` | UI metadata | feature view | no | UI slot state |
| `ui.command.register` | `ui.registerCommand` | UI action | feature view | ask when mutating | command palette / feature actions |

V1 allowed slots:

- `workspace.tools`
- `asset.inspector`
- `redclaw.artifactInspector`
- `diagnostics.featureDev`

Rules:

- No arbitrary full-app navigation in V1.
- Feature views receive context and SDK bridge only, not raw app internals.

#### Notifications And Approvals

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `notifications.send` | `notifications.send`, `notifications.update` | user-visible side effect | current user/workspace | no or ask by policy | notification center |
| `approvals.request` | `approvals.request` | approval flow | current run/feature | no | approval runtime |

Rules:

- Notifications must identify the feature id.
- Approval requests must include action, risk, affected paths/resources and fallback.

#### Settings And Account

| Capability | Methods | Access | Scope | Approval | Host mapping |
| --- | --- | --- | --- | --- | --- |
| `settings.read` | `settings.getRuntimeConfig`, `settings.getFeatureConfig` | read | safe config subset | no | settings read model |
| `account.profile.read` | `account.getProfileSummary` | read | current user summary | no, sanitized | account/profile bridge |

Rules:

- V1 is read-only.
- No API keys, raw tokens or secrets through SDK.

### 10.5 Capability Mapping

SDK calls require explicit capabilities:

| SDK namespace | Capability |
| --- | --- |
| `workspace.files.list/read` | `workspace.files.read` |
| `artifacts.write` | `artifacts.write` |
| `artifacts.publish` | `workspace.files.write` |
| `assets.search` | `assets.read` |
| `assets.updateMetadata` | `assets.write.metadata` |
| `manuscripts.read` | `manuscripts.read` |
| `manuscripts.writeCurrent` | `manuscripts.write.current` |
| `media.probe` | `media.read` |
| `media.submitJob` | `media.jobs.submit` |
| `knowledge.search/read` | `knowledge.read` |
| `tasks.create/update` | `tasks.write` |
| `featureData.read/write` | `featureData.read` / `featureData.write` |
| `ui.registerView` | `ui.view.register` |
| `approvals.request` | `approvals.request` |

The host enforces capabilities and approval. The agent guidance can recommend which SDK call to use, but the SDK does not encode business heuristics.

### 10.6 SDK Runtime Access

Feature code gets SDK access through a host-injected bridge:

```ts
const redbox = await getRedboxSdk();
const assets = await redbox.assets.search({ query: "cover images", limit: 20 });
```

For Python:

```python
from redbox_sdk import RedboxSdk

redbox = RedboxSdk.from_env()
files = redbox.workspace.files.list({"root": "workspace://", "limit": 50})
```

Implementation direction:

- Node SDK calls a local IPC bridge controlled by the host.
- Python SDK calls the same bridge through a small local HTTP/stdio adapter.
- Both SDKs use the same JSON schema contracts.
- Both SDKs expose sync convenience methods and async/event-stream methods where the underlying host action can be long-running.
- SDK bridge queues are bounded. Backpressure returns structured overload errors instead of hanging approval or run events behind saturated queues.

### 10.7 SDK Versioning

SDK must be versioned:

```json
{
  "sdk": {
    "version": "1",
    "requires": ["assets.read", "artifacts.write"]
  }
}
```

Feature manifests should declare SDK version and capabilities. Host rejects unknown required capabilities and can warn on deprecated SDK calls.

## 11. Module Architecture

### 11.1 Rust Host Modules

新增模块建议：

```text
desktop/src-tauri/src/workspace_runtime/
  mod.rs
  ids.rs
  paths.rs
  manifest.rs
  manager.rs
  bootstrap.rs
  python.rs
  node.rs
  scripts.rs
  features.rs
  feature_registry.rs
  feature_share.rs
  sdk.rs
  sdk_protocol.rs
  sdk_schema.rs
  event_router.rs
  ui_slots.rs
  dependencies.rs
  runs.rs
  artifacts.rs
  policy.rs
  doctor.rs
  status.rs
  cleanup.rs
```

职责边界：

- `ids.rs`：workspace root 到 stable workspace id。
- `paths.rs`：app data runtime path、run path、artifact path 解析。
- `manifest.rs`：typed manifest schema 和读写。
- `manager.rs`：统一 `inspect/bootstrap/repair`。
- `bootstrap.rs`：创建目录、初始化 Python / Node。
- `python.rs`：系统 Python/pip 探测、venv 创建、pip 依赖安装、脚本执行。
- `node.rs`：系统 Node/npm 检测、package 初始化、npm 依赖安装、脚本执行。
- `scripts.rs`：脚本保存、校验、entrypoint 生成。
- `features.rs`：feature manifest、文件写入、更新和 smoke check。
- `feature_registry.rs`：当前 workspace enabled/draft feature 快照。
- `feature_share.rs`：workspace feature 导出、导入、版本元数据和插件候选包生成。
- `sdk.rs`：App SDK bridge 调用分发、权限校验、结果包装。
- `sdk_protocol.rs`：SDK typed request / response / notification / error / approval mode。
- `sdk_schema.rs`：SDK JSON schema、版本、兼容性检查。
- `event_router.rs`：按 `workspaceId`、`runId`、`featureId` 路由 runtime events，隔离并发 run。
- `ui_slots.rs`：workspace feature view slot 注册和 sandbox 参数。
- `dependencies.rs`：依赖请求去重、安装锁、版本记录。
- `runs.rs`：run manifest、stdout/stderr、状态变更。
- `artifacts.rs`：产物登记、预览索引、发布到 workspace。
- `policy.rs`：网络、写入、命令、超时、大小限制。
- `doctor.rs`：被动诊断编程环境、runtime、SDK、feature registry、内置媒体工具和权限状态。
- `status.rs`：给 renderer / process card / diagnostics 使用的 compact status snapshot。
- `cleanup.rs`：缓存清理、过期 run 清理、损坏 runtime 修复。

### 11.2 Commands

新增 IPC command：

```text
workspace-runtime:inspect
workspace-runtime:status
workspace-runtime:doctor
workspace-runtime:bootstrap
workspace-runtime:repair
workspace-runtime:install-dependency
workspace-runtime:create-script
workspace-runtime:run-script
workspace-runtime:cancel-run
workspace-runtime:list-runs
workspace-runtime:get-run
workspace-runtime:list-artifacts
workspace-runtime:publish-artifact
workspace-runtime:create-feature
workspace-runtime:update-feature
workspace-runtime:list-features
workspace-runtime:get-feature
workspace-runtime:enable-feature
workspace-runtime:disable-feature
workspace-runtime:run-feature-action
workspace-runtime:share-feature
workspace-runtime:import-feature
workspace-runtime:upgrade-feature
workspace-runtime:list-sdk-capabilities
workspace-runtime:invoke-sdk
workspace-runtime:list-ui-slots
workspace-runtime:cleanup
```

Renderer 不直接调用 Tauri 原语，必须先扩：

```text
desktop/src/bridge/ipcRenderer.ts
```

### 11.3 Tool Contract

不要新增顶层 `python` 或 `node` tool。通过现有 `app_cli` 增加 action：

```json
{
  "action": "workspace_runtime.run_script",
  "payload": {
    "language": "python",
    "script": {
      "kind": "inline",
      "name": "extract_keyframes.py",
      "content": "..."
    },
    "cwd": "workspace",
    "args": [],
    "inputs": [],
    "expectedOutputs": [],
    "policy": {
      "network": "deny",
      "writeWorkspace": "deny"
    }
  }
}
```

Action 分组：

- `workspace_runtime.inspect`
- `workspace_runtime.status`
- `workspace_runtime.doctor`
- `workspace_runtime.bootstrap`
- `workspace_runtime.install_dependency`
- `workspace_runtime.create_script`
- `workspace_runtime.run_script`
- `workspace_runtime.cancel_run`
- `workspace_runtime.publish_artifact`
- `workspace_runtime.create_feature`
- `workspace_runtime.update_feature`
- `workspace_runtime.run_feature_action`
- `workspace_runtime.share_feature`
- `workspace_runtime.import_feature`
- `workspace_runtime.list_features`
- `workspace_runtime.expose_feature_view`
- `workspace_runtime.list_sdk_capabilities`
- `workspace_runtime.invoke_sdk`
- `workspace_runtime.cleanup`

### 11.4 Runtime Events

事件进入现有 runtime event stream：

```text
runtime:workspace-runtime-bootstrap-started
runtime:workspace-runtime-bootstrap-completed
runtime:workspace-runtime-bootstrap-failed
runtime:workspace-runtime-status-updated
runtime:workspace-runtime-doctor-started
runtime:workspace-runtime-doctor-completed
runtime:workspace-runtime-doctor-failed
runtime:script-created
runtime:script-run-started
runtime:script-run-output
runtime:script-run-artifact
runtime:script-run-completed
runtime:script-run-failed
runtime:script-run-cancelled
runtime:dependency-install-started
runtime:dependency-install-completed
runtime:dependency-install-failed
runtime:artifact-published
runtime:feature-created
runtime:feature-updated
runtime:feature-enabled
runtime:feature-disabled
runtime:feature-action-started
runtime:feature-action-output
runtime:feature-action-completed
runtime:feature-action-failed
runtime:feature-shared
runtime:feature-imported
runtime:feature-upgraded
runtime:feature-view-registered
runtime:sdk-call-started
runtime:sdk-call-completed
runtime:sdk-call-failed
runtime:sdk-protocol-mismatch
runtime:event-router-lagged
```

UI 不需要展示全部事件，只消费摘要和状态。

### 11.5 Persistence

持久化分两层：

1. 文件层

- runtime manifest。
- run manifest。
- stdout/stderr。
- outputs。
- artifacts。
- feature manifests。
- feature data。
- feature view bundles。

2. AppStore / SQLite metadata

- 最近 runs 索引。
- 与 chat session / RedClaw task / media queue 的关联。
- 产物预览卡片 metadata。
- workspace feature registry。
- feature capability grants。
- feature UI slot visibility。

不要把大日志、大产物、视频帧写入 SQLite。

## 12. AI Runtime Integration

### 12.1 Prompt Boundary

系统提示词只告诉 agent：

- 有受管 Python + Node workspace runtime。
- 默认在 runtime 中创建临时脚本。
- 不要往用户 workspace 根目录写依赖文件。
- 需要保存长期脚本时使用 `publish`。
- 用户需要长期可复用功能时，可以创建 workspace feature。
- workspace feature 调用 RedConvert 能力时必须走 App SDK。
- 大文件只传路径和摘要，不要把二进制或大 JSON 塞进消息。

不要基于用户自然语言关键词强制激活 Python 或 Node。是否写脚本由模型结合任务、工具说明和上下文判断。

### 12.2 Tool Exposure

默认策略：

- 普通 Chat：只暴露 `inspect`、`run_script`、`publish_artifact`。
- RedClaw / Wander：暴露 `run_script`、`install_dependency`、`artifact.publish`、`feature.create/update/run`，但写 workspace 需要策略检查。
- GenerationStudio / Video Director：暴露 media-oriented templates 和 run action。
- Settings / Diagnostics：暴露 feature registry、SDK capability diagnostics、repair、cleanup、list_runs。
- 诊断模式：额外暴露 `repair`、`cleanup`、`list_runs`。

这应该进入 `ToolRegistryPlan`，而不是靠 prompt 关键词。

### 12.3 Agent Decision Flow

标准流程：

1. 判断是否需要脚本。
2. 调用 `workspace_runtime.inspect`。
3. 如 runtime 未 ready，调用 `bootstrap`。
4. 如果缺依赖，调用 `install_dependency`，并说明依赖用途。
5. 创建或 inline 提供脚本。
6. 执行脚本。
7. 读取 run summary 和 artifacts。
8. 必要时验证产物。
9. 将可见产物返回用户，或发布到 workspace。

长期功能流程：

1. 判断需求是否应该沉淀为 workspace feature。
2. 查询 App SDK capabilities。
3. 生成 feature manifest 和代码。
4. 通过 SDK bridge 调用 app 能力，不直接读写内部 store。
5. 运行 smoke check。
6. 以 draft/disabled 状态注册 feature。
7. 用户确认后启用或固定入口。

### 12.4 Verification Layer

不要把 exit code 0 等同于成功。每类脚本执行后需要至少一个验证动作：

- 图片：文件存在、可 decode、尺寸符合预期。
- 视频：`ffprobe` 可读、时长/编码/分辨率符合预期。
- 数据：JSON/CSV 可 parse，行数或 schema 符合预期。
- 文档：文件存在，必要时渲染预览。
- 批量重命名：目标文件数量、路径冲突、原文件保留策略。

验证结果写入 run manifest。

## 13. Python Runtime

### 13.1 Use Existing Libraries

必须用现成库：

- `venv` + `pip`：环境创建和依赖安装。
- `pydantic`：复杂输入输出 schema。
- `pillow`：图片读写、缩放、格式转换。
- `opencv-python-headless`：视频帧、基础视觉处理。
- `numpy`：数组计算。
- `pandas`：表格和 CSV 清洗。
- `requests` / `httpx`：HTTP 请求。
- `beautifulsoup4` / `lxml`：HTML 解析。
- `openpyxl`：Excel 读写。

不自研：

- Python interpreter implementation. RedConvert manages venv orchestration, but does not reimplement Python itself.
- pip resolver。RedConvert 只记录 `pip freeze` / effective dependency snapshot，不自研 resolver。
- 图片编解码。
- CSV / XLSX parser。

需要自研：

- runtime manifest。
- dependency install policy。
- run manifest。
- artifact registry。
- workspace write guard。
- stdout/stderr sanitizer。
- run verification。

### 13.2 Bootstrap

初始化流程：

1. 检测系统 `python3` / `python` 和 `pip`。
2. 如果缺失或版本不兼容，生成 CLI Runtime 安装任务，等待用户批准后由 agent 执行系统安装。
3. 安装完成后重新检测系统 Python / pip。
4. 使用系统 Python 创建共享 `.venv`。
5. 使用 `.venv` 内置 pip 安装或升级 baseline packaging tools。
6. 创建共享 `python/requirements.txt`。
7. 使用 pip 安装 baseline dependencies。
8. 写 manifest，记录 Python、pip 和依赖版本。
9. 运行 smoke test：

```python
import sys
import json
print(json.dumps({"python": sys.version_info[:3]}))
```

如果 provisioning 失败：

- 标记 Python runtime 为 `missing` 或 `repair_required`。
- 保留 Node runtime、SDK、内置 `redbox_script_v1` 和非代码工具可用。
- UI 提供 `Install/Repair Python` 操作，由 agent 通过 CLI runtime 执行安装步骤，不要求用户手动打开终端。

### 13.3 Dependency Install Policy

依赖安装必须有结构化请求：

```json
{
  "ecosystem": "python",
  "packages": [
    {
      "name": "pandas",
      "version": null,
      "reason": "Parse the CSV files attached to this session."
    }
  ],
  "scope": "workspace-runtime"
}
```

策略：

- baseline 白名单依赖可自动安装。
- 非白名单依赖需要按当前 runtime policy 判断是否确认。
- 依赖安装期间加 workspace runtime install lock，避免并发破坏 lock file。
- 安装成功后更新 manifest。

## 14. Node Runtime

### 14.1 Use Existing Libraries

必须用现成库：

- `npm`：Node 默认包管理器。
- `tsx`：直接运行 TypeScript 脚本。
- `zod`：输入输出校验。
- `sharp`：图片处理、缩略图、封面。
- `execa`：子进程执行。
- `fast-glob`：文件枚举。
- `playwright`：仅在网页截图、页面验证、自动化时按需安装。
- `remotion`：仅在视频合成、程序化视频时按需安装。

不自研：

- JS 包管理。
- 图片 resize/convert。
- 浏览器自动化。
- 程序化视频渲染引擎。

需要自研：

- Node runtime manifest。
- npm project dependency 和 workspace runtime 的接线。
- script runner。
- artifact verification。
- Remotion 与 media queue 的产品级桥接。

### 14.2 Bootstrap

初始化流程：

1. 检测系统 Node，要求 `>=22 <23`。
2. 检测系统 npm。
3. 如果 Node/npm 缺失或版本不兼容，生成 CLI Runtime 安装任务，等待用户批准后由 agent 执行系统安装。
4. 安装完成后重新检测系统 Node/npm。
5. 创建共享 `node/package.json`。
6. 使用 npm 安装 baseline dependencies，生成 `package-lock.json`。
7. 写 manifest，记录 Node、npm 和依赖版本。
8. 运行 smoke test：

```ts
console.log(JSON.stringify({ node: process.version }))
```

如果 provisioning 失败：

- 标记 Node runtime 为 `missing` 或 `repair_required`。
- Python runtime 和非 Node feature 仍可继续使用。
- 需要 Node 的 feature 保持 draft/disabled，并显示 `Install/Repair Node.js` 动作。

### 14.3 Baseline package.json

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "run": "tsx"
  },
  "dependencies": {
    "tsx": "^4.0.0",
    "zod": "^3.0.0",
    "execa": "^9.0.0",
    "fast-glob": "^3.0.0",
    "sharp": "^0.33.0"
  }
}
```

具体版本执行时按当前生态重新确认，不在计划文档中锁死。

## 15. Video And Media Processing

### 15.1 Libraries And Tools

必须用现成工具：

- `ffmpeg`：转码、裁剪、拼接、抽帧、音频处理、字幕烧录。
- `ffprobe`：媒体 metadata 和验证。
- `sharp`：图片缩放、压缩、封面、缩略图。
- `Remotion`：程序化视频、字幕动画、分镜合成、模板化视频。
- `opencv-python-headless`：帧级分析和轻量视觉处理。

不自研：

- 视频编解码。
- 音视频 mux/demux。
- 浏览器渲染式视频合成引擎。
- 图片编解码。

需要自研：

- 视频任务 schema。
- 素材引用与 workspace artifact lineage。
- 分镜到 Remotion composition 的中间模型。
- run manifest 与 media queue 绑定。
- 失败恢复和 partial artifact 处理。
- 用户确认节点。

### 15.2 Video Director Flow

宣传片 / 自动剪视频链路建议：

```text
User request
  -> Video Director skill
  -> script outline
  -> shot list
  -> asset plan
  -> optional storyboard images
  -> user confirmation
  -> workspace runtime generates Remotion project or ffmpeg plan
  -> render
  -> ffprobe verification
  -> media queue artifact
  -> preview in UI
```

Python + Node Workbench 在这里承担：

- 分析素材。
- 抽取关键帧。
- 生成字幕 / JSON timecodes。
- 生成 Remotion composition。
- 调用 Remotion render。
- 调用 ffmpeg finalize。
- 写入产物和验证报告。

### 15.3 Media Run Schema

```json
{
  "kind": "media_pipeline",
  "pipeline": "promo_video",
  "inputs": [
    {
      "type": "image",
      "path": "/workspace/assets/product.png"
    }
  ],
  "steps": [
    {
      "type": "analyze_assets",
      "runtime": "python"
    },
    {
      "type": "build_composition",
      "runtime": "node"
    },
    {
      "type": "render_video",
      "tool": "remotion"
    },
    {
      "type": "finalize",
      "tool": "ffmpeg"
    },
    {
      "type": "verify",
      "tool": "ffprobe"
    }
  ],
  "outputs": [
    {
      "type": "video",
      "path": "artifacts/videos/final.mp4"
    }
  ]
}
```

## 16. UI Implementation

### 16.1 Chat And Wander

Additions should be minimal:

- Tool execution card shows concise status.
- Script output collapsed by default.
- Artifact previews appear as existing attachment / media preview cards.
- Actions:
  - cancel
  - retry
  - open artifact
  - save to workspace
  - view logs

Avoid explanatory text like “Python environment is being prepared” unless the action is blocked or failed. Prefer status labels:

- Preparing runtime
- Running script
- Installing dependency
- Verifying output
- Completed
- Failed

### 16.2 RedClaw

RedClaw should treat script runs as task execution evidence:

- Link run id to task id.
- Show script run as a compact process item.
- Keep logs behind an inspector.
- Publish generated manuscripts, media plans, data files or videos into existing RedClaw artifact surfaces.

No separate RedClaw-specific Python UI.

### 16.3 GenerationStudio And Video Pages

Use runtime only where it improves the current workflow:

- Keyframe extraction.
- Batch image normalization.
- Caption / subtitle preprocessing.
- Remotion render.
- ffmpeg finalize.
- output verification.

Do not expose a general scripting panel inside GenerationStudio.

### 16.4 Workspace Feature Views

Workspace feature views should be exposed as narrow, sandboxed UI slots:

- workspace tools panel.
- RedClaw task artifact inspector.
- asset detail side panel.
- diagnostics-only developer view.

Feature views should not be able to mount arbitrary full-app navigation by default. They should receive context through `redbox.sdk.getContext()` and call host capabilities through the SDK bridge.

V1 should avoid adding visible top-level navigation for every feature. Users can pin trusted features later.

### 16.5 Settings And Diagnostics

Settings entry:

```text
Settings -> Runtime -> Workspace Workbench
```

Possible controls:

- Runtime status.
- Python status.
- Node status.
- ffmpeg status.
- App SDK capability status.
- Workspace feature registry.
- Feature enable/disable.
- Feature smoke check.
- Repair.
- Clear cache.
- Open logs.
- Recent runs.

This page is diagnostic, not a daily workflow page.

## 17. Security And Policy

### 17.1 Default Policy

Default permissions:

- Read current workspace: allow.
- Write runtime directory: allow.
- Write user workspace: ask.
- Network: ask.
- Install dependency: allow baseline, ask unknown.
- Execute arbitrary shell: restricted through CLI runtime policy.
- App SDK capability call: allow only declared/granted capabilities.
- Feature UI: sandboxed bridge only.
- Max runtime: bounded.
- Max output: bounded.

### 17.2 Workspace Write Guard

Scripts should write to runtime artifacts by default.

Publishing into user workspace requires:

- explicit target path.
- path normalization.
- conflict check.
- overwrite policy.
- run manifest link.

Never let a script write arbitrary paths in the user workspace without host mediation.

### 17.3 Feature Capability Guard

Feature code can only access app capabilities declared in its manifest and granted by the host.

The host should check:

- feature enabled state.
- requested capability id.
- scope, such as current workspace, current manuscript or selected asset.
- approval policy.
- output path ownership.

Feature code must not call internal Tauri commands directly.

### 17.4 Environment Variables

Default environment should be minimal:

- no automatic shell profile sourcing.
- no inherited API keys unless explicitly granted.
- RedConvert-provided temp paths and workspace paths only.

### 17.5 Network

Network policy:

- dependency installation may require network.
- script runtime network defaults to ask.
- if user task explicitly requires fetching a URL, agent must request network-capable policy.

### 17.6 Logs

Logs must be sanitized before model-visible summaries:

- trim large output.
- redact common token patterns.
- avoid embedding full file contents.
- keep raw logs on disk for local diagnostics.

## 18. Performance Strategy

### 18.1 Dependency Reuse

- Use pip wheel cache for Python packages under the project runtime.
- Use npm cache and project-level `node_modules` for Node packages.
- Keep workspace runtime stable across sessions.
- Install baseline dependencies once.

### 18.2 Concurrency

Locks:

- one bootstrap lock per workspace runtime.
- one dependency install lock per ecosystem.
- multiple script runs allowed only if they do not mutate dependency files.
- media render runs should use bounded concurrency.
- feature actions should have per-feature concurrency limits.

### 18.3 Large Files

- Pass file paths, not base64.
- Generate previews and metadata.
- Stream stdout/stderr to files.
- Keep UI event summaries small.
- Keep large artifacts out of SQLite.

### 18.4 Cold Start

Cold start target:

- `inspect`: under 300 ms when manifest exists.
- first bootstrap: may take minutes, must stream progress.
- warm script run: under 2 seconds overhead before user script starts.
- feature action warm start: under 2 seconds before feature code starts.
- feature view load: under 1 second for cached local bundles.

### 18.5 Cleanup

Cleanup policy:

- keep recent runs.
- keep user-published artifacts.
- clean old cache frames and thumbnails.
- allow per-workspace runtime reset.
- never delete user workspace files during cleanup.
- feature cleanup must preserve feature manifest unless user deletes the feature.

## 19. Failure Recovery

Failure cases and behavior:

| Failure | Detection | Recovery |
| --- | --- | --- |
| Broken venv | smoke test fails | Recreate Python runtime |
| npm install failure | npm install fails repeatedly | Clear project node_modules or package-lock after confirmation |
| dependency install timeout | process timeout | Keep old runtime, mark install failed |
| script timeout | run timer | Cancel process, keep partial logs |
| artifact invalid | verifier fails | Show failed verification, keep artifact quarantined |
| workspace path moved | root missing | Require workspace rebind |
| disk full | write error | Surface disk usage and cleanup action |
| feature smoke check fails | feature validation fails | Keep feature in draft/disabled state |
| SDK capability denied | capability guard rejects call | Return structured permission error and optional approval path |
| missing Python | system Python detection or venv smoke test fails | Ask approval, then agent installs/repairs Python through CLI runtime |
| missing Node | system Node/npm detection fails | Ask approval, then agent installs/repairs Node.js through CLI runtime |
| no network during programming environment install | installer/package-manager command fails | Keep code-backed features unavailable and keep non-code tools available |
| installer verification fails | version check or smoke test fails | Mark repair_required and offer retry/install alternative |

## 20. Agent Usage Contract

This section defines prompt-level and tool-description guidance for how the agent should decide whether to use the managed Python + Node workbench. The goal is to make the capability learnable through tool contracts, runtime context and templates, not through hardcoded natural-language routing.

These rules are not host-side intent classifiers. The host should not block a script run merely because the task looks "too simple" to a heuristic. The host only enforces safety, filesystem, dependency, timeout, approval and artifact-publishing boundaries.

### 20.1 Core Rule

Agent should create and run scripts when the task benefits from repeatable computation, batch processing, third-party libraries, or media/data transformation.

Agent should create or update workspace features when the user asks for a reusable capability, custom page, persistent workflow, workspace-specific tool or repeated operation that should remain available after the current chat turn.

For simple file reads, manuscript edits, direct product actions, or one-step workspace operations, the agent should use narrower existing tools first:

- `Read`
- `List`
- `Search`
- `Write`
- existing Redbox product actions
- existing media generation / editor actions

### 20.2 When To Use Workspace Runtime

Prompt guidance: use the workspace runtime for:

- batch processing many files.
- parsing, cleaning, reshaping or validating CSV / JSON / HTML / XLSX data.
- image resizing, compression, format conversion, thumbnailing or visual preprocessing.
- video frame extraction, ffprobe metadata analysis, ffmpeg plan generation or Remotion composition generation.
- generating intermediate artifacts that need files rather than prompt text.
- using a Python / Node library that RedConvert does not expose as a first-class product action.
- repeatable transformation where a run manifest and artifacts are useful evidence.
- implementing or maintaining a workspace feature that needs code.
- building a lightweight custom page that calls RedConvert SDK capabilities.

### 20.3 When Not To Use Workspace Runtime

Prompt guidance: avoid the workspace runtime for:

- reading one file.
- listing a directory.
- searching known workspace / knowledge / asset collections.
- editing the current manuscript body.
- calling a first-class product operation that already exists.
- making a creative judgment that requires user confirmation.
- generating a final answer that can be produced directly from current context.
- installing a dependency just to avoid using an existing narrower tool.

### 20.4 Recommended Feature Decision

Prompt guidance: consider a workspace feature when:

- the user asks for something they will use repeatedly.
- the output is a page, panel, dashboard or tool rather than a one-time artifact.
- the feature needs to coordinate multiple RedConvert capabilities.
- the user wants the app itself to gain a workspace-specific function.

Avoid a workspace feature when:

- a one-off script run is enough.
- the functionality should become a general product feature instead.
- the requested behavior requires broad app privileges that cannot be safely granted through SDK capabilities.

### 20.5 Recommended Preflight Sequence

Recommended preflight before a script or feature run:

1. Identify why a script is justified.
2. Use `workspace_runtime.inspect` unless the current turn already has a fresh runtime-ready signal.
3. Bootstrap only when runtime status is missing, broken or incompatible.
4. Prefer existing templates before writing a script from scratch.
5. Install dependencies only when the script cannot use baseline packages or an existing product action.
6. Declare expected outputs and verification checks before running the script.
7. For a feature, inspect SDK capabilities and write a manifest before implementation.

### 20.6 Recommended Post-Run Sequence

Recommended post-run sequence:

1. Read the structured run result.
2. Verify outputs using declared verification checks.
3. Register artifacts.
4. Publish to workspace only if needed.
5. Summarize only the outcome, artifact links and any action needed from the user.
6. Preserve logs and manifest for diagnostics; do not paste large logs into the assistant message.

For a feature:

1. Run smoke check.
2. Keep the feature draft/disabled until validation passes.
3. Ask for approval before enabling new capabilities.
4. Register UI slot only after manifest validation.

### 20.7 Dependency Rules

Dependency installation requests should be structured and justified:

```json
{
  "ecosystem": "python",
  "packages": [
    {
      "name": "pandas",
      "reason": "Parse and validate attached CSV exports."
    }
  ]
}
```

Rules:

- Use baseline dependencies first.
- Prefer built-in product actions over new dependencies.
- Unknown packages require policy evaluation.
- Network-requiring installs must respect network policy.
- Dependency install failure must not block unrelated product actions.
- A script may not silently modify dependency files in the user workspace.

### 20.8 Publish Rules

Runtime outputs stay inside managed artifacts by default.

Publishing to the user workspace is a host-mediated operation and requires:

- explicit destination path.
- conflict behavior.
- artifact id.
- run id.
- verification status.

The agent should not write directly to arbitrary workspace paths from Python / Node scripts. It should write runtime artifacts first, then call `publish_artifact`.

## 21. Constraint Boundary

### 21.1 Host-Enforced Invariants

The host should enforce only capability safety and data integrity:

- Runtime files are stored outside the user workspace root by default.
- Shared runtime dependencies are separated from per-workspace data.
- Scripts write to managed artifact directories by default.
- Publishing to the user workspace goes through path normalization, conflict checks and approval policy.
- Dependency installation respects network and approval policy.
- Process execution respects timeout, output budget and cancellation.
- App SDK capability calls respect declared feature capabilities and approval policy.
- Feature UI runs in a sandboxed slot with a limited bridge.
- Logs and model-visible summaries are sanitized.
- Large artifacts stay on disk and are referenced by metadata.
- Unverified or failed artifacts are clearly marked before they can be presented as successful outputs.

These are platform guardrails. They do not decide whether a task "deserves" Python or Node.

### 21.2 Prompt-Level Guidance

The following belong in system prompt fragments, skill guidance, action descriptions or template activation hints:

- Prefer narrower tools for simple operations.
- Use scripts for repeatable computation, batch processing and library-backed transformations.
- Create workspace features for repeated tools, custom pages or persistent workflows.
- Use App SDK when custom code needs to call RedConvert capabilities.
- Prefer templates before writing from scratch.
- Verify outputs before reporting success.
- Keep generated artifacts in managed runtime unless the user needs files published.

These constraints shape agent behavior without hardcoding task semantics in the host.

### 21.3 Runtime Policy Is Not Task Semantics

Runtime policy may block or request approval for:

- network access.
- dependency installation.
- workspace writes.
- SDK capability access.
- feature UI registration.
- long-running execution.
- unsafe paths.
- oversized outputs.

Runtime policy should not block because:

- the user message contains or does not contain a keyword.
- the host thinks the task category should use another tool.
- the host detects a business phrase such as video, article, product image or batch edit.

## 22. Tool Exposure And Agent Guidance

### 22.1 No Keyword Routing

Do not route to workspace runtime because user text contains words like:

- python
- script
- video
- batch
- data
- image
- automation

These words may inform the model's reasoning, but the host must not force active tools, skills or runtime behavior from raw natural-language keywords.

Allowed exposure and context inputs:

- runtime mode.
- page-provided typed context.
- bound resources.
- session metadata.
- tool policy.
- user-granted permissions.
- explicit user action such as choosing a template or requesting a script.
- explicit user action requesting a persistent feature or custom page.

These inputs may affect which actions are shown directly, deferred, or summarized, but they should not force the agent to use a script.

### 22.2 Runtime Capability Card

Prompt assembly may include a short capability card when workspace runtime actions are visible:

```text
Managed Workspace Runtime:
- Use for batch file processing, Python/Node library work, media preprocessing, data conversion, and generated artifacts.
- Use workspace features for reusable tools, custom pages, dashboards, and persistent workflows.
- Use App SDK for RedConvert capabilities instead of private app internals.
- Prefer narrower Read/List/Search/Write/Product actions for simple operations.
- Default outputs must stay in runtime artifacts.
- Publish only when the user needs files in the workspace.
- Verify generated files before reporting success.
```

This card should be stable and short. It should not enumerate every package or template.

### 22.3 Action Descriptions

Tool descriptions should teach behavior at the action boundary:

```text
workspace_runtime.run_script:
Use this for repeatable file processing, data parsing, media preprocessing, or tasks that need Python/Node libraries. Do not use it for simple single-file reads, normal manuscript edits, or tasks covered by narrower product actions. Scripts write to managed runtime artifacts by default.
```

```text
workspace_runtime.publish_artifact:
Publish a verified managed runtime artifact into the user workspace. Use only after a script run has produced an artifact and the destination path is explicit.
```

```text
workspace_runtime.create_feature:
Create a reusable workspace-local feature such as a custom page, dashboard, batch tool, or persistent workflow. Use when the user wants the app to gain a workspace-specific capability, not for one-off transformations.
```

```text
workspace_runtime.invoke_sdk:
Call a declared RedConvert App SDK capability from workspace code. Use this instead of accessing internal stores, Tauri commands, or private files directly.
```

### 22.4 Exposure Matrix

Default exposure should be dynamic and turn-scoped. This matrix is a prompt/tool-surface recommendation, not a host-side business router:

| Runtime mode | Direct actions | Deferred actions | Hidden actions |
| --- | --- | --- | --- |
| default | inspect, run_script | install_dependency, publish_artifact, template.search, feature.create | repair, cleanup |
| wander | inspect, run_script, publish_artifact | install_dependency, template.search, feature.create, app_sdk.capabilities | repair, cleanup |
| redclaw | inspect, run_script, publish_artifact, feature.run | install_dependency, list_runs, template.search, feature.create, app_sdk.capabilities | repair, cleanup |
| image-generation | inspect, run_script, publish_artifact, template.search | install_dependency, feature.create | repair, cleanup |
| video-editor | inspect, run_script, publish_artifact, template.search | install_dependency, list_runs, feature.create, app_sdk.capabilities | repair, cleanup |
| diagnostics | inspect, list_runs, list_features, repair, cleanup, app_sdk.capabilities | run_script, install_dependency | none |
| manuscript-editor | bound editor actions only by default | feature.create if explicitly requested | install_dependency, repair, cleanup |

The manuscript editor should stay narrow by default. If the page explicitly exposes a runtime operation, the agent may still choose to use it. Normal manuscript editing guidance should continue to prefer bound editor actions.

### 22.5 Tool Search

If workspace runtime templates or actions exceed the direct action budget, expose them through `tool_search` or a deferred action index.

The model should be able to search for:

- templates.
- verification checks.
- media processing helpers.
- dependency capabilities.
- SDK capability summaries.
- existing workspace features.

It should not need a full list injected into every prompt.

## 23. Template System

### 23.1 Purpose

Templates reduce from-scratch script generation. They give the agent reliable starting points without hardcoding business intent into the host.

Templates are not agents. They are parameterized script assets with typed inputs, typed outputs, dependency metadata and verification requirements.

### 23.2 Template Record

```json
{
  "id": "video.extract_keyframes",
  "title": "Extract keyframes from video",
  "description": "Extract representative frames from a local video for analysis, storyboard, or preview.",
  "runtime": "python",
  "entrypoint": "extract_keyframes.py",
  "activationHint": "Use when a video file needs representative frame images or visual sampling.",
  "inputs": {
    "videoPath": {
      "type": "string",
      "kind": "file",
      "required": true
    },
    "maxFrames": {
      "type": "integer",
      "default": 12
    }
  },
  "outputs": {
    "frames": {
      "type": "array",
      "items": "image"
    },
    "metadata": {
      "type": "json"
    }
  },
  "dependencies": [
    {
      "ecosystem": "python",
      "name": "opencv-python-headless"
    }
  ],
  "verification": [
    "file_count",
    "image_decode"
  ]
}
```

### 23.3 Initial Template Set

V1 templates:

- `files.batch_rename_plan`: generate a safe rename plan, not directly rename.
- `data.csv_profile`: inspect CSV columns, row count, nulls and sample values.
- `data.json_validate`: validate JSON against an inferred or provided schema.
- `image.batch_resize`: resize and convert images to target dimensions / format.
- `image.thumbnail_sheet`: create a contact sheet for image review.
- `video.probe`: run ffprobe and normalize metadata.
- `video.extract_keyframes`: extract representative frames.
- `video.subtitle_burn_plan`: prepare ffmpeg subtitle burn-in command and verify inputs.
- `video.remotion_scaffold`: create a minimal Remotion composition from typed scene data.
- `web.page_snapshot`: fetch and parse a webpage only when network policy allows.
- `feature.basic_tool`: scaffold a workspace feature with one action.
- `feature.dashboard_view`: scaffold a sandboxed feature view with SDK context.
- `feature.asset_panel`: scaffold an asset-oriented feature view using `assets.read`.

### 23.4 Template Discovery Flow

1. Agent decides a script is justified.
2. Agent searches templates by task and resource kind.
3. Host returns top matches with activation hints and schemas.
4. Agent chooses a template or writes custom script if no template fits.
5. Host records template id in run manifest.

Template use is guidance, not forced routing.

### 23.5 Template Storage

Preferred structure:

```text
desktop/runtime-templates/
  python/
    video.extract_keyframes/
      template.json
      extract_keyframes.py
  node/
    video.remotion_scaffold/
      template.json
      scaffold.ts
```

Templates should be versioned. Run manifests must record template id and version.

## 24. Verification Taxonomy

### 24.1 Verification Record

Each run can declare verification checks:

```json
{
  "checks": [
    {
      "type": "video_probe",
      "path": "artifacts/videos/final.mp4",
      "expect": {
        "minDurationSec": 5,
        "maxDurationSec": 120,
        "hasVideo": true
      }
    }
  ]
}
```

### 24.2 V1 Checks

V1 should support:

- `path_exists`: file exists and is readable.
- `file_count`: output glob count matches range.
- `non_empty_file`: file size is greater than zero.
- `json_parse`: JSON parses successfully.
- `json_schema`: JSON matches schema.
- `csv_shape`: CSV parses, row count and column count match expectations.
- `image_decode`: image can be decoded.
- `image_dimensions`: width/height match expected range.
- `video_probe`: ffprobe can read video, duration and streams are valid.
- `audio_probe`: ffprobe can read audio, duration and streams are valid.
- `text_contains`: text output contains required markers.
- `feature_manifest`: feature manifest parses and declares valid capabilities.
- `feature_smoke`: feature action or view loads with mocked SDK context.
- `sdk_capability_check`: feature requested capabilities are known and granted.

### 24.3 Verification Rules

- Prompt guidance should ask the agent to declare at least one verification check for mutating script runs.
- Prompt guidance should ask the agent to use media-specific verification for media artifacts.
- Failed verification keeps artifact in managed runtime and marks it as failed or not verified.
- The assistant may report partial success only if verified outputs are clearly separated from failed outputs.
- Workspace features should pass manifest validation and smoke checks before being enabled.

Host enforcement should focus on artifact state truthfulness: an artifact cannot be represented as verified unless a verification check actually passed.

## 25. Structured Page Context

Page surfaces should pass typed context to the runtime instead of relying on user message parsing.

Example:

```json
{
  "runtimeMode": "video-editor",
  "boundResources": [
    {
      "kind": "video",
      "path": "workspace://media/source.mp4"
    }
  ],
  "allowedArtifactKinds": ["image", "json", "video"],
  "preferredTemplates": ["video.probe", "video.extract_keyframes"],
  "availableSdkCapabilities": ["media.read", "artifacts.write"],
  "featureSlots": ["workspace.tools", "asset.inspector"],
  "requiresUserConfirmationBeforeFinalRender": true
}
```

Rules:

- Page context may bias tool exposure.
- Page context may suggest templates.
- Page context may suggest feature slots and SDK capabilities.
- Page context must not force a script if a narrower product action is sufficient.
- Page context should use resource ids / virtual paths when possible.

## 26. Implementation Plan

This is one product capability. It can be reviewed in sections, but execution should land as a complete vertical slice before being considered done.

### 26.1 Host Foundation

Deliverables:

- `workspace_runtime` Rust module.
- workspace id and path resolver.
- runtime manifest schema.
- inspect/bootstrap/repair commands.
- system Python detection and venv bootstrap.
- system Node/npm bootstrap.
- smoke tests.
- feature folder and manifest validation.
- App SDK schema registry.
- App SDK generated protocol records for TypeScript / Python.
- run handle and event router.
- passive doctor diagnostics.
- compact runtime status snapshot.
- shared runtime root and workspace namespace resolver.
- system Python/pip and Node/npm detection plus CLI install flow.
- runtime kernel repair command.

Acceptance:

- A workspace can create runtime without writing to workspace root.
- Reopening app can inspect existing runtime.
- Broken runtime can be detected and repaired.
- Feature manifest validation works without starting feature code.
- Multiple workspaces resolve into separate namespaces under one shared runtime root.
- A machine without system Python/Node enters an agent-assisted install flow with approval and keeps non-code app capabilities usable.
- Doctor reports environment, runtime, SDK, feature registry and app-bundled media status without mutating local state.
- Two concurrent runs route output and completion events by `runId`.

### 26.2 Script Execution

Deliverables:

- create script command.
- run script command.
- stdout/stderr capture.
- cancel support.
- run manifest.
- artifact registration.
- basic verification hooks.

Acceptance:

- Python script can read workspace file and write runtime artifact.
- Node script can read workspace file and write runtime artifact.
- Run appears in runtime events and recent runs.
- Cancel stops long process and records cancelled status.

### 26.3 Dependency Management

Deliverables:

- structured dependency install request.
- Python package install through pip.
- Node package install through npm.
- baseline dependency set.
- install lock and status events.

Acceptance:

- Baseline dependencies install once and are reused.
- Unknown dependency requests are recorded with reason.
- Failed install does not corrupt previous runtime.
- Dependencies are installed once into shared runtime and audited per workspace/feature.

### 26.4 Workspace Feature And SDK Integration

Deliverables:

- create/update/list/enable/disable feature commands.
- feature action runner.
- feature view sandbox slot.
- App SDK bridge for Node and Python.
- SDK capability registry.
- SDK approval mode mapping.
- feature smoke check.
- feature share package export/import.

Acceptance:

- agent can create a draft feature with manifest and code.
- feature can call an allowed SDK capability.
- denied SDK capability returns structured permission error.
- feature view can load in a sandboxed slot with context.
- enabling a feature does not expose new capabilities without grant.
- exported feature package can be imported as draft in another workspace without carrying private data or grants.

### 26.5 Tool Plane Integration

Deliverables:

- `app_cli` actions.
- catalog descriptions.
- guard policy.
- ToolRegistryPlan exposure by runtime mode.
- transcript/checkpoint markers.
- capability card injection.
- template discovery actions.
- verification taxonomy actions.
- feature create/update/run actions.
- app SDK capability discovery/invoke actions.
- status and doctor actions.
- feature share/import actions.

Acceptance:

- agent can inspect, bootstrap, run script and publish artifact through the normal tool plane.
- no new top-level tool is added.
- tool descriptions discourage writing dependency files to workspace root.
- simple manuscript editing does not expose workspace runtime by default.
- deferred template discovery works without injecting all templates into prompt.
- reusable feature creation is available without adding new top-level tools.
- doctor output is available as structured JSON for support and compact human-readable diagnostics for Settings.

### 26.6 UI Integration

Deliverables:

- bridge methods.
- runtime event stream handling.
- compact process cards.
- artifact preview links.
- Settings diagnostics page.
- compact runtime status surface in process cards/status areas.
- workspace feature registry view.
- sandboxed feature view slot.

Acceptance:

- Chat / Wander can show script progress without large explanatory UI.
- Settings can repair and clear runtime.
- Logs are available on demand.
- Existing page refresh behavior is not replaced by full-page loading.
- Feature views are opt-in/pinned and do not add noisy default UI.
- Status UI shows runtime root, readiness, approval mode and current run state without adding broad explanatory text.

### 26.7 Media Workflow Integration

Deliverables:

- app-bundled ffmpeg / ffprobe verification helpers.
- image processing template.
- video frame extraction template.
- Remotion project generation path.
- media queue artifact linkage.

Acceptance:

- A video can be analyzed, processed, verified and linked back as a media artifact.
- Generated video has ffprobe validation.
- Partial failure preserves logs and intermediate artifacts.

### 26.8 Documentation And Diagnostics

Deliverables:

- developer docs.
- user-facing diagnostic copy.
- troubleshooting runbook.
- runtime reset procedure.
- SDK protocol compatibility notes.
- feature share package format.

Acceptance:

- Support can answer where scripts ran, what dependencies were installed, what feature code changed, which SDK capabilities were granted, what files were produced and why a run failed.
- Support can ask for one doctor report instead of reconstructing Python/Node/SDK/media status from separate logs.

## 27. Testing Matrix

Rust tests:

- workspace id stability.
- path guard rejects traversal.
- manifest read/write.
- run manifest status transitions.
- policy decisions.
- artifact publish conflict handling.
- runtime-mode exposure matrix.
- verification taxonomy.
- template schema validation.
- feature manifest validation.
- SDK capability guard.
- SDK protocol schema compatibility.
- ApprovalMode mapping.
- event routing by `runId`.
- doctor report JSON and compact UI model.
- feature share package export/import.
- shared runtime workspace namespace isolation.

Integration tests:

- Python bootstrap smoke.
- Node bootstrap smoke.
- system Python/Node missing flow through CLI Runtime install.
- provisioning failure leaves non-code app capabilities usable.
- Python script run.
- Node script run.
- dependency install success and failure.
- cancel long-running process.
- artifact verification.
- template search and run.
- run with failed verification blocks default publish.
- create feature action.
- feature smoke check.
- SDK allowed and denied calls.
- sandboxed feature view context.
- two workspaces share dependencies but cannot read each other's artifacts.
- concurrent script and feature action events do not cross streams.
- SDK backpressure returns structured overload errors.

Renderer tests:

- process card renders running/completed/failed.
- logs collapsed by default.
- artifact preview action.
- settings diagnostics state.
- compact runtime status state.
- manuscript editor does not show script runtime controls by default.
- feature registry renders enabled/draft/failed states.
- feature view slot loads with minimal bridge.

Manual verification:

- fresh app data directory.
- existing workspace runtime.
- moved workspace.
- corrupted runtime.
- large video input.
- no network.
- dependency install failure.
- workspace with existing package.json at root to confirm no pollution.
- simple manuscript edit does not call workspace runtime.
- video task can discover and use a video template.
- user asks for a reusable dashboard and agent creates a draft workspace feature.
- feature can call asset SDK without direct store access.
- doctor report shows app-bundled ffmpeg/ffprobe status separately from Python/Node programming environment.

## 28. Resolved Product Decisions

The plan is intentionally converged. These are product decisions, not parallel options:

1. Runtime storage: V1 uses the RedConvert project working directory shared runtime root. User workspace root pointers stay metadata-only.
2. Dependency timing: install the smallest Python / Node baseline at bootstrap, then lazy-install heavier libraries such as Remotion or data-science packages when a run or feature declares them.
3. Dependency approval: known baseline packages can install through policy; unknown, network-heavy, native-build, global, or executable packages require approval.
4. Script persistence: run manifests are always persisted; script source is persisted inside runtime runs and saved as a feature only when the agent or user intentionally creates a workspace feature.
5. Remotion: video-only lazy install in V1, not a universal baseline dependency.
6. Normal UI visibility: show compact run status, artifacts and failures; show source code, logs and dependency details only in diagnostics or explicit developer views.
7. Backup/export: V1 can export feature share packages and run evidence, but does not bundle the full shared `.venv` or `node_modules`.
8. Templates: ship a built-in template library for common media, data and feature scaffolds; authoring remains internal/developer-only in V1.
9. Verification: verification checks are run evidence by default; diagnostics can display them, normal users should not configure them in V1.
10. UI slots: V1 allows `workspace.tools`, `asset.inspector`, `redclaw.artifactInspector` and `diagnostics.featureDev` only.
11. Feature editing: agent/developer diagnostics can edit feature code; normal users enable, disable, run, pin, import and remove features.
12. Plugin promotion: a feature becomes a plugin candidate only after export as share package, SDK compatibility check, smoke check and explicit user/developer action.
13. Capability grants: grants are per feature and per workspace; share packages can declare requested capabilities but cannot carry grants.
14. Dependency conflicts: V1 records conflicts and can mark a feature incompatible; isolated per-feature environments are reserved for later high-risk cases.
15. Cleanup: cleanup removes unreachable runs, caches and artifacts by manifest reachability; feature manifests and user-enabled feature data survive unless explicitly deleted.
16. Agent-assisted install: Python / Node / pip / npm installation uses visible CLI runtime commands with approval, platform-specific instructions and no silent shell profile edits.
17. App media tools: ffmpeg / ffprobe are shipped and updated as app-bundled media tools, diagnosed separately from the user's programming environment.

## 29. Recommended V1 Scope

V1 should include:

- project working-directory shared runtime root.
- Python through user-machine Python + venv + pip.
- Node through user-machine Node + npm.
- script create/run/cancel.
- dependency install with policy.
- run manifest and artifact registry.
- compact UI events.
- Settings diagnostics.
- passive doctor diagnostics with JSON and compact UI output.
- compact runtime status snapshot.
- ffmpeg/ffprobe verification integration.
- simple media templates.
- agent usage contract.
- runtime-mode exposure recommendations.
- template search and template run.
- verification taxonomy.
- workspace feature manifest and draft registry.
- feature action runner.
- one sandboxed feature view slot.
- App SDK V1 for files, artifacts, assets, manuscripts, media probe and approvals.
- generated SDK protocol types for TypeScript and Python.
- run handles and `runId`-scoped event routing.
- explicit ApprovalMode mapping.
- local feature share package export/import as draft.
- shared runtime root with per-workspace namespace isolation.
- system programming environment detection and agent-assisted install for Python, pip, Node and npm.

V1 should not include:

- full IDE.
- arbitrary terminal.
- user workspace root project initialization.
- global shared user runtime.
- automatic publishing of scripts into user files.
- hardcoded natural-language routing based on task keywords.
- automatic script use for simple manuscript editing.
- full marketplace plugin packaging.
- remote feature daemon or remote runner lifecycle.
- arbitrary full-app UI injection.
- unrestricted SDK access to internal stores.
- per-workspace duplicate `.venv` / `node_modules` as the default runtime model.

## 30. Non-Negotiable Constraints

- Do not write `package.json`, `requirements.txt`, `.venv`, `node_modules` or lock files into the user workspace root by default.
- Do not expose Python / Node as broad top-level tools.
- Do not treat exit code 0 as proof of task success.
- Do not put large logs or artifacts into SQLite.
- Do not block UI on bootstrap, dependency install or media processing.
- Do not hold AppStore locks during file I/O, process execution, dependency install, ffmpeg, Remotion or Python / Node scripts.
- Do not hide script failures behind generic AI summaries. Preserve run evidence.
- Do not make the main UI explain runtimes to normal users unless an error needs action.
- Do not route to workspace runtime from raw natural-language keyword matching.
- Do not inject the full template catalog into every prompt.
- Do not represent unverified media artifacts as verified or successful.
- Do not add host-side business heuristics that block script use because the host thinks another tool is more appropriate.
- Do not let workspace feature code call private Tauri commands, SQLite, AppStore internals or unscoped filesystem paths directly.
- Do not expose a workspace feature UI unless its manifest, capabilities and smoke check pass.
- Do not treat workspace features as globally installed plugins by default.
- Do not store workspace private data, artifacts, logs or capability grants in the shared dependency layer.
- Do not let one workspace namespace read another workspace namespace without an explicit host-mediated export/import flow.
- Do not require users to manually preinstall Python, Node, npm or pip before using the app; missing programming environments should be handled through agent-assisted CLI install with approval.
- Do not silently modify system PATH, shell profiles, or global package managers.
