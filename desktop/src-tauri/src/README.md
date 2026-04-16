# Rust 模块结构（`src-tauri/src`）

本目录是 RedBox 桌面端 Rust Host 的主实现，当前按“入口 + 顶层能力模块 + 命令分发模块”组织。

## 顶层模块

- `main.rs`：应用入口、状态定义、Tauri 生命周期、模块装配。
- `commands/`：IPC/频道命令处理层（按业务域拆分）。
- `events/`：统一事件发射与前端兼容事件桥接。
- `persistence/`：本地状态读取、持久化、工作区 hydrate。
- `scheduler/`：后台调度计算、任务派生状态。
- `runtime.rs`：运行时核心类型与通用运行时辅助。
- `knowledge.rs`：知识库 workspace-first 写入与旧入口适配。
- `*_helpers/*.rs`：按能力拆分的辅助与执行模块（profile、mcp、io、media、import 等）。

## 文档约定

- 目录模块：在目录下提供 `README.md`。
- 单文件模块：在同级提供 `模块名.README.md`。
- 每次拆分 `main.rs` 时，必须同步更新对应模块 README 的“职责”和“对外接口”。
