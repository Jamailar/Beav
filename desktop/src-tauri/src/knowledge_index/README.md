# `src-tauri/src/knowledge_index/`

本目录承载知识索引目录、schema、后台任务和文件监听能力。

## Main Files

- `schema.rs`: 索引 schema 初始化
- `catalog.rs`: 索引目录查询
- `canonical_store.rs`: canonical document 缓存与复用
- `citation_anchors.rs`: citation anchor 构建、读取和查询
- `document_blocks.rs`: block 级索引构建与查询
- `indexer.rs`: 索引构建
- `document_parse/legal_metadata.rs`: 法律元数据抽取与日期/法域识别
- `document_parse/ocr.rs`: 扫描 PDF / 图片 OCR 解析
- `hybrid.rs`: sparse expansion、dense lane、RRF 融合与离线评测
- `evaluation.rs` (test-only): release gate fixture、grounding audit、发布阈值校验
- `jobs.rs`: 异步任务和重建调度
- `watcher.rs`: 目录监听
- `fingerprint.rs`: 变更识别

## Rules

- 索引运行时状态只保留必要内存字段，持久索引数据放 `.redbox/index/`
- 监听和重建逻辑不能阻塞页面进入路径
- index status 需要提供稳定的最小摘要，不返回大数据包
- block 索引建立在 canonical document 层之上，不直接依赖原始文件扫描
- 文件未变更时优先复用 canonical cache，避免重复解析
- Stage 4 起 block 命中会附带 `legalMetadata`，并使用 `lexical score + legal score` 排序
- 已失效/废止文档需要在结果里显式标记，不能只做隐藏降权
- Stage 5 起 OCR block 会显式带 `contentOrigin=ocr` 和 `ocrConfidence`
- 扫描 PDF 先走原生文本抽取；失败或为空时才回退到 OCR，避免把 native PDF 和 OCR PDF 混为一类
- Stage 6 起 `knowledge.search` 默认走 hybrid，可通过 `retrievalMode=lexical` 关闭增强链路
- hybrid 排序输出需要显式带 `retrievalLanes` 和 ranking breakdown，不能把 fusion / rerank 变成黑盒
- Stage 7 起 release gate 依赖固定 fixture 测试；任一阈值不达标都应直接阻塞发布

## Verification

- 验证索引初始化
- 验证 rebuild、watcher 和状态读取
