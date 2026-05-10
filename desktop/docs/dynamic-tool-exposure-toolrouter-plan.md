---
doc_type: plan
execution_status: completed
last_updated: 2026-05-05
owner: codex
scope:
  - desktop/src-tauri/src/tools
  - desktop/src-tauri/src/runtime
  - desktop/src-tauri/src/agent
  - desktop/src-tauri/src/interactive_runtime_shared.rs
  - desktop/prompts/library/runtime
reference_implementations:
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/tools/src/tool_registry_plan.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/tools/src/tool_discovery.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/mcp_tool_exposure.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/session/turn.rs
  - /Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/parallel.rs
success_metrics:
  - model_visible_tool_count_p95 <= 8
  - redbox_visible_action_count_p95 <= 12
  - wrong_tool_family_rate reduced by 60 percent
  - legacy_compat_tool_call_rate reduced by 80 percent
  - unavailable_tool_call_rate <= 1 percent
  - tool_plan_snapshot_coverage = 100 percent for interactive turns
---

# Dynamic Tool Exposure And Turn ToolRouter Plan

## 1. Goal

本计划把 RedConvert desktop 的 AI 工具体系从“runtime 静态工具包 + 大型 Redbox action 面板”升级为“每轮会话级 ToolRouter + 动态工具曝光”。

目标不是继续减少顶层工具名，而是让模型在每一轮只看到当前任务真正需要的工具和 action。RedBox 保持 Codex 风格的少量顶层工具：

- `Read`
- `List`
- `Search`
- `Write`
- `Redbox`
- `bash`

底层再用 ToolRouter 按当前 turn 动态决定：

- 哪些顶层工具可见。
- `Redbox` 内部哪些 action family 直接可用。
- 哪些 action family 延迟曝光，只能通过搜索发现。
- 哪些工具可并发执行。
- 哪些工具需要权限或只能在特定 runtime 使用。
- 工具结果如何进入 transcript、checkpoint、trace 和下一轮上下文。

本能力明确作为底层 runtime 机制存在，不做用户可见 UI。ToolRouter、dynamic exposure、direct/deferred action、fingerprint 和 `tool_plan` checkpoint 只服务于模型路由、日志审计和故障复盘；普通用户不应看到这些内部概念。

## 1.1 Implementation Progress

2026-04-25 已完成第一轮底层落地：

- 新增 `desktop/src-tauri/src/tools/plan.rs`，建立 session-scoped `ToolRegistryPlan`，集中计算 internal tools、visible tools、direct `app_cli` actions、deferred action index 和 fingerprint。
- `registry.rs` 的 session schema / prompt tool lines 已切到 `ToolRegistryPlan`，`Redbox` 的 `resource` / `operation` enum 会按本轮 direct actions 收敛。
- 新增 `tool_search` app_cli action，并通过 `tool_search` 暴露 deferred action discovery。
- `app_cli` 执行层会拒绝本轮 deferred action，返回结构化 `ACTION_DEFERRED`，并给出 `tool_search` 查询建议。
- `image-generation` runtime 已补齐 `image.generate` / `video.generate` action 覆盖。
- 每次生成 provider tools 时会在 app 日志输出 `[tools][plan]` 快照，包含 fingerprint、visible tools、direct actions、deferred namespace 和 deferred count。

2026-04-25 第二轮已补齐底层闭环：

