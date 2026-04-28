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
- `document_parse/visual_manifest.rs`: 图片/扫描 PDF 页的视觉语义 manifest schema、normalizer 和 retrieval projection
- `document_parse/visual_llm.rs`: OpenAI-compatible 多模态视觉索引调用与 metadata-only fallback
- `document_parse/pdf_pages.rs`: 扫描 PDF 页图渲染
- `hybrid.rs`: sparse expansion、dense lane、RRF 融合与离线评测
- `evaluation.rs` (test-only): release gate fixture、grounding audit、发布阈值校验
- `query_profile.rs`: 法律查询画像、检索粒度和默认 retrieval mode 推荐
- `migration.rs`: 检索 schema/index/canonical/parser/rerank 版本键与升级决策
- `retrieval_audit.rs`: indexed search 的 retrieval run / hit / evidence pack 审计落库
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
- 当前 lexical 主通道使用 SQLite FTS5 `bm25()` 召回与排序，保留 SQLite `LIKE` 兜底；最终目标仍是架构方案中的 `Tantivy + SQLite`
- 已失效/废止文档需要在结果里显式标记，不能只做隐藏降权
- 图片和扫描型 PDF 页走 `contentOrigin=visual_llm`，由 visual index model 直接生成结构化 manifest
- 扫描 PDF 先走原生文本抽取；失败或为空时渲染为页图并交给 visual index model，避免把 native PDF 和扫描 PDF 混为一类
- visual index provider 使用独立 `visual_index_*` 设置；模型不可用时生成 `metadata_only` manifest
- `visual_index_concurrency` 控制扫描 PDF 页级 visual LLM 调用的分批并发度，默认 1，上限 4
- visual manifest 必须通过 `retrievalProjection` 派生 block；block 需要写入 `visual_unit_id`、`source_document_id`、`evidence_refs_json`
- canonical visual manifest 需要同步到 `knowledge_visual_units` / `knowledge_visual_evidence`，搜索命中必须能回到原始图片文件或原始 PDF 页码
- `knowledge_visual_units` 是视觉索引台账，必须记录 `status`、`retry_count`、`last_error`、`next_retry_at`、`model`、`prompt_version`、`config_signature` 和 `payload_policy_version`；后台调度用它做失败冷却和模型配置漂移判断，不从 UI 状态推断
- `knowledge:get-index-status` 返回 `visualIndex` 摘要，包含 total/indexed/metadata_only/failed/retry_deferred/retry_ready，用于后台诊断视觉索引覆盖率
- `knowledge:get-file-index-dashboard` 是设置页“文件索引”面板的唯一聚合入口，必须同时覆盖文件发现、内容解析、文本索引、引用锚点、视觉索引、失败重试，以及全局知识库、文档源和 advisor/member knowledge；renderer 不应直接推断 SQLite 台账表。
- visual index 启用后，后台会在启动和设置保存时巡检 canonical cache；图片或扫描 PDF 只有 `metadata_only` manifest、manifest 缺失、或扫描 PDF 某页未完成 visual LLM 分析时，会触发 visual backfill。backfill 复用 unchanged canonical cache，只重新解析视觉索引不完整的文件。
- visual backfill 只有在 endpoint/model/prompt/payload policy 可调用且与 manifest 不一致时才会自动重跑；provider 请求失败会写入 `failed` 状态并设置 `next_retry_at`，避免后台守护任务在模型不可用时反复空转
- `knowledge:list-page` 有查询词时需要同时搜索 indexed blocks，让知识库 UI 能通过视觉语义召回无文字图片和扫描 PDF 页，并在文档源卡片显示 visual match summary
- 文档源详情需要返回 `visualBlocks`，用于展示 semantic blocks、evidence refs 和可用 bbox；retrieval audit 的 hit payload 需要保留 visual metadata，便于复盘为什么搜到这张图或 PDF 页
- Stage 6 起 `knowledge.search` 默认走 hybrid，可通过 `retrievalMode=lexical` 关闭增强链路
- hybrid 排序输出需要显式带 `retrievalLanes` 和 ranking breakdown，不能把 fusion / rerank 变成黑盒
- indexed `knowledge.search` 必须写入 `knowledge_retrieval_runs` / `knowledge_retrieval_hits`，返回 `auditRunId`，保证 evidence pack 可回放
- App 升级必须先走 `migration.rs` 版本决策；FTS/index-only/projection-only 变化不能触发默认 visual parser 全量重建；visual prompt/schema 变化必须进入 canonical reparse 确认路径
- Stage 7 起 release gate 依赖固定 fixture 测试；任一阈值不达标都应直接阻塞发布
- 对法律检索查询要先做 query profile，明确 intent、citation requirement、granularity，再决定默认 lexical/hybrid 路径
- advisor/member knowledge 也必须进入同一套 block/anchor 索引链，不能只让 registered document source 使用 indexed retrieval

## Verification

- 验证索引初始化
- 验证 rebuild、watcher 和状态读取
