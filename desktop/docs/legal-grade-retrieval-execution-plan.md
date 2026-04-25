---
doc_type: plan
execution_status: completed
last_updated: 2026-04-25
execution_stage: stage8_completed
owner: ai-agent
target_files:
  - desktop/src-tauri/src/knowledge_index/*
  - desktop/src-tauri/src/tools/knowledge_search.rs
  - desktop/src-tauri/src/tools/workspace_search.rs
  - desktop/src-tauri/src/commands/library.rs
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/document_ingest/*
  - desktop/src-tauri/src/document_parse/*
  - desktop/src-tauri/src/retrieval/*
  - desktop/src-tauri/src/citation/*
  - desktop/src-tauri/src/evaluation/*
success_metrics:
  - stage1_basic_retrieval_pass
  - stage3_citation_anchor_coverage
  - stage4_multilingual_ndcg_at_10
  - stage5_ocr_anchor_confidence
  - stage7_grounding_acceptance_gate
---

# 法律行业通用文件检索分阶段执行计划

Status: Current

## Scope

本计划将 [legal-grade-retrieval-architecture-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/legal-grade-retrieval-architecture-plan.md) 拆成可执行阶段，要求每个阶段结束后都具备明确验收口径，并且第一阶段结束后即可跑通最基础的文件检索流程。

## Execution Principles

1. 第一阶段优先形成最小闭环，而不是追求全格式覆盖。
2. 检索主底座先落 lexical + metadata，再逐步叠加 OCR、citation、rerank、hybrid。
3. 每阶段都必须有可复现的验收样例、失败样例和退出标准。
4. 每次代码提交保持 Atomic Commit，一个提交只落一个明确能力。

## Stage Overview

| 阶段 | 目标 | 完成后可获得的能力 |
| --- | --- | --- |
| Stage 1 | 跑通基础检索闭环 | 可导入基础文本类文件，完成最小入库、索引、搜索、读取 |
| Stage 2 | 建立通用解析标准层 | 多格式文件统一进入 `CanonicalDocument` |
| Stage 3 | 建立引用锚点与证据包 | 检索结果可稳定回溯到 block/span 级来源 |
| Stage 4 | 建立多语言与法律排序 | 中英双语检索和法律元数据排序可用 |
| Stage 5 | 支持扫描件与 OCR 文档 | 扫描 PDF / 图片文档进入证据链 |
| Stage 6 | 引入 hybrid 与 rerank | 复杂语义检索质量明显提升 |
| Stage 7 | 完成评测、审计与发布准入 | 系统具备法律产品上线前的质量闸门 |

## Stage 1: 基础检索闭环

### Goal

在不引入复杂 OCR、向量检索、法律专用排序之前，先跑通最基础的文件检索流程：

`导入文件 -> 标准化文本块 -> 建立索引 -> 搜索 -> 读取命中文本 -> 返回来源路径`

### Scope

这一阶段只覆盖最小必要格式：

- `txt`
- `md`
- `html`
- 原生文本 `pdf`
- `docx`

暂不覆盖：

- 扫描 PDF
- 图片 OCR
- `xlsx` / `pptx` / `eml`
- 复杂引用锚点
- dense / hybrid retrieval

### Implementation

必须实现：

1. 文件注册与版本记录

- 新增文档注册表，记录 `document_id`、`version_id`、`source_path`、`source_type`、`file_hash`

2. 最小 `CanonicalDocument`

- 统一输出 `title`、`languageHints`、`blocks[]`
- block 级字段至少包含 `block_id`、`page`、`text`、`normalized_text`

3. 最小解析适配器

- `txt/md/html` 用轻量文本解析
- `pdf/docx` 先接一个稳定 parser，保证原生文本抽取

4. 主索引

- 使用 `Tantivy` 建 block 级全文索引
- 使用 `SQLite` 管理文档元数据

5. 检索工具升级

- `knowledge.search` 从“直接扫文件”升级为“查 block 索引”
- `knowledge.read` 从“读原始文件片段”升级为“读 canonical block”

### Suggested Target Files

- `desktop/src-tauri/src/document_ingest/registry.rs`
- `desktop/src-tauri/src/document_parse/minimal.rs`
- `desktop/src-tauri/src/knowledge_index/*`
- `desktop/src-tauri/src/tools/knowledge_search.rs`

### Deliverables

- 最小文档注册表
- 最小 canonical schema
- block 级全文索引
- search/read 新返回结构
- 一组基础检索样例文档

### Acceptance

必须同时满足以下验收点：

1. 导入 5 份基础样例文件后，系统能完成索引构建，且不会回退到原始 grep 扫描。
2. 给定明确关键词查询，`knowledge.search` 能返回命中 block，结果中包含：
   - `documentId`
   - `blockId`
   - `sourcePath`
   - `page`
   - `snippet`
3. 对任意一个搜索结果调用 `knowledge.read`，能稳定读取对应 block 正文。
4. 删除一个已索引文件后，再次检索不再返回该文件结果。
5. 至少有一个自动化验收脚本能完成：
   - 导入
   - 索引
   - 搜索
   - 读取
   - 删除后复查

### Exit Criteria

满足以下条件才允许进入 Stage 2：

- 基础检索链路端到端跑通
- `txt/md/html/pdf/docx` 最小支持成立
- `knowledge.search/read` 已切换到 canonical/index 路径
- 基础回归样例稳定

### Progress Notes

- 已完成已注册文档源的 block 索引与 `knowledge.search/read` 的 `sourceId/rootPath/blockId` 支持
- 已补原生文本 `pdf` 抽取与多文档源监听
- 已将 document source ingest contract 独立下沉到 `src-tauri/src/document_ingest/registry.rs`，不再把注册逻辑继续堆在 `knowledge.rs`

## Stage 2: 通用解析标准层

### Goal

把“最小文本检索”升级为“多格式统一解析”，让后续 citation、OCR、多语言都建立在统一结构之上。

### Scope

新增支持：

- `pptx`
- `xlsx`
- `csv`
- `eml`
- `zip` 中的文本附件

### Implementation

必须实现：

1. 主解析编排层

- 引入 `Docling` 作为主解析器
- 为不同格式建立 parser adapter

2. fallback 机制

- `Docling` 失败时回退到 `Tika`
- 必要时允许 `Unstructured` 处理复杂元素切分

3. 完整 `CanonicalDocument`

- 增加 `pages`、`attachments`、`section_path`、`block_type`

4. 索引重建机制

- 解析成功后重建 block index
- 文件未变更时跳过重建

### Deliverables

- parser worker / sidecar
- canonical mapper
- parser fallback policy
- 增量索引逻辑

### Acceptance

1. 指定格式矩阵中的每类文件至少有一个样例可成功入库并生成 canonical blocks。
2. 同一查询可命中不同格式文件中的相关 block。
3. 未变更文件不会重复解析和重复建索引。
4. parser 失败时系统能回退并留下错误日志，而不是静默丢失。

### Exit Criteria

- 通用格式支持矩阵建立
- canonical schema 固定
- parser fallback 可用

### Progress Notes

- 已引入统一 `CanonicalDocument` 结构和 parser info
- 已支持 `pptx / xlsx / csv / eml / zip` 的 canonical 解析
- block 索引已建立在 canonical 层之上，不再直接依赖原始文件扫描
- 已增加 canonical cache，文件内容哈希未变化时优先复用解析结果

## Stage 3: 引用锚点与证据包

### Goal

让检索结果从“命中文本块”升级为“可精确引用的证据片段”。

### Implementation

必须实现：

1. `CitationAnchor`

- 在 block 内生成可稳定定位的 span anchor
- 保存页码、字符范围、quote text、section path

2. `EvidencePack`

- 检索后不直接返回松散结果，统一整理成证据包

3. tool contract 升级

- `knowledge.search` 返回 `anchorIds`
- `knowledge.read` 支持按 `anchorId` 读取

4. 基础 grounding contract

- 回答层可将 claim 绑定到 anchor

### Deliverables

- citation anchor registry
- anchor 读取接口
- evidence pack 结构
- claim-to-anchor 基础协议

### Acceptance

1. 搜索结果可稳定跳转到具体 block/span，而不是只到文件。
2. 同一文档重新索引后，未变更区域的 anchor id 保持稳定。
3. 至少 90% 的基础文本类文档命中结果能生成可读引用片段。
4. 最小回答链路中，核心 claim 至少能绑定一个 anchor。

### Exit Criteria

- 结果可引用
- 引文可回放
- grounding contract 初步成立

### Progress Notes

- 已新增 `knowledge_citation_anchors` 注册表
- `knowledge.search` 已返回 `anchorIds` 和 `evidencePack`
- `knowledge.read` 已支持按 `anchorId` 精确读取引用片段
- grounding contract 已通过 `claim -> supportingAnchorIds` 约束落地

## Stage 4: 多语言与法律元数据排序

### Goal

让系统具备中英双语检索能力，并开始按法律语义排序，而不是只按文本相似度排序。

### Implementation

必须实现：

1. 语言识别

- 文档级、页面级、block 级语言识别

2. 多语言 analyzer

- 中文 analyzer
- 英文 analyzer
- mixed-language normalization

3. 法律元数据提取

- `jurisdiction`
- `authority`
- `authority_level`
- `effective_date`
- `expiry_date`
- `document_type`
- `is_superseded`

4. 法律排序规则

- 先 metadata filter，再 lexical score，再 legal score

### Deliverables

- language pipeline
- legal metadata schema
- legal ranking profile v1

### Acceptance

1. 中英混合样例库中，中英文查询都能稳定命中正确文档。
2. 同样相关度下，现行法规原文优先于评论解读。
3. 已失效文档默认降权，并在结果中显式标识。
4. 中英双语评测集达到预设基础阈值。

### Exit Criteria

- 中英双语可用
- 法律排序生效
- 失效/现行状态进入检索逻辑

### Progress Notes

- 已补文档级法律元数据抽取：`jurisdiction / authority / authority_level / effective_date / expiry_date / document_type / is_superseded`
- canonical document 与 block 索引已持久化法律元数据，并在 `knowledge.search/read` 返回 `legalMetadata`
- 检索排序已升级为 `lexical score + legal score`，现行法规原文优先于评论解读，失效/废止文本默认降权并标记
- 中英混合查询已切到统一归一化与 term-based candidate 检索

## Stage 5: OCR 与扫描件支持

### Goal

将扫描 PDF、图片、影印件正式纳入可检索证据链。

### Implementation

必须实现：

1. OCR worker / provider

- 支持 `auto | api | local | disabled`
- `auto` 在配置远程 endpoint 时优先网络 OCR，避免弱性能客户端承担识别压力
- 本地 OCR 作为离线 fallback，不允许把单一 OCR 引擎硬编码成唯一通道

2. OCR 置信度链路

- page / block / span 置信度

3. OCR 结果入 canonical + citation

- OCR 文本也能生成 block 和 anchor

4. 低置信内容治理

- 低置信度结果降权或不允许作为唯一主证据

### Deliverables

- OCR parser path
- pluggable OCR provider config
- OCR confidence schema
- OCR-based anchor generation

### Acceptance

1. 扫描 PDF 能进入检索结果。
2. OCR 命中结果可读取对应文本和来源页码。
3. 低 OCR 置信内容在排序中显著降权。
4. OCR 结果不会和原生文本结果混淆来源类型。

### Exit Criteria

- 扫描件进入检索主链路
- OCR 结果具备引用能力
- OCR 风险可控

### Progress Notes

- 已新增 OCR parser path：扫描 PDF 通过 `pdftoppm` 渲染页图，再由可插拔 OCR provider 进入 canonical blocks
- 已支持远程 API OCR 优先、本地 Vision fallback、禁用 OCR 三种部署形态；配置项为 `ocr_provider`、`ocr_endpoint`/`ocr_api_endpoint`、`ocr_key`/`ocr_api_key`、`ocr_model`、`ocr_timeout_seconds`、`ocr_local_fallback`
- 图片类文件已支持直接 OCR 入库，block 会持久化 `contentOrigin=ocr` 和 `ocrConfidence`
- `knowledge.search/read` 已返回 OCR provenance，OCR 命中结果不会与原生文本结果混淆
- 排序已接入 OCR 置信度惩罚，低置信结果默认显著降权

## Stage 6: Hybrid 检索与 Rerank

### Goal

在不破坏主 lexical 底座的前提下，提高复杂语义查询和跨语言表达的召回与排序质量。

### Implementation

必须实现：

1. hybrid lane

- dense / sparse / multi-vector 召回

2. 融合策略

- Weighted RRF 或线性融合

3. rerank 层

- relevance rerank
- legal-aware rerank
- citation-aware rerank

### Deliverables

- hybrid planner
- rerank pipeline
- offline comparison report

### Acceptance

1. 在复杂语义查询集上，Recall@20 或 NDCG@10 明显优于纯 lexical。
2. rerank 后，法规原文、有效版本、可引用结果整体排序优于未重排版本。
3. hybrid lane 可关闭，关闭后主链路仍能正常运行。

### Exit Criteria

- hybrid 能力成为增强项而不是硬依赖
- rerank 带来明确可测收益

### Progress Notes

- 已新增 hybrid planner：`knowledge.search` 默认走 `hybrid`，并可用 `retrievalMode=lexical` 关闭增强链路
- lexical lane 已从纯 `LIKE` 候选升级为 SQLite FTS5 `bm25()` 主召回，`LIKE` 仅作为兼容兜底；后续仍按架构方案迁移到 `Tantivy + SQLite`
- block 索引已持久化本地 dense 向量缓存，检索时执行 `sparse expansion + semantic lane + weighted RRF`
- rerank 已接入 `legal-aware + citation-aware + confidence-aware` 规则，结果返回 `retrievalLanes` 和完整 ranking breakdown
- indexed `knowledge.search` 已写入 retrieval run / hit 审计表，并在响应中返回 `auditRunId`，用于回放 query plan、ranking 和 evidence pack
- 已新增离线对比报告：[hybrid-retrieval-evaluation-report.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/hybrid-retrieval-evaluation-report.md)

## Stage 7: 评测、审计与发布准入

### Goal

把系统从“能用”提升到“可作为法律产品上线的质量可控系统”。

### Implementation

必须实现：

1. 检索评测集

- 法律基础问答集
- 法条定位集
- 案例检索集
- 合同条款检索集
- 中英双语样例集

2. grounding audit

- claim coverage
- unsupported claim rate
- citation mismatch rate
- quote drift rate

3. 发布闸门

- 未达阈值不能作为默认检索主链路发布

### Deliverables

- benchmark runner
- audit report
- release gate checklist

### Acceptance

1. `Recall@20 >= 0.90`
2. `citation span exactness >= 0.98`
3. `unsupported claim rate <= 0.03`
4. `multilingual NDCG@10 >= 0.80`
5. `quote drift rate <= 0.01`
6. 每次版本变更后可自动产出检索回归报告

### Exit Criteria

- 质量闸门上线
- 审计可回放
- 发布标准明确

### Progress Notes

- 已新增固定 fixture 的 benchmark runner 与 grounding audit，代码在 `knowledge_index/evaluation.rs`
- Stage 7 现在通过失败测试直接阻塞 release gate，而不是依赖人工检查
- 已补 release gate 报告与检查清单：[retrieval-release-gate-report.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/retrieval-release-gate-report.md)

## Stage 8: 升级迁移与索引重建

### Goal

解决用户升级 App 后的数据库迁移、索引格式升级和后台重建问题，保证旧索引可用、新索引可恢复、失败可回滚。

### Implementation

必须实现：

1. 检索版本常量

- 在 `knowledge_index/schema.rs` 或独立 `migration.rs` 中定义：
  - `CURRENT_SCHEMA_VERSION`
  - `CURRENT_INDEX_FORMAT_VERSION`
  - `CURRENT_CANONICAL_SCHEMA_VERSION`
  - `CURRENT_PARSER_PIPELINE_VERSION`
  - `CURRENT_CHUNK_ANCHOR_RULE_VERSION`
  - `CURRENT_RERANK_POLICY_VERSION`

2. `knowledge_meta` 版本记录

- 存储当前已完成版本。
- 存储 `pending_migration`。
- 存储 `last_successful_rebuild_at`。
- 存储 `last_migration_error`。

3. migration decision builder

- 启动时对比旧版本和当前版本。
- 输出 `schema_only | fts_rebuild | block_anchor_rebuild | canonical_reparse | full_rebuild`。
- decision 必须可序列化到 index status，UI 能展示。

4. 幂等 schema migration

- 只在启动路径做轻量 DDL。
- 禁止在 UI 线程做 OCR、parser、全库扫描。
- FTS5/Tantivy/vector index 的重建只投递后台 job。

5. 分层重建 job

- `schema_only`：补表/列后直接标记完成。
- `fts_rebuild`：从 `knowledge_document_blocks` 重建 FTS/Tantivy，不重新解析文件。
- `block_anchor_rebuild`：从 `knowledge_canonical_documents.canonical_json` 重建 blocks、anchors、FTS/Tantivy。
- `canonical_reparse`：按 fingerprint 重新解析受影响文件，重建 downstream。
- `full_rebuild`：完整执行当前 catalog rebuild。

6. 旧索引兼容

- 新索引未完成前继续允许 `knowledge.search` 使用旧索引。
- 响应 `queryPlan.indexStaleness` 标明 `current | migration_pending | rebuilding | stale_fallback`。
- 失败时保留旧索引，写 `knowledge_index_errors` 与 `last_migration_error`。

7. 手动重建入口

- 保留 `knowledge:rebuild-catalog`。
- 增加“强制重建当前 source / 全库 / 仅全文索引”的参数设计。
- OCR 重建必须单独确认，避免升级后默认消耗大量本地性能或远程 API 额度。

### Deliverables

- `knowledge_index/migration.rs`
- `knowledge_meta` 版本键读写工具
- index status migration 字段
- 分层 rebuild job
- FTS/Tantivy-only rebuild
- canonical-to-block rebuild
- migration regression tests

### Acceptance

1. 老版本没有 FTS 表的数据库升级后，会自动补 schema 并后台重建 FTS，原检索在重建前仍可用。
2. 只改 rerank policy version 时，不触发 OCR/parser/FTS 重建。
3. 只改 chunk/anchor 规则时，从 canonical 重建 blocks/anchors，不重新 OCR。
4. 改 canonical schema 或 parser pipeline 时，只重新解析 fingerprint 受影响的文件。
5. 迁移中杀进程，重启后能继续或重新安全执行，不破坏旧索引。
6. 迁移失败时，`knowledge.search` 仍能使用旧索引，并在 query plan 标注 stale fallback。
7. 用户可手动触发全库重建或仅全文索引重建。

### Exit Criteria

- 用户升级 App 不需要手动删库。
- 所有检索结构变化都有明确 migration decision。
- 大型库升级不会阻塞 UI。
- 失败可观测、可重试、可保留旧索引。

### Progress Notes

- 当前 `schema.rs` 已有幂等建表/补列基础，但还缺显式版本键、migration decision、分层重建和 index staleness 标注。
- 当前 rebuild 是全量 `rebuild_catalog`，需要拆出 FTS-only、canonical-to-block、source-level rebuild。
- 已新增 `knowledge_index/migration.rs` 的版本键与 migration decision；启动时可自动识别 `schema_only`、`fts_rebuild`、`full_rebuild`。
- 已接入 FTS-only 后台重建：升级到 BM25/FTS 版本后，从 `knowledge_document_blocks` 重建 FTS，不触发 OCR/parser。
- indexed `knowledge.search` 的 `queryPlan.indexStaleness` 已标注 `current | migration_pending | rebuilding | stale_fallback | unknown`。
- 已完成 `block_anchor_rebuild` migration decision：chunk/anchor 规则变化时复用 `knowledge_canonical_documents.canonical_json` 重建 blocks、anchors、FTS/BM25，不重新 OCR 或 parser。
- 已完成 source-level rebuild 参数：`knowledge:rebuild-catalog` 支持 `sourceId`，可按 source 触发 `fts` 或 `canonicalBlocks` 重建。
- 已完成手动重建参数：`mode=full | fts | canonicalBlocks`；OCR 只在 `full` 且 parser 按当前 OCR provider 需要时发生，低成本重建路径不触发 OCR。
- canonical cache 已纳入 parser name/version 校验；parser pipeline 升级后的 full rebuild 不会误用旧 canonical JSON。
- Knowledge 页面已暴露“全量重建 / 重建引用 / 全文索引”三种入口；index status 已展示 `migrationStatus` 与 `pendingRebuildReason`。

## Phase Dependencies

- Stage 2 依赖 Stage 1 的 canonical/index 主链路
- Stage 3 依赖 Stage 2 的稳定 block 结构
- Stage 4 依赖 Stage 2 的 parser 输出和 Stage 3 的引用结构
- Stage 5 依赖 Stage 2 的 parser 编排与 Stage 3 的 anchor 结构
- Stage 6 依赖 Stage 4 / Stage 5 的稳定评测数据
- Stage 7 贯穿全程，但必须在 Stage 6 后完成最终闸门
- Stage 8 依赖 Stage 2 的 schema/catalog 和 Stage 6/7 的 query plan/audit 字段；所有后续检索结构变更都必须先更新 Stage 8 的版本键与迁移规则

## Recommended Delivery Slices

为了符合 Atomic Commit，建议按以下提交粒度推进：

1. 文档注册表与最小 canonical schema
2. Tantivy block 索引与 SQLite 元数据表
3. `knowledge.search/read` 切到 index/canonical 路径
4. Docling parser adapter
5. parser fallback 与增量索引
6. citation anchor registry
7. evidence pack 与 anchor read
8. language detection 与 analyzer
9. legal metadata extraction
10. OCR worker 与 confidence pipeline
11. hybrid planner
12. rerank pipeline
13. benchmark 与 release gate
14. retrieval schema version 与 migration decision
15. FTS/Tantivy-only rebuild
16. canonical-to-block rebuild
17. migration status UI 与 stale index query plan

## First Milestone Definition

第一阶段完成后的系统必须能现场演示以下流程：

1. 导入一个 `md` 文件和一个原生文本 `pdf`
2. 系统自动建立文档注册与 block 索引
3. 使用 `knowledge.search` 查询关键词
4. 返回包含来源路径和 snippet 的命中结果
5. 使用 `knowledge.read` 读取命中 block 正文
6. 删除其中一个文件
7. 再次查询时该文件结果消失

如果这 7 步不能稳定完成，则 Stage 1 视为未完成。

## Related Files

- [legal-grade-retrieval-architecture-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/legal-grade-retrieval-architecture-plan.md)
- [README.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/README.md)
- [knowledge_search.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/knowledge_search.rs)
- [catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/knowledge_index/catalog.rs)
- [indexer.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/knowledge_index/indexer.rs)
