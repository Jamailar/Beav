# `src-tauri/src/cli_runtime/`

CLI runtime host control plane 的基础模块目录。

## 当前职责

- `types.rs`：CLI runtime 的 canonical record / request / verifier 类型
- `path_env.rs`：宿主 shell 环境加载与 PATH 合并
- `detector.rs`：CLI 可执行探测与版本探针

## 当前边界

- 本次仅落地基础域模型与探测能力
- command surface、执行器、策略、校验、事件接线在后续原子提交继续补齐