- 新增 `desktop/src-tauri/src/tools/action_search.rs`，从 `app_cli.rs` 抽出 action discovery，搜索数据包含 action、namespace、description 和 input schema 字段摘要。
- 新增 `desktop/src-tauri/src/tools/router.rs`，`InteractiveToolExecutor::prepare_tool_call` 已切到 turn-scoped `ToolRouter`，统一处理 compat normalization、可见工具校验、direct/deferred action 校验和结构化路由错误。
- 新增 `desktop/src-tauri/src/runtime/turn_context.rs`，提供 typed `RedboxTurnContext`，集中保存 runtime mode、session metadata、active skills、allowed tools、bound context、task intent 和 model capabilities。
- Tool result envelope 会写入 `meta.toolPlanFingerprint`，可直接回溯允许该工具调用的 plan。
- `interactive_runtime_tools_for_mode` 会持久化 `tool_plan` checkpoint，不再只是日志输出。
- 新增 `desktop/src-tauri/src/tools/families/*`，把 action family taxonomy 和默认曝光策略从 `plan.rs` 拆出。
- `directActionFamilies` / `allowedActionFamilies` / `maxDirectActions` session metadata 已接入 ToolRegistryPlan，用于结构化控制本轮 action 曝光。
- prompt 工具摘要会明确提示 deferred actions 通过 `tool_search` 发现。

本计划约定“不做 UI 改造”，且后续也不应新增用户可见的 ToolRegistryPlan / ToolRouter 诊断面板。当前底层已经输出 checkpoint / log / schema；出现问题时通过本地日志、session checkpoint 和 tool result metadata 复盘。

2026-05-04 Codex 对齐补强：

- `tool_search` 已硬切为一等模型工具；常规 runtime 在存在 deferred app action 或 deferred MCP tool 时才暴露它。
- 旧 `tools.search` app_cli action 和 `Operate(resource="tools", operation="search")` 已移除；ToolRouter 的 deferred 错误只建议模型调用 `tool_search`。
- `manuscript-editor` 保持极小工具面，只暴露绑定稿件 `Write`，不会因为 deferred action 自动增加搜索工具。

## 2. Current Problem

当前工具优化已经完成第一步：顶层模型可见工具收敛到了 Codex 熟悉的命名风格。

现状入口：

- `desktop/src-tauri/src/tools/packs.rs`
  runtime mode 到静态工具包的映射。
- `desktop/src-tauri/src/tools/registry.rs`
  session metadata 下的工具列表和 OpenAI schema 生成。
- `desktop/src-tauri/src/tools/catalog.rs`
  `app_cli` / `Redbox` action descriptor 大目录。
- `desktop/src-tauri/src/tools/compat.rs`
  旧工具名、旧命令和新 action 的兼容翻译。
- `desktop/src-tauri/src/tools/executor.rs`
  工具调用准备和分发。
- `desktop/src-tauri/src/interactive_runtime_shared.rs`
  system prompt 中拼接可用工具说明。

主要问题：

1. 工具曝光仍然是 runtime 静态 pack 驱动。
   `image-generation`、`redclaw`、`chatroom` 虽然顶层工具少，但 `Redbox` 背后的 action family 仍然很多。

2. `Redbox` 是一个半 God tool。
   业务操作都收敛到了 `Redbox` 是正确方向，但 action 搜索、action 短名单、action 延迟加载还没有建立，所以模型仍可能在大 action 空间里误选。

3. prompt 承担了过多路由职责。
   目前靠 `available_tools` 文本、技能提示词、runtime overlay 解释“该用哪个工具”。这会提高 token 成本，也让模型在复杂场景中把规划标签、业务 action 和工具契约混在一起。

4. 兼容层仍在长期承压。
   `compat.rs` 支持大量旧工具名和旧 action。短期有必要，长期会让模型错误调用看起来“也能工作”，削弱新工具面的学习效果。

5. 每轮没有明确的 tool plan 快照。
   排查错误工具调用时，需要从 transcript、state、prompt、metadata 多处倒推。应该让每个 turn 都记录“当时到底向模型暴露了什么”。

## 3. Codex Reference

Codex 的关键经验不是“工具数量固定少”，而是“每一轮按上下文构建工具计划”。

### 3.1 ToolRegistryPlan

参考：

- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/tools/src/tool_registry_plan.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/tools/src/tool_config.rs`

Codex 通过 `ToolsConfig + ToolRegistryPlanParams` 构建本轮工具计划。这个 plan 同时包含：

- model-visible tool specs
- tool handler mapping
- parallel support flag
- MCP direct tools
- MCP deferred tools
- dynamic tools
- request user input / permissions / shell / apply patch 等内置工具条件开关

RedConvert 应建立对应的 `ToolRegistryPlan`，把现在散在 `packs.rs`、`registry.rs`、`catalog.rs`、`interactive_runtime_shared.rs` 的决策合并成一个 turn-scoped plan。

### 3.2 Deferred Tools And Tool Search

参考：

- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/mcp_tool_exposure.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/tools/src/tool_discovery.rs`

Codex 对工具过多的 MCP server 不直接暴露全部工具。当数量超过阈值，或 feature flag 要求延迟加载时，只暴露 `tool_search`，让模型用 BM25 搜索需要的工具。

RedConvert 应把这个策略用于 `Redbox` action family：

- 直接暴露当前 turn 高相关 action。
- 其他 action 进入 deferred action index。
- 暴露 `Redbox.search_actions` 或独立 `SearchActions` 能力，让模型按需发现。

### 3.3 Turn-Scoped Router

参考：

- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/session/turn.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/parallel.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/tools/router.rs`

Codex 每个 sampling request 都从 turn context 构建 router，再把工具调用交给 router 分发。router 知道：

- 这个工具是否存在。
- 是否在本轮对模型可见。
- 是否支持并发。
- 工具调用结果如何包装回模型。
- 失败时如何生成 structured failure response。

RedConvert 当前 `InteractiveToolExecutor` 只做 normalize 和 dispatch，缺少 turn-scoped plan、parallel gate、deferred tool resolution 和完整 trace。

## 4. Architecture Decision

有三种可选方案。

### Option A: Continue Static Tool Packs

继续维护 `ToolPack` 和 `available_tools` prompt，按 runtime 暴露固定工具集合。

优点：

- 实现成本最低。
- 与现有代码兼容。

缺点：

- 无法解决 Redbox action 面过宽。
- prompt 会继续膨胀。
- 工具误用只能靠提示词补丁。
- 很难解释某一轮为什么模型选错工具。

结论：不推荐。

### Option B: Split Redbox Into Many Business Tools

把 `image.generate`、`manuscripts.write`、`memory.search` 等拆成大量顶层工具。

优点：

- 单个工具 schema 更窄。
- 执行层更直接。

缺点：

- 回到用户已经指出的问题：工具太多，模型不知道选哪个。
- 与 Codex 熟悉的少工具面相反。
- 工具名和 action 名重复，迁移成本高。

结论：不推荐。

### Option C: Stable Top-Level Tools + Dynamic Redbox Actions

保留少量顶层工具，把业务能力放在 `Redbox` action family 中。每轮通过 ToolRouter 动态决定 action 短名单，其他 action 延迟搜索。

优点：

- 顶层工具面稳定，符合 Codex 风格。
- action schema 可以按需注入。
- prompt 成本可控。
- 错误工具调用可被 router 精准拒绝并给出替代建议。
- 兼容层可以逐步退场。

缺点：

- 需要新增 plan/router/search/trace 四个底层模块。
- 需要重构 schema 生成路径。

结论：推荐采用。

## 5. Target Product Architecture

目标调用链：

```text
User Input / Background Turn / Session Bridge
  -> TurnContextResolver
  -> ToolRegistryPlanBuilder
  -> ToolRouter
  -> PromptBuilder
  -> Provider Sampling
  -> ToolCallRouter
  -> ToolExecutor
  -> ToolResultEnvelope
  -> SessionTrace / Checkpoint / Transcript
  -> Follow-up Sampling
