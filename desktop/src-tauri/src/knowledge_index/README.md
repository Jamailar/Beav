# `src-tauri/src/knowledge_index/`

本目录承载知识索引目录、schema、后台任务和文件监听能力。

## Main Files

- `schema.rs`: 索引 schema 初始化
- `catalog.rs`: 索引目录查询
- `canonical_store.rs`: canonical document 缓存与复用
- `document_blocks.rs`: block 级索引构建与查询
- `indexer.rs`: 索引构建
- `jobs.rs`: 异步任务和重建调度
- `watcher.rs`: 目录监听
- `fingerprint.rs`: 变更识别

## Rules

- 索引运行时状态只保留必要内存字段，持久索引数据放 `.redbox/index/`
- 监听和重建逻辑不能阻塞页面进入路径
- index status 需要提供稳定的最小摘要，不返回大数据包
- block 索引建立在 canonical document 层之上，不直接依赖原始文件扫描
- 文件未变更时优先复用 canonical cache，避免重复解析

## Verification

- 验证索引初始化
- 验证 rebuild、watcher 和状态读取
