---
doc_type: plan
execution_status: completed
last_updated: 2026-04-25
owner: product-engineering
scope: desktop
source_of_truth: true
related_docs:
  - desktop/docs/runtime-memory-recall.md
  - desktop/docs/knowledge_index/README.md
  - desktop/docs/legal-grade-retrieval-execution-plan.md
  - desktop/docs/app-optimization-roadmap.md
---

# RedBox Memory v2 BM25 Hybrid Optimization Plan

## Goal

把当前长期记忆从 `JSON + contains 线性匹配 + 小摘要注入` 升级为本地优先、结构化、可审计、可解释的 hybrid memory engine。

核心方向：

1. 复用现有知识库的 SQLite FTS5 BM25 / Tantivy / hybrid ranking 经验，不重新引入一套搜索技术栈。
2. 借鉴 Mem0 的结构化抽取和混合检索。
3. 借鉴 Hermes 的 bounded prompt injection，保证注入内容小、稳定、可控。
4. 借鉴 MemPalace 的 scope/taxonomy/hooks 思路，但不照搬重型 palace UI 和外部 ChromaDB 服务。

## Current Baseline

当前 memory 已经有完整基础入口：

- 主存储：`memory/catalog.json`
- 历史：`memory/history.json`
- 自动摘要：`memory/MEMORY.md`
- host channel：`memory:list/search/add/delete/history/archived/maintenance-*`
- runtime 注入：`memory_summary_section`
- 后台整理：`memory/maintenance.rs`

当前限制：

- 检索是 `content/type/tags` 的线性 contains 匹配。
- 没有 BM25、向量、实体关系、scope filter。
- 没有独立 memory index lifecycle。
- `MEMORY.md` 只是生成物，但容易被误认为主存储。
- 写入主要保存自由文本，缺少结构化抽取、冲突检测和置信度。
- prompt 注入没有充分解释召回原因，也缺少可观测的 ranking breakdown。

## Existing Retrieval Assets To Reuse

RedBox 已经在 knowledge index 里落地了 lexical / BM25 基础设施：

- `tantivy = "0.26.0"` 已在 `desktop/src-tauri/Cargo.toml`。
- `knowledge_index/tantivy_index.rs` 已有 Tantivy block index。
- `knowledge_index/schema.rs` 已有 SQLite FTS5 virtual table。
- `knowledge_index/document_blocks.rs` 已有 FTS5 `bm25()` 查询、BM25 score 转换、lexical score、semantic score、rerank score。
- `knowledge_index/hybrid.rs` 已有 query expansion、RRF、citation/legal/confidence rerank 思路。
- `tools/knowledge_search.rs` 已在响应中暴露 `lexicalEngine: "tantivy+sqlite-fts5-bm25"` 和 ranking breakdown。

Memory v2 不应重新引入新的 BM25 库。

推荐复用策略：

1. 先复制成熟模式，给 memory 建独立 FTS5 表。
2. 再把 knowledge 和 memory 共用的 scoring/query helper 抽到共享模块。
3. 保持 memory 和 knowledge 的数据表、scope、history、prompt policy 独立。

## Architecture

### Layer 0: Stable Profile Snapshot

用途：

- 用户长期身份
- 创作定位
- RedClaw profile
- 关键约束

实现：

- 继续读取 `redclaw/profile/*` 和高置信 memory。
- 进入 prompt 前生成小型 bounded snapshot。
- 不参与大规模全文检索。

借鉴 Hermes：

- prompt 注入必须小。
- 不把全部 memory 文件直接暴露给模型。
- 记忆写入必须走结构化工具或后台 maintenance。

### Layer 1: Structured Long-Term Memory

用途：

- facts
- preferences
- goals
- constraints
- project decisions
- creative principles

新增字段建议：