```

关键原则：

- 顶层工具稳定。
- action 能力动态。
- prompt 只描述当前可用能力，不承担全量路由手册。
- ToolRouter 是唯一工具准入点。
- 兼容层只作为迁移兜底，不作为模型推荐路径。
- 工具结果必须结构化，不能只返回自由文本。

## 6. Module Design

### 6.1 `tools/plan.rs`

新增模块，职责等价 Codex `tool_registry_plan.rs`。

输入：

```rust
pub struct ToolRegistryPlanParams<'a> {
    pub runtime_mode: &'a str,
    pub session_id: Option<&'a str>,
    pub session_metadata: Option<&'a Value>,
    pub active_skills: &'a [String],
    pub page_context: Option<&'a Value>,
    pub task_intent: Option<&'a str>,
    pub model_supports_parallel_tool_calls: bool,
}
```

输出：

```rust
pub struct ToolRegistryPlan {
    pub visible_tools: Vec<ToolDescriptor>,
    pub visible_action_descriptors: Vec<ActionDescriptor>,
    pub deferred_action_families: Vec<String>,
    pub deferred_actions: Vec<ActionSearchEntry>,
    pub handlers: HashMap<ToolRouteKey, ToolHandlerKind>,
    pub parallel_policy: ToolParallelPolicy,
    pub prompt_summary: ToolPlanPromptSummary,
    pub fingerprint: String,
}
```

实现细节：

- 从 `packs.rs` 读取 runtime base tools。
- 从 session metadata 读取 `allowedTools`、`allowedAppCliActions`、`contextType`、`projectId`、`taskIntent`。
- 从 active skill 读取工具依赖和 action family hint。
- 根据 runtime mode 选择默认 action family。
- 根据 page context 注入绑定资源相关 action。
- 根据 action 数量和相关性决定 direct vs deferred。
- 输出 fingerprint，用于 system prompt warm cache。

必须自研，因为 RedBox 的 action family、runtime mode、session metadata、skill activation 都是产品内语义。

### 6.2 `tools/action_search.rs`

新增 action 搜索模块。

数据源：

- `ActionDescriptor.action`
- `ActionDescriptor.namespace`
- `ActionDescriptor.description`
- input schema 字段名
- runtime modes
- visibility
- mutating / concurrency flag
- skill activation hint

搜索方式：

- 第一版用轻量 BM25 或 token overlap。
- 不引入外部服务。
- 可用 `tantivy` 仅在后续 action 数量明显增大时考虑。

模型可调用 action：

```json
{
  "resource": "tool",
  "operation": "search_actions",
  "input": {
    "query": "generate 4 xiaohongshu cards",
    "limit": 8
  }
}
```

返回：

```json
{
  "ok": true,
  "action": "tool.search_actions",
  "data": {
    "items": [
      {
        "action": "image.generate",
        "family": "image",
        "description": "Generate images or image batches.",
        "inputSummary": ["prompt", "count", "aspectRatio", "imagePlanItems"],
        "mutating": true,
        "availableThisTurn": true
      }
    ]
  }
}
```

关键约束：

- search result 不直接扩大当前模型工具 schema。
- 第一版可以返回 action name 和 payload 结构摘要，模型下一次仍通过 `Redbox` 调用。
- 后续可以支持“search 后下一轮注入完整 schema”。

### 6.3 `tools/router.rs`

新增 turn-scoped router，逐步替代 `executor.rs` 中的准入逻辑。

职责：

- 接收原始 tool call。
- 调用 `compat::normalize_tool_call` 做迁移兼容。
- 根据 `ToolRegistryPlan` 判断工具和 action 是否允许。
- 对 deferred action 给出结构化错误和搜索建议。
- 控制并发。
- 调用实际 executor。
- 统一包装结果。
- 记录 trace。

核心接口：

```rust
pub struct ToolRouter {
    plan: Arc<ToolRegistryPlan>,
}

