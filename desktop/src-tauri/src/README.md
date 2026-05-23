# Rust 模块结构（`src-tauri/src`）

本目录是 RedBox 桌面端 Rust Host 的主实现，当前按“入口 + 顶层能力模块 + 命令分发模块”组织。

## 顶层模块

- `main.rs`：应用入口、Tauri builder / command registration / top-level run lifecycle。
- `app_state.rs`：Tauri managed state、runtime handles 与 global debug handle。
- `store/types.rs`：`AppStore` 与本地持久化 record structs。
- `workspace/paths.rs`：workspace/store/media/knowledge/subject/advisor path helpers。
- `channel_router.rs`：`window.ipcRenderer.invoke` channel fanout。
- `startup/`：store startup preparation、runtime restore、background housekeeping。
- `host_impl.rs`：Phase 3 兼容承接层，暂存历史 host glue 与 interactive runtime helpers，后续按领域继续拆分。
- `commands/`：IPC/频道命令处理层（按业务域拆分）。
- `commands/manuscripts.rs` + `commands/manuscripts/`：稿件 IPC router plus tree/package/post/richpost/editor-project/timeline/Remotion/layout channel handlers.
- `commands/official.rs` + `commands/official/`：官方账号/计费/model/API key IPC router plus auth/account/api-key/billing/model channel handlers.
- `document_ingest/`：文档源接入层，负责 copied-file / tracked-folder / vault 注册与 workspace 托管复制。
- `events/`：统一事件发射与前端兼容事件桥接。
- `media_generation.rs` + `media_generation/`：AI media provider adapter layer；parent keeps shared settings/transport/embedding helpers, `image.rs` owns image request/provider logic, and `video.rs` owns video request/provider logic.
- `persistence/`：本地状态读取、持久化、工作区 hydrate。
- `scheduler/`：后台调度计算、任务派生状态。
- `runtime.rs`：运行时核心类型与通用运行时辅助。
- `knowledge.rs`：知识库 workspace-first 写入、batch ingest 编排、本地 HTTP 适配。
- `*_helpers/*.rs`：按能力拆分的辅助与执行模块（profile、mcp、io、media、import 等）。

## 文档约定

- 目录模块：在目录下提供 `README.md`。
- 单文件模块：在同级提供 `模块名.README.md`。
- 每次拆分 `main.rs` 时，必须同步更新对应模块 README 的“职责”和“对外接口”。
