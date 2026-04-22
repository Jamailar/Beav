# `src-tauri/src/cli_runtime/`

CLI runtime host control plane 的基础模块目录。

## 当前职责

- `types.rs`：CLI runtime 的 canonical record / request / verifier 类型
- `path_env.rs`：宿主 shell 环境加载与 PATH 合并
- `detector.rs`：CLI 可执行探测与版本探针
- `environment_store.rs`：app-global / workspace-local / task-ephemeral 生命周期
- `runtime_resolver.rs`：环境选择与复用规则

## 当前边界

- 本次已覆盖基础域模型、探测、环境存储与 resolver
- command surface、执行器、策略、校验、事件接线在后续原子提交继续补齐
