---
doc_type: plan
execution_status: in_progress
last_updated: 2026-04-25
execution_stage: architecture_proposed
owner: ai-agent
target_files:
  - desktop/src-tauri/src/knowledge_index/*
  - desktop/src-tauri/src/tools/knowledge_search.rs
  - desktop/src-tauri/src/tools/workspace_search.rs
  - desktop/src-tauri/src/commands/library.rs
  - desktop/src-tauri/src/runtime/*
success_metrics:
  - legal_retrieval_recall_at_20
  - citation_span_exactness
  - evidence_grounded_answer_rate
  - multilingual_retrieval_ndcg_at_10
---

# 法律行业通用文件检索系统方案

Status: Current

## Scope

本方案定义 RedConvert 下一代通用文件检索系统的完整架构，目标是支撑多格式、多语言、强引用、可审计的法律行业检索与 AI grounded answer。输出不是零散优化建议，而是可直接落地的产品级方案，覆盖：

- 文件接入与解析
- OCR 与版面恢复
- 统一文档结构
- 引用锚点模型
- 多语言全文检索
- 混合召回与重排
- 法律场景专用排序规则
- grounded answer 与审计
- 性能优化与评测体系

## Current Baseline

当前仓库的知识检索能力主要由以下模块组成：

- 运行时默认检索路径是 `redbox_fs(action="knowledge.list|search|read")`
- `knowledge.search` 本质是基于文件扫描的 grep-like 文本匹配
- `knowledge.read` 是带 `offset` / `limit` / `maxChars` 的受控文件读取
- `knowledge_index/*` 当前主要承担 Knowledge 页面 catalog/summary 索引，而不是法律级 chunk retrieval 引擎
- embedding 与 similarity 相关链路已不再是主默认检索路径

这套能力对于通用知识库已经可用，但不满足法律行业对以下能力的要求：

- 精确引用到页、段、款、句或 span
- 多语言、多格式稳定解析
- 对法规、判例、合同、证据材料进行不同权重排序
- 对失效版本、修订版、冲突证据做严格区分
- 对每个答案保留可回放、可审计的 evidence trace

因此需要将当前“文件搜索工具链”升级为“法律级证据检索系统”。

## Design Goals

系统目标必须同时满足以下五类要求：

1. 严谨

- 每个关键结论都必须可回溯到原始证据
- 引用必须落到稳定锚点，而不是泛化到文件级
- 不允许“看起来相关但无法精确引用”的结果进入最终答案主证据链

2. 通用

- 支持 PDF、DOCX、PPTX、XLSX、CSV、TXT、Markdown、HTML、EML、图片扫描件、ZIP 解包文本附件
- 支持中英双语为主，后续可扩展至日语、韩语、欧洲语种
- 支持结构化资料与非结构化资料并存

3. 法律适配

- 明确区分法规、司法解释、案例、合同、内部制度、证据附件、律师备忘、二级解读
- 将司法层级、发布机关、适用法域、生效时间、失效状态纳入检索排序
- 对版本链、修订链、引用链进行显式建模

4. 本地优先

- 保持现有 workspace-first、本地存储、本地索引架构
- 避免将核心解析、索引、引用链依赖到外部 SaaS
- 满足涉法资料的隐私与合规要求

5. 可评测

- 检索效果不能只靠主观体验
- 必须能做离线 benchmark、回归测试、错误归因与审计复盘

## Recommended Architecture

推荐采用以下主链路：

`Raw File -> File Type Detect -> Parser / OCR / Layout Extraction -> CanonicalDocument -> Structural Segmentation -> Citation Anchors -> Metadata & Lexical Index -> Optional Dense/Sparse/Multi-vector Index -> Hybrid Recall -> Legal-aware Rerank -> Evidence Consolidation -> Grounded Answer with Exact Citations`

这个架构的核心思想是：

- 把“文件解析”和“检索”解耦
- 把“文档块”与“引用锚点”分开建模
- 把 lexical retrieval 作为主稳定底座
- 把 vector / multi-vector 作为增强召回，而不是唯一主干
- 把最终回答建立在 citation anchor 和 evidence pack 上，而不是建立在模型记忆或松散 chunk 上

## Module Breakdown

### 1. File Ingestion Layer

职责：

- 接收 workspace 中的新文件、更新文件、删除文件
- 做 MIME/扩展名识别
- 建立文件哈希、版本号、来源路径、导入时间、来源渠道
- 将解析任务投递给异步解析队列

必须自研：

- workspace 文件注册逻辑
- 文件版本与来源渠道映射
- 删除传播与索引清理逻辑
- 与当前 `knowledge:*` / `library:*` 工作区契约的对接

建议用现成库：

- Rust 文件类型识别：`infer`
- 哈希：`blake3`
- ZIP 解包与附件发现：标准 Rust zip 生态

建议新增模块：

- `desktop/src-tauri/src/document_ingest/registry.rs`
- `desktop/src-tauri/src/document_ingest/detector.rs`
- `desktop/src-tauri/src/document_ingest/jobs.rs`

### 2. Document Parsing Layer

这是整套系统最关键的基础层。法律检索质量首先取决于解析质量，而不是向量模型质量。

候选方案对比：

| 方案 | 优势 | 劣势 | 适用定位 |
| --- | --- | --- | --- |
| `docling-project/docling` | 多格式解析能力强，结构恢复好，适合 PDF/DOCX/PPTX/HTML，社区活跃 | 集成复杂度高于简单文本提取 | 推荐主方案 |
| `apache/tika` | 格式覆盖极广，稳定，适合通用抽取兜底 | 对复杂布局、表格、层级恢复较弱 | 推荐通用 fallback |
| `Unstructured-IO/unstructured` | 文档元素切分成熟，生态完整 | Python 依赖较重，纯本地集成成本高 | 推荐作为结构化 fallback |
| `datalab-to/marker` | PDF 到 Markdown 效果好，扫描/学术文档强 | 更适合 PDF 强提取，不适合作为唯一主引擎 | 作为 PDF 特化 fallback |

推荐结论：

- 主解析方案：`Docling`
- 通用 fallback：`Tika + Unstructured`
- PDF 特化 fallback：`Marker`

推荐实现方式：

- 在 Tauri/Rust 宿主中自研解析编排层
- 实际解析引擎以独立 Python worker 或 sidecar 运行
- Rust 只负责任务调度、结果落库、版本管理和错误治理

原因：

- 法律文档解析不是单一格式问题，而是多格式、多页布局、多语言、多附件问题
- 现成解析库更新快，适合以 worker 方式解耦
- Rust 宿主负责稳定系统边界，Python 负责文档理解生态

### 3. OCR And Layout Confidence Layer

法律资料大量来自扫描件、盖章件、法院文书 PDF、影印合同，OCR 不是补充功能，而是一级能力。

必须实现：

- 页面级 OCR 置信度
- block/span 级 OCR 置信度
- 原始图像坐标与识别文本的映射
- 低置信度区域标记

建议用现成库 / SDK：

- 远程 OCR：供应商 API / 自建 OCR 服务作为默认推荐通道，降低弱性能客户端负载
- 本地 OCR：`PaddleOCR`、`Tesseract` 或平台原生 Vision 作为离线兜底
- 版面分析：优先利用 `Docling` 能力，必要时补 `layoutparser` 类方案

推荐：

- OCR provider 必须可插拔，支持 `auto | api | local | disabled`
- 默认 `auto`：配置远程 endpoint 时优先网络 OCR；未配置或远程失败且允许 fallback 时使用本地 OCR
- `PaddleOCR` / `Tesseract` / 系统 Vision 保留为离线 fallback，不应成为无法替换的硬依赖

必须自研：

- OCR provider 统一请求/响应适配层
- OCR 结果规范化
- OCR 置信度与引用锚点绑定
- 低置信度内容在检索与回答阶段的降权规则

### 4. Canonical Document Layer

必须建立统一中间文档格式，后续所有 chunk、索引、引用都只基于这层，不直接基于原始 parser 输出。

推荐数据结构：

```ts
type CanonicalDocument = {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceType: 'pdf' | 'docx' | 'html' | 'txt' | 'xlsx' | 'email' | 'image' | 'other';
  languageHints: string[];
  title?: string;
  jurisdiction?: string;
  authority?: string;
  effectiveDate?: string;
  expiryDate?: string;
  isSuperseded?: boolean;
  pages: CanonicalPage[];
  blocks: CanonicalBlock[];
  attachments: CanonicalAttachment[];
  parserInfo: {
    parserName: string;
    parserVersion: string;
    ocrEngine?: string;
    ocrVersion?: string;
  };
};
```

`CanonicalBlock` 至少要包含：

- block id
- page number
- block type
- structural path
- raw text
- normalized text
- language
- bbox
- OCR confidence
- parent/child relation

必须自研：

- CanonicalDocument schema
- parser output -> canonical output 的映射器
- 版本间差异与 superseded 状态逻辑

### 5. Citation Anchor Layer

法律行业检索不能只返回“命中文档”或“命中 chunk”，必须有稳定的引用锚点模型。

推荐数据结构：

```ts
type CitationAnchor = {
  anchorId: string;
  documentId: string;
  versionId: string;
  pageStart: number;
  pageEnd: number;
  blockIds: string[];
  charStart: number;
  charEnd: number;
  quoteText: string;
  normalizedQuoteText: string;
  locator: {
    sectionPath?: string[];
    articleNo?: string;
    clauseNo?: string;
    itemNo?: string;
    paragraphNo?: string;
    bbox?: [number, number, number, number];
  };
  confidence: number;
  sourceKind: 'native_text' | 'ocr_text';
};
```

硬性规则：

- 每条最终引用必须落到 `CitationAnchor`
- 最终展示的 quoted text 必须与 anchor span 精确一致
- 不允许只引用文件名、标题、页码而不绑定文本 span
- 低 OCR 置信度 anchor 不能直接作为唯一主证据

必须自研：

- citation anchor 生成器
- anchor 稳定 ID 策略
- anchor 与 answer claim 的映射关系

这层是法律合规与可审计性的核心，不能外包给通用 RAG 框架。

### 6. Segmentation And Chunking Layer

不推荐使用简单固定 512/1024 token 平铺切块。法律文档天然具备层级结构，必须优先结构化切分。

推荐规则：

- 法条类：按篇/章/节/条/款/项切分
- 判决书类：按案号、法院、裁判要旨、事实、理由、判决结果切分
- 合同类：按章节、条款、附件、定义、义务、违约责任切分
- 证据材料：按文件边界、附件编号、页块、表格块切分

推荐采用三级结构：

1. document level
2. section/block level
3. citation span level

后续再演进为 query-aware chunk routing：

- broad legal research 查询使用 section 粒度
- exact clause 查询优先 citation span 粒度
- factual evidence 查询优先 OCR span + page block 粒度

### 7. Multilingual Layer

系统必须天然支持多语言，不应将中文和英文检索视为两个独立系统。

必须实现：

- 文档级语言识别
- 页面级语言识别
- block 级语言识别
- 按语言选择 analyzer / tokenizer / normalization 策略

建议用现成库：

- 语言识别：`lingua-rs`
- 中文分词：可接 `jieba-rs` 或支持 CJK analyzer 的索引方案
- 英文 analyzer：标准 stemming + lowercasing + stopword

向量/多向量候选：

- dense / sparse / multi-vector 主推 `BGE-M3`
- rerank 可优先 `bge-reranker-v2.5` 或 `mixedbread` 系列

推荐原则：

- lexical index 必须按语言定制 analyzer
- embedding 不是多语言支持的唯一手段
- 任何模型都不能替代原文引用锚点

### 8. Metadata And Lexical Index Layer

这是系统主底座，推荐作为默认主检索链路。

推荐实现：

- 倒排检索引擎：`Tantivy`
- 关系/事务/审计元数据：`SQLite`

理由：

- 与当前 Rust/Tauri 架构天然匹配
- 本地运行成本低
- 倒排 + BM25 + filter + snippet 能力成熟
- 可解释、可审计、易调优

推荐索引字段：

- `document_id`
- `version_id`
- `source_path`
- `workspace_id`
- `source_type`
- `title`
- `text`
- `normalized_text`
- `language`
- `jurisdiction`
- `authority`
- `authority_level`
- `effective_date`
- `expiry_date`
- `is_superseded`
- `document_type`
- `section_path`
- `article_no`
- `clause_no`
- `page`
- `block_id`
- `anchor_ids`
- `ocr_confidence`
- `tags`

实现要求：

- metadata filter 在 lexical search 前就参与查询计划
- snippet 不再从原始文件现算，而是基于 canonical block / anchor 预计算
- 返回结果必须保留 block 与 anchor 映射

### 9. Optional Hybrid Retrieval Layer

向量检索不是主底座，但对跨语言表达、语义近义、事实问法变化仍然有价值。

可选方案对比：

| 方案 | 优势 | 劣势 | 适合定位 |
| --- | --- | --- | --- |
| 本地自管 HNSW | 完全本地、轻量 | 自研维护成本高 | 作为基础 hybrid lane |
| 借鉴 `Qdrant` 设计 | hybrid / prefetch / rerank 思路成熟 | 若直接引入服务会增部署复杂度 | 推荐借鉴 query planning |
| `Weaviate` | 接口成熟、产品化强 | 本地桌面内嵌偏重 | 不推荐作为主方案 |
| `Vespa` | 排序能力极强 | 系统过重，超出桌面端主产品形态 | 适合作为长期架构参考 |

推荐结论：

- 默认产品主线不直接依赖外部向量数据库
- 主链路采用 `Tantivy + SQLite`
- hybrid lane 作为增强能力内置在 retrieval planner 中
- 查询计划借鉴 `Qdrant` 的 multi-stage / prefetch / fusion 思路

推荐流程：

- lexical recall top 200-500
- dense/sparse/multi-vector recall top 100-300
- 使用 Weighted RRF 或线性融合
- 融合后进入 rerank

### 10. Reranking Layer

严谨检索的关键不是多召回，而是正确排序。

推荐分三层：

1. relevance rerank

- 判断文本是否真正回答查询

2. legal priority rerank

- 判断法域、效力、时效、文件类型是否更优

3. citation availability rerank

- 优先选择有高质量 citation anchor 的候选

推荐技术：

- 默认：cross-encoder reranker
- 高精度扩展：`ColBERT` / multi-vector late interaction

推荐原则：

- 法律产品默认不要只靠 embedding cosine 选最终结果
- 最终 top results 必须被法律元数据规则二次矫正

### 11. Evidence Consolidation Layer

召回与重排后不能直接把 top-k 拼接给模型，必须先构造结构化证据包。

推荐数据结构：

```ts
type EvidencePack = {
  queryId: string;
  evidences: Array<{
    documentId: string;
    versionId: string;
    anchorId: string;
    blockId: string;
    score: number;
    legalScore: number;
    citationConfidence: number;
    quoteText: string;
    sectionPath?: string[];
    page: number;
    sourcePath: string;
    authorityLevel?: number;
    isSuperseded?: boolean;
  }>;
  conflicts: Array<{
    conflictType: 'superseded' | 'jurisdiction_mismatch' | 'contradictory_sources';
    evidenceIds: string[];
  }>;
};
```

必须实现：

- 重复 span 去重
- 相邻 span 合并
- 低置信 OCR 证据剔除或降权
- 冲突证据标记
- superseded 文档提示

### 12. Grounded Answer Layer

最终 AI 回答必须建立在 EvidencePack 上，不允许直接基于普通 chunk 拼接。

强规则：

- 每个核心 claim 至少绑定一个 `anchorId`
- 如果 claim 没有证据支撑，必须删除或显式标注“不足以支持”
- 引文必须可点击回到原文页块或原文 span
- quote 模式与 paraphrase 模式必须分开标记

推荐输出结构：

- `answer`
- `claims[]`
- `claims[].supportingAnchors[]`
- `claims[].quoteMode`
- `claims[].confidence`

## Query Flow

推荐查询执行流程：

1. Query Intent Classifier

- 判断是法规定位、法条解释、案例检索、合同条款检索、证据事实检索，还是跨文件归纳

2. Retrieval Profile Builder

- 根据 query 类型选择不同召回粒度
- 根据 workspace / folder / matter / jurisdiction 限定检索范围

3. Metadata Filter

- 优先过滤法域、文种、时间状态、文件来源

4. Lexical Recall

- 基于 Tantivy 执行 BM25 / phrase / boolean / fielded search

5. Optional Hybrid Recall

- 对 lexical 不充分的 query 启动 dense/sparse/multi-vector 补召回

6. Weighted Fusion

- 合并 lexical 与 semantic 候选集

7. Rerank

- relevance + legal-aware + citation-aware 联合排序

8. Evidence Consolidation

- 构造 EvidencePack

9. Grounded Answer

- 基于 EvidencePack 输出带严格引用的答案

## Legal-Specific Ranking Rules

法律领域不能只按文本相关性排序，必须引入法律权重。

关键因子：

- `jurisdiction_match`
- `authority_level`
- `effective_date_recency`
- `is_superseded`
- `citation_density`
- `quote_safety`
- `ocr_confidence`
- `document_type_priority`

推荐总分公式：

```text
final_score =
  0.35 * lexical_score +
  0.20 * semantic_score +
  0.20 * rerank_relevance_score +
  0.15 * legal_priority_score +
  0.10 * citation_quality_score
```

其中：

- `legal_priority_score` 由法域匹配、发布机关、效力层级、生效状态组成
- `citation_quality_score` 由 anchor 可用性、OCR 置信度、span 精准度组成

推荐优先级：

1. 现行法律/法规原文
2. 生效司法解释/官方规则
3. 判例/裁判文书
4. 合同/内部制度/证据材料
5. 评论/解读/二级资料

如果查询目标明确是“实务分析”或“案例趋势”，再提升案例和二级资料权重。

## Storage Design

推荐四类存储：

1. Raw Storage

- 原始文件
- 原始附件
- 原始页面图像

2. Canonical Storage

- CanonicalDocument JSON
- CanonicalPage / CanonicalBlock / Attachment 结构

3. Index Storage

- Tantivy index
- SQLite metadata db
- 可选 local vector index

4. Audit Storage

- retrieval run
- returned hits
- evidence pack
- final claim-to-anchor mapping

推荐 SQLite 表：

- `documents`
- `document_versions`
- `document_blocks`
- `citation_anchors`
- `document_metadata`
- `document_relations`
- `retrieval_runs`
- `retrieval_hits`
- `grounding_audits`

## Performance Strategy

必须从一开始按桌面端、法律资料库、大体量 PDF 的现实约束设计性能。

关键策略：

1. 增量索引

- 基于 `blake3` 做文件指纹
- 文件未变更时不重复解析
- 同一文档只重建受影响页面/块

2. 分层重建

- 原始文件变更先更新 registry
- parser 输出变更只重建 canonical layer
- citation / chunk 规则变更只重建 block 与 anchor 层
- rerank 规则变更不重建索引，只更新检索策略

3. 异步解析

- OCR、layout、parser 在后台 worker 执行
- UI 显示 stale-while-revalidate 状态
- 已有旧索引在新索引就绪前继续提供检索

4. 先过滤再检索

- metadata filter 尽量前置
- 减少大范围全文扫描

5. 预计算 snippet

- 常用 block/anchor 摘要提前生成
- 避免查询阶段大量二次 IO

6. 多级缓存

- 文档元数据缓存
- query result cache
- rerank feature cache
- parser artifact cache

## Upgrade, Migration, And Rebuild Strategy

App 升级后不能假设用户会手动清空索引。检索数据库、canonical schema、parser 版本、chunk/anchor 规则、FTS/Tantivy 索引格式都必须有版本化迁移和安全重建流程。

### 版本记录

`knowledge_meta` 必须记录以下版本键：

- `schema_version`：SQLite 表结构版本。
- `index_format_version`：FTS/Tantivy/vector 索引格式版本。
- `canonical_schema_version`：`CanonicalDocument` JSON 契约版本。
- `parser_pipeline_version`：parser/OCR/layout 编排版本。
- `chunk_anchor_rule_version`：block 切分与 citation anchor 规则版本。
- `rerank_policy_version`：rerank 权重和规则版本。
- `last_successful_rebuild_at`：最近一次完整成功重建时间。

### 启动迁移流程

启动时必须按固定顺序执行：

1. 打开 `.redbox/index/knowledge_catalog.sqlite`。
2. 设置 WAL 与基础 PRAGMA。
3. 执行幂等 schema migration：只做 `CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`、`ALTER TABLE ADD COLUMN`、可重建虚拟表创建，不在 UI 线程做重型重建。
4. 读取 `knowledge_meta` 中的版本键。
5. 对比当前 app 内置的检索版本常量。
6. 生成 migration decision：
   - `schema_only`：只需要表结构补齐，不需要重建。
   - `fts_rebuild`：FTS/Tantivy 索引结构变化，只重建全文索引。
   - `block_anchor_rebuild`：chunk/anchor 规则变化，复用 canonical，重建 blocks、anchors、lexical/vector index。
   - `canonical_reparse`：parser/OCR/canonical schema 变化，重新解析文件并重建下游层。
   - `full_rebuild`：无法安全增量迁移或旧版本缺少关键元数据，完整重建。
7. 将 decision 写入 `knowledge_meta.pending_migration`，并通过 index status 暴露给 UI。
8. 后台 job 执行迁移/重建，旧索引在新索引完成前继续提供检索。
9. 重建成功后原子更新版本键和 `last_successful_rebuild_at`；失败时保留旧索引并记录 `knowledge_index_errors`。

### 重建粒度

不同升级类型必须触发不同层级，避免每次升级都重新 OCR 大文件：

| 变化类型 | 触发动作 | 是否重新 OCR / parser |
| --- | --- | --- |
| 新增 SQLite 表/列 | schema migration | 否 |
| FTS5 表新增或格式变化 | 重建 FTS rows | 否 |
| Tantivy schema 变化 | 重建 Tantivy index | 否 |
| rerank 权重变化 | 更新策略版本 | 否 |
| citation anchor 切分规则变化 | 重建 anchors，并按需重建 evidence cache | 否 |
| block chunk 规则变化 | 从 canonical 重建 blocks、anchors、索引 | 否 |
| canonical schema 变化 | 重新解析文件，重建 downstream | 是 |
| OCR provider 配置变化 | 只影响新解析；若用户选择“重新 OCR”，才重建 OCR 文档 | 可选 |
| parser engine/version 变化 | 对受影响文件重新解析 | 是 |

### 安全要求

- 迁移必须幂等，同一版本可重复执行。
- 迁移失败不得删除旧可用索引。
- 大型重建必须后台执行，不阻塞页面进入。
- UI 必须展示 `migrationStatus`、`pendingRebuildReason`、`rebuildProgress`、`lastError`。
- 用户升级后第一次检索，如果新索引未完成，应返回旧索引结果，并在 `queryPlan` 标注 `indexStaleness`。
- 删除文件仍必须立即传播到 canonical、block、anchor、FTS/Tantivy、audit 关联数据，不能等下一次全量重建。

### 当前落地状态

- 已落地版本键与 migration decision：`schema_only`、`fts_rebuild`、`block_anchor_rebuild`、`full_rebuild`。
- 已落地 `Tantivy + SQLite FTS5 BM25` 双倒排底座；后台分层 job 会同步重建 FTS/BM25 与 Tantivy block index。
- 已落地 Docling / Tika / Unstructured 可插拔解析入口：外部 sidecar / API 可配置，不配置时保留内置 parser，失败时按顺序 fallback。
- 已落地手动重建入口：`knowledge:rebuild-catalog` 支持 `mode=full | fts | canonicalBlocks` 和可选 `sourceId`。
- canonical cache 命中必须匹配当前 parser name/version，避免 parser pipeline 升级后继续复用旧解析结果。
- OCR 重建保持可控：`fts` 与 `canonicalBlocks` 不触发 OCR；只有 `full` 路径会按当前可插拔 OCR provider 配置解析需要 OCR 的文件。
- 已落地 `canonical_reparse`、`rebuildProgress` 与 `knowledge_index_errors`；删除 document source 会同步删除 canonical、block、anchor、FTS/BM25、retrieval audit 关联数据。

## Security And Compliance

法律行业使用场景要求默认合规。

必须满足：

- 默认本地执行
- 可关闭外部网络依赖
- 每个 parser / OCR / model 的版本可追溯
- 每次检索有审计日志
- 删除文件时同步删除 canonical/index/audit 关联内容

不推荐默认依赖：

- 外部 SaaS OCR
- 外部 SaaS parser
- 外部 SaaS rerank API

如果未来需要云增强，必须显式配置并按 matter / workspace 做权限隔离。

## Evaluation Plan

必须建立独立评测体系。

离线检索指标：

- Recall@5
- Recall@20
- NDCG@10
- MRR
- passage hit rate
- citation-anchor exactness
- quote exact match
- multilingual recall

grounding 指标：

- claim coverage
- unsupported claim rate
- citation mismatch rate
- quote drift rate
- conflict detection rate

建议纳入的 benchmark / 工具：

- `Legal RAG Bench`
- `LexRAG`
- `LegalBench-RAG`
- `A Reasoning-Focused Legal Retrieval Benchmark`
- `BRIGHT`
- `RAGChecker`

建议验收阈值：

- `Recall@20 >= 0.90`
- `citation span exactness >= 0.98`
- `unsupported claim rate <= 0.03`
- `multilingual NDCG@10 >= 0.80`
- `quote drift rate <= 0.01`

## Recommended Execution Order

建议按以下顺序实施：

1. 建立 `CanonicalDocument` 与 `CitationAnchor` 契约
2. 接入 `Docling` 作为主解析链路
3. 建立 `Tantivy + SQLite` 主索引
4. 将 `knowledge.search/read` 升级为 block/span 级检索与读取
5. 增加法律元数据过滤与排序
6. 接入 rerank 层
7. 视需求加入 hybrid lane
8. 建立法律 benchmark 与 grounding audit

这是最稳妥的路径。理由是：

- 如果先上向量，再补解析和引用，后期会返工
- 如果没有 canonical 与 citation anchor，法律级 grounded answer 无法成立
- 如果没有 lexical + metadata 主底座，系统解释性与可调优性不足

## Concrete Integration With Current Repo

与当前 RedConvert 架构的结合方式如下：

可复用部分：

- workspace-first 文件组织
- `knowledge_index/*` 现有宿主挂载点
- `redbox_fs` 作为 AI runtime 统一工具入口
- runtime capability guardrails

建议升级：

1. `knowledge_index/*`

- 从 catalog summary 索引升级为：
  - 文档注册中心
  - canonical 元数据目录
  - lexical index 状态目录
  - citation anchor registry

2. `tools/knowledge_search.rs`

- 从原始文件扫描升级为：
  - metadata query
  - block/passage query
  - citation-anchor read

3. runtime tool contract

- `knowledge.search` 返回结果要包含：
  - `documentId`
  - `versionId`
  - `blockId`
  - `anchorIds`
  - `page`
  - `sectionPath`
  - `quotePreview`
  - `isSuperseded`
  - `ocrConfidence`

4. 新增模块建议

- `desktop/src-tauri/src/document_ingest/*`
- `desktop/src-tauri/src/document_parse/*`
- `desktop/src-tauri/src/retrieval/*`
- `desktop/src-tauri/src/citation/*`
- `desktop/src-tauri/src/evaluation/*`

## Final Recommendation

针对 RedConvert 的最优方案是：

- 解析主链路：`Docling`
- 通用 fallback：`Tika + Unstructured`
- 主检索底座：`Tantivy + SQLite`
- 增强召回：本地 dense/sparse/multi-vector hybrid lane
- 默认重排：cross-encoder reranker
- 高精度扩展：`ColBERT` / multi-vector rerank
- 引用模型：自研 `CitationAnchor`
- 法律评测：`Legal RAG Bench + LexRAG + BRIGHT + RAGChecker`

最终推荐理由：

- 它最符合当前仓库的 Rust/Tauri 本地优先架构
- 它把法律检索最关键的“引用严谨性”放在核心模型层，而不是后补
- 它既能覆盖通用多格式文件，又能为未来法律产品提供可审计证据链

一句话总结：

这套系统的目标不是“找几个相关 chunk”，而是“在多格式、多语言、多版本法律资料中，稳定找出可精确引用、可审计回放、适合作为法律答案依据的证据锚点”。

## Related Files

- [README.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/README.md)
- [skill-runtime-v2.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/skill-runtime-v2.md)
- [runtime-capability-guardrails.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-capability-guardrails.md)
- [member-skill-migration-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/member-skill-migration-plan.md)
- [knowledge_search.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/knowledge_search.rs)
- [catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/knowledge_index/catalog.rs)
- [indexer.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/knowledge_index/indexer.rs)

## External References

- [Docling](https://github.com/docling-project/docling)
- [Marker](https://github.com/datalab-to/marker)
- [Unstructured](https://github.com/Unstructured-IO/unstructured)
- [Apache Tika](https://github.com/apache/tika)
- [Tantivy](https://github.com/quickwit-oss/tantivy)
- [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [Qdrant Hybrid Search with Reranking](https://qdrant.tech/documentation/advanced-tutorials/reranking-hybrid-search/)
- [Weaviate Hybrid Search](https://docs.weaviate.io/weaviate/search/hybrid)
- [Vespa Hybrid Search Tutorial](https://docs.vespa.ai/en/learn/tutorials/hybrid-search)
- [ColBERT](https://github.com/stanford-futuredata/ColBERT)
- [FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)
- [Mixedbread Rerank](https://github.com/mixedbread-ai/mxbai-rerank)
- [RAGChecker](https://github.com/amazon-science/RAGChecker)
- [BRIGHT](https://github.com/xlang-ai/BRIGHT)
- [Legal RAG Bench](https://arxiv.org/abs/2603.01710)
- [LexRAG](https://arxiv.org/abs/2502.20640)
- [LegalBench-RAG](https://arxiv.org/abs/2408.10343)
- [A Reasoning-Focused Legal Retrieval Benchmark](https://arxiv.org/abs/2505.03970)
- [RAG Evaluation Survey 2025](https://arxiv.org/abs/2504.14891)
- [RAG Survey 2025](https://arxiv.org/abs/2506.00054)
- [SmartChunk Retrieval](https://arxiv.org/abs/2602.22225)
- [HiChunk](https://arxiv.org/abs/2509.11552)
- [WARP: Multi-Vector Retrieval](https://arxiv.org/abs/2501.17788)