impl ToolRouter {
    pub fn prepare(&self, raw: RawToolCall) -> Result<PreparedToolCall, ToolRouteError>;
    pub fn dispatch(&self, prepared: PreparedToolCall) -> Result<ToolResultEnvelope, ToolRouteError>;
    pub fn supports_parallel(&self, prepared: &PreparedToolCall) -> bool;
}
```

错误示例：

```json
{
  "ok": false,
  "error": {
    "code": "ACTION_DEFERRED",
    "message": "Action `team.task.create` is not exposed in this turn.",
    "retryable": true,
    "suggestedAction": "tool.search_actions",
    "details": {
      "queryHint": "team task create collaboration workboard"
    }
  }
}
```

### 6.4 `tools/families/*`

拆分 `catalog.rs`。

目标结构：

```text
tools/
  catalog.rs
  families/
    mod.rs
    image.rs
    manuscripts.rs
    memory.rs
    redclaw.rs
    subjects.rs
    team.rs
    runtime.rs
    editor.rs
    cli_runtime.rs
```

`catalog.rs` 只负责汇总和公共 schema helper，不继续承载全部 action 定义。

每个 family 要定义：

```rust
pub fn descriptors() -> Vec<ActionDescriptor>;
pub fn default_exposure_policy() -> ActionExposurePolicy;
```

必须自研，因为这是 RedBox 产品能力边界。

### 6.5 `runtime/turn_context.rs`

新增或扩展 turn context。

RedConvert 当前上下文分散在：

- session metadata
- runtime mode
- current host runtime context
- skill runtime state
- advisor context
- subject section
- memory section

需要给工具系统一个 typed 快照：

```rust
pub struct RedboxTurnContext {
    pub runtime_mode: String,
    pub session_id: Option<String>,
    pub current_date: String,
    pub workspace_root: Option<PathBuf>,
    pub session_metadata: Option<Value>,
    pub active_skills: Vec<String>,
    pub bound_context: Option<BoundContext>,
    pub model_capabilities: ModelCapabilities,
}
```

这个 context 是 ToolRegistryPlanBuilder 的唯一输入来源，避免 plan builder 自己到处读 store 和 runtime warm cache。

### 6.6 `interactive_runtime_shared.rs`

改造 prompt 注入。

现在：

- 直接调用 `prompt_tool_lines_for_session`。
- 把可用工具和 action families 拼成较长的文本。

目标：

- prompt 只消费 `ToolRegistryPlan.prompt_summary`。
- 不写全量 action 文档。
- 明确告诉模型：
  - 当前可见工具。
  - 当前可直接调用的 Redbox action。
  - 如需其它 RedBox 能力，先调用 `Redbox(tool.search_actions)`。

示例 prompt section：

```text
Available tools for this turn:
- Read: read one resource
- List: list resources
- Search: search resources
- Redbox: current actions exposed:
  - image.generate
  - skill.run
  - subjects.search
Deferred Redbox actions are searchable. If you need another product operation, call Redbox(resource="tool", operation="search_actions", input={ "query": "...", "limit": 8 }).
```

### 6.7 `runtime/session_runtime.rs`

增加 tool plan 快照。

新增 transcript/checkpoint payload：

```json
{
  "type": "tool_plan",
  "sessionId": "session-...",
  "turnId": "turn-...",
  "runtimeMode": "image-generation",
  "fingerprint": "sha256...",
  "visibleTools": ["Read", "Search", "Redbox"],
  "visibleActions": ["image.generate", "skill.run", "subjects.search"],
  "deferredActionFamilies": ["manuscripts", "team", "memory"],
  "activeSkills": ["image-director"]
}
```

用途：

- 复盘工具误用。
- 统计 action 曝光是否过宽。
- 评估 skill 是否正确收窄工具面。
- 为后续 UI 工具面板提供数据，但本轮不做 UI。

## 7. Action Exposure Policy

### 7.1 Default Direct Families

按 runtime mode 的默认直接曝光：

| Runtime | Direct action families | Deferred families |
| --- | --- | --- |
| `wander` | `workspace`, `knowledge` | all mutating app actions |
| `chatroom` | `memory`, `subjects`, `skills`, `manuscripts.read` | image, video, team, runtime mutations |
| `image-generation` | `image`, `skills`, `subjects`, `media.read` | manuscripts, team, memory mutations |
| `redclaw` | `redclaw`, `memory`, `manuscripts`, `image` when intent matches | team, diagnostics, cli runtime |
| `video-editor` | `editor`, `media`, `cli_runtime` | redclaw, team, unrelated manuscripts |
| `audio-editor` | `editor`, `media`, `cli_runtime` | redclaw, team, unrelated manuscripts |
| `diagnostics` | `runtime`, `cli_runtime`, `settings`, `logs` | creative actions |

### 7.2 Session Metadata Overrides

Existing metadata should continue to work:

- `allowedTools`
- `allowedAppCliActions`
- `contextType`
- `contextId`
- `projectId`
- `sourceTitle`
- `suiteState`

New metadata:

```json
{
  "toolIntent": "image_batch_generation",
  "allowedActionFamilies": ["image", "skills", "subjects"],
  "deferredActionFamilies": ["manuscripts", "team"],
  "allowDeferredActionSearch": true,
  "maxDirectActions": 12
}
```

### 7.3 Skill-Driven Exposure

Skills should affect tool exposure through structured metadata, not only prompt text.

Skill frontmatter can add:

```yaml
toolFamilies:
  direct:
    - image
    - subjects
  deferred:
    - manuscripts
toolActions:
  direct:
    - image.generate
    - skill.run
maxDirectActions: 8
```

Example:

- `image-director` activates `image.generate`, `skill.run`, `subjects.search`.
- It should not automatically expose `manuscripts.createProject` unless user asks to package or bind results.

## 8. Tool Call Lifecycle

### 8.1 Before Sampling

1. Resolve `RedboxTurnContext`.
2. Build `ToolRegistryPlan`.
3. Persist `tool_plan` checkpoint.
4. Build OpenAI tool schemas from plan.
5. Build prompt tool summary from plan.
6. Send provider request.

### 8.2 During Sampling

1. Stream assistant text and tool call args as today.
2. When tool call completes, pass raw call to `ToolRouter`.
3. Router normalizes compat names.
4. Router validates against plan.
5. Router dispatches executor.
6. Result is wrapped as `ToolResultEnvelope`.
7. Tool result and route decision are appended to session trace.

### 8.3 After Tool Call

1. If result requires follow-up, sampling continues.
2. If tool activated a skill or changed session metadata, next sampling request must rebuild `ToolRegistryPlan`.
3. If action was deferred, model receives structured error with `search_actions` suggestion.

## 9. Structured Result Contract

All Redbox actions should eventually use one envelope:

```json
{
  "ok": true,
  "action": "image.generate",
  "data": {},
  "meta": {
    "tool": "Redbox",
    "family": "image",
    "runtimeMode": "image-generation",
    "toolPlanFingerprint": "sha256...",
    "durationMs": 123,
    "truncated": false
  }
}
```

Failure:

```json
{
  "ok": false,
  "action": "image.generate",
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "aspectRatio must be one of 1:1, 3:4, 4:3, 9:16, 16:9",
    "retryable": true,
    "details": {}
  },
  "meta": {
    "toolPlanFingerprint": "sha256..."
  }
}
```

This replaces ad hoc success shapes gradually. Compatibility can preserve old fields during transition.

## 10. Build Vs Buy

Must self-build:

- `ToolRegistryPlan`
- RedBox action family taxonomy
- action exposure policy
- session metadata to tool plan resolver
- Redbox action search index
- turn-scoped ToolRouter
- RedBox structured result envelope
- session tool plan snapshot

Use existing libraries:

- `serde_json` for schema and payload.
- existing store/session persistence.
- existing provider transports.
- existing `redbox_fs`, `app_cli`, `redbox_editor`, `bash` executors.

Optional later:

- `tantivy` only if action search grows beyond simple in-memory ranking needs.

Do not add:

- a new external agent for tool routing.
- another LLM call just to choose tools.
- UI work in this phase.

## 11. Performance Strategy

### 11.1 Prompt Budget

Target:

- model-visible top-level tools p95 <= 8
- direct Redbox actions p95 <= 12
- prompt tool summary <= 1800 chars

Approach:

- Only inject short action summaries.
- Defer low-relevance action schemas.
- Rebuild prompt only when `toolPlanFingerprint` changes.

### 11.2 Runtime Cost

Action search should be in-memory:

- Build index at startup or catalog load.
- Rebuild only when catalog/skills change.
- Query cost should be O(action_count) in first version, acceptable for current scale.

### 11.3 Locking

Follow repository state rule:

1. Hold store lock only to read session metadata, skill state, and small context snapshots.
2. Release lock.
3. Build tool plan outside lock.
4. Re-lock only to persist checkpoint.

Do not scan workspace, media folders, or knowledge files while holding store lock.

### 11.4 Tool Result Budget

Keep `guards::apply_output_budget`, but move budget decision into `ToolRouter`:

- `Read` can return larger text.
- `Search` returns ranked summaries.
- mutating `Redbox` actions return compact structured output.
- large outputs should be persisted and returned as resource URI.

## 12. Migration Plan

### Step 1: Introduce Tool Plan Types

Files:

- add `desktop/src-tauri/src/tools/plan.rs`
- update `desktop/src-tauri/src/tools/mod.rs`
- add tests in `tools/plan.rs`

Deliverables:

- `ToolRegistryPlan`
- `ToolRegistryPlanParams`
- `ToolHandlerKind`
- fingerprint generation
- runtime pack parity tests

Acceptance:

- Existing visible tool lists remain unchanged.
- All current `cargo test tools::` pass.

### Step 2: Add Action Family Metadata

Files:

- update `desktop/src-tauri/src/tools/catalog.rs`
- optionally introduce `desktop/src-tauri/src/tools/families/mod.rs`

Deliverables:

- action family field
- exposure policy field
- family summary helper
- tests that image-generation only selects image/skill/subject families by default

Acceptance:

- No behavior change yet.
- Schema generation still matches current tests.

### Step 3: Add Redbox Action Search

Files:

- add `desktop/src-tauri/src/tools/action_search.rs`
- update `app_cli` or `Redbox` normalized action route
- update tool schema for `Redbox` to include `resource="tool", operation="search_actions"`

Deliverables:

- in-memory action index
- search API
- structured search results
- tests for query to action matching

Acceptance:

- Query `generate xiaohongshu card` returns `image.generate`.
- Query `save current manuscript` returns manuscript actions.
- Deferred action search is available without exposing all action schemas.

### Step 4: Build Turn ToolRouter

Files:

- add `desktop/src-tauri/src/tools/router.rs`
- refactor `desktop/src-tauri/src/tools/executor.rs`

Deliverables:

- `ToolRouter::prepare`
- `ToolRouter::dispatch`
- action allow/defer rejection
- parallel policy hook
- structured error output

Acceptance:

- Existing compat calls still work.
- Calling a deferred action returns `ACTION_DEFERRED` with search suggestion.
- Calling unavailable tool returns stable `TOOL_NOT_AVAILABLE`.

### Step 5: Integrate Plan Into Prompt And Schema Generation

Files:

- update `desktop/src-tauri/src/tools/registry.rs`
- update `desktop/src-tauri/src/interactive_runtime_shared.rs`
- update provider payload builders if they call `openai_schemas_for_session`

Deliverables:

- `openai_schemas_for_tool_plan`
- `prompt_tool_lines_for_tool_plan`
- runtime warm cache includes `toolPlanFingerprint`

Acceptance:

- In image-generation runtime, prompt shows only image-relevant direct actions.
- In wander runtime, mutating Redbox actions are not visible.
- No full action catalog dump appears in system prompt.

### Step 6: Persist Tool Plan Snapshot

Files:

- update `desktop/src-tauri/src/runtime/session_runtime.rs`
- update checkpoint helpers
- update agent loop before provider request

Deliverables:

- `tool_plan` checkpoint per interactive turn
- `toolPlanFingerprint` on tool result meta
- trace query includes tool plan records

Acceptance:

- Every interactive turn has one tool plan snapshot.
- Tool result can be traced back to the plan that allowed it.

### Step 7: Reduce Compat Surface

Files:

- update `desktop/src-tauri/src/tools/compat.rs`
- update prompt compatibility note

Deliverables:

- mark compat paths with `__compat.deprecated = true`
- log compat usage count
- add tests for old aliases

Acceptance:

- Existing old calls still work.
- New prompt no longer recommends old aliases.
- Metrics can show when compat usage is low enough to remove.

## 13. Verification Matrix

### Unit Tests

Run:

```bash
cd desktop/src-tauri
cargo test tools::
```

Required cases:

- runtime mode to plan mapping
- session metadata allowlist
- skill-driven direct action exposure
- deferred action rejection
- action search ranking
- compat normalization through router
- output envelope shape

### Integration Tests

Run one real turn for each runtime:

- `wander`: can read/list/search material, cannot mutate manuscript.
- `image-generation`: can invoke image director and generate images, cannot accidentally create manuscript project unless requested.
- `redclaw`: can access redclaw/memory/manuscript actions, can generate images only when task intent matches.
- `video-editor`: can use editor/media/cli runtime, unrelated RedClaw actions deferred.

### Regression Scenarios

1. Image card generation:
   - User asks for 4 Xiaohongshu cards.
   - Direct actions include `image.generate` and `skill.run`.
   - `manuscripts.createProject` deferred unless user asks to save as 稿件文件夹.

2. Writing task:
   - User asks for manuscript.
   - Direct actions include writing skill, manuscript create/write.
   - image generation deferred.

3. Advisor knowledge:
   - Direct tools include `Read/List/Search`.
   - Advisor knowledge scope preserved.
   - broad bash scanning not recommended.

4. Background media followup:
   - Followup bridge turns get a minimal tool plan.
   - No creative actions exposed unless needed.

## 14. Risk And Mitigation

### Risk: Model Cannot Find Deferred Action

Mitigation:

- Keep `Redbox.search_actions` always visible when any action is deferred.
- Search result includes query hints and compact payload examples.

### Risk: Prompt And Schema Diverge

Mitigation:

- Both prompt summary and OpenAI schemas must be derived from the same `ToolRegistryPlan`.
- Add test comparing visible actions in prompt summary against schema names.

### Risk: Skill Changes Tool Exposure Mid-Turn

Mitigation:

- Tool result from `skill.run` sets `requiresToolPlanRefresh = true`.
- Next sampling request rebuilds plan before provider call.

### Risk: Existing Sessions Depend On Legacy Actions

Mitigation:

- Keep `compat.rs` for two releases.
- Add usage metrics.
- Emit deprecation metadata in tool result.

### Risk: Action Search Becomes Another God Tool

Mitigation:

- Search only returns metadata, not arbitrary execution.
- Actual execution still goes through `Redbox` and ToolRouter validation.

## 15. Final Target State

After this migration:

- Models see a small, stable, Codex-like top-level tool surface.
- RedBox product actions are still structured and schema-first.
- Every turn has an explicit tool plan.
- Action families are exposed only when relevant.
- Unrelated capabilities are searchable, not dumped into context.
- Tool misuse produces helpful structured errors instead of silent fallback.
- Logs can answer: “what tools did the model see, why did it choose this one, and why was it allowed?”

This should become the foundation for later UI tooling, but the runtime must be completed first.
