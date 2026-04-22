# `persistence/` 模块

## 职责

- 构建/定位本地状态文件路径。
- 读写 `AppStore` 持久化状态。
- 将工作区文件系统数据 hydrate 到内存状态。

## 关键点

- 所有状态写入应通过 `with_store_mut`，避免绕过持久化。
- hydrate 逻辑依赖 `workspace_loaders`，禁止在命令层重复实现文件扫描。
- `redbox-state.json` 现在只保留主快照；高体积会话产物会拆到同级 `session-artifacts/` 目录，按 session 单文件持久化。
- 加载旧快照时会自动把内嵌的 `chatMessages`、`sessionTranscriptRecords`、`sessionCheckpoints`、`sessionToolResults` 迁移到 `session-artifacts/`，并在后续保存时保持主文件瘦身。
