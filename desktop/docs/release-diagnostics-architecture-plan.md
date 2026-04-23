---
doc_type: plan
execution_status: completed
last_updated: 2026-04-23
---

# RedBox Release Diagnostics Architecture

## Scope

本方案把桌面端原有的 `debug_logs`、stdout/stderr 和 session/task trace 升级为一套正式版可用的诊断平台，覆盖：

- Host 结构化日志
- Renderer 异常桥接
- 诊断包生成与本地队列
- 用户确认后的上传链路
- Web 接收端持久化

## Product Architecture

### 1. Host Logging Core

主实现位于 [desktop/src-tauri/src/logging/](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/logging/)。

- `mod.rs`
  - 初始化全局 runtime
  - 暴露统一 facade
  - 处理 recent preview、pending report、bundle export、upload
- `config.rs`
  - 定义 retention、单文件大小、recent preview、raw body 截断、上传端点等配置
- `event.rs`
  - 统一日志事件 schema
  - 定义 `LogSource`、`LogLevel`、`DiagnosticReportRecord`
- `redaction.rs`
  - 本地版与上传版两级脱敏
- `memory_sink.rs`
  - 设置页最近日志预览 ring buffer
- `file_sink.rs`
  - NDJSON 文件写入、轮转、zstd 归档
- `panic_hook.rs`
  - panic hook、异常退出标记、下次启动恢复检测
- `report_builder.rs`
  - 截取最近日志窗口并生成 zip 诊断包
- `upload_queue.rs`
  - `pending/uploaded/failed/export` 队列管理

日志目录固定为：

- `logs/current/host.ndjson`
- `logs/current/renderer.ndjson`
- `logs/current/crash.ndjson`
- `logs/archive/*.zst`
- `diagnostic-reports/pending/*.json`
- `diagnostic-reports/uploaded/*.json`
- `diagnostic-reports/failed/*.json`
- `diagnostic-reports/export/*.zip`

### 2. Legacy Bridge

[desktop/src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs) 中原有的：

- `append_debug_trace_global`
- `append_debug_log_state`
- `append_debug_trace_state`

已改为接入 logging facade，不再直接依赖 `eprintln!` 作为主诊断通道。`debug_log_enabled` 保留，但仅控制 verbose 级 trace 和 recent preview 行为，不控制正式版文件日志。

### 3. Renderer Diagnostics

Renderer 侧桥接位于：

- [desktop/src/logging/client.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/logging/client.ts)
- [desktop/src/main.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/main.tsx)
- [desktop/src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts)

接入点：

- `window.onerror`
- `window.onunhandledrejection`
- React `ErrorBoundary.componentDidCatch`

Renderer 不直接写本地文件，而是通过 `logs:append-renderer` 交给 host，统一进入 `renderer.ndjson`。

### 4. Settings And User Actions

设置页接入位于：

- [desktop/src/pages/Settings.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Settings.tsx)
- [desktop/src/pages/settings/SettingsSections.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/settings/SettingsSections.tsx)

用户能力包括：

- 查看日志状态
- 打开日志目录
- 查看 recent preview
- 手动生成并导出当前诊断包
- 查看 pending report 列表
- 对单个 pending report 执行导出、上传、删除
- 配置 verbose trace、高级上下文、上传同意策略、保留天数、单文件上限

### 5. Server Ingest

Web 接收端位于：

- [RedBoxweb/app/api/v1/client-diagnostics/reports/route.ts](/Users/Jam/LocalDev/GitHub/RedConvert/RedBoxweb/app/api/v1/client-diagnostics/reports/route.ts)
- [RedBoxweb/app/lib/diagnostics/reports.ts](/Users/Jam/LocalDev/GitHub/RedConvert/RedBoxweb/app/lib/diagnostics/reports.ts)
- [RedBoxweb/app/lib/env.ts](/Users/Jam/LocalDev/GitHub/RedConvert/RedBoxweb/app/lib/env.ts)

接口契约：

- `POST /api/v1/client-diagnostics/reports`
- `multipart/form-data`
- 字段：
  - `metadata`
  - `bundle`

服务端职责：

- 校验 metadata 基本字段
- 校验 bundle MIME 和大小
- 计算 `dedupeKey`
- 存储 `metadata.json + bundle.zip/.zst`
- 按 30 天保留期自动清理旧报告

默认存储目录来自 `DIAGNOSTICS_STORAGE_DIR`，未配置时回退到 `RedBoxweb/.diagnostics-reports`。

## Required Libraries vs Self-Built Modules

### Must Use Existing Libraries

- Rust:
  - `reqwest`
  - `serde`
  - `serde_json`
  - `zip`
  - `zstd`
- Web:
  - Next.js Route Handlers
  - Node `fs/promises`
  - Node `crypto`

### Must Be Custom

- 诊断事件 schema
- redact 规则
- pending/uploaded/failed 队列
- crash recovery 语义
- session/task trace 和诊断包的拼装规则
- renderer -> host 的日志桥
- 诊断包的裁剪和导出策略

## Performance Strategy

- 文件写入通过后台 worker 完成，主线程只 enqueue。
- recent preview 限制为 ring buffer，默认 200 条。
- `rawBody` 本地和上传分级截断，避免大响应拖垮 I/O。
- 诊断包只截最近时间窗口，默认 10 分钟。
- 日志轮转后归档到 `.zst`，避免长期膨胀。
- renderer 只上报关键异常，不把所有 `console.*` 全量转储。
- pending report 上传不自动重试主流程，失败保留本地等待用户再次操作。

## Current Gaps

- 上传端点目前依赖 host 侧编译时环境变量配置。
- 服务端已支持接收和落盘，但还没有后台检索/管理后台。
- 现阶段未把所有旧 `console.error` catch 分支逐一替换为 `reportRendererError`，优先覆盖了全局异常和 ErrorBoundary。
