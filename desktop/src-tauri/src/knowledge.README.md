# `knowledge.rs` 模块

## 职责

- 提供知识库 workspace-first 写入与变更操作。
- 定义统一 ingest contract，供旧 IPC、本地 HTTP、未来其他 adapter 复用。
- 在落盘后刷新 knowledge 投影，并发出兼容事件。

## 当前覆盖

- `knowledge:ingest-entry`
- `knowledge:ingest-document-source`
- `knowledge:batch-ingest`
- `knowledge:health`
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
- 本地 HTTP 入口挂在 assistant daemon 上，默认根路径是 `/api/knowledge`。

## 本地 HTTP 路由

- `GET /api/knowledge/health`
- `POST /api/knowledge/entries`
- `POST /api/knowledge/document-sources`
- `POST /api/knowledge/batch-ingest`

## 相关本地文档

- 打包资源页：`src-tauri/resources/knowledge-api-guide.html`
