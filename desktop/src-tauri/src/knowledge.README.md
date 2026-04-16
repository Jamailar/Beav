# `knowledge.rs` 模块

## 职责

- 提供知识库 workspace-first 写入与变更操作。
- 将旧 channel 的知识写入逻辑收敛为统一 helper。
- 在落盘后刷新 knowledge 投影，并发出兼容事件。

## 当前覆盖

- `youtube:save-note`
- `knowledge:delete-youtube`
- `knowledge:retry-youtube-subtitle`
- `knowledge:youtube-regenerate-summaries`
- `knowledge:delete`
- `knowledge:transcribe`
- `knowledge:docs:add-*`
- `knowledge:docs:delete-source`

## 约束

- `workspace/knowledge/**` 是知识内容真相源。
- `AppStore` 中的 knowledge 数据只作为投影与缓存，不应再直接成为写入真相层。
- 新入口应优先复用本模块，而不是在 command 层再次直接 `push/retain` knowledge store。
