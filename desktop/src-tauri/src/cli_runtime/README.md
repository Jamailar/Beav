# `src-tauri/src/cli_runtime/`

CLI runtime host control plane 的基础模块目录。

## 当前职责

- `types.rs`：CLI runtime 的 canonical record / request / verifier 类型
- `path_env.rs`：宿主 shell 环境加载与 PATH 合并
- `detector.rs`：CLI 可执行探测与版本探针
- `environment_store.rs`：app-global / workspace-local / task-ephemeral 生命周期
- `runtime_resolver.rs`：环境选择与复用规则
- `manifest_store.rs`：tool registry / dynamic manifest 持久化
- `introspection.rs`：CLI `--help` / `help` 解析与动态 manifest 生成
- `installers/*`：按安装器类型生成 install plan
- `sandbox.rs`：执行前 sandbox 规格、macOS `sandbox-exec` profile 与 launch plan
- `pty.rs`：交互式执行 transport 抽象
- `process_store.rs`：execution record 与 stdout/stderr 日志落盘
- `events.rs`：CLI runtime 到统一 `runtime:event` 的最小事件映射
- `executor.rs`：最小同步执行器
- `verify.rs`：执行后校验与 verification record 持久化

## 当前边界

- 当前已覆盖基础域模型、探测、环境存储、resolver、执行、install/verify 路由与最小事件接线
- `app_cli(action="cli_runtime.*")` 已作为 canonical runtime surface 暴露给 diagnostics / redclaw runtime
- 已拆出 installer backend、sandbox spec 和 terminal transport 抽象，并在 macOS 上接入 `sandbox-exec` 作为受控执行 backend
- Settings 已提供 CLI Runtime install composer 与 recent install queue
- 视频 `ffmpeg` / `remotion` 执行路径已经迁移到 CLI runtime
- 仍保留 pipes-backed PTY transport；如需更完整终端仿真，可在后续替换为 dedicated PTY backend