```json
{
  "id": "memory_xxx",
  "content": "用户偏好短句、强节奏、少解释。",
  "memoryType": "preference",
  "scope": "user",
  "spaceId": "default",
  "projectId": null,
  "sessionId": "session_xxx",
  "source": {
    "kind": "chat_message",
    "id": "message_xxx",
    "createdAt": "2026-04-25T10:00:00+08:00"
  },
  "entities": ["用户", "创作风格"],
  "tags": ["style", "writing"],
  "confidence": 0.86,
  "status": "active",
  "revision": 3,
  "createdAt": 1777000000000,
  "updatedAt": 1777000000000,
  "lastAccessed": 1777000000000
}
```

新增 scope：

| Scope | 用途 |
| --- | --- |
| `user` | 用户全局长期偏好和事实 |
| `workspace` | 当前 workspace 稳定事实 |
| `project` | 稿件、视频、任务项目级记忆 |
| `redclaw` | RedClaw 创作和运营策略 |
| `advisor` | 智囊团成员相关约束 |
| `session` | 只在当前 session 附近可用的短期摘要 |

### Layer 2: Episodic Memory

用途：

- 会话摘要
- 任务过程
- 工具调用结论
- 用户对某次产物的反馈

实现：

- 不把每条消息都升级为长期记忆。
- 对 session/checkpoint/tool_result 生成可检索摘要。
- 与长期 memory 分表或分 source lane 存储。

### Layer 3: Project And Media Memory

用途：

- 稿件项目长期方向
- 视频项目风格、主体、镜头偏好
- 生图/视频生成参数
- 素材引用关系

原则：

- 不把大文件、转录全文、视频帧直接写入 memory。
- 只存稳定摘要、决策、偏好、引用路径、参数。
- 大内容继续交给 knowledge/media index。

### Layer 4: Knowledge RAG

用途：

- 文档
- 素材
- 转录
- 网页摘录
- 法律/资料型证据

边界：

- Knowledge 负责证据检索。
- Memory 负责用户长期偏好、稳定事实、项目决策。
- 两者可以在 runtime recall 阶段融合，但存储和维护策略必须分开。

## Storage Design

### Phase 1: Keep JSON As Source Of Truth, Add SQLite FTS Index

保守落地方式：

- 保留 `memory/catalog.json` 和 `history.json` 作为兼容主存储。
- 新增 `memory/index.sqlite` 或放入现有 workspace SQLite store。
- 每次 `memory:add/update/archive/delete` 后同步更新 FTS。
- 启动 workspace hydration 时，如果 index 缺失或版本不匹配，从 catalog 重建。

新增表：

```sql
CREATE TABLE IF NOT EXISTS memory_records_index (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  space_id TEXT,
  project_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.75,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
  id UNINDEXED,
  content,
  memory_type,
  tags,
  entities,
  tokenize='unicode61'
);
```

Phase 1 不引入 vector，先把 lexical recall 做稳。

### Phase 2: Promote SQLite To Primary Store

当迁移稳定后：

- SQLite 成为主存储。
- `catalog.json` 变成导出/备份兼容文件。
- `MEMORY.md` 继续是自动生成摘要。
- history 进入 SQLite 表，保留 JSON export。

## Retrieval Design

### Query Construction

当前 query 来自：

```text
runtime_mode + advisorId + contextType + intent
```

Memory v2 应扩展为：

```text
runtime_mode
+ user latest message summary
+ session intent
+ contextType
+ active project/manuscript/video metadata
+ advisorId
+ explicit memory query if tool called
```

### Candidate Lanes

1. `profile_lane`
   - 高置信用户档案和 RedClaw profile
   - 小数量固定注入

2. `bm25_lane`
   - SQLite FTS5 `bm25(memory_records_fts)`
   - 支持 scope/status/type/project filter

3. `lexical_fallback_lane`
   - 当前 contains 逻辑保留为兜底
   - 只在 FTS index 不可用时启用

4. `semantic_lane`
   - 后续接 embedding/vector
   - 不作为第一阶段必做项

