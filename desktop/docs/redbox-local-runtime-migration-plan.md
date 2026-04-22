---
doc_type: plan
execution_status: not_started
last_updated: 2026-04-22
execution_stage: architecture_proposed
owner: ai-runtime
scope: desktop
target_files:
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/settings/SettingsSections.tsx
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/config/aiSources.ts
  - desktop/src/types.d.ts
  - desktop/src-tauri/src/main.rs
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/commands/*
  - desktop/src-tauri/src/events/*
  - desktop/src-tauri/src/local_runtime/*
  - desktop/src-tauri/tauri.conf.json
  - desktop/scripts/*
  - local-runtime/*
success_metrics:
  - RedBox 主包可管理 Local Runtime 的安装、启动、停止、重启、健康检查和日志查看
  - 已有 Chat/Wander/Knowledge 主推理链在切换到本地 OpenAI-compatible endpoint 后无行为回归
  - Local Runtime 崩溃、缺模型、端口冲突、环境损坏时，RedBox 能给出可执行修复动作
  - macOS/Windows 主包发布链不被 Python/vLLM/CUDA 运行时直接耦合
  - Linux NVIDIA 受管 vLLM 路线具备可验证的安装、推理、恢复和升级路径
---

# RedBox Local Runtime 迁移升级计划

Status: Current

## Scope

本方案定义将本地模型能力从“用户手动填写 endpoint”升级为“RedBox 主包 + RedBox Local Runtime 双包架构”的完整迁移计划。输出目标不是零散建议，而是可直接拆解到仓库和发布链路的执行方案，覆盖：

- 产品形态与安装体验
- RedBox 主包内嵌控制面 UI
- Local Runtime 无头执行面
- vLLM 作为受管推理引擎的接入方式
- AI runtime 与现有 OpenAI-compatible 主链的对接
- 与视频处理、知识库、Wander、Chat 的边界
- 构建、签名、升级、诊断、恢复与验证

本方案默认服务对象是当前 `desktop/` 主产品，不涉及 `archive/desktop-electron/`。

## Decision Summary

最终推荐方案如下：

1. 产品拆为两个交付物

- `RedBox`：主桌面 App，承载所有日常 UI、工作流、设置、诊断和 AI source 绑定。
- `RedBox Local Runtime`：受管本地运行时，负责 Python 环境、推理引擎、模型下载、健康检查和修复入口。

2. UI 归属

- 完整模型安装、模型切换、运行状态、日志、诊断、默认模型绑定 UI 一律内嵌在 `RedBox` 中。
- `Local Runtime` 不做完整独立产品 UI，只保留最小安装器 / 修复器 / 自检入口。

3. AI 接入方式

- 不改 RedBox 现有 `OpenAI-compatible endpoint + model_name` 主链。
- 本地模型启动成功后，RedBox 只是把 `baseURL/apiKey/modelName` 指到本地 runtime。

4. vLLM 使用策略

- `vLLM` 不直接打进 RedBox 主包。
- `vLLM` 放在 `RedBox Local Runtime` 内部，由其单独安装、升级、修复。

5. 支持策略

- 受管 `vLLM` 正式支持优先锁定为 `Linux x86_64 + NVIDIA CUDA`。
- `macOS` 与 `Windows` 保留 Local Runtime 架构，但 `vLLM` 受管模式默认不承诺正式支持；这两个平台继续保留“连接外部本地服务”的能力。

## Current Baseline

当前仓库在 AI 模型接入上已经具备几个关键基础：

### 1. RedBox 文本模型主链已经是 endpoint 驱动

- 文本推理配置通过 `ResolvedChatConfig { protocol, base_url, api_key, model_name }` 进入运行时。
- 主入口位于：
  - `desktop/src-tauri/src/runtime/config_runtime.rs`
  - `desktop/src-tauri/src/runtime/types.rs`
  - `desktop/src-tauri/src/llm_transport/openai.rs`
  - `desktop/src-tauri/src/provider_runtime/openai.rs`

这意味着：只要本地服务能稳定提供 OpenAI-compatible API，Chat / Wander / Knowledge 的主推理链原则上不需要重写。

### 2. 设置页已经存在本地 provider 预设

- `desktop/src/config/aiSources.ts` 中已经有：
  - `ollama-local`
  - `lmstudio-local`
  - `vllm-local`
  - `localai-local`
  - `llama-cpp-local`

这说明产品层已经接受“本地模型来源”这一概念，现阶段缺的是受管 runtime，而不是抽象层本身。

### 3. Rust Host 已有 sidecar 雏形，但不足以支撑重型推理服务

- 当前存在微信 sidecar 生命周期控制：
  - `desktop/src-tauri/src/assistant_core.rs`
  - `desktop/src-tauri/src/commands/assistant_daemon.rs`

但这套实现目前更偏轻量进程管理，缺少：

- 安装状态机
- 版本兼容
- 运行时 profile
- 健康检查与 ready/warmup 区分
- 日志持久化与 tail
- 崩溃恢复与升级回滚
- GPU / Python / torch / model 的 preflight

因此不能直接把现有 weixin sidecar 逻辑视为 Local Runtime 的最终实现，只能复用其“受管外部进程”思路。

### 4. 当前视频处理链不依赖 LLM 运行时

- 视频相关核心仍然是 `ffmpeg`、`remotion`、素材存储和项目编辑协议。
- 这条链路与文本推理服务是并列关系，不应被 `vLLM` runtime 绑死。

这点非常重要：本次迁移是 AI 基础设施升级，不是视频引擎重构。

## Goals

本次迁移必须同时满足以下目标：

1. 产品目标

- 用户在 RedBox 中就能完成 Local Runtime 的发现、安装、启动、停止、重启和故障诊断。
- 用户不需要手动管理 Python 环境、torch、CUDA、vLLM 命令行。
- 用户能像使用云端 provider 一样使用本地模型。

2. 架构目标

- 不破坏现有 `OpenAI-compatible` 主调用链。
- 不把 Python / CUDA / vLLM 依赖塞进 `RedBox` 主包构建链。
- 主包和本地 runtime 可以独立升级。

3. 稳定性目标

- Local Runtime 崩溃不应拖垮 RedBox 主 App。
- Runtime 缺模型、端口冲突、健康检查失败时，RedBox 必须可恢复、可提示、可回退。

4. 发布目标

- `RedBox` 主包继续维持当前 `dmg + nsis + app` 发布形态。
- `Local Runtime` 作为 companion package 独立构建、独立签名、独立升级。

5. 性能目标

- RedBox 主页面切换和设置页加载不能因 runtime 检查而被阻塞。
- 模型启动、日志采集、健康探针、模型列表刷新都必须异步化。

## Non-Goals

以下内容不在本次迁移的目标范围内：

- 不在本次迁移中重构 Chat / Wander 的 prompt、skill、tool pack 边界。
- 不在本次迁移中改造视频编辑器协议、ffmpeg recipe、remotion 导出流程。
- 不在本次迁移中把转写、embedding、图片生成全部切到 vLLM。
- 不在本次迁移中承诺所有平台都具备“受管 vLLM”正式支持。

## Options Compared

### 方案 A：把 Python 脚本直接塞进 RedBox 主包，首启动态安装依赖

优点：

- 代码初看最少
- 可以快速做出原型

缺点：

- 首启强依赖网络
- 安装失败面极大
- 不可离线复现
- 环境损坏后难修复
- 主包签名、升级、缓存治理全部混在一起

结论：

- 不推荐

### 方案 B：把完整 Python + vLLM + torch + CUDA 直接打进 RedBox 主包

优点：

- 产品表面看起来只有一个安装包
- 用户不需要理解 companion runtime

缺点：

- 主包极重
- macOS/Windows 发布复杂度大幅上升
- 平台差异会污染主产品构建链
- vLLM 官方平台支持矩阵不适合作为主包默认依赖

结论：

- 不推荐

### 方案 C：RedBox 只支持连接用户自己起好的 vLLM

优点：

- RedBox 改动最小
- 工程成本最低

缺点：

- 用户体验差
- 大量问题转为“环境没配好”
- 无法形成真正产品能力

结论：

- 可以保留为 fallback，但不是目标形态

### 方案 D：RedBox 主包 + RedBox Local Runtime 双包，UI 内嵌在 RedBox

优点：

- 主包稳定
- 运行时可独立升级
- 产品体验完整
- 与现有 OpenAI-compatible 架构天然兼容
- 平台差异被隔离在 runtime 侧

缺点：

- 需要新增安装、桥接、状态机和发布链路
- 文档、诊断、升级策略需要一次性设计完整

结论：

- 推荐方案

## Recommended Product Architecture

### Overall Topology

推荐最终拓扑如下：

`Renderer UI -> ipcRenderer bridge -> Rust Host local_runtime manager -> Local Runtime management API -> vLLM OpenAI-compatible inference API`

拆成两条链路：

1. 控制面链路

- RedBox Settings / diagnostics
- `window.ipcRenderer.localRuntime.*`
- Rust host `local_runtime` 管理模块
- Local Runtime management API

2. 推理面链路

- Chat / Wander / Knowledge / RedClaw
- 现有 `ResolvedChatConfig`
- 现有 OpenAI-compatible transport
- `http://127.0.0.1:<inference-port>/v1/...`

关键原则：

- 控制面和推理面分离
- 安装/管理失败不应该污染正常推理调用栈
- 本地 provider 只是现有 AI source 的一种实现，不是额外平行架构

## Module Breakdown

## 1. RedBox Renderer UI

### Responsibilities

- 展示本地 runtime 的安装状态、启动状态、健康状态
- 管理模型安装、删除、默认模型绑定
- 展示下载进度、日志、诊断和修复入口
- 将本地模型绑定到 `chatroom / wander / knowledge / redclaw`

### Entry Points

- `desktop/src/pages/Settings.tsx`
- `desktop/src/pages/settings/SettingsSections.tsx`
- `desktop/src/config/aiSources.ts`
- `desktop/src/bridge/ipcRenderer.ts`

### Required New UI Sections

建议在 `Settings -> AI` 中新增 `Local Runtime` 分组，至少包含以下面板：

1. `RuntimeStatusPanel`

- 已安装 / 未安装 / 安装中 / 运行中 / 启动失败 / 需升级
- 当前版本
- 当前引擎
- 当前模型
- 当前端口
- 最近错误

2. `RuntimeInstallPanel`

- 安装 Local Runtime
- 选择安装目录
- 选择缓存目录
- 查看安装进度
- 修复安装

3. `ModelCatalogPanel`

- 已安装模型列表
- 模型来源
- 本地体积
- 量化类型
- 是否已下载完成
- 是否可用于 chat / embedding / transcription

4. `RuntimeControlPanel`

- 启动
- 停止
- 重启
- 清理缓存
- 复制诊断信息

5. `HealthDiagnosticsPanel`

- Python 版本
- runtime 版本
- torch backend
- GPU 检测结果
- 显存/内存预估
- 端口占用
- `/health` 与 `/v1/models` 探针结果

6. `AiSourceBindingPanel`

- 设置默认本地 chat model
- 分别绑定到 `model_name_wander`
- `model_name_chatroom`
- `model_name_knowledge`
- `model_name_redclaw`

### Must Be Self-Developed

- Runtime 状态与安装引导 UI
- 与 AI source 的绑定逻辑
- 日志 tail 面板
- 修复入口与操作引导

### Can Reuse Existing Mechanisms

- `aiSources` 配置模型
- `getSettings` / `saveSettings`
- 现有 model picker
- 现有 diagnostics UI 风格

### Performance Rules

- 设置页首次渲染只显示最后一次缓存状态，后台刷新
- 日志 tail 分页或 ring buffer 展示，禁止整份大日志一次性注入页面
- 模型列表刷新和硬件探测必须异步，不能阻塞 Tab 切换

## 2. RedBox Bridge Layer

### Responsibilities

- 为前端提供统一 IPC 入口
- 屏蔽宿主命令细节
- 维持 renderer 不直接散落调用 Tauri 命令

### Required IPC Additions

在 `desktop/src/bridge/ipcRenderer.ts` 中新增：

- `localRuntime.getStatus()`
- `localRuntime.setConfig(payload)`
- `localRuntime.install(payload)`
- `localRuntime.repair(payload)`
- `localRuntime.start(payload?)`
- `localRuntime.stop()`
- `localRuntime.restart(payload?)`
- `localRuntime.fetchModels()`
- `localRuntime.getLogs(payload?)`
- `localRuntime.clearLogs()`
- `localRuntime.detectHardware()`
- `localRuntime.openInstallDir()`
- `localRuntime.openCacheDir()`

### Must Be Self-Developed

- IPC contract
- fallback shape
- 前后端 payload 类型定义

### Verification

- 所有新增 IPC 都至少从 Settings 真页走一遍
- Renderer 刷新后必须能恢复最后已知状态

## 3. RedBox Rust Host

### Responsibilities

- Local Runtime 的本机状态机
- 进程启动、停止、重启、探测、日志、恢复
- 对 Local Runtime management API 的轮询和封装
- 对前端暴露可预测 IPC

### Recommended New Module Layout

新增：

- `desktop/src-tauri/src/local_runtime/mod.rs`
- `desktop/src-tauri/src/local_runtime/types.rs`
- `desktop/src-tauri/src/local_runtime/config.rs`
- `desktop/src-tauri/src/local_runtime/detect.rs`
- `desktop/src-tauri/src/local_runtime/launcher.rs`
- `desktop/src-tauri/src/local_runtime/health.rs`
- `desktop/src-tauri/src/local_runtime/logs.rs`
- `desktop/src-tauri/src/local_runtime/manager.rs`
- `desktop/src-tauri/src/local_runtime/client.rs`
- `desktop/src-tauri/src/local_runtime/storage.rs`

### Responsibilities Per Module

`types.rs`

- `LocalRuntimeStatus`
- `LocalRuntimeConfig`
- `LocalRuntimeHealth`
- `LocalRuntimeInstallProgress`
- `LocalRuntimeModelRecord`
- `LocalRuntimeLogChunk`

`config.rs`

- 本地 runtime 配置解析
- 安装目录 / cache 目录 / 端口 / token
- 默认 profile

`detect.rs`

- OS / arch
- GPU 检测
- Python / runtime 可执行探测
- 端口占用
- 目录权限

`launcher.rs`

- 拉起 Local Runtime 管理进程
- 注入必要 env
- 记录 pid
- 负责 stop / restart

`health.rs`

- 区分：
  - process running
  - management API reachable
  - inference API reachable
  - model loaded
  - warmup completed

`logs.rs`

- 环形缓冲
- stdout/stderr 分类
- 日志截断
- tail 查询

`manager.rs`

- 全局状态机
- 单实例约束
- 自动恢复策略
- 轮询任务

`client.rs`

- 访问 Local Runtime management API
- 不把复杂 HTTP 细节散落到 commands

`storage.rs`

- 统一管理 runtime metadata
- 安装目录、版本记录、最近错误、最近成功启动信息

### AppState Changes

新增：

- `local_runtime_state: Mutex<LocalRuntimeManagerState>`

不要复用现有 `assistant_sidecar` 字段，因为二者职责和复杂度不同。

### Commands Layer Changes

建议新增：

- `desktop/src-tauri/src/commands/local_runtime.rs`

并在 `main.rs` 中只做接线，不在 `main.rs` 里堆叠逻辑。

### Must Be Self-Developed

- 全套状态机
- 健康检查封装
- 日志与恢复逻辑
- 与现有 settings/store 的持久化绑定

### Can Reuse Existing Libraries

- `reqwest`
- `tokio`
- 现有事件发射体系
- 现有 store / persistence 模式

### Performance Rules

- 所有探测和轮询都必须异步
- 持锁只读最小快照，锁外执行 I/O
- 健康检查结果缓存，避免设置页频繁打开时重复猛打本地 API

## 4. RedBox Local Runtime Package

### Responsibilities

- 承载本地 Python 推理环境
- 管理模型下载和缓存
- 提供管理 API
- 启停 vLLM 推理服务
- 提供最小安装器和修复器

### Recommended Directory Layout

建议在仓库根目录新增：

- `local-runtime/README.md`
- `local-runtime/runtime-manager/`
- `local-runtime/runtime-manager/app.py`
- `local-runtime/runtime-manager/api/`
- `local-runtime/runtime-manager/services/`
- `local-runtime/runtime-manager/models/`
- `local-runtime/runtime-manager/install/`
- `local-runtime/runtime-manager/diagnostics/`
- `local-runtime/packaging/`
- `local-runtime/packaging/linux/`
- `local-runtime/packaging/mac/`
- `local-runtime/packaging/windows/`

### Internal Module Breakdown

`runtime-manager`

- 管理 HTTP API
- 子进程生命周期
- 进度回报
- 日志

`engine adapter: vllm`

- 生成 `vllm serve` 参数
- 维护模型 profile
- 启动推理服务

`model installer`

- 下载模型
- 检查模型完整性
- 维护 manifest

`diagnostics`

- Python 环境自检
- torch / CUDA / 驱动自检
- 权限与目录自检

`repair`

- 缓存损坏清理
- 版本不兼容提示
- 重新下载 runtime 组件

### Management API

建议提供单独管理 API，例如：

- `GET /runtime/health`
- `GET /runtime/version`
- `GET /runtime/install-status`
- `POST /runtime/install`
- `POST /runtime/repair`
- `POST /runtime/start`
- `POST /runtime/stop`
- `POST /runtime/restart`
- `GET /runtime/models`
- `POST /runtime/models/install`
- `POST /runtime/models/remove`
- `GET /runtime/logs`
- `GET /runtime/hardware`

### Inference API

由 `vLLM` 暴露：

- `/v1/models`
- `/v1/chat/completions`
- 后续可选：
  - `/v1/embeddings`
  - `/v1/audio/transcriptions`

### Security Rules

- 只绑定 `127.0.0.1`
- 每次安装生成本地 token
- 管理 API 与推理 API 都要求 token
- 日志中禁止明文打印完整 token

### Must Use Existing Libraries

- `vLLM`
- `PyTorch`
- 平台对应 backend
- Python HTTP framework：建议 `FastAPI + uvicorn`

### Must Be Self-Developed

- runtime-manager
- engine profile
- 模型 manifest
- 修复与升级逻辑
- 管理 API

## 5. AI Runtime Integration

### Core Principle

不重写现有 Chat/Wander 主执行链，只把 Local Runtime 视为新的受管 AI source。

### Integration Points

- `desktop/src-tauri/src/runtime/config_runtime.rs`
- `desktop/src-tauri/src/runtime/types.rs`
- `desktop/src/config/aiSources.ts`
- `desktop/src/pages/Settings.tsx`

### Required Behavior

当用户选择本地模型时：

- `baseURL` 指向 `http://127.0.0.1:<inference-port>/v1`
- `apiKey` 指向本地 token
- `modelName` 指向选定模型
- `protocol` 保持 `openai`

### No-Change Zones

以下区域不应因为本次迁移被重写：

- `llm_transport/openai.rs`
- `provider_runtime/openai.rs`
- 工具调用主循环
- prompt / skill 的语义边界

### Required Enhancements

- 新增“本地 runtime 未运行时的错误归因”
- 新增“模型未安装 / 模型未加载”的结构化错误
- `ai:fetch-models` 在本地源场景下优先走 management API 的缓存结果，失败再 fallback 到 `/v1/models`

## 6. Video Processing Boundary

### Decision

视频处理链保持独立，不并入 Local Runtime。

### Why

- `ffmpeg`、`remotion`、媒体探测、转码、导出是独立重负载链路
- 把它们塞进 Local Runtime 会让 runtime 变成 god process
- 视频失败与本地 LLM 失败的恢复逻辑完全不同

### Required Product Behavior

- 本地 LLM 仅用于文案生成、规划、知识问答、脚本建议、结构化工具调用
- 视频生成、封面、素材处理继续走现有媒体链
- 未来若要接本地转写，也必须作为显式可选能力，而不是默认和 vLLM 文本服务捆绑

## 7. Packaging And Distribution

### RedBox Main Package

保持现有交付形态：

- macOS: `app`, `dmg`
- Windows: `nsis`
- Linux: `app`

`RedBox` 主包仅包含：

- UI
- Rust host
- 轻量静态资源
- Local Runtime 安装器入口

不包含：

- vLLM wheel
- torch wheel
- CUDA runtime
- 模型文件

### Local Runtime Package

作为独立交付物：

- `RedBox Local Runtime Installer`
- 独立版本号
- 独立签名
- 独立升级

### Tauri Integration

Tauri sidecar 机制可以用于受管本地二进制的嵌入与拉起，但这里推荐两层策略：

1. RedBox 主包内只内嵌极小的 bootstrap / installer helper
2. 真正的 Local Runtime 安装到独立目录后，由 Rust host 管理其进程

这样做的原因：

- 不把重型 runtime 直接绑进主包 resources
- 更新 runtime 时不需要整体替换主应用
- 安装失败、修复和回滚更清晰

### Platform Support Matrix

推荐正式支持矩阵：

| 平台 | Local Runtime 架构 | 受管 vLLM | 产品结论 |
| --- | --- | --- | --- |
| Linux x86_64 + NVIDIA | 支持 | 正式支持 | 首发正式支持平台 |
| macOS Apple Silicon | 支持 | 不作为正式默认支持 | 保留实验/后续能力 |
| Windows x86_64 | 支持 | 不作为正式默认支持 | 保留外部服务连接能力 |

原因：

- `vLLM` 官方 GPU 路线当前要求 Linux，且明确不原生支持 Windows。
- Apple Silicon 路线当前仍偏实验/源码构建。

### Upgrade Strategy

版本分离：

- `RedBox app version`
- `Local Runtime version`
- `Installed model manifest version`

兼容策略：

- RedBox 要维护一份 `compatible runtime version range`
- 当 runtime 版本过旧时，UI 给出“升级 runtime”
- 当模型 manifest 版本过旧时，runtime 自己负责迁移

## 8. Storage Layout

建议目录布局：

- `~/.redbox/local-runtime/`
  - `bin/`
  - `env/`
  - `logs/`
  - `state/`
  - `models/`
  - `cache/`
  - `manifests/`

目录职责：

- `bin/`：bootstrap 与管理程序
- `env/`：Python environment
- `logs/`：runtime 日志
- `state/`：pid、port、token、health snapshot
- `models/`：已安装模型
- `cache/`：下载缓存
- `manifests/`：模型和 runtime 版本元数据

## 9. Data Contracts

### LocalRuntimeConfig

建议字段：

```ts
type LocalRuntimeConfig = {
  installDir: string;
  cacheDir: string;
  engine: 'vllm';
  managementPort: number;
  inferencePort: number;
  authToken: string;
  autoStart: boolean;
  keepWarm: boolean;
  defaultModelId?: string;
  gpuPolicy: 'auto' | 'force_gpu' | 'force_cpu';
  startupTimeoutMs: number;
  healthCheckIntervalMs: number;
};
```

### LocalRuntimeStatus

建议字段：

```ts
type LocalRuntimeStatus = {
  installed: boolean;
  installState: 'missing' | 'installing' | 'installed' | 'repairing' | 'failed';
  processState: 'stopped' | 'starting' | 'running' | 'degraded' | 'failed';
  managementApiReady: boolean;
  inferenceApiReady: boolean;
  activeEngine?: 'vllm';
  activeModelId?: string;
  pid?: number;
  managementPort?: number;
  inferencePort?: number;
  version?: string;
  lastError?: string;
  updatedAt: string;
};
```

### LocalRuntimeModelRecord

建议字段：

```ts
type LocalRuntimeModelRecord = {
  id: string;
  displayName: string;
  source: 'huggingface' | 'modelscope' | 'local';
  family: 'qwen' | 'llama' | 'mistral' | 'other';
  capabilities: Array<'chat' | 'embedding' | 'transcription'>;
  quantization?: string;
  contextWindow?: number;
  diskUsageBytes?: number;
  installState: 'not_installed' | 'downloading' | 'installed' | 'broken';
  localPath?: string;
};
```

## 10. Execution Plan

下面不是“先做一点试试”的分阶段产品路线，而是完整目标架构下的执行顺序。执行时必须一次性按完整边界推进，避免再回到“临时脚本 + 手填 endpoint”的中间态。

### Workstream A: Contract First

输出：

- `LocalRuntimeConfig`
- `LocalRuntimeStatus`
- `LocalRuntimeModelRecord`
- IPC payload schema
- management API schema

执行：

1. 定义 TypeScript 类型和 Rust 对应结构。
2. 明确 settings 中的持久化字段。
3. 明确 RedBox 与 Local Runtime 之间的 HTTP contract。

完成标准：

- 前后端与 runtime manager 使用同一份字段语义
- 任何错误状态都能结构化表达

### Workstream B: RedBox Host Runtime Manager

输出：

- `local_runtime/*` Rust 模块
- IPC / commands
- 状态缓存

执行：

1. 在 Rust host 中新增 `local_runtime` 模块。
2. 实现状态机、探针、日志 ring buffer、进程管理。
3. 接入 `commands/local_runtime.rs`。
4. 通过事件层向前端广播 runtime 状态变更。

完成标准：

- 即使 Local Runtime 尚未安装，也能稳定返回结构化状态
- 启停和重启不阻塞 UI 线程

### Workstream C: RedBox Settings UI

输出：

- Local Runtime 设置页
- 模型安装和绑定面板
- 诊断与日志面板

执行：

1. 在 `Settings.tsx` 新增本地 runtime 状态装配。
2. 在 `SettingsSections.tsx` 新增 Local Runtime 分组。
3. 把本地模型映射回现有 AI source 配置。

完成标准：

- 用户无需手填 endpoint 也能完成本地模型配置
- 刷新后仍能恢复最后一次成功状态

### Workstream D: Local Runtime Package

输出：

- `local-runtime/` 新包
- 管理 API
- vLLM engine adapter
- installer / repair 流程

执行：

1. 实现 runtime-manager。
2. 实现 vLLM 启动 profile。
3. 实现模型安装和 manifest。
4. 实现 repair 与 diagnostics。

完成标准：

- 能独立启动、停止、查询状态
- 能输出明确诊断结论

### Workstream E: Packaging And Release

输出：

- Local Runtime 独立构建脚本
- 主包调用安装器入口
- 版本兼容策略

执行：

1. 新增 `local-runtime` 构建脚本。
2. 主包接入安装器和升级器入口。
3. 文档化签名、升级和回滚策略。

完成标准：

- RedBox 主包不因 Local Runtime 失败而无法发布
- Local Runtime 可单独升级

### Workstream F: Verification

输出：

- 验证矩阵
- 故障注入 checklist
- 平台级 smoke test

执行：

1. 跑真机安装。
2. 跑真机启动本地模型。
3. 跑 Chat/Wander/Knowledge 真查询。
4. 注入故障并观察恢复。

完成标准：

- 所有关键失败路径都有可执行修复动作

## 11. Verification Matrix

### RedBox UI

- Settings 打开时应立即显示上次已知状态
- 切页时不可整页阻塞
- 安装失败时保留已知状态并给出内联错误

### Host Manager

- 未安装 runtime 时 `getStatus` 返回结构化缺失态
- 端口冲突时能报告冲突而不是挂死
- stop / restart 后状态一致

### Local Runtime

- 安装完成后能返回版本信息
- start 后 management API 先 ready，再 inference API ready
- `/runtime/models` 与 `/v1/models` 数据一致

### AI Runtime

- Chat 使用本地模型能完成一次真实问答
- Wander 能完成一次真实任务并通过工具调用循环
- `ai:fetch-models` 在本地源上返回正确模型列表

### Failure Injection

- 模型目录缺失
- token 错误
- inference port 被占用
- management API 正常但 inference API 启动失败
- runtime 进程被外部 kill
- 日志目录不可写

### Performance

- 设置页状态刷新不阻塞首屏
- 日志查询不一次性读全量历史
- 健康探针有缓存与退避
- 模型列表使用缓存快照 + 后台刷新

## 12. Performance Optimization Strategy

### 1. RedBox 侧

- `stale-while-revalidate` 显示 runtime 状态
- 健康检查结果缓存 2 到 5 秒
- 大日志仅取 tail
- 模型列表分页或按需展开

### 2. Host 侧

- 锁内只维护快照，锁外做 HTTP 和文件 I/O
- 对 management API 轮询做指数退避
- 对崩溃恢复设置上限，防止重启风暴

### 3. Local Runtime 侧

- 模型启动采用 profile，避免每次重新推导复杂参数
- 下载器分块和断点续传
- 模型 manifest 单独缓存，避免每次扫描整个模型目录
- 区分 install progress 与 model warmup progress

### 4. 推理链

- 不在每次 Chat 请求前重新探测 runtime 健康
- 推理失败先基于最近健康快照快速归因，再触发后台复检

## 13. Risks And Mitigations

### 风险 1：把 Local Runtime 做成新的 god service

风险：

- 文本推理、模型安装、视频处理、转写、媒体下载全部塞进一个进程

缓解：

- Local Runtime 只负责本地 AI runtime
- 视频、ffmpeg、remotion 保持独立

### 风险 2：主包与 runtime 版本漂移

风险：

- RedBox 升级后找不到兼容 runtime

缓解：

- 主包维护兼容范围
- runtime 提供版本查询
- 不兼容时 UI 阻止启用并给出升级入口

### 风险 3：平台支持预期过高

风险：

- 用户误以为 macOS / Windows 上也有正式受管 vLLM 支持

缓解：

- 在产品和文档中明确支持矩阵
- 在不支持平台仅提供“连接外部本地服务”或实验标记

### 风险 4：模型下载与磁盘占用失控

风险：

- 模型巨大，安装失败或占满磁盘

缓解：

- 安装前做磁盘预检
- 展示预计体积
- 提供缓存清理和模型卸载

## 14. Related Files

- `desktop/src/config/aiSources.ts`
- `desktop/src/pages/Settings.tsx`
- `desktop/src/pages/settings/SettingsSections.tsx`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src-tauri/src/runtime/config_runtime.rs`
- `desktop/src-tauri/src/runtime/types.rs`
- `desktop/src-tauri/src/llm_transport/openai.rs`
- `desktop/src-tauri/src/provider_runtime/openai.rs`
- `desktop/src-tauri/src/assistant_core.rs`
- `desktop/src-tauri/src/commands/assistant_daemon.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/scripts/build-mac-release.mjs`
- `desktop/scripts/build-windows-release.mjs`

## 15. Final Recommendation

RedBox 应当把“本地模型能力”建设成一个完整的产品级基础设施层，而不是继续维持“手动填写本地 endpoint”的弱集成形态。

最佳落地方式是：

- `RedBox` 持有完整控制面 UI
- `RedBox Local Runtime` 持有无头执行面
- `vLLM` 仅作为 Local Runtime 内部的推理引擎之一
- 现有 AI 调用主链继续复用 OpenAI-compatible 接口
- 视频处理链保持独立

这条路线对现有 Chat/Wander 主逻辑的侵入并不大，但会新增一层必须认真实现的 runtime 管理基础设施。只要这一层一次性做对，后续接 `Ollama / llama.cpp / 其他本地引擎` 都会明显更稳，而不会继续累积一次性脚手架。
