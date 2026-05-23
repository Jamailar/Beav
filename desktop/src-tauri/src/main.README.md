# `main.rs`

## 职责

- Tauri 入口与生命周期管理。
- 管理全局状态实例，但不定义 `AppState` / `AppStore` 结构。
- 顶层模块装配与对外函数汇总（`mod ...` 与 re-export）。
- Tauri command registration 与 `.setup(...)` / `.run(...)` 顶层生命周期。

## 维护规则

- 新业务能力优先放入独立模块，`main.rs` 仅保留入口、装配和必要薄封装。
- 发生拆分时，同步更新对应模块 README。
- `host_impl.rs` 是 Phase 3 兼容承接层，只用于从 `main.rs` 移走历史 host glue；新增业务不得继续写入这里。