5. `graph_entity_lane`
   - 后续按 entities/source/project 建边
   - 用于扩展相关记忆，不直接决定最终排序

### Ranking

Phase 1 scoring：

```text
total_score =
  bm25_score * 0.55
+ lexical_match_score * 0.15
+ scope_boost * 0.12
+ recency_boost * 0.08
+ confidence_boost * 0.06
+ type_priority_boost * 0.04
```

必须返回 ranking breakdown：

```json
{
  "score": 8.4,
  "ranking": {
    "bm25Score": 6.2,
    "lexicalScore": 0.8,
    "scopeBoost": 0.6,
    "recencyBoost": 0.3,
    "confidenceBoost": 0.4,
    "typePriorityBoost": 0.1
  },
  "retrievalLanes": ["bm25", "scope-filter"]
}
```

### Prompt Injection

注入策略采用 Hermes 风格：

- 默认最多 8 条。
- 默认最多 1200 chars。
- 按 `user_profile / preference / project / constraint / recent_learning` 分组。
- 只注入 `content_preview`，不注入完整 history。
- 每条可携带轻量来源标识，但不暴露冗余 JSON。

示例：

```text
Long-term memory recall:
- [preference][user] 用户偏好短句、强节奏、少解释。
- [constraint][redclaw] 用户不希望把一次性素材偏好写入长期风格。
- [project][video] 当前视频项目要求保留主体一致性，避免重绘人物脸部。
```

## Write And Maintenance Design

### Memory Add

`memory.add` 不应只接自由文本。新增结构化 payload：

```json
{
  "content": "用户偏好短句、强节奏、少解释。",
  "type": "preference",
  "scope": "user",
  "tags": ["style", "writing"],
  "entities": ["用户", "写作风格"],
  "confidence": 0.86,
  "source": {
    "kind": "chat_message",
    "id": "message_xxx"
  }
}
```

兼容：

- 旧 payload 只有 `content/type/tags` 时，自动补默认 scope/source/confidence。

### Extractor

新增 `memory/extractor.rs`：

- 输入：recent messages、tool results、runtime mode、project metadata。
- 输出：strict JSON actions。
- actions：`create/update/archive/noop`。

抽取规则：

- 只保存长期稳定信息。
- 一次性任务不写入。
- 模糊、不确定、不完整的信息不写入。
- 与现有记忆重复时优先 update/revision，不 create。

### Conflict Resolution

新增字段：

- `canonical_key`
- `origin_id`
- `revision`
- `last_conflict_at`
- `confidence`

规则：

- 同 canonical key 下保留一条 active。
- 新旧冲突时，低置信归档，高置信更新。
- 对用户明确纠正的记忆，直接 update 并记录 history。

### Maintenance Hooks

借鉴 MemPalace hooks，但落地为 RedBox 后台任务：

| Hook | 触发 |
| --- | --- |
| `after_chat_exchange` | 对 recent messages 提取候选记忆 |
| `after_memory_mutation` | bump pending mutation |
| `periodic_consolidation` | pending >= 5 或定时 |
| `workspace_hydration` | index version check and rebuild |
| `before_prompt_injection` | recall + budget trim |

## Tool Contract

保留现有：

- `memory.list`
- `memory.search`
- `memory.add`
- `memory.delete`

新增或扩展：

- `memory.recall`
- `memory.update`
- `memory.archive`
- `memory.rebuildIndex`
- `memory.diagnostics`

`memory.search` 和 `memory.recall` 区别：

| Tool | 用途 |
| --- | --- |
| `memory.search` | 用户显式查记忆，返回较完整记录 |
| `memory.recall` | runtime 使用，返回压缩命中和 ranking breakdown |

## UI Design

新增或增强 Settings -> Memory Center：

- Active memories
- Archived memories
- Search diagnostics
- Recall preview
- Index status
- Source/history viewer
- Manual edit/archive
- Rebuild index action

关键要求：

