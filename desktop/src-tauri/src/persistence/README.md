# `persistence/` 模块

## 职责

- 构建/定位本地状态文件路径。
- 读写 `AppStore` 持久化状态。
- 将工作区文件系统数据 hydrate 到内存状态。

## 关键点

- 所有状态写入应通过 `with_store_mut`，避免绕过持久化。
- hydrate 逻辑依赖 `workspace_loaders`，禁止在命令层重复实现文件扫描。
