# Tauri Host Development Guide

Status: Current

## Scope

适用于 `src-tauri/src/` 下的 command、runtime、persistence、scheduler、events 及相关宿主能力。

## Entry Points

- `src-tauri/src/main.rs`
- `src-tauri/src/commands/`
- `src-tauri/src/events/`
- `src-tauri/src/persistence/`
- `src-tauri/src/runtime/`
- `src-tauri/src/scheduler/`

## Rules

- `main.rs` 只做状态、插件、命令注册和启动恢复。
- page-facing command 默认写成 `async`。
- 重 CPU 工作放 `spawn_blocking`。
- 文件系统和 hydrate 逻辑放到 `persistence/` 或 `workspace_loaders.rs`。
- 事件统一从 `events/` 发射，不要在命令里散发兼容事件。

## Change Checklist

1. 先确认是新增 command、事件、运行时能力，还是已有能力的延伸。
2. 明确数据是否属于内存状态、workspace 文件或外部服务。
3. 把慢操作移出锁。
4. 给 renderer 提供稳定 fallback shape。
5. 跑真实调用验证，而不只看编译通过。

## Verification

- `cargo fmt --check`
- `cargo check`
- 对应 renderer 调用
- 如涉及事件：验证前端能收到并正确过滤
- 如涉及 workspace：验证重启后状态可恢复