- 空记忆必须快速返回空数组。
- 搜索失败不能清空已展示数据。
- 重建索引必须有状态，不阻塞页面。
- 每条记忆显示 scope、type、confidence、updatedAt、source。

## Performance Strategy

1. 小规模 memory 仍可内存加载，用 FTS 负责排序质量。
2. FTS index 异步更新，不在 UI 首屏持锁重建。
3. workspace hydration 只检查版本和计数，不全量扫描大文件。
4. prompt injection 只取 top N 和 preview，不传完整 JSON。
5. index rebuild 使用 background job，支持取消/忽略旧请求。
6. memory store 锁内只取 snapshot，锁外做 I/O、index rebuild、LLM extractor。
7. `memory.search` 默认 limit 20，`memory.recall` 默认 limit 8。
8. 输出携带 `retrievalLanes` 和 ranking breakdown，便于定位召回质量问题。

## Implementation Plan

### Step 1: Shared Lexical Helpers

目标：

- 从 `knowledge_index/document_blocks.rs` 抽出可复用 scoring helper。

建议模块：

- `retrieval/mod.rs`
- `retrieval/bm25.rs`
- `retrieval/lexical.rs`
- `retrieval/ranking.rs`

迁移内容：

- `bm25_rank_score`
- query term extraction
- basic lexical score
- ranking breakdown structs

验证：

- knowledge search 现有 BM25 测试继续通过。
- 新增 shared helper 单测。

### Step 2: Memory FTS Index

目标：

- 新增 memory FTS 表和 index rebuild。

新增模块：

- `memory/index.rs`
- `memory/schema.rs`
- `memory/search.rs`

新增能力：

- rebuild from active catalog
- upsert one memory
- delete/archive one memory
- FTS search with BM25 score

验证：

- 空 index 搜索返回 `[]`。
- add 后 search 命中。
- archive 后 search 不命中 active。
- rebuild 后结果一致。

### Step 3: Memory Recall v2

目标：

- 替换 `memory/recall.rs` 的 contains ranking 为 BM25-first ranking。

要求：

- FTS 可用时走 BM25。
- FTS 不可用时 fallback 当前 contains。
- 返回 ranking breakdown。
- prompt injection 仍保持小摘要。

验证：

- `memory:list` 空返回。
- `memory:search` 正常返回。
- `build_memory_prompt_section` 仍在有命中时注入。
- FTS 故障时 fallback 不挂死。

### Step 4: Structured Write

目标：

- 扩展 `memory.add` payload。
- 增加 source/scope/confidence/entities。
- 更新 `catalog.json` schema 兼容旧记录。

验证：

- 旧 payload 仍能写。
- 新 payload 写入后可按 scope/type 查询。
- history 记录 before/after。

### Step 5: Extractor And Maintenance

目标：

- 把后台 maintenance 从“全量整理”升级为“候选抽取 + 合并 + 定期整理”。

新增：

- `memory/extractor.rs`
- extractor prompt
- strict JSON schema

验证：

- 一次性任务不写入。
- 明确长期偏好写入。
- 重复偏好 update 而不是 create。
- 冲突偏好保留 history。

### Step 6: Diagnostics And UI

目标：

- Settings 能看到 index 状态和 recall 质量。

新增：

- memory index status
- recall preview
- rebuild index
- ranking breakdown viewer

验证：

- 页面 stale-while-revalidate。
- 重建索引不阻塞 UI。
- 错误以内联方式显示，不清空旧数据。

## Testing Matrix

Rust tests：

- `memory_list_channel_returns_empty_array_without_hanging`
- `memory_search_channel_matches_content_and_tags`
- `memory_add_channel_persists_workspace_files`
- `memory_fts_search_uses_bm25_scores`
- `memory_fts_rebuild_matches_catalog`
- `memory_recall_falls_back_when_index_unavailable`
- `memory_recall_respects_scope_filters`
- `memory_add_structured_payload_preserves_source`
- `memory_archive_removes_from_active_recall`

