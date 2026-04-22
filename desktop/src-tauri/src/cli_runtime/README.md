# `src-tauri/src/cli_runtime/`

CLI runtime host control plane 的基础模块目录。

## 当前职责

- `types.rs`：CLI runtime 的 canonical record / request / verifier 类型
- `path_env.rs`：宿主 shell 环境加载与 PATH 合并
- `detector.rs`：CLI 可执行探测与版本探针
- `environment_store.rs`：app-global / workspace-local / task-ephemeral 生命周期
- `runtime_resolver.rs`：环境选择与复用规则
- `process_store.rs`：execution record 与 stdout/stderr 日志落盘
- `events.rs`：CLI runtime 到统一 `runtime:event` 的最小事件映射
- `executor.rs`：最小同步执行器
- `verify.rs`：执行后校验与 verification record 持久化

## 当前边界

- 当前已覆盖基础域模型、探测、环境存储、resolver、执行、install/verify 路由与最小事件接线
- `app_cli(action="cli_runtime.*")` 已作为 canonical runtime surface 暴露给 diagnostics / redclaw runtime
- 仍未覆盖后台取消、真正 PTY 托管和更细粒度 installer backend