Integration tests：

- agent calls `memory.search` and receives structured output.
- prompt injection contains only top N summary.
- memory maintenance creates/update/archive actions.
- workspace restart rebuilds or loads index correctly.

Manual verification：

- 空 memory：`memory.list` returns `[]` quickly。
- 有 1000 条 memory：`memory.search` p95 < 100ms。
- prompt 注入 < 1200 chars。
- archive 后不再注入。
- rebuild index 期间 UI 不冻结。

## Migration Strategy

1. 启动时检测 `memory/index.sqlite` 和 schema version。
2. 若缺失，后台从 `catalog.json` 重建。
3. 旧记录缺字段时补默认值：
   - `scope = "user"`
   - `confidence = 0.75`
   - `entities = []`
   - `source = { "kind": "legacy" }`
4. 写入时同时更新 catalog 和 index。
5. 一段稳定期后再考虑 SQLite primary。

## Recommended First Atomic Commit

第一个提交只做一件事：

> Extract shared BM25/ranking helpers from knowledge index without changing behavior.

不要在第一个提交里同时改 memory behavior。先把可复用底座抽出来，跑通现有 knowledge tests，再进入 memory index。

## Risks

| Risk | Mitigation |
| --- | --- |
| 过早引入 vector 导致复杂度上升 | Phase 1 只做 FTS5 BM25 |
| memory 与 knowledge 边界混淆 | 分表、分 tool、分 prompt policy |
| LLM extractor 写入噪声 | strict schema + confidence + maintenance review |
| prompt 注入过大 | bounded top N + max chars |
| index rebuild 卡 UI | background job + stale data |
| 多 workspace 数据串扰 | 所有 index 路径绑定 workspace root/space id |

## Final Recommendation

优先路线：

1. 复用现有 SQLite FTS5 BM25 思路，为 memory 建独立 FTS index。
2. 抽出 shared retrieval scoring helper，避免 knowledge/memory 两套 BM25 分数逻辑。
3. 保持 Hermes 风格小摘要注入，避免 prompt 污染。
4. 逐步增加 Mem0 风格结构化抽取、dedup、conflict resolution。
5. 只借鉴 MemPalace 的 scope/hooks/graph ideas，不引入重型外部服务。

这条路线能在不改变桌面端部署模型的前提下，把 memory 从“能用”推进到“可调、可解释、可扩展”。

## Implementation Completion

Status: Completed on 2026-04-25.

落地内容：

1. 新增独立 `memory/index.sqlite`，包含 `memory_records_index` 与 `memory_records_fts`。
2. `memory.search` 和 runtime recall 优先走 SQLite FTS5 BM25，失败或无命中时回退旧 contains 逻辑。
3. `UserMemoryRecord` 扩展为结构化 memory schema，支持 `scope`、`spaceId`、`projectId`、`sessionId`、`source`、`entities`、`confidence`。
4. 新增/扩展工具合同：`memory.recall`、`memory.update`、`memory.archive`、`memory.rebuildIndex`、`memory.diagnostics`。
5. `memory.add/update/archive/delete/maintenance` 后会同步重建 memory index。
6. index 带 snapshot fingerprint，内容变化但数量不变时也会自动重建。
7. `memory.search` 返回 `bm25Score`、`retrievalLanes`、`ranking.retrievalEngine`，便于诊断召回质量。
8. RedClaw authoring allowlist 和 runtime prompt 已更新到新的 memory action family。

验证证据：

- `cargo fmt --check`
- `cargo test memory:: -- --nocapture`
- `cargo test memory_action_request -- --nocapture`
- `cargo check`

未完成项：

- 前端 `tsc --noEmit` 未执行成功：当前 worktree 中 `pnpm exec tsc --noEmit` 报 `Command "tsc" not found`，需要安装/恢复 `desktop/node_modules` 后再跑。
